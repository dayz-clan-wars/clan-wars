import type { Vec3 } from "@factions/domain";
import { parsePlayerPos } from "./coords.js";
import { parseIdentity } from "./identity.js";

export type PlacementEvent = {
  gamertag: string; dayzId: string;
  /** The display name, e.g. "Garden Plot". */
  item: string;
  /** The DayZ classname inside the angle brackets, e.g. "GardenPlot". */
  itemClass: string;
  pos: Vec3;
};

// ⚠️ Anchored on the identity block's OWN closing paren, exactly as
// structure.ts's BUILT_RE is and for the same reason: the gamertag is
// attacker-controlled and sits before the identity block, so a bare
// `placed (.+?)<(\w+)>` lets a gamertag carrying placement-shaped text forge
// an event from an ordinary connect line.
const PLACED_RE = /\(id=[0-9A-F]{40}[^)]*\)\s*placed (.+?)<(\w+)>\s*$/u;

export function parsePlacement(raw: string): PlacementEvent | null {
  const who = parseIdentity(raw);
  if (!who) return null;
  const pos = parsePlayerPos(raw);
  if (!pos) return null;
  const m = PLACED_RE.exec(raw);
  if (!m) return null;
  return {
    gamertag: who.gamertag, dayzId: who.dayzId,
    item: m[1]!.trim(), itemClass: m[2]!, pos,
  };
}
