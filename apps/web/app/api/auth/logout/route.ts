import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/cookies";

/**
 * ⚠️ POST only, and deliberately no GET export. A GET logout can be triggered
 * by any <img> tag on any page on the internet, which turns logging players
 * out into a drive-by.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const url = req.nextUrl.clone();
  url.pathname = "/";
  url.search = "";
  const res = NextResponse.redirect(url, { status: 303 });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
