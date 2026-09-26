import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import type { Database } from "@factions/db";
import { openDb, makeFixture, MON, PREV_MON, at, type Fx } from "../fixture.js";
import { pickWeek } from "../../src/stages/pick.js";

const WEEK_END = at(7); // MON + 7 d, 2026-09-28
const closeThrough = (db: Database, d: Date) => db.execute(sql`update seasons set week_closed_through = ${d.toISOString()}::timestamptz`);

describe("pickWeek", () => {
  let db: Database; let fx: Fx;
  beforeAll(async () => { db = await openDb(); });
  beforeEach(async () => { fx = await makeFixture(db); });

  it("picks the last ended week once it is closed and ingest has passed its end", async () => {
    await closeThrough(db, MON);
    await fx.event("player.connected", at(7, 0, 5));
    expect((await pickWeek(db, at(7, 1)))?.toISOString()).toBe(MON.toISOString());
  });

  it("waits while the week is not closed", async () => {
    await closeThrough(db, PREV_MON);
    await fx.event("player.connected", at(7, 0, 5));
    expect(await pickWeek(db, at(7, 1))).toBeNull();
  });

  it("waits while ingest is behind and it is under 6 h past the week's end", async () => {
    await closeThrough(db, MON);
    await fx.event("player.connected", at(6, 23));
    expect(await pickWeek(db, at(7, 5, 59))).toBeNull();
  });

  it("goes out on an empty server once 6 h have passed", async () => {
    await closeThrough(db, MON);
    expect((await pickWeek(db, at(7, 6)))?.toISOString()).toBe(MON.toISOString());
  });

  it("prefers the earliest unfinished row over a new week", async () => {
    await closeThrough(db, MON);
    await fx.episode({ weekStart: PREV_MON, episodeNumber: 2, title: null, storylines: null, narrative: null, stage: "context" });
    expect((await pickWeek(db, at(7, 7)))?.toISOString()).toBe(PREV_MON.toISOString());
  });

  it("skips terminal rows and never picks a week that already has one", async () => {
    await closeThrough(db, MON);
    await fx.episode({ weekStart: PREV_MON, episodeNumber: 2, title: null, storylines: null, narrative: null, stage: "held" });
    await fx.episode({ weekStart: MON, episodeNumber: 3, title: "T", storylines: [], narrative: "Boris: hi", stage: "done" });
    expect(await pickWeek(db, at(7, 7))).toBeNull();
  });

  it("never backfills an older week with no row", async () => {
    await closeThrough(db, MON);
    await fx.episode({ weekStart: MON, episodeNumber: 3, title: "T", storylines: [], narrative: "Boris: hi", stage: "done" });
    expect(await pickWeek(db, at(7, 7))).toBeNull(); // PREV_MON has no row and stays that way
  });
});
