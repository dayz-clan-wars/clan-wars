import type { PinIcon } from "@factions/domain";
import { gridRef } from "./map-projection";
import { PIN_ICON_LABELS, fixAge } from "./map-copy";

/**
 * The map as a list, and the keys that tie a list row (or a remembered open
 * popup) back to the marker it names.
 *
 * ⚠️ A row is text, so the map's one rule applies (map-draw.ts): name, kind,
 * GRID REF and age, never a metre coordinate. A row does not even carry the
 * coordinate in an attribute. It finds its marker by key, and the marker
 * already knows where it is.
 */
export const markerKey = {
  you: (): string => "you",
  base: (): string => "base",
  clanmate: (dayzId: string): string => `clanmate:${dayzId}`,
  intruder: (gamertag: string): string => `intruder:${gamertag}`,
  bounty: (gamertag: string): string => `bounty:${gamertag}`,
  pin: (id: number): string => `pin:${id}`,
} as const;

export const ROSTER_LAYERS = ["you", "base", "clanmates", "intruders", "bounties", "pins"] as const;
export type RosterLayer = (typeof ROSTER_LAYERS)[number];

const KIND_LAYER: Readonly<Record<string, RosterLayer>> = {
  you: "you", base: "base", clanmate: "clanmates", intruder: "intruders", bounty: "bounties", pin: "pins",
};

/** The layer group a key's marker lives in, or null for a key this map never made. */
export function layerOfKey(key: string): RosterLayer | null {
  const kind = key.split(":")[0] ?? "";
  // ⚠️ `hasOwn`, not `in`: "__proto__" and "constructor" are in every object.
  return Object.hasOwn(KIND_LAYER, kind) ? KIND_LAYER[kind]! : null;
}

/** The slice of `MapData` the list reads. `MapData` satisfies it structurally; lib/ never imports from app/. */
export type RosterInput = {
  you: { fix: { x: number; z: number; at: Date } | null };
  base: { x: number; z: number } | null;
  clanmates: { dayzId: string; gamertag: string; fix: { x: number; z: number; at: Date } }[];
  intruders: { gamertag: string; x: number; z: number; lastSeenAt: Date; distanceM: number }[];
  bounties: { gamertag: string; fix: { x: number; z: number; at: Date } }[];
  pins: { id: number; x: number; z: number; icon: PinIcon; by: string | null; at: Date }[];
};

export type RosterRow = { key: string; name: string; detail: string };

/**
 * One row for every marker of yours on the map, in the order a player scans
 * for them: you, your base, anyone in your zone, anyone wanted, your
 * clanmates (the most recently seen first), then your pins (the newest first).
 * A layer that is switched off has no rows, because its markers are not on the
 * map for a row to open.
 */
export function rosterRows(d: RosterInput, enabled: Record<RosterLayer, boolean>, now: Date): RosterRow[] {
  const detail = (kind: string | null, x: number, z: number, at: Date | null): string =>
    [kind, `grid ${gridRef(x, z)}`, at ? fixAge(at, now) : null].filter((s): s is string => s !== null).join(" · ");
  const newestFirst = <T,>(xs: T[], at: (x: T) => Date): T[] => [...xs].sort((a, b) => at(b).getTime() - at(a).getTime());
  const rows: RosterRow[] = [];
  if (enabled.you && d.you.fix) rows.push({ key: markerKey.you(), name: "You", detail: detail(null, d.you.fix.x, d.you.fix.z, d.you.fix.at) });
  if (enabled.base && d.base) rows.push({ key: markerKey.base(), name: "Your base", detail: detail(null, d.base.x, d.base.z, null) });
  if (enabled.intruders) {
    for (const i of newestFirst(d.intruders, (i) => i.lastSeenAt)) {
      rows.push({ key: markerKey.intruder(i.gamertag), name: i.gamertag, detail: detail(`Intruder, ${Math.round(i.distanceM)} m`, i.x, i.z, i.lastSeenAt) });
    }
  }
  if (enabled.bounties) {
    for (const b of newestFirst(d.bounties, (b) => b.fix.at)) {
      rows.push({ key: markerKey.bounty(b.gamertag), name: b.gamertag, detail: detail("Wanted", b.fix.x, b.fix.z, b.fix.at) });
    }
  }
  if (enabled.clanmates) {
    for (const m of newestFirst(d.clanmates, (m) => m.fix.at)) {
      rows.push({ key: markerKey.clanmate(m.dayzId), name: m.gamertag, detail: detail("Clanmate", m.fix.x, m.fix.z, m.fix.at) });
    }
  }
  if (enabled.pins) {
    for (const p of newestFirst(d.pins, (p) => p.at)) {
      rows.push({ key: markerKey.pin(p.id), name: `${PIN_ICON_LABELS[p.icon]} pin`, detail: detail(`by ${p.by ?? "a member"}`, p.x, p.z, p.at) });
    }
  }
  return rows;
}
