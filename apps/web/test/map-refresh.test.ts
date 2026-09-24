import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAP_LOAD_COPY } from "../lib/map-copy";

/**
 * The phone's grid cell is the refresh button. It carried `aria-live`, and
 * its text includes the centre's grid ref, which changes on every pan, so a
 * screen reader said "Grid 043 087. Refresh" after each one. And "Refreshed ·
 * just now" flashed before the request had even finished, failure included.
 */
const view = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "map", "map-view.tsx"), "utf8");

describe("refresh feedback", () => {
  it("has no live region on a control whose text follows the pan", () => {
    expect(view).not.toContain("aria-live");
  });

  it("flashes and announces only after a refresh that succeeded", () => {
    expect(view).toMatch(/const ok = await load\(\);\s*if \(ok !== true\) return;\s*setFlash\(true\);\s*setAnnounce\(MAP_LOAD_COPY\.refreshed\);/u);
  });

  it("announces through one sr-only status of its own", () => {
    expect(view).toContain('<p role="status" className="sr-only">{announce}</p>');
    expect(MAP_LOAD_COPY.refreshed).toBe("Map refreshed.");
  });

  it("both Refresh buttons take the same path", () => {
    expect(view.match(/onClick=\{\(\) => void refreshTap\(\)\}/gu)).toHaveLength(2);
  });
});

// The phone's Refresh already carries "Refresh the map. Centre: grid …" in an
// sr-only span; the visible grid beside it made the name say the grid twice.
describe("the phone Refresh's accessible name", () => {
  it("hides the visible grid from the accessibility tree", () => {
    expect(view).toContain('<span aria-hidden="true" className="truncate">{centre?.grid ?? "000 000"}</span>');
  });
});

// Escape in the pin sheet cancels the draft (pin-sheet.tsx). The layers
// panel's window listener heard the same keypress and closed too, so one
// Escape undid two things.
describe("Escape with the pin sheet open", () => {
  it("leaves the layers panel alone", () => {
    expect(view).toMatch(/if \(!layersOpen \|\| pinSheet\) return;/u);
  });
});
