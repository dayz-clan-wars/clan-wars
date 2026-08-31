# Acceptance: ceremony detection against the production export

**Date run:** 2026-08-31

**Change under test:** the ceremony detector (`packages/ceremony`,
`apps/bot/src/ceremony-store.ts`, `apps/bot/src/ceremony-tick.ts`) — the
raise-only, White-texture, linked-only qualifying predicate; window
settling; `white_raises` / `ceremonies` / `ceremony_participants` recording;
and the faction-claim reservation/activation path it feeds.

**The question this run answers:** does the detector invent ceremonies out
of five weeks of real production ADM data that contains no White-flag
raises at all? A non-zero ceremony count would mean the detector hands out
identities from the 33-slot scarce pool to nobody, which is the dangerous
failure direction — false positives, not false negatives.

**Export:** `adm-raw-20260826.log.gz` (72,885 lines gzipped; 69,326 lines
after decompression, matching the header/footer overhead of 1,026 per-file
boundaries in the export — same file and same numbers as
`docs/acceptance/2026-08-26-emote-ingest.md` and
`docs/acceptance/2026-08-31-flag-injection-fix.md`). Lives at
`/Users/steveharmeyer/Development/dayz-one-life/adm-raw-20260826.log.gz`,
outside this repo. Decompressed to `/private/tmp/ceremony-acceptance/adm.log`,
a scratch path outside the repo, and never committed.

**Database:** `factions_backfill` on the already-running `clan-wars-postgres-1`
container (port 5434) — a scratch database, dropped and recreated for this
run. The shared `factions` database (used by the test suites, which truncate
it) was never touched by the backfill.

**Note on `CLOCK_OFFSET_MS`:** the task brief for this step describes
`replay-main.ts` as requiring a `CLOCK_OFFSET_MS` environment variable with
no default. Reading the current `apps/ingest-worker/src/replay-main.ts`
shows this is no longer accurate: it derives the per-map clock offset itself
via `clockOffsetMsFor(group.map)` (`apps/ingest-worker/src/clock-offsets.ts`),
and does not read `CLOCK_OFFSET_MS` from the environment at all. This matches
the note already recorded in `docs/acceptance/2026-08-26-emote-ingest.md`.
No `CLOCK_OFFSET_MS` was set for this run, and none was needed.

## Commands used

```bash
# Step 1: fresh backfill database
docker compose exec -T postgres psql -U factions -d postgres -c "DROP DATABASE IF EXISTS factions_backfill;"
docker compose exec -T postgres psql -U factions -d postgres -c "CREATE DATABASE factions_backfill;"

# Decompress export to scratch (never committed)
mkdir -p /private/tmp/ceremony-acceptance
gunzip -k -c /Users/steveharmeyer/Development/dayz-one-life/adm-raw-20260826.log.gz \
  > /private/tmp/ceremony-acceptance/adm.log

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

# Replay
DATABASE_URL="$BACKFILL_URL" pnpm --filter @factions/ingest-worker exec tsx \
  src/replay-main.ts /private/tmp/ceremony-acceptance/adm.log

# Step 2: run the ceremony detector over the whole backfill
# (same top-level-await workaround as the migration step)
cat > apps/bot/tmp-ceremony-tick.mts <<'EOF'
import { createClient } from '@factions/db';
import { PgCeremonyStore } from './src/ceremony-store.js';
import { ceremonyTick } from './src/ceremony-tick.js';
const db = createClient(process.env.DATABASE_URL!);
console.log(await ceremonyTick(db, new PgCeremonyStore(db), { batchSize: 1000 }));
process.exit(0);
EOF
DATABASE_URL="$BACKFILL_URL" pnpm --filter @factions/bot exec tsx tmp-ceremony-tick.mts
rm apps/bot/tmp-ceremony-tick.mts

# Step 3: verification queries
docker compose exec -T postgres psql -U factions -d factions_backfill -c \
  "select count(*) as ceremonies from ceremonies;"
docker compose exec -T postgres psql -U factions -d factions_backfill -c \
  "select count(*) as white_raises from white_raises;"
docker compose exec -T postgres psql -U factions -d factions_backfill -c \
  "select type, count(*) from events group by type order by 2 desc;"
docker compose exec -T postgres psql -U factions -d factions_backfill -c \
  "select payload->>'action' as action, count(*) from events where type in ('flag.raised','flag.lowered') group by 1;"

# Step 4: full suite (against the shared factions test database, not the backfill)
export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"
npx turbo run typecheck test --concurrency=1 --force
```

`pnpm run ci` was tried first; it reported `18 successful, 18 total` but
`18 cached, 18 total` — a pure cache hit, not a real re-execution, so it
could not be trusted to show the current branch's actual state. `npx turbo
run typecheck test --concurrency=1 --force` was used instead to force real
execution (turbo's own `--force`, not a script-level flag — passing `--force`
through `pnpm run ci -- --force` fails, because it gets forwarded into each
package's `tsc --noEmit --force`, which `tsc` rejects).

Replay summary output: `replayed 1026 files, 69326 lines, 3560 skipped (no
timestamp column)` and `0 flag-shaped lines produced no event`.

Ceremony tick result:

```
{
  scanned: 10,
  recorded: 0,
  settled: 0,
  detected: 0,
  activated: 0,
  lapsed: 0
}
```

`scanned: 10` is exactly the 10 `flag.raised` events in the export (see
below) — every one of them was examined and none qualified, because none
carried the neutral `White` texture.

## Results — actual vs. expected

| Check | Expected | Actual | Match |
|---|---|---|---|
| Ceremonies detected (`select count(*) from ceremonies`) | 0 | **0** | yes |
| `white_raises` recorded | 0 | **0** | yes |
| Flag changes (raise + lower) | 14 | **14** | yes |
| Flag raises | 10 | **10** | yes |
| Flag lowers | 4 | **4** | yes |
| `emote.performed` | 2,093 | **2,093** | yes |

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

These match `docs/acceptance/2026-08-26-emote-ingest.md` and
`docs/acceptance/2026-08-31-flag-injection-fix.md` exactly, confirming the
parser and projector were not disturbed by this branch's changes.

**Zero confirmed.** The export contains no `Flag_White` raises across
69,326 lines and five weeks of real production play. The detector scanned
all 10 raise events, qualified none of them, recorded zero `white_raises`,
settled zero windows, and detected zero ceremonies. This is the genuine
false-positive check the plan asked for, and it passed: the detector did
not invent a founding ritual out of ordinary flag activity, and it did not
hand out any of the 33 scarce faction identities to nobody.

## Full test suite

```bash
export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"
npx turbo run typecheck test --concurrency=1 --force
```

Per-package results (test tasks only; typecheck tasks all passed with no
test counts to report):

| package | test files | tests |
|---|---|---|
| @factions/projector | 1 | 11 |
| @factions/ingest-worker | 3 | 20 |
| @factions/db | 4 | 31 |
| @factions/domain | 3 | 30 |
| @factions/event-log | 2 | 13 |
| @factions/bot | 11 | 136 |
| @factions/adm-parser | 8 | 94 |
| @factions/ceremony | 1 | 10 |
| @factions/verification | 2 | 15 |

**Total: 360 tests passed, 0 skipped, 0 failed. Turbo: 18 successful, 18
total (0 cached — forced real execution).**

This matches the brief's expected total of 360 exactly, and is a growth of
105 tests from the prior acceptance baseline of 255 (`@factions/db` grew
from 12 to 31 by adding the ceremony/faction schema tests; `@factions/domain`
grew from 13 to 30; `@factions/bot` grew from 66 to 136 with the new
ceremony/claim command tests; a new `@factions/ceremony` package added 10).

This run truncated the `factions` database (test suites do it as part of
their setup) — expected, and does not touch `factions_backfill`, which
still holds the full replayed and detected backfill for inspection.

## Not yet accepted: a real ceremony

No human has ever performed a ceremony that this detector observed. Every
ceremony fixture in the test suite (`packages/ceremony/test/windows.test.ts`,
and the ceremony-related fixtures in `apps/bot/test/`) encodes an assumption
about what a real ceremony looks like on the wire: that three or more linked
players will each raise `Flag_White` at the same pole within the settling
window, that the ADM lines will be shaped the way the parser and the
adversarial-fixture guard expect, and that the ordering and timing observed
in a lab-authored fixture will match what actually happens when real players
attempt this in game. This acceptance run is strong evidence against false
positives — the detector does not hallucinate ceremonies out of ordinary
play — but it says nothing about whether the detector correctly recognizes
a real one, because the five-week export contains zero examples to test
that against. The gate below is the outstanding item that closes this gap,
and it has not been run.

- [ ] **Staged ceremony (REQUIRED before the detector is trusted in production).** Three or more linked players stand at a pole flying Flag_White and each raise it within ten minutes. Ingest that day's ADM. Confirm: one ceremony detected, the participant list matches who was actually there, and every participant received the DM. Record the ADM line excerpts here.

## PASS/FAIL

**PASS.** Every acceptance number matches the expected value exactly:
0 ceremonies, 0 white_raises, 14/10/4 flag changes (unchanged from Plan 1),
2,093 emotes (unchanged from Plan 2). Full suite: 360 tests, 0 skipped,
0 failed, 18/18 turbo tasks, forced past cache. No discrepancies were
found. The one open item is the staged-ceremony gate above, which requires
a real human-performed ceremony and cannot be satisfied by replaying this
export.
