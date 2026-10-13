import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, declarations, events, admFiles, identityLinks,
  defenses, seasonStandings, warLogEvents, clanNotices, factionEvents, flagHolds, factionTextures,
  type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { FLAG_CHANGE_WINDOW_MS, FLAG_DOWN_MS, OLD_FLAG_HOLD_MS } from "@factions/domain";
import { declarationForFaction } from "@factions/declarations";
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
  const P9 = "9000.00:100.00:9000.00";
  const WOLF_POLE = "5000.00:100.00:5000.00";
  const WOLF_NEAR = "5100.00:100.00:5000.00";

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table flag_holds, faction_textures, clan_notices, war_log_events, defenses, season_standings, raids, seasons, faction_events, faction_members, declarations, poles, identity_links, consumer_cursors, events, adm_files, factions, servers restart identity cascade`);
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

  // ⚠️ Derived from the poleKey, not a fixed (1, 2, 3): declareTx requires
  // the poleKey and its coordinates to describe the same point (§4.1's
  // own-pole exclusion and the 200 m spacing check both key off x/z), so any
  // test exercising a bind or a too-close refusal needs real coordinates.
  const poleXYZ = (poleKey: string) => {
    const [x, y, z] = poleKey.split(":").map(Number);
    return { x, y, z };
  };

  const raise = (dayzId: string, gamertag: string, texture: string, poleKey: string, at: Date) =>
    db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, type: "flag.raised", occurredAt: at,
      payload: { dayzId, gamertag, texture, poleKey, pole: poleXYZ(poleKey) },
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

  it("⚠️ a raise exactly FLAG_DOWN_MS after the lower is NOT a defense and leaves the clock for the dormancy tick", async () => {
    await db.update(factions).set({ flagDownSince: ago(FLAG_DOWN_MS), flagDownByDayzId: W1 }).where(eq(factions.id, BEAR));
    await raise(B1, "Bear1", "Flag_Bear", P1, now);
    const r = await raiseTick(db, { siteBaseUrl: SITE });
    expect(r.defenses).toBe(0);
    expect(await db.select().from(defenses)).toEqual([]);
    expect(await db.select().from(warLogEvents)).toEqual([]);
    expect(await db.select().from(clanNotices)).toEqual([]);
    const [bear] = await db.select({ f: factions.flagDownSince, b: factions.flagDownByDayzId }).from(factions).where(eq(factions.id, BEAR));
    // Untouched: dormancy-tick converts the clan to dormant(raided) and this
    // same raise revives it through the dormant branch on a later tick (§5.8).
    expect(bear).toEqual({ f: ago(FLAG_DOWN_MS), b: W1 });
  });

  it("one millisecond inside FLAG_DOWN_MS is still a defense", async () => {
    await db.update(factions).set({ flagDownSince: ago(FLAG_DOWN_MS - 1), flagDownByDayzId: W1 }).where(eq(factions.id, BEAR));
    await raise(B1, "Bear1", "Flag_Bear", P1, now);
    expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ defenses: 1 });
    const [bear] = await db.select({ f: factions.flagDownSince }).from(factions).where(eq(factions.id, BEAR));
    expect(bear!.f).toBeNull();
  });

  it("⚠️ a mid-batch failure does not re-apply the events that already committed", async () => {
    // Two notice-only events (non_member_raise): the branch with no unique key
    // of its own, where only the per-event cursor prevents a duplicate notice.
    await raise(W1, "Wolfie", "Flag_Bear", P1, now);
    await raise(S1, "Solo", "Flag_Bear", P1, new Date(now.getTime() + 1000));

    // Fail the SECOND event's transaction, after the first has committed.
    let started = 0;
    const flaky = new Proxy(db, {
      get(t, prop) {
        if (prop === "transaction") {
          return async (fn: unknown) => {
            if (started++ >= 1) throw new Error("injected mid-batch failure");
            return (t as Database).transaction(fn as never);
          };
        }
        const v = Reflect.get(t as object, prop);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as Database;

    await expect(raiseTick(flaky, { siteBaseUrl: SITE })).rejects.toThrow(/injected/u);
    expect(await db.select().from(clanNotices)).toHaveLength(1);

    // The next tick resumes at the first event's committed cursor: it applies
    // the second event and nothing else. Two notices in total, not three.
    await raiseTick(db, { siteBaseUrl: SITE });
    const notices = await db.select({ p: clanNotices.payload }).from(clanNotices).orderBy(clanNotices.id);
    expect(notices).toEqual([{ p: { gamertag: "Wolfie" } }, { p: { gamertag: "Solo" } }]);
  });

  it("⚠️ a replayed defense event does not double-count standings or cancel a fresh siege", async () => {
    await db.update(factions).set({ flagDownSince: ago(3_600_000), flagDownByDayzId: W1 }).where(eq(factions.id, BEAR));
    await raise(B1, "Bear1", "Flag_Bear", P1, now);
    await raiseTick(db, { siteBaseUrl: SITE });
    expect((await db.select({ d: seasonStandings.defenses }).from(seasonStandings))[0]).toEqual({ d: 1 });

    // A second, real raid lowers the flag again before the replay.
    const fresh = new Date(now.getTime() + 60_000);
    await db.update(factions).set({ flagDownSince: fresh, flagDownByDayzId: W1 }).where(eq(factions.id, BEAR));
    await db.execute(sql`update consumer_cursors set last_event_id = ${cursorAfterSetup} where consumer_name = 'raise-consumer'`);
    await raiseTick(db, { siteBaseUrl: SITE });

    expect(await db.select().from(defenses)).toHaveLength(1);
    expect((await db.select({ d: seasonStandings.defenses }).from(seasonStandings))[0]).toEqual({ d: 1 });
    expect(await db.select().from(warLogEvents)).toHaveLength(1);
    expect(await db.select().from(clanNotices)).toHaveLength(1);
    // The in-progress siege survives the replay.
    const [bear] = await db.select({ f: factions.flagDownSince }).from(factions).where(eq(factions.id, BEAR));
    expect(bear!.f).toEqual(fresh);
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

  describe("post-wipe bind (§8.5)", () => {
    it("a full member's raise of the clan's texture at any free pole binds the base with the raise as evidence", async () => {
      await db.delete(declarations).where(eq(declarations.ownerFactionId, BEAR));
      await raise(B1, "Bear1", "Flag_Bear", P9, now);
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ bound: 1 });
      const d = await declarationForFaction(db, BEAR);
      expect(d).toMatchObject({ poleKey: P9 });
      expect((await db.select().from(factionEvents)).at(-1)).toMatchObject({ kind: "rebound", factionId: BEAR, payload: { name: "BEAR", tag: "BEAR", texture: "Flag_Bear" } });
      expect(await db.select().from(clanNotices)).toEqual([]);
    });

    it("a replay of the bind event binds nothing more and proposes no rebind", async () => {
      // The bind exits through done(), which commits the cursor in the
      // event's own transaction. Rewind the cursor and re-deliver the same
      // raise: the branch now finds the declaration it just wrote, so a
      // regression that moved the cursor write would fall through to the
      // rebind proposal and DM the clan about its own bind.
      await db.delete(declarations).where(eq(declarations.ownerFactionId, BEAR));
      await raise(B1, "Bear1", "Flag_Bear", P9, now);
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ bound: 1 });
      expect(await db.select().from(factionEvents)).toHaveLength(1);

      await db.execute(sql`update consumer_cursors set last_event_id = ${cursorAfterSetup} where consumer_name = 'raise-consumer'`);
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ bound: 0 });

      expect(await declarationForFaction(db, BEAR)).toMatchObject({ poleKey: P9 });
      expect(await db.select().from(declarations)).toHaveLength(1);
      expect(await db.select().from(factionEvents)).toHaveLength(1); // no second "rebound"
      expect(await db.select().from(clanNotices)).toEqual([]);       // no spurious rebind_proposed
    });

    it("a dormant clan's bind also revives it", async () => {
      await db.delete(declarations).where(eq(declarations.ownerFactionId, BEAR));
      await db.update(factions).set({ status: "dormant", dormantSince: ago(86_400_000), dormantReason: "inactive", disbandWarnedAt: ago(1000) }).where(eq(factions.id, BEAR));
      await raise(B1, "Bear1", "Flag_Bear", P9, now);
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ bound: 1 });
      const [bear] = await db.select({ s: factions.status, r: factions.dormantReason, w: factions.disbandWarnedAt, d: factions.dormantSince }).from(factions).where(eq(factions.id, BEAR));
      expect(bear).toEqual({ s: "active", r: null, w: null, d: null });
      const rows = await db.select().from(factionEvents).orderBy(factionEvents.id);
      expect(rows.map((r) => r.kind)).toEqual(["rebound", "revived"]);
      expect(rows.at(-1)).toMatchObject({ kind: "revived", payload: { actor: "Bear1" } });
      expect((await db.select().from(clanNotices))[0]).toMatchObject({ kind: "revived", payload: { gamertag: "Bear1" } });
    });

    it("a pending member's raise binds nothing", async () => {
      await db.delete(declarations).where(eq(declarations.ownerFactionId, BEAR));
      const PEND = "PEND-DAYZID-000000000000000000000000";
      await db.insert(factionMembers).values({ factionId: BEAR, serverId, dayzId: PEND, discordId: "dPend", role: "member", joinedAt: now, status: "pending", pendingSince: now });
      await raise(PEND, "Pendy", "Flag_Bear", P9, now);
      const r = await raiseTick(db, { siteBaseUrl: SITE });
      expect(r.bound).toBe(0);
      expect(await declarationForFaction(db, BEAR)).toBeNull();
      expect((await db.select().from(clanNotices))[0]).toMatchObject({ kind: "colors_elsewhere", payload: { gamertag: "Pendy" } });
    });

    it("too close to another base binds nothing and writes nothing", async () => {
      await db.delete(declarations).where(eq(declarations.ownerFactionId, BEAR));
      const wolf = await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", poleKey: WOLF_POLE, createdAt: now, activatedAt: now });
      // seedFaction wrote its own synthetic flag.raised (evidence for WOLF's
      // declaration, dayzId "SEED") — advance the cursor past it, same as
      // beforeEach does for BEAR, so it doesn't queue its own non_member_raise.
      const rows = (await db.execute(sql`select coalesce(max(id), 0)::int as n from events`)) as unknown as { n: number }[];
      await db.execute(sql`update consumer_cursors set last_event_id = ${rows[0]!.n} where consumer_name = 'raise-consumer'`);
      await raise(B1, "Bear1", "Flag_Bear", WOLF_NEAR, now);
      const r = await raiseTick(db, { siteBaseUrl: SITE });
      expect(r.bound).toBe(0);
      expect(await declarationForFaction(db, BEAR)).toBeNull();
      expect(await declarationForFaction(db, wolf.id)).toMatchObject({ poleKey: WOLF_POLE });
      expect(await db.select().from(clanNotices)).toEqual([]);
      expect(await db.select().from(factionEvents)).toHaveLength(0);
    });

    it("a clan that still has a declaration gets the rebind proposal, not a bind", async () => {
      await raise(B1, "Bear1", "Flag_Bear", P3, now);
      const r = await raiseTick(db, { siteBaseUrl: SITE });
      expect(r.bound).toBe(0);
      expect((await db.select({ k: clanNotices.kind, p: clanNotices.payload }).from(clanNotices))[0]).toMatchObject({ k: "rebind_proposed", p: { gamertag: "Bear1", link: `${SITE}/clan/settings` } });
      const d = await declarationForFaction(db, BEAR);
      expect(d).toMatchObject({ poleKey: P1 }); // unchanged
    });

    describe("with a White flag (the clan's own flag cannot be had until the kit returns)", () => {
      it("a full member's White raise at a free pole binds the base, with the raise as evidence", async () => {
        await db.delete(declarations).where(eq(declarations.ownerFactionId, BEAR));
        await raise(B1, "Bear1", "Flag_White", P9, now);
        expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ bound: 1 });
        expect(await declarationForFaction(db, BEAR)).toMatchObject({ poleKey: P9 });
        expect((await db.select().from(factionEvents)).at(-1)).toMatchObject({ kind: "rebound", factionId: BEAR, payload: { texture: "Flag_Bear" } });
        expect(await db.select().from(clanNotices)).toEqual([]);
      });

      it("a dormant clan's White bind also revives it", async () => {
        await db.delete(declarations).where(eq(declarations.ownerFactionId, BEAR));
        await db.update(factions).set({ status: "dormant", dormantSince: ago(86_400_000), dormantReason: "inactive" }).where(eq(factions.id, BEAR));
        await raise(B1, "Bear1", "Flag_White", P9, now);
        expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ bound: 1 });
        const [bear] = await db.select({ s: factions.status }).from(factions).where(eq(factions.id, BEAR));
        expect(bear).toEqual({ s: "active" });
      });

      it("then raising the clan's own flag at that pole is ordinary upkeep: no rebind proposal, no second bind", async () => {
        await db.delete(declarations).where(eq(declarations.ownerFactionId, BEAR));
        await raise(B1, "Bear1", "Flag_White", P9, now);
        await raise(B1, "Bear1", "Flag_Bear", P9, new Date(now.getTime() + 60_000));
        expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ bound: 1 });
        expect(await declarationForFaction(db, BEAR)).toMatchObject({ poleKey: P9 });
        expect(await db.select().from(clanNotices)).toEqual([]);
      });

      it("⚠️ a clan that still has a base is not moved by a White raise, and is told nothing", async () => {
        // White at a free pole is founding-ceremony material; a clan moves
        // its base only through the rebind proposal.
        await raise(B1, "Bear1", "Flag_White", P3, now);
        const r = await raiseTick(db, { siteBaseUrl: SITE });
        expect(r).toMatchObject({ bound: 0, noticed: 0 });
        expect(await declarationForFaction(db, BEAR)).toMatchObject({ poleKey: P1 });
        expect(await db.select().from(clanNotices)).toEqual([]);
      });

      it("a pending member's or a clanless player's White raise binds nothing", async () => {
        await db.delete(declarations).where(eq(declarations.ownerFactionId, BEAR));
        const PEND = "PEND-DAYZID-000000000000000000000000";
        await db.insert(factionMembers).values({ factionId: BEAR, serverId, dayzId: PEND, discordId: "dPend", role: "member", joinedAt: now, status: "pending", pendingSince: now });
        await raise(PEND, "Pendy", "Flag_White", P9, now);
        await raise(W1, "Wanderer", "Flag_White", P4, now);
        expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ bound: 0, noticed: 0 });
        expect(await declarationForFaction(db, BEAR)).toBeNull();
        expect(await db.select().from(clanNotices)).toEqual([]);
      });

      it("a reserved clan's White raise binds nothing: activation is ceremony-tick's", async () => {
        await db.delete(declarations).where(eq(declarations.ownerFactionId, BEAR));
        await db.update(factions).set({ status: "reserved", activatedAt: null, reservedUntil: new Date(now.getTime() + 86_400_000) }).where(eq(factions.id, BEAR));
        await raise(B1, "Bear1", "Flag_White", P9, now);
        expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ bound: 0 });
        expect(await declarationForFaction(db, BEAR)).toBeNull();
      });
    });
  });

  describe("adopting a pole near a carried base", () => {
    // BEAR's old spot, carried by a wipe.
    const OLD = { x: 6000, z: 6000 };
    const NEAR = "6060.00:100.00:6040.00";   // ~72 m
    const EDGE = "6100.00:100.00:6000.00";   // exactly 100 m
    const FAR = "6101.00:100.00:6000.00";    // 101 m

    beforeEach(async () => {
      await db.update(declarations).set({
        poleKey: "6000.00:100.00:6000.00", x: "6000.00", z: "6000.00", carriedSince: ago(86_400_000),
      }).where(eq(declarations.ownerFactionId, BEAR));
    });

    it("a full member's White raise within 100 m adopts the pole: no notice, a rebound event", async () => {
      await raise(B1, "Bear1", "Flag_White", NEAR, now);
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ adopted: 1, bound: 0, noticed: 0 });
      expect(await declarationForFaction(db, BEAR)).toMatchObject({ poleKey: NEAR, carriedSince: null });
      expect((await db.select().from(factionEvents)).map((r) => r.kind)).toEqual(["rebound"]);
      expect(await db.select().from(clanNotices)).toEqual([]);
    });

    it("the clan's own flag at exactly 100 m adopts too", async () => {
      await raise(B1, "Bear1", "Flag_Bear", EDGE, now);
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ adopted: 1 });
      expect(await declarationForFaction(db, BEAR)).toMatchObject({ poleKey: EDGE, carriedSince: null });
    });

    it("101 m away the clan's own flag falls through to the rebind proposal, and the base stays carried", async () => {
      await raise(B1, "Bear1", "Flag_Bear", FAR, now);
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ adopted: 0, noticed: 1 });
      expect((await db.select({ k: clanNotices.kind }).from(clanNotices))[0]).toEqual({ k: "rebind_proposed" });
      expect(await declarationForFaction(db, BEAR)).toMatchObject({ x: "6000.00", carriedSince: ago(86_400_000) });
    });

    it("101 m away a White raise does nothing for the clan", async () => {
      await raise(B1, "Bear1", "Flag_White", FAR, now);
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ adopted: 0, bound: 0, noticed: 0 });
      expect(await declarationForFaction(db, BEAR)).toMatchObject({ x: "6000.00" });
    });

    it("a dormant clan's adoption revives it", async () => {
      await db.update(factions).set({ status: "dormant", dormantSince: ago(86_400_000), dormantReason: "inactive" }).where(eq(factions.id, BEAR));
      await raise(B1, "Bear1", "Flag_White", NEAR, now);
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ adopted: 1 });
      const [bear] = await db.select({ s: factions.status }).from(factions).where(eq(factions.id, BEAR));
      expect(bear).toEqual({ s: "active" });
      expect((await db.select().from(factionEvents).orderBy(factionEvents.id)).map((r) => r.kind)).toEqual(["rebound", "revived"]);
    });

    it("a pending member, a foreign flag, or a clanless player adopts nothing", async () => {
      const PEND = "PEND-DAYZID-000000000000000000000000";
      await db.insert(factionMembers).values({ factionId: BEAR, serverId, dayzId: PEND, discordId: "dPend", role: "member", joinedAt: now, status: "pending", pendingSince: now });
      await raise(PEND, "Pendy", "Flag_White", NEAR, now);
      await raise(B1, "Bear1", "Flag_Wolf", NEAR, new Date(now.getTime() + 1000));
      await raise(W1, "Wanderer", "Flag_White", NEAR, new Date(now.getTime() + 2000));
      expect((await raiseTick(db, { siteBaseUrl: SITE })).adopted).toBe(0);
      expect(await declarationForFaction(db, BEAR)).toMatchObject({ x: "6000.00", carriedSince: ago(86_400_000) });
    });

    it("⚠️ a clan whose base is NOT carried is never moved by a nearby White raise", async () => {
      await db.update(declarations).set({ carriedSince: null }).where(eq(declarations.ownerFactionId, BEAR));
      await raise(B1, "Bear1", "Flag_White", NEAR, now);
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ adopted: 0, bound: 0 });
      expect(await declarationForFaction(db, BEAR)).toMatchObject({ x: "6000.00" });
    });

    it("⚠️ a raise dated BEFORE the wipe adopts nothing: that pole no longer exists", async () => {
      await db.update(declarations).set({ carriedSince: now }).where(eq(declarations.ownerFactionId, BEAR));
      await raise(B1, "Bear1", "Flag_White", NEAR, ago(60_000));
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ adopted: 0 });
      expect(await declarationForFaction(db, BEAR)).toMatchObject({ x: "6000.00", carriedSince: now });
    });

    it("⚠️ a member of a clan whose base is NOT carried never moves a neighbour's carried base", async () => {
      const wolf = await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", poleKey: "2000.00:100.00:2000.00", x: 2000, y: 100, z: 2000, createdAt: now, activatedAt: now });
      const W2 = "W2-DAYZID-0000000000000000000000000";
      await db.insert(factionMembers).values({ factionId: wolf.id, serverId, dayzId: W2, discordId: "dW2", role: "leader", joinedAt: now, status: "full" });
      const rows = (await db.execute(sql`select coalesce(max(id), 0)::int as n from events`)) as unknown as { n: number }[];
      await db.execute(sql`update consumer_cursors set last_event_id = ${rows[0]!.n} where consumer_name = 'raise-consumer'`);
      await raise(W2, "Wolf2", "Flag_White", NEAR, now); // beside BEAR's carried spot
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ adopted: 0 });
      expect(await declarationForFaction(db, BEAR)).toMatchObject({ x: "6000.00", carriedSince: ago(86_400_000) });
      expect(await declarationForFaction(db, wolf.id)).toMatchObject({ x: "2000.00", carriedSince: null });
    });

    it("too close to another base adopts nothing and writes nothing", async () => {
      const wolf = await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", poleKey: "6200.00:100.00:6040.00", x: 6200, y: 100, z: 6040, createdAt: now, activatedAt: now });
      const rows = (await db.execute(sql`select coalesce(max(id), 0)::int as n from events`)) as unknown as { n: number }[];
      await db.execute(sql`update consumer_cursors set last_event_id = ${rows[0]!.n} where consumer_name = 'raise-consumer'`);
      await raise(B1, "Bear1", "Flag_White", NEAR, now); // 140 m from WOLF
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ adopted: 0 });
      expect(await declarationForFaction(db, BEAR)).toMatchObject({ x: "6000.00", carriedSince: ago(86_400_000) });
      expect(await declarationForFaction(db, wolf.id)).toMatchObject({ x: "6200.00" });
      expect(await db.select().from(factionEvents)).toHaveLength(0);
    });

    it("⚠️ a replay after the adoption moves nothing and writes no second rebound", async () => {
      await raise(B1, "Bear1", "Flag_White", NEAR, now);
      await raiseTick(db, { siteBaseUrl: SITE });
      await db.execute(sql`update consumer_cursors set last_event_id = ${cursorAfterSetup} where consumer_name = 'raise-consumer'`);
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ adopted: 0 });
      expect(await declarationForFaction(db, BEAR)).toMatchObject({ poleKey: NEAR });
      expect(await db.select().from(factionEvents)).toHaveLength(1);
      expect(await db.select().from(clanNotices)).toEqual([]);
    });

    it("⚠️ only the raiser's own clan adopts, never a neighbour's carried base", async () => {
      // WOLF is carried 210 m from NEAR (clear of the spacing rule); B1 is in
      // BEAR. BEAR adopts; WOLF is untouched.
      const wolf = await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", poleKey: "6270.00:100.00:6040.00", x: 6270, y: 100, z: 6040, createdAt: now, activatedAt: now });
      await db.update(declarations).set({ carriedSince: ago(86_400_000) }).where(eq(declarations.ownerFactionId, wolf.id));
      const rows = (await db.execute(sql`select coalesce(max(id), 0)::int as n from events`)) as unknown as { n: number }[];
      await db.execute(sql`update consumer_cursors set last_event_id = ${rows[0]!.n} where consumer_name = 'raise-consumer'`);
      await raise(B1, "Bear1", "Flag_White", NEAR, now);
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ adopted: 1 });
      expect(await declarationForFaction(db, wolf.id)).toMatchObject({ x: "6270.00", carriedSince: ago(86_400_000) });
    });
  });

  describe("a pending flag change", () => {
    const pend = (until = new Date(now.getTime() + FLAG_CHANGE_WINDOW_MS), stampsCooldown = true) =>
      db.insert(flagHolds).values({ serverId, texture: "Flag_Wolf", factionId: BEAR, kind: "pending", until, stampsCooldown, createdAt: ago(3_600_000) });
    const bearRow = async () => (await db.select().from(factions).where(eq(factions.id, BEAR)))[0]!;

    it("the old flag still counts while the change is pending", async () => {
      await pend();
      await db.update(factions).set({ flagDownSince: ago(3_600_000), flagDownByDayzId: W1 }).where(eq(factions.id, BEAR));
      await raise(B1, "Bear1", "Flag_Bear", P1, now);
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ defenses: 1 });
      expect((await bearRow()).texture).toBe("Flag_Bear");
    });

    it("a full member raising the new flag at home completes the change", async () => {
      await pend();
      await raise(B1, "Bear1", "Flag_Wolf", P1, now);
      await raiseTick(db, { siteBaseUrl: SITE });
      expect(await bearRow()).toMatchObject({ texture: "Flag_Wolf", renamedAt: now });
      expect(await db.select({ texture: flagHolds.texture, kind: flagHolds.kind, until: flagHolds.until }).from(flagHolds))
        .toEqual([{ texture: "Flag_Bear", kind: "released", until: new Date(now.getTime() + OLD_FLAG_HOLD_MS) }]);
      const hist = await db.select().from(factionTextures).where(eq(factionTextures.factionId, BEAR)).orderBy(factionTextures.fromAt);
      expect(hist.map((h) => [h.texture, h.toAt])).toEqual([["Flag_Bear", now], ["Flag_Wolf", null]]);
      const [fe] = await db.select().from(factionEvents).where(eq(factionEvents.kind, "flag_changed"));
      expect(fe!.payload).toMatchObject({ texture: "Flag_Wolf", previousTexture: "Flag_Bear", actor: "Bear1" });
      expect((await db.select().from(clanNotices).where(eq(clanNotices.kind, "flag_changed")))).toHaveLength(1);
    });

    it("a name-and-flag rebrand does not restamp the cooldown on completion", async () => {
      await pend(undefined, false);
      await raise(B1, "Bear1", "Flag_Wolf", P1, now);
      await raiseTick(db, { siteBaseUrl: SITE });
      expect((await bearRow()).renamedAt).toBeNull();
    });

    it("completing during a siege is also the defense", async () => {
      await pend();
      await db.update(factions).set({ flagDownSince: ago(3_600_000), flagDownByDayzId: W1 }).where(eq(factions.id, BEAR));
      await raise(B1, "Bear1", "Flag_Wolf", P1, now);
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ defenses: 1 });
      expect(await bearRow()).toMatchObject({ texture: "Flag_Wolf", flagDownSince: null });
    });

    it("completing revives a clan that went dormant meanwhile", async () => {
      await pend();
      await db.update(factions).set({ status: "dormant", dormantSince: ago(3_600_000), dormantReason: "inactive" }).where(eq(factions.id, BEAR));
      await raise(B1, "Bear1", "Flag_Wolf", P1, now);
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ revived: 1 });
      expect(await bearRow()).toMatchObject({ texture: "Flag_Wolf", status: "active" });
    });

    it("a raise at or after the deadline does nothing", async () => {
      await pend(now);
      await raise(B1, "Bear1", "Flag_Wolf", P1, now);
      await raiseTick(db, { siteBaseUrl: SITE });
      expect((await bearRow()).texture).toBe("Flag_Bear");
      expect((await db.select().from(flagHolds))[0]).toMatchObject({ kind: "pending" });
    });

    it("the pending flag raised at another pole does nothing", async () => {
      await pend();
      await raise(B1, "Bear1", "Flag_Wolf", P9, now);
      await raiseTick(db, { siteBaseUrl: SITE });
      expect((await bearRow()).texture).toBe("Flag_Bear");
      expect(await db.select().from(clanNotices)).toEqual([]);
    });

    it("a non-member raising the pending flag at home completes nothing", async () => {
      await pend();
      await raise(W1, "Wolfie", "Flag_Wolf", P1, now);
      await raiseTick(db, { siteBaseUrl: SITE });
      expect((await bearRow()).texture).toBe("Flag_Bear");
    });

    it("a second tick does not announce twice", async () => {
      await pend();
      await raise(B1, "Bear1", "Flag_Wolf", P1, now);
      await raiseTick(db, { siteBaseUrl: SITE });
      await raiseTick(db, { siteBaseUrl: SITE });
      expect(await db.select().from(factionEvents).where(eq(factionEvents.kind, "flag_changed"))).toHaveLength(1);
    });
  });
});
