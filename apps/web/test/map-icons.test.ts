import { describe, it, expect } from "vitest";
import { ICON, baseIcon, publicBaseIcon, type Palette } from "@/lib/map-icons";

const p: Palette = {
  gold: "#c8a24a", ink: "#e8e4dc", ink2: "#8b867c", rust: "#a4442e",
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
