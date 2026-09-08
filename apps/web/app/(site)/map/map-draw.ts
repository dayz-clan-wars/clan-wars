import type * as L from "leaflet";
import type { PinIcon } from "@factions/domain";
import { CANVAS_PX, MAX_ZOOM, gridRef, worldToLatLng } from "@/lib/map-projection";
import { DIM_AFTER_MS, PIN_ICON_LABELS, expiresIn, fixAge } from "@/lib/map-copy";
import {
  AGE_OPACITY, ICON, type AgeStep, type Palette, ageStep,
  baseIcon, clanmateIcon, hubIcon, intruderIcon, pinGlyph, pinIcon, publicBaseIcon, travelIcon, youIcon,
} from "@/lib/map-icons";
import { flagImagePath } from "@/src/flag-images";

/**
 * The pure drawing half of the map. Split out of map-view.tsx, which owns the
 * Leaflet lifecycle, the fetch loop and the switches — these functions take a
 * layer group and put shapes in it, and know nothing else.
 *
 * ⚠️ THE ONE RULE FOR EVERYTHING IN THIS FILE: no coordinate is ever written
 * into a tooltip, a popup or a label. Ages, names, distances and grid refs
 * only (spec §10.3). A dot's position is already on the screen; its numbers
 * are what someone screenshots and pastes into another clan's Discord.
 */

/** The wire shape of `MapState`: what `GET /api/map/state` produces, dates as ISO strings. */
export type WireFix = { x: number; z: number; at: string };
export type WireState = {
  world: { size: number };
  you: { gamertag: string; fix: WireFix | null };
  base: { x: number; z: number; radiusM: number; kind: "clan" | "solo" } | null;
  clanmates: { dayzId: string; gamertag: string; fix: WireFix }[];
  intruders: { gamertag: string; x: number; z: number; lastSeenAt: string; distanceM: number }[];
  publicBases: { x: number; z: number; texture: string | null }[];
  pins: { id: number; x: number; z: number; icon: PinIcon; note: string | null; by: string; at: string; expiresAt: string }[];
  travelPoints: readonly { x: number; z: number }[];
  hub: { x: number; z: number };
  layers: { base: boolean; clanmates: boolean; intruders: boolean; pins: boolean };
};

/** The same thing with real `Date`s — what everything below reads. */
export type MapData = Omit<WireState, "you" | "clanmates" | "intruders" | "pins"> & {
  you: { gamertag: string; fix: { x: number; z: number; at: Date } | null };
  clanmates: { dayzId: string; gamertag: string; fix: { x: number; z: number; at: Date } }[];
  intruders: { gamertag: string; x: number; z: number; lastSeenAt: Date; distanceM: number }[];
  pins: { id: number; x: number; z: number; icon: PinIcon; note: string | null; by: string; at: Date; expiresAt: Date }[];
};

/** JSON never carries a Date. Every `at` comes back as an ISO string; put them back. */
export function parseState(raw: WireState): MapData {
  return {
    ...raw,
    you: { gamertag: raw.you.gamertag, fix: raw.you.fix ? { x: raw.you.fix.x, z: raw.you.fix.z, at: new Date(raw.you.fix.at) } : null },
    clanmates: raw.clanmates.map((m) => ({ ...m, fix: { x: m.fix.x, z: m.fix.z, at: new Date(m.fix.at) } })),
    intruders: raw.intruders.map((i) => ({ ...i, lastSeenAt: new Date(i.lastSeenAt) })),
    pins: raw.pins.map((p) => ({ ...p, at: new Date(p.at), expiresAt: new Date(p.expiresAt) })),
  };
}

/**
 * `L.divIcon`, `bindTooltip` and `bindPopup` all take raw HTML. Gamertags and
 * pin notes are typed by players, so every one of them goes through this.
 *
 * ⚠️ Does not escape `'`. Use only in text nodes and double-quoted
 * attributes — never in a single-quoted attribute (`style='…'`), which this
 * would not make safe.
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

/**
 * The palette, read off the same CSS custom properties `@theme` emits, so the
 * map cannot drift from globals.css the way two hardcoded lists would. The
 * fallbacks are only for a context where `getComputedStyle` gives nothing.
 */
export function token(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v === "" ? fallback : v;
}

export const COLOURS = {
  gold: () => token("--color-gold", "#d9a03c"),
  ink: () => token("--color-ink", "#e8e2d4"),
  ink2: () => token("--color-ink-2", "#b5afa4"),
  rust: () => token("--color-rust", "#8c3a22"),
  olive: () => token("--color-olive", "#8fa36a"),
  muted: () => token("--color-muted", "#8a857c"),
  /** Every marker's ground: the one value the terrain never uses. */
  frame: () => token("--color-frame", "#0b0b0a"),
  rule2: () => token("--color-rule-2", "#2a2825"),
};

/** The marker builders' palette, read once per draw. */
export function palette(): Palette {
  return { gold: COLOURS.gold(), ink: COLOURS.ink(), ink2: COLOURS.ink2(), rust: COLOURS.rust(), olive: COLOURS.olive(), frame: COLOURS.frame(), rule2: COLOURS.rule2() };
}

/** Leaflet's own pane sits at 400; travel points go under everything else at 350. */
export const TRAVEL_PANE = "travel";
/** Below this zoom a travel point is a dot; from it up, a glyph chip. Set as a class on the container. */
export const TRAVEL_CHIP_ZOOM = 3;
export const FAR_CLASS = "cw-far";

/** A marker whose chip is one of the strings in map-icons.ts. Never a white box: `.cw-mk` in globals.css. */
function chipIcon(L: typeof import("leaflet"), html: string, box: { size: readonly [number, number]; anchor: readonly [number, number]; tooltipAnchor: readonly [number, number] }, className: string): L.DivIcon {
  return L.divIcon({ className: `cw-mk ${className}`, html, iconSize: [...box.size], iconAnchor: [...box.anchor], tooltipAnchor: [...box.tooltipAnchor] });
}

/**
 * One label whose text is an age, kept so the 30 s tick can rewrite it.
 *
 * ⚠️ This registry is why the age tick does NOT rebuild the layers. Clearing
 * and redrawing every group each tick tore down whatever was open: a player
 * halfway through reading a pin note lost the note and its Delete button
 * within 30 seconds, and 209 travel markers were rebuilt for nothing. So the
 * structural draw happens on new DATA only, and a tick calls `refreshAges`,
 * which rewrites content in place — Leaflet's `setTooltipContent` and
 * `setPopupContent` update an OPEN tooltip or popup without closing it.
 */
export type AgeLabel = {
  at: Date;
  layer: L.Layer;
  /** Renders the tooltip text for a given age string. */
  tooltip?: (age: string) => string;
  /** Renders the popup HTML for a given age string. */
  popup?: (age: string) => string;
  /** Clanmates step down with age, and a tick can cross a step as easily as a fetch can. */
  dim?: L.Marker;
  /** The age string last written, so an unchanged label is left alone entirely. */
  last?: string;
  step?: AgeStep;
};

export type Ctx = {
  L: typeof import("leaflet");
  group: L.LayerGroup;
  /** World metres → a latlng on this pyramid. */
  pt: (x: number, z: number) => L.LatLng;
  data: MapData;
  now: number;
  /** Every age-bearing label the draw puts on the map, for `refreshAges`. */
  ages: AgeLabel[];
  p: Palette;
};

/**
 * Apply an age step to a marker and its tag: opacity on both, and `cw-stale`
 * on the chip so CSS hollows the core. A class and a style, never a new
 * icon — `setIcon` would rebuild the element under an open popup.
 */
function applyStep(marker: L.Marker, step: AgeStep): void {
  const opacity = AGE_OPACITY[step];
  const stale = step === "stale";
  marker.setOpacity(opacity);
  marker.getTooltip()?.setOpacity(opacity);
  const el = marker.getElement();
  if (el) {
    el.classList.toggle("cw-stale", stale);
  } else {
    // Not on the map yet — the first draw runs before the group is added, and
    // a switched-off layer has no elements at all. Leaflet builds the element
    // from the icon's className when it does add the marker, so the class
    // goes there. The icon is this marker's own, never the shared travel one.
    const icon = marker.options.icon;
    if (icon) {
      const cls = (icon.options.className ?? "").replace(/\s*\bcw-stale\b/gu, "");
      icon.options.className = stale ? `${cls} cw-stale` : cls;
    }
  }
}

/** Rewrite the age-bearing labels in place. Touches nothing else on the map. */
export function refreshAges(ages: AgeLabel[], now: number): void {
  const at = new Date(now);
  for (const a of ages) {
    if (a.dim) {
      const step = ageStep(now - a.at.getTime(), DIM_AFTER_MS);
      if (step !== a.step) {
        a.step = step;
        applyStep(a.dim, step);
      }
    }
    const age = fixAge(a.at, at);
    // "3 h ago" is still "3 h ago" for most ticks; rewriting it anyway would
    // replace an open popup's DOM twice a minute for no visible change.
    if (age === a.last) continue;
    a.last = age;
    if (a.tooltip) a.layer.setTooltipContent(a.tooltip(age));
    if (a.popup) a.layer.setPopupContent(a.popup(age));
  }
}

export function ptFor(L: typeof import("leaflet"), size: number) {
  return (x: number, z: number): L.LatLng => {
    const { lat, lng } = worldToLatLng(x, z, size);
    return L.latLng(lat, lng);
  };
}

/** The name tags: mono in the black chip, no arrow. `cw-map-tag-*` variants recolour text or edge. */
const TAG = "cw-map-tag";
/** Leaflet's tooltips default to 90%; a fresh tag is fully there, and age lowers it (never the text colour). */
const tag = (className: string, direction: "right" | "top" = "right") => ({ permanent: true, direction, opacity: 1, className: `${TAG} ${className}`.trim() });

export function drawYou({ L, group, pt, data, now, ages, p }: Ctx): void {
  const fix = data.you.fix;
  // Nothing at all when the log has never placed this character — better an
  // absent dot than one at the origin.
  if (!fix) return;
  const text = (age: string) => `You · ${escapeHtml(age)}`;
  const age = fixAge(fix.at, new Date(now));
  const marker = L.marker(pt(fix.x, fix.z), { icon: chipIcon(L, youIcon(p), ICON.you, "cw-mk-you"), keyboard: false })
    .bindTooltip(text(age), tag(`${TAG}-you`));
  marker.addTo(group);
  ages.push({ at: fix.at, layer: marker, tooltip: text, last: age });
}

export function drawBase({ L, group, pt, data, p }: Ctx): void {
  const base = data.base;
  if (!base) return;
  // CRS.Simple is linear, so metres scale uniformly: one world metre is
  // `CANVAS_PX / size` pixels, and a pixel at MAX_ZOOM is `1 / 2**MAX_ZOOM`
  // of a latlng unit.
  const radius = (base.radiusM * (CANVAS_PX / data.world.size)) / 2 ** MAX_ZOOM;
  // The watch zone is a gold dash over a black dash: a two-tone ring stays
  // visible over grey, green and road alike.
  const dash = { fill: false, dashArray: "6 6", interactive: false } as const;
  L.circle(pt(base.x, base.z), { ...dash, radius, color: p.frame, weight: 4, opacity: 0.9 }).addTo(group);
  L.circle(pt(base.x, base.z), { ...dash, radius, color: p.gold, weight: 2 }).addTo(group);
  L.marker(pt(base.x, base.z), { icon: chipIcon(L, baseIcon(p), ICON.base, "cw-mk-base"), keyboard: false })
    .bindTooltip(`Your base · ${base.radiusM} m`, tag(`${TAG}-base`, "top"))
    .addTo(group);
}

export function drawClanmates({ L, group, pt, data, now, ages, p }: Ctx): void {
  for (const m of data.clanmates) {
    const step = ageStep(now - m.fix.at.getTime(), DIM_AFTER_MS);
    const name = escapeHtml(m.gamertag);
    const marker = L.marker(pt(m.fix.x, m.fix.z), { icon: chipIcon(L, clanmateIcon(p), ICON.clanmate, "cw-mk-clanmate"), keyboard: false });
    // The permanent tag is the gamertag alone and never changes; the age lives
    // in the popup, which is the only part a tick rewrites.
    marker.bindTooltip(name, tag(""));
    const text = (age: string) => `${name} · ${escapeHtml(age)}`;
    const age = fixAge(m.fix.at, new Date(now));
    marker.bindPopup(text(age), { className: "cw-map-popup" });
    marker.addTo(group);
    // Past a day the marker is dimmed rather than dropped: "here a day ago" is
    // still worth knowing, and a vanished clanmate reads as a bug. The
    // element exists only once the marker is on the map, so the step is
    // applied after addTo.
    applyStep(marker, step);
    ages.push({ at: m.fix.at, layer: marker, popup: text, dim: marker, last: age, step });
  }
}

export function drawIntruders({ L, group, pt, data, now, ages, p }: Ctx): void {
  for (const i of data.intruders) {
    const text = (age: string) => `${escapeHtml(i.gamertag)} · ${Math.round(i.distanceM)} m · ${escapeHtml(age)}`;
    const age = fixAge(i.lastSeenAt, new Date(now));
    const marker = L.marker(pt(i.x, i.z), { icon: chipIcon(L, intruderIcon(p), ICON.intruder, "cw-mk-intruder"), keyboard: false })
      .bindTooltip(text(age), tag(`${TAG}-intruder`));
    marker.addTo(group);
    ages.push({ at: i.lastSeenAt, layer: marker, tooltip: text, last: age });
  }
}

export function drawPublicBases({ L, group, pt, data, p }: Ctx): void {
  for (const b of data.publicBases) {
    // Flags are 2:1; 28x14 keeps them legible without swamping the chips.
    const src = b.texture ? `/${escapeHtml(flagImagePath(b.texture))}` : null;
    const icon = chipIcon(L, publicBaseIcon(p, src), ICON.publicBase, "cw-mk-public");
    L.marker(pt(b.x, b.z), { icon, keyboard: false }).bindTooltip("Public base", { direction: "right", opacity: 1, className: TAG }).addTo(group);
  }
}

export function drawPins({ L, group, pt, data, now, ages, p }: Ctx): void {
  for (const pin of data.pins) {
    const label = PIN_ICON_LABELS[pin.icon];
    const note = pin.note ? `<p class="m-0 px-3.5 pt-2.5 text-[13px] leading-normal text-ink">${escapeHtml(pin.note)}</p>` : "";
    // Grid ref, never a coordinate: it is what the guide and the bottom bar speak.
    const text = (age: string) =>
      `<div class="min-w-[13rem] max-w-[16rem]">` +
        `<div class="flex items-center gap-2.5 border-b border-rule-2 px-3.5 py-3">${pinGlyph(p, pin.icon, 20)}` +
          `<span class="font-display text-[13px] uppercase tracking-[0.06em] text-ink">${escapeHtml(label)}</span>` +
          `<span class="ml-auto font-mono text-[10px] text-muted">Grid ${gridRef(pin.x, pin.z)}</span></div>${note}` +
        `<p class="m-0 px-3.5 pb-3 pt-1.5 font-mono text-[10px] text-muted">${escapeHtml(pin.by)} · ${escapeHtml(age)} · ${escapeHtml(expiresIn(pin.expiresAt, new Date(now)))}</p>` +
        `<form method="post" action="/api/map/pin/delete" class="m-0">` +
          `<input type="hidden" name="id" value="${pin.id}" />` +
          `<button type="submit" class="flex min-h-[44px] w-full items-center justify-center border-t border-rule-2 font-display text-[11px] uppercase tracking-[0.06em] text-ink shadow-[inset_0_2px_0_var(--color-rust)] hover:bg-rust/15">Delete pin</button>` +
        `</form>` +
      `</div>`;
    const age = fixAge(pin.at, new Date(now));
    const marker = L.marker(pt(pin.x, pin.z), { icon: chipIcon(L, pinIcon(p, pin.icon), ICON.pin, "cw-mk-pin"), keyboard: false })
      .bindPopup(text(age), { className: "cw-map-popup", closeButton: true });
    // The chip's frame turns gold while its popup is open.
    marker.on("popupopen", () => marker.getElement()?.classList.add("cw-open"));
    marker.on("popupclose", () => marker.getElement()?.classList.remove("cw-open"));
    marker.addTo(group);
    ages.push({ at: pin.at, layer: marker, popup: text, last: age });
  }
}

export function drawTravel({ L, group, pt, data, p }: Ctx): void {
  // Dot or chip is the container's `cw-far` class, flipped on zoomend in
  // map-view.tsx — 209 markers swap form with one class, none rebuilt.
  const icon = chipIcon(L, travelIcon(p), ICON.travel, "cw-mk-travel");
  for (const t of data.travelPoints) {
    L.marker(pt(t.x, t.z), { pane: TRAVEL_PANE, icon, keyboard: false, interactive: false }).addTo(group);
  }
  L.marker(pt(data.hub.x, data.hub.z), { pane: TRAVEL_PANE, icon: chipIcon(L, hubIcon(p), ICON.hub, "cw-mk-hub"), keyboard: false })
    .bindTooltip("Fast Travel Hub", { ...tag(`${TAG}-hub`), pane: TRAVEL_PANE })
    .addTo(group);
}

/** A 1 km grid, so a grid ref read off the bottom bar has visible cells to sit in. */
export function drawGrid(L: typeof import("leaflet"), group: L.LayerGroup, pt: (x: number, z: number) => L.LatLng, size: number): void {
  const style = { color: COLOURS.frame(), weight: 1, opacity: 0.25, interactive: false } as const;
  for (let v = 0; v <= size; v += 1000) {
    L.polyline([pt(v, 0), pt(v, size)], style).addTo(group);
    L.polyline([pt(0, v), pt(size, v)], style).addTo(group);
  }
}
