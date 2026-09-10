/**
 * What a player died of, when the log only says "died."
 *
 * Lifted from One Life's death-verdict module (dayz-one-life, verified there
 * against every bare death in its production data), cut down to what the
 * kills consumer needs: one word for the `kills.cause` column. The parser
 * states a mechanism where the line names one; this infers one only for a
 * bare `died`, from the victim's stats on the death line and the hits and
 * knockouts logged in the RECENT_HIT_WINDOW_S before it.
 *
 * Pure — the caller supplies the recent evidence. packages/domain/test/
 * death-verdict.test.ts pins the ladder.
 */

/** The parser's stated mechanisms (`DeathCause` in @factions/adm-parser) and the kills consumer's `pvp`. */
export type StatedCause = "pvp" | "suicide" | "bled_out" | "drowned" | "environment" | "explosion" | "infected" | "animal" | "wolf" | "bear" | "fall" | "vehicle" | "died";
/** Inferred here, for a bare `died`. `finished` is a credited kill (finishedBy): the row carries a killer. */
export type InferredCause = "starvation" | "dehydration" | "mauled" | "finished";
export type DeathCauseWord = StatedCause | InferredCause;

/** Every value `kills.cause` may hold. apps/web's feed copy is held to this set. */
export const DEATH_CAUSES: ReadonlySet<string> = new Set<DeathCauseWord>([
  "pvp", "suicide", "bled_out", "drowned", "environment", "explosion", "infected", "animal", "wolf", "bear", "fall", "vehicle", "died",
  "starvation", "dehydration", "mauled", "finished",
]);

export type DeathFacts = {
  /** What the parser called it. */
  mechanism: string;
  /** The `Stats>` tail of a death line; null when the line had none. */
  energy: number | null;
  water: number | null;
  bleedSources: number | null;
};

export type RecentHit = {
  attackerType: "player" | "infected" | "environment";
  /** The non-player attacker's class name — "Infected", "FallDamageHealth", "Fence", a vehicle class. */
  attackerLabel: string | null;
  secondsBeforeDeath: number;
  /** The victim's HP AFTER the hit, as the `[HP: …]` field reports it. A hit that took HP to 0 is the killing blow. */
  victimHp: number | null;
  /** A player attacker's id, and what they hit with — what a credited kill (finishedBy) is written from. */
  attackerId?: string | null;
  weapon?: string | null;
  distanceM?: number | null;
};

export type RecentUnconscious = { secondsBeforeDeath: number; disconnecting: boolean };

export const STARVE_ENERGY_MAX = 1;     // the game reports 0 when out of food
export const DEHYDRATE_WATER_MAX = 1;
export const RECENT_HIT_WINDOW_S = 120;
/** HP at or below this after an infected hit counts as "left at effectively zero". */
export const TERMINAL_HP_MAX = 1;
/** A player's hit that left the victim at or below this, followed by a bare death, is credited to them. */
export const FINISH_HP_MAX = 25;

/** Class-name prefixes for the animals the log names as killers or hitters; first match wins. */
const ANIMALS: readonly [RegExp, "wolf" | "bear" | "animal"][] = [
  [/^Animal_CanisLupus/u, "wolf"],
  [/^Animal_UrsusArctos/u, "bear"],
  [/^Animal_/u, "animal"],
];

export function classifyEntityLabel(label: string | null): "wolf" | "bear" | "animal" | null {
  if (!label) return null;
  return ANIMALS.find(([re]) => re.test(label))?.[1] ?? null;
}

/**
 * Mechanism first: a stated cause explains its own side-effects (a suicide
 * by blade bleeds; a PvP victim is at 0 HP), so nothing underneath it is
 * read. Only a bare `died` goes down the ladder.
 */
export function classifyDeath(facts: DeathFacts, recentHits: RecentHit[], recentUnconscious: RecentUnconscious[]): DeathCauseWord {
  if (facts.mechanism !== "died") return DEATH_CAUSES.has(facts.mechanism) ? facts.mechanism as DeathCauseWord : "died";

  // One closed window for both evidence streams: a hit logged after the death instant is post-death noise.
  const inWindow = (s: number) => s >= 0 && s <= RECENT_HIT_WINDOW_S;
  const recent = recentHits.filter((h) => inWindow(h.secondsBeforeDeath));
  const knockedOut = recentUnconscious.some((u) => inWindow(u.secondsBeforeDeath));

  // A fall is logged as a `hit by FallDamageHealth` line and then a bare `died` with no killer
  // clause, so the terminal hit is the only evidence. It sits above the conditions: a starving
  // player who fell off a roof died of the fall.
  if (recent.some((h) => (h.attackerLabel ?? "").startsWith("FallDamage") && h.victimHp != null && h.victimHp <= 0)) return "fall";

  if (facts.energy != null && facts.energy <= STARVE_ENERGY_MAX) return "starvation";
  if (facts.water != null && facts.water <= DEHYDRATE_WATER_MAX) return "dehydration";

  // Infected deal shock, which never shows in `[HP: …]`, and their bleeds often close before the
  // death — so an infected hit is the gate and any one of three corroborations will do.
  // ⚠️ The terminal-HP corroboration rests on the INFECTED hits only: a player's shot or a fire
  // tick that left the victim at ~0 HP must not be corroborated by an unrelated scratch elsewhere
  // in the window — that misattribution was reproduced upstream three times before this guard.
  const bleeding = facts.bleedSources != null && facts.bleedSources > 0;
  const infectedHps = recent.filter((h) => h.attackerType === "infected").map((h) => h.victimHp).filter((n): n is number => n != null);
  const hunted = recent.some((h) => h.attackerType === "infected");
  const terminal = infectedHps.length > 0 && Math.min(...infectedHps) <= TERMINAL_HP_MAX; // min, not last: hits arrive with jitter
  if (hunted && (bleeding || knockedOut || terminal)) return "mauled";

  if (bleeding && recent.length > 0) return "bled_out";
  return "died";
}

/**
 * The player who finished a bare `died`, if the log supports crediting one.
 *
 * The game writes "died." when the last tick of damage was bleeding or
 * unconsciousness rather than the bullet, so a player shot to near-zero and
 * left to die is not credited by the log. The evidence is usually plain:
 * the last player to hit them left them at FINISH_HP_MAX or below, or they
 * were knocked out after that hit, and nothing but a player hurt them from
 * then until they died. Anything else touching them after the last shot —
 * an infected, a fall, a fence — breaks the credit; that thing finished it.
 *
 * Returns the crediting hit (id, weapon, distance), or null. The kills
 * consumer writes it as a kill with `cause = 'finished'`, so the feed can
 * say "finished by" and never claims the log said more than it did.
 */
export function finishedBy(recentHits: RecentHit[], recentUnconscious: RecentUnconscious[]): RecentHit | null {
  const inWindow = (s: number) => s >= 0 && s <= RECENT_HIT_WINDOW_S;
  const recent = recentHits.filter((h) => inWindow(h.secondsBeforeDeath));
  // ⚠️ Ties on the second are the rule, not the exception — a burst logs several hits at one timestamp —
  // and HP only falls within a burst, so the lowest HP is the last hit. Sorting on time alone kept the
  // first-logged hit of the burst (the highest HP) and missed two of the four credits in the live log.
  const last = recent.filter((h) => h.attackerType === "player" && h.attackerId)
    .sort((a, b) => a.secondsBeforeDeath - b.secondsBeforeDeath || (a.victimHp ?? Infinity) - (b.victimHp ?? Infinity))[0];
  if (!last) return null;
  if (recent.some((h) => h.attackerType !== "player" && h.secondsBeforeDeath < last.secondsBeforeDeath)) return null;
  const knockedOutAfter = recentUnconscious.some((u) => inWindow(u.secondsBeforeDeath) && u.secondsBeforeDeath < last.secondsBeforeDeath);
  const low = last.victimHp != null && last.victimHp <= FINISH_HP_MAX;
  return low || knockedOutAfter ? last : null;
}
