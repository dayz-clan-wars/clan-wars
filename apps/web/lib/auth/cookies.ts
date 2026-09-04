/**
 * Cookie names, lifetimes and attributes for the Discord login.
 *
 * ⚠️ No I/O and no environment reads. Everything is a parameter so the
 * attributes can be asserted directly — `apps/web` tests are node-only with no
 * browser, so a cookie flag that is not tested here is not tested anywhere.
 */

export const SESSION_COOKIE = "cw_session";
export const STATE_COOKIE = "cw_oauth_state";

/** Seven days. See spec §2.6 — roughly one login per active player per week. */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

/** Ten minutes: long enough to read a consent screen, short enough to not linger. */
export const STATE_MAX_AGE_SECONDS = 600;

export type CookieAttributes = {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
};

/**
 * ⚠️ `secure` is derived from the origin rather than hardcoded true. A `secure`
 * cookie is silently dropped over plain http, so hardcoding it would make
 * `pnpm dev` on http://localhost:3000 unable to log in at all — and the
 * symptom is a login that redirects successfully and arrives signed out.
 */
function base(baseUrl: string, maxAge: number): CookieAttributes {
  return {
    httpOnly: true,
    secure: baseUrl.startsWith("https://"),
    // ⚠️ lax, never strict. The OAuth callback is a cross-site top-level
    // navigation back from Discord; strict withholds the cookie on it.
    sameSite: "lax",
    path: "/",
    maxAge,
  };
}

/**
 * `maxAgeOverride` exists for the middleware re-issue path: a re-issued
 * cookie must expire at the ORIGINAL login's 7-day mark, not 7 days from now,
 * or a weekly visitor never re-authenticates. Pass the REMAINING life there,
 * not the full `SESSION_MAX_AGE_SECONDS` — the fresh-login case (no override)
 * is the only one that should get the full seven days.
 */
export function sessionCookieAttributes(baseUrl: string, maxAgeOverride?: number): CookieAttributes {
  return base(baseUrl, maxAgeOverride ?? SESSION_MAX_AGE_SECONDS);
}

export function stateCookieAttributes(baseUrl: string): CookieAttributes {
  return base(baseUrl, STATE_MAX_AGE_SECONDS);
}

/**
 * Remaining life of a session anchored at `authAt`, for the `maxAgeOverride`
 * above. Floored at 0 — `decodeSession` already refuses anything past its
 * `exp`, so this should never go negative in practice, but a negative
 * `maxAge` is a real footgun (some browsers expire the cookie immediately,
 * others reject the `Set-Cookie` header outright) and costs nothing to rule
 * out here.
 */
export function remainingSessionSeconds(authAt: number, now: number): number {
  return Math.max(0, authAt + SESSION_MAX_AGE_SECONDS - now);
}
