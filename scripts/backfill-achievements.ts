/**
 * Backfill achievements for every owner from history (spec
 * `docs/superpowers/specs/2026-09-11-achievements-design.md`; runbook
 * `docs/deploy/2026-09-12-achievements.md`).
 *
 *   DATABASE_URL=postgres://... pnpm backfill:achievements
 *
 * ⚠️ Refuses to run against a URL whose database name is not `factions_live` unless
 * `--allow-test-db` is also passed — same guard as `scripts/rebuild-kills.ts`.
 *
 * ⚠️ announce:false — a backfill must never post hundreds of historical unlocks. The
 * tick's own watermarks are set to the head when this finishes, so the live tick starts
 * from now. The runbook is the only interlock: the live tick (`ACHIEVEMENTS_TICK`) MUST
 * be off while this runs, because both share the watermarks and the resume marker.
 *
 * `batch` here does NOT bound how many owners this call drains — on the `everyone: true`
 * path `achievementsTick` always drains every owner in one call regardless of `batch`;
 * `batch` only sizes the chunks it reads `player_positions`/`clan_pins` history in while
 * feeding the explorer/cartographer counters first. Pass a sane chunk size, not
 * `Number.MAX_SAFE_INTEGER` — that would ask it to load the entire position/pin history
 * in one chunk.
 */
import { createClient } from "@factions/db";
import { achievementsTick } from "../apps/bot/src/achievements/tick.js";

const url = process.env.DATABASE_URL;
const allowTest = process.argv.includes("--allow-test-db");
if (!url) { console.error("DATABASE_URL unset"); process.exit(2); }
if (!url.endsWith("/factions_live") && !allowTest) { console.error(`refusing: not factions_live -> ${url} (pass --allow-test-db to override)`); process.exit(2); }

const db = createClient(url);
const started = Date.now();
const r = await achievementsTick(db, { everyone: true, announce: false, batch: 500,
  onError: (owner, key, err) => console.error(`rule ${key} failed for ${owner.kind} ${owner.id}`, err) });
console.log(`backfill: ${r.evaluated} owners evaluated, ${r.unlocked} unlocks inserted, ${r.failed} rule failures, in ${Date.now() - started}ms`);
await db.$client.end();
process.exit(r.failed ? 1 : 0);
