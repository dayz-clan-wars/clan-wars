import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, identityLinks, factions, ceremonies, ceremonyParticipants, type Database } from "@factions/db";
import { appendEvent } from "@factions/event-log";
import { sql, eq } from "drizzle-orm";
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
    await db.execute(sql`truncate table ceremony_participants, ceremonies, white_raises, faction_members, claim_drafts, factions, identity_links, consumer_cursors, events, raw_lines, adm_files, servers restart identity cascade`);
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

  const participantsOf = async (ceremonyId: number) =>
    (await db.select().from(ceremonyParticipants).where(eq(ceremonyParticipants.ceremonyId, ceremonyId)))
      .map((p) => p.dayzId).sort();

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
    await db.insert(factions).values({
      serverId, name: "N", tag: "N", texture: "Flag_Bear", poleKey: POLE,
      x: "1.00", y: "2.00", z: "3.00", status: "active", leaderDiscordId: "999", createdAt: T0,
    });
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
