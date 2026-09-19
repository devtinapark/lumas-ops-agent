import { NextResponse } from "next/server";
import { supabaseAdmin, type EventConfig, type EvaluationStatus } from "@/lib/supabase";
import { parseGuestRegistered, updateGuestStatus, verifyLumaSignature, type ParsedRegistration } from "@/lib/luma";
import { scoreApplicant, type AttendeeScore } from "@/lib/scoring";
import { claimWebhook, createJob, pauseForHost, releaseWebhook, updateJob, updatePending } from "@/lib/redis";
import { sendApprovalCard } from "@/lib/telegram";

export const runtime = "nodejs";
// Scoring + Luma + Telegram calls run inline so a failure returns non-2xx and Luma retries.
export const maxDuration = 60;

type Route = "auto_approve" | "auto_waitlist" | "host_review";

export async function POST(request: Request) {
  // 1. Verify the signature over the *raw* body before trusting anything in it.
  const rawBody = await request.text();
  const secret = process.env.LUMA_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "server misconfigured" }, { status: 500 });

  const sig = verifyLumaSignature(rawBody, request.headers, secret);
  if (!sig.ok) {
    console.warn("luma webhook rejected:", sig.reason);
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  // 2. Extract questionnaire data, links, and bio.
  const parsed = parseGuestRegistered(rawBody);
  if (parsed.kind === "ignored") return NextResponse.json({ ok: true, ignored: parsed.type });
  if (parsed.kind === "invalid") {
    console.error("luma webhook unparseable:", parsed.reason);
    return NextResponse.json({ error: parsed.reason }, { status: 400 });
  }
  const reg = parsed.registration;
  if (reg.approvalStatus === "approved" || reg.approvalStatus === "declined") {
    return NextResponse.json({ ok: true, ignored: `already ${reg.approvalStatus}` });
  }

  const db = supabaseAdmin();
  const { data: config, error: configError } = await db
    .from("event_configs")
    .select("*")
    .eq("luma_event_id", reg.lumaEventId)
    .eq("active", true)
    .maybeSingle<EventConfig>();
  if (configError) return NextResponse.json({ error: "db error" }, { status: 500 });
  if (!config) return NextResponse.json({ ok: true, ignored: "event not managed" });

  // Idempotency: Luma retries deliveries; act exactly once per Webhook-Id.
  const webhookId = request.headers.get("webhook-id") ?? `${reg.lumaGuestId}:${reg.lumaEventId}`;
  if (!(await claimWebhook(webhookId))) return NextResponse.json({ ok: true, duplicate: true });

  try {
    const { data: existing } = await db
      .from("attendee_evaluations")
      .select("id, status")
      .eq("event_config_id", config.id)
      .eq("luma_guest_id", reg.lumaGuestId)
      .maybeSingle<{ id: string; status: EvaluationStatus }>();
    // Already decided (e.g. Luma retried after our claim expired): never overwrite a decision.
    if (existing && existing.status !== "flagged_for_host") {
      return NextResponse.json({ ok: true, duplicate: true });
    }

    const job = await createJob({ webhookId, lumaEventId: reg.lumaEventId, lumaGuestId: reg.lumaGuestId });
    await updateJob(job.jobId, { status: "scoring" });

    // 3. Score with gpt-4o-mini. null means the model failed -> a human decides.
    const ai = await scoreApplicant(reg);
    const { route, note } = await decideRoute(config, ai);
    const reasoning = [ai?.reasoning ?? "AI evaluation unavailable; needs human review.", note]
      .filter(Boolean)
      .join(" ");

    // 4. Route.
    if (route === "auto_approve" || route === "auto_waitlist") {
      const approve = route === "auto_approve";
      await updateGuestStatus({
        eventId: reg.lumaEventId,
        guestId: reg.lumaGuestId,
        status: approve ? "approved" : "waitlist",
      });
      await saveEvaluation(config, reg, ai, reasoning, webhookId, {
        status: approve ? "auto_approved" : "waitlisted",
        decided_by: "ai",
        decided_at: new Date().toISOString(),
      });
      await updateJob(job.jobId, { status: "completed", decision: approve ? "approve" : "waitlist" });
      return NextResponse.json({ ok: true, route, score: ai?.score });
    }

    const evaluationId = await saveEvaluation(config, reg, ai, reasoning, webhookId, {
      status: "flagged_for_host",
    }, existing?.id);

    // Pause first (card: null) so a very fast button press can never miss its pending record.
    await pauseForHost({
      jobId: job.jobId,
      evaluationId,
      eventConfigId: config.id,
      lumaEventId: reg.lumaEventId,
      lumaGuestId: reg.lumaGuestId,
      guestEmail: reg.email,
      guestName: reg.name,
      score: ai?.score ?? null,
      escalated: false,
      card: null,
      createdAt: Date.now(),
    });
    const messageId = await sendApprovalCard(
      config.local_host_chat_id,
      {
        jobId: job.jobId,
        eventName: config.name,
        guestName: reg.name,
        guestEmail: reg.email,
        score: ai?.score ?? null,
        reasoning,
        githubUrl: reg.githubUrl,
        linkedinUrl: reg.linkedinUrl,
        injectionSuspected: ai?.injection_suspected ?? false,
      },
      { allowEscalate: true },
    );
    await updatePending(job.jobId, { card: { chatId: config.local_host_chat_id, messageId } });
    return NextResponse.json({ ok: true, route, score: ai?.score });
  } catch (err) {
    // Nothing irreversible is half-done (Luma calls are idempotent), so let Luma retry.
    console.error("luma webhook processing failed", err);
    await releaseWebhook(webhookId).catch(() => {});
    return NextResponse.json({ error: "processing failed" }, { status: 502 });
  }
}

async function decideRoute(
  config: EventConfig,
  ai: AttendeeScore | null,
): Promise<{ route: Route; note?: string }> {
  if (!ai) return { route: "host_review" };
  if (ai.score < config.auto_waitlist_threshold) return { route: "auto_waitlist" };
  if (ai.score < config.auto_approve_threshold) return { route: "host_review" };

  // Score qualifies for auto-approval; the guardrails below can still hand it to a human.
  if (ai.injection_suspected) {
    return { route: "host_review", note: "Auto-approval blocked: possible prompt injection." };
  }
  const { count } = await supabaseAdmin()
    .from("attendee_evaluations")
    .select("id", { count: "exact", head: true })
    .eq("event_config_id", config.id)
    .in("status", ["auto_approved", "host_approved"]);
  const approved = count ?? 0;
  const overCapacity = config.venue_capacity != null && approved >= config.venue_capacity;
  const overBudget =
    config.budget_cap_cents > 0 &&
    config.cost_per_head_cents > 0 &&
    (approved + 1) * config.cost_per_head_cents > config.budget_cap_cents;
  if (overCapacity || overBudget) {
    return { route: "host_review", note: "Auto-approval paused: venue capacity/budget cap reached." };
  }
  return { route: "auto_approve" };
}

async function saveEvaluation(
  config: EventConfig,
  reg: ParsedRegistration,
  ai: AttendeeScore | null,
  reasoning: string,
  webhookId: string,
  outcome: { status: EvaluationStatus; decided_by?: string; decided_at?: string },
  existingId?: string,
): Promise<string> {
  const { data, error } = await supabaseAdmin()
    .from("attendee_evaluations")
    .upsert(
      {
        ...(existingId ? { id: existingId } : {}),
        event_config_id: config.id,
        luma_guest_id: reg.lumaGuestId,
        luma_event_id: reg.lumaEventId,
        luma_webhook_id: webhookId,
        email: reg.email,
        full_name: reg.name,
        answers: reg.answers.map((a) => ({ label: a.question, answer: a.answer })),
        github_url: reg.githubUrl,
        linkedin_url: reg.linkedinUrl,
        project_bio: reg.projectBio,
        role: ai?.role ?? null,
        skills: ai?.skills ?? [],
        score: ai?.score ?? null,
        reasoning,
        injection_suspected: ai?.injection_suspected ?? false,
        ...outcome,
      },
      { onConflict: "event_config_id,luma_guest_id" },
    )
    .select("id")
    .single<{ id: string }>();
  if (error) throw new Error(`saveEvaluation failed: ${error.message}`);
  return data.id;
}
