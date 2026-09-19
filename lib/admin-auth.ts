import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ADMIN_COOKIE, SESSION_TTL_SECONDS, createSessionToken, verifySessionToken } from "@/lib/admin-session";

export async function isAdmin(): Promise<boolean> {
  const token = (await cookies()).get(ADMIN_COOKIE)?.value;
  return verifySessionToken(token, process.env.ADMIN_SESSION_SECRET);
}

/** Call at the top of every admin page, data function and Server Action. */
export async function requireAdmin(): Promise<void> {
  if (!(await isAdmin())) redirect("/admin/login");
}

export async function startAdminSession(): Promise<void> {
  (await cookies()).set(ADMIN_COOKIE, createSessionToken(process.env.ADMIN_SESSION_SECRET!), {
    httpOnly: true,
    // Browsers treat http://localhost as secure, but not every dev setup does.
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function endAdminSession(): Promise<void> {
  (await cookies()).delete(ADMIN_COOKIE);
}
