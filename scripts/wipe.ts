/**
 * Run the wipe for one server (spec §8.5).
 *
 *   DATABASE_URL=postgres://... pnpm wipe --server 1 [--at 2026-09-30T00:00:00Z]
 *
 * `--at` defaults to now, rounded to the minute. Exits non-zero when the
 * wipe reports `skipped: true` (a wipe with this exact `--at` already ran),
 * so a re-run is visible in an exit code, not only in the printed JSON.
 *
 * ⚠️ Refuses to run against a URL whose database name is not `factions_live`
 * unless `--allow-test-db` is also passed — this is the bot-stopped, one-shot
 * operation the runbook performs at season end, and running it against the
 * wrong database silently clears live declarations and identity holds.
 */
import { createClient } from "@factions/db";
import { wipe } from "../apps/bot/src/wipe.js";

const args = process.argv.slice(2);

const serverFlagIndex = args.indexOf("--server");
const serverArg = serverFlagIndex === -1 ? undefined : args[serverFlagIndex + 1];
if (!serverArg || !/^\d+$/u.test(serverArg)) {
  throw new Error("usage: wipe --server <id> [--at <ISO>] [--allow-test-db]");
}
const serverId = Number(serverArg);

const atFlagIndex = args.indexOf("--at");
const atArg = atFlagIndex === -1 ? undefined : args[atFlagIndex + 1];
const at = atArg ? new Date(atArg) : new Date(Math.floor(Date.now() / 60_000) * 60_000);
if (Number.isNaN(at.getTime())) {
  throw new Error(`--at is not a valid date (got: ${atArg})`);
}

const allowTestDb = args.includes("--allow-test-db");

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set.");
}
if (!allowTestDb && !url.endsWith("/factions_live")) {
  throw new Error(
    `DATABASE_URL does not end in /factions_live (got: ${url}). ` +
    "Pass --allow-test-db to run against a non-production database.",
  );
}

const db = createClient(url);
const result = await wipe(db, serverId, at);
console.log(JSON.stringify(result));
await db.$client.end();

if (result.skipped) {
  process.exitCode = 1;
}
