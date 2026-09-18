# Public ban announcements — deploy

A public `#bans` channel now announces every enforced ban and unban on the server:
applied, lifted (one lift on starting to link, for `UNLINKED_PC_BAN`) and expired
(served in full). `ban_announcements` is the queue table (migration
`0040_silent_slapstick.sql`); `banAnnouncementText` (`apps/bot/src/ban-announce-text.ts`)
is the pure renderer; `banAnnounceTick` (`apps/bot/src/ban-announce-tick.ts`) drains it,
run per server in `discord.ts` right after `banTick` in the same 5-minute block —
immediately after, because `banTick` is what writes the rows this drains; running it any
later would always leave the channel a cycle behind the ban it's announcing.

## What posts, and what deliberately does not

- **Applied**, **lifted** and **expired** ban transitions post — one line each, oldest
  first.
- ⚠️ **A dry-run ban never posts.** `BAN_DRY_RUN` (default `true`) governs whether a ban
  ever reaches Nitrado at all; the row `banTick` writes for a dry-run pass never queues a
  `ban_announcements` row (see `apps/bot/src/ban-tick.ts`). This is not a filter applied
  at post time — a dry-run ban simply never enters the queue, so there is nothing here to
  suppress or catch up on later once `BAN_DRY_RUN` is turned off.
- The `gamertag` in every line is player-controlled text. `banAnnouncementText` escapes
  markdown so it can't restyle the message, but escaping does **not** suppress
  `@everyone`/`@here` — that's the poster's job. The channel's poster passes
  `allowedMentions: { parse: [] }` explicitly (see `createChannelPoster`'s comment in
  `apps/bot/src/discord.ts`) so a gamertag of literally `@everyone` cannot ping the guild.

## ⚠️ The queue fills whether or not `BANS_CHANNEL_ID` is set

`ban_announcements` rows are written inside `banTick`'s own transaction, gated only on
`ENFORCEMENT_TICK` (and, transitively, `BAN_DRY_RUN=false` for a row to exist at all —
see above). `BANS_CHANNEL_ID` gates only the read side — whether `banAnnounceTick` runs
at all. This is the same shape as `RELEASE_CHANNEL_ID`/`release_announcements` and
`WAR_LOG_CHANNEL_ID`/`war_log_events`.

**Consequence: setting the channel later posts the whole backlog at once.** If real
enforcement has been running for a while before `BANS_CHANNEL_ID` is first configured,
every ban and unban since enforcement began is queued and unposted, and the first
restart with the channel set drains all of it, oldest first — but slowly.
`banAnnounceTick` runs in the bot's **5-minute** block (beside `reaperTick`/`banTick`,
not on the 10s tick interval) and posts at most `BAN_ANNOUNCE_BATCH_SIZE` = **20 rows
per server per run**: **20 messages every 5 minutes**, about 240/hour. A 500-row backlog
therefore takes roughly **two hours**, not a couple of minutes. Do not read a slow drain
as a stall and restart the bot — the restart just costs you the next cycle.

Before setting the channel, check what's queued:

    docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c \
      "select count(*) from ban_announcements where posted_at is null"

If that backlog should not post (e.g. you only want the channel to announce bans from
this point forward, not the history), mark it posted first — this does **not** retract
anything, because nothing has posted yet; it just tells the queue to skip it:

    docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c \
      "update ban_announcements set posted_at = now() where posted_at is null"

Then set `BANS_CHANNEL_ID` and restart the bot. Only bans and unbans from that point on
will post.

## Enable

Add to `/opt/clan-wars/.env`:

    BANS_CHANNEL_ID=1550534495428550736

then

    sudo systemctl restart clan-wars-bot

Confirm the warn is gone:

    journalctl -u clan-wars-bot --since "2 min ago" | grep -i "ban announce"

`public ban announcements are OFF (BANS_CHANNEL_ID unset)` must **not** appear; the
startup line should instead read `public ban announcements on: #bans`.

## If it blocks

Like the faction feed, the war log and release announcements, the queue **stops at the
first failure by design** — one stuck row blocks everything behind it rather than
letting a later ban post out of order, which would make the channel's chronology
untrustworthy. Spot it in the log:

    journalctl -u clan-wars-bot --since "10 min ago" | grep "ban announce queue blocked"

The line names the blocked `ban_announcements` row id and the server. Almost always the
bot lacking **View Channel** or **Send Messages** on the channel. Fix the permission;
the next tick retries on its own — nothing needs restarting. The per-server "already
reported" guard means this line logs once per row per server, not every 10 seconds
forever, but a *different* row blocking later is reported again.

## Rollback

Unset `BANS_CHANNEL_ID` and restart. `banTick` keeps writing `ban_announcements` rows on
every real ban transition regardless (it's unconditional, same as `release:sync`) and
nothing posts. Nothing already posted is retracted.

## This deployment's channel

`BANS_CHANNEL_ID=1550534495428550736`
