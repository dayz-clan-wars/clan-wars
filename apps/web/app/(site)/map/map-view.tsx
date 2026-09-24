"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type * as L from "leaflet";
/**
 * The Leaflet module as the dynamic import yields it. Named once, so the file
 * spells the dynamic import of "leaflet" in exactly one place: `importLeaflet`.
 */
type LeafletModule = typeof L;
import { PIN_ICONS, PIN_NOTE_MAX, POSITION_FIX_MS } from "@factions/domain";
import { MAX_ZOOM, ZOOM_SNAP, gridRef, latLngToWorld, worldToLatLng, zoomFloor, CANVAS_PX, parseGridRef } from "@/lib/map-projection";
import { placeWeight, placesFor } from "@/lib/map-places";
import { WATCH_ZONE_RADIUS_M } from "@factions/domain";
import { LAYER_REASONS, MAP_HINT, MAP_LOAD_COPY, MAP_REGION_LABEL, LAYER_LABELS, PIN_ICON_LABELS, PIN_FOLLOW, PIN_HINT } from "@/lib/map-copy";
import { layerIcon, pinGlyph } from "@/lib/map-icons";
import { applyPopupFit } from "@/lib/map-popup-fit";
import { layerOfKey, rosterRows } from "@/lib/map-roster";
import { followCentre, insetFor, pinAtCentre, pinAtPoint, type PinDraft } from "@/lib/map-pin";
import { MapRoster } from "./map-roster";
import {
  FAR_CLASS, TRAVEL_CHIP_ZOOM, TRAVEL_PANE, type AgeLabel, type Ctx, type MapData, type WireState,
  drawBase, drawBounties, drawClanmates, drawGrid, drawIntruders, drawPins, drawPublicBases, drawTravel, drawYou, escapeHtml, palette, parseState, ptFor, refreshAges,
} from "./map-draw";
import { changedLayers, layerSignatures, reopenAfter, type DataLayer, type Signatures } from "./map-redraw";
import { loadView, nextPollDelay, requestGate, type LoadError } from "@/lib/map-load";
import { withoutResult } from "@/lib/map-url";
import { MapStatus } from "./map-status";
import { MapNotices } from "./map-notices";
// ⚠️ Next special-cases a global stylesheet imported FROM node_modules: a
// third-party package's CSS may be imported in the component that needs it and
// still gets extracted, scoped to this component's chunk rather than loaded on
// every page. Do not move this to app/layout.tsx (that loads Leaflet's CSS
// site-wide) and do not delete it — without it Leaflet's panes, tiles and
// controls have no positioning CSS in a real browser.
//
// ⚠️ map.css comes SECOND, and must: it restyles Leaflet's white chrome at
// the same specificity, so the later sheet wins. When those rules sat in
// globals.css, this import landed after them and every pin popup on a phone
// was a white card with unreadable light text. test/map-css-order.test.ts
// pins the pair and their order.
import "leaflet/dist/leaflet.css";
import "./map.css";

/** Vendored from DZMap's own upstream config. Attribution is an obligation, not decoration. */
const TILE_ATTRIBUTION = '<a href="https://dayz.xam.nu" target="_blank">Tiles © Xam.nu</a>';
/** A 1x1 transparent gif: absent tiles read as dark ground, not a broken-image checkerboard. */
const BLANK_TILE = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const LAYER_STORAGE_KEY = "clan-wars.map.layers";
/** The world this map draws; the place names are keyed on it. */
const MAP = "enoch";
/** Place names sit over the travel points (350) and under every player marker (overlay 400, markers 600). */
const PLACE_PANE = "places";
/** Ages are recomputed far more often than positions are fetched, so a label never goes stale. */
const AGE_TICK_MS = 30_000;

type LayerKey = keyof typeof LAYER_LABELS;
/** The six every linked viewer has; the other four are gated on `layers.*`. */
const ALWAYS: LayerKey[] = ["you", "publicBases", "travel", "places", "terrain", "bounties"];
const ALL_KEYS = Object.keys(LAYER_LABELS) as LayerKey[];
const ALL_ON = Object.fromEntries(ALL_KEYS.map((k) => [k, true])) as Record<LayerKey, boolean>;

function loadSwitches(): Record<LayerKey, boolean> {
  // Private browsing and "block site data" both make localStorage throw on
  // access, not return null. A remembered switch is a convenience; the map
  // opening at all is not.
  try {
    const raw = window.localStorage.getItem(LAYER_STORAGE_KEY);
    if (!raw) return ALL_ON;
    const saved = JSON.parse(raw) as Partial<Record<LayerKey, boolean>>;
    return Object.fromEntries(ALL_KEYS.map((k) => [k, saved[k] ?? true])) as Record<LayerKey, boolean>;
  } catch {
    return ALL_ON;
  }
}


/** The settings sprocket: an eight-tooth gear in the chip's stroke, currentColor so the button colours it. */
/** The zoom "Center on me" lands at: about 5 m per pixel, a couple of kilometres across a phone. */
const RECENTRE_ZOOM = 4;

/** The reticle from the "you" marker, in currentColor, for the recentre button. */
function Reticle({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true">
      <circle cx="14" cy="14" r="3" fill="currentColor" stroke="none" />
      <circle cx="14" cy="14" r="8.5" />
      <path d="M14 1v5M14 22v5M1 14h5M22 14h5" />
    </svg>
  );
}

/** The pins layer's own glyph (lib/map-icons.ts `layerIcon("pins")`), in currentColor, for "Pin here". */
function PinMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="square" aria-hidden="true">
      <path d="M14 25V3M8 6l6-3 6 3-6 3z" fill="currentColor" />
      <path d="M7 25h14" />
    </svg>
  );
}

function Sprocket({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true">
      <circle cx="14" cy="14" r="4" />
      <path d="M14 2v4M14 22v4M2 14h4M22 14h4M5.5 5.5l2.8 2.8M19.7 19.7l2.8 2.8M5.5 22.5l2.8-2.8M19.7 8.3l2.8-2.8" />
      <circle cx="14" cy="14" r="8.5" />
    </svg>
  );
}

const HINT_KEY = "cw-map-hint-v1";

/** The bar's last slot: the player's next step, not always "Your clan" (App Review §03). */
export type MapNext = { label: string; href: string };

export default function MapView({ layers, notice, guide, next }: { layers: MapData["layers"]; notice?: string; guide?: { href: string; label: string }; next: MapNext }) {
  // A first map with nothing of the player's on it says what would change that; dismissed once, remembered beside the layer switches.
  const bare = !layers.base && !layers.clanmates;
  const [hint, setHint] = useState(false);
  useEffect(() => {
    if (!bare) return;
    try { setHint(localStorage.getItem(HINT_KEY) !== "1"); } catch { setHint(true); }
  }, [bare]);
  const dismissHint = () => { setHint(false); try { localStorage.setItem(HINT_KEY, "1"); } catch { /* a private window forgets; fine */ } };
  // The pin form's answer. Shown until dismissed, but taken out of the address
  // at once: a reload used to replay "Pin dropped." for as long as the tab lived.
  const [shownNotice, setShownNotice] = useState(notice);
  useEffect(() => {
    if (!notice) return;
    // Next keeps its own router state in history.state; passing it back leaves the router undisturbed.
    try { window.history.replaceState(window.history.state, "", withoutResult(window.location.href)); } catch { /* the notice still dismisses */ }
  }, [notice]);
  // `/map?at=043087` (from /base's "Map →") opens on that grid square. Read
  // once, client-side: the HTML still carries no metre coordinate, and a
  // bad key is simply the whole map.
  const at = useSearchParams().get("at");
  const atRef = useRef(at);
  atRef.current = at;
  // "Refreshed · just now" on the grid cell for two seconds after a tap, and
  // one announcement. ⚠️ Only once the answer is in and good: flashing on the
  // tap itself told a player "refreshed" about a request that then failed.
  const [flash, setFlash] = useState(false);
  const [announce, setAnnounce] = useState("");
  const el = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<MapData | null>(null);
  const [error, setError] = useState<LoadError | null>(null);
  // Failures in a row (the backoff), and a count of settled requests: each
  // settle re-arms the one poll timer, so the next wait follows the last answer.
  const [failures, setFailures] = useState(0);
  const [settled, setSettled] = useState(0);
  // The map exists (Leaflet loaded and built), or its chunk failed to load.
  // `attempt` re-runs the creation effect for a retry after a chunk failure.
  const [mapReady, setMapReady] = useState(false);
  const [leafletFailed, setLeafletFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [enabled, setEnabled] = useState<Record<LayerKey, boolean>>(ALL_ON);
  // The centre in metres as well as its grid ref: "Pin here" drops on it. Null until the map exists.
  const [centre, setCentre] = useState<{ grid: string; x: number; z: number } | null>(null);
  const [pinAt, setPinAt] = useState<PinDraft | null>(null);
  const shell = useRef<HTMLElement>(null);
  // The layers live behind a sprocket. Closed by default: the map is the
  // page, and a panel that stays open covers the terrain a player came for.
  const [layersOpen, setLayersOpen] = useState(false);

  const visible = ALL_KEYS.filter((k) => ALWAYS.includes(k) || layers[k as keyof MapData["layers"]]);
  // The switches that would do nothing, with what would put them there.
  const missing = (Object.keys(LAYER_REASONS) as (keyof typeof LAYER_REASONS)[]).filter((k) => !layers[k]);

  // ── The fetch loop ────────────────────────────────────────────────────────
  // The last answer's raw body, so an unchanged poll is skipped outright (see `load`).
  const lastBody = useRef<string | null>(null);
  const gate = useRef(requestGate());
  const inflight = useRef<AbortController | null>(null);
  const load = useCallback(async (): Promise<boolean | null> => {
    // ⚠️ One answer applied at a time, and only the newest. A Refresh tapped
    // while the poll's request was still out used to race it, and whichever
    // answered LAST won, so an older snapshot could overwrite a newer one.
    // The abort saves the superseded request's bandwidth; the gate is what
    // keeps the order right even when the abort lands too late.
    inflight.current?.abort();
    const ctl = new AbortController();
    inflight.current = ctl;
    const n = gate.current.begin();
    let ok = false;
    try {
      const res = await fetch("/api/map/state", { cache: "no-store", signal: ctl.signal });
      const body = res.ok ? await res.text() : null;
      if (!gate.current.isLatest(n)) return null;
      if (res.status === 401) setError("unauthenticated");
      else if (res.status === 403) setError("not-linked");
      else if (body === null) setError("failed");
      else {
        setError(null);
        // An unchanged answer changes nothing on the map. Skipping it keeps
        // `data`, and every effect keyed on it, still. Parsed BEFORE it is
        // remembered, so a body that fails to parse is never taken as "unchanged".
        if (body !== lastBody.current) {
          const next = parseState(JSON.parse(body) as WireState);
          lastBody.current = body;
          setData(next);
        }
        ok = true;
      }
    } catch {
      // ⚠️ An aborted request is superseded, not failed: counting it would
      // push the backoff up every time a player taps Refresh.
      if (!gate.current.isLatest(n)) return null;
      setError("failed");
    }
    setFailures((f) => (ok ? 0 : f + 1));
    setSettled((s) => s + 1);
    return ok;
  }, []);

  const leafletMod = useRef<Promise<LeafletModule> | null>(null);
  /**
   * The Leaflet chunk, requested once.
   * ⚠️ Started on MOUNT, beside the first state fetch. It used to wait for
   * that fetch (the creation effect is gated on `size`), so a phone paid
   * state → JS → tiles in series before the first tile was even asked for.
   * Still a dynamic import, so Leaflet never enters the server bundle and
   * never runs during SSR. This page's HTML must stay coordinate-free.
   */
  const importLeaflet = useCallback(() => {
    leafletMod.current ??= import("leaflet").then((mod) => mod.default ?? (mod as unknown as LeafletModule));
    return leafletMod.current;
  }, []);

  const refreshTap = async () => {
    const ok = await load();
    if (ok !== true) return;
    setFlash(true);
    setAnnounce(MAP_LOAD_COPY.refreshed);
    setTimeout(() => { setFlash(false); setAnnounce(""); }, 2_000);
  };

  // 401 and 403 are answers, not outages: the session is gone or the character
  // is not linked, and neither is fixed by asking again five minutes later.
  const terminal = error === "unauthenticated" || error === "not-linked";
  const view = loadView({ mapReady, error, leafletFailed });
  const retry = () => {
    // A Leaflet chunk that failed to load is only fetched again by re-running the creation effect.
    if (leafletFailed) { setLeafletFailed(false); setAttempt((a) => a + 1); }
    void load();
  };

  useEffect(() => {
    setEnabled(loadSwitches());
    void load();
    importLeaflet().catch(() => { /* reported by the creation effect, which awaits this same promise */ });
    return () => inflight.current?.abort();
  }, [load, importLeaflet]);

  const terminalRef = useRef(terminal);
  terminalRef.current = terminal;
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.visibilityState === "hidden");
  // ⚠️ A background tab asks for nothing: no poll, no age tick. Coming back is
  // a fresh load and a fresh clock at once, never a wait of up to five minutes
  // for a timer that was paused.
  useEffect(() => {
    const onVisibility = () => {
      const h = document.visibilityState === "hidden";
      setHidden(h);
      if (!h && !terminalRef.current) { setNow(Date.now()); void load(); }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [load]);

  // One timer, re-armed after every settled request, not an interval. The
  // next wait depends on how the last answer went (lib/map-load.ts: 15 s,
  // 60 s, then the poll), and a manual Refresh restarts the wait instead of
  // stacking a second schedule on the first.
  useEffect(() => {
    const delay = nextPollDelay({ failures, hidden }, POSITION_FIX_MS);
    if (terminal || delay === null) return;
    const id = setTimeout(() => void load(), delay);
    return () => clearTimeout(id);
  }, [load, terminal, failures, settled, hidden]);

  // Ages tick between fetches: a fix five minutes old must not read "just now"
  // for the whole interval.
  useEffect(() => {
    if (hidden) return;
    const id = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(id);
  }, [hidden]);

  /**
   * Center on your last known position and zoom in. The fix is whatever the
   * server log last recorded — not live — so the marker's tooltip, which
   * says how old it is, stays the honest part; this only moves the view.
   */
  const recentre = () => {
    const m = map.current, Lm = leaflet.current, d = dataRef.current;
    const fix = d?.you.fix;
    if (!m || !Lm || !d || !fix) return;
    m.setView(ptFor(Lm, d.world.size)(fix.x, fix.z), Math.max(RECENTRE_ZOOM, m.getMinZoom()), { animate: true });
  };
  const hasFix = data?.you.fix != null;

  /**
   * A list row's action: centre on its marker, open it, and put focus ON it.
   * ⚠️ Focus moves to the marker because the row's own button is about to be
   * unmounted with the panel, and focus left on a dead element drops a
   * keyboard user back at the top of the page. Enter on the focused marker
   * reopens its popup, and Escape closes it (Leaflet's own handling).
   */
  const goTo = (key: string) => {
    const m = map.current;
    const layer = layerOfKey(key);
    const marker = layer ? index.current[layer]?.get(key) : undefined;
    if (!m || !marker) return;
    setLayersOpen(false);
    m.setView(marker.getLatLng(), Math.max(RECENTRE_ZOOM, m.getZoom()), { animate: true });
    if (marker.getPopup()) marker.openPopup();
    marker.getElement()?.focus();
  };
  // Recomputed each render, and `now` ticks every 30 s, so a row's age never goes stale.
  const rows = data ? rosterRows(data, enabled, new Date(now)) : [];

  const toggle = (key: LayerKey) => {
    setEnabled((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try { window.localStorage.setItem(LAYER_STORAGE_KEY, JSON.stringify(next)); } catch { /* storage is a convenience */ }
      return next;
    });
  };

  // ── Leaflet ───────────────────────────────────────────────────────────────
  const leaflet = useRef<LeafletModule | null>(null);
  const map = useRef<L.Map | null>(null);
  const groups = useRef<Partial<Record<LayerKey, L.LayerGroup>>>({});
  // Each layer's markers by key (lib/map-roster.ts), for the list's rows.
  const index = useRef<Partial<Record<LayerKey, Map<string, L.Marker>>>>({});
  const gridDrawn = useRef(false);
  // The open popup, and the call that keeps its card inside the container.
  const openPopup = useRef<L.Popup | null>(null);
  const fitPopupNow = useRef<() => void>(() => {});
  const dataRef = useRef<MapData | null>(null);
  const hintRef = useRef(false);
  hintRef.current = hint;
  dataRef.current = data;
  const nowRef = useRef(now);
  nowRef.current = now;

  const observer = useRef<ResizeObserver | null>(null);
  const barObserver = useRef<ResizeObserver | null>(null);

  // ⚠️ An overlay at the bottom must sit BESIDE the map's box, not over it.
  // The world has a hard edge (maxBoundsViscosity 1) and the zoom floor fits
  // the whole map to the container, so anything drawn over the container's
  // bottom hides the south of the map with no way to pan it into view. The
  // phone bar's height varies (a notice, the layer chips), and the phone pin
  // sheet replaces it while open, so whichever is mounted is measured
  // (lib/map-pin.ts `insetFor`). The map element's bottom follows it, and
  // `--cw-inset` on <main> tells the "Pin here" cross where the map's centre
  // is. The map's own ResizeObserver then re-measures Leaflet and the floor.
  // A callback ref, because the two overlays unmount and remount each other.
  const insetBy = useCallback((overlay: HTMLElement | null) => {
    barObserver.current?.disconnect();
    barObserver.current = null;
    if (!overlay || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      const px = insetFor(overlay.getBoundingClientRect(), shell.current?.clientWidth ?? 0);
      if (el.current) el.current.style.bottom = `${px}px`;
      shell.current?.style.setProperty("--cw-inset", `${px}px`);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(overlay);
    barObserver.current = ro;
  }, []);
  // `layers` comes from the server render and never changes for a mounted
  // MapView, but the creation effect deliberately depends on `size` alone —
  // reading it through a ref keeps that honest.
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const size = data?.world.size ?? null;

  // Per layer, so a layer that is not rebuilt keeps its labels ticking.
  const ages = useRef<Partial<Record<LayerKey, AgeLabel[]>>>({});
  const allAges = () => Object.values(ages.current).flatMap((a) => a ?? []);
  // What each layer was last drawn from, and the popup open right now (by markerKey).
  const sigs = useRef<Partial<Signatures>>({});
  const openKey = useRef<string | null>(null);

  const redraw = useCallback(() => {
    const Lm = leaflet.current;
    const m = map.current;
    const d = dataRef.current;
    if (!Lm || !m || !d) return;
    const pt = ptFor(Lm, d.world.size);
    const p = palette();

    for (const key of ALL_KEYS) {
      // Created and added as two statements, never `layerGroup().addTo(m)`:
      // leaning on addTo's return value means a group that never lands in the
      // ref is rebuilt on every poll, forever.
      if (!groups.current[key]) {
        const g = Lm.layerGroup();
        groups.current[key] = g;
      }
    }

    const next = layerSignatures(d, hintRef.current);
    const changed = changedLayers(sigs.current, next);
    sigs.current = next;
    // ⚠️ Captured BEFORE the clear: removing a marker fires its popupclose,
    // which forgets the key.
    const reopen = reopenAfter(openKey.current, changed);
    // ⚠️ This runs on NEW DATA ONLY, and rebuilds only the layers whose data
    // changed (map-redraw.ts). See the age tick below and AgeLabel in
    // map-draw.ts: rebuilding on the 30 s tick tore down every open popup.
    for (const key of changed) {
      groups.current[key]!.clearLayers();
      index.current[key]?.clear();
      ages.current[key] = [];
    }
    const ctx = (key: DataLayer): Ctx => ({ L: Lm, group: groups.current[key]!, pt, data: d, now: nowRef.current, ages: ages.current[key]!, index: (index.current[key] ??= new Map()), p });
    const draws: Record<DataLayer, () => void> = {
      you: () => {
        drawYou(ctx("you"));
        // The hint's faint dashed ring: what a base's watch zone would add around you. Same group as the dot, so it comes and goes with it.
        if (hintRef.current && d.you.fix) {
          const units = WATCH_ZONE_RADIUS_M * (CANVAS_PX / d.world.size) / 2 ** MAX_ZOOM;
          Lm.circle(pt(d.you.fix.x, d.you.fix.z), { radius: units, color: p.gold, opacity: 0.35, weight: 2, dashArray: "6 6", fill: false, interactive: false }).addTo(groups.current.you!);
        }
      },
      base: () => drawBase(ctx("base")),
      clanmates: () => drawClanmates(ctx("clanmates")),
      intruders: () => drawIntruders(ctx("intruders")),
      bounties: () => drawBounties(ctx("bounties")),
      publicBases: () => drawPublicBases(ctx("publicBases")),
      pins: () => drawPins(ctx("pins")),
      travel: () => drawTravel(ctx("travel")),
    };
    for (const key of changed) draws[key]();
    // The grid never changes, so it is drawn once — redrawing 26 polylines
    // every poll would be churn with nothing to show for it.
    if (!gridDrawn.current) {
      drawGrid(Lm, groups.current.terrain!, pt, d.world.size);
      gridDrawn.current = true;
    }
    if (reopen) {
      const layer = layerOfKey(reopen);
      (layer ? index.current[layer]?.get(reopen) : undefined)?.openPopup();
    }
  }, []);

  useEffect(() => {
    if (!el.current || size === null) return;
    let cancelled = false;

    // The chunk importLeaflet started on mount: usually in hand by now. Still
    // dynamic, so Leaflet never enters the server bundle and never runs
    // during SSR — this page's HTML must stay coordinate-free.
    void importLeaflet()
      .then((Lm) => {
        if (cancelled || !el.current) return;
        leaflet.current = Lm;
        const m = Lm.map(el.current, {
          crs: Lm.CRS.Simple, minZoom: 0, maxZoom: MAX_ZOOM,
          // Quarter steps: whole-level snapping makes a fractional zoom floor
          // unreachable, and no snapping at all makes the wheel rescale tiles
          // continuously instead of stepping between rendered levels.
          zoomSnap: ZOOM_SNAP,
          // A hard stop at the world's edge rather than an elastic bounce —
          // the edge is a fact about the terrain, not a suggestion.
          maxBoundsViscosity: 1,
          attributionControl: true,
        });
        map.current = m;

        const ll = (x: number, z: number) => { const p = worldToLatLng(x, z, size); return Lm.latLng(p.lat, p.lng); };
        const world = Lm.latLngBounds([ll(0, 0), ll(size, size)]);
        m.setMaxBounds(world);

        // Under the overlay pane (400) that holds the dots, over the tiles
        // (200): 209 travel points must never cover the one dot someone opened
        // the map to find.
        const pane = m.createPane(TRAVEL_PANE);
        if (pane) pane.style.zIndex = "350";
        const placePane = m.createPane(PLACE_PANE);
        if (placePane) placePane.style.zIndex = "360";

        // ⚠️ The zoom floor: never a view with anything but map in it. Set
        // from the container's size, and again on every resize, because the
        // floor depends on the container's longer side (see zoomFloor).
        const applyFloor = () => {
          const size = m.getSize();
          const floor = zoomFloor(size.x, size.y);
          if (floor !== null) m.setMinZoom(floor);
        };

        // Place names, tiered by zoom (lib/map-places.ts): rebuilt on zoomend
        // into the "places" layer group, which the switches add and remove
        // like any other. Sixty markers at most.
        const drawPlaces = () => {
          const places = groups.current.places;
          if (!places) return;
          places.clearLayers();
          for (const p of placesFor(MAP, m.getZoom())) {
            // `p.lat`/`p.lng` are already on this pyramid — not run through `ll`.
            Lm.marker(Lm.latLng(p.lat, p.lng), {
              pane: PLACE_PANE, interactive: false, keyboard: false,
              // ⚠️ The visible label is the inner span. `iconSize: [0, 0]` writes
              // `width: 0; height: 0` inline on the root, which no class rule
              // beats — a box on the root paints a dash at the anchor while the
              // text overflows it. The root is the anchor; the span is the chip.
              icon: Lm.divIcon({ className: `cw-place cw-place-${placeWeight(p.kind)}`, html: `<span class="cw-place-chip">${escapeHtml(p.name)}</span>`, iconSize: [0, 0] }),
            }).addTo(places);
          }
        };
        m.on("zoomend", drawPlaces);

        // Travel points are a dot when zoomed out and a glyph chip from
        // TRAVEL_CHIP_ZOOM up. Both forms are in every marker's markup; one
        // class on the container picks, so 209 markers swap with no rebuild.
        const far = () => m.getContainer().classList.toggle(FAR_CLASS, m.getZoom() < TRAVEL_CHIP_ZOOM);
        m.on("zoomend", far);

        for (const key of ALL_KEYS) if (!groups.current[key]) groups.current[key] = Lm.layerGroup();
        Lm.tileLayer("/tiles/enoch/topographic/{z}/{x}/{y}.webp", {
          minZoom: 0, maxZoom: MAX_ZOOM, noWrap: true,
          // Absent tiles (dev, or before the mirror has run) leave the drawn
          // layers readable on dark ground instead of a checkerboard of broken
          // images that looks like a broken feature.
          errorTileUrl: BLANK_TILE,
          attribution: TILE_ATTRIBUTION,
        }).addTo(groups.current.terrain!);

        applyFloor();
        m.fitBounds(world);
        const open = parseGridRef(atRef.current, size);
        if (open) m.setView(ll(open.x, open.z), Math.max(RECENTRE_ZOOM, m.getMinZoom()), { animate: false });
        far();
        drawPlaces();
        redraw();
        for (const key of ALL_KEYS) if (enabledRef.current[key]) m.addLayer(groups.current[key]!);
        setMapReady(true);

        const readCentre = () => {
          const c = latLngToWorld(m.getCenter().lat, m.getCenter().lng, size);
          setCentre({ grid: gridRef(c.x, c.z), x: c.x, z: c.z });
          // A "Pin here" draft rides the centre: pan, and the pin moves under the cross.
          setPinAt((d) => followCentre(d, c));
        };
        readCentre();
        m.on("moveend", readCentre);
        // Long-press on touch, right-click on desktop — Leaflet gives both the
        // same event, which is why the pin gesture needs no touch handling of
        // its own.
        //
        // ⚠️ Registered ONLY for a viewer who has the pins layer. A solo or
        // pending viewer who long-pressed used to set `pinAt`, which hid the
        // bottom bar while the form that owns the Cancel button stayed
        // unrendered — one stray right-click and the map had no controls left.
        // The guard here and the `!pinSheet` on the bar are the two halves of
        // that; `pinSheet` below keeps them from drifting apart again.
        // ⚠️ A pin near the world's edge. Leaflet keeps a popup in view by
        // PANNING THE MAP, and this map cannot pan: the world is the max bounds
        // with viscosity 1 and the zoom floor fits all of it, so a card that
        // overruns the container was simply clipped away by
        // `.leaflet-container`'s `overflow: hidden` — note and Delete button off
        // the page. lib/map-popup-fit.ts moves the card instead. Recomputed on
        // every view change, because what fits depends on where the pin now is.
        const fitOpen = () => { const p = openPopup.current; if (p) applyPopupFit(m, p); };
        fitPopupNow.current = fitOpen;
        // Which marker the open popup belongs to, by key, so a rebuild of its layer can put it back.
        const keyOf = (popup: L.Popup): string | null => {
          for (const g of Object.values(index.current)) for (const [k, mk] of g ?? []) if (mk.getPopup() === popup) return k;
          return null;
        };
        m.on("popupopen", (e: L.PopupEvent) => { openPopup.current = e.popup; openKey.current = keyOf(e.popup); fitOpen(); });
        m.on("popupclose", (e: L.PopupEvent) => { if (openPopup.current === e.popup) { openPopup.current = null; openKey.current = null; } });
        m.on("moveend zoomend resize", fitOpen);

        if (layersRef.current.pins) {
          m.on("contextmenu", (e: L.LeafletMouseEvent) => {
            const w = latLngToWorld(e.latlng.lat, e.latlng.lng, size);
            setPinAt(pinAtPoint(w));
          });
        }

        // Leaflet measures the container once at creation and only listens for
        // WINDOW resizes; a full-viewport container settles after mount (bars
        // and fonts land late) and the stale measurement leaves a blank band.
        if (typeof ResizeObserver !== "undefined") {
          const ro = new ResizeObserver(() => { map.current?.invalidateSize(); applyFloor(); });
          ro.observe(el.current);
          observer.current = ro;
        }
      })
      .catch(() => {
        // Forgotten, so a retry (which bumps `attempt`) asks for the chunk again rather than re-reading the failure.
        leafletMod.current = null;
        if (!cancelled) setLeafletFailed(true);
      });

    return () => {
      cancelled = true;
      observer.current?.disconnect();
      observer.current = null;
      map.current?.remove();
      map.current = null;
      openPopup.current = null;
      fitPopupNow.current = () => {};
      groups.current = {};
      index.current = {};
      // With the groups gone, every AgeLabel points at a detached layer; an
      // age tick must not go looking for their tooltips.
      ages.current = {};
      sigs.current = {};
      openKey.current = null;
      gridDrawn.current = false;
      leaflet.current = null;
      setMapReady(false);
    };
    // Only `size` and `attempt`: re-running this per poll would destroy and
    // rebuild the map, snapping the view and closing popups with no user input.
    // `attempt` changes only on a retry after the Leaflet chunk failed to load,
    // when there is no map to lose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, attempt]);

  // Structure follows the data. Nothing here reads `now`.
  useEffect(redraw, [data, redraw]);

  // ⚠️ The age tick rewrites text and NOTHING else. It must never clear a
  // layer group: a player reading a pin note would lose the note and its
  // Delete button mid-read, twice a minute, with no input of their own.
  // A rewritten age can change the card's height (an expiry wrapping to a
  // second line), so the fit is taken again — never the layers.
  useEffect(() => { refreshAges(allAges(), now); fitPopupNow.current(); }, [now]);

  // One group per layer, added and removed on its switch.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    for (const key of ALL_KEYS) {
      const g = groups.current[key];
      if (!g) continue;
      if (enabled[key] && !m.hasLayer(g)) m.addLayer(g);
      if (!enabled[key] && m.hasLayer(g)) m.removeLayer(g);
    }
  }, [enabled, data]);

  // ⚠️ ONE condition, read twice. The pin sheet and the bottom bar are
  // mutually exclusive, and when they were written as `pinAt && layers.pins`
  // against `!pinAt` they could both be false at once — leaving a full-screen
  // map with no controls and no way back.
  const pinSheet = pinAt !== null && layers.pins;
  const pinHere = () => { if (centre) setPinAt(pinAtCentre(centre)); };

  // The popup's Delete button (map-draw.ts) carries `data-arm`: the first
  // tap swaps its label for that text, the second within four seconds
  // submits. Delegated from the map's own element, because Leaflet builds
  // the popup's DOM itself and rebuilds it on every open.
  useEffect(() => {
    const root = el.current;
    if (!root) return;
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>("button[data-arm]");
      if (!btn || btn.dataset.armed) return;
      e.preventDefault();
      const label = btn.textContent;
      btn.dataset.armed = "1";
      btn.textContent = btn.dataset.arm ?? label;
      btn.classList.add("bg-rust/15");
      setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = label; btn.classList.remove("bg-rust/15"); } }, 4_000);
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, []);

  // Escape closes the panel; nothing else on this page listens for it.
  useEffect(() => {
    if (!layersOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLayersOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layersOpen]);
  // Read once the component is on a page: the fallbacks equal the tokens, so
  // the server render and the browser agree on every glyph.
  const pal = palette();

  return (
    // `isolate` is load-bearing, not cosmetic: Leaflet puts its panes at
    // 200-700 and its controls at 1000, absolutely positioned. Without a
    // stacking context here they paint over everything else on the site.
    <main ref={shell} id="main" tabIndex={-1} aria-label="The map" className="fixed inset-x-0 bottom-0 top-bar isolate bg-terrain outline-none">
      <h1 className="sr-only">The map</h1>
      {/* The refresh's one announcement. Not the button: its text follows every pan. */}
      <p role="status" className="sr-only">{announce}</p>
      {/* Leaflet makes this element keyboard-pannable (tabindex 0); the name says what it is and how to move through it. */}
      <div ref={el} role="region" aria-label={MAP_REGION_LABEL} className="absolute inset-0" />
      <MapStatus view={view} onRetry={retry} />

      {pinSheet && pinAt.follow && (
        // The cross marks the map's centre, which is where a "Pin here" draft
        // lands. It sits between the markers (600) and the popups (700): over
        // everything it points at, under anything open. The map ends
        // `--cw-inset` above the bottom, so its centre is half of what remains.
        <div aria-hidden="true" className="pointer-events-none absolute left-1/2 z-[650] -translate-x-1/2 -translate-y-1/2 text-gold" style={{ top: "calc((100% - var(--cw-inset, 0px)) / 2)" }}>
          <Reticle size={32} />
        </div>
      )}

      {/*
        ⚠️ An overlay, not an early return. Returning message JSX instead of
        the page unmounted the container while the creation effect neither
        re-ran nor cleaned up: the L.Map kept its listeners on a detached
        element, and if the error ever cleared the remounted container could
        never be given a map again. Rendering over the top leaves that
        effect's cleanup the single owner of teardown; the poll stops on its
        own (see `terminal` above).
      */}
      {terminal && (
        <div className="absolute inset-0 z-[1200] flex items-center justify-center bg-ground/95 px-6">
          <p role="status" className="max-w-[24rem] text-center text-ink-2">
            {error === "unauthenticated"
              ? <>Your session could not be read. <a className="text-gold underline-offset-4 hover:underline" href="/login?next=/map">Sign in again</a>.</>
              : <><a className="text-gold underline-offset-4 hover:underline" href="/link">Link your character</a> first — the map is behind login and a linked character.</>}
          </p>
        </div>
      )}

      {pinSheet && (
        <form
          ref={insetBy}
          method="post" action="/api/map/pin"
          className="absolute inset-x-0 bottom-0 z-[1100] max-h-[70dvh] overflow-y-auto border-t-2 border-rule-2 bg-frame p-4 lg:inset-x-auto lg:bottom-6 lg:left-6 lg:w-[360px] lg:border-2"
        >
          <input type="hidden" name="x" value={pinAt.x} />
          <input type="hidden" name="z" value={pinAt.z} />
          <p className="font-display text-[13px] uppercase tracking-[0.06em] text-ink"><span className="mr-3 text-gold">Pin</span>{gridRef(pinAt.x, pinAt.z)}</p>
          {pinAt.follow && <p className="mt-1 font-mono text-[11px] text-muted">{PIN_FOLLOW}</p>}
          <fieldset className="mt-3 grid grid-cols-3 gap-2">
            <legend className="sr-only">Icon</legend>
            {PIN_ICONS.map((icon, i) => (
              <label key={icon} className="flex min-h-[44px] cursor-pointer items-center gap-2 border-2 border-rule-3 px-2.5 text-[13px] text-ink has-[:checked]:border-gold has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-gold">
                <input type="radio" name="icon" value={icon} defaultChecked={i === 0} className="sr-only" />
                <span aria-hidden="true" className="flex flex-none" dangerouslySetInnerHTML={{ __html: pinGlyph(pal, icon, 22) }} />
                {PIN_ICON_LABELS[icon]}
              </label>
            ))}
          </fieldset>
          <textarea
            name="note" maxLength={PIN_NOTE_MAX} rows={2} placeholder={`A note, ${PIN_NOTE_MAX} characters at most`}
            className="mt-3 w-full border-2 border-rule-3 bg-ground p-2.5 font-mono text-sm text-ink placeholder:text-muted focus:border-gold focus:outline-none"
          />
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="submit" className="flex min-h-[48px] items-center justify-center bg-gold font-display text-xs uppercase tracking-[0.06em] text-ground hover:bg-gold-hover">Drop a pin</button>
            <button type="button" onClick={() => setPinAt(null)} className="flex min-h-[48px] items-center justify-center border-2 border-rule-2 font-display text-xs uppercase tracking-[0.06em] text-ink">Cancel</button>
          </div>
        </form>
      )}

      {!pinSheet && (
        <>
          {/* Desktop: a sprocket top right opens the layers as a panel under it; grid and refresh bottom left. */}
          <div className="absolute right-6 top-6 z-[1100] hidden flex-col items-end gap-2 lg:flex">
            <button
              type="button" onClick={() => setLayersOpen((o) => !o)} aria-expanded={layersOpen} aria-controls="map-layers"
              className={`flex h-11 w-11 items-center justify-center border-2 bg-frame ${layersOpen ? "border-gold text-gold" : "border-rule-2 text-ink hover:text-gold"}`}
            >
              <Sprocket />
              <span className="sr-only">Layers</span>
            </button>
            {layersOpen && (
              <aside id="map-layers" className="w-[300px] border-2 border-rule-2 bg-frame">
                <div className="flex items-center justify-between border-b-2 border-rule-2 px-5 py-3.5">
                  <h2 className="m-0 font-display text-sm uppercase tracking-[0.06em] text-ink">Layers</h2>
                  <span className="font-mono text-[11px] text-muted">Fixes every {POSITION_FIX_MS / 60_000} min</span>
                </div>
                <ul className="py-1.5">
                  {visible.map((key) => (
                    <li key={key}>
                      <label className="flex min-h-[44px] cursor-pointer items-center gap-3 px-5 text-sm text-ink">
                        <input type="checkbox" className="h-4 w-4 flex-none accent-gold" checked={enabled[key]} onChange={() => toggle(key)} />
                        <span aria-hidden="true" className={`flex flex-none ${enabled[key] ? "" : "opacity-40"}`} dangerouslySetInnerHTML={{ __html: layerIcon(pal, key) }} />
                        {LAYER_LABELS[key]}
                        <span className="ml-auto font-mono text-[11px] text-muted">{enabled[key] ? "ON" : "OFF"}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                {missing.length > 0 && (
                  <ul className="border-t border-rule-2 py-1.5" aria-label="Not on your map yet">
                    {missing.map((key) => (
                      <li key={key} className="flex min-h-[36px] items-center gap-3 px-5 text-sm text-dim">
                        <span aria-hidden="true" className="flex flex-none opacity-40" dangerouslySetInnerHTML={{ __html: layerIcon(pal, key) }} />
                        {LAYER_LABELS[key]} <span className="font-mono text-[11px] text-muted">— {LAYER_REASONS[key]}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <MapRoster rows={rows} onGo={goTo} />
                <div className="border-t border-rule-2 px-5 py-3 font-mono text-xs leading-relaxed text-muted">Last known, not live. Markers older than 24 h are dimmed.{layers.pins && ` ${PIN_HINT}`}{guide && <> <a className="text-gold hover:underline" href={guide.href}>In the guide: {guide.label} →</a></>}</div>
              </aside>
            )}
          </div>
          {hint && (
            <div role="note" className="absolute inset-x-4 top-[calc(50%-40px)] z-[1100] border-2 border-gold bg-frame px-4 py-3.5 lg:inset-x-auto lg:left-6 lg:top-auto lg:bottom-24 lg:w-[360px]">
              <div className="flex items-baseline justify-between gap-4">
                <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-gold">{MAP_HINT.kicker}</span>
                <button type="button" onClick={dismissHint} className="-mr-2 flex h-9 w-9 items-center justify-center font-mono text-sm text-muted hover:text-ink" aria-label="Dismiss">✕</button>
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-ink">{MAP_HINT.before}<a className="text-gold hover:underline" href="/base">{MAP_HINT.cta}</a>{MAP_HINT.after}</p>
              <p className="mt-2 text-xs leading-relaxed text-muted">{MAP_HINT.more}</p>
            </div>
          )}
          {/*
            Notices stay visible with the panel closed: a failed refresh is not
            a setting. Top centre, because the zoom control owns the top-left
            corner and the layers the top-right: at left-6 top-6 a notice sat
            over the zoom buttons for as long as it stayed up.
          */}
          {(shownNotice || view === "stale") && (
            <div className="absolute left-1/2 top-6 z-[1100] hidden w-[360px] -translate-x-1/2 lg:block">
              <MapNotices notice={shownNotice} stale={view === "stale"} onDismiss={() => setShownNotice(undefined)} tone="frame" />
            </div>
          )}
          <div className="absolute bottom-6 left-6 z-[1100] hidden items-stretch border-2 border-rule-2 bg-frame font-display text-xs uppercase tracking-[0.06em] lg:flex">
            <span className="flex min-h-[44px] items-center px-4 font-mono text-[11px] tracking-[0.18em] text-muted">Grid {centre?.grid ?? "000 000"}</span>
            <button type="button" onClick={recentre} disabled={!hasFix} title={hasFix ? "Center on your last known position" : "No position for you yet"}
              className="flex min-h-[44px] items-center gap-2 border-l border-rule-2 px-4 text-ink hover:text-gold disabled:opacity-40 disabled:hover:text-ink">
              <Reticle size={16} /> Center on me
            </button>
            {layers.pins && (
              <button type="button" data-pin-here onClick={pinHere} disabled={centre === null}
                className="flex min-h-[44px] items-center gap-2 border-l border-rule-2 px-4 text-ink hover:text-gold disabled:opacity-40 disabled:hover:text-ink">
                <PinMark size={16} /> Pin here
              </button>
            )}
            <button type="button" onClick={() => void refreshTap()} className="flex min-h-[44px] items-center border-l border-rule-2 px-4 text-ink hover:text-gold">Refresh</button>
            <a className="flex min-h-[44px] items-center border-l border-rule-2 bg-gold px-4 text-ground hover:bg-gold-hover" href={next.href}>{next.label}</a>
          </div>

          {/* Phones: a bottom bar; the sprocket unfolds the layers as chips above it. */}
          <div ref={insetBy} className="absolute inset-x-0 bottom-0 z-[1100] max-h-[45dvh] overflow-y-auto border-t-2 border-rule-2 bg-frame pb-[env(safe-area-inset-bottom)] lg:hidden">
            {(shownNotice || view === "stale") && (
              <div className="mx-4 mt-3">
                <MapNotices notice={shownNotice} stale={view === "stale"} onDismiss={() => setShownNotice(undefined)} tone="surface" />
              </div>
            )}
            {layersOpen && (
              <div id="map-layers-sheet">
              <div className="flex gap-2 overflow-x-auto px-4 pb-3 pt-3">
                {visible.map((key) => (
                  <label key={key} className={`flex min-h-[44px] flex-none cursor-pointer items-center gap-2 border-2 px-3 font-mono text-[11px] uppercase tracking-[0.12em] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-gold ${enabled[key] ? "border-gold text-ink" : "border-rule-3 text-muted"}`}>
                    <input type="checkbox" className="sr-only" checked={enabled[key]} onChange={() => toggle(key)} />
                    <span aria-hidden="true" className="flex flex-none" dangerouslySetInnerHTML={{ __html: layerIcon(pal, key, 16) }} />
                    {LAYER_LABELS[key]}
                  </label>
                ))}
              </div>
              <MapRoster rows={rows} onGo={goTo} />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-rule-2 px-4 py-2 font-mono text-[11px] leading-relaxed text-muted">
                <span>Last known, not live.</span>
                {layers.pins && <span>{PIN_HINT}</span>}
                {guide && <a className="text-gold hover:underline" href={guide.href}>In the guide: {guide.label} →</a>}
              </div>
              </div>
            )}
            <div className={`flex items-center gap-2 px-4 py-2.5 ${layersOpen ? "border-t border-rule-2" : ""}`}>
              <button
                type="button" onClick={() => setLayersOpen((o) => !o)} aria-expanded={layersOpen} aria-controls="map-layers-sheet"
                className={`flex h-11 w-11 items-center justify-center border-2 ${layersOpen ? "border-gold text-gold" : "border-rule-3 text-ink"}`}
              >
                <Sprocket size={18} />
                <span className="sr-only">Layers</span>
              </button>
              <button type="button" onClick={recentre} disabled={!hasFix} title={hasFix ? "Center on your last known position" : "No position for you yet"}
                className="flex h-11 w-11 items-center justify-center border-2 border-rule-3 text-ink disabled:opacity-40">
                <Reticle size={18} />
                <span className="sr-only">Center on me</span>
              </button>
              {layers.pins && (
                <button type="button" data-pin-here onClick={pinHere} disabled={centre === null}
                  className="flex h-11 w-11 flex-none items-center justify-center border-2 border-rule-3 text-ink disabled:opacity-40">
                  <PinMark size={18} />
                  <span className="sr-only">Pin here</span>
                </button>
              )}
              {/* The grid cell is the refresh button: a tap reloads and says so for two seconds. */}
              <button type="button" onClick={() => void refreshTap()} title="Refresh"
                className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 border-2 border-rule-3 px-3 font-mono text-[11px] text-muted">
                {flash ? <span className="truncate text-ink">Refreshed · just now</span> : <><span className="truncate">{centre?.grid ?? "000 000"}</span><svg width="14" height="14" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="square" aria-hidden="true" className="ml-auto flex-none"><path d="M23 14a9 9 0 1 1-3-6.7" /><path d="M20 3v5h-5" /></svg></>}
                <span className="sr-only">Refresh the map. Centre: grid {centre?.grid ?? "000 000"}</span>
              </button>
              <a className="flex min-h-[44px] flex-none items-center bg-gold px-3.5 font-display text-xs uppercase tracking-[0.06em] text-ground" href={next.href}>{next.label}</a>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
