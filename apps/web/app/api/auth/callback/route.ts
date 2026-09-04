import { NextResponse, type NextRequest } from "next/server";
import { addGuildMember, currentUser, discordClient, guildMemberStatus } from "@/lib/auth/discord";
import { SESSION_COOKIE, STATE_COOKIE, sessionCookieAttributes } from "@/lib/auth/cookies";
import { encodeSession, sessionKey, type Session } from "@/lib/auth/session";
import { nextCheckAfter, outcomeForStatus } from "@/lib/auth/membership";
import { safeNextPath, splitNextPath } from "@/lib/auth/next-path";
import { siteUrl } from "@/lib/auth/site-url";

type StateCookie = { state: string; mode: "login" | "join"; next: string };

function readState(raw: string | undefined): StateCookie | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as StateCookie;
    if (typeof v.state !== "string" || (v.mode !== "login" && v.mode !== "join")) return null;
    return { state: v.state, mode: v.mode, next: safeNextPath(v.next) };
  } catch {
    return null;
  }
}

function fail(req: NextRequest, reason: string): NextResponse {
  const origin = process.env.WEB_BASE_URL ?? req.nextUrl.origin;
  const url = siteUrl(origin, "/login", `?error=${encodeURIComponent(reason)}`);
  const res = NextResponse.redirect(url);
  res.cookies.delete(STATE_COOKIE);
  return res;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const baseUrl = process.env.WEB_BASE_URL ?? req.nextUrl.origin;
  const code = req.nextUrl.searchParams.get("code");
  const returnedState = req.nextUrl.searchParams.get("state");
  const saved = readState(req.cookies.get(STATE_COOKIE)?.value);

  // ⚠️ Refuse outright. With no PKCE this comparison is the only thing
  // standing between us and a login CSRF, so a missing or mismatched state
  // must never fall through to the exchange.
  if (!code || !saved || !returnedState || returnedState !== saved.state) {
    return fail(req, "state");
  }

  let accessToken: string;
  try {
    // No PKCE (confidential client, and arctic's Discord provider refuses a
    // code verifier for one) — the null is the codeVerifier arg, not a stray.
    accessToken = (await discordClient().validateAuthorizationCode(code, null)).accessToken();
  } catch {
    return fail(req, "discord");
  }

  const user = await currentUser(accessToken);
  if (!user) return fail(req, "discord");

  let outcome = outcomeForStatus(await guildMemberStatus(user.id));

  if (saved.mode === "join" && outcome !== "member") {
    const status = await addGuildMember(user.id, accessToken);
    // 201 added, 204 already a member. 403 means banned — say so plainly
    // rather than offering a retry that cannot succeed.
    if (status === 201 || status === 204) outcome = "member";
    else if (status === 403) return fail(req, "banned");
  }

  // ⚠️ Unlike middleware's last-known-good, LOGIN has no prior session to fall
  // back on — "unknown" here has never meant "member" or "not a member", it
  // means we don't know. Building a session from it would set guild:false and
  // send an actual member to /join, where the button fires the guilds.join
  // consent screen spec §2.3 exists to keep away from people already in the
  // guild. Fail with the "discord unavailable" copy /login already has for
  // this (spec §5) instead. Do NOT copy this into middleware: there,
  // last-known-good is correct and deliberate.
  if (outcome === "unknown") return fail(req, "discord");

  // ⚠️ The access token is used for nothing else and is not stored anywhere.
  // Everything after this point works from the user id alone.
  const now = Math.floor(Date.now() / 1000);
  const session: Session = {
    sub: user.id,
    name: user.username,
    avatar: user.avatar,
    guild: outcome === "member",
    nextCheckAt: nextCheckAfter(outcome, now),
    // The anchor for the 7-day expiry — see session.ts. Set ONLY here, at a
    // fresh login; middleware carries it through unchanged on every re-issue.
    authAt: now,
  };

  const url = siteUrl(baseUrl, "/");
  if (session.guild) {
    // ⚠️ Split, never assigned whole: a next-path may carry a query, and
    // assigning it to `pathname` percent-encodes the "?" into the path.
    const { pathname, search } = splitNextPath(saved.next);
    url.pathname = pathname;
    url.search = search;
  } else {
    url.pathname = "/join";
    url.search = `?next=${encodeURIComponent(saved.next)}`;
  }

  const res = NextResponse.redirect(url);
  res.cookies.set(
    SESSION_COOKIE,
    await encodeSession(session, sessionKey(process.env.SESSION_SECRET ?? "")),
    sessionCookieAttributes(baseUrl),
  );
  res.cookies.delete(STATE_COOKIE);
  return res;
}
