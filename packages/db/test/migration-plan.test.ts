import { describe, expect, it } from "vitest";
import { planMigrations, readJournal, type JournalEntry } from "../src/migration-plan";

/**
 * The planner is a pure function of two inputs — the journal on disk and the
 * `drizzle.__drizzle_migrations` rows — so every interesting case is a unit
 * test with no database. `migrate-live.test.ts` covers the one thing these
 * cannot: that a real migrate run lands where the planner said it would.
 */

const entry = (idx: number, when: number): JournalEntry => ({ idx, when, tag: `${String(idx).padStart(4, "0")}_t` });
const JOURNAL: JournalEntry[] = [entry(0, 100), entry(1, 200), entry(2, 300)];

describe("planMigrations", () => {
  it("plans every entry against a database with no migrations table", () => {
    const plan = planMigrations(JOURNAL, { count: 0, maxCreatedAt: null });
    expect(plan).toEqual({ ok: true, appliedCount: 0, pending: JOURNAL });
  });

  it("plans nothing when the newest applied row is the newest journal entry", () => {
    const plan = planMigrations(JOURNAL, { count: 3, maxCreatedAt: 300 });
    expect(plan).toEqual({ ok: true, appliedCount: 3, pending: [] });
  });

  it("plans the contiguous suffix when one entry is pending", () => {
    const plan = planMigrations(JOURNAL, { count: 2, maxCreatedAt: 200 });
    expect(plan).toEqual({ ok: true, appliedCount: 2, pending: [JOURNAL[2]] });
  });

  // ⚠️ The case the dormancy runbook warns about. The postgres-js migrator
  // applies every entry whose `when` is newer than the newest `created_at`, so
  // a table filled in by hand with different timestamps REPLAYS old migrations
  // — silently, and against live data. Refusing is the whole point of the
  // check: a timestamp matching no journal entry means the table was not
  // written by this migrator.
  it("refuses when the newest applied timestamp matches no journal entry", () => {
    const plan = planMigrations(JOURNAL, { count: 2, maxCreatedAt: 1_700_000_000_000 });
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.code).toBe("timestamp-mismatch");
  });

  // Two rows applied means the newest should be entry 1. Entry 2's timestamp
  // there says the rows are not the first two — the count and the order
  // disagree, so the suffix cannot be trusted.
  it("refuses when the newest applied timestamp is not the entry at that count", () => {
    const plan = planMigrations(JOURNAL, { count: 2, maxCreatedAt: 300 });
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.code).toBe("timestamp-mismatch");
  });

  it("refuses when more migrations are applied than the journal has entries", () => {
    const plan = planMigrations(JOURNAL, { count: 4, maxCreatedAt: 300 });
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.code).toBe("more-applied-than-journalled");
  });

  // The migrator compares timestamps, not indices: an out-of-order journal
  // makes it skip an entry forever, and the skip never shows up as an error.
  it("refuses a journal whose timestamps are not strictly ascending", () => {
    const plan = planMigrations([entry(0, 100), entry(1, 300), entry(2, 200)], { count: 0, maxCreatedAt: null });
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.code).toBe("journal-not-ascending");
  });

  it("refuses a journal with two entries sharing a timestamp", () => {
    const plan = planMigrations([entry(0, 100), entry(1, 100)], { count: 0, maxCreatedAt: null });
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.code).toBe("journal-not-ascending");
  });

  it("refuses rows in a database with an empty journal", () => {
    const plan = planMigrations([], { count: 1, maxCreatedAt: 100 });
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.code).toBe("more-applied-than-journalled");
  });

  it("plans nothing for an empty journal against an empty database", () => {
    expect(planMigrations([], { count: 0, maxCreatedAt: null })).toEqual({ ok: true, appliedCount: 0, pending: [] });
  });

  // A count with no timestamp (or a timestamp with no count) is not a state
  // this migrator can produce; it means the read itself is wrong.
  it("refuses a count with no timestamp", () => {
    const plan = planMigrations(JOURNAL, { count: 2, maxCreatedAt: null });
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.code).toBe("timestamp-mismatch");
  });
});

describe("readJournal", () => {
  // Pins the journal this package actually ships: the planner's guarantees are
  // worth nothing if the file it reads is malformed or out of order.
  it("reads the shipped journal in ascending order", () => {
    const journal = readJournal();
    expect(journal.length).toBeGreaterThanOrEqual(35);
    expect(journal[0]?.tag).toBe("0000_fixed_betty_brant");
    journal.forEach((e, i) => expect(e.idx).toBe(i));
    expect(planMigrations(journal, { count: 0, maxCreatedAt: null }).ok).toBe(true);
  });
});
