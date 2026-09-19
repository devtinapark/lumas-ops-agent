import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin, type EventConfig, type EvaluationStatus } from "@/lib/supabase";
import { updateGuestStatus } from "@/lib/luma";
import {
  acquireDecisionLock,
  claimTelegramUpdate,
  getPending,
  resolvePending,
  updatePending,
  type PendingApproval,
} from "@/lib/redis";
import {
  answerCallback,
  decodeCallback,
  editCard,
  escapeHtml,
  sendApprovalCard,
  sendText,
  verifyTelegramSecret,
  type CardAction,
} from "@/lib/telegram";

export const runtime = "nodejs";
export const maxDuration = 30;

const updateSchema = z.object({
  update_id: z.number(),
  callback_query: z
    .object({
      id: z.string(),
      from: z.object({ id: z.number(), first_name: z.string().optional() }),
      data: z.string().optional(),
      message: z.object({ message_id: z.number(), chat: z.object({ id: z.number() }) }).optional(),
    })
    .optional(),
});

// Telegram redelivers on non-2xx, so after authentication we always answer 200.
const ok = () => NextResponse.json({ ok: true });

export async function POST(request: Request) {
  // 1. Only Telegram (holder of our setWebhook secret_token) may call this route.
  if (!verifyTelegramSecret(request.headers)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !parsed.data.callback_query) return ok(); // not a button press
  const { update_id, callback_query: cb } = parsed.data;

  if (!(await claimTelegramUpdate(update_id))) return ok();

  const decoded = decodeCallback(cb.data);
  if (!decoded) {
    await answerCallback(cb.id, "Unrecognised action.").catch(() => {});
    return ok();
  }
  const { action, jobId } = decoded;

  // 2. Read the pending (interrupted) state from Redis.
  const pending = await getPending(jobId);
  if (!pending) {
    await answerCallback(cb.id, "Already handled, or this card expired.", true).catch(() => {});
    if (cb.message) await editCard(cb.message.chat.id, cb.message.message_id, "This decision was already handled.").catch(() => {});
    return ok();
  }

  const db = supabaseAdmin();
  const { data: config } = await db
    .from("event_configs")
    .select("*")
    .eq("id", pending.eventConfigId)
    .single<EventConfig>();
  if (!config) {
    await answerCallback(cb.id, "Event config missing.", true).catch(() => {});
    return ok();
  }

  // 3. Host authorisation: identity comes from Telegram's signed-in `from.id`, never from callback data.
  const isFounder = cb.from.id === config.founder_telegram_id;
  const isHost = cb.from.id === config.local_host_telegram_id;
  const allowed = pending.escalated ? isFounder : isHost || isFounder;
  const fromCardChat = !pending.card || pending.card.chatId === cb.message?.chat.id;
  if (!allowed || !fromCardChat) {
    console.warn("telegram action unauthorised", { fromId: cb.from.id, jobId, escalated: pending.escalated });
    await answerCallback(
      cb.id,
      pending.escalated ? "Escalated to the founder; only they can decide." : "You are not authorised for this action.",
      true,
    ).catch(() => {});
    return ok();
  }
  const actor = { telegramId: cb.from.id, role: isFounder ? ("founder" as const) : ("host" as const), name: cb.from.first_name ?? "Host" };

  // 4. Single-flight: a double-click or two admins pressing at once must act only once.
  const release = await acquireDecisionLock(jobId);
  if (!release) {
    await answerCallback(cb.id, "Already processing…").catch(() => {});
    return ok();
  }

  try {
    if (action === "escalate") {
      await escalate(config, pending, actor);
    } else {
      await decide(config, pending, action, actor);
    }
    await answerCallback(cb.id, "Done.").catch(() => {});
  } catch (err) {
    console.error("telegram action failed", err);
    await answerCallback(cb.id, "Something went wrong; buttons are still active, try again.", true).catch(() => {});
  } finally {
    await release().catch(() => {});
  }
  return ok();
}

type Actor = { telegramId: number; role: "host" | "founder"; name: string };

async function decide(
  config: EventConfig,
  pending: PendingApproval,
  action: Exclude<CardAction, "escalate">,
  actor: Actor,
) {
  const db = supabaseAdmin();
  const approve = action === "approve";
  const newStatus: EvaluationStatus = approve ? "host_approved" : "host_waitlisted";
  const previousStatus = await currentStatus(pending.evaluationId);

  // Execute the Luma call first; a failure keeps the card live so the human can retry.
  let lumaError: string | null = null;
  try {
    await updateGuestStatus({
      eventId: pending.lumaEventId,
      guestId: pending.lumaGuestId,
      status: approve ? "approved" : "waitlist",
    });
  } catch (err) {
    lumaError = err instanceof Error ? err.message : String(err);
  }

  await audit({
    pending,
    actor,
    action,
    previousStatus,
    newStatus: lumaError ? previousStatus : newStatus,
    luma: lumaError ? "error" : "ok",
    lumaError,
  });

  if (lumaError) {
    await db.from("attendee_evaluations").update({ luma_sync_error: lumaError }).eq("id", pending.evaluationId);
    throw new Error(lumaError);
  }

  const { error } = await db
    .from("attendee_evaluations")
    .update({
      status: newStatus,
      decided_by: actor.role,
      decided_at: new Date().toISOString(),
      luma_sync_error: null,
    })
    .eq("id", pending.evaluationId);
  if (error) console.error("evaluation update failed after Luma success", error);

  await resolvePending(pending.jobId, action);

  const verdict = approve ? "✅ Approved" : "⏳ Waitlisted";
  if (pending.card) {
    await editCard(
      pending.card.chatId,
      pending.card.messageId,
      `${verdict} by ${escapeHtml(actor.name)}\n<b>${escapeHtml(pending.guestName ?? "Unknown")}</b>${pending.guestEmail ? ` (${escapeHtml(pending.guestEmail)})` : ""}\nAI score: ${pending.score ?? "n/a"}`,
    ).catch((e) => console.error("editCard failed", e));
  }
  if (actor.role === "founder") {
    await sendText(
      config.local_host_chat_id,
      `${verdict} by the founder: ${escapeHtml(pending.guestName ?? pending.guestEmail ?? "applicant")}`,
    ).catch(() => {});
  }
}

async function escalate(config: EventConfig, pending: PendingApproval, actor: Actor) {
  const db = supabaseAdmin();
  const { data: evaluation } = await db
    .from("attendee_evaluations")
    .select("reasoning, github_url, linkedin_url, injection_suspected")
    .eq("id", pending.evaluationId)
    .single<{ reasoning: string | null; github_url: string | null; linkedin_url: string | null; injection_suspected: boolean }>();

  const previousStatus = await currentStatus(pending.evaluationId);
  const founderMessageId = await sendApprovalCard(
    config.founder_chat_id,
    {
      jobId: pending.jobId,
      eventName: config.name,
      guestName: pending.guestName,
      guestEmail: pending.guestEmail,
      score: pending.score,
      reasoning: evaluation?.reasoning ?? null,
      githubUrl: evaluation?.github_url ?? null,
      linkedinUrl: evaluation?.linkedin_url ?? null,
      injectionSuspected: evaluation?.injection_suspected ?? false,
      banner: `Escalated by ${actor.name}`,
    },
    { allowEscalate: false },
  );

  await db
    .from("attendee_evaluations")
    .update({ status: "escalated", decided_by: actor.role })
    .eq("id", pending.evaluationId);
  await audit({ pending, actor, action: "escalate", previousStatus, newStatus: "escalated", luma: "not_applicable", lumaError: null });

  // From here on only the founder can resolve this job.
  const oldCard = pending.card;
  await updatePending(pending.jobId, { escalated: true, card: { chatId: config.founder_chat_id, messageId: founderMessageId } });
  if (oldCard) {
    await editCard(oldCard.chatId, oldCard.messageId, `🚨 Escalated to the founder\n<b>${escapeHtml(pending.guestName ?? "Unknown")}</b>`)
      .catch((e) => console.error("editCard failed", e));
  }
}

async function currentStatus(evaluationId: string): Promise<EvaluationStatus> {
  const { data } = await supabaseAdmin()
    .from("attendee_evaluations")
    .select("status")
    .eq("id", evaluationId)
    .single<{ status: EvaluationStatus }>();
  return data?.status ?? "flagged_for_host";
}

async function audit(params: {
  pending: PendingApproval;
  actor: Actor;
  action: CardAction;
  previousStatus: EvaluationStatus;
  newStatus: EvaluationStatus;
  luma: "ok" | "error" | "not_applicable";
  lumaError: string | null;
}) {
  const { error } = await supabaseAdmin().from("host_audit_logs").insert({
    evaluation_id: params.pending.evaluationId,
    event_config_id: params.pending.eventConfigId,
    actor_telegram_id: params.actor.telegramId,
    actor_role: params.actor.role,
    action: params.action,
    previous_status: params.previousStatus,
    new_status: params.newStatus,
    luma_result: params.luma,
    luma_error: params.lumaError,
    telegram_message_id: params.pending.card?.messageId ?? null,
    metadata: { job_id: params.pending.jobId, ai_score: params.pending.score },
  });
  // The Luma call already happened; never lose the action because the log write failed.
  if (error) console.error("AUDIT WRITE FAILED", error, params);
}
