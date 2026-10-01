import { describe, it, expect } from "vitest";
import { LIVE_FEEDS, LIVE_ENTRY_KINDS, LIVE_FEED_KIND, isLiveFeed, LIVE_PAGE_SIZE } from "../src/index";

describe("live feeds", () => {
  it("names the nine Discord feeds in tab order", () => {
    expect([...LIVE_FEEDS]).toEqual(["online", "kills", "hits", "streaks", "long-range", "clans", "war-log", "achievements", "bans"]);
  });
  it("maps every combat tab to a stored kind", () => {
    expect(Object.values(LIVE_FEED_KIND).sort()).toEqual([...LIVE_ENTRY_KINDS].sort());
  });
  it("accepts only known slugs", () => {
    expect(isLiveFeed("kills")).toBe(true);
    expect(isLiveFeed("constructor")).toBe(false);
    expect(isLiveFeed("")).toBe(false);
  });
  it("pages by 50", () => expect(LIVE_PAGE_SIZE).toBe(50));
});
