# Credited kills, mutual kills, grenades — deploy runbook

Follows `2026-09-10-death-causes.md` (deployed 2026-09-09 as v1.2.0). Three fixes to what the
log is read as, found by auditing every kill-shaped line in `raw_lines` against `kills`:

- **Mutual kills.** When the killer died in the same exchange the log marks them `(DEAD)` too,
  and both the kill regex and the hit regex missed the marker — two real PvP kills were filed as
  `environment`, three player hits as environment hits. Fixed in the parser.
- **Grenades.** `killed by 6-M7 Frag Grenade` names no thrower; it is now `explosion` ("in an
  explosion"), not `environment`.
- **Credited kills.** A player shot to `FINISH_HP_MAX` (25) HP or below, or knocked out after the
  shot, who then dies with nothing but a player having hurt them since, is recorded as a kill by
  that player — `cause = 'finished'`, weapon and range from the hit line, faction and friendly
  fire resolved as for any kill. The site says "Finished by", the Discord kill feed "finished".
  Four such deaths were in the log at the time of writing (27 → 31 PvP kills).

No migration. Nothing new posts to Discord except that a credited kill IS a kill, so the kill
feed will post the four historical ones once the rebuild lands — see step 4.

1. **Take a `pg_dump` of `factions_live`.**

2. **Deploy the worker and the bot** (`docker compose build ingest-worker && docker compose up -d
   ingest-worker`, `sudo systemctl restart clan-wars-bot`).

3. **Delete the events the old parser got wrong, then reparse.** ⚠️ The reparse skips any line
   that already has an event (`events_idempotency_uniq` is on file + line, not type), so a
   misparsed line is never corrected by a reparse alone. Delete first — all hit and unconscious
   events (their payloads gain `weapon`/`distanceM`, and three were mis-typed), and the four
   `player.died` rows whose cause was `environment` (two mutual kills, two grenades):

       delete from events where type in ('player.hit', 'player.unconscious');            -- 505 rows on 2026-09-10
       -- kills rows reference events (kills_event_id_events_id_fk): drop the four stale rows first — the rebuild recreates them
       delete from kills where event_id in (select id from events where type = 'player.died' and payload->>'cause' = 'environment');
       delete from events where type = 'player.died' and payload->>'cause' = 'environment'; -- 4 rows

   Nothing consumes those rows by id — the kills consumer matches evidence by `occurred_at`.

   ⚠️ **But the feed cursors DO need parking, and `hit-feed-poster`'s before this step, not
   after it.** The reparse appends the deleted `player.hit` rows back at the **head** of the log
   with brand-new ids and their true, old `occurred_at`. #hit-feed reads `events` by id, so every
   one of those 505 rows is "new" to it and it will replay weeks of old firefights into a public
   channel. Note the four cursors now (the table in step 4), and restore them after step 4.

       set -a; . ./.env; set +a
       (cd apps/ingest-worker && npx tsx src/reparse-main.ts)

4. **Rebuild kills.** ⚠️ Before this step, park the feed cursors so the rebuild's four new
   PvP rows and two recovered mutual kills do not post to Discord as if they happened today:

       select consumer_name, last_event_id from consumer_cursors where consumer_name like '%feed-poster%';

   ⚠️ **There are FOUR feed consumers, not one**, and an earlier version of this runbook matched
   on `'%kill%'`, which silently caught only two of them:

   | Consumer | Channel | Cursor is |
   |---|---|---|
   | `kill-feed-poster` | #kill-feed | a `kills.event_id` |
   | `hit-feed-poster` | #hit-feed | an `events.id` of a `player.hit` |
   | `killstreak-feed-poster` | #killstreaks | a `kills.event_id` |
   | `long-range-feed-poster` | #long-range | a `kills.event_id` |

   All four need parking, for the same reason: a reparse appends events at the **head** of the
   log carrying their true, **old** `occurred_at`, so the new ids land above every cursor and
   every feed reads them as new. Skip two of them and weeks-old combat posts into two public
   channels in front of live players. Note each cursor's value before the rebuild, and after it
   restore any feed you do not want posting history — `update consumer_cursors set last_event_id
   = <max> where consumer_name = '<name>'` (`<max>` is `select max(event_id) from kills` for the
   three kill-derived feeds, and `select max(id) from events where type = 'player.hit'` for
   `hit-feed-poster`).

   The kill feed's cursor is a `kills.event_id`; the recovered rows all carry event ids BELOW the
   current cursor except the two re-parsed mutual kills, which land at the head of the log with
   NEW ids. Decide whether you want those two posted (they are real kills, days old). To post
   nothing, after the rebuild set the kill feed cursor to `select max(event_id) from kills`.

   `pnpm rebuild:kills --server 1` fails on the host (`drizzle-orm` is not resolvable from the
   workspace root — pre-existing; the same function runs from the bot package):

       cd apps/bot && npx tsx --eval '
         import { createClient } from "@factions/db"; import { rebuildKills } from "./src/kills-tick.js";
         const db = createClient(process.env.DATABASE_URL); console.log(await rebuildKills(db, 1)); await db.$client.end();'

5. **Verify**:

       select cause, count(*) from kills group by 1 order by 2 desc;

   Expect `environment` gone, `explosion 2`, `finished 4`, `pvp 29`. (Ran 2026-09-10: exactly that;
   `died` 43 → 38. The kill feed's cursor was parked at `max(event_id)`, so nothing posted.)

6. **Deploy web** (`deploy/deploy-web.sh`).
