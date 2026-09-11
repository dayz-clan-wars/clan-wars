# Clan Wars — working notes for Claude

A Discord bot and log-ingest pipeline for a DayZ server. Players link their Discord
account to their in-game character, found factions by ritual at a flagpole, and hold
territory. The bot writes faction state; a worker ingests the game server's ADM logs
and projects supply spawns back onto the server through Nitrado's API.

pnpm workspace + turbo. TypeScript, vitest, drizzle-orm over postgres.js, discord.js.

---

## ⚠️ Read this before touching anything

**`factions_live` is production.** It lives on the same Postgres as everything else,
port 5434. Nothing but a deliberate migration step or a read-only check should ever
point at it.

**Migration 0020 drops columns the running bot selects.** Stop `clan-wars-bot` before
applying it; see `docs/deploy/2026-09-05-declarations.md`.

**`TEST_DATABASE_URL` is a BASE URL, not a target.** Since 2026-09-02 (inbox item 21)
only its host, port and credentials are used; the database it names is discarded, and
each package derives its own `factions_test_<package>` — created by a shared vitest
`globalSetup`, migrated by the suites themselves. Set it to:

    TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"

⚠️ Do **not** try to aim a suite at a particular database by editing that URL; it has no
effect, by design. That is what makes a typo unable to truncate live player data any
more. `TEST_DATABASE_FRESH=1` drops and recreates a package's database — the right
response to *editing* a migration rather than adding one.

⚠️ **0023 was hand-edited on this branch** (`clan_notices_dm_has_target`,
`raids.last_lower_event_id`) after it was first generated. A `factions_test_<package>`
created before that edit carries the stale 0023 and will not pick up the fix — drop it
once so the migration re-applies. `TEST_DATABASE_FRESH=1` does not help through
`turbo run test`: `turbo.json`'s `test` task only declares `TEST_DATABASE_URL` and
`DATABASE_URL` in its `env`, so `TEST_DATABASE_FRESH` does not reach the child process.
Run the affected package's `vitest` directly with `TEST_DATABASE_FRESH=1` set, or drop
the specific `factions_test_<package>` database by hand — never touch `factions_live`.

**Port 5434 only.** 5432 and 5433 belong to other projects on this machine — never
stop, remove, or repoint their containers.

**The full gate, and always with `--force`:**

    TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
      npx turbo run typecheck test --concurrency=1 --force

Expect **26/26 tasks** (`packages/roster` and `packages/declarations` each add `typecheck` and `test`). A cached pass
proves nothing; check the count, not the exit code.
`pnpm -r test` also passes now and exits 0, which it never did before isolation — but the
turbo gate stays the gate, because it runs `typecheck` too.

---

## Running things

- **Postgres + ingest worker:** `docker compose up -d postgres ingest-worker` (reads
  `.env`). The worker runs from a built image, so a code change needs
  `docker compose build ingest-worker`. ⚠️ Name the services — a bare `up -d` also
  starts `web`.
- **Bot:** not containerised. `set -a && . ./.env && set +a && pnpm --filter @factions/bot start`.
  It needs the env sourced; `nohup … > bot.log 2>&1 &` if you want it detached. Use
  `. ./.env`, not `. .env` — in zsh, `.` searches `$PATH` for a slashless name and fails
  with `no such file or directory: .env`.
  Since 3a, `discord.ts`'s `start()` also runs `raid-tick.ts` and `raise-tick.ts` each
  interval, right after presence and before verification/dormancy — every
  `flag.lowered`/`flag.raised` that scores a raid, records a defense, revives a dormant
  clan, or notices a non-member raise/colors-elsewhere/rebind proposal — and, after the
  feed poster, two more posters that turn those consumers' queued rows into messages:
  `notice-tick.ts` (per-target order, three attempts then `failed_at`, a stuck target
  never blocks a different one) and `war-log-tick.ts` (one channel, stops at the first
  failure, same shape as the feed poster, gated on `WAR_LOG_CHANNEL_ID`).
  `structure-tick.ts` (3b): a reconciler, not a queue — derives roles/channels/`@Linked`
  from `factions`, `faction_members` (full only) and `identity_links`, diffs against the
  guild cache, writes only differences; the only writer of `factions.discord_*_id`.
  `guild.ts` is the only file that calls discord.js role/channel/member APIs. Since 3b
  the bot also requires `CLAN_TEXT_CATEGORY_ID`, `CLAN_VOICE_CATEGORY_ID` and
  `LINKED_ROLE_ID` (config load fails without all three) and the **Server Members
  Intent** enabled on the Developer Portal → Bot page — see `apps/bot/README.md` for the
  full env table.
  Since 4, `week-tick.ts` runs right after `raise-tick.ts` (it reads `raidTick`'s output,
  so it belongs after it) and before the posters: it closes every ended week, in order,
  under `seasons.week_closed_through`, inserting `alpha_weeks` and the `#war-log` row in
  one transaction per season (`closeWeeksTx`) — `war-log-tick.ts` posts those rows only
  after the commit. `wipeTx` calls the same `closeWeeksTx` with `now = wipeAt` before it
  closes the season, so the last elapsed week still crowns its Alphas: once `ended_at` is
  set, the tick (which walks open seasons only) can never reach it.
  `structure-tick.ts`'s reconciler gained an `@Alpha` step alongside its existing
  role/channel/`@Linked` diffs: it gives the role to the full members of the latest
  closed week's Alphas and takes it from everyone else. The bot now also requires
  `ALPHA_ROLE_ID` (config load fails without it, same as the other three role/category
  ids) — see `apps/bot/README.md`.
  Since 5, `positions-tick.ts` and `zone-tick.ts` run right after presence and before
  structure, **both every tick** (`BOT_TICK_INTERVAL_MS`, default 10 s) — not on a
  5-minute schedule; `reaper-tick.ts` is the 5-minute one, running beside pending expiry
  and deleting positions and sightings older than their retention windows
  (`POSITION_RETENTION_MS`, `INTRUDER_PIN_TTL_MS`). `positions-tick.ts` projects every
  pos-bearing event into `player_positions` in batches, **skipping any fix older than
  `POSITION_RETENTION_MS`** (the reaper would delete it minutes later) while still
  advancing its cursor; `docs/deploy/2026-09-07-map.md` step 5 seeds that cursor at the
  30-day boundary, so on a real deploy it backfills the retained history only.
  `zone-tick.ts` detects intruders within `WATCH_ZONE_RADIUS_M` = **100 m** of declared
  bases (never 60 — 60 is not a number in this increment), queueing alerts by range and
  `INTRUDER_ALERT_COOLDOWN_MS`, and it likewise **skips any fix older than
  `INTRUDER_PIN_TTL_MS`** — that guard, plus the runbook's `zone-watch` cursor seed at the
  log head, is what stops an unseeded or rewound cursor replaying the whole event log into
  every clan channel. The map's four rules (spec §10.3):
  every fix shows its age — `player_positions.occurred_at` written by `positions-tick.ts`,
  returned as `at`/`lastSeenAt` by `map.ts`, rendered by `map-draw.ts`'s age labels
  refreshed every 30 s in `map-view.tsx`; no trails — `map-draw.ts` draws one marker per
  player and its only polylines are the 1 km grid (`drawGrid`); no position of anyone outside your clan
  except intruders inside your own zone — `map.ts` queries `player_positions` only for the
  viewer plus their full clanmates, and `intruder_sightings.last_x`/`last_z` (the last
  in-zone fix, never overwritten by an out-of-zone fix — `zone-tick.ts`) only for the
  viewer's own declaration; dormant clans keep their map (`HOLDING_STATUSES`); and
  `Cache-Control: no-store, private` on every position response — `apps/web/app/api/map/state/route.ts`,
  pinned by `apps/web/test/map-route-headers.test.ts`, with ownership as a WHERE predicate
  in `map.ts`, never a post-filter. Tiles are a static host prerequisite, mirrored from One
  Life and shared with dayzonelife.com; absent tiles render the map with a dark ground, not
  broken. `POSITION_RETENTION_MS` is deliberately absent from `packages/domain/src/guide-numbers.ts` —
  it is a housekeeping constant, not a player-facing number.
  Since 6, `membership-tick.ts` runs **before** presence (it reconciles the roster against
  `membership_history`, opening and closing spans as members join and leave; presence must
  see the reconciled spans before promoting a pending member) and **before** the kills
  consumer (which uses `membershipAt` to resolve faction membership at the instant each kill
  happened). `sessions-tick.ts` and `kills-tick.ts` run right after zone (which needs
  membership reconciled before it matches intruders against clans) and **before** structure,
  both every tick. `sessions-tick.ts` projects `player.connected` and `player.disconnected`
  events into `player_sessions` rows (opening on connect, closing on disconnect/restart/
  duplicate-connect); `kills-tick.ts` projects `player.killed` and `player.died` events
  into `kills` rows, resolving faction membership and friendly fire (self-kills are never
  friendly fire, never PvP). Since 2026-09-10 the parser also keeps `hit by` lines
  (`player.hit`) and knockouts (`player.unconscious`), and the `Stats>` tail of a bare
  `died.`; the kills consumer hands a bare `died` to `@factions/domain`'s `classifyDeath`
  (lifted from One Life) with the victim's hits and knockouts from the two minutes before,
  and writes the verdict — `mauled`, `starvation`, `dehydration`, `fall` — into
  `kills.cause`. Evidence is matched by `occurred_at` and victim id, never by event id, so a
  reparse-then-rebuild attributes history too: `docs/deploy/2026-09-10-death-causes.md`.
  A bare `died` after a player's hit that left the victim at `FINISH_HP_MAX` (25) or below, or
  a knockout after it, with nothing but a player hurting them since, is a credited kill
  (`finishedBy`): killer, weapon and range from the hit, `cause = 'finished'`, and it counts
  as a kill everywhere `killer_dayz_id` does. ⚠️ A reparse never corrects a misparsed line —
  the idempotency index is on file + line, not type — delete the wrong events first
  (`docs/deploy/2026-09-10-credited-kills.md`). ⚠️ `pnpm rebuild:kills` fails from the
  workspace root (`drizzle-orm` unresolvable, pre-existing); the runbook shows the bot-package
  form that works. `membership_history` is a projection the roster never writes
  — only the bot writes it, once per tick. Rebuild scripts `pnpm rebuild:sessions --server
  <id>` and `pnpm rebuild:kills --server <id>` (single-server only, `factions_live` guard,
  idempotent) clear and backfill from the log head; use them after a migration or to wipe
  stats. ⚠️ The two consumers are deliberately left unseeded (cursor 0) so they backfill the
  whole log — nothing posts to Discord from either (kills are stats, never points — spec
  §11 global constraint). Schedule the deploy restart in a quiet hour because the bot posts
  nothing new until the backfill completes (`guardedRunner` skips overlapping ticks meanwhile).
  Kills before the first membership reconciler run have null faction ids and `friendly_fire
  = false` unless the seeded span (from `joined_at`) covers them.
  Since increment 7, `leadership-tick.ts` runs right after presence, every tick (ruling
  13 — a 60 s ceiling in spec §7, not a throttle): a succession claim past its
  `resolves_at` hands the seat to the claimant or is voided, and a no-confidence vote
  past its `closes_at` passes or fails (`resolveSuccessionClaims`/`closeExpiredVotes`
  from the roster's internal store). `structure-tick.ts` gains two more reconciler
  steps, after the existing role/channel/`@Linked`/`@Alpha` diffs: step 7 grants/revokes
  a clan voice channel's per-user overwrite for each open guest pass (converting one to
  a full member's role access first, so its overwrite becomes a stray for the same
  diff to remove); step 8 sets `[TAG] gamertag`/bare-gamertag nicknames for every
  linked user, diffed against the member cache every pass. Outside the tick loop, the
  bot also now handles the gateway's `guildMemberRemove` event as it arrives
  (`guild-removal.ts`) — not on a schedule — dropping a departed user's roster row,
  identity link, solo declaration and guest passes in one transaction, handing off
  leadership if they held it (ruling 10: no catch-up sweep for removals during
  downtime). `/guest` is the one live slash command, registered the same way every
  retired command is (`Routes.applicationGuildCommands`), letting an officer or the
  leader give a 24h voice guest pass from the clan's own text channel.
- **⚠️ Exactly one bot instance may run.** `notifyCompleted` DMs before it marks, which
  is right for one process and at-least-once across two — we shipped a duplicate DM to a
  real player this way on 2026-09-01. The bot runs as a **systemd unit**, which makes the
  running count **checkable** and stopping it **safe**: `systemctl status clan-wars-bot`
  shows the real count in the unit's cgroup, and `sudo systemctl stop clan-wars-bot`
  cannot reach anything outside it. It does not make a second instance impossible —
  someone can still hand-start a second bot outside the unit, and that second instance
  ships duplicate DMs exactly as before. Not doing that remains a human discipline, not
  something systemd enforces.

  ⚠️ **`systemctl status clan-wars-bot` reporting `active (running)` answers exactly one
  question: how many bot processes are running. It does not mean the bot is working.**
  The bot holds no eager database connection — postgres.js connects lazily — and every
  tick is individually try/caught, so a bot pointed at a dead database keeps running and
  keeps reporting `active (running)` with the entire data path down. To know the data
  path is actually alive, check that the `events` table is still growing and that
  `docker compose ps` shows `postgres` healthy.

  ⚠️ **Never run `pkill -f "src/main.ts"` on this host, and never trust a bare `pgrep`
  pattern as a survivor check — pattern matching is unreliable in both directions here.**
  ~15 `dayzonelife.com` services (verifier, api, ingest-worker, projector, granter,
  rebooter, enforcer, crier, newsdesk, notifier and more) match `src/main.ts`-style
  patterns, so `pkill`/`ps | grep` reads like a cleanup command but is a site-outage
  command. The inverse failure is just as real: `pgrep -af "filter @factions/bot"` was
  tried as the safe replacement during this deploy and false-positived, matching a shell
  command line that merely contained the pattern text rather than the bot process
  itself. If `systemctl status clan-wars-bot` isn't available for some reason, the
  dependable manual fallback is process **cwd**, not a command-line pattern: clan-wars
  processes have `/proc/<pid>/cwd` under `/opt/clan-wars`; dayzonelife.com's are under
  `/var/www/dayzonelife.com`.
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
- **Web app:** `docker compose build web && docker compose up -d web`. It publishes
  `127.0.0.1:3020` and the **system nginx** terminates TLS for `dayzclanwars.com` and
  proxies to it. There is no Caddy: nginx owns :80/:443 on this host and serves three
  other production sites (dayzonelife.com, manicdotes.com, regime.fi) from them. ⚠️ Every
  `systemctl reload nginx` is a reload for all four — run `sudo nginx -t` first, and
  `reload`, never `restart`. Vhost and unit files are version controlled in `deploy/`;
  `/etc` holds symlinks. `pnpm --filter @factions/web dev` for local work. Since
  increment 2a, the `web` service in `docker-compose.yml` also needs `DATABASE_URL`
  (pointed at `factions_live`); `apps/web` never reads it directly — only
  `@factions/roster` reads `DATABASE_URL`, and `apps/web` calls the package's exports.
  Since 2b the roster package also writes: `startLink`/`cancelLink`/`unlink` and
  `declareSolo`/`releaseSolo`, over `@factions/verification` and `@factions/declarations`
  — the same stores the bot uses, moved out of `apps/bot` so neither side has its own
  copy of a rule. Since 2c-b the site is the tool: `/clans`, `/clans/{tag}`, `/clan`,
  `/clan/settings`, `/claim/{ceremony}` and `/me` call the package's 34 exports through
  form POSTs to `apps/web/app/api/**` (`lib/form.ts`; codes looked up in
  `lib/clan-copy.ts`). Every Discord slash command is retired and answers with one line
  and a link (`apps/bot/src/retired-commands.ts`, `SITE_BASE_URL`). A page may never
  reference an identifier containing "faction" (`apps/web/test/copy-vocabulary.test.ts`
  bans the substring in web source, identifiers included) — the package maps the
  page-facing fields at that boundary, e.g. `reads.ts`'s `clanId`/`clanName`.

---

## Where things live

| What | Where |
|---|---|
| The player's guide (the authority over every rule) | `apps/web/content/guide/` (hand-written HTML fragments) and `apps/web/lib/guide.ts` (chapter manifest) — served at dayzclanwars.com/guide by `apps/web/app/guide/`. Moved in from the archived field-guide repo on 2026-09-07 |
| The guide in Discord (📖 Field Guide category, one channel per chapter) | Written from the same fragments by `apps/web/scripts/publish-guide.ts` via `apps/web/lib/guide-discord.ts`; a reconciler, run by `deploy/deploy-web.sh` after every web deploy and hourly by `clan-wars-guide.timer`. Edit the site, never the channels. Runbook: `docs/deploy/2026-09-09-guide-in-discord.md` |
| The server-name strip (in-game name under the top bar) | Nitrado `settings.config.hostname`, read every sweep by the worker into `servers.hostname`/`hostname_seen_at`, served by `liveServers()` in `packages/roster/src/servers.ts`, rendered by `apps/web/app/components/server-strip.tsx`. Never configured or hard-coded. Runbook: `docs/deploy/2026-09-11-server-name-strip.md` |
| The target state, guide → system | `docs/superpowers/specs/2026-09-04-clan-wars-target-state-design.md` — wins over every earlier spec where they differ |
| Designs (per increment) | `docs/superpowers/specs/` |
| Implementation plans | `docs/superpowers/plans/` |
| **The running to-do list** | `docs/superpowers/plans/PLAN-3-INBOX.md` |
| Long-term direction (not designs) | `docs/direction/` |
| Deploy runbooks | `docs/deploy/` |
| The raid window, flipped by hand twice a week | `docs/deploy/raid-window.md` — held against `RAID_WINDOW` by `packages/domain/test/raid-window-runbook.test.ts` |
| Acceptance records | `docs/acceptance/` |
| Bot operational notes | `apps/bot/README.md` |
| The guide's numbers | `packages/domain/src/guide-numbers.ts` — the appendix table and the chapters' `{{KEY\|format}}` tokens both render from it; `apps/web/test/guide.test.ts` fails on a hand-typed number |
| The wipe, the launch grace stamp, and a standings rebuild | `pnpm wipe --server <id> --at <ISO>` (`scripts/wipe.ts`; `--at` is required — no default, usage error exits 2 — and the wipe is a no-op when the server's open season is younger than a week, i.e. one a wipe just opened), `pnpm launch --server <id> --at <ISO>` (`scripts/launch.ts`; stamps every pole on the server to `--at` + 7 days, spec §4.2; same `--at`-is-required rule, idempotent for the same instant), `pnpm rebuild:standings --season <id>` (`scripts/rebuild-standings.ts`) — all three refuse a `DATABASE_URL` that doesn't end in `/factions_live` unless `--allow-test-db` is also passed. Root `package.json` carries `@factions/db` as a dependency (since increment 4) so these resolve from the repo root without `cd`ing into a package. |

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
`packages/db/test/holding-index-drift.test.ts`. `apps/web/test/theme-tokens.test.ts` —
the `@theme` block against the palette; a dropped token renders a browser default
silently.

**Every guide number lives in `packages/domain/src/rules.ts`** and reaches the guide through
`packages/domain/src/guide-numbers.ts`: the "Every number" appendix renders `GUIDE_NUMBERS`, and
the chapters carry `{{KEY|format}}` tokens that `apps/web/app/guide/render.ts` resolves at build
time (an unknown key throws). A new number goes in `rules.ts`, then a row in `guide-numbers.ts`,
then a token in the chapter — never a literal. `apps/web/test/guide.test.ts` fails on a hand-typed
rule number in any chapter; the old vendored `docs/guide-numbers.json` and its drift test are gone
(2026-09-07).

**Every package `apps/web` transpiles (`transpilePackages` in `apps/web/next.config.ts`)
must use extensionless relative imports in its `src/`.** Turbopack cannot map `.js` →
`.ts`; `tsconfig.base.json`'s `moduleResolution: "Bundler"` makes the extensionless form
legal, and tsx and vitest resolve it the same way. Today that is `roster`, `db`,
`domain`, `declarations` and `verification` — including `packages/roster/src/internal/`, the bot's entry point; adding a package to `transpilePackages` means converting it first, and
`apps/web/test/transpiled-imports.test.ts` fails until you do.

---

## Invariants worth knowing before you change them

- **`HOLDING_STATUSES` (`reserved, active, dormant`) means identity — holds flag, tag
  and pole — and nothing else.** It is mirrored by two partial unique indexes plus the
  existence of a `declarations` row. Do not narrow it to change behaviour; add a set.
  Supply kits are governed by a predicate, not a status set: `status in ('reserved',
  'active') and flag_down_since is null` (`SUPPLIED_PREDICATE` in `packages/domain`,
  spelled in SQL by the worker and pinned by `holding-index-drift.test.ts`) — a raided
  clan keeps `status = 'active'` but loses its kit the moment its flag comes down.
  ⚠️ `reserved` is in on purpose (2026-09-08): the kit is the only source of a clan's own
  flag and raising it is the activation, so an active-only predicate leaves every new clan
  unable to activate. The 2026-09-04 spec's §4.3 shipped with `active` alone and did
  exactly that to COK and NIGHT; it is amended.
- **Lock order (spec §4.12): `factions` → `declarations` → `poles` →
  `faction_members` → `faction_invites` → `faction_join_requests` → `faction_votes` → `faction_vote_ballots`
  → `succession_claims` → `season_standings` → `raids` → `defenses` → `vault_locks` →
  `clan_pins` → `guest_passes` → `faction_events` → `war_log_events` → `clan_notices`.**
  `poles` sits right after `declarations` because `releaseTx` takes both, in that
  order: it deletes the declaration and then stamps the released pole's grace.
  A deadlock was already built once from two separately-correct changes taking two of
  them in opposite orders. There are four writers now. `faction_events` is always last
  among the roster tables, and can safely be: it is insert-only and nothing references
  it, so no writer ever needs it locked before touching the roster tables. All three
  queues are insert-only and always last; a channel notice with no channel yet waits
  with a null target (3b fills it).
  `packages/roster` is the fifth roster writer and the first outside the bot process. Its
  first writes landed in 2b: `unlink` row-locks the identity link, then takes
  `lockDeclarations` → `releaseTx`, then deletes the link; `declareSolo` takes
  `lockDeclarations` before reading the link, which is what serialises the two
  (`packages/roster/test/base.test.ts` races them). 2c adds
  the roster writes, every one appending its feed or notice row in the transition's own
  transaction. Since 2c-a the store itself lives in `packages/roster/src/internal/`;
  `apps/bot` imports `@factions/roster/internal`, which `apps/web` may never import
  (`smoke.test.ts`). New writers there: `requestJoinDb`/`decideRequestDb` (`factions →
  faction_join_requests → faction_members`; `decideRequestDb`'s cap check takes the
  `factions` row `FOR UPDATE`, then runs the member count as a SEPARATE statement so it
  sees a fresh snapshot after the lock wait — the same shape as `acceptInvite`'s cap
  check, and for the same reason: `FOR SHARE` would not bar a second reader from taking
  the same shared lock and reading the same stale count), `presenceTick`
  (`lockDeclarations → releaseTx → faction_members`), `writeHoldsTx` (right after the
  `factions` write). `lockIdentity(tx, serverId)` — `pg_advisory_xact_lock(hashtext('identity'), serverId)`
  — serialises name/tag uniqueness in `rename` and `reserve`, since names have no unique
  index.
- **`declarations` is written by `declareTx` and nothing else.** The 200 m rule is a
  query under a lock inside it, not an index; a second writer is a race. `declareTx`
  lives in `packages/declarations` since 2b; `apps/bot` calls it directly, and
  `packages/roster` reaches it only through `declareSoloTx`.
- **`poles` is filled by the bot's `pole-tick.ts`**, not by `apps/projector`, which does
  not run here. `grace_until` comes from it.
- **`faction_events` rows are written in the SAME transaction as the transition they
  describe.** The feed's whole correctness is "a row exists iff the transition happened",
  and nothing anywhere reconciles the two — the transition's own evidence
  (`dormant_since` nulled on revive, a name overwritten by a rename) is exactly what the
  log preserves, so it is already gone by the time anyone could notice a missing row.
  Append through `appendFactionEventTx`, which takes a `Tx` rather than a `Database`
  precisely so this is hard to get wrong.
- **The feed's payload is frozen at write time and carries no coordinates.** Re-reading
  `factions` at post time would print today's name on a late rename post; a coordinate in
  the payload is rejected by `faction_events_no_coordinates`, which exists because this is
  the first table whose whole purpose is to be published.
- **The feed posts in `id` order and stops at the first failure.** One stuck row blocks
  the queue, loudly (`feed queue blocked at …` at error level). That is deliberate:
  skipping ahead would let a retried older event land below newer ones, and a feed whose
  order cannot be trusted is not a record of anything.
- **The emote budget (`MAX_POOL_EMOTES_PER_ATTEMPT`) is the primary defence** against a
  `/link` target completing its own sequence by accident. Do not exempt in-sequence
  emotes from it — an accidental completion is *made* of in-sequence emotes.
- **`flag_changes` holds zero rows in `factions_live`.** The projector that fills it does
  not run there. Read the `events` log directly, as `ceremony-tick` and the dormancy
  clock do.
- **Pole coordinates are a raid target.** They are gated to the viewer's own `/base`;
  no clan page, DM or feed row carries one (`rebindCandidates` carry pole keys in
  hidden form fields, never rendered).
- **Roster membership is PUBLIC, on purpose — do not "fix" it.** `/clans/{tag}`
  listing any clan's members (gamertag and rank) to anyone is the intended product
  behaviour (confirmed 2026-09-02), not an oversight inherited from spec §6. Knowing who
  flies which flag is the point of flying one; it is what makes an identity worth
  holding and a rivalry legible. This is deliberately NOT the same rule as the pole
  coordinates above: who someone is is public, where their base is is not. Gating the
  roster would also break the one lookup a player has for deciding who they are looking
  at. A past version of this file listed it as a gap "worth revisiting"; it is not.
- **A pending member is on `faction_members` and not on the roster** (spec §4.5, §14).
  `status = 'full'` is part of every membership read — dormancy attribution, activation,
  rebind, `viewerFor.clan`, `declareSoloTx`'s in-clan refusal, `isRosterMember`. The cap
  counts both statuses. A pending member keeps their solo base until the presence tick
  promotes them and releases it in the same transaction. Unlink is refused with ANY
  roster row.
- **The dormancy clock's raise lookup depends on `events_raise_lookup_idx`** — a partial
  index over `(server_id, payload->>'poleKey', payload->>'texture', occurred_at)` where
  `type = 'flag.raised'`. Without it the subquery filters every `flag.raised` row on the
  server once per faction per tick (352ms vs 0.41ms at a year of projected ingest), and
  nothing errors — `guardedRunner` just skips overlapping runs, so the clock silently
  stops keeping up. The index's payload keys and the query's are two statements of one
  fact; `apps/bot/test/dormancy-index-drift.test.ts` holds them together. Do not
  "simplify" it to `(server_id, occurred_at)`: that form is *worse than no index* for a
  faction that has not raised in months, which is the only kind dormancy cares about.
  Since increment 4, `clockQuery`'s coalesce also takes the `GREATEST` against the
  server's open season's `started_at` (spec §5.1) — a wipe opens a fresh season, and a
  clan's dormancy clock restarts with it even if its last raise was long before.
- **`season_standings` is a projection; the drift test in `standings.test.ts` is what
  keeps it honest** — edit it only through the consumers (the raid/raise ticks, the week
  and season close) or `scripts/rebuild-standings.ts`, never by hand.
- **Two entrances to `dormant`, one exit.** `dormant_reason` (`raided`/`inactive`) is a
  column, not a second status — a raid that goes 24 h without a defense and 7 days of no
  full-member raise both land on `status = 'dormant'`. Anything that switches on `status`
  alone is correct; anything that assumes `dormant` means "inactive" is wrong.
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
- **The website is a surface, never a source of truth.** Rituals — founding, claiming a
  flag, binding a pole — are earned in game and proved from the server's logs; nothing on
  `dayzclanwars.com` may perform one. Administration is different: roster chores (every
  roster read and write, since 2c-b from the pages themselves) are permitted
  from the web, but only through `packages/roster`. The boundary is that package's export allowlist —
  `apps/web` may call only what `packages/roster` chooses to export — pinned by name in
  both `packages/roster/test/exports.test.ts` and `apps/web/test/smoke.test.ts`. Under
  that allowlist, the `declarations_one_evidence` CHECK (target spec §16) is the guard
  the export list leans on — exactly one of `evidence_event_id` / `evidence_ceremony_id`
  is set, so no row can exist without citing a ceremony or a raise, and even a permitted
  caller cannot write a declaration without the evidence a ritual actually produces.
- **The 33 flag images and `CLAIMABLE_FLAGS` are two statements of one fact.**
  `apps/web/test/flag-assets.test.ts` holds them together. Drift shows up as a missing
  thumbnail in a Discord channel, not as an error.
- **⚠️ There is no second machine.** Postgres, the ingest worker, the web app and the
  bot all run on this host, alongside three unrelated production sites. Earlier deploy
  documents describe a separate VPS holding only `web` and `caddy`; that machine does
  not exist and never did on this deployment. Name compose services anyway — a bare
  `up -d` starts more than you mean.
- **The vote freeze and the electorate decrement both live in `kick`/`leave`/`transfer`/
  `disband`, never in a page.** `kick`, `transfer` and `disband` all refuse while a
  no-confidence vote is open (`voteIsOpenTx`, spec §5.7: "no handing the seat to an ally
  to dodge a vote on it", and no disbanding the clan to dodge one either); `leave` does
  not — nobody is trapped in a clan by a vote — but a leaver's electorate slot and
  ballot are both removed (`applyElectorateLeaveTx`), which can carry a vote that was
  one short. `kick` also decrements the electorate, since the freeze only refuses
  `kick` while a vote is open; the call is made anyway on the (currently unreachable)
  chance that changes. Only the leader-initiated `disband` (`PgRosterStore.disband`) is
  frozen — the shared `disbandFactionTx` it calls into is not, so the dormancy tick's
  auto-disband and the guild-removal path keep working while a vote is open.
- **Vault exposure lives in `kick`/`leave`, full members only.** A departing full member
  (never a pending one — spec §4.5, whose role is `'member'` regardless) has every lock
  they could see marked exposed (`exposeLocksTx`), because every code they knew is now
  known to someone outside the clan. A removed leader exposes the whole vault, and
  `removeFromGuildDb` releases their solo declaration and closes any open vote or claim
  in their clan silently, the same way `disbandFactionTx` does.
- **`removeFromGuildDb` is internal-only, and the one roster writer a gateway event (not
  the log, a clock, or the site) is allowed to start** (`@factions/roster/internal`,
  never the package root — `packages/roster/test/exports.test.ts` and
  `apps/web/test/smoke.test.ts` both pin the allowlist). It runs from
  `apps/bot/src/guild-removal.ts`'s `guildMemberRemove` handler, which checks the
  event's guild id against `DISCORD_GUILD_ID` before it ever reaches the store —
  ruling 10: there is no catch-up sweep for removals that happened while the bot was
  down, gateway event only.
- **Nicknames and guest-pass voice overwrites are reconciled by `structureTick`, never
  fire-and-forget** — the same discipline 3b established for roles/channels/`@Linked`.
  Step 7 diffs each clan voice channel's member overwrites against its open guest
  passes (`memberOverwrites` excludes the bot's own overwrite, so the diff never
  revokes its own View+Connect grant; a failed pass read under-acts — skips the whole
  diff rather than revoking every pass in the guild); step 8 diffs every linked user's
  current nickname against `nicknameFor` (`[TAG] gamertag` for a full member of a
  holding clan, bare gamertag otherwise, both capped at `NICKNAME_MAX` = 32) against the
  member cache every pass, so a manual rename reverts within one tick interval.

---

## Current state — 2026-09-03

**This host was rebuilt today for the single-host deployment** (see
`docs/deploy/2026-09-03-single-host-deployment.md`). `factions_live` is a **fresh**
database — all 20 of 20 journal entries applied in one run during this deploy, not
accreted across the dates below. It holds **one registered server** (`CW-TEST`,
Livonia) and **zero factions**. Nothing below has been exercised against real player
data on this deployment; the descriptions are of the code, which is unchanged and real,
not of anything that has happened here yet.

Increment 2a (site foundation) landed: Tailwind, `packages/roster` with `viewerFor`,
`/me` from the database. No new player capability; the slash commands still run.
Increment 2b landed: `/link` (autocomplete, three emotes, 24 hours since 2026-09-08 — ten minutes before, 5 s poll), unlink
on `/me`, `/base` for solo declare and release; migration 0021; inbox 7 closed.
Discord's `/link` still runs beside the page until 2c-b.
Increment 2c-a landed: the roster store in `packages/roster`, pending/full membership
with presence promotion and the cap, join requests, identity holds, the recruiting post,
and the package's roster writes and reads exported for 2c-b's pages. Slash commands still
run.

**Increment 2c-b is merged.** The slash commands are retired; roster administration
happens on the site. Not deployed until the runbook `docs/deploy/2026-09-05-site-roster.md`
runs, together with 2b and 2c-a.

**Increment 3a merged; not deployed until `docs/deploy/2026-09-05-raids-and-notices.md`.**

**Increment 3b merged; not deployed until `docs/deploy/2026-09-06-discord-structure.md`.**

**Increment 4 merged; not deployed until `docs/deploy/2026-09-06-scoring-and-seasons.md`.**

**Increment 7 (leadership and the vault) is merged; not deployed until
`docs/deploy/2026-09-09-leadership-and-vault.md` runs.** Migration 0028 adds succession
claims, no-confidence votes, the vault, and guest passes. A silent leader (`last_seen_at`
older than `LEADER_SILENT_MS` = 7 d) can be claimed by an OFFICER while the clan has any
officer on its roster, and by any full member only when it has none; the claim
resolves after `SUCCESSION_WINDOW_MS` = 48 h unless the leader is seen again first; any
full member can instead open a no-confidence vote (2/3 of the electorate, 48 h, one at a
time per clan), which the leader cannot open and cannot dodge by transferring away.
Removal from the Discord — `guildMemberRemove` — removes a player from everything at
once: roster, identity link, solo declaration, guest passes, and the leader seat if they
held it. The vault (`vault_locks`/`vault_history`) holds a clan's door/safe codes behind
a per-lock `min_role`; a code is never DM'd, fed, or put in a URL — only shown by
`revealLock`/`/api/vault/reveal`, and a rotation's DM says only "see the vault." Guest
passes (`guest_passes`) give a non-member 24h voice-channel access via `/guest` or
`/clan/settings`, reconciled onto the clan's voice channel by the structure tick.
`@factions/roster`'s root export list grows by 14 (12 functions, `VAULT_NAME_MAX`,
`VAULT_NOTE_MAX`).

⚠️ Hand-deleted clan channels are logged, not recreated; null the column to recreate. If
an operator deletes a clan's role or channel by hand, `structure-tick.ts` logs
`structure: missing:<id>` once per tick and leaves it gone — an operator's deletion is
treated as a decision, not damage to repair. To force it back: `update factions set
discord_text_channel_id = null where id = …;` (or `discord_voice_channel_id` /
`discord_role_id`) — the next tick creates a fresh one.

Faction dormancy is **in the code and migrated in**. A faction that does not raise its
own flag at its own pole for 7 days goes dormant and loses its supply kit; 14 further
days disband it. Spec and plan are in `docs/superpowers/`. (Previously deployed and
exercised against a now-gone database — see `docs/deploy/2026-09-02-dormancy.md` for
that history; it does not describe this database.)

**Faction rebind is in the code and migrated in.** A faction can move its base: a
roster member raises the faction's OWN flag at a pole nobody holds, the leader
confirms, and the binding moves in one guarded write. 7-day cooldown. (Previously
deployed and exercised against a now-gone database — see
`docs/deploy/2026-09-03-faction-rebind.md` for that history.)

⚠️ The disband and base-release copy tells a leaving clan or player their old base "stays
private for 3 days" (`apps/web/lib/clan-copy.ts`'s `DISBAND`, `apps/web/lib/base-copy.ts`'s
`released`; both `RELEASED_POLE_GRACE_MS`). That promise is real now, not vacuous: no clan
page, DM or feed row carries a base's coordinates (see the pole-coordinates bullet above).
See `docs/superpowers/specs/2026-09-03-base-declaration-design.md`.

Declarations (increment 1 of the target-state spec) are in the code and migrated in.
Solo declare has a store and a lapse clock but no page and no DM yet (increments 2 and 3).

**The faction feed is in the code and migrated in.** `faction_events` is an append-only
log, written inside each transition's own transaction, and a tick posts queued rows in
`id` order as embeds to `#🎌-faction-feed`. (Previously deployed and exercised against a
now-gone database — see `docs/deploy/2026-09-03-faction-feed.md` and
`docs/acceptance/2026-09-03-faction-feed.md` for that history.) On this database, no
faction has ever existed, so no event of any kind has ever been queued or posted here.

⚠️ `BOT_FEED_CHANNEL_ID` lives in `.env`. Passing it only on the start command line turns
the feed off at the next restart with nothing saying so — rows keep accumulating unposted
and the only signal is one warn line at startup.

⚠️ Only `founded` and `activated` have ever posted to a real channel, anywhere, and both
came from the 2026-09-02 backfill on the now-gone database. The other five kinds are
tested but have never run in production. This is a fact about code maturity, not about
which database is live — it stays true regardless of the fresh, empty `factions_live`
above.

Test-database isolation (inbox item 21) also landed on 2026-09-02: one database per
package, `pnpm -r test` green for the first time, and the shared `factions` database no
longer written to by any suite. Nothing about it reaches production — it is test
infrastructure only. Acceptance: `docs/acceptance/2026-09-02-test-database-isolation.md`.

The read-only acceptance check, to re-run before any future dormancy change:

    docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c "
      select f.tag, f.status, f.dormant_since,
             now() - coalesce((select max(e.occurred_at) from events e
               where e.type='flag.raised' and e.server_id=f.server_id
                 and e.payload->>'poleKey'=d.pole_key
                 and e.payload->>'texture'=f.texture
                 and e.payload->>'dayzId' in (select dayz_id from faction_members where faction_id=f.id)),
               f.activated_at, f.created_at) as age
      from factions f left join declarations d on d.owner_faction_id = f.id
      where f.status in ('active','dormant')"

Any row with `age` over 7 days will be made dormant on the next tick, cutting a real
faction's supplies. That is a decision, not a side effect. The solo lapse clock is
separate: for a solo declaration it starts at `declared_at`, or the declarant's last
raise, whichever is later.

⚠️ The read-only acceptance check above returns **zero rows** on a fresh database. That
is the same output it gives when "nothing will transition on the next tick" — identical
text, opposite meanings. Read a zero-row result together with `select count(*) from
factions`, or it proves nothing.

Increment 8 (launch) merged on 2026-09-07: `/guide` redirects to the
guide's host (superseded 2026-09-07: the guide now lives in `apps/web`), `pnpm launch` stamps the launch grace, `docs/deploy/raid-window.md` is the
twice-weekly base-damage flip, and `docs/deploy/2026-09-10-launch.md` is the order every
unapplied runbook (2b → 7) reaches `factions_live` in, plus the acceptance. Deployed to `factions_live` on 2026-09-08 as one consolidated deploy (migrations 0020–0028 together; the database held zero clans): `docs/acceptance/2026-09-08-launch.md`. Launch instant `2026-09-08T00:39:17Z`; poles in grace until 2026-09-15.

### Known-open, in rough priority order

1. A genuinely dead server never releases its flags — the last of inbox item 26's three
   gaps. The disband countdown now pauses while a server is dark, which is the safe
   direction and is logged loudly, but it means the pool cannot reclaim a flag from a
   server that never comes back without manual intervention.
2. `packages/domain/src/emotes.ts` claims every safe token "has been performed by a real
   player completing a real `/link` in production". That is not true — about ten of the
   24 have ever appeared in live data. A player was blocked by `EmoteMove` on
   2026-09-01.
3. A stale 30KB `flag-supplies.json` sits beside ours in the server's mission `custom/`
   directory. `cfggameplay.json` does not load it; it is only confusing. Deleted by the
   launch runbook (`docs/deploy/2026-09-10-launch.md` §1), after a check that
   `cfggameplay.json` does not name it.
4. A blocked feed queue has no alerting: `feed queue blocked at …` is an error-level log
   line and nothing else, so a human has to notice it. See inbox item 35 (the artwork
   half of that item closed 2026-09-03).
5. A lapsed reservation releases a flag with no feed event — `lapseReservations` returns
   the flag to the pool 24 hours after claim if unactivated, but the prior `founded` event
   is never retracted or closed. So the feed reads as if the faction still holds a flag
   that is back on the market. See inbox item 36.
