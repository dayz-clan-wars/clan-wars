import { NextResponse, type NextRequest } from "next/server";
import { currentSession } from "./viewer";
import { siteUrl } from "./auth/site-url";
import type { Session } from "./auth/session";

/**
 * Non-secret values a refused form sends back, so the player does not
 * retype them (H2). ⚠️ A field name is matched against `NEVER_KEEP`
 * case-insensitively, and rejected outright unless it is a plain identifier
 * (letters, digits, "_", "-") — see `neverKeep` — so `Code`, `CODE` and a
 * dotted name like `kept.code` are refused exactly like `code`.
 */
export type Keep = Record<string, string | readonly string[]>;
export type Redirect = { back: string; code: string; keep?: Keep };

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
  const { back: target, code, keep } = typeof out === "string" ? { back, code: out, keep: undefined } : out;
  return redirectTo(origin, target, resultQuery(code, keep));
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

/**
 * Where a form post may send the player back to.
 *
 * ⚠️ An allowlist, not a validation. `back` arrives in a form field, so it is
 * attacker-controlled; used as given it is an open redirect — a link on our own
 * domain that bounces to someone else's, wearing our styling. Anything not
 * spelled here falls back to the route's own default.
 */
const BACKS = new Set(["/me", "/clan", "/clan/settings", "/clan/vault", "/notifications"]);

export function safeBack(value: FormDataEntryValue | string | null, fallback: string): string {
  return typeof value === "string" && BACKS.has(value) ? value : fallback;
}

/** Query-string prefix for kept values: `?result=…&kept.name=…`. */
export const KEEP_PREFIX = "kept.";
/** No kept value is longer than this, whatever the field's own limit. */
export const KEEP_VALUE_MAX = 200;
/** No kept list (the claim roster) is longer than this. */
export const KEEP_LIST_MAX = 16;

/**
 * ⚠️ Never kept, never read back. A vault code must never enter a URL
 * (CLAUDE.md, the vault); a kept value is in the address bar, the history and
 * the access log. Enforced here, in BOTH directions, so a future route that
 * passes it — or a crafted link that carries it — still cannot leak one.
 */
const NEVER_KEEP = new Set(["code"]);
/** A field name safe to prefix and put on the query — no dots, no odd characters. */
const FIELD_NAME_RE = /^[A-Za-z0-9_-]+$/u;

/**
 * ⚠️ The single gate for "never keep this field", used by both write-side
 * callers (`resultQuery`, `keepFrom`). `NEVER_KEEP.has(name)` alone is not
 * enough: it is an exact, case-sensitive match, so `Code`/`CODE` sail past it,
 * and a name containing a "." can forge a `kept.` segment of its own — a
 * field literally named `kept.code` would otherwise write the same
 * `kept.code=` query param `code` does. Lowercasing before the set check
 * catches the first; requiring a plain identifier (no ".", no other
 * punctuation) catches the second, since a legitimate field name never needs
 * one.
 */
function neverKeep(name: string): boolean {
  return !FIELD_NAME_RE.test(name) || NEVER_KEEP.has(name.toLowerCase());
}

const keepable = (v: string) => v.length > 0 && v.length <= KEEP_VALUE_MAX;

/**
 * The query a form redirect carries: the result code, then any kept values.
 *
 * ⚠️ URLSearchParams, never string concatenation: a typed "&" or "=" would
 * otherwise split the query and a kept name would come back as two fields.
 * An over-long value is DROPPED, not cut — a silently truncated name in the
 * field is worse than an empty one.
 */
export function resultQuery(code: string, keep?: Keep): string {
  const q = new URLSearchParams({ result: code });
  for (const [name, value] of Object.entries(keep ?? {})) {
    if (neverKeep(name)) continue;
    const values = typeof value === "string" ? [value] : value.slice(0, KEEP_LIST_MAX);
    for (const v of values) if (keepable(v)) q.append(KEEP_PREFIX + name, v);
  }
  return `?${q.toString()}`;
}

/**
 * The fields of a refused form worth handing back, trimmed, each within its
 * own limit. Only the fields named in `fields` — a route lists what it keeps,
 * so nothing is kept by accident.
 */
export function keepFrom(form: FormData, fields: Record<string, number>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, max] of Object.entries(fields)) {
    if (neverKeep(name)) continue;
    const v = form.get(name);
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t.length > 0 && t.length <= Math.min(max, KEEP_VALUE_MAX)) out[name] = t;
  }
  return out;
}

export type Kept = { get(name: string): string | undefined; all(name: string): string[] };

/**
 * A page's view of its kept values. ⚠️ Attacker-suppliable like every query
 * value, so the page only ever puts one into a field's defaultValue or
 * re-checks an option it already lists — never renders it as text.
 */
export function readKept(params: Record<string, string | string[] | undefined>): Kept {
  const all = (name: string): string[] => {
    const key = KEEP_PREFIX + name;
    if (NEVER_KEEP.has(name) || !Object.hasOwn(params, key)) return [];
    const v = params[key];
    const list = typeof v === "string" ? [v] : Array.isArray(v) ? v : [];
    return list.filter(keepable).slice(0, KEEP_LIST_MAX);
  };
  return { get: (name) => all(name)[0], all };
}
