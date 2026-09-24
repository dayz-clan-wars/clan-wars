import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { followCentre, insetFor, pickReturnFocus, pinAtCentre, pinAtPoint } from "../lib/map-pin";

const WEB = join(import.meta.dirname, "..");
const view = readFileSync(join(WEB, "app", "(site)", "map", "map-view.tsx"), "utf8");

describe("pin drafts", () => {
  it("puts a 'Pin here' draft on the centre, rounded to the metre, following it", () => {
    expect(pinAtCentre({ x: 4321.6, z: 8765.4 })).toEqual({ x: 4322, z: 8765, follow: true });
  });

  it("moves a following draft with the centre as the player pans", () => {
    const d = pinAtCentre({ x: 100, z: 100 });
    expect(followCentre(d, { x: 250.2, z: 90.7 })).toEqual({ x: 250, z: 91, follow: true });
  });

  it("leaves a draft dropped on a point where it was pressed", () => {
    const d = pinAtPoint({ x: 100.4, z: 100.6 });
    expect(d).toEqual({ x: 100, z: 101, follow: false });
    expect(followCentre(d, { x: 900, z: 900 })).toBe(d);
  });

  it("returns the same object for an unchanged centre, so React skips the render", () => {
    const d = pinAtCentre({ x: 100, z: 100 });
    expect(followCentre(d, { x: 100.2, z: 99.8 })).toBe(d);
    expect(followCentre(null, { x: 1, z: 1 })).toBeNull();
  });
});

describe("insetFor", () => {
  it("insets by a full-width overlay's height — the phone bar, the phone pin sheet", () => {
    expect(insetFor({ width: 390, height: 120.4 }, 390)).toBe(120);
  });

  it("insets nothing for a floating desktop card or a display:none bar", () => {
    expect(insetFor({ width: 360, height: 400 }, 1280)).toBe(0);
    expect(insetFor({ width: 0, height: 0 }, 1280)).toBe(0);
  });
});

describe("the 'Pin here' buttons", () => {
  it("sit on both bars, only for a viewer with the pins layer", () => {
    // ⚠️ A bare substring count also catches `pickReturnFocus`'s
    // `"[data-pin-here]"` selector string (Task 12) — that occurrence is a
    // selector, not an attribute, so it is excluded by requiring the match
    // not be bracketed.
    expect(view.match(/(?<!\[)data-pin-here(?!\])/gu)).toHaveLength(2);
    expect(view.match(/\{layers\.pins && \(\s*<button type="button" data-pin-here/gu)).toHaveLength(2);
  });

  it("are the words the legend and the guide use", () => {
    const guide = readFileSync(join(WEB, "content", "guide", "10-the-map.html"), "utf8");
    expect(guide).toContain("Pin here");
    expect(view).not.toContain("Press and hold to drop a pin.");
  });
});

describe("pickReturnFocus", () => {
  /**
   * ⚠️ Review focus 4. Both bars unmount while the pin sheet is open, so
   * the button that opened it no longer exists when it closes. Focus has to go
   * to the "Pin here" button that is on screen NOW (the phone's or the
   * desktop's; the other one is display:none), or it falls to <body>.
   */
  // ⚠️ Typed explicitly: `offsetParent` is `unknown` on the real signature
  // (an element's `offsetParent` is `Element | null`), and an inline literal's
  // `null` would otherwise narrow to the literal type `null`, which a sibling
  // literal's `{}` can't unify with under inference from two call sites.
  type Candidate = { offsetParent: unknown; id: string };

  it("picks the visible candidate", () => {
    const hidden: Candidate = { offsetParent: null, id: "desktop" };
    const shown: Candidate = { offsetParent: {}, id: "phone" };
    expect(pickReturnFocus([hidden, shown], null)).toBe(shown);
  });

  it("falls back when every candidate is hidden or gone", () => {
    const map: Candidate = { offsetParent: {}, id: "map" };
    expect(pickReturnFocus([{ offsetParent: null, id: "x" } as Candidate], map)).toBe(map);
    expect(pickReturnFocus([] as Candidate[], map)).toBe(map);
    expect(pickReturnFocus([] as Candidate[], null)).toBeNull();
  });

  it("is what map-view.tsx calls when the sheet closes", () => {
    expect(view).toContain('pickReturnFocus([...document.querySelectorAll<HTMLElement>("[data-pin-here]")], el.current)?.focus()');
  });
});
