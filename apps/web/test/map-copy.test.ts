import { describe, it, expect } from "vitest";
import { PIN_ICONS } from "@factions/domain";
import { LAYER_LABELS, PIN_ICON_LABELS, RESULT_COPY, DIM_AFTER_MS, expiresIn, fixAge } from "../lib/map-copy";
import { AGE_OPACITY, PIN_GLYPHS, ageStep, pinGlyph, pinIcon, type Palette } from "../lib/map-icons";

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
    expect(PIN_GLYPHS[icon]).toMatch(/<path /u);
  });

  it("has exactly six of each — no orphan entry either way", () => {
    expect(Object.keys(PIN_ICON_LABELS).sort()).toEqual([...PIN_ICONS].sort());
    expect(Object.keys(PIN_GLYPHS).sort()).toEqual([...PIN_ICONS].sort());
  });

  const p: Palette = { gold: "GOLD", ink: "INK", ink2: "INK2", rust: "RUST", olive: "OLIVE", frame: "FRAME", rule2: "RULE2" };

  it("fills every placeholder — no {a}, {f} or {i} reaches the map", () => {
    for (const icon of PIN_ICONS) {
      expect(pinIcon(p, icon)).not.toMatch(/\{[afi]\}/u);
      expect(pinGlyph(p, icon)).not.toMatch(/\{[afi]\}/u);
    }
  });

  it("is a gold glyph on a black chip, except danger, which is the one rust pin", () => {
    expect(pinIcon(p, "loot")).toContain('stroke="GOLD"');
    expect(pinIcon(p, "loot")).toContain('fill="FRAME"');
    expect(pinIcon(p, "danger")).toContain('stroke="RUST"');
    expect(pinIcon(p, "danger")).not.toContain("GOLD");
  });
});

describe("ageStep", () => {
  it("is three steps, and stale never drops below 55%", () => {
    expect(ageStep(0, DIM_AFTER_MS)).toBe("fresh");
    expect(ageStep(59 * 60_000, DIM_AFTER_MS)).toBe("fresh");
    expect(ageStep(2 * 3600_000, DIM_AFTER_MS)).toBe("today");
    expect(ageStep(DIM_AFTER_MS + 1, DIM_AFTER_MS)).toBe("stale");
    expect(AGE_OPACITY.stale).toBeGreaterThanOrEqual(0.55);
  });
});

describe("expiresIn", () => {
  const now = new Date("2026-09-06T12:00:00Z");
  const ahead = (ms: number) => new Date(now.getTime() + ms);

  it("counts minutes, hours, then days, and says expiring at the end", () => {
    expect(expiresIn(ahead(20 * 60_000), now)).toBe("expires in 20 min");
    expect(expiresIn(ahead(3 * 3600_000), now)).toBe("expires in 3 h");
    expect(expiresIn(ahead(6 * 24 * 3600_000), now)).toBe("expires in 6 d");
    expect(expiresIn(now, now)).toBe("expiring");
    expect(expiresIn(ahead(-3600_000), now)).toBe("expiring");
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
