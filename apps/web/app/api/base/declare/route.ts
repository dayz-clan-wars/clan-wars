import { NextResponse, type NextRequest } from "next/server";
import { declareSolo } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { siteUrl } from "@/lib/auth/site-url";

/** POST from the form on /base. Every rule — 200 m, one base, evidence — is the package's. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const origin = process.env.WEB_BASE_URL ?? req.nextUrl.origin;
  const session = await currentSession();
  if (!session) return NextResponse.redirect(siteUrl(origin, "/login?next=/base"), { status: 303 });
  const form = await req.formData();
  const poleKey = form.get("poleKey");
  if (typeof poleKey !== "string" || poleKey.length === 0 || poleKey.length > 64) {
    return NextResponse.redirect(siteUrl(origin, "/base?result=no-raise"), { status: 303 });
  }
  const out = await declareSolo(session.sub, poleKey);
  return NextResponse.redirect(siteUrl(origin, `/base?result=${out.ok ? "declared" : out.reason}`), { status: 303 });
}
