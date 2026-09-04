import { describe, it, expect } from "vitest";
import {
  SESSION_COOKIE,
  STATE_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  STATE_MAX_AGE_SECONDS,
  sessionCookieAttributes,
  stateCookieAttributes,
  remainingSessionSeconds,
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

  // ⚠️ The override exists so a re-issued cookie (middleware's 15-minute
  // recheck) can carry the REMAINING life of the original 7-day session,
  // rather than resetting to a full 7 days on every re-issue.
  it("accepts a maxAge override for a re-issued cookie", () => {
    expect(sessionCookieAttributes("https://x.test", 120).maxAge).toBe(120);
  });

  it("falls back to the full seven days with no override", () => {
    expect(sessionCookieAttributes("https://x.test").maxAge).toBe(SESSION_MAX_AGE_SECONDS);
  });
});

describe("remainingSessionSeconds", () => {
  const now = 1_800_000_000;

  it("is the full session length right after login", () => {
    expect(remainingSessionSeconds(now, now)).toBe(SESSION_MAX_AGE_SECONDS);
  });

  it("shrinks as the session ages", () => {
    const threeDaysIn = now - 3 * 24 * 60 * 60;
    expect(remainingSessionSeconds(threeDaysIn, now)).toBe(SESSION_MAX_AGE_SECONDS - 3 * 24 * 60 * 60);
  });

  // ⚠️ Floored at 0. decodeSession already refuses a token past its exp, so
  // this should never see an authAt this old, but a negative maxAge is a real
  // footgun (browsers disagree on what it means) and costs nothing to rule out.
  it("floors at zero rather than going negative", () => {
    const wayPast = now - 30 * 24 * 60 * 60;
    expect(remainingSessionSeconds(wayPast, now)).toBe(0);
  });
});
