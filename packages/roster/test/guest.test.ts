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
  removeFromGuildDb,
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

  // ------------------------------------------------- staged race (§13)

  /**
   * `grantGuestPassDb` and `removeFromGuildDb` both open by taking the
   * clan's `factions` row (the removal only when the user has a roster row
   * there, so the target below is a PENDING member — pending has no roster
   * standing, so the grant still sees a non-member and goes through). A
   * third connection HOLDING that row parks both; releasing it lets Postgres
   * pick the order, read out of `pg_stat_activity` rather than waited out.
   *
   * ⚠️ What is asserted, and what is deliberately NOT. A guest pass is FOR an
   * outsider: `U9` in every test above holds one with no identity link at
   * all, so "an open pass belongs to a linked user" is not an invariant of
   * this system and cannot be asserted here. What IS invariant is that the
   * removal never MISSES a pass that existed when it ran: the pass granted
   * before the race is revoked in both orders. The raced pass is then in
   * exactly one of two consistent states — revoked, because the grant landed
   * first and the removal swept it; or open, because the removal had already
   * committed and the officer granted a pass to somebody who by then was
   * simply an outsider. Never half-written, and never a deadlock.
   */
  for (const grantFirst of [true, false]) {
  it(`a grant racing the target's guild removal ends in one of two consistent states (${grantFirst ? "grant" : "removal"} started first)`, async () => {
    const uid9 = "9".repeat(40);
    await db.insert(players).values({ dayzId: uid9, gamertag: "Nine", firstSeenAt: now, lastSeenAt: now });
    await db.insert(identityLinks).values({ discordId: U9, dayzId: uid9, gamertag: "Nine", verifiedAt: now });
    await db.insert(factionMembers).values({
      factionId, serverId, dayzId: uid9, discordId: U9, role: "member", joinedAt: now, status: "pending", pendingSince: now,
    });

    // A pass that already exists when the removal runs. It must be revoked
    // whichever way the race falls.
    const earlier = await grantGuestPassDb(db, { factionId, actorDiscordId: D.L, userDiscordId: U9, at: now });
    expect(earlier.outcome).toBe("ok");
    await revokeGuestPassDb(db, { factionId, actorDiscordId: D.L, passId: earlier.passId!, at: now });
    const standing = await grantGuestPassDb(db, { factionId, actorDiscordId: D.L, userDiscordId: U9, at: now });
    expect(standing.outcome).toBe("ok");

    const at = new Date(now.getTime() + 60_000);

    const holderDb = createClient(URL);
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let taken!: () => void;
    const isTaken = new Promise<void>((r) => { taken = r; });
    const holder = holderDb.transaction(async (tx) => {
      await tx.execute(sql`select id from factions where id = ${factionId}::bigint for update`);
      taken();
      await released;
    });

    const dbA = createClient(URL);
    const dbB = createClient(URL);
    let granted!: { outcome: string; passId: number | null };
    let removed!: { linked: boolean; roster: string };
    try {
      await isTaken;
      // ⚠️ Staged, not just launched: the second side starts only once the
      // first is CONFIRMED waiting on the `factions` row, so the FIFO queue
      // gives this test the order it names. `removeFromGuildDb` opens with
      // two reads of its own and would otherwise always queue second.
      const granting = () => grantGuestPassDb(dbA, { factionId, actorDiscordId: D.O1, userDiscordId: U9, at });
      const removing = () => removeFromGuildDb(dbB, { discordId: U9, at });
      const waitFor = async (n: number) => {
        for (let i = 0; i < 20_000; i++) {
          const rows = await db.execute(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
          if (Number((rows as unknown as { n: number }[])[0]!.n) >= n) return;
        }
        throw new Error(`only saw fewer than ${n} waiters on the factions row`);
      };

      let grantP: ReturnType<typeof granting>;
      let removeP: ReturnType<typeof removing>;
      if (grantFirst) {
        grantP = granting();
        await waitFor(1);
        removeP = removing();
      } else {
        removeP = removing();
        await waitFor(1);
        grantP = granting();
      }
      await waitFor(2);
      const racers = Promise.all([grantP, removeP]);
      release();
      [granted, removed] = await racers;
    } finally {
      release();
      await holder.catch(() => {});
      await holderDb.$client.end();
      await dbA.$client.end();
      await dbB.$client.end();
    }

    // Neither order errored, and the removal did its whole job.
    expect(removed.linked).toBe(true);
    expect(await db.select().from(identityLinks).where(eq(identityLinks.discordId, U9))).toEqual([]);
    expect(await db.select().from(factionMembers).where(eq(factionMembers.discordId, U9))).toEqual([]);

    // The pass that existed when the removal ran is revoked, either way.
    expect((await passRow(standing.passId!)).revokedAt?.getTime()).toBe(at.getTime());

    // Grant-first is `already-active` (the standing pass was still open);
    // removal-first is `ok`, because the sweep closed that pass first.
    expect(["ok", "already-active"]).toContain(granted.outcome);
    if (granted.outcome === "already-active") {
      expect(granted.passId).toBeNull();
      expect(await openGuestPassesDb(db, factionId, at)).toEqual([]);
    } else {
      // The only open pass is the one granted AFTER the removal committed.
      const open = await openGuestPassesDb(db, factionId, at);
      expect(open.map((o) => o.id)).toEqual([granted.passId]);
    }
  });
  }

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
