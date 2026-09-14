import { acquireAdvisoryLock, type AdvisoryLock } from "@factions/db";

/**
 * Exactly one bot process may run against a database, and this is what makes
 * that true rather than hoped for (PLAN-3-INBOX item 22).
 *
 * Two things in the bot already lean on it:
 *
 * - **The notifier is at-least-once across processes.** `notifyCompleted`
 *   sends the DM before calling `markNotified`, which is right for one
 *   process — marking first would drop the DM entirely if the send then
 *   failed — but two processes both read `pendingNotifications()`, both
 *   send, then both mark. Observed for real on 2026-09-01: a stale process
 *   survived a `pkill` whose pattern did not match the expanded tsx command
 *   line, a second was started alongside it, and a verified player was DM'd
 *   twice. The same argument covers the ceremony notifier and the players
 *   projection, which share the loop.
 * - **`/found` keeps its draft in memory** (`founding-draft.ts`). A
 *   `custom_id` caps at 100 characters and ten 17-character participant ids
 *   do not fit, so a chosen flag and crew cannot ride along in the
 *   interaction. Across two processes a player's select-menu pick and their
 *   modal submit can land on different ones; the second has no draft and
 *   answers "that took too long", seconds after they chose. Nothing is
 *   written and nothing corrupts — it just fails intermittently, with no
 *   explanation available to the player or to whoever they report it to.
 */

/**
 * ⚠️ One constant, deliberately NOT derived from the guild id.
 *
 * The loop this protects is not guild-scoped — the notifier, the ceremony
 * notifier and the players projection all read every row in the database. So
 * the invariant is one process per DATABASE, and keying on a guild would
 * permit two bots to share one database and both notify, which is the exact
 * failure this exists to prevent.
 *
 * The value is arbitrary but must never change: an advisory lock is only an
 * agreed number, so a bot on a new key cannot see a bot holding the old one.
 * Chosen once, 2026-09-14.
 */
const LOCK_KEY = 8_531_207;

export type InstanceLock = AdvisoryLock;

/** Takes the single-instance lock, or returns null if another bot holds it. */
export function acquireInstanceLock(url: string): Promise<InstanceLock | null> {
  return acquireAdvisoryLock(url, LOCK_KEY);
}
