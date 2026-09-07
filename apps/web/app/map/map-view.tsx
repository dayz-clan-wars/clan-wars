"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type * as L from "leaflet";
import { PIN_ICONS, PIN_NOTE_MAX, POSITION_FIX_MS } from "@factions/domain";
import { MAX_ZOOM, gridRef, latLngToWorld, worldToLatLng } from "@/lib/map-projection";
import { LAYER_LABELS, PIN_ICON_GLYPHS, PIN_ICON_LABELS } from "@/lib/map-copy";
import {
  TRAVEL_PANE, type Ctx, type MapData, type WireState,
  drawBase, drawClanmates, drawGrid, drawIntruders, drawPins, drawPublicBases, drawTravel, drawYou, parseState, ptFor,
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

export default function MapView({ layers, notice }: { layers: MapData["layers"]; notice?: string }) {
  const el = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<MapData | null>(null);
  const [error, setError] = useState<"unauthenticated" | "not-linked" | "failed" | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [enabled, setEnabled] = useState<Record<LayerKey, boolean>>(ALL_ON);
  const [centre, setCentre] = useState("000 000");
  const [pinAt, setPinAt] = useState<{ x: number; z: number } | null>(null);

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

  useEffect(() => {
    setEnabled(loadSwitches());
    void load();
    const id = setInterval(() => void load(), POSITION_FIX_MS);
    return () => clearInterval(id);
  }, [load]);

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
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const size = data?.world.size ?? null;

  const redraw = useCallback(() => {
    const Lm = leaflet.current;
    const m = map.current;
    const d = dataRef.current;
    if (!Lm || !m || !d) return;
    const pt = ptFor(Lm, d.world.size);

    for (const key of ALL_KEYS) {
      // Created and added as two statements, never `layerGroup().addTo(m)`:
      // leaning on addTo's return value means a group that never lands in the
      // ref is rebuilt on every poll, forever.
      if (!groups.current[key]) {
        const g = Lm.layerGroup();
        groups.current[key] = g;
      }
    }

    const ctx = (key: LayerKey): Ctx => ({ L: Lm, group: groups.current[key]!, pt, data: d, now: nowRef.current });
    // The same groups, cleared and rebuilt rather than diffed — what is on the
    // map stays in lockstep with the data, with no stale layer left behind.
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
        redraw();
        for (const key of ALL_KEYS) if (enabledRef.current[key]) m.addLayer(groups.current[key]!);

        const readCentre = () => { const c = latLngToWorld(m.getCenter().lat, m.getCenter().lng, size); setCentre(gridRef(c.x, c.z)); };
        readCentre();
        m.on("moveend", readCentre);
        // Long-press on touch, right-click on desktop — Leaflet gives both the
        // same event, which is why the pin gesture needs no touch handling of
        // its own.
        m.on("contextmenu", (e: L.LeafletMouseEvent) => {
          const w = latLngToWorld(e.latlng.lat, e.latlng.lng, size);
          setPinAt({ x: Math.round(w.x), z: Math.round(w.z) });
        });

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
      gridDrawn.current = false;
      leaflet.current = null;
    };
    // Only `size`: re-running this per poll would destroy and rebuild the map,
    // snapping the view and closing popups with no user input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  useEffect(redraw, [data, now, redraw]);

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

  if (error === "unauthenticated") {
    return <main className="mx-auto max-w-[34rem] px-4 py-10"><p className="text-ink-2">Your session could not be read. <a className="text-gold underline-offset-4 hover:underline" href="/login?next=/map">Sign in again</a>.</p></main>;
  }
  if (error === "not-linked") {
    return <main className="mx-auto max-w-[34rem] px-4 py-10"><p className="text-ink-2"><a className="text-gold underline-offset-4 hover:underline" href="/link">Link your character</a> first — the map is behind login and a linked character.</p></main>;
  }

  return (
    // `isolate` is load-bearing, not cosmetic: Leaflet puts its panes at
    // 200-700 and its controls at 1000, absolutely positioned. Without a
    // stacking context here they paint over everything else on the site.
    <div className="fixed inset-0 isolate bg-terrain">
      <div ref={el} className="absolute inset-0" />

      {pinAt && layers.pins && (
        <form
          method="post" action="/api/map/pin"
          className="absolute inset-x-0 bottom-0 z-[1100] max-h-[70dvh] overflow-y-auto border-t border-rule bg-frame p-4"
        >
          <input type="hidden" name="x" value={pinAt.x} />
          <input type="hidden" name="z" value={pinAt.z} />
          <p className={bar}>Drop a pin at {gridRef(pinAt.x, pinAt.z)}</p>
          <fieldset className="mt-3 flex flex-wrap gap-2">
            <legend className="sr-only">Icon</legend>
            {PIN_ICONS.map((icon, i) => (
              <label key={icon} className="flex min-h-[44px] cursor-pointer items-center gap-2 rounded-md border border-rule-2 px-3 text-sm text-ink has-[:checked]:border-gold">
                <input type="radio" name="icon" value={icon} defaultChecked={i === 0} className="h-4 w-4" />
                <span aria-hidden="true">{PIN_ICON_GLYPHS[icon]}</span> {PIN_ICON_LABELS[icon]}
              </label>
            ))}
          </fieldset>
          <textarea
            name="note" maxLength={PIN_NOTE_MAX} rows={2} placeholder={`A note, ${PIN_NOTE_MAX} characters at most`}
            className="mt-3 w-full rounded-md border border-rule-2 bg-surface p-2 text-sm text-ink"
          />
          <div className="mt-3 flex gap-2">
            <button type="submit" className="min-h-[44px] rounded-md bg-gold px-4 font-display text-ground">Drop</button>
            <button type="button" onClick={() => setPinAt(null)} className="min-h-[44px] rounded-md border border-rule px-4 font-display text-ink">Cancel</button>
          </div>
        </form>
      )}

      {!pinAt && (
        <div className="absolute inset-x-0 bottom-0 z-[1100] max-h-[45dvh] overflow-y-auto border-t border-rule bg-frame/95 p-3">
          {notice && <p role="status" className="mb-2 rounded-md border border-rule-2 bg-surface p-2 text-sm text-ink">{notice}</p>}
          {error === "failed" && <p role="status" className="mb-2 rounded-md border border-rust bg-surface p-2 text-sm text-ink">The map could not be refreshed. What you see may be out of date.</p>}
          <div className="flex flex-wrap gap-2">
            {visible.map((key) => (
              <label key={key} className="flex min-h-[44px] cursor-pointer items-center gap-2 rounded-md border border-rule-2 px-3 text-sm text-ink has-[:checked]:border-gold">
                <input type="checkbox" className="h-4 w-4" checked={enabled[key]} onChange={() => toggle(key)} />
                {LAYER_LABELS[key]}
              </label>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-4">
            <span className={bar}>Grid {centre}</span>
            <button type="button" onClick={() => void load()} className={`${bar} underline-offset-4 hover:underline`}>Refresh</button>
            <a className={`${bar} underline-offset-4 hover:underline`} href="/me">Your page</a>
            <a className={`${bar} underline-offset-4 hover:underline`} href="/clan">Your clan</a>
            {layers.pins && <span className={bar}>Press and hold to drop a pin</span>}
          </div>
        </div>
      )}
    </div>
  );
}
