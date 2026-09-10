# The raid window — twice-weekly runbook

Base damage is on from **Friday 00:00 UTC** to **Monday 00:00 UTC** (guide ch. 5 and 13;
`RAID_WINDOW` in `packages/domain/src/rules.ts`). Nothing in this repo flips it: the game
server's `cfggameplay.json` does, and a restart applies it (spec §12). So this runbook is
done by hand, twice a week, every week the server is up. `packages/domain/test/raid-window-runbook.test.ts`
holds this document against `rules.ts`; if the window ever changes, change the guide and
`rules.ts` first, then this.

Non-destructive raids (lowering a flag) score all week. The window only decides whether
walls, gates and containers take damage.

## The two flips

| When (UTC) | Server-local (UTC+7, `servers.clock_offset_ms = 25200000`) | Set `GeneralData.disableBaseDamage` to | Then |
|---|---|---|---|
| Friday 00:00 UTC | Friday 07:00 | `false` | restart the server |
| Monday 00:00 UTC | Monday 07:00 | `true` | restart the server |

## Exceptions, by decision

| Boundary skipped | Decided | What happens instead |
|---|---|---|
| 2026-09-11 and 2026-09-14 (the first weekend after the 2026-09-08 launch) | 2026-09-10 | Neither flip is made. `disableBaseDamage` stays `true` all week. The first window opens **Friday 2026-09-18 00:00 UTC**, and the normal twice-weekly cadence starts from there. |

A skipped weekend is a decision recorded here, never a missed flip to catch up (see below):
do not open a window on a different day to compensate. Everything else keeps its normal
clock: flag lowering scores all week, and the week tick closes week one at Monday
2026-09-14 00:00 UTC from whatever non-destructive raids landed. Say so in Discord before
the Friday, in plain words: no base damage this weekend, first raid weekend is 18–21
September, lowering flags counts as always.

The setting is read at server start. Editing the file without a restart changes nothing;
restarting without editing the file changes nothing. Do both, in that order.

⚠️ The Monday restart is **the normal case** for the week close, not a hazard (spec §14):
the bot's week tick closes the week that ended at Monday 00:00 UTC on its next interval
after the boundary, from `raids` and `defenses` already committed, and a restart of the
game server does not touch the bot. Nothing here needs to be timed against the bot.

## Procedure

Through the Nitrado web panel for the server (service id in `servers` — `19831378` for
`CW-TEST`), signed in as the account that owns it. The bot's API token has no part in this;
the supplies design (2026-09-01) refused to automate this file because a bad write breaks
the map for everyone, and that stands.

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

## If a flip is missed

Do it as soon as it is noticed, in the same order (edit, read back, restart). Do not
"make up" time by extending the next window: the guide promises exactly these hours, and
the scoreboard does not depend on the window at all. Say in Discord that the window opened
or closed late, and when.

## What this never does

- Change any other key in `cfggameplay.json`. `objectSpawnersArr` (the supplies file) and
  everything else are set once, by hand, and left alone.
- Touch the database or the bot. The window is not stored anywhere; `RAID_WINDOW` in
  `rules.ts` is a statement for the guide's numbers table, not a clock.
