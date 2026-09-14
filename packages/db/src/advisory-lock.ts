import postgres from "postgres";

/**
 * A Postgres session-scoped advisory lock, held on a connection of its own.
 *
 * Lives here because it is a database mechanism and `packages/db` owns the
 * driver — no other package imports `postgres` directly. WHAT the lock is
 * for, and which key it uses, belongs to the caller: see
 * `apps/bot/src/instance-lock.ts`.
 */

export type AdvisoryLock = {
  /**
   * Closes the connection holding the lock, which is what releases it.
   * Safe to call twice — shutdown paths are rarely as tidy as they look.
   */
  release: () => Promise<void>;
};

/**
 * Takes `key`, or returns null if another session already holds it.
 *
 * ⚠️ Its own connection, `max: 1`, never a shared pool. An advisory lock
 * belongs to the SESSION that took it; over a pool of ten it would land on
 * whichever connection ran the statement, be invisible to the other nine,
 * and be released whenever the pool recycled that one.
 *
 * ⚠️ `pg_try_advisory_lock`, not `pg_advisory_lock`. The blocking form waits
 * forever, which to an operator is indistinguishable from a hung boot.
 * Refusing at once is what lets a caller print a sentence and exit.
 *
 * Session scope is the point: a process that is SIGKILLed, OOM-killed or
 * loses power drops its connection and the lock goes with it. A row lease
 * would need a TTL, and a TTL means a dead holder blocks recovery until it
 * expires.
 */
export async function acquireAdvisoryLock(url: string, key: number): Promise<AdvisoryLock | null> {
  const sql = postgres(url, { max: 1 });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await sql.end({ timeout: 5 });
  };

  try {
    const [row] = await sql<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${key}) AS locked`;
    if (!row?.locked) {
      await close();
      return null;
    }
    return { release: close };
  } catch (err) {
    // A connection that failed never held the lock; do not leak it.
    await close();
    throw err;
  }
}
