import { createHmac } from "node:crypto";

export const TEST_SECRET = "whsec_test_secret";

export function signedHeaders(body: string, opts: { secret?: string; ts?: number; webhookId?: string } = {}) {
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", opts.secret ?? TEST_SECRET).update(`${ts}.${body}`).digest("hex");
  return new Headers({
    "content-type": "application/json",
    "webhook-id": opts.webhookId ?? "wh_1",
    "webhook-timestamp": ts,
    "webhook-signature": `t=${ts},v1=${sig}`,
  });
}

export function registration(overrides: Record<string, unknown> = {}) {
  return {
    type: "guest.registered",
    data: {
      guest: {
        api_id: "gst-abc",
        event_api_id: "evt-test",
        email: "ana@example.com",
        name: "Ana",
        approval_status: "pending_approval",
        registration_answers: [
          { label: "What are you building?", answer: "An open-source agent https://github.com/ana/agent" },
          { label: "LinkedIn", value_text: "https://www.linkedin.com/in/ana-dev" },
        ],
        ...overrides,
      },
    },
  };
}
