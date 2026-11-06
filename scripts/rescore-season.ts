/**
 * Rescore one season under the raid value rules (value spec 2026-11-06 §6):
 * insert the old-flag raids the live consumer never scored, reprice every raid
 * row, rebuild season_standings. Runbook: docs/deploy/2026-11-06-raid-value.md.
 *
 *   DATABASE_URL=postgres://... pnpm rescore:season --season 3            # dry run
 *   DATABASE_URL=postgres://... pnpm rescore:season --season 3 --apply
 *
 * A dry run by default: it runs the whole rescore in a transaction and rolls
 * it back, so what it prints is exactly what `--apply` would commit.
 *
 * ⚠️ Refuses to run against a URL whose database name is not `factions_live`
 * unless `--allow-test-db` is also passed, the same guard as
 * rebuild-standings: an apply rewrites live scoring data, and the wrong
 * database fails silently (rows rewritten, no error).
 *
 * ⚠️ Stop the bot first. raid-tick does not lock `seasons`, so a raid landing
 * during an apply would be priced against the pre-rescore rows.
 */
import { createClient, seasons } from "@factions/db";
import { eq } from "drizzle-orm";
import { rescoreSeason } from "../apps/bot/src/rescore.js";

const args = process.argv.slice(2);
const seasonFlagIndex = args.indexOf("--season");
const seasonArg = seasonFlagIndex === -1 ? undefined : args[seasonFlagIndex + 1];
if (!seasonArg || !/^\d+$/u.test(seasonArg)) {
  throw new Error("usage: rescore-season --season <id> [--apply] [--allow-test-db]");
}
const seasonId = Number(seasonArg);
const apply = args.includes("--apply");
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
const [season] = await db.select().from(seasons).where(eq(seasons.id, seasonId));
if (!season) throw new Error(`season id ${seasonId} does not exist`);
console.log(`season id ${season.id} (number ${season.number}, server ${season.serverId}, started ${season.startedAt.toISOString()}${season.endedAt ? `, ended ${season.endedAt.toISOString()}` : ", open"})`);
console.log(apply ? "APPLY: changes will be committed." : "DRY RUN: nothing will be committed. Pass --apply to write.");

const report = await rescoreSeason(db, seasonId, { apply });

console.log(`\nretro raids ${apply ? "inserted" : "that would be inserted"}: ${report.inserted.length}`);
for (const r of report.inserted) {
  console.log(`  ${r.at.toISOString()}  ${r.raider ?? "solo"}→${r.victim}  by ${r.lowerer}  ${r.online ? "online" : "offline"}  ${r.points} pts  (${r.lowerCount} lower${r.lowerCount === 1 ? "" : "s"})`);
}

console.log(`\nraid rows, in (first_lower_at, id) order: ${report.rows.length}`);
for (const r of report.rows) {
  const changed = r.oldPoints === r.newPoints ? "" : `  (was ${r.oldPoints})`;
  console.log(`  #${r.id}  ${r.at.toISOString()}  ${r.raider ?? "solo"}→${r.victim}  ${r.online ? "online " : "offline"}  ${r.newPoints} pts${changed}`);
}

// The same sum season_standings.points holds after the rebuild.
const totals = new Map<string, number>();
for (const r of report.rows) {
  if (r.raider !== null) totals.set(r.raider, (totals.get(r.raider) ?? 0) + r.newPoints);
}
console.log("\nseason points by clan:");
for (const [clan, pts] of [...totals].sort((a, b) => b[1] - a[1])) console.log(`  ${clan.padEnd(6)} ${pts}`);

console.log(`\ndisagreements (investigate each before --apply): ${report.disagreements.length}`);
for (const d of report.disagreements) console.log(`  ${d}`);

await db.$client.end();
