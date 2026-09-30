import { AWARD_MAX_DAYS, AWARD_REMOVAL_LEAD_MS } from "./rules";
import { nextRestartAt } from "./restarts";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export type AwardItem = { className: string; label: string; image?: string; extras?: string[] };
export type AwardSlot = { label: string; items: AwardItem[] };
export type AwardDef = { key: string; label: string; durationDays: number; slots: Record<string, AwardSlot> };
export type Awards = Record<string, AwardDef>;

/** An award key is what `/award grant` accepts and what `award_grants.award_key` stores. */
const AWARD_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
/** A slot key is a key in `award_grants.picks` and a URL-safe form field. */
const SLOT_KEY = /^[a-z][a-zA-Z0-9]*$/u;

/**
 * Parse and check the committed award catalogue.
 *
 * ⚠️ Throws rather than repairing, for the booster catalogue's reason: this is
 * the ONLY validator of what a winner may pick, and every award key it accepts
 * is one `/award grant` will hand out. A misspelled class name is the one
 * failure it cannot catch (it spawns nothing, silently); the runbook greps
 * every class name against the mission's types.xml for that.
 */
export function loadAwards(json: unknown): Awards {
  if (typeof json !== "object" || json === null) throw new Error("awards: catalogue is not an object");
  const out: Awards = {};
  for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
    if (!AWARD_KEY.test(key)) throw new Error(`awards: key ${key} is not lowercase kebab-case`);
    const v = value as Partial<AwardDef> | null;
    if (typeof v?.label !== "string" || v.label === "") throw new Error(`awards: ${key} has no label`);
    // ⚠️ The same ceiling `/award grant days:` has. The grant checks its
    // length against it, so a default above it would be refused on every
    // grant, and KotH and the referral payout retry a refused grant forever.
    if (!Number.isInteger(v.durationDays) || (v.durationDays as number) <= 0 || (v.durationDays as number) > AWARD_MAX_DAYS) {
      throw new Error(`awards: ${key} durationDays must be a whole number from 1 to ${AWARD_MAX_DAYS}`);
    }
    const slots = v.slots;
    if (typeof slots !== "object" || slots === null || Object.keys(slots).length === 0) {
      throw new Error(`awards: ${key} has no slots`);
    }
    for (const [slot, s] of Object.entries(slots)) {
      if (!SLOT_KEY.test(slot)) throw new Error(`awards: ${key} slot ${slot} is not a camelCase key`);
      if (typeof s?.label !== "string" || !Array.isArray(s.items) || s.items.length === 0) {
        throw new Error(`awards: ${key} slot ${slot} needs a label and at least one item`);
      }
      const names = new Set<string>();
      const labels = new Set<string>();
      for (const item of s.items) {
        if (typeof item?.className !== "string" || typeof item?.label !== "string") {
          throw new Error(`awards: ${key} slot ${slot} has an item without className and label`);
        }
        if (names.has(item.className)) throw new Error(`awards: ${key} slot ${slot} lists ${item.className} twice`);
        names.add(item.className);
        // ⚠️ Same rule as the booster catalogue, for the failure that shipped
        // there: two options a player cannot tell apart.
        if (labels.has(item.label)) throw new Error(`awards: ${key} slot ${slot} lists the label ${item.label} twice`);
        labels.add(item.label);
        if (item.image !== undefined && item.image !== `items/${item.className}.webp`) {
          throw new Error(`awards: ${item.className} has image ${String(item.image)}, expected items/${item.className}.webp`);
        }
        // Class names spawned beside the pick (a gun's mags and parts). Repeats
        // are how a loadout gets two mags, so they are allowed here and never
        // added to `names`. ⚠️ Empty is refused rather than read as "none":
        // leave the field out instead, so there is one way to say it.
        if (item.extras !== undefined
          && (!Array.isArray(item.extras) || item.extras.length === 0
            || !item.extras.every((x: unknown) => typeof x === "string" && x !== ""))) {
          throw new Error(`awards: ${item.className} extras must be a non-empty list of class names`);
        }
      }
    }
    out[key] = { key, label: v.label, durationDays: v.durationDays as number, slots: slots as Record<string, AwardSlot> };
  }
  return out;
}

export function isAwardPick(def: AwardDef, slot: string, className: string): boolean {
  return Object.hasOwn(def.slots, slot) && def.slots[slot]!.items.some((i) => i.className === className);
}

/** Every slot holds an allowed pick. Placement and the spawner file both require it. */
export function picksComplete(def: AwardDef, picks: Record<string, string>): boolean {
  return Object.keys(def.slots).every((slot) => typeof picks[slot] === "string" && isAwardPick(def, slot, picks[slot]!));
}

export type AwardTimes = {
  placeBy: Date; placedAt: Date | null; liveFrom: Date | null; expiresAt: Date | null; revokedAt: Date | null;
};
export type AwardState = "revoked" | "expired" | "lapsed" | "live" | "waiting" | "unplaced";

/**
 * A grant's state, derived from its timestamps (spec §3.2).
 *
 * ⚠️ Checked in THIS order and nowhere else. A stored status would be one more
 * thing to fall out of step with the timestamps it summarises; every reader —
 * the page, the command, the placement tick — asks this function.
 */
export function awardState(g: AwardTimes, now: Date): AwardState {
  if (g.revokedAt) return "revoked";
  if (g.expiresAt && now >= g.expiresAt) return "expired";
  if (!g.placedAt && now >= g.placeBy) return "lapsed";
  if (g.liveFrom && now >= g.liveFrom) return "live";
  return g.placedAt ? "waiting" : "unplaced";
}

export function isOpenAward(s: AwardState): boolean {
  return s === "unplaced" || s === "waiting" || s === "live";
}

/**
 * The clock for a grant first carried by an upload at `uploadedAt`: live from
 * the restart after it, for `durationDays`.
 *
 * ⚠️ `nextRestartAt` — the SAME arithmetic the restart tick and the site's
 * countdown use — so with restarts on even hours `expiresAt` is itself a
 * restart slot, and the week is exactly a week of sessions.
 */
export function awardClock(uploadedAt: Date, durationDays: number): { liveFrom: Date; expiresAt: Date } {
  return awardClockMs(uploadedAt, durationDays * DAY_MS);
}

/**
 * `awardClock` for a length in milliseconds: a transferred award resumes with
 * the time it had left, which is rarely a whole number of days.
 */
export function awardClockMs(uploadedAt: Date, lengthMs: number): { liveFrom: Date; expiresAt: Date } {
  const liveFrom = nextRestartAt(uploadedAt);
  return { liveFrom, expiresAt: new Date(liveFrom.getTime() + lengthMs) };
}

/**
 * How long an award has left to run (transfers spec §3): what a transfer
 * saves into `remaining_ms`, and what the worker's stamp runs for.
 *
 * ⚠️ Once stamped, counted from `max(now, live_from)`: time before it went
 * live was never spent. ⚠️ Never negative, so an award given away in its last
 * minute hands over a sliver, not a clock that ends before it starts.
 */
export function awardTimeLeftMs(
  g: { liveFrom: Date | null; expiresAt: Date | null; remainingMs: number | null; durationDays: number }, now: Date,
): number {
  if (g.expiresAt) {
    const from = Math.max(now.getTime(), g.liveFrom?.getTime() ?? now.getTime());
    return Math.max(0, g.expiresAt.getTime() - from);
  }
  return g.remainingMs ?? g.durationDays * DAY_MS;
}

/** "2 days 5 hours", "1 day", "5 hours", "less than an hour": whole hours, rounded down. */
export function timeLeftText(ms: number): string {
  const hours = Math.floor(ms / HOUR_MS);
  if (hours < 1) return "less than an hour";
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  return [d > 0 ? part(d, "day") : "", h > 0 ? part(h, "hour") : ""].filter(Boolean).join(" ");
}

/**
 * Whether a grant belongs in the spawner file right now (spec §5.1). Picks are
 * checked separately, against the catalogue, by the worker.
 *
 * ⚠️ `expires_at` null means "not stamped yet", never "no expiry": the clock
 * is stamped from the first upload that carries the grant, so a grant has to
 * be in the file BEFORE it can have one.
 */
export function inAwardFile(g: AwardTimes, now: Date): boolean {
  if (!g.placedAt || g.revokedAt) return false;
  if (g.expiresAt === null) return true;
  return now.getTime() < g.expiresAt.getTime() - AWARD_REMOVAL_LEAD_MS;
}
