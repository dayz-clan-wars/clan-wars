import type { MapData } from "./map-draw";
import { layerOfKey } from "@/lib/map-roster";

/**
 * Which layers a new answer from /api/map/state actually changed.
 *
 * ⚠️ Why this exists. Every poll used to clear and rebuild EVERY group, and
 * Leaflet closes a popup whose marker is removed. A player reading a pin
 * note, or halfway through the two-tap Delete, lost the card every five
 * minutes and on every Refresh, and 209 static travel markers were rebuilt
 * each time. Now a group is rebuilt only when its own slice of the data
 * changed, so an open popup on an unchanged layer is never touched at all.
 *
 * Terrain and place names are not here: the grid is drawn once, and places
 * follow the zoom, not the data.
 */
export const DATA_LAYERS = ["you", "base", "clanmates", "intruders", "bounties", "publicBases", "pins", "travel"] as const;
export type DataLayer = (typeof DATA_LAYERS)[number];
export type Signatures = Record<DataLayer, string>;

/** Each layer's slice of the data, as a string. Dates serialise as ISO, so a changed age is a changed signature. */
export function layerSignatures(d: MapData, hint: boolean): Signatures {
  return {
    // The hint's dashed ring is drawn into the "you" group, so it is part of that group's signature.
    you: JSON.stringify([d.you.fix, hint]),
    base: JSON.stringify(d.base),
    clanmates: JSON.stringify(d.clanmates),
    intruders: JSON.stringify(d.intruders),
    bounties: JSON.stringify(d.bounties),
    publicBases: JSON.stringify(d.publicBases),
    pins: JSON.stringify(d.pins),
    travel: JSON.stringify(d.travelPoints),
  };
}

export function changedLayers(prev: Partial<Signatures>, next: Signatures): DataLayer[] {
  return DATA_LAYERS.filter((k) => prev[k] !== next[k]);
}

/**
 * The popup to put back after a rebuild. Only one whose own layer was rebuilt
 * qualifies: its marker is new, and Leaflet closed the old marker's popup. A
 * popup on an untouched layer is still open, armed Delete and all. Reopening
 * it would rebuild its DOM and disarm the button.
 */
export function reopenAfter(openKey: string | null, changed: readonly DataLayer[]): string | null {
  if (!openKey) return null;
  const layer = layerOfKey(openKey);
  return layer !== null && changed.includes(layer) ? openKey : null;
}
