import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SETTINGS = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "clan", "settings", "page.tsx"), "utf8");

/**
 * M6: one tap moved the base, started the 7-day cooldown and put the old pole
 * on its grace clock. Release on /base has always been two-press; this is the
 * same weight of act.
 */
describe("Move here", () => {
  it("is a two-press", () => {
    expect(SETTINGS).toMatch(/<RowAction action="\/api\/clan\/rebind"[^\n]*confirm="Press again to move"/u);
  });
});
