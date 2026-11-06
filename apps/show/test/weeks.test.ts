import { describe, it, expect } from "vitest";
import { WEEK_MS, weekWindow, episodeNumber, episodeCode, parseWeekArg, lastEndedWeek } from "../src/weeks.js";

const SEASON_1_START = new Date("2026-09-08T00:39:17Z"); // the real launch instant

describe("weeks", () => {
  it("windows a Monday as [Mon, next Mon)", () => {
    const w = weekWindow(new Date("2026-09-21T00:00:00Z"));
    expect(w.from.toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(w.to.getTime() - w.from.getTime()).toBe(WEEK_MS);
  });

  it("refuses a week start that is not a scoring week start", () => {
    expect(() => weekWindow(new Date("2026-09-22T00:00:00Z"))).toThrow(/scoring week start/);
    expect(() => weekWindow(new Date("2026-09-21T00:00:01Z"))).toThrow(/scoring week start/);
  });

  it("numbers episodes from the week the season started in (spec §2.4)", () => {
    expect(episodeNumber(SEASON_1_START, new Date("2026-09-07T00:00:00Z"))).toBe(1);
    expect(episodeNumber(SEASON_1_START, new Date("2026-09-21T00:00:00Z"))).toBe(3);
  });

  it("refuses a week before the season", () => {
    expect(() => episodeNumber(SEASON_1_START, new Date("2026-08-31T00:00:00Z"))).toThrow(/before/);
  });

  it("windows the bridging week short and the Sunday weeks after it", () => {
    expect(weekWindow(new Date("2026-11-02T00:00:00Z")).to.toISOString()).toBe("2026-11-08T14:00:00.000Z");
    const w = weekWindow(new Date("2026-11-08T14:00:00Z"));
    expect(w.to.toISOString()).toBe("2026-11-15T14:00:00.000Z");
    expect(() => weekWindow(new Date("2026-11-09T00:00:00Z"))).toThrow(/scoring week start/);
  });

  it("numbers episodes across the cutover", () => {
    expect(episodeNumber(SEASON_1_START, new Date("2026-11-02T00:00:00Z"))).toBe(9);
    expect(episodeNumber(SEASON_1_START, new Date("2026-11-08T14:00:00Z"))).toBe(10);
    expect(episodeNumber(SEASON_1_START, new Date("2026-11-15T14:00:00Z"))).toBe(11);
  });

  it("resolves --week and the last ended week after the cutover", () => {
    expect(parseWeekArg("2026-11-02").toISOString()).toBe("2026-11-02T00:00:00.000Z");
    expect(parseWeekArg("2026-11-08").toISOString()).toBe("2026-11-02T00:00:00.000Z");
    expect(parseWeekArg("2026-11-09").toISOString()).toBe("2026-11-08T14:00:00.000Z");
    expect(lastEndedWeek(new Date("2026-11-08T14:00:00Z")).toISOString()).toBe("2026-11-02T00:00:00.000Z");
    expect(lastEndedWeek(new Date("2026-11-15T13:00:00Z")).toISOString()).toBe("2026-11-02T00:00:00.000Z");
    expect(lastEndedWeek(new Date("2026-11-15T14:00:00Z")).toISOString()).toBe("2026-11-08T14:00:00.000Z");
  });

  it("formats S01E03", () => {
    expect(episodeCode(1, 3)).toBe("S01E03");
    expect(episodeCode(12, 40)).toBe("S12E40");
  });

  it("parses --week as the Monday of the week containing that date", () => {
    expect(parseWeekArg("2026-09-24").toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(() => parseWeekArg("next week")).toThrow(/YYYY-MM-DD/);
  });

  it("the last ENDED week is the one before the current week", () => {
    expect(lastEndedWeek(new Date("2026-09-25T12:00:00Z")).toISOString()).toBe("2026-09-14T00:00:00.000Z");
    expect(lastEndedWeek(new Date("2026-09-28T00:00:00Z")).toISOString()).toBe("2026-09-21T00:00:00.000Z");
  });
});
