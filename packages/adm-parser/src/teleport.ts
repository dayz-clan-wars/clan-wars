import type { Vec3 } from "@factions/domain";
import { inMapBounds, inAltitudeBounds } from "./coords.js";

export type TeleportEvent = { dayzId: string; gamertag: string; from: Vec3; to: Vec3; reason: string };

// ⚠️ Anchored on the identity block's own closing paren, the same way flag.ts and
// session.ts are — the gamertag is attacker-controlled and sits before the identity
// block.
const TELEPORT_RE =
  /Player "([^"]+)"\s*\(id=([0-9A-F]{40})[^)]*\) was teleported from: <([^>]+)> to: <([^>]+)>\. Reason: (.+?)\s*$/u;

/**
 * `from:`/`to:` triples are `<x, altitude, z>` — like the flagpole's `at <...>`
 * field, NOT like `pos=<x, z, altitude>`. Getting this backwards swaps the
 * horizontal and vertical axes for every teleport.
 */
function parseTriple(raw: string): Vec3 | null {
  const parts = raw.split(",").map((p) => parseFloat(p.trim()));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
  const [x, alt, z] = parts as [number, number, number];
  if (!inMapBounds(x, z) || !inAltitudeBounds(alt)) return null;
  return { x, y: alt, z };
}

export function parseTeleport(raw: string): TeleportEvent | null {
  const m = TELEPORT_RE.exec(raw);
  if (!m) return null;

  const from = parseTriple(m[3]!);
  const to = parseTriple(m[4]!);
  if (!from || !to) return null;

  return { gamertag: m[1]!, dayzId: m[2]!, from, to, reason: m[5]!.trim() };
}
