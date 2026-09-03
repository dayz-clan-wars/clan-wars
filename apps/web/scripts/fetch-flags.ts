/**
 * Fetch the 33 claimable flag images from the DayZ Fandom wiki, normalise
 * them, and write them into public/flags/.
 *
 * ⚠️ Run BY HAND, never at build or deploy time. A build that reaches out to
 * a third-party wiki is a build that fails when that wiki blocks it — and it
 * already blocks ordinary requests: a plain GET of the HTML page returns 403,
 * which is why this uses the MediaWiki API. It is also a build whose output
 * can change with nothing in this repository changing.
 *
 * The flag pool is fixed at 33 by design (see packages/domain/src/flags.ts),
 * so the expected frequency of running this is: once.
 *
 *   pnpm --filter @factions/web exec tsx scripts/fetch-flags.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { CLAIMABLE_FLAGS } from "@factions/domain";
import { wikiFilenameFor, flagImagePath } from "../src/flag-images.js";

const API = "https://dayz.fandom.com/api.php";
const PUBLIC = join(import.meta.dirname, "..", "public");

/** Long-edge target. Discord renders embed thumbnails near 80x80; this leaves
 *  room for a future directory page without being another 1.4MB per flag. */
const MAX_EDGE = 256;

/** The wiki serves these over a CDN that rejects requests without a UA. */
const HEADERS = { "User-Agent": "clan-wars-flag-fetch/1.0 (private DayZ community server)" };

async function imageUrl(wikiFilename: string): Promise<string> {
  const url = `${API}?action=query&titles=${encodeURIComponent(`File:${wikiFilename}`)}` +
    `&prop=imageinfo&iiprop=url&format=json`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`imageinfo ${wikiFilename}: HTTP ${res.status}`);
  const body = await res.json() as {
    query?: { pages?: Record<string, { imageinfo?: { url: string }[] }> };
  };
  const pages = Object.values(body.query?.pages ?? {});
  const direct = pages[0]?.imageinfo?.[0]?.url;
  // ⚠️ A missing page comes back as a page with no imageinfo rather than an
  // error, so an unchecked read here would write a zero-byte file and the
  // only symptom would be one blank thumbnail.
  if (!direct) throw new Error(`no imageinfo for File:${wikiFilename} — has the wiki renamed it?`);
  return direct;
}

async function main(): Promise<void> {
  await mkdir(join(PUBLIC, "flags"), { recursive: true });
  let written = 0;

  for (const texture of CLAIMABLE_FLAGS) {
    const wikiName = wikiFilenameFor(texture);
    const src = await imageUrl(wikiName);
    const res = await fetch(src, { headers: HEADERS });
    if (!res.ok) throw new Error(`download ${wikiName}: HTTP ${res.status}`);

    const raw = Buffer.from(await res.arrayBuffer());
    const out = await sharp(raw)
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();

    const dest = join(PUBLIC, flagImagePath(texture));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, out);
    written++;
    console.log(`${texture.padEnd(20)} <- ${wikiName.padEnd(22)} ${raw.length} -> ${out.length} bytes`);
  }

  console.log(`\nwrote ${written} flag image(s) to public/flags/`);
  if (written !== CLAIMABLE_FLAGS.length) {
    throw new Error(`expected ${CLAIMABLE_FLAGS.length}, wrote ${written}`);
  }
}

await main();
