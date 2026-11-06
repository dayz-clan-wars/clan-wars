import { describe, expect, it } from "vitest";
import { previousScoringWeek, scoringWeekEnd, scoringWeekStartOf } from "../src/scoring-week";

const d = (s: string) => new Date(s);
const iso = (x: Date) => x.toISOString();

describe("scoringWeekStartOf", () => {
  it("is the Monday before the cutover", () => {
    expect(iso(scoringWeekStartOf(d("2026-10-28T12:00Z")))).toBe("2026-10-26T00:00:00.000Z");
    expect(iso(scoringWeekStartOf(d("2026-11-08T13:59:59Z")))).toBe("2026-11-02T00:00:00.000Z");
  });
  it("is Sunday 14:00 from the cutover", () => {
    expect(iso(scoringWeekStartOf(d("2026-11-08T14:00Z")))).toBe("2026-11-08T14:00:00.000Z");
    expect(iso(scoringWeekStartOf(d("2026-11-15T13:00Z")))).toBe("2026-11-08T14:00:00.000Z");
    expect(iso(scoringWeekStartOf(d("2026-11-15T14:00Z")))).toBe("2026-11-15T14:00:00.000Z");
    expect(iso(scoringWeekStartOf(d("2026-11-11T03:00Z")))).toBe("2026-11-08T14:00:00.000Z");
  });
});

describe("scoringWeekEnd", () => {
  it("cuts the bridging week short at the cutover", () => {
    expect(iso(scoringWeekEnd(d("2026-10-26T00:00Z")))).toBe("2026-11-02T00:00:00.000Z");
    expect(iso(scoringWeekEnd(d("2026-11-02T00:00Z")))).toBe("2026-11-08T14:00:00.000Z");
    expect(iso(scoringWeekEnd(d("2026-11-08T14:00Z")))).toBe("2026-11-15T14:00:00.000Z");
  });
  it("walks across the cutover without skipping a week", () => {
    const seen: string[] = [];
    let w = d("2026-10-12T00:00Z");
    for (let i = 0; i < 6; i++) { seen.push(iso(w)); w = scoringWeekEnd(w); }
    expect(seen).toEqual(["2026-10-12T00:00:00.000Z", "2026-10-19T00:00:00.000Z", "2026-10-26T00:00:00.000Z", "2026-11-02T00:00:00.000Z", "2026-11-08T14:00:00.000Z", "2026-11-15T14:00:00.000Z"]);
  });
});

describe("previousScoringWeek", () => {
  it("steps back over the cutover", () => {
    expect(iso(previousScoringWeek(d("2026-11-08T14:00Z")))).toBe("2026-11-02T00:00:00.000Z");
    expect(iso(previousScoringWeek(d("2026-11-15T14:00Z")))).toBe("2026-11-08T14:00:00.000Z");
    expect(iso(previousScoringWeek(d("2026-11-02T00:00Z")))).toBe("2026-10-26T00:00:00.000Z");
  });
});
