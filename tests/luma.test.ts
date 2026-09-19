import { describe, expect, it } from "vitest";
import { parseGuestRegistered, verifyLumaSignature } from "@/lib/luma";
import { TEST_SECRET, registration, signedHeaders } from "./helpers/luma";

describe("verifyLumaSignature", () => {
  const body = JSON.stringify(registration());

  it("accepts a correctly signed, fresh payload", () => {
    expect(verifyLumaSignature(body, signedHeaders(body), TEST_SECRET)).toEqual({ ok: true });
  });

  it("rejects a tampered body", () => {
    expect(verifyLumaSignature(body.replace("Ana", "Eve"), signedHeaders(body), TEST_SECRET)).toMatchObject({
      ok: false,
      reason: "signature mismatch",
    });
  });

  it("rejects the wrong secret", () => {
    expect(verifyLumaSignature(body, signedHeaders(body, { secret: "whsec_other" }), TEST_SECRET).ok).toBe(false);
  });

  it("rejects stale timestamps (replay protection)", () => {
    const old = Math.floor(Date.now() / 1000) - 10 * 60;
    expect(verifyLumaSignature(body, signedHeaders(body, { ts: old }), TEST_SECRET)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("tolerance"),
    });
  });

  it("rejects timestamps too far in the future", () => {
    const future = Math.floor(Date.now() / 1000) + 10 * 60;
    expect(verifyLumaSignature(body, signedHeaders(body, { ts: future }), TEST_SECRET).ok).toBe(false);
  });

  it("rejects missing and malformed headers", () => {
    expect(verifyLumaSignature(body, new Headers(), TEST_SECRET).ok).toBe(false);
    expect(verifyLumaSignature(body, new Headers({ "webhook-signature": "garbage" }), TEST_SECRET).ok).toBe(false);
    expect(verifyLumaSignature(body, new Headers({ "webhook-signature": "t=1,v1=zz" }), TEST_SECRET).ok).toBe(false);
  });

  it("accepts when any of several v1 signatures matches (secret rotation)", () => {
    const h = signedHeaders(body);
    const [t, v1] = h.get("webhook-signature")!.split(",");
    h.set("webhook-signature", `${t},v1=${"0".repeat(64)},${v1}`);
    expect(verifyLumaSignature(body, h, TEST_SECRET).ok).toBe(true);
  });

  it("falls back to the webhook-timestamp header when t= is absent", () => {
    const h = signedHeaders(body);
    h.set("webhook-signature", h.get("webhook-signature")!.split(",")[1]);
    expect(verifyLumaSignature(body, h, TEST_SECRET).ok).toBe(true);
  });
});

describe("parseGuestRegistered", () => {
  it("extracts ids, contact, answers, links and bio from a nested guest", () => {
    const result = parseGuestRegistered(JSON.stringify(registration()));
    expect(result.kind).toBe("registration");
    if (result.kind !== "registration") return;
    expect(result.registration).toMatchObject({
      lumaGuestId: "gst-abc",
      lumaEventId: "evt-test",
      email: "ana@example.com",
      name: "Ana",
      githubUrl: "https://github.com/ana/agent",
      linkedinUrl: "https://www.linkedin.com/in/ana-dev",
      projectBio: "An open-source agent https://github.com/ana/agent",
    });
    expect(result.registration.answers).toHaveLength(2);
  });

  it("accepts the guest inlined in data with alternate id fields", () => {
    const body = JSON.stringify({
      type: "guest.registered",
      data: { id: "gst-2", event: { api_id: "evt-2" }, user_email: "x@y.co", user_name: "X" },
    });
    const result = parseGuestRegistered(body);
    expect(result).toMatchObject({ kind: "registration", registration: { lumaGuestId: "gst-2", lumaEventId: "evt-2", email: "x@y.co" } });
  });

  it("ignores other event types", () => {
    expect(parseGuestRegistered(JSON.stringify({ type: "guest.updated", data: {} }))).toEqual({ kind: "ignored", type: "guest.updated" });
  });

  it("flags invalid JSON, envelopes and missing ids", () => {
    expect(parseGuestRegistered("not json").kind).toBe("invalid");
    expect(parseGuestRegistered(JSON.stringify({ hello: 1 })).kind).toBe("invalid");
    expect(parseGuestRegistered(JSON.stringify(registration({ api_id: undefined }))).kind).toBe("invalid");
  });

  it("strips control characters, caps length and joins multi-select answers", () => {
    const result = parseGuestRegistered(
      JSON.stringify(
        registration({
          registration_answers: [
            { label: "Bio", answer: "hi\u0000\u0007there" + "x".repeat(5000) },
            { label: "Stack", answer: ["TypeScript", "Go"] },
            { label: "Empty", answer: "" },
          ],
        }),
      ),
    );
    if (result.kind !== "registration") throw new Error("expected registration");
    const [bio, stack] = result.registration.answers;
    expect(bio.answer.startsWith("hithere")).toBe(true);
    expect(bio.answer.length).toBeLessThanOrEqual(1500);
    expect(stack.answer).toBe("TypeScript, Go");
    expect(result.registration.answers).toHaveLength(2);
  });

  it("does not treat look-alike domains as GitHub links", () => {
    const result = parseGuestRegistered(
      JSON.stringify(registration({ registration_answers: [{ label: "Links", answer: "https://github.com.evil.io/x" }] })),
    );
    if (result.kind !== "registration") throw new Error("expected registration");
    expect(result.registration.githubUrl).toBeNull();
  });
});
