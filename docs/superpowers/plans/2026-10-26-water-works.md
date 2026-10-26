# Water Works and Community Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two new well-rebuilding achievements, plus a 7-day plate carrier award for every well a player roofs, held for unlinked players until they link.

**Architecture:** A "well" is a laid `well_brick` `base.built` event; rubble and roofs attach to a well by 2D distance. The achievements are ordinary PvE rules over `events`. The plate carriers are a new owed-record table, `well_awards`, filled and paid by a new bot tick shaped like `payBountyAwards`.

**Tech Stack:** TypeScript, drizzle-orm over postgres.js, vitest, discord.js bot ticks.

**Spec:** `docs/superpowers/specs/2026-10-26-water-works-design.md`

## Global Constraints

- Part names, exact: brick `well_brick`; roof `roof` (exact match, never `roof1`–`roof3` or `level_N_roof`); rubble `/^rubble_/` (`RUIN_RUBBLE_RE`).
- `WELL_RADIUS_M = 5`, 2D distance on `payload.pos.x`/`payload.pos.z`, same `server_id` only.
- Award: `plate-carrier`, `durationDays` 7 (pass `durationDays: 7` explicitly), reason exactly `"Rebuilt a well"`.
- Once per player (`dayz_id`) per well, for good. A rebuilt well is the SAME well.
- No coordinate in rule evidence, award reasons, notices or feed rows.
- Gate the payout tick on `WELL_AWARD_TICK` (`1`/`true`), off by default. It needs no channel.
- Run the full gate locally: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5440/factions" npx turbo run typecheck test --concurrency=1 --force`. Use port 5440, a throwaway postgres:16; 5434 belongs to another project on this machine. Expect 32/32 tasks.
- Player-facing copy: plain voice (CHANGELOG, descriptions).

## Review Focus

1. **Two wells in one village.** A brick 6 m from another well's brick is a separate well. Its roof pays separately, and its rubble is credited only to the well it's near. Tests: Task 2 and Task 4.
2. **A well rebuilt after decay.** A new `well_brick` 1–3 m from the old one resolves to the same well, so the same player's second roof records nothing. Test: Task 4.
3. **Rubble before the brick.** A clears the rubble on Monday and B lays the brick on Wednesday. A's Community Service carries Wednesday's date, and A is re-evaluated on B's event even if A never plays again. Tests: Task 2 and Task 3.
4. **A house beside a well.** `rubble_rubble2` or `roof1` within 5 m of a well brick: rubble counts (any `rubble_` part), but `roof1` never counts as the well's roof. Test: Task 2.
5. **Crash or retry mid-payout.** Grant and `award_grant_id` commit together, so re-running the tick never pays twice. Test: Task 4.

---

### Task 1: Define the two achievements, the radius, and the badge art

**Files:**
- Modify: `packages/domain/src/achievements.ts` (two `def`s after `fixer_upper`)
- Modify: `packages/domain/src/achievement-evidence.ts` (well part constants, next to `RUIN_RUBBLE_RE`)
- Modify: `packages/domain/src/rules.ts` (`WELL_RADIUS_M`)
- Modify: `packages/domain/test/achievements.test.ts` (153→155, 150→152)
- Create: `apps/web/public/achievements/svg/{community_service,water_works}.svg`, plus their `unlocked/` and `locked/` PNGs
- Modify: `apps/web/lib/achievement-glyphs.ts` (regenerated)

**Interfaces:**
- Produces: keys `"community_service"` and `"water_works"`. Exports from `@factions/domain`: `WELL_RADIUS_M = 5`, `WELL_BRICK_PART = "well_brick"`, `WELL_ROOF_PART = "roof"`.

- [ ] **Step 1: Update the count tests.** In `packages/domain/test/achievements.test.ts`, change 153→155 and 150→152. Add a test that `ACHIEVEMENT_BY_KEY.community_service` and `.water_works` are `{ group: "pve", owner: "player", target: 1, unit: "count" }`, and that neither appears in `ACHIEVEMENTS_2026_10`, since that list is frozen.
- [ ] **Step 2: Run the domain tests and confirm they fail.** Run `pnpm --filter @factions/domain test`. Expected: FAIL on the length.
- [ ] **Step 3: Add the definitions.** Add `def("community_service", "Community Service", "Help rebuild a ruined well", "pve")` and `def("water_works", "Water Works", "Put the roof on a rebuilt well", "pve")`, plus the constants. `WELL_RADIUS_M` gets a ⚠️ comment: the observed wells keep all three steps within ~3 m, and a bigger radius merges neighbouring wells.
- [ ] **Step 4: Draw the badges.** Draw two SVGs in the existing style (pve `#8fa36a`, the shield path as in `rubble_rouser.svg`): a hand pump or bucket for Community Service, a well with a roof for Water Works. Then run `pnpm --filter @factions/web achievements:png` and `pnpm --filter @factions/web prebuild`.
- [ ] **Step 5: Run the domain and web tests and confirm they pass.** Run `pnpm --filter @factions/domain test && pnpm --filter @factions/web test`. Expected: PASS. Fix any other test pinned to a count of 150 or 153; find them with `grep -rn "\b15[03]\b" apps packages --include=*.test.ts`.
- [ ] **Step 6: Commit.** Message: `feat: Community Service and Water Works achievement definitions`.

### Task 2: The two rules

**Files:**
- Create: `apps/bot/src/wells.ts`
- Modify: `apps/bot/src/achievements/rules-pve.ts`
- Test: `apps/bot/test/achievements/rules-pve.test.ts` (new `describe` block "wells")

**Interfaces:**
- Consumes: Task 1's constants.
- Produces, in `apps/bot/src/wells.ts`:
  - `type WellStep = { id: number; at: Date; serverId: number; dayzId: string; part: string; x: number; z: number }`
  - `wellStepsOf(db: Database, dayzId: string): Promise<WellStep[]>`: the owner's `base.built` events whose part is `well_brick`, `roof`, or matches `^rubble_`, in ascending time.
  - `bricksNear(db: Database, serverId: number, x: number, z: number): Promise<{ id: number; at: Date }[]>`: every `well_brick` event on that server within `WELL_RADIUS_M`, in ascending time.
  - `wellAnchor(bricks: { id: number; at: Date }[]): number`: the id of the earliest brick. **This is a well's identity**, and Task 4 relies on it.

  Compute distance in SQL: `sqrt(power((payload->'pos'->>'x')::float - $x, 2) + power((payload->'pos'->>'z')::float - $z, 2)) <= WELL_RADIUS_M`.

- [ ] **Step 1: Write the failing tests.** Seed with `seedEvent` and the payload shape `{ dayzId, gamertag, part, tool, structure: null, pos: { x, y, z } }`. Use A and B as in the file. The well is at (1000, 1000):
  - `community_service: rubble by A then brick by B; both earn it at the brick's time`. A's result is `{ count: 1, earnedAt: brick.at }` and B's is `{ count: 1, earnedAt: brick.at }`.
  - `community_service: rubble with no brick anywhere earns nothing`. Count 0.
  - `community_service: rubble 6 m from the brick earns nothing; 4 m does`.
  - `community_service: rubble after the brick earns it at the rubble's time`.
  - `community_service: the roof-builder earns it at the roof`. C only builds the roof, and C earns it at `roof.at`.
  - `water_works: a roof within 5 m of an earlier brick earns it at the roof`. Expect `{ count: 1, earnedAt: roof.at, evidenceId: roof.id }`.
  - `water_works: roof1 beside a well, or a roof with no brick, earns nothing`.
  - `water_works: a roof built before any brick earns nothing`.
  - `evidence carries no coordinate`. `JSON.stringify(result.evidence)` contains neither `"1000"` nor the keys `x` and `z`.
- [ ] **Step 2: Run the tests and confirm they fail.** Run `pnpm --filter @factions/bot exec vitest run test/achievements/rules-pve.test.ts -t wells`. Expected: FAIL, no rule.
- [ ] **Step 3: Implement both rules** in `PVE_RULES`, using `wells.ts`. Memoise `wellStepsOf` through `ctx.memo("wells:"+id, …)` so both rules share one read.
  - **Community Service:** for each step, `credit = max(step.at, firstBrickNear.at)` when a brick exists within radius. Earn at the minimum credit, with `oneShot` evidence `{ part }`.
  - **Water Works:** the first `roof` step that has a brick within radius with `at <= roof.at`.
- [ ] **Step 4: Run the tests and confirm they pass.** Run `rules-pve.test.ts` and `rules.test.ts`. Expected: PASS; `rules.test.ts` holds that every key has a rule.
- [ ] **Step 5: Commit.** Message: `feat: well rules for Community Service and Water Works`.

### Task 3: Re-evaluate rubble-clearers when a brick lands

**Files:**
- Modify: `apps/bot/src/achievements/touched.ts` (the `events` loop in `collectTouched`)
- Test: `apps/bot/test/achievements/touched.test.ts`

**Interfaces:**
- Consumes: Task 1's `WELL_RADIUS_M` and `WELL_BRICK_PART`.

- [ ] **Step 1: Write the failing test.** `collectTouched: a well_brick also touches everyone who cleared rubble within 5 m on that server`. Seed A's rubble at (1000,1000), then set the watermark past it. Seed D's rubble 50 m away, and E's rubble at the same spot on another server. Then seed B's brick at (1001,1000). `owners` includes A and B, and excludes D and E.
- [ ] **Step 2: Run the test and confirm it fails.** Run `vitest run test/achievements/touched.test.ts`. Expected: FAIL, A is missing.
- [ ] **Step 3: Implement it.** Add a `rubbleNear` column to the existing events select, the same way the `clans` column already works: `case when part = 'well_brick' then (select array_agg(distinct payload->>'dayzId') from events r where r.server_id = e.server_id and r.type = 'base.built' and r.payload->>'part' ~ '^rubble_' and <distance ≤ WELL_RADIUS_M>) end`. Then `add(player(id))` for each. Add a comment on why: Community Service is earned by someone with no new event of their own.
- [ ] **Step 4: Run the tests and confirm they pass.** Run `touched.test.ts` and `tick.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** Message: `feat: a laid well brick re-evaluates its rubble-clearers`.

### Task 4: `well_awards` and the payout tick

**Files:**
- Modify: `packages/db/src/schema.ts` (new `wellAwards` table beside `bounties`)
- Create: `packages/db/migrations/0072_*.sql` plus its meta, via `cd packages/db && npx drizzle-kit generate`. Read the SQL before committing.
- Create: `apps/bot/src/well-award-tick.ts`
- Test: `apps/bot/test/well-award-tick.test.ts`
- Modify: `CLAUDE.md` (lock order: insert `well_awards` before `award_grants`, plus a paragraph like the `bounties` one)

**Interfaces:**
- Consumes: Task 2's `bricksNear` and `wellAnchor`, and `grantAwardTx` from `@factions/roster/internal` (signature in `packages/roster/src/internal/award-admin.ts:73`).
- Produces:
  - **Table `well_awards`:** `id bigserial pk`, `server_id int not null fk servers`, `dayz_id text not null`, `well_brick_event_id bigint not null` (the anchor), `roof_event_id bigint not null fk events`, `roofed_at timestamptz not null`, `award_grant_id bigint null fk award_grants`, `award_failure text null`, `created_at timestamptz default now()`.
  - **Constraint:** unique `well_awards_player_well_uq (dayz_id, well_brick_event_id)`. ⚠️ This constraint is the only thing stopping a second payment, so comment it that way.
  - `wellAwardTick(db: Database, opts: { now: Date; siteBaseUrl: string; grantedByDiscordId: string }): Promise<{ recorded: number; paid: number }>`
  - `WELL_AWARD_CONSUMER = "well-award-consumer"`, a cursor in `consumer_cursors` over `events.id`.

- [ ] **Step 1: Write the failing tests** in `well-award-tick.test.ts`, using `seedEvent`, `seedLink` and `seedServer`. Use the bounty-tick tests as the model for setup and the awards catalogue.
  - `records and pays a linked roof-builder one plate-carrier for 7 days, reason "Rebuilt a well"`. One `award_grants` row with `{ awardKey: "plate-carrier", durationDays: 7, reason: "Rebuilt a well" }`, and the `well_awards` row's `award_grant_id` is set.
  - `an unlinked roof-builder is owed, not paid, and is paid the tick after linking`. The first run gives `{ recorded: 1, paid: 0 }`. Then `seedLink`, and the second run gives `{ recorded: 0, paid: 1 }`.
  - `the same player roofing the same well after a rebuild (new brick 2 m away) is not paid again`. One grant in total.
  - `a different player roofing that same well later is paid`. Two grants.
  - `two wells 6 m apart are two wells: one player roofing both gets two plate carriers`.
  - `a roof with no brick within 5 m records nothing`.
  - `re-running the tick, or rewinding the cursor to 0, pays nothing more`.
  - `plate-carrier missing from the catalogue sets award_failure once and stops retrying`. Stub the catalogue the way the bounty tests do.
- [ ] **Step 2: Run the tests and confirm they fail.** Run `vitest run test/well-award-tick.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Add the schema and generate the migration.** Run `npx drizzle-kit generate` and check that the SQL is only the create table, the FKs and the unique index.
- [ ] **Step 4: Implement `wellAwardTick`.** It does two things:
  - **(a) Record.** Read `base.built` events with `part = 'roof'` past the cursor, in id order. For each one, find the bricks near it with `at <= roof.at`. If there are any, `insert … on conflict do nothing` with the anchor `wellAnchor(bricksNear(...))`, taken over all bricks near the *matched* brick so a rebuild resolves to the original. Advance the cursor in the same transaction.
  - **(b) Pay.** Mirror `payBountyAwards` line for line: an inner join to `identity_links`; `FOR UPDATE` on the row; `FOR SHARE` on the link; a catalogue check that writes `award_failure`; `grantAwardTx` with `{ awardKey: "plate-carrier", durationDays: 7, reason: "Rebuilt a well", serverId: row.serverId }`; throw if the grant is refused; then set `award_grant_id` in the same transaction. Isolate failures per row.
- [ ] **Step 5: Run the tests and confirm they pass.** Run `well-award-tick.test.ts` and the db package tests. Expected: PASS.
- [ ] **Step 6: Commit.** Message: `feat: plate carrier for every well a player roofs`.

### Task 5: Wire it in, document it, ship-ready

**Files:**
- Modify: `apps/bot/src/config.ts` (`wellAwards: { enabled: boolean }` from `WELL_AWARD_TICK`, parsed like `BOUNTY_TICK`)
- Modify: `apps/bot/src/discord.ts` (call `wellAwardTick` right after `achievementsTick` with `grantedByDiscordId: client.user.id`, the same as `referralAwardTick`; log when `recorded` or `paid` is non-zero; a startup warn line when it's off)
- Modify: `apps/bot/README.md` (env table row), `CHANGELOG.md` (`[Unreleased]`)
- Create: `docs/deploy/2026-10-26-water-works.md`
- Test: `apps/bot/test/config.test.ts`

- [ ] **Step 1: Write the failing test.** In `config.test.ts`: `WELL_AWARD_TICK=true enables wellAwards; unset is off`.
- [ ] **Step 2: Run the test and confirm it fails.** Expected: FAIL.
- [ ] **Step 3: Implement the config and the `discord.ts` call.** Put it inside the same `try/catch` shape the neighbouring ticks use.
- [ ] **Step 4: Write the CHANGELOG entry and the runbook.** CHANGELOG (copy verbatim): "- Two new achievements for rebuilding ruined wells. **Community Service** goes to everyone who clears a well's rubble, lays its bricks or builds its roof. **Water Works** goes to whoever puts the roof on. Every well you roof also earns you a Plate Carrier award for 7 days, once per well. If you haven't linked yet, it waits for you until you do." The runbook covers:
  - the migration is automatic on release;
  - set `WELL_AWARD_TICK=true` in `.env` and restart the bot;
  - the first tick scans all history, so expect `recorded: 2, paid: 1` (RonaldRaygun552 is paid; helifighter06 is held until they link);
  - the past achievement unlocks arrive through the live achievements tick the next time each player is touched (any build or session close), announced normally, with no backfill run;
  - a read-only check: `select dayz_id, award_grant_id from well_awards`.
- [ ] **Step 5: Run the full gate.** Run the command from Global Constraints. Expected: 32/32 tasks, all passing.
- [ ] **Step 6: Commit.** Message: `feat: run the well award tick behind WELL_AWARD_TICK`.
