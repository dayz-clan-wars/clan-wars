import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { KIT_SLOTS } from "@factions/domain";
import { boosterCatalogue } from "@factions/domain/catalogue";

// ⚠️ Must match EDGE in apps/web/scripts/fetch-item-images.ts — two statements
// of one fact, held together only by this test.
const EDGE = 192;

const ITEMS_DIR = join(import.meta.dirname, "..", "public", "items");

/**
 * ⚠️ The catalogue's `image` paths and the contents of public/items/ are two
 * statements of one fact, and the compiler cannot see the second. Same
 * reasoning as flag-assets.test.ts, and the same silent failure: drift shows
 * up as a blank tile in the picker, not a stack trace.
 *
 * This also closes the class of gap PLAN-3-INBOX item 41 describes, where an
 * asset absent from the built image was invisible until production.
 */
describe("item images match the catalogue", () => {
  const files = readdirSync(ITEMS_DIR).filter((f) => f.endsWith(".webp"));
  const entries = KIT_SLOTS.flatMap((s) => boosterCatalogue()[s]);

  it("every catalogue image resolves to a file", () => {
    const missing = entries
      .filter((e) => e.image && !files.includes(`${e.className}.webp`))
      .map((e) => e.className);
    expect(missing).toEqual([]);
  });

  it("every file belongs to a catalogue entry", () => {
    const known = new Set(entries.map((e) => e.className));
    const orphans = files.filter((f) => !known.has(f.replace(/\.webp$/u, "")));
    expect(orphans).toEqual([]);
  });

  it("there is one per catalogue entry", () => {
    expect(files).toHaveLength(entries.length);
  });

  it("⚠️ every image was actually normalised, not committed raw", () => {
    // The byte ceiling alone cannot catch a skipped resize when the wiki's
    // source is already small, so dimensions are checked too. Committing raw
    // downloads would add tens of MB and nothing else would complain.
    for (const f of files) {
      const bytes = statSync(join(ITEMS_DIR, f)).size;
      expect(bytes, `${f} is ${bytes} bytes`).toBeLessThan(60_000);
      expect(bytes, `${f} is suspiciously small`).toBeGreaterThan(0);
    }
  });

  it("⚠️ every image is a square of exactly EDGE", async () => {
    for (const f of files) {
      const { width, height } = await sharp(join(ITEMS_DIR, f)).metadata();
      expect(width ?? 0, `${f} width`).toBe(EDGE);
      expect(height ?? 0, `${f} height`).toBe(EDGE);
    }
  });
});
