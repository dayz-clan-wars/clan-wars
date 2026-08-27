import { safeVerificationEmotes } from "@factions/domain";

/**
 * Draw `length` DISTINCT safe emote tokens in a random order.
 *
 * `rng` is injected rather than calling Math.random directly so a test can pin
 * the sequence. Distinctness matters: a sequence with a repeated token is
 * ambiguous to a player watching their own emote wheel, and shortens the
 * effective search space.
 */
export function generateSequence(rng: () => number, length = 3): string[] {
  const avail = safeVerificationEmotes().map((e) => e.token);
  const chosen: string[] = [];
  for (let i = 0; i < length && avail.length > 0; i++) {
    const j = Math.floor(rng() * avail.length);
    chosen.push(avail.splice(j, 1)[0]!);
  }
  return chosen;
}

/** Strictly after — a challenge is still live at its expiry instant. */
export function isExpired(challenge: { expiresAt: Date }, now: Date): boolean {
  return now.getTime() > challenge.expiresAt.getTime();
}
