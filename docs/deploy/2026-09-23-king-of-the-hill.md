# King of the Hill — deploy and operate

An admin schedules a one-session King of the Hill event at one of 31 Livonia towns:
for that session every fresh spawn lands at the hill in a KotH kit, infected and
predators converge there, and kills whose victim is within `KOTH_ZONE_RADIUS_M`
(500 m) of the hill are scored, with the top linked killer winning the Plate Carrier
award. Spec: `docs/superpowers/specs/2026-09-23-king-of-the-hill-design.md`.

## 1. Merge and publish the `livonia` Release

Part A of this feature lives in the `livonia` repo (branch `koth-mission`, not yet
pushed at the time this was written): the 44 `custom/koth-*.json` presets, the
regenerated per-town `koth/locations/<slug>/` sets (four files each), the deploy
workflow's "Stage the KotH defaults" step (which populates `koth/default/` from the
live mission files immediately before FTP, never committed — `koth/default/` is
`.gitignore`d), and the workflow's `koth-` guard (`cfggameplay.json` in the repo may
never name a `koth-` preset — that file must always carry the default list, the same
rule `docs/deploy/2026-09-21-airdrops.md` §1 holds for `airdrop-*` entries).

Merge that branch, tag, and publish the Release — publishing is what deploys; pushing
`main` or a tag alone does nothing (`livonia/CLAUDE.md`).

Then verify on the server, through the Nitrado file browser or a read-only
`listFiles` call (`packages/nitrado`'s `listFiles`, never a write):

- `koth/default/` holds four non-empty files: `cfgplayerspawnpoints.xml`,
  `env/wolf_territories.xml`, `env/bear_territories.xml`, `env/zombie_territories.xml`
- `custom/` holds all 44 `koth-*.json` files (`KOTH_PRESET_FILES` in
  `packages/domain/src/koth.ts` names them)
- `koth/locations/lembork/` holds four files (spot-check; every other town's
  directory should look the same)

⚠️ Do this check before flipping `KOTH_TICK` on. `planKoth` refuses an opening outright
— and touches nothing — if any of these is missing (spec §5.1), but there is no
value in exercising that refusal path against a fresh deploy when a five-minute check
avoids it.

## 2. Migrate

Migration `0049_gifted_sheva_callister.sql` adds `koth_events`. As with every other
migration here, it is applied by the release deployer, never by the bot
(`CLAUDE.md`'s "Migrations are applied automatically on a release deploy, and by
nothing else"). On the auto-deploy path `deploy/deploy-release.sh` runs
`pnpm db:migrate --apply --production` for you, after stopping the writers. Off that
path, the manual procedure is `docs/deploy/2026-09-14-db-migrate.md`:

1. Stop the bot.
2. `pnpm db:migrate` (dry run, prints the tags it would apply).
3. Read the generated SQL.
4. `pnpm db:migrate --apply --production`.
5. Start the bot.

Confirm the migration landed and the table is empty:

```sql
select count(*) from koth_events;
```

Expect `0`. Never apply anything to `factions_live` outside that script and runbook.

## 3. Env and restart

All in `.env`, never on the start command line — `BOT_FEED_CHANNEL_ID` is the
standing example of what goes wrong otherwise: a value passed only on the command
line turns the feature off at the very next restart with nothing saying so.

    KOTH_TICK=true

`KOTH_TICK` requires `RESTART_SCHEDULE` and `SERVER_EVENTS_CHANNEL_ID` — config load
refuses to start without both, the same as `AIRDROP_TICK` and `RAID_WINDOW_TICK`.
`OPS_CHANNEL_ID` is used for failure alerts if set; without it, an alert is an
error-level log line instead.

```
set -a && . ./.env && set +a
sudo systemctl restart clan-wars-bot
```

Check the startup log line — `apps/bot/src/discord.ts` logs exactly one of:

- `king of the hill on` — the flag is live
- `KOTH_TICK is off: /koth refuses; any unfinished KotH session is still restored
  at the next restart.` — the flag did not take effect; check `.env` was sourced

⚠️ **The restore arm ignores `KOTH_TICK` entirely.** It runs at every slot, on or off,
whenever any `koth_events` row has ever existed on the server (`planKoth`'s first
query) — so turning the flag off mid-session does not strand the server in KotH mode,
and the "off" log line above is accurate about `/koth` but not about the restore.

## 4. Rehearsal on a quiet slot

Run `/koth schedule location:<town> at:<slot>` for a slot at least 2 hours out (well
past `KOTH_REMINDER_LEAD_MS` = 30 min — the command refuses anything closer). Watch
`#server-events` for the "scheduled" post, then the "reminder" post 30 minutes before
the slot.

**After the opening restart**, check:

- a fresh character spawns at the hill, in a KotH kit
- infected are present at the hill and absent at a normal town away from it
- the "live" post appeared in `#server-events`

**After the closing restart**, check:

- all four whole files (`cfgplayerspawnpoints.xml`,
  `env/{wolf,bear,zombie}_territories.xml`) equal `koth/default/`'s copies
- `cfggameplay.json`'s `spawnGearPresetFiles` lists `./custom/loadout.json` (the
  ordinary default), not a `koth-` entry
- `events.xml`'s `Infected*` values match the row's `infected_snapshot`, not `1`
  across the board — the restore puts back whatever was actually running before the
  session, which may already have had some `Infected*` events off

Then check the award:

- the results post appeared in `#server-events` (top 5, the winner, the dropped-kill
  count if nonzero)
- the `award_grants` row exists (`select * from award_grants order by id desc limit
  1;`) and the DM landed with the winner

```sql
select id, state, location, slot_at, opened_at, restored_at, results, winner_dayz_id, award_grant_id
from koth_events order by id desc limit 5;
```

## 5. Rollback

`KOTH_TICK=false`, then `sudo systemctl restart clan-wars-bot`. `/koth` now refuses
every subcommand; a `scheduled` or `live` row is not touched by the flag. The restore
arm still runs at the next slot regardless (§3 above) — a `live` row's session ends
and its four files come back at the closing restart exactly as if the flag were still
on, because `planKoth` never gates on it. If a session needs to be stopped
immediately rather than waiting for its own closing restart, reverting the code (not
just the flag) removes the tick that opens future ones; an already-`live` session
still needs its own closing restart, or a hand `update koth_events set state =
'failed' where id = …` plus a manual file restore (`docs/deploy/raid-window.md`'s
manual-fallback pattern for a stuck flag) to short-circuit it.

## 6. Turning it off for good

Same shape as `docs/deploy/2026-09-21-airdrops.md` §6: `KOTH_TICK=false` stops new
schedules but, unlike airdrops, does *not* leave a live session stuck — the restore
arm is unconditional (§3). Let a `live` session reach its own closing restart before
relying on that, the same way you would not force-remove a live airdrop's spawner
entry unless it had to come off immediately.
