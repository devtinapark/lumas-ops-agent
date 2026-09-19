import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isAdmin } from "@/lib/admin-auth";
import { signLumaPayload } from "@/lib/luma";
import { lumaMode } from "@/lib/luma-client";
import { buildSimulatedRegistration, SIMULATION_TYPES } from "@/lib/luma-simulation-payloads";
import { supabaseAdmin } from "@/lib/supabase";
import { POST as lumaWebhook } from "@/app/api/webhooks/luma/route";

export const runtime = "nodejs";
// Runs the full webhook pipeline (AI scoring, Supabase, Telegram) inline.
export const maxDuration = 60;

const querySchema = z.object({
  type: z.enum(SIMULATION_TYPES),
  event: z
    .string()
    .regex(/^evt-[A-Za-z0-9]+$/)
    .optional(),
});

/**
 * GET /api/simulations/luma?type=rockstar|borderline|unaligned[&event=evt-...]
 *
 * Builds a mock guest.registered delivery, signs it exactly as Luma would, and hands it to
 * the real webhook handler in-process. The webhook's signature check is never relaxed.
 * Open in development; in production only a signed-in founder can run it.
 */
export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV === "production" && !(await isAdmin())) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const query = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) {
    return NextResponse.json(
      { error: `Use ?type=${SIMULATION_TYPES.join("|")} and optionally &event=evt-...` },
      { status: 400 },
    );
  }

  const secret = process.env.LUMA_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "Set LUMA_WEBHOOK_SECRET (any random 32+ char string works while simulating)." },
      { status: 500 },
    );
  }

  const eventId = query.data.event ?? (await latestActiveEventId());
  if (!eventId) {
    return NextResponse.json({ error: "No active event in event_configs. Create one in /admin first." }, { status: 404 });
  }

  const sim = buildSimulatedRegistration(query.data.type, eventId);
  const rawBody = JSON.stringify(sim.payload);
  const webhookResponse = await lumaWebhook(
    new Request(new URL("/api/webhooks/luma", request.url), {
      method: "POST",
      body: rawBody,
      headers: signLumaPayload(rawBody, secret, sim.webhookId),
    }),
  );
  const webhook = (await webhookResponse.json().catch(() => ({}))) as { route?: string; score?: number };

  return NextResponse.json(
    {
      simulation: {
        type: sim.type,
        lumaEventId: eventId,
        guestId: sim.guestId,
        webhookId: sim.webhookId,
        expectedRoute: sim.expectedRoute,
        // Scores come from the live model, so the outcome can differ from the profile's intent.
        matchedExpectation: webhook.route === sim.expectedRoute,
        lumaMode: lumaMode(sim.guestId),
      },
      webhook: { status: webhookResponse.status, ...webhook },
    },
    { status: webhookResponse.ok ? 200 : 502 },
  );
}

async function latestActiveEventId(): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from("event_configs")
    .select("luma_event_id")
    .eq("active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ luma_event_id: string }>();
  if (error) throw new Error(`event lookup failed: ${error.message}`);
  return data?.luma_event_id ?? null;
}
