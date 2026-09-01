import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers,
  type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { PgRosterStore } from "../src/roster-store.js";
import type { SetRoleArgs, TransferArgs } from "../src/roster-store.js";

const URL = requireTestDatabaseUrl();
const LEADER = "d1";
const OFFICER = "d2";
const MEMBER = "d3";
const t0 = new Date("2026-08-31T12:00:00Z");

describe("PgRosterStore setRole and transfer", () => {
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
    const [f] = await db.insert(factions).values({
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", poleKey: "1:2:3",
      x: "1.00", y: "2.00", z: "3.00", status: "active", leaderDiscordId: LEADER, createdAt: t0,
    }).returning();
    factionId = f!.id;
    await db.insert(factionMembers).values([
      { factionId, serverId, dayzId: "L".repeat(40), discordId: LEADER, role: "leader", joinedAt: t0 },
      { factionId, serverId, dayzId: "O".repeat(40), discordId: OFFICER, role: "officer", joinedAt: t0 },
      { factionId, serverId, dayzId: "M".repeat(40), discordId: MEMBER, role: "member", joinedAt: t0 },
    ]);
  });

  describe("setRole", () => {
    const setRoleArgs = (over: Partial<SetRoleArgs> = {}): SetRoleArgs => ({
      factionId, actorDiscordId: LEADER, targetDiscordId: MEMBER, role: "officer",
      ...over,
    });

    it("only the leader promotes", async () => {
      const r = await store.setRole(setRoleArgs({ actorDiscordId: OFFICER, targetDiscordId: MEMBER, role: "officer" }));
      expect(r).toBe("not-leader");
      const [row] = await db.select().from(factionMembers).where(eq(factionMembers.discordId, MEMBER));
      expect(row!.role).toBe("member");
    });

    it("demote cannot target the leader", async () => {
      const r = await store.setRole(setRoleArgs({ actorDiscordId: LEADER, targetDiscordId: LEADER, role: "member" }));
      expect(r).toBe("cannot-target-leader");
      const [row] = await db.select().from(factionMembers).where(eq(factionMembers.discordId, LEADER));
      expect(row!.role).toBe("leader");
    });

    it("the leader promotes a member to officer", async () => {
      const r = await store.setRole(setRoleArgs({ actorDiscordId: LEADER, targetDiscordId: MEMBER, role: "officer" }));
      expect(r).toBe("ok");
      const [row] = await db.select().from(factionMembers).where(eq(factionMembers.discordId, MEMBER));
      expect(row!.role).toBe("officer");
    });

    it("the leader demotes an officer to member", async () => {
      const r = await store.setRole(setRoleArgs({ actorDiscordId: LEADER, targetDiscordId: OFFICER, role: "member" }));
      expect(r).toBe("ok");
      const [row] = await db.select().from(factionMembers).where(eq(factionMembers.discordId, OFFICER));
      expect(row!.role).toBe("member");
    });

    it("refuses when the target is not a member", async () => {
      const r = await store.setRole(setRoleArgs({ targetDiscordId: "nobody" }));
      expect(r).toBe("target-not-member");
    });
  });

  describe("transfer", () => {
    const transferArgs = (over: Partial<TransferArgs> = {}): TransferArgs => ({
      factionId, fromDiscordId: LEADER, toDiscordId: MEMBER, at: t0,
      ...over,
    });

    it("transfer swaps both roles in one transaction", async () => {
      const r = await store.transfer(transferArgs({ fromDiscordId: LEADER, toDiscordId: MEMBER }));
      expect(r).toBe("ok");
      const rows = await db.select().from(factionMembers).where(eq(factionMembers.factionId, factionId));
      expect(rows.find((row) => row.discordId === LEADER)!.role).toBe("officer");
      expect(rows.find((row) => row.discordId === MEMBER)!.role).toBe("leader");
    });

    it("a transfer by a non-leader changes nothing", async () => {
      const r = await store.transfer(transferArgs({ fromDiscordId: OFFICER, toDiscordId: MEMBER }));
      expect(r).toBe("not-leader");
      const rows = await db.select().from(factionMembers).where(eq(factionMembers.factionId, factionId));
      expect(rows.find((row) => row.discordId === LEADER)!.role).toBe("leader");
      expect(rows.find((row) => row.discordId === MEMBER)!.role).toBe("member");
    });

    it("transferring to a non-member changes nothing", async () => {
      const r = await store.transfer(transferArgs({ toDiscordId: "nobody" }));
      expect(r).toBe("target-not-member");
      const rows = await db.select().from(factionMembers).where(eq(factionMembers.factionId, factionId));
      expect(rows.find((row) => row.discordId === LEADER)!.role).toBe("leader");
    });
  });
});
