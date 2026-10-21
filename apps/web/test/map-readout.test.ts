import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MapReadout, nextCursor, trackCursor } from "../app/(site)/map/map-readout";
import { worldToLatLng } from "../lib/map-projection";

const size = 16384;

/** A stub map: records handlers by event name, and fires them. */
function stubMap() {
  const on = new Map<string, ((e: unknown) => void)[]>();
  return {
    on: (name: string, fn: (e: unknown) => void) => { on.set(name, [...(on.get(name) ?? []), fn]); },
    off: (name: string, fn: (e: unknown) => void) => { on.set(name, (on.get(name) ?? []).filter((f) => f !== fn)); },
    fire: (name: string, e: unknown = {}) => { for (const f of on.get(name) ?? []) f(e); },
    count: (name: string) => (on.get(name) ?? []).length,
  };
}
/** rAF by hand: frames run when the test says so. */
function stubRaf() {
  const q = new Map<number, () => void>();
  let id = 0;
  return { request: (cb: () => void) => { q.set(++id, cb); return id; }, cancel: (n: number) => { q.delete(n); }, flush: () => { const cbs = [...q.values()]; q.clear(); cbs.forEach((c) => c()); }, pending: () => q.size };
}
const move = (x: number, z: number) => ({ latlng: worldToLatLng(x, z, size) });

describe("nextCursor", () => {
  it("hands back the same object when the rounded metres have not moved, so React skips the render", () => {
    const a = nextCursor(null, { x: 7216.2, z: 5706.4 });
    expect(a).toEqual({ x: 7216, z: 5706 });
    expect(nextCursor(a, { x: 7215.8, z: 5705.6 })).toBe(a);
    expect(nextCursor(a, { x: 7217.1, z: 5706 })).toEqual({ x: 7217, z: 5706 });
  });
});

describe("trackCursor", () => {
  it("updates at most once a frame, from the last move in it", () => {
    const m = stubMap(), raf = stubRaf();
    let cur: { x: number; z: number } | null = null;
    let sets = 0;
    trackCursor(m as never, size, (u) => { sets++; cur = u(cur); }, raf);
    m.fire("mousemove", move(100, 100));
    m.fire("mousemove", move(200, 200));
    expect(raf.pending()).toBe(1);
    raf.flush();
    expect(sets).toBe(1);
    expect(cur).toEqual({ x: 200, z: 200 });
  });

  it("keeps the last position on mouseout, so moving onto the readout to copy it copies the hovered point", () => {
    const m = stubMap(), raf = stubRaf();
    let cur: { x: number; z: number } | null = null;
    trackCursor(m as never, size, (u) => { cur = u(cur); }, raf);
    m.fire("mousemove", move(7216, 5706));
    raf.flush();
    m.fire("mouseout");
    raf.flush();
    expect(cur).toEqual({ x: 7216, z: 5706 });
    expect(m.count("mouseout")).toBe(0);
  });

  it("unsubscribes and drops a pending frame", () => {
    const m = stubMap(), raf = stubRaf();
    const stop = trackCursor(m as never, size, () => { throw new Error("no update after stop"); }, raf);
    m.fire("mousemove", move(1, 1));
    stop();
    expect(raf.pending()).toBe(0);
    expect(m.count("mousemove")).toBe(0);
  });
});

describe("MapReadout", () => {
  it("reads the centre before the mouse moves", () => {
    const html = renderToStaticMarkup(createElement(MapReadout, { map: null, size, centre: { x: 7216, z: 9334 }, variant: "bar" }));
    expect(html).toContain("GPS 072 / 070 · 7216, 9334");
  });

  it("owns the cursor: MapView keeps no cursor state, so a mouse move re-renders the readout alone", () => {
    const view = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "map", "map-view.tsx"), "utf8");
    expect(view).not.toMatch(/setCursor|"mousemove"/u);
    expect(view.match(/<MapReadout /gu)).toHaveLength(2);
  });
});
