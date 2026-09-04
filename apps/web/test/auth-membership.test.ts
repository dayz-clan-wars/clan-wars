import { describe, it, expect } from "vitest";
import {
  outcomeForStatus,
  nextCheckAfter,
  RECHECK_OK_SECONDS,
  RECHECK_BACKOFF_SECONDS,
} from "../lib/auth/membership";

describe("outcomeForStatus", () => {
  it("200 is a member", () => {
    expect(outcomeForStatus(200)).toBe("member");
  });

  it("404 is not a member", () => {
    expect(outcomeForStatus(404)).toBe("notMember");
  });

  // ⚠️ Everything below is "unknown", and unknown NEVER logs anyone out.
  // Spec §2.7: a Discord outage must not become a site outage.
  it("rate limiting is unknown, not a refusal", () => {
    expect(outcomeForStatus(429)).toBe("unknown");
  });

  it("server errors are unknown", () => {
    for (const s of [500, 502, 503, 504]) expect(outcomeForStatus(s)).toBe("unknown");
  });

  it("a network error is unknown", () => {
    expect(outcomeForStatus("network-error")).toBe("unknown");
  });

  // ⚠️ 401/403 mean OUR bot token is wrong or lost its access — our fault, not
  // the player's. Treating them as notMember would log out every player at
  // once the moment someone edited the bot's role.
  it("auth failures against our own bot token are unknown, not notMember", () => {
    expect(outcomeForStatus(401)).toBe("unknown");
    expect(outcomeForStatus(403)).toBe("unknown");
  });
});

describe("nextCheckAfter", () => {
  const now = 1_800_000_000;

  it("waits the full cadence after a definite answer", () => {
    expect(nextCheckAfter("member", now)).toBe(now + RECHECK_OK_SECONDS);
    expect(nextCheckAfter("notMember", now)).toBe(now + RECHECK_OK_SECONDS);
    expect(RECHECK_OK_SECONDS).toBe(900);
  });

  // ⚠️ Backs off rather than leaving the session stale. If a failure left
  // nextCheckAt in the past, every subsequent request would retry and we would
  // hammer a Discord that is already struggling.
  it("backs off briefly after an unknown", () => {
    expect(nextCheckAfter("unknown", now)).toBe(now + RECHECK_BACKOFF_SECONDS);
    expect(RECHECK_BACKOFF_SECONDS).toBe(60);
  });

  it("always moves the check forward", () => {
    for (const o of ["member", "notMember", "unknown"] as const) {
      expect(nextCheckAfter(o, now)).toBeGreaterThan(now);
    }
  });
});
