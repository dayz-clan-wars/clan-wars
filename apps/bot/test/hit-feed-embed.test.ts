import { describe, it, expect } from "vitest";
import { hitFeedEmbed, type HitFeedItem } from "../src/hit-feed-embed.js";

const site = "https://dayzclanwars.com";
const base: HitFeedItem = {
  eventId: 7, occurredAt: new Date("2026-09-12T01:00:41Z"), startedAt: new Date("2026-09-12T01:00:00Z"),
  attacker: { gamertag: "Steve", tag: "WOLF", texture: null },
  victim: { gamertag: "Dave", tag: "BEAR", texture: null },
  weapon: "KA-74", friendlyFire: false, suppressed: false,
  hits: [
    { damage: 38, bodyPart: "Torso", weapon: "KA-74", distanceM: 41 },
    { damage: 38, bodyPart: "Head", weapon: "KA-74", distanceM: 39 },
  ],
  totalDamage: 76, victimHpAfter: 12,
};

describe("hitFeedEmbed", () => {
  it("titles on the attacker and their tag, and links to the profile", () => {
    const e = hitFeedEmbed(base, site);
    expect(e.title).toBe("Steve [WOLF]");
    expect(e.url).toBe("https://dayzclanwars.com/players/Steve");
  });

  it("names the victim, the count and the weapon", () => {
    const e = hitFeedEmbed(base, site);
    expect(e.description).toContain("hit **[Dave](https://dayzclanwars.com/players/Dave)** [BEAR] 2 times");
    expect(e.description).toContain("KA-74");
  });

  it("says 'once' rather than '1 times'", () => {
    const e = hitFeedEmbed({ ...base, hits: [base.hits[0]!], totalDamage: 38 }, site);
    expect(e.description).toContain("once");
    expect(e.description).not.toContain("1 times");
  });

  it("totals the damage and reports the HP they were left at", () => {
    const e = hitFeedEmbed(base, site);
    expect(e.description).toContain("76 damage");
    expect(e.description).toContain("left them at 12 HP");
  });

  it("omits the HP clause when the log did not give one", () => {
    const e = hitFeedEmbed({ ...base, victimHpAfter: null }, site);
    expect(e.description).not.toContain("HP");
  });

  it("renders a detail line per hit, WITHOUT the weapon — the header already named it", () => {
    const e = hitFeedEmbed(base, site);
    expect(e.description).toContain("38 dmg · Torso · 41 m");
    expect(e.description).not.toContain("Torso · KA-74");
  });

  it("caps the detail lines at ten", () => {
    const hits = Array.from({ length: 14 }, () => ({ damage: 10, bodyPart: "Torso", weapon: "KA-74", distanceM: 40 }));
    const e = hitFeedEmbed({ ...base, hits, totalDamage: 140 }, site);
    expect(e.description).toContain("… and 4 more");
  });

  it("says friendly fire in the title and colours it amber", () => {
    const e = hitFeedEmbed({ ...base, friendlyFire: true }, site);
    expect(e.title).toContain("Friendly fire");
    expect(e.color).toBe(0xe67e22);
  });

  it("⚠️ colours an ordinary engagement duller than the kill feed's rust, so the two channels read apart at a glance", () => {
    expect(hitFeedEmbed(base, site).color).toBe(0x8c5a3c);
  });

  it("⚠️ timestamps the last hit, not the post — a delayed post still reads as when it happened", () => {
    const e = hitFeedEmbed(base, site);
    expect(e.timestamp).toBe("2026-09-12T01:00:41.000Z");
  });

  it("escapes markdown in gamertags in the DESCRIPTION, where markdown renders", () => {
    const e = hitFeedEmbed({ ...base, victim: { gamertag: "D_ave", tag: null, texture: null } }, site);
    expect(e.description).toContain("D\\_ave");
  });

  it("⚠️ leaves the gamertag RAW in the title — Discord renders no markdown there, so an escape would be displayed", () => {
    const e = hitFeedEmbed({ ...base, attacker: { gamertag: "x_Dave_x", tag: null, texture: null } }, site);
    expect(e.title).toBe("x_Dave_x");
  });

  it("uses the attacker's flag as the thumbnail when there is one", () => {
    const e = hitFeedEmbed({ ...base, attacker: { ...base.attacker, texture: "wolf" } }, site, (t) => `https://cdn/${t}.png`);
    expect(e.thumbnail).toEqual({ url: "https://cdn/wolf.png" });
  });

  it("a missing weapon simply drops out of the line", () => {
    const e = hitFeedEmbed({ ...base, weapon: null }, site);
    expect(e.description).not.toContain("null");
  });
});
