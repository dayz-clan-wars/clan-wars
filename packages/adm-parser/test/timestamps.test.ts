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

  it("applies clock offset to returned date", () => {
    const c = new TimelineCursor(new Date("2026-07-11T12:54:21.000Z"), 4 * 60 * 60 * 1000);
    expect(c.advance("12:55:13 | x")?.toISOString()).toBe("2026-07-11T16:55:13.000Z");
  });

  it("uses default offset of 0 when omitted", () => {
    const c = new TimelineCursor(new Date("2026-07-22T07:01:37.000Z"));
    expect(c.advance("07:52:16 | x")?.toISOString()).toBe("2026-07-22T07:52:16.000Z");
  });

  it("does not roll forward when line is slightly before boot", () => {
    const c = new TimelineCursor(new Date("2026-07-22T07:01:37.000Z"));
    expect(c.advance("07:01:36 | x")?.toISOString()).toBe("2026-07-22T07:01:36.000Z");
  });

  it("does not roll forward on DST fall-back (1 hour backwards)", () => {
    const c = new TimelineCursor(new Date("2026-07-22T01:59:59.000Z"));
    expect(c.advance("01:59:59 | x")?.toISOString()).toBe("2026-07-22T01:59:59.000Z");
    expect(c.advance("01:00:00 | y")?.toISOString()).toBe("2026-07-22T01:00:00.000Z");
  });

  it("rolls forward on genuine midnight crossing", () => {
    const c = new TimelineCursor(new Date("2026-07-22T23:59:00.000Z"));
    expect(c.advance("23:59:00 | x")?.toISOString()).toBe("2026-07-22T23:59:00.000Z");
    expect(c.advance("00:01:00 | y")?.toISOString()).toBe("2026-07-23T00:01:00.000Z");
  });

  it("advances through second and third midnight", () => {
    const c = new TimelineCursor(new Date("2026-07-22T23:50:00.000Z"));
    expect(c.advance("23:50:00 | a")?.toISOString()).toBe("2026-07-22T23:50:00.000Z");
    // First midnight: 23:50:00 to 00:10:00 (backwards > 12h)
    expect(c.advance("00:10:00 | b")?.toISOString()).toBe("2026-07-23T00:10:00.000Z");
    // Later on same day
    expect(c.advance("12:00:00 | c")?.toISOString()).toBe("2026-07-23T12:00:00.000Z");
    // Second midnight: 12:00:00 to 23:55:00
    expect(c.advance("23:55:00 | d")?.toISOString()).toBe("2026-07-23T23:55:00.000Z");
    // 23:55:00 to 00:05:00 (backwards > 12h)
    expect(c.advance("00:05:00 | e")?.toISOString()).toBe("2026-07-24T00:05:00.000Z");
    // Later on same day
    expect(c.advance("12:00:00 | f")?.toISOString()).toBe("2026-07-24T12:00:00.000Z");
    // Third midnight: 12:00:00 to 23:55:00
    expect(c.advance("23:55:00 | g")?.toISOString()).toBe("2026-07-24T23:55:00.000Z");
    // 23:55:00 to 00:05:00 (backwards > 12h)
    expect(c.advance("00:05:00 | h")?.toISOString()).toBe("2026-07-25T00:05:00.000Z");
  });
});
