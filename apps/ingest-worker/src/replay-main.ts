import { readFile } from "node:fs/promises";
import { createClient, servers } from "@factions/db";
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

/**
 * A map missing from CLOCK_OFFSET_MS_BY_MAP must never silently fall back to a
 * zero offset: that is exactly the failure the table exists to prevent (every
 * timestamp for that server stored hours wrong, while every count-based
 * acceptance check stays green). Fail loudly instead.
 */
function clockOffsetMsFor(map: string): number {
  const offset = CLOCK_OFFSET_MS_BY_MAP[map];
  if (offset === undefined) {
    const known = Object.keys(CLOCK_OFFSET_MS_BY_MAP).join(", ");
    throw new Error(
      `replay-main: no clockOffsetMs configured for map "${map}" (known maps: ${known})`,
    );
  }
  return offset;
}

const db = createClient(DATABASE_URL);
const lines = (await readFile(path, "utf8")).split(/\r?\n/);
const { groups, skipped } = groupExportByFile(lines);

let totalLines = 0;

for (const [filename, group] of groups) {
  const name = `export-${group.map}`;
  const clockOffsetMs = clockOffsetMsFor(group.map);

  // Upsert rather than select-then-insert-if-missing, so a re-run without the
  // runbook's truncate step can never reuse a stale clockOffsetMs (e.g. 0,
  // from before this map was added to the table above) left on an existing row.
  const [server] = await db.insert(servers)
    .values({ name, map: group.map, clockOffsetMs })
    .onConflictDoUpdate({
      target: [servers.name, servers.map],
      set: { clockOffsetMs },
    })
    .returning();

  const r = await ingestFile(db, {
    serverId: server!.id, map: group.map, filename,
    bootAt: group.bootAt, lines: group.lines, clockOffsetMs,
  });
  totalLines += group.lines.length;
  if (r.eventsAppended > 0) console.log(`${filename}: ${r.eventsAppended} events`);
}

console.log(
  `replayed ${groups.size} files, ${totalLines} lines, ${skipped} skipped (no timestamp column)`,
);
process.exit(0);
