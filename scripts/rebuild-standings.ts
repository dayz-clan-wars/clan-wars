/**
 * Rebuild season_standings for one season from raids + defenses (spec §13).
 *
 *   DATABASE_URL=postgres://... pnpm rebuild:standings --season 3
 *
 * ⚠️ Refuses to run against a URL whose database name is not `factions_live`
 * unless `--allow-test-db` is also passed — this operates on live scoring
 * data and the failure mode of running it against the wrong database is
 * silent (it deletes and rewrites rows, not an error).
 */
import { createClient } from "@factions/db";
import { rebuildStandings } from "../apps/bot/src/standings.js";

const args = process.argv.slice(2);
const seasonFlagIndex = args.indexOf("--season");
const seasonArg = seasonFlagIndex === -1 ? undefined : args[seasonFlagIndex + 1];
if (!seasonArg || !/^\d+$/u.test(seasonArg)) {
  throw new Error("usage: rebuild-standings --season <id> [--allow-test-db]");
}
const seasonId = Number(seasonArg);
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
const count = await rebuildStandings(db, seasonId);
console.log(`season ${seasonId}: rebuilt ${count} season_standings row(s)`);
await db.$client.end();
