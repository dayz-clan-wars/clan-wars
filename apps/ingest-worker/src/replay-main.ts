import { readFile } from "node:fs/promises";
import { createClient, servers } from "@factions/db";
import { groupExportByFile } from "./replay-export.js";
import { ingestFile } from "./ingest.js";
import { clockOffsetMsFor } from "./clock-offsets.js";

const DATABASE_URL = process.env.DATABASE_URL;
const path = process.argv[2];

if (!DATABASE_URL || !path) {
  console.error("Usage: DATABASE_URL=... node src/replay-main.ts <export.log>");
  process.exit(1);
}

const db = createClient(DATABASE_URL);
const lines = (await readFile(path, "utf8")).split(/\r?\n/);
const { groups, skipped } = groupExportByFile(lines);

let totalLines = 0;
let totalUnparsedFlagLines = 0;

for (const [filename, group] of groups) {
  const name = `export-${group.map}`;
  const clockOffsetMs = clockOffsetMsFor(group.map);

  // Upsert rather than select-then-insert-if-missing, so a re-run without the
  // runbook's truncate step can never reuse a stale clockOffsetMs left on an
  // existing row.
  const [server] = await db.insert(servers)
    .values({ name, map: group.map, clockOffsetMs })
    .onConflictDoUpdate({
      target: [servers.name, servers.map],
      set: { clockOffsetMs },
    })
    .returning();

  const r = await ingestFile(db, {
    serverId: server!.id, filename,
    bootAt: group.bootAt, lines: group.lines, clockOffsetMs,
    markComplete: true,
  });
  totalLines += group.lines.length;
  totalUnparsedFlagLines += r.unparsedFlagLines;
  if (r.eventsAppended > 0) console.log(`${filename}: ${r.eventsAppended} events`);
}

console.log(
  `replayed ${groups.size} files, ${totalLines} lines, ${skipped} skipped (no timestamp column)`,
);
// Non-zero means the parser saw flag-shaped text it could not interpret. Since
// the flag-lower is the only raid signal the log provides, a parser false
// negative is otherwise indistinguishable from a quiet week.
console.log(`${totalUnparsedFlagLines} flag-shaped lines produced no event`);
process.exit(0);
