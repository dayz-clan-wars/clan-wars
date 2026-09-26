import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { spawnRun, type Run } from "../run.js";
import type { WriteFileFsLike } from "./compositor.js";

// Ported from KOTH bot/src/animation/screenWall.js at a5ef8e7, typed. `screenCards` is dropped per
// the task-7 brief (replaced by src/cards/cards.ts's StoryContext -> Card[] in a later task).
// `mapLabel` is renamed `header` per the brief's Card shape.

const CYAN = "#9bdcef";
const LIME = "#b4e617";
const WHITE = "#f4f4f2";
const INK = "#0a0b0d";

/** Every string drawn into an SVG must be XML-escaped (global-context.md). */
const esc = (s: string): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const clip = (s: string, n = 14): string => (s.length > n ? s.slice(0, n) : s);

export type CardRow = { name: string; value: string };
export type Card = { header: string; title: string; rows: CardRow[] };

function txt(x: number, y: number, size: number, fill: string, anchor: string, family: string, str: string, sw = 6): string {
  return (
    `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" stroke="${INK}" stroke-width="${sw}"` +
    ` paint-order="stroke" stroke-linejoin="round" text-anchor="${anchor}" font-family="${family}">${str}</text>`
  );
}

/**
 * One stat card sized to the TV screen rect. The hosts occlude the left/right thirds of the
 * screen (their heads sit over the screen edges), so ALL content is horizontally centered in the
 * middle column, each row is a centered `name  value` pair, and kept compact so it reads in the
 * ~450px gap between Boris and Pavel. Names are clipped short to stay inside that band.
 */
export function buildCardSvg(o: {
  header: string;
  title: string;
  rows: CardRow[];
  width?: number;
  height?: number;
  displayFamily: string;
  gamertagFamily: string;
}): string {
  const { header, title, rows, width = 742, height = 494, displayFamily, gamertagFamily } = o;
  const cx = width / 2;
  let body =
    txt(cx, 96, 50, CYAN, "middle", displayFamily, esc(header), 7) +
    txt(cx, 150, 38, LIME, "middle", displayFamily, esc(title), 6);
  const y0 = 216;
  const dy = 60;
  (rows.length ? rows : [{ name: "no data yet", value: "" }]).forEach((r, i) => {
    const y = y0 + i * dy;
    // Whole row centered as one group: white name + lime value, sitting in the central visible
    // band regardless of name length. Both tspans MUST use the same font (gamertagFamily): a
    // <text> that mixes two font-families drops the ENTIRE element in resvg when the run forms
    // a ligature (e.g. "fi" in "Fade fishy69"), silently blanking the row (KOTH b954fe3). Single-
    // font renders ligatures fine, so keep the value in the gamertag font rather than the display
    // font.
    body +=
      `<text x="${cx}" y="${y}" font-size="36" text-anchor="middle" stroke="${INK}" stroke-width="6"` +
      ` paint-order="stroke" stroke-linejoin="round" font-family="${gamertagFamily}">` +
      `<tspan fill="${WHITE}">${esc(clip(r.name, 12))}</tspan>` +
      `<tspan fill="${LIME}">${r.value ? `   ${esc(r.value)}` : ""}</tspan>` +
      `</text>`;
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="${INK}"/>` +
    `<rect x="8" y="8" width="${width - 16}" height="${height - 16}" fill="none" stroke="${CYAN}" stroke-width="4"/>` +
    body +
    `</svg>`
  );
}

/** Pure ffmpeg args: N card stills -> one looped, crossfading, silent screen clip of durSec. */
export function buildScreenClipArgs(o: {
  cardPaths: string[];
  holdSec: number;
  xfSec: number;
  fps: number;
  width: number;
  height: number;
  outPath: string;
}): string[] {
  const { cardPaths, holdSec, xfSec, fps, width, height, outPath } = o;
  const inputs: string[] = [];
  const chains: string[] = [];
  cardPaths.forEach((p, i) => {
    inputs.push("-loop", "1", "-t", String(holdSec + xfSec), "-i", p);
    chains.push(`[${i}:v]scale=${width}:${height},setsar=1,fps=${fps},format=yuv420p,settb=1/${fps},setpts=PTS-STARTPTS[c${i}]`);
  });
  // Sequential xfade: c0 x c1 x c2 ... each offset by an accumulated hold.
  let prev = "[c0]";
  let offset = holdSec;
  for (let i = 1; i < cardPaths.length; i++) {
    const out = i === cardPaths.length - 1 ? "[cv]" : `[x${i}]`;
    chains.push(`${prev}[c${i}]xfade=transition=fade:duration=${xfSec}:offset=${offset}${out}`);
    prev = out;
    offset += holdSec;
  }
  const finalLabel = cardPaths.length === 1 ? "[c0]" : "[cv]";
  return [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    ...inputs,
    "-filter_complex",
    chains.join(";"),
    "-map",
    finalLabel,
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(fps),
    "-t",
    String(holdSec * cardPaths.length),
    outPath,
  ];
}

export type ResvgCtor = new (
  svg: string,
  opts: {
    background: string;
    fitTo: { mode: "width"; value: number };
    font: { fontFiles: string[]; defaultFontFamily: string; loadSystemFonts: false };
  },
) => { render: () => { asPng: () => Buffer } };

/** Rasterize each card then build the screen clip. DI'd resvg + ffmpeg + fs. */
export async function buildScreenClip(
  deps: { ResvgImpl?: ResvgCtor; runImpl?: Run; fsImpl?: WriteFileFsLike } = {},
  o: {
    cards: Card[];
    durSec: number;
    fps: number;
    outPath: string;
    workDir: string;
    width?: number;
    height?: number;
    displayFontPath: string;
    gamertagFontPath: string;
  },
): Promise<string> {
  const { ResvgImpl = Resvg as unknown as ResvgCtor, runImpl = spawnRun, fsImpl = fs } = deps;
  const { cards, durSec, fps, outPath, workDir, width = 742, height = 494, displayFontPath, gamertagFontPath } = o;
  const displayFamily = "Animals are like people";
  const gamertagFamily = "Patrick Hand";
  const cardPaths = cards.map((card, i) => {
    const svg = buildCardSvg({ ...card, width, height, displayFamily, gamertagFamily });
    const p = path.join(workDir, `card_${i}.png`);
    const resvg = new ResvgImpl(svg, {
      background: INK,
      fitTo: { mode: "width", value: width },
      font: { fontFiles: [displayFontPath, gamertagFontPath], defaultFontFamily: displayFamily, loadSystemFonts: false },
    });
    fsImpl.writeFileSync(p, resvg.render().asPng());
    return p;
  });
  const holdSec = durSec / cardPaths.length;
  const args = buildScreenClipArgs({ cardPaths, holdSec, xfSec: Math.min(0.5, holdSec / 2), fps, width, height, outPath });
  await runImpl("ffmpeg", args);
  return outPath;
}
