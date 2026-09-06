import { NextResponse, type NextRequest } from "next/server";
import { currentSession } from "./viewer";
import { siteUrl } from "./auth/site-url";
import type { Session } from "./auth/session";

export type Redirect = { back: string; code: string };

/**
 * The pure half of a form redirect: given an origin, a path, and an already
 * assembled query string, build the 303. Split out so it can be unit tested
 * without `next/headers`' `cookies()`, which has no request context outside
 * a real request.
 *
 * ⚠️ The path goes in `siteUrl`'s second argument, the query in its third.
 * `siteUrl(origin, \`${path}?x=y\`)` assigns the whole thing to
 * `url.pathname`, which percent-encodes the "?" into the path — a redirect
 * to `/clan%3Fresult=...` that 404s.
 */
export function redirectTo(origin: string, target: string, query: string): NextResponse {
  return NextResponse.redirect(siteUrl(origin, target, query), { status: 303 });
}

/**
 * Every roster write on the site has this shape: a form POST, one package
 * call, a 303 back to the page with a `?result=` code the page looks up.
 * ⚠️ The code is looked up, never echoed (lib/copy-lookup.ts). The rule
 * being enforced — cap, cooldown, authority — is the package's; this file
 * checks only that a string is a string.
 */
export async function formAction(req: NextRequest, back: string, run: (session: Session, form: FormData) => Promise<string | Redirect>): Promise<NextResponse> {
  const origin = process.env.WEB_BASE_URL ?? req.nextUrl.origin;
  const session = await currentSession();
  if (!session) return redirectTo(origin, "/login", `?next=${encodeURIComponent(back)}`);
  const form = await req.formData();
  const out = await run(session, form);
  const { back: target, code } = typeof out === "string" ? { back, code: out } : out;
  return redirectTo(origin, target, `?result=${encodeURIComponent(code)}`);
}

export function text(form: FormData, name: string, max: number): string | null {
  const v = form.get(name);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 || t.length > max ? null : t;
}
const ID_RE = /^\d{1,12}$/u;
export function id(form: FormData, name: string): number | null {
  const v = form.get(name);
  return typeof v === "string" && ID_RE.test(v) ? Number(v) : null;
}
export const confirmed = (form: FormData): boolean => form.get("confirm") === "yes";

/**
 * Like `text`, but distinguishes "absent or empty" from "present but too
 * long" instead of collapsing both to `null`. A route that collapses them
 * silently clears an over-long field and reports success — the field never
 * saved what the player typed. `"too-long"` lets the caller report a
 * `bad-input` result instead.
 */
export function optionalText(form: FormData, name: string, max: number): string | null | "too-long" {
  const v = form.get(name);
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length === 0) return null;
  if (t.length > max) return "too-long";
  return t;
}
