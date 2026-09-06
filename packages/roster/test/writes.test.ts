import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, factionInvites, identityHolds, rosterCooldowns, identityLinks, players,
  poles, events, admFiles, declarations, ceremonies, ceremonyParticipants,
  type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { PENDING_EXPIRY_MS, ROSTER_COOLDOWN_MS, ACTIVATION_WINDOW_MS, RELEASED_POLE_GRACE_MS } from "@factions/domain";
import { actorFor } from "../src/actor";
import {
  inviteDb, acceptInviteDb, leaveDb, requestJoinDbByTag, decideRequestDbFor,
  kickDb, promoteDb, demoteDb, transferDb, disbandDb, renameDb, setRecruitingPostDb,
  claimCeremonyDb, confirmRebindDb,
} from "../src/writes";
import { seedFaction } from "./seed";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-05T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const key = (x: number, z: number) => `${x.toFixed(2)}:100.00:${z.toFixed(2)}`;

const UID_L = "L".repeat(40);
const UID_O = "O".repeat(40);
const UID_T = "T".repeat(40);

describe("roster package writes", () => {
  let db: Database;
  let serverId = 0;
  let admFileId = 0;
  let line = 0;
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
    const [adm] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    admFileId = adm!.id;
    line = 0;

    await db.insert(players).values([
      { dayzId: UID_L, gamertag: "Leo", firstSeenAt: now, lastSeenAt: now },
      { dayzId: UID_O, gamertag: "Otto", firstSeenAt: now, lastSeenAt: now },
      { dayzId: UID_T, gamertag: "Theo", firstSeenAt: now, lastSeenAt: now },
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

  const raise = async (dayzId: string, poleKey: string, x: number, z: number, at: Date, texture = "Flag_Bear") => {
    const [e] = await db.insert(events).values({
      serverId, admFileId, lineIndex: line++, type: "flag.raised", occurredAt: at,
      payload: { dayzId, gamertag: "G", texture, poleKey, pole: { x, y: 100, z } },
    }).returning({ id: events.id });
    return e!.id;
  };

  it("actorFor: not-linked, not-in-clan, pending, and the leader", async () => {
    expect(await actorFor(db, "d-nobody")).toBe("not-linked");
    expect(await actorFor(db, "d2")).toBe("not-in-clan");

    await db.insert(factionMembers).values({
      factionId, serverId, dayzId: UID_O, discordId: "d2", role: "member", joinedAt: now, status: "pending", pendingSince: now,
    });
    expect(await actorFor(db, "d2")).toBe("pending");

    expect(await actorFor(db, "d1")).toEqual({
      discordId: "d1", dayzId: UID_L, gamertag: "Leo", factionId, serverId, role: "leader", status: "full",
    });
  });

  it("invite: the leader may, a member may not, and an unlinked invitee is refused", async () => {
    const invited = await inviteDb(db, now, "d1", "d2");
    expect(invited.outcome).toBe("ok");
    expect(invited.inviteId).not.toBeNull();
    const [row] = await db.select().from(factionInvites).where(eq(factionInvites.id, invited.inviteId!));
    expect(row!.expiresAt.getTime()).toBe(now.getTime() + PENDING_EXPIRY_MS);

    const byMember = await inviteDb(db, now, "d3", "d2");
    expect(byMember.outcome).toBe("not-permitted");

    const toUnlinked = await inviteDb(db, now, "d1", "d-ghost");
    expect(toUnlinked.outcome).toBe("invitee-not-linked");
  });

  it("acceptInvite writes a pending row; leave removes it and stamps a cooldown", async () => {
    const { inviteId } = await inviteDb(db, now, "d1", "d2");
    expect(await acceptInviteDb(db, now, "d2", inviteId!)).toBe("ok");
    const [pending] = await db.select().from(factionMembers).where(eq(factionMembers.discordId, "d2"));
    expect(pending).toMatchObject({ status: "pending" });

    expect(await leaveDb(db, now, "d2")).toBe("ok");
    expect(await db.select().from(factionMembers).where(eq(factionMembers.discordId, "d2"))).toEqual([]);
    const [cd] = await db.select().from(rosterCooldowns).where(eq(rosterCooldowns.dayzId, UID_O));
    expect(cd!.until.getTime()).toBe(now.getTime() + ROSTER_COOLDOWN_MS);
  });

  it("requestJoin refuses a non-recruiting clan; an officer decides once it recruits; an unknown tag is refused", async () => {
    const notRecruiting = await requestJoinDbByTag(db, now, "d2", "BEAR");
    expect(notRecruiting.outcome).toBe("not-recruiting");

    expect(await setRecruitingPostDb(db, "d1", { recruiting: true, playWindow: null, language: null, pitch: null })).toBe("ok");

    const requested = await requestJoinDbByTag(db, now, "d2", "BEAR");
    expect(requested.outcome).toBe("ok");
    expect(requested.requestId).not.toBeNull();

    expect(await decideRequestDbFor(db, now, "d1", requested.requestId!, "accepted")).toBe("ok");
    const [pending] = await db.select().from(factionMembers).where(eq(factionMembers.discordId, "d2"));
    expect(pending).toMatchObject({ status: "pending" });

    const noSuchClan = await requestJoinDbByTag(db, now, "d2", "NOPE");
    expect(noSuchClan.outcome).toBe("no-such-clan");
  });

  it("kick, promote, demote, transfer on a full member; transfer refuses a pending target", async () => {
    expect(await promoteDb(db, "d1", "d3")).toBe("ok");
    expect((await db.select().from(factionMembers).where(eq(factionMembers.discordId, "d3")))[0]!.role).toBe("officer");

    expect(await demoteDb(db, "d1", "d3")).toBe("ok");
    expect((await db.select().from(factionMembers).where(eq(factionMembers.discordId, "d3")))[0]!.role).toBe("member");

    expect(await transferDb(db, now, "d1", "d3")).toBe("ok");
    expect((await db.select().from(factionMembers).where(eq(factionMembers.discordId, "d3")))[0]!.role).toBe("leader");

    expect(await kickDb(db, now, "d3", "d1")).toBe("ok");
    expect(await db.select().from(factionMembers).where(eq(factionMembers.discordId, "d1"))).toEqual([]);

    const { inviteId } = await inviteDb(db, now, "d3", "d2");
    await acceptInviteDb(db, now, "d2", inviteId!);
    expect(await transferDb(db, now, "d3", "d2")).toBe("target-not-member");
  });

  it("rename holds up the old identity and validates the new one", async () => {
    expect(await renameDb(db, now, "d1", { name: "Grizzlies", tag: "GRIZ" })).toBe("ok");
    const holds = await db.select().from(identityHolds).where(eq(identityHolds.serverId, serverId));
    expect(holds.map((h) => h.valueLower).sort()).toEqual(["bear", "bears"]);

    expect(await renameDb(db, now, "d1", { name: "ab" })).toBe("bad-name");
    expect(await renameDb(db, now, "d1", { name: "Fine", tag: "T@G" })).toBe("bad-tag");
  });

  it("disband: the leader may, a member may not", async () => {
    expect(await disbandDb(db, "d3")).toBe("not-leader");
    expect(await disbandDb(db, "d1")).toBe("ok");
    const [f] = await db.select().from(factions).where(eq(factions.id, factionId));
    expect(f!.status).toBe("disbanded");
  });

  describe("claimCeremony", () => {
    // ⚠️ A different server: `faction_members_server_player_uniq` is one
    // clan per player PER SERVER, and d1/d2/d3 already hold the Bears
    // membership seeded in the outer `beforeEach` on `serverId`. The
    // ceremony here founds a second clan for the same three (already-linked)
    // people, so it needs a server on which none of them has a roster row.
    let ceremonyServerId = 0;
    let ceremonyId = 0;

    beforeEach(async () => {
      const [s2] = await db.insert(servers).values({ name: "S2", map: "sakhal", clockOffsetMs: 0 }).returning();
      ceremonyServerId = s2!.id;
      const [c] = await db.insert(ceremonies).values({
        serverId: ceremonyServerId, poleKey: key(8000, 8000), x: "8000.00", y: "100.00", z: "8000.00",
        windowStart: now, windowEnd: now, status: "provisional", detectedAt: now,
        expiresAt: new Date(now.getTime() + 86_400_000),
      }).returning({ id: ceremonies.id });
      ceremonyId = c!.id;
      await db.insert(ceremonyParticipants).values([
        { ceremonyId, dayzId: UID_L, discordId: "d1", gamertag: "Leo" },
        { ceremonyId, dayzId: UID_O, discordId: "d2", gamertag: "Otto" },
        { ceremonyId, dayzId: UID_T, discordId: "d3", gamertag: "Theo" },
      ]);
    });

    it("reserves a clan from a ceremony, pruned to the chosen roster", async () => {
      const out = await claimCeremonyDb(db, now, "d1", ceremonyId, {
        name: "Wolves", tag: "WOLF", texture: "Flag_Wolf", memberDayzIds: [UID_L, UID_O],
      });
      expect(out).toBe("ok");
      const [f] = await db.select().from(factions).where(eq(factions.tag, "WOLF"));
      expect(f).toBeDefined();
      expect(f!.status).toBe("reserved");
      expect(f!.reservedUntil!.getTime()).toBe(now.getTime() + ACTIVATION_WINDOW_MS);
      const members = await db.select().from(factionMembers).where(eq(factionMembers.factionId, f!.id));
      expect(members).toHaveLength(2);
      const [decl] = await db.select().from(declarations).where(eq(declarations.ownerFactionId, f!.id));
      expect(decl!.evidenceCeremonyId).toBe(ceremonyId);
    });

    it("refuses a roster missing the claimant", async () => {
      const out = await claimCeremonyDb(db, now, "d1", ceremonyId, {
        name: "Wolves", tag: "WOLF", texture: "Flag_Wolf", memberDayzIds: [UID_O, UID_T],
      });
      expect(out).toBe("bad-roster");
    });

    it("refuses a texture outside the claimable set", async () => {
      const out = await claimCeremonyDb(db, now, "d1", ceremonyId, {
        name: "Wolves", tag: "WOLF", texture: "Flag_Nope", memberDayzIds: [UID_L, UID_O],
      });
      expect(out).toBe("bad-flag");
    });

    it("refuses a ceremony the caller was not a participant in", async () => {
      const [other] = await db.insert(ceremonies).values({
        serverId: ceremonyServerId, poleKey: key(9000, 9000), x: "9000.00", y: "100.00", z: "9000.00",
        windowStart: now, windowEnd: now, status: "provisional", detectedAt: now,
        expiresAt: new Date(now.getTime() + 86_400_000),
      }).returning({ id: ceremonies.id });
      await db.insert(ceremonyParticipants).values([
        { ceremonyId: other!.id, dayzId: UID_L, discordId: "d1", gamertag: "Leo" },
        { ceremonyId: other!.id, dayzId: UID_T, discordId: "d3", gamertag: "Theo" },
      ]);
      const out = await claimCeremonyDb(db, now, "d2", other!.id, {
        name: "Foxes", tag: "FOXX", texture: "Flag_Rex", memberDayzIds: [UID_L],
      });
      expect(out).toBe("no-such-ceremony");
    });
  });

  describe("confirmRebind", () => {
    const newPole = key(8000, 8000);

    it("refuses with no candidate, refuses an officer, and otherwise moves the base", async () => {
      expect(await confirmRebindDb(db, now, "d1", newPole)).toBe("no-candidate");

      await raise(UID_T, newPole, 8000, 8000, ago(30 * 60_000));

      await promoteDb(db, "d1", "d3");
      expect(await confirmRebindDb(db, now, "d3", newPole)).toBe("not-leader");

      expect(await confirmRebindDb(db, now, "d1", newPole)).toBe("ok");
      const [decl] = await db.select().from(declarations).where(eq(declarations.ownerFactionId, factionId));
      expect(decl!.poleKey).toBe(newPole);
      const [oldPole] = await db.select().from(poles).where(eq(poles.poleKey, "5000.00:100.00:5000.00"));
      expect(oldPole!.graceUntil.getTime()).toBe(now.getTime() + RELEASED_POLE_GRACE_MS);
    });
  });
});
