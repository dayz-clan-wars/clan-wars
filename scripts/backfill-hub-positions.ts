/**
 * Backfill positions onto past hit and kill events (spec 2026-09-22-hub-combat §4.4;
 * runbook docs/deploy/2026-09-22-hub-combat.md). A DRY RUN unless `--apply`.
 *
 *   pnpm --filter @factions/bot exec tsx ../../scripts/backfill-hub-positions.ts --server 1 [--apply]
 *
 * ⚠️ Run BEFORE rebuild:kills — the rebuild reads these positions to mark Hub kills.
 * ⚠️ Refuses a DATABASE_URL not ending in /factions_live unless --allow-test-db.
 */
import { createClient } from "@factions/db";
import { backfillHubPositions } from "../apps/bot/src/hub-backfill.js";

const args = process.argv.slice(2);
const serverArg = args[args.indexOf("--server") + 1];
if (!args.includes("--server") || !serverArg || !/^\d+$/u.test(serverArg)) {
  console.error("usage: backfill-hub-positions --server <id> [--apply] [--allow-test-db]");
  process.exit(2);
}
const apply = args.includes("--apply");
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL unset"); process.exit(2); }
if (!url.endsWith("/factions_live") && !args.includes("--allow-test-db")) { console.error(`refusing: not factions_live -> ${url} (pass --allow-test-db to override)`); process.exit(2); }

const db = createClient(url);
const r = await backfillHubPositions(db, { serverId: Number(serverArg), apply });
console.log(`${apply ? "applied" : "DRY RUN"}: ${r.scanned} scanned, ${r.updated} updated, ${r.unparsed} unparsed`);
await db.$client.end();
