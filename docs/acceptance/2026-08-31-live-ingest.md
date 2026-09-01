# Acceptance: live ingest (cursor-resumed replay) against the production export

**Date run:** 2026-08-31

**Change under test:** the ingest refactor that RESUMES from a per-file line
cursor (`adm_files.lines_ingested` / `complete`) instead of re-reading every
file on every run (`apps/ingest-worker/src/ingest.ts`, `tick.ts`, `sweep.ts`,
`replay-main.ts`, `clock-offsets.ts`). This is exactly the kind of change
that can silently drop or double lines without anything downstream looking
wrong, because every count-based check would simply report the new number.
So this acceptance replays five weeks of real production logs and requires
the same counts three prior plans established (`docs/acceptance/2026-08-26-emote-ingest.md`,
`docs/acceptance/2026-08-31-flag-injection-fix.md`,
`docs/acceptance/2026-08-31-ceremony-detection.md`), plus a second replay
against the same database to prove the resume path emits zero new lines.

**Export:** `adm-raw-20260826.log.gz` (72,885 lines gzipped; 69,326 lines
after decompression — same file and same numbers as the three prior
acceptance runs above). Lives at
`/Users/steveharmeyer/Development/dayz-one-life/adm-raw-20260826.log.gz`,
outside this repo. Decompressed to `/private/tmp/live-ingest-acceptance/adm.log`,
a scratch path outside the repo, and never committed.

**Database:** `factions_backfill` on the already-running `clan-wars-postgres-1`
container (port 5434) — scratch, dropped and recreated for this run. The
shared `factions` database (used by the test suites, which truncate it) was
never touched by the backfill.

**Note on `CLOCK_OFFSET_MS`:** as already recorded in
`docs/acceptance/2026-08-31-ceremony-detection.md`, `replay-main.ts` does
not read `CLOCK_OFFSET_MS` from the environment — it derives the per-map
clock offset internally via `clockOffsetMsFor(group.map)`
(`apps/ingest-worker/src/clock-offsets.ts`). No `CLOCK_OFFSET_MS` was set
for this run, and none was needed.

## Commands used

```bash
# Step 1: fresh backfill database
docker compose exec -T postgres psql -U factions -d postgres -c "DROP DATABASE IF EXISTS factions_backfill;"
docker compose exec -T postgres psql -U factions -d postgres -c "CREATE DATABASE factions_backfill;"

# Decompress export to scratch (never committed)
mkdir -p /private/tmp/live-ingest-acceptance
gunzip -k -c /Users/steveharmeyer/Development/dayz-one-life/adm-raw-20260826.log.gz \
  > /private/tmp/live-ingest-acceptance/adm.log

# Migrations: `tsx -e` fails on top-level await in this setup (same as prior
# acceptance runs), so a temporary .mts file was written inside packages/db/,
# run, then deleted.
cat > packages/db/tmp-migrate-backfill.mts <<'EOF'
import { createClient, runMigrations } from './src/index.js';
const client = createClient(process.env.DATABASE_URL!);
await runMigrations(client);
process.exit(0);
EOF
export BACKFILL_URL="postgres://factions:factions@localhost:5434/factions_backfill"
DATABASE_URL="$BACKFILL_URL" pnpm --filter @factions/db exec tsx tmp-migrate-backfill.mts
rm packages/db/tmp-migrate-backfill.mts

# Step 1: first replay
DATABASE_URL="$BACKFILL_URL" pnpm --filter @factions/ingest-worker exec tsx \
  src/replay-main.ts /private/tmp/live-ingest-acceptance/adm.log

# Step 2: verification queries
docker compose exec -T postgres psql -U factions -d factions_backfill -c \
  "select type, count(*) from events group by type order by 2 desc;"
docker compose exec -T postgres psql -U factions -d factions_backfill -c \
  "select payload->>'action' as action, count(*) from events where type in ('flag.raised','flag.lowered') group by 1;"
docker compose exec -T postgres psql -U factions -d factions_backfill -c \
  "select count(*) as ceremonies from ceremonies;"
docker compose exec -T postgres psql -U factions -d factions_backfill -c \
  "select sum(lines_ingested) as lines, count(*) filter (where complete) as complete_files, count(*) as files from adm_files;"

# Step 3: second replay against the SAME database, not recreated
DATABASE_URL="$BACKFILL_URL" pnpm --filter @factions/ingest-worker exec tsx \
  src/replay-main.ts /private/tmp/live-ingest-acceptance/adm.log

# Step 3: re-run the same verification queries to confirm nothing moved

# Step 4: full suite
export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"
npx turbo run typecheck test --concurrency=1 --force
```

`pnpm run ci` was not tried first this time — the brief already documents
(and the prior ceremony-detection acceptance confirmed) that it reports a
pure cache hit and cannot be trusted. `npx turbo run typecheck test
--concurrency=1 --force` was used directly to force real execution.

## Step 1 & 2: first replay — actual vs. expected

Replay summary output: `replayed 1026 files, 69326 lines, 3560 skipped (no
timestamp column)` and `0 flag-shaped lines produced no event`.

| Check | Expected | Actual | Match |
|---|---|---|---|
| Lines replayed | 69,326 | **69,326** | yes |
| Flag changes (raise + lower) | 14 | **14** | yes |
| Flag raises | 10 | **10** | yes |
| Flag lowers | 4 | **4** | yes |
| `emote.performed` | 2,093 | **2,093** | yes |
| Ceremonies | 0 | **0** | yes |
| `adm_files` rows | 1,026, all complete | **1,026, all complete** | yes |

All events-by-type rows observed:

| type | count |
|---|---|
| player.position | 15,500 |
| emote.performed | 2,093 |
| flag.raised | 10 |
| flagpole.placed | 6 |
| flagpole.built | 5 |
| flag.lowered | 4 |
| flagpole.folded | 3 |
| flagpole.dismantled | 1 |

`adm_files`: `lines = 69326`, `complete_files = 1026`, `files = 1026`.

These match `docs/acceptance/2026-08-26-emote-ingest.md`,
`docs/acceptance/2026-08-31-flag-injection-fix.md`, and
`docs/acceptance/2026-08-31-ceremony-detection.md` exactly. **This is the
check that matters**: nothing moved after the cursor-resume refactor, so the
refactor did not silently drop or double any lines.

## Step 3: second replay against the same database, not recreated

The same `replay-main.ts` command was re-run a second time against
`factions_backfill` without dropping or recreating it — the file's 1,026
entries in `adm_files` already had `lines_ingested` equal to their full line
count from the first run, so the cursor resume path should write nothing on
the second pass.

Replay summary output (identical to the first run's console output, because
the script always logs the export's own line/file counts regardless of
how much it actually re-ingests):
`replayed 1026 files, 69326 lines, 3560 skipped (no timestamp column)` and
`0 flag-shaped lines produced no event`. No `<file>: N events` lines were
printed on the second run (every one on the first run had `eventsAppended >
0`; the second run appended none), confirming no new events were written.

Post-second-replay verification:

| Check | After first replay | After second replay | Match |
|---|---|---|---|
| `events` by type (all 8 rows) | as above | **identical, unchanged** | yes |
| `adm_files` lines | 69,326 | **69,326** | yes |
| `adm_files` complete_files | 1,026 | **1,026** | yes |
| `adm_files` files | 1,026 | **1,026** | yes |

**New lines captured on the second replay: 0.** This is the defect this
plan exists to fix, demonstrated on 69,326 real production lines rather
than a fixture. The mechanism is the cursor, not the `complete` flag:
`ingestFile` never reads `complete` — there is no such branch. For each file
it computes `from = existing.linesIngested` (`ingest.ts:59`), which the first
run had already advanced to that file's total line count, and then skips every
line with `lineIndex < from` (`ingest.ts:76`). The cursor still walked all
69,326 lines — it must, because it is stateful and rolls the date forward on
midnight crossings — but wrote none of them.

## Step 4: full test suite

```bash
export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"
npx turbo run typecheck test --concurrency=1 --force
```

Per-package results (test tasks only; typecheck tasks all passed with no
test counts to report):

| package | test files | tests |
|---|---|---|
| @factions/db | 5 | 37 |
| @factions/ceremony | 1 | 10 |
| @factions/bot | 11 | 147 |
| @factions/domain | 3 | 30 |
| @factions/projector | 1 | 11 |
| @factions/event-log | 2 | 13 |
| @factions/ingest-worker | 8 | 57 |
| @factions/nitrado | 1 | 8 |
| @factions/adm-parser | 8 | 101 |
| @factions/verification | 2 | 15 |

**Total: 429 tests passed, 0 skipped, 0 failed. Turbo: 20 successful, 20
total (0 cached — forced real execution).**

The brief's stated baseline was 378, but noted that earlier tasks in this
plan added packages and tests, so the actual count would be higher — 429 is
the actual observed total and a growth of 69 tests from that baseline
(`@factions/nitrado` is a new package present since an earlier task in this
plan; `@factions/ingest-worker` grew with tick/sweep tests for the
cursor-resume path; `@factions/db` gained the `live-ingest-schema.test.ts`
suite covering the `adm_files` cursor columns).

`stderr` output was observed from `@factions/ingest-worker:test` and
`@factions/bot:test` (e.g. `ingest: download failed for /a.ADM Error: boom`)
and Postgres `NOTICE` lines about schema/table truncation — these are
expected error-path and setup logging asserted by the tests themselves, not
failures. No test was reported failed or skipped.

This run truncated the `factions` database (test suites do it as part of
their setup) — expected, and does not touch `factions_backfill`, which
still holds the full twice-replayed backfill for inspection.

## Not yet accepted: live Nitrado ingestion

- [x] **Live Nitrado tick — PASSED 2026-09-01 against service 19831378 (CW-TEST, livonia).**

      Ran against the real Nitrado API with a real token. Results:

      **Derived offset matches the measured value.** A read-only probe over all
      nine listed files, before anything was written:

      ```
      DayZServer_X1_x64_2026-08-31_17-16-14.ADM  raw_offset=7.0000h
      DayZServer_X1_x64_2026-08-31_17-21-44.ADM  raw_offset=7.0000h
      DayZServer_X1_x64_2026-08-31_17-26-10.ADM  raw_offset=8.1422h
      DayZServer_X1_x64_2026-08-31_19-39-38.ADM  raw_offset=8.3817h
      DayZServer_X1_x64_2026-08-31_21-53-32.ADM  raw_offset=7.0000h
      DayZServer_X1_x64_2026-09-01_00-06-58.ADM  raw_offset=7.0000h
      DayZServer_X1_x64_2026-09-01_02-20-12.ADM  raw_offset=8.2869h
      DayZServer_X1_x64_2026-09-01_04-33-40.ADM  raw_offset=7.0000h
      DayZServer_X1_x64_2026-09-01_06-47-00.ADM  raw_offset=7.0000h

      DERIVED  25200000 ms (7.0000h)   MEASURED 25200000 ms (7.0000h)   MATCH
      ```

      This is the design's model confirmed against production data. Every
      candidate is `trueOffset + writeLag`: the six files showing exactly
      7.0000h are 124 bytes — a boot header and nothing else, never appended
      to — so their mtime IS their creation instant. The three showing
      8.14-8.38h were still being written when they rotated, and the excess is
      pure lag. The minimum is the truth.

      It also demonstrates why retaining the tightest bound matters: had the
      listing contained only the three appended files, the derivation would
      have returned 8.25h, and an implementation that overwrote rather than
      retained would have stamped every subsequent event 1h15m off with every
      count-based check still green.

      **Files listed oldest-first and ingested:** 9 files, 8 marked complete,
      the newest left incomplete. 123 raw lines, 23 events.

      **Timestamps convert correctly.** Local `17:31:51` in the ADM line stored
      as `2026-09-01 00:31:51+00` — +7h across the day boundary. The latest
      event (`04:02:21Z`) agrees with that file's Nitrado mtime (`04:02:32Z`).
      No event is future-dated relative to the wall clock.

      **Second tick ingested nothing new:** raw_lines 123 -> 123, events
      23 -> 23, `clock_offset_ms` unchanged at 25200000. The resume cursor and
      the offset retention both hold.

      **Note on the database.** Real data lives in `factions_live`, not
      `factions`. Eleven test files truncate `servers`, `events` and
      `raw_lines` in `factions`, so ingesting there would have every event
      deleted by the next `pnpm test` run. `docker-compose.yml` and `.env`
      both point at `factions_live`; `TEST_DATABASE_URL` keeps `factions`.

## PASS/FAIL

**PASS.** Every acceptance number from Step 2 matches the expected value
exactly: 69,326 lines replayed, 14/10/4 flag changes, 2,093 emotes, 0
ceremonies, 1,026 `adm_files` rows all complete — unchanged from the three
prior acceptance runs against the same export. Step 3 confirms the cursor
resume path: a second replay against the same, non-recreated database
captured 0 new lines, with `adm_files` and `events` counts identical before
and after. Full suite: 429 tests, 0 skipped, 0 failed, 20/20 turbo tasks,
forced past cache. No discrepancies were found. The one open item is the
live Nitrado gate above, which requires a real service id and token and was
not run.
