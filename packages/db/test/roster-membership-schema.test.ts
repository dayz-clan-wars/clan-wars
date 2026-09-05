import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, factions, factionMembers, identityHolds, type Database } from "../src/index";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-05T12:00:00Z");

describe("migration 0022", () => {
  let db: Database; let serverId = 0; let factionId = 0;
  beforeAll(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table identity_holds, faction_join_requests, faction_members, factions, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(factions).values({ serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", leaderDiscordId: "d1", createdAt: now }).returning();
    factionId = f!.id;
  });

  it("a member row defaults to full and refuses other statuses", async () => {
    const [m] = await db.insert(factionMembers).values({ factionId, serverId, dayzId: "A".repeat(40), discordId: "d1", role: "leader", joinedAt: now }).returning();
    expect(m!.status).toBe("full");
    await expect(db.insert(factionMembers).values({ factionId, serverId, dayzId: "B".repeat(40), discordId: "d2", role: "member", joinedAt: now, status: "maybe" }))
      .rejects.toThrow(/faction_members_status_valid/u);
  });

  it("a recruiting post defaults off", async () => {
    const [f] = await db.select({ recruiting: factions.recruiting, pitch: factions.pitch }).from(factions);
    expect(f).toEqual({ recruiting: false, pitch: null });
  });

  it("holds compare in SQL and can be infinite", async () => {
    await db.insert(identityHolds).values({ serverId, kind: "name", valueLower: "wolves", factionId, reason: "disbanded", heldUntil: sql`'infinity'::timestamptz` });
    const live = await db.execute(sql`select count(*)::int as n from identity_holds where held_until > now()`);
    expect((live as unknown as { n: number }[])[0]!.n).toBe(1);
    await expect(db.insert(identityHolds).values({ serverId, kind: "colour", valueLower: "x", factionId, reason: "disbanded", heldUntil: now }))
      .rejects.toThrow(/identity_holds_kind_valid/u);
  });

  it("a decision needs a decided_at and vice versa", async () => {
    await expect(db.execute(sql`insert into faction_join_requests (faction_id, server_id, dayz_id, discord_id, created_at, expires_at, decision)
      values (${factionId}, ${serverId}, 'C', 'd3', now(), now(), 'accepted')`)).rejects.toThrow(/decision_requires_decided/u);
  });
});
