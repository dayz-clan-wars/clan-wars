/**
 * What is reachable without a session.
 *
 * ⚠️ These lists are the security boundary. `test/auth-gate.test.ts` pins them
 * exactly, so adding an entry is a deliberate act that fails a test naming it.
 */

/**
 * The landing page, the clan directory, the scoring pages, and the guide
 * (spec §10.2: public) — and the site mark, which the top bar shows to
 * everyone. ⚠️ `public/` files are NOT exempt from the gate: the middleware
 * matcher only skips /_next/static, /_next/image, favicon.ico and robots.txt,
 * so an image outside these lists 303s to /login for an anonymous visitor.
 * The app icons and manifest (app/icon.png, app/apple-icon.png,
 * app/manifest.ts) are fetched by the browser before any login, so they are
 * public too — a 303 there is a broken tab icon, not a leak prevented.
 * The share images (app/opengraph-image.png, app/twitter-image.png) are
 * fetched by Discord's and Twitter's crawlers, which never have a session —
 * gated, a pasted link unfurls with no picture.
 */
export const PUBLIC_PATHS = ["/", "/clans", "/scoreboard", "/alphas", "/seasons", "/war-log", "/players", "/guide", "/mark.png", "/icon.png", "/apple-icon.png", "/manifest.webmanifest", "/opengraph-image.png", "/twitter-image.png"] as const;

/**
 * ⚠️ Trailing slashes are load-bearing: "/api/auth/" must not match
 * "/api/authorise-me". Every prefix here ends with one.
 *
 * Static flags stay public on purpose — they are the same 33 images the bot
 * already posts publicly, and gating them would break caching for every page.
 * `/clans/` is the public clan pages (`/clans/{tag}`); `/clan` (singular,
 * the member's own) is gated. `/players/` is public player profiles
 * (`/players/{gamertag}`, spec §10.2); `/clan/board` (under `/clan`, not
 * `/players`) stays gated. `/guide/` is the field guide's chapters
 * (`app/guide/[slug]`), served by this app since 2026-09-07 — before that
 * every subpath was a permanent redirect to the guide's own host. `/hero/`
 * is the landing page's terrain still (public/hero/, one webp): the page is
 * public, so its picture must be too. `/api/players/` is the gamertag
 * autocomplete behind the public player search; its `linked` scope checks
 * the session itself (app/api/players/suggest/route.ts).
 */
export const PUBLIC_PREFIXES = ["/api/auth/", "/flags/", "/clans/", "/players/", "/guide/", "/icons/", "/hero/", "/api/players/"] as const;

/**
 * Handled by middleware rather than by this predicate: whether these should
 * render depends on the session, so they are neither public nor gated.
 */
export const AUTH_PAGES = ["/login", "/join"] as const;

export function pathIsPublic(pathname: string): boolean {
  if ((PUBLIC_PATHS as readonly string[]).includes(pathname)) return true;
  return (PUBLIC_PREFIXES as readonly string[]).some((p) => pathname.startsWith(p));
}
