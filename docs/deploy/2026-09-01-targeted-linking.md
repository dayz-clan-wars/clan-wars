# Deploy step — targeted identity linking

Everything below was learned deploying this to `factions_live` on 2026-09-01.
It is in running order.

## 0. Check `DATABASE_URL`

The bot and the ingest worker must both point at **`factions_live`**. The
`factions` database on the same server (port 5434) is the TEST database — a
dozen test files truncate `events`, `verification_challenges` and friends in it,
so a process pointed there loses every ingested event on the next `pnpm test`.

## 1. Stop the bot BEFORE migrating

Migration `0013` and, before it, `0012` add NOT NULL columns and constraints that
pre-migration code knows nothing about. On 2026-09-01 `factions_live` was
migrated while the bot was still running the old code: `handleLink` inserted a
null `target_dayz_id` against the new NOT NULL column and Discord showed "The
application did not respond" to a real user, twice. No data damage — both
inserts rolled back — but the window is player-visible.

Restart-then-migrate, or take the bot down for the migration window. Either
way, confirm the old process is actually gone: the duplicate-DM incident below
was caused by a `pkill` pattern that did not match the expanded `tsx` command
line, leaving a stale bot alive.

## 2. Only ONE bot instance may run

`notifyCompleted` sends the DM **before** it calls `markNotified`. That order is
right for one process — marking first would drop the DM if the send then failed —
but it makes the notifier at-least-once *across* processes: two instances both
read `pendingNotifications()`, both send, then both mark. We hit this for real on
2026-09-01 and a verified player received the completion DM twice.

The bindings were never at risk (`completeChallenge` is guarded and only one link
row existed); the blast radius is duplicate notifications. Nothing in the code
enforces single-instance — see inbox item 22 — so it is the operator's job.
The players projection and the ceremony notifier share the same loop and the same
assumption.

## 3. Clear the pre-change challenges, THEN migrate

With the bot down, and before applying migration 0012 to any database holding
rows:

    delete from challenge_attempts;
    delete from verification_challenges;

Every pre-change challenge is unwinnable under the new rules: it has no target
UID, and the tick now requires one. `identity_links` is untouched and must not
be cleared — a completed link stays valid.

Verified 2026-09-01: `factions_live` held 1 challenge, 0 attempts, 0 links.

Then apply the migrations, and only then start the bot again.

## 4. Expect a long FIRST tick

`runPlayerProjection` runs first in the bot's guarded job, ahead of
`verificationTick`, and on a fresh deploy `players` is empty at cursor 0. The
first pass therefore replays the **whole event log**, one INSERT per event,
serially, before verification runs at all. The observed first tick on CW-TEST
logged `players projected 31 of 31 events`; a server with real history will take
proportionally longer.

Two consequences while it runs:

- `/link`'s autocomplete can offer **nobody**, because it only offers characters
  the projection has recorded. This looks like a broken command and is not.
- Verification does not advance until the projection finishes, since both share
  one guarded job.

Both resolve on their own. Later ticks are cheap — the cursor only ever moves
forward.

## 5. What the migrations do not do

Nothing pre-existing becomes notifiable. Migration `0013` adds
`verification_challenges.cancel_reason`, which is NULL on every existing row, and
`pendingNotifications` keys the cancelled half of its query on that column rather
than on `canceled_at` — so the pile of already-cancelled and expired challenges
is not DMed as a flood on the first tick.
