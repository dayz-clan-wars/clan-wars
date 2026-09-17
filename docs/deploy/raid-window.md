# The raid window — automated flip and its manual fallback

Base damage is on from **Friday 00:00 UTC** to **Monday 00:00 UTC** (guide ch. 5 and 13;
`RAID_WINDOW` in `packages/domain/src/rules.ts`). Since the raid-window-automation
increment, the bot flips it: `raid-window-tick.ts` runs beside `restart-tick.ts`, on the
same two-hourly restart slots that already apply the truck wipe and the weekly vehicle
rotation, gated on `RAID_WINDOW_TICK`. It is **level-triggered** — every slot recomputes
what `GeneralData.disableBaseDamage` should be at that instant and repairs it if a prior
write was lost or hand-reverted, so a bot down across the Friday boundary opens the
window *late* rather than not at all. `packages/domain/test/raid-window-runbook.test.ts`
holds this document against `rules.ts`; if the window ever changes, change the guide and
`rules.ts` first, then this.

`RAID_WINDOW_TICK` requires `RESTART_SCHEDULE` (config load refuses to start otherwise —
the flip only ever takes effect at a restart) and `ANNOUNCEMENTS_CHANNEL_ID` (the
advance/open/close notices have nowhere else to go). `OPS_CHANNEL_ID` is optional and
degrades to an error-level log line, the same way `WAR_LOG_CHANNEL_ID` does when unset.

Non-destructive raids (lowering a flag) score all week. **The window only decides
whether walls take damage — not gates, and not containers.** `disableContainerDamage`
is `false` on the live server and nothing has ever flipped it: containers are
damageable every day of the week, window or no window. Windowing container damage too
was considered and **deliberately rejected on 2026-09-17** as a separate decision that
needs its own player-facing announcement, not something to fold into this automation
change silently. No player-facing promise is broken by this: the guide says only that
"walls do not take damage" outside the window (`apps/web/content/guide/05-raiding.html`),
and the word "container" appears nowhere in `apps/web/content/guide/` or in
`packages/domain/src/guide-numbers.ts`.

## How the flip works

The surgical edit lives in `apps/bot/src/cfggameplay.ts` (`setBaseDamageDisabled`). It
is a targeted splice of the one key, never a parse-and-reserialize — the live file's
formatting stays byte-identical outside that key — and it refuses rather than guesses:
it throws if the input does not parse, if `GeneralData.disableBaseDamage` is missing or
not a boolean, if the key appears zero or more than once anywhere in the file, or if the
value read back after the edit is not what was asked for. A refusal costs at most a
window that opens or closes up to two hours late; the next slot retries.

Three tables record it (migration `0037_fresh_moira_mactaggert.sql`):

- **`raid_window_flips`** — one row per server per boundary, carrying the outcome
  (`applied`/`refused`/`failed`), `restart_confirmed_at`, and the pre-edit file content
  for recovery.
- **`raid_window_skips`** — weekends deliberately not opened, written by
  `pnpm raid:skip --opens <ISO> --reason "…"` (see below).
- **`raid_window_announcements`** — one row per boundary per kind
  (advance/open/close/failure), so a retried tick never double-posts.

## How to tell it worked

The website's top bar and Discord's open/close messages both read **confirmed** flips —
`outcome = 'applied'` with `restart_confirmed_at` set — never the clock. An unconfirmed
boundary renders `OPENING — not yet confirmed`, never `LIVE`; a confirmed flip is what
lets the open message go out at all. So:

1. After the Friday 00:00 UTC slot, check `raid_window_flips` for an `applied` row with
   `restart_confirmed_at` set for that boundary.
2. Confirm in game: a player hitting a wall with a tool takes damage on Friday, and does
   not on Monday.
3. If the site strip or Discord never moved past "not yet confirmed" / never posted
   "live", the flip was refused or failed — see below.

## What to do when it does not

- **A refused or failed flip posts an ops alert**, once per boundary (to `OPS_CHANNEL_ID`,
  or an error-level log line if that is unset). Check `raid_window_flips.detail` for the
  error `cfggameplay.ts` threw.
- **The tick retries automatically** at the next restart slot — do nothing for a flip
  that is merely late. Do not "make up" time by extending the next window: the guide
  promises exactly these hours, and the scoreboard does not depend on the window at all.
  Say in Discord that the window opened or closed late, and when.
- **A flip that keeps refusing** (the same error every slot) needs a human: read the
  error, then use the manual procedure below to unblock the server while the underlying
  cause (a hand-edited file, a moved key, a second `disableBaseDamage` occurrence
  elsewhere in the JSON) is fixed. `raid_window_flips.previous_content` on the last
  `applied` row is the recovery path if a bad write needs to be reverted by hand.
- **The tick being off** (`RAID_WINDOW_TICK` unset) is not a failure state — it is the
  condition the manual procedure below exists for.

## Exceptions, by decision

| Boundary skipped | Decided | What happens instead |
|---|---|---|
| 2026-09-11 and 2026-09-14 (the first weekend after the 2026-09-08 launch) | 2026-09-10 | Neither flip is made. `disableBaseDamage` stays `true` all week. The first window opens **Friday 2026-09-18 00:00 UTC**, and the normal twice-weekly cadence starts from there. |

Skips are now recorded with `pnpm raid:skip --opens <ISO> --reason "…"`, which refuses
anything that is not exactly a window's opening instant (midnight UTC on
`RAID_WINDOW.openDow`) — an off-by-one or wrong-day value would match no window and
silently do nothing downstream. A skip is what the site strip and Discord's advance
notice both read; they show the reason given on the command line.

A skipped weekend is a decision recorded this way, never a missed flip to catch up: do
not open a window on a different day to compensate. Everything else keeps its normal
clock: flag lowering scores all week, and the week tick closes week one at Monday
2026-09-14 00:00 UTC from whatever non-destructive raids landed.

⚠️ The Monday restart is **the normal case** for the week close, not a hazard (spec §14):
the bot's week tick closes the week that ended at Monday 00:00 UTC on its next interval
after the boundary, from `raids` and `defenses` already committed, and a restart of the
game server does not touch the bot. Nothing here needs to be timed against the bot.

## Manual procedure (fallback, when the tick is off or a flip is refused)

Through the Nitrado web panel for the server (service id in `servers` — `19831378` for
`CW-TEST`), signed in as the account that owns it. The bot's own token can do this too,
but a stuck automatic flip usually means something about the file needs a human's eyes
first, which is what this procedure is for.

1. **Open the file.** Nitrado panel → *Tools* → *File Browser* → the mission directory
   (`dayzxb_missions/dayzOffline.enoch/`, the same directory whose `custom/` holds
   `faction-supplies.json`) → `cfggameplay.json`.
2. **Copy it first.** Download the file (or copy its whole content into a local file) before
   editing. This is the only recovery path if the edit leaves the JSON invalid — a server
   that fails to parse `cfggameplay.json` fails to start, for everyone.
3. **Edit one key only.** Under `"GeneralData"`, find `"disableBaseDamage"` and set it to
   `false` (Friday) or `true` (Monday). Change nothing else: no reformatting, no trailing
   comma, no quotes around the boolean. Save.
4. **Read it back.** Reopen the file and confirm the key shows the value you set and the
   file still parses (the panel's editor shows a JSON error if it does not; if in doubt,
   paste the content into `python3 -m json.tool` locally).
5. **Restart the server** from the panel, at the boundary — as close to 00:00 UTC as you
   can. Players online are disconnected by the restart; the guide tells them a restart sits
   on the boundary, so it is expected.
6. **Confirm it applied.** After the server is back: on Friday, a player hitting a wall with
   a tool sees damage; on Monday they do not. If you cannot check in game, the read-back
   in step 4 plus a completed restart in the panel is the evidence — record both.

## The two flips

| When (UTC) | Server-local (UTC+7, `servers.clock_offset_ms = 25200000`) | Set `GeneralData.disableBaseDamage` to | Then |
|---|---|---|---|
| Friday 00:00 UTC | Friday 07:00 | `false` | restart the server |
| Monday 00:00 UTC | Monday 07:00 | `true` | restart the server |

## What this never does

- Change any other key in `cfggameplay.json`. `objectSpawnersArr` (the supplies file) and
  everything else are set once, by hand, and left alone. `disableContainerDamage` is one
  of those never-touched keys, on purpose — see the correction above.
- Windowing the raid clock's own bookkeeping. `RAID_WINDOW` in `rules.ts` is read by both
  the tick and the guide's numbers table; nothing computes it a second way.
