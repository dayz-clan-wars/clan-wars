import { NextResponse, type NextRequest } from "next/server";
import { pathIsPublic, AUTH_PAGES } from "./lib/auth/gate";
import { SESSION_COOKIE, sessionCookieAttributes, remainingSessionSeconds } from "./lib/auth/cookies";
import { decodeSession, encodeSession, sessionKey, type Session } from "./lib/auth/session";
import { guildMemberStatus } from "./lib/auth/discord";
import { nextCheckAfter, outcomeForStatus } from "./lib/auth/membership";
import { safeNextPath, splitNextPath, landingPath } from "./lib/auth/next-path";
import { decideRoute } from "./lib/auth/route-decision";

const [LOGIN_PATH, JOIN_PATH] = AUTH_PAGES;

/**
 * The gate.
 *
 * ⚠️ Gated pages stay STATICALLY rendered. This intercepts the request; it does
 * not make the page dynamic. Nothing about how the pages build changes.
 *
 * ⚠️ The matcher excludes `/_next/static` (and `/_next/image`, favicon,
 * robots.txt). That makes "everything else is gated" a claim about ROUTES,
 * not about content: a gated page's build-time HTML/JS/data is baked into a
 * static chunk under `/_next/static` and is fetchable by anyone, gate or no
 * gate. Harmless today because the gated pages are invented fixtures with
 * nothing real baked in — but baking real data into a gated page at build
 * time (rather than fetching it at request time, after this gate has run)
 * would leak that data with no error, log line, or test to catch it.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};

/**
 * ⚠️ Split, never assigned whole. A next-path may carry a query
 * ("/mobile?tab=map"), and assigning that to `url.pathname` percent-encodes
 * the "?" into the path — a redirect that 404s on a route that exists.
 */
function redirectTo(req: NextRequest, target: string, next?: string): NextResponse {
  const url = req.nextUrl.clone();
  const { pathname, search } = splitNextPath(target);
  url.pathname = pathname;
  // A `next` to remember replaces the target's own query; otherwise keep it.
  url.search = next ? `?next=${encodeURIComponent(next)}` : search;
  return NextResponse.redirect(url);
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname, search } = req.nextUrl;
  if (pathIsPublic(pathname)) return NextResponse.next();

  const baseUrl = process.env.WEB_BASE_URL ?? req.nextUrl.origin;
  const key = sessionKey(process.env.SESSION_SECRET ?? "");
  const here = safeNextPath(pathname + search);
  // ⚠️ Guarded against naming an auth page itself — `/login?next=/login`
  // would otherwise land a signed-in member back on /login, which redirects
  // by consulting `wanted` again. See lib/auth/next-path.ts.
  const wanted = landingPath(safeNextPath(req.nextUrl.searchParams.get("next")), AUTH_PAGES);

  const existing = await decodeSession(req.cookies.get(SESSION_COOKIE)?.value ?? "", key);

  // The 15-minute recheck only ever applies to a gated page with an existing
  // session — /login and /join decide from `existing` alone (see
  // route-decision.ts) and never reach this block.
  let session: Session | null = existing;
  let refreshed = false;
  const now = Math.floor(Date.now() / 1000);
  if (pathname !== LOGIN_PATH && pathname !== JOIN_PATH && existing && now >= existing.nextCheckAt) {
    const outcome = outcomeForStatus(await guildMemberStatus(existing.sub));
    session = {
      ...existing,
      // ⚠️ "unknown" leaves `guild` exactly as it was — last-known-good. This
      // one expression is spec §2.7: a Discord outage must not log anyone out.
      guild: outcome === "unknown" ? existing.guild : outcome === "member",
      nextCheckAt: nextCheckAfter(outcome, now),
      // `authAt` carries through UNCHANGED — only a fresh login sets it. See
      // session.ts: it is what stops the 7-day expiry sliding forever.
    };
    refreshed = true;
  }

  const decision = decideRoute({ pathname, existing, session, wanted, here });
  const res =
    decision.action === "redirect"
      ? redirectTo(req, decision.target, decision.next)
      : NextResponse.next();

  // ⚠️ Attached from this ONE place, after the decision is made, regardless
  // of which branch fired. This is the actual fix for the kicked-member loop:
  // the refreshed cookie used to be set only after the code path that fell
  // through to the bottom, so the /join redirect for a just-kicked member
  // returned before that line ever ran. /join then read the stale cookie
  // (still `guild:true`) and bounced back to `wanted` — forever, hammering
  // Discord on every hop. Setting it here, unconditionally on `refreshed`,
  // means the next branch anyone adds gets this for free instead of needing
  // to remember to repeat it.
  if (refreshed && session) {
    res.cookies.set(
      SESSION_COOKIE,
      await encodeSession(session, key),
      // Remaining life, not the full seven days — a re-issue must not slide
      // the expiry forward from "now".
      sessionCookieAttributes(baseUrl, remainingSessionSeconds(session.authAt, now)),
    );
  }
  return res;
}
