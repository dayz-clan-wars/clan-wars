# Nasdara log fixes (motorbikes, dogs, land mines, ruin repairs) — deploy runbook

Part A of the 150-achievements work. An audit of the Nasdara log against `events` found the
parser misreading six shapes, and two shapes it ignored:

- **Whole hit labels.** `Doberman`, `German Shepherd` and `Brown Bear` were cut at the first word
  (`attackerLabel = 'German'`, `entity = 'NO'`). Labels are now whole (and trimmed); a `NO DRIVER`
  hit's label is the vehicle class, and `HitLine.cause` carries the `with X` word for non-player hits.
- **Motorbike deaths.** `killed by NO DRIVER (Motorbike_…)` is now cause `vehicle`, entity = the
  class, and `Motorbike_` is a vehicle prefix (Sunday Driver).
- **Dog deaths.** `dog` is a death cause, stated or inferred from dog bites (`classifyDeath`).
- **Land-mine deaths.** `killed by LandMineTrap` was cause `environment` (the explosion pattern's
  `mine\b` finds no word boundary inside `LandMineTrap`); it is now `explosion`. Nothing keys off
  `environment` for these: no achievement rule reads it, and the feeds only change the wording.
- **Ruin repairs.** `Built X on  with Tool` stays `base.built` with `structure` null. It counts
  toward no build-point board, profile feed or achievement; base-zone enforcement sees it
  unchanged.
- **New events.** `player.conscious` (regained consciousness) and `item.packed` (packed tents).

No migration. Nothing posts to Discord from the new event types: the four feed consumers read
only kills and hits.

All commands run on the bot host, in `/opt/clan-wars`. Every SQL statement below is shown inside
its psql call; on this host `pnpm` is `/home/acab/.local/bin/pnpm`, and every script runs in a
subshell that loads `.env`.

1. **Take a `pg_dump` of `factions_live`.**

       cd /opt/clan-wars && sudo -n docker compose exec -T postgres pg_dump -U factions -Fc factions_live > ~/factions_live-pre-nasdara-fixes.dump

2. **Deploy.** This is the release deploy: once the tag lands, `clan-wars-deploy.timer` runs
   `deploy/deploy-release.sh`, which rebuilds and restarts the worker and the bot. Do not rebuild
   by hand. From here new lines parse correctly; stored events are untouched until step 4.
   Continue from step 3 once the deploy has finished.

3. **Count before.** Measured 2026-10-20 (read-only); re-measure and write your numbers down,
   as they move with the log. The right-hand column is what step 7 should show.

       cd /opt/clan-wars && sudo -n docker compose exec -T postgres psql -U factions -d factions_live -X -c "
         select count(*) as hits_without_cause from events where type='player.hit' and not payload ? 'cause';
         select count(*) as bare_deaths_without_stats from events where type='player.died' and payload->>'cause'='died' and not payload ? 'bleedSources';
         select count(*) as no_driver_deaths from events where type='player.died' and payload->>'entity'='NO';
         select count(*) as german_hits from events where type='player.hit' and payload->>'attackerLabel'='German';
         select count(*) as ruin_repairs from events where type='base.built' and payload->>'structure' like 'with %';
         select count(*) as mine_deaths_as_environment from events where type='player.died' and payload->>'entity'='LandMineTrap' and payload->>'cause'='environment';
         select count(*) as vehicle_kills from kills where cause='vehicle';
         select count(*) as raw_lines from raw_lines;
         select max(id) as max_event_id from events;"

   | Query | 2026-10-20 | After step 6 | Why |
   |---|---|---|---|
   | `hits_without_cause` | 10,887 (every hit) | **0** | repayload adds the `cause` key to every `player.hit` (null for a player hit) |
   | `bare_deaths_without_stats` | 43 | **0** | old bare deaths stored before the `Stats>` fields; all 43 raw lines carry them, so repayload fills `water`/`energy`/`bleedSources` and the rebuild may reclassify them (today 43 `kills` rows, `died` or `finished`) |
   | `no_driver_deaths` | 3 | **0** | the motorbike deaths; entity becomes the `Motorbike_…` class, cause `vehicle` |
   | `german_hits` | 1 | **0** | label becomes `German Shepherd` |
   | `ruin_repairs` | 161 | **0** | `structure` becomes null |
   | `mine_deaths_as_environment` | 2 | **0** | cause becomes `explosion` (event 48943 and 81546) |
   | `vehicle_kills` | 8 | **≥ 11** | the three motorbike deaths move in after the rebuild |
   | `raw_lines` | 103,442 | — | sizes the reparse in step 5 |
   | `max_event_id` | 83,298 | — | for reference |

   And the cause distribution, to compare in step 7:

       cd /opt/clan-wars && sudo -n docker compose exec -T postgres psql -U factions -d factions_live -X -c "select cause, count(*) from kills group by 1 order by 2 desc;"

   On 2026-10-20: pvp 1829, died 716, explosion 112, suicide 88, bled_out 23, finished 16,
   infected 13, mauled 10, environment 8, vehicle 8, dehydration 5, starvation 4, bear 3,
   drowned 3, wolf 1 (2,839 rows).

4. **Repayload, then vacuum.** Rewrites stored payloads in place from `raw_lines`; it never
   deletes or inserts events, so no ids move and no cursor is touched. Dry run first, read the
   counts, then apply:

       cd /opt/clan-wars && (set -a && . ./.env && set +a && /home/acab/.local/bin/pnpm -s --filter @factions/ingest-worker repayload)
       cd /opt/clan-wars && (set -a && . ./.env && set +a && /home/acab/.local/bin/pnpm -s --filter @factions/ingest-worker repayload --apply)

   Expect `changed` to show roughly every `player.hit` (≈ 10,887 plus hits since), at least 48
   `player.died` (3 motorbike + 43 bare + 2 mine) and ≈ 161 `base.built`.

   Defaults to `--types player.hit,player.died,base.built`. ⚠️ If you pass `--types`, put its
   value immediately after it: `--types player.hit --apply`. `--types --apply` swallows `--apply`
   as the type list and you get a dry run that looks like it did nothing.

   Every hit row was rewritten, so reclaim the dead tuples and refresh the planner's statistics:

       cd /opt/clan-wars && sudo -n docker compose exec -T postgres psql -U factions -d factions_live -X -c "VACUUM ANALYZE events;"

5. **Stop the bot, note the cursors, reparse to backfill the two new shapes.** `player.conscious`
   and `item.packed` lines have no event yet, and a reparse skips any line that already has one
   (the idempotency index is on file + line), so only these are added. Repayload (step 4) moved
   no ids, so stopping here is early enough.

   ⚠️ The reparse appends at the **head** of the log with brand-new ids and their true, old
   `occurred_at`. With the bot running, its consumers would read those old events as if new.
   Stop the bot first, and write down the four poster cursors (step 6 puts them back):

       sudo systemctl stop clan-wars-bot
       cd /opt/clan-wars && sudo -n docker compose exec -T postgres psql -U factions -d factions_live -X -c "select consumer_name, last_event_id from consumer_cursors where consumer_name in ('kill-feed-poster','hit-feed-poster','killstreak-feed-poster','long-range-feed-poster') order by 1;"

   Then reparse. It replays every stored line (≈ 2 queries a line, almost all of them no-op
   inserts). Timed on a local Postgres at 0.45 ms a line, so the 103,442 lines measured in step 3
   take about 50 seconds; allow up to 5 minutes on the host. **The bot is down for this time and
   for the rebuild in step 6.** The worker keeps running and keeps ingesting.

       cd /opt/clan-wars && (set -a && . ./.env && set +a && cd apps/ingest-worker && /home/acab/.local/bin/pnpm -s exec tsx src/reparse-main.ts)

   Then move the presence promoter to the head. It reads every event that carries a position,
   with no age check, so the old `item.packed` events just appended (each has a position) would
   otherwise promote a pending member for being at a base weeks ago:

       cd /opt/clan-wars && sudo -n docker compose exec -T postgres psql -U factions -d factions_live -X -c "update consumer_cursors set last_event_id = (select max(id) from events) where consumer_name = 'presence-promoter';"

   (Live events the worker ingested while the bot was down are skipped by this too; a pending
   member seen at base in those minutes is promoted the next time they are seen there.)

   The four feed consumers read only kills and hits, so the new event types themselves do not post.

6. **Rebuild kills, restore the cursors, resync the Live page, start the bot.** Motorbike, dog and
   land-mine deaths move from `died`/`environment` to `vehicle`, `dog` and `explosion`. The bot
   stays stopped until the end of this step.

   ⚠️ There are FOUR feed consumers, not one (a `'%kill%'` match catches only two):

   | Consumer | Channel | Cursor is |
   |---|---|---|
   | `kill-feed-poster` | #kill-feed | a `kills.event_id` |
   | `hit-feed-poster` | #hit-feed | an `events.id` of a `player.hit` |
   | `killstreak-feed-poster` | #killstreaks | a `kills.event_id` |
   | `long-range-feed-poster` | #long-range | a `kills.event_id` |

   `pnpm rebuild:kills` fails from the workspace root (`drizzle-orm` is not resolvable); use the
   bot-package form. ⚠️ `--input-type=module` is required: without it tsx compiles the eval as
   CommonJS and refuses the top-level `await`.

       cd /opt/clan-wars && (set -a && . ./.env && set +a && cd apps/bot && /home/acab/.local/bin/pnpm -s exec tsx --input-type=module --eval '
         import { createClient } from "@factions/db"; import { rebuildKills } from "./src/kills-tick.js";
         const db = createClient(process.env.DATABASE_URL); console.log(await rebuildKills(db, 1)); await db.$client.end();')

   Then restore the four poster cursors to the values you **noted in step 5** (not to the max).
   The rebuild renumbers `kills.id` but keeps every `kills.event_id`, and no `events.id` moved, so
   the noted values still mean the same place. History stays unposted, and the kills and hits the
   worker logged while the bot was down post as normal when it starts. Put your numbers in for
   `<…>`:

       cd /opt/clan-wars && sudo -n docker compose exec -T postgres psql -U factions -d factions_live -X -c "
         update consumer_cursors set last_event_id = <kill-feed-poster>       where consumer_name = 'kill-feed-poster';
         update consumer_cursors set last_event_id = <hit-feed-poster>        where consumer_name = 'hit-feed-poster';
         update consumer_cursors set last_event_id = <killstreak-feed-poster> where consumer_name = 'killstreak-feed-poster';
         update consumer_cursors set last_event_id = <long-range-feed-poster> where consumer_name = 'long-range-feed-poster';
         select consumer_name, last_event_id from consumer_cursors where consumer_name like '%feed-poster' order by 1;"

   Then resync the Live page's kill-derived feeds (`feed_entries` rows and recorder cursors; the
   recorders backfill again from the rebuilt `kills`):

       cd /opt/clan-wars && sudo -n docker compose exec -T postgres psql -U factions -d factions_live -X -c "
         delete from feed_entries where kind in ('kill','killstreak','long_range');
         delete from consumer_cursors where consumer_name in ('kill-feed-recorder','killstreak-feed-recorder','long-range-feed-recorder');"

   `hit-feed-recorder` and the hit entries stay as they are; stale hit `feed_entries` payloads
   (an old "German" label, say) are left as they are.

   Now start the bot:

       sudo systemctl start clan-wars-bot

   ⚠️ **Expect achievement cards with past dates.** The rebuild gives every `kills` row a new id
   above the achievement tick's `achievements:kills` watermark (8,873 on 2026-10-20), so on start
   every player with a kill or a death is re-evaluated. Any unlock of an EXISTING tile that the
   corrected history now deserves (Sunday Driver for the motorbike victims, say) is awarded and
   posts its normal Discord card, dated when it was earned. This is accepted; nothing is revoked.

   ⚠️ **Bounty claims are frozen when written** and have no cursor over `kills`, so the
   renumbering does not touch them. Nothing to park or resync.

7. **Verify.** Re-run the step 3 counts: the first six must return **0**, and `vehicle_kills`
   must be at least **11** (8 + the three motorbike deaths). Then compare the cause distribution
   with step 3's:

       cd /opt/clan-wars && sudo -n docker compose exec -T postgres psql -U factions -d factions_live -X -c "select cause, count(*) from kills group by 1 order by 2 desc;"
       cd /opt/clan-wars && sudo -n docker compose exec -T postgres psql -U factions -d factions_live -X -c "select type, count(*) from events where type in ('player.conscious','item.packed') group by 1;"

   Expected against step 3: `vehicle` up by **at least 3**; `explosion` up by 2 and `environment`
   down by 2 (the mines); `died` down. Other `died` rows may move to `bled_out`, `starvation`,
   `dehydration`, `fall` or `dog` now that the 43 bare deaths carry their stats and hits carry
   whole labels, so `died` can drop by more than `vehicle` rises. The total stays the same apart
   from kills logged since step 3. Both new event types non-zero.
