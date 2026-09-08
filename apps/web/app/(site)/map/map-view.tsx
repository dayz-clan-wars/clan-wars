"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type * as L from "leaflet";
import { PIN_ICONS, PIN_NOTE_MAX, POSITION_FIX_MS } from "@factions/domain";
import { MAX_ZOOM, gridRef, latLngToWorld, worldToLatLng } from "@/lib/map-projection";
import { LAYER_LABELS, PIN_ICON_LABELS } from "@/lib/map-copy";
import { layerIcon, pinGlyph } from "@/lib/map-icons";
import {
  FAR_CLASS, TRAVEL_CHIP_ZOOM, TRAVEL_PANE, type AgeLabel, type Ctx, type MapData, type WireState,
  drawBase, drawClanmates, drawGrid, drawIntruders, drawPins, drawPublicBases, drawTravel, drawYou, palette, parseState, ptFor, refreshAges,
} from "./map-draw";
// ⚠️ Next special-cases a global stylesheet imported FROM node_modules: a
// third-party package's CSS may be imported in the component that needs it and
// still gets extracted, scoped to this component's chunk rather than loaded on
// every page. Do not move this to app/layout.tsx (that loads Leaflet's CSS
// site-wide) and do not delete it — without it Leaflet's panes, tiles and
// controls have no positioning CSS in a real browser.
import "leaflet/dist/leaflet.css";

/** Vendored from DZMap's own upstream config. Attribution is an obligation, not decoration. */
const TILE_ATTRIBUTION = '<a href="https://dayz.xam.nu" target="_blank">Tiles © Xam.nu</a>';
/** A 1x1 transparent gif: absent tiles read as dark ground, not a broken-image checkerboard. */
const BLANK_TILE = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const LAYER_STORAGE_KEY = "clan-wars.map.layers";
/** Ages are recomputed far more often than positions are fetched, so a label never goes stale. */
const AGE_TICK_MS = 30_000;

type LayerKey = keyof typeof LAYER_LABELS;
/** The four every linked viewer has; the other four are gated on `layers.*`. */
const ALWAYS: LayerKey[] = ["you", "publicBases", "travel", "terrain"];
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

const bar = "font-mono text-xs uppercase tracking-[0.18em] text-muted";

/** The settings sprocket: an eight-tooth gear in the chip's stroke, currentColor so the button colours it. */
function Sprocket({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true">
      <circle cx="14" cy="14" r="4" />
      <path d="M14 2v4M14 22v4M2 14h4M22 14h4M5.5 5.5l2.8 2.8M19.7 19.7l2.8 2.8M5.5 22.5l2.8-2.8M19.7 8.3l2.8-2.8" />
      <circle cx="14" cy="14" r="8.5" />
    </svg>
  );
}

export default function MapView({ layers, notice, guide }: { layers: MapData["layers"]; notice?: string; guide?: { href: string; label: string } }) {
  const el = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<MapData | null>(null);
  const [error, setError] = useState<"unauthenticated" | "not-linked" | "failed" | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [enabled, setEnabled] = useState<Record<LayerKey, boolean>>(ALL_ON);
  const [centre, setCentre] = useState("000 000");
  const [pinAt, setPinAt] = useState<{ x: number; z: number } | null>(null);
  // The layers live behind a sprocket. Closed by default: the map is the
  // page, and a panel that stays open covers the terrain a player came for.
  const [layersOpen, setLayersOpen] = useState(false);

  const visible = ALL_KEYS.filter((k) => ALWAYS.includes(k) || layers[k as keyof MapData["layers"]]);

  // ── The fetch loop ────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/map/state", { cache: "no-store" });
      if (res.status === 401) return setError("unauthenticated");
      if (res.status === 403) return setError("not-linked");
      if (!res.ok) return setError("failed");
      setError(null);
      setData(parseState((await res.json()) as WireState));
    } catch {
      setError("failed");
    }
  }, []);

  // 401 and 403 are answers, not outages: the session is gone or the character
  // is not linked, and neither is fixed by asking again five minutes later.
  const terminal = error === "unauthenticated" || error === "not-linked";

  useEffect(() => {
    setEnabled(loadSwitches());
    void load();
  }, [load]);

  useEffect(() => {
    if (terminal) return;
    const id = setInterval(() => void load(), POSITION_FIX_MS);
    return () => clearInterval(id);
  }, [load, terminal]);

  // Ages tick between fetches: a fix five minutes old must not read "just now"
  // for the whole interval.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const toggle = (key: LayerKey) => {
    setEnabled((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try { window.localStorage.setItem(LAYER_STORAGE_KEY, JSON.stringify(next)); } catch { /* storage is a convenience */ }
      return next;
    });
  };

  // ── Leaflet ───────────────────────────────────────────────────────────────
  const leaflet = useRef<typeof import("leaflet") | null>(null);
  const map = useRef<L.Map | null>(null);
  const groups = useRef<Partial<Record<LayerKey, L.LayerGroup>>>({});
  const gridDrawn = useRef(false);
  const dataRef = useRef<MapData | null>(null);
  dataRef.current = data;
  const nowRef = useRef(now);
  nowRef.current = now;

  const observer = useRef<ResizeObserver | null>(null);
  // `layers` comes from the server render and never changes for a mounted
  // MapView, but the creation effect deliberately depends on `size` alone —
  // reading it through a ref keeps that honest.
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const size = data?.world.size ?? null;

  const ages = useRef<AgeLabel[]>([]);

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

    const ctx = (key: LayerKey): Ctx => ({ L: Lm, group: groups.current[key]!, pt, data: d, now: nowRef.current, ages: ages.current, p });
    // The same groups, cleared and rebuilt rather than diffed — what is on the
    // map stays in lockstep with the data, with no stale layer left behind.
    // ⚠️ This runs on NEW DATA ONLY. See the age tick below and AgeLabel in
    // map-draw.ts: rebuilding on the 30 s tick tore down every open popup.
    ages.current = [];
    for (const key of ALL_KEYS) if (key !== "terrain") groups.current[key]!.clearLayers();
    drawYou(ctx("you"));
    drawBase(ctx("base"));
    drawClanmates(ctx("clanmates"));
    drawIntruders(ctx("intruders"));
    drawPublicBases(ctx("publicBases"));
    drawPins(ctx("pins"));
    drawTravel(ctx("travel"));
    // The grid never changes, so it is drawn once — redrawing 26 polylines
    // every poll would be churn with nothing to show for it.
    if (!gridDrawn.current) {
      drawGrid(Lm, groups.current.terrain!, pt, d.world.size);
      gridDrawn.current = true;
    }
  }, []);

  useEffect(() => {
    if (!el.current || size === null) return;
    let cancelled = false;

    // Dynamically imported so Leaflet never enters the server bundle and never
    // runs during SSR — this page's HTML must stay coordinate-free.
    void import("leaflet")
      .then((mod) => {
        if (cancelled || !el.current) return;
        const Lm = mod.default ?? (mod as unknown as typeof import("leaflet"));
        leaflet.current = Lm;
        const m = Lm.map(el.current, {
          crs: Lm.CRS.Simple, minZoom: 0, maxZoom: MAX_ZOOM,
          // Quarter steps: whole-level snapping makes a fractional zoom floor
          // unreachable, and no snapping at all makes the wheel rescale tiles
          // continuously instead of stepping between rendered levels.
          zoomSnap: 0.25,
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

        m.fitBounds(world);
        far();
        redraw();
        for (const key of ALL_KEYS) if (enabledRef.current[key]) m.addLayer(groups.current[key]!);

        const readCentre = () => { const c = latLngToWorld(m.getCenter().lat, m.getCenter().lng, size); setCentre(gridRef(c.x, c.z)); };
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
        if (layersRef.current.pins) {
          m.on("contextmenu", (e: L.LeafletMouseEvent) => {
            const w = latLngToWorld(e.latlng.lat, e.latlng.lng, size);
            setPinAt({ x: Math.round(w.x), z: Math.round(w.z) });
          });
        }

        // Leaflet measures the container once at creation and only listens for
        // WINDOW resizes; a full-viewport container settles after mount (bars
        // and fonts land late) and the stale measurement leaves a blank band.
        if (typeof ResizeObserver !== "undefined") {
          const ro = new ResizeObserver(() => map.current?.invalidateSize());
          ro.observe(el.current);
          observer.current = ro;
        }
      })
      .catch(() => { if (!cancelled) setError("failed"); });

    return () => {
      cancelled = true;
      observer.current?.disconnect();
      observer.current = null;
      map.current?.remove();
      map.current = null;
      groups.current = {};
      // With the groups gone, every AgeLabel points at a detached layer; an
      // age tick must not go looking for their tooltips.
      ages.current = [];
      gridDrawn.current = false;
      leaflet.current = null;
    };
    // Only `size`: re-running this per poll would destroy and rebuild the map,
    // snapping the view and closing popups with no user input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  // Structure follows the data. Nothing here reads `now`.
  useEffect(redraw, [data, redraw]);

  // ⚠️ The age tick rewrites text and NOTHING else. It must never clear a
  // layer group: a player reading a pin note would lose the note and its
  // Delete button mid-read, twice a minute, with no input of their own.
  useEffect(() => { refreshAges(ages.current, now); }, [now]);

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
    <div className="fixed inset-x-0 bottom-0 top-bar isolate bg-terrain">
      <div ref={el} className="absolute inset-0" />

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
          method="post" action="/api/map/pin"
          className="absolute inset-x-0 bottom-0 z-[1100] max-h-[70dvh] overflow-y-auto border-t-2 border-rule-2 bg-frame p-4 lg:inset-x-auto lg:bottom-6 lg:left-6 lg:w-[360px] lg:border-2"
        >
          <input type="hidden" name="x" value={pinAt.x} />
          <input type="hidden" name="z" value={pinAt.z} />
          <p className="font-display text-[13px] uppercase tracking-[0.06em] text-ink"><span className="mr-3 text-gold">Pin</span>{gridRef(pinAt.x, pinAt.z)}</p>
          <fieldset className="mt-3 grid grid-cols-3 gap-2">
            <legend className="sr-only">Icon</legend>
            {PIN_ICONS.map((icon, i) => (
              <label key={icon} className="flex min-h-[44px] cursor-pointer items-center gap-2 border-2 border-rule-2 px-2.5 text-[13px] text-ink has-[:checked]:border-gold">
                <input type="radio" name="icon" value={icon} defaultChecked={i === 0} className="sr-only" />
                <span aria-hidden="true" className="flex flex-none" dangerouslySetInnerHTML={{ __html: pinGlyph(pal, icon, 22) }} />
                {PIN_ICON_LABELS[icon]}
              </label>
            ))}
          </fieldset>
          <textarea
            name="note" maxLength={PIN_NOTE_MAX} rows={2} placeholder={`A note, ${PIN_NOTE_MAX} characters at most`}
            className="mt-3 w-full border-2 border-rule-2 bg-ground p-2.5 font-mono text-sm text-ink placeholder:text-dim focus:border-gold focus:outline-none"
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
                  <span className="font-mono text-[10px] text-muted">Fixes every {POSITION_FIX_MS / 60_000} min</span>
                </div>
                <ul className="py-1.5">
                  {visible.map((key) => (
                    <li key={key}>
                      <label className="flex min-h-[44px] cursor-pointer items-center gap-3 px-5 text-sm text-ink">
                        <input type="checkbox" className="h-4 w-4 flex-none accent-gold" checked={enabled[key]} onChange={() => toggle(key)} />
                        <span aria-hidden="true" className={`flex flex-none ${enabled[key] ? "" : "opacity-40"}`} dangerouslySetInnerHTML={{ __html: layerIcon(pal, key) }} />
                        {LAYER_LABELS[key]}
                        <span className={`ml-auto font-mono text-[10px] ${enabled[key] ? "text-muted" : "text-dim"}`}>{enabled[key] ? "ON" : "OFF"}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                <div className="border-t border-rule-2 px-5 py-3 font-mono text-[10px] leading-relaxed text-muted">Last known, not live. Markers older than 24 h are dimmed.{layers.pins && " Press and hold to drop a pin."}{guide && <> <a className="text-gold hover:underline" href={guide.href}>In the guide: {guide.label} →</a></>}</div>
              </aside>
            )}
          </div>
          {/* Notices stay visible with the panel closed: a failed refresh is not a setting. */}
          {(notice || error === "failed") && (
            <div className="absolute left-6 top-6 z-[1100] hidden w-[360px] lg:block">
              {notice && <p role="status" className="border border-rule-2 bg-frame px-3 py-2 text-sm text-ink">{notice}</p>}
              {error === "failed" && <p role="status" className="mt-2 border border-rust bg-frame px-3 py-2 text-sm text-ink">The map could not be refreshed. What you see may be out of date.</p>}
            </div>
          )}
          <div className="absolute bottom-6 left-6 z-[1100] hidden items-stretch border-2 border-rule-2 bg-frame font-display text-xs uppercase tracking-[0.06em] lg:flex">
            <span className="flex min-h-[44px] items-center px-4 font-mono text-[11px] tracking-[0.18em] text-muted">Grid {centre}</span>
            <button type="button" onClick={() => void load()} className="flex min-h-[44px] items-center border-l border-rule-2 px-4 text-ink hover:text-gold">Refresh</button>
            <a className="flex min-h-[44px] items-center border-l border-rule-2 px-4 text-ink hover:text-gold" href="/clan">Your clan</a>
          </div>

          {/* Phones: a bottom bar; the sprocket unfolds the layers as chips above it. */}
          <div className="absolute inset-x-0 bottom-0 z-[1100] max-h-[45dvh] overflow-y-auto border-t-2 border-rule-2 bg-frame lg:hidden">
            {notice && <p role="status" className="mx-4 mt-3 border border-rule-2 bg-surface px-3 py-2 text-sm text-ink">{notice}</p>}
            {error === "failed" && <p role="status" className="mx-4 mt-3 border border-rust bg-surface px-3 py-2 text-sm text-ink">The map could not be refreshed. What you see may be out of date.</p>}
            {layersOpen && (
              <div id="map-layers-sheet" className="flex gap-2 overflow-x-auto px-4 pb-3 pt-3">
                {visible.map((key) => (
                  <label key={key} className={`flex min-h-[40px] flex-none cursor-pointer items-center gap-2 border-2 px-3 font-mono text-[10px] uppercase tracking-[0.12em] ${enabled[key] ? "border-gold text-ink" : "border-rule-2 text-muted"}`}>
                    <input type="checkbox" className="sr-only" checked={enabled[key]} onChange={() => toggle(key)} />
                    <span aria-hidden="true" className="flex flex-none" dangerouslySetInnerHTML={{ __html: layerIcon(pal, key, 16) }} />
                    {LAYER_LABELS[key]}
                  </label>
                ))}
              </div>
            )}
            <div className={`flex flex-wrap items-center gap-4 px-4 py-2.5 ${layersOpen ? "border-t border-rule-2" : ""}`}>
              <button
                type="button" onClick={() => setLayersOpen((o) => !o)} aria-expanded={layersOpen} aria-controls="map-layers-sheet"
                className={`flex h-10 w-10 items-center justify-center border-2 ${layersOpen ? "border-gold text-gold" : "border-rule-2 text-ink"}`}
              >
                <Sprocket size={18} />
                <span className="sr-only">Layers</span>
              </button>
              <span className={bar}>Grid {centre}</span>
              <button type="button" onClick={() => void load()} className={`${bar} text-ink`}>Refresh</button>
              <a className={`${bar} text-ink`} href="/clan">Your clan</a>
              {layers.pins && <span className={bar}>Hold to pin</span>}
              {guide && <a className={`${bar} text-gold`} href={guide.href}>Guide</a>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
