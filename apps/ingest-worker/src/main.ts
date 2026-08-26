import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createClient, servers } from "@factions/db";
import { readAdmFile } from "./read-adm-file.js";
import { ingestFile } from "./ingest.js";

const DATABASE_URL = process.env.DATABASE_URL;
const ADM_DIR = process.env.ADM_DIR;
const SERVER_NAME = process.env.SERVER_NAME;
const MAP = process.env.MAP;
const CLOCK_OFFSET_MS_RAW = process.env.CLOCK_OFFSET_MS;

if (!DATABASE_URL || !ADM_DIR || !SERVER_NAME || !MAP || CLOCK_OFFSET_MS_RAW === undefined) {
  console.error(
    "Set DATABASE_URL, ADM_DIR, SERVER_NAME, MAP and CLOCK_OFFSET_MS.\n" +
    "CLOCK_OFFSET_MS is the milliseconds to ADD to this server's local ADM\n" +
    "wall-clock time to get UTC (observed: Chernarus +4h = 14400000,\n" +
    "Livonia/Sakhal +7h = 25200000). It has no default: DayZ writes\n" +
    "server-local time, and a wrong offset stores every timestamp hours off\n" +
    "while every count-based check stays green.",
  );
  process.exit(1);
}

const CLOCK_OFFSET_MS = Number(CLOCK_OFFSET_MS_RAW);
if (!Number.isInteger(CLOCK_OFFSET_MS)) {
  console.error(`CLOCK_OFFSET_MS must be an integer number of milliseconds, got "${CLOCK_OFFSET_MS_RAW}".`);
  process.exit(1);
}

const db = createClient(DATABASE_URL);

// Upsert rather than select-then-insert-if-missing, so a re-run always refreshes
// the stored offset instead of silently reusing a stale value on an existing row.
const [server] = await db.insert(servers)
  .values({ name: SERVER_NAME, map: MAP, clockOffsetMs: CLOCK_OFFSET_MS })
  .onConflictDoUpdate({
    target: [servers.name, servers.map],
    set: { clockOffsetMs: CLOCK_OFFSET_MS },
  })
  .returning();

const names = (await readdir(ADM_DIR)).filter((n) => n.endsWith(".ADM")).sort();

for (const filename of names) {
  const { bootAt, lines } = await readAdmFile(join(ADM_DIR, filename));
  const r = await ingestFile(db, {
    serverId: server!.id,
    filename,
    bootAt,
    lines,
    clockOffsetMs: server!.clockOffsetMs,
  });
  console.log(
    `${filename}: ${r.linesCaptured} lines, ${r.eventsAppended} events, ` +
    `${r.unparsedFlagLines} unparsed flag-shaped lines`,
  );
}

process.exit(0);
