/**
 * One-off: replay the stored raw lines through the current parser, so line
 * shapes the parser learned after a file was ingested become events.
 *
 * ⚠️ A deliberate deploy step, never called at startup — the same rule as
 * `feed-backfill.ts`. Take a `pg_dump` first.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx apps/ingest-worker/src/reparse-main.ts
 */
import { createClient } from "@factions/db";
import { reparseStoredLines } from "./reparse.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Usage: DATABASE_URL=... npx tsx src/reparse-main.ts");
  process.exit(1);
}

const db = createClient(DATABASE_URL);
const r = await reparseStoredLines(db, console.log);
console.log(`reparsed ${r.files} files, ${r.lines} lines: ${r.eventsAppended} new events`);
console.log(`${r.unparsedFlagLines} flag-shaped lines produced no event`);
process.exit(0);
