import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factionMembers, identityLinks, type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { handleGuildMemberRemove } from "../src/guild-removal.js";
import { seedFaction } from "./seed.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-05T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const GUILD = "guild-1";
const OTHER_GUILD = "guild-2";
const UID_M = "M".repeat(40);
const D_M = "dM";

describe("handleGuildMemberRemove", () => {
  let db: Database;
  let serverId = 0;
  let factionId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table guest_passes, roster_cooldowns, faction_members, declarations, poles, factions, clan_notices, identity_links, events, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const f = await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: ago(500_000), poleKey: "1000.00:100.00:1000.00" });
    factionId = f.id;
    await db.insert(identityLinks).values({ discordId: D_M, dayzId: UID_M, gamertag: "Mina", verifiedAt: now });
    await db.insert(factionMembers).values({
      factionId, serverId, dayzId: UID_M, discordId: D_M, role: "member", joinedAt: ago(400_000), status: "full",
    });
  });

  it("returns 'other-guild' and writes nothing for a mismatched guild id", async () => {
    const result = await handleGuildMemberRemove(db, { guildId: OTHER_GUILD, expectedGuildId: GUILD, userId: D_M, now });
    expect(result).toBe("other-guild");
    const [link] = await db.select().from(identityLinks).where(eq(identityLinks.discordId, D_M));
    expect(link).toBeDefined();
    const [member] = await db.select().from(factionMembers).where(eq(factionMembers.discordId, D_M));
    expect(member).toBeDefined();
  });

  it("delegates to the store for the bot's own guild, and the member's row disappears", async () => {
    const result = await handleGuildMemberRemove(db, { guildId: GUILD, expectedGuildId: GUILD, userId: D_M, now });
    expect(result).toMatchObject({ linked: true, roster: "member-left" });
    expect(await db.select().from(factionMembers).where(eq(factionMembers.discordId, D_M))).toEqual([]);
    expect(await db.select().from(identityLinks).where(eq(identityLinks.discordId, D_M))).toEqual([]);
  });
});
