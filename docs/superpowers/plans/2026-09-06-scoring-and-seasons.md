# Scoring and Seasons (increment 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Weeks close with three Alphas and an `@Alpha` role, seasons close at the wipe with a results table and a champion, a wipe script does the whole reset, a clan re-binds its base with its first raise after a wipe, and the site shows the scoreboard, the Alphas, past seasons and the war log.

**Architecture:** Two clock ticks and one script. The **week tick** closes every week that has ended since the season's high-water mark, in order, inserting `alpha_weeks` rows under their unique key and queueing the `#war-log` line in the same transaction (the poster posts after commit, which is §7's "insert, commit, then post"). The **`@Alpha` role** is one more step of 3b's reconciler: desired holders are the full members of the latest closed week's Alphas, diffed against the role. The **wipe** is a pure function over a transaction (`wipeTx`) that a thin root script calls with the production guard, so "wipe twice is once" is a unit test. **Season close** is the first step of the wipe. The **post-wipe bind** is one new branch in the raise consumer. The site reads all of it through four new `@factions/roster` exports from `raids`, `defenses`, `alpha_weeks`, `season_results` and `season_standings`, never from the Discord queues.

**Tech Stack:** drizzle-orm 0.36 (one migration, 0024), postgres.js, vitest, discord.js via 3b's `GuildGateway`, Next 16 pages under `apps/web/app`.

**Spec:** `docs/superpowers/specs/2026-09-04-clan-wars-target-state-design.md` — §4.8 (`alpha_weeks`, `season_results`), §7 (week close, reapers), §8.1–8.5 (points, credit, week, season, wipe), §9.1 (`ALPHA_ROLE_ID`), §9.2 (`week_closed`, `season_closed` lines), §10.2 (`/scoreboard`, `/alphas`, `/seasons`, `/war-log`, badges), §13 (drift test for standings, week close across a restart, two missed weeks, a week with no raids, wipe twice), §14 (week and season close hazards), §15 row 4.

## Global Constraints

- **Points are stored at write time and never recomputed** (§8.1). Nothing in this increment recalculates `raids.points`; the week and season totals are sums of stored points.
- **Rank order everywhere** is §8.1's: points desc, `times_raided` asc, `activated_at` asc. One function computes it (Task 2) and the raid consumer, the week tick, the season close and the scoreboard all call it.
- **`season_standings` is a projection of `raids` + `defenses`**; a rebuild function exists and a drift test holds the two together (§4.8, §13).
- **Week close is idempotent across a restart and closes every missed week in order** (§7 ⚠️). A week nobody scored still closes, with one `week_closed` line saying so. The high-water mark is `seasons.week_closed_through` (Task 1; ruling recorded there).
- **Queue rows in the transition's own transaction, always** (§4.7, §14): `week_closed` and `season_closed` are `war_log_events` rows written inside the closing transaction; the existing poster posts them in id order.
- **The wipe script is idempotent by the season it closes** (§8.5) and refuses any database that is not `factions_live` unless invoked with `--allow-test-db` (tests call `wipeTx` directly, never the script).
- **Nothing here writes a raid, a defense, or a status** except: the wipe's step 5 clearing `flag_down_*` / `disband_warned_at`, and the post-wipe bind reviving a dormant clan through the shared `reviveFactionTx`.
- Lock order §4.12: factions → declarations → poles → faction_members → … → season_standings → raids/defenses → alpha_weeks → season_results → faction_events → war_log_events → clan_notices. `alpha_weeks` and `season_results` are insert-only and sit after `raids`/`defenses`.
- `ALPHA_ROLE_ID` is a **required** snowflake (§9.1), created by hand once; the bot never creates it. `@Alpha` goes to full members only.
- Public web export list grows by exactly four names; `packages/roster/test/exports.test.ts` and `apps/web/test/smoke.test.ts` are edited on purpose. No identifier under `apps/web` contains "faction". Every page importing `@factions/roster` is `force-dynamic`.
- Player-facing text says "clan", never "faction" (`apps/bot/test/vocabulary.test.ts`; `apps/web` vocabulary test).
- `docs/guide-numbers.json` drift test stays green: `ALPHAS_PER_WEEK = 3`, `POST_WIPE_BIND_MS = 7 d`, points 200/100/100 are already in `rules.ts`; add no new number without adding it to the guide.
- Full gate before every commit: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force` → **26 successful, 26 total**. Never touch `factions_live`.
- Commit trailers: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01Svc2Dv7g1XwWi8CSuY4h5e`.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/db/migrations/0024_seasons_close.sql`, `packages/db/src/schema.ts` | `alpha_weeks`, `season_results`, `seasons.week_closed_through` |
| `apps/bot/src/config.ts` | `alphaRoleId` required |
| `apps/bot/src/standings.ts` (create) | `rankedStandings`, `rebuildStandings`, `weekTopThree` — the one rank order |
| `apps/bot/src/raid-tick.ts` (modify) | calls `rankedStandings` instead of its inline query |
| `apps/bot/src/week-tick.ts` (create) | `weekTick` |
| `apps/bot/src/war-log-text.ts` (modify) | `week_closed` with 1–3 Alphas; `season_closed` with no champion |
| `apps/bot/src/structure-store.ts`, `structure-tick.ts` (modify) | `@Alpha` step |
| `apps/bot/src/season-close.ts` (create) | `closeSeasonTx` |
| `apps/bot/src/wipe.ts` (create), `scripts/wipe.ts` (create), `scripts/rebuild-standings.ts` (create) | the wipe and the rebuild, function + CLI |
| `apps/bot/src/raise-tick.ts` (modify) | post-wipe bind branch |
| `apps/bot/src/discord.ts` (modify) | week tick wiring |
| `packages/roster/src/scoring.ts` (create), `src/index.ts`, `src/reads.ts` (modify) | `scoreboard`, `alphas`, `seasons`, `warLog`; Alpha badge and placements |
| `apps/web/app/{scoreboard,alphas,seasons,war-log}/page.tsx` (create), `apps/web/lib/auth/gate.ts`, `app/clans/page.tsx`, `app/clans/[tag]/page.tsx`, `app/page.tsx` (modify) | the pages, the gate, the badges, the nav |
| `docs/deploy/2026-09-06-scoring-and-seasons.md`, `CLAUDE.md`, spec §15, `apps/bot/README.md` | operations |

---

### Task 1: Migration 0024 and `ALPHA_ROLE_ID`

**Files:**
- Create: `packages/db/migrations/0024_seasons_close.sql` (generated, renamed, journal tag fixed), `packages/db/test/seasons-close-schema.test.ts`
- Modify: `packages/db/src/schema.ts`, `apps/bot/src/config.ts`, `apps/bot/test/config.test.ts`, `apps/bot/README.md`

**Interfaces:**
- Produces (schema):
  ```ts
  // seasons gains
  weekClosedThrough: timestamp("week_closed_through", { withTimezone: true }),   // nullable: no week closed yet
  export const alphaWeeks = pgTable("alpha_weeks", {
    id: bigserial, seasonId (fk seasons), weekStart: timestamptz notNull, rank: integer notNull, factionId (fk factions) notNull, points: integer notNull,
  }, (t) => ({ uniq: uniqueIndex("alpha_weeks_uniq").on(t.seasonId, t.weekStart, t.rank), rankValid: check("alpha_weeks_rank_valid", sql`${t.rank} between 1 and 3`) }));
  export const seasonResults = pgTable("season_results", {
    id: bigserial, seasonId (fk) notNull, factionId (fk) notNull, rank: integer notNull, points, raids, timesRaided, defenses: integer notNull, statusAtClose: text notNull,
  }, (t) => ({ uniq: uniqueIndex("season_results_uniq").on(t.seasonId, t.factionId), statusValid: check("season_results_status_valid", sql`${t.statusAtClose} in ('active','dormant','disbanded','lapsed','reserved')`) }));
  ```
- Produces (config): `BotConfig.alphaRoleId: string` from `ALPHA_ROLE_ID` via 3b's `requiredSnowflake`.

**Ruling (recorded here, spec §7 vs §4.8):** §7 says a week with no scorers "writes zero `alpha_weeks` rows and one `week_closed` event" and warns that without a key "the tick re-examines the week forever"; §4.8 gives `alpha_weeks` as the only week table. The high-water mark therefore lives on `seasons.week_closed_through`, advanced in the same transaction as the week's rows (compare-and-set on the previous value). Readers of `alpha_weeks` need no sentinel filtering. Cost if wrong: one nullable column.

- [ ] **Step 1: Failing tests** (`seasons-close-schema.test.ts`, same harness as `raids-schema.test.ts`):

```ts
  it("alpha_weeks is unique per (season, week, rank) and rank is 1..3", async () => {
    await db.insert(alphaWeeks).values({ seasonId, weekStart: monday, rank: 1, factionId: A, points: 300 });
    await expect(db.insert(alphaWeeks).values({ seasonId, weekStart: monday, rank: 1, factionId: B, points: 200 })).rejects.toThrow(/alpha_weeks_uniq/u);
    await expect(db.insert(alphaWeeks).values({ seasonId, weekStart: monday, rank: 4, factionId: B, points: 1 })).rejects.toThrow(/alpha_weeks_rank_valid/u);
  });
  it("season_results is unique per (season, faction) and pins the status vocabulary", async () => {
    await db.insert(seasonResults).values({ seasonId, factionId: A, rank: 1, points: 300, raids: 2, timesRaided: 0, defenses: 1, statusAtClose: "active" });
    await expect(db.insert(seasonResults).values({ seasonId, factionId: A, rank: 2, points: 0, raids: 0, timesRaided: 0, defenses: 0, statusAtClose: "active" })).rejects.toThrow(/season_results_uniq/u);
    await expect(db.insert(seasonResults).values({ seasonId, factionId: B, rank: 2, points: 0, raids: 0, timesRaided: 0, defenses: 0, statusAtClose: "gone" })).rejects.toThrow(/season_results_status_valid/u);
  });
  it("seasons.week_closed_through starts null", async () => {
    const [s] = await db.select({ w: seasons.weekClosedThrough }).from(seasons).where(eq(seasons.id, seasonId));
    expect(s!.w).toBeNull();
  });
```

`config.test.ts`: extend `OK` with `ALPHA_ROLE_ID: "42345678901234567"`, add `ALPHA_ROLE_ID` to the `it.each` of required keys from 3b, and assert `alphaRoleId` is read.

- [ ] **Step 2: Run** → both fail (tables missing; `alphaRoleId` undefined).
- [ ] **Step 3: Implement** the schema, `cd packages/db && npx drizzle-kit generate`, rename the file to `0024_seasons_close.sql`, fix the journal tag, read the SQL in full. Config: `alphaRoleId: requiredSnowflake(env, "ALPHA_ROLE_ID", "the @Alpha role")` with the same docblock style as 3b's three. README: env row (required), example `.env` line, and one sentence in the permissions paragraph (the bot's role above `@Alpha`).
- [ ] **Step 4: Run** the two test files, then the full gate → 26/26. Any bot test fixture that calls `loadConfig` gets the new key.
- [ ] **Step 5: Commit**

```bash
git add packages/db apps/bot/src/config.ts apps/bot/test/config.test.ts apps/bot/README.md
git commit -m "feat(db,bot): migration 0024 — alpha_weeks, season_results, seasons.week_closed_through; ALPHA_ROLE_ID required"
```

---

### Task 2: `standings.ts` — one rank order, the rebuild, the drift test

**Files:**
- Create: `apps/bot/src/standings.ts`, `apps/bot/test/standings.test.ts`, `scripts/rebuild-standings.ts`
- Modify: `apps/bot/src/raid-tick.ts:92-99` (use `rankedStandings`)

**Interfaces:**
- Produces:
  ```ts
  export type StandingRow = { factionId: number; name: string; tag: string; texture: string; status: string; activatedAt: Date | null; points: number; raids: number; timesRaided: number; defenses: number };
  /** Every standings row of the season in §8.1 order (points desc, times_raided asc, activated_at asc). Not filtered by status or points — callers slice. */
  export async function seasonTable(db: Database | Tx, seasonId: number): Promise<StandingRow[]>;
  /** §8.1's "ranked": active AND points > 0, in order. rankOf is 1-based or null. */
  export async function rankedStandings(db: Database | Tx, seasonId: number): Promise<{ ranked: StandingRow[]; rankOf: (factionId: number) => number | null }>;
  /** Top ALPHAS_PER_WEEK clans by sum(raids.points) for the week, ties by §8.1 order, only sums > 0. */
  export async function weekTopThree(db: Database | Tx, seasonId: number, weekStart: Date): Promise<{ factionId: number; name: string; tag: string; texture: string; points: number }[]>;
  /** Recompute season_standings from raids + defenses (raids: raider_faction_id → points += points, raids += 1; victim → times_raided += 1; defenses: faction_id → defenses += 1). Deletes rows no longer backed by any raid/defense. Returns the rebuilt row count. */
  export async function rebuildStandings(db: Database, seasonId: number): Promise<number>;
  ```
- Consumes: `seasonStandings`, `raids`, `defenses`, `factions` from `@factions/db`; `ALPHAS_PER_WEEK` from `@factions/domain`.

- [ ] **Step 1: Failing tests** — the fixture from `raid-tick.test.ts` (server, season, clans BEAR/WOLF/LYNX with poles, full members, `lower()` helper) plus `raise()` from `raise-tick.test.ts`, driving the real consumers so the drift test proves the projection against real writers:

```ts
  it("rankedStandings orders by points desc, times_raided asc, activated_at asc and excludes unranked and dormant", async () => { /* seed standings rows directly: A 300/0, B 300/2, C 300/2 with earlier activated_at, D 0, E 100 dormant → ranked = [A, C, B]; rankOf(D) null; rankOf(E) null */ });
  it("⚠️ drift: season_standings equals a rebuild from raids + defenses after real raids, an absorbed lower, a solo raid and a defense", async () => {
    await lower(W1, "Wolfie", "Flag_Bear", P1, t0);                       // WOLF raids BEAR
    await lower(W1, "Wolfie", "Flag_Bear", P1, new Date(t0.getTime() + 60_000)); // absorbed
    await lower(S1, "Solo", "Flag_Wolf", P2, t0);                         // solo raids WOLF: 0 points, times_raided +1
    await raidTick(db);
    await raise(B1, "Bear1", "Flag_Bear", P1, new Date(t0.getTime() + 3_600_000)); // BEAR defends
    await raiseTick(db, { siteBaseUrl: SITE });
    const live = await db.select().from(seasonStandings).orderBy(seasonStandings.factionId);
    await rebuildStandings(db, seasonId);
    const rebuilt = await db.select().from(seasonStandings).orderBy(seasonStandings.factionId);
    expect(rebuilt.map(strip)).toEqual(live.map(strip));   // strip = drop id
    expect(rebuilt.find((r) => r.factionId === WOLF)).toMatchObject({ points: 100, raids: 1, timesRaided: 1 });
    expect(rebuilt.find((r) => r.factionId === BEAR)).toMatchObject({ points: 0, raids: 0, timesRaided: 1, defenses: 1 });
  });
  it("rebuild repairs a hand-edited row and removes an orphan", async () => { /* update BEAR points to 999; insert a standings row for LYNX with no raids; rebuild → BEAR back to 0, LYNX row gone */ });
  it("weekTopThree sums stored points per raider clan for the week, ties by §8.1, at most three, only positive", async () => { /* four clans with raids in week w and one in week w+1; a fourth-place clan excluded; a clan with a solo raid (0 points) excluded */ });
  it("raid-tick's rank comes from rankedStandings (N=10, r=4 → 167 still holds)", async () => { /* the existing raid-tick points test re-run here through rankedStandings' rankOf on the same seeded ladder */ });
```

- [ ] **Step 2: Run** → fails.
- [ ] **Step 3: Implement** `standings.ts`; replace `raid-tick.ts`'s inline ranked query with `const { ranked, rankOf } = await rankedStandings(tx, season.id); const rank = rankOf(victim.id); const points = raiderFactionId === null ? 0 : pointsFor(rank, ranked.length);`. `rebuildStandings` runs in one transaction: lock the season's standings rows (`select … for update`), compute the aggregate with one SQL statement (a `full outer join` of the raids raider aggregate, the raids victim aggregate, and the defenses aggregate on faction_id), upsert every computed row, delete the season's rows not in the computed set. `scripts/rebuild-standings.ts` (root, like `scripts/guide-numbers.ts`): `DATABASE_URL` + `--season <id>`; refuses a non-`factions_live` URL without `--allow-test-db`; prints the count.
- [ ] **Step 4: Run** `test/standings.test.ts test/raid-tick.test.ts` → PASS; full gate → 26/26.
- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/standings.ts apps/bot/src/raid-tick.ts apps/bot/test/standings.test.ts scripts/rebuild-standings.ts
git commit -m "feat(bot): one §8.1 rank order; season_standings rebuild held to raids + defenses by a drift test"
```

---

### Task 3: The week tick and the `week_closed` line

**Files:**
- Create: `apps/bot/src/week-tick.ts`, `apps/bot/test/week-tick.test.ts`
- Modify: `apps/bot/src/war-log-text.ts` (`week_closed`), `apps/bot/test/war-log-text.test.ts`, `apps/bot/src/discord.ts` (wiring, after the raise tick, before the posters)

**Interfaces:**
- Produces:
  ```ts
  export type WeekTickResult = { closed: number; errors: number };
  /** For every open season: close each week from the high-water mark up to the last week whose end <= now, in order, one transaction per week. */
  export async function weekTick(db: Database, opts: { now: Date; onError?: (seasonId: number, weekStart: Date, err: unknown) => void }): Promise<WeekTickResult>;
  /** The Monday after `weekStart`. */
  export function nextWeek(weekStart: Date): Date;
  ```
- Consumes: `weekTopThree` (Task 2), `weekStartOf` (`@factions/domain`), `appendWarLogTx` (`@factions/roster/internal`), `alphaWeeks`, `seasons`.

**Per week `w` (starting at `weekStartOf(season.startedAt)` when `week_closed_through` is null, else `nextWeek(week_closed_through)`), while `nextWeek(w) <= now`:** one transaction — `select … from seasons where id = $1 for update`; re-read `week_closed_through` and skip if it already covers `w` (a second instance or a replay); `top = weekTopThree(tx, season.id, w)`; insert one `alpha_weeks` row per entry (rank = index + 1) with `onConflictDoNothing` on the unique key; `appendWarLogTx(tx, { serverId, kind: "week_closed", occurredAt: nextWeek(w), payload: { weekStart: w.toISOString(), first: top[0]?.name ?? null, second: top[1]?.name ?? null, third: top[2]?.name ?? null, p1: top[0]?.points ?? null, p2: …, p3: … } })`; `update seasons set week_closed_through = w`. Commit. `closed++`. An error in one week calls `onError`, counts, and stops that season's loop for this tick (weeks must close in order).

**`week_closed` rendering (§9.2, ruling for fewer than three):** `first === null` → `🏆 No Alphas this week — nobody scored.`; otherwise list only the present names and points: `🏆 Alphas this week: **A**, **B** — 300 / 200`.

- [ ] **Step 1: Failing tests** — fixture: server, season started Wed 2026-09-02 12:00 UTC (`weekStartOf` → Mon 08-31), clans BEAR/WOLF/LYNX/OWL, raids inserted DIRECTLY into `raids` (the consumers are Task 2's concern; here the input is stored points) with `week_start` values:

```ts
  it("closes the first week at Monday 00:00 UTC with the top three and queues the line", async () => {
    await seedRaid({ raider: WOLF, victim: BEAR, points: 200, at: wed });   // week of 08-31
    await seedRaid({ raider: LYNX, victim: BEAR, points: 100, at: thu });
    expect(await weekTick(db, { now: new Date("2026-09-06T23:59:59Z") })).toEqual({ closed: 0, errors: 0 });
    expect(await weekTick(db, { now: new Date("2026-09-07T00:00:00Z") })).toEqual({ closed: 1, errors: 0 });
    expect(await db.select().from(alphaWeeks).orderBy(alphaWeeks.rank)).toMatchObject([
      { weekStart: new Date("2026-08-31T00:00:00Z"), rank: 1, factionId: WOLF, points: 200 },
      { weekStart: new Date("2026-08-31T00:00:00Z"), rank: 2, factionId: LYNX, points: 100 },
    ]);
    const [w] = await db.select().from(warLogEvents);
    expect(w).toMatchObject({ kind: "week_closed", occurredAt: new Date("2026-09-07T00:00:00Z"), payload: { first: "WOLF", second: "LYNX", third: null, p1: 200, p2: 100, p3: null } });
    expect((await db.select({ w: seasons.weekClosedThrough }).from(seasons))[0]!.w).toEqual(new Date("2026-08-31T00:00:00Z"));
  });
  it("⚠️ a second tick at the same instant closes nothing more (restart on the boundary)", async () => { /* run twice; alpha_weeks 2 rows; war_log_events 1 row */ });
  it("⚠️ two missed weeks close in order, each with its own line", async () => {
    await seedRaid({ raider: WOLF, victim: BEAR, points: 200, at: wed });                              // week 08-31
    await seedRaid({ raider: OWL, victim: BEAR, points: 150, at: new Date("2026-09-09T12:00:00Z") });   // week 09-07
    expect(await weekTick(db, { now: new Date("2026-09-21T00:00:00Z") })).toEqual({ closed: 3, errors: 0 });   // 08-31, 09-07, 09-14 (empty)
    const lines = await db.select().from(warLogEvents).orderBy(warLogEvents.id);
    expect(lines.map((l) => l.payload.first)).toEqual(["WOLF", "OWL", null]);
    expect(lines.map((l) => l.occurredAt.toISOString())).toEqual(["2026-09-07T00:00:00.000Z", "2026-09-14T00:00:00.000Z", "2026-09-21T00:00:00.000Z"]);
  });
  it("a week with no raids still closes and says so", async () => { /* no raids; tick at 09-07 → closed 1, alpha_weeks empty, one line with first null, week_closed_through = 08-31 */ });
  it("a closed season is left alone", async () => { /* set ended_at; tick → closed 0 */ });
  it("ties break by §8.1: times_raided asc then activated_at asc", async () => { /* WOLF and LYNX both 200 this week; LYNX times_raided 1, WOLF 0 → WOLF first; then equal times_raided, earlier activated_at first */ });
```

`war-log-text.test.ts`: `week_closed` with three, with two (`"🏆 Alphas this week: **A**, **B** — 300 / 200"`), with one, with none.

- [ ] **Step 2: Run** → fails.
- [ ] **Step 3: Implement** `week-tick.ts`, the renderer, and the wiring in `discord.ts` (its own try/catch; log `weeks closed N` when non-zero; `onError` logs `week close failed for season S week W`).
- [ ] **Step 4: Run** `test/week-tick.test.ts test/war-log-text.test.ts` → PASS; full gate → 26/26.
- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/week-tick.ts apps/bot/src/war-log-text.ts apps/bot/src/discord.ts apps/bot/test/week-tick.test.ts apps/bot/test/war-log-text.test.ts
git commit -m "feat(bot): week close — Alphas under (season, week, rank), a high-water mark on the season, the #war-log line"
```

---

### Task 4: `@Alpha` in the reconciler

**Files:**
- Modify: `apps/bot/src/structure-store.ts`, `apps/bot/src/structure-tick.ts`, `apps/bot/src/discord.ts` (pass `alphaRoleId`), `apps/bot/test/structure-store.test.ts`, `apps/bot/test/structure-tick.test.ts`

**Interfaces:**
- Produces: `StructureStore.currentAlphaFactionIds(): Promise<Set<number>>` — the faction ids in `alpha_weeks` for `(season = the open season, week_start = seasons.week_closed_through)` across every open season; empty when no week has closed. `StructureTickOpts` gains `alphaRoleId: string`; `StructureTickResult` gains `alphaAdds`, `alphaRemoves`.

**Step 6 of the pass (after `@Linked`):** desired = full members (from `fullMembersByClan`, which needs the clan to have a role id — read the members for the Alpha factions with a second, role-independent query if a clan has no structure yet) of every current Alpha faction, filtered by `isMember`; actual = `roleMembers(alphaRoleId)`; add and remove. Reads inside `step("alpha-read")`, writes per user.

- [ ] **Step 1: Failing tests** — `structure-store.test.ts`: `currentAlphaFactionIds` returns the ids of the latest closed week only (seed two weeks of `alpha_weeks`, `week_closed_through` = the later one), and an empty set when `week_closed_through` is null. `structure-tick.test.ts`: fixture gains an `alpha` role in `FakeGuild`; "gives @Alpha to the full members of this week's Alphas and takes it from last week's" (BEAR was Alpha in week 1, WOLF in week 2 → after the tick, WOLF's full members hold it, BEAR's do not; pending members never do); "no closed week → nobody holds @Alpha".
- [ ] **Step 2–3: Run, implement.** `discord.ts` passes `alphaRoleId: cfg.alphaRoleId`; the summary log names the two new counters.
- [ ] **Step 4: Run** the two files + full gate → 26/26.
- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/structure-store.ts apps/bot/src/structure-tick.ts apps/bot/src/discord.ts apps/bot/test/structure-store.test.ts apps/bot/test/structure-tick.test.ts
git commit -m "feat(bot): @Alpha follows the latest closed week through the reconciler"
```

---

### Task 5: Season close and the wipe

**Files:**
- Create: `apps/bot/src/season-close.ts`, `apps/bot/src/wipe.ts`, `apps/bot/test/season-close.test.ts`, `apps/bot/test/wipe.test.ts`, `scripts/wipe.ts`
- Modify: `apps/bot/src/war-log-text.ts` (`season_closed` without a champion), `apps/bot/test/war-log-text.test.ts`, `apps/bot/src/dormancy-store.ts` (`clockQuery`'s coalesce), `apps/bot/test/dormancy-store.test.ts`

**The 7-day clock after a wipe (§5.1, §8.5):** `clockQuery`'s `lastRaiseAt` becomes `greatest(coalesce(LAST_RAISE, activated_at, created_at), <open season started_at>)` — the open season's `started_at` via a correlated subquery on `seasons where server_id = factions.server_id and ended_at is null`, `greatest` ignoring nulls. Test (`dormancy-store.test.ts`): a clan whose last raise is 20 days old on a server whose open season started yesterday reads `lastRaiseAt` = the season start, so `decide()` does not make it dormant; with no open season the old behaviour holds.

**Interfaces:**
- Produces:
  ```ts
  // season-close.ts
  /** Snapshot season_results from season_standings in §8.1 order (rank 1..n over EVERY standings row, ranked or not), set ended_at and champion (rank 1 if its points > 0, else null), queue season_closed. Returns null when the server has no open season. Idempotent: an already-ended season is not touched. */
  export async function closeSeasonTx(tx: Tx, serverId: number, at: Date): Promise<{ seasonId: number; number: number; champion: { factionId: number; name: string; points: number } | null } | null>;
  // wipe.ts
  export type WipeResult = { skipped: boolean; closedSeason: number | null; openedSeason: number; holdsEnded: number; declarationsDeleted: number; polesStamped: number; clansCleared: number };
  /** §8.5 in one transaction. No-op (skipped: true) when a season with started_at = wipeAt already exists on the server. */
  export async function wipeTx(tx: Tx, serverId: number, wipeAt: Date): Promise<WipeResult>;
  export async function wipe(db: Database, serverId: number, wipeAt: Date): Promise<WipeResult>;
  ```
- Consumes: `seasonTable` (Task 2), `appendWarLogTx`, `POST_WIPE_BIND_MS` (`@factions/domain`), `identityHolds`, `declarations`, `poles`, `factions`, `seasons`.

**`wipeTx` order (lock order §4.12; the bot is stopped per the runbook, but the function still locks):** `select id from factions where server_id = $1 for update`; (1) `closeSeasonTx`; (2) `update identity_holds set held_until = $wipeAt where server_id = $1 and held_until = 'infinity'`; (3) `delete from declarations where server_id = $1` (after `lockDeclarations`); (4) `update poles set grace_until = $wipeAt + POST_WIPE_BIND_MS, flag_raised = false where server_id = $1`; (5) `update factions set flag_down_since = null, flag_down_by_dayz_id = null, disband_warned_at = null where server_id = $1` (`clan_pins` and `intruder_sightings` do not exist until increment 5 — a comment names them for that increment's plan to add); (6) `insert into seasons (server_id, number, started_at) values ($1, closed.number + 1 (or 1), $wipeAt)`.

**`season_closed` rendering:** champion null → `🏁 Season {n} is over. Nobody scored. Full table: {link}`.

- [ ] **Step 1: Failing tests**

```ts
  // season-close.test.ts — seeded standings: WOLF 300, BEAR 100 (dormant), LYNX 0 (active), OWL disbanded with 50
  it("snapshots every standings row in §8.1 order with status_at_close, names the champion, queues the line", async () => {
    const r = await db.transaction((tx) => closeSeasonTx(tx, serverId, at));
    expect(r).toMatchObject({ number: 1, champion: { factionId: WOLF, points: 300 } });
    expect(await db.select().from(seasonResults).orderBy(seasonResults.rank)).toMatchObject([
      { factionId: WOLF, rank: 1, points: 300, statusAtClose: "active" },
      { factionId: BEAR, rank: 2, points: 100, statusAtClose: "dormant" },
      { factionId: OWL, rank: 3, points: 50, statusAtClose: "disbanded" },
      { factionId: LYNX, rank: 4, points: 0, statusAtClose: "active" },
    ]);
    expect((await db.select().from(seasons))[0]).toMatchObject({ endedAt: at, championFactionId: WOLF });
    expect((await db.select().from(warLogEvents))[0]).toMatchObject({ kind: "season_closed", payload: { number: 1, clan: "WOLF", points: 300 } });
  });
  it("no scorer → no champion, the line says so", async () => { /* all zero → championFactionId null, payload.clan null */ });
  it("closing twice is once", async () => { /* second call returns null; one results set; one line */ });

  // wipe.test.ts — a full fixture: open season 1 (started 30 d ago) with standings, two clans with declarations (one dormant with disband_warned_at, one active with flag_down_since), a solo declaration, an identity hold at 'infinity' and one at a finite date, three poles (flag_raised true)
  it("does §8.5 in one transaction", async () => {
    const r = await wipe(db, serverId, wipeAt);
    expect(r).toMatchObject({ skipped: false, closedSeason: 1, openedSeason: 2, holdsEnded: 1, declarationsDeleted: 3, polesStamped: 3, clansCleared: 2 });
    expect(await db.select().from(declarations)).toEqual([]);
    for (const p of await db.select().from(poles)) { expect(p.graceUntil).toEqual(new Date(wipeAt.getTime() + POST_WIPE_BIND_MS)); expect(p.flagRaised).toBe(false); }
    for (const f of await db.select().from(factions)) { expect(f.flagDownSince).toBeNull(); expect(f.disbandWarnedAt).toBeNull(); expect(["active", "dormant"]).toContain(f.status); }  // statuses untouched
    const holds = await db.select().from(identityHolds).orderBy(identityHolds.id);
    expect(holds[0]!.heldUntil).toEqual(wipeAt); expect(holds[1]!.heldUntil).toEqual(finite);
    const open = await openSeason(db, serverId);
    expect(open).toMatchObject({ number: 2, startedAt: wipeAt });
    expect(await db.select().from(seasonStandings).where(eq(seasonStandings.seasonId, open!.id))).toEqual([]);
  });
  it("⚠️ wipe twice is once", async () => {
    await wipe(db, serverId, wipeAt);
    const again = await wipe(db, serverId, wipeAt);
    expect(again.skipped).toBe(true);
    expect(await db.select().from(seasons)).toHaveLength(2);
    expect(await db.select().from(warLogEvents)).toHaveLength(1);
  });
  it("a failing step rolls the whole wipe back", async () => { /* make step 6 fail by pre-inserting a season number 2 with a different started_at (seasons_number_uniq) → rejects; declarations still present; season 1 still open */ });
```

- [ ] **Step 2: Run** → fails.
- [ ] **Step 3: Implement.** `scripts/wipe.ts` (root): args `--server <id> --at <ISO>` (default now, rounded to the minute), reads `DATABASE_URL`, refuses a URL not ending in `/factions_live` unless `--allow-test-db`, prints the `WipeResult` as JSON, exits non-zero on `skipped` so a re-run is visible. Ends the client.
- [ ] **Step 4: Run** the three test files + full gate → 26/26.
- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/season-close.ts apps/bot/src/wipe.ts apps/bot/src/war-log-text.ts apps/bot/test scripts/wipe.ts
git commit -m "feat(bot): season close and the wipe — results snapshot, champion, holds end, declarations cleared, next season opened; idempotent"
```

---

### Task 6: The post-wipe bind

**Files:**
- Modify: `apps/bot/src/raise-tick.ts` (the "undeclared pole" branch), `apps/bot/test/raise-tick.test.ts`

**Rule (§8.5):** on a `flag.raised` at an undeclared pole whose texture belongs to a holding clan (active or dormant) with **no `declarations` row**, by a **full member**: `declareTx(tx, { serverId, poleKey, x, y, z, owner: { factionId }, evidence: { eventId: ev.id }, at: ev.occurredAt })`. On `ok`: append the `rebound` feed event (payload `{ name, tag, texture }` — the existing renderer says "moved house", which is what happened); if the clan is dormant, `reviveFactionTx(tx, clan.id, ev.occurredAt, { dayzId, gamertag })`; result `"bound"`. On `too-close` / `pole-taken`: nothing is written and the tick logs at info (**ruling:** no notice kind exists for this and §9.3 lists none; the site's clan page will show "no base" once increment 5 lands — cost if wrong: a member who raised too close to another base gets no DM). `RaiseTickResult` gains `bound: number`. A clan **with** a declaration keeps today's `rebind_proposed` path; `POST_WIPE_BIND_MS` is the guide's number for the poles' grace, not a gate on this branch (a late bind is still a bind).

- [ ] **Step 1: Failing tests** (`raise-tick.test.ts`, new `describe("post-wipe bind")` with a clan whose declaration was deleted):

```ts
  it("a full member's raise of the clan's texture at any free pole binds the base with the raise as evidence", async () => {
    await db.delete(declarations).where(eq(declarations.ownerFactionId, BEAR));
    await raise(B1, "Bear1", "Flag_Bear", P9, now);
    expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ bound: 1 });
    const d = await declarationForFaction(db, BEAR);
    expect(d).toMatchObject({ poleKey: P9 });
    expect((await db.select().from(factionEvents)).at(-1)).toMatchObject({ kind: "rebound", factionId: BEAR });
  });
  it("a dormant clan's bind also revives it", async () => { /* status dormant + dormant_reason inactive; after the tick: active, revived feed row, revived notice */ });
  it("a pending member's raise binds nothing", async () => { /* → colors_elsewhere notice as today, no declaration */ });
  it("too close to another base binds nothing and writes nothing", async () => { /* P9 within 200 m of WOLF's declaration → no declaration, no feed row, bound 0 */ });
  it("a clan that still has a declaration gets the rebind proposal, not a bind", async () => { /* existing test still passes: rebind_proposed */ });
```

- [ ] **Step 2–3: Run, implement.** Lock order: the clan's `factions` row `FOR UPDATE` first (the branch currently reads `owner` without a lock — take the lock now), then `declareTx` (which takes the declarations advisory lock), then `faction_events`, then the revive.
- [ ] **Step 4: Run** `test/raise-tick.test.ts` + full gate → 26/26.
- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/raise-tick.ts apps/bot/test/raise-tick.test.ts
git commit -m "feat(bot): after a wipe, a full member's first raise binds the clan's base"
```

---

### Task 7: The roster package reads — `scoreboard`, `alphas`, `seasons`, `warLog`, badges, placements

**Files:**
- Create: `packages/roster/src/scoring.ts`, `packages/roster/test/scoring.test.ts`
- Modify: `packages/roster/src/index.ts`, `packages/roster/src/reads.ts` (`DirectoryEntry.alpha`, `ClanPage.placements`, `ClanPage.alphaWeeks`, `ClanPage.stats`), `packages/roster/test/exports.test.ts` (four names added), `packages/roster/test/reads.test.ts` (or wherever `directoryDb`/`clanByTagDb` are tested), `apps/web/test/smoke.test.ts` (the same four names)

**Interfaces:**
- Produces (public, page-facing vocabulary — `clanId`/`clanName`, never "faction"):
  ```ts
  export type ScoreboardRow = { rank: number | null; tag: string; name: string; texture: string; status: string; points: number; raids: number; timesRaided: number; defenses: number; alpha: boolean };
  export type Scoreboard = { season: { number: number; startedAt: Date; weekClosedThrough: Date | null } | null; rows: ScoreboardRow[] };
  /** The open season's table in §8.1 order: ranked clans (rank 1..N) first, then unranked (rank null) by name. Disbanded/lapsed clans are excluded. */
  export function scoreboard(): Promise<Scoreboard>;
  export type AlphaWeek = { weekStart: Date; entries: { rank: number; tag: string; name: string; texture: string; points: number }[] };
  /** Every closed week of the open season, newest first; a week nobody scored has no entries. */
  export function alphas(): Promise<{ season: { number: number } | null; weeks: AlphaWeek[] }>;
  export type SeasonSummary = { number: number; startedAt: Date; endedAt: Date; champion: { tag: string; name: string; texture: string; points: number } | null; rows: { rank: number; tag: string; name: string; texture: string; points: number; raids: number; timesRaided: number; defenses: number; statusAtClose: string }[] };
  /** Closed seasons, newest first, from season_results. */
  export function seasons(): Promise<SeasonSummary[]>;
  export type WarLogEntry =
    | { kind: "raid"; at: Date; raider: { tag: string; name: string } | null; victim: { tag: string; name: string; texture: string }; gamertag: string | null; points: number; lowers: number }
    | { kind: "defense"; at: Date; victim: { tag: string; name: string; texture: string }; gamertag: string | null; durationSeconds: number };
  /** Raids and defenses of the open season, newest first, from raids + defenses (never from the queue). */
  export function warLog(limit?: number): Promise<WarLogEntry[]>;
  ```
  `DirectoryEntry` gains `alpha: boolean` (in the latest closed week's `alpha_weeks`); `ClanPage` gains `placements: { season: number; rank: number; points: number }[]` (from `season_results`), `alphaWeeks: number` (count across seasons), `stats: { raids: number; defenses: number; longestSiegeSeconds: number | null; daysHeld: number | null }` (raids = standings of the open season; longest siege from `defenses.siege_seconds`; daysHeld from the current declaration's `declared_at`).
- Consumes: the tables; `ALPHAS_PER_WEEK`. The rank order is re-implemented here as one SQL `order by` (the bot's `standings.ts` is not importable from the package; a drift test in this task pins the two orderings on one seeded ladder: the package's `scoreboard` ranks and the bot's `rankedStandings` — the bot test can import nothing from here either, so the package test asserts the literal order `[A, C, B]` on the same fixture Task 2 uses, with a comment naming the twin).

- [ ] **Step 1: Failing tests** (`scoring.test.ts`, real DB): scoreboard order and `rank` null for unranked, dormant included with its mark, disbanded excluded, `alpha` true only for the latest closed week; `alphas` newest first with an empty week; `seasons` newest first with champion null when nobody scored; `warLog` merges raids and defenses by time desc with the solo raider (`raider: null`) and the gamertag from `players`, honouring `limit`; `directory` rows carry `alpha`; `clanByTag` carries `placements`, `alphaWeeks`, `stats.longestSiegeSeconds`, `stats.daysHeld` (null without a declaration). Exports pin test lists 38 names; `smoke.test.ts` list matches.
- [ ] **Step 2–3: Run, implement.** Wrappers in `index.ts` follow the existing one-liner style (`scoreboard()` → `scoreboardDb(db())`).
- [ ] **Step 4: Run** `packages/roster` tests + `apps/web` tests (smoke) + full gate → 26/26.
- [ ] **Step 5: Commit**

```bash
git add packages/roster apps/web/test/smoke.test.ts
git commit -m "feat(roster): scoreboard, alphas, seasons and war log reads; Alpha badge and placements"
```

---

### Task 8: The pages, the gate, the nav

**Files:**
- Create: `apps/web/app/scoreboard/page.tsx`, `apps/web/app/alphas/page.tsx`, `apps/web/app/seasons/page.tsx`, `apps/web/app/war-log/page.tsx`, `apps/web/lib/scoring-copy.ts`, `apps/web/test/scoring-copy.test.ts`
- Modify: `apps/web/lib/auth/gate.ts` (`PUBLIC_PATHS` gains `"/scoreboard", "/alphas", "/seasons", "/war-log"`), `apps/web/test/auth-gate.test.ts`, `apps/web/app/clans/page.tsx` (Alpha badge), `apps/web/app/clans/[tag]/page.tsx` (placements, Alpha weeks, stats, badge), `apps/web/app/page.tsx` (nav links to the four pages)

Every page: `export const dynamic = "force-dynamic"`, the `label` class and layout of `app/clans/page.tsx`, `flagImagePath` for flags, `when` / `days` from `@/lib/format`, a `duration(seconds)` helper in `scoring-copy.ts` (`"3h 15m"`, the bot's format, re-implemented here because `apps/web` cannot import the bot). Copy in `scoring-copy.ts`: `EMPTY_SCOREBOARD = "No season is open. The scoreboard starts with the first raid after the season opens."`, `NO_ALPHAS_WEEK = "Nobody scored."`, `NO_SEASONS = "No season has closed yet."`, `EMPTY_WAR_LOG = "No raids yet this season."`, `ALPHA_BADGE = "Alpha"`.

- `/scoreboard`: heading "Season {n}", a table: rank (or "—"), flag, name [tag], points, raids, times raided, defenses, a "dormant" mark, an Alpha badge; unranked rows after ranked; footer line naming `weekClosedThrough` ("Alphas through the week of {date}").
- `/alphas`: one section per week, newest first: "Week of {Mon date}" and the three (or fewer) with points, or `NO_ALPHAS_WEEK`.
- `/seasons`: one section per closed season: "Season {n} — {start} to {end}", champion line, the full table.
- `/war-log`: a list, newest first: raid → "**{raider}** raided **{victim}** — flag lowered by {gamertag} · {points} pts" (solo: "**{victim}** was raided — flag lowered by {gamertag} (no clan)"), defense → "**{victim}** raised their colors again — {duration} under siege"; `warLog(200)`.
- `/clans`: an `ALPHA_BADGE` chip next to a clan whose `alpha` is true.
- `/clans/{tag}`: a "This season" block (rank from the scoreboard is not on `ClanPage` — show the stats: raids, defenses, longest siege, days held), "Placements" (season, rank, points) and "Alpha weeks: N".

- [ ] **Step 1: Failing tests**: `auth-gate.test.ts` pins the new `PUBLIC_PATHS`; `scoring-copy.test.ts` pins `duration(11700) === "3h 15m"`, `duration(59) === "0m"`... use the bot's exact rules (read `apps/bot/src/notice-text.ts` `duration` and mirror them: hours and minutes, no seconds; `"0m"` under a minute).
- [ ] **Step 2–3: Run, implement.** `cd apps/web && npx vitest run && npx tsc --noEmit`; the web vocabulary test (no "faction").
- [ ] **Step 4: Full gate** → 26/26.
- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): /scoreboard, /alphas, /seasons, /war-log; Alpha badges; placements on the clan page"
```

---

### Task 9: Runbook, CLAUDE.md, spec §15

**Files:**
- Create: `docs/deploy/2026-09-06-scoring-and-seasons.md`
- Modify: `CLAUDE.md`, spec §15 (plan file name), `apps/bot/README.md` (only if stale)

- [ ] **Step 1: Runbook**

```markdown
# Scoring and seasons (increment 4) — deploy runbook

Migration 0024 adds `alpha_weeks`, `season_results` and `seasons.week_closed_through`. Nothing is
dropped. The bot gains the week tick (closes every ended week, in order, at start and every tick)
and `@Alpha`; the site gains four public pages. `scripts/wipe.ts` is the wipe.

1. **Read the migration.** `packages/db/migrations/0024_seasons_close.sql`.
2. **Apply 0024** with the one-off runner from `docs/deploy/2026-09-02-dormancy.md`. The bot may
   keep running while it applies; restart it after.
3. **Create the `@Alpha` role by hand**, below the bot's role; put its id in the bot `.env` as
   `ALPHA_ROLE_ID`. The bot refuses to start without it. Never assign it by hand — the reconciler
   gives it to the full members of the latest closed week's Alphas and takes it from everyone else.
4. **Deploy** bot and web together: `docker compose build web && docker compose up -d web &&
   sudo systemctl restart clan-wars-bot`.
5. **Confirm on start:** `journalctl -u clan-wars-bot -f` shows `weeks closed N` where N is the
   number of Monday boundaries since season 1 opened (each with a `🏆` line in `#war-log`, in
   order — a season opened on a Wednesday closes its first, partial week the following Monday),
   then `structure … alphaAdds K`. `/scoreboard`, `/alphas`, `/seasons`, `/war-log` render
   without signing in.
6. **The wipe**, when the server owner schedules it: stop the bot; run the game server's wipe;
   then, from the repo root on the host:
       set -a && . ./.env && set +a && npx tsx scripts/wipe.ts --server 1 --at 2026-10-01T06:00:00Z
   It prints the result as JSON. Running it again with the same `--at` prints `skipped: true` and
   exits non-zero on purpose. Then start the bot. `#war-log` gets the `🏁` line; `/seasons`
   shows the table; every clan's flag is down in the game and its base is unbound — the first
   raise of its flag by a full member binds the new base (200 m rule applies; too close binds
   nothing and the member must pick another pole). Solos re-declare on `/base`.
7. **Rebuild standings** only if a hand edit or a bug is suspected:
       npx tsx scripts/rebuild-standings.ts --season <id>
   The drift test guarantees this equals what the consumers wrote.
8. **What waits.** `clan_pins` and `intruder_sightings` (wipe step 5) arrive with increment 5;
   `wipe.ts` names them in a comment.
```

- [ ] **Step 2: CLAUDE.md** — ticks bullet: `week-tick.ts` (closes weeks in order under `seasons.week_closed_through`; insert + queue in one transaction, the poster posts after commit) and the reconciler's `@Alpha` step; scripts bullet: `scripts/wipe.ts` and `scripts/rebuild-standings.ts` with the `factions_live` guard; hazards: "`season_standings` is a projection; the drift test in `standings.test.ts` is what keeps it honest — edit it only through the consumers or the rebuild"; env: `ALPHA_ROLE_ID` required; current state: "Increment 4 merged; not deployed until `docs/deploy/2026-09-06-scoring-and-seasons.md`."
- [ ] **Step 3: Spec §15** row 4: plan file `2026-09-06-scoring-and-seasons.md`. Nothing else.
- [ ] **Step 4:** Full gate → 26/26. Commit:

```bash
git add docs/deploy/2026-09-06-scoring-and-seasons.md CLAUDE.md docs/superpowers/specs/2026-09-04-clan-wars-target-state-design.md apps/bot/README.md
git commit -m "docs: increment 4 runbook and the wipe procedure; CLAUDE.md for the week tick, @Alpha and the scripts"
```

---

## Self-review

**Spec coverage.** §4.8 `alpha_weeks`, `season_results` (Task 1). §8.1 one rank order shared by the raid consumer, the week tick, the season close and the scoreboard (Tasks 2, 3, 5, 7 — the package re-implements the `order by` and a fixture pins it). §8.3 week close, Alphas, `@Alpha`, badge on directory/scoreboard/clan page, `#war-log` (Tasks 3, 4, 7, 8). §8.4 season close, `season_results`, champion, Seasons page, placements, `#war-log` (Tasks 5, 7, 8). §8.5 the wipe's six steps (Task 5; `clan_pins`/`intruder_sightings` deferred to increment 5 with a named comment), the post-wipe bind (Task 6), the 7-day clock from `started_at` (already in `dormancy-store.ts`'s coalesce? — it coalesces `activated_at`, `created_at`; **gap**: §5.1 says "coalesced with … the season's `started_at`" — Task 5 adds `seasons.started_at` to `clockQuery`'s coalesce, greatest of the candidates, with a `dormancy-store.test.ts` case: a clan with an old raise and a season opened yesterday is not dormant. Added to Task 5's files: `apps/bot/src/dormancy-store.ts`, `apps/bot/test/dormancy-store.test.ts`). §9.1 `ALPHA_ROLE_ID` (Task 1). §9.2 both lines (Tasks 3, 5). §10.2 four public routes and the badges (Tasks 7, 8). §13: standings drift (Task 2), points worked example (kept, Task 2), week close across a restart, two missed weeks, a week with no raids (Task 3), wipe twice (Task 5). §14 week close ordering (Task 3: queue row inside the transaction; the poster posts after commit).

**Placeholders.** Tests in Tasks 2–7 given as comments name their exact seeds and assertions; none says "add tests". The runbook and CLAUDE.md edits are spelled out.

**Type consistency.** `seasonTable` / `rankedStandings` / `weekTopThree` (Task 2) are what Tasks 3 and 5 call; `closeSeasonTx` (Task 5) is what `wipeTx` calls first; `StructureStore.currentAlphaFactionIds` and `alphaRoleId` (Task 4) match `structureTick`'s opts; the four package exports (Task 7) are what the four pages (Task 8) import; `ScoreboardRow.alpha` and `DirectoryEntry.alpha` share the definition "in the latest closed week's `alpha_weeks`".
