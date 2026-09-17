/**
 * Record a raid weekend deliberately not opened.
 *
 *   DATABASE_URL=postgres://... pnpm raid:skip --opens 2026-09-18T00:00:00Z --reason "first weekend after launch"
 *
 * ⚠️ A skip is a DECISION — "there is no raid weekend this week, and here is why" —
 * not a missed flip to catch up. Do not use this to compensate for a window that
 * failed to open: the guide promises specific hours, the level-triggered tick already
 * repairs a lost write within two hours, and the scoreboard does not depend on the
 * window at all. Compensating here would just invent a second decision nobody made.
 *
 * `--opens` is REQUIRED and must be exactly a window's opening instant (midnight UTC
 * on `RAID_WINDOW.openDow`) — it has no safe rounding. `raidWindowAt` matches a skip
 * by exact instant comparison (`getTime()`), so a value off by one second, or on the
 * wrong day, matches no window at all: the row sits in the database, every consumer
 * (the bot tick, the site strip, the Thursday notice) ignores it, and the weekend
 * opens anyway while a human believes it was called off. This script is the only
 * place that mistake can be caught, which is why it refuses rather than rounds.
 *
 * ⚠️ Refuses to run against a URL whose database name is not `factions_live` unless
 * `--allow-test-db` is also passed — same guard as `scripts/wipe.ts`, for the same
 * reason: this is a one-shot operation whose target must never be a typo.
 */
import { createClient, raidWindowSkips } from "@factions/db";
import { RAID_WINDOW } from "@factions/domain";

const args = process.argv.slice(2);

const USAGE = 'usage: raid:skip --opens <ISO> --reason "<why>" [--allow-test-db]';
function usageError(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}

const opensRaw = arg("opens");
if (!opensRaw) {
  usageError("--opens is required (the window opening instant; there is no default).");
}
const reason = arg("reason");
if (!reason || reason.trim() === "") {
  usageError("--reason is required and must not be empty.");
}

const opensAt = new Date(opensRaw);
if (Number.isNaN(opensAt.getTime())) {
  usageError(`--opens is not a valid date (got: ${opensRaw})`);
}

// ⚠️ Must be EXACTLY a window's opening instant. See the header comment — an off-by-one
// or wrong-day value matches no window and silently does nothing downstream.
const DAY_MS = 24 * 60 * 60 * 1000;
const midnight = new Date(Date.UTC(opensAt.getUTCFullYear(), opensAt.getUTCMonth(), opensAt.getUTCDate()));
const back = (midnight.getUTCDay() - RAID_WINDOW.openDow + 7) % 7;
const nearest = new Date(midnight.getTime() - back * DAY_MS);
if (opensAt.getTime() !== nearest.getTime()) {
  usageError(
    `--opens must be exactly a window opening instant (midnight UTC on day ${RAID_WINDOW.openDow}). ` +
      `Got ${opensAt.toISOString()}; the window covering it opens at ${nearest.toISOString()}.`,
  );
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
const row = { opensAt, reason: reason.trim(), decidedAt: new Date() };
// onConflictDoUpdate, not onConflictDoNothing: re-running with a corrected reason must
// fix the reason the site strip and Thursday's notice will show, not silently keep the old one.
await db
  .insert(raidWindowSkips)
  .values(row)
  .onConflictDoUpdate({ target: raidWindowSkips.opensAt, set: { reason: row.reason, decidedAt: row.decidedAt } });
console.log(`raid:skip: ${opensAt.toISOString()} will NOT open — ${row.reason}`);
await db.$client.end();
process.exit(0);
