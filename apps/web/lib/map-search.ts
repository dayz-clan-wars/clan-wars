import { gridRef, parseCoordQuery, type CoordQuery } from "./map-projection";
import { SEARCH_COPY } from "./map-copy";

/**
 * The map's search box, minus the box: one query in, a coordinate and the
 * matching names out. Pure, so the ranking is tested without a DOM.
 *
 * Coordinates come first because they are what the box is for: the Morse-code
 * bunker broadcasts give players GPS numbers, and they type them straight in.
 */
export type SearchHit =
  | { tab: "locations"; label: string; x: number; z: number }
  | { tab: "items"; className: string; label: string } // filled by Task 9
  | { tab: "models"; typeName: string; label: string; count: number }; // filled by Task 11
export type SearchTab = SearchHit["tab"];
export type SearchResult = { coord: CoordQuery; hits: SearchHit[] };
/** Places and bunkers in world metres. Task 9 adds `items?`, Task 11 adds `models?`. */
export type SearchCtx = { size: number; places: { name: string; x: number; z: number }[]; bunkers: { x: number; z: number }[] };

/** The zoom a picked result lands at, unless the player is already closer. */
export const SEARCH_ZOOM = 5;
export const searchZoom = (current: number): number => Math.max(current, SEARCH_ZOOM);

/**
 * How well a name matches. Every query word must start some word of the name, in
 * order; a name that starts with the whole query ranks above one that only
 * contains it ("no ab" → No Abad before M12 No Abad). Null is no match.
 */
/** Word breaks, the same for a name and a query, so a hyphenated name matches typed with or without its hyphen. */
const words = (s: string): string[] => s.toLowerCase().split(/[\s\-_/]+/u).filter(Boolean);

function score(name: string, query: readonly string[]): number | null {
  const lower = name.toLowerCase();
  const parts = words(name);
  let from = 0;
  let first = -1;
  for (const w of query) {
    let i = from;
    while (i < parts.length && !parts[i]!.startsWith(w)) i++;
    if (i === parts.length) return null;
    if (first < 0) first = i;
    from = i + 1;
  }
  // Lower is better: where the match starts, then how much name is left over.
  return first * 1000 + (lower.length - query.join(" ").length);
}

export function searchMap(q: string, ctx: SearchCtx): SearchResult {
  const query = q.trim();
  if (!query) return { coord: null, hits: [] };
  const coord = parseCoordQuery(query, ctx.size);
  // Two numbers are a coordinate, or a mistyped one. Either way they are not a name.
  if (coord) return { coord, hits: [] };
  const typed = words(query);
  // ⚠️ Numbered by their order in world.json, from 1: the same file, so the same
  // number every load. Reordering the mission's bunker list renumbers them.
  const named = [
    ...ctx.places,
    ...ctx.bunkers.map((b, i) => ({ name: `${SEARCH_COPY.bunker} ${i + 1}`, x: b.x, z: b.z })),
  ];
  const ranked: { s: number; hit: SearchHit }[] = [];
  for (const n of named) {
    const s = score(n.name, typed);
    if (s !== null) ranked.push({ s, hit: { tab: "locations", label: n.name, x: n.x, z: n.z } });
  }
  ranked.sort((a, b) => a.s - b.s || a.hit.label.localeCompare(b.hit.label, undefined, { numeric: true }));
  return { coord: null, hits: ranked.map((r) => r.hit) };
}

/**
 * The bottom bar's readout: "GPS 072 / 087 · 7216, 5706".
 *
 * These ARE coordinates on screen, and that is not a breach of the map's rule
 * (map-draw.ts, spec §10.3). The rule keeps a PLAYER's numbers out of tooltips
 * and labels. This readout is only ever where the cursor is, or the middle of the
 * view, and is never attached to a marker — the same numbers the in-game GPS shows
 * anyone standing there.
 */
export function readoutText(x: number, z: number, size: number): string {
  const cx = Math.min(size, Math.max(0, x)), cz = Math.min(size, Math.max(0, z));
  return `GPS ${gridRef(cx, cz, size).replace(" ", " / ")} · ${Math.round(cx)}, ${Math.round(cz)}`;
}
