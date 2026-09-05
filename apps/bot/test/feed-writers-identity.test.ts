import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl, factionEvents,
  factions, servers, factionMembers, identityLinks, players, admFiles, events as eventLog,
  type Database,
} from "@factions/db";
import { asc, sql } from "drizzle-orm";
import { seedFaction } from "./seed.js";
import { PgRosterStore } from "../src/roster-store.js";
import { PgRebindStore } from "../src/rebind-store.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-03T12:00:00Z");

// ⚠️ Both ≥ 200 m from the Hub at (100, 93) and from each other. The seed
// helper's direct insert would tolerate anything, but `rebind` goes through
// `declareTx`, which enforces MIN_BASE_SPACING_M — the old (1,2,3)/(9,9,9)
// fixture sits ~124 m from the Hub and every rebind here would be refused.
const HOME = { x: 10000, y: 100, z: 10000 };
const AWAY = { x: 20000, y: 100, z: 20000 };
const HOME_KEY = "10000.00:100.00:10000.00";
const AWAY_KEY = "20000.00:100.00:20000.00";

describe("identity changes write feed events", () => {
  let db: Database;
  let factionId = 0;
  /** The `flag.raised` at AWAY that every rebind below cites as its evidence. */
  let awayEventId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    // SET LOCAL shares the truncate's connection (the pool hands out any
    // connection, and the setting reverts at commit), so the dozens of
    // "truncate cascades to ..." NOTICEs stay out of the suite's output and a
    // genuine warning is visible when one appears.
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table faction_events, players, identity_links, faction_members, declarations, poles, events, adm_files, factions, servers restart identity cascade`);
    });

    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    const serverId = s!.id;

    // A linked leader: identity_links carries the verification-time
    // gamertag, players carries the current one. actorGamertagTx prefers the
    // latter, so both rows share the same value here — "Racer" — to match
    // the brief's assertions.
    await db.insert(identityLinks).values({
      discordId: "d1", dayzId: "u1", gamertag: "Racer", verifiedAt: now,
    });
    await db.insert(players).values({
      dayzId: "u1", gamertag: "Racer", firstSeenAt: now, lastSeenAt: now,
    });

    const faction = await seedFaction(db, {
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear",
      poleKey: HOME_KEY, x: HOME.x, y: HOME.y, z: HOME.z,
      status: "active", leaderDiscordId: "d1", createdAt: now, activatedAt: now,
    });
    factionId = faction.id;

    await db.insert(factionMembers).values([
      { factionId, serverId, dayzId: "u1", discordId: "d1", role: "leader", joinedAt: now },
    ]);

    // The raise at AWAY. `declareTx` requires real evidence for the new
    // binding, so a rebind can no longer name a pole out of thin air.
    const [adm] = await db.insert(admFiles).values({
      serverId, filename: "away.ADM", bootAt: now,
    }).returning();
    const [raise] = await db.insert(eventLog).values({
      serverId, admFileId: adm!.id, lineIndex: 0, type: "flag.raised", occurredAt: now,
      payload: { dayzId: "u1", gamertag: "Racer", texture: "Flag_Bear", poleKey: AWAY_KEY, pole: AWAY },
    }).returning();
    awayEventId = raise!.id;
  });

  const events = () => db.select().from(factionEvents).orderBy(asc(factionEvents.id));

  it("⚠️ writes renamed carrying BOTH names", async () => {
    // Read live at post time, both halves would resolve to the current name
    // and the post would degenerate to "X renamed to X".
    const outcome = await new PgRosterStore(db).rename({
      factionId, discordId: "d1", name: "Wolves", at: now, notBefore: now,
    });
    expect(outcome).toBe("ok");

    const [e] = await events();
    expect(e!.kind).toBe("renamed");
    expect(e!.payload).toMatchObject({ name: "Wolves", previousName: "Bears", actor: "Racer" });
  });

  it("writes no renamed row when the caller is not the leader", async () => {
    expect(await new PgRosterStore(db).rename({
      factionId, discordId: "someone-else", name: "Wolves", at: now, notBefore: now,
    })).toBe("not-leader");
    expect(await events()).toHaveLength(0);
  });

  it("writes no renamed row when the cooldown rejects", async () => {
    const store = new PgRosterStore(db);
    await store.rename({ factionId, discordId: "d1", name: "Wolves", at: now, notBefore: now });
    const second = await store.rename({
      factionId, discordId: "d1", name: "Bears Again", at: now,
      notBefore: new Date(now.getTime() - 604_800_000),
    });
    expect(second).toBe("cooldown");
    expect(await events()).toHaveLength(1);
  });

  it("⚠️ writes rebound with no coordinates at all", async () => {
    // The constraint would reject them, but the payload must not carry them
    // in the first place: rebind is the one transition whose whole subject
    // is a location.
    const moved = await new PgRebindStore(db).rebind({
      factionId, leaderDiscordId: "d1", expectedPoleKey: HOME_KEY,
      poleKey: AWAY_KEY, x: AWAY.x, y: AWAY.y, z: AWAY.z, evidenceEventId: awayEventId, at: now,
      notBefore: new Date(now.getTime() - 604_800_000),
    });
    expect(moved).toBe("ok");

    const [e] = await events();
    expect(e!.kind).toBe("rebound");
    expect(e!.payload).toMatchObject({ name: "Bears", tag: "BEAR", actor: "Racer" });
    expect(JSON.stringify(e!.payload)).not.toContain(AWAY_KEY);
    expect(JSON.stringify(e!.payload)).not.toContain(HOME_KEY);
  });

  it("⚠️ a dormant faction that rebinds writes rebound THEN revived", async () => {
    // Top-to-bottom the channel must read as a complete story: the move
    // happened (rebound), and its consequence is that the countdown is
    // cancelled and supplies resume (revived). Order is id order, so
    // rebound must be inserted first.
    await db.update(factions).set({ status: "dormant", dormantSince: now })
      .where(sql`${factions.id} = ${factionId}`);

    const moved = await new PgRebindStore(db).rebind({
      factionId, leaderDiscordId: "d1", expectedPoleKey: HOME_KEY,
      poleKey: AWAY_KEY, x: AWAY.x, y: AWAY.y, z: AWAY.z, evidenceEventId: awayEventId, at: now,
      notBefore: new Date(now.getTime() - 604_800_000),
    });
    expect(moved).toBe("ok");

    const rows = await events();
    expect(rows.map((r) => r.kind)).toEqual(["rebound", "revived"]);
    expect(rows[1]!.payload).toMatchObject({ name: "Bears", tag: "BEAR", actor: "Racer" });
  });

  it("an active faction that rebinds writes only rebound", async () => {
    const moved = await new PgRebindStore(db).rebind({
      factionId, leaderDiscordId: "d1", expectedPoleKey: HOME_KEY,
      poleKey: AWAY_KEY, x: AWAY.x, y: AWAY.y, z: AWAY.z, evidenceEventId: awayEventId, at: now,
      notBefore: new Date(now.getTime() - 604_800_000),
    });
    expect(moved).toBe("ok");
    expect((await events()).map((r) => r.kind)).toEqual(["rebound"]);
  });

  it("writes no rebound row when the optimistic pole guard fails", async () => {
    expect(await new PgRebindStore(db).rebind({
      factionId, leaderDiscordId: "d1", expectedPoleKey: "somewhere-else",
      poleKey: AWAY_KEY, x: AWAY.x, y: AWAY.y, z: AWAY.z, evidenceEventId: awayEventId, at: now,
      notBefore: new Date(now.getTime() - 604_800_000),
    })).toBe("refused");
    expect(await events()).toHaveLength(0);
  });
});
