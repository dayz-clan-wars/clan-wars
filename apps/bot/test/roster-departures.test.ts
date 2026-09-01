import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, rosterCooldowns,
  type Database,
} from "@factions/db";
import { sql, eq, and } from "drizzle-orm";
import { PgRosterStore } from "../src/roster-store.js";
import type { KickArgs, LeaveArgs } from "../src/roster-store.js";

const URL = requireTestDatabaseUrl();
const LEADER = "d1";
const OFFICER = "d2";
const MEMBER = "d3";
const t0 = new Date("2026-08-31T12:00:00Z");
const UNTIL = new Date(t0.getTime() + 259_200_000);

describe("PgRosterStore kick and leave", () => {
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

  describe("kick", () => {
    const kickArgs = (over: Partial<KickArgs> = {}): KickArgs => ({
      factionId, actorDiscordId: LEADER, targetDiscordId: MEMBER, at: t0, until: UNTIL,
      ...over,
    });

    it("an officer cannot kick another officer", async () => {
      // Second officer to kick each other.
      await db.insert(factionMembers).values({
        factionId, serverId, dayzId: "O2".padEnd(40, "0"), discordId: "d4", role: "officer", joinedAt: t0,
      });
      const r = await store.kick(kickArgs({ actorDiscordId: OFFICER, targetDiscordId: "d4" }));
      expect(r).toBe("cannot-kick-officer");
    });

    it("an officer cannot kick the leader", async () => {
      const r = await store.kick(kickArgs({ actorDiscordId: OFFICER, targetDiscordId: LEADER }));
      expect(r).toBe("cannot-kick-leader");
    });

    it("the leader can kick an officer", async () => {
      const r = await store.kick(kickArgs({ actorDiscordId: LEADER, targetDiscordId: OFFICER }));
      expect(r).toBe("ok");
      const rows = await db.select().from(factionMembers).where(eq(factionMembers.discordId, OFFICER));
      expect(rows).toHaveLength(0);
    });

    it("nobody kicks themselves", async () => {
      const r = await store.kick(kickArgs({ actorDiscordId: LEADER, targetDiscordId: LEADER }));
      expect(r).toBe("cannot-kick-self");
    });

    it("refuses when the target is not a member", async () => {
      const r = await store.kick(kickArgs({ targetDiscordId: "nobody" }));
      expect(r).toBe("target-not-member");
    });

    it("refuses when the actor is not permitted", async () => {
      const r = await store.kick(kickArgs({ actorDiscordId: MEMBER, targetDiscordId: OFFICER }));
      expect(r).toBe("not-permitted");
    });

    it("a kick writes a cooldown", async () => {
      const r = await store.kick(kickArgs({ actorDiscordId: LEADER, targetDiscordId: OFFICER }));
      expect(r).toBe("ok");
      const [row] = await db.select().from(rosterCooldowns)
        .where(and(eq(rosterCooldowns.serverId, serverId), eq(rosterCooldowns.dayzId, "O".repeat(40))));
      expect(row!.until.getTime()).toBe(UNTIL.getTime());
    });

    it("does not report ok or write a cooldown when the target is removed out from under the kick", async () => {
      // Simulate a concurrent departure: a separate transaction deletes the
      // target's membership row and holds the row lock (uncommitted) while
      // this kick's own read of actor/target still sees the old, pre-delete
      // state. Only when the racer commits does kick's own DELETE proceed —
      // by which point the row is gone. A kick() that decides "ok" from a
      // stale pre-read (rather than from what its own DELETE actually
      // removed) gets this wrong: it reports success and writes a cooldown
      // for a member who was never actually kicked by this call.
      let releaseLock!: () => void;
      const lockHeld = new Promise<void>((resolve) => { releaseLock = resolve; });
      let lockAcquired!: () => void;
      const lockAcquiredPromise = new Promise<void>((resolve) => { lockAcquired = resolve; });

      const racer = db.transaction(async (tx) => {
        await tx.delete(factionMembers)
          .where(and(eq(factionMembers.factionId, factionId), eq(factionMembers.discordId, OFFICER)));
        lockAcquired();
        await lockHeld;
      });

      await lockAcquiredPromise;
      const kickPromise = store.kick(kickArgs({ actorDiscordId: LEADER, targetDiscordId: OFFICER }));
      // Give kick's own (non-blocking) SELECTs time to run and its DELETE
      // time to reach the lock and start blocking, before we release it.
      await new Promise((resolve) => setTimeout(resolve, 100));
      releaseLock();
      await racer;

      const result = await kickPromise;
      expect(result).not.toBe("ok");
      expect(await db.select().from(rosterCooldowns)).toHaveLength(0);
    });
  });

  describe("leave", () => {
    const leaveArgs = (over: Partial<LeaveArgs> = {}): LeaveArgs => ({
      factionId, discordId: MEMBER, at: t0, until: UNTIL,
      ...over,
    });

    it("the leader cannot leave", async () => {
      const r = await store.leave(leaveArgs({ discordId: LEADER }));
      expect(r).toBe("leader-must-transfer");
      const rows = await db.select().from(factionMembers).where(eq(factionMembers.discordId, LEADER));
      expect(rows).toHaveLength(1);
    });

    it("refuses when not a member", async () => {
      const r = await store.leave(leaveArgs({ discordId: "nobody" }));
      expect(r).toBe("not-member");
    });

    it("a member can leave", async () => {
      const r = await store.leave(leaveArgs({ discordId: MEMBER }));
      expect(r).toBe("ok");
      const rows = await db.select().from(factionMembers).where(eq(factionMembers.discordId, MEMBER));
      expect(rows).toHaveLength(0);
    });

    it("leaving writes the same cooldown a kick does", async () => {
      await store.leave(leaveArgs({ discordId: MEMBER }));
      const [row] = await db.select().from(rosterCooldowns)
        .where(and(eq(rosterCooldowns.serverId, serverId), eq(rosterCooldowns.dayzId, "M".repeat(40))));
      expect(row!.until.getTime()).toBe(UNTIL.getTime());
    });

    it("extends an existing cooldown rather than shortening it", async () => {
      const far = new Date(t0.getTime() + 500_000_000);
      const near = new Date(t0.getTime() + 1_000);

      await store.leave(leaveArgs({ discordId: MEMBER, until: far }));
      // Rejoin, then leave again with a shorter cooldown.
      await db.insert(factionMembers).values({
        factionId, serverId, dayzId: "M".repeat(40), discordId: MEMBER, role: "member", joinedAt: t0,
      });
      await store.leave(leaveArgs({ discordId: MEMBER, until: near }));

      const [row] = await db.select().from(rosterCooldowns)
        .where(and(eq(rosterCooldowns.serverId, serverId), eq(rosterCooldowns.dayzId, "M".repeat(40))));
      expect(row!.until.getTime()).toBe(far.getTime());
    });
  });
});
