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

2. **Deploy the worker and the bot** (`sudo docker compose build ingest-worker && sudo docker
   compose up -d ingest-worker`, `sudo systemctl restart clan-wars-bot`). From here new lines
   parse correctly; stored events are untouched until step 4.

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

5. **Reparse, to backfill the two new shapes.** `player.conscious` and `item.packed` lines have
   no event yet, and a reparse skips any line that already has one (the idempotency index is on
   file + line), so only these are added:

       (cd apps/ingest-worker && npx tsx src/reparse-main.ts)

   ⚠️ It appends at the **head** of the log with brand-new ids and their true, old
   `occurred_at`. The four feed consumers (`kill-feed-poster`, `hit-feed-poster`,
   `killstreak-feed-poster`, `long-range-feed-poster`) read only kills and hits, so the new types
   do not post. Step 6 parks the cursors anyway, because it also rebuilds `kills`.

6. **Rebuild kills.** Motorbike and dog deaths move from `died` to `vehicle` and `dog`.
   ⚠️ Before this step, park the feed cursors so nothing from the rebuild posts as if it
   happened today:

       select consumer_name, last_event_id from consumer_cursors where consumer_name like '%feed-poster%';

   ⚠️ There are FOUR feed consumers, not one (a `'%kill%'` match catches only two):

   | Consumer | Channel | Cursor is |
   |---|---|---|
   | `kill-feed-poster` | #kill-feed | a `kills.event_id` |
   | `hit-feed-poster` | #hit-feed | an `events.id` of a `player.hit` |
   | `killstreak-feed-poster` | #killstreaks | a `kills.event_id` |
   | `long-range-feed-poster` | #long-range | a `kills.event_id` |

   Note each value, run the rebuild, then restore any feed you do not want posting history:
   `update consumer_cursors set last_event_id = <max> where consumer_name = '<name>'`, where
   `<max>` is `select max(event_id) from kills` for the three kill-derived feeds and `select
   max(id) from events where type = 'player.hit'` for `hit-feed-poster`.

   `pnpm rebuild:kills` fails from the workspace root (`drizzle-orm` is not resolvable); use the
   bot-package form:

       set -a; . ./.env; set +a
       cd apps/bot && npx tsx --eval '
         import { createClient } from "@factions/db"; import { rebuildKills } from "./src/kills-tick.js";
         const db = createClient(process.env.DATABASE_URL); console.log(await rebuildKills(db, 1)); await db.$client.end();'

   Notes:
   - ⚠️ **Bounty claims are frozen when written** and have no cursor over `kills`, so the
     renumbering does not touch them. Nothing to park or resync.
   - ⚠️ **Live page resync.** The Live page's kill, killstreak and long-range rows come from
     `feed_entries`. Delete those three feeds' `feed_entries` rows and the three recorder cursors
     (the `*-feed-recorder` consumers for kills, killstreaks and long range); the recorders
     backfill again from the rebuilt `kills`. Leave the hit feed's rows alone.

7. **Verify.** Re-run step 3: the first three must return **0**, and the vehicle count must be
   at least 11 (the three `NO` deaths move in). Then:

       select cause, count(*) from kills group by 1 order by 2 desc;
       select type, count(*) from events where type in ('player.conscious','item.packed') group by 1;

   `vehicle` up and `died` down by the same amount, plus any `dog` rows; both new event types
   non-zero. Existing achievements are never revoked by this; the new rules arrive with Part B.
