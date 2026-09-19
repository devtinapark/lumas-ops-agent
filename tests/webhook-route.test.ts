import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, type Query } from "./helpers/fake-supabase";
import { TEST_SECRET, registration, signedHeaders } from "./helpers/luma";

const m = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import("./helpers/fake-supabase").fakeSupabase>,
  claimWebhook: vi.fn(),
  releaseWebhook: vi.fn(),
  createJob: vi.fn(),
  updateJob: vi.fn(),
  pauseForHost: vi.fn(),
  updatePending: vi.fn(),
  scoreApplicant: vi.fn(),
  sendApprovalCard: vi.fn(),
  updateGuestStatus: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => m.db.client }));
vi.mock("@/lib/redis", () => ({
  claimWebhook: m.claimWebhook,
  releaseWebhook: m.releaseWebhook,
  createJob: m.createJob,
  updateJob: m.updateJob,
  pauseForHost: m.pauseForHost,
  updatePending: m.updatePending,
}));
vi.mock("@/lib/scoring", () => ({ scoreApplicant: m.scoreApplicant }));
vi.mock("@/lib/telegram", () => ({ sendApprovalCard: m.sendApprovalCard }));
vi.mock("@/lib/luma", async (orig) => ({ ...(await orig<typeof import("@/lib/luma")>()), updateGuestStatus: m.updateGuestStatus }));

const { POST } = await import("@/app/api/webhooks/luma/route");

const CONFIG = {
  id: "cfg-1",
  luma_event_id: "evt-test",
  name: "VB Medellín",
  active: true,
  auto_approve_threshold: 85,
  auto_waitlist_threshold: 40,
  budget_cap_cents: 0,
  cost_per_head_cents: 0,
  venue_capacity: null as number | null,
  local_host_name: "Host",
  local_host_telegram_id: 111,
  local_host_chat_id: 111,
  founder_telegram_id: 222,
  founder_chat_id: 222,
};

let config: typeof CONFIG | null;
let existing: { id: string; status: string } | null;
let approvedCount: number;

function score(n: number | null, extra: Partial<{ injection_suspected: boolean }> = {}) {
  m.scoreApplicant.mockResolvedValue(
    n === null ? null : { score: n, reasoning: "reason", role: "Engineer", skills: ["TS"], injection_suspected: false, ...extra },
  );
}

function post(body: unknown, headers?: Headers) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return POST(new Request("http://localhost/api/webhooks/luma", { method: "POST", body: raw, headers: headers ?? signedHeaders(raw) }));
}

const upserts = () => m.db.where("attendee_evaluations", "upsert").map((q: Query) => q.payload as Record<string, unknown>);

beforeEach(() => {
  vi.stubEnv("LUMA_WEBHOOK_SECRET", TEST_SECRET);
  vi.stubEnv("LUMA_API_KEY", "test-live-key");
  config = { ...CONFIG };
  existing = null;
  approvedCount = 0;
  m.db = fakeSupabase({
    event_configs: () => ({ data: config }),
    attendee_evaluations: (q) => {
      if (q.op === "upsert") return { data: { id: "eval-1" } };
      if (q.terminal === "maybeSingle") return { data: existing };
      return { count: approvedCount };
    },
  });
  for (const fn of Object.values(m)) if (typeof fn === "function" && "mockReset" in fn) fn.mockReset();
  m.claimWebhook.mockResolvedValue(true);
  m.releaseWebhook.mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  m.createJob.mockResolvedValue({ jobId: "a".repeat(32) });
  m.sendApprovalCard.mockResolvedValue(555);
  m.updateGuestStatus.mockResolvedValue(undefined);
  score(90);
});

describe("POST /api/webhooks/luma: authentication", () => {
  it("500s when the webhook secret is not configured", async () => {
    vi.stubEnv("LUMA_WEBHOOK_SECRET", "");
    expect((await post(registration())).status).toBe(500);
  });

  it("401s a bad signature before touching any state", async () => {
    const raw = JSON.stringify(registration());
    const res = await post(raw.replace("Ana", "Eve"), signedHeaders(raw));
    expect(res.status).toBe(401);
    expect(m.db.queries).toHaveLength(0);
    expect(m.claimWebhook).not.toHaveBeenCalled();
    expect(m.scoreApplicant).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/luma: filtering", () => {
  it("ignores non-registration events", async () => {
    const res = await post({ type: "guest.updated", data: {} });
    expect(await res.json()).toMatchObject({ ok: true, ignored: "guest.updated" });
    expect(m.claimWebhook).not.toHaveBeenCalled();
  });

  it("400s a signed but unparseable payload", async () => {
    expect((await post({ type: "guest.registered", data: { nothing: true } })).status).toBe(400);
  });

  it("ignores events without an active config", async () => {
    config = null;
    const res = await post(registration());
    expect(await res.json()).toMatchObject({ ignored: "event not managed" });
    expect(m.scoreApplicant).not.toHaveBeenCalled();
  });

  it("ignores guests Luma already approved", async () => {
    const res = await post(registration({ approval_status: "approved" }));
    expect(await res.json()).toMatchObject({ ignored: "already approved" });
  });

  it("acts once per Webhook-Id", async () => {
    m.claimWebhook.mockResolvedValue(false);
    expect(await (await post(registration())).json()).toMatchObject({ duplicate: true });
    expect(m.scoreApplicant).not.toHaveBeenCalled();
  });

  it("never re-decides an applicant that already has a decision", async () => {
    existing = { id: "eval-1", status: "host_approved" };
    expect(await (await post(registration())).json()).toMatchObject({ duplicate: true });
    expect(m.updateGuestStatus).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/luma: routing", () => {
  it("auto-approves high scores in Luma and records it", async () => {
    score(92);
    const res = await post(registration());
    expect(await res.json()).toMatchObject({ route: "auto_approve", score: 92 });
    expect(m.updateGuestStatus).toHaveBeenCalledWith({ eventId: "evt-test", guestId: "gst-abc", status: "approved" });
    expect(upserts()[0]).toMatchObject({
      status: "auto_approved",
      decided_by: "ai",
      score: 92,
      github_url: "https://github.com/ana/agent",
      role: "Engineer",
    });
    expect(m.sendApprovalCard).not.toHaveBeenCalled();
  });

  it("auto-waitlists low scores", async () => {
    score(12);
    await post(registration());
    expect(m.updateGuestStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "waitlist" }));
    expect(upserts()[0]).toMatchObject({ status: "waitlisted" });
  });

  it("sends mid scores to the host and pauses before the card goes out", async () => {
    score(60);
    const res = await post(registration());
    expect(await res.json()).toMatchObject({ route: "host_review" });
    expect(m.updateGuestStatus).not.toHaveBeenCalled();
    expect(upserts()[0]).toMatchObject({ status: "flagged_for_host" });

    expect(m.pauseForHost).toHaveBeenCalledWith(expect.objectContaining({ evaluationId: "eval-1", escalated: false, card: null }));
    expect(m.pauseForHost.mock.invocationCallOrder[0]).toBeLessThan(m.sendApprovalCard.mock.invocationCallOrder[0]);
    expect(m.sendApprovalCard).toHaveBeenCalledWith(111, expect.objectContaining({ score: 60 }), { allowEscalate: true });
    expect(m.updatePending).toHaveBeenCalledWith("a".repeat(32), { card: { chatId: 111, messageId: 555 } });
  });

  it("falls back to a human when the AI fails", async () => {
    score(null);
    await post(registration());
    expect(m.updateGuestStatus).not.toHaveBeenCalled();
    expect(upserts()[0]).toMatchObject({ status: "flagged_for_host", score: null });
  });

  it("sends a high scorer to the host once venue capacity is reached", async () => {
    config!.venue_capacity = 10;
    approvedCount = 10;
    score(97);
    await post(registration());
    expect(m.updateGuestStatus).not.toHaveBeenCalled();
    expect(upserts()[0]).toMatchObject({ status: "flagged_for_host", reasoning: expect.stringContaining("capacity") });
  });

  it("sends suspected prompt injection to the host even with a perfect score", async () => {
    score(100, { injection_suspected: true });
    await post(registration());
    expect(m.updateGuestStatus).not.toHaveBeenCalled();
    expect(upserts()[0]).toMatchObject({ status: "flagged_for_host", injection_suspected: true });
  });
});

describe("POST /api/webhooks/luma: failures", () => {
  it("502s and releases the idempotency claim so Luma can retry", async () => {
    score(92);
    m.updateGuestStatus.mockRejectedValue(new Error("Luma down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post(registration());
    expect(res.status).toBe(502);
    expect(m.releaseWebhook).toHaveBeenCalledWith("wh_1");
    expect(upserts()).toHaveLength(0);
  });
});

describe("POST /api/webhooks/luma: simulation mode", () => {
  it("without LUMA_API_KEY, auto-decisions are recorded as simulated and Luma is never called", async () => {
    vi.stubEnv("LUMA_API_KEY", "");
    vi.spyOn(console, "info").mockImplementation(() => {});
    score(92);
    const res = await post(registration());
    expect(await res.json()).toMatchObject({ route: "auto_approve", lumaMode: "simulated" });
    expect(m.updateGuestStatus).not.toHaveBeenCalled();
    expect(upserts()[0]).toMatchObject({ status: "auto_approved", luma_sync_mode: "simulated" });
  });

  it("with LUMA_API_KEY, records the live sync", async () => {
    score(92);
    await post(registration());
    expect(upserts()[0]).toMatchObject({ luma_sync_mode: "live" });
  });
});
