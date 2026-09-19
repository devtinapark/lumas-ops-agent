import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const LUMA_API_BASE = "https://public-api.luma.com";
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

// ---------------------------------------------------------------------------
// Webhook signature verification
// Luma signs `${timestamp}.${rawBody}` with HMAC-SHA256 (hex) using the whsec_ secret.
// Header: `Webhook-Signature: t=<unix>,v1=<hex>`.
// ---------------------------------------------------------------------------

export type SignatureResult = { ok: true } | { ok: false; reason: string };

export function verifyLumaSignature(rawBody: string, headers: Headers, secret: string): SignatureResult {
  const header = headers.get("webhook-signature");
  if (!header) return { ok: false, reason: "missing webhook-signature header" };

  let timestamp: string | undefined = headers.get("webhook-timestamp") ?? undefined;
  const candidates: string[] = [];
  for (const part of header.split(/[,\s]+/)) {
    const [key, value] = part.split("=");
    if (key === "t" && value) timestamp = value;
    if (key === "v1" && value) candidates.push(value);
  }
  if (!timestamp || candidates.length === 0) return { ok: false, reason: "malformed signature header" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "invalid timestamp" };
  if (Math.abs(Date.now() / 1000 - ts) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp outside tolerance (possible replay)" };
  }

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  const match = candidates.some((sig) => {
    const given = Buffer.from(sig, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return match ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

/** Produces the headers Luma would send, so simulated deliveries pass the real verifier. */
export function signLumaPayload(rawBody: string, secret: string, webhookId: string, nowMs = Date.now()): Headers {
  const timestamp = String(Math.floor(nowMs / 1000));
  const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return new Headers({
    "content-type": "application/json",
    "webhook-id": webhookId,
    "webhook-timestamp": timestamp,
    "webhook-signature": `t=${timestamp},v1=${signature}`,
  });
}

// ---------------------------------------------------------------------------
// Payload parsing (deliberately tolerant: Luma's guest payload shape is only partially
// documented, so we accept the known variants and validate what we actually need).
// ---------------------------------------------------------------------------

const answerSchema = z.object({
  label: z.string().optional(),
  question_id: z.string().optional(),
  answer: z.unknown().optional(),
  value: z.unknown().optional(),
  value_text: z.string().optional(),
});

const guestSchema = z
  .object({
    api_id: z.string().optional(),
    id: z.string().optional(),
    guest_id: z.string().optional(),
    event_api_id: z.string().optional(),
    event_id: z.string().optional(),
    event: z.object({ api_id: z.string().optional(), id: z.string().optional() }).optional(),
    email: z.string().optional(),
    user_email: z.string().optional(),
    name: z.string().nullish(),
    user_name: z.string().nullish(),
    approval_status: z.string().optional(),
    registration_answers: z.array(answerSchema).nullish(),
  })
  .passthrough();

const envelopeSchema = z.object({
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
});

export interface QuestionAnswer {
  question: string;
  answer: string;
}

export interface ParsedRegistration {
  lumaGuestId: string;
  lumaEventId: string;
  approvalStatus: string | undefined;
  email: string | null;
  name: string | null;
  answers: QuestionAnswer[];
  githubUrl: string | null;
  linkedinUrl: string | null;
  projectBio: string | null;
}

export type ParseResult =
  | { kind: "ignored"; type: string }
  | { kind: "registration"; registration: ParsedRegistration }
  | { kind: "invalid"; reason: string };

// Strips control characters (keeps \t \n \r) and caps length; applicant text is untrusted.
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const clean = (s: string, max = 1500) => s.replace(CONTROL_CHARS, "").trim().slice(0, max);

function answerText(a: z.infer<typeof answerSchema>): string {
  if (a.value_text) return a.value_text;
  const raw = a.answer ?? a.value;
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.join(", ");
  return JSON.stringify(raw);
}

export function parseGuestRegistered(rawBody: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { kind: "invalid", reason: "body is not JSON" };
  }
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) return { kind: "invalid", reason: "missing type/data envelope" };
  if (envelope.data.type !== "guest.registered") return { kind: "ignored", type: envelope.data.type };

  // Some payloads nest the guest under data.guest, others inline it in data.
  const nested = envelope.data.data.guest;
  const guest = guestSchema.safeParse(
    nested && typeof nested === "object" ? { ...envelope.data.data, ...nested } : envelope.data.data,
  );
  if (!guest.success) return { kind: "invalid", reason: "unrecognised guest shape" };
  const g = guest.data;

  const lumaGuestId = g.api_id ?? g.guest_id ?? g.id;
  const lumaEventId = g.event_api_id ?? g.event_id ?? g.event?.api_id ?? g.event?.id;
  if (!lumaGuestId || !lumaEventId) return { kind: "invalid", reason: "missing guest or event id" };

  const answers: QuestionAnswer[] = (g.registration_answers ?? [])
    .map((a) => ({ question: clean(a.label ?? a.question_id ?? "question", 200), answer: clean(answerText(a)) }))
    .filter((a) => a.answer.length > 0);

  const haystack = answers.map((a) => a.answer).join("\n");
  const githubUrl = haystack.match(/https?:\/\/(?:www\.)?github\.com\/[\w.-]+(?:\/[\w.-]+)?/i)?.[0] ?? null;
  const linkedinUrl = haystack.match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|company)\/[\w%.-]+/i)?.[0] ?? null;
  const projectBio =
    answers.find((a) => /bio|project|building|about|working on/i.test(a.question))?.answer ?? null;

  return {
    kind: "registration",
    registration: {
      lumaGuestId,
      lumaEventId,
      approvalStatus: g.approval_status,
      email: g.email ?? g.user_email ?? null,
      name: g.name ?? g.user_name ?? null,
      answers,
      githubUrl,
      linkedinUrl,
      projectBio,
    },
  };
}

// ---------------------------------------------------------------------------
// Luma API client (founder-held key; never exposed to the host)
// ---------------------------------------------------------------------------

export type LumaGuestStatus = "approved" | "declined" | "pending_approval" | "waitlist";

export class LumaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** POST /v1/events/guests/update-status */
export async function updateGuestStatus(params: {
  eventId: string;
  guestId: string;
  status: LumaGuestStatus;
  sendEmail?: boolean;
}): Promise<void> {
  const apiKey = process.env.LUMA_API_KEY;
  if (!apiKey) throw new Error("Missing required env var LUMA_API_KEY");

  const res = await fetch(`${LUMA_API_BASE}/v1/events/guests/update-status`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-luma-api-key": apiKey },
    body: JSON.stringify({
      event_id: params.eventId,
      guest_id: params.guestId,
      status: params.status,
      send_email: params.sendEmail ?? true,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const detail = clean(await res.text().catch(() => ""), 300);
    throw new LumaApiError(`Luma update-status failed (${res.status}): ${detail}`, res.status);
  }
}
