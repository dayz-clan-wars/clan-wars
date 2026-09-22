# The automatic raid window — deploy

2026-09-17. Design: `docs/superpowers/specs/2026-09-17-raid-window-automation-design.md`.
Operator's reference for the feature itself (how the flip works, how to read the tables,
the manual fallback): `docs/deploy/raid-window.md`. **This file is the deploy only** —
what to set, what to expect on the way in, and what to check at the first real boundary.

Nothing here is a code deploy step. `clan-wars-deploy.timer` checks out the tag, builds,
stops the writers, dumps `factions_live` and applies migrations — see
`docs/deploy/2026-09-16-auto-deploy.md`. The work below is `.env` and verification.

## 1. The `.env` additions

Add to `/opt/clan-wars/.env` (the bot reads it; the bot is not containerised):

    RAID_WINDOW_TICK=1

That is the only new variable. It has **two hard requirements**, both of which fail
config load — the bot refuses to start, with the reason on one line, rather than running
with a half-working feature:

| Already set? | If not | The refusal |
|---|---|---|
| `RESTART_SCHEDULE` | must be on | `RAID_WINDOW_TICK is on but RESTART_SCHEDULE is off` — the flip only takes effect at a restart, so nothing would ever apply it |
| `SERVER_EVENTS_CHANNEL_ID` | must be a channel id | `RAID_WINDOW_TICK is on but SERVER_EVENTS_CHANNEL_ID is unset` — the advance/open/close notices are player-facing and have nowhere to go |

`OPS_CHANNEL_ID` is **optional** and is the one that degrades rather than refusing: with
it unset, a refused or failed flip logs at error level instead of posting. Set it if you
want to be told; a flip failing silently in the journal is the thing you will not notice.

⚠️ Both requirements are checked at **config load**, not at the first boundary. If the
bot is running, it already satisfied them.

Restart the bot after editing `.env`:

    sudo systemctl restart clan-wars-bot
    systemctl status clan-wars-bot

⚠️ `active (running)` says only that one process is running. Confirm the data path
separately — `docker compose ps` shows `postgres` healthy, and `events` is still growing.

## 2. Migration 0037

`0037_fresh_moira_mactaggert.sql` adds `raid_window_flips`, `raid_window_skips` and
`raid_window_announcements`. It is applied by the release deployer, with the writers
stopped and a dump taken, and by nothing else. **Do not apply it by hand** unless you are
deliberately running the manual path in `docs/deploy/2026-09-14-db-migrate.md`.

It adds three new tables and alters nothing existing, so old code against the new schema
is fine: a bot without `RAID_WINDOW_TICK` simply never reads them.

Confirm it landed:

    docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c "\dt raid_window_*"

Three tables, all empty.

## 3. ⚠️ What the site says BEFORE the first boundary

This is the part that looks like a fault and is not.

The site's strip and Discord's open/close messages read **confirmed flips**, never the
clock. Straight after the deploy there are no rows yet, so until the tick's first restart
slot the strip shows:

    RAID WEEKEND: OPENING — not yet confirmed      (if you deployed inside a window)
    RAID WEEKEND: CLOSING — not yet confirmed      (if you deployed outside one)

**That clears at the first restart slot**, at most two hours later — not at the first
Friday. The slot records the boundary it brought the file into line with even when the
file already held the wanted value, which is the usual case on day one. After that slot
the strip reads `LIVE` or `CLOSED` with a countdown.

⚠️ If it is still "not yet confirmed" more than two hours after the bot came up, that is
a real failure: go to §5.

## 4. First real boundary

The first Friday 00:00 UTC or Monday 00:00 UTC after the deploy. Check, in order:

1. **The flip row.**

        docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c "
          select server_id, boundary_at, wanted_disabled, outcome,
                 applied_at, restart_confirmed_at
          from raid_window_flips order by boundary_at desc limit 5"

   Wanted: one row for that boundary, `outcome = applied`, `restart_confirmed_at` set.
   `wanted_disabled` is **false on a Friday** (raiding on) and **true on a Monday**.

2. **The Discord message.** `#server-events` carries the advance notice (a day ahead) and
   then the open or close. One each, never repeated. (Since
   `docs/deploy/2026-09-21-server-events-channel.md`, this posts to `#server-events`
   alongside airdrops and the weekly vehicle wipe, not `#announcements`.)

3. **The site.** The top-bar strip reads `LIVE` (with a countdown to the close) or
   `CLOSED` (counting down to the open).

4. **In game, if you can.** Friday: a player hitting a wall with a tool sees damage.
   Monday: they do not. This is the only check that proves the game server reloaded the
   file; everything above proves we wrote and restarted.

## 5. When it is wrong

- **`outcome = refused` or `failed`** — read `detail`, and follow "What to do when it does
  not" in `docs/deploy/raid-window.md`. An ops alert fires once per boundary, and the tick
  retries on its own at the next slot. A window that is merely late needs nothing.
- **No row at all for a past boundary** — the tick is not running. Check
  `RAID_WINDOW_TICK` is in `.env` (⚠️ not just on the start command line, which is lost at
  the next restart with nothing saying so) and that the bot restarted after you added it.
- **A row but no `restart_confirmed_at`** — the upload succeeded and the restart did not.
  Nothing announces and the strip keeps warning, which is correct: the server has not
  loaded the file. The next successful restart slot confirms it.
- **A skipped weekend** — record it, do not let it look like a failure:

        pnpm raid:skip --opens 2026-09-25T00:00:00Z --reason "server migration"

  The site and the Thursday notice then explain the skip. A skip is a decision, never a
  missed flip to catch up: do not open a window on another day to compensate.
