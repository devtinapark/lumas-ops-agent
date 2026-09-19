import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | undefined;

/** Service-role client. Server-only: never import this from a Client Component. */
export function supabaseAdmin(): SupabaseClient {
  client ??= createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  return client;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

export type EvaluationStatus =
  | "auto_approved"
  | "flagged_for_host"
  | "waitlisted"
  | "host_approved"
  | "host_waitlisted"
  | "escalated";

export interface EventConfig {
  id: string;
  luma_event_id: string;
  name: string;
  active: boolean;
  auto_approve_threshold: number;
  auto_waitlist_threshold: number;
  budget_cap_cents: number;
  cost_per_head_cents: number;
  venue_capacity: number | null;
  local_host_name: string;
  local_host_telegram_id: number;
  local_host_chat_id: number;
  founder_telegram_id: number;
  founder_chat_id: number;
}

export interface AttendeeEvaluation {
  id: string;
  event_config_id: string;
  luma_guest_id: string;
  luma_event_id: string;
  email: string | null;
  full_name: string | null;
  score: number | null;
  reasoning: string | null;
  status: EvaluationStatus;
}
