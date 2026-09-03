# Deploy: faction rebind, and the dormancy pause — 2026-09-03

**Shipped:** `/faction rebind` (a faction can move its base), and the dormancy pause fix
(inbox item 26). Both had been merged to `main` and were not running.

**Migration:** `0018_complete_miek` — one nullable column, `factions.rebound_at`.

**Plan:** `docs/superpowers/plans/2026-09-03-faction-rebind.md`
**Specs:** `docs/superpowers/specs/2026-09-03-faction-rebind-design.md`,
`docs/superpowers/specs/2026-09-02-faction-dormancy-design.md` §3.3

---

## Why the bot had to restart even though the migration was harmless

`0018` adds a **nullable** column with no default, so old code plus new schema is safe —
CLAUDE.md's stop-the-bot rule is about NOT NULL columns and constraints, and this is
neither. The restart was needed for a different reason: the running bot had been started
before any of this work, so it carried neither the dormancy pause nor the rebind command.
`buildCommands()` registers slash commands at startup, so `/faction rebind` does not exist
to Discord until a restart happens.

## The migrator safety check, before touching anything

There is still no `db:migrate` script (inbox item 28). The one-off runner from
`docs/deploy/2026-09-02-dormancy.md` was reused verbatim and deleted afterwards.

⚠️ The postgres-js migrator applies every journal entry whose `when` is newer than the
newest `created_at` in `drizzle.__drizzle_migrations`. Before running it, confirm that
comparison selects exactly what you expect:

```
live:    count = 18, max(created_at) = 1788386867092
journal: 0017_omniscient_unus when = 1788386867092   <- equal, so 0017 is the newest applied
         0018_complete_miek   when = 1788452386380   <- the only entry newer
```

So `0018` and nothing else. After: `count = 19, max = 1788452386380`.

## Order used

1. `git push origin main` — 18 commits existed only on one machine. Do this first; it is
   free and it is the largest risk on the board before a deploy.
2. Read-only dormancy acceptance check — **the go/no-go**. One active faction, `COK`,
   age 1d 19h, well under the 7-day threshold, so the first tick transitions nothing.
   ⚠️ Any row over 7 days here loses a real player's supplies on the first tick.
3. Confirmed the migrator would apply only `0018` (above).
4. `pkill -f "src/main.ts"`, then **counted survivors — zero** before continuing.
5. Applied `0018` with the one-off runner, then verified:
   `rebound_at | timestamp with time zone | YES | (no default)`.
   The nullable-with-no-default shape is the point — a `DEFAULT now()` would have put
   every existing faction on a 7-day rebind cooldown at migration time, with no symptom
   except leaders being wrongly refused.
6. Started one bot: `set -a && . ./.env && set +a && nohup pnpm --filter @factions/bot start > bot.log 2>&1 &`
   — note `. ./.env`, not `. .env`; zsh's `.` searches `$PATH` for a slashless name and
   silently starts nothing.
7. Waited ~60s (six ticks), grepped the log for errors: none.
8. Re-ran the acceptance check.

## Result

Before and after are identical apart from the new column:

```
 tag | status | dormant_since | rebound_at |         age
-----+--------+---------------+------------+----------------------
 COK | active |               |            | 1 day 19:46:12
```

Nothing transitioned, which is what it had to do. `bot ready as Clan Wars#3900`, one
logical instance (two pids: the tsx wrapper and its node child, as always).

## The ingest worker was NOT rebuilt, deliberately

Nothing under `apps/ingest-worker` changed on this branch. The worker runs old code
against the new schema, which is safe: `rebound_at` is additive, and the supply tick
selects explicit columns (`tag`, `texture`, `x`, `y`, `z`) rather than `select()`.
Confirmed live after the migration — sweeps continuing normally at ~3s each.

## What is now live that was not before

- **The dormancy disband clock pauses while a server is dark.** Previously the countdown
  kept running through an ingest outage, so a faction could disband on less observed
  silence than the 14-day window promises. A paused clock is logged at error level.
- **`/faction rebind` is available to players.** There is no feature flag; it went live
  with the restart. A roster member raises the faction's own flag at a pole nobody holds,
  the leader confirms with a button, and the base moves. 7-day cooldown.

⚠️ The reply text tells a leader their old base "stays private for 3 days". That is
vacuously true today — nothing publishes base coordinates yet. It becomes a real promise,
and must be wired, when
`docs/superpowers/specs/2026-09-03-base-declaration-design.md` ships. Recorded in that
spec's §10.

## Carried forward

- Still no `db:migrate` script (inbox item 28). This is the third deploy applied by a
  hand-assembled runner.
- Still nothing enforcing the single-bot-instance rule (inbox item 22). The survivor count
  in step 4 is a human check.
