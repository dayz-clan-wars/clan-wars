# Acceptance: the paused disband countdown (inbox item 26, bullets 1 and 2)

**Date run:** 2026-09-02

**Change under test:** `decide()` gains a `pause` transition. A dormant faction whose
server has produced no event for `dormantAfterMs` now has its `dormant_since` re-stamped
to now, restarting the disband countdown, instead of merely having the disband withheld.
`dormancyTick` counts `paused`; the bot logs it at error level, naming it as an ingest
problem.

Two of item 26's three bullets close with this. The third — a genuinely dead server never
releasing its flags — is unchanged and, by construction, now permanent rather than
incidental. That is recorded in the inbox and in the spec's new §3.3 rather than fixed.

## Why the old behaviour was wrong

Withholding the disband was necessary and not sufficient: the countdown kept running
through the blind window. A `dormant_since` stamped during an outage was stamped from
evidence nobody had, and the first tick after recovery disbanded a faction that had been
*watched* for less than the window promises.

## 1. The defect, reproduced and then fixed

`apps/bot/test/dormancy.test.ts` replays inbox item 26's exact scenario one tick per day:
ingest down days 0–20, a genuine flag raise on day 10 that nothing can observe until the
backfill lands, then a healthy server from day 20 on.

Against the old `decide()` the replay disbanded the faction on **day 21** — 14 days after
a stamp backed by 11 days of anything anyone actually watched. Against the new one it
disbands on **day 33**: dormant on day 7, paused each tick through day 19, countdown
running from day 19 once observation resumed on day 20.

The test asserts the day and, separately, the property — at least a full window after
observation resumed — so the arithmetic and the intent both have to hold.

A control replay with a server that is never down still disbands on **day 21**, which is
the unchanged 7 + 14. The fix does not slow down the ordinary path.

## 2. Boundary and ordering coverage

`decide()`'s dormant branch is `revive` → `stamp` → `pause` → `disband`, each boundary
tested:

- `revive` still beats `pause` (evidence beats the absence of evidence — the same
  reasoning that puts revive ahead of disband).
- `stamp` still beats `pause` on a row with no timestamp. The two write the same value
  but the store guards are complements, so routing to the wrong one would be a no-op the
  tick reported as work done.
- `pause` fires whether or not the row is due. This is the ordering the fix turns on:
  behind the due check, the clock still accrued on every not-yet-due tick.
- The three pre-existing liveness-gate tests changed from `toBeNull()` to `toBe("pause")`.
  That is a deliberate contract change, not a loosened assertion — the gate's *effect* is
  strictly stronger than before.

## 3. Store guards are complementary

`apps/bot/test/dormancy-store.test.ts`, against the real database:

| Row | `stampDormantSince` | `pauseDormancyClock` |
|---|---|---|
| dormant, `dormant_since IS NULL` | true | **false** |
| dormant, `dormant_since` set | false | **true** |
| active | false | **false** |

Plus the end-to-end storage behaviour: a row that was due to disband, once paused, is
refused by `disbandDormant` at the cutoff that would previously have taken it.

## 4. Suites

```
apps/bot  test/dormancy*.test.ts    5 files, 67 tests, all passing
```

Full gate:

```
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx turbo run typecheck test --concurrency=1 --force
#  Tasks:    20 successful, 20 total
#  Cached:    0 cached, 20 total
```

## 5. Production is unaffected today

The read-only acceptance check from CLAUDE.md, run against `factions_live` before
committing:

```
 tag | status | dormant_since |          age
-----+--------+---------------+-----------------------
 COK | active |               | 1 day 00:54:41.194269
```

And the new transition's input, the server's own liveness:

```
 id |  name   | since_last_event
----+---------+------------------
  1 | CW-TEST | 00:07:08.251838
```

One active faction, last raise ~1 day ago (well inside the 7-day window), and a server
that produced an event seven minutes ago. Nothing is dormant, so there is no countdown to
pause, and the new branch cannot fire for any live row as things stand. The change is
inert in production until either a faction goes dormant or ingest stops.

**No migration.** `dormant_since` already exists and no column was added, so this deploys
as code only — the bot can be restarted on it without a schema step.

## What this does not prove

- **The pause has never run against a real outage.** The scenario is exercised by a
  replay over the pure function and by store-level tests, not by taking production ingest
  down.
- **Write volume during an outage is reasoned about, not measured.** One update per
  dormant faction per tick, for as long as the outage lasts. With today's single faction
  that is nothing; it was never load-tested at a full 33-flag pool.
- **Nothing about the third bullet.** A dead server still never releases its flags, and
  this change makes that indefinite rather than eventual.
