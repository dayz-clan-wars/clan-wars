/**
 * What is reachable without a session.
 *
 * ⚠️ These lists are the security boundary. `test/auth-gate.test.ts` pins them
 * exactly, so adding an entry is a deliberate act that fails a test naming it.
 */

/** The landing page, and only the landing page. */
export const PUBLIC_PATHS = ["/"] as const;

/**
 * ⚠️ Trailing slashes are load-bearing: "/api/auth/" must not match
 * "/api/authorise-me". Every prefix here ends with one.
 *
 * Static flags stay public on purpose — they are the same 33 images the bot
 * already posts publicly, and gating them would break caching for every page.
 */
export const PUBLIC_PREFIXES = ["/api/auth/", "/flags/"] as const;

/**
 * Handled by middleware rather than by this predicate: whether these should
 * render depends on the session, so they are neither public nor gated.
 */
export const AUTH_PAGES = ["/login", "/join"] as const;

export function pathIsPublic(pathname: string): boolean {
  if ((PUBLIC_PATHS as readonly string[]).includes(pathname)) return true;
  return (PUBLIC_PREFIXES as readonly string[]).some((p) => pathname.startsWith(p));
}
