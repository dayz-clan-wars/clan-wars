import { describe, it, expect } from "vitest";
import { killstreakFeedEmbed, type KillstreakFeedItem } from "../src/killstreak-feed-embed.js";

const site = "https://dayzclanwars.com";
const base: KillstreakFeedItem = {
  eventId: 9, occurredAt: new Date("2026-09-12T01:41:00Z"), startedAt: new Date("2026-09-12T01:00:00Z"),
  killer: { gamertag: "Steve", tag: "WOLF", texture: null },
  streak: 6, victims: ["Dave", "Rob", "Amy", "Jen", "Kai", "Mo"],
};

describe("killstreakFeedEmbed", () => {
  it("leads with the number", () => {
    const e = killstreakFeedEmbed(base, site);
    expect(e.title).toBe("Steve [WOLF]");
    expect(e.description).toContain("6 kill streak");
  });

  it("lists the victims oldest first", () => {
    const e = killstreakFeedEmbed(base, site);
    expect(e.description).toContain("last 6: Dave, Rob, Amy, Jen, Kai, Mo");
  });

  it("caps a long victim list", () => {
    const victims = Array.from({ length: 15 }, (_, n) => `V${n}`);
    const e = killstreakFeedEmbed({ ...base, streak: 15, victims }, site);
    expect(e.description).toContain("… and 5 more");
  });

  it("says how long the streak has been running, from the kill times", () => {
    const e = killstreakFeedEmbed(base, site);
    expect(e.description).toContain("started 41 minutes ago");
  });

  it("⚠️ timestamps the kill, not the post", () => {
    expect(killstreakFeedEmbed(base, site).timestamp).toBe("2026-09-12T01:41:00.000Z");
  });

  it("⚠️ escapes names in the description, but leaves the title's gamertag RAW — Discord renders no markdown in a title, so an escape there would be displayed", () => {
    const e = killstreakFeedEmbed({ ...base, killer: { gamertag: "x_Dave_x", tag: null, texture: null }, victims: ["D_ave"] }, site);
    expect(e.title).toBe("x_Dave_x");
    expect(e.description).toContain("D\\_ave");
  });

  // "started ... ago" boundaries — pins the unit escalating BEFORE rounding
  // can push it into the next unit (e.g. 3599s must not read "60 minutes").
  describe("elapsed-time boundaries", () => {
    const withDelta = (seconds: number): KillstreakFeedItem => ({
      ...base,
      startedAt: new Date(0),
      occurredAt: new Date(seconds * 1000),
    });

    it("59s stays in seconds — one below the minute boundary", () => {
      const e = killstreakFeedEmbed(withDelta(59), site);
      expect(e.description).toContain("started 59 seconds ago");
    });

    it("60s crosses into minutes exactly at the boundary", () => {
      const e = killstreakFeedEmbed(withDelta(60), site);
      expect(e.description).toContain("started 1 minute ago");
    });

    it("3599s escalates to hours instead of rounding to 60 minutes", () => {
      const e = killstreakFeedEmbed(withDelta(3599), site);
      expect(e.description).toContain("started 1 hour ago");
    });

    it("3600s crosses into hours exactly at the boundary", () => {
      const e = killstreakFeedEmbed(withDelta(3600), site);
      expect(e.description).toContain("started 1 hour ago");
    });
  });
});
