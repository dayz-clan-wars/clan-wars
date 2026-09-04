import { AUTH_PAGES } from "./gate";
import type { Session } from "./session";

/**
 * The gate's routing decision, pulled out of middleware as a pure function.
 *
 * ⚠️ Middleware itself is not unit-testable (it needs a real Next.js request
 * object and the edge runtime), so the actual bug this fixes — a kicked
 * member's redirect to /join never carrying the refreshed cookie, because the
 * `res.cookies.set(...)` lived below an early `return` — could not be pinned
 * by a test that exercises middleware.ts directly. Moving the "what to do"
 * decision here, with no cookie-writing in it at all, makes it possible to
 * test every branch's OUTPUT and lets middleware attach the refreshed cookie
 * from ONE place after calling this, rather than duplicating that line at
 * every return site (which is exactly how the bug happened: a call added
 * later without repeating the line above it).
 */
export type RouteDecision =
  | { action: "allow" }
  | { action: "redirect"; target: string; next?: string };

const [LOGIN_PATH, JOIN_PATH] = AUTH_PAGES;

export function decideRoute(input: {
  pathname: string;
  /** The session as decoded from the incoming cookie, before any recheck. */
  existing: Session | null;
  /**
   * The session after a possible 15-minute recheck — `=== existing` when no
   * recheck ran. Only consulted for gated pages; /login and /join decide from
   * `existing` alone, exactly as before this refactor (they redirect away
   * before a recheck would ever run).
   */
  session: Session | null;
  /** Safe, auth-page-guarded landing target for someone already signed in. */
  wanted: string;
  /** Safe path to return to after signing in, for a gated page. */
  here: string;
}): RouteDecision {
  const { pathname, existing, session, wanted, here } = input;

  // ⚠️ /login and /join redirect away when they have nothing to ask for.
  // Rendering /join to a member would send a "Join servers for you" consent
  // screen to someone already in the guild.
  if (pathname === LOGIN_PATH) {
    return existing?.guild ? { action: "redirect", target: wanted } : { action: "allow" };
  }
  if (pathname === JOIN_PATH) {
    if (!existing) return { action: "redirect", target: LOGIN_PATH, next: JOIN_PATH };
    return existing.guild ? { action: "redirect", target: wanted } : { action: "allow" };
  }

  if (!existing) return { action: "redirect", target: LOGIN_PATH, next: here };
  if (!session?.guild) return { action: "redirect", target: JOIN_PATH, next: here };
  return { action: "allow" };
}
