# Acceptance: per-package test database isolation (inbox item 21)

**Date run:** 2026-09-02

**Change under test:** `requireTestDatabaseUrl()` now treats `TEST_DATABASE_URL` as a
**base** — host, port and credentials only — and derives one database per workspace
package (`factions_test_bot`, `factions_test_ingest_worker`, …). A shared vitest
`globalSetup` (`packages/db/src/test-setup.ts`) creates that database; the suites'
existing `runMigrations` calls bring its schema up. No test file changed, and no
`truncate` was removed: sharing a namespace was the bug, not the truncations.

This is the kind of change that can look green while doing nothing, because every suite
still passes when it has a database to itself. So acceptance requires three things a
broken version could not produce: the recursive run passing, the previously-failing apps
passing *within* it, and evidence that the shared database is no longer touched at all.

## 1. The turbo gate

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx turbo run typecheck test --concurrency=1 --force
```

```
 Tasks:    20 successful, 20 total
Cached:    0 cached, 20 total
  Time:    49.697s
```

20 of 20, uncached. Unchanged from before the change, as it had to be — the gate already
worked, because `--concurrency=1` serialises the packages.

## 2. `pnpm -r test` — the run that could never be trusted

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -r test
```

```
EXIT=0
```

Every package passing in one recursive run, including the two the item names:

| Package | Files | Tests |
|---|---|---|
| `packages/domain` | 4 | 36 |
| `packages/ceremony` | 1 | 10 |
| `packages/nitrado` | 1 | 24 |
| `packages/verification` | 2 | 15 |
| `packages/adm-parser` | 8 | 101 |
| `packages/db` | 10 | 56 |
| `packages/event-log` | 2 | 13 |
| **`apps/ingest-worker`** | **11** | **113** |
| **`apps/projector`** | **1** | **11** |
| `apps/bot` | 26 | 456 |

The `apps/ingest-worker` output contains `startTests` stack fragments and lines like
`ingest: download failed for /a.ADM Error: boom`. Those are the suite's own
`console.error` calls from the tests that exercise the download-failure and
missing-header paths — deliberate output, not failures. `Test Files 11 passed`.

## 3. The shared database is no longer written to

The strongest available evidence, since "no two suites share a namespace" is otherwise a
claim about absence. A canary row was inserted into the shared `factions` database and a
full forced test run performed against it:

```bash
docker exec clan-wars-postgres-1 psql -U factions -d factions -X \
  -c "insert into servers (name, map, clock_offset_ms) values ('CANARY-item-21','chernarus',0)"
# canary before: 1

TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx turbo run test --concurrency=1 --force
# 10 of 10 tasks, 0 cached, 42.6s

# canary after:  1
```

Before this change the row would have been destroyed by the first suite to `truncate
servers`. The canary was deleted afterwards.

Databases present after the run:

```
factions_test_bot
factions_test_db
factions_test_event_log
factions_test_ingest_worker
factions_test_projector
```

## 4. `TEST_DATABASE_FRESH=1` really drops and recreates

The only `DROP DATABASE` in the repository, so it is exercised rather than assumed. A
canary **table** was created in `factions_test_event_log` and the suite re-run with the
flag set:

```
before: 1     # pg_tables count for canary_should_vanish
 Test Files  2 passed (2)
      Tests  13 passed (13)
after:  0
```

The database was dropped, recreated, migrated by the suite's own `runMigrations`, and
the tests passed against the fresh schema.

## What this does not prove

- **Vitest's file-ordering sensitivity is gone by construction, not by measurement.**
  The item notes the failure set moved with vitest's size-based file ordering. Nothing
  here reorders files deliberately to confirm the sensitivity has gone; the argument is
  structural — two suites can no longer observe each other's tables.
- **Concurrency between packages is now safe, but only lightly exercised.** `pnpm -r`
  runs packages in parallel and passed. The `duplicate_database` (42P04) race in
  `test-setup.ts` is handled and reasoned about, but was not forced.
- **Nothing about production.** No migration, no schema change, and `factions_live` was
  not touched.
