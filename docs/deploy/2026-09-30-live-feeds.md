# Live page feeds: deploy runbook

Adds the public `/live` page and the bot recorders that feed it. Two migrations, both additive.

## Migrations

- **0061** creates `feed_entries`, the website's copy of the four combat feeds.
- **0062** makes `feed_entries.source_event_id` cascade on delete from `events`. The hand-delete
  runbook `docs/deploy/2026-09-10-credited-kills.md` therefore still works, and deleting events
  removes the matching website entries.

Both are safe to apply with the bot running. A release deploy applies migrations automatically
(`deploy/deploy-release.sh`).

## What runs

The recorders run every bot tick, whether or not Discord channels are set. Their consumer cursors
(`consumer_cursors.consumer_name`):

- `kill-feed-recorder`
- `hit-feed-recorder`
- `killstreak-feed-recorder`
- `long-range-feed-recorder`

Each recorder takes 100 rows per tick. On the first tick after the bot restarts, kills, killstreaks
and long range backfill from the start of history. The hit recorder seeds at the head and logs
`live recorder: hit cursor seeded at the head` once, so hit history starts at deploy.

Each backfill tick adds an estimated 1-2 s of sequential queries (a code-review estimate, not a measurement). `guardedRunner` turns any overrun into
skipped firings, never overlapping runs. The killstreak recorder resolves names and runs for every
kill before dropping non-milestones, so it is the slowest and will finish last. Discord posting is
unaffected.

## Watch

Bot logs (`journalctl -u clan-wars-bot -f`):

- `live recorder: N kill`, `live recorder: N hit`, `live recorder: N killstreak` and
  `live recorder: N long_range` (for example `live recorder: 100 kill`) while backfill runs. They
  stop when caught up.
- `live recorder: <kind> cursor seeded at the head` once per recorder that seeds (expected for
  `hit`, for example `live recorder: hit cursor seeded at the head`).
- `live recorder blocked at event N (<kind>); nothing behind it will record until this one
  succeeds.` means that recorder is stuck on one event. Investigate that event.

Read-only progress check:

    select kind, count(*) from feed_entries group by kind;
    select consumer_name, last_event_id from consumer_cursors where consumer_name like '%-feed-recorder';

The four cursors should advance toward the head of the log, then hold. All four hold an `events.id` in
`consumer_cursors.last_event_id`.

## Web

The web deploy needs the new image (`deploy/deploy-web.sh`). `/live` is public.

## Rollback

The recorders are harmless to leave running. To stop them, revert the bot. Then, optionally, clean
up with the two statements below, against the right database only:

    delete from consumer_cursors where consumer_name like '%-feed-recorder';
    drop table feed_entries;

Do not run anything against `factions_live` without a backup. The deploy script takes one before it
migrates (dumps land in `/var/backups/clan-wars`); restore from that, or confirm it exists, before any cleanup.
Reverting the code alone does not need the cleanup.
