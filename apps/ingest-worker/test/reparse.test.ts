import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, events, rawLines, admFiles, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { ingestFile } from "../src/ingest.js";
import { reparseStoredLines } from "../src/reparse.js";

const URL = requireTestDatabaseUrl();
const A = "89B90470B5F5E8C64EF8B28C89250D6AD1CE2A71";
const B = "212229C4B9D5641CC66865612291744A89E607FB";

/** A file as the old parser saw it: the kill and the connect are stored, but never became events. */
const LINES = [
  "AdminLog started on 2026-09-06 at 20:09:46",
  `20:10:00 | Player "RonaldRaygun552" (id=${A}) is connected`,
  `23:59:59 | Player "IGC slide" (id=${B} pos=<365.1, 1615.2, 452.1>) placed Flag Pole Kit<TerritoryFlagKit>`,
  `00:51:18 | Player "RonaldRaygun552" (DEAD) (id=${A} pos=<337.8, 1585.8, 444.8>) killed by Player "IGC slide" (id=${B} pos=<365.1, 1615.2, 452.1>) with KA-74 from 40.714 meters `,
];

describe("reparseStoredLines", () => {
  let db: Database;
  let serverId: number;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table flag_changes, poles, events, raw_lines, adm_files, servers, consumer_cursors restart identity cascade`);
    const [srv] = await db.insert(servers).values({ name: "T", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = srv!.id;
    // Stored lines, one event (the kit), as if ingested before the parser knew kills and connects.
    const [file] = await db.insert(admFiles).values({ serverId, filename: "a.ADM", bootAt: new Date("2026-09-06T20:09:46Z"), linesIngested: LINES.length, complete: true }).returning();
    await db.insert(rawLines).values(LINES.map((content, lineIndex) => ({ admFileId: file!.id, lineIndex, content })));
    await db.insert(events).values({ serverId, admFileId: file!.id, lineIndex: 2, subIndex: 0, type: "flagpole.placed", occurredAt: new Date("2026-09-06T23:59:59Z"), payload: {} });
  });

  it("appends the events the old parser missed, leaves the existing one alone, and keeps the dates right across midnight", async () => {
    const r = await reparseStoredLines(db);
    expect(r.files).toBe(1);
    expect(r.eventsAppended).toBe(2);
    const rows = await db.select().from(events).orderBy(events.lineIndex);
    expect(rows.map((e) => e.type)).toEqual(["player.connected", "flagpole.placed", "player.killed"]);
    // The kill is after the midnight the cursor crossed on line 2 → 3.
    expect(rows[2]?.occurredAt.toISOString()).toBe("2026-09-07T00:51:18.000Z");
    expect(rows[2]?.payload).toMatchObject({ killerDayzId: B, victimDayzId: A, weapon: "KA-74" });
  });

  it("is idempotent — a second run appends nothing", async () => {
    await reparseStoredLines(db);
    const again = await reparseStoredLines(db);
    expect(again.eventsAppended).toBe(0);
    expect(await db.select().from(events)).toHaveLength(3);
  });

  it("does not move the resume cursor or re-open a complete file", async () => {
    await reparseStoredLines(db);
    const [file] = await db.select().from(admFiles);
    expect(file?.linesIngested).toBe(LINES.length);
    expect(file?.complete).toBe(true);
  });

  it("a normal ingest after the reparse still resumes at the cursor", async () => {
    await reparseStoredLines(db);
    const r = await ingestFile(db, { serverId, filename: "a.ADM", bootAt: new Date("2026-09-06T20:09:46Z"), lines: LINES, clockOffsetMs: 0, markComplete: true });
    expect(r.eventsAppended).toBe(0);
    expect(r.linesCaptured).toBe(0);
  });
});
