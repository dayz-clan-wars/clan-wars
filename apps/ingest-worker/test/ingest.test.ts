import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, servers, events, rawLines, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { ingestFile } from "../src/ingest.js";

const URL = process.env.TEST_DATABASE_URL;
const ID = "D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1";

const LINES = [
  "AdminLog started on 2026-07-22 at 07:01:37",
  `07:52:16 | Player "YrJustBad" (id=${ID} pos=<2993.4, 1135.7, 447.9>) placed Flag Pole Kit<TerritoryFlagKit>`,
  `10:21:40 | Player "YrJustBad" (id=${ID} pos=<2990.4, 1138.3, 448.0>) has raised Flag_Livonia on TerritoryFlag at <2991.569092, 447.946503, 1138.587646>`,
  "13:00:07 | ##### PlayerList log: 1 players",
  `13:00:07 | Player "YrJustBad" (id=${ID} pos=<9958.4, 7440.6, 176.4>)`,
  "13:00:07 | #####",
  `14:00:00 | Player "YrJustBad" (id=${ID}) is connected`,
];

describe.skipIf(!URL)("ingestFile", () => {
  let db: Database;
  let serverId: number;

  beforeEach(async () => {
    db = createClient(URL!);
    await runMigrations(db);
    await db.execute(sql`truncate table flag_changes, poles, events, raw_lines, adm_files, servers, consumer_cursors restart identity cascade`);
    const [srv] = await db.insert(servers).values({ name: "T", map: "livonia" }).returning();
    serverId = srv!.id;
  });

  const opts = () => ({
    serverId, map: "livonia", filename: "a.ADM",
    bootAt: new Date("2026-07-22T07:01:37Z"), lines: LINES, clockOffsetMs: 0,
  });

  it("captures every line losslessly", async () => {
    const r = await ingestFile(db, opts());
    expect(r.linesCaptured).toBe(LINES.length);
    expect(await db.select().from(rawLines)).toHaveLength(LINES.length);
  });

  it("appends only lines that parse to events", async () => {
    const r = await ingestFile(db, opts());
    // kit placement + raise + one position entry = 3. Roster header, terminator,
    // boot header and "is connected" produce no events.
    expect(r.eventsAppended).toBe(3);
  });

  it("resolves absolute timestamps from the boot header", async () => {
    await ingestFile(db, opts());
    const rows = await db.select().from(events).orderBy(events.lineIndex);
    expect(rows[1]?.occurredAt.toISOString()).toBe("2026-07-22T10:21:40.000Z");
  });

  it("stores the flag texture and pole key in the payload", async () => {
    await ingestFile(db, opts());
    const rows = await db.select().from(events).orderBy(events.lineIndex);
    const raise = rows.find((r) => r.type === "flag.raised");
    expect(raise?.payload).toMatchObject({
      texture: "Flag_Livonia",
      poleKey: "2991.57:447.95:1138.59",
    });
  });

  it("is idempotent when the same file is ingested twice", async () => {
    await ingestFile(db, opts());
    const second = await ingestFile(db, opts());
    expect(second.eventsAppended).toBe(0);
    expect(await db.select().from(events)).toHaveLength(3);
  });

  it("shifts occurredAt by the server's clock offset", async () => {
    // A server running 4 hours ahead of UTC (e.g. Chernarus UTC+4) records
    // 10:21:40 local time for what is actually 14:21:40Z.
    await ingestFile(db, { ...opts(), clockOffsetMs: 4 * 60 * 60 * 1000 });
    const rows = await db.select().from(events).orderBy(events.lineIndex);
    expect(rows[1]?.occurredAt.toISOString()).toBe("2026-07-22T14:21:40.000Z");
  });
});
