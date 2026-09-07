import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, poles, type Database } from "@factions/db";
import { sql, eq, asc } from "drizzle-orm";
import { NEW_POLE_GRACE_MS } from "@factions/domain";
import { stampLaunchGrace } from "../src/launch.js";

const URL = requireTestDatabaseUrl();
const seen = new Date("2026-08-20T12:00:00Z");
const launchAt = new Date("2026-09-12T00:00:00Z");

describe("the launch grace stamp", () => {
  let db: Database;
  let here = 0;
  let elsewhere = 0;

  const seedPole = (serverId: number, poleKey: string, raised: boolean) =>
    db.insert(poles).values({
      serverId, map: "livonia", poleKey, x: "5000.00", y: "100.00", z: "5000.00",
      currentTexture: raised ? "Flag_Wolf" : "Flag_White", flagRaised: raised,
      firstSeenAt: seen, lastSeenAt: seen, graceUntil: new Date(seen.getTime() + NEW_POLE_GRACE_MS),
    });

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table poles, servers restart identity cascade`);
    });
    const [a] = await db.insert(servers).values({ name: "A", map: "livonia", clockOffsetMs: 0 }).returning();
    const [b] = await db.insert(servers).values({ name: "B", map: "livonia", clockOffsetMs: 0 }).returning();
    here = a!.id;
    elsewhere = b!.id;
    await seedPole(here, "5000_5000", true);
    await seedPole(here, "6000_6000", false);
    await seedPole(elsewhere, "7000_7000", true);
  });

  it("stamps every pole on the server to launch + 7 days and nothing else", async () => {
    const result = await stampLaunchGrace(db, here, launchAt);
    expect(result).toEqual({ polesStamped: 2, graceUntil: new Date(launchAt.getTime() + NEW_POLE_GRACE_MS) });

    const rows = await db.select().from(poles).where(eq(poles.serverId, here)).orderBy(asc(poles.poleKey));
    expect(rows.map((p) => p.graceUntil.getTime())).toEqual([
      launchAt.getTime() + NEW_POLE_GRACE_MS,
      launchAt.getTime() + NEW_POLE_GRACE_MS,
    ]);
    // The stamp is grace only: flags, textures and sighting times are untouched.
    expect(rows.map((p) => [p.flagRaised, p.currentTexture])).toEqual([[true, "Flag_Wolf"], [false, "Flag_White"]]);
    expect(rows.every((p) => p.firstSeenAt.getTime() === seen.getTime())).toBe(true);
  });

  it("leaves the other server alone", async () => {
    await stampLaunchGrace(db, here, launchAt);
    const [other] = await db.select().from(poles).where(eq(poles.serverId, elsewhere));
    expect(other!.graceUntil.getTime()).toBe(seen.getTime() + NEW_POLE_GRACE_MS);
  });

  it("twice with the same instant is the same stamp", async () => {
    const first = await stampLaunchGrace(db, here, launchAt);
    const second = await stampLaunchGrace(db, here, launchAt);
    expect(second).toEqual(first);
    const rows = await db.select().from(poles).where(eq(poles.serverId, here));
    expect(rows.every((p) => p.graceUntil.getTime() === launchAt.getTime() + NEW_POLE_GRACE_MS)).toBe(true);
  });

  it("stamps zero poles on a server that has none, without error", async () => {
    const [empty] = await db.insert(servers).values({ name: "C", map: "livonia", clockOffsetMs: 0 }).returning();
    expect(await stampLaunchGrace(db, empty!.id, launchAt)).toEqual({
      polesStamped: 0, graceUntil: new Date(launchAt.getTime() + NEW_POLE_GRACE_MS),
    });
  });
});
