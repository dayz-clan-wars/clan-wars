import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, type Database,
} from "@factions/db";
import { sql } from "drizzle-orm";
import { armbandAssignments } from "../src/armband-roster.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-12T12:00:00Z");

const UID_A = "75E109C86EABE1E14F7ACE47F2C9BF11757ACE0C";
const UID_B = "C87349CA0FCDDE3EAAE617E3E3349B013DD71F0A";

describe("armbandAssignments", () => {
  let db: Database;
  let serverId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table events, raw_lines, adm_files, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
  });

  const seedFaction = async (tag: string, texture: string) => {
    const [f] = await db.insert(factions).values({
      serverId, name: tag, tag, texture, status: "active",
      leaderDiscordId: `d-${tag}`, createdAt: now,
    }).returning();
    return f!.id;
  };

  const seedMember = async (factionId: number, dayzId: string, status: "full" | "pending") => {
    await db.insert(factionMembers).values({
      factionId, serverId, dayzId, discordId: `disc-${dayzId}`,
      role: "member", joinedAt: now, status,
    });
  };

  it("maps a full member to their faction's armband", async () => {
    const f = await seedFaction("BEAR", "Flag_Bear");
    await seedMember(f, UID_A, "full");

    expect(await armbandAssignments(db, serverId)).toEqual([
      { dayzId: UID_A, armband: "Armband_Bear" },
    ]);
  });

  /**
   * ⚠️ spec §4.5/§14: every "is a member" read means status = 'full'. A pending
   * member has accepted but has not yet been seen at the clan's base — giving
   * them the colours would publish a membership the game has not confirmed.
   */
  it("excludes a pending member", async () => {
    const f = await seedFaction("BEAR", "Flag_Bear");
    await seedMember(f, UID_A, "pending");

    expect(await armbandAssignments(db, serverId)).toEqual([]);
  });

  it("excludes members of a faction on another server", async () => {
    const [other] = await db.insert(servers).values({ name: "O", map: "chernarus", clockOffsetMs: 0 }).returning();
    const f = await seedFaction("BEAR", "Flag_Bear");
    await seedMember(f, UID_A, "full");
    const [of_] = await db.insert(factions).values({
      serverId: other!.id, name: "WOLF", tag: "WOLF", texture: "Flag_Wolf",
      status: "active", leaderDiscordId: "d-w", createdAt: now,
    }).returning();
    await db.insert(factionMembers).values({
      factionId: of_!.id, serverId: other!.id, dayzId: UID_B,
      discordId: "disc-b", role: "member", joinedAt: now, status: "full",
    });

    expect(await armbandAssignments(db, serverId)).toEqual([
      { dayzId: UID_A, armband: "Armband_Bear" },
    ]);
  });

  /**
   * ⚠️ armbandFor() returns null outside the 34-flag pool. Emitting a derived
   * name for an unknown texture would name an item that does not exist, and
   * CreateAttachment on a bad classname is a script error at spawn time.
   */
  it("drops a faction whose texture is outside the claimable pool", async () => {
    const f = await seedFaction("GHOST", "Flag_Nonsense");
    await seedMember(f, UID_A, "full");

    expect(await armbandAssignments(db, serverId)).toEqual([]);
  });
});
