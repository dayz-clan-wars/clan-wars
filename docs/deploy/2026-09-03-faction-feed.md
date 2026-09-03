# Deploy: the faction feed — 2026-09-03

**Shipping:** an append-only `faction_events` log, written inside each transition's own
transaction, and a tick that posts queued rows in `id` order as embeds to one configured
public Discord channel. Merged to `main`, not yet running.

**Migration:** `0019_nice_doomsday` — creates `faction_events`, with the
`faction_events_no_coordinates` check constraint (this is the first table whose whole
purpose is to be published, so it is also the first one that refuses to hold a coordinate
at the database layer, not just by convention).

**Plan:** `docs/superpowers/plans/2026-09-03-faction-feed.md`
**Spec:** `docs/superpowers/specs/2026-09-03-faction-feed-design.md`
**Backfill:** `scripts/backfill-faction-events.md`, script at `apps/bot/src/feed-backfill.ts`

⚠️ This document is a runbook, not a report — it has not been executed. Follow
CLAUDE.md's rules throughout: port 5434 only, never touch `factions_live` outside a
deliberate step below, and confirm zero surviving bot processes before starting one.

---

## Order of operations

### 1. Pre-deploy check

Confirm `1545142533603201184` names a real channel in the guild `DISCORD_GUILD_ID`
points at, and that the bot's role has **View Channel**, **Send Messages** and **Embed
Links** there. Missing Embed Links is the dangerous one: every post then fails, and
because the feed stops at the first failure (by design — see CLAUDE.md), the queue never
advances past row one. Missing View Channel or Send Messages fails the same way for a
more obvious reason.

### 2. Read-only acceptance, before

```sql
select id, tag, status, created_at, activated_at from factions order by id;
```

Expect one row: `COK`, `created_at` 2026-09-01 21:30:07Z, `activated_at` 2026-09-01
22:54:15Z. This is also the input the backfill (step 4) will read — confirm it here so a
surprise in that step is recognizable as a surprise, not the first look at the data.

### 3. Apply `0019`

Use the one-off runner described in `docs/deploy/2026-09-02-dormancy.md` — a scratch
script at the repo root (needed there for workspace resolution: `@factions/db` does not
resolve from `scripts/`, and the same runner already refuses to point at anything but
`factions_live`), run with `set -a && . ./.env && set +a && npx tsx ./migrate-live.tmp.ts`,
then deleted.

Before running it, check the migrator will apply only `0019`:

```
docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X \
  -c "select count(*), max(created_at) from drizzle.__drizzle_migrations"
```

Expect `count = 19`, `max(created_at)` equal to `0018_complete_miek`'s journal `when`
(`1788452386380`) — so `0019_nice_doomsday` (`when` `1788463371578`) is the only entry
newer. After applying: `count = 20`, matching the journal's 20 total entries (`0019` is
`idx: 19`, zero-based, i.e. the 20th migration). **Confirm 20 of 20 journal entries.**

`0019` only creates a table — nothing existing reads or writes it yet, so this step is
safe to run with the old bot still up. It does not need to happen while the bot is down;
step 5 stops the bot for the restart, not for this migration.

### 4. Run the backfill

Point `DATABASE_URL` at `factions_live` and run:

```bash
set -a && . .env && set +a && npx tsx apps/bot/src/feed-backfill.ts
```

Expect `backfill: inserted 2, skipped 0` — `COK` gets a `founded` row dated 2026-09-01
21:30:07Z and an `activated` row dated 2026-09-01 22:54:15Z, both queued with
`posted_at` null. `skipped` would only be nonzero on a re-run, or for a faction that
somehow already has a `faction_events` row (none does today).

Run this **after** `0019` and **before** `BOT_FEED_CHANNEL_ID` is set and the bot
restarted — see `scripts/backfill-faction-events.md`'s "When to run it". Running it after
the feed is live would race a real transition landing on the same faction; running it
before `0019` fails outright, since the table does not exist yet.

### 5. Restart the bot with the feed enabled

Confirm zero surviving bot processes:

```bash
ps ax | grep "src/main.ts" | grep -v grep
```

Expect no output. `pkill -f "src/main.ts"` and re-check if anything is running — CLAUDE.md's
rule about `notifyCompleted` DMing before it marks makes a second live instance a
player-visible bug, not just a data race.

Start exactly one instance with the channel set:

```bash
set -a && . ./.env && set +a
BOT_FEED_CHANNEL_ID=1545142533603201184 nohup pnpm --filter @factions/bot start > bot.log 2>&1 &
```

(`. ./.env`, not `. .env` — zsh's `.` searches `$PATH` for a slashless name and silently
starts nothing, per the dormancy and rebind runbooks.)

The two backfilled rows are already queued from step 4, so the first feed tick after
this restart should post both.

### 6. Acceptance, after

- The configured channel shows two embeds: `founded` then `activated` (id order —
  `founded`'s row was inserted first), both timestamped 2026-09-01 — `founded` at 21:30
  and `activated` at 22:54.
- ```sql
  select count(*) from faction_events where posted_at is null;
  ```
  Expect `0`. A nonzero count here means the feed is stuck on a row and needs the log
  checked for `feed queue blocked at faction_events row …` before anything else about the
  feed is trusted.

### 7. Rollback

Unset `BOT_FEED_CHANNEL_ID` and restart the bot (same zero-survivor check as step 5).
Rows keep accumulating in `faction_events`; nothing posts. There is no schema change to
revert — `0019` only adds a table nothing else depends on, so leaving it in place is
harmless with the feed off, and the backfilled rows stay queued for whenever the channel
id is set again.

---

## What is NOT part of this deploy

- No flag-image resolution — `feed-embed.ts`'s resolver hook exists but nothing calls it
  with real artwork; every embed posts without a thumbnail. See inbox item 35.
- No raid/defense posts, no flag raise/lower posts, no per-faction channels — see the
  plan's "Notes for the implementer" for why each is deliberately out.
- No alerting on a blocked queue. `feed queue blocked at …` is an error-level log line;
  nothing pages anyone. Also inbox item 35.
