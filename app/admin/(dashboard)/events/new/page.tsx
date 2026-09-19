import Link from "next/link";
import { requireAdmin } from "@/lib/admin-auth";
import { EventForm } from "../../../_components/event-form";

export default async function NewEventPage() {
  await requireAdmin();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/admin" className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
          ← Events
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New event</h1>
      </div>
      <EventForm />
    </div>
  );
}
