# Raid Value Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raids pay the victim's live value (heat up, hits down, ×1.5 online / ×0.75 offline), old flags count anywhere, the window runs Fri 14:00 → Sun 14:00 UTC, season 3 is rescored, the week's top clan's leader gets a weapon kit, and #scoreboard shows every clan's price.

**Architecture:** The value rule is one pure function in `packages/domain` over the season's raid rows (no stored running value). `raid-tick` calls it at write time, the rescore script calls it in replay, and the scoreboard read calls it for "now". The scoring-week calendar becomes a domain function with a hard cutover at Sun 2026-11-08 14:00 UTC. Every week consumer (raid rows, week close, alpha list, show) goes through it.

**Tech Stack:** TypeScript, vitest, drizzle-orm over postgres.js, discord.js, Next.js (apps/web).

**Spec:** `docs/superpowers/specs/2026-11-06-raid-value-scoring-design.md`. Read it before starting any task. It holds the why, and every decision here argues from it.

## Global Constraints

- Ships 2026-11-06, one PR, one release. Tasks 1–6 are the must-ship core (window, week, value, raids, rescore). Tasks 7–9 follow in the same branch, and the release waits for all nine.
- Every rule number lives in `packages/domain/src/rules.ts` and reaches the guide through `guide-numbers.ts` tokens. No literals in chapters (`apps/web/test/guide.test.ts` enforces it).
- Value constants: `RAID_VALUE_BASE = 100`, `RAID_HEAT = 50`, `RAID_HEAT_FADE_MS = 14 * DAY`, `RAID_HIT_FADE_MS = 7 * DAY`, `NEW_CLAN_WORTHLESS_MS = 7 * DAY`, `RAID_ONLINE_MULT = 1.5`, `RAID_OFFLINE_MULT = 0.75`. Points use `Math.round`.
- `RAID_WINDOW = { openDow: 5, openHour: 14, closeDow: 0, closeHour: 14 }`, UTC, half-open, all year.
- `SCORING_WEEK_CUTOVER = 2026-11-08T14:00:00Z`. Weeks before it are Monday 00:00 → Monday 00:00. The bridging week is Mon 2026-11-02 00:00 → the cutover. After it, Sunday 14:00 → Sunday 14:00.
- `RAID_AWARD_KEY = "weapon-kit"`, `RAID_AWARD_DAYS = 7`, granted to `factions.leader_discord_id`.
- Copy voice: `brand/02-verbal-identity.md` (sibling of the repo, `../brand/`). Plain; never discourage raiding; em dashes allowed.
- No coordinate ever appears in a notice, war-log payload, feed row or embed.
- The house style: comments explain why, and `⚠️` marks silent-failure lines. Follow CLAUDE.md's lock order. New tables get a place in it (Task 7).
- The gate: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`, expect 32/32. Never point anything at `factions_live` except the Task 6 script on the prod host.

## Review Focus

1. **Deploying mid-window** (Friday 2026-11-06, window open since 00:00). The new `boundaryAt` is Fri 14:00, so the tick posts one fresh "RAID WINDOW OPEN, closes Sunday 14:00" line. That's wanted: it corrects the announced close. It must not post a "close" or flip base damage off. Task 1 tests the instant 2026-11-06T18:00Z.
2. **One lowering, one raid.** A third clan lowering X's flag on Y's base scores on Y only. A Y member lowering a white flag on Y's base is upkeep. Task 5 tests both.
3. **The value must not count the raid being priced.** A raid's own row is excluded from its own value, including in the rescore replay, where all rows already exist. Task 3 and Task 6 test it.
4. **The scoreboard's price must equal the next raid's payout.** Both call `raidPoints(clanValue(...), online)` from the same facts. Task 8 tests that the post's number equals `raidPoints` for the fixture clan.
5. **The bridging week closes once, at Sun 2026-11-08 14:00, and pays one kit.** Not at Monday 00:00, and not twice: the week-close high-water mark and the award row both key on the Monday 2026-11-02 week start. Tasks 2 and 7 test it.

---

### Task 1: The raid window moves to Fri 14:00 → Sun 14:00 UTC

**Files:**
- Modify: `packages/domain/src/rules.ts` (`RAID_WINDOW`), `packages/domain/src/raid-window.ts` (`raidWindowAt`), `docs/deploy/raid-window.md`, `packages/domain/test/raid-window-runbook.test.ts`, `packages/domain/src/guide-numbers.ts` (`RAID_WINDOW` string → `"Fri 14:00 → Sun 14:00 UTC"`)
- Test: `packages/domain/test/raid-window.test.ts`

**Interfaces:**
- Produces: `RAID_WINDOW: { openDow: 5; openHour: 14; closeDow: 0; closeHour: 14 }`. `raidWindowAt(when, skips)` keeps its signature and `RaidWindowState`. The KotH guard and restart tick need no change.

- [ ] **Step 1: Failing tests** in `raid-window.test.ts` (update existing Monday-based cases to the new boundaries):
  - `2026-11-13T13:59:59Z` → phase `closed`, `opensAt` = `2026-11-13T14:00Z`.
  - `2026-11-13T14:00:00Z` → `open`, `closesAt` = `2026-11-15T14:00Z`, `boundaryAt` = opensAt.
  - `2026-11-15T13:59:59Z` → `open`. `2026-11-15T14:00:00Z` → `closed`, `boundaryAt` = `2026-11-15T14:00Z`, `opensAt` = `2026-11-20T14:00Z`.
  - **Deploy instant** `2026-11-06T18:00:00Z` → `open`, `opensAt` `2026-11-06T14:00Z`, `closesAt` `2026-11-08T14:00Z`.
  - A skip whose `opensAt` is `2026-11-13T14:00Z` → `skipped` at `2026-11-14T00:00Z`.
- [ ] **Step 2:** Run `npx vitest run test/raid-window.test.ts` in `packages/domain`. Expect FAIL.
- [ ] **Step 3:** Implement. Replace `lastMidnightOn` with the most recent `openDow`@`openHour`:00 at or before `when`. `closeOfLast` = that + `((closeDow - openDow + 7) % 7) * DAY + (closeHour - openHour) * HOUR`. Keep the half-open and boundary comments, updated.
- [ ] **Step 4:** Update the runbook: every "Friday 00:00 UTC" → "Friday 14:00 UTC", "Monday 00:00 UTC" → "Sunday 14:00 UTC", in the table rows and prose. Update the test to build strings from `${DAY_NAMES[dow]} ${String(hour).padStart(2,"0")}:00 UTC`. Add a dated note that the 2026-11-06 weekend closed early at Sunday 14:00 by owner decision.
- [ ] **Step 5:** Run `packages/domain` tests. Expect PASS. Also run `apps/bot` `restart-tick`, `raid-window-tick` and `koth*` tests, and fix any fixtures that hard-code Monday 00:00.
- [ ] **Step 6: Commit** `feat(raid-window): Fri 14:00 → Sun 14:00 UTC`.

### Task 2: The scoring-week calendar with the 2026-11-08 cutover

**Files:**
- Create: `packages/domain/src/scoring-week.ts` (export from `index.ts`)
- Modify: `packages/domain/src/rules.ts` (`SCORING_WEEK_CUTOVER`), `apps/bot/src/raid-tick.ts` (`weekStart:`), `apps/bot/src/week-tick.ts` (`nextWeek` → `scoringWeekEnd`, the first week via `scoringWeekStartOf`), `packages/roster/src/scoring.ts` (`alphasDb` loop), `apps/show/src/weeks.ts`, `packages/domain/src/guide-numbers.ts` (`ALPHA_WEEK` → `"Sun 14:00 → Sun 14:00 UTC"`)
- Test: `packages/domain/test/scoring-week.test.ts`, `apps/bot/test/week-tick.test.ts`, `apps/show/test/weeks.test.ts`

**Interfaces:**
- Produces: `scoringWeekStartOf(d: Date): Date` and `scoringWeekEnd(weekStart: Date): Date`.
  - Before the cutover, `scoringWeekStartOf` returns `weekStartOf(d)` (Monday 00:00). From the cutover on, it returns the latest Sunday 14:00 UTC ≤ `d`.
  - `scoringWeekEnd(w)` = `w < CUTOVER ? min(w + 7d, CUTOVER) : w + 7d`.
- `weekStartOf` stays (other callers). Nothing new may call it for scoring.

- [ ] **Step 1: Failing tests** in `scoring-week.test.ts`:
  - `scoringWeekStartOf(2026-10-28T12:00Z)` = `2026-10-26T00:00Z`.
  - `scoringWeekStartOf(2026-11-08T13:59:59Z)` = `2026-11-02T00:00Z`. `scoringWeekStartOf(2026-11-08T14:00Z)` = `2026-11-08T14:00Z`.
  - `scoringWeekStartOf(2026-11-15T13:00Z)` = `2026-11-08T14:00Z`.
  - `scoringWeekEnd(2026-10-26T00:00Z)` = `2026-11-02T00:00Z`. `scoringWeekEnd(2026-11-02T00:00Z)` = `2026-11-08T14:00Z`. `scoringWeekEnd(2026-11-08T14:00Z)` = `2026-11-15T14:00Z`.
  - Walking `w = scoringWeekEnd(w)` from `2026-10-12T00:00Z` hits exactly `[10-12, 10-19, 10-26, 11-02, 11-08T14, 11-15T14]`.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement `scoring-week.ts`.
- [ ] **Step 4:** Rewire the callers.
  - **week-tick:** in `closeWeeksTx`, the loop condition is `scoringWeekEnd(w) <= now`. `week_closed`'s `occurredAt` is `scoringWeekEnd(thisWeek)`.
  - **raid-tick:** `weekStart: scoringWeekStartOf(ev.occurredAt)`.
  - **alphasDb:** walk with `scoringWeekEnd`.
  - **show `weekWindow(ws)`:** accept `ws` iff `scoringWeekStartOf(ws) === ws`, and return `{from: ws, to: scoringWeekEnd(ws)}`.
  - **show `episodeNumber`:** count steps of `scoringWeekEnd` from `scoringWeekStartOf(seasonStartedAt)`.
  - **show `lastEndedWeek(now)`:** walk back from `scoringWeekStartOf(now)` one step. A helper `previousScoringWeek(w)` in `scoring-week.ts` is fine, with a test: `previousScoringWeek(2026-11-08T14:00Z)` = `2026-11-02T00:00Z`.
  - **show `parseWeekArg`:** resolve via `scoringWeekStartOf`.
  - Fix the comments that say "Monday".
- [ ] **Step 5: Week-tick test.** A season started 2026-10-17T23:08:54Z with `week_closed_through` = 2026-10-26.
  - `weekTick` at `2026-11-08T13:59Z` closes nothing.
  - At `2026-11-08T14:00Z` it closes 2026-11-02 exactly once (`alpha_weeks.week_start` = 2026-11-02, war-log `occurredAt` = 2026-11-08T14:00Z).
  - At `2026-11-15T14:00Z` it closes `2026-11-08T14:00Z`.
- [ ] **Step 6:** Run `packages/domain`, `apps/bot` (week-tick, raid-tick, standings, wipe), `packages/roster` (scoring) and `apps/show` (weeks) tests. Expect PASS.
- [ ] **Step 7: Commit** `feat(scoring): Sunday 14:00 scoring week with the 2026-11-08 cutover`.

### Task 3: The pure value rule

**Files:**
- Create: `packages/domain/src/raid-value.ts` (export from `index.ts`)
- Modify: `packages/domain/src/rules.ts` (the seven constants above). Don't remove `POINTS_*` / `pointsFor` yet (Task 9).
- Test: `packages/domain/test/raid-value.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type RaidFact = { id: number; at: Date; raiderFactionId: number | null; victimFactionId: number };
  export type ValuedClan = { id: number; activatedAt: Date };
  /** Value of `clan` at `at`, from season facts strictly before `at` (and never `excludeRaidId`). */
  export function clanValue(clan: ValuedClan, facts: RaidFact[], at: Date, excludeRaidId?: number): number;
  export function raidPoints(value: number, online: boolean): number;            // Math.round(value × mult)
  export type ValueReasons = { recentRaids: number; hitsThisWeek: number; newUntil: Date | null };
  export function valueReasons(clan: ValuedClan, facts: RaidFact[], at: Date): ValueReasons;
  ```
- The rule:
  - **Heat:** counts facts with `raiderFactionId === clan.id`, 0 ≤ at−f.at < `RAID_HEAT_FADE_MS`, each `RAID_HEAT·(1−Δ/fade)`.
  - **Hits:** count facts with `victimFactionId === clan.id && raiderFactionId !== null`, 0 ≤ Δ < `RAID_HIT_FADE_MS`, each a factor of `0.5+0.5·Δ/fade`.
  - **New clan:** 0 if `at < activatedAt + NEW_CLAN_WORTHLESS_MS`.
  - "Strictly before" means `f.at < at`, or `f.at === at && f.id < excludeRaidId`. The rescore passes the row's own id.
- `valueReasons`:
  - `recentRaids` = the heat-window count.
  - `hitsThisWeek` = the hit-window count.
  - `newUntil` = `activatedAt + NEW_CLAN_WORTHLESS_MS` when that's still in the future, else null.

- [ ] **Step 1: Failing tests:**
  - A new clan at activatedAt + 6d 23h → 0.
  - A lone clan → 100.
  - One raid landed 7d ago → 125.
  - Hit 3.5d ago → 75.
  - Two hits right now → 25.
  - A solo hit (`raiderFactionId: null`) → no change.
  - `raidPoints(100, true)` = 150, `raidPoints(100, false)` = 75.
  - **The production fixture:** a `test/fixtures/season3-raids.ts` holding the 19 rows below, with activations `VOLK 2026-09-08T23:46:10Z, SKULL 2026-09-17T21:21:40Z, COCK 2026-09-15T00:10:06Z, Z2 2026-09-19T02:04:09Z, WOOKI 2026-09-26T20:27:03Z, MMBA 2026-10-20T23:26:35Z, OUT 2026-10-24T20:34:25Z, NDF 2026-10-29T22:23:06Z`. Replay in order: each row's points = `raidPoints(clanValue(victim, facts, at, id), online)`, and they must equal:

    | at (UTC) | raider→victim | online | points |
    |---|---|---|---|
    | 10-19 21:50:52 | COCK→VOLK | n | 75 |
    | 10-21 19:34:39 | COCK→MMBA | y | 0 |
    | 10-24 03:10:53 | COCK→SKULL | n | 75 |
    | 10-27 23:07:36 | COCK→OUT | n | 0 |
    | 10-28 00:05:35 | Z2→WOOKI | y | 150 |
    | 10-28 01:05:00 | Z2→SKULL | n | 58 |
    | 10-29 11:26:36 | Z2→COCK | n | 160 |
    | 10-30 01:35:36 | NDF→OUT | n | 0 |
    | 10-30 16:07:13 | Z2→OUT | n | 0 |
    | 10-31 21:45:53 | COCK→MMBA | y | 150 |
    | 11-01 17:00:14 | COCK→NDF | y | 0 |
    | 11-01 18:44:54 | Z2→OUT | n | 29 |
    | 11-01 19:33:08 | Z2→SKULL | n | 63 |
    | 11-01 22:01:47 | NDF→MMBA | n | 43 |
    | 11-01 22:44:59 | Z2→NDF | n | 0 |
    | 11-04 18:44:59 | VOLK→COCK | y | 293 |
    | 11-05 19:43:33 | Z2→OUT | n | 55 |
    | 11-06 01:32:37 | Z2→NDF | y | 155 |
    | 11-06 03:10:07 | NDF→Z2 | n | 290 |

    All dates are 2026. The season totals are Z2 670, NDF 333, COCK 300 and VOLK 293. The values at `2026-11-06T12:00Z` (rounded) are VOLK 144, SKULL 83, COCK 113, Z2 198, WOOKI 100, MMBA 74, OUT 45 and NDF 76. Add one test that runs the replay with every row already in `facts` (passing `excludeRaidId`) and gets the same points.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expect PASS.
- [ ] **Step 5: Commit** `feat(domain): raid value rule`.

### Task 4: Schema for online, away raids, and the award ledger

**Files:**
- Modify: `packages/db/src/schema.ts`, `packages/domain` (`ClanNoticeKind` gains `flag_lowered_away`). Generate `packages/db/migrations/0073_*.sql` with `cd packages/db && npx drizzle-kit generate`, and read the SQL.
- Test: the `packages/db` suite (migrations apply on a fresh `factions_test_db`).

**Interfaces:**
- Produces:
  - `raids.victimOnline: boolean("victim_online").notNull().default(false)`.
  - `raids.away: boolean("away").notNull().default(false)`. True when the raid isn't at the victim's own declared base.
  - `raids.rankedCountAtLower` becomes nullable. New rows write null to both rank columns.
  - `raidAwardWeeks` table `raid_award_weeks`:
    - `season_id` bigint → seasons, `week_start` timestamptz, PK (season_id, week_start).
    - `faction_id` bigint → factions, `leader_discord_id` text not null.
    - `award_grant_id` bigint → award_grants null, `closed_at` timestamptz not null, `detail` jsonb not null default `{}`.
- Additive and defaulted, so no stop-the-bot hazard beyond the normal deploy.

- [ ] **Step 1:** Edit the schema and generate the migration.
- [ ] **Step 2:** Run `packages/db` tests and `typecheck`. Expect PASS.
- [ ] **Step 3: Commit** `feat(db): raids.victim_online/away, raid_award_weeks`.

### Task 5: raid-tick scores by value, detects old flags, and records online

**Files:**
- Create: `apps/bot/src/raid-detect.ts` (pure-ish helpers over a `Tx`, shared with Task 6)
- Modify: `apps/bot/src/raid-tick.ts`, `apps/bot/src/notice-text.ts` and `apps/web/lib/notice-copy.ts` (`flag_lowered_away` copy in both, no coordinates; the two are separate renderers, see CLAUDE.md)
- Test: `apps/bot/test/raid-tick.test.ts`, `apps/bot/test/raid-detect.test.ts`

**Interfaces:**
- Consumes: `clanValue`, `raidPoints`, `RaidFact` (Task 3). `scoringWeekStartOf` (Task 2). `membershipAt` (`apps/bot/src/membership-tick.ts`).
- Produces (`raid-detect.ts`):
  ```ts
  export type LowerVerdict =
    | { kind: "none" }
    | { kind: "raid"; victimFactionId: number; away: boolean };
  /** Who this flag.lowered raids, per spec §2. Reads only; takes no locks. */
  export function classifyLower(tx: Tx, ev: { serverId: number; occurredAt: Date; dayzId: string; poleKey: string; texture: string }): Promise<LowerVerdict>;
  export function seasonRaidFacts(tx: Tx, seasonId: number): Promise<RaidFact[]>;
  export function clanOnlineAt(tx: Tx, serverId: number, factionId: number, at: Date): Promise<boolean>; // full member (membership_history) with an open player_sessions row at `at`
  ```
- `classifyLower` order (spec §2):
  1. **Pole is an `active` clan Y's declared base, lowerer not a full member of Y** → raid on Y, `away: false`.
  2. **Y's base, lowerer is Y's member** → look up the raiser. Raid on X only when the latest `flag.raised` on this server+poleKey+texture at or before the lower was by a full member of X (`membershipAt` at the raise), X ≠ Y, X is `active`, and the texture was X's at the raise (`faction_textures` `from_at ≤ t < coalesce(to_at, ∞)`). Then it's a raid on X, `away: true`. Otherwise `none`.
  3. **Not a declared base** → the same raise lookup. Raid on X if the lowerer isn't X's full member, `away: true`.
  - The raise lookup must use `events_raise_lookup_idx`'s exact payload keys.

- [ ] **Step 1: Failing `raid-detect` tests:**
  - A non-member lowering at Y's base → Y, base.
  - A third clan Z lowering X's flag on Y's base → Y, base (one raid).
  - Y's member lowering X's own flag on Y's base → X, away.
  - Y's member lowering a white flag on Y's base → none.
  - Y's member lowering X's flag that a non-member of X raised → none.
  - A non-member lowering X's own flag at an undeclared pole → X, away.
  - The same, but X's member lowers it → none.
  - The same, but the flag is a white flag raised by X → none.
  - After X rebrands, its OLD texture raised before `to_at` → still X.
  - X dormant → none.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement `raid-detect.ts`, then rewire `raidTick`.
  - Replace the victim lookup with `classifyLower`, then lock the victim's `factions` row `FOR UPDATE` (lock order unchanged).
  - Dedup as today.
  - Points: `raidPoints(clanValue(victim, await seasonRaidFacts(tx, season.id), ev.occurredAt), await clanOnlineAt(...))`, and 0 when the raider is solo.
  - Write `victimOnline`, `away`, and null rank columns.
  - When `away`, don't touch `flagDownSince` and don't queue `flag_down`. Queue `flag_lowered_away` to the victim clan's channel instead, with the payload `{ gamertag, raiderClan }`.
  - The war-log line is unchanged, so away and base raids read the same.
  - Delete the `rankedStandings` call from this path.
- [ ] **Step 4: Update `raid-tick.test.ts`:**
  - Points equal the value rule.
  - An online victim gets ×1.5.
  - An away raid leaves `flag_down_since` null and queues `flag_lowered_away`.
  - A raid's own row is not in its own value.
  - Run with `apps/bot`'s standings and wipe tests. Expect PASS.
- [ ] **Step 5: Commit** `feat(raids): value scoring, online multiplier, old-flag raids`.

### Task 6: Rescore season 3 (retro old-flag raids included) and the runbook

**Files:**
- Create: `scripts/rescore-season.ts` (root `package.json` script `rescore:season`), `docs/deploy/2026-11-06-raid-value.md`
- Test: `apps/bot/test/rescore-season.test.ts`. Put the logic in `apps/bot/src/rescore.ts` so it's testable, and keep the script a thin CLI like `rebuild-standings.ts`.

**Interfaces:**
- Consumes: `classifyLower`, `seasonRaidFacts`, `clanOnlineAt` (Task 5). `clanValue`/`raidPoints` (Task 3). `scoringWeekStartOf` (Task 2). `rebuildStandings` (`apps/bot/src/standings.ts`).
- Produces: `rescoreSeason(db: Database, seasonId: number, opts: { apply: boolean }): Promise<RescoreReport>`, where `RescoreReport = { inserted: RetroRaid[]; rows: { id: number; at: Date; raider: string | null; victim: string; online: boolean; oldPoints: number; newPoints: number }[]; disagreements: string[] }`.

- [ ] **Step 1: Failing test** on a seeded test DB: three existing raid rows, one away-raid `flag.lowered`, sessions making one victim online.
  - `apply: false` writes nothing and reports one insert and the new points.
  - `apply: true` inserts the retro row with `week_start = scoringWeekStartOf(at)`, `away = true`, and no war-log or notice rows.
  - It rewrites `points`/`victim_online` in `(first_lower_at, id)` order, each with `excludeRaidId` = its own id.
  - It leaves `alpha_weeks` and the old `week_start` values untouched.
  - It leaves `season_standings` equal to `rebuildStandings`.
  - Re-running `apply` is a no-op: no duplicate retro row, same points.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3: Implement**, all in one transaction under the season's `seasons` row lock.
  1. Scan the season's `flag.lowered` events in id order. For each lower not covered by an existing raid row's `[first_lower_event_id, last_lower_event_id]` that `classifyLower` calls a raid, honour `RAID_DEDUP_MS` against rows already present or inserted, then insert.
  2. "Declared base" in the replay = a current `declarations` row on that pole with `declared_at ≤ at`. That's the spec's allowed approximation. Write it in a comment.
  3. Report every existing raid row `classifyLower` would no longer call a raid, and every lower it would call a raid that has neither a row nor an insert, as `disagreements`. Don't change those rows; print them.
  4. Recompute online and points for every row, then update.
  5. Run `rebuildStandings`.
- [ ] **Step 4:** Run. Expect PASS.
- [ ] **Step 5: Runbook** `docs/deploy/2026-11-06-raid-value.md`, in order:
  1. The release deploy runs migration 0073 automatically.
  2. `sudo systemctl stop clan-wars-bot`.
  3. Run `pnpm rescore:season --season 3` (dry run) from `/opt/clan-wars` with `.env` sourced (memory: `/home/acab/.local/bin/pnpm`).
  4. **Check the dry run before applying:**
     - Exactly one insert: Z2→NDF at 2026-11-06T01:32:37Z, online, 155.
     - Totals: Z2 670, NDF 333, COCK 300, VOLK 293, plus any raids landed after 2026-11-06T12:00Z, which change these.
     - Investigate every `disagreements` line before going on. The known one is 2026-10-30T17:47 XxBE4zyxX lowering MMBA's `Flag_Snake` at MMBA's base with no raid row.
  5. Run with `--apply`.
  6. Run `pnpm rebuild:standings --season 3`, which must report no drift.
  7. Start the bot.
  8. Confirm #server-events got the fresh "RAID WINDOW OPEN, closes Sunday" line.
  9. Post the player announcement (the spec's draft).
- [ ] **Step 6: Commit** `feat(scoring): season rescore script and runbook`.

### Task 7: The weekly raid award

**Files:**
- Create: `apps/bot/src/raid-award.ts`, `apps/bot/src/raid-award-tick.ts`, `apps/bot/src/raid-award-text.ts`
- Modify: `packages/domain/src/rules.ts` (`RAID_AWARD_KEY`, `RAID_AWARD_DAYS`, `RAID_AWARD_FIRST_WEEK = 2026-11-02T00:00Z`), `apps/bot/src/config.ts` (`RAID_AWARD_TICK`, refuses without `SERVER_EVENTS_CHANNEL_ID`), `apps/bot/src/discord.ts` (run right after `weekTick`), `apps/bot/README.md`, CLAUDE.md (lock order: `raid_award_weeks` immediately before `award_grants`)
- Test: `apps/bot/test/raid-award.test.ts`

**Interfaces:**
- Consumes: `alpha_weeks` rank 1 (written by `closeWeeksTx`). `grantAwardTx` (`@factions/roster/internal`, args `{ awardKey, winnerDiscordId, grantedByDiscordId, reason, siteBaseUrl, now, serverId, durationDays }`). `scoringWeekEnd`.
- Produces: `payRaidAwards(db: Database, opts: { now: Date; siteBaseUrl: string; grantedByDiscordId: string; post: (text: string) => Promise<void> }): Promise<{ paid: number }>`.

- [ ] **Step 1: Failing tests:**
  - With an `alpha_weeks` rank-1 row for week 2026-11-02, `payRaidAwards` inserts `raid_award_weeks` and grants `weapon-kit` for 7 days to `factions.leader_discord_id` as of the payout. The reason is `"Top raiding clan, week of 2026-11-02"`.
  - It posts once, and a second call pays nothing.
  - A rank-1 row for week 2026-10-26 (before `RAID_AWARD_FIRST_WEEK`) is never paid.
  - A week whose rank-1 clan was later disbanded → recorded with `detail.failure`, no grant, no throw.
  - A refused grant throws and rolls back the ledger row.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3: Implement.** One transaction per week in the order `raid_award_weeks` (insert … on conflict do nothing returning = the idempotency guard) → `award_grants` → `clan_notices`, and post after the commit. Leaders always have a Discord id (`factions.leader_discord_id` is NOT NULL), so the spec's held-for-unlinked path is not needed. Write a comment saying why. Text in `raid-award-text.ts`, in plain voice, naming the clan, its points that week, and that the leader can give the kit to a clanmate on the site.
- [ ] **Step 4:** Run. Expect PASS.
- [ ] **Step 5: Commit** `feat(awards): weekly weapon kit for the top raiding clan`.

### Task 8: #scoreboard and /scoreboard show the price list

**Files:**
- Modify: `packages/roster/src/scoring.ts` (`ScoreboardRow` gains `price`; `scoreboardDb` reads the season's raid facts and who is online), `apps/bot/src/scoreboard-post.ts`, `apps/web/app/(site)/scoreboard/page.tsx`
- Create: the copy in `packages/copy/src/scoreboard.ts` (title, footer and reason phrases, numbers from `rules.ts`), exported from `index.ts`
- Test: `packages/roster/test/scoring.test.ts`, `apps/bot/test/scoreboard-post.test.ts`, the web scoreboard render test if one exists (else add `apps/web/test/scoreboard-price.test.ts`)

**Interfaces:**
- Consumes: `clanValue`, `raidPoints`, `valueReasons` (Task 3).
- Produces: `ScoreboardRow.price: { payout: number; online: boolean; recentRaids: number; hitsThisWeek: number; newUntil: Date | null } | null`. It's null for dormant clans.
- The price-list order: active clans by `payout` desc, then tag. Dormant clans go on one "can't be raided" line.

- [ ] **Step 1: Failing tests:**
  - **Roster:** for the Task 3 fixture at `2026-11-06T12:00Z` with nobody online, Z2's `price.payout` is **148** (value 197.60 × 0.75), and **296** with a Z2 member in session. Also assert it equals a direct `raidPoints(clanValue(...))` call. The other offline payouts at that instant: VOLK 108, SKULL 63, COCK 85, WOOKI 75, MMBA 56, OUT 34, NDF 57. SKULL, WOOKI and MMBA are dormant on production, so seed them active in the test if you assert theirs.
  - **Bot post:**
    - The first embed is titled "💰 What a raid pays right now".
    - Its rows read like `Z2 · 148 · 🔥 7 recent raids · 🩹 hit 1 time this week`.
    - A 🟢 row shows the ×1.5 payout.
    - A 🐣 row reads `new, counts from <date>`.
    - The dormant line is present.
    - At most 9 clan cards, each with `💰 <payout>` after the points.
    - `scoreboardKey` changes when one clan's payout or online flag changes, and does not change when only the clock moves within the same rounded values.
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement. The reason text never uses relative times. The web page renders the same list from the same rows, above the table.
- [ ] **Step 4:** Run. Expect PASS.
- [ ] **Step 5: Commit** `feat(scoreboard): live raid prices`.

### Task 9: The guide, the numbers, CLAUDE.md, and the changelog

**Files:**
- Modify:
  - `packages/domain/src/rules.ts`: remove `POINTS_TOP/BOTTOM/UNRANKED`, and remove `pointsFor` from `scoring.ts` and its test.
  - `packages/domain/src/guide-numbers.ts`: rows for the seven value constants, `RAID_AWARD_DAYS`, and the window/week strings. Delete `POINTS`.
  - Guide chapters `apps/web/content/guide/05-raiding.html`, `07-the-scoreboard.html`, `12-fair-play.html` (window times) and `13-rules-on-one-page.html`.
  - `CLAUDE.md`: a "Where things live" row for raid value, the award and the rescore, with ⚠️ notes on own-row exclusion, the cutover constant, and the single-raid-per-lower rule.
  - `CHANGELOG.md` under `## [Unreleased]`.
- Test: `apps/web/test/guide.test.ts`, the domain `rules`/`guide-numbers` tests

- [ ] **Step 1:** Rewrite the chapters with `{{KEY|format}}` tokens only. Chapter 5 covers the price, heat, hits, new clans, online/offline, flags anywhere (own flag, raised by a member), "X's flag on your base", and the new window. Chapter 7 covers banked points, the Sunday week, and the weekly kit to the leader. Write in the player-facing voice and don't discourage raiding.
- [ ] **Step 2:** Run the full gate (32/32). Expect PASS.
- [ ] **Step 3:** The changelog entry is player-facing, plain voice: what changed, that season 3 was rescored, and that this weekend closes Sunday 14:00 UTC.
- [ ] **Step 4: Commit** `docs: raid value scoring in the guide, CLAUDE.md and changelog`.
- [ ] **Step 5:** Open the PR with `keel:finish-work`, then cut the release (memory: a release/x.y.z changelog PR, then the tag; confirm the version bump with the owner, since this is a minor).
