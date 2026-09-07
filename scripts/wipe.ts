/**
 * Run the wipe for one server (spec §8.5).
 *
 *   DATABASE_URL=postgres://... pnpm wipe --server 1 --at 2026-09-30T00:00:00Z
 *
 * `--at` is REQUIRED: it is the season boundary, and it has no safe default.
 * A missing or unparseable `--at` is a usage error (exit 2) — never "now" —
 * so a bare re-run cannot invent a fresh timestamp and wipe a second time.
 * Exits 1 when the wipe reports `skipped: true` (the season on offer is one
 * a wipe just opened), so a re-run is visible in an exit code, not only in
 * the printed JSON.
 *
 * ⚠️ Refuses to run against a URL whose database name is not `factions_live`
 * unless `--allow-test-db` is also passed — this is the bot-stopped, one-shot
 * operation the runbook performs at season end, and running it against the
 * wrong database silently clears live declarations and identity holds.
 */
import { createClient } from "@factions/db";
import { wipe } from "../apps/bot/src/wipe.js";

const args = process.argv.slice(2);

const USAGE = "usage: wipe --server <id> --at <ISO> [--allow-test-db]";
function usageError(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

const serverFlagIndex = args.indexOf("--server");
const serverArg = serverFlagIndex === -1 ? undefined : args[serverFlagIndex + 1];
if (!serverArg || !/^\d+$/u.test(serverArg)) {
  usageError(`--server is missing or not a positive integer (got: ${serverArg ?? "nothing"})`);
}
const serverId = Number(serverArg);

const atFlagIndex = args.indexOf("--at");
const atArg = atFlagIndex === -1 ? undefined : args[atFlagIndex + 1];
if (!atArg) {
  usageError("--at is required (the season boundary; there is no default).");
}
const at = new Date(atArg);
if (Number.isNaN(at.getTime())) {
  usageError(`--at is not a valid date (got: ${atArg})`);
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
