import locations from "../assets/koth-locations.json";
import presets from "../assets/koth-presets.json";
import {
  KOTH_MIN_GAP_MS, KOTH_NO_REPEAT, KOTH_PRESET_PREFIX, KOTH_REMINDER_LEAD_MS, KOTH_VOTE_MIN_OPEN_MS,
  KOTH_VOTE_PASS_DEN, KOTH_VOTE_PASS_NUM, KOTH_VOTE_TURNOUT_MIN, KOTH_ZONE_RADIUS_M, RESTART_PERIOD_MS,
} from "./rules";
import { nextRestartAt } from "./restarts";
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

/**
 * Spec §2.2: slot to slot, because for KotH the session is the event.
 * ⚠️ One statement for all three paths — /koth schedule, the automatic trigger and the vote.
 */
export function kothGapOk(slot: Date, lastSlotAt: Date | null): boolean {
  return lastSlotAt === null || slot.getTime() - lastSlotAt.getTime() >= KOTH_MIN_GAP_MS;
}

/**
 * Spec §2.4, `chooseAirdrop`'s shape.
 * ⚠️ The fallback is not padding: an empty pool indexes undefined and throws inside a tick.
 */
export function chooseKothTown(recent: string[], rng: () => number): KothLocation {
  const skip = new Set(recent.slice(0, KOTH_NO_REPEAT));
  const pool = KOTH_LOCATIONS.filter((l) => !skip.has(l.slug));
  const from = pool.length > 0 ? pool : KOTH_LOCATIONS;
  return from[Math.floor(rng() * from.length)]!;
}

export type KothFireInput = {
  slot: Date;
  /** A koth_events row holds the slot, or an announced/live airdrop does. */
  slotTaken: boolean;
  /** A vote for this slot is open or failed (§3.2). */
  voteBlocks: boolean;
  /** A KotH is `scheduled` or `live`. */
  openEvent: boolean;
  /** `origin = 'auto'` rows, not cancelled/failed, in the slot's ISO week. */
  weekCount: number;
  weeklyCap: number;
  lastSlotAt: Date | null;
  pop: number;
  /** ⚠️ Taken strictly before this decision instant — see airdrop-tick.ts. */
  threshold: number;
  minPop: number;
};

/** Spec §3. The refusals in the order that makes one cheapest to read. */
export function shouldFireKoth(i: KothFireInput): boolean {
  if (i.slotTaken || i.voteBlocks || i.openEvent) return false;
  if (i.weekCount >= i.weeklyCap) return false;
  if (!kothGapOk(i.slot, i.lastSlotAt)) return false;
  return i.pop >= Math.max(i.minPop, i.threshold);
}

/** Half the frozen electorate, rounded up, never under the minimum (§4). */
export function turnoutFloor(electorate: number): number {
  return Math.max(KOTH_VOTE_TURNOUT_MIN, Math.ceil(electorate / 2));
}

export type VoteResult = { outcome: "passed" | "failed"; reason: "passed" | "turnout" | "majority" };

/** Turnout first, so a result post can say which bar was missed. */
export function voteOutcome(v: { cast: number; yes: number; floor: number }): VoteResult {
  if (v.cast < v.floor) return { outcome: "failed", reason: "turnout" };
  if (v.yes * KOTH_VOTE_PASS_DEN < v.cast * KOTH_VOTE_PASS_NUM) return { outcome: "failed", reason: "majority" };
  return { outcome: "passed", reason: "passed" };
}

/** A vote closes when the reminder would go out: the announcement is the reminder. */
export function voteClosesAt(slot: Date): Date {
  return new Date(slot.getTime() - KOTH_REMINDER_LEAD_MS);
}

/** The first slot whose vote would be open at least `KOTH_VOTE_MIN_OPEN_MS`. */
export function voteTargetSlot(now: Date): Date {
  let slot = nextRestartAt(now);
  while (voteClosesAt(slot).getTime() - now.getTime() < KOTH_VOTE_MIN_OPEN_MS) {
    slot = new Date(slot.getTime() + RESTART_PERIOD_MS);
  }
  return slot;
}
