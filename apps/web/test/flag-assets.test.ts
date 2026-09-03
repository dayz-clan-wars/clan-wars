import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { CLAIMABLE_FLAGS } from "@factions/domain";

// ⚠️ Must match MAX_EDGE in apps/web/scripts/fetch-flags.ts — two statements
// of one fact, held together only by this test.
const MAX_EDGE = 256;

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
    // Flag_Wolf's stored original is 877x1027 and ~1.4MB (per the MediaWiki
    // API's own `size` field) — but the CDN content-negotiates, so a plain
    // download can arrive as a smaller transcoded WebP instead. Neither form
    // is a consistent, appropriately-sized asset for a Discord embed
    // thumbnail rendered near 80x80, which is why normalisation happens
    // regardless of which one the wiki hands back — sharp decodes whichever
    // it receives. This asserts that normalisation in scripts/fetch-flags.ts
    // actually ran — committing the raw downloads would add tens of MB to
    // the repo and nothing else would complain.
    for (const f of files) {
      const bytes = statSync(join(FLAGS_DIR, f)).size;
      expect(bytes, `${f} is ${bytes} bytes`).toBeLessThan(200_000);
      expect(bytes, `${f} is suspiciously small`).toBeGreaterThan(0);
    }
  });

  it("⚠️ every image was actually resized to MAX_EDGE, not just under the byte ceiling", async () => {
    // The byte bound above cannot catch a skipped resize when the wiki's raw
    // source is already small — Flag_Sakhal's raw source is 18,152 bytes,
    // already under 200,000, so a pipeline that forgot to resize it would
    // still pass that assertion. Checking pixel dimensions closes that gap.
    for (const f of files) {
      const { width, height } = await sharp(join(FLAGS_DIR, f)).metadata();
      expect(Math.max(width ?? 0, height ?? 0), `${f} long edge`).toBe(MAX_EDGE);
    }
  });
});
