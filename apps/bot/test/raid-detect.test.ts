import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, factionTextures, declarations, events, admFiles,
  membershipHistory, playerSessions, raids,
  type Database,
} from "@factions/db";
import { sql, eq, and, isNull } from "drizzle-orm";
import { classifyLower, clanOnlineAt, seasonRaidFacts } from "../src/raid-detect.js";
import { seedFaction, seedSeason } from "./seed.js";

const URL = requireTestDatabaseUrl();
const t0 = new Date("2026-10-20T12:00:00Z");
const created = new Date(t0.getTime() - 30 * 86_400_000);
const H = 3_600_000;
const at = (ms: number) => new Date(t0.getTime() + ms);

describe("raid-detect", () => {
  let db: Database;
  let serverId = 0;
  let admFileId = 0;
  let line = 0;
  let X = 0, Y = 0, Z = 0;
  const X1 = "X1-DAYZID", Y1 = "Y1-DAYZID", Z1 = "Z1-DAYZID";
  const PX = "1000.00:100.00:1000.00";
  const PY = "2000.00:100.00:2000.00";
  const PZ = "3000.00:100.00:3000.00";
  const PU = "7000.00:100.00:7000.00"; // nobody's declared base

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table clan_notices, war_log_events, season_standings, raids, seasons, membership_history, player_sessions, faction_members, declarations, poles, consumer_cursors, events, adm_files, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: created, linesIngested: 0, complete: true }).returning();
    admFileId = a!.id;
    line = 0;
    await seedSeason(db, serverId, created);
    X = (await seedFaction(db, { serverId, tag: "X", texture: "Flag_X", poleKey: PX, x: 1000, z: 1000, createdAt: created, activatedAt: created })).id;
    Y = (await seedFaction(db, { serverId, tag: "Y", texture: "Flag_Y", poleKey: PY, x: 2000, z: 2000, createdAt: created, activatedAt: created })).id;
    Z = (await seedFaction(db, { serverId, tag: "Z", texture: "Flag_Z", poleKey: PZ, x: 3000, z: 3000, createdAt: created, activatedAt: created })).id;
    for (const [f, d] of [[X, X1], [Y, Y1], [Z, Z1]] as const) {
      await db.insert(factionMembers).values({ factionId: f, serverId, dayzId: d, discordId: `d${d}`, role: "leader", joinedAt: created, status: "full" });
      await db.insert(membershipHistory).values({ serverId, factionId: f, dayzId: d, joinedAt: created });
    }
  });

  const raise = async (dayzId: string, texture: string, poleKey: string, when: Date) => {
    const [ev] = await db.insert(events).values({
      serverId, admFileId, lineIndex: line++, type: "flag.raised", occurredAt: when,
      payload: { dayzId, gamertag: dayzId, texture, poleKey, pole: { x: 1, y: 2, z: 3 } },
    }).returning();
    return ev!;
  };
  const classify = (dayzId: string, texture: string, poleKey: string, when: Date, opts?: { replay?: boolean }) =>
    db.transaction((tx) => classifyLower(tx, { serverId, occurredAt: when, dayzId, poleKey, texture }, opts));

  it("a non-member lowering at Y's base raids Y, at base", async () => {
    expect(await classify(Z1, "Flag_Y", PY, t0)).toEqual({ kind: "raid", victimFactionId: Y, away: false });
  });

  it("a third clan Z lowering X's flag on Y's base raids Y only (one lowering is never two raids)", async () => {
    await raise(X1, "Flag_X", PY, at(-H));
    expect(await classify(Z1, "Flag_X", PY, t0)).toEqual({ kind: "raid", victimFactionId: Y, away: false });
  });

  it("Y's member lowering X's own flag on Y's base raids X, away", async () => {
    await raise(X1, "Flag_X", PY, at(-H));
    expect(await classify(Y1, "Flag_X", PY, t0)).toEqual({ kind: "raid", victimFactionId: X, away: true });
  });

  it("Y's member lowering a white flag X raised on Y's base is upkeep", async () => {
    await raise(X1, "Flag_White", PY, at(-H));
    expect(await classify(Y1, "Flag_White", PY, t0)).toEqual({ kind: "none" });
  });

  it("Y's member lowering X's flag that a non-member of X raised is upkeep (no farming a stolen flag)", async () => {
    await raise(X1, "Flag_X", PY, at(-2 * H));
    await raise(Z1, "Flag_X", PY, at(-H)); // the LATEST raise decides
    expect(await classify(Y1, "Flag_X", PY, t0)).toEqual({ kind: "none" });
  });

  it("Y's member lowering Y's own flag at Y's base is upkeep", async () => {
    await raise(Y1, "Flag_Y", PY, at(-H));
    expect(await classify(Y1, "Flag_Y", PY, t0)).toEqual({ kind: "none" });
  });

  it("a non-member lowering X's own flag at an undeclared pole raids X, away", async () => {
    await raise(X1, "Flag_X", PU, at(-H));
    expect(await classify(Z1, "Flag_X", PU, t0)).toEqual({ kind: "raid", victimFactionId: X, away: true });
  });

  it("X's own member lowering X's flag at an undeclared pole is not a raid", async () => {
    await raise(X1, "Flag_X", PU, at(-H));
    expect(await classify(X1, "Flag_X", PU, t0)).toEqual({ kind: "none" });
  });

  it("a white flag raised by X at an undeclared pole is not X's flag", async () => {
    await raise(X1, "Flag_White", PU, at(-H));
    expect(await classify(Z1, "Flag_White", PU, t0)).toEqual({ kind: "none" });
  });

  it("an undeclared pole with no raise of that texture is not a raid", async () => {
    expect(await classify(Z1, "Flag_X", PU, t0)).toEqual({ kind: "none" });
  });

  it("a raise after the lower does not count", async () => {
    await raise(X1, "Flag_X", PU, at(H));
    expect(await classify(Z1, "Flag_X", PU, t0)).toEqual({ kind: "none" });
  });

  it("after X rebrands, its OLD flag raised before to_at is still X's", async () => {
    const rebrandAt = at(-H);
    await raise(X1, "Flag_X", PU, at(-2 * H));
    await db.update(factionTextures).set({ toAt: rebrandAt }).where(and(eq(factionTextures.factionId, X), isNull(factionTextures.toAt)));
    await db.insert(factionTextures).values({ factionId: X, texture: "Flag_X2", fromAt: rebrandAt });
    await db.update(factions).set({ texture: "Flag_X2" }).where(eq(factions.id, X));
    expect(await classify(Z1, "Flag_X", PU, t0)).toEqual({ kind: "raid", victimFactionId: X, away: true });
  });

  it("an old flag raised AFTER X rebranded away from it is not X's", async () => {
    const rebrandAt = at(-2 * H);
    await db.update(factionTextures).set({ toAt: rebrandAt }).where(and(eq(factionTextures.factionId, X), isNull(factionTextures.toAt)));
    await db.insert(factionTextures).values({ factionId: X, texture: "Flag_X2", fromAt: rebrandAt });
    await db.update(factions).set({ texture: "Flag_X2" }).where(eq(factions.id, X));
    await raise(X1, "Flag_X", PU, at(-H));
    expect(await classify(Z1, "Flag_X", PU, t0)).toEqual({ kind: "none" });
  });

  it("the raiser's membership is read at the raise instant: a member who has since left still raised it for X", async () => {
    await raise(X1, "Flag_X", PU, at(-2 * H));
    await db.update(membershipHistory).set({ leftAt: at(-H) }).where(eq(membershipHistory.dayzId, X1));
    await db.delete(factionMembers).where(eq(factionMembers.dayzId, X1));
    expect(await classify(Z1, "Flag_X", PU, t0)).toEqual({ kind: "raid", victimFactionId: X, away: true });
  });

  it("a base declared after the lower is not yet a base: the away rule applies", async () => {
    await db.update(declarations).set({ declaredAt: at(H) }).where(eq(declarations.ownerFactionId, Y));
    await raise(Y1, "Flag_Y", PY, at(-H));
    expect(await classify(Z1, "Flag_Y", PY, t0)).toEqual({ kind: "raid", victimFactionId: Y, away: true });
  });

  it("X dormant: none live, a raid in replay (status history is not recorded)", async () => {
    await raise(X1, "Flag_X", PU, at(-H));
    await db.update(factions).set({ status: "dormant", dormantSince: at(-H / 2), dormantReason: "inactive" }).where(eq(factions.id, X));
    expect(await classify(Z1, "Flag_X", PU, t0)).toEqual({ kind: "none" });
    expect(await classify(Z1, "Flag_X", PU, t0, { replay: true })).toEqual({ kind: "raid", victimFactionId: X, away: true });
  });

  it("Y dormant at its base: no base raid live, a base raid in replay", async () => {
    await db.update(factions).set({ status: "dormant", dormantSince: at(-H), dormantReason: "inactive" }).where(eq(factions.id, Y));
    expect(await classify(Z1, "Flag_Y", PY, t0)).toEqual({ kind: "none" });
    expect(await classify(Z1, "Flag_Y", PY, t0, { replay: true })).toEqual({ kind: "raid", victimFactionId: Y, away: false });
  });

  it("replay reads membership from history only, not today's roster", async () => {
    // Y1 joined Y only after the lower: live still sees today's roster row
    // (upkeep), replay sees the span (a raid).
    await db.update(membershipHistory).set({ joinedAt: at(H) }).where(eq(membershipHistory.dayzId, Y1));
    expect(await classify(Y1, "Flag_Y", PY, t0)).toEqual({ kind: "none" });
    expect(await classify(Y1, "Flag_Y", PY, t0, { replay: true })).toEqual({ kind: "raid", victimFactionId: Y, away: false });
  });

  describe("clanOnlineAt", () => {
    const session = async (dayzId: string, from: Date, to: Date | null) => {
      const ev = await raise(dayzId, "conn", "conn", from); // any event row satisfies the FK
      await db.insert(playerSessions).values({ serverId, dayzId, connectedAt: from, connectEventId: ev.id, disconnectedAt: to, closeReason: to ? "disconnect" : null });
    };
    const online = (f: number, when: Date) => db.transaction((tx) => clanOnlineAt(tx, serverId, f, when));

    it("a full member in an open session at the instant is online; before, after, or another clan is not", async () => {
      await session(X1, at(-H), at(H));
      await session(Z1, at(-H), null);
      expect(await online(X, t0)).toBe(true);
      expect(await online(X, at(-2 * H))).toBe(false);
      expect(await online(X, at(H))).toBe(false); // disconnected_at is exclusive
      expect(await online(Y, t0)).toBe(false);
      expect(await online(Z, at(5 * H))).toBe(true);
    });

    it("membership is read at the instant: a member who joined later does not count", async () => {
      await session(X1, at(-H), null);
      await db.update(membershipHistory).set({ joinedAt: at(H) }).where(eq(membershipHistory.dayzId, X1));
      expect(await online(X, t0)).toBe(false);
      expect(await online(X, at(2 * H))).toBe(true);
    });
  });

  it("seasonRaidFacts returns the season's raid rows as RaidFacts", async () => {
    const season = await db.query.seasons.findFirst();
    const ev = await raise(Z1, "Flag_Y", PY, t0);
    await db.insert(raids).values({
      seasonId: season!.id, serverId, victimFactionId: Y, raiderDayzId: Z1, raiderFactionId: Z,
      firstLowerEventId: ev.id, firstLowerAt: t0, lastLowerAt: t0, lastLowerEventId: ev.id, lowerCount: 1,
      points: 75, weekStart: t0,
    });
    const facts = await db.transaction((tx) => seasonRaidFacts(tx, season!.id));
    expect(facts).toEqual([{ id: expect.any(Number), at: t0, raiderFactionId: Z, victimFactionId: Y }]);
    expect(await db.transaction((tx) => seasonRaidFacts(tx, season!.id + 1))).toEqual([]);
  });
});
