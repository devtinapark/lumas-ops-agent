import type { EvaluationStatus } from "@/lib/supabase";

export const STATUS_META: Record<EvaluationStatus, { label: string; className: string }> = {
  auto_approved: { label: "Auto-approved", className: "bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-300" },
  host_approved: { label: "Host approved", className: "bg-emerald-50 text-emerald-800 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-300" },
  flagged_for_host: { label: "Awaiting host", className: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-950 dark:text-amber-300" },
  escalated: { label: "Escalated", className: "bg-red-50 text-red-800 ring-red-600/20 dark:bg-red-950 dark:text-red-300" },
  waitlisted: { label: "Auto-waitlisted", className: "bg-zinc-100 text-zinc-700 ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-300" },
  host_waitlisted: { label: "Host waitlisted", className: "bg-zinc-100 text-zinc-700 ring-zinc-500/20 dark:bg-zinc-800 dark:text-zinc-300" },
};

export function StatusBadge({ status }: { status: EvaluationStatus }) {
  const meta = STATUS_META[status];
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${meta.className}`}>
      {meta.label}
    </span>
  );
}
