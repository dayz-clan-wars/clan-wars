# Leaderboard crowns — deploy runbook

Nine Discord roles, one per leaderboard, each held by whoever is #1 on that board in
the **current season**. No migration, no new table, nothing posted to Discord. The bot
gains one reconciler tick (`apps/bot/src/crown-tick.ts`) reading the same
`playerBoardsDb` the public `/players` boards render from, so the crown and the board
can never disagree about who is winning.

⚠️ **Every crown is optional and off until its role id is set.** A board with no id
configured is never touched, so these can go in one at a time. All nine unset and the
tick does not run at all. Nothing else in this deploy changes behaviour.

1. **Create the nine roles by hand** in the Discord server. The bot only adds and
   removes members, so name, colour, icon and position are yours and it will never
   rename or delete one. Suggested names, in board order:

   | Board | Role |
   |---|---|
   | `raiders` | Top Raider |
   | `killers` | Top Killer |
   | `kd` | Best K/D |
   | `streaks` | Best Killstreak |
   | `longestKills` | Longest Kill |
   | `builders` | Top Builder |
   | `playTime` | Most Play Time |
   | `deaths` | Most PVP Deaths |
   | `friendlyFire` | Most Friendly Fire |

   ⚠️ **Every one of these must sit BELOW the bot's own highest role** in the role list.
   Discord refuses a role write from a bot to a role at or above its own, and the
   refusal arrives as a per-member error — the tick logs `crowns: <board>-add:<id>` and
   keeps going, so the symptom is one crown that silently never fills while the other
   eight work.

2. **Add the ids to `.env`** (Developer Mode → right-click the role → Copy Role ID).
   Any subset is valid:

       CROWN_RAIDERS_ROLE_ID=...
       CROWN_KILLERS_ROLE_ID=...
       CROWN_KD_ROLE_ID=...
       CROWN_STREAKS_ROLE_ID=...
       CROWN_LONGEST_KILL_ROLE_ID=...
       CROWN_BUILDERS_ROLE_ID=...
       CROWN_PLAYTIME_ROLE_ID=...
       CROWN_DEATHS_ROLE_ID=...
       CROWN_FRIENDLY_FIRE_ROLE_ID=...

   ⚠️ Put them in `.env`, not on the start command line — the same hazard
   `BOT_FEED_CHANNEL_ID` carries. A crown passed only on the command line turns off at
   the next restart with nothing saying so, and an unheld crown looks exactly like a
   board nobody is on.

   Each is validated at load, not at first write: a malformed id fails the bot's start
   with a message naming the variable, rather than looking configured for a week.

   ⚠️ **Two crowns set to the same role id also fails the start**, naming both
   variables. That is the easy mistake to make pasting nine ids in a row, and nothing
   downstream would have errored: the two boards would take the role off each other
   every pass forever, printing a steady `crowns: 1 added, 1 removed` that reads just
   like normal churn.

3. **Restart the bot**: `sudo systemctl restart clan-wars-bot`. No migration, so
   nothing needs stopping first and the order does not matter.

4. **Confirm on the first pass** (`journalctl -u clan-wars-bot -f`). The crowns run
   every `CROWN_TICK_INTERVAL_MS` (default 5 min), right after the structure tick, and
   print one line only when something changed:

       crowns: 7 added, 0 removed

   A first pass adds one line's worth of crowns and then goes quiet — silence after
   that means nothing moved, which is the normal state. `0 error(s)` is never printed;
   an error count only appears when there is one.

5. **Verify in Discord.** Open the member list and check a crown against
   `https://dayzclanwars.com/players` for the same board. They read the same query, so
   they must agree; if they do not, the crown is stale by at most one interval.

## What holders should expect

- **The scope is the current season**, so a season rollover empties every board and
  strips all nine crowns at once. They fill again as the new season's first kills,
  raids and builds land. This is intended — each season is its own race — but it does
  mean a quiet stretch right after a wipe where nobody wears anything.
- **Everyone tied at the top holds the crown.** Two players level on killstreak both
  get it.
- **A #1 who has not linked their Discord account leaves the crown unheld.** It does
  not fall through to #2, because #2 is not the best player. Linking with `/link` is
  what makes them eligible, and the crown lands within one interval.
- **A crown at value zero is never worn.** Nobody holds Most Friendly Fire until
  somebody actually shoots a clanmate.

## Turning one off

Remove its env var and restart. The bot then stops touching that role entirely, which
means **the last holder keeps it** — an unconfigured board is not reconciled, so
nothing strips it. Take the role off by hand, or delete the role, if that is not what
you want.

## Hazards

⚠️ **A failed leaderboard read writes nothing at all.** Treating a failed query as
"nobody is #1" would strip all nine crowns off everyone on one bad read and hand them
back on the next pass. The tick returns early instead and logs `crowns: boards-read`.

⚠️ **Ties are read ten deep.** The store scans the first ten rows of each board for
players level with #1. An eleven-way tie at the top would silently drop the rest —
accepted rather than paying a second per-board query, and not reachable on any board
whose top value is a distance or a play-time total.

⚠️ **Nothing here posts to Discord.** The crowns are roles only, by design. If an
announcement is wanted later it is a new feature with a channel id of its own, not a
flag on this one.
