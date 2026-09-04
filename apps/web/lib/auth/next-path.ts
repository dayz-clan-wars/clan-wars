/**
 * Validates the `?next=` value the login flow carries around.
 *
 * ⚠️ This is the open-redirect guard. `?next=` is attacker-controlled: it
 * arrives in a URL anyone can send to anyone. Without this, a link to
 * dayzclanwars.com bounces the player to an attacker's site immediately after
 * we have asked them to trust us with a Discord consent screen, which is the
 * best possible moment to phish someone.
 *
 * Allow exactly one shape: a single leading slash NOT followed by another
 * slash or a backslash. Everything else becomes "/".
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return "/";
  // ⚠️ WHATWG URL parsing strips ASCII tab, LF and CR from a URL string
  // ANYWHERE in it, BEFORE parsing. So "/\t/evil.example" reads as a harmless
  // relative path to the prefix checks below, and then resolves to
  // https://evil.example/. Reject the whole control-character class rather
  // than stripping it: a legitimate next-path never contains one, and
  // stripping would silently rewrite an attacker's value into a valid path.
  if (/[\t\n\r ]/.test(raw)) return "/";
  if (!raw.startsWith("/")) return "/";
  // ⚠️ "//host" is protocol-relative and browsers treat it as absolute.
  // "/\host" is normalised to "//host" by some browsers. Both are off-site.
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}

/**
 * Splits a validated next-path into the two halves a URL object needs.
 *
 * ⚠️ Callers must not assign `safeNextPath()`'s result straight to
 * `url.pathname`: a path carrying a query ("/mobile?tab=map") would have its
 * "?" percent-encoded INTO the path, and the redirect would 404 on a route
 * that exists. Re-validates its input, so callers may pass a raw value.
 */
export function splitNextPath(next: string | null | undefined): {
  pathname: string;
  search: string;
} {
  const safe = safeNextPath(next);
  const q = safe.indexOf("?");
  return q === -1
    ? { pathname: safe, search: "" }
    : { pathname: safe.slice(0, q), search: safe.slice(q) };
}
