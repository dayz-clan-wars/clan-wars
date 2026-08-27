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

const FLAG_CHANGE_RE = /has (raised|lowered) (\S+) on TerritoryFlag/u;

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
