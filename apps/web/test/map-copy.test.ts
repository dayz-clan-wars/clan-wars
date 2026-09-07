import { describe, it, expect } from "vitest";
import { PIN_ICONS } from "@factions/domain";
import { LAYER_LABELS, PIN_ICON_LABELS, PIN_ICON_GLYPHS, RESULT_COPY, DIM_AFTER_MS, fixAge } from "../lib/map-copy";

/**
 * ⚠️ A refusal with no copy renders as a blank notice: the redirect carries
 * `?result=<reason>`, `lookupCopy` misses, and the player is told nothing
 * about why their pin did not land. The reason union is listed here as
 * literals on purpose — a type-level `satisfies` would be erased by the time
 * the query string exists, so the list is the pin.
 */
const DROP_PIN_REFUSALS = ["not-linked", "not-in-clan", "pending", "bad-icon", "bad-note", "off-map"] as const;

describe("the pin icons all have words and a glyph", () => {
  it.each(PIN_ICONS)("%s has a label and a glyph", (icon) => {
    expect(PIN_ICON_LABELS[icon]).toBeTruthy();
    expect(PIN_ICON_GLYPHS[icon]).toBeTruthy();
  });

  it("has exactly six of each — no orphan entry either way", () => {
    expect(Object.keys(PIN_ICON_LABELS).sort()).toEqual([...PIN_ICONS].sort());
    expect(Object.keys(PIN_ICON_GLYPHS).sort()).toEqual([...PIN_ICONS].sort());
  });
});

describe("RESULT_COPY", () => {
  it.each(DROP_PIN_REFUSALS)("has a line for the %s refusal", (reason) => {
    expect(Object.hasOwn(RESULT_COPY, reason)).toBe(true);
    expect(RESULT_COPY[reason]).toBeTruthy();
  });

  it("has a line for both successes and for a delete that did nothing", () => {
    for (const key of ["dropped", "deleted", "not-deleted"]) {
      expect(Object.hasOwn(RESULT_COPY, key)).toBe(true);
    }
  });

  it("says clan, never faction", () => {
    expect(Object.values(RESULT_COPY).join(" ")).not.toMatch(/faction/iu);
  });
});

describe("the layer labels name every switch the map can draw", () => {
  it("covers the eight layers", () => {
    expect(Object.keys(LAYER_LABELS).sort()).toEqual(
      ["base", "clanmates", "intruders", "pins", "publicBases", "terrain", "travel", "you"],
    );
  });
});

describe("fixAge", () => {
  const now = new Date("2026-09-06T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("says just now inside the first minute", () => {
    expect(fixAge(now, now)).toBe("just now");
    expect(fixAge(ago(20_000), now)).toBe("just now");
  });

  it("counts minutes, then hours, then days", () => {
    expect(fixAge(ago(14 * 60_000), now)).toBe("14 min ago");
    expect(fixAge(ago(3 * 3600_000), now)).toBe("3 h ago");
    expect(fixAge(ago(25 * 3600_000), now)).toBe("yesterday");
    expect(fixAge(ago(6 * 24 * 3600_000), now)).toBe("6 d ago");
  });

  it("never leaks a coordinate — an age is all it can say", () => {
    expect(fixAge(ago(90 * 60_000), now)).toMatch(/^[\d.]+ h ago$/u);
  });
});

describe("DIM_AFTER_MS", () => {
  it("is a day — past that a dot is dimmed (guide ch. 10)", () => {
    expect(DIM_AFTER_MS).toBe(24 * 3600_000);
  });
});
