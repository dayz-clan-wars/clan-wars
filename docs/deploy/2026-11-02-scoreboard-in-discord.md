# Clan scoreboard in Discord — deploy runbook

One standing post in `#scoreboard`, **edited in place** rather than reposted: a heading
linking to the site's scoreboard, then one card per clan with its flag as the thumbnail,
its rank, points, Alpha badge and raids / times raided / defenses. Same rows, same order
and same empty state as `https://dayzclanwars.com/scoreboard`, because both render the
same `scoreboard()` read.

No migration, no new table. One channel id and a restart.

1. **Lock the channel.** Deny everyone but the bot permission to post in `#scoreboard`.
   The bot only ever edits its own post, so a player's message is ignored, but it would
   sit under the scoreboard.

2. **Add the id to `/opt/clan-wars/.env`:**

       SCOREBOARD_CHANNEL_ID=...

   It runs on `LEADERBOARD_TICK_INTERVAL_MS` (default 5 minutes). Flags need
   `FLAG_IMAGE_BASE_URL` (already `https://dayzclanwars.com` in production); unset, the
   cards post without flags. Unset `SCOREBOARD_CHANNEL_ID` and the feature is off.

3. **Restart the bot**: `sudo systemctl restart clan-wars-bot`.

4. **Confirm the first pass** (`journalctl -u clan-wars-bot -f`). Within the interval:

       scoreboard: posted, 0 error(s)

   After a later restart the first pass prints `edited` instead: it adopts the post
   already there and redraws it once. Passes that change nothing print nothing.

5. **Verify against the site.** Every clan, its order, rank, points, Alpha badge and the
   three counts must match `/scoreboard`. A disagreement is a bug, not a lag, beyond the
   five-minute interval.

## How the post is found

There is **no stored message id**. Every pass the bot reads the channel's last 50
messages and takes its own message whose heading carries the masked link
`[…](<https://dayzclanwars.com/scoreboard>)`. Found, it is edited when the standings
changed; not found, a fresh post goes up. So deleting the post is a safe way to force a
redraw: it comes back within one interval.

## Hazards

⚠️ **A failed standings read writes nothing**, so a database blip can never blank the
cards.

⚠️ **Ten cards at most.** Discord caps a message at 10 embeds. Past ten clans the post
shows the top ten and the heading adds "+N more on the site".

⚠️ **Changing `SITE_BASE_URL` orphans the post.** The marker includes the origin, so the
bot will not recognise its old post and will send a new one. Delete the old one by hand.
