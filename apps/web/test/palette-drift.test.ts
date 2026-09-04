import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ⚠️ The palette is stated twice — once in `app/mobile/mobile.module.css` and
 * once in `app/auth.module.css` — because CSS modules are scoped and
 * neither route can see the other's custom properties.
 *
 * Two statements of one fact will drift. This is the test that fails when they
 * do. The failure it prevents is not an error: it is /link rendering in a gold
 * two shades off /mobile's, which looks like a design choice and gets reported
 * by nobody.
 *
 * Adding a property to only ONE file is fine and deliberately allowed — the
 * routes do not need identical palettes, only identical VALUES for the tokens
 * they share.
 */
const FILES = {
  mobile: join(import.meta.dirname, "..", "app", "mobile", "mobile.module.css"),
  link: join(import.meta.dirname, "..", "app", "auth.module.css"),
};

/** Every `--name: value;` declaration in a stylesheet, as a map. */
function customProperties(path: string): Map<string, string> {
  const text = readFileSync(path, "utf8");
  const found = new Map<string, string>();
  for (const match of text.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    const [, name, value] = match;
    // Both groups are non-optional in the pattern, so this only narrows types.
    if (name === undefined || value === undefined) continue;
    found.set(name, value.trim());
  }
  return found;
}

describe("the two stylesheets agree about the palette", () => {
  const mobile = customProperties(FILES.mobile);
  const link = customProperties(FILES.link);

  it("finds properties in both files", () => {
    expect(mobile.size).toBeGreaterThan(0);
    expect(link.size).toBeGreaterThan(0);
  });

  it("shares a meaningful number of tokens", () => {
    // ⚠️ Guards the guard. A rename on both sides could empty the intersection
    // and leave the comparison below passing vacuously, proving nothing.
    const shared = [...link.keys()].filter((k) => mobile.has(k));
    expect(shared.length).toBeGreaterThanOrEqual(10);
  });

  it("gives every shared token the same value", () => {
    const drifted = [...link.entries()]
      .filter(([name, value]) => mobile.has(name) && mobile.get(name) !== value)
      .map(([name, value]) => `${name}: ${mobile.get(name)} (mobile) vs ${value} (link)`);
    expect(drifted).toEqual([]);
  });
});
