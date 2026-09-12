# The daily truck wipe — runbook

Once a day the event-spawned trucks are cleared and respawned fresh: the bot sets the
configured `events.xml` events to `<active>0</active>` before the 08:00 UTC restart and back
to `<active>1</active>` before the 10:00 UTC restart. No migration, no new table, no new
service — it rides on the restart slots that already exist
(`docs/deploy/2026-09-12-scheduled-restarts.md`), so `RESTART_SCHEDULE` must already be on.

## What it actually does

At every restart slot, for each server it is about to restart, the bot computes the
`<active>` value that server should **boot into** — `0` inside the window, `1` outside —
downloads `<mission>/db/events.xml`, and uploads it again only if the value differs.

⚠️ **Level-triggered, not edge-triggered.** It does not "write 0 at 08:00 and 1 at 10:00".
Every slot recomputes the wanted state, which is what makes a lost write self-heal: if the
10:00 upload fails, the file is still at `0`, and the 12:00 slot notices and puts it back.
An edge-triggered version leaves the trucks off for a full day the first time that happens.
The cost is one download per server per slot, which is the check.

⚠️ **The write lands before the restart POST**, because DayZ reads `events.xml` only at boot.
A write afterwards would not take effect for another two hours.

⚠️ **A failed wipe never costs a restart.** Any error — mission dir, download, parse, upload
— is logged at error level and the restart is issued anyway. Players rely on the two-hour
cadence, and the next slot converges the file regardless.

⚠️ **`events.xml` is in the mission's `db` directory**, not the mission root and not `custom`.
Verified against the live file server on 2026-09-12: the mission root holds only
`cfgeconomycore.xml`, `cfgeventspawns.xml`, `cfgeventgroups.xml` and the `db`/`env`/`custom`
directories, and a download of `<mission>/events.xml` answers `File doesn't exist (anymore?)`.
`custom/` is teleports, loadouts and faction supplies.

⚠️ **There is no dry-run**, the same as the restart it rides on. The moment
`TRUCK_WIPE_EVENTS` is set and the bot restarts, the next slot inside the window rewrites
`events.xml` on every active server with a `nitrado_service_id`.

## Steps

1. Confirm the schedule is already live and landing: `server_restarts` has recent
   `restarted` rows, and the journal is not full of `missed`.

       docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c \
         "select server_id, scheduled_for, outcome from server_restarts order by scheduled_for desc limit 6"

2. Confirm the event name exists in the live file before naming it. A name that is absent
   throws every slot — logged, restart unaffected, but the wipe never happens:

       select '<event name="VehicleTruck01">' in <mission>/db/events.xml

   On the clan-wars server (service 19831378, `dayzOffline.enoch`) `VehicleTruck01` is
   present with three `Truck_01_Covered*` children and was at `<active>1</active>` on
   2026-09-12.

3. Deploy the code with the wipe still off:

       cd /opt/clan-wars && git pull --ff-only && pnpm install --frozen-lockfile \
         && sudo systemctl restart clan-wars-bot

   Nothing changes: with `TRUCK_WIPE_EVENTS` unset the bot never reads `events.xml`.

4. Turn it on. Put in `.env`:

       TRUCK_WIPE_EVENTS=VehicleTruck01

   (`TRUCK_WIPE_OFF_HOUR=8` and `TRUCK_WIPE_ON_HOUR=10` are the defaults; set them only to
   move the window, and only to even hours.) Then `sudo systemctl restart clan-wars-bot`.

5. Watch the first slot inside the window. The journal shows
   `restart: server <id> wrote events.xml for <slot>` immediately before the restart line.
   Outside the window the first slot after enabling will also write once — bringing the file
   to `1`, which it already is — and then go quiet.

## Verifying

- **The file changed, and only where it should.** Download `<mission>/db/events.xml` before
  and after a wipe slot: exactly one character differs, the `<active>` digit inside the
  `VehicleTruck01` block. Every other event, all comments and all formatting are byte-identical.
- **Trucks are actually gone in game** after the 08:00 restart, and back after the 10:00 one.
  ⚠️ This is the one claim no test can make. The whole approach rests on DayZ clearing an
  event's spawned vehicles when the event is inactive at boot; confirm it on the first real
  morning before trusting the schedule.

## Rolling back

Remove `TRUCK_WIPE_EVENTS` from `.env` and restart the bot. The bot stops touching
`events.xml` immediately, leaving it in whatever state it is in — so if you roll back
between 08:00 and 10:00, set the event back to `<active>1</active>` by hand, or the trucks
stay gone.
