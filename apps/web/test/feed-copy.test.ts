import { describe, it, expect } from "vitest";
import { FEED_KIND, DEATH_CAUSE, EMPTY_FEED, FEED_TITLE, FRIENDLY_FIRE_MARK, deathCause, steps, shot } from "../lib/feed-copy";

describe("feed copy", () => {
  it("names every kind", () => {
    expect(Object.fromEntries(Object.entries(FEED_KIND).map(([k, v]) => [k, v.label]))).toEqual({
      kill: "Kill", death: "Death", raid: "Raid", raised: "Colours", built: "Building", dismantled: "Dismantle",
    });
  });
  it("strings", () => {
    expect(EMPTY_FEED).toBe("Nothing in the log for this scope.");
    expect(FEED_TITLE).toBe("Feed");
    expect(FRIENDLY_FIRE_MARK).toBe("friendly fire");
  });
  it("covers every cause the adm parser can name", () => {
    for (const c of ["bled_out", "drowned", "suicide", "infected", "animal", "fall", "vehicle", "environment", "died"]) expect(c in DEATH_CAUSE, c).toBe(true);
  });
  it("death causes read as a phrase, unknown ones as the log wrote them", () => {
    expect(deathCause("infected")).toBe("to the infected");
    expect(deathCause("pvp")).toBe("by their own hand");
    expect(deathCause("died")).toBe("");
    expect(deathCause("environment")).toBe("to the environment");
    expect(deathCause("bled_out")).toBe("bled out");
    expect(deathCause("radiation")).toBe("radiation");
    expect(deathCause(null)).toBe("");
  });
  it("steps and shots", () => {
    expect(steps(1, "built")).toBe("Built 1 step");
    expect(steps(14, "dismantled")).toBe("Dismantled 14 steps");
    expect(shot(193.6, "DMR")).toBe("193.6 m · DMR");
    expect(shot(null, "DMR")).toBe("DMR");
    expect(shot(50, null)).toBe("50 m");
    expect(shot(null, null)).toBe("");
  });
});
