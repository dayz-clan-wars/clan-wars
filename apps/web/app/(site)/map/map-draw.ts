import type * as L from "leaflet";
import type { PinIcon } from "@factions/domain";
import { CANVAS_PX, MAX_ZOOM, gridRef, gridRefKey, worldToLatLng } from "@/lib/map-projection";
import { DIM_AFTER_MS, PIN_ICON_LABELS, SEARCH_COPY, expiresIn, fixAge, tierLabel } from "@/lib/map-copy";
import { rulerSummary, type RulerPoint } from "@/lib/map-ruler";
import { ALWAYS_DRAWN, LOOT_MIN_ZOOM, WORLD_MIN_ZOOM, isDense, type WorldItem } from "@/lib/world-layers";
import { markerTitle } from "@/lib/map-labels";
import { markerKey } from "@/lib/map-roster";
import { popupOptions } from "@/lib/map-motion";
import {
  AGE_OPACITY, ICON, type AgeStep, type Palette, ageStep,
  baseIcon, bountyIcon, clanmateIcon, intruderIcon, pinGlyph, pinIcon, publicBaseIcon, travelIcon, worldAccent, worldIcon, youIcon,
} from "@/lib/map-icons";

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
  publicBases: { x: number; z: number }[];
  pins: { id: number; x: number; z: number; icon: PinIcon; note: string | null; by: string | null; at: string; expiresAt: string }[];
  bounties: { gamertag: string; reason: string; fix: WireFix }[];
  travelPoints: readonly { x: number; z: number }[];
  hub: { x: number; z: number };
  layers: { base: boolean; clanmates: boolean; intruders: boolean; pins: boolean };
};

/** The same thing with real `Date`s — what everything below reads. */
export type MapData = Omit<WireState, "you" | "clanmates" | "intruders" | "pins" | "bounties"> & {
  you: { gamertag: string; fix: { x: number; z: number; at: Date } | null };
  clanmates: { dayzId: string; gamertag: string; fix: { x: number; z: number; at: Date } }[];
  intruders: { gamertag: string; x: number; z: number; lastSeenAt: Date; distanceM: number }[];
  pins: { id: number; x: number; z: number; icon: PinIcon; note: string | null; by: string | null; at: Date; expiresAt: Date }[];
  bounties: { gamertag: string; reason: string; fix: { x: number; z: number; at: Date } }[];
};

/** JSON never carries a Date. Every `at` comes back as an ISO string; put them back. */
export function parseState(raw: WireState): MapData {
  return {
    ...raw,
    you: { gamertag: raw.you.gamertag, fix: raw.you.fix ? { x: raw.you.fix.x, z: raw.you.fix.z, at: new Date(raw.you.fix.at) } : null },
    clanmates: raw.clanmates.map((m) => ({ ...m, fix: { x: m.fix.x, z: m.fix.z, at: new Date(m.fix.at) } })),
    intruders: raw.intruders.map((i) => ({ ...i, lastSeenAt: new Date(i.lastSeenAt) })),
    pins: raw.pins.map((p) => ({ ...p, at: new Date(p.at), expiresAt: new Date(p.expiresAt) })),
    bounties: raw.bounties.map((b) => ({ ...b, fix: { x: b.fix.x, z: b.fix.z, at: new Date(b.fix.at) } })),
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
  /** Rust for a mark (3:1 on the frame). --color-rust is edges only; the map draws no edge in it. */
  rust2: () => token("--color-rust-2", "#d4623a"),
  olive: () => token("--color-olive", "#8fa36a"),
  military: () => token("--color-military", "#e0457b"),
  muted: () => token("--color-muted", "#8a857c"),
  /** Every marker's ground: the one value the terrain never uses. */
  frame: () => token("--color-frame", "#0b0b0a"),
  rule2: () => token("--color-rule-2", "#2a2825"),
};

/** The marker builders' palette, read once per draw. */
export function palette(): Palette {
  return { gold: COLOURS.gold(), ink: COLOURS.ink(), ink2: COLOURS.ink2(), rust2: COLOURS.rust2(), olive: COLOURS.olive(), frame: COLOURS.frame(), rule2: COLOURS.rule2(), military: COLOURS.military() };
}

/** Leaflet's own pane sits at 400; travel points go under everything else at 350. */
export const TRAVEL_PANE = "travel";
/**
 * Travel points are drawn from this zoom up, and only those in view. Below it
 * the layer is empty: 2,189 sheds on a phone's whole-map view were a marker
 * per few pixels and the slowest thing on the page. 4 is past every screen's
 * zoom floor (a 1920 px desktop's is 3), so "zoomed in" means it everywhere.
 */
export const TRAVEL_MIN_ZOOM = 4;
/** How far past the visible edge to draw, as a fraction of the view, so a short pan shows sheds before the redraw lands. */
export const TRAVEL_VIEW_PAD = 0.25;

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
 * within 30 seconds, and 2,189 travel markers were rebuilt for nothing. So the
 * structural draw happens on new DATA only, and a tick calls `refreshAges`,
 * which rewrites content in place — Leaflet's `setTooltipContent` and
 * `setPopupContent` update an OPEN tooltip or popup without closing it.
 */
export type AgeLabel = {
  at: Date;
  layer: L.Layer;
  /** Renders the tooltip text for a given age string. */
  tooltip?: (age: string) => string;
  /**
   * Renders the popup HTML for a given age string at a given instant.
   * ⚠️ `now` is not redundant with `age`: a pin's popup also says when it
   * expires, and an expiry closed over the draw-time clock never moved — the
   * pins layer is rebuilt only when the pins change, so "expires in 6 d" stood
   * the day before the pin went, beside an age that did move.
   */
  popup?: (age: string, now: Date) => string;
  /** Clanmates step down with age, and a tick can cross a step as easily as a fetch can. */
  dim?: L.Marker;
  /** A marker whose title carries the age — its accessible name, which a tick must rewrite like any label. */
  title?: { marker: L.Marker; text: (age: string) => string };
  /** The age string last written, so an unchanged label is left alone entirely. */
  last?: string;
  /**
   * The popup HTML last written. Compared whole, not by age, because an
   * expiry can change while the age string does not ("3 d ago" lasts a day).
   */
  lastPopup?: string;
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
  /**
   * This layer's markers by `markerKey`: what a list row and a remembered open
   * popup find their marker through. Cleared with the layer's group.
   */
  index: Map<string, L.Marker>;
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

/**
 * ⚠️ Leaflet copies `options.title` onto the icon only when it BUILDS the
 * icon, so writing the option alone leaves the accessible name at its
 * draw-time age for as long as the marker lives ("You, last seen just now",
 * hours later). Both are written: the element for now, the option for a
 * rebuild, which happens when a layer is switched off and on.
 */
function setTitle(marker: L.Marker, title: string): void {
  marker.options.title = title;
  marker.getElement()?.setAttribute("title", title);
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
    // replace an open popup's DOM twice a minute for no visible change (and
    // disarm a half-pressed Delete in it).
    const popup = a.popup?.(age, at);
    const aged = age !== a.last;
    a.last = age;
    if (aged && a.tooltip) a.layer.setTooltipContent(a.tooltip(age));
    if (popup !== undefined && popup !== a.lastPopup) {
      a.lastPopup = popup;
      a.layer.setPopupContent(popup);
    }
    if (aged && a.title) setTitle(a.title.marker, a.title.text(age));
  }
}

export function ptFor(L: typeof import("leaflet"), size: number) {
  return (x: number, z: number): L.LatLng => {
    const { lat, lng } = worldToLatLng(x, z, size);
    return L.latLng(lat, lng);
  };
}

/**
 * Every popup on this map, without exception.
 *
 * ⚠️ `cw-map-popup` is not only styling: `lib/map-popup-fit.ts` writes its fit
 * as custom properties that ONLY this class's rules read. A popup bound without
 * it is still clipped away by `.leaflet-container`'s `overflow: hidden` near the
 * world's edge — the 2026-09-12 bug, silently, for that one popup. Pinned by
 * test/map-popup-fit.test.ts.
 *
 * ⚠️ Never passed to `bindPopup` bare — always through `popupOptions(POPUP)`
 * (`lib/map-motion.ts`), which adds `autoPan` for the visitor's motion
 * preference. `POPUP` itself carries no `autoPan`, so a bare use would silently
 * animate the map under reduced motion.
 */
const POPUP = { className: "cw-map-popup", closeButton: true } as const;

/**
 * A text-only popup's body. ⚠️ `pr-11` keeps the text clear of the close
 * button, which map.css makes 44px square in the card's top-right corner; the
 * `min-h` keeps a one-line card at least as tall as that button, or the
 * button hangs off the card's foot.
 */
const POPUP_TEXT = "min-h-[44px] py-3 pl-3.5 pr-11 font-mono text-[13px] leading-normal text-ink";

/**
 * The chip's frame turns gold while its popup is open.
 *
 * ⚠️ Load-bearing for a popup near the world's edge, not decoration. A card
 * shifted further than its tip can follow has the tip hidden outright
 * (`cw-no-tip`), and then this is the only thing left saying which marker the
 * card belongs to. Every marker that binds a popup calls it.
 */
function markOpen(marker: L.Marker): void {
  marker.on("popupopen", () => marker.getElement()?.classList.add("cw-open"));
  marker.on("popupclose", () => marker.getElement()?.classList.remove("cw-open"));
}

/** The name tags: mono in the black chip, no arrow. `cw-map-tag-*` variants recolour text or edge. */
const TAG = "cw-map-tag";
/** Leaflet's tooltips default to 90%; a fresh tag is fully there, and age lowers it (never the text colour). */
const tag = (className: string, direction: "right" | "top" = "right") => ({ permanent: true, direction, opacity: 1, className: `${TAG} ${className}`.trim() });

export function drawYou({ L, group, pt, data, now, ages, index, p }: Ctx): void {
  const fix = data.you.fix;
  // Nothing at all when the log has never placed this character — better an
  // absent dot than one at the origin.
  if (!fix) return;
  const text = (age: string) => `You · ${escapeHtml(age)}`;
  const age = fixAge(fix.at, new Date(now));
  const marker = L.marker(pt(fix.x, fix.z), { icon: chipIcon(L, youIcon(p), ICON.you, "cw-mk-you"), keyboard: true, title: markerTitle.you(age) })
    .bindTooltip(text(age), tag(`${TAG}-you`));
  marker.addTo(group);
  index.set(markerKey.you(), marker);
  ages.push({ at: fix.at, layer: marker, tooltip: text, title: { marker, text: markerTitle.you }, last: age });
}

export function drawBase({ L, group, pt, data, index, p }: Ctx): void {
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
  const marker = L.marker(pt(base.x, base.z), { icon: chipIcon(L, baseIcon(p), ICON.base, "cw-mk-base"), keyboard: true, title: markerTitle.base(base.x, base.z, base.radiusM) })
    .bindTooltip(`Your base · ${base.radiusM} m`, tag(`${TAG}-base`, "top"));
  marker.addTo(group);
  index.set(markerKey.base(), marker);
}

export function drawClanmates({ L, group, pt, data, now, ages, index, p }: Ctx): void {
  // Oldest fix first, newest last: a name tag is a DOM node in the tooltip
  // pane, painted in insertion order, so the clanmate seen most recently
  // lands on top of anyone who logged off hours ago. The marker itself gets
  // the same order as a z-index offset, since Leaflet otherwise stacks
  // markers by latitude alone.
  const ordered = [...data.clanmates].sort((a, b) => a.fix.at.getTime() - b.fix.at.getTime());
  ordered.forEach((m, i) => {
    const step = ageStep(now - m.fix.at.getTime(), DIM_AFTER_MS);
    const name = escapeHtml(m.gamertag);
    const age = fixAge(m.fix.at, new Date(now));
    const marker = L.marker(pt(m.fix.x, m.fix.z), { icon: chipIcon(L, clanmateIcon(p), ICON.clanmate, "cw-mk-clanmate"), keyboard: true, title: markerTitle.clanmate(m.gamertag, age), zIndexOffset: i * 1000 });
    // The permanent tag is the gamertag alone and never changes; the age lives
    // in the popup and the title, which are what a tick rewrites.
    marker.bindTooltip(name, tag(""));
    const text = (age: string) => `<div class="${POPUP_TEXT}">${name} · ${escapeHtml(age)}</div>`;
    const html = text(age);
    marker.bindPopup(html, popupOptions(POPUP));
    markOpen(marker);
    marker.addTo(group);
    index.set(markerKey.clanmate(m.dayzId), marker);
    // Past a day the marker is dimmed rather than dropped: "here a day ago" is
    // still worth knowing, and a vanished clanmate reads as a bug. The
    // element exists only once the marker is on the map, so the step is
    // applied after addTo.
    applyStep(marker, step);
    ages.push({ at: m.fix.at, layer: marker, popup: text, title: { marker, text: (a) => markerTitle.clanmate(m.gamertag, a) }, dim: marker, last: age, lastPopup: html, step });
  });
}

export function drawIntruders({ L, group, pt, data, now, ages, index, p }: Ctx): void {
  for (const i of data.intruders) {
    const text = (age: string) => `${escapeHtml(i.gamertag)} · ${Math.round(i.distanceM)} m · ${escapeHtml(age)}`;
    const age = fixAge(i.lastSeenAt, new Date(now));
    const marker = L.marker(pt(i.x, i.z), { icon: chipIcon(L, intruderIcon(p), ICON.intruder, "cw-mk-intruder"), keyboard: true, title: markerTitle.intruder(i.gamertag, i.distanceM, age) })
      .bindTooltip(text(age), tag(`${TAG}-intruder`));
    marker.addTo(group);
    index.set(markerKey.intruder(i.gamertag), marker);
    ages.push({ at: i.lastSeenAt, layer: marker, tooltip: text, title: { marker, text: (a) => markerTitle.intruder(i.gamertag, i.distanceM, a) }, last: age });
  }
}

/** Every open bounty whose target is online. Name, "wanted" and the age — never a coordinate (the rule at the top of this file). */
export function drawBounties({ L, group, pt, data, now, ages, index, p }: Ctx): void {
  for (const b of data.bounties) {
    const text = (age: string) => `${escapeHtml(b.gamertag)} · wanted · ${escapeHtml(age)}`;
    const age = fixAge(b.fix.at, new Date(now));
    const popup = (age: string) => `<div class="${POPUP_TEXT}">${text(age)}<br>${escapeHtml(b.reason)}</div>`;
    const marker = L.marker(pt(b.fix.x, b.fix.z), { icon: chipIcon(L, bountyIcon(p), ICON.bounty, "cw-mk-bounty"), keyboard: true, title: markerTitle.bounty(b.gamertag, age) })
      .bindTooltip(text(age), tag(`${TAG}-intruder`))
      .bindPopup(popup(age), popupOptions(POPUP));
    markOpen(marker);
    marker.addTo(group);
    index.set(markerKey.bounty(b.gamertag), marker);
    // ⚠️ The popup must be registered here too, not just the tooltip — an open
    // popup otherwise keeps its draw-time age forever while the permanent tag
    // updates every 30 s, and the two contradict each other.
    ages.push({ at: b.fix.at, layer: marker, tooltip: text, popup, title: { marker, text: (a) => markerTitle.bounty(b.gamertag, a) }, last: age, lastPopup: popup(age) });
  }
}

export function drawPublicBases({ L, group, pt, data, p }: Ctx): void {
  for (const b of data.publicBases) {
    const icon = chipIcon(L, publicBaseIcon(p), ICON.publicBase, "cw-mk-public");
    // Not a tab stop: it opens nothing and is not in the "On the map" list, so
    // Tab would only interleave strangers' bases with the player's own markers.
    // The title stays, for a pointer's hover and a screen reader's browse mode.
    L.marker(pt(b.x, b.z), { icon, keyboard: false, title: markerTitle.publicBase(b.x, b.z) }).bindTooltip("Public base", { direction: "right", opacity: 1, className: TAG }).addTo(group);
  }
}

export function drawPins({ L, group, pt, data, now, ages, index, p }: Ctx): void {
  for (const pin of data.pins) {
    const label = PIN_ICON_LABELS[pin.icon];
    const note = pin.note ? `<p class="m-0 px-3.5 pt-2.5 text-[13px] leading-normal text-ink">${escapeHtml(pin.note)}</p>` : "";
    // Grid ref, never a coordinate: it is what the guide and the bottom bar speak.
    const text = (age: string, at: Date) =>
      `<div class="min-w-[13rem] max-w-[16rem]">` +
        `<div class="flex items-center gap-2.5 border-b border-rule-2 py-3 pl-3.5 pr-11">${pinGlyph(p, pin.icon, 20)}` +
          `<span class="font-display text-[13px] uppercase tracking-[0.06em] text-ink">${escapeHtml(label)}</span>` +
          `<span class="ml-auto font-mono text-[11px] text-muted">Grid ${gridRef(pin.x, pin.z)}</span></div>${note}` +
        `<p class="m-0 px-3.5 pb-3 pt-1.5 font-mono text-[11px] text-muted">${escapeHtml(pin.by ?? "a member")} · ${escapeHtml(age)} · ${escapeHtml(expiresIn(pin.expiresAt, at))}</p>` +
        `<form method="post" action="/api/map/pin/delete" class="m-0">` +
          `<input type="hidden" name="id" value="${pin.id}" />` +
          // The grid square to come back to: six digits, never a coordinate (lib/map-url.ts).
          `<input type="hidden" name="at" value="${gridRefKey(pin.x, pin.z)}" />` +
          `<button type="submit" data-arm="Delete it? Tap again" class="flex min-h-[44px] w-full items-center justify-center border-t border-rule-2 font-display text-xs uppercase tracking-[0.06em] text-ink shadow-[inset_0_2px_0_var(--color-rust)] hover:bg-rust/15">Delete pin</button>` +
        `</form>` +
      `</div>`;
    const age = fixAge(pin.at, new Date(now));
    const html = text(age, new Date(now));
    const marker = L.marker(pt(pin.x, pin.z), { icon: chipIcon(L, pinIcon(p, pin.icon), ICON.pin, "cw-mk-pin"), keyboard: true, title: markerTitle.pin(label, pin.x, pin.z, age) })
      .bindPopup(html, popupOptions(POPUP));
    markOpen(marker);
    marker.addTo(group);
    index.set(markerKey.pin(pin.id), marker);
    ages.push({ at: pin.at, layer: marker, popup: text, title: { marker, text: (a) => markerTitle.pin(label, pin.x, pin.z, a) }, last: age, lastPopup: html });
  }
}

/**
 * The travel points inside `view`, or none when `view` is null (zoomed out).
 * map-view.tsx passes the padded bounds and redraws on every moveend, so the
 * group only ever holds the sheds near the screen.
 */
export function drawTravel({ L, group, pt, data, p }: Pick<Ctx, "L" | "group" | "pt" | "data" | "p">, view: L.LatLngBounds | null): void {
  if (view === null) return;
  const icon = chipIcon(L, travelIcon(p), ICON.travel, "cw-mk-travel");
  // The Hub itself is not drawn: it is one fixed, well-known building, and a
  // marker with a name tag at every zoom only covered the south-west corner.
  for (const t of data.travelPoints) {
    const at = pt(t.x, t.z);
    if (view.contains(at)) L.marker(at, { pane: TRAVEL_PANE, icon, keyboard: false, interactive: false }).addTo(group);
  }
}

/** The bounds to draw travel points in, or null below TRAVEL_MIN_ZOOM. */
export function travelView(m: L.Map): L.LatLngBounds | null {
  return m.getZoom() >= TRAVEL_MIN_ZOOM ? m.getBounds().pad(TRAVEL_VIEW_PAD) : null;
}

/**
 * A 1 km grid, so a grid ref read off the bottom bar has visible cells to sit in.
 * ⚠️ Horizontals run at z = size − k·1000, not k·1000: the GPS counts rows down
 * from the north edge, and a grid anchored at the south edge would be drawn
 * offset from the cells the readout names whenever size is not a multiple of 1000.
 */
export function drawGrid(L: typeof import("leaflet"), group: L.LayerGroup, pt: (x: number, z: number) => L.LatLng, size: number): void {
  const style = { color: COLOURS.frame(), weight: 1, opacity: 0.25, interactive: false } as const;
  for (let v = 0; v <= size; v += 1000) {
    L.polyline([pt(v, 0), pt(v, size)], style).addTo(group);
    L.polyline([pt(0, size - v), pt(size, size - v)], style).addTo(group);
  }
}

/** The world layers' pane: under the travel points (350), the place names (360) and every player marker. */
export const WORLD_PANE = "world";
/**
 * How far past the visible edge world markers are drawn. Smaller than the travel pad:
 * the loot layers are the densest thing on the map, and every 10% of pad on each side
 * is ~44% more area to fill with DOM markers.
 */
export const WORLD_VIEW_PAD = 0.1;

/** Where to draw world markers, and whether the dense layers are in yet; null below WORLD_MIN_ZOOM. */
export type WorldView = { bounds: L.LatLngBounds; dense: boolean };

/** The bounds to draw world markers in, or null below WORLD_MIN_ZOOM (Review Focus 5: a zoomed-out phone draws none). */
export function worldView(m: L.Map): WorldView | null {
  const zoom = m.getZoom();
  return zoom >= WORLD_MIN_ZOOM ? { bounds: m.getBounds().pad(WORLD_VIEW_PAD), dense: zoom >= LOOT_MIN_ZOOM } : null;
}

/** What drawWorld has on the map, by item id: kept between calls so a redraw only adds and removes the difference. */
export type WorldDrawn = Map<string, { key: string; layer: L.Layer }>;

/**
 * A world marker's popup.
 *
 * ⚠️ This is the one popup on the map that DOES print coordinates, and that is not a
 * breach of the rule at the top of this file. That rule protects players: a clanmate's
 * or a base's numbers are what someone pastes into another clan's Discord. A bunker,
 * a heli-crash spawn or a barracks is static mission data that iZurvive already
 * publishes for every server; its GPS and metres are what a player types into the
 * search box or reads off their in-game GPS. Nothing here comes from the database.
 */
export function worldPopup(item: WorldItem, size: number): string {
  const line = (text: string) => `<p class="m-0 pt-1 font-mono text-[11px] text-muted">${text}</p>`;
  return `<div class="${POPUP_TEXT}">` +
    `<p class="m-0 font-display text-[13px] uppercase tracking-[0.06em] text-ink">${escapeHtml(item.title)}</p>` +
    line(`GPS ${gridRef(item.x, item.z, size)} · metres ${Math.round(item.x)} ${Math.round(item.z)}`) +
    (item.radius !== undefined ? line(`Radius ${Math.round(item.radius)} m`) : "") +
    (item.tiers?.length ? line(`Tier: ${escapeHtml(item.tiers.map(tierLabel).join(", "))}`) : "") +
    (item.usage?.length ? line(`Loot: ${escapeHtml(item.usage.join(", "))}`) : "") +
  `</div>`;
}

/**
 * Put the world items that belong on screen into their layers' groups, and take off
 * the ones that no longer do. Bunkers and contaminated circles are drawn whatever the
 * view; everything else only inside `view`, and the loot buildings and wrecks only
 * once `view.dense`.
 *
 * ⚠️ A reconciler, not clear-and-redraw. It runs on every moveend, and opening a
 * popup near the edge pans the map, which fires moveend: clearing the groups there
 * removed the very marker whose popup was opening and closed it at once. A marker
 * still wanted is left alone, so its popup stays open; it also means a short pan
 * creates only the markers that just came into range.
 */
export function drawWorld(
  { L, group, pt, p, size }: { L: typeof import("leaflet"); group: (key: string) => L.LayerGroup; pt: (x: number, z: number) => L.LatLng; p: Palette; size: number },
  items: readonly WorldItem[],
  view: WorldView | null,
  drawn: WorldDrawn,
): void {
  const icons = new Map<string, L.DivIcon>();
  const iconFor = (key: string) => {
    let icon = icons.get(key);
    if (!icon) {
      icon = chipIcon(L, worldIcon(p, key), ICON.world, "cw-mk-world");
      icons.set(key, icon);
    }
    return icon;
  };
  const want = new Set<string>();
  for (const item of items) {
    const always = ALWAYS_DRAWN.has(item.key);
    if (!always && (view === null || (isDense(item.key) && !view.dense))) continue;
    const at = pt(item.x, item.z);
    if (!always && !view!.bounds.contains(at)) continue;
    want.add(item.id);
    const had = drawn.get(item.id);
    if (had?.key === item.key) continue;
    // Same building, new owner: a loot layer above it in LOOT_GROUPS order was switched on or off.
    if (had) group(had.key).removeLayer(had.layer);
    const popup = () => worldPopup(item, size);
    let layer: L.Layer;
    if (item.radius !== undefined) {
      // Metres to latlng units, as drawBase does for the watch zone.
      const radius = (item.radius * (CANVAS_PX / size)) / 2 ** MAX_ZOOM;
      const colour = worldAccent(p, item.key);
      layer = L.circle(at, { pane: WORLD_PANE, radius, color: colour, weight: 2, dashArray: "4 4", fillColor: colour, fillOpacity: 0.12 })
        .bindPopup(popup, popupOptions(POPUP));
    } else {
      // Not a tab stop: a view can hold hundreds, and Tab would wade through every
      // roof before reaching the player's own markers. The title serves hover and browse mode.
      const marker = L.marker(at, { pane: WORLD_PANE, icon: iconFor(item.key), keyboard: false, title: item.title })
        .bindPopup(popup, popupOptions(POPUP));
      markOpen(marker);
      layer = marker;
    }
    layer.addTo(group(item.key));
    drawn.set(item.id, { key: item.key, layer });
  }
  for (const [id, d] of drawn) {
    if (want.has(id)) continue;
    group(d.key).removeLayer(d.layer);
    drawn.delete(id);
  }
}

/**
 * The search box's coordinate popup: the GPS, the metres, and Pin it.
 *
 * Coordinates again, and allowed for the same reason as `worldPopup`: this is the
 * point the player typed into the search box, not anyone's position. Pin it carries
 * `data-pin-it`; map-view.tsx listens for it on the map's element (Leaflet builds the
 * popup's DOM) and opens the ordinary pin sheet on the point.
 */
export function reticlePopup(at: { x: number; z: number }, size: number, canPin: boolean): string {
  const x = Math.round(at.x), z = Math.round(at.z);
  return `<div class="${POPUP_TEXT}">` +
    `<p class="m-0 font-display text-[13px] uppercase tracking-[0.06em] text-ink">GPS ${gridRef(x, z, size)}</p>` +
    `<p class="m-0 pt-1 font-mono text-[11px] text-muted">Metres ${x}, ${z}</p>` +
    (canPin
      ? `<button type="button" data-pin-it data-x="${x}" data-z="${z}" class="mt-2 flex min-h-[44px] items-center border-2 border-gold px-3 font-display text-xs uppercase tracking-[0.06em] text-gold hover:bg-gold hover:text-ground">${SEARCH_COPY.pinIt}</button>`
      : "") +
  `</div>`;
}

/** The searched point's mark: the "you" reticle's shape, so it reads as "here", in gold. */
const RETICLE_SVG = (gold: string) =>
  `<svg width="32" height="32" viewBox="0 0 28 28" fill="none" stroke="${gold}" stroke-width="2" stroke-linecap="square" aria-hidden="true">` +
  `<circle cx="14" cy="14" r="8.5"/><path d="M14 1v7M14 20v7M1 14h7M20 14h7"/></svg>`;

/**
 * Drop the search reticle on a point, replacing the last one, and return it so the
 * caller can open its popup once the view has moved. Local to the page: nothing saved.
 */
export function drawReticle(
  { L, group, pt, p, size }: { L: typeof import("leaflet"); group: L.LayerGroup; pt: (x: number, z: number) => L.LatLng; p: Palette; size: number },
  at: { x: number; z: number },
  canPin: boolean,
): L.Marker {
  group.clearLayers();
  const marker = L.marker(pt(at.x, at.z), {
    keyboard: true,
    title: `GPS ${gridRef(at.x, at.z, size)}`,
    icon: L.divIcon({ className: "cw-mk", html: RETICLE_SVG(p.gold), iconSize: [32, 32], iconAnchor: [16, 16] }),
  }).bindPopup(() => reticlePopup(at, size, canPin), popupOptions(POPUP));
  markOpen(marker);
  marker.addTo(group);
  return marker;
}

/**
 * The ruler's line, a dot on every point, and the total with the last leg's bearing
 * beside the last point. Rebuilt whole on every click: a ruler is a handful of points.
 * Distances and bearings only — no coordinate is written (the rule at the top).
 */
export function drawRuler(
  L: typeof import("leaflet"),
  group: L.LayerGroup,
  pt: (x: number, z: number) => L.LatLng,
  points: readonly RulerPoint[],
  colour: string,
): void {
  group.clearLayers();
  if (points.length === 0) return;
  const at = points.map((q) => pt(q.x, q.z));
  // Not interactive: a click on the line must land on the map and add a point, not stop at the line.
  if (at.length > 1) L.polyline(at, { color: colour, weight: 3, dashArray: "8 6", interactive: false }).addTo(group);
  at.forEach((a, i) => {
    const dot = L.circleMarker(a, { radius: 5, color: colour, weight: 2, fillColor: colour, fillOpacity: 1, interactive: false });
    if (i === at.length - 1 && at.length > 1) dot.bindTooltip(rulerSummary(points), { permanent: true, direction: "right", className: TAG, opacity: 1 });
    dot.addTo(group);
  });
}
