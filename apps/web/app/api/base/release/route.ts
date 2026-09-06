import { NextResponse, type NextRequest } from "next/server";
import { releaseSolo } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { siteUrl } from "@/lib/auth/site-url";

/** POST from the form on /base; requires the confirm checkbox — a release starts a 3-day clock on the pole. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const origin = process.env.WEB_BASE_URL ?? req.nextUrl.origin;
  const session = await currentSession();
  if (!session) return NextResponse.redirect(siteUrl(origin, "/login", "?next=/base"), { status: 303 });
  const form = await req.formData();
  if (form.get("confirm") !== "yes") return NextResponse.redirect(siteUrl(origin, "/base", "?result=unconfirmed"), { status: 303 });
  const { released } = await releaseSolo(session.sub);
  return NextResponse.redirect(siteUrl(origin, "/base", `?result=${released ? "released" : "nothing"}`), { status: 303 });
}
