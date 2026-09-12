import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events, kills, players, factions, membershipHistory, type Database } from "@factions/db";
import { eq, sql } from "drizzle-orm";
import { writeCursor } from "@factions/event-log";
import { PgHitFeedStore } from "../src/hit-feed-tick.js";
import { KILLS_CONSUMER } from "../src/kills-tick.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(40); const B = "B".repeat(40); const R = "R".repeat(40);
const C = "C".repeat(40); const D = "D".repeat(40);
const t0 = new Date("2026-09-12T00:00:00Z");
const s = (n: number) => new Date(t0.getTime() + n * 1000);

describe("PgHitFeedStore", () => {
  let db: Database;
  let serverId: number;
  let store: PgHitFeedStore;
  let line = 0;

  async function mkHit(a: { at: Date; attacker: string | null; victim: string; weapon?: string | null; damage?: number; hp?: number }) {
    const [file] = await db.select({ id: admFiles.id }).from(admFiles).where(sql`filename = 'f.ADM'`);
    const [ev] = await db.insert(events).values({
      serverId, admFileId: file!.id, lineIndex: line++, type: "player.hit" as never, occurredAt: a.at,
      payload: {
        victimDayzId: a.victim, victimGamertag: "v", victimHp: a.hp ?? 60,
        attackerType: a.attacker ? "player" : "infected",
        attackerDayzId: a.attacker, attackerGamertag: a.attacker ? "k" : null,
        attackerLabel: a.attacker ? null : "Infected",
        damage: a.damage ?? 38, bodyPart: "Torso",
        weapon: a.weapon === undefined ? "KA-74" : a.weapon, distanceM: 41,
      },
    }).returning({ id: events.id });
    return ev!.id;
  }

  /** A marker event that moves the ingest frontier forward without being a hit. */
  async function mkFrontier(at: Date) {
    const [file] = await db.select({ id: admFiles.id }).from(admFiles).where(sql`filename = 'f.ADM'`);
    const [ev] = await db.insert(events).values({
      serverId, admFileId: file!.id, lineIndex: line++, type: "player.connected" as never, occurredAt: at, payload: {},
    }).returning({ id: events.id });
    // The kills projector has seen everything up to here.
    await writeCursor(db, KILLS_CONSUMER, ev!.id);
    return ev!.id;
  }

  async function mkKill(a: { at: Date; killer: string; victim: string }) {
    const [file] = await db.select({ id: admFiles.id }).from(admFiles).where(sql`filename = 'f.ADM'`);
    const [ev] = await db.insert(events).values({
      serverId, admFileId: file!.id, lineIndex: line++, type: "player.killed" as never, occurredAt: a.at, payload: {},
    }).returning({ id: events.id });
    await db.insert(kills).values({
      serverId, eventId: ev!.id, occurredAt: a.at, victimDayzId: a.victim, killerDayzId: a.killer,
      weapon: "KA-74", distanceM: "41.0", cause: "pvp", friendlyFire: false,
    });
    return ev!.id;
  }

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table kills, seasons, players, membership_history, declarations, poles, factions, events, raw_lines, adm_files, consumer_cursors, servers restart identity cascade`);
    line = 0;
    const [srv] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = srv!.id;
    await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: t0, linesIngested: 0, complete: true });
    await db.insert(players).values([
      { dayzId: A, gamertag: "Alpha", firstSeenAt: t0, lastSeenAt: t0 },
      { dayzId: B, gamertag: "Bravo", firstSeenAt: t0, lastSeenAt: t0 },
      { dayzId: R, gamertag: "Romeo", firstSeenAt: t0, lastSeenAt: t0 },
      { dayzId: C, gamertag: "Charlie", firstSeenAt: t0, lastSeenAt: t0 },
      { dayzId: D, gamertag: "Delta", firstSeenAt: t0, lastSeenAt: t0 },
    ]);
    store = new PgHitFeedStore(db);
  });

  it("returns one item per closed engagement, with names resolved and damage totalled", async () => {
    await mkHit({ at: s(0), attacker: A, victim: B, damage: 38 });
    await mkHit({ at: s(4), attacker: A, victim: B, damage: 38, hp: 12 });
    await mkFrontier(s(400));
    const items = await store.readAfter(0, 20);
    expect(items).toHaveLength(1);
    expect(items[0]!.attacker.gamertag).toBe("Alpha");
    expect(items[0]!.victim.gamertag).toBe("Bravo");
    expect(items[0]!.hits).toHaveLength(2);
    expect(items[0]!.totalDamage).toBe(76);
    expect(items[0]!.victimHpAfter).toBe(12);
    expect(items[0]!.suppressed).toBe(false);
  });

  it("⚠️ an engagement still open is not returned at all — the cursor must not step over it", async () => {
    await mkHit({ at: s(0), attacker: A, victim: B });
    await mkFrontier(s(30));
    expect(await store.readAfter(0, 20)).toEqual([]);
  });

  it("⚠️ an engagement a kill claimed comes back SUPPRESSED, not absent — it still advances the cursor", async () => {
    await mkHit({ at: s(0), attacker: A, victim: B });
    await mkHit({ at: s(4), attacker: A, victim: B });
    await mkKill({ at: s(6), killer: A, victim: B });
    await mkFrontier(s(400));
    const items = await store.readAfter(0, 20);
    expect(items).toHaveLength(1);
    expect(items[0]!.suppressed).toBe(true);
  });

  it("⚠️ suppression ignores the weapon, so a weapon switch before the kill does not orphan the first half", async () => {
    await mkHit({ at: s(0), attacker: A, victim: B, weapon: "KA-74" });
    await mkHit({ at: s(4), attacker: A, victim: B, weapon: "Mosin" });
    await mkKill({ at: s(6), killer: A, victim: B });
    await mkFrontier(s(400));
    const items = await store.readAfter(0, 20);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.suppressed)).toEqual([true, true]);
  });

  it("a kill by someone else does not suppress this attacker's engagement", async () => {
    await mkHit({ at: s(0), attacker: A, victim: B });
    await mkKill({ at: s(6), killer: R, victim: B });
    await mkFrontier(s(400));
    const items = await store.readAfter(0, 20);
    expect(items[0]!.suppressed).toBe(false);
  });

  it("a kill more than the attribution window after the last hit does not suppress it", async () => {
    await mkHit({ at: s(0), attacker: A, victim: B });
    await mkKill({ at: s(200), killer: A, victim: B });
    await mkFrontier(s(900));
    const items = await store.readAfter(0, 20);
    expect(items[0]!.suppressed).toBe(false);
  });

  it("⚠️ a wedged kills projector holds everything back rather than leaking fatal fights into the feed", async () => {
    await mkHit({ at: s(0), attacker: A, victim: B });
    // Ingest has run far ahead, but the kills cursor is still at 0.
    const [file] = await db.select({ id: admFiles.id }).from(admFiles).where(sql`filename = 'f.ADM'`);
    await db.insert(events).values({ serverId, admFileId: file!.id, lineIndex: line++, type: "player.connected" as never, occurredAt: s(900), payload: {} });
    expect(await store.readAfter(0, 20)).toEqual([]);
  });

  it("PvE and self-inflicted hits never reach the feed", async () => {
    await mkHit({ at: s(0), attacker: null, victim: B });
    await mkHit({ at: s(1), attacker: B, victim: B });
    await mkFrontier(s(400));
    expect(await store.readAfter(0, 20)).toEqual([]);
  });

  it("head is the newest hit event id, and seeded is false until the cursor is written", async () => {
    const id = await mkHit({ at: s(0), attacker: A, victim: B });
    expect(await store.head()).toBe(id);
    expect(await store.seeded()).toBe(false);
    await store.markPosted(id);
    expect(await store.seeded()).toBe(true);
    expect(await store.cursor()).toBe(id);
  });

  it("reads only after the cursor", async () => {
    await mkHit({ at: s(0), attacker: A, victim: B });
    const second = await mkHit({ at: s(300), attacker: A, victim: B });
    await mkFrontier(s(900));
    const items = await store.readAfter(second - 1, 20);
    expect(items).toHaveLength(1);
    expect(items[0]!.eventId).toBe(second);
  });

  it("⚠️ two interleaved fights close with strictly ascending event ids — never a descending pair for the loop to hand the cursor backward on", async () => {
    // C/D's engagement starts first (lowest id) but closes with a LOWER last
    // event id than A/B's engagement, which starts second but closes later.
    // Ordering by first-event id (the dropped fix) would emit [C/D, A/B] —
    // descending last-event ids (4 then 3).
    await mkHit({ at: s(0), attacker: C, victim: D }); // id 1
    await mkHit({ at: s(1), attacker: A, victim: B }); // id 2
    await mkHit({ at: s(3), attacker: A, victim: B }); // id 3 — closes A/B's run
    await mkHit({ at: s(4), attacker: C, victim: D }); // id 4 — closes C/D's run
    await mkFrontier(s(400));
    const items = await store.readAfter(0, 20);
    expect(items).toHaveLength(2);
    const ids = items.map((i) => i.eventId);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids[0]!).toBeLessThan(ids[1]!);
  });

  it("⚠️ a fight that finishes early posts while an unrelated fight that started later is still ongoing — and the ongoing one survives complete once it finally closes", async () => {
    // The short fight (C/D) is fully quiet BEFORE the long fight (A/B) even
    // begins, so posting it never requires the cursor to step over any of the
    // long fight's hits.
    const shortHit = await mkHit({ at: s(0), attacker: C, victim: D });
    await mkHit({ at: s(500), attacker: A, victim: B });
    await mkHit({ at: s(540), attacker: A, victim: B });
    // 60s past the long fight's last hit: quiet under the burst window, but
    // still within the settle floor (max(windowS, RECENT_HIT_WINDOW_S)=120s)
    // — the long fight must stay open.
    await mkFrontier(s(600));

    const tick1 = await store.readAfter(0, 20);
    expect(tick1).toHaveLength(1);
    expect(tick1[0]!.eventId).toBe(shortHit);
    await store.markPosted(tick1[0]!.eventId);

    const longHit3 = await mkHit({ at: s(560), attacker: A, victim: B });
    await mkFrontier(s(900));

    const tick2 = await store.readAfter(await store.cursor(), 20);
    expect(tick2).toHaveLength(1);
    expect(tick2[0]!.hits).toHaveLength(3);
    expect(tick2[0]!.startedAt).toEqual(s(500));
    expect(tick2[0]!.eventId).toBe(longHit3);
  });

  it("⚠️ the same attacker/victim pair fighting on two servers stays two engagements, each checked against its own server's kills", async () => {
    const [srv2] = await db.insert(servers).values({ name: "S2", map: "chernarusplus", clockOffsetMs: 0 }).returning();
    const serverId2 = srv2!.id;
    const [file2] = await db.insert(admFiles).values({ serverId: serverId2, filename: "g.ADM", bootAt: t0, linesIngested: 0, complete: true }).returning();

    // Server 1: A hits B, and a kill on server 1 claims it.
    await mkHit({ at: s(0), attacker: A, victim: B });
    await mkKill({ at: s(6), killer: A, victim: B });

    // Server 2: the SAME dayz ids fight — a global identity is not scoped to one server.
    await db.insert(events).values({
      serverId: serverId2, admFileId: file2!.id, lineIndex: 0, type: "player.hit" as never, occurredAt: s(0),
      payload: {
        victimDayzId: B, victimGamertag: "v", victimHp: 60,
        attackerType: "player", attackerDayzId: A, attackerGamertag: "k", attackerLabel: null,
        damage: 38, bodyPart: "Torso", weapon: "KA-74", distanceM: 41,
      },
    });

    await mkFrontier(s(400));
    const items = await store.readAfter(0, 20);
    expect(items).toHaveLength(2);
    // Not merged into one two-hit engagement.
    expect(items.every((i) => i.hits.length === 1)).toBe(true);
    // Server 1's is claimed by its own kill; server 2's has no kill at all.
    expect(items.filter((i) => i.suppressed)).toHaveLength(1);
  });

  it("⚠️ a hand-deleted cursor-event row does not stop the feed forever", async () => {
    await mkHit({ at: s(0), attacker: A, victim: B });
    await mkHit({ at: s(4), attacker: A, victim: B });
    const markerId = await mkFrontier(s(50));
    // This repo's documented fix for a misparsed line: delete the event row.
    // The kills cursor's numeric value is untouched — it still names this id.
    await db.delete(events).where(eq(events.id, markerId));

    // Ingest continues past it. The frontier must come from THIS event, never
    // from the deleted row's own occurred_at (which no longer exists to read).
    const [file] = await db.select({ id: admFiles.id }).from(admFiles).where(sql`filename = 'f.ADM'`);
    await db.insert(events).values({ serverId, admFileId: file!.id, lineIndex: line++, type: "player.connected" as never, occurredAt: s(500), payload: {} });

    const items = await store.readAfter(0, 20);
    expect(items).toHaveLength(1);
    expect(items[0]!.suppressed).toBe(false);
  });

  it("⚠️ id order, not occurred_at order, decides whether the kills projector has reached an event — guards a reparse's backfilled timestamps", async () => {
    await mkHit({ at: s(0), attacker: A, victim: B });
    await mkFrontier(s(50)); // kills projector reaches here; its cursor row's own occurred_at is s(50)

    // A reparse backfills a hit at the HEAD of the log (a high id) with an OLD
    // occurred_at, correcting a misparsed line from early in the file. Under
    // the old "cursor row's own occurred_at" frontier, s(-500) is long before
    // s(50), so this would be judged quiet and closed immediately — even
    // though the kills projector's cursor has not actually reached its id, so
    // no suppressing kill row can exist yet.
    const backfilledId = await mkHit({ at: s(-500), attacker: A, victim: R });
    expect(await store.readAfter(0, 20)).toEqual([]);

    // Once the kills projector's cursor actually passes the backfilled
    // event's id, it is handled like any other hit.
    await mkFrontier(s(400));
    const items = await store.readAfter(0, 20);
    expect(items.map((i) => i.eventId)).toContain(backfilledId);
  });

  it("resolves the clan each side was in at the fight, and flags friendly fire when both sides match", async () => {
    const [f] = await db.insert(factions).values({
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active",
      leaderDiscordId: "d1", createdAt: t0,
    }).returning();
    await db.insert(membershipHistory).values([
      { serverId, factionId: f!.id, dayzId: A, joinedAt: t0, leftAt: null },
      { serverId, factionId: f!.id, dayzId: B, joinedAt: t0, leftAt: null },
    ]);
    await mkHit({ at: s(0), attacker: A, victim: B });
    await mkFrontier(s(400));
    const items = await store.readAfter(0, 20);
    expect(items).toHaveLength(1);
    expect(items[0]!.attacker.tag).toBe("BEAR");
    expect(items[0]!.victim.tag).toBe("BEAR");
    expect(items[0]!.friendlyFire).toBe(true);
  });
});
