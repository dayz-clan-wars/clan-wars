/**
 * Re-fetch the committed item thumbnails from the DayZ community wikis,
 * normalise them, and write them into public/items/.
 *
 * ⚠️ Run BY HAND, never at build or deploy time — the same reasoning as
 * fetch-flags.ts: a build that reaches a third-party wiki fails when that wiki
 * blocks it, and its output can change with nothing in this repository
 * changing.
 *
 * ⚠️ This script REFRESHES what src/item-images.ts already names. It does not
 * discover anything: which file belongs to which class was decided by a human
 * review, because the wikis name files after display names and nothing maps by
 * rule (see that module's own warning).
 *
 *   pnpm --filter @factions/web exec tsx scripts/fetch-item-images.ts
 *   pnpm --filter @factions/web exec tsx scripts/fetch-item-images.ts --only PlateCarrier
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { KIT_SLOTS } from "@factions/domain";
import { boosterCatalogue } from "@factions/domain/catalogue";
import { awardsCatalogue } from "@factions/domain/awards";
import { wikiFileFor, itemImagePath } from "../src/item-images.js";

const API: Record<string, string> = {
  "wiki.gg": "https://dayz.wiki.gg/api.php",
  fandom: "https://dayz.fandom.com/api.php",
};
const PUBLIC = join(import.meta.dirname, "..", "public");

/** Tiles render near 96px; 192 covers a 2x display with nothing wasted. */
const EDGE = 192;

/** The wikis' CDNs reject requests without a UA. */
const HEADERS = { "User-Agent": "clan-wars-item-fetch/1.0 (private DayZ community server)" };

/**
 * ⚠️ The CDN drops the connection after roughly two dozen sequential downloads
 * from one process — a footnote at 33 flags, a certainty at 200 items. Without
 * this the script dies partway with no obvious cause.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 5, delayMs = 500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

async function imageUrl(api: string, file: string): Promise<string> {
  const url = `${api}?action=query&titles=${encodeURIComponent(`File:${file}`)}&prop=imageinfo&iiprop=url&format=json`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`imageinfo ${file}: HTTP ${res.status}`);
  const body = await res.json() as { query?: { pages?: Record<string, { imageinfo?: { url: string }[] }> } };
  const direct = Object.values(body.query?.pages ?? {})[0]?.imageinfo?.[0]?.url;
  // ⚠️ A missing page comes back as a page with no imageinfo rather than an
  // error, so an unchecked read here writes a zero-byte file and the only
  // symptom is one blank tile.
  if (!direct) throw new Error(`no imageinfo for File:${file} — has the wiki renamed it?`);
  return direct;
}

async function main(): Promise<void> {
  await mkdir(join(PUBLIC, "items"), { recursive: true });
  // `--only PlateCarrier` fetches just those classes. ⚠️ Re-running the whole
  // catalogue re-encodes 200 committed images and churns the diff for nothing.
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] ?? "" : "";
  // Award items share public/items/ with the kit, so both catalogues feed it.
  const entries = [
    ...KIT_SLOTS.flatMap((s) => boosterCatalogue()[s]),
    ...Object.values(awardsCatalogue()).flatMap((a) => Object.values(a.slots).flatMap((s) => s.items)),
  ].filter((e) => !only || e.className.startsWith(only));
  let written = 0;
  const skipped: string[] = [];

  for (const entry of entries) {
    const source = wikiFileFor(entry.className);
    if (!source) { skipped.push(`${entry.className} (no source)`); continue; }
    // ⚠️ A supplied URL or a hand-trimmed image has no wiki file to re-fetch.
    // Overwriting it from a guess would silently undo a human decision.
    if (source.wiki === "supplied" || source.wiki === "local") {
      skipped.push(`${entry.className} (${source.wiki}, committed by hand)`);
      continue;
    }
    const api = API[source.wiki];
    if (!api) throw new Error(`${entry.className}: unknown wiki ${source.wiki}`);
    const src = await withRetry(() => imageUrl(api, source.file));
    const raw = await withRetry(async () => {
      const res = await fetch(src, { headers: HEADERS });
      if (!res.ok) throw new Error(`download ${source.file}: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    });
    const resized = await sharp(raw)
      .resize({ width: EDGE, height: EDGE, fit: "inside", withoutEnlargement: true })
      .toBuffer();
    const meta = await sharp(resized).metadata();
    // Square-pad so every tile sits on the same baseline in the grid.
    const out = await sharp({
      create: { width: EDGE, height: EDGE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{
        input: resized,
        left: Math.round((EDGE - (meta.width ?? EDGE)) / 2),
        top: Math.round((EDGE - (meta.height ?? EDGE)) / 2),
      }])
      .webp({ quality: 82 })
      .toBuffer();

    const dest = join(PUBLIC, itemImagePath(entry.className));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, out);
    written++;
    console.log(`${entry.className.padEnd(28)} <- ${source.file.padEnd(34)} ${raw.length} -> ${out.length} bytes`);
  }

  console.log(`\nwrote ${written} item image(s) to public/items/`);
  for (const s of skipped) console.log(`  skipped ${s}`);
}

await main();
