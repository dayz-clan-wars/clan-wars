import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, declarations, events, admFiles, identityLinks,
  defenses, seasonStandings, warLogEvents, clanNotices, factionEvents,
  type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { raiseTick } from "../src/raise-tick.js";
import { seedFaction, seedSeason } from "./seed.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-04T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const SITE = "https://example.test";

describe("raiseTick", () => {
  let db: Database;
  let serverId = 0;
  let admFileId = 0;
  let lineIndex = 0;
  let BEAR = 0;
  let cursorAfterSetup = 0;
  const B1 = "B1-DAYZID-0000000000000000000000000";
  const W1 = "W1-DAYZID-0000000000000000000000000";
  const S1 = "S1-DAYZID-0000000000000000000000000";
  const P1 = "1000.00:100.00:1000.00";
  const P3 = "3000.00:100.00:3000.00";
  const P4 = "4000.00:100.00:4000.00";

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table clan_notices, war_log_events, defenses, season_standings, raids, seasons, faction_events, faction_members, declarations, poles, identity_links, consumer_cursors, events, adm_files, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    admFileId = a!.id;
    lineIndex = 0;

    await seedSeason(db, serverId, now);

    const bear = await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", poleKey: P1, createdAt: now, activatedAt: now });
    BEAR = bear.id;

    await db.insert(factionMembers).values([
      { factionId: BEAR, serverId, dayzId: B1, discordId: "dB1", role: "leader", joinedAt: now, status: "full" },
    ]);

    // seedFaction wrote its own synthetic flag.raised (evidence for BEAR's
    // declaration, dayzId "SEED"). raiseTick, unlike raidTick, DOES act on
    // flag.raised — that seed event is a non-member raising at BEAR's own
    // pole and would otherwise queue a spurious non_member_raise notice
    // before any test's own events are considered. Advance the cursor past
    // it so each test starts clean, the same way a real deployment's cursor
    // already sits past every event that predates it going live.
    const rows = (await db.execute(sql`select coalesce(max(id), 0)::int as n from events`)) as unknown as { n: number }[];
    const n = rows[0]!.n;
    cursorAfterSetup = n;
    await db.execute(sql`insert into consumer_cursors (consumer_name, last_event_id, updated_at) values ('raise-consumer', ${n}, now())`);
  });

  const raise = (dayzId: string, gamertag: string, texture: string, poleKey: string, at: Date) =>
    db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, type: "flag.raised", occurredAt: at,
      payload: { dayzId, gamertag, texture, poleKey, pole: { x: 1, y: 2, z: 3 } },
    });

  const declareSolo = async (poleKey: string, dayzId: string) => {
    const [ev] = await db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, type: "flag.raised", occurredAt: now,
      payload: { dayzId, gamertag: "Solo", texture: "Flag_White", poleKey, pole: { x: 1, y: 2, z: 3 } },
    }).returning();
    await db.insert(declarations).values({
      serverId, poleKey, x: "1.00", y: "2.00", z: "3.00", ownerDayzId: dayzId, evidenceEventId: ev!.id, declaredAt: now,
    });
  };

  it("a full member's raise at the declaration while the flag is down is a defense: row, standings, clock cleared, war-log, notice", async () => {
    await db.update(factions).set({ flagDownSince: ago(3 * 3_600_000 + 15 * 60_000), flagDownByDayzId: W1 }).where(eq(factions.id, BEAR));
    await raise(B1, "Bear1", "Flag_Bear", P1, now);
    expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ defenses: 1 });
    const [d] = await db.select().from(defenses);
    expect(d).toMatchObject({ factionId: BEAR, raisedByDayzId: B1, siegeSeconds: 3 * 3600 + 15 * 60 });
    const [bear] = await db.select({ f: factions.flagDownSince }).from(factions).where(eq(factions.id, BEAR));
    expect(bear!.f).toBeNull();
    expect((await db.select().from(warLogEvents))[0]).toMatchObject({ kind: "defense", payload: { victimClan: "BEAR", durationSeconds: 3 * 3600 + 15 * 60 } });
    expect((await db.select().from(clanNotices))[0]).toMatchObject({ kind: "defended", payload: { gamertag: "Bear1", durationSeconds: 3 * 3600 + 15 * 60 } });
  });

  it("a pending member's raise during flag-down is not a defense, and a non-member's raise is a non_member_raise notice", async () => {
    await db.update(factions).set({ flagDownSince: ago(3_600_000), flagDownByDayzId: W1 }).where(eq(factions.id, BEAR));
    const PEND = "PEND-DAYZID-000000000000000000000000";
    await db.insert(factionMembers).values({ factionId: BEAR, serverId, dayzId: PEND, discordId: "dPend", role: "member", joinedAt: now, status: "pending", pendingSince: now });
    await raise(PEND, "Pendy", "Flag_Bear", P1, now);
    await raise(W1, "Wolfie", "Flag_Bear", P1, new Date(now.getTime() + 1000));
    const r = await raiseTick(db, { siteBaseUrl: SITE });
    expect(r.defenses).toBe(0);
    expect(await db.select().from(defenses)).toEqual([]);
    const [bear] = await db.select({ f: factions.flagDownSince }).from(factions).where(eq(factions.id, BEAR));
    expect(bear!.f).not.toBeNull(); // never cleared
    const notices = await db.select({ kind: clanNotices.kind, payload: clanNotices.payload }).from(clanNotices).orderBy(clanNotices.id);
    expect(notices).toEqual([
      { kind: "non_member_raise", payload: { gamertag: "Pendy" } },
      { kind: "non_member_raise", payload: { gamertag: "Wolfie" } },
    ]);
  });

  it("a full member's raise at a DORMANT clan's declaration revives it with the raiser named", async () => {
    await db.update(factions).set({ status: "dormant", dormantSince: ago(86_400_000), dormantReason: "inactive", disbandWarnedAt: ago(1000) }).where(eq(factions.id, BEAR));
    await raise(B1, "Bear1", "Flag_Bear", P1, now);
    expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ revived: 1 });
    const [bear] = await db.select({ s: factions.status, r: factions.dormantReason, w: factions.disbandWarnedAt, d: factions.dormantSince }).from(factions).where(eq(factions.id, BEAR));
    expect(bear).toEqual({ s: "active", r: null, w: null, d: null });
    const events_ = await db.select().from(factionEvents).orderBy(factionEvents.id);
    expect(events_.at(-1)).toMatchObject({ kind: "revived", payload: { actor: "Bear1" } });
    expect((await db.select().from(clanNotices))[0]).toMatchObject({ kind: "revived", payload: { gamertag: "Bear1" } });
  });

  it("the clan's texture raised at a pole that is not its declaration: a full member → rebind_proposed with the settings link; a non-member → colors_elsewhere", async () => {
    await raise(B1, "Bear1", "Flag_Bear", P3, now);
    await raise(S1, "Solo", "Flag_Bear", P3, now);
    await raiseTick(db, { siteBaseUrl: SITE });
    const kinds = (await db.select({ k: clanNotices.kind, p: clanNotices.payload }).from(clanNotices).orderBy(clanNotices.id));
    expect(kinds[0]).toMatchObject({ k: "rebind_proposed", p: { gamertag: "Bear1", link: `${SITE}/clan/settings` } });
    expect(kinds[1]).toMatchObject({ k: "colors_elsewhere", p: { gamertag: "Solo" } });
  });

  it("a non-member's raise at a SOLO declaration DMs the declarant (solo_non_member_raise)", async () => {
    await declareSolo(P4, S1);
    await db.insert(identityLinks).values({ discordId: "dS1", dayzId: S1, gamertag: "Solo", verifiedAt: now });
    await raise(W1, "Wolfie", "Flag_White", P4, now);
    const r = await raiseTick(db, { siteBaseUrl: SITE });
    expect(r.noticed).toBe(1);
    const [n] = await db.select({ kind: clanNotices.kind, target: clanNotices.target, to: clanNotices.discordTargetId, payload: clanNotices.payload }).from(clanNotices);
    expect(n).toMatchObject({ kind: "solo_non_member_raise", target: "dm", to: "dS1", payload: { gamertag: "Wolfie" } });
  });

  it("is idempotent: rerunning from cursor 0 writes no second defense (defenses_event_uniq) and no second notice", async () => {
    await db.update(factions).set({ flagDownSince: ago(3_600_000), flagDownByDayzId: W1 }).where(eq(factions.id, BEAR));
    await raise(B1, "Bear1", "Flag_Bear", P1, now);
    await raiseTick(db, { siteBaseUrl: SITE });
    expect(await db.select().from(defenses)).toHaveLength(1);
    expect(await db.select().from(clanNotices)).toHaveLength(1);
    // "Cursor 0" relative to this test's own events — i.e. replaying from
    // right after setup, not literal 0, which would also re-deliver
    // seedFaction's own synthetic flag.raised and add a genuine (not
    // duplicate) non_member_raise notice for it.
    await db.execute(sql`update consumer_cursors set last_event_id = ${cursorAfterSetup} where consumer_name = 'raise-consumer'`);
    await raiseTick(db, { siteBaseUrl: SITE });
    expect(await db.select().from(defenses)).toHaveLength(1);
    expect(await db.select().from(clanNotices)).toHaveLength(1);
  });
});
