import { describe, it, expect } from "vitest";
import { parseBootHeader, parseLocalTime, TimelineCursor, isValidTimeZone, zoneClockOffsetMs } from "../src/index.js";

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
    const c = new TimelineCursor(new Date("2026-07-22T07:01:37.000Z"), { kind: "offset", offsetMs: 0 });
    expect(c.advance("07:52:16 | x")?.toISOString()).toBe("2026-07-22T07:52:16.000Z");
  });

  it("rolls forward one day when the clock wraps past midnight", () => {
    const c = new TimelineCursor(new Date("2026-07-22T23:58:00.000Z"), { kind: "offset", offsetMs: 0 });
    expect(c.advance("23:59:00 | x")?.toISOString()).toBe("2026-07-22T23:59:00.000Z");
    expect(c.advance("00:01:00 | x")?.toISOString()).toBe("2026-07-23T00:01:00.000Z");
  });

  it("does not roll forward on equal timestamps", () => {
    const c = new TimelineCursor(new Date("2026-07-22T10:00:00.000Z"), { kind: "offset", offsetMs: 0 });
    c.advance("10:00:00 | x");
    expect(c.advance("10:00:00 | y")?.toISOString()).toBe("2026-07-22T10:00:00.000Z");
  });

  it("returns null for a line with no time field", () => {
    const c = new TimelineCursor(new Date("2026-07-22T07:01:37.000Z"), { kind: "offset", offsetMs: 0 });
    expect(c.advance("##### PlayerList log: 2 players")).toBeNull();
  });

  it("applies clock offset to returned date", () => {
    const c = new TimelineCursor(new Date("2026-07-11T12:54:21.000Z"), { kind: "offset", offsetMs: 4 * 60 * 60 * 1000 });
    expect(c.advance("12:55:13 | x")?.toISOString()).toBe("2026-07-11T16:55:13.000Z");
  });

  it("does not roll forward when line is slightly before boot", () => {
    const c = new TimelineCursor(new Date("2026-07-22T07:01:37.000Z"), { kind: "offset", offsetMs: 0 });
    expect(c.advance("07:01:36 | x")?.toISOString()).toBe("2026-07-22T07:01:36.000Z");
  });

  it("does not roll forward on DST fall-back (1 hour backwards)", () => {
    const c = new TimelineCursor(new Date("2026-07-22T01:59:59.000Z"), { kind: "offset", offsetMs: 0 });
    expect(c.advance("01:59:59 | x")?.toISOString()).toBe("2026-07-22T01:59:59.000Z");
    expect(c.advance("01:00:00 | y")?.toISOString()).toBe("2026-07-22T01:00:00.000Z");
  });

  it("rolls forward on genuine midnight crossing", () => {
    const c = new TimelineCursor(new Date("2026-07-22T23:59:00.000Z"), { kind: "offset", offsetMs: 0 });
    expect(c.advance("23:59:00 | x")?.toISOString()).toBe("2026-07-22T23:59:00.000Z");
    expect(c.advance("00:01:00 | y")?.toISOString()).toBe("2026-07-23T00:01:00.000Z");
  });

  it("advances through second and third midnight", () => {
    const c = new TimelineCursor(new Date("2026-07-22T23:50:00.000Z"), { kind: "offset", offsetMs: 0 });
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

describe("TimelineCursor in a zone (America/Los_Angeles)", () => {
  const LA = { kind: "zone", timeZone: "America/Los_Angeles" } as const;
  /** The boot header's components, wearing a UTC label as parseBootHeader builds them. */
  const boot = (local: string) => new Date(`${local}Z`);
  const iso = (c: TimelineCursor, time: string) => c.advance(`${time} | x`)?.toISOString();

  it("converts summer time at UTC-7 and winter time at UTC-8", () => {
    expect(iso(new TimelineCursor(boot("2026-07-22T10:00:00"), LA), "10:00:00")).toBe("2026-07-22T17:00:00.000Z");
    expect(iso(new TimelineCursor(boot("2026-12-22T10:00:00"), LA), "10:00:00")).toBe("2026-12-22T18:00:00.000Z");
  });

  it("walks the fall-back: the repeated hour first as PDT, then as PST once the clock steps back", () => {
    // 2026-11-01: 01:59:59 PDT (08:59:59Z) is followed by 01:00:00 PST (09:00:00Z).
    const c = new TimelineCursor(boot("2026-11-01T00:30:00"), LA);
    expect(iso(c, "00:30:00")).toBe("2026-11-01T07:30:00.000Z");
    expect(iso(c, "01:00:00")).toBe("2026-11-01T08:00:00.000Z"); // first pass, PDT
    expect(iso(c, "01:30:00")).toBe("2026-11-01T08:30:00.000Z");
    expect(iso(c, "01:59:59")).toBe("2026-11-01T08:59:59.000Z");
    expect(iso(c, "01:00:00")).toBe("2026-11-01T09:00:00.000Z"); // stepped back: PST
    expect(iso(c, "01:30:00")).toBe("2026-11-01T09:30:00.000Z"); // stays on the second pass
    expect(iso(c, "01:59:59")).toBe("2026-11-01T09:59:59.000Z");
    expect(iso(c, "02:00:00")).toBe("2026-11-01T10:00:00.000Z");
  });

  it("keeps a jittered line in the repeated hour on the pass it is on", () => {
    const c = new TimelineCursor(boot("2026-11-01T01:30:00"), LA);
    expect(iso(c, "01:30:05")).toBe("2026-11-01T08:30:05.000Z");
    // Seconds behind is write-order jitter, not the fall-back.
    expect(iso(c, "01:30:04")).toBe("2026-11-01T08:30:04.000Z");
    expect(iso(c, "01:59:58")).toBe("2026-11-01T08:59:58.000Z");
    expect(iso(c, "01:00:02")).toBe("2026-11-01T09:00:02.000Z");
    // Jitter on the second pass must not drop back to the first.
    expect(iso(c, "01:00:01")).toBe("2026-11-01T09:00:01.000Z");
  });

  it("takes the first pass for a file that boots inside the repeated hour", () => {
    const c = new TimelineCursor(boot("2026-11-01T01:15:00"), LA);
    expect(iso(c, "01:15:00")).toBe("2026-11-01T08:15:00.000Z");
  });

  it("walks the spring-forward", () => {
    // 2026-03-08: 01:59:59 PST (09:59:59Z), then the wall clock jumps to 03:00:00 PDT (10:00:00Z).
    const c = new TimelineCursor(boot("2026-03-08T01:00:00"), LA);
    expect(iso(c, "01:59:59")).toBe("2026-03-08T09:59:59.000Z");
    expect(iso(c, "03:00:00")).toBe("2026-03-08T10:00:00.000Z");
    expect(iso(c, "03:30:00")).toBe("2026-03-08T10:30:00.000Z");
  });

  it("reads a wall time in the spring-forward gap as still on standard time", () => {
    // 02:30 never happens on 2026-03-08 in Pacific time. A clock that wrote it
    // has not stepped yet, so it means 02:30 PST.
    const c = new TimelineCursor(boot("2026-03-08T02:30:00"), LA);
    expect(iso(c, "02:30:00")).toBe("2026-03-08T10:30:00.000Z");
  });

  it("rolls past local midnight within the zone", () => {
    const c = new TimelineCursor(boot("2026-11-04T23:50:00"), LA);
    expect(iso(c, "23:59:59")).toBe("2026-11-05T07:59:59.000Z");
    expect(iso(c, "00:00:01")).toBe("2026-11-05T08:00:01.000Z");
    expect(iso(c, "06:00:00")).toBe("2026-11-05T14:00:00.000Z");
  });

  it("rolls past the midnight that opens the fall-back day", () => {
    const c = new TimelineCursor(boot("2026-10-31T23:30:00"), LA);
    expect(iso(c, "23:30:00")).toBe("2026-11-01T06:30:00.000Z");
    expect(iso(c, "00:30:00")).toBe("2026-11-01T07:30:00.000Z");
  });

  it("refuses a zone it cannot convert in, rather than guessing", () => {
    expect(() => new TimelineCursor(boot("2026-07-22T10:00:00"), { kind: "zone", timeZone: "America/Los_Angles" }))
      .toThrow(/unknown time zone/);
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA names", () => {
    expect(isValidTimeZone("America/Los_Angeles")).toBe(true);
    expect(isValidTimeZone("Europe/Moscow")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });
  it("refuses typos, blanks and bare offsets", () => {
    expect(isValidTimeZone("America/Los_Angles")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("+04:00")).toBe(false);
  });
});

describe("zoneClockOffsetMs", () => {
  it("is the fixed offset that zone needs at that instant (UTC = local + offset)", () => {
    expect(zoneClockOffsetMs("America/Los_Angeles", new Date("2026-11-01T08:59:59Z"))).toBe(7 * 3_600_000);
    expect(zoneClockOffsetMs("America/Los_Angeles", new Date("2026-11-01T09:00:00Z"))).toBe(8 * 3_600_000);
  });
});
