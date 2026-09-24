import locations from "../assets/koth-locations.json";
import presets from "../assets/koth-presets.json";
import { KOTH_PRESET_PREFIX, KOTH_ZONE_RADIUS_M, RESTART_PERIOD_MS } from "./rules";
import { distance2d } from "./spacing";

export type KothLocation = { name: string; slug: string; centreX: number; centreZ: number };

/** Vendored from livonia/koth/locations/index.json; koth-drift.test.ts holds them together. */
export const KOTH_LOCATIONS: readonly KothLocation[] = locations as KothLocation[];
/** Vendored from livonia/custom/koth-*.json. */
export const KOTH_PRESET_FILES: readonly string[] = presets as string[];

export function kothLocation(slug: string): KothLocation | null {
  return KOTH_LOCATIONS.find((l) => l.slug === slug) ?? null;
}

/** Slots are aligned to the epoch in RESTART_PERIOD_MS steps (rules.ts). */
export function isRestartSlot(d: Date): boolean {
  return d.getTime() % RESTART_PERIOD_MS === 0;
}

export type KothRowLike = { slotAt: Date; state: string; announcedAt: Date | null };

/**
 * The event the session starting at `slot` belongs to, or null for default.
 * ⚠️ Exact slot only: a row whose slot has passed is never opened late (spec §2.1).
 * ⚠️ `announcedAt` is required: nobody finds an event they were not told about.
 */
export function kothWanted<T extends KothRowLike>(slot: Date, rows: T[]): T | null {
  return rows.find((r) => r.state === "scheduled" && r.announcedAt !== null && r.slotAt.getTime() === slot.getTime()) ?? null;
}

/** ⚠️ A missing position is never on the hill: a kill we cannot place does not score here. */
export function inKothZone(pos: { x: number; z: number } | null, centre: { x: number; z: number }): boolean {
  return pos !== null && distance2d(pos, centre) <= KOTH_ZONE_RADIUS_M;
}

export type KothKill = { killerDayzId: string; gamertag: string; occurredAt: Date };
export type KothStanding = { dayzId: string; gamertag: string; kills: number; reachedAt: Date };

/** Most kills first; on a tie, whoever reached that count first (spec §2.10). */
export function kothStandings(kills: KothKill[]): KothStanding[] {
  const sorted = [...kills].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const by = new Map<string, KothStanding>();
  for (const k of sorted) {
    const s = by.get(k.killerDayzId) ?? { dayzId: k.killerDayzId, gamertag: k.gamertag, kills: 0, reachedAt: k.occurredAt };
    s.kills += 1;
    s.reachedAt = k.occurredAt;
    by.set(k.killerDayzId, s);
  }
  return [...by.values()].sort((a, b) =>
    b.kills - a.kills || a.reachedAt.getTime() - b.reachedAt.getTime() || a.dayzId.localeCompare(b.dayzId));
}

/** The highest-ranked LINKED player — the prize needs a Discord account to land on. */
export function kothWinner(standings: KothStanding[], isLinked: (dayzId: string) => boolean): KothStanding | null {
  return standings.find((s) => isLinked(s.dayzId)) ?? null;
}

/**
 * What `spawnGearPresetFiles` should become outside a session, or null to leave it.
 * ⚠️ Null whenever the list holds no koth- entry: that is how a user's own later
 * edit to the default loadout survives every slot (spec §2.5).
 */
export function restoredPresets(current: string[], snapshot: string[] | null): string[] | null {
  const isKoth = (p: string) => p.includes(`/${KOTH_PRESET_PREFIX}`);
  if (!current.some(isKoth)) return null;
  const next = snapshot ?? current.filter((p) => !isKoth(p));
  if (next.length === 0) throw new Error("restoring spawnGearPresetFiles would leave it empty — refusing");
  return next;
}
