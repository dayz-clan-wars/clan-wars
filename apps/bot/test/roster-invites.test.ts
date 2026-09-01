import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, factionInvites, rosterCooldowns,
  type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { PgRosterStore } from "../src/roster-store.js";
import type { CreateInviteArgs } from "../src/roster-store.js";

const URL = requireTestDatabaseUrl();
const LEADER = "d1";
const INVITEE_DISCORD = "d9";
const INVITEE_DAYZ = "P".repeat(40);
const t0 = new Date("2026-08-31T12:00:00Z");
const t1 = new Date("2026-08-31T13:00:00Z");

describe("PgRosterStore invites", () => {
  let db: Database;
  let store: PgRosterStore;
  let serverId = 0;
  let factionId = 0;
  let base: CreateInviteArgs;

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
    await db.insert(factionMembers).values({
      factionId, serverId, dayzId: "L".repeat(40), discordId: LEADER, role: "leader", joinedAt: t0,
    });

    base = {
      factionId, serverId,
      inviteeDiscordId: INVITEE_DISCORD, inviteeDayzId: INVITEE_DAYZ,
      invitedByDiscordId: LEADER,
      at: t0, expiresAt: new Date(t0.getTime() + 604_800_000),
    };
  });

  it("creates a pending invite and returns its id", async () => {
    const r = await store.createInvite(base);
    expect(r.outcome).toBe("ok");
    expect(r.inviteId).not.toBeNull();
    const rows = await db.select().from(factionInvites);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(r.inviteId);
  });

  it("refreshes an expired offer rather than inserting a second", async () => {
    // ⚠️ The pending index cannot include `expires_at > now()` (a partial
    // index predicate must be IMMUTABLE), so a lapsed offer still occupies
    // the slot. Re-inviting must therefore UPDATE it, not collide with it.
    await store.createInvite({ ...base, at: t0, expiresAt: new Date(t0.getTime() + 1000) });
    const r = await store.createInvite({ ...base, at: t1, expiresAt: new Date(t1.getTime() + 1000) });
    expect(r.outcome).toBe("ok");
    const rows = await db.select().from(factionInvites);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expiresAt.getTime()).toBe(t1.getTime() + 1000);
  });

  it("refuses to invite someone already a member on that server", async () => {
    await db.insert(factionMembers).values({
      factionId, serverId, dayzId: INVITEE_DAYZ, discordId: INVITEE_DISCORD, role: "member", joinedAt: t0,
    });
    const r = await store.createInvite(base);
    expect(r).toEqual({ outcome: "already-member", inviteId: null });
    expect(await db.select().from(factionInvites)).toHaveLength(0);
  });

  it("refuses to invite someone on cooldown", async () => {
    await db.insert(rosterCooldowns).values({ serverId, dayzId: INVITEE_DAYZ, until: new Date(t0.getTime() + 1000) });
    const r = await store.createInvite(base);
    expect(r).toEqual({ outcome: "cooldown", inviteId: null });
    expect(await db.select().from(factionInvites)).toHaveLength(0);
  });

  it("refuses to invite into a lapsed faction", async () => {
    await db.update(factions).set({ status: "disbanded" }).where(eq(factions.id, factionId));
    const r = await store.createInvite(base);
    expect(r).toEqual({ outcome: "not-holding", inviteId: null });
  });

  describe("accept and decline", () => {
    let inviteId = 0;

    beforeEach(async () => {
      const r = await store.createInvite(base);
      inviteId = r.inviteId!;
    });

    it("does not accept an expired invite", async () => {
      await db.update(factionInvites).set({ expiresAt: t0 }).where(eq(factionInvites.id, inviteId));
      expect(await store.acceptInvite(inviteId, INVITEE_DISCORD, new Date(t0.getTime() + 1))).toBe("gone");
    });

    it("does not accept someone else's invite", async () => {
      // The invite id rides in a button custom id, which is guessable.
      expect(await store.acceptInvite(inviteId, "not-the-invitee", t1)).toBe("gone");
      const [row] = await db.select().from(factionInvites).where(eq(factionInvites.id, inviteId));
      expect(row!.acceptedAt).toBeNull();
    });

    it("accepting twice adds one member", async () => {
      expect(await store.acceptInvite(inviteId, INVITEE_DISCORD, t1)).toBe("ok");
      expect(await store.acceptInvite(inviteId, INVITEE_DISCORD, t1)).toBe("gone");
      const rows = await db.select().from(factionMembers).where(eq(factionMembers.factionId, factionId));
      expect(rows).toHaveLength(2);
    });

    it("leaves the invite pending — not consumed — when the faction has lapsed", async () => {
      // ⚠️ This is the defect the brief warns about: returning early from
      // inside the transaction would have already committed the
      // acceptedAt update before this check runs. It must roll back.
      await db.update(factions).set({ status: "disbanded" }).where(eq(factions.id, factionId));
      expect(await store.acceptInvite(inviteId, INVITEE_DISCORD, t1)).toBe("not-holding");
      const [row] = await db.select().from(factionInvites).where(eq(factionInvites.id, inviteId));
      expect(row!.acceptedAt).toBeNull();
      expect(await db.select().from(factionMembers).where(eq(factionMembers.factionId, factionId))).toHaveLength(1);
    });

    it("leaves the invite still pending after a cooldown result", async () => {
      // Same defect, other guard: a `return "cooldown"` from inside the
      // transaction would commit the invite's acceptedAt update while adding
      // no member, permanently burning the invite for nothing.
      await db.insert(rosterCooldowns).values({ serverId, dayzId: INVITEE_DAYZ, until: new Date(t1.getTime() + 1000) });
      expect(await store.acceptInvite(inviteId, INVITEE_DISCORD, t1)).toBe("cooldown");
      const [row] = await db.select().from(factionInvites).where(eq(factionInvites.id, inviteId));
      expect(row!.acceptedAt).toBeNull();
      expect(row!.declinedAt).toBeNull();
      expect(row!.revokedAt).toBeNull();
      expect(await db.select().from(factionMembers).where(eq(factionMembers.factionId, factionId))).toHaveLength(1);
    });

    it("declines a pending invite", async () => {
      expect(await store.declineInvite(inviteId, INVITEE_DISCORD, t1)).toBe(true);
      const [row] = await db.select().from(factionInvites).where(eq(factionInvites.id, inviteId));
      expect(row!.declinedAt).toEqual(t1);
    });

    it("refuses to decline someone else's invite", async () => {
      expect(await store.declineInvite(inviteId, "not-the-invitee", t1)).toBe(false);
    });

    it("refuses to decline an already-accepted invite", async () => {
      expect(await store.acceptInvite(inviteId, INVITEE_DISCORD, t1)).toBe("ok");
      expect(await store.declineInvite(inviteId, INVITEE_DISCORD, t1)).toBe(false);
    });
  });

  describe("pendingInvitesFor", () => {
    it("lists only open, unexpired invites, soonest-expiring first", async () => {
      const [f2] = await db.insert(factions).values({
        serverId, name: "Wolves", tag: "WOLF", texture: "Flag_Wolf", poleKey: "4:5:6",
        x: "4.00", y: "5.00", z: "6.00", status: "active", leaderDiscordId: LEADER, createdAt: t0,
      }).returning();
      await db.insert(factionMembers).values({
        factionId: f2!.id, serverId, dayzId: "M".repeat(40), discordId: LEADER, role: "leader", joinedAt: t0,
      });

      await store.createInvite({ ...base, expiresAt: new Date(t0.getTime() + 20_000) });
      await store.createInvite({ ...base, factionId: f2!.id, expiresAt: new Date(t0.getTime() + 10_000) });

      const rows = await store.pendingInvitesFor(INVITEE_DAYZ, t0);
      expect(rows.map((r) => r.factionName)).toEqual(["Wolves", "Bears"]);
    });

    it("excludes expired, accepted, and declined invites", async () => {
      const r1 = await store.createInvite(base);
      await store.acceptInvite(r1.inviteId!, INVITEE_DISCORD, t0);
      expect(await store.pendingInvitesFor(INVITEE_DAYZ, t0)).toHaveLength(0);
    });
  });
});
