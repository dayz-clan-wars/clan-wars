# Historical backfill

Replays the production ADM export through ingest and projection, then verifies the
result against known quantities from the log survey.

## Run

```bash
docker compose up -d postgres
export DATABASE_URL="postgres://factions:factions@localhost:5434/factions"

# Truncate this project's working tables only. Never drop the database, and never
# touch tables belonging to other projects.
psql "$DATABASE_URL" -c 'truncate table flag_changes, poles, consumer_cursors, events, raw_lines, adm_files, servers restart identity cascade;'

gzcat /path/to/adm-raw-20260826.log.gz > /tmp/adm-export.log
pnpm --filter @factions/ingest-worker exec node --experimental-strip-types \
  src/replay-main.ts /tmp/adm-export.log
pnpm --filter @factions/projector start
```

**Note:** on Node 24, `--experimental-strip-types` does not rewrite a relative `.js`
import specifier to the sibling `.ts` file it actually resolves to (this project's
source uses `.js` specifiers throughout per its ES module convention), so the
commands above currently fail with `ERR_MODULE_NOT_FOUND` for `@factions/db`'s
internal imports. Until that's addressed, run both entry points through `vite-node`
(already present transitively via `vitest`) instead of plain `node`, and use
`docker exec <postgres-container> psql -U factions -d factions` in place of a local
`psql` client if one isn't installed on the host:

```bash
VITE_NODE=./node_modules/.pnpm/vite-node@2.1.9_@types+node@22.20.1/node_modules/vite-node/vite-node.mjs
(cd apps/ingest-worker && node "../../$VITE_NODE" src/replay-main.ts /tmp/adm-export.log)
(cd apps/projector && node "../../$VITE_NODE" src/main.ts)
```

## Expected results

The survey of this export established the following. Any deviation is a defect.

| Check | Expected |
|---|---|
| Distinct flagpoles with raise/lower events | 1 |
| Total raise + lower events | 14 |
| Raises | 10 |
| Lowers | 4 |
| Distinct textures | 3 — `Flag_Livonia`, `Flag_DayZ`, `Flag_Bohemia` |
| Pole key | `2991.57:447.95:1138.59` |

## Verify

```sql
select count(*) from flag_changes;                       -- 14
select action, count(*) from flag_changes group by action; -- raised 10, lowered 4
select count(distinct pole_key) from flag_changes;       -- 1
select distinct texture from flag_changes order by 1;    -- Bohemia, DayZ, Livonia
select pole_key, current_texture, flag_raised from poles; -- 2991.57:447.95:1138.59
```

## Verify the clock offset (not just counts)

Counts alone cannot detect a wrong per-server clock offset: DayZ ADM logs record
server-local wall-clock time, not UTC, and each of the three maps in this export
runs on a different clock (`chernarus` +4h, `livonia` +7h, `sakhal` +7h — see the
`CLOCK_OFFSET_MS_BY_MAP` constant in `apps/ingest-worker/src/replay-main.ts`). A
backfill run with the offsets left at the default `0` would still report all the
counts above as flawless, while every stored timestamp was 4-7 hours wrong.

Ground truth line from the export (Livonia, +7h):

```
[Livonia] 2026-07-23T17:21:40Z  DayZServer_X1_x64_2026-07-23_09-01-42.ADM:151  |  10:21:40 | Player "XxBE4zyxX" (id=D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1 pos=<2990.4, 1138.3, 448.0>) has raised Flag_Livonia on TerritoryFlag at <2991.569092, 447.946503, 1138.587646>
```

The ADM line reads `10:21:40` server-local; the export's own authoritative UTC
instant for this line is `2026-07-23T17:21:40Z`. Check that the corresponding
`flag_changes` row was stored with exactly that instant:

```sql
select occurred_at
from flag_changes
where action = 'raised'
  and occurred_at = '2026-07-23T17:21:40Z';
-- expect exactly 1 row
```

If this query returns zero rows (or the row exists but at a different, shifted
timestamp), the clock offset is wrong — go check `CLOCK_OFFSET_MS_BY_MAP` in
`replay-main.ts` before trusting any of the counts above.
