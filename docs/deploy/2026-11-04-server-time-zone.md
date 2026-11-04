# Server time zone (`servers.time_zone`) — deploy runbook

**Why.** The worker turns ADM log times (the game server's local wall clock) into UTC. Until
now it had one number per server for that, `servers.clock_offset_ms` (`UTC = local + offset`),
derived every tick and kept as a **downward-only ratchet**. Server 1's game clock follows US
Pacific time *with* daylight saving. At the 2026-11-01 fall-back (09:00 UTC) the true offset
went from +7h to +8h; the ratchet refused to rise, and every event after that was stamped one
hour early — enough to make a bounty kill look like it happened before the bounty was placed.
The offset was set to `28800000` (+8h) by hand on 2026-11-04 at about 22:05 UTC.

A hand-set +8h is only right until the spring-forward (2027-03-14), when the ratchet would
drop it to +7h on its own — and then fail again next November. This change adds a nullable
`servers.time_zone` (an IANA zone). When it is set, the worker converts every line with the
zone's real rules, including both DST edges, and stops deriving or writing `clock_offset_ms`.
When it is null, nothing changes: the derived offset and its ratchet work exactly as before.

What the zone path does at the two DST edges (`packages/adm-parser/src/timestamps.ts`):

- **Fall-back (01:00–01:59 happens twice).** Lines are taken as the first pass (PDT) until the
  log's clock visibly steps back; from then on they are the second pass (PST). A backward step
  of under five minutes is write-order jitter, not the fall-back. A file that *starts* inside
  the repeated hour is read as the first pass.
- **Spring-forward (02:00–02:59 never happens).** A clock that steps correctly never writes one;
  if a line says 02:30 anyway, it is read as standard time (02:30 PST = 10:30 UTC), the clock
  that has not stepped yet.

All commands run on the bot host, in `/opt/clan-wars`.

1. **Deploy.** Migration `0073_sudden_harry_osborn.sql` is a single
   `ALTER TABLE "servers" ADD COLUMN "time_zone" text;` — nullable, no default, safe under the
   running code. It ships through the normal release deploy: `clan-wars-deploy.timer` runs
   `deploy/deploy-release.sh`, which applies the migration and **rebuilds the ingest-worker
   image** (the worker runs from a built image, so new code does nothing until that image is
   rebuilt). Do not rebuild by hand. If you ever apply this outside a release deploy, the worker
   still needs `sudo docker compose build ingest-worker && sudo docker compose up -d --force-recreate ingest-worker`
   *after* the migration, or the zone in step 2 is ignored.

2. **Set server 1's zone.** Only after step 1 has finished — the old worker ignores the column.

       sudo -n docker compose exec -T postgres psql -U factions -d factions_live -X -c "
         update servers set time_zone = 'America/Los_Angeles' where id = 1;
         select id, name, map, clock_offset_ms, time_zone from servers order by id;"

   Spell the zone exactly. Postgres does not check it; the worker does, and a misspelled zone
   **stops ingest for that server** (an error in the worker log every tick) rather than
   falling back to the offset. That is deliberate: a quiet fallback is the bug this fixes.
   `clock_offset_ms` stays as it is (28800000). With a zone set the worker neither reads nor
   writes it; it is only the fallback if the zone is ever cleared.

3. **Check.** Within a minute or two of the next sweep:

       sudo -n docker compose logs --since 10m ingest-worker | grep -E "time zone|clock offset|not a time zone"

   Expect nothing. A `file times disagree with time zone` warning means the listed files'
   times do not fit the zone — read it before trusting new events. Then confirm new events
   sit at "now", not an hour off:

       sudo -n docker compose exec -T postgres psql -U factions -d factions_live -X -c "
         select max(occurred_at) as newest_event, now() from events where server_id = 1;"

## Not part of this change: the events already stamped wrong

Events on server 1 from the fall-back (2026-11-01 09:00 UTC) until the hand fix
(2026-11-04 ~22:05 UTC) are **still one hour early** in `events.occurred_at`, and so is
everything projected from them (kills, sessions, feeds, bounty outcomes). Setting the zone
does not repair them, and neither does a reparse: `events_idempotency_uniq` is on file and
line, not time, so a reparse only adds events that do not exist yet. Repairing those three
days is a separate, deliberate decision with its own runbook, and is not done here.
