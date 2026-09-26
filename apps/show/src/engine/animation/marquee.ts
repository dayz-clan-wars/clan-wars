import fs from "node:fs";
import { Resvg } from "@resvg/resvg-js";

// Ported from KOTH bot/src/animation/marquee.js at a5ef8e7, typed. `buildMarqueeItems` (and its
// COMMUNITY constant and default discord invite) is dropped per the task-7 brief, replaced by
// src/cards/cards.ts's marquee-item builder in a later task.

const INK = "#0a0b0d";
const WHITE = "#f4f4f2";
const LIME = "#b4e617";
const SEP = "     ◆     "; // spaced diamond between items (leading, so tiled copies read continuously)
const FRAME_W = 1920; // the strip is padded to at least this wide so two tiled copies always cover the frame

/** Every string drawn into an SVG must be XML-escaped (global-context.md). */
const esc = (s: string): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One cycle of ticker text. Leads with the separator so a repeated/tiled copy joins seamlessly. */
export function cycleText(items: string[]): string {
  return SEP + items.join(SEP);
}

/**
 * The strip SVG at an EXPLICIT pixel width (the caller measures the real text width so the strip is
 * tight, no empty tail). Left-anchored text starting at x=0; the ink bar fills the whole width. Pure.
 */
export function buildStripSvg(o: { text: string; width: number; height?: number; family: string; fontSize?: number }): {
  svg: string;
  width: number;
} {
  const { text, width, height = 90, family, fontSize } = o;
  const fs2 = fontSize ?? Math.round(height * 0.5);
  const y = Math.round(height * 0.68);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="${INK}" fill-opacity="0.82"/>` +
    `<text x="0" y="${y}" font-size="${fs2}" fill="${WHITE}" stroke="${LIME}" stroke-width="1"` +
    ` paint-order="stroke" text-anchor="start" font-family="${family}">${esc(text)}</text>` +
    `</svg>`;
  return { svg, width };
}

export type ResvgCtor = new (
  svg: string,
  opts: {
    background: string;
    fitTo?: { mode: "height"; value: number };
    font: { fontFiles: string[]; defaultFontFamily: string; loadSystemFonts: false };
  },
) => { render: () => { asPng: () => Buffer }; innerBBox?: () => { x: number; width: number } | null };

/** Measured pixel advance of `text` (x=0 -> right edge of last glyph), or null when resvg can't measure (tests). */
function measurePeriod(
  ResvgImpl: ResvgCtor,
  o: { text: string; fontSize: number; family: string; fontPath: string },
): number | null {
  const { text, fontSize, family, fontPath } = o;
  try {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="120000" height="${fontSize * 2}">` +
      `<text x="0" y="${fontSize}" font-size="${fontSize}" font-family="${family}">${esc(text)}</text></svg>`;
    const r = new ResvgImpl(svg, {
      background: "rgba(0,0,0,0)",
      font: { fontFiles: [fontPath], defaultFontFamily: family, loadSystemFonts: false },
    });
    if (typeof r.innerBBox !== "function") return null;
    const b = r.innerBBox();
    if (!b || !(b.width > 0)) return null;
    return (b.x || 0) + b.width;
  } catch {
    return null;
  }
}

export type WriteFileFsLike = { writeFileSync: (p: string, data: Buffer) => void };

/**
 * Rasterize the ticker strip to a PNG at outPath. The returned `width` is the exact PNG width and is
 * the compositor's tiling PERIOD: two copies spaced by it scroll seamlessly with no gap and never
 * blank. We MEASURE the real rendered text width (resvg innerBBox) so the strip is tight, an earlier
 * character-count estimate left a big empty (black) tail each cycle. Padded (whole extra cycles) to
 * at least the frame width so two tiled copies always cover the screen. Returns { width, height }.
 */
export function buildMarqueePng(
  deps: { ResvgImpl?: ResvgCtor; fsImpl?: WriteFileFsLike } = {},
  o: { items: string[]; height?: number; family: string; fontPath: string; outPath: string },
): { width: number; height: number } {
  const { ResvgImpl = Resvg as unknown as ResvgCtor, fsImpl = fs } = deps;
  const { items, height = 90, family, fontPath, outPath } = o;
  const fontSize = Math.round(height * 0.5);
  let text = cycleText(items);
  let period = measurePeriod(ResvgImpl, { text, fontSize, family, fontPath });
  if (period != null) {
    // repeat whole cycles until the strip is at least the frame width (so two tiled copies cover it)
    let guard = 0;
    while (period !== null && period < FRAME_W && guard++ < 64) {
      text += cycleText(items);
      period = measurePeriod(ResvgImpl, { text, fontSize, family, fontPath });
    }
  }
  const width = period != null ? Math.ceil(period) : Math.max(1, Math.ceil(text.length * fontSize * 0.55));
  const { svg } = buildStripSvg({ text, width, height, family, fontSize });
  const resvg = new ResvgImpl(svg, {
    background: "rgba(0,0,0,0)",
    fitTo: { mode: "height", value: height },
    font: { fontFiles: [fontPath], defaultFontFamily: family, loadSystemFonts: false },
  });
  fsImpl.writeFileSync(outPath, resvg.render().asPng());
  return { width, height };
}
