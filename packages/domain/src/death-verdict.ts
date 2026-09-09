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
export type StatedCause = "pvp" | "suicide" | "bled_out" | "drowned" | "environment" | "infected" | "animal" | "wolf" | "bear" | "fall" | "vehicle" | "died";
/** Inferred here, for a bare `died`. */
export type InferredCause = "starvation" | "dehydration" | "mauled";
export type DeathCauseWord = StatedCause | InferredCause;

/** Every value `kills.cause` may hold. apps/web's feed copy is held to this set. */
export const DEATH_CAUSES: ReadonlySet<string> = new Set<DeathCauseWord>([
  "pvp", "suicide", "bled_out", "drowned", "environment", "infected", "animal", "wolf", "bear", "fall", "vehicle", "died",
  "starvation", "dehydration", "mauled",
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
};

export type RecentUnconscious = { secondsBeforeDeath: number; disconnecting: boolean };

export const STARVE_ENERGY_MAX = 1;     // the game reports 0 when out of food
export const DEHYDRATE_WATER_MAX = 1;
export const RECENT_HIT_WINDOW_S = 120;
/** HP at or below this after an infected hit counts as "left at effectively zero". */
export const TERMINAL_HP_MAX = 1;

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
