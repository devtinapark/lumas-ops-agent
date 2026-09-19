import { z } from "zod";

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const telegramId = z.coerce
  .number({ message: "Must be a number" })
  .int("Must be a whole number")
  .refine((n) => n !== 0 && Math.abs(n) <= Number.MAX_SAFE_INTEGER, "Not a valid Telegram id");

const money = z.coerce
  .number({ message: "Must be a number" })
  .min(0, "Cannot be negative")
  .max(10_000_000, "Too large")
  .transform((n) => Math.round(n * 100));

export const eventConfigFormSchema = z
  .object({
    luma_event_id: z
      .string()
      .trim()
      .regex(/^evt-[A-Za-z0-9]+$/, 'Luma event ids look like "evt-abc123"'),
    name: z.string().trim().min(1, "Required").max(120),
    active: z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean()),
    auto_approve_threshold: z.coerce.number().int().min(1).max(100),
    auto_waitlist_threshold: z.coerce.number().int().min(0).max(99),
    budget_cap: z.preprocess(blankToUndefined, money.optional()),
    cost_per_head: z.preprocess(blankToUndefined, money.optional()),
    venue_capacity: z.preprocess(blankToUndefined, z.coerce.number().int().positive("Must be positive").optional()),
    local_host_name: z.string().trim().min(1, "Required").max(80),
    local_host_telegram_id: telegramId,
    local_host_chat_id: z.preprocess(blankToUndefined, telegramId.optional()),
    founder_telegram_id: telegramId,
    founder_chat_id: z.preprocess(blankToUndefined, telegramId.optional()),
  })
  .refine((v) => v.auto_waitlist_threshold < v.auto_approve_threshold, {
    path: ["auto_waitlist_threshold"],
    message: "Must be lower than the auto-approve threshold",
  })
  .transform((v) => ({
    luma_event_id: v.luma_event_id,
    name: v.name,
    active: v.active,
    auto_approve_threshold: v.auto_approve_threshold,
    auto_waitlist_threshold: v.auto_waitlist_threshold,
    budget_cap_cents: v.budget_cap ?? 0,
    cost_per_head_cents: v.cost_per_head ?? 0,
    venue_capacity: v.venue_capacity ?? null,
    local_host_name: v.local_host_name,
    local_host_telegram_id: v.local_host_telegram_id,
    // A private chat's id equals the user's id, so DMs need no separate chat id.
    local_host_chat_id: v.local_host_chat_id ?? v.local_host_telegram_id,
    founder_telegram_id: v.founder_telegram_id,
    founder_chat_id: v.founder_chat_id ?? v.founder_telegram_id,
  }));

export type EventConfigInput = z.output<typeof eventConfigFormSchema>;

export type FieldErrors = Partial<Record<string, string>>;

export function parseEventConfigForm(
  form: FormData,
): { ok: true; data: EventConfigInput } | { ok: false; errors: FieldErrors } {
  const raw = Object.fromEntries(
    [...form.entries()].filter(([, v]) => typeof v === "string"),
  ) as Record<string, string>;
  const result = eventConfigFormSchema.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };
  const errors: FieldErrors = {};
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? "_form");
    errors[key] ??= issue.message;
  }
  return { ok: false, errors };
}
