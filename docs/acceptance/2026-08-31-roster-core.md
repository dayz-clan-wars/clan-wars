# Acceptance: roster core (Plan 4)

**Date run:** 2026-09-01 (re-run 2026-09-01 after the final-review fix wave)

**Change under test:** the roster core — `apps/bot/src/roster-store.ts`,
`apps/bot/src/roster-context.ts`, `apps/bot/src/roster-commands.ts`, and the
`faction_members` / `faction_invites` / `roster_cooldowns` schema in
`packages/db/src/schema.ts` — covering invite/accept/decline, kick/leave and
their shared cooldown, promote/demote/transfer, disband, and rename, plus the
public `/faction info` and `/faction roster` reads and their Discord wiring.

**The question this run answers:** do the three unique indexes this whole
design leans on — `faction_members_server_player_uniq` (one faction per
player per server), `faction_members_leader_uniq` (exactly one leader),
`faction_invites_pending_uniq` (one outstanding offer per faction per
player) — actually arbitrate a genuine race, or only look correct because
every prior test ran its two statements one after another on a single
connection? A membership rule that only holds when nobody contends for it
is not a membership rule; it is a hope. This run drives real concurrent
writes from two separate Postgres connections at each of the three indexes
and checks that exactly one side wins and the data never splits.

**Database:** the shared `factions` test database on the already-running
`clan-wars-postgres-1` container, host port 5434 (`postgres://factions:factions@localhost:5434/factions`).
Ports 5432 and 5433 belong to unrelated projects on this machine and were
not touched.

## The race tests

`apps/bot/test/roster-races.test.ts` (new). Each test opens **two separate
`createClient(URL)` connections**, wraps each in its own `PgRosterStore`,
and drives both stores through `Promise.all` — a genuine race decided by
Postgres's own row locks and unique-index conflict detection, not by
`setTimeout`. This is the same house pattern already established in
`apps/bot/test/roster-departures.test.ts`'s "removed out from under the
kick" test: ordering evidence comes from what the database itself
serializes, so the tests are deterministic in their *outcome* even though
which of the two racing calls wins is left genuinely up to Postgres and is
never asserted. (Race 5 below opens a third connection, whose only job is
to hold a table lock that parks one racer in a specific gap — still real
lock state, still no clock.)

1. **`faction_invites_pending_uniq` / `faction_members_server_player_uniq`** — two different factions each hold a live, unexpired invite for the same Discord user (same underlying player). Both invites are accepted in the same instant from two connections. Exactly one `acceptInvite` returns `"ok"`; the other hits the unique violation on `faction_members_server_player_uniq` inside its own transaction and the store's existing catch (`if (String(err).includes("faction_members_server_player_uniq")) return "already-member"`) maps it to `"already-member"` — never a raw Postgres error string. Exactly one membership row exists afterward.

2. **`faction_members_leader_uniq`** — one faction, one leader, two officers. Two `transfer` calls target the same leader concurrently, to two different officers. `transfer` demotes-then-promotes inside one transaction; the second transaction's demote UPDATE blocks on the leader's row lock, and once the first transaction commits, its own WHERE (`role = 'leader'`) matches zero rows because the first transfer already flipped that role — no serialization error, no exception, just an ordinary zero-row UPDATE that the existing code already reports as `"not-leader"`. Exactly one `transfer` returns `"ok"`; exactly one row in the faction has `role = 'leader'` afterward.

3. **The kick/leave DELETE race** — a leader kicks a member at the same instant the member leaves on their own. Both `kick` and `leave` decide their outcome from `.returning()` on a conditional DELETE against the same membership row (see the doc comments on both methods in `roster-store.ts`), so the second DELETE to reach Postgres — after the first commits and the row is gone — simply matches zero rows and returns its own non-`"ok"` outcome (`"target-not-member"` / `"not-member"`) rather than throwing. Exactly one of the two racers reports `"ok"`, the member row is gone, and exactly one cooldown row is written (never two, never zero).

4. **Rename versus rename inside the cooldown** (added by the final-review fix wave — §8 named this race and nobody had written it). One faction, one leader, two concurrent `rename` calls to different names with the same `notBefore` floor. The second UPDATE blocks on the faction's row lock, then re-evaluates its own WHERE against the committed row, where `renamed_at` is now the first writer's instant and no longer satisfies `renamed_at <= notBefore`. Exactly one returns `"ok"`, exactly one returns `"cooldown"`, and the stored name is the winner's — never the loser's. Verified to FAIL when the cooldown clause is removed from the UPDATE's WHERE, so it is testing the guard rather than agreeing with it.

5. **Accept versus disband — the stranded membership row** (added by the final-review fix wave; a blocking defect). `acceptInvite` re-read the faction's status with an unlocked `SELECT`, which under `READ COMMITTED` is not a check at all: `disband()` and `lapseReservations()` both `UPDATE factions` and then `DELETE FROM faction_members`, and that DELETE cannot see the membership row the accept has not inserted yet. Read status → watch a disband commit in the gap → insert anyway, and the row outlives its faction. `faction_members_server_player_uniq` carries no status predicate, so that row then bars the player from every future faction on the server with **no command able to clear it** — `/faction leave` says "You are not in a faction", `createInvite` says "already in a faction", `acceptInvite` says "already-member". Manual SQL was the only escape.

   The interleaving is narrow, so the test stages it with a real lock rather than hoping for it: a third connection holds `ACCESS EXCLUSIVE` on `roster_cooldowns`, the table `acceptInvite` reads *between* its status check and its membership INSERT, which parks the accept in exactly the gap the defect needs. Ordering is read back out of `pg_stat_activity`'s own view of who is waiting for whom — never timed, never `setTimeout`. The test was run RED against the unfixed store first and failed with the stranded row present (`expected [ { id: 2, … } ] to deeply equal []`). The fix takes `SELECT … FOR SHARE` on the faction row inside the accept transaction, which both writers must wait on, so the roster DELETE always runs after the membership INSERT.

6. **Accept versus disband — lock order** (added by the follow-up re-review; a blocking defect the fix wave itself introduced). Race 5's `FOR SHARE` and Item 4's invite revoke together created a cycle: `acceptInvite` claimed the `faction_invites` row and then waited on the `factions` row, while `disband()`/`lapseReservations()` updated the `factions` row and then waited on the `faction_invites` row to set `revoked_at`. Postgres resolves that by aborting one side with 40P01 — a raw serialization error surfacing to a player who merely pressed Accept. Neither half existed before the wave.

   Staged with a real row lock, like race 5: a third connection holds `FOR UPDATE` on the leader's membership row, which parks the disband *between* its `UPDATE factions` and its invite revoke; the accept then arrives at that held faction row. (A row lock, not `LOCK TABLE faction_members` — `disband`'s leader guard is a correlated SELECT on that same table, so a table-level `ACCESS EXCLUSIVE` would park the disband before it ever locked the faction row, which is the wrong gap.) The test was run against the pre-fix ordering and failed with `PostgresError: deadlock detected`. The fix moves the `FOR SHARE` **above** the claim UPDATE so both sides acquire `factions` first; the claim remains the atomic double-spend guard and carries the locked faction id in its own `WHERE`, and the `not-holding` path then has nothing written to roll back. Neither call may reject — that both settle IS the assertion that no deadlock occurred — and the outcomes are deterministic (`disband` → `"ok"`, `accept` → `"not-holding"`, invite unconsumed but revoked, no membership row).

Both staged tests wrap their lock holder in a `try/finally` and close their
extra connection, so a failing wait predicate cannot leave a lock in place
and wedge the next `beforeEach` TRUNCATE.

No test in this file needed a store-level catch for a raw Postgres
serialization error — the app's default `READ COMMITTED` isolation means
every one of these six races resolves as an ordinary row-lock wait
followed by a zero-row UPDATE/DELETE or a unique-index violation, both of
which the store already handled before this task. Races 1-3 needed no
change to `roster-store.ts`; races 5 and 6 did — see above.

### Commands used

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  pnpm -F @factions/bot test roster-races
```

Run three times in a row, not once — a race test that passes by scheduling
luck will not pass three times.

**Run 1:**
```
 ✓ test/roster-races.test.ts (6 tests) 412ms
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

**Run 2:**
```
 ✓ test/roster-races.test.ts (6 tests) 399ms
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

**Run 3:**
```
 ✓ test/roster-races.test.ts (6 tests) 420ms
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

All three runs: 1 file, 6 tests, 0 failed. (Output also carries a stream
of Postgres `NOTICE`-level `truncate cascades to table "..."` lines from
the `beforeEach` truncate statement — expected noise from the shared
multi-table schema, not test failures.)

## Full workspace suite

```bash
export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"
npx turbo run typecheck test --concurrency=1 --force
```

`--force` (turbo's own flag) was used deliberately, as in the prior
acceptance runs on this repo, to force real re-execution rather than a
cache hit.

Per-package results (test tasks only; typecheck tasks all passed with no
test counts to report):

| package | test files | tests |
|---|---|---|
| @factions/projector | 1 | 11 |
| @factions/ceremony | 1 | 10 |
| @factions/ingest-worker | 8 | 71 |
| @factions/event-log | 2 | 13 |
| @factions/domain | 3 | 30 |
| @factions/nitrado | 1 | 10 |
| @factions/verification | 2 | 15 |
| @factions/adm-parser | 8 | 101 |
| @factions/bot | 19 | 328 |
| @factions/db | 6 | 40 |

**Total: 629 tests passed across 51 test files, 0 skipped, 0 failed. Turbo:
20 successful, 20 total (0 cached — forced real execution).**

This is a growth of 269 tests from the 2026-08-31 ceremony-detection
acceptance baseline of 360 (`@factions/bot` alone grew from 136 to 328
across this plan's ten tasks, the final-review fix wave and its follow-up,
including the six races above;
`@factions/db` grew from 31 to 40 with the roster schema tests;
`@factions/ingest-worker`, `@factions/nitrado`, `@factions/adm-parser` grew
from unrelated, already-landed work on other branches merged into this
history). The `@factions/ingest-worker` test output includes several
printed stack traces from `apps/ingest-worker/test/tick.test.ts` — these
are pre-existing, deliberately-triggered error paths under test (the same
"assert expected error logs instead of printing them" pattern already
noted in this codebase's commit history), not new failures; the package's
own summary line reports `8 passed (8)` files and `71 passed (71)` tests.

This run truncated the shared `factions` database as a normal part of each
test file's `beforeEach` — expected, and does not touch any other database.

## Not yet accepted: a real roster command against a real Discord client

Every test in this plan — including the three race tests above — drives
`PgRosterStore` and the command handlers directly against a real Postgres
database, but never through an actual Discord gateway, an actual slash
command interaction, or an actual human clicking an actual button. The
race tests prove the indexes and locks decide concurrent writes correctly;
they say
nothing about whether `/faction invite`, `/faction accept`, `/faction kick`,
`/faction promote`, `/faction transfer`, `/faction disband`, or
`/faction rename` behave correctly when driven by Discord's own
interaction plumbing (button custom-id round-trips, ephemeral replies,
permission checks Discord itself enforces, rate limits, retries). No
roster command has ever run against a real Discord client.

- [ ] **Staged (requires a Discord guild and human hands).** Found a
      faction, invite a second player, have them accept, promote them,
      transfer leadership, kick a third player and confirm the cooldown
      blocks their re-invite, then disband and confirm the flag returns to
      the pool.

This gate joins two others already open and unresolved elsewhere in this
project: Plan 3's staged ceremony gate (`docs/acceptance/2026-08-31-ceremony-detection.md`
— three or more linked players raising `Flag_White` together, ingested and
confirmed against a real ADM export) and the live Nitrado ingest tick gate
(pulling and processing a real Nitrado ADM feed on a schedule, rather than
replaying a static export). None of the three has been run. All three
require the same thing this plan cannot supply from a test suite: a real
Discord guild, a real DayZ server, and human hands.

## PASS/FAIL

**PASS** on every fixture-level check this task can make. The six
concurrency races each ran three times with no flakes: the invite-accept
race, the leadership-transfer race, the kick/leave race, the
rename-vs-rename race, the accept-vs-disband strand race and the
accept-vs-disband lock-order race all resolved to exactly one winner and a
consistent database state every time. Races 1-3 needed no store change;
races 4-6 were added by the final-review fix wave and its follow-up. Race 5
exposed a real defect (an unlocked status read in `acceptInvite` that could
strand an unclearable membership row) and race 6 exposed a defect the wave
itself introduced (the `FOR SHARE` and the invite revoke disagreeing on
lock order, deadlocking with 40P01); both were seen failing before their
fixes landed. The full workspace suite — 629 tests across 51 files, 20/20
turbo tasks, forced past cache — passed with zero failures. The one open item is the staged Discord gate above,
which requires a real guild and real human hands and cannot be satisfied by
any automated test in this repository; it joins two other staged gates
already open elsewhere in this project.
