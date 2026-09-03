import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, factions, factionEvents, type Database } from "@factions/db";
import { asc, sql } from "drizzle-orm";
import { backfillFactionEvents } from "../src/feed-backfill.js";

const URL = requireTestDatabaseUrl();
const created = new Date("2026-09-01T21:30:07Z");
const activated = new Date("2026-09-01T22:54:15Z");

describe("backfillFactionEvents", () => {
  let db: Database;
  let serverId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table faction_events, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
  });

  const seed = (over: Partial<{ activatedAt: Date | null; status: string; tag: string; texture: string }> = {}) =>
    db.insert(factions).values({
      serverId, name: "Cokehead Kings", tag: over.tag ?? "COK",
      texture: over.texture ?? "Flag_Wolf",
      poleKey: `1:2:${over.tag ?? "COK"}`, x: "1", y: "2", z: "3",
      status: over.status ?? "active", leaderDiscordId: "d1",
      createdAt: created, activatedAt: over.activatedAt === undefined ? activated : over.activatedAt,
      // factions_reserved_has_deadline requires this whenever status is
      // "reserved"; irrelevant to what the backfill itself reads.
      reservedUntil: over.status === "reserved" ? new Date("2026-09-08T00:00:00Z") : null,
    }).returning();

  const events = () => db.select().from(factionEvents).orderBy(asc(factionEvents.id));

  it("writes founded and activated at their real times", async () => {
    await seed();
    expect(await backfillFactionEvents(db)).toEqual({ inserted: 2, skipped: 0 });

    const rows = await events();
    expect(rows.map((r) => r.kind)).toEqual(["founded", "activated"]);
    expect(rows[0]!.occurredAt).toEqual(created);
    expect(rows[1]!.occurredAt).toEqual(activated);
    expect(rows[0]!.payload).toMatchObject({ name: "Cokehead Kings", tag: "COK" });
  });

  it("writes only founded for a faction that never activated", async () => {
    await seed({ activatedAt: null, status: "reserved" });
    expect(await backfillFactionEvents(db)).toEqual({ inserted: 1, skipped: 0 });
    expect((await events()).map((r) => r.kind)).toEqual(["founded"]);
  });

  it("⚠️ is a no-op on a second run", async () => {
    // Run twice by accident during a deploy and the channel gets every
    // founding announced a second time.
    await seed();
    await backfillFactionEvents(db);
    expect(await backfillFactionEvents(db)).toEqual({ inserted: 0, skipped: 1 });
    expect(await events()).toHaveLength(2);
  });

  it("⚠️ leaves the rows queued rather than posted", async () => {
    // The backfill's whole delivery mechanism is the ordinary feed tick.
    await seed();
    await backfillFactionEvents(db);
    expect((await events()).every((r) => r.postedAt === null)).toBe(true);
  });

  it("⚠️ carries no coordinates, even though the faction row has them", async () => {
    await seed();
    await backfillFactionEvents(db);
    for (const row of await events()) {
      expect(JSON.stringify(row.payload)).not.toContain("1:2:");
    }
  });

  it("⚠️ skips a faction that is already half-backfilled, rather than completing it", async () => {
    // Simulates a run that crashed between the `founded` and `activated`
    // inserts (the case the per-faction transaction now prevents from being
    // CREATED). This is the honest boundary of the guarantee: the
    // transaction stops a half-write from ever landing, but if one already
    // exists — e.g. written before this fix shipped — the idempotence check
    // still can't tell "half" from "complete" and skips it like any other
    // faction that already has a row. It does not repair it.
    const [f] = await seed();
    await db.insert(factionEvents).values({
      serverId, factionId: f!.id, kind: "founded",
      occurredAt: created, payload: { name: f!.name, tag: f!.tag, texture: f!.texture },
    });

    expect(await backfillFactionEvents(db)).toEqual({ inserted: 0, skipped: 1 });
    expect((await events()).map((r) => r.kind)).toEqual(["founded"]);
  });
});
