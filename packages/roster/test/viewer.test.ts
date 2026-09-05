import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, identityLinks, type Database,
} from "@factions/db";
import { sql } from "drizzle-orm";
import { viewerForDb } from "../src/viewer";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-05T12:00:00Z");

describe("viewerForDb", () => {
  let db: Database;
  let serverId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table faction_members, factions, identity_links, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
  });

  it("a stranger has no link and no clan", async () => {
    expect(await viewerForDb(db, "d-nobody")).toEqual({ link: null, clan: null, pending: null });
  });

  it("a linked solo has a link and no clan", async () => {
    await db.insert(identityLinks).values({ discordId: "d1", dayzId: "A".repeat(40), gamertag: "Steve", verifiedAt: now, createdAt: now });
    const v = await viewerForDb(db, "d1");
    expect(v.link).toEqual({ dayzId: "A".repeat(40), gamertag: "Steve", verifiedAt: now });
    expect(v.clan).toBeNull();
  });

  it("a member sees their clan and role", async () => {
    await db.insert(identityLinks).values({ discordId: "d1", dayzId: "A".repeat(40), gamertag: "Steve", verifiedAt: now, createdAt: now });
    const [f] = await db.insert(factions).values({
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", leaderDiscordId: "d1", createdAt: now,
    }).returning();
    await db.insert(factionMembers).values({ factionId: f!.id, serverId, dayzId: "A".repeat(40), discordId: "d1", role: "leader", joinedAt: now });
    const v = await viewerForDb(db, "d1");
    expect(v.clan).toEqual({ id: f!.id, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", role: "leader" });
  });

  it("⚠️ a disbanded clan is not the viewer's clan", async () => {
    // HOLDING_STATUSES is the predicate. A roster row left behind on a
    // disbanded faction (there should be none — disband deletes them — but
    // the read must not depend on that) is not a clan the viewer is in.
    await db.insert(identityLinks).values({ discordId: "d1", dayzId: "A".repeat(40), gamertag: "Steve", verifiedAt: now, createdAt: now });
    const [f] = await db.insert(factions).values({
      serverId, name: "Gone", tag: "GONE", texture: "Flag_Wolf", status: "disbanded", leaderDiscordId: "d1", createdAt: now,
    }).returning();
    await db.insert(factionMembers).values({ factionId: f!.id, serverId, dayzId: "A".repeat(40), discordId: "d1", role: "member", joinedAt: now });
    expect((await viewerForDb(db, "d1")).clan).toBeNull();
  });

  it("a pending member has pending set and clan null — not a clan-level viewer", async () => {
    const [f] = await db.insert(factions).values({
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", leaderDiscordId: "d9", createdAt: now,
    }).returning();
    await db.insert(identityLinks).values({ discordId: "d1", dayzId: "A".repeat(40), gamertag: "Steve", verifiedAt: now });
    await db.insert(factionMembers).values({
      factionId: f!.id, serverId, dayzId: "A".repeat(40), discordId: "d1", role: "member", joinedAt: now,
      status: "pending", pendingSince: now,
    });
    const v = await viewerForDb(db, "d1");
    expect(v.clan).toBeNull();
    expect(v.pending).toEqual({ id: f!.id, name: "Bears", tag: "BEAR" });
  });
});
