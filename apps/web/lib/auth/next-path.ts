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
 *
 * ⚠️ A fragment ("/mobile#frag") has the exact same failure mode as a query —
 * assigned into `url.pathname` it percent-encodes to `%23` and 404s. Fixed by
 * DROPPING it rather than carrying it through: a fragment is never sent to
 * the server, so the redirect target loses nothing a request could have used
 * anyway, and there is nowhere else in a `{pathname, search}` pair to put it.
 */
export function splitNextPath(next: string | null | undefined): {
  pathname: string;
  search: string;
} {
  const safe = safeNextPath(next);
  const hash = safe.indexOf("#");
  const withoutHash = hash === -1 ? safe : safe.slice(0, hash);
  const q = withoutHash.indexOf("?");
  return q === -1
    ? { pathname: withoutHash, search: "" }
    : { pathname: withoutHash.slice(0, q), search: withoutHash.slice(q) };
}

/**
 * Guards the ONE place `next` is used as a landing page for someone who is
 * ALREADY signed in with guild access (the early-exit branches of /login and
 * /join). If `next` names an auth page itself, landing there re-enters the
 * same check — `/login?next=/login` bounces a signed-in member back to
 * /login instead of anywhere real. Refused once, here, rather than trusted to
 * every call site that builds a redirect target from `next`.
 */
export function landingPath(target: string, authPages: readonly string[]): string {
  const { pathname } = splitNextPath(target);
  return authPages.includes(pathname) ? "/" : target;
}
