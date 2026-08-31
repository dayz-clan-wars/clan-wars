# Acceptance: anchored flag/coordinate parsers against the production export

**Date run:** 2026-08-31

**Change:** `FLAG_CHANGE_RE`, `POLE_AT_RE` and `PLAYER_POS_RE` anchored to the
identity parenthetical (PLAN-3-INBOX item 1). The concern is a regression:
anchoring narrows three patterns that sit on the only raid signal the ADM log
provides, so a silent drop would be invisible without replaying the export.

**Export:** `adm-raw-20260826.log.gz`, replayed into a dedicated
`factions_backfill` database — never the shared test database, which the DB
suites truncate.

## Commands

Identical to `docs/acceptance/2026-08-26-emote-ingest.md`, plus the projector:

```bash
DATABASE_URL="postgres://factions:factions@localhost:5434/factions_backfill" \
  pnpm --filter @factions/ingest-worker exec tsx src/replay-main.ts /path/to/scratch/adm.log
DATABASE_URL="postgres://factions:factions@localhost:5434/factions_backfill" \
  pnpm --filter @factions/projector start
```

Replay summary: `replayed 1026 files, 69326 lines, 3560 skipped (no timestamp
column)` and **`0 flag-shaped lines produced no event`** — the load-bearing
line. Projection: `projected 17622 events, 0 skipped (unknown server), 3 folds
not bound to a pole`.

## Results — actual vs. expected

| Check | Expected | Actual | Match |
|---|---|---|---|
| Total raise + lower events | 14 | **14** | yes |
| Raises | 10 | **10** | yes |
| Lowers | 4 | **4** | yes |
| Distinct flagpoles | 1 | **1** | yes |
| Pole key | `2991.57:447.95:1138.59` | same | yes |
| Distinct textures | Bohemia, DayZ, Livonia | same | yes |
| Current pole state | `Flag_Livonia`, raised | same | yes |
| Clock-offset ground truth row (`2026-07-23T17:21:40Z`) | 1 row | **1 row** | yes |
| `emote.performed` events (unchanged from 2026-08-26) | 2,093 | **2,093** | yes |
| Unbound folds (unchanged) | 3 | **3** | yes |

`pnpm run ci` (forced past the turbo cache): 16/16 tasks green, 93 parser tests.

## What the anchoring rejects

Nine tests added across `test/flag.test.ts` and `test/coords.test.ts`, each
watched failing first — every one of the five flag attacks succeeded before the
fix, including a fully fabricated `flag.raised` built from a `has been
disconnected` line.
