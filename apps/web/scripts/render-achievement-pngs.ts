import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { ACHIEVEMENT_KEYS } from "@factions/domain";

/**
 * Renders public/achievements/{unlocked,locked}/<key>.png from svg/<key>.svg
 * (128x128, transparent). Run BY HAND and commit the output, so a deploy never
 * depends on sharp's native binary:
 *
 *   pnpm --filter @factions/web achievements:png              # missing files only
 *   pnpm --filter @factions/web achievements:png -- --overwrite
 *
 * ⚠️ The first 50 PNGs were drawn outside this repo, so the default fills only
 * files that do not exist yet and never redraws those. --overwrite redraws all.
 */
const ART = join(import.meta.dirname, "..", "public", "achievements");

/** Locked palette from public/achievements/README.md. */
const LOCKED_OUTLINE = "#2a2825";
const LOCKED_GLYPH = "#4a4640";
/**
 * ⚠️ The 50 hand-drawn locked PNGs fill the shield with the site background
 * (--color-frame), opaque, rather than leaving it clear. Match them so new
 * locked tiles sit beside the old ones identically.
 */
const LOCKED_FILL = "#0b0b0a";

/** The c2pa provenance block is large and useless to a rasteriser. */
export function stripMetadata(svg: string): string {
  return svg.replace(/<metadata[\s\S]*?<\/metadata>/u, "");
}

/**
 * Locked look: shield outlined #2a2825 with no group tint (flat background fill), glyph #4a4640. The shield
 * is the path before the glyph group; the glyph is everything inside it. The
 * group colour differs per tile, so we match any hex rather than naming four.
 */
export function lockedSvg(svg: string): string {
  const at = svg.indexOf("<g ");
  if (at < 0) throw new Error("svg has no glyph group");
  const shield = svg
    .slice(0, at)
    .replace(/fill="rgba\([^"]*\)"/u, `fill="${LOCKED_FILL}"`)
    .replace(/stroke="#[0-9a-fA-F]{6}"/u, `stroke="${LOCKED_OUTLINE}"`);
  const glyph = svg.slice(at).replace(/stroke="#[0-9a-fA-F]{6}"/gu, `stroke="${LOCKED_GLYPH}"`);
  return shield + glyph;
}

export interface ArtDirs {
  /** Folder holding svg/, unlocked/ and locked/. Injectable so tests never write into public/. */
  root: string;
}

/** Returns the files written. */
export async function renderPngs(
  keys: string[],
  opts: { overwrite: boolean },
  dirs: ArtDirs = { root: ART },
): Promise<string[]> {
  const written: string[] = [];
  for (const state of ["unlocked", "locked"] as const) await mkdir(join(dirs.root, state), { recursive: true });
  for (const key of keys) {
    const svg = stripMetadata(await readFile(join(dirs.root, "svg", `${key}.svg`), "utf8"));
    for (const [state, source] of [
      ["unlocked", svg],
      ["locked", lockedSvg(svg)],
    ] as const) {
      const dest = join(dirs.root, state, `${key}.png`);
      if (!opts.overwrite && existsSync(dest)) continue;
      await writeFile(dest, await sharp(Buffer.from(source)).resize(128, 128).png().toBuffer());
      written.push(dest);
    }
  }
  return written;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const done = await renderPngs([...ACHIEVEMENT_KEYS], { overwrite: process.argv.includes("--overwrite") });
  console.log(`wrote ${done.length} PNG(s)`);
}
