import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLAIMABLE_FLAGS } from "@factions/domain";

const FLAGS_DIR = join(import.meta.dirname, "..", "public", "flags");

/**
 * ⚠️ CLAIMABLE_FLAGS and the contents of public/flags/ are two statements of
 * one fact, and the compiler cannot see the second. Nothing but this test
 * holds them together.
 *
 * Drift is silent in the worst way: the symptom is a missing thumbnail in a
 * Discord channel, not a stack trace, and only for the faction holding the
 * affected flag. Same reasoning as packages/db/test/holding-index-drift.test.ts.
 */
describe("flag images match CLAIMABLE_FLAGS", () => {
  const files = readdirSync(FLAGS_DIR).filter((f) => f.endsWith(".png"));

  it("every claimable flag has an image", () => {
    const missing = CLAIMABLE_FLAGS.filter((t) => !files.includes(`${t}.png`));
    expect(missing).toEqual([]);
  });

  it("every image belongs to a claimable flag", () => {
    const orphans = files.filter((f) => !CLAIMABLE_FLAGS.includes(f.replace(/\.png$/u, "")));
    expect(orphans).toEqual([]);
  });

  it("there are exactly 33", () => {
    expect(files).toHaveLength(33);
  });

  it("⚠️ no image is anywhere near the wiki's original weight", () => {
    // Flag_Wolf.png is 877x1027 and 1.4MB at source, against a Discord embed
    // thumbnail rendered near 80x80. This asserts the normalisation in
    // scripts/fetch-flags.ts actually ran — committing the raw downloads
    // would add ~35MB to the repo and nothing else would complain.
    for (const f of files) {
      const bytes = statSync(join(FLAGS_DIR, f)).size;
      expect(bytes, `${f} is ${bytes} bytes`).toBeLessThan(200_000);
      expect(bytes, `${f} is suspiciously small`).toBeGreaterThan(0);
    }
  });
});
