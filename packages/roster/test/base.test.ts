import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, identityLinks, players, poles, events, admFiles, declarations, clanNotices,
  type Database,
} from "@factions/db";
import { RELEASED_POLE_GRACE_MS, SOLO_LAPSE_MS } from "@factions/domain";
import { declareTx, declarationForPlayer } from "@factions/declarations";
import { sql, eq } from "drizzle-orm";
import { baseForDb, declareSoloDb, releaseSoloDb } from "../src/base";
import { unlinkDb } from "../src/link";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-05T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const UID_A = "A".repeat(40);
const key = (x: number, z: number) => `${x.toFixed(2)}:100.00:${z.toFixed(2)}`;
const P1 = key(5000, 5000);
const P2 = key(6000, 6000);

describe("roster base writes", () => {
  let db: Database; let serverId = 0; let admFileId = 0; let line = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table declarations, poles, faction_members, factions, identity_links, players, events, raw_lines, adm_files, ceremonies, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    admFileId = a!.id; line = 0;
    await db.insert(players).values({ dayzId: UID_A, gamertag: "Ronald", firstSeenAt: now, lastSeenAt: now });
    await db.insert(identityLinks).values({ discordId: "d1", dayzId: UID_A, gamertag: "Ronald", verifiedAt: now });
  });

  const pole = (poleKey: string, x: number, z: number) => db.insert(poles).values({
    serverId, map: "livonia", poleKey, x: x.toFixed(2), y: "100.00", z: z.toFixed(2),
    currentTexture: "Flag_White", flagRaised: true, firstSeenAt: now, lastSeenAt: now, graceUntil: now,
  });
  const raise = async (dayzId: string, poleKey: string, x: number, z: number, at: Date) => {
    const [e] = await db.insert(events).values({
      serverId, admFileId, lineIndex: line++, type: "flag.raised", occurredAt: at,
      payload: { dayzId, gamertag: "G", texture: "Flag_White", poleKey, pole: { x, y: 100, z } },
    }).returning({ id: events.id });
    return e!.id;
  };

  it("an unlinked viewer sees nothing to do", async () => {
    expect(await baseForDb(db, "d-nobody")).toEqual({ linked: false });
  });

  it("lists the poles the player raised at, newest first, without y", async () => {
    await pole(P1, 5000, 5000); await pole(P2, 6000, 6000);
    await raise(UID_A, P1, 5000, 5000, ago(2000));
    await raise(UID_A, P2, 6000, 6000, ago(1000));
    await raise("STRANGER", key(7000, 7000), 7000, 7000, ago(500));
    const v = await baseForDb(db, "d1");
    expect(v).toMatchObject({ linked: true, gamertag: "Ronald", inClan: false, declaration: null });
    if (!v.linked) return;
    expect(v.candidates).toEqual([
      { poleKey: P2, x: 6000, z: 6000, raisedAt: ago(1000) },
      { poleKey: P1, x: 5000, z: 5000, raisedAt: ago(2000) },
    ]);
  });

  it("declares, then shows the declaration and drops it from the candidates", async () => {
    await pole(P1, 5000, 5000); await pole(P2, 6000, 6000);
    await raise(UID_A, P1, 5000, 5000, ago(2000));
    await raise(UID_A, P2, 6000, 6000, ago(1000));
    expect(await declareSoloDb(db, "d1", P1, now)).toEqual({ ok: true });
    const v = await baseForDb(db, "d1");
    if (!v.linked) throw new Error("linked");
    expect(v.declaration).toMatchObject({ poleKey: P1, x: 5000, z: 5000, declaredAt: now });
    expect(v.candidates.map((c) => c.poleKey)).toEqual([P2]);
  });

  it("refuses: not linked, no raise, in a clan", async () => {
    expect(await declareSoloDb(db, "d-nobody", P1, now)).toEqual({ ok: false, reason: "not-linked" });
    await pole(P1, 5000, 5000);
    expect(await declareSoloDb(db, "d1", P1, now)).toEqual({ ok: false, reason: "no-raise" });
    await raise(UID_A, P1, 5000, 5000, ago(1000));
    const [f] = await db.insert(factions).values({ serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", leaderDiscordId: "d1", createdAt: now }).returning();
    await db.insert(factionMembers).values({ factionId: f!.id, serverId, dayzId: UID_A, discordId: "d1", role: "leader", joinedAt: now });
    expect(await declareSoloDb(db, "d1", P1, now)).toEqual({ ok: false, reason: "in-clan" });
  });

  it("⚠️ a PENDING member reads as not-in-clan — /base is still their solo view until promotion", async () => {
    const [f] = await db.insert(factions).values({ serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", leaderDiscordId: "d1", createdAt: now }).returning();
    await db.insert(factionMembers).values({
      factionId: f!.id, serverId, dayzId: UID_A, discordId: "d1", role: "member", joinedAt: now,
      status: "pending", pendingSince: now,
    });
    const v = await baseForDb(db, "d1");
    expect(v).toMatchObject({ linked: true, inClan: false });
  });

  it("refuses too-close to another declared base — the 200 m rule runs inside the package", async () => {
    const near = key(5150, 5000);
    await pole(P1, 5000, 5000); await pole(near, 5150, 5000);
    const [f] = await db.insert(factions).values({ serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", leaderDiscordId: "d9", createdAt: now }).returning();
    const evidence = await raise("Z".repeat(40), near, 5150, 5000, ago(3000));
    await db.transaction((tx) => declareTx(tx, { serverId, poleKey: near, x: 5150, y: 100, z: 5000, owner: { factionId: f!.id }, evidence: { eventId: evidence }, at: ago(3000) }));
    await raise(UID_A, P1, 5000, 5000, ago(1000));
    expect(await declareSoloDb(db, "d1", P1, now)).toEqual({ ok: false, reason: "too-close" });
  });

  it("release deletes the declaration and stamps the pole's grace; nothing to release is false", async () => {
    await pole(P1, 5000, 5000);
    await raise(UID_A, P1, 5000, 5000, ago(1000));
    expect(await releaseSoloDb(db, "d1", now)).toEqual({ released: false });
    await declareSoloDb(db, "d1", P1, now);
    expect(await releaseSoloDb(db, "d1", now)).toEqual({ released: true });
    expect(await declarationForPlayer(db, serverId, UID_A)).toBeNull();
    const [p] = await db.select({ graceUntil: poles.graceUntil }).from(poles).where(eq(poles.poleKey, P1));
    expect(p!.graceUntil.getTime()).toBe(now.getTime() + RELEASED_POLE_GRACE_MS);
  });

  /**
   * Spec §13: a staged race for the new writer pair. `unlinkDb` and
   * `declareSoloDb` both start by taking the server's declaration lock, so a
   * third connection HOLDING that lock parks both; releasing it lets Postgres
   * pick an order. Either order must end with no link and no declaration —
   * declare-then-unlink releases it, unlink-then-declare refuses not-linked.
   * The invariant is asserted, as inbox 20 requires; the ordering is observed
   * via pg_stat_activity, never waited out.
   */
  it("unlink racing declareSolo never leaves a declaration without a link", async () => {
    await pole(P1, 5000, 5000);
    await raise(UID_A, P1, 5000, 5000, ago(1000));

    const holderDb = createClient(URL);
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let taken!: () => void;
    const isTaken = new Promise<void>((r) => { taken = r; });
    const holder = holderDb.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('declarations'), ${serverId})`);
      taken();
      await released;
    });
    try {
      await isTaken;
      const racers = Promise.all([unlinkDb(db, "d1", now), declareSoloDb(db, "d1", P1, now)]);
      for (let i = 0; i < 5000; i++) {
        const rows = await db.execute(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
        if (Number((rows as unknown as { n: number }[])[0]!.n) >= 2) break;
      }
      release();
      const [unlinked, declared] = await racers;
      expect(unlinked.ok).toBe(true);
      // Exactly one of the two orders happened; both are legal.
      if (declared.ok) expect(unlinked).toEqual({ ok: true, releasedBase: true });
      else expect(declared).toEqual({ ok: false, reason: "not-linked" });
    } finally {
      release();
      await holder.catch(() => {});
      await holderDb.$client.end();
    }
    expect(await db.select().from(declarations)).toEqual([]);
    expect(await db.select().from(identityLinks)).toEqual([]);
  });

  it("shows lapsed: a solo_lapsed notice from an hour ago with no declaration", async () => {
    const [f] = await db.insert(factions).values({ serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", leaderDiscordId: "d9", createdAt: now }).returning();
    const lapsedAt = ago(60 * 60 * 1000); // 1 hour ago
    await db.insert(clanNotices).values({
      serverId, factionId: f!.id, target: "dm", discordTargetId: "d1", kind: "solo_lapsed",
      occurredAt: lapsedAt, payload: {},
    });
    const v = await baseForDb(db, "d1");
    expect(v).toMatchObject({ linked: true, declaration: null });
    if (!v.linked) throw new Error("linked");
    expect(v.lapsed).toEqual({ at: lapsedAt });
  });

  it("lapsed is null when notice is older than RELEASED_POLE_GRACE_MS", async () => {
    const [f] = await db.insert(factions).values({ serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", leaderDiscordId: "d9", createdAt: now }).returning();
    const tooOld = ago(RELEASED_POLE_GRACE_MS + 1000); // Older than grace period
    await db.insert(clanNotices).values({
      serverId, factionId: f!.id, target: "dm", discordTargetId: "d1", kind: "solo_lapsed",
      occurredAt: tooOld, payload: {},
    });
    const v = await baseForDb(db, "d1");
    expect(v).toMatchObject({ linked: true, declaration: null });
    if (!v.linked) throw new Error("linked");
    expect(v.lapsed).toEqual(null);
  });

  it("lapsed is null when there is a live declaration", async () => {
    await pole(P1, 5000, 5000);
    await raise(UID_A, P1, 5000, 5000, ago(1000));
    await declareSoloDb(db, "d1", P1, now);
    const [f] = await db.insert(factions).values({ serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", leaderDiscordId: "d9", createdAt: now }).returning();
    const lapsedAt = ago(60 * 60 * 1000); // 1 hour ago
    await db.insert(clanNotices).values({
      serverId, factionId: f!.id, target: "dm", discordTargetId: "d1", kind: "solo_lapsed",
      occurredAt: lapsedAt, payload: {},
    });
    const v = await baseForDb(db, "d1");
    if (!v.linked) throw new Error("linked");
    expect(v.declaration).not.toBeNull();
    expect(v.lapsed).toEqual(null);
  });
});
