import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { MIGRATIONS_FOLDER } from "./migrations-folder";
import type { Database } from "./client";

/**
 * What `pnpm db:migrate` knows before it writes anything.
 *
 * The postgres-js migrator applies every journal entry whose `when` is newer
 * than the newest `created_at` in `drizzle.__drizzle_migrations`. It compares
 * TIMESTAMPS, not names or indices, and it reports nothing about what it
 * decided. That makes two failures invisible at the moment they matter:
 *
 *   - a `__drizzle_migrations` table filled in by hand with timestamps of its
 *     own replays old migrations against live data, and
 *   - a journal whose entries are out of order silently skips one forever.
 *
 * `planMigrations` is the check the dormancy runbook performs by hand with
 * `select count(*), max(created_at)`. Keeping it pure — journal in, rows in,
 * decision out — is what makes those cases testable without a database.
 */

export interface JournalEntry {
  /** Position in the journal, 0-based. */
  idx: number;
  /** The migration's file tag, e.g. `0034_busy_thunderbolts`. */
  tag: string;
  /** Epoch milliseconds. THIS is what the migrator compares against. */
  when: number;
}

/** The two numbers that describe `drizzle.__drizzle_migrations`. */
export interface AppliedState {
  count: number;
  /** Epoch milliseconds of the newest applied row; null when none are applied. */
  maxCreatedAt: number | null;
}

export type MigrationPlan =
  | { ok: true; appliedCount: number; pending: JournalEntry[] }
  | { ok: false; code: PlanRefusal; message: string };

export type PlanRefusal = "journal-not-ascending" | "more-applied-than-journalled" | "timestamp-mismatch";

/**
 * What a migrate run would apply, or why it must not run at all.
 *
 * The consistency rule is one sentence: with `count` rows applied, the newest
 * of them must be the journal's entry at `count - 1`. Anything else means the
 * table was not written by this journal, and the timestamp comparison the
 * migrator is about to make cannot be trusted.
 */
export function planMigrations(journal: readonly JournalEntry[], applied: AppliedState): MigrationPlan {
  for (let i = 1; i < journal.length; i += 1) {
    const prev = journal[i - 1]!;
    const here = journal[i]!;
    if (here.when <= prev.when) {
      return {
        ok: false,
        code: "journal-not-ascending",
        message:
          `Journal entry ${here.tag} (when=${here.when}) is not newer than ${prev.tag} (when=${prev.when}). ` +
          "The migrator applies by timestamp, so it would skip one of them for good.",
      };
    }
  }

  if (applied.count > journal.length) {
    return {
      ok: false,
      code: "more-applied-than-journalled",
      message:
        `${applied.count} migrations are applied but the journal has only ${journal.length} entries. ` +
        "This database is ahead of the code — deploy the matching code, do not migrate.",
    };
  }

  if (applied.count === 0) {
    if (applied.maxCreatedAt !== null) {
      return {
        ok: false,
        code: "timestamp-mismatch",
        message: `No migrations are applied but the newest timestamp is ${applied.maxCreatedAt}.`,
      };
    }
    return { ok: true, appliedCount: 0, pending: [...journal] };
  }

  const newest = journal[applied.count - 1]!;
  if (applied.maxCreatedAt !== newest.when) {
    return {
      ok: false,
      code: "timestamp-mismatch",
      message:
        `${applied.count} migrations are applied, so the newest should be ${newest.tag} (when=${newest.when}), ` +
        `but drizzle.__drizzle_migrations holds ${applied.maxCreatedAt ?? "no timestamp"}. ` +
        "Applying now could replay migrations that already ran. Reconcile the table by hand first.",
    };
  }

  return { ok: true, appliedCount: applied.count, pending: journal.slice(applied.count) };
}

/** The journal shipped alongside this package's migrations. */
export function readJournal(folder: string = MIGRATIONS_FOLDER): JournalEntry[] {
  const raw: unknown = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, "utf8"));
  const entries: unknown = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) throw new Error(`Journal at ${folder} has no entries array.`);
  return entries.map((e, i) => {
    const { idx, tag, when } = e as { idx?: unknown; tag?: unknown; when?: unknown };
    if (typeof idx !== "number" || typeof tag !== "string" || typeof when !== "number") {
      throw new Error(`Journal entry ${i} is malformed: ${JSON.stringify(e)}`);
    }
    return { idx, tag, when };
  });
}

/**
 * The state of `drizzle.__drizzle_migrations`, or an empty state when the
 * table does not exist yet (a database that has never been migrated).
 *
 * `created_at` is a bigint, which postgres-js hands back as a string; Number()
 * is exact for epoch milliseconds well past any date this project will see.
 */
export async function readAppliedState(db: Database): Promise<AppliedState> {
  const present = await db.execute(sql`select to_regclass('drizzle.__drizzle_migrations') is not null as present`);
  if (!(present[0] as { present?: boolean } | undefined)?.present) return { count: 0, maxCreatedAt: null };

  const rows = await db.execute(
    sql`select count(*)::int as count, max(created_at) as max from drizzle.__drizzle_migrations`,
  );
  const row = rows[0] as { count?: number; max?: string | number | null } | undefined;
  const max = row?.max;
  return { count: row?.count ?? 0, maxCreatedAt: max === null || max === undefined ? null : Number(max) };
}
