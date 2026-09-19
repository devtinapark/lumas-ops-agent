-- LumaOps Agent: initial schema.
-- All tables are service-role only (RLS on, no policies). The Medellín host never touches
-- Supabase directly; every host action flows through the Telegram route, which is audited.

create extension if not exists pgcrypto;

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- event_configs: founder-owned guardrails, one row per Luma event
-- ---------------------------------------------------------------------------
create table event_configs (
  id                      uuid primary key default gen_random_uuid(),
  luma_event_id           text not null unique,               -- "evt-..."
  name                    text not null,
  active                  boolean not null default true,

  auto_approve_threshold  smallint not null default 85 check (auto_approve_threshold between 1 and 100),
  auto_waitlist_threshold smallint not null default 40 check (auto_waitlist_threshold between 0 and 99),

  -- Venue budget guardrail: auto-approval stops (falls back to host review) once
  -- approved_count * cost_per_head_cents would exceed budget_cap_cents or capacity.
  budget_cap_cents        integer  not null default 0 check (budget_cap_cents >= 0),
  cost_per_head_cents     integer  not null default 0 check (cost_per_head_cents >= 0),
  venue_capacity          integer  check (venue_capacity is null or venue_capacity > 0),

  local_host_name         text     not null,
  local_host_telegram_id  bigint   not null,                  -- Telegram user id allowed to press buttons
  local_host_chat_id      bigint   not null,                  -- chat the cards are delivered to
  founder_telegram_id     bigint   not null,                  -- escalation target; also authorised to act
  founder_chat_id         bigint   not null,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint thresholds_ordered check (auto_waitlist_threshold < auto_approve_threshold)
);

create trigger event_configs_updated_at before update on event_configs
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- attendee_evaluations
-- ---------------------------------------------------------------------------
create table attendee_evaluations (
  id                  uuid primary key default gen_random_uuid(),
  event_config_id     uuid not null references event_configs(id) on delete restrict,
  luma_guest_id       text not null,                          -- "gst-..." (from webhook)
  luma_event_id       text not null,
  luma_webhook_id     text,                                   -- Webhook-Id header, for tracing

  email               text,
  full_name           text,
  answers             jsonb not null default '[]'::jsonb,     -- raw questionnaire [{label, answer}]
  github_url          text,
  linkedin_url        text,
  project_bio         text,
  role                text,                                   -- AI-extracted, used by badge/chart tooling
  skills              text[] not null default '{}',           -- AI-extracted, used by chart tooling

  score               smallint check (score between 0 and 100), -- null = AI unavailable -> human review
  reasoning           text,
  injection_suspected boolean not null default false,

  status              text not null check (status in (
                        'auto_approved',      -- AI score >= approve threshold, Luma approved
                        'flagged_for_host',   -- waiting on a human decision
                        'waitlisted',         -- AI score < waitlist threshold
                        'host_approved',
                        'host_waitlisted',
                        'escalated'           -- passed to founder
                      )),
  luma_sync_error     text,                                   -- last Luma API failure, if any

  decided_by          text,                                   -- 'ai' | 'host' | 'founder'
  decided_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (event_config_id, luma_guest_id)
);

create index attendee_evaluations_event_status_idx on attendee_evaluations (event_config_id, status);

create trigger attendee_evaluations_updated_at before update on attendee_evaluations
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- host_audit_logs: append-only record of every human decision
-- ---------------------------------------------------------------------------
create table host_audit_logs (
  id                 bigint generated always as identity primary key,
  evaluation_id      uuid not null references attendee_evaluations(id) on delete restrict,
  event_config_id    uuid not null references event_configs(id) on delete restrict,
  actor_telegram_id  bigint not null,
  actor_role         text not null check (actor_role in ('host', 'founder')),
  action             text not null check (action in ('approve', 'waitlist', 'escalate')),
  previous_status    text not null,
  new_status         text not null,
  luma_result        text not null check (luma_result in ('ok', 'error', 'not_applicable')),
  luma_error         text,
  telegram_message_id bigint,
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

create index host_audit_logs_eval_idx on host_audit_logs (evaluation_id);

create or replace function forbid_audit_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'host_audit_logs is append-only';
end $$;

create trigger host_audit_logs_immutable before update or delete on host_audit_logs
  for each row execute function forbid_audit_mutation();

-- ---------------------------------------------------------------------------
-- Lock everything down: only the service role (server-side) can read/write.
-- ---------------------------------------------------------------------------
alter table event_configs        enable row level security;
alter table attendee_evaluations enable row level security;
alter table host_audit_logs      enable row level security;

revoke all on event_configs, attendee_evaluations, host_audit_logs from anon, authenticated;
