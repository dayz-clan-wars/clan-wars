/**
 * Stamp a server's map change, the dormancy grace for switch day (Nasdara
 * swap, spec §H).
 *
 *   DATABASE_URL=postgres://... pnpm map-cutover --server 1 --at 2026-10-20T00:00:00Z
 *
 * `--at` is REQUIRED: it is the cutover instant, and it has no safe default.
 * A missing or unparseable `--at` is a usage error (exit 2) — never "now" —
 * so a re-run reproduces the same stamp instead of inventing a later one,
 * which would quietly lengthen every clan's grace.
 *
 * ⚠️ Refuses to run against a URL whose database name is not `factions_live`
 * unless `--allow-test-db` is also passed — the same rule as `pnpm launch`.
 */
import { createClient } from "@factions/db";
import { setMapChangedAt } from "../apps/bot/src/map-cutover.js";

const args = process.argv.slice(2);

const USAGE = "usage: map-cutover --server <id> --at <ISO> [--allow-test-db]";
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
  usageError("--at is required (the cutover instant; there is no default).");
}
const at = new Date(atArg);
if (Number.isNaN(at.getTime())) {
  usageError(`--at is not a valid date (got: ${atArg})`);
}

const allowTestDb = args.includes("--allow-test-db");

function redacted(u: string): string {
  try {
    const p = new URL(u);
    if (p.password) p.password = "***";
    return p.toString();
  } catch {
    return "<unparseable url>";
  }
}

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set.");
}
if (!allowTestDb && !url.endsWith("/factions_live")) {
  throw new Error(
    `DATABASE_URL does not end in /factions_live (got: ${redacted(url)}). ` +
    "Pass --allow-test-db to run against a non-production database.",
  );
}

const db = createClient(url);
await setMapChangedAt(db, serverId, at);
console.log(JSON.stringify({ serverId, mapChangedAt: at.toISOString() }));
await db.$client.end();
