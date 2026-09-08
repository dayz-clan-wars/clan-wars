# Raids and notices (increment 3a) — deploy runbook

Migration 0023 adds seven nullable columns to `factions` and six tables. Nothing is dropped;
the bot may keep running while it applies, but restart it straight after.

⚠️ **The two new consumers start live, not from the beginning of the log.** Left at cursor 0
they would fold every historical `flag.lowered`/`flag.raised`, and while that is harmless for
`raids`/`season_standings` it is *wrong* for `factions.flag_down_since`: the raid consumer sets
that column only when it is currently null, so the fold would stamp it from the earliest
historical lower and clear it at the earliest later raise, leaving a clan that is under siege
right now reading as safe (keeps its supply kit, never goes `dormant(raided)`) and a clan
raided months ago reading as under siege (loses supplies, goes dormant on the next tick).
So step 5 seeds both cursors at the log head. The deliberate trade: **pre-deploy lowers and
raises are not scored, and season 1 starts at deploy.** The flag-down state stays coherent
from the first tick, which is what the live game depends on.

Note also that a lower consumed before season 1 exists is **dropped, not deferred** — the raid
consumer logs `no season` once per server and advances past it. Step 4 is load-bearing and
must happen before the restart.

1. **Read the migration.** `packages/db/migrations/0023_raids_and_queues.sql`.
2. **Apply 0023** with the one-off runner from `docs/deploy/2026-09-02-dormancy.md`.
3. **Stamp any pre-existing dormant clan's reason** (there are none on this deployment):
       update factions set dormant_reason = 'inactive' where status = 'dormant' and dormant_reason is null;
4. **Open season 1** — the raid consumer skips (and logs once per server) until this exists:
       insert into seasons (server_id, number, started_at) select id, 1, now() from servers where active;
5. **Seed both consumer cursors at the log head**, BEFORE the restart. `consumer_cursors` is
   `@factions/event-log`'s table: `consumer_name` (primary key), `last_event_id`, `updated_at`.

       insert into consumer_cursors (consumer_name, last_event_id, updated_at)
       select 'raid-consumer', coalesce(max(id), 0), now() from events
       on conflict (consumer_name) do update
         set last_event_id = excluded.last_event_id, updated_at = now();

       insert into consumer_cursors (consumer_name, last_event_id, updated_at)
       select 'raise-consumer', coalesce(max(id), 0), now() from events
       on conflict (consumer_name) do update
         set last_event_id = excluded.last_event_id, updated_at = now();

   Verify before restarting:

       select consumer_name, last_event_id from consumer_cursors
       where consumer_name in ('raid-consumer', 'raise-consumer');
       select max(id) from events;

   The three numbers must agree. If the bot is restarted before this runs, stop it, run the
   two statements, then `update factions set flag_down_since = null, flag_down_by_dayz_id = null;`
   to discard the incoherent fold, and start it again.
6. **Env.** Bot `.env`: `WAR_LOG_CHANNEL_ID=1546677744044216432` (`#war-log`, created 2026-09-07 under the Feeds category; `#faction-feed` was renamed `#clan-feed` the same day, id unchanged) (optional; without it raids
   queue and post in order once set). Web container (`docker-compose.yml`): `SITE_BASE_URL`
   alongside `WEB_BASE_URL`, same value — the invite DM's link is built inside the package.
7. **Deploy** bot and web together: `docker compose build web && docker compose up -d web &&
   sudo systemctl restart clan-wars-bot`.
8. **Confirm:** `journalctl -u clan-wars-bot -f` — no `raid tick failed` / `raise tick failed` /
   `notice tick failed`; `select count(*) from clan_notices where posted_at is null and
   failed_at is null and target = 'channel'` is the number of channel notices waiting for
   increment 3b's channels (expected: everything channel-bound, none failed).
9. **Acceptance.** A non-member lowers a test clan's flag: within a tick `raids` has a row,
   `factions.flag_down_since` is set, `#war-log` shows the raid line, every full member has a
   flag_down DM. A member raises: `defenses` row, `#war-log` defense line, `flag_down_since`
   null. Then the dormancy check from `docs/deploy/2026-09-05-declarations.md` step 9.
10. **What did not change / what waits.** No clan channel or role exists yet (3b); channel
    notices queue unfailed. `dormant` still DMs the leader as before AND queues the channel
    line. The verification DMs (`linked`, lockouts) still ride `notifyCompleted`, not the queue.

## Developer note (not a deploy step)

Migration 0023 was hand-edited after it was generated. Any working copy that applied an
earlier version of it has a stale schema, and the per-package test databases are the usual
place that bites: drop each `factions_test_*` database once so the migrations re-apply from
scratch. **Never drop `factions_live`.**
