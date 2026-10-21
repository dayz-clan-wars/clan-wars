import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { PVP_RULES, gunSet, ownPvpKills } from "../../src/achievements/rules-pvp.js";
import { makeCtx } from "../../src/achievements/types.js";
import { seedServer, seedKill, seedSession, seedRaid, seedDefense, seedFaction, seedSeason, seedHit, TRUNCATE } from "./seed.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(36), B = "B".repeat(36), C = "C".repeat(36);
const t0 = new Date("2026-08-01T10:00:00Z");
const m = (n: number) => new Date(t0.getTime() + n * 60_000);
const player = { kind: "player" as const, id: A };
const NOW = m(100_000);
const mk = () => makeCtx(NOW);
const rule = (k: string) => PVP_RULES[k as keyof typeof PVP_RULES]!;

describe("pvp rules", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => { await tx.execute(sql`set local client_min_messages = warning`); await tx.execute(sql.raw(TRUNCATE)); });
    serverId = (await seedServer(db)).id;
  });

  it("first_blood / ten_down / centurion: PvP kills only — friendly fire and being killed do not count", async () => {
    await seedKill(db, { serverId, killer: A, victim: B, at: m(0), friendlyFire: true });
    await seedKill(db, { serverId, killer: B, victim: A, at: m(1) });
    expect((await rule("first_blood")(db, player, mk())).count).toBe(0);
    for (let i = 0; i < 10; i++) await seedKill(db, { serverId, killer: A, victim: i % 2 ? B : C, at: m(10 + i), weapon: `W${i}`, distanceM: 20 });
    expect(await rule("first_blood")(db, player, mk())).toMatchObject({ count: 1, earnedAt: m(10) });
    expect(await rule("ten_down")(db, player, mk())).toMatchObject({ count: 10, earnedAt: m(19), evidence: { kills: 10 } });
    expect(await rule("centurion")(db, player, mk())).toMatchObject({ count: 10, target: 100 });
  });

  it("marksman / sniper / point_blank: by distance, first qualifying kill, distance in the evidence", async () => {
    await seedKill(db, { serverId, killer: A, victim: B, at: m(0), distanceM: 149.9 });
    await seedKill(db, { serverId, killer: A, victim: B, at: m(1), distanceM: null });
    expect(await rule("marksman")(db, player, mk())).toMatchObject({ count: 149, target: 150 });    // best so far, floored
    const far = await seedKill(db, { serverId, killer: A, victim: B, at: m(2), distanceM: 312.4, weapon: "Mosin" });
    expect(await rule("marksman")(db, player, mk())).toMatchObject({ count: 312, earnedAt: m(2), evidenceId: far.id, evidence: { distanceM: 312, weapon: "Mosin" } });
    expect(await rule("sniper")(db, player, mk())).toMatchObject({ count: 312, earnedAt: m(2) });
    expect((await rule("point_blank")(db, player, mk())).count).toBe(0);
    await seedKill(db, { serverId, killer: A, victim: B, at: m(3), distanceM: 4.9 });
    expect(await rule("point_blank")(db, player, mk())).toMatchObject({ count: 1, earnedAt: m(3) });
  });

  it("arsenal: distinct weapons, earned on the kill that brought the tenth", async () => {
    for (let i = 0; i < 12; i++) await seedKill(db, { serverId, killer: A, victim: B, at: m(i), weapon: `W${i % 10}` });
    expect(await rule("arsenal")(db, player, mk())).toMatchObject({ count: 10, earnedAt: m(9) });
  });

  it("hat_trick: three PvP kills inside one of the killer's sessions", async () => {
    await seedSession(db, { serverId, dayzId: A, from: m(0), to: m(60) });
    await seedSession(db, { serverId, dayzId: A, from: m(100), to: m(160) });
    await seedKill(db, { serverId, killer: A, victim: B, at: m(5) });
    await seedKill(db, { serverId, killer: A, victim: B, at: m(50) });
    await seedKill(db, { serverId, killer: A, victim: B, at: m(105) });
    await seedKill(db, { serverId, killer: A, victim: B, at: m(110), friendlyFire: true });
    expect(await rule("hat_trick")(db, player, mk())).toMatchObject({ count: 2, target: 3 });
    await seedKill(db, { serverId, killer: A, victim: C, at: m(55) });
    expect(await rule("hat_trick")(db, player, mk())).toMatchObject({ count: 3, earnedAt: m(55) });
  });

  it("killing_spree / unstoppable: the streak walk, reset by a PvP death", async () => {
    for (let i = 0; i < 4; i++) await seedKill(db, { serverId, killer: A, victim: B, at: m(i) });
    await seedKill(db, { serverId, killer: B, victim: A, at: m(4) });
    for (let i = 0; i < 5; i++) await seedKill(db, { serverId, killer: A, victim: C, at: m(10 + i) });
    expect(await rule("killing_spree")(db, player, mk())).toMatchObject({ count: 5, earnedAt: m(14) });
    expect(await rule("unstoppable")(db, player, mk())).toMatchObject({ count: 5, target: 10 });
  });

  it("nemesis: five kills of the same player", async () => {
    for (let i = 0; i < 4; i++) { await seedKill(db, { serverId, killer: A, victim: B, at: m(i) }); await seedKill(db, { serverId, killer: A, victim: C, at: m(100 + i) }); }
    expect(await rule("nemesis")(db, player, mk())).toMatchObject({ count: 4, target: 5 });
    await seedKill(db, { serverId, killer: A, victim: C, at: m(200) });
    expect(await rule("nemesis")(db, player, mk())).toMatchObject({ count: 5, earnedAt: m(200), evidence: { victim: C, kills: 5 } });
  });

  it("payback: killing your killer within an hour, not after", async () => {
    await seedKill(db, { serverId, killer: B, victim: A, at: m(0) });
    await seedKill(db, { serverId, killer: A, victim: B, at: m(61) });
    expect((await rule("payback")(db, player, mk())).count).toBe(0);
    await seedKill(db, { serverId, killer: C, victim: A, at: m(100) });
    const pay = await seedKill(db, { serverId, killer: A, victim: C, at: m(159) });
    expect(await rule("payback")(db, player, mk())).toMatchObject({ count: 1, earnedAt: m(159), evidenceId: pay.id });
  });

  it("flag_thief / home_defender / blue_on_blue", async () => {
    const bear = await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: t0, activatedAt: t0 });
    const wolf = await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", poleKey: "9000.00:100.00:9000.00", x: 9000, z: 9000, createdAt: t0, activatedAt: t0 });
    const season = await seedSeason(db, serverId, t0);
    expect((await rule("flag_thief")(db, player, mk())).count).toBe(0);
    await seedRaid(db, { serverId, seasonId: season.id, victimFactionId: wolf.id, raiderDayzId: A, raiderFactionId: bear.id, at: m(5) });
    expect(await rule("flag_thief")(db, player, mk())).toMatchObject({ count: 1, earnedAt: m(5) });
    await seedDefense(db, { serverId, factionId: bear.id, seasonId: season.id, raisedByDayzId: A, at: m(9), siegeSeconds: 3600 });
    expect(await rule("home_defender")(db, player, mk())).toMatchObject({ count: 1, earnedAt: m(9), evidence: { siegeSeconds: 3600 } });
    expect((await rule("blue_on_blue")(db, player, mk())).count).toBe(0);
    await seedKill(db, { serverId, killer: A, victim: B, at: m(20), friendlyFire: true });
    expect(await rule("blue_on_blue")(db, player, mk())).toMatchObject({ count: 1, earnedAt: m(20) });
  });

  it("Hub kills earn nothing: counts, distance, streaks, nemesis and payback all ignore them (spec 2026-09-22-hub-combat)", async () => {
    await seedKill(db, { serverId, killer: A, victim: B, at: m(0), distanceM: 400, atHub: true });
    expect((await rule("first_blood")(db, player, mk())).count).toBe(0);
    expect((await rule("sniper")(db, player, mk())).count).toBe(0);
    for (let i = 0; i < 5; i++) await seedKill(db, { serverId, killer: A, victim: B, at: m(10 + i), atHub: true });
    expect((await rule("nemesis")(db, player, mk())).count).toBe(0);
    expect((await rule("killing_spree")(db, player, mk())).count).toBe(0);
    await seedKill(db, { serverId, killer: B, victim: A, at: m(20), atHub: true });   // a Hub death is not "them killing you"
    await seedKill(db, { serverId, killer: A, victim: B, at: m(21) });
    expect((await rule("payback")(db, player, mk())).count).toBe(0);
  });

  it("a Hub death does not break a streak", async () => {
    for (let i = 0; i < 3; i++) await seedKill(db, { serverId, killer: A, victim: B, at: m(i) });
    await seedKill(db, { serverId, killer: B, victim: A, at: m(5), atHub: true });
    for (let i = 0; i < 2; i++) await seedKill(db, { serverId, killer: A, victim: C, at: m(10 + i) });
    expect((await rule("killing_spree")(db, player, mk())).count).toBe(5);
  });

  // ── The armory (spec 2026-10-20-achievements-150 §2.2, §2.3) ────────────────

  it("gun tile: the first scoring kill with that firearm, variants merged", async () => {
    await seedKill(db, { serverId, killer: A, victim: B, at: m(0), weapon: "KA-M", friendlyFire: true }); // does not count
    await seedKill(db, { serverId, killer: A, victim: B, at: m(1), weapon: "KA-M", atHub: true });       // does not count
    expect((await rule("gun_akm")(db, player, mk())).count).toBe(0);
    const k = await seedKill(db, { serverId, killer: A, victim: C, at: m(2), weapon: "KA-M", distanceM: 42 });
    await seedKill(db, { serverId, killer: A, victim: B, at: m(3), weapon: "KA-M", distanceM: 10 });
    expect(await rule("gun_akm")(db, player, mk())).toMatchObject({ count: 1, target: 1, earnedAt: m(2), evidenceId: k.id, evidence: { weapon: "KA-M" } });
    // A sawed-off counts toward its parent firearm, and a finish variant shares its gun's tile.
    await seedKill(db, { serverId, killer: A, victim: B, at: m(4), weapon: "Sawed-off Mosin 91/30", distanceM: 15 });
    await seedKill(db, { serverId, killer: A, victim: B, at: m(5), weapon: "Engraved Kolt 1911", distanceM: 8 });
    expect(await rule("gun_mosin")(db, player, mk())).toMatchObject({ count: 1, earnedAt: m(4) });
    expect(await rule("gun_colt1911")(db, player, mk())).toMatchObject({ count: 1, earnedAt: m(5) });
    // Someone else's kill with a gun earns the owner nothing.
    await seedKill(db, { serverId, killer: B, victim: C, at: m(6), weapon: "VSS", distanceM: 200 });
    expect((await rule("gun_vss")(db, player, mk())).count).toBe(0);
  });

  it("class tile: n of N, earned at the kill completing the class", async () => {
    await seedKill(db, { serverId, killer: A, victim: B, at: m(1), weapon: "VSD", distanceM: 300 });
    expect(await rule("class_snipers")(db, player, mk())).toMatchObject({ count: 1, target: 2 });
    expect((await rule("class_snipers")(db, player, mk())).earnedAt).toBeUndefined();
    const vss = await seedKill(db, { serverId, killer: A, victim: C, at: m(5), weapon: "VSS", distanceM: 120 });
    await seedKill(db, { serverId, killer: A, victim: C, at: m(9), weapon: "VSD", distanceM: 250 });   // a repeat changes nothing
    expect(await rule("class_snipers")(db, player, mk())).toMatchObject({ count: 2, target: 2, earnedAt: m(5), evidenceId: vss.id });
    expect(await rule("class_pistols")(db, player, mk())).toMatchObject({ count: 0, target: 12 });
  });

  it("full_armory progress is distinct firearms of 52", async () => {
    for (const [i, w] of ["KA-M", "VSD", "BK-133", "KA-M"].entries()) await seedKill(db, { serverId, killer: A, victim: B, at: m(i), weapon: w, distanceM: 30 });
    expect(await rule("full_armory")(db, player, mk())).toEqual({ count: 3, target: 52 });
  });

  it("gunSet is the owner's first scoring kill per firearm, read once per owner per pass", async () => {
    await seedKill(db, { serverId, killer: A, victim: B, at: m(0), weapon: "KA-M", distanceM: 30 });
    await seedKill(db, { serverId, killer: B, victim: A, at: m(1), weapon: "VSS", distanceM: 30 });
    const ctx = mk();
    const a = await gunSet(db, ctx, A);
    expect([...a.keys()]).toEqual(["akm"]);
    expect(await gunSet(db, ctx, A)).toBe(a);   // memoised
    // ⚠️ The memo key carries the owner: a second owner in one ctx gets their own kills, not A's.
    expect([...(await gunSet(db, ctx, B)).keys()]).toEqual(["vss"]);
    expect((await ownPvpKills(db, ctx, B)).map((k) => k.weapon)).toEqual(["VSS"]);
  });

  // ⚠️ "Once" is per PROCESS: the lookup's reported-names set is module-level, so these names
  // must not be warned about by any earlier test in this file, or the count here reads 0.
  it("an unmapped display name counts for nothing and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await seedKill(db, { serverId, killer: A, victim: B, at: m(0), weapon: "Mystery 9000", distanceM: 40 });
      await seedKill(db, { serverId, killer: A, victim: C, at: m(1), weapon: "Mystery 9000", distanceM: 41 });
      // A near-miss of a real name credits nothing either: no neighbouring gun.
      await seedKill(db, { serverId, killer: A, victim: C, at: m(2), weapon: "KA-M2", distanceM: 41 });
      // Melee and vehicle kills carry no range and are never guns: never warned about.
      await seedKill(db, { serverId, killer: A, victim: C, at: m(3), weapon: "Hunting Knife", distanceM: null });
      await seedKill(db, { serverId, killer: A, victim: C, at: m(4), weapon: "TransportHit (Motorbike_02_Red)", distanceM: null });
      // A known off-catalogue gun is deliberately unmapped: no tile, no warning.
      await seedKill(db, { serverId, killer: A, victim: C, at: m(5), weapon: "DMR", distanceM: 300 });
      expect((await rule("full_armory")(db, player, mk())).count).toBe(0);
      expect((await rule("gun_akm")(db, player, mk())).count).toBe(0);
      expect((await rule("full_armory")(db, player, mk())).count).toBe(0);   // a second pass: still one warning
      expect((await rule("arsenal")(db, player, mk())).count).toBe(5);       // Arsenal still counts the five raw strings
      const about = (name: string) => warn.mock.calls.filter((c) => String(c[0]).includes(JSON.stringify(name)));
      expect(about("Mystery 9000")).toHaveLength(1);
      expect(about("KA-M2")).toHaveLength(1);
      for (const n of ["Hunting Knife", "TransportHit (Motorbike_02_Red)", "DMR"]) expect(about(n)).toHaveLength(0);
    } finally { warn.mockRestore(); }
  });

  // ── Melee (spec 2026-10-20-achievements-150 §2.4) ───────────────────────────

  const melee = (at: Date, weapon: string, o: { victim?: string; friendlyFire?: boolean; atHub?: boolean; distanceM?: number | null } = {}) =>
    seedKill(db, { serverId, killer: A, victim: o.victim ?? B, at, weapon, distanceM: o.distanceM ?? null, friendlyFire: o.friendlyFire, atHub: o.atHub });

  it("knife_work / bare_knuckles / sledge: the first scoring kill with that weapon", async () => {
    await melee(m(0), "Hunting Knife", { friendlyFire: true });
    await melee(m(1), "(MeleeFist)", { atHub: true });
    await seedKill(db, { serverId, killer: B, victim: A, at: m(2), weapon: "Sledgehammer" });   // being killed with one is not this
    for (const k of ["knife_work", "bare_knuckles", "sledge"]) expect((await rule(k)(db, player, mk())).count).toBe(0);
    const knife = await melee(m(3), "Kukri");
    const fist = await melee(m(4), "(MeleeFist_Heavy)");
    const sledge = await melee(m(5), "Sledgehammer");
    await melee(m(6), "Combat Knife");
    expect(await rule("knife_work")(db, player, mk())).toMatchObject({ count: 1, earnedAt: m(3), evidenceId: knife.id, evidence: { weapon: "Kukri" } });
    expect(await rule("bare_knuckles")(db, player, mk())).toMatchObject({ count: 1, earnedAt: m(4), evidenceId: fist.id });
    expect(await rule("sledge")(db, player, mk())).toMatchObject({ count: 1, earnedAt: m(5), evidenceId: sledge.id });
  });

  it("melee_mix: 5 different melee weapons; fists are one, guns and ranged kills are none", async () => {
    await melee(m(0), "(MeleeFist)");
    await melee(m(1), "(MeleeFistHeavy)");
    await melee(m(2), "(MeleeFist_Heavy)");
    await melee(m(3), "Hunting Knife");
    await melee(m(4), "Hunting Knife", { victim: C });
    await melee(m(5), "Mystery 9000", { distanceM: 40 });        // an unmapped gun: it has a range, so not melee
    await seedKill(db, { serverId, killer: A, victim: B, at: m(6), weapon: "M4-A1", distanceM: 30 });
    await melee(m(7), "TransportHit (Motorbike_02_Red)");      // a bike is not a melee weapon
    await melee(m(8), "Pickaxe");
    await melee(m(9), "Hatchet", { friendlyFire: true });
    expect(await rule("melee_mix")(db, player, mk())).toMatchObject({ count: 3, target: 5 });
    await melee(m(10), "Farming Hoe");
    const fifth = await melee(m(11), "Sledgehammer");
    await melee(m(12), "Hatchet");
    expect(await rule("melee_mix")(db, player, mk())).toMatchObject({ count: 5, earnedAt: m(11), evidenceId: fifth.id });
  });

  // ── Motorbikes (§2.6) ───────────────────────────────────────────────────────

  it("roadkill: a scoring kill whose weapon is a motorbike; a car or a Hub kill is not", async () => {
    await melee(m(0), "TransportHit (Hatchback_02_Blue)");
    await melee(m(1), "TransportHit (Motorbike_02_Red)", { atHub: true });
    expect((await rule("roadkill")(db, player, mk())).count).toBe(0);
    const k = await melee(m(2), "TransportHit (Motorbike_01_Blue)");
    expect(await rule("roadkill")(db, player, mk())).toMatchObject({ count: 1, earnedAt: m(2), evidenceId: k.id, evidence: { vehicle: "Motorbike_01_Blue" } });
  });

  const sec = (n: number) => new Date(t0.getTime() + n * 1000);
  const ride = (at: Date, victim: string, weapon = "TransportHit (Motorbike_02_Red)", attacker = A) => seedHit(db, { serverId, at, victim, attacker, weapon });

  it("⚠️ hit_and_run: 30 identical lines in one second on one victim are one incident; another victim that second is another", async () => {
    await ride(sec(0), B, "TransportHit (Hatchback_02_Blue)");
    await ride(sec(1), A);                                         // your own bike on yourself is not hitting a player
    await ride(sec(2), A, "TransportHit (Motorbike_02_Red)", B);   // being hit is not this
    await seedHit(db, { serverId, at: sec(3), victim: A, attackerLabel: "Motorbike_02_Yellow", cause: "TransportHit" });
    expect((await rule("hit_and_run")(db, player, mk())).count).toBe(0);
    const first = await ride(sec(10), B);
    for (let i = 1; i < 30; i++) await ride(sec(10), B);
    expect(await rule("hit_and_run")(db, player, mk())).toMatchObject({ count: 1, earnedAt: sec(10), evidenceId: first.id, evidence: { incidents: 1 } });
    await ride(sec(10), C);
    expect((await rule("hit_and_run")(db, player, mk())).evidence).toMatchObject({ incidents: 2 });
  });
});
