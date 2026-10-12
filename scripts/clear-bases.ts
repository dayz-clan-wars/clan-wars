/**
 * Release every base declared before a cutoff — the one-off for a map change.
 *
 *   DATABASE_URL=postgres://... pnpm clear-bases --server 1 --before 2026-10-08T00:00:00Z --dry-run
 *
 * `--before` is REQUIRED, with no default: it decides which bases a live
 * server loses. Usage errors exit 2. Prints the bases (with coordinates — this
 * is an operator's terminal, never a channel) as JSON.
 *
 * ⚠️ Refuses a URL whose database is not `factions_live` unless
 * `--allow-test-db` is passed, as `wipe` and `launch` do.
 */
import { createClient } from "@factions/db";
import { clearBasesBefore } from "../apps/bot/src/clear-bases.js";

const args = process.argv.slice(2);
const USAGE = "usage: clear-bases --server <id> --before <ISO> [--dry-run] [--allow-test-db]";
function usageError(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}
// ⚠️ Reject anything unrecognised: a misspelled `--dry-run` (say `--dryrun`)
// would otherwise be ignored and run the REAL deletion against production.
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--server" || a === "--before") i++; // skip the value; its own check follows
  else if (a !== "--dry-run" && a !== "--allow-test-db") usageError(`unknown argument: ${a}`);
}
const valueOf = (flag: string) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

const serverArg = valueOf("--server");
if (!serverArg || !/^\d+$/u.test(serverArg)) usageError(`--server is missing or not a positive integer (got: ${serverArg ?? "nothing"})`);
const beforeArg = valueOf("--before");
if (!beforeArg) usageError("--before is required (there is no default).");
const before = new Date(beforeArg);
if (Number.isNaN(before.getTime())) usageError(`--before is not a valid date (got: ${beforeArg})`);

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set.");
if (!args.includes("--allow-test-db") && !url.endsWith("/factions_live")) {
  throw new Error(`DATABASE_URL does not end in /factions_live. Pass --allow-test-db to run against a non-production database.`);
}

const db = createClient(url);
const result = await clearBasesBefore(db, Number(serverArg), before, { at: new Date(), dryRun: args.includes("--dry-run") });
console.log(JSON.stringify(result, null, 2));
await db.$client.end();
