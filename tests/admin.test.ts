import { describe, expect, it } from "vitest";
import {
  SESSION_TTL_SECONDS,
  checkAdminPassword,
  createSessionToken,
  sessionSecretProblem,
  verifySessionToken,
} from "@/lib/admin-session";
import { parseEventConfigForm } from "@/lib/admin-schema";

const SECRET = "a".repeat(48);

describe("admin session token", () => {
  it("verifies a fresh token", () => {
    expect(verifySessionToken(createSessionToken(SECRET), SECRET)).toBe(true);
  });

  it("expires after the TTL", () => {
    const now = Date.now();
    const token = createSessionToken(SECRET, now);
    expect(verifySessionToken(token, SECRET, now + (SESSION_TTL_SECONDS - 1) * 1000)).toBe(true);
    expect(verifySessionToken(token, SECRET, now + (SESSION_TTL_SECONDS + 1) * 1000)).toBe(false);
  });

  it("rejects tokens signed with another secret (rotation logs everyone out)", () => {
    expect(verifySessionToken(createSessionToken("b".repeat(48)), SECRET)).toBe(false);
  });

  it("rejects an extended expiry with the old signature", () => {
    const [exp, mac] = createSessionToken(SECRET).split(".");
    expect(verifySessionToken(`${Number(exp) + 86_400}.${mac}`, SECRET)).toBe(false);
  });

  it.each([undefined, "", "abc", "123.", ".abc", "123.abc.def"])("rejects malformed token %s", (token) => {
    expect(verifySessionToken(token, SECRET)).toBe(false);
  });

  it("rejects everything when no secret is configured", () => {
    expect(verifySessionToken(createSessionToken(SECRET), undefined)).toBe(false);
  });

  it("requires a strong session secret", () => {
    expect(sessionSecretProblem(undefined)).toMatch(/not set/);
    expect(sessionSecretProblem("short")).toMatch(/32/);
    expect(sessionSecretProblem(SECRET)).toBeNull();
  });
});

describe("checkAdminPassword", () => {
  it("matches exactly and fails closed", () => {
    expect(checkAdminPassword("hunter2!", "hunter2!")).toBe(true);
    expect(checkAdminPassword("hunter2", "hunter2!")).toBe(false);
    expect(checkAdminPassword("", "")).toBe(false);
    expect(checkAdminPassword("anything", undefined)).toBe(false);
  });
});

function form(values: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

const valid = {
  luma_event_id: "evt-abc123",
  name: "Visible Builders Medellín #4",
  active: "on",
  auto_approve_threshold: "85",
  auto_waitlist_threshold: "40",
  budget_cap: "1500.50",
  cost_per_head: "12.5",
  venue_capacity: "80",
  local_host_name: "Host",
  local_host_telegram_id: "111",
  local_host_chat_id: "",
  founder_telegram_id: "222",
  founder_chat_id: "-1001234567890",
};

describe("parseEventConfigForm", () => {
  it("converts money to cents and defaults DM chat ids to user ids", () => {
    const result = parseEventConfigForm(form(valid));
    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        active: true,
        budget_cap_cents: 150050,
        cost_per_head_cents: 1250,
        venue_capacity: 80,
        local_host_chat_id: 111,
        founder_chat_id: -1001234567890,
      }),
    });
  });

  it("treats blank caps as 'no cap' and unchecked box as inactive", () => {
    const result = parseEventConfigForm(form({ ...valid, active: "", budget_cap: "", cost_per_head: "", venue_capacity: "" }));
    expect(result).toMatchObject({ ok: true, data: { active: false, budget_cap_cents: 0, cost_per_head_cents: 0, venue_capacity: null } });
  });

  it("requires the waitlist threshold to be below the approve threshold", () => {
    const result = parseEventConfigForm(form({ ...valid, auto_waitlist_threshold: "85" }));
    expect(result).toMatchObject({ ok: false, errors: { auto_waitlist_threshold: expect.stringContaining("lower") } });
  });

  it.each([
    ["luma_event_id", "abc123"],
    ["auto_approve_threshold", "101"],
    ["auto_waitlist_threshold", "-1"],
    ["budget_cap", "-5"],
    ["venue_capacity", "0"],
    ["local_host_telegram_id", "not-a-number"],
    ["local_host_telegram_id", "0"],
    ["founder_telegram_id", ""],
    ["name", "   "],
  ])("rejects %s = %j", (key, value) => {
    const result = parseEventConfigForm(form({ ...valid, [key]: value }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[key]).toBeTruthy();
  });

  it("ignores unknown fields such as a smuggled id", () => {
    const result = parseEventConfigForm(form({ ...valid, id: "x", created_at: "1999" }));
    expect(result.ok && Object.keys(result.data)).not.toContain("created_at");
  });
});
