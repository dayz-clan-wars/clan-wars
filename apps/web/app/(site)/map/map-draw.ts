import type * as L from "leaflet";
import type { PinIcon } from "@factions/domain";
import { CANVAS_PX, MAX_ZOOM, worldToLatLng } from "@/lib/map-projection";
import { DIM_AFTER_MS, PIN_ICON_GLYPHS, PIN_ICON_LABELS, fixAge } from "@/lib/map-copy";
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
  rust: () => token("--color-rust", "#8c3a22"),
  olive: () => token("--color-olive", "#8fa36a"),
  muted: () => token("--color-muted", "#8a857c"),
};

/** Leaflet's own pane sits at 400; travel points go under everything else at 350. */
export const TRAVEL_PANE = "travel";

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
  /** Clanmates dim past a day, and a tick can cross that boundary as easily as a fetch can. */
  dim?: L.CircleMarker;
  /** The age string last written, so an unchanged label is left alone entirely. */
  last?: string;
  wasStale?: boolean;
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
};

/** Rewrite the age-bearing labels in place. Touches nothing else on the map. */
export function refreshAges(ages: AgeLabel[], now: number): void {
  const at = new Date(now);
  for (const a of ages) {
    if (a.dim) {
      const stale = now - a.at.getTime() > DIM_AFTER_MS;
      if (stale !== a.wasStale) {
        a.wasStale = stale;
        a.dim.setStyle({ opacity: stale ? 0.4 : 1, fillOpacity: stale ? 0.2 : 0.5 });
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

export function drawYou({ L, group, pt, data, now, ages }: Ctx): void {
  const fix = data.you.fix;
  // Nothing at all when the log has never placed this character — better an
  // absent dot than one at the origin.
  if (!fix) return;
  const text = (age: string) => `You · ${escapeHtml(age)}`;
  const age = fixAge(fix.at, new Date(now));
  const dot = L.circleMarker(pt(fix.x, fix.z), { radius: 7, color: COLOURS.gold(), weight: 2, fillColor: COLOURS.gold(), fillOpacity: 0.6 })
    .bindTooltip(text(age));
  dot.addTo(group);
  ages.push({ at: fix.at, layer: dot, tooltip: text, last: age });
}

export function drawBase({ L, group, pt, data }: Ctx): void {
  const base = data.base;
  if (!base) return;
  // CRS.Simple is linear, so metres scale uniformly: one world metre is
  // `CANVAS_PX / size` pixels, and a pixel at MAX_ZOOM is `1 / 2**MAX_ZOOM`
  // of a latlng unit.
  const radius = (base.radiusM * (CANVAS_PX / data.world.size)) / 2 ** MAX_ZOOM;
  L.circle(pt(base.x, base.z), { radius, color: COLOURS.gold(), weight: 2, fill: false }).addTo(group);
  L.circleMarker(pt(base.x, base.z), { radius: 5, color: COLOURS.gold(), weight: 2, fillColor: COLOURS.gold(), fillOpacity: 1 })
    .bindTooltip("Your base")
    .addTo(group);
}

export function drawClanmates({ L, group, pt, data, now, ages }: Ctx): void {
  for (const m of data.clanmates) {
    const stale = now - m.fix.at.getTime() > DIM_AFTER_MS;
    const tag = escapeHtml(m.gamertag);
    const dot = L.circleMarker(pt(m.fix.x, m.fix.z), {
      radius: 6, color: COLOURS.ink(), weight: 2, fillColor: COLOURS.ink(),
      // Past a day the dot is dimmed rather than dropped: "here a day ago" is
      // still worth knowing, and a vanished clanmate reads as a bug.
      opacity: stale ? 0.4 : 1, fillOpacity: stale ? 0.2 : 0.5,
    });
    // The permanent tag is the gamertag alone and never changes; the age lives
    // in the popup, which is the only part a tick rewrites.
    dot.bindTooltip(tag, { permanent: true, direction: "right", className: "cw-map-tag", opacity: stale ? 0.4 : 1 });
    const text = (age: string) => `${tag} · ${escapeHtml(age)}`;
    const age = fixAge(m.fix.at, new Date(now));
    dot.bindPopup(text(age));
    dot.addTo(group);
    ages.push({ at: m.fix.at, layer: dot, popup: text, dim: dot, last: age, wasStale: stale });
  }
}

export function drawIntruders({ L, group, pt, data, now, ages }: Ctx): void {
  for (const i of data.intruders) {
    const text = (age: string) => `${escapeHtml(i.gamertag)} · ${Math.round(i.distanceM)} m · ${escapeHtml(age)}`;
    const age = fixAge(i.lastSeenAt, new Date(now));
    const dot = L.circleMarker(pt(i.x, i.z), { radius: 6, color: COLOURS.rust(), weight: 2, dashArray: "3 3", fill: false })
      .bindTooltip(text(age));
    dot.addTo(group);
    ages.push({ at: i.lastSeenAt, layer: dot, tooltip: text, last: age });
  }
}

export function drawPublicBases({ L, group, pt, data }: Ctx): void {
  for (const b of data.publicBases) {
    // Flags are 2:1; 28x14 keeps them legible without swamping the dots.
    const icon = b.texture
      ? L.divIcon({ className: "cw-map-flag", html: `<img src="/${escapeHtml(flagImagePath(b.texture))}" alt="" width="28" height="14" />`, iconSize: [28, 14], iconAnchor: [14, 7] })
      : L.divIcon({ className: "cw-map-flag", html: `<span class="block h-3 w-3 rounded-sm" style="background:${COLOURS.muted()}"></span>`, iconSize: [12, 12], iconAnchor: [6, 6] });
    L.marker(pt(b.x, b.z), { icon, keyboard: false }).bindTooltip("Public base").addTo(group);
  }
}

export function drawPins({ L, group, pt, data, now, ages }: Ctx): void {
  for (const p of data.pins) {
    const label = PIN_ICON_LABELS[p.icon];
    const glyph = PIN_ICON_GLYPHS[p.icon];
    const note = p.note ? `<p class="mt-1 text-ink-2">${escapeHtml(p.note)}</p>` : "";
    const text = (age: string) =>
      `<div class="min-w-[12rem] text-sm">` +
        `<p class="font-display text-ink">${glyph} ${escapeHtml(label)}</p>${note}` +
        `<p class="mt-1 text-xs text-muted">${escapeHtml(p.by)} · ${escapeHtml(age)}</p>` +
        `<form method="post" action="/api/map/pin/delete" class="mt-2">` +
          `<input type="hidden" name="id" value="${p.id}" />` +
          `<button type="submit" class="min-h-[44px] rounded-md border border-rust px-3 font-display text-ink">Delete</button>` +
        `</form>` +
      `</div>`;
    const age = fixAge(p.at, new Date(now));
    const marker = L.marker(pt(p.x, p.z), {
      icon: L.divIcon({ className: "cw-map-pin", html: `<span class="text-lg leading-none">${glyph}</span>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
      keyboard: false,
    }).bindPopup(text(age));
    marker.addTo(group);
    ages.push({ at: p.at, layer: marker, popup: text, last: age });
  }
}

export function drawTravel({ L, group, pt, data }: Ctx): void {
  const olive = COLOURS.olive();
  for (const t of data.travelPoints) {
    L.circleMarker(pt(t.x, t.z), { pane: TRAVEL_PANE, radius: 3, color: olive, weight: 1, fillColor: olive, fillOpacity: 0.7, interactive: false }).addTo(group);
  }
  L.circleMarker(pt(data.hub.x, data.hub.z), { pane: TRAVEL_PANE, radius: 6, color: olive, weight: 2, fillColor: olive, fillOpacity: 0.9 })
    .bindTooltip("Fast Travel Hub")
    .addTo(group);
}

/** A 1 km grid, so a grid ref read off the bottom bar has visible cells to sit in. */
export function drawGrid(L: typeof import("leaflet"), group: L.LayerGroup, pt: (x: number, z: number) => L.LatLng, size: number): void {
  const style = { color: COLOURS.muted(), weight: 1, opacity: 0.25, interactive: false } as const;
  for (let v = 0; v <= size; v += 1000) {
    L.polyline([pt(v, 0), pt(v, size)], style).addTo(group);
    L.polyline([pt(0, v), pt(size, v)], style).addTo(group);
  }
}
