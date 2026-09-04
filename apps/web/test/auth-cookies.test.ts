import { describe, it, expect } from "vitest";
import {
  SESSION_COOKIE,
  STATE_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  STATE_MAX_AGE_SECONDS,
  sessionCookieAttributes,
  stateCookieAttributes,
} from "../lib/auth/cookies";

describe("session cookie attributes", () => {
  it("is httpOnly and sameSite=lax", () => {
    const a = sessionCookieAttributes("https://dayzclanwars.com");
    // ⚠️ httpOnly is what stops any script on the page reading the session.
    expect(a.httpOnly).toBe(true);
    // ⚠️ lax, NOT strict: the OAuth callback is a cross-site top-level
    // navigation back from Discord, and strict drops the cookie on exactly
    // that redirect — the login would appear to succeed and then not.
    expect(a.sameSite).toBe("lax");
    expect(a.path).toBe("/");
  });

  it("is secure over https", () => {
    expect(sessionCookieAttributes("https://dayzclanwars.com").secure).toBe(true);
  });

  it("is not secure over plain-http localhost, or dev could never log in", () => {
    expect(sessionCookieAttributes("http://localhost:3000").secure).toBe(false);
  });

  it("lasts seven days", () => {
    expect(SESSION_MAX_AGE_SECONDS).toBe(60 * 60 * 24 * 7);
    expect(sessionCookieAttributes("https://x.test").maxAge).toBe(SESSION_MAX_AGE_SECONDS);
  });

  it("uses a short life for the state cookie", () => {
    expect(STATE_MAX_AGE_SECONDS).toBe(600);
    expect(stateCookieAttributes("https://x.test").maxAge).toBe(600);
  });

  it("names the cookies distinctly", () => {
    expect(SESSION_COOKIE).toBe("cw_session");
    expect(STATE_COOKIE).toBe("cw_oauth_state");
    expect(SESSION_COOKIE).not.toBe(STATE_COOKIE);
  });
});
