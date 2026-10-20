import type { Vec3 } from "@factions/domain";
import { parsePlayerPos } from "./coords.js";
import { parseIdentity } from "./identity.js";

export type PackedEvent = {
  dayzId: string; gamertag: string;
  /** The display name, e.g. "Large Tent". */
  item: string;
  pos: Vec3;
};

// ⚠️ Anchored on the identity block's closing paren, as placement.ts is, so a
// gamertag carrying `packed X with Hands` text cannot forge an event. The line
// ends with a trailing space in production, hence `\s*$`.
const PACKED_RE = /\(id=[0-9A-F]{40}[^)]*\)\s*packed (.+?) with Hands\s*$/u;

export function parsePacked(raw: string): PackedEvent | null {
  const who = parseIdentity(raw);
  if (!who) return null;
  const pos = parsePlayerPos(raw);
  if (!pos) return null;
  const m = PACKED_RE.exec(raw);
  if (!m) return null;
  return { dayzId: who.dayzId, gamertag: who.gamertag, item: m[1]!.trim(), pos };
}
