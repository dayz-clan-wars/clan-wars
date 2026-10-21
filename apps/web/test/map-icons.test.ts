import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { ICON, baseIcon, bountyIcon, intruderIcon, layerIcon, pinIcon, publicBaseIcon, worldIcon, type Palette } from "@/lib/map-icons";
import { worldLayers } from "@/lib/world-layers";
import type { WorldFile } from "@/lib/map-world";

const p: Palette = {
  gold: "#c8a24a", ink: "#e8e4dc", ink2: "#8b867c", rust2: "#d4623a",
  olive: "#6b7a4a", frame: "#12110f", rule2: "#2a2824", military: "#e0457b",
};

describe("the public-base marker", () => {
  /**
   * ⚠️ It used to be a 35×34 composite carrying the clan's real flag IMAGE —
   * the only marker that loaded an outside asset, and the only one that was
   * not a chip. A public base is an abandoned pole, so whose flag last flew
   * there is not the map's business, and the odd size made it the one marker
   * that pinned differently from everything around it.
   */
  it("is a chip glyph, not an embedded flag image", () => {
    const svg = publicBaseIcon(p);
    expect(svg).not.toContain("<img");
    expect(svg).toContain('width="28"');
    expect(svg).toContain('height="28"');
  });

  it("pins at the foot of the pole, exactly as your own base does", () => {
    expect(ICON.publicBase).toEqual(ICON.base);
  });

  it("reads as unclaimed: muted and hollow where your own base is gold and filled", () => {
    const mine = baseIcon(p);
    const theirs = publicBaseIcon(p);
    expect(mine).toContain(`fill="${p.gold}"`);
    expect(theirs).not.toContain(`fill="${p.gold}"`);
    expect(theirs).toContain(p.ink2);
  });
});

/**
 * ⚠️ --color-rust is 2.6:1 on the frame, and globals.css keeps it for EDGES.
 * A marker's mark is a graphic that has to meet 3:1 against the chip, so the
 * intruder diamond, the bounty crosshair, the danger pin and their legend
 * glyphs are drawn in rust-2 (5:1): the same hue, readable.
 */
describe("the map's rust markers are rust-2", () => {
  const RUST_EDGE = "#8c3a22";
  it.each([
    ["intruder", intruderIcon(p)],
    ["bounty", bountyIcon(p)],
    ["danger pin", pinIcon(p, "danger")],
    ["intruders legend", layerIcon(p, "intruders")],
    ["bounties legend", layerIcon(p, "bounties")],
  ])("%s", (_name, svg) => {
    expect(svg).toContain(p.rust2);
    expect(svg).not.toContain(RUST_EDGE);
  });

  it("puts a dark mark on the bright diamond, not ink on it", () => {
    expect(intruderIcon(p)).toContain(`stroke="${p.frame}" stroke-width="2.2"`);
  });

  it("reads rust-2 from the theme, not a literal", () => {
    const draw = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "map", "map-draw.ts"), "utf8");
    expect(draw).toContain('rust2: () => token("--color-rust-2", "#d4623a")');
    expect(draw).not.toContain('token("--color-rust",');
    const css = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "map", "map.css"), "utf8");
    expect(css).toContain(".cw-map-tag-intruder { border-color: var(--color-rust-2); }");
  });
});

describe("the world layers' icons", () => {
  const world = JSON.parse(readFileSync(join(import.meta.dirname, "..", "public", "map-data", "nasdara", "world.json"), "utf8")) as WorldFile;
  const keys = worldLayers(world).map((l) => l.key);
  const GRID = layerIcon(p, "no-such-layer");

  it("covers every layer the committed world offers", () => expect(keys.length).toBeGreaterThan(20));

  it.each(keys)("%s has a map chip and its own legend glyph", (key) => {
    expect(worldIcon(p, key)).toMatch(/^<svg[^>]*>.*<path|<circle/su);
    expect(worldIcon(p, key)).toContain(`width="${ICON.world.size[0]}"`);
    const legend = layerIcon(p, key);
    expect(legend).toContain("<svg");
    expect(legend).not.toBe(GRID);
  });

  it("gives Military its own accent, which no other layer uses", () => {
    expect(worldIcon(p, "loot:military")).toContain(p.military);
    for (const key of keys.filter((k) => k !== "loot:military")) expect(worldIcon(p, key), key).not.toContain(p.military);
  });

  it("never draws a world layer in gold, which on this map means yours", () => {
    for (const key of keys) expect(worldIcon(p, key), key).not.toContain(p.gold);
  });
});
