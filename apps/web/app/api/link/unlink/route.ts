import { NextResponse, type NextRequest } from "next/server";
import { unlink } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { siteUrl } from "@/lib/auth/site-url";

/**
 * ⚠️ POST only, from the form on /me — a GET unlink could be triggered by
 * any <img> on the internet, the same reasoning as the logout route. The
 * refusal-while-in-a-clan and the solo-base release are the package's, not
 * this file's.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const origin = process.env.WEB_BASE_URL ?? req.nextUrl.origin;
  const session = await currentSession();
  if (!session) return NextResponse.redirect(siteUrl(origin, "/login", "?next=/me"), { status: 303 });
  const out = await unlink(session.sub);
  const code = out.ok ? "ok" : out.reason;
  return NextResponse.redirect(siteUrl(origin, "/me", `?unlink=${code}`), { status: 303 });
}
