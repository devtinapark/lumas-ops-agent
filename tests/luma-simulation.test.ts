import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeSupabase } from "./helpers/fake-supabase";

const m = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import("./helpers/fake-supabase").fakeSupabase>,
  updateGuestStatus: vi.fn(),
  isAdmin: vi.fn(),
  webhook: vi.fn(),
}));

vi.mock("@/lib/luma", async (orig) => ({ ...(await orig<typeof import("@/lib/luma")>()), updateGuestStatus: m.updateGuestStatus }));
vi.mock("@/lib/admin-auth", () => ({ isAdmin: m.isAdmin }));
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => m.db.client }));
vi.mock("@/app/api/webhooks/luma/route", () => ({ POST: m.webhook }));

const { approveGuest, waitlistGuest, lumaMode } = await import("@/lib/luma-client");
const { buildSimulatedRegistration, SIMULATION_TYPES } = await import("@/lib/luma-simulation-payloads");
const { parseGuestRegistered, verifyLumaSignature } = await import("@/lib/luma");
const { GET } = await import("@/app/api/simulations/luma/route");

const SECRET = "whsec_simulation_secret";
const guest = { eventId: "evt-test", guestId: "gst-real1" };

beforeEach(() => {
  for (const fn of [m.updateGuestStatus, m.isAdmin, m.webhook]) fn.mockReset();
  m.updateGuestStatus.mockResolvedValue(undefined);
  m.isAdmin.mockResolvedValue(false);
  m.webhook.mockResolvedValue(Response.json({ ok: true, route: "auto_approve", score: 93 }));
  m.db = fakeSupabase({ event_configs: () => ({ data: { luma_event_id: "evt-default" } }) });
  vi.stubEnv("LUMA_API_KEY", "");
  vi.stubEnv("LUMA_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("NODE_ENV", "development");
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("luma-client", () => {
  it("simulates when LUMA_API_KEY is missing, empty or whitespace", async () => {
    for (const key of ["", "   "]) {
      vi.stubEnv("LUMA_API_KEY", key);
      expect(await approveGuest(guest)).toEqual({ success: true, mode: "simulated" });
    }
    expect(m.updateGuestStatus).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith(
      "[luma:simulated] POST /v1/events/guests/update-status",
      { event_id: "evt-test", guest_id: "gst-real1", status: "approved" },
    );
  });

  it("calls the real API as soon as a key is present, without a restart", async () => {
    expect(lumaMode()).toBe("simulated");
    vi.stubEnv("LUMA_API_KEY", "live-key");
    expect(await approveGuest(guest)).toEqual({ success: true, mode: "live" });
    expect(await waitlistGuest(guest)).toEqual({ success: true, mode: "live" });
    expect(m.updateGuestStatus).toHaveBeenNthCalledWith(1, { ...guest, status: "approved" });
    expect(m.updateGuestStatus).toHaveBeenNthCalledWith(2, { ...guest, status: "waitlist" });
  });

  it("propagates live API failures so callers can retry", async () => {
    vi.stubEnv("LUMA_API_KEY", "live-key");
    m.updateGuestStatus.mockRejectedValue(new Error("Luma 500"));
    await expect(approveGuest(guest)).rejects.toThrow("Luma 500");
  });

  it("never sends simulated guests to the real API", async () => {
    vi.stubEnv("LUMA_API_KEY", "live-key");
    expect(await approveGuest({ eventId: "evt-test", guestId: "gst-sim-rockstar-1" })).toMatchObject({ mode: "simulated" });
    expect(m.updateGuestStatus).not.toHaveBeenCalled();
  });
});

describe("simulation payloads", () => {
  it.each(SIMULATION_TYPES)("%s parses with the production parser", (type) => {
    const sim = buildSimulatedRegistration(type, "evt-test");
    const parsed = parseGuestRegistered(JSON.stringify(sim.payload));
    expect(parsed).toMatchObject({
      kind: "registration",
      registration: { lumaGuestId: sim.guestId, lumaEventId: "evt-test", approvalStatus: "pending_approval" },
    });
    expect(sim.guestId.startsWith("gst-sim-")).toBe(true);
    expect(sim.payload.data.guest.email).toMatch(/@example\.com$/);
  });

  it("gives the rockstar extractable GitHub and LinkedIn links", () => {
    const parsed = parseGuestRegistered(JSON.stringify(buildSimulatedRegistration("rockstar", "evt-test").payload));
    expect(parsed).toMatchObject({ registration: { githubUrl: expect.stringContaining("github.com"), linkedinUrl: expect.stringContaining("linkedin.com") } });
  });

  it("mints fresh guest and webhook ids on every call", () => {
    const a = buildSimulatedRegistration("borderline", "evt-test");
    const b = buildSimulatedRegistration("borderline", "evt-test");
    expect(a.guestId).not.toBe(b.guestId);
    expect(a.webhookId).not.toBe(b.webhookId);
  });

  it("maps each profile to its intended route", () => {
    expect(SIMULATION_TYPES.map((t) => buildSimulatedRegistration(t, "evt-x").expectedRoute)).toEqual([
      "auto_approve",
      "host_review",
      "auto_waitlist",
    ]);
  });
});

const get = (qs: string) => GET(new NextRequest(`http://localhost/api/simulations/luma${qs}`));

describe("GET /api/simulations/luma", () => {
  it("hands the real webhook handler a correctly signed delivery", async () => {
    const res = await get("?type=rockstar&event=evt-abc");
    expect(res.status).toBe(200);
    const req = m.webhook.mock.calls[0][0] as Request;
    const raw = await req.text();
    expect(verifyLumaSignature(raw, req.headers, SECRET)).toEqual({ ok: true });
    expect(JSON.parse(raw).data.guest.event_api_id).toBe("evt-abc");
    expect(await res.json()).toMatchObject({
      simulation: { type: "rockstar", expectedRoute: "auto_approve", matchedExpectation: true, lumaMode: "simulated" },
      webhook: { status: 200, route: "auto_approve", score: 93 },
    });
  });

  it("defaults to the latest active event", async () => {
    await get("?type=unaligned");
    const raw = await (m.webhook.mock.calls[0][0] as Request).text();
    expect(JSON.parse(raw).data.guest.event_api_id).toBe("evt-default");
  });

  it("reports when the AI routed differently than the profile intended", async () => {
    m.webhook.mockResolvedValue(Response.json({ ok: true, route: "host_review", score: 80 }));
    expect(await (await get("?type=rockstar")).json()).toMatchObject({ simulation: { matchedExpectation: false } });
  });

  it.each(["", "?type=hacker", "?type=rockstar&event=../../x"])("400s bad query %j", async (qs) => {
    expect((await get(qs)).status).toBe(400);
    expect(m.webhook).not.toHaveBeenCalled();
  });

  it("explains a missing signing secret", async () => {
    vi.stubEnv("LUMA_WEBHOOK_SECRET", "");
    const res = await get("?type=rockstar");
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/LUMA_WEBHOOK_SECRET/);
  });

  it("404s when there is no active event", async () => {
    m.db = fakeSupabase({ event_configs: () => ({ data: null }) });
    expect((await get("?type=rockstar")).status).toBe(404);
  });

  it("in production, is hidden from anyone but the signed-in founder", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await get("?type=rockstar")).status).toBe(404);
    expect(m.webhook).not.toHaveBeenCalled();
    m.isAdmin.mockResolvedValue(true);
    expect((await get("?type=rockstar")).status).toBe(200);
  });

  it("surfaces webhook failures as 502", async () => {
    m.webhook.mockResolvedValue(Response.json({ error: "processing failed" }, { status: 502 }));
    expect((await get("?type=rockstar")).status).toBe(502);
  });
});
