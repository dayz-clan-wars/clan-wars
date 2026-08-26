import type { Vec3 } from "@factions/domain";
import { parsePlayerPos } from "./coords.js";
import { parseIdentity } from "./identity.js";

export type FlagPoleAction = "placed_kit" | "folded" | "built" | "dismantled";

export type FlagPoleEvent = {
  gamertag: string;
  dayzId: string;
  action: FlagPoleAction;
  part: string | null;
  tool: string | null;
  player: Vec3 | null;
};

const PLACED_KIT_RE = /placed Flag Pole Kit<TerritoryFlagKit>/u;
const FOLDED_RE = /folded Flag Pole\s*$/u;
// No space before "Built"/"Dismantled" in real logs: `pos=<...>)Built base on Flag Pole`.
const BUILT_RE = /\)\s*Built (\S+) on Flag Pole(?: with (.+?))?\s*$/u;
const DISMANTLED_RE = /\)\s*Dismantled (\S+) from Flag Pole(?: with (.+?))?\s*$/u;

export function parseFlagPole(raw: string): FlagPoleEvent | null {
  const who = parseIdentity(raw);
  if (!who) return null;

  const base = {
    gamertag: who.gamertag,
    dayzId: who.dayzId,
    player: parsePlayerPos(raw),
  };

  if (PLACED_KIT_RE.test(raw)) {
    return { ...base, action: "placed_kit", part: null, tool: null };
  }
  if (FOLDED_RE.test(raw)) {
    return { ...base, action: "folded", part: null, tool: null };
  }

  const built = BUILT_RE.exec(raw);
  if (built) {
    return { ...base, action: "built", part: built[1]!, tool: built[2]?.trim() ?? null };
  }

  const dismantled = DISMANTLED_RE.exec(raw);
  if (dismantled) {
    return { ...base, action: "dismantled", part: dismantled[1]!, tool: dismantled[2]?.trim() ?? null };
  }

  return null;
}
