import { readFile } from "node:fs/promises";
import { createClient, servers } from "@factions/db";
import { and, eq } from "drizzle-orm";
import { groupExportByFile } from "./replay-export.js";
import { ingestFile } from "./ingest.js";

const DATABASE_URL = process.env.DATABASE_URL;
const path = process.argv[2];

if (!DATABASE_URL || !path) {
  console.error("Usage: DATABASE_URL=... node src/replay-main.ts <export.log>");
  process.exit(1);
}

/**
 * DayZ ADM logs record server-local wall-clock time, not UTC. These offsets were
 * measured against this export's own authoritative ISO timestamps (the export
 * header repeats each line's UTC instant alongside the server-local ADM text),
 * confirming three servers run on three different clocks: Chernarus UTC+4,
 * Livonia and Sakhal UTC+7. This is measured production data, not a guess —
 * see scripts/backfill.md for the verification query that checks it.
 */
const CLOCK_OFFSET_MS_BY_MAP: Record<string, number> = {
  chernarus: 4 * 60 * 60 * 1000,
  livonia: 7 * 60 * 60 * 1000,
  sakhal: 7 * 60 * 60 * 1000,
};

const db = createClient(DATABASE_URL);
const lines = (await readFile(path, "utf8")).split(/\r?\n/);
const groups = groupExportByFile(lines);

for (const [filename, group] of groups) {
  const name = `export-${group.map}`;
  const clockOffsetMs = CLOCK_OFFSET_MS_BY_MAP[group.map] ?? 0;

  const [existing] = await db.select().from(servers)
    .where(and(eq(servers.name, name), eq(servers.map, group.map)));
  const server = existing ?? (await db.insert(servers)
    .values({ name, map: group.map, clockOffsetMs }).returning())[0]!;

  const r = await ingestFile(db, {
    serverId: server.id, map: group.map, filename,
    bootAt: group.bootAt, lines: group.lines, clockOffsetMs,
  });
  if (r.eventsAppended > 0) console.log(`${filename}: ${r.eventsAppended} events`);
}

console.log(`replayed ${groups.size} files`);
process.exit(0);
