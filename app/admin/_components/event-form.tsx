"use client";

import { useActionState } from "react";
import type { EventConfig } from "@/lib/supabase";
import { saveEventAction, type EventFormState } from "../actions";
import { buttonClass, cardClass, inputClass } from "./styles";

const fromCents = (c: number) => (c ? String(c / 100) : "");

function initialValues(event?: EventConfig): Record<string, string> {
  if (!event) return { active: "on", auto_approve_threshold: "85", auto_waitlist_threshold: "40" };
  return {
    luma_event_id: event.luma_event_id,
    name: event.name,
    active: event.active ? "on" : "",
    auto_approve_threshold: String(event.auto_approve_threshold),
    auto_waitlist_threshold: String(event.auto_waitlist_threshold),
    budget_cap: fromCents(event.budget_cap_cents),
    cost_per_head: fromCents(event.cost_per_head_cents),
    venue_capacity: event.venue_capacity ? String(event.venue_capacity) : "",
    local_host_name: event.local_host_name,
    local_host_telegram_id: String(event.local_host_telegram_id),
    local_host_chat_id: event.local_host_chat_id === event.local_host_telegram_id ? "" : String(event.local_host_chat_id),
    founder_telegram_id: String(event.founder_telegram_id),
    founder_chat_id: event.founder_chat_id === event.founder_telegram_id ? "" : String(event.founder_chat_id),
  };
}

export function EventForm({ event }: { event?: EventConfig }) {
  const [state, formAction, pending] = useActionState<EventFormState, FormData>(saveEventAction, {});
  const values = state.values ?? initialValues(event);
  const errors = state.errors ?? {};

  const field = (name: string, label: string, opts: { type?: string; hint?: string; placeholder?: string; required?: boolean; min?: number; max?: number; step?: string } = {}) => (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={opts.type ?? "text"}
        defaultValue={values[name] ?? ""}
        placeholder={opts.placeholder}
        required={opts.required}
        min={opts.min}
        max={opts.max}
        step={opts.step}
        aria-invalid={errors[name] ? true : undefined}
        aria-describedby={`${name}-hint`}
        className={inputClass}
      />
      <p id={`${name}-hint`} className={`text-xs ${errors[name] ? "text-red-600 dark:text-red-400" : "text-zinc-500"}`}>
        {errors[name] ?? opts.hint ?? " "}
      </p>
    </div>
  );

  return (
    // key forces the uncontrolled inputs to re-read defaults after a failed submit
    <form key={JSON.stringify(values)} action={formAction} className="flex flex-col gap-6">
      {event && <input type="hidden" name="id" value={event.id} />}

      {errors._form && (
        <p role="alert" className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">
          {errors._form}
        </p>
      )}

      <fieldset className={`${cardClass} grid gap-4 p-5 sm:grid-cols-2`}>
        <legend className="px-1 text-sm font-semibold">Event</legend>
        {field("name", "Display name", { required: true, placeholder: "Visible Builders Medellín #4" })}
        {field("luma_event_id", "Luma event id", { required: true, placeholder: "evt-abc123", hint: "From the event's Luma API/manage page." })}
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="active" defaultChecked={values.active === "on"} className="size-4" />
          Active: process new registrations for this event
        </label>
      </fieldset>

      <fieldset className={`${cardClass} grid gap-4 p-5 sm:grid-cols-2`}>
        <legend className="px-1 text-sm font-semibold">AI routing thresholds</legend>
        {field("auto_approve_threshold", "Auto-approve at score ≥", { type: "number", min: 1, max: 100, required: true, hint: "At or above this, Luma approves without a human." })}
        {field("auto_waitlist_threshold", "Auto-waitlist below score", { type: "number", min: 0, max: 99, required: true, hint: "Everything in between goes to the host." })}
      </fieldset>

      <fieldset className={`${cardClass} grid gap-4 p-5 sm:grid-cols-3`}>
        <legend className="px-1 text-sm font-semibold">Venue guardrails</legend>
        {field("venue_capacity", "Venue capacity", { type: "number", min: 1, hint: "Blank = no cap." })}
        {field("budget_cap", "Budget cap", { type: "number", min: 0, step: "0.01", hint: "Blank = no cap." })}
        {field("cost_per_head", "Cost per head", { type: "number", min: 0, step: "0.01", hint: "Same currency as the cap." })}
        <p className="text-xs text-zinc-500 sm:col-span-3">
          When capacity or budget would be exceeded, high scorers go to the host instead of being auto-approved.
        </p>
      </fieldset>

      <fieldset className={`${cardClass} grid gap-4 p-5 sm:grid-cols-2`}>
        <legend className="px-1 text-sm font-semibold">People (Telegram)</legend>
        {field("local_host_name", "Local host name", { required: true })}
        <div className="hidden sm:block" />
        {field("local_host_telegram_id", "Host Telegram user id", { type: "number", required: true, hint: "Only this user can press Approve/Waitlist/Escalate." })}
        {field("local_host_chat_id", "Host chat id (optional)", { type: "number", hint: "Blank = DM the host. Use a group id (negative) for a group." })}
        {field("founder_telegram_id", "Founder Telegram user id", { type: "number", required: true, hint: "Receives escalations; can always decide." })}
        {field("founder_chat_id", "Founder chat id (optional)", { type: "number", hint: "Blank = DM the founder." })}
      </fieldset>

      <div className="flex justify-end">
        <button type="submit" disabled={pending} className={buttonClass}>
          {pending ? "Saving…" : event ? "Save changes" : "Create event"}
        </button>
      </div>
    </form>
  );
}
