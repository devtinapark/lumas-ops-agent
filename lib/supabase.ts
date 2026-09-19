import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | undefined;

/** Service-role client. Server-only: never import this from a Client Component. */
export function supabaseAdmin(): SupabaseClient {
  client ??= createClient(
    requireUrlEnv("SUPABASE_URL"),
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

/** Like requireEnv, but rejects a value that is not a usable http(s) URL — an API
 *  key, or an unfilled `https://<project-ref>...` placeholder copied from
 *  .env.example, otherwise fails deep inside the Supabase client. */
export function requireUrlEnv(name: string): string {
  const value = requireEnv(name);
  const hint = `${name} must be an http(s) URL, e.g. https://abcdefghijkl.supabase.co`;
  if (/[<>]/.test(value)) {
    throw new Error(`${hint} — got the unfilled placeholder ${value}`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${hint} — got ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(hint);
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
