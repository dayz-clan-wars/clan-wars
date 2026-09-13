# Combat feeds — deploy

Three new Discord feeds. Each is off until its channel id is set, and each seeds its
cursor at the head on its first run, posting nothing historical — the same rule
`docs/deploy/2026-09-08-kill-feed.md` documents for #kill-feed.

## Migration

**`0034` is a real migration and must be applied by hand before the new code starts** —
nothing in this repo applies migrations at startup. `runMigrations` (`packages/db/src/migrate.ts`)
is called only from tests, there is no `db:migrate` script, and a deploy that assumes the
bot migrates itself starts a bot whose queries reference an index the live database does
not have. Use the one-off runner from `docs/deploy/2026-09-02-dormancy.md`.

`0034` adds two indexes on `events`, both needed by the hit feed's queries
(`hit-feed-tick.ts`: `hitEventsQuery` and `maxOccurredAtQuery`):

```sql
CREATE INDEX IF NOT EXISTS "events_hit_id_idx" ON "events" USING btree ("id") WHERE "events"."type" = 'player.hit';
CREATE INDEX IF NOT EXISTS "events_occurred_idx" ON "events" USING btree ("occurred_at");
```

⚠️ **Not `CONCURRENTLY`** — migrations run inside a transaction, and `CREATE INDEX
CONCURRENTLY` cannot run in one. This briefly locks writes on `events`, which is a large
table (the same table `0034`'s own review found had no usable index for this feed's read).
Pick a quiet moment; do not run it during a busy raid window.

Confirm the count afterward:

    select count(*) from __drizzle_migrations;   -- should include 0034

## Channels

| Channel | Env | Id |
|---|---|---|
| #hit-feed | `HIT_FEED_CHANNEL_ID` | `1548401025038426334` |
| #killstreaks | `KILLSTREAK_FEED_CHANNEL_ID` | `1548459035936821358` |
| #long-range | `LONG_RANGE_FEED_CHANNEL_ID` | `1548459101116178513` |

All three are optional, like `KILL_FEED_CHANNEL_ID` and `BOT_FEED_CHANNEL_ID`: unset means
the feed is off and nothing posts. Validated at config load, not at first post, so a
malformed id fails loudly at boot instead of looking like an off feed.

## Tuning

| Env | Default | Meaning |
|---|---|---|
| `HIT_BURST_WINDOW_S` | `60` | Quiet gap that closes an engagement |
| `KILLSTREAK_EVERY` | `3` | Post on every Nth kill of a streak |
| `LONG_RANGE_MIN_M` | `100` | Minimum distance for #long-range |

⚠️ Lowering `HIT_BURST_WINDOW_S` below 120 does **NOT** make #hit-feed post sooner. A
separate 120-second floor — `RECENT_HIT_WINDOW_S`, how far back `kills-tick` looks to
credit a finished death to a kill — holds every engagement open until a late kill can no
longer claim it, regardless of how short the burst window is set. Tuning
`HIT_BURST_WINDOW_S` below that floor changes nothing observable; do not conclude the
feature is broken.

## Permissions

The bot needs **View Channel**, **Send Messages** and **Embed Links** on all three
channels. A feed that cannot post logs `<name> feed blocked at …` once and stops; nothing
behind the blocked item posts until it succeeds, by design, so the channel stays
chronological.

## Steps

1. **Apply migration `0034`** before the new code starts (see above). It is index-only —
   no column changes — so the bot does not need stopping for it, but it does briefly lock
   `events` for writes; do it in a quiet moment regardless.
2. **Set the channel ids** above (and the tunables, if the defaults are not wanted) in the
   host `.env`.
3. **Pull and restart the bot**: `git pull && sudo systemctl restart clan-wars-bot`. The
   bot role already has View Channel, Send Messages and Embed Links guild-wide.
4. **Watch for three `cursor seeded at the head` lines** on the first tick after restart —
   one per feed that has a channel id set. They appear once each, ever.
5. **Confirm a post in each configured channel** after the next qualifying fight: any PvP
   engagement for #hit-feed, every third kill of a streak for #killstreaks, and any PvP
   kill past `LONG_RANGE_MIN_M` for #long-range.

## Turning one off

Unset its channel id and restart. The cursor row stays where it is, so re-enabling it
later resumes from that point rather than replaying — if the gap is large, delete the
consumer's row from `consumer_cursors` before restarting to have it re-seed at the head
instead.

Consumer names: `hit-feed-poster`, `killstreak-feed-poster`, `long-range-feed-poster`.
