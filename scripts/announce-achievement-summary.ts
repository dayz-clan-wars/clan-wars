/**
 * After the October 2026 release's silent backfill, DM each linked player one line
 * saying how many of the 103 new achievements they already hold (spec
 * `docs/superpowers/specs/2026-10-20-achievements-150-design.md`).
 *
 *   DATABASE_URL=postgres://... pnpm announce:achievement-summary --before <ISO> [--dry-run]
 *
 * `--before` is the release instant and is REQUIRED (usage error, exit 2): only unlocks
 * earned before it count, because those are the ones `pnpm backfill:achievements`
 * credited without a word. A tile earned after it was announced live already.
 * `SITE_BASE_URL` sets the wall link's host, as it does for the bot.
 *
 * ⚠️ DM only — never the public wall or a clan channel. Never run
 * `backfill:achievement-notices` for this release: that announces every unlock one by one.
 *
 * ⚠️ Refuses a DATABASE_URL whose database is not `factions_live` unless
 * `--allow-test-db` is passed — same guard as the other scripts here.
 *
 * ⚠️ This only QUEUES rows; the running bot's notice poster sends them. Idempotent
 * per player and release: running it twice sends one DM.
 */
import { createClient } from "@factions/db";
import { ACHIEVEMENTS_2026_10 } from "@factions/domain";
import { DEFAULT_SITE_BASE_URL, optionalHttpUrl } from "../apps/bot/src/config.js";
import { queueAchievementSummaries } from "../apps/bot/src/achievements/summary.js";

const url = process.env.DATABASE_URL;
const argv = process.argv.slice(2);
const allowTest = argv.includes("--allow-test-db");
const dryRun = argv.includes("--dry-run");
const beforeArg = argv.includes("--before") ? argv[argv.indexOf("--before") + 1] : undefined;
const before = beforeArg ? new Date(beforeArg) : null;
if (!url) { console.error("DATABASE_URL unset"); process.exit(2); }
if (!url.endsWith("/factions_live") && !allowTest) { console.error(`refusing: not factions_live -> ${url} (pass --allow-test-db to override)`); process.exit(2); }
if (!before || Number.isNaN(before.getTime())) { console.error("usage: announce:achievement-summary --before <ISO instant of the release> [--dry-run] [--allow-test-db]"); process.exit(2); }
// ⚠️ The bot's own check, so a typo'd host or a stray path cannot put a dead link in
// every player's DM: the queued payload freezes the URL, and nothing rewrites it later.
let siteBaseUrl: string;
try { siteBaseUrl = (optionalHttpUrl(process.env, "SITE_BASE_URL") ?? DEFAULT_SITE_BASE_URL).replace(/\/+$/u, ""); }
catch (err) { console.error((err as Error).message); process.exit(2); }

const db = createClient(url);
const r = await queueAchievementSummaries(db, { release: "2026-10", keys: ACHIEVEMENTS_2026_10, before, siteBaseUrl, dryRun });
console.log(`${dryRun ? "dry run" : "summary"}: ${r.queued} ${dryRun ? "would be queued" : "DMs queued"}, ${r.skipped} already sent, unlocks before ${before.toISOString()}, links to ${siteBaseUrl}`);
await db.$client.end();
