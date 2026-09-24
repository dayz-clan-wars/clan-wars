import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pinResultPath, withoutResult } from "../lib/map-url";

describe("withoutResult", () => {
  it("drops ?result and keeps the grid square", () => {
    expect(withoutResult("https://dayzclanwars.com/map?result=dropped&at=043087")).toBe("/map?at=043087");
  });

  it("leaves a bare path bare", () => {
    expect(withoutResult("https://dayzclanwars.com/map?result=deleted")).toBe("/map");
    expect(withoutResult("https://dayzclanwars.com/map")).toBe("/map");
  });
});

describe("pinResultPath", () => {
  it("sends the player back to the pin's grid square with the result", () => {
    expect(pinResultPath("dropped", "043087")).toBe("?result=dropped&at=043087");
  });

  /** ⚠️ `at` on the delete form is player-supplied: six digits or nothing, so it can carry neither a coordinate nor a second parameter. */
  it("drops an `at` that is not exactly six digits", () => {
    expect(pinResultPath("deleted", null)).toBe("?result=deleted");
    expect(pinResultPath("deleted", "043087&result=dropped")).toBe("?result=deleted");
    expect(pinResultPath("deleted", "4321.7")).toBe("?result=deleted");
    expect(pinResultPath("deleted", "1043087")).toBe("?result=deleted");
  });
});

describe("the pin routes keep the view", () => {
  const API = join(import.meta.dirname, "..", "app", "api", "map", "pin");
  const draw = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "map", "map-draw.ts"), "utf8");

  it.each([join(API, "route.ts"), join(API, "delete", "route.ts")])("%s redirects through pinResultPath", (file) => {
    expect(readFileSync(file, "utf8")).toMatch(/siteUrl\(origin, "\/map", pinResultPath\(/u);
  });

  it("the delete form posts the pin's grid square", () => {
    expect(draw).toContain('<input type="hidden" name="at" value="${gridRefKey(pin.x, pin.z)}" />');
  });
});

/**
 * "Six digits" was stated twice — here and in parseGridRef — with nothing to
 * hold them together. One regex now; this fails if map-url grows its own again,
 * or if gridRefKey ever writes a key the shared shape would refuse.
 */
describe("the grid key's shape is stated once", () => {
  it("map-url uses map-projection's GRID_KEY, not its own", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "lib", "map-url.ts"), "utf8");
    expect(src).toMatch(/import \{[^}]*\bGRID_KEY\b[^}]*\} from "\.\/map-projection"/u);
    expect(src).not.toMatch(/\\d\{6\}/u);
  });

  it("every key gridRefKey writes matches it", async () => {
    const { GRID_KEY, gridRefKey } = await import("../lib/map-projection");
    for (const [x, z] of [[0, 0], [4321.7, 8765.2], [12799, 12799], [-5, 50]] as const) {
      expect(gridRefKey(x, z)).toMatch(GRID_KEY);
    }
  });
});
