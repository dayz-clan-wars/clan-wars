import { classifyEntityLabel } from "@factions/domain";

export type DeathCause = "bled_out" | "drowned" | "suicide" | "infected" | "animal" | "wolf" | "bear" | "fall" | "vehicle" | "environment" | "died";
export type DeathLine =
  | { kind: "killed"; victimDayzId: string; victimGamertag: string; killerDayzId: string; killerGamertag: string; weapon: string | null; distanceM: number | null }
  /** `water`/`energy`/`bleedSources` are the `Stats>` tail a bare death carries — the evidence classifyDeath reads. */
  | { kind: "died"; victimDayzId: string; victimGamertag: string; cause: DeathCause; entity: string | null; water: number | null; energy: number | null; bleedSources: number | null };

const ID = "[0-9A-F]{40}";
// ⚠️ Both identities anchored on their 40-hex ids; the victim's `(DEAD)` marker sits between the name and the id.
const KILL_RE = new RegExp(`Player "([^"]+)" \\(DEAD\\) \\(id=(${ID})[^)]*\\) killed by Player "([^"]+)" \\(id=(${ID})[^)]*\\)(.*)$`, "u");
const DEATH_RE = new RegExp(`Player "([^"]+)" \\(DEAD\\) \\(id=(${ID})[^)]*\\)(.*)$`, "u");
const WEAPON_RE = /with (.+?)(?: from ([\d.]+) meters)?\s*$/u;
const ENTITY_RE = /killed by ([A-Za-z0-9_]+)/u;
const VERB_RE = /\b(died|committed suicide|bled out|drowned|killed by)\b/u;
const STATS_RE = /Stats>\s*Water:\s*([\d.]+)\s*Energy:\s*([\d.]+)\s*Bleed sources:\s*(\d+)/u;
// Animals go through @factions/domain's classifyEntityLabel first (wolf, bear, animal) — the same
// rules the verdict applies to hit labels — so the prefixes here are disjoint from `Animal_`.
const ENTITY_CAUSES: readonly [RegExp, DeathCause][] = [
  [/^Zmb/u, "infected"], [/^FallDamage$/u, "fall"],
  [/^(CivilianSedan|Hatchback_|Sedan_|Offroad|Truck_|Boat_)/u, "vehicle"],
];

export function parseDeath(raw: string): DeathLine | null {
  if (raw.includes(" hit by ") || raw.includes(" is unconscious")) return null;
  const k = KILL_RE.exec(raw);
  if (k) {
    const w = WEAPON_RE.exec(k[5]!);
    return { kind: "killed", victimGamertag: k[1]!, victimDayzId: k[2]!, killerGamertag: k[3]!, killerDayzId: k[4]!,
      weapon: w ? w[1]!.trim() : null, distanceM: w?.[2] ? parseFloat(w[2]) : null };
  }
  const m = DEATH_RE.exec(raw);
  if (!m) return null;
  const tail = m[3]!; const lower = tail.toLowerCase();
  if (!VERB_RE.test(lower)) return null;      // a corpse re-listed by the PlayerList is not a death
  const entity = ENTITY_RE.exec(tail)?.[1] ?? null;
  const cause: DeathCause =
    lower.includes("bled out") ? "bled_out" : lower.includes("drowned") ? "drowned" : lower.includes("committed suicide") ? "suicide"
    : lower.includes("killed by") ? (entity ? (classifyEntityLabel(entity) ?? ENTITY_CAUSES.find(([re]) => re.test(entity))?.[1] ?? "environment") : "environment")
    : "died";
  const s = STATS_RE.exec(tail);
  return { kind: "died", victimGamertag: m[1]!, victimDayzId: m[2]!, cause, entity: lower.includes("killed by") ? entity : null,
    water: s ? parseFloat(s[1]!) : null, energy: s ? parseFloat(s[2]!) : null, bleedSources: s ? parseInt(s[3]!, 10) : null };
}
