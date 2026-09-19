import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/admin-auth";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Founder login · LumaOps", robots: { index: false } };

export default async function LoginPage() {
  if (await isAdmin()) redirect("/admin");
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Founder console</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Event rules, thresholds and budget caps. Hosts don&apos;t have access here.
      </p>
      <LoginForm />
    </main>
  );
}
