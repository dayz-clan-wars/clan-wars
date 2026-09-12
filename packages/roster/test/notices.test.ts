import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, clanNotices, warLogEvents,
  type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import {
  appendClanNoticeTx, noticeClanTx, noticeUserTx, noticeFullMembersTx, appendWarLogTx,
  PgNoticeStore, PgWarLogStore, NOTICE_MAX_ATTEMPTS, countUnpostedNotices, countUnpostedWarLog,
} from "../src/internal/notices";
import { seedFaction } from "./seed";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-05T12:00:00Z");

describe("roster package notices", () => {
  let db: Database;
  let serverId = 0;
  let factionId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table faction_join_requests, identity_holds, faction_invites, roster_cooldowns, faction_members, declarations, poles, factions, ceremony_participants, ceremonies, claim_drafts, identity_links, players, events, raw_lines, adm_files, faction_events, clan_notices, war_log_events, servers restart identity cascade`);
    });

    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;

    const f = await seedFaction(db, {
      serverId, tag: "BEAR", name: "Bears", texture: "Flag_Bear",
      leaderDiscordId: "d1", createdAt: now, activatedAt: now,
    });
    factionId = f.id;
    await db.insert(factionMembers).values([
      { factionId, serverId, dayzId: "L".repeat(40), discordId: "d1", role: "leader", joinedAt: now, status: "full" },
      { factionId, serverId, dayzId: "T".repeat(40), discordId: "d2", role: "member", joinedAt: now, status: "full" },
      { factionId, serverId, dayzId: "O".repeat(40), discordId: "d3", role: "member", joinedAt: now, status: "pending", pendingSince: now },
    ]);
  });

  it("appendClanNoticeTx writes a row verbatim", async () => {
    await db.transaction((tx) => appendClanNoticeTx(tx, {
      serverId, factionId, target: "dm", discordTargetId: "d1", kind: "solo_lapsed", occurredAt: now, payload: {},
    }));
    const rows = await db.select().from(clanNotices);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target: "dm", discordTargetId: "d1", kind: "solo_lapsed" });
  });

  it("noticeClanTx queues a channel row with a null target until the clan has a channel, and readUnposted skips it", async () => {
    await db.transaction((tx) => noticeClanTx(tx, { serverId, factionId, kind: "joined", occurredAt: now, payload: { gamertag: "Otto" } }));
    const [row] = await db.select().from(clanNotices);
    expect(row).toMatchObject({ target: "channel", discordTargetId: null, kind: "joined" });
    expect(await new PgNoticeStore(db).readUnposted(10)).toEqual([]);
    await db.update(factions).set({ discordTextChannelId: "chan-1" }).where(eq(factions.id, factionId));
    const [q] = await new PgNoticeStore(db).readUnposted(10);
    expect(q).toMatchObject({ id: row!.id, discordTargetId: "chan-1" });
  });

  it("readUnposted does not let a null-target channel backlog starve the DMs behind it", async () => {
    // Three channel rows for a clan with no channel yet (the steady state until
    // increment 3b), then two DMs. limit 2 must return the two DMs, not nothing.
    for (const gamertag of ["A", "B", "C"]) {
      await db.transaction((tx) => noticeClanTx(tx, { serverId, factionId, kind: "joined", occurredAt: now, payload: { gamertag } }));
    }
    for (const discordId of ["d1", "d2"]) {
      await db.transaction((tx) => noticeUserTx(tx, { serverId, factionId, discordId, kind: "solo_lapsed", occurredAt: now, payload: {} }));
    }
    const q = await new PgNoticeStore(db).readUnposted(2);
    expect(q.map((r) => r.discordTargetId)).toEqual(["d1", "d2"]);
    expect(q.map((r) => r.id)).toEqual([...q.map((r) => r.id)].sort((a, b) => a - b));
  });

  it("readUnposted returns deliverable rows in id order and stops at the limit", async () => {
    for (const discordId of ["d1", "d2", "d3", "d4"]) {
      await db.transaction((tx) => noticeUserTx(tx, { serverId, factionId, discordId, kind: "solo_lapsed", occurredAt: now, payload: {} }));
    }
    const store = new PgNoticeStore(db);
    const first = await store.readUnposted(2);
    expect(first.map((r) => r.discordTargetId)).toEqual(["d1", "d2"]);
    for (const r of first) await store.markPosted(r.id, now);
    expect((await store.readUnposted(10)).map((r) => r.discordTargetId)).toEqual(["d3", "d4"]);
  });

  it("noticeFullMembersTx DMs every full member and no pending one", async () => {
    const n = await db.transaction((tx) => noticeFullMembersTx(tx, { serverId, factionId, kind: "flag_down", occurredAt: now, payload: { gamertag: "Raider" } }));
    expect(n).toBe(2);
    const rows = await db.select({ t: clanNotices.discordTargetId }).from(clanNotices).where(eq(clanNotices.target, "dm"));
    expect(rows.map((r) => r.t).sort()).toEqual(["d1", "d2"]);
  });

  it("a channel row with no clan behind it posts to its own target", async () => {
    // ⚠️ The achievements wall queues `factionId: null, target: "channel"` with the
    // public channel written in. The coalesce in readUnposted is what makes that row
    // deliverable: resolving a channel from the faction row alone would leave it
    // waiting forever, unposted and unfailed, with nothing saying so.
    await db.transaction((tx) => appendClanNoticeTx(tx, {
      serverId, factionId: null, target: "channel", discordTargetId: "wall-1", kind: "achievement", occurredAt: now,
      payload: { key: "sniper", name: "Sniper", ownerKind: "player", ownerName: "111111111111111111", clanTag: "BEAR", public: true },
    }));
    const [q] = await new PgNoticeStore(db).readUnposted(10);
    expect(q).toMatchObject({ factionId: null, target: "channel", discordTargetId: "wall-1", kind: "achievement" });
  });

  it("markAttempt fails a row on the third attempt and readUnposted stops returning it", async () => {
    await db.transaction((tx) => noticeUserTx(tx, { serverId, factionId: null, discordId: "d9", kind: "solo_lapsed", occurredAt: now, payload: {} }));
    const store = new PgNoticeStore(db);
    const [q] = await store.readUnposted(10);
    expect(await store.markAttempt(q!.id, now)).toBe(1);
    expect(await store.markAttempt(q!.id, now)).toBe(2);
    expect(await store.markAttempt(q!.id, now)).toBe(NOTICE_MAX_ATTEMPTS);
    const [row] = await db.select({ failedAt: clanNotices.failedAt }).from(clanNotices).where(eq(clanNotices.id, q!.id));
    expect(row!.failedAt).not.toBeNull();
    expect(await store.readUnposted(10)).toEqual([]);
  });

  it("markPosted stamps posted_at and readUnposted stops returning the row", async () => {
    await db.transaction((tx) => noticeUserTx(tx, { serverId, factionId: null, discordId: "d9", kind: "solo_lapsed", occurredAt: now, payload: {} }));
    const store = new PgNoticeStore(db);
    const [q] = await store.readUnposted(10);
    await store.markPosted(q!.id, now);
    expect(await store.readUnposted(10)).toEqual([]);
  });

  it("appendWarLogTx rejects a coordinate at the database", async () => {
    await expect(db.transaction((tx) => appendWarLogTx(tx, { serverId, kind: "raid", occurredAt: now, payload: { x: 1 } as never }))).rejects.toThrow(/no_coordinates/u);
  });

  it("appendWarLogTx writes a row and PgWarLogStore reads/marks it", async () => {
    await db.transaction((tx) => appendWarLogTx(tx, { serverId, kind: "raid", occurredAt: now, payload: { gamertag: "Raider" } }));
    const store = new PgWarLogStore(db);
    const [q] = await store.readUnposted(10);
    expect(q).toMatchObject({ kind: "raid", payload: { gamertag: "Raider" } });
    await store.markPosted(q!.id, now);
    expect(await store.readUnposted(10)).toEqual([]);
  });

  it("countUnpostedNotices and countUnpostedWarLog count queue rows", async () => {
    expect(await countUnpostedNotices(db)).toBe(0);
    expect(await countUnpostedWarLog(db)).toBe(0);
    await db.transaction((tx) => noticeUserTx(tx, { serverId, factionId: null, discordId: "d9", kind: "solo_lapsed", occurredAt: now, payload: {} }));
    await db.transaction((tx) => appendWarLogTx(tx, { serverId, kind: "raid", occurredAt: now, payload: {} }));
    expect(await countUnpostedNotices(db)).toBe(1);
    expect(await countUnpostedWarLog(db)).toBe(1);
  });

  it("clan_notices rejects a coordinate payload at the database", async () => {
    await expect(db.transaction((tx) => appendClanNoticeTx(tx, {
      serverId, factionId, target: "dm", discordTargetId: "d1", kind: "solo_lapsed", occurredAt: now, payload: { x: 1 } as never,
    }))).rejects.toThrow(/no_coordinates/u);
  });
});
