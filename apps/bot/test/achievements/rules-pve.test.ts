import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { PVE_RULES } from "../../src/achievements/rules-pve.js";
import { makeCtx } from "../../src/achievements/types.js";
import { BAD_DOG_SURVIVE_MS } from "@factions/domain";
import { seedServer, seedKill, seedSession, seedEvent, seedHit, TRUNCATE } from "./seed.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(36), B = "B".repeat(36);
const t0 = new Date("2026-08-01T10:00:00Z");
const h = (n: number) => new Date(t0.getTime() + n * 3_600_000);
const player = { kind: "player" as const, id: A };
const NOW = h(1000);
const mk = (now = NOW) => makeCtx(now);
const sec = (n: number) => new Date(t0.getTime() + n * 1000);
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
    expect((await rule("foundation")(db, player, mk())).count).toBe(0);
    for (let i = 0; i < 100; i++) await seedEvent(db, { serverId, type: "base.built", at: h(i), payload: { dayzId: A, gamertag: "Ann", part: "Wall", structure: "Fence" } });
    await seedEvent(db, { serverId, type: "base.dismantled", at: h(200), payload: { dayzId: A, gamertag: "Ann" } });
    expect(await rule("foundation")(db, player, mk())).toMatchObject({ count: 1, earnedAt: h(0) });
    expect(await rule("builder")(db, player, mk())).toMatchObject({ count: 100, earnedAt: h(99) });
    expect(await rule("architect")(db, player, mk())).toMatchObject({ count: 100, target: 500 });
  });

  it("ruin repairs (structure null) are not build points", async () => {
    for (let i = 0; i < 3; i++) await seedEvent(db, { serverId, type: "base.built", at: h(i), payload: { dayzId: A, gamertag: "Ann", part: "Wall", structure: "Fence" } });
    for (let i = 3; i < 8; i++) await seedEvent(db, { serverId, type: "base.built", at: h(i), payload: { dayzId: A, gamertag: "Ann", part: "door1_metal", structure: null, tool: "Hammer" } });
    expect(await rule("foundation")(db, player, mk())).toMatchObject({ count: 1, earnedAt: h(0) });
    expect((await rule("builder")(db, player, mk())).count).toBe(3);
  });

  it.each([
    ["brains", "infected"], ["gravity_check", "fall"],
    ["sunday_driver", "vehicle"], ["should_have_bandaged", "bled_out"],
  ])("%s: a death with cause %s and no killer", async (key, cause) => {
    await seedKill(db, { serverId, killer: B, victim: A, at: h(0) });                       // a PvP death: not this
    expect((await rule(key)(db, player, mk())).count).toBe(0);
    const k = await seedKill(db, { serverId, killer: null, victim: A, at: h(1), cause });
    expect(await rule(key)(db, player, mk())).toMatchObject({ count: 1, earnedAt: h(1), evidenceId: k.id });
  });

  it("lights_out: unconscious events that were not a disconnect", async () => {
    for (let i = 0; i < 9; i++) await seedEvent(db, { serverId, type: "player.unconscious", at: h(i), payload: { dayzId: A, gamertag: "Ann", disconnecting: false } });
    await seedEvent(db, { serverId, type: "player.unconscious", at: h(9), payload: { dayzId: A, gamertag: "Ann", disconnecting: true } });
    expect(await rule("lights_out")(db, player, mk())).toMatchObject({ count: 9, target: 10 });
    await seedEvent(db, { serverId, type: "player.unconscious", at: h(10), payload: { dayzId: A, gamertag: "Ann", disconnecting: false } });
    expect(await rule("lights_out")(db, player, mk())).toMatchObject({ count: 10, earnedAt: h(10) });
  });

  it("nine_lives: any death counts", async () => {
    for (let i = 0; i < 8; i++) await seedKill(db, { serverId, killer: i % 2 ? B : null, victim: A, at: h(i), cause: i % 2 ? "pvp" : "fall" });
    expect(await rule("nine_lives")(db, player, mk())).toMatchObject({ count: 8, target: 9 });
    await seedKill(db, { serverId, killer: B, victim: A, at: h(8), friendlyFire: true });
    expect(await rule("nine_lives")(db, player, mk())).toMatchObject({ count: 9, earnedAt: h(8) });
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
    expect(await rule("ironman")(db, player, mk())).toMatchObject({ count: 3, target: 5 });      // 1 + 2 = 3 h so far, floor
    expect((await rule("ironman")(db, player, mk())).earnedAt).toBeUndefined();
    await seedSession(db, { serverId, dayzId: A, from: h(9), to: h(11) });
    await seedSession(db, { serverId, dayzId: A, from: h(12), to: h(13.5) });
    // run: (5-4)=1h, +2h = 3h, +2h = 5h → crosses exactly at the end of the fourth session, h(11)
    // (brief's note under Step 3: the rule stops at the crossing, so count reports the target, not the
    // session's raw total of 6h — the achievement is one-shot at the target.)
    expect(await rule("ironman")(db, player, mk())).toMatchObject({ count: 5, earnedAt: h(11) });
  });

  it("ironman: a death in the GAP between two sessions breaks the streak, it does not extend it", async () => {
    // ⚠️ 4 h + 4 h with a death BETWEEN them is not an 8 h run. The death is outside every
    // session's window, so the rule has to notice it while skipping past it — otherwise the two
    // clean sessions weld together and hand out ironman to a player who demonstrably died.
    await seedSession(db, { serverId, dayzId: A, from: h(0), to: h(4) });
    await seedKill(db, { serverId, killer: null, victim: A, at: h(4.5), cause: "fall" });
    await seedSession(db, { serverId, dayzId: A, from: h(5), to: h(9) });
    expect(await rule("ironman")(db, player, mk())).toMatchObject({ count: 4, target: 5 });
    expect((await rule("ironman")(db, player, mk())).earnedAt).toBeUndefined();
    // The run restarted at h(5), so the target is only crossed 5 h of play after it.
    await seedSession(db, { serverId, dayzId: A, from: h(10), to: h(12) });
    expect(await rule("ironman")(db, player, mk())).toMatchObject({ count: 5, earnedAt: h(11) });
  });

  // ── Dogs (spec 2026-10-20-achievements-150 §2.5) ────────────────────────────

  const bite = (at: Date, label = "Doberman", victim = A) => seedHit(db, { serverId, at, victim, attackerLabel: label });

  it("dog_food: a death with cause dog and no killer", async () => {
    await bite(h(0));
    expect((await rule("dog_food")(db, player, mk())).count).toBe(0);
    const k = await seedKill(db, { serverId, killer: null, victim: A, at: h(0.01), cause: "dog" });
    expect(await rule("dog_food")(db, player, mk())).toMatchObject({ count: 1, earnedAt: h(0.01), evidenceId: k.id });
  });

  it("⚠️ dog_food: dog bites then a player's kill — the death is the player's, so no Dog Food", async () => {
    await bite(sec(0)); await bite(sec(2), "German Shepherd");
    await seedKill(db, { serverId, killer: B, victim: A, at: sec(5), cause: "dog" });   // even mislabelled, a credited kill is not this
    await seedKill(db, { serverId, killer: B, victim: A, at: sec(9) });
    expect((await rule("dog_food")(db, player, mk())).count).toBe(0);
  });

  it("chew_toy: 10 dog hit lines, both breeds, other hitters and other victims not counted", async () => {
    for (let i = 0; i < 9; i++) await bite(sec(i), i % 2 ? "German Shepherd" : "Doberman");
    await seedHit(db, { serverId, at: sec(20), victim: A, attackerLabel: "Infected", attackerType: "infected" });
    await seedHit(db, { serverId, at: sec(21), victim: A, attackerLabel: "Fence", cause: "BarbedWireHit" });
    await seedHit(db, { serverId, at: sec(22), victim: A, attacker: B, weapon: "M4-A1" });
    await bite(sec(23), "Doberman", B);
    expect(await rule("chew_toy")(db, player, mk())).toMatchObject({ count: 9, target: 10 });
    // Lines, not attacks: a tenth bite in the same second as the ninth still counts.
    const tenth = await bite(sec(8));
    expect(await rule("chew_toy")(db, player, mk())).toMatchObject({ count: 10, earnedAt: sec(8), evidenceId: tenth.id });
  });

  it("bad_dog: a bite and then a death 4 min later is not surviving it", async () => {
    await bite(h(0));
    await seedKill(db, { serverId, killer: null, victim: A, at: new Date(h(0).getTime() + 4 * 60_000), cause: "bled_out" });
    expect(await rule("bad_dog")(db, player, mk())).toMatchObject({ count: 0, target: 1 });
  });

  it("bad_dog: a death in the bite's own second is the bite killing you, not surviving it", async () => {
    await bite(sec(30));
    await seedKill(db, { serverId, killer: null, victim: A, at: sec(30), cause: "dog" });
    expect(await rule("bad_dog")(db, player, mk())).toMatchObject({ count: 0, target: 1 });
  });

  it("bad_dog: a bite with an open session and no death is earned at bite + 10 min, only once now has reached it", async () => {
    await seedSession(db, { serverId, dayzId: A, from: h(-1), to: null });
    const b = await bite(h(1));
    const at = new Date(h(1).getTime() + BAD_DOG_SURVIVE_MS);
    expect(await rule("bad_dog")(db, player, mk(new Date(at.getTime() - 1000)))).toMatchObject({ count: 0, target: 1 });
    expect(await rule("bad_dog")(db, player, mk(at))).toMatchObject({ count: 1, earnedAt: at, evidenceId: b.id });
    // A death after the window does not undo it.
    await seedKill(db, { serverId, killer: B, victim: A, at: new Date(at.getTime() + 1000) });
    expect(await rule("bad_dog")(db, player, mk())).toMatchObject({ count: 1, earnedAt: at });
  });

  it("bad_dog: the first bite that was survived — an earlier fatal mauling does not count, a later survived one does", async () => {
    await bite(h(0));
    await seedKill(db, { serverId, killer: null, victim: A, at: h(0.1), cause: "dog" });   // 6 min later
    const b2 = await bite(h(2), "German Shepherd");
    await bite(h(2.05));
    expect(await rule("bad_dog")(db, player, mk())).toMatchObject({ count: 1, earnedAt: new Date(h(2).getTime() + BAD_DOG_SURVIVE_MS), evidenceId: b2.id });
  });

  // ── Motorbikes (§2.6) ───────────────────────────────────────────────────────

  it("⚠️ road_rash: a 30-line burst in one second is one incident, not 30", async () => {
    const first = await seedHit(db, { serverId, at: sec(10), victim: A, attackerLabel: "Motorbike_02_Yellow", cause: "TransportHit" });
    for (let i = 1; i < 30; i++) await seedHit(db, { serverId, at: sec(10), victim: A, attackerLabel: "Motorbike_02_Yellow", cause: "TransportHit" });
    expect(await rule("road_rash")(db, player, mk())).toMatchObject({ count: 1, earnedAt: sec(10), evidenceId: first.id, evidence: { incidents: 1 } });
    await seedHit(db, { serverId, at: sec(70), victim: A, attackerLabel: "Motorbike_01_Blue", cause: "TransportHit" });
    expect((await rule("road_rash")(db, player, mk())).evidence).toMatchObject({ incidents: 2 });
  });

  it("road_rash: not a car, not a driven bike, not someone else", async () => {
    await seedHit(db, { serverId, at: sec(0), victim: A, attackerLabel: "Hatchback_02_Blue", cause: "TransportHit" });
    await seedHit(db, { serverId, at: sec(1), victim: A, attacker: B, weapon: "TransportHit (Motorbike_02_Red)" });
    await seedHit(db, { serverId, at: sec(2), victim: B, attackerLabel: "Motorbike_02_Yellow", cause: "TransportHit" });
    expect(await rule("road_rash")(db, player, mk())).toMatchObject({ count: 0, target: 1 });
  });

  it("wipeout: a no-killer vehicle death whose entity is a motorbike; a car, or a driver's kill, is not", async () => {
    await seedKill(db, { serverId, killer: null, victim: A, at: h(0), cause: "vehicle", entity: "Hatchback_02_Blue" });
    await seedKill(db, { serverId, killer: B, victim: A, at: h(1), cause: "pvp", weapon: "TransportHit (Motorbike_02_Red)" });
    await seedKill(db, { serverId, killer: null, victim: B, at: h(2), cause: "vehicle", entity: "Motorbike_02_Yellow" });
    expect(await rule("wipeout")(db, player, mk())).toMatchObject({ count: 0, target: 1 });
    const k = await seedKill(db, { serverId, killer: null, victim: A, at: h(3), cause: "vehicle", entity: "Motorbike_02_Yellow" });
    expect(await rule("wipeout")(db, player, mk())).toMatchObject({ count: 1, earnedAt: h(3), evidenceId: k.id, evidence: { vehicle: "Motorbike_02_Yellow" } });
  });

  // ── Ruins (§2.7) ────────────────────────────────────────────────────────────

  const repair = (at: Date, part: string, who = A) =>
    seedEvent(db, { serverId, type: "base.built", at, payload: { dayzId: who, gamertag: "Ann", part, structure: null, tool: "Hammer" } });
  const build = (at: Date, who = A) =>
    seedEvent(db, { serverId, type: "base.built", at, payload: { dayzId: who, gamertag: "Ann", part: "Wall", structure: "Fence", tool: "Hammer" } });

  it("squatter: the first ruin repair; a Fence build, or someone else's repair, earns no ruin tile", async () => {
    await build(h(0)); await repair(h(1), "door1_metal", B);
    for (const k of ["squatter", "rubble_rouser", "renovator", "fixer_upper"]) expect((await rule(k)(db, player, mk())).count).toBe(0);
    const r = await repair(h(2), "roof1");
    expect(await rule("squatter")(db, player, mk())).toMatchObject({ count: 1, earnedAt: h(2), evidenceId: r.id });
  });

  it("rubble_rouser: 10 rubble piles; 10 repairs that are not rubble do not earn it", async () => {
    for (let i = 0; i < 10; i++) await repair(h(i), i % 2 ? "door2_wood" : "wall1_window_wood");
    for (let i = 10; i < 19; i++) await repair(h(i), `rubble_rubble${i}`);
    expect(await rule("rubble_rouser")(db, player, mk())).toMatchObject({ count: 9, target: 10 });
    const tenth = await repair(h(30), "rubble_rubble1");
    expect(await rule("rubble_rouser")(db, player, mk())).toMatchObject({ count: 10, earnedAt: h(30), evidenceId: tenth.id });
  });

  it("renovator: 25 ruin repairs of any part, each line one repair; builds do not count", async () => {
    for (let i = 0; i < 30; i++) await build(h(i));
    for (let i = 0; i < 24; i++) await repair(h(40 + i), i % 3 ? "rubble_rubble1" : "ladder_rebuild");
    expect(await rule("renovator")(db, player, mk())).toMatchObject({ count: 24, target: 25 });
    await repair(h(70), "rubble_rubble1");
    expect(await rule("renovator")(db, player, mk())).toMatchObject({ count: 25, earnedAt: h(70) });
  });

  it("fixer_upper: earned at the repair that completes door, window and roof; walls with windows are walls", async () => {
    await repair(h(0), "door1_metal"); await repair(h(1), "door2_wood");
    await repair(h(2), "wall2_window_wood"); await repair(h(3), "wall1_door_wood"); await repair(h(4), "rubble_rubble1");
    await repair(h(5), "roof1");
    expect(await rule("fixer_upper")(db, player, mk())).toMatchObject({ count: 0, target: 1 });
    const w = await repair(h(6), "window4_metal");
    await repair(h(7), "window1_wood");
    expect(await rule("fixer_upper")(db, player, mk())).toMatchObject({ count: 1, earnedAt: h(6), evidenceId: w.id });
  });

  // ── Traps and explosives (§2.8) ─────────────────────────────────────────────

  it.each([["snapped", "BearTrap"], ["tripped", "TripwireTrap"]])("%s: hit by a %s", async (key, label) => {
    await seedHit(db, { serverId, at: sec(0), victim: B, attackerLabel: label });
    await seedHit(db, { serverId, at: sec(1), victim: A, attackerLabel: "Fence", cause: "BarbedWireHit" });
    expect((await rule(key)(db, player, mk())).count).toBe(0);
    const hit = await seedHit(db, { serverId, at: sec(5), victim: A, attackerLabel: label });
    expect(await rule(key)(db, player, mk())).toMatchObject({ count: 1, earnedAt: sec(5), evidenceId: hit.id });
  });

  it("snagged: a BarbedWireHit from a fence, watchtower or gate; a bear trap or a dog is not", async () => {
    await seedHit(db, { serverId, at: sec(0), victim: A, attackerLabel: "BearTrap" });
    await seedHit(db, { serverId, at: sec(1), victim: A, attackerLabel: "Doberman" });
    await seedHit(db, { serverId, at: sec(2), victim: B, attackerLabel: "Fence", cause: "BarbedWireHit" });
    expect((await rule("snagged")(db, player, mk())).count).toBe(0);
    const hit = await seedHit(db, { serverId, at: sec(3), victim: A, attackerLabel: "Watchtower", cause: "BarbedWireHit" });
    expect(await rule("snagged")(db, player, mk())).toMatchObject({ count: 1, earnedAt: sec(3), evidenceId: hit.id });
  });

  it("minesweeper: a no-killer death whose entity is a land mine or claymore; a grenade, or a credited kill, is not", async () => {
    await seedKill(db, { serverId, killer: null, victim: A, at: h(0), cause: "explosion", entity: "M67Grenade" });
    await seedKill(db, { serverId, killer: B, victim: A, at: h(1), cause: "explosion", entity: "LandMineTrap" });
    await seedKill(db, { serverId, killer: null, victim: B, at: h(2), cause: "explosion", entity: "Claymore" });
    expect(await rule("minesweeper")(db, player, mk())).toMatchObject({ count: 0, target: 1 });
    // ⚠️ `killed by LandMineTrap` is filed "environment", not "explosion" (EXPLOSION_RE's `mine\b`
    // cannot match inside "MineTrap"), so the rule must read the entity, never the cause.
    const k = await seedKill(db, { serverId, killer: null, victim: A, at: h(3), cause: "environment", entity: "LandMineTrap" });
    expect(await rule("minesweeper")(db, player, mk())).toMatchObject({ count: 1, earnedAt: h(3), evidenceId: k.id, evidence: { entity: "LandMineTrap" } });
  });

  it("minesweeper: a claymore death counts too", async () => {
    const k = await seedKill(db, { serverId, killer: null, victim: A, at: h(3), cause: "explosion", entity: "Claymore" });
    expect(await rule("minesweeper")(db, player, mk())).toMatchObject({ count: 1, earnedAt: h(3), evidenceId: k.id, evidence: { entity: "Claymore" } });
  });

  it("frag_out: a no-killer explosion death by a grenade entity; a mine, plastic or a credited kill is not", async () => {
    await seedKill(db, { serverId, killer: null, victim: A, at: h(0), cause: "explosion", entity: "LandMineTrap" });
    await seedKill(db, { serverId, killer: null, victim: A, at: h(1), cause: "explosion", entity: "Plastic" });
    await seedKill(db, { serverId, killer: B, victim: A, at: h(2), cause: "explosion", entity: "RGD" });
    await seedKill(db, { serverId, killer: null, victim: A, at: h(3), cause: "environment", entity: null });   // not an explosion
    expect(await rule("frag_out")(db, player, mk())).toMatchObject({ count: 0, target: 1 });
    const k = await seedKill(db, { serverId, killer: null, victim: A, at: h(4), cause: "explosion", entity: "6" });   // "6-M7 Frag Grenade", cut at the hyphen
    expect(await rule("frag_out")(db, player, mk())).toMatchObject({ count: 1, earnedAt: h(4), evidenceId: k.id });
  });

  it("frag_out: an M79 death with the thrower lost (`killed by  with 40mm …`, null entity) counts", async () => {
    const k = await seedKill(db, { serverId, killer: null, victim: A, at: h(1), cause: "explosion", entity: null });
    expect(await rule("frag_out")(db, player, mk())).toMatchObject({ count: 1, earnedAt: h(1), evidenceId: k.id });
    expect((await rule("minesweeper")(db, player, mk())).count).toBe(0);
  });

  // ── Camp (§2.9) ─────────────────────────────────────────────────────────────

  const placed = (at: Date, item: string, who = A) =>
    seedEvent(db, { serverId, type: "item.placed", at, payload: { dayzId: who, gamertag: "Ann", item, itemClass: item.replace(/ /gu, ""), pos: { x: 1, y: 2, z: 3 } } });
  const packed = (at: Date, item: string, who = A) =>
    seedEvent(db, { serverId, type: "item.packed", at, payload: { dayzId: who, gamertag: "Ann", item, pos: { x: 1, y: 2, z: 3 } } });

  it("barrel_hoarder: 10 barrels placed; other items and other players do not count", async () => {
    await placed(h(0), "Sea Chest"); await placed(h(1), "Barrel", B); await placed(h(2), "Wooden Crate");
    for (let i = 0; i < 9; i++) await placed(h(10 + i), "Barrel");
    expect(await rule("barrel_hoarder")(db, player, mk())).toMatchObject({ count: 9, target: 10 });
    const tenth = await placed(h(30), "Barrel");
    expect(await rule("barrel_hoarder")(db, player, mk())).toMatchObject({ count: 10, earnedAt: h(30), evidenceId: tenth.id });
  });

  it("pack_up: 10 tents packed, any kind in TENTS; a packed non-tent, or a placed tent, does not count", async () => {
    await packed(h(0), "Garden Plot"); await placed(h(1), "Large Tent"); await packed(h(2), "Large Tent", B);
    const kinds = ["Large Tent", "Car Tent", "Medium Tent", "Improvised Shelter", "Tarp Shelter", "Party Tent", "Canopy Tent"];
    for (let i = 0; i < 9; i++) await packed(h(10 + i), kinds[i % kinds.length]!);
    expect(await rule("pack_up")(db, player, mk())).toMatchObject({ count: 9, target: 10 });
    const tenth = await packed(h(30), "Medium Tent");
    expect(await rule("pack_up")(db, player, mk())).toMatchObject({ count: 10, earnedAt: h(30), evidenceId: tenth.id });
  });

  it.each([["sea_legs", "Sea Chest"], ["minefield", "Land Mine"]])("%s: place a %s", async (key, item) => {
    await placed(h(0), "Barrel"); await placed(h(1), item, B); await packed(h(2), item);
    expect((await rule(key)(db, player, mk())).count).toBe(0);
    const e = await placed(h(3), item);
    expect(await rule(key)(db, player, mk())).toMatchObject({ count: 1, earnedAt: h(3), evidenceId: e.id });
  });
});
