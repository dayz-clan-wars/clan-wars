import { parseIdentity } from "./identity.js";

export type ConsciousLine = { dayzId: string; gamertag: string };

// ⚠️ Anchored on the identity block's OWN closing paren: the gamertag is
// attacker-controlled and precedes the identity block, so an unanchored
// `regained consciousness` match could be forged from a connect line.
const RE = /\(id=[0-9A-F]{40}[^)]*\)\s*regained consciousness\s*$/u;

/** `regained consciousness` — a player waking from unconsciousness. A (DEAD) player is a corpse line. */
export function parseConscious(raw: string): ConsciousLine | null {
  if (!raw.includes("regained consciousness") || raw.includes("(DEAD)")) return null;
  const who = parseIdentity(raw);
  if (!who || !RE.test(raw)) return null;
  return { dayzId: who.dayzId, gamertag: who.gamertag };
}
