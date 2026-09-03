# Acceptance: the faction feed

**Date run:** 2026-09-03
**Runbook:** `docs/deploy/2026-09-03-faction-feed.md` (executed; this is its record)
**Merged:** PR #3, merge commit `28ef923` on `main`
**Migration:** `0019_nice_doomsday`

The feed is the first thing this bot says in public. Every other surface is ephemeral or
a DM, so acceptance has to prove two different things: that the right rows exist, and
that what reached a real Discord channel is what those rows meant.

## 1. Pre-deploy state

```
 id | tag | status |         created_at         |      activated_at
----+-----+--------+----------------------------+------------------------
  1 | COK | active | 2026-09-01 21:30:07.957+00 | 2026-09-01 22:54:15+00
```

`drizzle.__drizzle_migrations`: 19 rows, newest `created_at` `1788452386380` — exactly
`0018_complete_miek`'s journal `when`, against 20 journal entries. So `0019` was the only
entry the migrator would apply. `to_regclass('public.faction_events')` was null.

## 2. Channel permissions — checked, not assumed

The runbook's step 1 is the one thing the database cannot answer, and the one whose
failure is worst: without **Embed Links** every post fails, and because the feed stops at
the first failure the queue never advances past row one. Checked with a throwaway
read-only script against the live token:

```
guild: Clan Wars (1542277942900686938)
channel: #🎌-faction-feed type=0 guild=1542277942900686938
same guild as DISCORD_GUILD_ID: true
isSendable(): true
  ViewChannel: YES
  SendMessages: YES
  EmbedLinks: YES
  ReadMessageHistory: YES
```

## 3. Gate on the merged tree

```
 Tasks:    20 successful, 20 total
Cached:    0 cached, 20 total
```

Run on `main` at `28ef923` — the tree that was about to run, not the branch it came from.

## 4. Migration

Applied with the one-off runner from `docs/deploy/2026-09-02-dormancy.md` (the variant
that refuses any URL not ending `/factions_live`), then deleted. After:

```
 count |      max
-------+---------------
    20 | 1788463371578
```

20 of 20 journal entries, `max(created_at)` equal to `0019`'s `when`. The table arrived
with everything it was supposed to:

```
faction_events_kind_valid
faction_events_no_coordinates      <- the constraint the whole design turns on
faction_events_pkey
faction_events_faction_id_factions_id_fk
faction_events_server_id_servers_id_fk

faction_events_faction_idx
faction_events_pkey
faction_events_queue_idx           <- partial, WHERE posted_at IS NULL
```

The `relation "__drizzle_migrations" already exists, skipping` line in the runner's
output is a Postgres NOTICE from `CREATE TABLE IF NOT EXISTS`, not an error; the runner
exited 0.

## 5. Backfill

```
backfill: inserted 2 event(s), skipped 0 faction(s)
```

Exactly what the runbook predicted. Both rows queued, dated to the transitions rather
than to the deploy, and carrying no coordinates:

```
 id |   kind    |        occurred_at         | posted_at |                      payload
----+-----------+----------------------------+-----------+---------------------------------------------------
  1 | founded   | 2026-09-01 21:30:07.957+00 |           | {"tag": "COK", "name": "The Cocks", "texture": "Flag_Rooster"}
  2 | activated | 2026-09-01 22:54:15+00     |           | {"tag": "COK", "name": "The Cocks", "texture": "Flag_Rooster"}
```

## 6. Restart

`pkill -f "src/main.ts"`, then **counted the survivors: 0** before starting anything —
CLAUDE.md's one-instance rule, which exists because `notifyCompleted` DMs before it
marks.

⚠️ `BOT_FEED_CHANNEL_ID` was written into `.env`, not passed only on the start command
line as the runbook's step 5 showed. A command-line-only variable turns the feed off at
the next restart with nothing saying so — the same class of silent failure the startup
warning was added to catch. The runbook has been corrected to match.

One logical instance confirmed by PPID (`38239`'s parent is `38233` — the tsx wrapper and
its child, the same shape as before the restart).

First tick after start:

```
bot ready as Clan Wars#3900
feed posted 2
```

## 7. What actually reached the channel

The load-bearing check. Read back from Discord, not inferred from the database:

```
--- msg 1545168793163014205 by Clan Wars#3900
  title: The Cocks [COK]
  desc:  Founded. The ritual is complete — the flag is reserved.
  color: #3ba55d  ts: 2026-09-01T21:30:07.957000+00:00
  fields: Flag=Rooster
  thumbnail: none
--- msg 1545168796296151194 by Clan Wars#3900
  title: The Cocks [COK]
  desc:  Colors raised. The faction is live.
  color: #3ba55d  ts: 2026-09-01T22:54:15+00:00
  fields: Flag=Rooster
  thumbnail: none
```

Four things this proves that a broken feed could not: the two posts are in `id` order
(`founded` before `activated`); both carry the **2026-09-01** transition times rather
than the deploy's, so a backfilled row reads as history with no special-casing; neither
payload nor embed contains a coordinate; and `thumbnail: none` is the designed state
while no flag artwork exists.

```
select count(*) from faction_events where posted_at is null;  ->  0
```

## Not proven here, and worth knowing

- **Only two of the seven kinds have run in production.** `founded` and `activated` came
  from the backfill. `renamed`, `rebound`, `dormant`, `revived` and `disbanded` are
  covered by tests and have never posted to a real channel — the first one to fire will
  be the first live exercise of its embed.
- **The stop-on-failure path has not fired here.** It is tested, but no real post has
  ever failed, so `feed queue blocked at …` has never been seen in production.
- **A lapsed reservation still writes no event** (inbox item 36). It could not fire
  during this deploy — `COK` is active and no reservation is outstanding.
