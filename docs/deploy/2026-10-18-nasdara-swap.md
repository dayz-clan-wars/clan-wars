# Nasdara swap — Clan Wars moves from Chernarus to Nasdara

Spec: `docs/superpowers/specs/2026-10-17-nasdara-swap-design.md`.

Switch day is planned for 2026-10-18.

⚠️ **Cutover race.** A Chernarus raise made after the cutover instant but before
`clear-bases` runs is not cleared (`--before` excludes later declarations), and that
base would carry onto Nasdara. So the Chernarus game server is STOPPED before the
instant is taken, the instant is taken at the moment of the clear step, and steps 3
to 6 run back to back. The Nitrado mission switch and start come last.

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

3. **Ship this branch's release** with the usual flow. Migration 0068
   (`servers.map_changed_at`, nullable, additive) applies on deploy via
   `deploy-release.sh`. Nothing reads it until step 5.
4. **Tidy `.env`.** Delete `AIRDROP_TICK`, `AIRDROP_WEEKLY_CAP`, `AIRDROP_MIN_POP` and
   `HUB_BAN_TICK` from `/opt/clan-wars/.env`. The bot no longer reads them; leaving
   them is harmless but misleading.

## 2. List what the wipe will cost

    psqlcw <<'SQL'
    select id, tag, reserved_until from factions where status = 'reserved';
    SQL

A reserved clan's base is cleared with the rest, so it cannot activate (activation
joins `declarations`) and lapses within 24 hours. Accepted: it re-founds on Nasdara.
Tell those clans first.

## 3. Stop the server and take the cutover instant

In Nitrado, STOP the Chernarus game server (19831378) so nobody can raise a flag.
Then, on the host, take the instant once and keep it in the shell for steps 4 to 6:

    CUT=$(date -u +%Y-%m-%dT%H:%M:%SZ); echo "$CUT"

Write it down. Use this SAME `$CUT` for `clear-bases` and `map-cutover`; ⚠️ a later
instant for `map-cutover` silently lengthens every clan's grace. Do not leave a gap
between here and step 6: run 4, 5 and 6 back to back.

## 4. Close open events and clear placements

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
incidents; rosters are untouched.

    psqlcw <<'SQL'
    update booster_kits set pos_x = null, pos_y = null, pos_z = null;
    update award_grants set pos_x = null, pos_y = null, pos_z = null
      where revoked_at is null;
    update booster_kit_challenges set closed_at = now() where closed_at is null;
    delete from clan_pins;
    SQL

⚠️ Do NOT touch `award_grants.placed_at`. `awardState()` checks lapse before live, so
nulling it on a grant past `place_by` ends a live award. Position columns only.

## 5. Map identity and dormancy grace

    psqlcw <<'SQL'
    update servers set map = 'nasdara' where id = 1;
    SQL
    pnpm map-cutover --server 1 --at "$CUT"

The grace applies to active clans only. Each gets a week from the cutover to raise a
flag again before dormancy counts.

## 6. Operator: switch the mission and start

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
- No clan went dormant at the first ticks:

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
