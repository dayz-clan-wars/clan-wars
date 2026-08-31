import type { Vec3 } from "@factions/domain";
import { parsePlayerPos, parsePoleAt } from "./coords.js";
import { parseIdentity } from "./identity.js";

export type FlagChangeAction = "raised" | "lowered";

export type FlagChange = {
  gamertag: string;
  dayzId: string;
  action: FlagChangeAction;
  texture: string;
  player: Vec3 | null;
  pole: Vec3;
};

/**
 * CRITICAL: anchored to the identity parenthetical, not searched from line start.
 * The gamertag is attacker-controlled and appears earlier on the line, so an
 * unanchored pattern matched a flag clause worn in the name — turning an
 * unrelated line into a fabricated `flag.raised`, or reporting `lowered` on a
 * genuine raise (a fake raid signal on the attacker's own pole). A name cannot
 * forge this anchor without embedding a literal 40-hex id group, which does not
 * fit inside the platform's 32-character name limit.
 */
const FLAG_CHANGE_RE =
  /\(id=[0-9A-F]{40}[^)]*\)\s*has (raised|lowered) (\S+) on TerritoryFlag/u;

export function parseFlagChange(raw: string): FlagChange | null {
  const m = FLAG_CHANGE_RE.exec(raw);
  if (!m) return null;

  const who = parseIdentity(raw);
  if (!who) return null;

  // A flag change without pole coordinates cannot be bound to an identity, so it is
  // unusable downstream. Drop it rather than emit an event with no key.
  const pole = parsePoleAt(raw);
  if (!pole) return null;

  return {
    gamertag: who.gamertag,
    dayzId: who.dayzId,
    action: m[1]! as FlagChangeAction,
    texture: m[2]!,
    player: parsePlayerPos(raw),
    pole,
  };
}
