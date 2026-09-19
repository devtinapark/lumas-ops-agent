import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const ADMIN_COOKIE = "lumaops_admin";
export const SESSION_TTL_SECONDS = 60 * 60 * 12;

const sha256 = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time compare that also hides length differences. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

export function checkAdminPassword(input: string, expected: string | undefined): boolean {
  if (!expected || !input) return false;
  return safeEqual(input, expected);
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`lumaops-admin.v1.${payload}`).digest("base64url");
}

/** Stateless session token: "<expiresAtSeconds>.<hmac>". Rotating the secret logs everyone out. */
export function createSessionToken(secret: string, nowMs = Date.now()): string {
  const expires = Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS;
  return `${expires}.${sign(String(expires), secret)}`;
}

export function verifySessionToken(token: string | undefined, secret: string | undefined, nowMs = Date.now()): boolean {
  if (!token || !secret) return false;
  const match = token.match(/^(\d{1,12})\.([A-Za-z0-9_-]{43})$/);
  if (!match) return false;
  const [, expires, mac] = match;
  if (Number(expires) * 1000 <= nowMs) return false;
  return safeEqual(mac, sign(expires, secret));
}

/** Refuse to run with a guessable session secret. */
export function sessionSecretProblem(secret: string | undefined): string | null {
  if (!secret) return "ADMIN_SESSION_SECRET is not set.";
  if (secret.length < 32) return "ADMIN_SESSION_SECRET must be at least 32 characters.";
  return null;
}
