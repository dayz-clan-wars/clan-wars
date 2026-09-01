# Live ingest via Nitrado — design

**Date:** 2026-08-31
**Covers:** scheduling the ADM ingest worker so events reach the database continuously
**Builds on:** Plan 1 (ADM ingest, flag events), Plan 3 (ceremony detection, which is unusable without this)
**Mirrors:** the `one-life` production implementation (`apps/ingest-worker`, `packages/nitrado`)

---

## 1. Purpose

`apps/ingest-worker` is a one-shot batch over a local directory. Nothing schedules it, so
events reach the database only when a human runs it by hand.

Plan 3's two-clock rules make every downstream decision *safe* under that lag — nothing expires
or lapses that we never had the chance to observe — but they do not make the product usable. A
ceremony is not detected until its events are ingested. If that takes a day, the founding ritual
simply feels broken to the players who performed it. This is inbox item 9, and it is the gap
between "correct" and "works".

The `one-life` bot solves the same problem in production today. This design ports that
solution rather than inventing a second one.

### In scope

- A `@factions/nitrado` package: list and download ADM files over the Nitrado API
- A continuously-running ingest worker: sweep → per-server tick → resumable file processing
- Resuming mid-file instead of reprocessing whole files
- Deriving each server's clock offset from Nitrado metadata
- Docker and compose artifacts so the worker actually runs somewhere

### Out of scope

- Ingesting anything but ADM files (RPT is a separate pipeline and a separate decision)
- Nitrado ban-list and server-restart APIs — `one-life` needs them for its enforcer and
  rebooter; nothing here does
- Retiring `replay-main.ts`. The historical-export replay stays exactly as it is; it is how
  every acceptance run since Plan 1 has been performed

---

## 2. What the current worker gets wrong

Two defects, both invisible until the cadence gets short.

**It reprocesses everything, every run.** `ingestFile` loops every line of every file and leans
on `onConflictDoNothing` to discard duplicates — one INSERT per line, per run. Against the
production export that is 69,326 inserts that almost entirely conflict. Acceptable once; not
every sixty seconds.

**The cursor already exists and nothing reads it.** `adm_files.lines_ingested` and
`adm_files.complete` are both written (`.set({ linesIngested: opts.lines.length, complete: true })`)
and never read. A file marked complete is still fully reprocessed on the next run. The fix is
smaller than it first appears: read what is already being written.

---

## 3. Decisions

| Decision | Rationale |
|---|---|
| **Port `one-life`'s pattern rather than depend on its package** | Two repos, one credential surface; a shared package would couple their release cycles. The pattern is ~300 lines and its subtleties are documented below. |
| **Take only `listAdmFiles` and `downloadFile`** | `one-life`'s client also carries ban-list and restart methods for its enforcer and rebooter. Nothing here has either. YAGNI. |
| **Derive the clock offset from Nitrado each tick, exactly as `one-life` does** | Self-corrects if a server's timezone changes. `one-life` falls back to the stored value when Nitrado omits `modified_at`. |
| **The worker stops writing server IDENTITY; it still writes the derived offset** | Today `main.ts` upserts the whole server row from env on every run. Once the database decides which servers are swept, that upsert is wrong twice over: it cannot know the `nitrado_service_id`, and re-running it would silently reactivate a server someone deliberately deactivated. Registration moves to a script. The one column the worker continues to write is `clock_offset_ms`, because it derives that value each tick (§5) — identity is declared, the offset is observed. |
| **Keep `replay-main.ts` untouched** | It is the acceptance path for the historical export, and the only way to reproduce every count this project has established. |
| **Hand-rolled config, `console` logging** | `one-life` uses zod and pino. Neither is a dependency here, and `apps/bot/src/config.ts` already establishes this repo's config idiom, including its refusal to accept values `Number()` silently reinterprets. |

### The cold-start zero, and why it is closed here

`one-life`'s offset fallback is `srv?.clockOffsetMs ?? 0`, and a zero offset is the exact silent
failure clan-wars' schema comment warns about — every row lands, every count-based check stays
green, and only the absolute instants are hours wrong.

That hazard does not survive the port. `servers.clock_offset_ms` here is `NOT NULL` with **no
default**, deliberately, so a server row cannot exist without an offset someone stated on
purpose. The `?? 0` branch has nothing to reach.

---

## 4. Schema

Three columns. The cursor infrastructure is already present.

| Table | Column | Why |
|---|---|---|
| `servers` | `nitrado_service_id` | Needed to construct a client for this server |
| `servers` | `active` | The sweep runs over active servers; the database is the source of truth for which |
| `adm_files` | `path` | Nitrado's download path. `filename` stays the identity — its unique index is `(server_id, filename)` — and `path` is how the bytes are fetched |

`adm_files.lines_ingested` (the resume cursor) and `adm_files.complete` already exist and are
already written. This design makes them *read*.

`last_pulled_at` is deliberately omitted: `one-life` carries it and nothing there reads it, and
"is ingest alive" is answerable from `events`.

---

## 5. The worker

Three layers, mirroring `one-life`.

### Loop

`main.ts` becomes long-running: sweep, log, `setTimeout(intervalSeconds)`, repeat, under
`restart: unless-stopped`. Sequential by construction, so no overlap guard is needed — unlike
the bot, which needs `guardedRunner` because a timer fires regardless of whether the last run
finished.

### Sweep

Select `active` servers; run each server's tick inside its own try/catch. One server's Nitrado
failure must not abort the rest of the sweep.

### Tick, per server

1. List ADM files, oldest-first.
2. Derive the clock offset from files with a parseable local timestamp and `modifiedAtMs > 0`,
   and write it back to `servers.clock_offset_ms`. Fall back to the stored value when no
   candidate qualifies. This is the ONLY column of `servers` the worker writes — name, map,
   service id and `active` are declared by the registration script and never touched here.
3. Walk the files oldest-first, with a backfill budget:
   - a `complete` file that is not the newest is skipped;
   - older files consume budget; when it runs out, the remaining ones wait for the next tick;
   - **the newest file is not touched while any older file is still pending.** Ordering matters:
     the live file's timestamps depend on everything before it.
4. Download, ensure the `adm_files` row exists, process from the stored cursor, write back the
   new cursor and `complete` — where `complete` is true only for files that are not the newest.

> ⚠️ `modifiedAtMs > 0` is load-bearing. Nitrado sometimes omits `modified_at`, and the client
> coerces the absence to `0`. Since the derivation picks the MINIMUM
> `(modifiedAtMs - localTimestampMs)` candidate, a zero would win and shift every timestamp by
> decades.

### File processing, and the one thing that must not be got wrong

Resume writes at `lines_ingested`. **Do not resume the timestamp cursor there.**

`TimelineCursor` is stateful: it is seeded with the file's `bootAt` and advanced line by line,
tracking midnight rollovers as it goes. Constructing a fresh cursor at line 5,000 loses every
rollover crossed before it, and every timestamp from that point is hours wrong — silently, in
precisely the manner `clock_offset_ms`'s own comment describes: every row lands, every
count-based acceptance check stays green, and only the instants are wrong.

**The rule: advance the cursor from line 0 over every line; write rows only from
`lines_ingested` onward.** Parsing is in-memory string work and cheap. Database writes are what
the cursor gates.

Two further guards, both ported with their reasoning intact:

- **Pop exactly one trailing empty line before counting.** A file ending in a line terminator
  yields a phantom final element. Count it and the persisted cursor sits one past the real end,
  so every line the live file subsequently gains is skipped forever.
- **Clamp a cursor greater than the line count back to the line count.** The file shrank or
  rotated; never reprocess.

---

## 6. Deployment

A `Dockerfile` mirroring `one-life`'s — `node:20-alpine`, corepack, copy the workspace
manifests plus `packages/` and the app, `pnpm install --frozen-lockfile`, `pnpm start`. No build
step; this repo runs TypeScript through `tsx`.

`docker-compose.yml` gains the worker service (`restart: unless-stopped`, `depends_on` postgres,
`DATABASE_URL`, `NITRADO_TOKEN` from `${NITRADO_TOKEN}`, `INGEST_INTERVAL_SECONDS: "60"`,
`ADM_BACKFILL_BUDGET: "15"`) **and a healthcheck on postgres**, which it currently lacks —
without one, `condition: service_healthy` has nothing to wait on and the worker races the
database on every `compose up`. `.env` is already gitignored.

`scripts/register-server.ts` inserts or updates one server row: name, map, Nitrado service id,
clock offset, active. A manual step, deliberately — the row carries a credential-scoped service
id and an offset the schema refuses to default.

---

## 7. Testing and acceptance

### Unit

The Nitrado client takes an injected `fetchFn`, so a fake serves listings and downloads with no
network: oldest-first ordering, the filename-timestamp regex, the `modified_at ?? 0` coercion,
and the two-step download (the API returns a token URL, not the bytes).

### Resume semantics — the tests that earn their keep

| Test | What it defends |
|---|---|
| **A file whose lines cross midnight, processed partway, then resumed** | The silent failure. A fresh cursor loses the rollover and every later timestamp is hours wrong. The fixture must actually cross midnight or it proves nothing. |
| A grown file ingests only its new lines | The reprocessing defect this design exists to fix |
| A file ending in a newline does not skip the next line it gains | The phantom-empty-line trap |
| A shrunk or rotated file does not reprocess | Cursor clamping |
| Backfill stops at the budget | A cold start must not hammer Nitrado or the database |
| The live file is untouched while older files are pending | Ordering; the live file's timestamps depend on its predecessors |
| One server's failure leaves the others ingested | Sweep isolation |

### Real-data acceptance

Replay the production export through the refactored ingest. It must still yield **69,326 lines,
14 flag changes (10 raises, 4 lowers), 2,093 `emote.performed`, and 0 ceremonies** — the numbers
Plans 1 through 3 established.

This is the check that matters: the cursor refactor is exactly the change that could silently
drop or double lines, and these counts are how that would show. If any of them moves, the
refactor is wrong.

### Gate: live smoke test

Recorded, not assumed, in the manner of Plan 3's staged-ceremony gate:

- [ ] **Live Nitrado tick (REQUIRED before the worker is trusted in production).** Against the
      real service id, run one sweep. Confirm: files listed oldest-first, the derived clock
      offset matches the measured value for that map, events land, and a second tick ingests
      only lines added since the first.

---

## 8. Carried forward

- **RPT ingest** — a separate pipeline `one-life` also runs. Not needed by anything here yet.
- **Multi-server sweep at scale** — the sweep is per-server sequential. One server today, three
  maps eventually; if that grows, the tick is the unit to parallelise.
- **`adm_files.path` versus `filename` as identity** — identity stays `filename` to preserve the
  existing unique index and every row already written. If Nitrado ever serves two files with one
  name under different paths, that assumption needs revisiting.
