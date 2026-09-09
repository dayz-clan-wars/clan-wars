import { describe, it, expect } from "vitest";
import { BOARD_KINDS } from "@factions/roster";
import { BOARD_SLUGS, BOARD_TOP, boardKindFromSlug, parsePageParam, seasonQuery } from "../lib/board-page";

describe("board pages", () => {
  it("shows ten rows on a panel", () => {
    expect(BOARD_TOP).toBe(10);
  });

  it("every board has a distinct kebab-case slug that maps back to it", () => {
    const slugs = BOARD_KINDS.map((k) => BOARD_SLUGS[k]);
    expect(new Set(slugs).size).toBe(BOARD_KINDS.length);
    for (const k of BOARD_KINDS) {
      expect(BOARD_SLUGS[k]).toMatch(/^[a-z]+(-[a-z]+)*$/u);
      expect(boardKindFromSlug(BOARD_SLUGS[k])).toBe(k);
    }
    expect(BOARD_SLUGS.playTime).toBe("play-time");
    expect(BOARD_SLUGS.longestKills).toBe("longest-kills");
  });

  it("an unknown slug is null, never a guess", () => {
    expect(boardKindFromSlug("playTime")).toBeNull();
    expect(boardKindFromSlug("")).toBeNull();
    expect(boardKindFromSlug("__proto__")).toBeNull();
    expect(boardKindFromSlug("constructor")).toBeNull();
  });

  it("parses ?page= as a positive integer, else page 1", () => {
    expect(parsePageParam("3")).toBe(3);
    expect(parsePageParam("1")).toBe(1);
    expect(parsePageParam(undefined)).toBe(1);
    expect(parsePageParam("0")).toBe(1);
    expect(parsePageParam("-2")).toBe(1);
    expect(parsePageParam("1.5")).toBe(1);
    expect(parsePageParam("abc")).toBe(1);
    expect(parsePageParam("")).toBe(1);
    expect(parsePageParam(["2", "3"])).toBe(1);
    expect(parsePageParam("9999999")).toBe(1);
  });

  it("writes a scope back as a season query", () => {
    expect(seasonQuery({ kind: "all" })).toBe("season=all");
    expect(seasonQuery({ kind: "season", number: 2 })).toBe("season=2");
  });
});
