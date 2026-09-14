import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, type Database } from "@factions/db";
import { planMigrations, readAppliedState, readJournal } from "../src/migration-plan";

/**
 * The one thing the pure planner tests cannot cover: that a real migrate run
 * against a real database leaves `drizzle.__drizzle_migrations` in the state
 * `planMigrations` predicts. If drizzle ever changes how it stamps that table,
 * this is what notices — before the runbook's safety check starts refusing on
 * production.
 */
describe("migration state after a real migrate", () => {
  let db: Database;

  beforeAll(async () => {
    db = createClient(requireTestDatabaseUrl());
    await runMigrations(db);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("leaves one row per journal entry, newest stamped with the newest entry's `when`", async () => {
    const journal = readJournal();
    const applied = await readAppliedState(db);
    expect(applied.count).toBe(journal.length);
    expect(applied.maxCreatedAt).toBe(journal[journal.length - 1]!.when);
  });

  it("plans nothing further, which is what a re-run must see", async () => {
    const plan = planMigrations(readJournal(), await readAppliedState(db));
    expect(plan).toEqual({ ok: true, appliedCount: readJournal().length, pending: [] });
  });
});
