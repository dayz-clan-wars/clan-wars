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
