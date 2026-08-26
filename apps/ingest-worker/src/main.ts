import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createClient, servers } from "@factions/db";
import { and, eq } from "drizzle-orm";
import { readAdmFile } from "./read-adm-file.js";
import { ingestFile } from "./ingest.js";

const DATABASE_URL = process.env.DATABASE_URL;
const ADM_DIR = process.env.ADM_DIR;
const SERVER_NAME = process.env.SERVER_NAME;
const MAP = process.env.MAP;

if (!DATABASE_URL || !ADM_DIR || !SERVER_NAME || !MAP) {
  console.error("Set DATABASE_URL, ADM_DIR, SERVER_NAME and MAP.");
  process.exit(1);
}

const db = createClient(DATABASE_URL);

const [existing] = await db.select().from(servers)
  .where(and(eq(servers.name, SERVER_NAME), eq(servers.map, MAP)));
const server = existing ?? (await db.insert(servers)
  .values({ name: SERVER_NAME, map: MAP }).returning())[0]!;

const names = (await readdir(ADM_DIR)).filter((n) => n.endsWith(".ADM")).sort();

for (const filename of names) {
  const { bootAt, lines } = await readAdmFile(join(ADM_DIR, filename));
  const r = await ingestFile(db, {
    serverId: server.id,
    map: MAP,
    filename,
    bootAt,
    lines,
    clockOffsetMs: server.clockOffsetMs,
  });
  console.log(`${filename}: ${r.linesCaptured} lines, ${r.eventsAppended} events`);
}

process.exit(0);
