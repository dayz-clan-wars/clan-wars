# Leaderboards in Discord — deploy runbook

Nine standing messages in one channel, one per leaderboard, **edited in place** rather
than reposted. Same order, same titles, same top ten and same current-season scope as
the site's `/players` panels, because both read the same `playerBoardsDb` call.

No migration, no new table. One channel id and a restart.

1. **Pick or make the channel.** It holds exactly nine bot messages and nothing else.

   ⚠️ **Deny everyone but the bot permission to post in it.** The bot identifies its own
   nine messages by the board link in each embed, so a player's message is ignored
   rather than edited — but a channel people can post in will interleave chatter
   between the boards, and the nine are only in the site's order because they were
   *sent* in that order.

2. **Add the id to `.env`:**

       LEADERBOARDS_CHANNEL_ID=...

   Optionally `LEADERBOARD_TICK_INTERVAL_MS` (default `300000`, 5 minutes — the same
   clock the crowns run on, since both read the same nine boards).

   Unset, nothing is posted or edited anywhere: the whole feature is off.

3. **Restart the bot**: `sudo systemctl restart clan-wars-bot`.

4. **Confirm on the first pass** (`journalctl -u clan-wars-bot -f`). Expect one line
   within the interval:

       leaderboards: 9 posted, 0 edited (rebuilt), 0 error(s)

   `(rebuilt)` on a first run is correct and expected — an empty channel has none of
   the nine, so the tick builds all nine in order. After that, passes that change
   nothing print nothing, and a board that moves prints `0 posted, 1 edited`.

5. **Verify against the site.** Open the channel beside `https://dayzclanwars.com/players`.
   The nine titles, their order, the ten names in each and every number must match —
   they are rendered from one query and one set of formatters, so a disagreement is a
   bug, not a lag.

## How the nine messages are found again

There is **no stored message id**, by design — the same approach `#players-online` uses.
On start, and after any rebuild, the bot reads the channel's recent history, keeps its
own messages, and reads each embed's URL back to learn which board it is.

- **All nine found** → it adopts them and only ever edits from then on. This is what
  makes a restart or a redeploy silent: no new messages appear.
- **Any missing** → the channel is **rebuilt**: the bot deletes its own messages there
  and posts all nine fresh, in order.

⚠️ **The rebuild is why you must not delete just one of the nine.** Re-sending a single
missing message would put it at the bottom, out of the site's order, with nothing able
to put it back. Deleting one costs you all nine and their message links.

## Hazards

⚠️ **A failed board read writes nothing.** Rendering "no rows" from a failed query would
blank all nine messages at once and refill them on the next pass. The tick returns early
and logs `leaderboards: boards-read`.

⚠️ **A board's key is written only after its edit succeeds.** A failed edit leaves the
key stale so the next pass retries that board, rather than believing the message is
current. One failing board never stops the other eight.

⚠️ **Changing a board's slug in `BOARD_SLUGS` orphans the nine messages once.** The
slug is both the link and the marker the bot finds its message by, so the next pass
recognises none of them and rebuilds. Survivable, but it is not a cosmetic edit.

## What players see at a season rollover

All nine boards empty at once and the messages become nine "Nothing yet." cards until
the new season's first kills, raids and builds land. The nine crown roles go unheld over
the same stretch, for the same reason. Consistent, and intended, but stark — say so
ahead of a wipe if anyone asks.
