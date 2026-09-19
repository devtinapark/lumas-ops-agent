import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, type Query } from "./helpers/fake-supabase";
import type { PendingApproval } from "@/lib/redis";

const m = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import("./helpers/fake-supabase").fakeSupabase>,
  claimTelegramUpdate: vi.fn(),
  getPending: vi.fn(),
  acquireDecisionLock: vi.fn(),
  release: vi.fn(),
  resolvePending: vi.fn(),
  updatePending: vi.fn(),
  updateGuestStatus: vi.fn(),
  answerCallback: vi.fn(),
  editCard: vi.fn(),
  sendApprovalCard: vi.fn(),
  sendText: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => m.db.client }));
vi.mock("@/lib/redis", () => ({
  claimTelegramUpdate: m.claimTelegramUpdate,
  getPending: m.getPending,
  acquireDecisionLock: m.acquireDecisionLock,
  resolvePending: m.resolvePending,
  updatePending: m.updatePending,
}));
vi.mock("@/lib/luma", () => ({ updateGuestStatus: m.updateGuestStatus }));
vi.mock("@/lib/telegram", async (orig) => ({
  ...(await orig<typeof import("@/lib/telegram")>()),
  answerCallback: m.answerCallback,
  editCard: m.editCard,
  sendApprovalCard: m.sendApprovalCard,
  sendText: m.sendText,
}));

const { POST } = await import("@/app/api/telegram/action/route");

const SECRET = "tg-secret";
const JOB = "b".repeat(32);
const HOST = 111;
const FOUNDER = 222;
const HOST_CHAT = 111;
const FOUNDER_CHAT = 222;

const CONFIG = {
  id: "cfg-1",
  name: "VB Medellín",
  local_host_telegram_id: HOST,
  local_host_chat_id: HOST_CHAT,
  founder_telegram_id: FOUNDER,
  founder_chat_id: FOUNDER_CHAT,
};

let pending: PendingApproval | null;
let updateId = 1;

function basePending(): PendingApproval {
  return {
    jobId: JOB,
    evaluationId: "eval-1",
    eventConfigId: "cfg-1",
    lumaEventId: "evt-test",
    lumaGuestId: "gst-abc",
    guestEmail: "ana@example.com",
    guestName: "Ana",
    score: 60,
    escalated: false,
    card: { chatId: HOST_CHAT, messageId: 900 },
    createdAt: 0,
  };
}

function click(action: "a" | "w" | "e", opts: { from?: number; chat?: number; data?: string; secret?: string | null } = {}) {
  const body = {
    update_id: updateId++,
    callback_query: {
      id: "cbq-1",
      from: { id: opts.from ?? HOST, first_name: "Juan" },
      data: opts.data ?? `${action}:${JOB}`,
      message: { message_id: 900, chat: { id: opts.chat ?? HOST_CHAT } },
    },
  };
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.secret !== null) headers.set("x-telegram-bot-api-secret-token", opts.secret ?? SECRET);
  return POST(new Request("http://localhost/api/telegram/action", { method: "POST", body: JSON.stringify(body), headers }));
}

const audits = () => m.db.where("host_audit_logs", "insert").map((q: Query) => q.payload as Record<string, unknown>);
const evalUpdates = () => m.db.where("attendee_evaluations", "update").map((q: Query) => q.payload as Record<string, unknown>);
const lastAnswer = () => m.answerCallback.mock.calls.at(-1)?.[1] as string;

beforeEach(() => {
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("LUMA_API_KEY", "test-live-key");
  pending = basePending();
  m.db = fakeSupabase({
    event_configs: () => ({ data: CONFIG }),
    attendee_evaluations: (q) =>
      q.op === "select" ? { data: { status: "flagged_for_host", reasoning: "r", github_url: null, linkedin_url: null, injection_suspected: false } } : {},
    host_audit_logs: () => ({}),
  });
  for (const fn of Object.values(m)) if (typeof fn === "function" && "mockReset" in fn) fn.mockReset();
  m.claimTelegramUpdate.mockResolvedValue(true);
  m.getPending.mockImplementation(async () => pending);
  m.release.mockResolvedValue(undefined);
  m.acquireDecisionLock.mockResolvedValue(m.release);
  m.updateGuestStatus.mockResolvedValue(undefined);
  m.answerCallback.mockResolvedValue(undefined);
  m.editCard.mockResolvedValue(undefined);
  m.sendApprovalCard.mockResolvedValue(777);
  m.sendText.mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/telegram/action: authentication", () => {
  it("401s requests without Telegram's secret token", async () => {
    expect((await click("a", { secret: null })).status).toBe(401);
    expect((await click("a", { secret: "guess" })).status).toBe(401);
    expect(m.claimTelegramUpdate).not.toHaveBeenCalled();
    expect(m.updateGuestStatus).not.toHaveBeenCalled();
  });

  it("acknowledges non-button updates without acting", async () => {
    const res = await POST(
      new Request("http://localhost/api/telegram/action", {
        method: "POST",
        body: JSON.stringify({ update_id: 5, message: { text: "hi" } }),
        headers: { "x-telegram-bot-api-secret-token": SECRET },
      }),
    );
    expect(res.status).toBe(200);
    expect(m.getPending).not.toHaveBeenCalled();
  });

  it("ignores redelivered updates", async () => {
    m.claimTelegramUpdate.mockResolvedValue(false);
    await click("a");
    expect(m.getPending).not.toHaveBeenCalled();
  });

  it("rejects forged callback data", async () => {
    await click("a", { data: "a:not-a-job" });
    expect(lastAnswer()).toMatch(/Unrecognised/);
    expect(m.getPending).not.toHaveBeenCalled();
  });
});

describe("POST /api/telegram/action: authorisation", () => {
  it("rejects clicks from anyone but the host or founder", async () => {
    await click("a", { from: 999 });
    expect(lastAnswer()).toMatch(/not authorised/);
    expect(m.updateGuestStatus).not.toHaveBeenCalled();
    expect(audits()).toHaveLength(0);
  });

  it("rejects clicks on a copy of the card in another chat", async () => {
    await click("a", { chat: 12345 });
    expect(m.updateGuestStatus).not.toHaveBeenCalled();
  });

  it("tells the user when the decision was already made", async () => {
    pending = null;
    await click("a");
    expect(lastAnswer()).toMatch(/Already handled/);
    expect(m.updateGuestStatus).not.toHaveBeenCalled();
  });

  it("acts only once when a click is already being processed", async () => {
    m.acquireDecisionLock.mockResolvedValue(null);
    await click("a");
    expect(lastAnswer()).toMatch(/Already processing/);
    expect(m.updateGuestStatus).not.toHaveBeenCalled();
  });
});

describe("POST /api/telegram/action: decisions", () => {
  it("host approve: updates Luma, Supabase, the audit log and the card", async () => {
    await click("a");
    expect(m.updateGuestStatus).toHaveBeenCalledWith({ eventId: "evt-test", guestId: "gst-abc", status: "approved" });
    expect(evalUpdates()).toContainEqual(expect.objectContaining({ status: "host_approved", decided_by: "host", luma_sync_error: null }));
    expect(audits()).toEqual([
      expect.objectContaining({
        actor_telegram_id: HOST,
        actor_role: "host",
        action: "approve",
        previous_status: "flagged_for_host",
        new_status: "host_approved",
        luma_result: "ok",
      }),
    ]);
    expect(m.resolvePending).toHaveBeenCalledWith(JOB, "approve");
    expect(m.editCard).toHaveBeenCalledWith(HOST_CHAT, 900, expect.stringContaining("Approved by Juan"));
    expect(m.release).toHaveBeenCalled();
    expect(lastAnswer()).toBe("Done.");
  });

  it("host waitlist: moves the guest to Luma's waitlist", async () => {
    await click("w");
    expect(m.updateGuestStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "waitlist" }));
    expect(evalUpdates()).toContainEqual(expect.objectContaining({ status: "host_waitlisted" }));
    expect(m.resolvePending).toHaveBeenCalledWith(JOB, "waitlist");
  });

  it("keeps the card live and logs the failure when Luma rejects the update", async () => {
    m.updateGuestStatus.mockRejectedValue(new Error("Luma 500"));
    await click("a");
    expect(m.resolvePending).not.toHaveBeenCalled();
    expect(audits()[0]).toMatchObject({ luma_result: "error", luma_error: "Luma 500", new_status: "flagged_for_host" });
    expect(evalUpdates()).toContainEqual({ luma_sync_error: "Luma 500" });
    expect(lastAnswer()).toMatch(/try again/);
    expect(m.release).toHaveBeenCalled();
  });
});

describe("POST /api/telegram/action: escalation", () => {
  it("host escalate: hands the decision to the founder without touching Luma", async () => {
    await click("e");
    expect(m.updateGuestStatus).not.toHaveBeenCalled();
    expect(m.sendApprovalCard).toHaveBeenCalledWith(
      FOUNDER_CHAT,
      expect.objectContaining({ banner: "Escalated by Juan" }),
      { allowEscalate: false },
    );
    expect(m.updatePending).toHaveBeenCalledWith(JOB, { escalated: true, card: { chatId: FOUNDER_CHAT, messageId: 777 } });
    expect(audits()[0]).toMatchObject({ action: "escalate", new_status: "escalated", luma_result: "not_applicable" });
    expect(m.resolvePending).not.toHaveBeenCalled();
    expect(m.editCard).toHaveBeenCalledWith(HOST_CHAT, 900, expect.stringContaining("Escalated"));
  });

  it("once escalated, the host can no longer decide", async () => {
    pending = { ...basePending(), escalated: true, card: { chatId: FOUNDER_CHAT, messageId: 901 } };
    await click("a", { from: HOST, chat: FOUNDER_CHAT });
    expect(lastAnswer()).toMatch(/founder/);
    expect(m.updateGuestStatus).not.toHaveBeenCalled();
  });

  it("the founder resolves an escalation and the host is notified", async () => {
    pending = { ...basePending(), escalated: true, card: { chatId: FOUNDER_CHAT, messageId: 901 } };
    await click("a", { from: FOUNDER, chat: FOUNDER_CHAT });
    expect(m.updateGuestStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "approved" }));
    expect(audits()[0]).toMatchObject({ actor_role: "founder", actor_telegram_id: FOUNDER });
    expect(m.sendText).toHaveBeenCalledWith(HOST_CHAT, expect.stringContaining("founder"));
  });
});

describe("POST /api/telegram/action: simulation mode", () => {
  it("without LUMA_API_KEY, a host approval completes in simulated mode", async () => {
    vi.stubEnv("LUMA_API_KEY", "");
    vi.spyOn(console, "info").mockImplementation(() => {});
    await click("a");
    expect(m.updateGuestStatus).not.toHaveBeenCalled();
    expect(evalUpdates()).toContainEqual(expect.objectContaining({ status: "host_approved", luma_sync_mode: "simulated" }));
    expect(audits()[0]).toMatchObject({ luma_result: "ok", metadata: expect.objectContaining({ luma_mode: "simulated" }) });
    expect(m.resolvePending).toHaveBeenCalledWith(JOB, "approve");
  });

  it("simulated guests stay simulated even once a real key is configured", async () => {
    pending = { ...basePending(), lumaGuestId: "gst-sim-borderline-abc123" };
    vi.spyOn(console, "info").mockImplementation(() => {});
    await click("a");
    expect(m.updateGuestStatus).not.toHaveBeenCalled();
    expect(evalUpdates()).toContainEqual(expect.objectContaining({ luma_sync_mode: "simulated" }));
  });
});
