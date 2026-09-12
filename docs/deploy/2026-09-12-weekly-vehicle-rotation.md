# The weekly rotating vehicle wipe — runbook

Every Monday at `TRUCK_WIPE_OFF_HOUR` (08:00 UTC) one vehicle type is wiped alongside the
daily trucks and comes back at `TRUCK_WIPE_ON_HOUR` (10:00). Which one rotates weekly
through five, and the coming week's is announced 24 hours ahead.

Spec `docs/superpowers/specs/2026-09-12-weekly-vehicle-rotation-design.md`. Rides on the
slots from `docs/deploy/2026-09-12-scheduled-restarts.md`; shares the window with
`docs/deploy/2026-09-12-truck-wipe.md`.

## The rotation

| Wipe Monday 08:00Z | Vehicle | events.xml event | Announced Sunday 08:00Z |
|---|---|---|---|
| 2026-09-14 | Olga | `VehicleCivilianSedan` | 2026-09-13 |
| 2026-09-21 | Gunter | `VehicleHatchback02` | 2026-09-20 |
| 2026-09-28 | Hummer | `VehicleOffroad02` | 2026-09-27 |
| 2026-10-05 | Ada | `VehicleOffroadHatchback` | 2026-10-04 |
| 2026-10-12 | Sarka | `VehicleSedan02` | 2026-10-11 |
| 2026-10-19 | Olga again — wraps | | 2026-10-18 |

⚠️ Derived from the calendar, never stored. `ROTATION_ANCHOR_MS` in
`packages/domain/src/rules.ts` is what phases it; moving that constant re-phases every
week, including ones already announced. It is an anchor, not a start date to keep current.

⚠️ A week the bot sleeps through is skipped, not owed. The vehicle is a function of the
date.

## Before you start

1. Confirm all five event names exist in the live file. A name that is absent throws every
   slot — logged, restart unaffected, wipe silently does not happen.

       grep -oE '<event name="Vehicle[^"]*"' events.xml

2. Confirm the bot can post in the announcements channel: it needs **View Channel** and
   **Send Messages** there. A missing permission makes every Sunday tick fail and retry
   until the cutoff, then record `missed`.

## Steps

1. **Apply migration 0033_lumpy_stick.sql** before the new code starts — nothing applies
   migrations here. Use the one-off runner from `docs/deploy/2026-09-02-dormancy.md`. It
   is additive (a new table only), so the bot does not need stopping, but confirm the
   count afterwards:

       select count(*) from __drizzle_migrations;   -- expect 34

2. **Deploy the code dark** (`WEEKLY_VEHICLE_WIPE` unset):

       cd /opt/clan-wars && git pull --ff-only && sudo systemctl restart clan-wars-bot

   The journal shows `WEEKLY_VEHICLE_WIPE is off: no weekly vehicle rotation.` and
   `ANNOUNCEMENTS_CHANNEL_ID is unset: wipes happen without notice.`

3. **Set the channel first, the wipe second.** In `.env`:

       ANNOUNCEMENTS_CHANNEL_ID=<channel id>
       WEEKLY_VEHICLE_WIPE=1

   Then `sudo systemctl restart clan-wars-bot`. The journal must show BOTH:

       weekly vehicle rotation on: Olga → Gunter → Hummer → Ada → Sarka
       truck wipe on: VehicleTruck01 off at 08:00Z, back on at 10:00Z

## Verifying

- **The Sunday message** lands in the channel at 08:00 UTC naming the right vehicle for
  the table above. It posts exactly once; a bot restart does not repeat it.
- **The Monday file diff**: download `<mission>/db/events.xml` before 08:00 and after, and
  confirm exactly TWO `<active>` digits changed — `VehicleTruck01` and that week's
  vehicle. Everything else, comments included, is byte-identical.
- **The Monday 10:00 restore** puts both back to `1`.
- **Convergence**: on any ordinary slot the bot writes nothing (`no upload` in the
  journal), because the file already holds the wanted state.

## Rolling back

Remove `WEEKLY_VEHICLE_WIPE` from `.env` and restart. The bot stops touching the five
rotation events immediately, leaving them as they are.

⚠️ Rolling back between 08:00 and 10:00 on a Monday leaves that week's vehicle at
`<active>0</active>` and nothing will restore it — set it back to `1` by hand.

Removing only `ANNOUNCEMENTS_CHANNEL_ID` stops the notices and leaves the wipe running,
which is a legitimate state; startup says so every restart.
