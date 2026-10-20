# Nasdara log fixes (motorbikes, dogs, ruin repairs) — deploy runbook

Part A of the 150-achievements work. An audit of the Nasdara log against `events` found the
parser misreading five shapes, and two shapes it ignored:

- **Whole hit labels.** `Doberman`, `German Shepherd` and `Brown Bear` were cut at the first word
  (`attackerLabel = 'German'`, `entity = 'NO'`). Labels are now whole; a `NO DRIVER` hit's label
  is the vehicle class, and `HitLine.cause` carries the `with X` word for non-player hits.
- **Motorbike deaths.** `killed by NO DRIVER (Motorbike_…)` is now cause `vehicle`, entity = the
  class, and `Motorbike_` is a vehicle prefix (Sunday Driver).
- **Dog deaths.** `dog` is a death cause, stated or inferred from dog bites (`classifyDeath`).
- **Ruin repairs.** `Built X on  with Tool` stays `base.built` with `structure` null. It counts
  toward no build-point board, profile feed or achievement; base-zone enforcement sees it
  unchanged.
- **New events.** `player.conscious` (regained consciousness) and `item.packed` (packed tents).

No migration. Nothing posts to Discord from the new event types: the four feed consumers read
only kills and hits.

1. **Take a `pg_dump` of `factions_live`.** On the bot host, in `/opt/clan-wars`:

       sudo docker compose exec -T postgres pg_dump -U factions -Fc factions_live > ~/factions_live-pre-nasdara-fixes.dump

2. **Deploy.** This is the release deploy: once the tag lands, `clan-wars-deploy.timer` runs
   `deploy/deploy-release.sh`, which rebuilds and restarts the worker and the bot. Do not rebuild
   by hand. From here new lines parse correctly; stored events are untouched until step 4.
   Continue from step 3 once the deploy has finished.

3. **Count before.** Run each with `sudo docker compose exec -T postgres psql -U factions -d
   factions_live`. Measured 2026-10-20; re-measure, as the numbers move with the log:

       select count(*) from events where type='player.died' and payload->>'entity'='NO';                 -- 3 → 0
       select count(*) from events where type='player.hit' and payload->>'attackerLabel'='German';       -- 1 → 0
       select count(*) from events where type='base.built' and payload->>'structure' like 'with %';      -- ~153 → 0
       select count(*) from kills where cause='vehicle';                                                 -- 8 → ≥ 11

4. **Repayload.** Rewrites stored payloads in place from `raw_lines`; it never deletes or inserts
   events, so no ids move and no cursor is touched. Dry run first, read the counts, then apply:

       set -a; . ./.env; set +a
       pnpm --filter @factions/ingest-worker repayload
       pnpm --filter @factions/ingest-worker repayload --apply

   Defaults to `--types player.hit,player.died,base.built`. ⚠️ If you pass `--types`, put its
   value immediately after it: `--types player.hit --apply`. `--types --apply` swallows `--apply`
   as the type list and you get a dry run that looks like it did nothing.

5. **Stop the bot, then reparse to backfill the two new shapes.** `player.conscious` and
   `item.packed` lines have no event yet, and a reparse skips any line that already has one (the
   idempotency index is on file + line), so only these are added. Repayload (step 4) moved no ids,
   so stopping here is early enough.

   ⚠️ The reparse appends at the **head** of the log with brand-new ids and their true, old
   `occurred_at`. The bot runs throughout and its posters keep ticking; `hit-feed-poster` reads
   `events` by id, so any `player.hit` the reparse newly appends would post to #hit-feed. Stop the
   bot first, and note the four poster cursors:

       sudo systemctl stop clan-wars-bot
       select consumer_name, last_event_id from consumer_cursors where consumer_name like '%feed-poster%';

       set -a; . ./.env; set +a
       (cd apps/ingest-worker && npx tsx src/reparse-main.ts)

   The four feed consumers read only kills and hits, so the new event types themselves do not post.

6. **Rebuild kills, park the cursors, resync the Live page, start the bot.** Motorbike and dog
   deaths move from `died` to `vehicle` and `dog`. The bot stays stopped until the end of this step.

   ⚠️ There are FOUR feed consumers, not one (a `'%kill%'` match catches only two):

   | Consumer | Channel | Cursor is |
   |---|---|---|
   | `kill-feed-poster` | #kill-feed | a `kills.event_id` |
   | `hit-feed-poster` | #hit-feed | an `events.id` of a `player.hit` |
   | `killstreak-feed-poster` | #killstreaks | a `kills.event_id` |
   | `long-range-feed-poster` | #long-range | a `kills.event_id` |

   `pnpm rebuild:kills` fails from the workspace root (`drizzle-orm` is not resolvable); use the
   bot-package form:

       set -a; . ./.env; set +a
       cd apps/bot && npx tsx --eval '
         import { createClient } from "@factions/db"; import { rebuildKills } from "./src/kills-tick.js";
         const db = createClient(process.env.DATABASE_URL); console.log(await rebuildKills(db, 1)); await db.$client.end();'

   Then park all four cursors explicitly, so nothing posts history:

       update consumer_cursors set last_event_id = (select max(event_id) from kills)
         where consumer_name in ('kill-feed-poster','killstreak-feed-poster','long-range-feed-poster');
       update consumer_cursors set last_event_id = (select max(id) from events where type = 'player.hit')
         where consumer_name = 'hit-feed-poster';

   Then resync the Live page's kill-derived feeds (`feed_entries` rows and recorder cursors; the
   recorders backfill again from the rebuilt `kills`):

       delete from feed_entries where kind in ('kill','killstreak','long_range');
       delete from consumer_cursors where consumer_name in ('kill-feed-recorder','killstreak-feed-recorder','long-range-feed-recorder');

   `hit-feed-recorder` and the hit entries stay as they are; stale hit `feed_entries` payloads
   (an old "German" label, say) are left as they are.

   Now start the bot: `sudo systemctl start clan-wars-bot`.

   ⚠️ **Bounty claims are frozen when written** and have no cursor over `kills`, so the
   renumbering does not touch them. Nothing to park or resync.

7. **Verify.** Re-run step 3: the first three must return **0**, and the vehicle count must be
   at least 11 (the three `NO` deaths move in). Then:

       select cause, count(*) from kills group by 1 order by 2 desc;
       select type, count(*) from events where type in ('player.conscious','item.packed') group by 1;

   `vehicle` up and `died` down by the same amount, plus any `dog` rows; both new event types
   non-zero. Existing achievements are never revoked by this; the new rules arrive with Part B.
