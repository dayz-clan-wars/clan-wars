# Backfill faction founding history

Gives the factions that already exist a `founded` (and, where applicable, `activated`)
row in `faction_events`, dated to the real `created_at` / `activated_at` on the
`factions` row — not to the moment the script runs. Without this, the faction feed's
first posts would only cover transitions from the moment the feed shipped forward, and
every faction that existed before that would look like it sprang into being mid-story.

**Idempotent per faction, not per row.** The script skips any faction that already has
*any* row in `faction_events`, regardless of kind. Running it twice is safe — the second
run inserts nothing — which matters because this runs by hand against production during
a deploy, and a duplicate insert would announce a founding a second time to a public
channel, where it cannot be taken back.

**Leaves rows queued, not posted.** `posted_at` is left null; delivery is the ordinary
feed tick's job, not this script's. This script never touches Discord.

**No actor is recorded.** The founder's identity isn't on the `factions` row, and
resolving `leader_discord_id` would credit whoever holds the seat today, which is wrong
for any faction that has since changed leadership.

## When to run it

After migration `0019` (which creates `faction_events`) has been applied, and before
`BOT_FEED_CHANNEL_ID` is set and the bot restarted onto the feed code — so the backfilled
rows are already queued and ready when the first feed tick runs, and no live transition
races the backfill for the same faction.

## Read-only check first

```sql
select id, tag, status, created_at, activated_at from factions order by id;
```

Confirm the `created_at` / `activated_at` values look sane (no nulls where you expect a
timestamp, no far-future dates) before writing anything.

## Run

```bash
set -a && . .env && set +a && npx tsx apps/bot/src/feed-backfill.ts
```

Prints `backfill: inserted <n> event(s), skipped <n> faction(s)` and exits 0.
`skipped` counts factions that already had at least one `faction_events` row — expected
to be everything on a re-run, and expected to be nothing on the first run against a
freshly migrated database.
