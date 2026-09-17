# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Design for release announcements in Discord
  (`docs/superpowers/specs/2026-09-17-release-announcements-design.md`), not yet
  implemented: `CHANGELOG.md` is the single source, `deploy-release.sh` queues a
  row after a *successful* deploy rather than on the tag push, and a bot tick
  drains the queue oldest-first into a player-facing channel. The same
  `pnpm release:sync` call is the backfill, the per-deploy hook and the repair
  tool. Implementation plan:
  `docs/superpowers/plans/2026-09-17-release-announcements.md`.

## [1.17.0] - 2026-09-17

### Added

- An acceptance record for the automatic deployment system,
  `docs/acceptance/2026-09-17-auto-deploy.md`: what the three rehearsals proved,
  the six-minute outage the second one caused and why, the measured downtime of
  a real rollback, and an explicit list of what the acceptance does **not**
  establish.
- The raid weekend opens and closes itself. Base damage is flipped on the
  Friday and Monday boundaries by the bot, on the restart slots that already
  apply it, and repaired within two hours if a write is lost or reverted.
- The site's top bar states whether raiding is live, with a countdown — read
  from confirmed flips, so a failed flip shows "not yet confirmed" rather than
  telling players base damage is on when it is not.
- Discord announces the weekend a day ahead, at its open and at its close, and
  alerts ops once per boundary if a flip is refused.
- `pnpm raid:skip` records a weekend deliberately not opened, with its reason;
  the site and the Thursday notice both explain the skip.
- `docs/deploy/2026-09-17-raid-window.md`, the deploy runbook for the automatic
  raid window: the `.env` additions and the two config-load refusals they carry,
  what the site says before the first boundary, and what to check at it.

### Fixed

- A raid-window boundary whose `cfggameplay.json` already held the wanted value
  recorded nothing, and the site and Discord both read a missing record as "the
  flip did not happen". The site warned indefinitely on day one, on the Monday
  after a skipped weekend, and after an operator's own manual flip. Every
  boundary now records itself, whether or not the file needed changing.
- An unconfirmed Monday close showed "OPENING" on the site, though base damage
  was still on. It now says "CLOSING".
- The raid-window failure alert scanned every failed flip ever recorded on every
  tick, and could post its first alert about a weekend long past.
- The raid-window countdown seeded itself from the clock during render, which
  could differ between the server's markup and the browser's first paint.
- `docs/deploy/raid-window.md` said the window decides whether "walls, gates and
  containers" take damage. Container damage has never been windowed on this
  server. No player-facing promise was affected — the guide says only that walls
  do not take damage.

## [1.16.6] - 2026-09-17

### Fixed

- The release deployer can no longer be rewritten out from under itself. It
  moves the tree to the new tag, which replaces `deploy-release.sh` while bash
  is executing it, and bash reads a script lazily by byte offset rather than
  loading it whole — so a replacement of a different length makes the
  interpreter resume at a stale offset in new bytes. Reproduced: the victim
  script silently stopped running at the rewrite and **exited 0**, which in a
  deploy means all three writers stopped, a failure marker written, and a
  success reported. The deployer now re-execs from a private copy, so its own
  text cannot change mid-run.
- A deploy can no longer report success while production runs the previous
  release's image. `docker compose up -d` was observed starting the stopped
  containers again rather than recreating them on the newly built image; web
  and ingest-worker are build-only services whose definitions name no image, so
  an unchanged definition can look up to date. No health check could catch it —
  the old image is perfectly healthy. The deployer now passes
  `--force-recreate`, which costs nothing because those containers have already
  been stopped.

## [1.16.5] - 2026-09-17

### Changed

- Rehearsal 2, re-run: a deliberately unhealthy release, used once to prove the
  deployer's automatic rollback restores code, images, host config and database
  after the image-retag fix in 1.16.3. Reverted here. The rollback passed: 1
  minute 57 seconds of downtime, including a full drop-and-restore of
  `factions_live`, with no human involved.

## [1.16.4] - 2026-09-17 [WITHDRAWN]

Not a release. This tag is rehearsal 2's re-run — a deliberately unhealthy
build, cut to prove the automatic rollback after the image-retag fix in 1.16.3.
It is recorded rather than deleted for the same reason as 1.16.2: a tag the
deploy history names should not be a mystery.

The rollback passed in full this time. **Never deploy this tag.**

## [1.16.3] - 2026-09-17

### Fixed

- The deployer's rollback no longer retags the **postgres** image when
  restoring the previous release. It resolved the target with
  `docker compose config --images <service>`, which also lists the service's
  dependencies, so the first line was `postgres:16-alpine` — pointing the
  database's image tag at an application image and putting postgres into a
  restart loop. Found by rehearsal 2 on 2026-09-17, which took production down
  for about six minutes; no data was lost.

### Changed

- Rehearsal 2's deliberately unhealthy release is reverted.

## [1.16.2] - 2026-09-17 [WITHDRAWN]

Not a release. This tag is rehearsal 2 — a deliberately unhealthy build, cut to
prove the deployer's automatic rollback works against real production data. It
is recorded here rather than deleted because the production host's failure
marker names it, and a tag a runbook points at should not be a mystery.

The rollback restored the tree, the host config and `factions_live` correctly,
and refused to retry. It failed at one step, fixed in 1.16.3. **Never deploy
this tag.**

## [1.16.1] - 2026-09-17

### Fixed

- The release deployer no longer dies at its first step: `pnpm` prints a
  lifecycle banner to stdout before a script's own output, and the deployer
  fed that banner to a JSON parser. Every deploy would have failed.
- `/backups/` is ignored, so hand-made dumps kept on the production host no
  longer leave the working tree dirty — which would otherwise make the release
  deployer refuse every deploy.

## [1.16.0] - 2026-09-16

### Added

- Releases deploy themselves: a new `vX.Y.Z` tag on `main` is deployed to
  production within two minutes, applying migrations and rolling back code,
  image, host config and database together if any phase fails.
- Repository lifecycle, CI, hygiene, secret-scanning and dependency-update
  configuration via the shipyard plugins: `.keel.json`, `.rigging.json`,
  `.stow.json`, `.hull.json` and `.bosun.json`, with the GitHub Actions
  workflows, PR/issue templates, CODEOWNERS and changelog gate they render.
- CI (`.github/workflows/ci.yml`) runs `pnpm run ci` — the typecheck and test
  gate — on node 20 against a Postgres 16 service container, with
  `TEST_DATABASE_URL` pointed at it as the base URL each package derives its
  own `factions_test_<package>` from.
- Secret scanning (`.github/workflows/security.yml`) runs trufflehog rather
  than gitleaks: this repo is organization-owned, and the gitleaks action
  exits 1 without a licence key before scanning anything.
- `CLAUDE.md` documents the CI gate, the `main`-is-protected PR workflow, the
  committed-changelog requirement, and the secret-scanning boundary — including
  that the history was swept clean once at adoption.
- Design for automatic deployment on release (`docs/superpowers/specs/2026-09-16-auto-deploy-design.md`),
  approved but not implemented: a host-side timer deploys each new tag, applies
  migrations, and rolls back both code and database automatically on failure,
  with the implementation plan in `docs/superpowers/plans/2026-09-16-auto-deploy.md`.

## [1.15.0] - 2026-09-15

### Added

- Automated base-zone enforcement. A non-member who builds, dismantles, or
  stacks fireplaces and garden plots inside a declared base's 100 m watch zone
  is recorded and warned. Nothing happens until the base's owner presses
  charges from `/base` — and then the ban is automatic, scaled to the damage,
  with no staff step. The bot only ever sentences incidents it witnessed
  itself: a report carries no free text and cannot describe an act the log
  did not record. The owner chooses whether to charge and which participants
  to charge; they never choose what the charge is.
- The sentence: 24h base, +48h for any breach, +24h for a fence-to-gate, +12h
  per part dismantled, capped at 7 days on a first offence, doubled on the
  second, permanent on the third in a season.
- Migration 0036 adds `zone_incidents`, `zone_violations`, `zone_placements`,
  `zone_incident_participants` and `bans`. CREATE only — the bot does not
  need stopping to apply it.
- Runbook: `docs/deploy/2026-09-15-zone-enforcement.md`.

### Changed

- Dismantling a base that is not yours is a violation 24/7. The "inside the
  window, dismantling while raiding is part of raiding" carve-out is deleted.
- Building anything inside someone else's watch zone is a breach — watchtower,
  fence, anything.
- Stacked fireplaces and garden plots move off the permanent-ban exploit list
  onto the proportional ladder.
- These three skip the ticket queue. Every other fair-play rule still needs
  one. (`apps/web/content/guide/12-fair-play.html`)

### Notes

- ⚠️ Ships dark. `ENFORCEMENT_TICK` defaults off and `BAN_DRY_RUN` defaults
  true: audit rows are always written, and a real ban needs both flags set
  deliberately. The dry-run week is where `BOOST_STACK_RADIUS_M` and
  `BOOST_STACK_MIN_RISE_M` get tuned before anyone is banned.
- ⚠️ `parity.test.ts`'s `PENDING` list is no longer empty. `reportIncident` is
  deferred deliberately: the evidence an officer needs to judge a report
  cannot appear in Discord under `clan_notices_no_coordinates`, so the
  decision surface is the owner-gated `/base` page.

## [1.14.0] - 2026-09-14

### Fixed

- A typo'd `BOT_TICK_INTERVAL_MS` was a database hammer, not a slow loop.
  `tickIntervalMs` goes straight into `setInterval`, which stores its delay in
  a signed 32-bit int: past 2,147,483,647 Node warns and uses 1 ms, so an
  extra-digit typo in `.env` fired the tick loop a thousand times a second
  while the value on the page read like a longer interval than intended.
  ⚠️ Operationally new: the bot now refuses to start on an out-of-range
  `BOT_TICK_INTERVAL_MS`, naming the limit, rather than clamping it — clamping
  would silently run an interval the config does not say. The cap is on this
  key alone; the dormancy windows stay uncapped.
- A thrown tick no longer takes the notifier down with it. `verificationTick`
  and `notifyCompleted` shared one `try`, so a persistently throwing tick
  meant players who had already completed their sequence were never told —
  indefinitely, with nothing saying the notifier had stopped too. Every other
  pair in that pass already had its own catch.
- `liveChallenges` is read once per batch instead of once per emote event —
  one query per batch plus a lookup per event × challenge, instead of one
  query per event (2,093 on the historical backfill). ⚠️ The per-event re-read
  was load-bearing, not merely wasteful: the cache is dropped on every write,
  or safe-pool emotes arriving after a completion in the same batch would
  re-enter the finished challenge and fail its `stillOpen` guard, surfacing as
  `alreadyLinked` — a code that means "this UID belongs to someone else."

### Notes

- Bot only. No migration, no web change, no player-facing behaviour change.

## [1.13.0] - 2026-09-14

### Added

- Migration 0035: a unique index on `faction_members (server_id, discord_id)`,
  the mirror of the one that has always existed on `(server_id, dayz_id)`. One
  person, one membership per server, whichever of their two ids identifies
  them. First migration applied with `pnpm db:migrate` (shipped in v1.11.0)
  instead of a hand-assembled runner.

### Notes

- No player-facing behaviour change — nothing a player could do before is
  refused now. The index forbids only rows that four separate write paths
  already refuse to write; it is defence in depth, not a fix for a live bug.
  What was open is that none of those paths was backed by a constraint, so a
  fifth one getting it wrong would have raised a raw Postgres error at a
  player instead of degrading gracefully.
- ⚠️ The index caught three test fixtures on its first run, each seeding one
  Discord account as leader of two clans on one server — always illegal, but
  only the dayz-keyed index had been watching for it.
- Runbook: `docs/deploy/2026-09-14-membership-uniqueness.md`.

## [1.12.0] - 2026-09-14

### Fixed

- A map pin dropped within half a card's width of the world's edge opened a
  popup that was simply cut off — the note and the Delete button off the
  page, with no gesture that could bring them back. Leaflet's only answer to
  an overrunning popup is to pan the map, and this map cannot pan: the world
  is the max bounds with viscosity 1 and the zoom floor already fits all of
  it, so there is no headroom to pan into. The card now moves instead of the
  map (`apps/web/lib/map-popup-fit.ts`, pure and unit-tested) — the tip stays
  where Leaflet put it, still pointing at the pin, and hides past the point
  where it would slide off the card's own corner. A card that overruns the
  top flips below its pin instead of sliding down onto it.

### Notes

- Web only. No migration, no bot change, no operational change.

## [1.11.0] - 2026-09-14

### Added

- `pnpm db:migrate` (`scripts/migrate.ts`): applying a migration to
  `factions_live` is now a checked step instead of a script hand-assembled at
  deploy time. Dry run by default — prints the target, the journal, what is
  applied, and the exact tags it would apply, then exits without writing.
  `--apply` writes. After applying, it re-reads the migrations table and
  checks the result against the plan, because the migrator itself reports
  neither what it applied nor that it applied anything.
- Root scripts are typechecked (`scripts/tsconfig.json`, `pnpm
  typecheck:scripts`, run by both `typecheck` and CI). Its first run found a
  live bug: `rebuild-kills.ts` and `rebuild-sessions.ts` import `drizzle-orm`,
  which was not a root dependency and does not resolve from the repo root
  under pnpm's strict layout — both scripts would have failed at startup with
  `ERR_MODULE_NOT_FOUND`. Fixed by adding the dependency.

### Notes

- ⚠️ The production guard runs both ways, unlike `pnpm wipe` / `pnpm launch`:
  `--production` is required to apply to `factions_live` and refused against
  any other database, so the flag cannot be carried by muscle memory onto a
  database it did not mean.
- ⚠️ It refuses outright when `drizzle.__drizzle_migrations` disagrees with
  the journal. The postgres-js migrator applies every entry whose `when` is
  newer than the newest `created_at` — comparing timestamps, not names — so a
  table ever filled in by hand replays old migrations against live data,
  silently. That case is now a unit test instead of a runbook paragraph.
- No player-facing change, no runtime change to the bot or the site, and no
  migration of its own — nothing needs deploying to use this release.
- Runbook: `docs/deploy/2026-09-14-db-migrate.md`.

## [1.10.0] - 2026-09-13

### Added

- Single-instance enforcement: the bot takes a Postgres session-scoped
  advisory lock before it opens a pool, logs in, or registers commands. A
  second process prints one line and exits 0 — deliberate, so
  `Restart=on-failure` leaves it exited instead of restart-looping every
  interval. Session-scoped, so a SIGKILLed or power-lost bot releases the
  lock on connection death: no TTL, no stale holder to clear by hand.
  Two things already depended on this invariant without enforcing it: the
  notifier is at-least-once across processes — a verified player was DM'd
  twice on 2026-09-01 after a `pkill` pattern missed a stale process — and
  `/found` keeps its draft in memory, because ten 17-character participant
  ids do not fit in a 100-character `custom_id`, so two processes could lose
  a player's founding choices between their select menu and their modal.

### Changed

- Crash logs no longer print request bodies. `unhandledRejection` and
  `uncaughtException` now log through `safeErrorInfo` — Node prints an
  error's own enumerable properties by default, and both drivers attach
  payloads: `@discordjs/rest` carries `requestBody.json` (for `/vault
  reveal`, a clan's lock code) and `url` (an interaction token); postgres.js
  carries `.query` and `.parameters`, and `/vault add` submits a code as a
  bound parameter. The diagnosis still reaches the journal.

### Fixed

- `idOf` no longer coerces. `Number("9e2")` is `900` and passed
  `Number.isInteger`, so it was a valid row id on all sixteen call sites that
  bridge a slash option to a roster row — every `lock:`, `pin:`, `invite:`,
  `request:` and `pass:`. Now matches `DECIMAL_RE`, the house rule it broke.
  No privilege escalation: the roster re-derives permission and answers
  "gone" for a row that isn't yours.

### Notes

- ⚠️ Operationally new: hand-starting a second bot no longer works. That is
  the feature. To hand a running bot's job to a new one, stop the old one
  first — `systemctl restart` is unaffected, since systemd waits for the stop
  and the lock releases after `client.destroy()`.
- ⚠️ The process still exits on a crash. Sanitising the log does not make the
  bot survive states it previously died in.
- No new player-facing behaviour; no migration.
- Runbook: `docs/deploy/2026-09-14-single-instance-lock.md`.
## [1.9.0] - 2026-09-13

### Added

- Discord command parity is complete: everything a player can do on the site,
  they can now do in Discord. `/vault list|add|edit|reveal|confirm|delete|
  rotate`, `/map pins|pin|unpin|view`, and the read-only group `/scoreboard
  /alphas /seasons /warlog /player /board /achievements`.
- A shared embed budget that counts the "+N more" line against Discord's
  6000-character cap, closing the gap plan 2 left open. A router that can
  open a modal from a slash command, and update a select menu in place
  instead of stacking a new card per interaction.
- Scoring, stats and achievement wording moved from `apps/web/lib` into
  `@factions/copy`, byte-identical, with the web files re-exporting — the
  site renders exactly what it rendered before; no web redeploy needed.

### Fixed

- A lock code could reach an operator log: `@discordjs/rest` attaches the
  failed request body to the errors it throws, and the router's `editReply`
  sat outside its own try/catch, so a rate limit on a `/vault reveal` reply
  could carry the code into `console.error`. Sanitised at both logging sites.
- `/alphas` failed outright on a week nobody scored — Discord rejects an
  empty embed field and the roster emits every closed week, empty ones
  included.
- `/board` never printed the season it resolved to, so a fumbled scope could
  silently return a different season's numbers.

### Notes

- ⚠️ `/unlink`, `/whoami` and `/faction` are gone the instant the bot
  restarts. Registration is one PUT that replaces the whole command list, so
  there is no transition period — the stubs stop existing at the same moment
  the nine new commands appear.
- `apps/bot/test/parity.test.ts`'s `PENDING` list is empty, and the suite
  re-checks that on every run — a new write in `@factions/roster` with no
  command now fails the build.
- No migration. `apps/bot` only in effect — do not run `deploy-web.sh`.
- Runbook: `docs/deploy/2026-09-13-discord-commands-3.md`.

## [1.8.0] - 2026-09-13

### Added

- Discord clan commands: plan 2 of the command-parity work. Every clan-side
  write the website supports can now be made from Discord, over the same
  `@factions/roster` layer, with every player-facing sentence coming from
  `@factions/copy` so an outcome cannot be covered on one surface and missing
  on the other. New commands: `/me` (show, accept, decline, withdraw),
  `/roster` (invite, revoke, decide, kick, promote, demote, transfer), `/clan`
  (info, leave, rename, recruiting, rebind, disband), `/clans` (list, show,
  join), `/lead` (claim, vote, ballot), `/found` (flag select, crew
  multi-select, name/tag modal), `/guest` (grant, revoke).
- Confirm buttons and modal submits route through a shared handler. The press
  IS the write for disband, transfer, claim-succession and open-vote — the
  slash handler never touches the roster. The router re-checks the presser
  against the actor named in the custom id, and every write re-derives
  eligibility from `@factions/roster` under its own row lock regardless: a
  button is never a permission.

### Fixed

- `/clan info` would have shown a clan's exact base coordinate to a PENDING
  member. `clanForDb` computes `base` for every rank while gating everything
  else, and the website renders no coordinate on that page at all, so nothing
  had needed the gate before. Found by the whole-branch review; now gated on
  full membership.

### Notes

- ⚠️ Behaviour changes for players: `/guest` changes shape, from `/guest
  user:` to `/guest grant user:`, plus a new `/guest revoke pass:`.
  Registration is one PUT, so the change is instant and total — tell officers
  before deploying. `/guest` also no longer has to be run in the clan's
  channel; the clan is derived from the actor's own membership.
- The retired stubs `/unlink`, `/whoami` and `/faction` stay registered and
  still answer with a site pointer; they are removed in plan 3, along with
  `/vault` and `/map`.
- No migration. `apps/bot` only — do not run `deploy-web.sh`.
- Runbook: `docs/deploy/2026-09-13-discord-commands-2.md`.

## [1.7.1] - 2026-09-13

### Fixed

- v1.7.0 shipped a broken web image. `packages/copy/src/vault.ts` imported
  `VAULT_NAME_MAX` and `VAULT_NOTE_MAX` as runtime values from
  `@factions/roster`, and because `src/index.ts` is a barrel, that pulled
  roster's pooled postgres client into the browser bundle of every page
  importing any copy table — `apps/web/lib/link-copy.ts` is imported by
  `link-flow.tsx`, a client component, so Turbopack failed to resolve `fs`,
  `net`, `tls` and `perf_hooks`. The gate went 28/28 green on v1.7.0 and could
  not have caught it: `tsc --noEmit` and vitest both resolve modules the Node
  way, and neither runs a bundler. The failure surfaced inside the web image
  on the production host, mid-deploy; the bot was unaffected, being Node
  rather than a browser bundle, and shipped fine.
- The two constants move to `@factions/domain`, beside `PIN_NOTE_MAX`, where a
  player-facing limit belonged anyway. `vault-store.ts` re-exports them, so
  `@factions/roster`'s pinned export list is unchanged. `@factions/roster`
  becomes a devDependency of `@factions/copy`, every remaining use being
  `import type`.

### Notes

- ⚠️ Do not deploy v1.7.0. `packages/copy/test/leaf.test.ts` is the standing
  guard: it fails on any runtime import of `@factions/roster` from that
  package and names the offending specifiers.
- Deployed to regime: web image rebuilt, bot restarted on the same commit.

## [1.7.0] - 2026-09-13

### Added

- The slash commands come back, as a second front door beside the site: an
  earlier spec had retired every Discord command in favour of
  `dayzclanwars.com`. `/link status|start|cancel|unlink` and `/base
  show|declare|release` return, without giving the bot its own copy of a
  single rule — `@factions/roster`'s 61 capability wrappers move behind
  `makeRoster(getDb, getNow)`, so the bot binds them to its own handle and
  runs the identical code the site runs. `interaction.user.id` is the same
  Discord snowflake the site's session holds, so there is no new credential
  and no impersonation path.
- The six outcome-copy tables move to `@factions/copy`. One table per action,
  read by both surfaces, so an outcome cannot be worded on the site and blank
  in Discord. Autocomplete runs over live rows: characters the log has seen,
  and — for `/base declare` — only poles the actor themselves raised at,
  because a pole coordinate is a raid target and the scoping is a query
  filter, not a post-hoc trim.

### Notes

- ⚠️ Every reply is ephemeral, by construction: the flag is set once at
  `deferReply` and `command-registration.test.ts` asserts it structurally. A
  challenge sequence in a public message is a challenge any reader can
  perform, binding their own UID to someone else's Discord account.
- Three standing guards: `parity.test.ts` accounts for all 70 roster exports
  and fails on a new one nobody classified; the registry bijection forbids a
  command with no handler or a handler no command reaches; and the vocabulary
  scan now walks `packages/copy/src`, with a non-vacuity assertion so it
  cannot silently stop walking.
- The retired stubs for `unlink`, `whoami` and `faction` stay registered and
  still answer with a link — they go when parity is complete, not before.
- ⚠️ This release's web image does not build — see v1.7.1. Do not deploy this
  tag; deploy v1.7.1 instead.
- No migration. Runbook: `docs/deploy/2026-09-13-discord-commands.md`.

## [1.6.0] - 2026-09-12

### Added

- Three combat feeds share one cursor loop. The hit feed groups PvP hits into
  engagements and posts once per burst with a detail line per hit; an
  engagement that ends in a kill is suppressed and its hits are appended to
  the `#kill-feed` embed instead, so a fight never splits across two
  channels. Closing is guarded three ways: the quiet window, a 120s settle
  floor (`RECENT_HIT_WINDOW_S`, so a late "finished" death cannot claim an
  already-posted burst), and the kills-projector cursor as the frontier
  rather than the wall clock. The killstreak feed posts every
  `KILLSTREAK_EVERY` kills on a hot hand; friendly fire neither advances nor
  breaks a streak, PvE deaths do not reset one, and streaks are not
  season-scoped. The long-range feed posts a season rank capped at 10th; a
  null distance is skipped, never read as zero. `cursor-feed.ts` holds the
  post-then-advance loop all four feeds share, with a render that may decline
  an item and still advance the cursor; `kill-feed-tick.ts` folded onto it
  with its tests unedited.
- Daily truck wipe: event-spawned trucks are cleared once a day, riding the
  restart slots that already exist rather than a new tick. ⚠️
  Level-triggered, not edge-triggered — every slot recomputes the state the
  server should boot into, so a lost write self-heals at the next restart
  instead of leaving the trucks gone for a full day.
- Weekly vehicle rotation: a Monday 08:00Z wipe of one of five vehicles,
  rotating weekly and derived from the calendar rather than a stored
  pointer, announced to Discord 24h ahead (`vehicle_wipe_announcements`,
  migration 0033).

### Notes

- ⚠️ The cursor watermark took four fix rounds. Emitting an engagement whose
  `lastEventId` sits above another's `firstEventId` buries that one's early
  hits below the cursor forever. The rule is a fixed point — emit the largest
  safe prefix, with the batch limit applied inside the loop and a liveness
  fallback that deliberately exceeds the limit rather than stall, since
  nested spans admit no smaller safe set. Verified against an exhaustive
  subset search over 200k configurations.
- ⚠️ Migration 0034 is additive but must be applied by hand; nothing here
  migrates at startup. It creates two indexes on `events` NOT concurrently,
  briefly locking writes on the largest table. Skipping it fails silently — a
  seq scan per tick with nothing logged.
- ⚠️ Known gap: the hit feed's frontier is global, not per-server. Latent
  with one registered server; close it before a second is added.
- Runbook: `docs/deploy/2026-09-12-combat-feeds.md`.

## [1.5.0] - 2026-09-12

### Added

- Achievement badges on every surface: the design hand-off's 150 PNGs and 50
  glyphs wired into the wall, the owner's unlock toasts, the Discord unlock
  card and a 1200x630 share card. `ACHIEVEMENT_GROUP_COLORS` in
  `@factions/domain` is the one statement of the four group colours. The 104
  historical unlocks were announced to `#achievements` in earned order by
  `scripts/backfill-achievement-notices.ts`.
- Scheduled restarts: the bot restarts the server at the top of every even
  UTC hour through Nitrado, behind `RESTART_SCHEDULE`, recording one
  `server_restarts` row per server per slot. `messages.xml` keeps its own
  countdown. Migration 0032 is additive.

### Notes

- Runbook: `docs/deploy/2026-09-12-scheduled-restarts.md`.

