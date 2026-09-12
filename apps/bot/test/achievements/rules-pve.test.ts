import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { PVE_RULES } from "../../src/achievements/rules-pve.js";
import { seedServer, seedKill, seedSession, seedEvent, TRUNCATE } from "./seed.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(36), B = "B".repeat(36);
const t0 = new Date("2026-08-01T10:00:00Z");
const h = (n: number) => new Date(t0.getTime() + n * 3_600_000);
const player = { kind: "player" as const, id: A };
const ctx = { now: h(1000) };
const rule = (k: string) => PVE_RULES[k as keyof typeof PVE_RULES]!;

describe("pve rules", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => { await tx.execute(sql`set local client_min_messages = warning`); await tx.execute(sql.raw(TRUNCATE)); });
    serverId = (await seedServer(db)).id;
  });

  it("foundation / builder / architect: base.built events by the player", async () => {
    expect((await rule("foundation")(db, player, ctx)).count).toBe(0);
    for (let i = 0; i < 100; i++) await seedEvent(db, { serverId, type: "base.built", at: h(i), payload: { dayzId: A, gamertag: "Ann", part: "Wall", structure: "Fence" } });
    await seedEvent(db, { serverId, type: "base.dismantled", at: h(200), payload: { dayzId: A, gamertag: "Ann" } });
    expect(await rule("foundation")(db, player, ctx)).toMatchObject({ count: 1, earnedAt: h(0) });
    expect(await rule("builder")(db, player, ctx)).toMatchObject({ count: 100, earnedAt: h(99) });
    expect(await rule("architect")(db, player, ctx)).toMatchObject({ count: 100, target: 500 });
  });

  it.each([
    ["wolf_bait", "wolf"], ["bear_necessities", "bear"], ["brains", "infected"], ["gravity_check", "fall"],
    ["sunday_driver", "vehicle"], ["should_have_bandaged", "bled_out"],
  ])("%s: a death with cause %s and no killer", async (key, cause) => {
    await seedKill(db, { serverId, killer: B, victim: A, at: h(0) });                       // a PvP death: not this
    expect((await rule(key)(db, player, ctx)).count).toBe(0);
    const k = await seedKill(db, { serverId, killer: null, victim: A, at: h(1), cause });
    expect(await rule(key)(db, player, ctx)).toMatchObject({ count: 1, earnedAt: h(1), evidenceId: k.id });
  });

  it("lights_out: unconscious events that were not a disconnect", async () => {
    for (let i = 0; i < 9; i++) await seedEvent(db, { serverId, type: "player.unconscious", at: h(i), payload: { dayzId: A, gamertag: "Ann", disconnecting: false } });
    await seedEvent(db, { serverId, type: "player.unconscious", at: h(9), payload: { dayzId: A, gamertag: "Ann", disconnecting: true } });
    expect(await rule("lights_out")(db, player, ctx)).toMatchObject({ count: 9, target: 10 });
    await seedEvent(db, { serverId, type: "player.unconscious", at: h(10), payload: { dayzId: A, gamertag: "Ann", disconnecting: false } });
    expect(await rule("lights_out")(db, player, ctx)).toMatchObject({ count: 10, earnedAt: h(10) });
  });

  it("nine_lives: any death counts", async () => {
    for (let i = 0; i < 8; i++) await seedKill(db, { serverId, killer: i % 2 ? B : null, victim: A, at: h(i), cause: i % 2 ? "pvp" : "fall" });
    expect(await rule("nine_lives")(db, player, ctx)).toMatchObject({ count: 8, target: 9 });
    await seedKill(db, { serverId, killer: B, victim: A, at: h(8), friendlyFire: true });
    expect(await rule("nine_lives")(db, player, ctx)).toMatchObject({ count: 9, earnedAt: h(8) });
  });

  it("ironman: hours played between deaths; a death mid-session keeps only the part after it", async () => {
    // 2 h, death at 1 h into the second session, then 2 h + 2 h + 1.5 h → best run is 1 + 2 + 2 + 1.5 = 6.5 h, crossed inside the last session
    await seedSession(db, { serverId, dayzId: A, from: h(0), to: h(2) });
    await seedSession(db, { serverId, dayzId: A, from: h(3), to: h(5) });
    await seedKill(db, { serverId, killer: null, victim: A, at: h(4), cause: "fall" });
    await seedSession(db, { serverId, dayzId: A, from: h(6), to: h(8) });
    // NOTE (fixture fix, not an assertion-intent change): the brief seeded the fourth session
    // (h9-h11) here, before these two "3 h so far" checks. Since 1 (remainder after the death) +
    // 2 (this third session) + 2 (that fourth session) = 5 h exactly, the target would already be
    // crossed inside the fourth session by the time these checks ran — contradicting their own
    // comments ("1 + 2 = 3 h so far" and earnedAt undefined). The fourth session belongs after
    // these checks, moved down alongside the fifth, so the checkpoint genuinely lands before the
    // crossing, matching the assertions' documented intent.
    expect(await rule("ironman")(db, player, ctx)).toMatchObject({ count: 3, target: 5 });      // 1 + 2 = 3 h so far, floor
    expect((await rule("ironman")(db, player, ctx)).earnedAt).toBeUndefined();
    await seedSession(db, { serverId, dayzId: A, from: h(9), to: h(11) });
    await seedSession(db, { serverId, dayzId: A, from: h(12), to: h(13.5) });
    // run: (5-4)=1h, +2h = 3h, +2h = 5h → crosses exactly at the end of the fourth session, h(11)
    // (brief's note under Step 3: the rule stops at the crossing, so count reports the target, not the
    // session's raw total of 6h — the achievement is one-shot at the target.)
    expect(await rule("ironman")(db, player, ctx)).toMatchObject({ count: 5, earnedAt: h(11) });
  });

  it("ironman: a death in the GAP between two sessions breaks the streak, it does not extend it", async () => {
    // ⚠️ 4 h + 4 h with a death BETWEEN them is not an 8 h run. The death is outside every
    // session's window, so the rule has to notice it while skipping past it — otherwise the two
    // clean sessions weld together and hand out ironman to a player who demonstrably died.
    await seedSession(db, { serverId, dayzId: A, from: h(0), to: h(4) });
    await seedKill(db, { serverId, killer: null, victim: A, at: h(4.5), cause: "fall" });
    await seedSession(db, { serverId, dayzId: A, from: h(5), to: h(9) });
    expect(await rule("ironman")(db, player, ctx)).toMatchObject({ count: 4, target: 5 });
    expect((await rule("ironman")(db, player, ctx)).earnedAt).toBeUndefined();
    // The run restarted at h(5), so the target is only crossed 5 h of play after it.
    await seedSession(db, { serverId, dayzId: A, from: h(10), to: h(12) });
    expect(await rule("ironman")(db, player, ctx)).toMatchObject({ count: 5, earnedAt: h(11) });
  });
});
