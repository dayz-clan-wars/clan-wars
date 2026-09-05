import { cookies } from "next/headers";
import { SESSION_COOKIE } from "./auth/cookies";
import { decodeSession, sessionKey, type Session } from "./auth/session";

/**
 * The signed-in viewer, from the session cookie, for server components.
 *
 * ⚠️ Call this only from a page that is `force-dynamic`. It reads a request
 * cookie, which Next forbids at build time — but a page that could be built
 * statically and merely happened to call this at request time would still
 * have the static-rendering trap (frontend rebuild §7) one refactor away.
 * test/request-time-rendering.test.ts pins the pairing.
 *
 * The middleware has already run: a null here means the cookie was tampered
 * with or the secret rotated, not that the visitor is anonymous.
 */
export async function currentSession(): Promise<Session | null> {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value ?? "";
  return decodeSession(raw, sessionKey(process.env.SESSION_SECRET ?? ""));
}
