/**
 * Build an absolute URL on THIS site, from the configured public origin.
 *
 * ⚠️ Never build a redirect by cloning `req.nextUrl` inside a ROUTE HANDLER.
 * Behind this host's nginx the Node runtime sees the container's own bind
 * address, so the clone resolves to `https://0.0.0.0:3000` — a dead address.
 * The OAuth callback's final hop then strands the player on nothing
 * immediately after a successful Discord login, with the session cookie set
 * but nowhere to land.
 *
 * ⚠️ Middleware does NOT have this problem — it receives the original host —
 * which is exactly what makes the bug so easy to ship: the redirects you test
 * first all work, and only the callback and logout are wrong. It is invisible
 * until the app runs behind a proxy, so no local run and no unit test that
 * mocks a request will show it.
 *
 * `origin` falls back to the request's own origin only so `pnpm dev` works
 * with no `WEB_BASE_URL` set.
 */
export function siteUrl(origin: string, pathname: string, search = ""): URL {
  const url = new URL(origin);
  url.pathname = pathname;
  url.search = search;
  return url;
}
