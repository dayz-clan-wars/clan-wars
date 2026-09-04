import { NextResponse, type NextRequest } from "next/server";
import { pathIsPublic } from "./lib/auth/gate";
import { SESSION_COOKIE, sessionCookieAttributes } from "./lib/auth/cookies";
import { decodeSession, encodeSession, sessionKey, type Session } from "./lib/auth/session";
import { guildMemberStatus } from "./lib/auth/discord";
import { nextCheckAfter, outcomeForStatus } from "./lib/auth/membership";
import { safeNextPath, splitNextPath } from "./lib/auth/next-path";

/**
 * The gate.
 *
 * ⚠️ Gated pages stay STATICALLY rendered. This intercepts the request; it does
 * not make the page dynamic. Nothing about how the pages build changes.
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
  const wanted = safeNextPath(req.nextUrl.searchParams.get("next"));

  const existing = await decodeSession(req.cookies.get(SESSION_COOKIE)?.value ?? "", key);

  // ⚠️ /login and /join redirect away when they have nothing to ask for.
  // Rendering /join to a member would send a "Join servers for you" consent
  // screen to someone already in the guild.
  if (pathname === "/login") {
    return existing?.guild ? redirectTo(req, wanted) : NextResponse.next();
  }
  if (pathname === "/join") {
    if (!existing) return redirectTo(req, "/login", "/join");
    return existing.guild ? redirectTo(req, wanted) : NextResponse.next();
  }

  if (!existing) return redirectTo(req, "/login", here);

  let session: Session = existing;
  const now = Math.floor(Date.now() / 1000);
  if (now >= session.nextCheckAt) {
    const outcome = outcomeForStatus(await guildMemberStatus(session.sub));
    session = {
      ...session,
      // ⚠️ "unknown" leaves `guild` exactly as it was — last-known-good. This
      // one expression is spec §2.7: a Discord outage must not log anyone out.
      guild: outcome === "unknown" ? session.guild : outcome === "member",
      nextCheckAt: nextCheckAfter(outcome, now),
    };
  }

  if (!session.guild) return redirectTo(req, "/join", here);

  const res = NextResponse.next();
  // Only re-issue when the re-check actually ran, so a normal request sets no
  // cookie and the 7-day expiry is not silently extended on every page view.
  if (session !== existing) {
    res.cookies.set(SESSION_COOKIE, await encodeSession(session, key), sessionCookieAttributes(baseUrl));
  }
  return res;
}
