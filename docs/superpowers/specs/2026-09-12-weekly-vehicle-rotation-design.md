# Weekly rotating vehicle wipe, announced a day ahead — design

Every Monday at 08:00 UTC one vehicle type is wiped alongside the daily truck wipe and
comes back at 10:00 UTC with it. Which vehicle rotates weekly through five, and the
coming week's is announced to Discord 24 hours beforehand.

Builds on `docs/deploy/2026-09-12-truck-wipe.md` (the daily wipe) and
`docs/deploy/2026-09-12-scheduled-restarts.md` (the slots both ride on).

## The five, in rotation order

| # | events.xml event | In game |
|---|---|---|
| 0 | `VehicleCivilianSedan` | Olga |
| 1 | `VehicleHatchback02` | Gunter |
| 2 | `VehicleOffroad02` | Hummer |
| 3 | `VehicleOffroadHatchback` | Ada |
| 4 | `VehicleSedan02` | Sarka |

All five verified present in the live `<mission>/db/events.xml` on 2026-09-12.
`VehicleBoat` and `VehicleTruck01` are deliberately excluded — the first is out of scope,
the second is the daily wipe's.

## Rotation: derived, never stored

    weeklyWipeVehicle(monday) = VEHICLES[(weeksSince(ROTATION_ANCHOR, monday)) mod 5]

`ROTATION_ANCHOR = 2026-09-14T00:00:00Z`, the first wipe Monday, chosen so the sequence
runs in the order above rather than starting mid-list at whatever the epoch implies.

⚠️ **No stored pointer, by design.** Sunday's announcement and Monday's wipe derive the
vehicle from the same pure function over the same Monday, so they cannot disagree. A
pointer read at two different moments is exactly how a bot announces Olga and wipes
Gunter. The cost is that the order is fixed by the calendar: skipping or reordering a
week is a code change, not a row edit. That is the intended trade.

A missed week is simply skipped — the rotation is a function of the date, so a week the
bot sleeps through does not "owe" its vehicle a turn later.

## The wipe itself

Extends `applyTruckWipe` in `apps/bot/src/restart-tick.ts`. At every restart slot, for the
server about to boot:

- Each **daily** event (`TRUCK_WIPE_EVENTS`) gets `0` inside the daily window, else `1` —
  unchanged behaviour.
- Each of the **five rotation** events gets `0` only if it is this week's vehicle *and*
  the slot is a Monday inside the wipe window; otherwise `1`.

The rotation reuses `TRUCK_WIPE_OFF_HOUR`/`TRUCK_WIPE_ON_HOUR` rather than adding a second
pair — "same window as the trucks" is the requirement, and two independently-settable
windows would be two statements of one fact. Those hours are parsed and validated whether
or not `TRUCK_WIPE_EVENTS` is set, so the rotation works with the daily truck wipe off.

⚠️ **All five converge every slot, not just the current week's.** If the bot is down
across a Monday 10:00, the vehicle wiped that morning is left at `<active>0</active>`, and
by the time the bot returns the rotation has moved on — nothing would ever put it back.
Converging all five costs nothing (one download either way, and an unchanged file is still
never re-uploaded) and makes that unrecoverable state impossible.

One download, one conditional upload, unchanged from the daily wipe. The Monday 08:00 slot
therefore writes two `<active>` flips in a single upload: the trucks' and this week's
vehicle's.

## The announcement

**Channel.** New optional `ANNOUNCEMENTS_CHANNEL_ID`. Unset means off, and startup says so
— the same rule the other posters follow, because an unannounced wipe and a broken
announcer look identical otherwise.

**Timing.** Posts at `wipeMonday − 24h`, i.e. Sunday 08:00 UTC.

`wipeMondayFor(now)` is the next Monday 08:00Z strictly after `now`, so that during the
Monday 08:00–10:00 wipe itself the tick is already looking at *next* week — it never
re-announces the wipe in progress. The announcement window for that next Monday does not
open until its own Sunday, so nothing posts a week early.

**Lateness.** The bot catches up: any tick between Sunday 08:00 and `wipeMonday − 1h` with
no row yet posts immediately. Past that cutoff it records `missed` and stays silent.

⚠️ A late announcement is still useful; one that lands *after* the wipe is worse than
silence, because it tells players a wipe is coming that already took their car. The cutoff
is what separates the two, and it is why this does not simply reuse the restart tick's
ten-minute grace — a two-hour outage should not cost a whole week's notice.

**Idempotency.** New table, shaped exactly like `server_restarts`:

    vehicle_wipe_announcements(
      wipe_at      timestamptz primary key,  -- the Monday 08:00Z slot
      announced_at timestamptz not null,
      event_name   text not null,            -- frozen at write time
      outcome      text not null             -- 'posted' | 'missed'
    )

⚠️ Keyed on `wipe_at` ALONE, with no `server_id` — unlike `server_restarts`, which it
otherwise copies. The rotation is a property of the calendar, not of a server: every
server wipes the same vehicle in the same week, and the announcement is one message to one
channel. A per-server key would post one identical message per active server.

`onConflictDoNothing` on insert, so overlapping ticks and restarts cannot double-post.

⚠️ **Post, then insert** — the house rule from every other poster. A row written first
records an announcement that never went out if the post then fails; the reverse costs at
most a duplicate message after a crash between the two, which is the direction this repo
has chosen everywhere (see `notice-tick.ts`).

⚠️ `event_name` is stored even though it is derivable, for the same reason the feed
freezes its payload: the row is a record of *what was announced*, and recomputing it later
against a changed rotation list would make the record lie.

**Copy.** One message, no embed:

> 🚗 **Weekly vehicle wipe — tomorrow, 08:00 UTC**
> This week it's **Olga** (`VehicleCivilianSedan`). Every one on the map is cleared at the
> 08:00 restart and respawns fresh from 10:00. Move anything you want to keep out of them
> before then.

## Table placement in the lock order

`vehicle_wipe_announcements` sits outside the lock order, beside `server_restarts`: one
writer (the announce tick), a single statement, touching no other table. It references
nothing, which is what lets it be keyed on the calendar alone.

## Config

| Var | Default | Meaning |
|---|---|---|
| `WEEKLY_VEHICLE_WIPE` | off | `1`/`true` turns the rotation on. Requires `RESTART_SCHEDULE` (the slots it rides on); config load fails without it, exactly as `TRUCK_WIPE_EVENTS` does. Independent of `TRUCK_WIPE_EVENTS` — either can run without the other. |
| `ANNOUNCEMENTS_CHANNEL_ID` | unset | Where the notice posts. Unset = wipe still happens, silently. |

⚠️ The wipe and the announcement are independently switchable on purpose. Turning the
channel off must not stop the wipe, and a wipe that cannot announce must not be blocked by
it — but startup logs both states so neither can be off by accident.

## Testing

Pure, no database:
- `weeklyWipeVehicle` — all five in order across ten consecutive weeks; wraps; stable
  across every hour of a Monday; anchored so 2026-09-14 is Olga.
- `wipeMondayFor` / `announceAtFor` — the Monday of a mid-week date, of a Sunday, and of
  the wipe Monday itself.

Over the restart tick (existing DB suite):
- Monday 08:00 slot writes `0` for trucks **and** this week's vehicle in one upload.
- Monday 10:00 restores both.
- A non-Monday slot leaves all five rotation vehicles at `1`.
- A slot after a missed Monday 10:00 restores the *previous* week's vehicle — the
  convergence guarantee above.
- An unknown event name fails that server's wipe, logs, and still restarts.

Over the announce tick (new DB suite):
- Posts once at Sunday 08:00 and never again for that week.
- Catches up at Sunday 20:00; records `missed` at Monday 07:30.
- A failed post writes no row, so the next tick retries.
- Off entirely with no channel configured.
- Two active servers produce exactly ONE message, not two.

## Deploy

Migration `0033_vehicle_wipe_announcements.sql`, additive — a new table only, nothing
dropped or altered, so it does not need the bot stopped.

⚠️ Nothing applies migrations in production here. It is a deliberate step before the new
code starts, using the one-off runner from `docs/deploy/2026-09-02-dormancy.md`.

⚠️ **Timing.** The first announcement is Sunday 2026-09-13 08:00 UTC and the first wipe
Monday 2026-09-14 08:00 UTC. Deployed after that Sunday morning, the announcement records
`missed` (or is skipped past the cutoff) and the first *announced* wipe is 2026-09-21.
