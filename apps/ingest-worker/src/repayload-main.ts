/**
 * One-off: re-derive stored event payloads from raw lines with the current parser.
 * Dry run unless `--apply`.
 *
 * ⚠️ A deliberate deploy step, never called at startup. Take a `pg_dump` first.
 * ⚠️ Refuses a database not named `factions_live` unless `--allow-test-db` is passed
 * (same guard as scripts/backfill-achievements.ts).
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @factions/ingest-worker repayload [--apply] [--types=player.hit,player.died,base.built]
 */
import { createClient } from "@factions/db";
import type { EventType } from "@factions/domain";
import { repayloadEvents } from "./repayload.js";

const url = process.env.DATABASE_URL;
const args = process.argv.slice(2);
const allowTest = args.includes("--allow-test-db");
if (!url) { console.error("DATABASE_URL unset"); process.exit(2); }
if (!url.endsWith("/factions_live") && !allowTest) { console.error(`refusing: not factions_live -> ${url} (pass --allow-test-db to override)`); process.exit(2); }

const i = args.findIndex((a) => a === "--types" || a.startsWith("--types="));
const raw = i < 0 ? "player.hit,player.died,base.built" : args[i]!.includes("=") ? args[i]!.split("=")[1]! : args[i + 1] ?? "";
const types = raw.split(",").map((s) => s.trim()).filter(Boolean) as EventType[];
const apply = args.includes("--apply");

const db = createClient(url);
console.log(apply ? "APPLY: writing payloads" : "dry run (pass --apply to write)");
const r = await repayloadEvents(db, { types, apply, log: console.log });
console.log(r);
process.exit(0);
