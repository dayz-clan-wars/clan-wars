export type UnconsciousLine = { dayzId: string; gamertag: string; disconnecting: boolean };

const ID = "[0-9A-F]{40}";
const RE = new RegExp(`Player "([^"]+)" \\(id=(${ID})[^)]*\\) is (unconscious|disconnecting while being unconscious)\\s*$`, "u");

/**
 * `is unconscious` / `is disconnecting while being unconscious`.
 *
 * Infected deal shock, which never appears in a hit line's `[HP: …]` field:
 * a player is knocked out at near-full health and then dies. So this line,
 * not an HP threshold, is the signal that a mauling turned lethal
 * (classifyDeath). Waking up is not recorded, and a `(DEAD)` player going
 * unconscious is a corpse line — the id anchor excludes both.
 */
export function parseUnconscious(raw: string): UnconsciousLine | null {
  if (!raw.includes("unconscious") || raw.includes("(DEAD)")) return null;
  const m = RE.exec(raw);
  if (!m) return null;
  return { gamertag: m[1]!, dayzId: m[2]!, disconnecting: m[3] !== "unconscious" };
}
