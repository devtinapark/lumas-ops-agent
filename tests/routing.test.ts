import { describe, expect, it } from "vitest";
import { routeApplicant, type RoutingConfig } from "@/lib/routing";

const config: RoutingConfig = {
  auto_approve_threshold: 85,
  auto_waitlist_threshold: 40,
  budget_cap_cents: 0,
  cost_per_head_cents: 0,
  venue_capacity: null,
};
const ai = (score: number, injection_suspected = false) => ({ score, injection_suspected });

describe("routeApplicant", () => {
  it.each([
    [0, "auto_waitlist"],
    [39, "auto_waitlist"],
    [40, "host_review"],
    [84, "host_review"],
    [85, "auto_approve"],
    [100, "auto_approve"],
  ])("score %i → %s", (score, route) => {
    expect(routeApplicant(config, ai(score), 0).route).toBe(route);
  });

  it("sends to a human when the AI is unavailable", () => {
    expect(routeApplicant(config, null, 0).route).toBe("host_review");
  });

  it("blocks auto-approval when injection is suspected", () => {
    expect(routeApplicant(config, ai(99, true), 0)).toMatchObject({ route: "host_review", note: expect.stringContaining("injection") });
  });

  it("still auto-waitlists low scorers that tried injection", () => {
    expect(routeApplicant(config, ai(10, true), 0).route).toBe("auto_waitlist");
  });

  it("pauses auto-approval at venue capacity", () => {
    const capped = { ...config, venue_capacity: 50 };
    expect(routeApplicant(capped, ai(95), 49).route).toBe("auto_approve");
    expect(routeApplicant(capped, ai(95), 50).route).toBe("host_review");
  });

  it("pauses auto-approval when the next seat would exceed the budget", () => {
    const budget = { ...config, budget_cap_cents: 100_000, cost_per_head_cents: 2_500 }; // 40 seats
    expect(routeApplicant(budget, ai(95), 39).route).toBe("auto_approve");
    expect(routeApplicant(budget, ai(95), 40).route).toBe("host_review");
  });

  it("ignores a budget cap with no cost per head", () => {
    expect(routeApplicant({ ...config, budget_cap_cents: 100 }, ai(95), 1000).route).toBe("auto_approve");
  });

  it("respects custom thresholds", () => {
    const strict = { ...config, auto_approve_threshold: 95, auto_waitlist_threshold: 60 };
    expect(routeApplicant(strict, ai(90), 0).route).toBe("host_review");
    expect(routeApplicant(strict, ai(59), 0).route).toBe("auto_waitlist");
  });
});
