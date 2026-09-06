import { NextResponse, type NextRequest } from "next/server";
import { currentSession } from "./viewer";
import { siteUrl } from "./auth/site-url";
import type { Session } from "./auth/session";

export type Redirect = { back: string; code: string };

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
  if (!session) return NextResponse.redirect(siteUrl(origin, `/login?next=${encodeURIComponent(back)}`), { status: 303 });
  const form = await req.formData();
  const out = await run(session, form);
  const { back: target, code } = typeof out === "string" ? { back, code: out } : out;
  return NextResponse.redirect(siteUrl(origin, `${target}?result=${encodeURIComponent(code)}`), { status: 303 });
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
