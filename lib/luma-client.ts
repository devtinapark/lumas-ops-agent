import { updateGuestStatus, type LumaGuestStatus } from "@/lib/luma";

export type LumaMode = "live" | "simulated";
export type LumaActionResult = { success: true; mode: LumaMode };

/** Guest ids minted by the simulation suite; these never reach the real Luma API. */
export const SIMULATED_GUEST_PREFIX = "gst-sim-";

/**
 * Live when LUMA_API_KEY is set, simulated otherwise. Read per call, so adding the key
 * in Vercel takes effect on the next request with no code change.
 */
export function lumaMode(guestId?: string): LumaMode {
  if (guestId?.startsWith(SIMULATED_GUEST_PREFIX)) return "simulated";
  return process.env.LUMA_API_KEY?.trim() ? "live" : "simulated";
}

interface GuestRef {
  eventId: string;
  guestId: string;
}

async function setStatus(guest: GuestRef, status: LumaGuestStatus): Promise<LumaActionResult> {
  const mode = lumaMode(guest.guestId);
  if (mode === "simulated") {
    console.info("[luma:simulated] POST /v1/events/guests/update-status", {
      event_id: guest.eventId,
      guest_id: guest.guestId,
      status,
    });
    return { success: true, mode };
  }
  // Throws LumaApiError on failure; callers keep the decision retryable.
  await updateGuestStatus({ ...guest, status });
  return { success: true, mode };
}

export const approveGuest = (guest: GuestRef) => setStatus(guest, "approved");
export const waitlistGuest = (guest: GuestRef) => setStatus(guest, "waitlist");
