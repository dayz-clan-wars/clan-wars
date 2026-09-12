/**
 * Announce every historical unlock to Discord, in the order it was earned
 * (runbook `docs/deploy/2026-09-12-achievements.md`, "Announcing the history").
 *
 *   DATABASE_URL=postgres://... ACHIEVEMENTS_CHANNEL_ID=... pnpm backfill:achievement-notices --targets public[,clan,dm] [--dry-run]
 *
 * `--targets` picks where: `public` is the #achievements wall (needs
 * ACHIEVEMENTS_CHANNEL_ID), `clan` each clan's own channel (pings the player),
 * `dm` the player's DMs. Default `public`. `--dry-run` counts and queues nothing.
 *
 * ⚠️ Refuses a DATABASE_URL whose database is not `factions_live` unless
 * `--allow-test-db` is passed — same guard as the other scripts here.
 *
 * ⚠️ This only QUEUES rows; the running bot's notice poster sends them, 50
 * per tick per target, oldest first. Idempotent: an unlock already announced
 * (by this or by the live tick) is skipped.
 */
import { createClient } from "@factions/db";
import { backfillAchievementNotices } from "../apps/bot/src/achievements/backfill-notices.js";

const url = process.env.DATABASE_URL;
const argv = process.argv.slice(2);
const allowTest = argv.includes("--allow-test-db");
const dryRun = argv.includes("--dry-run");
const targetsArg = argv[argv.indexOf("--targets") + 1];
const wanted = new Set((argv.includes("--targets") && targetsArg ? targetsArg : "public").split(",").map((s) => s.trim()));
const unknown = [...wanted].filter((t) => !["public", "clan", "dm"].includes(t));
if (!url) { console.error("DATABASE_URL unset"); process.exit(2); }
if (!url.endsWith("/factions_live") && !allowTest) { console.error(`refusing: not factions_live -> ${url} (pass --allow-test-db to override)`); process.exit(2); }
if (unknown.length) { console.error(`unknown --targets: ${unknown.join(", ")} (public, clan, dm)`); process.exit(2); }
const targets = { public: wanted.has("public"), clan: wanted.has("clan"), dm: wanted.has("dm") };
const achievementsChannelId = process.env.ACHIEVEMENTS_CHANNEL_ID;
if (targets.public && !achievementsChannelId) { console.error("ACHIEVEMENTS_CHANNEL_ID unset, so `public` has nowhere to post"); process.exit(2); }

const db = createClient(url);
const started = Date.now();
const r = await backfillAchievementNotices(db, { achievementsChannelId, targets, dryRun, onError: (owner, key, err) => console.error(`notice for ${key} failed for ${owner.kind} ${owner.id}`, err) });
console.log(`${dryRun ? "dry run" : "backfill"}: ${r.unlocks} unlocks, ${r.queued} ${dryRun ? "would be queued" : "queued"}, ${r.skipped} already announced, ${r.failed} failed, targets ${Object.entries(targets).filter(([, v]) => v).map(([k]) => k).join("+")}, in ${Date.now() - started}ms`);
await db.$client.end();
process.exit(r.failed ? 1 : 0);
