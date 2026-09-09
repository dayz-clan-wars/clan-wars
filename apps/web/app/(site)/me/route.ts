import { NextResponse, type NextRequest } from "next/server";
import { viewerFor } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { siteUrl } from "@/lib/auth/site-url";
import { homePath } from "@/lib/own-page";

/**
 * "You" is a forward, not a page: a linked member's home is their own
 * player page, and before that it is the link flow (lib/own-page.ts). The
 * notice codes the action routes append (`?unlink=`, `?result=`) ride along
 * to wherever that is.
 *
 * ⚠️ A route handler, not a page with `redirect()`: app/(site)/loading.tsx
 * makes every page in the group stream, and a streamed redirect is a
 * one-second `<meta http-equiv="refresh">` behind the loading line, not a
 * 307. Every action route lands here with a hard 303, so that flash would be
 * on the main path. The middleware still gates this path (it is not public).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const origin = process.env.WEB_BASE_URL ?? req.nextUrl.origin;
  const session = await currentSession();
  // The middleware admitted this request, so the cookie was valid a moment ago; sign in again rather than land nowhere.
  if (!session) return NextResponse.redirect(siteUrl(origin, "/login", "?next=/me"), { status: 303 });
  const viewer = await viewerFor(session.sub);
  const q = req.nextUrl.searchParams;
  const to = homePath(viewer.link?.gamertag, { unlink: q.get("unlink") ?? undefined, result: q.get("result") ?? undefined });
  const [pathname, search = ""] = to.split("?", 2);
  return NextResponse.redirect(siteUrl(origin, pathname!, search && `?${search}`), { status: 307 });
}
