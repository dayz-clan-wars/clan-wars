import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/cookies";
import { siteUrl } from "@/lib/auth/site-url";

/**
 * ⚠️ POST only, and deliberately no GET export. A GET logout can be triggered
 * by any <img> tag on any page on the internet, which turns logging players
 * out into a drive-by.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const origin = process.env.WEB_BASE_URL ?? req.nextUrl.origin;
  const res = NextResponse.redirect(siteUrl(origin, "/"), { status: 303 });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
