import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PIN_ICONS } from "@factions/domain";
import { PinSheet } from "../app/(site)/map/pin-sheet";
import { PIN_FOLLOW, PIN_SHEET_COPY } from "../lib/map-copy";
import type { Palette } from "../lib/map-icons";

const pal: Palette = { gold: "#d9a03c", ink: "#e8e2d4", ink2: "#b5afa4", rust2: "#d4623a", olive: "#8fa36a", frame: "#0b0b0a", rule2: "#2a2825" };
const render = (follow: boolean) =>
  renderToStaticMarkup(createElement(PinSheet, { draft: { x: 4321, z: 8765, follow }, pal, onCancel: () => {}, insetRef: () => {} }));

describe("PinSheet", () => {
  it("is a form named for the grid square it drops on", () => {
    expect(render(false)).toContain('aria-label="Drop a pin at grid 043 087"');
  });

  it("labels the note with a real label, not a placeholder alone", () => {
    const html = render(false);
    const id = html.match(/<textarea[^>]*\bid="([^"]+)"/u)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`for="${id}"`);
    expect(html).toContain(PIN_SHEET_COPY.note);
    expect(html).not.toContain("placeholder=");
  });

  it("offers every icon, the first checked", () => {
    const html = render(false);
    expect(html.match(/type="radio"/gu)).toHaveLength(PIN_ICONS.length);
    expect(html).toMatch(/type="radio"[^>]*value="loot"[^>]*checked=""|checked=""[^>]*value="loot"/u);
  });

  it("clears the phone's home indicator", () => {
    expect(render(false)).toContain("env(safe-area-inset-bottom)");
  });

  it("says the pin follows the cross only for a Pin-here draft", () => {
    expect(render(true)).toContain(PIN_FOLLOW);
    expect(render(false)).not.toContain(PIN_FOLLOW);
  });

  it("puts nothing but the grid ref in its text — the metres ride hidden inputs, as before", () => {
    const text = render(false).replace(/<input type="hidden"[^>]*>/gu, "");
    expect(text).not.toMatch(/4321|8765/u);
  });
});

describe("PinSheet's keyboard handling", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "map", "pin-sheet.tsx"), "utf8");

  it("moves focus into the sheet when it opens", () => {
    expect(src).toContain("first.current?.focus()");
  });

  it("cancels on Escape", () => {
    expect(src).toMatch(/e\.key === "Escape"[\s\S]{0,60}onCancel\(\)/u);
  });
});
