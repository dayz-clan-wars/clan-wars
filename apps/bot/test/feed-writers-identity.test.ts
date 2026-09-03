import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl, factionEvents,
  factions, servers, factionMembers, identityLinks, players, type Database,
} from "@factions/db";
import { asc, sql } from "drizzle-orm";
import { PgRosterStore } from "../src/roster-store.js";
import { PgRebindStore } from "../src/rebind-store.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-03T12:00:00Z");

describe("identity changes write feed events", () => {
  let db: Database;
  let factionId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    // SET LOCAL shares the truncate's connection (the pool hands out any
    // connection, and the setting reverts at commit), so the dozens of
    // "truncate cascades to ..." NOTICEs stay out of the suite's output and a
    // genuine warning is visible when one appears.
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table faction_events, players, identity_links, faction_members, factions, servers restart identity cascade`);
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

    const [faction] = await db.insert(factions).values({
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear",
      poleKey: "1:2:3", x: "1", y: "2", z: "3", status: "active",
      leaderDiscordId: "d1", createdAt: now, activatedAt: now,
    }).returning();
    factionId = faction!.id;

    await db.insert(factionMembers).values([
      { factionId, serverId, dayzId: "u1", discordId: "d1", role: "leader", joinedAt: now },
    ]);
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
      factionId, leaderDiscordId: "d1", expectedPoleKey: "1:2:3",
      poleKey: "9:9:9", x: 9, y: 9, z: 9, at: now,
      notBefore: new Date(now.getTime() - 604_800_000),
    });
    expect(moved).toBe(true);

    const [e] = await events();
    expect(e!.kind).toBe("rebound");
    expect(e!.payload).toMatchObject({ name: "Bears", tag: "BEAR", actor: "Racer" });
    expect(JSON.stringify(e!.payload)).not.toContain("9:9:9");
  });

  it("⚠️ a dormant faction that rebinds writes rebound THEN revived", async () => {
    // Top-to-bottom the channel must read as a complete story: the move
    // happened (rebound), and its consequence is that the countdown is
    // cancelled and supplies resume (revived). Order is id order, so
    // rebound must be inserted first.
    await db.update(factions).set({ status: "dormant", dormantSince: now })
      .where(sql`${factions.id} = ${factionId}`);

    const moved = await new PgRebindStore(db).rebind({
      factionId, leaderDiscordId: "d1", expectedPoleKey: "1:2:3",
      poleKey: "9:9:9", x: 9, y: 9, z: 9, at: now,
      notBefore: new Date(now.getTime() - 604_800_000),
    });
    expect(moved).toBe(true);

    const rows = await events();
    expect(rows.map((r) => r.kind)).toEqual(["rebound", "revived"]);
    expect(rows[1]!.payload).toMatchObject({ name: "Bears", tag: "BEAR", actor: "Racer" });
  });

  it("an active faction that rebinds writes only rebound", async () => {
    const moved = await new PgRebindStore(db).rebind({
      factionId, leaderDiscordId: "d1", expectedPoleKey: "1:2:3",
      poleKey: "9:9:9", x: 9, y: 9, z: 9, at: now,
      notBefore: new Date(now.getTime() - 604_800_000),
    });
    expect(moved).toBe(true);
    expect((await events()).map((r) => r.kind)).toEqual(["rebound"]);
  });

  it("writes no rebound row when the optimistic pole guard fails", async () => {
    expect(await new PgRebindStore(db).rebind({
      factionId, leaderDiscordId: "d1", expectedPoleKey: "somewhere-else",
      poleKey: "9:9:9", x: 9, y: 9, z: 9, at: now,
      notBefore: new Date(now.getTime() - 604_800_000),
    })).toBe(false);
    expect(await events()).toHaveLength(0);
  });
});
