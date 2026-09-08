/**
 * What is reachable without a session.
 *
 * ⚠️ These lists are the security boundary. `test/auth-gate.test.ts` pins them
 * exactly, so adding an entry is a deliberate act that fails a test naming it.
 */

/** The landing page, the clan directory, the scoring pages, and the guide (spec §10.2: public). */
export const PUBLIC_PATHS = ["/", "/clans", "/scoreboard", "/alphas", "/seasons", "/war-log", "/players", "/guide"] as const;

/**
 * ⚠️ Trailing slashes are load-bearing: "/api/auth/" must not match
 * "/api/authorise-me". Every prefix here ends with one.
 *
 * Static flags stay public on purpose — they are the same 33 images the bot
 * already posts publicly, and gating them would break caching for every page.
 * `/clans/` is the public clan pages (`/clans/{tag}`); `/clan` (singular,
 * the member's own) is gated. `/players/` is public player profiles
 * (`/players/{gamertag}`, spec §10.2); `/clan/board` (under `/clan`, not
 * `/players`) stays gated. `/guide/` is the field guide's subpaths — every
 * one of them is a permanent redirect to the guide's own host
 * (next.config.ts), and Next runs redirects before middleware, so this entry
 * makes the list true rather than making the route reachable.
 */
export const PUBLIC_PREFIXES = ["/api/auth/", "/flags/", "/clans/", "/players/", "/guide/"] as const;

/**
 * Handled by middleware rather than by this predicate: whether these should
 * render depends on the session, so they are neither public nor gated.
 */
export const AUTH_PAGES = ["/login", "/join"] as const;

export function pathIsPublic(pathname: string): boolean {
  if ((PUBLIC_PATHS as readonly string[]).includes(pathname)) return true;
  return (PUBLIC_PREFIXES as readonly string[]).some((p) => pathname.startsWith(p));
}
