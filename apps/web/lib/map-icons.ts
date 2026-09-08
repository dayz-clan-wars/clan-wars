import type { PinIcon } from "@factions/domain";

/**
 * The marker set, from `Map Markers.dc.html` (2026-09-07). The terrain tiles
 * are pale grey, soft green, orange roads and blue water: olive and ink
 * vanish on them and gold sits next to the roads. So every marker is a
 * near-black chip FIRST, and its colour lives inside the chip. The chip is
 * the same frame / rule-2 panel the rest of the site is built from.
 *
 * Everything here is a pure string builder: no Leaflet, no DOM. `map-draw.ts`
 * wraps the strings in `L.divIcon`; `map-view.tsx` renders the pin glyphs in
 * the pin sheet. The colours arrive as a `Palette` so the builders are
 * testable without `getComputedStyle`.
 *
 * ⚠️ Nothing typed by a player goes through these builders — gamertags and
 * notes live in tooltips and popups, escaped there. The only outside string
 * a builder takes is a flag image path, which the caller has escaped.
 */

export type Palette = {
  gold: string; ink: string; ink2: string; rust: string; olive: string;
  /** The chip's ground. The one value the terrain never uses. */
  frame: string;
  /** The chip's resting edge. */
  rule2: string;
};

/** Every marker's box, and where Leaflet pins it to the point. */
export const ICON = {
  you: { size: [28, 28], anchor: [14, 14], tooltipAnchor: [19, 0] },
  /** Anchored at the foot of the pole; the tag sits above the chip. */
  base: { size: [28, 28], anchor: [10, 23], tooltipAnchor: [4, -27] },
  clanmate: { size: [28, 28], anchor: [14, 14], tooltipAnchor: [19, 0] },
  intruder: { size: [28, 28], anchor: [14, 14], tooltipAnchor: [19, 0] },
  /** A 3px pole and a framed 28×14 flag beside it; anchored bottom-left, at the foot. */
  publicBase: { size: [35, 34], anchor: [1, 34], tooltipAnchor: [22, -17] },
  travel: { size: [28, 28], anchor: [14, 14], tooltipAnchor: [19, 0] },
  hub: { size: [36, 36], anchor: [18, 18], tooltipAnchor: [23, 0] },
  pin: { size: [28, 28], anchor: [14, 14], tooltipAnchor: [19, 0] },
} as const satisfies Record<string, { size: readonly [number, number]; anchor: readonly [number, number]; tooltipAnchor: readonly [number, number] }>;

/** The 28-unit chip every glyph sits in. The edge carries `cw-chip-edge` so CSS can recolour it (an open pin goes gold). */
function chip(p: Palette, accent: string, inner: string, edge = p.rule2, size = 28): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 28 28" fill="none" stroke="${accent}" stroke-width="2" stroke-linecap="square" aria-hidden="true">` +
    `<rect class="cw-chip-edge" x="1" y="1" width="26" height="26" fill="${p.frame}" stroke="${edge}"/>${inner}</svg>`;
}

/**
 * The six pin glyphs, 28-unit paths. `{a}` is the accent (gold, or rust for
 * danger), `{f}` the frame black, `{i}` the ink mark. Order and keys match
 * `PIN_ICONS`; `map-copy.test.ts` checks nothing is missing.
 */
export const PIN_GLYPHS: Record<PinIcon, string> = {
  loot: `<path d="M6 11h16v11H6zM6 11l2-4h12l2 4M14 11v11M11 15h6"/>`,
  vehicle: `<path d="M5 18v-4l3-6h12l3 6v4zM5 14h18"/><circle cx="9" cy="19" r="2" fill="{f}"/><circle cx="19" cy="19" r="2" fill="{f}"/>`,
  enemy: `<path d="M4 14s4-6 10-6 10 6 10 6-4 6-10 6S4 14 4 14z"/><circle cx="14" cy="14" r="3" fill="{a}"/>`,
  meet: `<path d="M14 23V5M9 8l5-3 5 3-5 3z" fill="{a}"/><path d="M8 23h12"/>`,
  danger: `<path d="M14 5l10 17H4z" fill="{a}"/><path d="M14 12v5M14 19.5v.5" stroke="{i}"/>`,
  note: `<path d="M7 5h10l4 4v14H7zM17 5v4h4M10 14h8M10 18h8"/>`,
};

/** Danger is the one rust pin; everything else you drop is gold. */
export function pinAccent(p: Palette, icon: PinIcon): string {
  return icon === "danger" ? p.rust : p.gold;
}

function glyphMarkup(p: Palette, icon: PinIcon): string {
  return PIN_GLYPHS[icon].replaceAll("{a}", pinAccent(p, icon)).replaceAll("{f}", p.frame).replaceAll("{i}", p.ink);
}

/** A pin on the map: the glyph in its chip. */
export function pinIcon(p: Palette, icon: PinIcon): string {
  return chip(p, pinAccent(p, icon), glyphMarkup(p, icon));
}

/** The bare glyph, no chip — for the pin sheet's radios and the popup head. */
export function pinGlyph(p: Palette, icon: PinIcon, size = 22): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 28 28" fill="none" stroke="${pinAccent(p, icon)}" stroke-width="2.4" stroke-linecap="square" aria-hidden="true">${glyphMarkup(p, icon)}</svg>`;
}

/** You: a gold reticle on a black disc. The ticks make it the one marker found instantly. */
export function youIcon(p: Palette): string {
  return `<svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="${p.gold}" stroke-width="2" stroke-linecap="square" aria-hidden="true">` +
    `<circle cx="14" cy="14" r="13" fill="${p.frame}" stroke="${p.frame}"/><circle cx="14" cy="14" r="4" fill="${p.gold}" stroke="none"/>` +
    `<circle cx="14" cy="14" r="9"/><path d="M14 1v4M14 23v4M1 14h4M23 14h4"/></svg>`;
}

/** Your base: a gold flag in a gold-framed chip. */
export function baseIcon(p: Palette): string {
  return chip(p, p.gold, `<path d="M10 23V5M10 6h9l-2 3.5 2 3.5h-9" fill="${p.gold}"/>`, p.gold);
}

/**
 * A clanmate: an ink core in a black disc. Both cores are in the markup and
 * CSS shows one — past a day the root gains `cw-stale`, the core hollows and
 * the whole thing drops to 55%. A tick toggles a class; it never rebuilds.
 */
export function clanmateIcon(p: Palette): string {
  return `<svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="9" fill="${p.frame}"/>` +
    `<circle class="cw-core-solid" cx="14" cy="14" r="5" fill="${p.ink}"/>` +
    `<circle class="cw-core-hollow" cx="14" cy="14" r="5" fill="none" stroke="${p.ink}" stroke-width="2"/></svg>`;
}

/** An intruder: a solid rust diamond with an ink mark, on black, with a slow pulse ring. */
export function intruderIcon(p: Palette): string {
  return `<span class="cw-ring" style="border-color:${p.rust}"></span>` +
    `<svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><path d="M14 1l13 13-13 13L1 14z" fill="${p.frame}"/>` +
    `<path d="M14 5l9 9-9 9-9-9z" fill="${p.rust}"/><path d="M14 9.5v5.5M14 17.5v1.5" stroke="${p.ink}" stroke-width="2.2"/></svg>`;
}

/**
 * A public base: the clan's real flag, black-framed, beside a black pole so
 * the foot marks the pole. No flag: a dashed empty one. `src` is already
 * escaped by the caller.
 */
export function publicBaseIcon(p: Palette, src: string | null): string {
  const flag = src
    ? `<span style="border:2px solid ${p.frame};line-height:0;background:${p.frame}"><img src="${src}" alt="" width="28" height="14" style="object-fit:cover;display:block"></span>`
    : `<span style="width:32px;height:18px;border:2px solid ${p.frame};background:${p.frame}99;box-sizing:border-box;display:block"><span style="display:block;width:100%;height:100%;border:1px dashed ${p.ink2};box-sizing:border-box"></span></span>`;
  return `<span style="display:flex;align-items:flex-start"><span style="width:3px;height:34px;background:${p.frame};flex:none"></span>${flag}</span>`;
}

/**
 * A travel point. Both forms are in the markup: below zoom 3 a black 10px
 * dot with an olive core, from zoom 3 up the glyph in a chip so a player can
 * see the point before walking. The container's `cw-far` class picks.
 *
 * The data carries no kind (outhouse / well / bus stop), so every point wears
 * the same roofed glyph.
 */
export function travelIcon(p: Palette): string {
  return `<svg class="cw-tp-dot" width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="5" fill="${p.frame}"/><circle cx="14" cy="14" r="2.5" fill="${p.olive}"/></svg>` +
    `<span class="cw-tp-chip">${chip(p, p.olive, `<path d="M6 13l8-7 8 7v9H6zM11 22v-6h6v6"/>`)}</span>`;
}

/** The Hub: a black hexagon with an H, twice a point's size, at every zoom. */
export function hubIcon(p: Palette): string {
  return `<svg width="36" height="36" viewBox="0 0 36 36" fill="none" stroke="${p.olive}" stroke-width="2" aria-hidden="true">` +
    `<path d="M18 2l14 8v16l-14 8L4 26V10z" fill="${p.frame}"/><path d="M12 11v14M24 11v14M12 18h12" stroke-linecap="square"/></svg>`;
}

/**
 * The layers panel's row icons: the marker's own glyph, bare, 20px, so the
 * panel is a legend. Keys are `LAYER_LABELS`'s.
 */
export function layerIcon(p: Palette, key: string, size = 20): string {
  const open = (extra = "") => `<svg width="${size}" height="${size}" viewBox="0 0 28 28" fill="none" stroke-width="2.4" stroke-linecap="square" aria-hidden="true"${extra}>`;
  switch (key) {
    case "you": return `${open(` stroke="${p.gold}"`)}<circle cx="14" cy="14" r="4" fill="${p.gold}" stroke="none"/><circle cx="14" cy="14" r="9"/><path d="M14 1v4M14 23v4M1 14h4M23 14h4"/></svg>`;
    case "base": return `${open(` stroke="${p.gold}"`)}<path d="M10 25V3M10 4h11l-2.5 4 2.5 4H10" fill="${p.gold}"/></svg>`;
    case "clanmates": return `${open()}<circle cx="14" cy="14" r="8" fill="${p.ink}"/></svg>`;
    case "intruders": return `${open()}<path d="M14 3l11 11-11 11L3 14z" fill="${p.rust}"/><path d="M14 9v6M14 18v1.5" stroke="${p.ink}"/></svg>`;
    case "publicBases": return `${open(` stroke="${p.ink}"`)}<path d="M7 26V3M7 4h14v9H7"/></svg>`;
    case "pins": return `${open(` stroke="${p.gold}"`)}<path d="M14 25V3M8 6l6-3 6 3-6 3z" fill="${p.gold}"/><path d="M7 25h14"/></svg>`;
    case "travel": return `${open(` stroke="${p.olive}"`)}<path d="M4 13l10-9 10 9v11H4zM10 24v-7h8v7"/></svg>`;
    default: return `${open(` stroke="${p.ink2}"`)}<path d="M3 3h22v22H3zM3 14h22M14 3v22"/></svg>`;
  }
}

/**
 * Three age steps, not a gradient: fresh, today, stale. Stale never goes
 * below 55% — on light terrain a 40% marker is gone.
 */
export const AGE_OPACITY = { fresh: 1, today: 0.8, stale: 0.55 } as const;
export type AgeStep = keyof typeof AGE_OPACITY;

export function ageStep(ageMs: number, dimAfterMs: number): AgeStep {
  if (ageMs > dimAfterMs) return "stale";
  if (ageMs > 3_600_000) return "today";
  return "fresh";
}
