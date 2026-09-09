import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, factionInvites, factionJoinRequests, rosterCooldowns,
  identityLinks, players, ceremonies, ceremonyParticipants,
  type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { CLAIMABLE_FLAGS } from "@factions/domain";
import {
  clanForDb, directoryDb, clanByTagDb, claimContextDb, myInvitesDb, myRequestsDb,
} from "../src/reads";
import { openVoteDb, grantGuestPassDb } from "../src/internal";
import { promoteDb, demoteDb } from "../src/writes";
import { seedFaction } from "./seed";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-05T12:00:00Z");

const UID_L = "L".repeat(40);
const UID_O = "O".repeat(40);
const UID_T = "T".repeat(40);
const UID_I = "I".repeat(40);
const UID_R = "R".repeat(40);

describe("the roster package's page reads", () => {
  let db: Database;
  let serverId = 0;
  let factionId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table faction_join_requests, identity_holds, faction_invites, roster_cooldowns, faction_members, declarations, poles, factions, ceremony_participants, ceremonies, claim_drafts, identity_links, players, events, raw_lines, adm_files, faction_events, servers restart identity cascade`);
    });

    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;

    await db.insert(players).values([
      { dayzId: UID_L, gamertag: "Leo", firstSeenAt: now, lastSeenAt: now },
      { dayzId: UID_O, gamertag: "Otto", firstSeenAt: now, lastSeenAt: now },
      { dayzId: UID_T, gamertag: "Theo", firstSeenAt: now, lastSeenAt: now },
      { dayzId: UID_I, gamertag: "Ivy", firstSeenAt: now, lastSeenAt: now },
      { dayzId: UID_R, gamertag: "Rex", firstSeenAt: now, lastSeenAt: now },
    ]);
    await db.insert(identityLinks).values([
      { discordId: "d1", dayzId: UID_L, gamertag: "Leo", verifiedAt: now },
      { discordId: "d2", dayzId: UID_O, gamertag: "Otto", verifiedAt: now },
      { discordId: "d3", dayzId: UID_T, gamertag: "Theo", verifiedAt: now },
    ]);

    const f = await seedFaction(db, {
      serverId, tag: "BEAR", name: "Bears", texture: "Flag_Bear",
      leaderDiscordId: "d1", createdAt: now, activatedAt: now,
    });
    factionId = f.id;
    await db.insert(factionMembers).values([
      { factionId, serverId, dayzId: UID_L, discordId: "d1", role: "leader", joinedAt: now, status: "full" },
      { factionId, serverId, dayzId: UID_T, discordId: "d3", role: "member", joinedAt: now, status: "full" },
    ]);
  });

  const setRecruiting = (id: number, recruiting = true) =>
    db.update(factions).set({ recruiting }).where(eq(factions.id, id));

  describe("clanFor", () => {
    it("the leader sees invitesOut and requestsIn populated", async () => {
      await db.insert(factionInvites).values({
        factionId, serverId, inviteeDiscordId: "d-invitee", inviteeDayzId: UID_I,
        invitedByDiscordId: "d1", createdAt: now, expiresAt: new Date(now.getTime() + 86_400_000),
      });
      await db.insert(factionJoinRequests).values({
        factionId, serverId, dayzId: UID_R, discordId: "d-requester",
        createdAt: now, expiresAt: new Date(now.getTime() + 86_400_000),
      });

      const view = await clanForDb(db, "d1", now);
      if (view === "not-linked" || view === "not-in-clan") throw new Error("expected a ClanView");
      expect(view.me).toEqual({ role: "leader", status: "full" });
      expect(view.clan.base).toEqual({ x: expect.any(Number), z: expect.any(Number) });
      expect(view.invitesOut).toHaveLength(1);
      expect(view.requestsIn).toHaveLength(1);
      expect(view.roster.map((r) => r.dayzId).sort()).toEqual([UID_L, UID_T].sort());
      expect(view.leadership.canClaim).toBe("is-leader");
    });

    it("a plain member sees the roster but no invitesOut or requestsIn", async () => {
      await db.insert(factionInvites).values({
        factionId, serverId, inviteeDiscordId: "d-invitee", inviteeDayzId: UID_I,
        invitedByDiscordId: "d1", createdAt: now, expiresAt: new Date(now.getTime() + 86_400_000),
      });

      const view = await clanForDb(db, "d3", now);
      if (view === "not-linked" || view === "not-in-clan") throw new Error("expected a ClanView");
      expect(view.me).toEqual({ role: "member", status: "full" });
      expect(view.invitesOut).toEqual([]);
      expect(view.requestsIn).toEqual([]);
      expect(view.rebindCandidates).toEqual([]);
      expect(view.guestPasses).toEqual([]);
    });

    it("shows an open vote's myBallot/inElectorate for a full member who has not voted", async () => {
      const UID_V = "V".repeat(40);
      await db.insert(players).values({ dayzId: UID_V, gamertag: "Vera", firstSeenAt: now, lastSeenAt: now });
      await db.insert(identityLinks).values({ discordId: "d6", dayzId: UID_V, gamertag: "Vera", verifiedAt: now });
      await db.insert(factionMembers).values({
        factionId, serverId, dayzId: UID_V, discordId: "d6", role: "member", joinedAt: now, status: "full",
      });

      await openVoteDb(db, { factionId, openerDiscordId: "d3", nomineeDiscordId: "d6", at: now, siteBaseUrl: "https://example.test" });

      const view = await clanForDb(db, "d6", now);
      if (view === "not-linked" || view === "not-in-clan") throw new Error("expected a ClanView");
      expect(view.leadership.openVote).not.toBeNull();
      expect(view.leadership.openVote!.inElectorate).toBe(true);
      expect(view.leadership.openVote!.myBallot).toBe(false);

      // The opener's nomination IS their own yes (ruling 3).
      const openerView = await clanForDb(db, "d3", now);
      if (openerView === "not-linked" || openerView === "not-in-clan") throw new Error("expected a ClanView");
      expect(openerView.leadership.openVote!.myBallot).toBe(true);
    });

    it("populates guestPasses for an officer, empty for a plain member", async () => {
      await promoteDb(db, "d1", "d3");
      await grantGuestPassDb(db, { factionId, actorDiscordId: "d3", userDiscordId: "d-guest", at: now });

      const officerView = await clanForDb(db, "d3", now);
      if (officerView === "not-linked" || officerView === "not-in-clan") throw new Error("expected a ClanView");
      expect(officerView.guestPasses).toHaveLength(1);
      expect(officerView.guestPasses[0]!.userDiscordId).toBe("d-guest");

      await demoteDb(db, "d1", "d3");
      const plainView = await clanForDb(db, "d3", now);
      if (plainView === "not-linked" || plainView === "not-in-clan") throw new Error("expected a ClanView");
      expect(plainView.guestPasses).toEqual([]);
    });

    it("a pending member sees the roster, status pending, and no officer views", async () => {
      const UID_P = "P".repeat(40);
      await db.insert(players).values({ dayzId: UID_P, gamertag: "Pen", firstSeenAt: now, lastSeenAt: now });
      await db.insert(identityLinks).values({ discordId: "d5", dayzId: UID_P, gamertag: "Pen", verifiedAt: now });
      await db.insert(factionMembers).values({
        factionId, serverId, dayzId: UID_P, discordId: "d5", role: "member", joinedAt: now, status: "pending", pendingSince: now,
      });

      const view = await clanForDb(db, "d5", now);
      if (view === "not-linked" || view === "not-in-clan") throw new Error("expected a ClanView");
      expect(view.me.status).toBe("pending");
      expect(view.invitesOut).toEqual([]);
      expect(view.requestsIn).toEqual([]);
      expect(view.roster.map((r) => r.dayzId)).toContain(UID_P);
    });

    it("not-linked and not-in-clan", async () => {
      expect(await clanForDb(db, "d-nobody", now)).toBe("not-linked");
      expect(await clanForDb(db, "d2", now)).toBe("not-in-clan");
    });
  });

  describe("directory", () => {
    it("orders a recruiting clan first and reports the flag pool", async () => {
      await setRecruiting(factionId, false);
      const recruiting = await seedFaction(db, {
        serverId, tag: "WOLF", name: "Wolves", texture: "Flag_Wolf",
        poleKey: "6000.00:100.00:6000.00", x: 6000, z: 6000,
        leaderDiscordId: "d2", createdAt: now, activatedAt: now,
      });
      await setRecruiting(recruiting.id, true);
      const reserved = await seedFaction(db, {
        serverId, tag: "REX", name: "Foxes", texture: "Flag_Rex", status: "reserved",
        poleKey: "7000.00:100.00:7000.00", x: 7000, z: 7000,
        leaderDiscordId: "d3", createdAt: now, reservedUntil: new Date(now.getTime() + 86_400_000),
      });

      const { clans, flags } = await directoryDb(db);
      // Reserved clans are not public yet.
      expect(clans.map((c) => c.tag)).toEqual(["WOLF", "BEAR"]);
      expect(clans[0]!.memberCount).toBe(0);
      expect(clans[1]!.memberCount).toBe(2);

      const taken = [reserved.texture, "Flag_Bear", "Flag_Wolf"].sort();
      expect(flags.taken.slice().sort()).toEqual(taken);
      expect(flags.free).toHaveLength(CLAIMABLE_FLAGS.length - taken.length);
      expect(flags.free).not.toContain("Flag_Bear");
    });
  });

  describe("clanByTag", () => {
    beforeEach(async () => {
      await setRecruiting(factionId, true);
    });

    it("a stranger cannot request", async () => {
      const page = await clanByTagDb(db, "BEAR", null, now);
      expect(page!.canRequest).toBe("not-linked");
      expect(page!.roster.map((r) => r.role).sort()).toEqual(["leader", "member"]);
    });

    it("a linked outsider on a recruiting clan may request", async () => {
      const page = await clanByTagDb(db, "BEAR", "d2", now);
      expect(page!.canRequest).toBe("yes");
    });

    it("a linked outsider on cooldown may not", async () => {
      await db.insert(rosterCooldowns).values({ serverId, dayzId: UID_O, until: new Date(now.getTime() + 86_400_000) });
      const page = await clanByTagDb(db, "BEAR", "d2", now);
      expect(page!.canRequest).toBe("cooldown");
    });

    it("a linked outsider who already has an open request cannot request again", async () => {
      await db.insert(factionJoinRequests).values({
        factionId, serverId, dayzId: UID_O, discordId: "d2", createdAt: now, expiresAt: new Date(now.getTime() + 86_400_000),
      });
      const page = await clanByTagDb(db, "BEAR", "d2", now);
      expect(page!.canRequest).toBe("already-requested");
    });

    it("no such clan is null", async () => {
      expect(await clanByTagDb(db, "NOPE", "d2", now)).toBeNull();
    });

    it("a reserved clan's tag is null until activation (spec §4.4, matching directoryDb)", async () => {
      await seedFaction(db, {
        serverId, tag: "REX", name: "Foxes", texture: "Flag_Rex", status: "reserved",
        poleKey: "8000.00:100.00:8000.00", x: 8000, z: 8000,
        leaderDiscordId: "d3", createdAt: now, reservedUntil: new Date(now.getTime() + 86_400_000),
      });
      expect(await clanByTagDb(db, "REX", "d2", now)).toBeNull();
    });
  });

  describe("claimContext", () => {
    it("a participant sees the ceremony's roster and a flag pool excluding held textures", async () => {
      const [c] = await db.insert(ceremonies).values({
        serverId, poleKey: "9000.00:100.00:9000.00", x: "9000.00", y: "100.00", z: "9000.00",
        windowStart: now, windowEnd: now, status: "provisional", detectedAt: now,
        expiresAt: new Date(now.getTime() + 86_400_000),
      }).returning({ id: ceremonies.id });
      await db.insert(ceremonyParticipants).values([
        { ceremonyId: c!.id, dayzId: UID_L, discordId: "d1", gamertag: "Leo" },
        { ceremonyId: c!.id, dayzId: UID_O, discordId: "d2", gamertag: "Otto" },
        { ceremonyId: c!.id, dayzId: UID_T, discordId: "d3", gamertag: "Theo" },
      ]);

      const ctx = await claimContextDb(db, "d1");
      expect(ctx).not.toBeNull();
      expect(ctx!.ceremony.id).toBe(c!.id);
      expect(ctx!.ceremony.participants.map((p) => p.dayzId).sort()).toEqual([UID_L, UID_O, UID_T].sort());
      expect(ctx!.freeFlags).not.toContain("Flag_Bear");
      expect(ctx!.freeFlags).toHaveLength(CLAIMABLE_FLAGS.length - 1);
    });

    it("no open ceremony is null", async () => {
      expect(await claimContextDb(db, "d1")).toBeNull();
    });
  });

  describe("myInvites / myRequests", () => {
    it("lists the seeded rows", async () => {
      await db.insert(factionInvites).values({
        factionId, serverId, inviteeDiscordId: "d2", inviteeDayzId: UID_O,
        invitedByDiscordId: "d1", createdAt: now, expiresAt: new Date(now.getTime() + 86_400_000),
      });
      const invites = await myInvitesDb(db, "d2", now);
      expect(invites).toHaveLength(1);
      expect(invites[0]!.clanId).toBe(factionId);

      await setRecruiting(factionId, true);
      const other = await seedFaction(db, {
        serverId, tag: "WOLF", name: "Wolves", texture: "Flag_Wolf",
        poleKey: "6000.00:100.00:6000.00", x: 6000, z: 6000,
        leaderDiscordId: "d3", createdAt: now, activatedAt: now,
      });
      await db.insert(factionJoinRequests).values({
        factionId: other.id, serverId, dayzId: UID_O, discordId: "d2", createdAt: now, expiresAt: new Date(now.getTime() + 86_400_000),
      });
      const requests = await myRequestsDb(db, "d2", now);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.clanId).toBe(other.id);
    });

    it("a stranger has neither", async () => {
      expect(await myInvitesDb(db, "d-nobody", now)).toEqual([]);
      expect(await myRequestsDb(db, "d-nobody", now)).toEqual([]);
    });
  });
});
