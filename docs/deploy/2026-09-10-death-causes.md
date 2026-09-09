# Death causes — deploy runbook

The adm parser learns two line shapes it used to drop — `hit by` (`player.hit`) and
`is unconscious` / `is disconnecting while being unconscious` (`player.unconscious`) — and
reads the `Stats>` tail (water, energy, bleed sources) off a bare `died.` line. The kills
consumer hands a bare `died` to `@factions/domain`'s `classifyDeath` together with the
victim's hits and knockouts from the two minutes before it, and writes the verdict —
`mauled`, `starvation`, `dehydration`, `fall`, `bled_out` — into `kills.cause` where it
used to write `died`. Named killers gain `wolf` and `bear` beside `animal`. The player
feed's "Died" line says which. No migration; no new table; nothing posts to Discord.

⚠️ `kills.cause` stays descriptive only. PvP is still decided by `killer_dayz_id`, never by
this column (schema.ts comment; spec §4.9).

1. **Take a `pg_dump` of `factions_live`** — steps 3 and 4 rewrite `events` (additively)
   and `kills` (delete and replay).

2. **Deploy the worker and the bot**: `docker compose build ingest-worker && docker compose
   up -d ingest-worker`, then `sudo systemctl restart clan-wars-bot`. From here, new hit and
   unconscious lines become events as they arrive, and new bare deaths get a verdict.

3. **Backfill the evidence** — replay the stored raw lines through the new parser
   (`apps/ingest-worker/src/reparse.ts`; a deliberate step, never run at startup):

       set -a; . ./.env; set +a
       npx tsx apps/ingest-worker/src/reparse-main.ts

   Every existing event is skipped by `events_idempotency_uniq`; only `player.hit` and
   `player.unconscious` rows land, at the head of the log with their true `occurred_at`.
   Expect roughly one new event per `hit by` / `unconscious` line in `raw_lines`
   (`select count(*) from raw_lines where content like '%hit by%' or content like
   '%unconscious%'` — ~600 at the time of writing).

   ⚠️ The map's two consumers (`positions-projector`, `zone-watch`) read every event type
   and skip the ones they do not project, so the new rows cost them one pass and nothing
   else. Nothing posts.

4. **Rebuild kills** so the historical bare deaths get their verdicts:

       pnpm rebuild:kills --server 1

   The consumer matches evidence by `occurred_at` and victim id, not by event id, so the
   backfilled hits are found even though their ids sit above the deaths'. One long drain,
   as in `docs/deploy/2026-09-08-player-stats.md` step 6.

5. **Verify**:

       select cause, count(*) from kills group by 1 order by 2 desc;

   Before this deploy the live table read `died 43, pvp 27, environment 4, suicide 3,
   bled_out 1`. Expect `died` to shrink and `mauled` / `fall` / `starvation` to appear.
   Some bare deaths stay `died` — a healthy player with no hit in two minutes (an admin
   respawn, say) has nothing to attribute — and that is the right answer, not a gap.

6. **Deploy web** (`deploy/deploy-web.sh`) for the new feed words, and open a profile whose
   feed had a plain "Died" line.
