import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient,
  runMigrations,
  requireTestDatabaseUrl,
  servers,
  factions,
  factionMembers,
  identityLinks,
  players,
  guestPasses,
  seasons,
  alphaWeeks,
  type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { GUEST_PASS_MS } from "@factions/domain";
import { PgStructureStore } from "../src/structure-store.js";
import { seedFaction } from "./seed.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-06T12:00:00Z");

describe("PgStructureStore", () => {
  let db: Database;
  let store: PgStructureStore;
  let serverId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(
        sql`truncate table alpha_weeks, seasons, identity_links, players, guest_passes, faction_members, factions, declarations, poles, events, adm_files, servers restart identity cascade`,
      );
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    store = new PgStructureStore(db);
  });

  it("classifies clans by status and by which ids are set", async () => {
    const a = await seedFaction(db, { serverId, tag: "AAA", texture: "Flag_A", status: "active", createdAt: now, poleKey: "1.00:1.00:1.00" });
    const b = await seedFaction(db, { serverId, tag: "BBB", texture: "Flag_B", status: "dormant", createdAt: now, poleKey: "2.00:1.00:2.00" });
    const c = await seedFaction(db, { serverId, tag: "CCC", texture: "Flag_C", status: "disbanded", createdAt: now, poleKey: "3.00:1.00:3.00" });
    const d = await seedFaction(db, { serverId, tag: "DDD", texture: "Flag_D", status: "reserved", createdAt: now, poleKey: "4.00:1.00:4.00", reservedUntil: new Date(now.getTime() + 86400000) });
    await store.setRoleId(b.id, "r-b");
    await store.setTextChannelId(b.id, "t-b");
    await store.setVoiceChannelId(b.id, "v-b");
    await store.setRoleId(c.id, "r-c");
    expect((await store.clansNeedingStructure()).map((r) => r.id)).toEqual([a.id]);
    expect((await store.clansWithStructure()).map((r) => r.id)).toEqual([b.id]);
    expect((await store.clansToTearDown()).map((r) => r.id)).toEqual([c.id]);
    expect(d.id).toBeGreaterThan(0);
  });

  it("a partially created clan (role only) is still 'needing structure'", async () => {
    const a = await seedFaction(db, { serverId, tag: "AAA", texture: "Flag_A", createdAt: now });
    await store.setRoleId(a.id, "r-a");
    const [row] = await store.clansNeedingStructure();
    expect(row).toMatchObject({ id: a.id, roleId: "r-a", textChannelId: null, voiceChannelId: null });
  });

  it("fullMembersByClan lists full members only, for clans with a role", async () => {
    const a = await seedFaction(db, { serverId, tag: "AAA", texture: "Flag_A", createdAt: now });
    await store.setRoleId(a.id, "r-a");
    await db.insert(factionMembers).values([
      { factionId: a.id, serverId, dayzId: "U1", discordId: "d1", role: "leader", joinedAt: now, status: "full" },
      { factionId: a.id, serverId, dayzId: "U2", discordId: "d2", role: "member", joinedAt: now, status: "pending" },
    ]);
    expect(await store.fullMembersByClan()).toEqual(new Map([[a.id, ["d1"]]]));
  });

  it("linkedDiscordIds is every identity_links row", async () => {
    await db.insert(identityLinks).values([
      { discordId: "d1", dayzId: "U1", gamertag: "One", verifiedAt: now },
      { discordId: "d2", dayzId: "U2", gamertag: "Two", verifiedAt: now },
    ]);
    expect(await store.linkedDiscordIds()).toEqual(new Set(["d1", "d2"]));
  });

  it("fullMembersOf lists full members only, regardless of a role id", async () => {
    const a = await seedFaction(db, { serverId, tag: "AAA", texture: "Flag_A", createdAt: now, poleKey: "1.00:1.00:1.00" });
    const b = await seedFaction(db, { serverId, tag: "BBB", texture: "Flag_B", createdAt: now, poleKey: "2.00:1.00:2.00" });
    await db.insert(factionMembers).values([
      { factionId: a.id, serverId, dayzId: "U1", discordId: "d1", role: "leader", joinedAt: now, status: "full" },
      { factionId: a.id, serverId, dayzId: "U2", discordId: "d2", role: "member", joinedAt: now, status: "pending" },
      { factionId: b.id, serverId, dayzId: "U3", discordId: "d3", role: "leader", joinedAt: now, status: "full" },
    ]);
    // Neither clan has a Discord role id yet.
    expect(await store.fullMembersOf([a.id, b.id])).toEqual(
      new Map([[a.id, ["d1"]], [b.id, ["d3"]]]),
    );
    expect(await store.fullMembersOf([])).toEqual(new Map());
  });

  it("currentAlphaFactionIds returns the ids of the latest closed week only", async () => {
    const week1 = new Date("2026-08-24T00:00:00Z");
    const week2 = new Date("2026-08-31T00:00:00Z");
    const bear = await seedFaction(db, { serverId, tag: "BEA", texture: "Flag_A", createdAt: now, poleKey: "1.00:1.00:1.00" });
    const wolf = await seedFaction(db, { serverId, tag: "WLF", texture: "Flag_B", createdAt: now, poleKey: "2.00:1.00:2.00" });
    const [season] = await db.insert(seasons).values({
      serverId, number: 1, startedAt: week1, weekClosedThrough: week2,
    }).returning();
    await db.insert(alphaWeeks).values([
      { seasonId: season!.id, weekStart: week1, rank: 1, factionId: bear.id, points: 10 },
      { seasonId: season!.id, weekStart: week2, rank: 1, factionId: wolf.id, points: 20 },
    ]);
    expect(await store.currentAlphaFactionIds()).toEqual(new Set([wolf.id]));
  });

  it("currentAlphaFactionIds is empty when no week has closed", async () => {
    await db.insert(seasons).values({ serverId, number: 1, startedAt: now, weekClosedThrough: null });
    expect(await store.currentAlphaFactionIds()).toEqual(new Set());
  });

  it("openGuestPassesByVoiceChannel delegates to openPassesByVoiceChannel", async () => {
    const a = await seedFaction(db, { serverId, tag: "AAA", texture: "Flag_A", createdAt: now });
    await store.setVoiceChannelId(a.id, "voice-a");
    await db.insert(guestPasses).values({
      factionId: a.id, discordUserId: "d1", grantedByDiscordId: "d0", grantedAt: now,
      expiresAt: new Date(now.getTime() + 1000),
    });
    expect(await store.openGuestPassesByVoiceChannel(now)).toEqual(new Map([["voice-a", new Set(["d1"])]]));
  });

  it("convertGuestPasses delegates to convertPassesForFullMembersDb", async () => {
    const a = await seedFaction(db, { serverId, tag: "AAA", texture: "Flag_A", createdAt: now });
    await db.insert(factionMembers).values({
      factionId: a.id, serverId, dayzId: "U1", discordId: "d1", role: "member", joinedAt: now, status: "full",
    });
    const [pass] = await db.insert(guestPasses).values({
      factionId: a.id, discordUserId: "d1", grantedByDiscordId: "d0", grantedAt: now,
      expiresAt: new Date(now.getTime() + 1000),
    }).returning();
    expect(await store.convertGuestPasses(now)).toBe(1);
    const [row] = await db.select({ convertedAt: guestPasses.convertedAt }).from(guestPasses).where(eq(guestPasses.id, pass!.id));
    expect(row!.convertedAt).not.toBeNull();
  });

  describe("desiredNicknames", () => {
    it("prefixes a full member's tag, falls back to the link's gamertag, and bares a non-member", async () => {
      const bear = await seedFaction(db, { serverId, name: "Night Bears", tag: "BEAR", texture: "Flag_A", status: "active", createdAt: now, poleKey: "1.00:1.00:1.00" });
      await db.insert(identityLinks).values([
        { discordId: "d1", dayzId: "U1", gamertag: "LinkOne", verifiedAt: now },
        { discordId: "d2", dayzId: "U2", gamertag: "LinkTwo", verifiedAt: now },
      ]);
      // Current gamertag wins over the link's stale one.
      await db.insert(players).values({ dayzId: "U1", gamertag: "One", firstSeenAt: now, lastSeenAt: now });
      await db.insert(factionMembers).values([
        { factionId: bear.id, serverId, dayzId: "U1", discordId: "d1", role: "leader", joinedAt: now, status: "full" },
        { factionId: bear.id, serverId, dayzId: "U2", discordId: "d2", role: "member", joinedAt: now, status: "pending" },
      ]);
      expect(await store.desiredNicknames()).toEqual(new Map([
        ["d1", "[BEAR] One"],
        ["d2", "LinkTwo"],
      ]));
    });

    it("bares the gamertag for a full member of a non-holding (lapsed) clan", async () => {
      const bear = await seedFaction(db, { serverId, name: "Night Bears", tag: "BEAR", texture: "Flag_A", status: "lapsed", createdAt: now, poleKey: "1.00:1.00:1.00" });
      await db.insert(identityLinks).values({ discordId: "d1", dayzId: "U1", gamertag: "One", verifiedAt: now });
      await db.insert(factionMembers).values({
        factionId: bear.id, serverId, dayzId: "U1", discordId: "d1", role: "leader", joinedAt: now, status: "full",
      });
      expect(await store.desiredNicknames()).toEqual(new Map([["d1", "One"]]));
    });

    it("truncates a 40-char gamertag so the nickname is exactly 32 chars, tag intact", async () => {
      const bear = await seedFaction(db, { serverId, name: "Night Bears", tag: "BEAR", texture: "Flag_A", status: "active", createdAt: now, poleKey: "1.00:1.00:1.00" });
      const longName = "X".repeat(40);
      await db.insert(identityLinks).values({ discordId: "d1", dayzId: "U1", gamertag: longName, verifiedAt: now });
      await db.insert(factionMembers).values({
        factionId: bear.id, serverId, dayzId: "U1", discordId: "d1", role: "leader", joinedAt: now, status: "full",
      });
      const result = await store.desiredNicknames();
      const nickname = result.get("d1")!;
      expect(nickname).toHaveLength(32);
      expect(nickname.startsWith("[BEAR] ")).toBe(true);
    });
  });
});
