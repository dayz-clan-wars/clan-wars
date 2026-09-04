import { describe, it, expect } from "vitest";
import { siteUrl } from "../lib/auth/site-url";

/**
 * ⚠️ This exists because the bug it guards reached production. The OAuth
 * callback built its redirects by cloning the incoming request's URL, which
 * behind this host's nginx resolves to the container's own bind address —
 * so a successful Discord login redirected the player to
 * `https://0.0.0.0:3000/mobile` and stranded them there.
 *
 * No unit test that mocks a request would have caught it, and middleware
 * (which receives the original host) worked correctly throughout — so the
 * redirects anyone would check first were all fine.
 */
describe("siteUrl", () => {
  it("always builds on the configured public origin, never the request's", () => {
    expect(siteUrl("https://dayzclanwars.com", "/mobile").href).toBe(
      "https://dayzclanwars.com/mobile",
    );
  });

  it("ignores any host baked into the origin's own path", () => {
    // The container's view of itself, which is what leaked into production.
    expect(siteUrl("https://dayzclanwars.com", "/login", "?error=state").href).toBe(
      "https://dayzclanwars.com/login?error=state",
    );
  });

  it("keeps a query string intact", () => {
    expect(siteUrl("https://dayzclanwars.com", "/mobile", "?tab=map").href).toBe(
      "https://dayzclanwars.com/mobile?tab=map",
    );
  });

  it("defaults to no query", () => {
    expect(siteUrl("https://dayzclanwars.com", "/").search).toBe("");
  });

  it("works for a plain-http dev origin with a port", () => {
    expect(siteUrl("http://localhost:3000", "/join", "?next=%2Fmobile").href).toBe(
      "http://localhost:3000/join?next=%2Fmobile",
    );
  });

  // ⚠️ The regression itself: a container-internal origin must never survive
  // into a redirect the browser is asked to follow.
  it("never yields 0.0.0.0 when given the real origin", () => {
    const url = siteUrl("https://dayzclanwars.com", "/mobile");
    expect(url.hostname).toBe("dayzclanwars.com");
    expect(url.href).not.toContain("0.0.0.0");
  });
});
