import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, admFiles, poles, events, factionMembers, identityLinks, clanNotices, type Database,
} from "@factions/db";
import { declareSolo, declarationForPlayer } from "@factions/declarations";
import { JOIN_PRESENCE_RADIUS_M, PENDING_EXPIRY_MS, RELEASED_POLE_GRACE_MS } from "@factions/domain";
import { sql, eq } from "drizzle-orm";
import { presenceTick, expirePendingMembers } from "../src/presence-tick.js";
import { seedFaction } from "./seed.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-04T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const P = "5000.00:100.00:5000.00";
const UID_B = "B".repeat(40);

describe("presenceTick / expirePendingMembers", () => {
  let db: Database;
  let serverId = 0;
  let admFileId = 0;
  let factionId = 0;
  let line = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table declarations, poles, faction_members, factions, events, raw_lines, adm_files, consumer_cursors, identity_links, clan_notices, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    admFileId = a!.id;
    line = 0;

    const f = await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", createdAt: ago(100_000), poleKey: P, x: 5000, y: 100, z: 5000 });
    factionId = f.id;

    await db.insert(factionMembers).values({
      factionId, serverId, dayzId: UID_B, discordId: "200", role: "member", joinedAt: now,
      status: "pending", pendingSince: now,
    });
    await db.insert(identityLinks).values({ discordId: "200", dayzId: UID_B, gamertag: "Bee", verifiedAt: now });
  });

  const position = (dayzId: string, x: number, z: number, at = now) => db.insert(events).values({
    serverId, admFileId, lineIndex: line++, type: "player.position", occurredAt: at,
    payload: { dayzId, gamertag: "G", pos: { x, y: 100, z } },
  }).returning({ id: events.id });

  it("promotes a pending member seen within JOIN_PRESENCE_RADIUS_M of the declaration, citing the event", async () => {
    await position(UID_B, 5000 + JOIN_PRESENCE_RADIUS_M - 1, 5000);
    const r = await presenceTick(db);
    expect(r.promoted).toHaveLength(1);
    const [m] = await db.select({ status: factionMembers.status, seen: factionMembers.seenAtBaseEventId }).from(factionMembers).where(eq(factionMembers.dayzId, UID_B));
    expect(m!.status).toBe("full");
    expect(m!.seen).toBe(r.promoted[0]!.eventId);
    expect((await presenceTick(db)).promoted).toEqual([]);   // idempotent: cursor advanced, row no longer pending
  });

  it("does not promote at radius + 1, nor a stranger, nor a fix near some OTHER clan's pole", async () => {
    await position(UID_B, 5000 + JOIN_PRESENCE_RADIUS_M + 1, 5000);
    await position("S".repeat(40), 5000, 5000);
    expect((await presenceTick(db)).promoted).toEqual([]);
    expect((await db.select({ status: factionMembers.status }).from(factionMembers).where(eq(factionMembers.dayzId, UID_B)))[0]!.status).toBe("pending");
  });

  it("⚠️ compares x with x and z with z — a fix at the pole's x and a far z is NOT at the base", async () => {
    await position(UID_B, 5000, 5000 + 1000);
    expect((await presenceTick(db)).promoted).toEqual([]);
  });

  it("a flag raise at the pole counts as presence (the payload carries the pole, not a pos)", async () => {
    await db.insert(events).values({ serverId, admFileId, lineIndex: line++, type: "flag.raised", occurredAt: now,
      payload: { dayzId: UID_B, gamertag: "G", texture: "Flag_White", poleKey: P, pole: { x: 5000, y: 100, z: 5000 } } });
    expect((await presenceTick(db)).promoted).toHaveLength(1);
  });

  it("promotion releases the joiner's solo base in the same transaction and stamps its grace", async () => {
    // UID_B declared a solo base elsewhere before accepting the invite (spec §5.3 ⚠️: kept until promotion).
    const Q = "7000.00:100.00:7000.00";
    await db.insert(poles).values({ serverId, map: "livonia", poleKey: Q, x: "7000.00", y: "100.00", z: "7000.00", currentTexture: "Flag_White", flagRaised: true, firstSeenAt: now, lastSeenAt: now, graceUntil: now });
    await db.insert(events).values({ serverId, admFileId, lineIndex: line++, type: "flag.raised", occurredAt: ago(5000), payload: { dayzId: UID_B, gamertag: "G", texture: "Flag_White", poleKey: Q, pole: { x: 7000, y: 100, z: 7000 } } });
    // declareSolo refuses a FULL member; UID_B is pending, so this must succeed (Task 3).
    expect(await declareSolo(db, { serverId, dayzId: UID_B, poleKey: Q, at: ago(4000) })).toMatchObject({ ok: true });
    await position(UID_B, 5000, 5000);
    const r = await presenceTick(db);
    expect(r.promoted[0]).toMatchObject({ dayzId: UID_B, releasedSoloBase: true });
    expect(await declarationForPlayer(db, serverId, UID_B)).toBeNull();
    const [q] = await db.select({ graceUntil: poles.graceUntil }).from(poles).where(eq(poles.poleKey, Q));
    expect(q!.graceUntil.getTime()).toBe(now.getTime() + RELEASED_POLE_GRACE_MS);   // `at` = the event's occurredAt = now
  });

  it("expires a pending member unseen for PENDING_EXPIRY_MS, and not one day short of it", async () => {
    expect(await expirePendingMembers(db, new Date(now.getTime() + PENDING_EXPIRY_MS - 1))).toEqual([]);
    expect(await expirePendingMembers(db, new Date(now.getTime() + PENDING_EXPIRY_MS))).toEqual([{ factionId, dayzId: UID_B, discordId: "200" }]);
    expect(await db.select().from(factionMembers).where(eq(factionMembers.dayzId, UID_B))).toEqual([]);
    // Full members are never expired, whatever their pending_since says.
  });

  it("promotion queues a 'became_full' channel notice naming the promoted member", async () => {
    await position(UID_B, 5000 + JOIN_PRESENCE_RADIUS_M - 1, 5000);
    expect((await presenceTick(db)).promoted).toHaveLength(1);
    const [n] = await db.select().from(clanNotices);
    expect(n).toMatchObject({ target: "channel", kind: "became_full", payload: { gamertag: "Bee" } });
  });

  it("a non-promotion (out of radius) queues no notice", async () => {
    await position(UID_B, 5000 + JOIN_PRESENCE_RADIUS_M + 1, 5000);
    expect((await presenceTick(db)).promoted).toEqual([]);
    expect(await db.select().from(clanNotices)).toEqual([]);
  });

  it("expiring a pending member queues a 'pending_expired' DM with the clan name", async () => {
    expect(await expirePendingMembers(db, new Date(now.getTime() + PENDING_EXPIRY_MS))).toEqual([{ factionId, dayzId: UID_B, discordId: "200" }]);
    const [n] = await db.select().from(clanNotices);
    expect(n).toMatchObject({ target: "dm", kind: "pending_expired", discordTargetId: "200", payload: { clan: "WOLF" } });
  });

  it("expiring nobody (short of PENDING_EXPIRY_MS) queues no notice", async () => {
    expect(await expirePendingMembers(db, new Date(now.getTime() + PENDING_EXPIRY_MS - 1))).toEqual([]);
    expect(await db.select().from(clanNotices)).toEqual([]);
  });
});
