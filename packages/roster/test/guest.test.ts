import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, guestPasses, clanNotices,
  identityLinks, players, admFiles,
  type Database,
} from "@factions/db";
import { sql, eq, asc } from "drizzle-orm";
import { GUEST_PASS_MS } from "@factions/domain";
import {
  grantGuestPassDb, revokeGuestPassDb, openGuestPassesDb, openPassesByVoiceChannel, convertPassesForFullMembersDb,
} from "../src/internal";
import { seedFaction } from "./seed";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-05T12:00:00Z");

const UID = { L: "L".repeat(40), O1: "O".repeat(40), M1: "1".repeat(40) };
const TAGS: Record<keyof typeof UID, string> = { L: "Leo", O1: "Otto", M1: "Mina" };
const D: Record<keyof typeof UID, string> = { L: "dL", O1: "dO1", M1: "dM1" };
const U9 = "u9";

describe("guest-pass store", () => {
  let db: Database;
  let serverId = 0;
  let factionId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table guest_passes, vault_history, vault_locks, faction_vote_ballots, faction_votes, succession_claims, clan_notices, faction_join_requests, identity_holds, faction_invites, roster_cooldowns, faction_members, declarations, poles, factions, ceremony_participants, ceremonies, claim_drafts, identity_links, players, events, raw_lines, adm_files, faction_events, servers restart identity cascade`);
    });

    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true });

    const who = Object.keys(UID) as (keyof typeof UID)[];
    await db.insert(players).values(who.map((k) => ({ dayzId: UID[k], gamertag: TAGS[k], firstSeenAt: now, lastSeenAt: now })));
    await db.insert(identityLinks).values(who.map((k) => ({ discordId: D[k], dayzId: UID[k], gamertag: TAGS[k], verifiedAt: now })));

    const f = await seedFaction(db, {
      serverId, tag: "BEAR", name: "Bears", texture: "Flag_Bear",
      leaderDiscordId: D.L, createdAt: now, activatedAt: now,
    });
    factionId = f.id;
    await db.update(factions).set({ discordVoiceChannelId: "voice-1" }).where(eq(factions.id, factionId));

    await db.insert(factionMembers).values([
      { factionId, serverId, dayzId: UID.L, discordId: D.L, role: "leader", joinedAt: now, status: "full" },
      { factionId, serverId, dayzId: UID.O1, discordId: D.O1, role: "officer", joinedAt: now, status: "full" },
      { factionId, serverId, dayzId: UID.M1, discordId: D.M1, role: "member", joinedAt: now, status: "full" },
    ]);
  });

  afterEach(async () => { await db.$client.end(); });

  const notices = async () => {
    const rows = await db.select({ target: clanNotices.target, payload: clanNotices.payload }).from(clanNotices)
      .where(eq(clanNotices.kind, "guest")).orderBy(asc(clanNotices.id));
    return rows.map((r) => ({ target: r.target, payload: r.payload as Record<string, unknown> }));
  };

  const passRow = async (id: number) => (await db.select().from(guestPasses).where(eq(guestPasses.id, id)))[0]!;

  it("grant: officer+, expiry, notice, duplicate, is-member, self, not-permitted, revoke-then-regrant", async () => {
    const granted = await grantGuestPassDb(db, { factionId, actorDiscordId: D.O1, userDiscordId: U9, at: now });
    expect(granted.outcome).toBe("ok");
    expect(granted.passId).not.toBeNull();

    const row = await passRow(granted.passId!);
    expect(row.expiresAt.getTime()).toBe(now.getTime() + GUEST_PASS_MS);
    expect(row.revokedAt).toBeNull();
    expect(row.convertedAt).toBeNull();

    const ns = await notices();
    expect(ns).toEqual([{ target: "channel", payload: { officer: "Otto", user: U9 } }]);

    // Duplicate: an open pass already exists for u9.
    const again = await grantGuestPassDb(db, { factionId, actorDiscordId: D.O1, userDiscordId: U9, at: now });
    expect(again.outcome).toBe("already-active");
    expect(again.passId).toBeNull();

    // Grant to a full member of this clan.
    const toMember = await grantGuestPassDb(db, { factionId, actorDiscordId: D.O1, userDiscordId: D.M1, at: now });
    expect(toMember.outcome).toBe("is-member");

    // Grant by a plain member.
    const byMember = await grantGuestPassDb(db, { factionId, actorDiscordId: D.M1, userDiscordId: "u10", at: now });
    expect(byMember.outcome).toBe("not-permitted");

    // Grant to self.
    const toSelf = await grantGuestPassDb(db, { factionId, actorDiscordId: D.O1, userDiscordId: D.O1, at: now });
    expect(toSelf.outcome).toBe("self");

    // Revoke the open pass, then a fresh grant is ok again.
    const revoked = await revokeGuestPassDb(db, { factionId, actorDiscordId: D.O1, passId: granted.passId!, at: now });
    expect(revoked).toBe("ok");
    expect((await passRow(granted.passId!)).revokedAt?.getTime()).toBe(now.getTime());

    const regranted = await grantGuestPassDb(db, { factionId, actorDiscordId: D.O1, userDiscordId: U9, at: now });
    expect(regranted.outcome).toBe("ok");
    expect(regranted.passId).not.toBe(granted.passId);
  });

  it("revoke: not-permitted and gone", async () => {
    const granted = await grantGuestPassDb(db, { factionId, actorDiscordId: D.O1, userDiscordId: U9, at: now });

    const byMember = await revokeGuestPassDb(db, { factionId, actorDiscordId: D.M1, passId: granted.passId!, at: now });
    expect(byMember).toBe("not-permitted");

    const missing = await revokeGuestPassDb(db, { factionId, actorDiscordId: D.O1, passId: 999_999, at: now });
    expect(missing).toBe("gone");

    const ok = await revokeGuestPassDb(db, { factionId, actorDiscordId: D.O1, passId: granted.passId!, at: now });
    expect(ok).toBe("ok");

    const alreadyGone = await revokeGuestPassDb(db, { factionId, actorDiscordId: D.O1, passId: granted.passId!, at: now });
    expect(alreadyGone).toBe("gone");
  });

  it("openGuestPassesDb: only open passes, with granter gamertag", async () => {
    const granted = await grantGuestPassDb(db, { factionId, actorDiscordId: D.O1, userDiscordId: U9, at: now });

    const open = await openGuestPassesDb(db, factionId, now);
    expect(open).toEqual([{ id: granted.passId, userDiscordId: U9, grantedBy: "Otto", expiresAt: new Date(now.getTime() + GUEST_PASS_MS) }]);

    await revokeGuestPassDb(db, { factionId, actorDiscordId: D.O1, passId: granted.passId!, at: now });
    expect(await openGuestPassesDb(db, factionId, now)).toEqual([]);
  });

  it("openPassesByVoiceChannel: maps the clan's voice channel to open users, omits expired", async () => {
    await grantGuestPassDb(db, { factionId, actorDiscordId: D.O1, userDiscordId: U9, at: now });

    const later = new Date(now.getTime() + GUEST_PASS_MS + 1000);
    const map = await openPassesByVoiceChannel(db, later);
    expect(map.has("voice-1")).toBe(false);

    const soon = new Date(now.getTime() + 1000);
    const mapOpen = await openPassesByVoiceChannel(db, soon);
    expect(mapOpen.get("voice-1")).toEqual(new Set([U9]));
  });

  it("convertPassesForFullMembersDb: converts once the user is a full member, and it drops out of open lists", async () => {
    const granted = await grantGuestPassDb(db, { factionId, actorDiscordId: D.O1, userDiscordId: U9, at: now });

    expect(await convertPassesForFullMembersDb(db, now)).toBe(0);

    await db.insert(factionMembers).values({
      factionId, serverId, dayzId: "d-u9", discordId: U9, role: "member", joinedAt: now, status: "full",
    });

    expect(await convertPassesForFullMembersDb(db, now)).toBe(1);
    expect((await passRow(granted.passId!)).convertedAt?.getTime()).toBe(now.getTime());

    expect(await openGuestPassesDb(db, factionId, now)).toEqual([]);
    expect((await openPassesByVoiceChannel(db, now)).has("voice-1")).toBe(false);

    // Idempotent: no more rows to convert.
    expect(await convertPassesForFullMembersDb(db, now)).toBe(0);
  });
});
