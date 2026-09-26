import fs from "node:fs";
import { Resvg } from "@resvg/resvg-js";

// Ported and reshaped from KOTH bot/src/video/leaderboardImage.js at a5ef8e7. KOTH drew one crown
// column per map (Chernarus/Livonia), with rank, gamertag and crown count as three separately
// positioned <text> elements. This plan (task-8 brief) has one map and no crowns: it draws a
// single column of clan rows -- "<rank>. <name>  <points> pts · <raids> raids" -- and every row is
// ONE <text> element in a single font-family (the b954fe3 rule, global-context.md), because mixing
// font-families within one <text> element is what silently dropped an entire row in resvg when the
// run formed a ligature (Task 7's screenWall.ts carries the same rule for stat-card rows). The
// headline is drawn exactly as given -- never uppercased, never built up from a season/week pair
// (that composition belongs to src/cards/ in a later task).

const CYAN = "#9bdcef";
const LIME = "#b4e617";
const WHITE = "#f4f4f2";
const INK = "#0a0b0d";
const DIM = "#cfd2d6";

/** Every string drawn into an SVG must be XML-escaped (global-context.md). */
const esc = (s: string): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const clip = (s: string, n = 16): string => (s.length > n ? s.slice(0, n) : s);

const MAX_ROWS = 5;

function txt(x: number, y: number, size: number, fill: string, anchor: string, family: string, str: string, sw = 8): string {
  return (
    `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" stroke="${INK}" stroke-width="${sw}"` +
    ` paint-order="stroke" stroke-linejoin="round" text-anchor="${anchor}" font-family="${family}">${str}</text>`
  );
}

export type OutroRow = { name: string; points: number; raids: number };
export type OutroBoard = { headline: string; rows: OutroRow[] };

/**
 * Build the outro board SVG (pure). Background image is embedded as a data URI; a black scrim
 * improves legibility. Draws the headline as given, then up to 5 rows, each a single <text>
 * element (single font-family) reading "<rank>. <name>  <points> pts · <raids> raids".
 */
export function buildOutroBoardSvg(o: {
  board: OutroBoard;
  backgroundDataUri: string;
  displayFamily: string;
  gamertagFamily: string;
  width?: number;
  height?: number;
  scrim?: number;
}): string {
  const { board, backgroundDataUri, displayFamily, gamertagFamily, width = 1920, height = 1080, scrim = 0.45 } = o;
  const cx = width / 2;
  const leftX = cx - 460;
  let body = txt(cx, 175, 94, CYAN, "middle", displayFamily, esc(board.headline), 12);
  const y0 = 320;
  const dy = 113;
  board.rows.slice(0, MAX_ROWS).forEach((r, i) => {
    const y = y0 + i * dy;
    const line =
      `<tspan fill="${DIM}">${i + 1}. </tspan>` +
      `<tspan fill="${WHITE}">${esc(clip(r.name))}</tspan>` +
      `<tspan fill="${LIME}">  ${r.points} pts</tspan>` +
      `<tspan fill="${DIM}"> · ${r.raids} raids</tspan>`;
    body += txt(leftX, y, 52, WHITE, "start", gamertagFamily, line, 7);
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"` +
    ` width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<image x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice" xlink:href="${esc(backgroundDataUri)}"/>` +
    `<rect width="${width}" height="${height}" fill="#000000" fill-opacity="${scrim}"/>` +
    body +
    `</svg>`
  );
}

const DISPLAY_FAMILY = "Animals are like people";
const GAMERTAG_FAMILY = "Patrick Hand";

/** The subset of `node:fs` `renderOutroBoardPng` needs, so tests can inject a fake. */
export type ReadFileFsLike = { readFileSync: (p: string) => Buffer };

export type ResvgCtor = new (
  svg: string,
  opts: {
    background: string;
    fitTo: { mode: "width"; value: number };
    font: { fontFiles: string[]; defaultFontFamily: string; loadSystemFonts: false };
  },
) => { render: () => { asPng: () => Buffer } };

/**
 * Rasterize the outro board to a PNG Buffer (1920x1080 by default). Loads BOTH fonts explicitly
 * (system fonts off) so the bundled .ttf families render deterministically. DI'd fs + Resvg.
 */
export function renderOutroBoardPng(
  o: {
    board: OutroBoard;
    backgroundPath: string;
    displayFontPath: string;
    gamertagFontPath: string;
    width?: number;
    height?: number;
    scrim?: number;
  },
  deps: { fsImpl?: ReadFileFsLike; ResvgImpl?: ResvgCtor } = {},
): Buffer {
  const { board, backgroundPath, displayFontPath, gamertagFontPath, width = 1920, height = 1080, scrim = 0.45 } = o;
  const { fsImpl = fs, ResvgImpl = Resvg as unknown as ResvgCtor } = deps;
  const backgroundDataUri = `data:image/png;base64,${fsImpl.readFileSync(backgroundPath).toString("base64")}`;
  const svg = buildOutroBoardSvg({
    board,
    backgroundDataUri,
    displayFamily: DISPLAY_FAMILY,
    gamertagFamily: GAMERTAG_FAMILY,
    width,
    height,
    scrim,
  });
  const resvg = new ResvgImpl(svg, {
    background: INK,
    fitTo: { mode: "width", value: width },
    font: { fontFiles: [displayFontPath, gamertagFontPath], defaultFontFamily: DISPLAY_FAMILY, loadSystemFonts: false },
  });
  return resvg.render().asPng();
}
