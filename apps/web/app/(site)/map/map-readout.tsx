"use client";
import { useEffect, useState } from "react";
import type * as L from "leaflet";
import { READOUT_COPY } from "@/lib/map-copy";
import { latLngToWorld } from "@/lib/map-projection";
import { readoutText } from "@/lib/map-search";

type Point = { x: number; z: number };

/**
 * The next cursor to store, or `prev` itself when the rounded metres have not moved.
 * Returning the same object is what makes React skip the render.
 */
export function nextCursor(prev: Point | null, next: Point): Point | null {
  const x = Math.round(next.x), z = Math.round(next.z);
  return prev && prev.x === x && prev.z === z ? prev : { x, z };
}

type Raf = { request: (cb: () => void) => number; cancel: (id: number) => void };
const RAF: Raf = { request: (cb) => requestAnimationFrame(cb), cancel: (id) => cancelAnimationFrame(id) };

/**
 * Follow the mouse over the map, at most once a frame, into `set`. Returns the
 * unsubscribe. Pure of React, so the throttle and the mouseout rule are tested
 * with a stub map.
 *
 * ⚠️ `mouseout` does NOT clear the cursor. Moving onto the readout button to click
 * it leaves the map, and clearing there swapped the hovered point for the centre
 * just before the click copied it.
 */
export function trackCursor(
  m: Pick<L.Map, "on" | "off">,
  size: number,
  set: (update: (prev: Point | null) => Point | null) => void,
  raf: Raf = RAF,
): () => void {
  let frame = 0;
  let last: L.LatLng | null = null;
  const onMove = (e: L.LeafletMouseEvent) => {
    last = e.latlng;
    frame ||= raf.request(() => {
      frame = 0;
      const at = last;
      if (at) set((prev) => nextCursor(prev, latLngToWorld(at.lat, at.lng, size)));
    });
  };
  m.on("mousemove", onMove as L.LeafletEventHandlerFn);
  return () => {
    m.off("mousemove", onMove as L.LeafletEventHandlerFn);
    if (frame) raf.cancel(frame);
    frame = 0;
  };
}

export type MapReadoutProps = {
  /** The live map, or null until it exists. */
  map: L.Map | null;
  size: number | null;
  /** The view's centre: what a touch screen reads, and the mouse's stand-in before it moves. */
  centre: Point | null;
  /** "bar" is the desktop bottom bar's cell; "row" is the phone's full-width row. */
  variant: "bar" | "row";
};

/**
 * The readout: "GPS 072 / 087 · 7216, 5706" under the mouse on desktop, the centre
 * otherwise; a tap copies it.
 *
 * ⚠️ Its own component, holding its own cursor state: in MapView, a mouse move
 * re-rendered the whole map page — roster, panels, search and all — every frame.
 *
 * The readout shows coordinates, and that is allowed: it is only ever the cursor or
 * the centre, never attached to a player marker (lib/map-search.ts `readoutText`).
 */
export function MapReadout({ map, size, centre, variant }: MapReadoutProps) {
  const [cursor, setCursor] = useState<Point | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    // Only where there is a hovering pointer; a touch screen reads the centre, which is what the player is looking at.
    if (!map || size === null || !window.matchMedia?.("(hover: hover)").matches) return;
    return trackCursor(map, size, setCursor);
  }, [map, size]);
  const here = cursor ?? centre;
  const text = here && size !== null ? readoutText(here.x, here.z, size) : "GPS 000 / 000";
  const copy = () => {
    // ⚠️ Silent on refusal: an insecure context has no clipboard, and a denied write
    // is the browser's answer, not something the player can act on.
    try {
      void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1_500); }, () => {});
    } catch { /* no clipboard */ }
  };
  if (variant === "bar") {
    return (
      <button type="button" onClick={copy} title={READOUT_COPY.copy}
        className="flex min-h-[44px] min-w-[31ch] items-center px-4 font-mono text-[11px] tracking-[0.06em] text-muted tabular-nums hover:text-ink">
        {copied ? READOUT_COPY.copied : text}
      </button>
    );
  }
  return (
    <button type="button" onClick={copy} className="flex min-h-[44px] w-full items-center gap-3 px-4 font-mono text-[11px] text-muted tabular-nums">
      <span className="truncate">{text}</span>
      <span className="ml-auto flex-none uppercase tracking-[0.12em] text-ink">{copied ? READOUT_COPY.copied : READOUT_COPY.copy}</span>
    </button>
  );
}
