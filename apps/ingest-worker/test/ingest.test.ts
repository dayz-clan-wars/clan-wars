import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, events, rawLines, admFiles, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { ingestFile } from "../src/ingest.js";

const URL = requireTestDatabaseUrl();
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

describe("ingestFile", () => {
  let db: Database;
  let serverId: number;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table flag_changes, poles, events, raw_lines, adm_files, servers, consumer_cursors restart identity cascade`);
    const [srv] = await db.insert(servers).values({ name: "T", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = srv!.id;
  });

  const opts = () => ({
    serverId, filename: "a.ADM",
    bootAt: new Date("2026-07-22T07:01:37Z"), lines: LINES, clockOffsetMs: 0,
    markComplete: true,
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

  it("reports zero unparsed flag-shaped lines for a clean file", async () => {
    const r = await ingestFile(db, opts());
    expect(r.unparsedFlagLines).toBe(0);
  });

  it("counts flag-shaped lines the parser could not interpret", async () => {
    // Flag-shaped text in a grammar parseLine does not recognise. Without this
    // canary a parser regression on the only raid signal is a silent no-op.
    const lines = [
      "AdminLog started on 2026-07-22 at 07:01:37",
      `08:00:00 | Player "YrJustBad" (id=${ID} pos=<1.0, 2.0, 3.0>) has hoisted Flag_DayZ on TerritoryFlag at <1.0, 3.0, 2.0>`,
      `08:00:01 | Player "YrJustBad" (id=${ID} pos=<1.0, 2.0, 3.0>) unfurled Flag Pole`,
    ];
    const r = await ingestFile(db, { ...opts(), lines });
    expect(r.eventsAppended).toBe(0);
    expect(r.unparsedFlagLines).toBe(2);
  });

  it("shifts occurredAt by the server's clock offset", async () => {
    // A server running 4 hours ahead of UTC (e.g. Chernarus UTC+4) records
    // 10:21:40 local time for what is actually 14:21:40Z.
    await ingestFile(db, { ...opts(), clockOffsetMs: 4 * 60 * 60 * 1000 });
    const rows = await db.select().from(events).orderBy(events.lineIndex);
    expect(rows[1]?.occurredAt.toISOString()).toBe("2026-07-22T14:21:40.000Z");
  });

  describe("resuming", () => {
    const ingest = (lines: string[], markComplete = false) => ingestFile(db, {
      serverId, filename: "resume.ADM", bootAt: new Date("2026-07-22T07:01:37Z"),
      lines, clockOffsetMs: 0, markComplete,
    });

    it("returns the line count as the new cursor", async () => {
      const r = await ingest(LINES);
      expect(r.linesIngested).toBe(LINES.length);
    });

    it("writes nothing twice when the same lines are ingested again", async () => {
      // The defect this task fixes: the old implementation re-inserted every
      // line of every file on every run and leaned on ON CONFLICT to discard
      // them. At a 60-second cadence that is the whole file, every minute.
      await ingest(LINES);
      const before = (await db.select().from(rawLines)).length;
      const second = await ingest(LINES);
      expect(second.linesCaptured).toBe(0);
      expect((await db.select().from(rawLines)).length).toBe(before);
    });

    it("ingests only the lines a growing file has gained", async () => {
      await ingest(LINES);
      const grown = [...LINES, `15:00:00 | Player "YrJustBad" (id=${ID}) has been disconnected`];
      const r = await ingest(grown);
      expect(r.linesCaptured).toBe(1);
      expect(r.linesIngested).toBe(grown.length);
    });

    it("does not reprocess a file that shrank or rotated", async () => {
      // The cursor is past the end. Reprocessing would rewrite line 0 of a
      // different file's content under the same adm_files row.
      await ingest(LINES);
      const r = await ingest(LINES.slice(0, 2));
      expect(r.linesCaptured).toBe(0);
    });

    it("keeps timestamps correct across midnight when resuming mid-file", async () => {
      // ⚠️ THE test. TimelineCursor is stateful: it rolls the date forward on
      // a backwards clock jump. Resuming with a FRESH cursor at the resume
      // point loses that rollover, and every later timestamp is a day early —
      // silently, with every row still landing and every count still green.
      const beforeMidnight = [
        "AdminLog started on 2026-07-22 at 22:00:00",
        `22:30:00 | Player "YrJustBad" (id=${ID} pos=<2990.4, 1138.3, 448.0>) has raised Flag_Livonia on TerritoryFlag at <2991.569092, 447.946503, 1138.587646>`,
      ];
      const afterMidnight = [
        ...beforeMidnight,
        `00:30:00 | Player "YrJustBad" (id=${ID} pos=<2990.4, 1138.3, 448.0>) has raised Flag_Livonia on TerritoryFlag at <2991.569092, 447.946503, 1138.587646>`,
      ];
      await ingestFile(db, {
        serverId, filename: "midnight.ADM", bootAt: new Date("2026-07-22T22:00:00Z"),
        lines: beforeMidnight, clockOffsetMs: 0, markComplete: false,
      });
      await ingestFile(db, {
        serverId, filename: "midnight.ADM", bootAt: new Date("2026-07-22T22:00:00Z"),
        lines: afterMidnight, clockOffsetMs: 0, markComplete: false,
      });
      const rows = await db.select().from(events).orderBy(events.id);
      const last = rows[rows.length - 1]!;
      // The 00:30 line belongs to the 23rd, not the 22nd.
      expect(last.occurredAt.toISOString()).toBe("2026-07-23T00:30:00.000Z");
    });

    it("marks a file complete only when told to", async () => {
      // The live file is still being written; marking it complete would make
      // the next tick skip the lines it is about to gain.
      await ingest(LINES, false);
      const [live] = await db.select().from(admFiles);
      expect(live?.complete).toBe(false);
      await ingest(LINES, true);
      const [done] = await db.select().from(admFiles);
      expect(done?.complete).toBe(true);
    });
  });
});
