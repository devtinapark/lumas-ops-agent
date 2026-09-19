import Link from "next/link";
import { requireAdmin } from "@/lib/admin-auth";
import { listEvents } from "@/lib/admin-data";
import { buttonClass, cardClass } from "../_components/styles";

export default async function AdminHome() {
  await requireAdmin();
  const events = await listEvents();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Events</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Each event has its own AI thresholds, budget cap and local host.
          </p>
        </div>
        <Link href="/admin/events/new" className={buttonClass}>
          New event
        </Link>
      </div>

      {events.length === 0 ? (
        <div className={`${cardClass} px-6 py-12 text-center text-sm text-zinc-600 dark:text-zinc-400`}>
          No events yet. Create one to start routing Luma registrations.
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {events.map((e) => {
            const approved = e.counts.auto_approved + e.counts.host_approved;
            const pending = e.counts.flagged_for_host + e.counts.escalated;
            const waitlisted = e.counts.waitlisted + e.counts.host_waitlisted;
            return (
              <li key={e.id}>
                <Link
                  href={`/admin/events/${e.id}`}
                  className={`${cardClass} block p-5 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="font-medium">{e.name}</h2>
                    <span className={`text-xs font-medium ${e.active ? "text-emerald-700 dark:text-emerald-400" : "text-zinc-500"}`}>
                      {e.active ? "● Active" : "○ Paused"}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-xs text-zinc-500">{e.luma_event_id}</p>
                  <dl className="mt-4 grid grid-cols-3 gap-2 text-sm">
                    <Stat label="Approved" value={approved} of={e.venue_capacity} />
                    <Stat label="Pending" value={pending} highlight={pending > 0} />
                    <Stat label="Waitlisted" value={waitlisted} />
                  </dl>
                  <p className="mt-4 text-xs text-zinc-500">
                    Auto-approve ≥ {e.auto_approve_threshold} · auto-waitlist &lt; {e.auto_waitlist_threshold} · host{" "}
                    {e.local_host_name}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value, of, highlight }: { label: string; value: number; of?: number | null; highlight?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className={`text-lg font-semibold tabular-nums ${highlight ? "text-amber-700 dark:text-amber-400" : ""}`}>
        {value}
        {of ? <span className="text-sm font-normal text-zinc-500"> / {of}</span> : null}
      </dd>
    </div>
  );
}
