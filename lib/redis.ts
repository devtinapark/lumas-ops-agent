import { Redis } from "@upstash/redis";
import { randomUUID } from "node:crypto";

/**
 * Upstash Redis state for LumaOps.
 *
 * Human-in-the-loop model: on Vercel Hobby we cannot hold a function open while a human
 * decides, so the "interruption" is durable state rather than a suspended stream:
 *   job.status = "awaiting_host"  +  a `pending` record keyed by jobId.
 * The Telegram button press carries the jobId, loads the pending record, and resumes the flow.
 */

let client: Redis | undefined;
// Lazy so importing this module (e.g. during `next build`) never needs credentials.
const redis = () =>
  (client ??= new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN!,
  }));

const P = "lumaops";
const TTL = {
  webhookSeen: 60 * 60 * 24, // Luma retries within a day
  job: 60 * 60 * 24 * 2,
  pending: 60 * 60 * 24 * 7, // undecided cards expire after a week
  telegramUpdate: 60 * 60,
  lock: 30,
} as const;

const k = {
  webhook: (id: string) => `${P}:webhook:${id}`,
  job: (id: string) => `${P}:job:${id}`,
  pending: (id: string) => `${P}:pending:${id}`,
  lock: (id: string) => `${P}:lock:${id}`,
  tgUpdate: (id: number) => `${P}:tg-update:${id}`,
};

// ---------------------------------------------------------------------------
// Webhook parsing jobs
// ---------------------------------------------------------------------------

export type JobStatus =
  | "received"
  | "scoring"
  | "awaiting_host" // interrupted: waiting for a human button press
  | "completed"
  | "failed";

export interface WebhookJob {
  jobId: string;
  webhookId: string;
  lumaEventId: string;
  lumaGuestId: string;
  status: JobStatus;
  decision?: "approve" | "waitlist" | "escalate";
  error?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Idempotency gate for Luma retries. Returns true exactly once per Webhook-Id.
 * Call `releaseWebhook` if processing fails before any side effect so a retry can run again.
 */
export async function claimWebhook(webhookId: string): Promise<boolean> {
  const res = await redis().set(k.webhook(webhookId), Date.now(), { nx: true, ex: TTL.webhookSeen });
  return res === "OK";
}

export async function releaseWebhook(webhookId: string): Promise<void> {
  await redis().del(k.webhook(webhookId));
}

export async function createJob(
  input: Pick<WebhookJob, "webhookId" | "lumaEventId" | "lumaGuestId">,
): Promise<WebhookJob> {
  const now = Date.now();
  const job: WebhookJob = {
    // 32 hex chars: fits Telegram's 64-byte callback_data limit with a short prefix.
    jobId: randomUUID().replaceAll("-", ""),
    status: "received",
    createdAt: now,
    updatedAt: now,
    ...input,
  };
  await redis().set(k.job(job.jobId), job, { ex: TTL.job });
  return job;
}

export async function getJob(jobId: string): Promise<WebhookJob | null> {
  return redis().get<WebhookJob>(k.job(jobId));
}

export async function updateJob(
  jobId: string,
  patch: Partial<Omit<WebhookJob, "jobId">>,
): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;
  await redis().set(k.job(jobId), { ...job, ...patch, updatedAt: Date.now() }, { ex: TTL.job });
}

// ---------------------------------------------------------------------------
// Human-in-the-loop interruption state
// ---------------------------------------------------------------------------

export interface PendingApproval {
  jobId: string;
  evaluationId: string;
  eventConfigId: string;
  lumaEventId: string;
  lumaGuestId: string;
  guestEmail: string | null;
  guestName: string | null;
  score: number | null;
  /** Once true, only the founder may resolve it. */
  escalated: boolean;
  /** Where the live card lives, so it can be edited in place. */
  card: { chatId: number; messageId: number } | null;
  createdAt: number;
}

/** Pause the flow: persist everything needed to resume when a button is pressed. */
export async function pauseForHost(pending: PendingApproval): Promise<void> {
  await redis().set(k.pending(pending.jobId), pending, { ex: TTL.pending });
  await updateJob(pending.jobId, { status: "awaiting_host" });
}

export async function getPending(jobId: string): Promise<PendingApproval | null> {
  return redis().get<PendingApproval>(k.pending(jobId));
}

export async function updatePending(
  jobId: string,
  patch: Partial<Omit<PendingApproval, "jobId">>,
): Promise<PendingApproval | null> {
  const current = await getPending(jobId);
  if (!current) return null;
  const next = { ...current, ...patch };
  const ttl = await redis().ttl(k.pending(jobId));
  await redis().set(k.pending(jobId), next, { ex: ttl > 0 ? ttl : TTL.pending });
  return next;
}

/** Resume: the decision is final, so drop the pending record and close the job. */
export async function resolvePending(
  jobId: string,
  decision: NonNullable<WebhookJob["decision"]>,
): Promise<void> {
  await redis().del(k.pending(jobId));
  await updateJob(jobId, { status: "completed", decision });
}

// ---------------------------------------------------------------------------
// Decision lock: stops double-clicks and concurrent presses from acting twice
// ---------------------------------------------------------------------------

const RELEASE_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/** Returns a release function if the lock was acquired, otherwise null. */
export async function acquireDecisionLock(jobId: string): Promise<(() => Promise<void>) | null> {
  const token = randomUUID();
  const res = await redis().set(k.lock(jobId), token, { nx: true, ex: TTL.lock });
  if (res !== "OK") return null;
  return async () => {
    await redis().eval(RELEASE_LUA, [k.lock(jobId)], [token]);
  };
}

/** Telegram redelivers updates on non-2xx/timeouts; dedupe by update_id. */
export async function claimTelegramUpdate(updateId: number): Promise<boolean> {
  const res = await redis().set(k.tgUpdate(updateId), 1, { nx: true, ex: TTL.telegramUpdate });
  return res === "OK";
}
