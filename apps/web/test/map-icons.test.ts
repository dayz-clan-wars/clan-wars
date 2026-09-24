import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { ICON, baseIcon, bountyIcon, intruderIcon, layerIcon, pinIcon, publicBaseIcon, type Palette } from "@/lib/map-icons";

const p: Palette = {
  gold: "#c8a24a", ink: "#e8e4dc", ink2: "#8b867c", rust2: "#d4623a",
  olive: "#6b7a4a", frame: "#12110f", rule2: "#2a2824",
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
