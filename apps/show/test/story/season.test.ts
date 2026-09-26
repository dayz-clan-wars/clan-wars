import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { seasons, servers, type Database } from "@factions/db";
import { openDb, makeFixture, MON, type Fx } from "../fixture.js";
import { seasonForWeek } from "../../src/story/season.js";

describe("seasonForWeek", () => {
  let db: Database; let fx: Fx;
  beforeAll(async () => { db = await openDb(); });
  beforeEach(async () => { fx = await makeFixture(db); });

  it("ignores a season on an inactive server, even an earlier-starting one", async () => {
    const [old] = await db.insert(servers).values({ name: "OLD", map: "livonia", clockOffsetMs: 0, active: false }).returning();
    await db.insert(seasons).values({ serverId: old!.id, number: 9, startedAt: new Date("2026-08-01T00:00:00Z") });
    const s = await seasonForWeek(db, MON);
    expect(s).toMatchObject({ id: fx.seasonId, serverId: fx.serverId, number: 1 });
  });

  it("still throws NoSeasonError when only an inactive server has a season", async () => {
    await db.execute(sql`update servers set active = false`);
    await expect(seasonForWeek(db, MON)).rejects.toThrow(/no season covers/u);
  });
});
