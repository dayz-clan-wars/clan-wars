import { describe, it, expect, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { setMapChangedAt } from "../src/map-cutover.js";

const DB_URL = requireTestDatabaseUrl();
const at = new Date("2026-10-20T00:00:00Z");
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const run = promisify(execFile);

describe("the map cutover stamp", () => {
  let db: Database;
  let here = 0;
  let elsewhere = 0;

  beforeEach(async () => {
    db = createClient(DB_URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table servers restart identity cascade`);
    });
    const [a] = await db.insert(servers).values({ name: "A", map: "nasdara", clockOffsetMs: 0 }).returning();
    const [b] = await db.insert(servers).values({ name: "B", map: "livonia", clockOffsetMs: 0 }).returning();
    here = a!.id;
    elsewhere = b!.id;
  });

  it("sets map_changed_at on that server only", async () => {
    await setMapChangedAt(db, here, at);
    const [a] = await db.select().from(servers).where(eq(servers.id, here));
    const [b] = await db.select().from(servers).where(eq(servers.id, elsewhere));
    expect(a!.mapChangedAt).toEqual(at);
    expect(b!.mapChangedAt).toBeNull();
  });

  it("⚠️ refuses a server id that matches no row, rather than reporting success", async () => {
    await expect(setMapChangedAt(db, 999, at)).rejects.toThrow("no server with id 999");
  });

  it("⚠️ the script refuses a database that is not factions_live without --allow-test-db", async () => {
    // A test URL, never the live one: the guard must fire before any write.
    const failure = await run("pnpm", ["exec", "tsx", "scripts/map-cutover.ts", "--server", String(here), "--at", at.toISOString()], {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: DB_URL },
    }).then(() => null, (e: { code: number; stderr: string }) => e);
    expect(failure).not.toBeNull();
    expect(failure!.stderr).toContain("does not end in /factions_live");
    // The password never reaches the terminal.
    expect(failure!.stderr).not.toContain("factions:factions@");
    const [a] = await db.select().from(servers).where(eq(servers.id, here));
    expect(a!.mapChangedAt).toBeNull();
  }, 30_000);

  it("--at is required: a missing one is a usage error, never now", async () => {
    const failure = await run("pnpm", ["exec", "tsx", "scripts/map-cutover.ts", "--server", String(here), "--allow-test-db"], {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: DB_URL },
    }).then(() => null, (e: { code: number; stderr: string }) => e);
    expect(failure!.code).toBe(2);
    expect(failure!.stderr).toContain("--at is required");
  }, 30_000);
});
