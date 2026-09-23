import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { BOUNTY_STATUSES } from "@factions/domain";
import { bounties, createClient, requireTestDatabaseUrl, runMigrations, servers, type Database } from "../src/index";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-23T12:00:00Z");

describe("bounties schema", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table bounties, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
  });
  const row = (over: Partial<typeof bounties.$inferInsert> = {}) => ({
    serverId, targetDayzId: "T".repeat(40), reason: "r", placedByDiscordId: "9",
    placedAt: now, onlineBudgetMs: 1000, deadlineAt: now, ...over,
  });

  it("⚠️ the status CHECK names exactly BOUNTY_STATUSES", async () => {
    const r = await db.execute(sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'bounties_status_valid'`);
    const def = String((r as unknown as { def: string }[])[0]!.def);
    for (const s of BOUNTY_STATUSES) expect(def).toContain(`'${s}'`);
    expect(def.match(/'[a-z]+'/gu)!.length).toBe(BOUNTY_STATUSES.length);
  });

  it("allows one open bounty per target", async () => {
    await db.insert(bounties).values(row());
    await expect(db.insert(bounties).values(row())).rejects.toThrow(/bounties_one_open_uniq/u);
  });

  it("allows a new bounty once the old one is closed", async () => {
    await db.insert(bounties).values(row({ status: "expired", closedAt: now }));
    await expect(db.insert(bounties).values(row())).resolves.toBeDefined();
  });

  it("refuses a claimed row with no claimer", async () => {
    await expect(db.insert(bounties).values(row({ status: "claimed", closedAt: now }))).rejects.toThrow(/bounties_claim_complete/u);
  });
});
