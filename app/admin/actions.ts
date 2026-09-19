"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { z } from "zod";
import { endAdminSession, requireAdmin, startAdminSession } from "@/lib/admin-auth";
import { checkAdminPassword, sessionSecretProblem } from "@/lib/admin-session";
import { parseEventConfigForm, type FieldErrors } from "@/lib/admin-schema";
import { saveEvent, setEventActive } from "@/lib/admin-data";
import { hitRateLimit } from "@/lib/redis";

export type LoginState = { error?: string };

const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_SECONDS = 15 * 60;

export async function loginAction(_prev: LoginState, form: FormData): Promise<LoginState> {
  const secretProblem = sessionSecretProblem(process.env.ADMIN_SESSION_SECRET);
  if (secretProblem || !process.env.ADMIN_PASSWORD) {
    return { error: `Admin login is not configured. ${secretProblem ?? "ADMIN_PASSWORD is not set."}` };
  }

  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  try {
    if (!(await hitRateLimit(`admin-login:${ip}`, LOGIN_LIMIT, LOGIN_WINDOW_SECONDS))) {
      return { error: "Too many attempts. Try again in 15 minutes." };
    }
  } catch (err) {
    // Without Redis there is no brute-force protection, so production fails closed.
    if (process.env.NODE_ENV === "production") {
      console.error("login rate limiter unavailable", err);
      return { error: "Login is temporarily unavailable." };
    }
  }

  const password = form.get("password");
  if (typeof password !== "string" || !checkAdminPassword(password, process.env.ADMIN_PASSWORD)) {
    return { error: "Incorrect password." };
  }
  await startAdminSession();
  redirect("/admin");
}

export async function logoutAction(): Promise<void> {
  await endAdminSession();
  redirect("/admin/login");
}

export type EventFormState = { errors?: FieldErrors; values?: Record<string, string> };

const idSchema = z.uuid();

export async function saveEventAction(_prev: EventFormState, form: FormData): Promise<EventFormState> {
  await requireAdmin();
  const rawId = form.get("id");
  const id = typeof rawId === "string" && rawId !== "" ? rawId : null;
  if (id && !idSchema.safeParse(id).success) return { errors: { _form: "Invalid event id." } };

  const values = Object.fromEntries(
    [...form.entries()].filter(([, v]) => typeof v === "string"),
  ) as Record<string, string>;

  const parsed = parseEventConfigForm(form);
  if (!parsed.ok) return { errors: parsed.errors, values };

  const result = await saveEvent(id, parsed.data);
  if ("error" in result) return { errors: { _form: result.error }, values };
  redirect(`/admin/events/${result.id}?saved=1`);
}

export async function toggleActiveAction(form: FormData): Promise<void> {
  await requireAdmin();
  const id = idSchema.parse(form.get("id"));
  await setEventActive(id, form.get("active") === "true");
  refresh();
}
