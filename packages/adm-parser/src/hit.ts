import type { Vec3 } from "@factions/domain";
import { posInIdentity } from "./coords.js";

export type HitLine = {
  victimDayzId: string; victimGamertag: string;
  /** The victim's HP AFTER the hit, from the `[HP: …]` field. */
  victimHp: number | null;
  attackerType: "player" | "infected" | "environment";
  attackerDayzId: string | null; attackerGamertag: string | null;
  /** A non-player attacker's name: "Infected", "FallDamageHealth", "Fence", a vehicle class, or an animal's whole display name ("German Shepherd"). */
  attackerLabel: string | null;
  /** A non-player hit's mechanism, the word after ` with ` ("BarbedWireHit", "TransportHit"); null for a player hit or an animal/infected strike. */
  cause: string | null;
  damage: number | null; bodyPart: string | null;
  /** What a player hit with, and from how far — the `with … from … meters` tail, as on a kill line. */
  weapon: string | null; distanceM: number | null;
  /** Each player's position from their OWN identity block — the Hub rule reads these (spec 2026-09-22-hub-combat). Null for a non-player attacker. */
  victimPos: Vec3 | null; attackerPos: Vec3 | null;
};

const ID = "[0-9A-F]{40}";
// ⚠️ The victim is anchored on their 40-hex id and the `[HP: …]` field that only a hit line
// carries; a `(DEAD)` marker between the name and the id is a corpse being hit, not a hit.
const VICTIM_RE = new RegExp(`Player "([^"]+)" \\(id=(${ID})([^)]*)\\)\\[HP: ([\\d.]+)\\] hit by (.*)$`, "u");
// ⚠️ `(DEAD)` optional after the attacker's name: a player who hits while dying (a mutual exchange) is logged that way,
// and without it the line reads as `hit by Player` — an environment hit labelled "Player" (same trap as death.ts).
const BY_PLAYER_RE = new RegExp(`^Player "([^"]+)" (?:\\(DEAD\\) )?\\(id=(${ID})([^)]*)\\)(.*)$`, "u");
const WEAPON_RE = /with (.+?)(?: from ([\d.]+) meters)?\s*$/u;
// ⚠️ A driverless vehicle logs `NO DRIVER with TransportHit (Class)`; matched first, or the label reads "NO".
const NO_DRIVER_RE = /^NO DRIVER with ([A-Za-z0-9_]+) \(([A-Za-z0-9_]+)\)/u;
// Animals are logged by display name ("German Shepherd", "Brown Bear"), so the label runs to the first
// ` into `, ` with `, ` (` or end of line rather than stopping at the first space.
const BY_OTHER_RE = /^(.+?)(?= into | with | \(|$)/u;
const CAUSE_RE = / with ([A-Za-z0-9_]+)/u;
const INTO_RE = /into ([A-Za-z]+)(?:\(\d+\))?/u;
const DAMAGE_RE = /for ([\d.]+) damage/u;

/**
 * A `hit by` line: who or what damaged a player, and what it left them at.
 * Nothing scores from this — it is the evidence a bare `died.` is later
 * attributed from (@factions/domain's classifyDeath), which is why the
 * classes are kept verbatim in `attackerLabel`: the verdict reads them.
 */
export function parseHit(raw: string): HitLine | null {
  if (!raw.includes(" hit by ")) return null;
  const m = VICTIM_RE.exec(raw);
  if (!m) return null;
  const rest = m[5]!;
  const base = { victimGamertag: m[1]!, victimDayzId: m[2]!, victimHp: parseFloat(m[4]!), victimPos: posInIdentity(m[3]!),
    damage: DAMAGE_RE.exec(rest) ? parseFloat(DAMAGE_RE.exec(rest)![1]!) : null, bodyPart: INTO_RE.exec(rest)?.[1] ?? null };
  const p = BY_PLAYER_RE.exec(rest);
  if (p) {
    const w = WEAPON_RE.exec(p[4]!);
    return { ...base, attackerType: "player", attackerGamertag: p[1]!, attackerDayzId: p[2]!, attackerLabel: null, cause: null, attackerPos: posInIdentity(p[3]!),
      weapon: w ? w[1]!.trim() : null, distanceM: w?.[2] ? parseFloat(w[2]) : null };
  }
  const nd = NO_DRIVER_RE.exec(rest);
  const label = nd ? nd[2]! : BY_OTHER_RE.exec(rest)?.[1]?.trim() ?? null;
  const cause = nd ? nd[1]! : CAUSE_RE.exec(rest)?.[1] ?? null;
  const attackerType = label === "Infected" ? "infected" : "environment";
  // Animals are the environment to the log; the label carries which one (the verdict's classifyEntityLabel reads it).
  return { ...base, attackerType, attackerGamertag: null, attackerDayzId: null, attackerLabel: label, cause, attackerPos: null, weapon: null, distanceM: null };
}
