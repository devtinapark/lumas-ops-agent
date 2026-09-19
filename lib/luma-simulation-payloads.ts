import { randomUUID } from "node:crypto";
import { SIMULATED_GUEST_PREFIX } from "@/lib/luma-client";
import type { Route } from "@/lib/routing";

/**
 * Mock `guest.registered` deliveries. The shape follows Luma's documented envelope
 * ({ type, data }) and guest fields as far as the public docs describe them; our parser
 * also accepts the known variants, so a real payload that differs slightly still parses.
 */

export const SIMULATION_TYPES = ["rockstar", "borderline", "unaligned"] as const;
export type SimulationType = (typeof SIMULATION_TYPES)[number];

interface Profile {
  name: string;
  emailLocal: string;
  expectedRoute: Route;
  answers: { question_id: string; label: string; answer: string }[];
}

const PROFILES: Record<SimulationType, Profile> = {
  rockstar: {
    name: "Valentina Ospina",
    emailLocal: "valentina",
    expectedRoute: "auto_approve",
    answers: [
      {
        question_id: "q_building",
        label: "What are you building right now?",
        answer:
          "Maintainer of 'paisa-pay', an open-source Colombian payments SDK (1.8k GitHub stars, used by 40+ startups). " +
          "Shipped v2 last month with PSE and Nequi support; I post weekly build logs on X.",
      },
      { question_id: "q_github", label: "GitHub", answer: "https://github.com/valentina-ospina" },
      { question_id: "q_linkedin", label: "LinkedIn", answer: "https://www.linkedin.com/in/valentina-ospina" },
      {
        question_id: "q_shipped",
        label: "Link to something you've shipped",
        answer: "https://github.com/valentina-ospina/paisa-pay — 312 releases, CI, docs site, 60 contributors.",
      },
      { question_id: "q_stack", label: "Main stack", answer: "TypeScript, Go, Postgres, Next.js" },
    ],
  },
  borderline: {
    name: "Mateo Ruiz",
    emailLocal: "mateo",
    expectedRoute: "host_review",
    answers: [
      {
        question_id: "q_building",
        label: "What are you building right now?",
        answer:
          "Exploring an AI tool that helps small restaurants in Laureles manage orders. " +
          "I have a prototype on my laptop but haven't launched yet.",
      },
      { question_id: "q_github", label: "GitHub", answer: "https://github.com/mateo-ruiz" },
      { question_id: "q_linkedin", label: "LinkedIn", answer: "" },
      { question_id: "q_shipped", label: "Link to something you've shipped", answer: "Nothing public yet." },
      { question_id: "q_stack", label: "Main stack", answer: "Python, learning React" },
    ],
  },
  unaligned: {
    name: "Carlos Gómez",
    emailLocal: "carlos",
    expectedRoute: "auto_waitlist",
    answers: [
      {
        question_id: "q_building",
        label: "What are you building right now?",
        answer: "Not building anything. Looking to meet investors and get leads for my real estate agency.",
      },
      { question_id: "q_github", label: "GitHub", answer: "" },
      { question_id: "q_linkedin", label: "LinkedIn", answer: "" },
      { question_id: "q_shipped", label: "Link to something you've shipped", answer: "n/a" },
      { question_id: "q_stack", label: "Main stack", answer: "none" },
    ],
  },
};

export interface SimulatedDelivery {
  type: SimulationType;
  expectedRoute: Route;
  webhookId: string;
  guestId: string;
  payload: {
    type: "guest.registered";
    data: { guest: Record<string, unknown> };
  };
}

/**
 * Every call mints fresh guest and webhook ids, so the same profile can be replayed
 * without hitting the webhook's duplicate-delivery and already-decided guards.
 */
export function buildSimulatedRegistration(type: SimulationType, lumaEventId: string): SimulatedDelivery {
  const profile = PROFILES[type];
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const guestId = `${SIMULATED_GUEST_PREFIX}${type}-${suffix}`;
  const now = new Date().toISOString();
  return {
    type,
    expectedRoute: profile.expectedRoute,
    webhookId: `sim_${suffix}`,
    guestId,
    payload: {
      type: "guest.registered",
      data: {
        guest: {
          api_id: guestId,
          event_api_id: lumaEventId,
          name: profile.name,
          email: `${profile.emailLocal}+${suffix}@example.com`, // reserved domain: never a real inbox
          approval_status: "pending_approval",
          registered_at: now,
          created_at: now,
          registration_answers: profile.answers.map((a) => ({ ...a, value: a.answer, value_text: a.answer })),
        },
      },
    },
  };
}
