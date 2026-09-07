import type { Vec3 } from "@factions/domain";
import { parsePlayerPos } from "./coords.js";
import { parseIdentity } from "./identity.js";

export type StructureEvent = {
  gamertag: string; dayzId: string; action: "built" | "dismantled";
  part: string; structure: string; tool: string | null; pos: Vec3;
};

// ⚠️ Anchored on the identity block's OWN closing paren — `\(id=[0-9A-F]{40}[^)]*\)` —
// the same way coords.ts's POLE_AT_RE is, not on a bare `)`. The gamertag is
// attacker-controlled and sits before the identity block, so a bare `\)\s*Built`
// lets a gamertag carrying a literal `)` followed by build-shaped text (e.g.
// `Player "X) Built rock on EnemyBase" (id=... pos=...) has connected`) forge an
// event from an ordinary connect line. Requiring the match to start at the
// identity block's close rules that out. "Flag Pole" is excluded here because
// flagpole.ts already yields `flagpole.*` for it and parseLine tries that parser
// first; this guard is belt-and-braces.
const BUILT_RE = /\(id=[0-9A-F]{40}[^)]*\)\s*Built (\S+) on (.+?)(?: with (.+?))?\s*$/u;
const DISMANTLED_RE = /\(id=[0-9A-F]{40}[^)]*\)\s*Dismantled (\S+) from (.+?)(?: with (.+?))?\s*$/u;

export function parseStructure(raw: string): StructureEvent | null {
  const who = parseIdentity(raw);
  if (!who) return null;
  const pos = parsePlayerPos(raw);
  if (!pos) return null;
  const built = BUILT_RE.exec(raw);
  const m = built ?? DISMANTLED_RE.exec(raw);
  if (!m) return null;
  const structure = m[2]!.trim();
  if (structure === "Flag Pole") return null;
  return {
    gamertag: who.gamertag, dayzId: who.dayzId, action: built ? "built" : "dismantled",
    part: m[1]!, structure, tool: m[3]?.trim() ?? null, pos,
  };
}
