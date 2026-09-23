/**
 * Revoke achievements that discredited Hub kills earned (spec 2026-09-22-hub-combat §2.8;
 * runbook docs/deploy/2026-09-22-hub-combat.md). A DRY RUN unless `--apply`.
 *
 *   pnpm --filter @factions/bot exec tsx ../../scripts/revoke-achievements.ts [--apply]
 *
 * ⚠️ Run AFTER `rebuild:kills` — before it, `kills.at_hub` is false everywhere and
 * this finds nothing. Same `factions_live` guard as backfill-achievements.ts.
 */
import { createClient } from "@factions/db";
import { revokeAchievements } from "../apps/bot/src/achievements/revoke.js";

const url = process.env.DATABASE_URL;
const allowTest = process.argv.includes("--allow-test-db");
const apply = process.argv.includes("--apply");
if (!url) { console.error("DATABASE_URL unset"); process.exit(2); }
if (!url.endsWith("/factions_live") && !allowTest) { console.error(`refusing: not factions_live -> ${url} (pass --allow-test-db to override)`); process.exit(2); }

const db = createClient(url);
const r = await revokeAchievements(db, { apply, onError: (o, k, err) => console.error(`rule ${k} failed for ${o}`, err) });
for (const x of r.revoked) console.log(`${apply ? "revoked" : "would revoke"}: ${x.key} from ${x.ownerId}`);
for (const x of r.redated) console.log(`${apply ? "re-dated" : "would re-date"}: ${x.key} for ${x.ownerId}`);
console.log(`${apply ? "applied" : "DRY RUN"}: ${r.owners} owners, ${r.revoked.length} revoked, ${r.redated.length} re-dated, ${r.failed} rule failures`);
await db.$client.end();
process.exit(r.failed ? 1 : 0);
