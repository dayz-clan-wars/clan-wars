/**
 * Rebuild kills for one server from the event log (spec §4.9, §11).
 *
 *   DATABASE_URL=postgres://... pnpm rebuild:kills --server 1
 *
 * ⚠️ Refuses to run against a URL whose database name is not `factions_live`
 * unless `--allow-test-db` is also passed — this operates on live kills
 * data and the failure mode of running it against the wrong database is
 * silent (it deletes and rewrites rows, not an error).
 *
 * ⚠️ Refuses to run when more than one active server exists. `rebuildKills`
 * deletes and replays one server's rows but resets the kills consumer's
 * cursor to 0 globally — a rebuild with two active servers would re-derive
 * both servers' kills on every rebuild and race a concurrent rebuild of
 * the other server's cursor writes. One active server means that race can't
 * happen.
 */
import { createClient, servers } from "@factions/db";
import { eq } from "drizzle-orm";
import { rebuildKills } from "../apps/bot/src/kills-tick.js";

const args = process.argv.slice(2);
const serverFlagIndex = args.indexOf("--server");
const serverArg = serverFlagIndex === -1 ? undefined : args[serverFlagIndex + 1];
if (!serverArg || !/^\d+$/u.test(serverArg)) {
  throw new Error("usage: rebuild-kills --server <id> [--allow-test-db]");
}
const serverId = Number(serverArg);
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

const activeServers = await db.select({ id: servers.id }).from(servers).where(eq(servers.active, true));
if (activeServers.length > 1) {
  throw new Error(
    `refusing to rebuild: ${activeServers.length} active servers exist, but the kills consumer's cursor is global. ` +
    "Deactivate every active server but the one being rebuilt first.",
  );
}

const count = await rebuildKills(db, serverId);
console.log(`server ${serverId}: rebuilt ${count} kills row(s)`);
await db.$client.end();
