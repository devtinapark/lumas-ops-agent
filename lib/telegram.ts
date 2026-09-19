import { createHash, timingSafeEqual } from "node:crypto";

export type CardAction = "approve" | "waitlist" | "escalate";

const PREFIX: Record<CardAction, string> = { approve: "a", waitlist: "w", escalate: "e" };
const FROM_PREFIX = Object.fromEntries(
  Object.entries(PREFIX).map(([action, p]) => [p, action]),
) as Record<string, CardAction>;

/** callback_data is capped at 64 bytes by Telegram: "<a|w|e>:<32-hex jobId>" is 34. */
export function encodeCallback(action: CardAction, jobId: string): string {
  return `${PREFIX[action]}:${jobId}`;
}

export function decodeCallback(data: string | undefined): { action: CardAction; jobId: string } | null {
  const match = data?.match(/^([awe]):([0-9a-f]{32})$/);
  if (!match) return null;
  return { action: FROM_PREFIX[match[1]], jobId: match[2] };
}

/**
 * Telegram authenticates webhook deliveries with the `secret_token` you pass to setWebhook,
 * echoed back in X-Telegram-Bot-Api-Secret-Token. (Callback queries themselves carry no hash;
 * the Login Widget / Mini App `hash` scheme does not apply here.)
 */
export function verifyTelegramSecret(headers: Headers): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  const given = headers.get("x-telegram-bot-api-secret-token");
  if (!expected || !given) return false;
  // Hash both sides so lengths match and timing leaks nothing about the secret.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export const escapeHtml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing required env var TELEGRAM_BOT_TOKEN");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description ?? res.status}`);
  return json.result;
}

export interface CardInput {
  jobId: string;
  eventName: string;
  guestName: string | null;
  guestEmail: string | null;
  score: number | null;
  reasoning: string | null;
  githubUrl: string | null;
  linkedinUrl: string | null;
  injectionSuspected: boolean;
  /** Extra line shown above the body, e.g. escalation context. */
  banner?: string;
}

export function renderCardText(c: CardInput): string {
  const lines = [
    c.banner ? `<b>${escapeHtml(c.banner)}</b>` : null,
    `<b>${escapeHtml(c.eventName)}</b> — new applicant`,
    `<b>${escapeHtml(c.guestName ?? "Unknown")}</b>${c.guestEmail ? ` (${escapeHtml(c.guestEmail)})` : ""}`,
    `AI score: <b>${c.score ?? "n/a (AI unavailable)"}</b>`,
    c.injectionSuspected ? "⚠️ Applicant text tried to manipulate the evaluator." : null,
    c.reasoning ? `<i>${escapeHtml(c.reasoning)}</i>` : null,
    c.githubUrl ? `GitHub: ${escapeHtml(c.githubUrl)}` : null,
    c.linkedinUrl ? `LinkedIn: ${escapeHtml(c.linkedinUrl)}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

export async function sendApprovalCard(
  chatId: number,
  card: CardInput,
  opts: { allowEscalate: boolean },
): Promise<number> {
  const row = [
    { text: "✅ Approve", callback_data: encodeCallback("approve", card.jobId) },
    { text: "⏳ Waitlist", callback_data: encodeCallback("waitlist", card.jobId) },
    ...(opts.allowEscalate
      ? [{ text: "🚨 Escalate", callback_data: encodeCallback("escalate", card.jobId) }]
      : []),
  ];
  const msg = await call<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text: renderCardText(card),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [row] },
  });
  return msg.message_id;
}

/** Replace the card text and drop the buttons so a decided card cannot be pressed again. */
export function editCard(chatId: number, messageId: number, html: string) {
  return call("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [] },
  });
}

export function answerCallback(callbackQueryId: string, text: string, alert = false) {
  return call("answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert: alert });
}

export function sendText(chatId: number, html: string) {
  return call("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML" });
}
