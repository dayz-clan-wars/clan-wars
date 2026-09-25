/**
 * Derive the list thumbnails (public/flags/thumb/*.webp) from the 33
 * committed PNGs in public/flags/.
 *
 * ⚠️ Run BY HAND and commit the output, like fetch-flags.ts and
 * fetch-item-images.ts. It reads only files already in this repository, so it
 * needs no network, but committing the output means a deploy never depends
 * on sharp's native binary. Re-run it whenever a PNG in public/flags changes;
 * test/flag-thumbs.test.ts fails for a flag that has none.
 *
 *   pnpm --filter @factions/web exec tsx scripts/build-flag-thumbs.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { CLAIMABLE_FLAGS } from "@factions/domain";
import { FLAG_THUMB_EDGE, flagImagePath, flagThumbPath } from "../src/flag-images.js";

const PUBLIC = join(import.meta.dirname, "..", "public");

async function main(): Promise<void> {
  let written = 0;
  for (const texture of CLAIMABLE_FLAGS) {
    const out = await sharp(join(PUBLIC, flagImagePath(texture)))
      .resize({ width: FLAG_THUMB_EDGE, height: FLAG_THUMB_EDGE, fit: "inside" })
      .webp({ quality: 85, effort: 6 })
      .toBuffer();
    const dest = join(PUBLIC, flagThumbPath(texture));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, out);
    written++;
    console.log(`${texture.padEnd(20)} -> ${out.length} bytes`);
  }
  console.log(`\nwrote ${written} thumbnail(s) to public/flags/thumb/`);
  if (written !== CLAIMABLE_FLAGS.length) throw new Error(`expected ${CLAIMABLE_FLAGS.length}, wrote ${written}`);
}

await main();
