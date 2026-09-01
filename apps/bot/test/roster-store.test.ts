import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, identityLinks, rosterCooldowns,
  type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { PgRosterStore } from "../src/roster-store.js";

const URL = requireTestDatabaseUrl();
const PLAYER = "C".repeat(40);
const LEADER_DISCORD = "d1";
const now = new Date("2026-08-31T12:00:00Z");

describe("PgRosterStore", () => {
  let db: Database;
  let store: PgRosterStore;
  let serverId = 0;
  let factionId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    // SET LOCAL shares the truncate's connection (the pool hands out any
    // connection, and the setting reverts at commit), so the dozens of
    // "truncate cascades to ..." NOTICEs stay out of the suite's output and a
    // genuine warning is visible when one appears.
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table faction_invites, roster_cooldowns, faction_members, factions, identity_links, servers restart identity cascade`);
    });
    store = new PgRosterStore(db);
    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
  });

  const seedFaction = async (opts: { status: string; name: string }) => {
    const [f] = await db.insert(factions).values({
      serverId, name: opts.name, tag: opts.name.slice(0, 4), texture: `Flag_${opts.name}`,
      poleKey: "1:2:3", x: "1.00", y: "2.00", z: "3.00",
      status: opts.status, leaderDiscordId: LEADER_DISCORD, createdAt: now,
    }).returning();
    return f!.id;
  };

  const seedMembership = async (opts: { status: string; name: string }) => {
    const id = await seedFaction(opts);
    await db.insert(factionMembers).values({
      factionId: id, serverId, dayzId: PLAYER, discordId: LEADER_DISCORD, role: "leader", joinedAt: now,
    });
    return id;
  };

  it("lists only holding factions", async () => {
    // A lapsed faction's rows are deleted (Task 2), but a DORMANT one's are
    // not — so the status filter is doing real work, not duplicating that.
    await seedMembership({ status: "active", name: "Live" });
    const [s2] = await db.insert(servers).values({ name: "S2", map: "livonia", clockOffsetMs: 0 }).returning();
    const goneFactionId = (await db.insert(factions).values({
      serverId: s2!.id, name: "Gone", tag: "Gone", texture: "Flag_Gone", poleKey: "4:5:6",
      x: "4.00", y: "5.00", z: "6.00", status: "disbanded", leaderDiscordId: LEADER_DISCORD, createdAt: now,
    }).returning())[0]!.id;
    await db.insert(factionMembers).values({
      factionId: goneFactionId, serverId: s2!.id, dayzId: PLAYER, discordId: LEADER_DISCORD, role: "leader", joinedAt: now,
    });
    const [s3] = await db.insert(servers).values({ name: "S3", map: "chernarus", clockOffsetMs: 0 }).returning();
    const dormantFactionId = (await db.insert(factions).values({
      serverId: s3!.id, name: "Sleeping", tag: "SLP", texture: "Flag_Sleeping", poleKey: "7:8:9",
      x: "7.00", y: "8.00", z: "9.00", status: "dormant", leaderDiscordId: LEADER_DISCORD, createdAt: now,
    }).returning())[0]!.id;
    await db.insert(factionMembers).values({
      factionId: dormantFactionId, serverId: s3!.id, dayzId: PLAYER, discordId: LEADER_DISCORD, role: "leader", joinedAt: now,
    });

    const rows = await store.membershipsFor(LEADER_DISCORD);
    // Dormant IS holding — it keeps its flag, tag and pole — so it is listed.
    expect(rows.map((r) => r.factionName)).toEqual(["Live", "Sleeping"]);
  });

  it("returns a roster entry with a null gamertag when the link is gone", async () => {
    // A left join, not an inner one: /unlink can remove the link, and the
    // roster must still render rather than silently losing a member.
    factionId = await seedMembership({ status: "active", name: "Live" });
    await db.insert(identityLinks).values({ discordId: LEADER_DISCORD, dayzId: PLAYER, gamertag: "Steve", verifiedAt: now });
    await db.delete(identityLinks).where(eq(identityLinks.dayzId, PLAYER));
    const [entry] = await store.rosterOf(factionId);
    expect(entry!.dayzId).toBe(PLAYER);
    expect(entry!.gamertag).toBeNull();
  });

  it("reports no cooldown once it has expired", async () => {
    await db.insert(rosterCooldowns).values({ serverId, dayzId: PLAYER, until: new Date("2026-01-01T00:00:00Z") });
    expect(await store.cooldownUntil(serverId, PLAYER)).toBeNull();
  });

  it("reports a cooldown while it is still in the future", async () => {
    const until = new Date("2099-01-01T00:00:00Z");
    await db.insert(rosterCooldowns).values({ serverId, dayzId: PLAYER, until });
    expect(await store.cooldownUntil(serverId, PLAYER)).toEqual(until);
  });

  it("finds the identity link for a discord id and for a dayz id", async () => {
    await db.insert(identityLinks).values({ discordId: LEADER_DISCORD, dayzId: PLAYER, gamertag: "Steve", verifiedAt: now });
    expect(await store.linkFor(LEADER_DISCORD)).toEqual({ dayzId: PLAYER, gamertag: "Steve" });
    expect(await store.linkForDayzId(PLAYER)).toEqual({ discordId: LEADER_DISCORD, gamertag: "Steve" });
    expect(await store.linkFor("nobody")).toBeNull();
  });

  it("finds a member of a faction and reports their role", async () => {
    factionId = await seedMembership({ status: "active", name: "Live" });
    expect(await store.memberOf(factionId, LEADER_DISCORD)).toEqual({ dayzId: PLAYER, role: "leader" });
    expect(await store.memberOf(factionId, "nobody")).toBeNull();
  });

  it("orders the roster leader, officer, member, then by join time", async () => {
    factionId = await seedFaction({ status: "active", name: "Live" });
    const at = (m: number) => new Date(now.getTime() + m * 60_000);
    await db.insert(factionMembers).values([
      { factionId, serverId, dayzId: "P2", discordId: "d2", role: "member", joinedAt: at(1) },
      { factionId, serverId, dayzId: "P3", discordId: "d3", role: "officer", joinedAt: at(2) },
      { factionId, serverId, dayzId: "P1", discordId: LEADER_DISCORD, role: "leader", joinedAt: at(3) },
      { factionId, serverId, dayzId: "P4", discordId: "d4", role: "member", joinedAt: at(0) },
    ]);
    const rows = await store.rosterOf(factionId);
    expect(rows.map((r) => r.dayzId)).toEqual(["P1", "P3", "P4", "P2"]);
  });

  it("loads a faction card by id and by name, with a member count", async () => {
    factionId = await seedMembership({ status: "active", name: "Live" });
    const byId = await store.factionById(factionId);
    expect(byId).toMatchObject({ id: factionId, name: "Live", serverName: "S", memberCount: 1 });
    const byName = await store.factionByName("live");
    expect(byName).toMatchObject({ id: factionId });
    expect(await store.factionById(999999)).toBeNull();
    expect(await store.factionByName("nope")).toBeNull();
  });

  it("scopes a name lookup to the requested server", async () => {
    // Faction names are unique per server, not globally: `/faction info
    // name:Bears server:2` must not answer with server 1's Bears.
    const here = await seedFaction({ status: "active", name: "Bears" });
    const [s2] = await db.insert(servers).values({ name: "S2", map: "livonia", clockOffsetMs: 0 }).returning();
    const there = (await db.insert(factions).values({
      serverId: s2!.id, name: "Bears", tag: "BR2", texture: "Flag_Bears2", poleKey: "4:5:6",
      x: "4.00", y: "5.00", z: "6.00", status: "active", leaderDiscordId: LEADER_DISCORD, createdAt: now,
    }).returning())[0]!.id;

    expect(await store.factionByName("bears", serverId)).toMatchObject({ id: here });
    expect(await store.factionByName("bears", s2!.id)).toMatchObject({ id: there });
    expect(await store.factionByName("bears", 999999)).toBeNull();
    // No server given keeps the old unqualified behaviour.
    expect(await store.factionByName("bears")).not.toBeNull();
  });
});
