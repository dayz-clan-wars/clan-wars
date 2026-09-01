import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, factions, factionMembers, type Database } from "../src/index.js";
import { sql } from "drizzle-orm";

const URL = requireTestDatabaseUrl();
const A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("roster schema", () => {
  let db: Database;
  let serverId = 0;
  let f1 = 0;
  let f2 = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table faction_members, factions, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({
      name: "S", map: "livonia", clockOffsetMs: 0, nitradoServiceId: null,
    }).returning();
    serverId = s!.id;
    const rows = await db.insert(factions).values([
      { serverId, name: "One", tag: "ONE", texture: "Flag_Alpha", poleKey: "1.00:2.00:3.00",
        x: "1.00", y: "2.00", z: "3.00", status: "active", leaderDiscordId: "d1", createdAt: new Date() },
      { serverId, name: "Two", tag: "TWO", texture: "Flag_Beta", poleKey: "4.00:5.00:6.00",
        x: "4.00", y: "5.00", z: "6.00", status: "active", leaderDiscordId: "d2", createdAt: new Date() },
    ]).returning();
    f1 = rows[0]!.id;
    f2 = rows[1]!.id;
  });

  it("refuses the same player on two factions on one server", async () => {
    await db.insert(factionMembers).values({
      factionId: f1, serverId, dayzId: A, discordId: "d1", role: "leader", joinedAt: new Date(),
    });
    await expect(db.insert(factionMembers).values({
      factionId: f2, serverId, dayzId: A, discordId: "d1", role: "member", joinedAt: new Date(),
    })).rejects.toThrow(/faction_members_server_player_uniq/);
  });

  it("refuses a second leader on one faction", async () => {
    await db.insert(factionMembers).values({
      factionId: f1, serverId, dayzId: A, discordId: "d1", role: "leader", joinedAt: new Date(),
    });
    await expect(db.insert(factionMembers).values({
      factionId: f1, serverId, dayzId: B, discordId: "d2", role: "leader", joinedAt: new Date(),
    })).rejects.toThrow(/faction_members_leader_uniq/);
  });

  it("allows a second officer on one faction", async () => {
    await db.insert(factionMembers).values({
      factionId: f1, serverId, dayzId: A, discordId: "d1", role: "officer", joinedAt: new Date(),
    });
    await db.insert(factionMembers).values({
      factionId: f1, serverId, dayzId: B, discordId: "d2", role: "officer", joinedAt: new Date(),
    });
    const rows = await db.select().from(factionMembers);
    expect(rows).toHaveLength(2);
  });
});
