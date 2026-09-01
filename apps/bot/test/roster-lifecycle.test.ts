import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, rosterCooldowns,
  type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { PgRosterStore } from "../src/roster-store.js";
import type { RenameArgs } from "../src/roster-store.js";

const URL = requireTestDatabaseUrl();
const LEADER = "d1";
const t0 = new Date("2026-08-31T12:00:00Z");
const RENAME_COOLDOWN_MS = 604_800_000; // 7 days
const past = new Date(t0.getTime() - RENAME_COOLDOWN_MS - 1);

describe("PgRosterStore disband and rename", () => {
  let db: Database;
  let store: PgRosterStore;
  let serverId = 0;
  let factionId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table faction_invites, roster_cooldowns, faction_members, factions, identity_links, servers restart identity cascade`);
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
      { factionId, serverId, dayzId: "M".repeat(40), discordId: "d3", role: "member", joinedAt: t0 },
    ]);
  });

  describe("disband", () => {
    it("refuses a non-leader", async () => {
      const r = await store.disband(factionId, "d3");
      expect(r).toBe("not-leader");
      const [f] = await db.select().from(factions).where(eq(factions.id, factionId));
      expect(f!.status).toBe("active");
    });

    it("disbanding releases flag, tag, pole and roster", async () => {
      expect(await store.disband(factionId, LEADER)).toBe("ok");
      const [f] = await db.select().from(factions).where(eq(factions.id, factionId));
      expect(f!.status).toBe("disbanded");
      expect(await db.select().from(factionMembers).where(eq(factionMembers.factionId, factionId))).toEqual([]);
      // The releasing indexes are partial over the holding statuses, so the
      // texture is immediately re-claimable by someone else.
      await db.insert(factions).values({
        serverId, name: "Bears II", tag: "BEAR", texture: "Flag_Bear", poleKey: "1:2:3",
        x: "1.00", y: "2.00", z: "3.00", status: "active", leaderDiscordId: "d9", createdAt: t0,
      });
    });

    it("disbanding writes no cooldowns", async () => {
      await store.disband(factionId, LEADER);
      expect(await db.select().from(rosterCooldowns)).toEqual([]);
    });
  });

  /**
   * Leadership authority must follow the `faction_members` roster row, which
   * `faction_members_leader_uniq` protects, and never the denormalised
   * `factions.leader_discord_id` copy. Every other suite in this plan seeds
   * the two in agreement and never transfers, so a guard reading the stale
   * copy looked correct everywhere. These tests transfer first.
   */
  describe("after a leadership transfer", () => {
    const NEW_LEADER = "d3";

    beforeEach(async () => {
      expect(await store.transfer({ factionId, fromDiscordId: LEADER, toDiscordId: NEW_LEADER, at: t0 })).toBe("ok");
    });

    it("names the new leader on the faction row", async () => {
      const [f] = await db.select().from(factions).where(eq(factions.id, factionId));
      expect(f!.leaderDiscordId).toBe(NEW_LEADER);
    });

    it("lets the new leader rename", async () => {
      const r = await store.rename({ factionId, discordId: NEW_LEADER, name: "Cubs", at: t0, notBefore: past });
      expect(r).toBe("ok");
      const [f] = await db.select().from(factions).where(eq(factions.id, factionId));
      expect(f!.name).toBe("Cubs");
    });

    it("lets the new leader disband", async () => {
      expect(await store.disband(factionId, NEW_LEADER)).toBe("ok");
      const [f] = await db.select().from(factions).where(eq(factions.id, factionId));
      expect(f!.status).toBe("disbanded");
    });

    it("refuses the demoted old leader's rename", async () => {
      const r = await store.rename({ factionId, discordId: LEADER, name: "Cubs", at: t0, notBefore: past });
      expect(r).toBe("not-leader");
      const [f] = await db.select().from(factions).where(eq(factions.id, factionId));
      expect(f!.name).toBe("Bears");
    });

    it("refuses the demoted old leader's disband", async () => {
      expect(await store.disband(factionId, LEADER)).toBe("not-leader");
      const [f] = await db.select().from(factions).where(eq(factions.id, factionId));
      expect(f!.status).toBe("active");
      expect(await db.select().from(factionMembers).where(eq(factionMembers.factionId, factionId))).toHaveLength(2);
    });
  });

  describe("rename", () => {
    const renameArgs = (over: Partial<RenameArgs> = {}): RenameArgs => ({
      factionId, discordId: LEADER, name: "Second", at: t0, notBefore: past,
      ...over,
    });

    it("refuses a non-leader", async () => {
      const r = await store.rename(renameArgs({ discordId: "d3" }));
      expect(r).toBe("not-leader");
    });

    it("a first rename is always allowed", async () => {
      const r = await store.rename(renameArgs({ name: "First" }));
      expect(r).toBe("ok");
      const [f] = await db.select().from(factions).where(eq(factions.id, factionId));
      expect(f!.name).toBe("First");
      expect(f!.renamedAt).not.toBeNull();
    });

    it("a rename inside the cooldown is refused and changes nothing", async () => {
      const t1 = new Date(t0.getTime() + 60_000);
      const t1MinusSixDays = new Date(t1.getTime() - 6 * 24 * 60 * 60 * 1000);
      const ok1 = await store.rename({ factionId, discordId: LEADER, name: "First", at: t0, notBefore: past });
      expect(ok1).toBe("ok");
      const r = await store.rename({ factionId, discordId: LEADER, name: "Second", at: t1, notBefore: t1MinusSixDays });
      expect(r).toBe("cooldown");
      const [f] = await db.select().from(factions).where(eq(factions.id, factionId));
      expect(f!.name).toBe("First");
    });

    it("a rename after the cooldown has elapsed is allowed", async () => {
      const t1 = new Date(t0.getTime() + RENAME_COOLDOWN_MS + 60_000);
      const notBefore = new Date(t1.getTime() - RENAME_COOLDOWN_MS);
      await store.rename({ factionId, discordId: LEADER, name: "First", at: t0, notBefore: past });
      const r = await store.rename({ factionId, discordId: LEADER, name: "Second", at: t1, notBefore });
      expect(r).toBe("ok");
      const [f] = await db.select().from(factions).where(eq(factions.id, factionId));
      expect(f!.name).toBe("Second");
    });
  });
});
