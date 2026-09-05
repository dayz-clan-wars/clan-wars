import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events, identityLinks, factions, declarations, ceremonies, ceremonyParticipants, type Database } from "@factions/db";
import { appendEvent } from "@factions/event-log";
import { sql, eq, and, asc } from "drizzle-orm";
import { PgCeremonyStore } from "../src/ceremony-store.js";
import { ceremonyTick } from "../src/ceremony-tick.js";

const URL = requireTestDatabaseUrl();
const UIDS = ["A", "B", "C", "D"].map((c) => c.repeat(40));
const POLE = "1:2:3";
const T0 = new Date("2026-08-31T12:00:00Z");
const at = (m: number) => new Date(T0.getTime() + m * 60_000);

describe("ceremonyTick", () => {
  let db: Database;
  let store: PgCeremonyStore;
  let serverId = 0;
  let admFileId = 0;
  let line = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    // SET LOCAL shares the truncate's connection (the pool hands out any
    // connection, and the setting reverts at commit), so the dozens of
    // "truncate cascades to ..." NOTICEs stay out of the suite's output and a
    // genuine warning is visible when one appears.
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table ceremony_participants, ceremonies, white_raises, faction_members, claim_drafts, factions, identity_links, consumer_cursors, events, raw_lines, adm_files, servers restart identity cascade`);
    });
    store = new PgCeremonyStore(db);
    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: T0 }).returning();
    admFileId = f!.id;
    line = 0;
    for (const [i, uid] of UIDS.entries()) {
      await db.insert(identityLinks).values({ discordId: `10${i}`, dayzId: uid, gamertag: `P${i}`, verifiedAt: T0 });
    }
  });

  const raise = (dayzId: string, minutes: number, texture = "Flag_White", poleKey = POLE) =>
    appendEvent(db, {
      serverId, admFileId, lineIndex: line++, subIndex: 0,
      type: "flag.raised", occurredAt: at(minutes),
      payload: { gamertag: "Steve", dayzId, texture, action: "raised", poleKey, pole: { x: 1, y: 2, z: 3 } },
    });

  const tick = (now = at(60)) => ceremonyTick(db, store, { batchSize: 100, now });

  // The pole binding lives in `declarations`, not on `factions`, since this
  // branch's schema change. `isPoleBound`/`reservedFactionAt` read it there —
  // Task 9's shared seed helper doesn't exist yet, so this is the minimal
  // local fixture for it.
  const declareFor = async (owner: { factionId: number } | { dayzId: string }, poleKey = POLE, at_ = T0) => {
    const [ev] = await db.insert(events).values({
      serverId, admFileId, lineIndex: line++, subIndex: 0,
      type: "flag.raised", occurredAt: at_, payload: {},
    }).returning();
    await db.insert(declarations).values({
      serverId, poleKey, x: "1.00", y: "2.00", z: "3.00",
      ownerFactionId: "factionId" in owner ? owner.factionId : null,
      ownerDayzId: "dayzId" in owner ? owner.dayzId : null,
      evidenceEventId: ev!.id, declaredAt: at_,
    });
  };

  const participantsOf = async (ceremonyId: number) =>
    (await db.select().from(ceremonyParticipants).where(eq(ceremonyParticipants.ceremonyId, ceremonyId)))
      .map((p) => p.dayzId).sort();

  // For the solo-declarant tests: cite an actual seeded raise as the
  // declaration's evidence, rather than inventing a fresh event — the CHECK
  // constraint just wants an events row, but this keeps the fixture honest.
  const firstRaiseEventId = async () => {
    const [e] = await db.select({ id: events.id }).from(events)
      .where(and(eq(events.serverId, serverId), eq(events.type, "flag.raised")))
      .orderBy(asc(events.id));
    return e!.id;
  };

  it("detects three linked UIDs raising White at one pole", async () => {
    await raise(UIDS[0]!, 0);
    await raise(UIDS[1]!, 1);
    await raise(UIDS[2]!, 2);
    await raise(UIDS[0]!, 20); // advances the high-water mark past the window
    const r = await tick();
    expect(r.detected).toBe(1);
    const [c] = await db.select().from(ceremonies);
    expect(await participantsOf(c!.id)).toEqual([UIDS[0], UIDS[1], UIDS[2]].sort());
  });

  it("settles a ceremony at a pole declared to one of the participants", async () => {
    await raise(UIDS[0]!, 0);
    await raise(UIDS[1]!, 1);
    await raise(UIDS[2]!, 2);
    await raise(UIDS[0]!, 20); // advances the high-water mark past the window
    // Declared to A, who stands among the three raisers below — a solo's own
    // pole is eligible for a ceremony as long as the solo is present in it.
    await db.insert(declarations).values({
      serverId, poleKey: POLE, x: "1.00", y: "2.00", z: "3.00",
      ownerDayzId: UIDS[0]!, evidenceEventId: await firstRaiseEventId(), declaredAt: T0,
    });
    const r = await tick();
    expect(r.detected).toBe(1);
  });

  it("⚠️ refuses a ceremony at a pole declared to someone absent — no takeover by ceremony", async () => {
    await raise(UIDS[0]!, 0);
    await raise(UIDS[1]!, 1);
    await raise(UIDS[2]!, 2);
    await raise(UIDS[0]!, 20); // advances the high-water mark past the window
    // Declared to a solo who is NOT among the raisers below — three strangers
    // must not be able to take a base from under its sleeping owner.
    await db.insert(declarations).values({
      serverId, poleKey: POLE, x: "1.00", y: "2.00", z: "3.00",
      ownerDayzId: "Z".repeat(40), evidenceEventId: await firstRaiseEventId(), declaredAt: T0,
    });
    const r = await tick();
    expect(r.detected).toBe(0);
  });

  it("includes a fourth participant who arrives at minute nine", async () => {
    for (const [i, m] of [0, 1, 2, 9].entries()) await raise(UIDS[i]!, m);
    await raise(UIDS[0]!, 20);
    await tick();
    const [c] = await db.select().from(ceremonies);
    expect(await participantsOf(c!.id)).toHaveLength(4);
  });

  it("does not detect two linked UIDs", async () => {
    await raise(UIDS[0]!, 0);
    await raise(UIDS[1]!, 1);
    await raise(UIDS[0]!, 20);
    expect((await tick()).detected).toBe(0);
  });

  it("does not count an unlinked UID", async () => {
    // Only linked players can found a faction: every participant must be
    // reachable by DM, and the claimant check must be a lookup, not trust.
    await db.delete(identityLinks).where(eq(identityLinks.dayzId, UIDS[2]!));
    await raise(UIDS[0]!, 0);
    await raise(UIDS[1]!, 1);
    await raise(UIDS[2]!, 2);
    await raise(UIDS[0]!, 20);
    expect((await tick()).detected).toBe(0);
  });

  it("ignores raises of a claimable flag", async () => {
    for (const [i, m] of [0, 1, 2].entries()) await raise(UIDS[i]!, m, "Flag_Zenit");
    await raise(UIDS[0]!, 20, "Flag_Zenit");
    expect((await tick()).recorded).toBe(0);
  });

  it("ignores a pole already bound to a faction", async () => {
    const [f] = await db.insert(factions).values({
      serverId, name: "N", tag: "N", texture: "Flag_Bear",
      status: "active", leaderDiscordId: "999", createdAt: T0,
    }).returning();
    await declareFor({ factionId: f!.id });
    for (const [i, m] of [0, 1, 2].entries()) await raise(UIDS[i]!, m);
    await raise(UIDS[0]!, 20);
    expect((await tick()).recorded).toBe(0);
  });

  it("does not detect three UIDs spread across eleven minutes", async () => {
    await raise(UIDS[0]!, 0);
    await raise(UIDS[1]!, 5);
    await raise(UIDS[2]!, 11);
    await raise(UIDS[0]!, 40);
    expect((await tick()).detected).toBe(0);
  });

  it("treats a pole bound outside hasOpenCeremony's view as still ineligible", async () => {
    // Regression for: a ceremony opens at P and more raises land at P; the
    // ceremony gets claimed (status -> 'claimed'), which drops it out of the
    // PARTIAL `ceremonies_open_pole_uniq` index (provisional-only), so
    // `hasOpenCeremony(P)` now reports false even though P belongs to a
    // claimed faction. The still-pending raises from before the claim must
    // not settle into a second ceremony at that now-bound pole — such a
    // ceremony could never be claimed, colliding with
    // `factions_holding_pole_uniq`.
    //
    // The pole must still be FREE while the raises are recorded — phase 1's
    // own `isPoleBound` check would otherwise skip recording them entirely,
    // and phase 2 would then have nothing pending to prove anything with.
    // So: record while free, tick once at a point where the window is not
    // yet settleable (raises land as pending, nothing settles), THEN bind
    // the pole, THEN advance the log past the window and tick again.
    await raise(UIDS[0]!, 0);
    await raise(UIDS[1]!, 1);
    await raise(UIDS[2]!, 2);

    // First tick: log hasn't reached the window's end yet, so the raises are
    // recorded but not yet settleable. Assert they are in fact pending —
    // this is what makes the rest of the test honest.
    const first = await tick(at(2));
    expect(first.recorded).toBe(3);
    expect(first.detected).toBe(0);
    expect(await store.pendingRaises({ serverId, poleKey: POLE })).toHaveLength(3);

    // Now the pole becomes bound — after the raises were already recorded as
    // pending, exactly as it would after a claim.
    const [f] = await db.insert(factions).values({
      serverId, name: "N", tag: "N", texture: "Flag_Bear",
      status: "reserved", leaderDiscordId: "999", createdAt: T0,
      reservedUntil: at(60 * 24),
    }).returning();
    await declareFor({ factionId: f!.id }, POLE, at(2));
    await raise(UIDS[0]!, 20); // advances the high-water mark past the window; skipped from recording, but that's fine — it only needs to move highWaterMark
    const second = await tick(at(20));
    expect(second.detected).toBe(0);
    expect(await db.select().from(ceremonies)).toHaveLength(0);
    expect(await store.pendingRaises({ serverId, poleKey: POLE })).toHaveLength(0);
  });

  it("does not settle a window the log has not yet advanced past", async () => {
    // The high-water mark is the newest EVENT time. With no event after the
    // window, the participant set is still unknown.
    await raise(UIDS[0]!, 0);
    await raise(UIDS[1]!, 1);
    await raise(UIDS[2]!, 2);
    const r = await tick(at(999));
    expect(r.recorded).toBe(3);
    expect(r.detected).toBe(0);
  });

  it("opens no second ceremony at a pole that already has one outstanding", async () => {
    for (const [i, m] of [0, 1, 2].entries()) await raise(UIDS[i]!, m);
    await raise(UIDS[0]!, 20);
    await tick();
    for (const [i, m] of [0, 1, 2].entries()) await raise(UIDS[i]!, m + 30);
    await raise(UIDS[0]!, 60);
    const r = await tick(at(90));
    expect(r.detected).toBe(0);
    expect(await db.select().from(ceremonies)).toHaveLength(1);
  });

  it("is idempotent: a second tick over the same events detects nothing new", async () => {
    for (const [i, m] of [0, 1, 2].entries()) await raise(UIDS[i]!, m);
    await raise(UIDS[0]!, 20);
    await tick();
    expect((await tick()).detected).toBe(0);
    expect(await db.select().from(ceremonies)).toHaveLength(1);
  });

  it("expires a provisional ceremony once both clocks pass its deadline", async () => {
    for (const [i, m] of [0, 1, 2].entries()) await raise(UIDS[i]!, m);
    await raise(UIDS[0]!, 20);
    await tick();
    await raise(UIDS[0]!, 60 * 48); // log advances two days
    await tick(at(60 * 48));
    const [c] = await db.select().from(ceremonies);
    expect(c?.status).toBe("expired");
  });

  // ⚠️ `settle` refuses to invent coordinates for a pole key it cannot parse,
  // and it is right to. But that throw used to escape ceremonyTick entirely:
  // phase 3 (expiry AND reservation lapse) never ran, and because the poisoned
  // raises were never consumed the same pole threw again on the next tick, and
  // every tick after — forever, for every server. Every reserved faction then
  // held its flag, tag and pole out of the 33-slot pool permanently, which is
  // exactly the failure the reservation lifecycle exists to prevent.
  //
  // The key is reachable: an unvalidated altitude of DayZ's off-map sentinel
  // renders through toFixed(2) as e-notation, which parsePoleKey rejects.
  const POISON = "3000.00:-3.4028234663852886e+38:1100.00";

  it("settles a healthy pole even when another pole's key cannot be parsed", async () => {
    for (const [i, m] of [0, 1, 2].entries()) await raise(UIDS[i]!, m, "Flag_White", POISON);
    for (const [i, m] of [0, 1, 2].entries()) await raise(UIDS[i]!, m);
    await raise(UIDS[0]!, 20);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await tick();
    expect(r.detected).toBe(1);
    expect((await db.select().from(ceremonies)).map((c) => c.poleKey)).toEqual([POLE]);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("still expires and lapses when a pole key cannot be parsed", async () => {
    const [f] = await db.insert(factions).values({
      serverId, name: "N", tag: "N", texture: "Flag_Bear",
      status: "reserved", leaderDiscordId: "999",
      createdAt: T0, reservedUntil: at(10),
    }).returning();
    const [c] = await db.insert(ceremonies).values({
      serverId, poleKey: "8:8:8", x: "8.00", y: "8.00", z: "8.00",
      windowStart: T0, windowEnd: T0, status: "provisional",
      detectedAt: T0, expiresAt: at(10),
    }).returning();

    // A poisoned pole with a settleable window, sitting in phase 2 ahead of
    // phase 3.
    for (const [i, m] of [0, 1, 2].entries()) await raise(UIDS[i]!, m, "Flag_White", POISON);
    await raise(UIDS[0]!, 60 * 48, "Flag_White", POISON); // advances the log two days

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await tick(at(60 * 48));
    expect(r.lapsed).toBe(1);
    expect((await db.select().from(ceremonies).where(eq(ceremonies.id, c!.id)))[0]?.status).toBe("expired");
    expect((await db.select().from(factions).where(eq(factions.id, f!.id)))[0]?.status).toBe("lapsed");
    logged.mockRestore();
  });

  it("does not expire a ceremony the log has not caught up to", async () => {
    // Wall clock says 48h; the log has only reached minute 20. Expiring here
    // would retire a ceremony whose claim window we never actually observed.
    for (const [i, m] of [0, 1, 2].entries()) await raise(UIDS[i]!, m);
    await raise(UIDS[0]!, 20);
    await tick();
    await tick(new Date(T0.getTime() + 48 * 3_600_000));
    const [c] = await db.select().from(ceremonies);
    expect(c?.status).toBe("provisional");
  });
});
