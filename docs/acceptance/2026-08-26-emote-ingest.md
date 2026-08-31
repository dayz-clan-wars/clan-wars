# Acceptance: emote ingest against the production export

**Date run:** 2026-08-26 (executed 2026-08-27)

**Export:** `adm-raw-20260826.log.gz` (72,885 lines gzipped; 69,326 lines after decompression, matching the header/footer overhead of 1,026 per-file boundaries in the export). Decompressed to a scratch path outside the repo and never committed.

## Commands used

```bash
# Database already existed for this task; verified rather than recreated.
docker compose exec -T postgres psql -U factions -d postgres -c "CREATE DATABASE factions_backfill;" || true

# Migrations: `tsx -e` fails on top-level await in this setup, so a temporary
# .mts file was written inside packages/db/, run, then deleted.
cat > packages/db/tmp-migrate-backfill.mts <<'EOF'
import { createClient, runMigrations } from './src/index.js';
const client = createClient(process.env.DATABASE_URL!);
await runMigrations(client);
process.exit(0);
EOF
export BACKFILL_URL="postgres://factions:factions@localhost:5434/factions_backfill"
DATABASE_URL="$BACKFILL_URL" pnpm --filter @factions/db exec tsx tmp-migrate-backfill.mts
rm packages/db/tmp-migrate-backfill.mts

# Clean slate before replay
docker compose exec -T postgres psql -U factions -d factions_backfill -c \
  "TRUNCATE TABLE adm_files, challenge_attempts, consumer_cursors, events, flag_changes, identity_links, poles, raw_lines, servers, verification_challenges RESTART IDENTITY CASCADE;"

# Decompress export to scratch (never committed)
gunzip -k -c adm-raw-20260826.log.gz > /path/to/scratch/adm.log

# Replay. NOTE: replay-main.ts derives the per-map clock offset itself via
# clockOffsetMsFor(group.map) — CLOCK_OFFSET_MS is not read here and was not set.
DATABASE_URL="$BACKFILL_URL" pnpm --filter @factions/ingest-worker exec tsx src/replay-main.ts /path/to/scratch/adm.log

# Verification queries
docker compose exec -T postgres psql -U factions -d factions_backfill -c \
  "select type, count(*) from events group by type order by 2 desc;"
docker compose exec -T postgres psql -U factions -d factions_backfill -c \
  "select payload->>'emote' as emote, count(*) from events where type='emote.performed' group by 1 order by 2 desc;"
docker compose exec -T postgres psql -U factions -d factions_backfill -c \
  "select count(*) from events where type='emote.performed' and payload->>'dayzId' is null;"
docker compose exec -T postgres psql -U factions -d factions_backfill -c \
  "select count(*) from events where type='emote.performed' and payload ? 'pos';"
docker compose exec -T postgres psql -U factions -d factions_backfill -t -A -c \
  "select distinct payload->>'emote' from events where type='emote.performed' order by 1;"

# Full suite
export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"
pnpm run ci
```

Replay summary output: `replayed 1026 files, 69326 lines, 3560 skipped (no timestamp column)` and `0 flag-shaped lines produced no event`.

## Results — actual vs. expected

| Check | Expected | Actual | Match |
|---|---|---|---|
| `emote.performed` events | 2,093 | **2,093** | yes |
| Distinct emote tokens | 35 | **35** | yes |
| `EmoteSitA` count | 1,611 | **1,611** | yes |
| Emote events with null/missing `dayzId` | 0 | **0** | yes |
| Emote events whose payload contains `pos` | 0 | **0** | yes |
| `flag.raised` + `flag.lowered` total | 14 (10 raised, 4 lowered) | **14 (10 raised, 4 lowered)** | yes |
| `flagpole.*` events | 15 | **15** | yes |
| `player.position` events | 15,500 | **15,500** | yes |

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

## Distinct emote token census (35 tokens, 2,093 total)

| token | count |
|---|---|
| EmoteSitA | 1,611 |
| EmoteSuicide | 143 |
| EmoteCampfireSit | 48 |
| EmoteGreeting | 29 |
| EmoteClap | 28 |
| EmoteTaunt | 28 |
| EmoteSurrender | 21 |
| EmotePoint | 18 |
| EmoteTauntElbow | 13 |
| EmoteLyingDown | 13 |
| EmoteHeart | 12 |
| EmotePointSelf | 11 |
| EmoteDance | 11 |
| EmoteShrug | 10 |
| EmoteRPSRandom | 10 |
| EmoteThroat | 9 |
| EmoteSalute | 8 |
| EmoteLookAtMe | 8 |
| EmoteCome | 8 |
| EmoteWatching | 8 |
| EmoteSilent | 5 |
| EmoteThumb | 5 |
| EmoteShake | 5 |
| EmoteTauntKiss | 5 |
| EmoteMove | 5 |
| EmoteFacepalm | 4 |
| EmoteSOS | 3 |
| EmoteVomit | 3 |
| EmoteTimeout | 3 |
| EmoteThumbDown | 2 |
| EmoteListening | 2 |
| EmoteNod | 1 |
| EmoteHold | 1 |
| EmoteSitB | 1 |
| EmoteTauntThink | 1 |

Every one of these 35 tokens was confirmed present in `EMOTE_DICTIONARY` (`packages/domain/src/emotes.ts`) by diffing the observed token set against the dictionary's `token` fields — zero tokens missing. The census is not stale.

## Full test suite

```bash
export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"
pnpm run ci
```

Per-package results:

| package | test files | tests |
|---|---|---|
| @factions/projector | 1 | 11 |
| @factions/db | 2 | 12 |
| @factions/ingest-worker | 3 | 20 |
| @factions/verification | 2 | 15 |
| @factions/event-log | 2 | 13 |
| @factions/bot | 5 | 66 |
| @factions/adm-parser | 8 | 84 |
| @factions/domain | 2 | 13 |

**Total: 234 tests passed, 0 skipped, 0 failed. Turbo: 16 successful, 16 total.**

This run truncated the `factions` database (test suites do it as part of their setup) — expected and does not touch `factions_backfill`.

## PASS/FAIL

**PASS.** Every acceptance number matches the expected value exactly. The flag/flagpole regression check (14 flag changes, 15 flagpole events) confirms the Task 2 `parseLine` branch addition did not disturb existing parsing. All 35 observed emote tokens are present in `EMOTE_DICTIONARY`. Full suite: 234 tests, 0 skipped, 0 failed.
