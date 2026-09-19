import "server-only";
import { requireAdmin } from "@/lib/admin-auth";
import { supabaseAdmin, type EvaluationStatus, type EventConfig } from "@/lib/supabase";
import type { EventConfigInput } from "@/lib/admin-schema";

export type StatusCounts = Record<EvaluationStatus, number>;

export const EMPTY_COUNTS: StatusCounts = {
  auto_approved: 0,
  host_approved: 0,
  flagged_for_host: 0,
  escalated: 0,
  waitlisted: 0,
  host_waitlisted: 0,
};

export interface EvaluationRow {
  id: string;
  full_name: string | null;
  email: string | null;
  score: number | null;
  status: EvaluationStatus;
  reasoning: string | null;
  role: string | null;
  github_url: string | null;
  linkedin_url: string | null;
  injection_suspected: boolean;
  luma_sync_error: string | null;
  luma_sync_mode: "live" | "simulated" | null;
  decided_by: string | null;
  created_at: string;
}

export interface AuditRow {
  id: number;
  evaluation_id: string;
  actor_telegram_id: number;
  actor_role: "host" | "founder";
  action: "approve" | "waitlist" | "escalate";
  previous_status: string;
  new_status: string;
  luma_result: "ok" | "error" | "not_applicable";
  luma_error: string | null;
  created_at: string;
}

function countStatuses(rows: { status: EvaluationStatus }[]): StatusCounts {
  const counts = { ...EMPTY_COUNTS };
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return counts;
}

export async function listEvents(): Promise<(EventConfig & { counts: StatusCounts })[]> {
  await requireAdmin();
  const db = supabaseAdmin();
  const [events, evals] = await Promise.all([
    db.from("event_configs").select("*").order("created_at", { ascending: false }),
    db.from("attendee_evaluations").select("event_config_id, status"),
  ]);
  if (events.error) throw new Error(events.error.message);
  if (evals.error) throw new Error(evals.error.message);
  const byEvent = new Map<string, { status: EvaluationStatus }[]>();
  for (const row of evals.data as { event_config_id: string; status: EvaluationStatus }[]) {
    byEvent.set(row.event_config_id, [...(byEvent.get(row.event_config_id) ?? []), row]);
  }
  return (events.data as EventConfig[]).map((e) => ({ ...e, counts: countStatuses(byEvent.get(e.id) ?? []) }));
}

export async function getEvent(id: string): Promise<EventConfig | null> {
  await requireAdmin();
  const { data, error } = await supabaseAdmin().from("event_configs").select("*").eq("id", id).maybeSingle<EventConfig>();
  if (error) throw new Error(error.message);
  return data;
}

export async function getEventDetail(id: string) {
  await requireAdmin();
  const db = supabaseAdmin();
  const [evaluations, audit] = await Promise.all([
    db
      .from("attendee_evaluations")
      .select(
        "id, full_name, email, score, status, reasoning, role, github_url, linkedin_url, injection_suspected, luma_sync_error, luma_sync_mode, decided_by, created_at",
      )
      .eq("event_config_id", id)
      .order("created_at", { ascending: false })
      .limit(500),
    db
      .from("host_audit_logs")
      .select("id, evaluation_id, actor_telegram_id, actor_role, action, previous_status, new_status, luma_result, luma_error, created_at")
      .eq("event_config_id", id)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);
  if (evaluations.error) throw new Error(evaluations.error.message);
  if (audit.error) throw new Error(audit.error.message);
  const rows = evaluations.data as EvaluationRow[];
  return { evaluations: rows, audit: audit.data as AuditRow[], counts: countStatuses(rows) };
}

export async function saveEvent(id: string | null, input: EventConfigInput): Promise<{ id: string } | { error: string }> {
  await requireAdmin();
  const db = supabaseAdmin();
  const query = id
    ? db.from("event_configs").update(input).eq("id", id).select("id").single<{ id: string }>()
    : db.from("event_configs").insert(input).select("id").single<{ id: string }>();
  const { data, error } = await query;
  if (error) {
    if (error.code === "23505") return { error: "Another event already uses that Luma event id." };
    return { error: error.message };
  }
  return { id: data.id };
}

export async function setEventActive(id: string, active: boolean): Promise<void> {
  await requireAdmin();
  const { error } = await supabaseAdmin().from("event_configs").update({ active }).eq("id", id);
  if (error) throw new Error(error.message);
}
