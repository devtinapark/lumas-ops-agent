import type { EventConfig } from "@/lib/supabase";
import type { AttendeeScore } from "@/lib/scoring";

export type Route = "auto_approve" | "auto_waitlist" | "host_review";

export type RoutingConfig = Pick<
  EventConfig,
  "auto_approve_threshold" | "auto_waitlist_threshold" | "budget_cap_cents" | "cost_per_head_cents" | "venue_capacity"
>;

/**
 * Pure routing decision. Anything uncertain (no AI score, suspected injection, capacity or
 * budget reached) goes to a human rather than being auto-decided.
 */
export function routeApplicant(
  config: RoutingConfig,
  ai: Pick<AttendeeScore, "score" | "injection_suspected"> | null,
  approvedCount: number,
): { route: Route; note?: string } {
  if (!ai) return { route: "host_review" };
  if (ai.score < config.auto_waitlist_threshold) return { route: "auto_waitlist" };
  if (ai.score < config.auto_approve_threshold) return { route: "host_review" };

  if (ai.injection_suspected) {
    return { route: "host_review", note: "Auto-approval blocked: possible prompt injection." };
  }
  const overCapacity = config.venue_capacity != null && approvedCount >= config.venue_capacity;
  const overBudget =
    config.budget_cap_cents > 0 &&
    config.cost_per_head_cents > 0 &&
    (approvedCount + 1) * config.cost_per_head_cents > config.budget_cap_cents;
  if (overCapacity || overBudget) {
    return { route: "host_review", note: "Auto-approval paused: venue capacity/budget cap reached." };
  }
  return { route: "auto_approve" };
}
