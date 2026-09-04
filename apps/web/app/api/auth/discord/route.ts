import { NextResponse, type NextRequest } from "next/server";
import { generateState } from "arctic";
import { discordClient } from "@/lib/auth/discord";
import { STATE_COOKIE, stateCookieAttributes } from "@/lib/auth/cookies";
import { safeNextPath } from "@/lib/auth/next-path";

/**
 * Begins the OAuth round.
 *
 * ⚠️ Two tiers of consent. The default round asks for `identify` only;
 * `guilds.join` renders on Discord's screen as "Join servers for you", which
 * is the most alarming line a player will read and is irrelevant to everyone
 * already in the guild. It is requested only by ?mode=join.
 *
 * ⚠️ No PKCE: this is a confidential client and arctic's Discord provider
 * refuses a code verifier for one. The state cookie is therefore the ENTIRE
 * CSRF defence.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const baseUrl = process.env.WEB_BASE_URL ?? req.nextUrl.origin;
  const mode = req.nextUrl.searchParams.get("mode") === "join" ? "join" : "login";
  const next = safeNextPath(req.nextUrl.searchParams.get("next"));

  const state = generateState();
  const scopes = mode === "join" ? ["identify", "guilds.join"] : ["identify"];
  const url = discordClient().createAuthorizationURL(state, null, scopes);

  const res = NextResponse.redirect(url);
  // mode and next travel in the signed-off cookie, not the URL, so neither can
  // be swapped between the redirect to Discord and the callback.
  res.cookies.set(
    STATE_COOKIE,
    JSON.stringify({ state, mode, next }),
    stateCookieAttributes(baseUrl),
  );
  return res;
}
