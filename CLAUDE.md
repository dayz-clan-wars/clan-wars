# Clan Wars — working notes for Claude

A Discord bot and log-ingest pipeline for a DayZ server. Players link their Discord
account to their in-game character, found factions by ritual at a flagpole, and hold
territory. The bot writes faction state; a worker ingests the game server's ADM logs
and projects supply spawns back onto the server through Nitrado's API.

pnpm workspace + turbo. TypeScript, vitest, drizzle-orm over postgres.js, discord.js.

---

## ⚠️ Read this before touching anything

**`factions_live` is production. `factions` is the test database.** Both live on the
same Postgres, port 5434. A dozen test files `truncate` `events`, `factions`,
`verification_challenges` and friends in `factions`, so a process pointed at the wrong
one loses real player data on the next `pnpm test`. Every DB-backed suite needs:

    TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"

**Port 5434 only.** 5432 and 5433 belong to other projects on this machine — never
stop, remove, or repoint their containers.

**The full gate, and always with `--force`:**

    TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
      npx turbo run typecheck test --concurrency=1 --force

Expect **20/20 tasks**. A cached pass proves nothing; check the count, not the exit code.
`pnpm -r test` is NOT a trustworthy gate — every app shares the one test database and
truncates shared tables underneath its neighbours (inbox item 21). Per-package runs and
the turbo gate are what do the real work.

---

## Running things

- **Postgres + ingest worker:** `docker compose up -d` (reads `.env`). The worker
  runs from a built image, so a code change needs `docker compose build ingest-worker`.
- **Bot:** not containerised. `set -a && . .env && set +a && pnpm --filter @factions/bot start`.
  It needs the env sourced; `nohup … > bot.log 2>&1 &` if you want it detached.
- **⚠️ Exactly one bot instance may run.** `notifyCompleted` DMs before it marks, which
  is right for one process and at-least-once across two — we shipped a duplicate DM to a
  real player this way on 2026-09-01. Before starting one, confirm zero survivors:
  `ps ax | grep "src/main.ts" | grep -v grep`. Kill with `pkill -f "src/main.ts"` —
  a pattern that does not match the expanded `tsx` command line is what left the stale
  process last time.
- **⚠️ Nothing applies migrations in production.** `runMigrations` is exported from
  `packages/db/src/migrate.ts` but is called *only from tests* — `apps/bot/src` never
  calls it, and there is no `db:migrate` script. A deploy that assumes "the bot migrates
  at startup" starts a bot whose queries reference columns the live database does not
  have; on 2026-09-02 that produced a `dormancy tick failed … column "dormant_since"
  does not exist` loop until `0015` was applied by hand. Apply migrations deliberately,
  as a step of their own, before starting the new code — see
  `docs/deploy/2026-09-02-dormancy.md` for the one-off runner that does it safely.
  Generate with `cd packages/db && npx drizzle-kit generate`, and **read the generated
  SQL** before letting it near `factions_live`.
- **⚠️ Stop the bot before migrating** when a migration adds NOT NULL columns or
  constraints. Old code + new schema and new code + old schema both break; see
  `docs/deploy/2026-09-01-targeted-linking.md` for the incident.

---

## Where things live

| What | Where |
|---|---|
| Designs (the authority) | `docs/superpowers/specs/` |
| Implementation plans | `docs/superpowers/plans/` |
| **The running to-do list** | `docs/superpowers/plans/PLAN-3-INBOX.md` |
| Deploy runbooks | `docs/deploy/` |
| Acceptance records | `docs/acceptance/` |
| Bot operational notes | `apps/bot/README.md` |

`PLAN-3-INBOX.md` is the backlog. Items are numbered, struck through when done with a
date and commit. Read it before proposing work — several entries record hazards that are
deliberately unfixed, and at least two record reasoning that later turned out to be
wrong (see item 23).

---

## Conventions that matter here

**Comments explain WHY, not what.** Where a line is load-bearing — where getting it
wrong causes a *silent* failure — say what breaks. `⚠️` marks those. This is the house
style and code review enforces it. Match the density of the file you are editing.

**Prefer a failing test over a defensive default.** Several guards here exist because
the alternative was an operation that succeeded while doing nothing useful: an upload
into a directory the server never reads, a hash that advances on a failed write, a
challenge that can never be completed.

**Two statements of one fact will drift.** Where a constant is mirrored somewhere the
compiler cannot see — a SQL index predicate, an env var, a message that names a number —
there should be a test that fails when they disagree. See
`packages/db/test/holding-index-drift.test.ts`.

---

## Invariants worth knowing before you change them

- **`HOLDING_STATUSES` (`reserved, active, dormant`) means identity — holds flag, tag
  and pole — and nothing else.** It is mirrored by three partial unique indexes in SQL.
  Do not narrow it to change behaviour; add a set. `SUPPLIED_STATUSES` (`reserved,
  active`) is the one that governs supply kits.
- **Lock order for the roster tables: `factions` → `faction_members` → `faction_invites`.**
  A deadlock was already built once from two separately-correct changes taking two of
  them in opposite orders. There are three writers now.
- **The emote budget (`MAX_POOL_EMOTES_PER_ATTEMPT`) is the primary defence** against a
  `/link` target completing its own sequence by accident. Do not exempt in-sequence
  emotes from it — an accidental completion is *made* of in-sequence emotes.
- **`flag_changes` holds zero rows in `factions_live`.** The projector that fills it does
  not run there. Read the `events` log directly, as `ceremony-tick` and the dormancy
  clock do.
- **Pole coordinates are a raid target.** They are gated to faction members in
  `/faction info` and kept out of DMs. Every Discord command reply is ephemeral
  (`RosterReply.ephemeral` is the literal `true`, so a public one will not compile).
- **The dormancy clock's raise lookup depends on `events_raise_lookup_idx`** — a partial
  index over `(server_id, payload->>'poleKey', payload->>'texture', occurred_at)` where
  `type = 'flag.raised'`. Without it the subquery filters every `flag.raised` row on the
  server once per faction per tick (352ms vs 0.41ms at a year of projected ingest), and
  nothing errors — `guardedRunner` just skips overlapping runs, so the clock silently
  stops keeping up. The index's payload keys and the query's are two statements of one
  fact; `apps/bot/test/dormancy-index-drift.test.ts` holds them together. Do not
  "simplify" it to `(server_id, occurred_at)`: that form is *worse than no index* for a
  faction that has not raised in months, which is the only kind dormancy cares about.
- **The supply spawner file is a projection of the factions table.** The worker
  regenerates it every sweep, hashes it, and uploads only on a change. The hash advances
  only on a successful upload. Nothing coordinates the bot and the worker — status is
  the whole interface.
- **The supply file's drift baseline is OBSERVED, never computed.** `supply_uploads`
  stores the `size` and `modified_at` the game server itself reported right after our
  upload, and the quiet path compares against those. Do not "simplify" it to compare the
  remote mtime with `uploaded_at` — they match today, but `modified_at` is the game
  server's clock (fixed UTC+4/+7, the same fact `listAdmFiles` works around), and any
  offset makes every tick see drift and re-upload forever. Both size and mtime are
  compared because neither subsumes the other: mtime catches a same-length edit, size
  catches a restore that preserved timestamps.

---

## Current state — 2026-09-02

Faction dormancy is **deployed**. A faction that does not raise its own flag at its own
pole for 7 days goes dormant and loses its supply kit; 14 further days disband it. Spec
and plan are in `docs/superpowers/`.

Live as of 2026-09-02: migrations `0015`, `0016` and `0017` applied to `factions_live`
(18 of 18 journal entries), the bot restarted on the dormancy code as a single instance, and the
ingest worker rebuilt and recreated. The acceptance check was run before and after —
one active faction (`COK`), last flag raise ~21h ago, `dormant_since` still null, so the
first tick transitioned nothing, which is what it had to do. Runbook:
`docs/deploy/2026-09-02-dormancy.md`.

The read-only acceptance check, to re-run before any future dormancy change:

    docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c "
      select f.tag, f.status, f.dormant_since,
             now() - coalesce((select max(e.occurred_at) from events e
               where e.type='flag.raised' and e.server_id=f.server_id
                 and e.payload->>'poleKey'=f.pole_key
                 and e.payload->>'texture'=f.texture),
               f.activated_at, f.created_at) as age
      from factions f where f.status in ('active','dormant')"

Any row with `age` over 7 days will be made dormant on the next tick, cutting a real
faction's supplies. That is a decision, not a side effect.

### Known-open, in rough priority order

1. **Inbox item 21** — test-database isolation. Until this is fixed, `pnpm -r test`
   cannot be trusted as a gate.
2. Three residual gaps in dormancy, all recorded in the inbox: an outage can poison a
   `dormant_since` stamped during it; withheld disbands are silent (no counter); a
   genuinely dead server never releases its flags.
3. `/faction roster` still lists any named faction's members to anyone. Deliberate per
   spec §6, but worth revisiting alongside the pole gating.
4. `packages/domain/src/emotes.ts` claims every safe token "has been performed by a real
   player completing a real `/link` in production". That is not true — about ten of the
   24 have ever appeared in live data. A player was blocked by `EmoteMove` on
   2026-09-01.
5. A stale 30KB `flag-supplies.json` sits beside ours in the server's mission `custom/`
   directory. `cfggameplay.json` does not load it; it is only confusing.
