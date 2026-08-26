import type { Vec3 } from "@factions/domain";
import { parsePlayerPos } from "./coords.js";
import { parseIdentity } from "./identity.js";

const HEADER_RE = /#####\s*PlayerList log:\s*(\d+)\s*players?/u;
const TERMINATOR_RE = /#####\s*$/u;
/** A dump body line ends at the closing paren — nothing follows it. */
const ENTRY_RE = /Player "[^"]+"\s*\(id=[0-9A-F]{40}\s+pos=<[^>]*>\)\s*$/u;

export function parseRosterHeader(raw: string): { count: number } | null {
  const m = HEADER_RE.exec(raw);
  if (!m) return null;
  return { count: parseInt(m[1]!, 10) };
}

export function isRosterTerminator(raw: string): boolean {
  if (HEADER_RE.test(raw)) return false;
  return TERMINATOR_RE.test(raw);
}

export function parsePlayerListEntry(
  raw: string,
): { gamertag: string; dayzId: string; pos: Vec3 } | null {
  if (!ENTRY_RE.test(raw)) return null;
  const who = parseIdentity(raw);
  if (!who) return null;
  const pos = parsePlayerPos(raw);
  if (!pos) return null;
  return { gamertag: who.gamertag, dayzId: who.dayzId, pos };
}
