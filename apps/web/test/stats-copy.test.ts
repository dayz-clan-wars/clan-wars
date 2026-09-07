import { describe, it, expect } from "vitest";
import { KD_MIN_KILLS } from "@factions/domain";
import { BOARD_LABELS, KD_NOTE, EMPTY_BOARD, NO_PROFILE, playTime, scopeLabel } from "../lib/stats-copy";

describe("BOARD_LABELS", () => {
  it("names all five boards", () => {
    expect(BOARD_LABELS).toEqual({
      raiders: "Top raiders",
      killers: "Top killers",
      kd: "Best K/D",
      playTime: "Most play time",
      friendlyFire: "Most friendly fire",
    });
  });
});

describe("KD_NOTE", () => {
  it("names the kill floor", () => {
    expect(KD_NOTE).toBe(`K/D needs ${KD_MIN_KILLS} kills`);
  });
});

it("EMPTY_BOARD", () => {
  expect(EMPTY_BOARD).toBe("Nothing yet.");
});

it("NO_PROFILE", () => {
  expect(NO_PROFILE).toBe("No player by that name.");
});

describe("playTime", () => {
  it("formats hours and zero-padded minutes", () => {
    expect(playTime(43_500)).toBe("12h 05m");
  });
  it("formats zero", () => {
    expect(playTime(0)).toBe("0h 00m");
  });
  it("formats under an hour", () => {
    expect(playTime(65)).toBe("0h 01m");
  });
});

describe("scopeLabel", () => {
  it("labels all-time", () => {
    expect(scopeLabel({ kind: "all" })).toBe("All-time");
  });
  it("labels a season", () => {
    expect(scopeLabel({ kind: "season", number: 3 })).toBe("Season 3");
  });
});
