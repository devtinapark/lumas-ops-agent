import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin-auth";
import { getEvent, getEventDetail, type AuditRow, type EvaluationRow } from "@/lib/admin-data";
import { toggleActiveAction } from "../../../actions";
import { EventForm } from "../../../_components/event-form";
import { StatusBadge } from "../../../_components/status-badge";
import { cardClass, secondaryButtonClass } from "../../../_components/styles";

const TABS = [
  { key: "applicants", label: "Applicants" },
  { key: "audit", label: "Host audit log" },
  { key: "settings", label: "Settings" },
] as const;
type Tab = (typeof TABS)[number]["key"];

const money = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Bogota" });

export default async function EventPage({ params, searchParams }: PageProps<"/admin/events/[id]">) {
  await requireAdmin();
  const { id } = await params;
  const sp = await searchParams;
  if (!z.uuid().safeParse(id).success) notFound();

  const event = await getEvent(id);
  if (!event) notFound();
  const { evaluations, audit, counts } = await getEventDetail(id);

  const tab: Tab = TABS.some((t) => t.key === sp.tab) ? (sp.tab as Tab) : "applicants";
  const approved = counts.auto_approved + counts.host_approved;
  const pending = counts.flagged_for_host + counts.escalated;
  const spent = approved * event.cost_per_head_cents;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/admin" className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
            ← Events
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">{event.name}</h1>
          <p className="mt-1 font-mono text-xs text-zinc-500">{event.luma_event_id}</p>
        </div>
        <form action={toggleActiveAction} className="flex items-center gap-3">
          <input type="hidden" name="id" value={event.id} />
          <input type="hidden" name="active" value={String(!event.active)} />
          <span className={`text-sm font-medium ${event.active ? "text-emerald-700 dark:text-emerald-400" : "text-zinc-500"}`}>
            {event.active ? "● Active" : "○ Paused"}
          </span>
          <button type="submit" className={secondaryButtonClass}>
            {event.active ? "Pause processing" : "Resume processing"}
          </button>
        </form>
      </div>

      {sp.saved === "1" && (
        <p role="status" className="rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          Settings saved. New registrations use them immediately.
        </p>
      )}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Approved" value={String(approved)} sub={event.venue_capacity ? `of ${event.venue_capacity} seats` : "no capacity cap"} />
        <Tile label="Needs a decision" value={String(pending)} sub={counts.escalated ? `${counts.escalated} escalated to you` : "with the host"} warn={pending > 0} />
        <Tile label="Waitlisted" value={String(counts.waitlisted + counts.host_waitlisted)} sub={`${counts.waitlisted} by AI`} />
        <Tile
          label="Budget used"
          value={event.budget_cap_cents ? money(spent) : "—"}
          sub={event.budget_cap_cents ? `of ${money(event.budget_cap_cents)}` : "no budget cap"}
          warn={event.budget_cap_cents > 0 && spent >= event.budget_cap_cents}
        />
      </dl>

      <nav className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800" aria-label="Event sections">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/admin/events/${event.id}?tab=${t.key}`}
            aria-current={tab === t.key ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              tab === t.key
                ? "border-zinc-900 text-zinc-900 dark:border-zinc-100 dark:text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "applicants" && <Applicants rows={evaluations} />}
      {tab === "audit" && <Audit rows={audit} names={new Map(evaluations.map((e) => [e.id, e.full_name ?? e.email ?? "—"]))} />}
      {tab === "settings" && <EventForm event={event} />}
    </div>
  );
}

function Tile({ label, value, sub, warn }: { label: string; value: string; sub: string; warn?: boolean }) {
  return (
    <div className={`${cardClass} p-4`}>
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className={`mt-1 text-2xl font-semibold tabular-nums ${warn ? "text-amber-700 dark:text-amber-400" : ""}`}>{value}</dd>
      <dd className="text-xs text-zinc-500">{sub}</dd>
    </div>
  );
}

function Applicants({ rows }: { rows: EvaluationRow[] }) {
  if (rows.length === 0) {
    return <Empty>No registrations yet. They appear here as Luma webhooks arrive.</Empty>;
  }
  return (
    <div className={`${cardClass} overflow-x-auto`}>
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead className="border-b border-zinc-200 text-xs text-zinc-500 dark:border-zinc-800">
          <tr>
            <th className="px-4 py-2 font-medium">Applicant</th>
            <th className="px-4 py-2 text-right font-medium">Score</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">AI reasoning</th>
            <th className="px-4 py-2 font-medium">Received</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {rows.map((r) => (
            <tr key={r.id} className="align-top">
              <td className="px-4 py-3">
                <div className="font-medium">{r.full_name ?? "Unknown"}</div>
                <div className="text-xs text-zinc-500">{r.email}</div>
                <div className="mt-1 flex gap-2 text-xs">
                  {r.role && <span className="text-zinc-500">{r.role}</span>}
                  {r.github_url && <ExternalLink href={r.github_url}>GitHub</ExternalLink>}
                  {r.linkedin_url && <ExternalLink href={r.linkedin_url}>LinkedIn</ExternalLink>}
                </div>
              </td>
              <td className="px-4 py-3 text-right font-semibold tabular-nums">{r.score ?? "—"}</td>
              <td className="px-4 py-3">
                <StatusBadge status={r.status} />
                {r.injection_suspected && <div className="mt-1 text-xs text-red-700 dark:text-red-400">⚠ injection attempt</div>}
                {r.luma_sync_mode === "simulated" && (
                  <div className="mt-1 text-xs text-zinc-500" title="Recorded without calling Luma (no LUMA_API_KEY or a simulated guest)">
                    Simulated, not synced to Luma
                  </div>
                )}
                {r.luma_sync_error && <div className="mt-1 text-xs text-red-700 dark:text-red-400" title={r.luma_sync_error}>Luma sync failed</div>}
              </td>
              <td className="max-w-sm px-4 py-3 text-zinc-600 dark:text-zinc-400">{r.reasoning}</td>
              <td className="whitespace-nowrap px-4 py-3 text-xs text-zinc-500">{when(r.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Audit({ rows, names }: { rows: AuditRow[]; names: Map<string, string> }) {
  if (rows.length === 0) return <Empty>No host decisions yet.</Empty>;
  const verb = { approve: "Approved", waitlist: "Waitlisted", escalate: "Escalated" } as const;
  return (
    <div className={`${cardClass} overflow-x-auto`}>
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="border-b border-zinc-200 text-xs text-zinc-500 dark:border-zinc-800">
          <tr>
            <th className="px-4 py-2 font-medium">When</th>
            <th className="px-4 py-2 font-medium">Who</th>
            <th className="px-4 py-2 font-medium">Action</th>
            <th className="px-4 py-2 font-medium">Applicant</th>
            <th className="px-4 py-2 font-medium">Luma</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {rows.map((a) => (
            <tr key={a.id}>
              <td className="whitespace-nowrap px-4 py-3 text-xs text-zinc-500">{when(a.created_at)}</td>
              <td className="px-4 py-3">
                <span className="capitalize">{a.actor_role}</span>
                <span className="ml-1 font-mono text-xs text-zinc-500">{a.actor_telegram_id}</span>
              </td>
              <td className="px-4 py-3 font-medium">{verb[a.action]}</td>
              <td className="px-4 py-3">{names.get(a.evaluation_id) ?? "—"}</td>
              <td className="px-4 py-3 text-xs">
                {a.luma_result === "ok" && <span className="text-emerald-700 dark:text-emerald-400">✓ synced</span>}
                {a.luma_result === "not_applicable" && <span className="text-zinc-500">n/a</span>}
                {a.luma_result === "error" && (
                  <span className="text-red-700 dark:text-red-400" title={a.luma_error ?? undefined}>
                    ✗ failed
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  // Applicant-supplied URL: only render http(s) links.
  if (!/^https?:\/\//i.test(href)) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-blue-700 hover:underline dark:text-blue-400">
      {children}
    </a>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className={`${cardClass} px-6 py-12 text-center text-sm text-zinc-600 dark:text-zinc-400`}>{children}</div>;
}
