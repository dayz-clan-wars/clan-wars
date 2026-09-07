import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, guestPasses, type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { handleGuestCommand } from "../src/guest-command.js";
import { seedFaction } from "./seed.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-05T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const CHANNEL = "channel-1";

const D = { L: "dL", O: "dO", M: "dM" };
const UID = { L: "L".repeat(40), O: "O".repeat(40), M: "M".repeat(40) };
const GUEST_ID = "guest-1";

describe("handleGuestCommand", () => {
  let db: Database;
  let serverId = 0;
  let factionId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table guest_passes, faction_members, declarations, poles, factions, clan_notices, events, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const f = await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: ago(500_000), poleKey: "1000.00:100.00:1000.00" });
    factionId = f.id;
    await db.update(factions).set({ discordTextChannelId: CHANNEL }).where(eq(factions.id, factionId));
    await db.insert(factionMembers).values([
      { factionId, serverId, dayzId: UID.L, discordId: D.L, role: "leader", joinedAt: ago(400_000), status: "full" },
      { factionId, serverId, dayzId: UID.O, discordId: D.O, role: "officer", joinedAt: ago(400_000), status: "full" },
      { factionId, serverId, dayzId: UID.M, discordId: D.M, role: "member", joinedAt: ago(400_000), status: "full" },
    ]);
  });

  it("tells a channel that is not a clan's channel to run it in their own channel", async () => {
    const reply = await handleGuestCommand(db, { channelId: "some-other-channel", actorDiscordId: D.O, targetUserId: GUEST_ID, now });
    expect(reply).toEqual({ content: "Run this in your clan's channel.", ephemeral: true });
  });

  it("refuses a plain member", async () => {
    const reply = await handleGuestCommand(db, { channelId: CHANNEL, actorDiscordId: D.M, targetUserId: GUEST_ID, now });
    expect(reply).toEqual({ content: "Only an officer or the leader can give a guest pass.", ephemeral: true });
    expect(await db.select().from(guestPasses)).toEqual([]);
  });

  it("an officer grants a pass: the success line and one guest_passes row", async () => {
    const reply = await handleGuestCommand(db, { channelId: CHANNEL, actorDiscordId: D.O, targetUserId: GUEST_ID, now });
    expect(reply).toEqual({ content: "Guest pass given: <@guest-1> can see and join the voice channel for 24h.", ephemeral: true });
    const rows = await db.select().from(guestPasses);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ factionId, discordUserId: GUEST_ID });
  });

  it("an existing pass reports 'already active'", async () => {
    await handleGuestCommand(db, { channelId: CHANNEL, actorDiscordId: D.O, targetUserId: GUEST_ID, now });
    const reply = await handleGuestCommand(db, { channelId: CHANNEL, actorDiscordId: D.O, targetUserId: GUEST_ID, now });
    expect(reply).toEqual({ content: "They already have an active pass.", ephemeral: true });
    expect(await db.select().from(guestPasses)).toHaveLength(1);
  });

  it("a full member needs no pass", async () => {
    const reply = await handleGuestCommand(db, { channelId: CHANNEL, actorDiscordId: D.O, targetUserId: D.M, now });
    expect(reply).toEqual({ content: "They are a full member already — no pass needed.", ephemeral: true });
  });
});
