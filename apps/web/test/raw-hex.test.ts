import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(import.meta.dirname, "..", "app", "components", f), "utf8");

/**
 * L2: colours come from the @theme tokens. A hex literal is a second statement
 * of a palette colour that nothing holds to the first — #4a4640 was not a
 * palette colour at all.
 */
describe("no raw hex colours", () => {
  it.each(["hero-map.tsx", "achievement-badge.tsx"])("%s states no hex colour", (f) => {
    expect(read(f)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u);
  });
});
