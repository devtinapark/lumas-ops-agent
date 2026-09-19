import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeCallback, encodeCallback, escapeHtml, renderCardText, verifyTelegramSecret } from "@/lib/telegram";

const JOB = "0123456789abcdef0123456789abcdef";

describe("callback data", () => {
  it.each(["approve", "waitlist", "escalate"] as const)("round-trips %s within Telegram's 64-byte limit", (action) => {
    const data = encodeCallback(action, JOB);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(decodeCallback(data)).toEqual({ action, jobId: JOB });
  });

  it.each([undefined, "", "x:" + JOB, "a:" + JOB.slice(1), "a:" + JOB.toUpperCase(), `a:${JOB}:extra`, "a:../../etc"])(
    "rejects malformed data %s",
    (data) => {
      expect(decodeCallback(data)).toBeNull();
    },
  );
});

describe("verifyTelegramSecret", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts only the configured secret", () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "s3cret-token");
    expect(verifyTelegramSecret(new Headers({ "x-telegram-bot-api-secret-token": "s3cret-token" }))).toBe(true);
    expect(verifyTelegramSecret(new Headers({ "x-telegram-bot-api-secret-token": "wrong" }))).toBe(false);
    expect(verifyTelegramSecret(new Headers())).toBe(false);
  });

  it("fails closed when no secret is configured", () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "");
    expect(verifyTelegramSecret(new Headers({ "x-telegram-bot-api-secret-token": "" }))).toBe(false);
  });
});

describe("card rendering", () => {
  it("escapes applicant-controlled HTML", () => {
    expect(escapeHtml(`<b>&"x"</b>`)).toBe("&lt;b&gt;&amp;\"x\"&lt;/b&gt;");
    const text = renderCardText({
      jobId: JOB,
      eventName: "VB",
      guestName: "<a href='x'>click</a>",
      guestEmail: null,
      score: 60,
      reasoning: "<script>",
      githubUrl: null,
      linkedinUrl: null,
      injectionSuspected: true,
    });
    expect(text).not.toContain("<a href");
    expect(text).not.toContain("<script>");
    expect(text).toContain("manipulate");
  });

  it("says when the AI score is unavailable", () => {
    const text = renderCardText({
      jobId: JOB, eventName: "VB", guestName: null, guestEmail: null, score: null,
      reasoning: null, githubUrl: null, linkedinUrl: null, injectionSuspected: false,
    });
    expect(text).toContain("n/a");
  });
});
