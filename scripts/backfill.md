# Historical backfill

Replays the production ADM export through ingest and projection, then verifies the
result against known quantities from the log survey.

## Register the server first

The ingest worker no longer registers servers itself. It used to upsert a server
row from env vars on every run, which could not know the Nitrado service id and
could silently reactivate a server someone had deliberately deactivated.
Registration is now a deliberate operator step, run once (and again whenever the
service id, clock offset, or active flag changes) before starting the worker:

```bash
DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  pnpm --filter @factions/ingest-worker exec tsx src/register-server.ts \
  --name "Clan Wars Livonia" --map livonia --service-id 1234 --offset-ms 25200000
```

Flags:

| Flag | Meaning |
|---|---|
| `--name` | Server display name. Combined with `--map`, this is the row's unique key — re-running with the same `--name`/`--map` updates the existing row instead of inserting a duplicate. |
| `--map` | Map identifier (e.g. `chernarus`, `livonia`, `sakhal`). |
| `--service-id` | The Nitrado service id this server's ADM files are fetched from. |
| `--offset-ms` | Milliseconds to ADD to this server's local ADM time to get UTC. Has no default — the schema requires it explicitly, because a wrong offset stores every timestamp hours off while every count-based check still stays green. Measured production values: `chernarus` 14400000 (+4h), `livonia` and `sakhal` 25200000 (+7h). |
| `--active` | Defaults to `true`; pass `--active false` to register a server as retired without deleting its row. |

Then start the worker, which only sweeps servers already registered and active.

## Run

```bash
docker compose up -d postgres
export DATABASE_URL="postgres://factions:factions@localhost:5434/factions"

# Truncate this project's working tables only. Never drop the database, and never
# touch tables belonging to other projects.
psql "$DATABASE_URL" -c 'truncate table flag_changes, poles, consumer_cursors, events, raw_lines, adm_files, servers restart identity cascade;'

gzcat /path/to/adm-raw-20260826.log.gz > /tmp/adm-export.log
pnpm --filter @factions/ingest-worker exec tsx src/replay-main.ts /tmp/adm-export.log
pnpm --filter @factions/projector start   # "start" is "tsx src/main.ts"
```

**Why `tsx` and not `node --experimental-strip-types`:** on Node 24,
`--experimental-strip-types` does not rewrite a relative `.js` import specifier to
the sibling `.ts` file it actually resolves to (this project's source uses `.js`
specifiers throughout per its ES module convention), so plain `node` fails with
`ERR_MODULE_NOT_FOUND` on `@factions/db`'s internal imports. Both
`apps/ingest-worker` and `apps/projector` run their entry points through `tsx` (a
workspace-root devDependency), which resolves `.js` specifiers to their `.ts`
files correctly.

`tsx` was chosen over `vite-node` (an earlier workaround) deliberately: `vite-node`
is a transitive dependency of `vitest`, and depending on someone else's transitive
dependency is fragile — a lockfile bump can move or remove it with no direct
signal in this project's own `package.json`. A real `tsc` build step emitting
`dist/*.js` (which plain `node` can run with no loader at all) is the eventual
production answer; that is out of scope here and left as a follow-up.

If a local `psql` client isn't installed on the host, run SQL through the
container instead: `docker exec <postgres-container> psql -U factions -d factions -c "..."`.

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
`CLOCK_OFFSET_MS_BY_MAP` constant in `apps/ingest-worker/src/clock-offsets.ts`). A
backfill run with the offsets all set to `0` would still report every count above
as flawless, while every stored timestamp was 4-7 hours wrong.

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
`clock-offsets.ts` before trusting any of the counts above.
