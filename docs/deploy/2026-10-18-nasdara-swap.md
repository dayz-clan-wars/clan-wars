# Nasdara swap — Clan Wars moves from Chernarus to Nasdara

Spec: `docs/superpowers/specs/2026-10-17-nasdara-swap-design.md`.

Switch day is planned for 2026-10-18.

⚠️ **Cutover race.** A Chernarus raise declared after the cutover instant is not
cleared (`--before` excludes later declarations), and that base would carry onto
Nasdara. Stopping the server is not enough on its own: the worker fetches the ADM
on its own schedule and the bot's consumers fold it in after that, so a raise made
in the last minute of the session can still become a declaration minutes after the
stop. So the Chernarus game server is STOPPED, the bot release ships, ingestion and
the raise consumer are proved caught up, and only THEN is the instant taken. Steps 3
to 6 run back to back; the Nitrado mission switch and start come last, behind a
zero-declarations check.

⚠️ **The bot ships on switch day, not before.** This branch's bot is the Nasdara bot:
on a live Chernarus server it would pick Nasdara towns for KotH, drop the Hub ban, and
`release:sync` would announce the move in Discord before it happens. So it deploys in
step 3, after the Chernarus server is stopped.

Every `pnpm` command runs on the host, in `/opt/clan-wars`, with `.env` loaded
(`. ./.env`, not `. .env`):

    cd /opt/clan-wars && set -a && . ./.env && set +a

SQL runs against `factions_live` through the postgres container; each SQL block
below is fed to it on stdin, for example:

    cd /opt/clan-wars && sudo docker compose exec -T postgres psql -U factions -d factions_live -v ON_ERROR_STOP=1 <<'SQL'
    select id, tag, reserved_until from factions where status = 'reserved';
    SQL

(Define once `psqlcw() { sudo docker compose exec -T postgres psql -U factions -d factions_live -v ON_ERROR_STOP=1; }`
in the shell (from `/opt/clan-wars`); the blocks below use it as `psqlcw <<'SQL' ... SQL`.)

## 1. Before switch day

1. **Release the nasdara mission.** In `dayz-one-life/nasdara`, the unreleased
   change (the object spawner files and the 14-day flag refresh) sits on `main`.
   Publish a GitHub release `v1.0.1`. The deploy workflow uploads to the Clan Wars
   server (Nitrado 19831378) at `/dayzxb_missions/dayzOffline.nasdara/`. Confirm that
   folder holds `cfggameplay.json`, `db/globals.xml` and `koth/default/`.
2. **Mirror the tiles.** From the One Life checkout on the host (its `MAPS` and
   `dzmap.yaml` already include `nasdara`):

       sudo ./deploy/mirror-tiles.sh -p 4
       ls -l /var/www/tiles/nasdara/topographic/0/0/0.webp

3. **Prepare this branch's release, but do not tag it.** Merge the
   `release/x.y.z` changelog PR as usual; the tag is pushed in step 3, after the
   Chernarus server is stopped (see the warning at the top). The deploy timer ships
   whatever tag it sees, so a tag pushed early ships the Nasdara bot onto Chernarus.

## 2. List what the wipe will cost

    psqlcw <<'SQL'
    select id, tag, reserved_until from factions where status = 'reserved';
    SQL

A reserved clan's base is cleared with the rest, so it cannot activate (activation
joins `declarations`) and lapses within 24 hours. Accepted: it re-founds on Nasdara.
Tell those clans first.

## 3. Stop the server, ship the bot, wait for catch-up, take the cutover instant

1. **Stop.** In Nitrado, STOP the Chernarus game server (19831378) so nobody can
   raise a flag. Confirm the Nitrado panel shows the server **stopped** (not
   "stopping" or "restarting") before going on.
2. **Tidy `.env`.** Delete `AIRDROP_TICK`, `AIRDROP_WEEKLY_CAP`, `AIRDROP_MIN_POP` and
   `HUB_BAN_TICK` from `/opt/clan-wars/.env`. The new bot no longer reads them;
   leaving them is harmless but misleading.
3. **Ship the bot.** Push the release tag. Within two minutes the deploy timer runs
   `deploy-release.sh`, which stops the bot, web and worker, dumps `factions_live`,
   applies migration 0068 (`servers.map_changed_at`, nullable, additive) and starts
   everything again. Watch it through:

       journalctl -u clan-wars-deploy -f
       sudo -u acab journalctl -u clan-wars-bot -n 1   # "bot ready as"

   `release:sync` queues the changelog now, so the release post lands as the move
   happens, not before.
4. **Wait for catch-up.** The worker must have fetched the stopped session's final
   ADM, and the raise and pole consumers must have folded every event of it. Run this
   twice, at least two minutes apart (the worker sweeps every 60 s):

       psqlcw <<'SQL'
       select (select max(id) from events where server_id = 1) as last_event_id,
              (select max(occurred_at) from events where server_id = 1) as last_event_at,
              (select lines_ingested from adm_files where server_id = 1 order by id desc limit 1) as newest_adm_lines,
              c.consumer_name, c.last_event_id as cursor
       from consumer_cursors c
       where c.consumer_name in ('raise-consumer', 'pole-projector-bot');
       SQL

   Caught up means all of: `last_event_id` and `newest_adm_lines` did not change
   between the two runs; `last_event_at` is about when the server stopped; and BOTH
   cursors are at or past `last_event_id`. ⚠️ The pole cursor matters as much as the
   raise cursor: `pole-tick` stamps each pole with `servers.map` as it reads it, so a
   Chernarus raise folded after step 5 is filed as a Nasdara pole.
5. **Take the instant.** Only now, take it once and keep it in the shell for steps 4
   to 6:

       CUT=$(date -u +%Y-%m-%dT%H:%M:%SZ); echo "$CUT"

   Write it down. Use this SAME `$CUT` for `clear-bases` and `map-cutover`; ⚠️ a later
   instant for `map-cutover` silently lengthens every clan's grace. Do not leave a gap
   between here and step 6: run 4, 5 and 6 back to back.

## 4. Map identity and dormancy grace — BEFORE clearing anything

    psqlcw <<'SQL'
    update servers set map = 'nasdara' where id = 1;
    SQL
    pnpm map-cutover --server 1 --at "$CUT"

The grace applies to active clans only. Each gets a week from the cutover to raise a
flag again before dormancy counts.

⚠️ This step comes BEFORE `clear-bases`, not after. The dormancy tick runs every few
seconds: once a clan's base is cleared, its clock falls back to its activation and the
season start, so an active clan whose last raise is more than a week old goes dormant
on the very next tick unless `map_changed_at` is already set. That happened on
2026-10-17: ADM and VOLK went dormant in the 15 s between `clear-bases` and
`map-cutover`, posted to the feed and their channels, and had to be revived by hand
(`PgDormancyStore.revive`). The grace reads only `map_changed_at`, so setting it first
changes nothing until the bases are gone.

## 5. Close open events and clear placements

    psqlcw <<'SQL'
    update koth_events set state = 'cancelled', cancel_posted_at = now()
      where server_id = 1 and state = 'scheduled';
    update koth_votes set state = 'void', closed_at = now() where state = 'open';
    update airdrop_events set state = 'ended', ended_at = now()
      where state in ('announced', 'live');
    SQL

A `live` KotH row is left alone: the restart tick's restore arm closes it.

    pnpm clear-bases --server 1 --before "$CUT" --dry-run

Review the list: it should be every base on the server. Then the same command without
`--dry-run`. It releases every declaration and cascades sightings, zone placements and
incidents; rosters are untouched. Then:

    psqlcw <<'SQL'
    select count(*) from declarations where server_id = 1;  -- 0
    SQL

⚠️ Anything but 0 means a declaration landed after `$CUT`: catch-up was not complete.
Do NOT switch the mission. Go back to step 3.4, wait until it passes, take a NEW `$CUT`,
re-run `clear-bases` with it, and re-run step 4's `map-cutover` with that new `$CUT` too.

    psqlcw <<'SQL'
    update booster_kits set pos_x = null, pos_y = null, pos_z = null;
    update award_grants set pos_x = null, pos_y = null, pos_z = null
      where revoked_at is null;
    update booster_kit_challenges set closed_at = now() where closed_at is null;
    delete from clan_pins;
    SQL

⚠️ Do NOT touch `award_grants.placed_at`. `awardState()` checks lapse before live, so
nulling it on a grant past `place_by` ends a live award. Position columns only.

## 6. Operator: switch the mission and start

First, the gate: `select count(*) from declarations where server_id = 1;` (via
`psqlcw`) must still be 0. If not, back to step 3.4 as in step 5.

Only now, in Nitrado, set the mission to `dayzOffline.nasdara` on 19831378 and START
the server.

## 7. Guide channels

The guide chapters were renumbered (getting-around removed, chapters 12 to 14 became
11 to 13). The reconciler only deletes channels with `--prune`, so run it once by hand:

    pnpm --filter @factions/web guide:publish --dry-run
    pnpm --filter @factions/web guide:publish --prune

Read the dry run first: it should name the old chapter channels and nothing hand-made.
`--prune` deletes every channel under the category the guide does not own. Neither
`deploy-web.sh` nor the hourly timer passes it, so this is a one-off.

## 8. Check

- `select clock_offset_ms from servers where id = 1;` (via `psqlcw`) is still 25200000, and the worker
  logs no offset change. The offset belongs to the Nitrado box, not the map; new events'
  `occurred_at` should track wall-clock time.
- The RPT names `dayzOffline.nasdara`, the three object spawner files load, and there
  are no load complaints beyond Bohemia's known ones.
- `supply_uploads`, `booster_kit_uploads` and `award_uploads` advance with no worker
  errors. The restart tick ran clean and found `koth/default/`.
- The site map shows Nasdara tiles and place names, with no travel layer; the KotH
  town list shows Nasdara towns.
- No clan went dormant at the first ticks (`$CUT`, or paste the written-down instant
  if this is a new shell):

      psqlcw <<SQL
      select tag, status, dormant_since from factions
        where status = 'dormant' and dormant_since > '$CUT';  -- 0 rows
      SQL

- Announce to players (separate from this work).

## Rollback

The cleanup is not reversible except from the pre-migration dump `deploy-release.sh`
takes. Switching Nitrado back to Chernarus without restoring it leaves every clan
without a base. The release itself is additive (migration 0068 is nullable and
unread by older code).
