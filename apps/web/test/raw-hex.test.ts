import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(import.meta.dirname, "..", "app", "components", f), "utf8");

/**
 * L2: colours come from the @theme tokens. A hex literal is a second statement
 * of a palette colour that nothing holds to the first — #4a4640 was not a
 * palette colour at all. rgb()/rgba() is the same problem in a different
 * spelling — `rgba(11,11,10,.7)` was --color-frame hand-copied with an alpha
 * tacked on, drifting the moment the token changes.
 */
describe("no raw hex colours", () => {
  it.each(["hero-map.tsx", "achievement-badge.tsx"])("%s states no hex colour", (f) => {
    expect(read(f)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u);
  });

  it("⚠️ hero-map.tsx states no rgb()/rgba() literal either — color-mix() over a token instead", () => {
    expect(read("hero-map.tsx")).not.toMatch(/\brgba?\(/u);
  });
});
