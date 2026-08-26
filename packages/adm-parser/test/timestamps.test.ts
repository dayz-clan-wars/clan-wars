import { describe, it, expect } from "vitest";
import { parseBootHeader, parseLocalTime, TimelineCursor } from "../src/index.js";

describe("parseBootHeader", () => {
  it("reads the AdminLog boot line as UTC", () => {
    const d = parseBootHeader("AdminLog started on 2026-07-22 at 07:01:37");
    expect(d?.toISOString()).toBe("2026-07-22T07:01:37.000Z");
  });
  it("returns null on a normal line", () => {
    expect(parseBootHeader('Player "A" (id=AB) is connected')).toBeNull();
  });
});

describe("parseLocalTime", () => {
  it("reads the leading HH:MM:SS field", () => {
    expect(parseLocalTime("07:52:16 | Player \"A\" (id=AB) is connected")).toEqual({ h: 7, m: 52, s: 16 });
  });
  it("returns null when there is no time field", () => {
    expect(parseLocalTime("##### PlayerList log: 2 players")).toBeNull();
  });
});

describe("TimelineCursor", () => {
  it("resolves a line on the boot date", () => {
    const c = new TimelineCursor(new Date("2026-07-22T07:01:37.000Z"));
    expect(c.advance("07:52:16 | x")?.toISOString()).toBe("2026-07-22T07:52:16.000Z");
  });

  it("rolls forward one day when the clock wraps past midnight", () => {
    const c = new TimelineCursor(new Date("2026-07-22T23:58:00.000Z"));
    expect(c.advance("23:59:00 | x")?.toISOString()).toBe("2026-07-22T23:59:00.000Z");
    expect(c.advance("00:01:00 | x")?.toISOString()).toBe("2026-07-23T00:01:00.000Z");
  });

  it("does not roll forward on equal timestamps", () => {
    const c = new TimelineCursor(new Date("2026-07-22T10:00:00.000Z"));
    c.advance("10:00:00 | x");
    expect(c.advance("10:00:00 | y")?.toISOString()).toBe("2026-07-22T10:00:00.000Z");
  });

  it("returns null for a line with no time field", () => {
    const c = new TimelineCursor(new Date("2026-07-22T07:01:37.000Z"));
    expect(c.advance("##### PlayerList log: 2 players")).toBeNull();
  });
});
