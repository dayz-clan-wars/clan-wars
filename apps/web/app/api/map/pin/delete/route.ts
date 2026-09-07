import { NextResponse, type NextRequest } from "next/server";
import { deletePin } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { siteUrl } from "@/lib/auth/site-url";

/**
 * POST from a pin's popup. Any full member of the clan can clear a pin; the
 * clan is in the package's WHERE clause, so another clan's id deletes nothing
 * and comes back as `not-deleted` — the same answer as a pin that has already
 * expired, which is what keeps this from being a probe for pin ids.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const origin = process.env.WEB_BASE_URL ?? req.nextUrl.origin;
  const session = await currentSession();
  if (!session) return NextResponse.redirect(siteUrl(origin, "/login", "?next=/map"), { status: 303 });
  const form = await req.formData();
  const id = Number(form.get("id"));
  const out = Number.isInteger(id) && id > 0 ? await deletePin(session.sub, id) : { deleted: false };
  return NextResponse.redirect(siteUrl(origin, "/map", `?result=${out.deleted ? "deleted" : "not-deleted"}`), { status: 303 });
}
