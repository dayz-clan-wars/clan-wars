# Achievements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fifty lifetime achievements for players and clans, computed by a bot tick from the derived tables, stored once with evidence, shown on the site and announced in Discord.

**Architecture:** Definitions are data in `@factions/domain`. Rules are pure reads in the bot (`apps/bot/src/achievements/`), one per key, returning `{ count, target, earnedAt, evidence }`. A tick finds owners touched since the last pass, evaluates their rules, inserts unlock rows (PK-guarded) and queues notices in the same transaction. The site reads unlocks and cached progress through one roster export.

**Tech Stack:** TypeScript, drizzle-orm over postgres.js, vitest, discord.js, Next.js (app router), Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-09-11-achievements-design.md`

## Global Constraints

- Exactly 50 definitions, keys unique snake_case; every `team` entry is `clan`-owned, nothing else is.
- Friendly fire counts for nothing except `blue_on_blue`. "PvP kill" = `kills.killer_dayz_id` not null, ≠ victim, `friendly_fire = false`.
- Thresholds live only in `packages/domain/src/achievements.ts`. Never retype one in copy, guide or renderer.
- `earned_at` is the evidence's own timestamp, never "now". Rules take `now` only for open spans (Loyalist) and never for anything else.
- No coordinates in `evidence`, notice payloads, or any rendered tile (grid-square counts only; the same `no_coordinates` CHECK as `clan_notices`).
- Player-facing copy says "clan", never "faction" (`apps/web/test/copy-vocabulary.test.ts` bans the substring in web source).
- `apps/web` imports only `@factions/roster` public exports; the export allowlist is pinned in `packages/roster/test/exports.test.ts` AND `apps/web/test/smoke.test.ts`.
- Every page reading the viewer or `@factions/roster` is `export const dynamic = "force-dynamic"`.
- Tests: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"` (a base URL; each package derives `factions_test_<package>`). Full gate before any "done": `TEST_DATABASE_URL=… npx turbo run typecheck test --concurrency=1 --force`, expect every task successful, 0 cached (currently 26/26; this plan adds none).
- Never touch `factions_live` from a test or a local run. Migrations apply to production only via the runbook.
- Commit after every task, on a feature branch `achievements`, merged to `main` with `--no-ff` at the end.

## File map

| File | Responsibility |
|---|---|
| `packages/domain/src/achievements.ts` | The 50 definitions (data) + `ACHIEVEMENT_BY_KEY`, `AchievementGroup`, `AchievementOwner` |
| `packages/domain/src/streaks.ts` | Pure PvP streak walk shared by rules (stats keeps its own copy, untouched) |
| `packages/domain/src/feed.ts` | `CLAN_NOTICE_KINDS` gains `"achievement"` |
| `packages/db/src/schema.ts` + `migrations/0031_achievements.sql` | `achievement_unlocks`, `achievement_progress`, `achievement_counters` |
| `apps/bot/src/achievements/types.ts` | `Owner`, `RuleResult`, `Rule`, helpers `oneShot`, `nth` |
| `apps/bot/src/achievements/rules-solo.ts`, `rules-pve.ts`, `rules-pvp.ts`, `rules-team.ts` | The rules, grouped as the spec groups them |
| `apps/bot/src/achievements/rules.ts` | `RULES: Record<AchievementKey, Rule>` registry |
| `apps/bot/src/achievements/counters.ts` | Lifetime counters for Explorer (visited squares) and Cartographer (pins dropped) |
| `apps/bot/src/achievements/touched.ts` | Touched-owner collection + watermarks |
| `apps/bot/src/achievements/tick.ts` | `achievementsTick(db, opts)`: evaluate, unlock, announce |
| `apps/bot/src/notice-text.ts` | `achievement` renderer branch |
| `apps/bot/src/config.ts`, `discord.ts` | `ACHIEVEMENTS_CHANNEL_ID`, `ACHIEVEMENTS_TICK` gate, wiring |
| `scripts/backfill-achievements.ts` | Backfill runner (root scripts dir, like `rebuild-kills.ts`) |
| `packages/roster/src/achievements.ts` + `index.ts` | `achievementsForDb`, export `achievementsFor` |
| `apps/web/lib/achievements-copy.ts`, `app/components/achievement-wall.tsx` | Copy + tiles |
| `apps/web/app/(site)/players/[gamertag]/page.tsx`, `components/owner.tsx`, `clans/[tag]/page.tsx`, `clan/page.tsx` | Surfaces |
| `apps/web/content/guide/14-achievements.html`, `lib/guide.ts`, `app/guide/render.ts` | Guide chapter rendered from definitions |
| `docs/deploy/2026-09-12-achievements.md` | Runbook |

Test helpers created in Task 3 and used by every rule task: `apps/bot/test/achievements/seed.ts`.

---

### Task 1: Definitions in the domain package

**Files:**
- Create: `packages/domain/src/achievements.ts`
- Create: `packages/domain/test/achievements.test.ts`
- Modify: `packages/domain/src/index.ts` (add `export * from "./achievements";`)

**Interfaces:**
- Produces: `ACHIEVEMENTS: readonly Achievement[]`, `ACHIEVEMENT_BY_KEY: Record<AchievementKey, Achievement>`, types `Achievement = { key: AchievementKey; name: string; description: string; group: AchievementGroup; owner: AchievementOwner; target: number; unit: "count" | "hours" | "days" | "m" }`, `AchievementGroup = "solo" | "pve" | "pvp" | "team"`, `AchievementOwner = "player" | "clan"`, `ACHIEVEMENT_GROUPS`, `AchievementKey` (union of the 50 keys).

- [ ] **Step 1: Write the failing test**

```ts
// packages/domain/test/achievements.test.ts
import { describe, it, expect } from "vitest";
import { ACHIEVEMENTS, ACHIEVEMENT_BY_KEY, ACHIEVEMENT_GROUPS } from "../src/achievements";

describe("the achievement definitions", () => {
  it("are exactly fifty, keyed uniquely in snake_case", () => {
    expect(ACHIEVEMENTS).toHaveLength(50);
    const keys = ACHIEVEMENTS.map((a) => a.key);
    expect(new Set(keys).size).toBe(50);
    for (const k of keys) expect(k).toMatch(/^[a-z][a-z0-9_]*$/u);
    expect(Object.keys(ACHIEVEMENT_BY_KEY).sort()).toEqual([...keys].sort());
  });

  it("split 11 solo, 12 pve, 15 pvp, 12 team; team is clan-owned and nothing else is", () => {
    const by = (g: string) => ACHIEVEMENTS.filter((a) => a.group === g);
    expect([by("solo").length, by("pve").length, by("pvp").length, by("team").length]).toEqual([11, 12, 15, 12]);
    for (const a of ACHIEVEMENTS) expect(a.owner).toBe(a.group === "team" ? "clan" : "player");
    expect(ACHIEVEMENT_GROUPS).toEqual(["solo", "pve", "pvp", "team"]);
  });

  it("carry a positive integer target and a description a player can act on", () => {
    for (const a of ACHIEVEMENTS) {
      expect(Number.isInteger(a.target) && a.target >= 1).toBe(true);
      expect(a.name.length).toBeGreaterThan(2);
      expect(a.description).toMatch(/^[A-Z].*[^.]$/u);   // sentence case, no trailing full stop (tiles add none)
      expect(a.description.toLowerCase()).not.toContain("faction");
    }
  });

  it("states the thresholds the spec agreed", () => {
    const t = (k: string) => ACHIEVEMENT_BY_KEY[k as keyof typeof ACHIEVEMENT_BY_KEY].target;
    expect([t("marksman"), t("sniper"), t("point_blank")]).toEqual([150, 300, 5]);
    expect([t("long_haul"), t("veteran"), t("ironman")]).toEqual([24, 100, 5]);
    expect([t("loyalist"), t("regular")]).toEqual([30, 7]);
    expect([t("ten_down"), t("centurion"), t("warpath"), t("full_strength"), t("dynasty")]).toEqual([10, 100, 25, 10, 4]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/domain && pnpm exec vitest run test/achievements.test.ts`
Expected: FAIL — cannot resolve `../src/achievements`.

- [ ] **Step 3: Write the definitions**

```ts
// packages/domain/src/achievements.ts
/**
 * The fifty achievements — data, not code. The badge wall, the Discord line,
 * the guide chapter and the bot's rules all read THIS array; a threshold
 * changes here and nowhere else (spec 2026-09-11 §4).
 *
 * `target` is in `unit`: a count, hours, days, or metres. One-shot
 * achievements are `target: 1, unit: "count"`. The rule for each key lives in
 * apps/bot/src/achievements/rules.ts; apps/bot/test/achievements/rules.test.ts
 * fails if a key here has no rule or a rule has no key here.
 */
export const ACHIEVEMENT_GROUPS = ["solo", "pve", "pvp", "team"] as const;
export type AchievementGroup = (typeof ACHIEVEMENT_GROUPS)[number];
export type AchievementOwner = "player" | "clan";
export type AchievementUnit = "count" | "hours" | "days" | "m";

const def = <K extends string>(key: K, name: string, description: string, group: AchievementGroup, target = 1, unit: AchievementUnit = "count") =>
  ({ key, name, description, group, owner: group === "team" ? "clan" : "player", target, unit }) as const;

export const ACHIEVEMENTS = [
  // Solo — presence and progression
  def("enlisted", "Enlisted", "Link your account", "solo"),
  def("squad_up", "Squad Up", "Become a full member of a clan", "solo"),
  def("founder", "Founder", "Take part in a founding ceremony", "solo"),
  def("loyalist", "Loyalist", "30 days as a full member of one clan", "solo", 30, "days"),
  def("long_haul", "Long Haul", "24 hours played", "solo", 24, "hours"),
  def("veteran", "Veteran", "100 hours played", "solo", 100, "hours"),
  def("regular", "Regular", "Play on 7 consecutive days", "solo", 7, "days"),
  def("wanderer", "Wanderer", "10 fast travels", "solo", 10),
  def("explorer", "Explorer", "Seen in 50 different 1 km grid squares", "solo", 50),
  def("showman", "Showman", "50 emotes", "solo", 50),
  def("cartographer", "Cartographer", "Drop 10 map pins", "solo", 10),
  // PvE — the map, the builds, and the ways it kills you
  def("foundation", "Foundation", "Build your first base part", "pve"),
  def("builder", "Builder", "100 build points", "pve", 100),
  def("architect", "Architect", "500 build points", "pve", 500),
  def("ironman", "Ironman", "5 hours played without dying", "pve", 5, "hours"),
  def("wolf_bait", "Wolf Bait", "Get killed by a wolf", "pve"),
  def("bear_necessities", "Bear Necessities", "Get killed by a bear", "pve"),
  def("brains", "Brains", "Get killed by infected", "pve"),
  def("gravity_check", "Gravity Check", "Die to a fall", "pve"),
  def("sunday_driver", "Sunday Driver", "Get killed by a vehicle", "pve"),
  def("lights_out", "Lights Out", "Get knocked unconscious 10 times", "pve", 10),
  def("should_have_bandaged", "Should Have Bandaged", "Bleed out", "pve"),
  def("nine_lives", "Nine Lives", "Die 9 times, any cause", "pve", 9),
  // PvP — kills, streaks, and flags taken by hand
  def("first_blood", "First Blood", "Your first PvP kill", "pvp"),
  def("ten_down", "Ten Down", "10 PvP kills", "pvp", 10),
  def("centurion", "Centurion", "100 PvP kills", "pvp", 100),
  def("marksman", "Marksman", "A kill from 150 m or more", "pvp", 150, "m"),
  def("sniper", "Sniper", "A kill from 300 m or more", "pvp", 300, "m"),
  def("point_blank", "Point Blank", "A kill from under 5 m", "pvp", 5, "m"),
  def("arsenal", "Arsenal", "Kills with 10 different weapons", "pvp", 10),
  def("hat_trick", "Hat Trick", "3 PvP kills in one session", "pvp", 3),
  def("killing_spree", "Killing Spree", "5 PvP kills without a PvP death", "pvp", 5),
  def("unstoppable", "Unstoppable", "10 PvP kills without a PvP death", "pvp", 10),
  def("nemesis", "Nemesis", "Kill the same player 5 times", "pvp", 5),
  def("payback", "Payback", "Kill someone within an hour of them killing you", "pvp"),
  def("flag_thief", "Flag Thief", "Lower an enemy flag yourself in a scored raid", "pvp"),
  def("home_defender", "Home Defender", "Make the raise that ends a siege", "pvp"),
  def("blue_on_blue", "Blue on Blue", "Kill a clanmate", "pvp"),
  // Team — the clan's record
  def("colors_raised", "Colors Raised", "Found the clan and get it activated", "team"),
  def("full_strength", "Full Strength", "10 full members at once", "team", 10),
  def("first_raid", "First Raid", "The clan's first scored raid", "team"),
  def("warpath", "Warpath", "25 raids", "team", 25),
  def("giant_killer", "Giant Killer", "Raid the clan ranked first", "team"),
  def("wide_net", "Wide Net", "Raid 5 different clans", "team", 5),
  def("fortress", "Fortress", "10 defenses", "team", 10),
  def("podium", "Podium", "Finish a season in the top 3", "team"),
  def("alpha", "Alpha", "Finish a week in the top 3", "team"),
  def("dynasty", "Dynasty", "Alpha 4 weeks running", "team", 4),
  def("untouched", "Untouched", "A whole season without being raided", "team"),
  def("champions", "Champions", "Win a season", "team"),
] as const;

export type Achievement = (typeof ACHIEVEMENTS)[number];
export type AchievementKey = Achievement["key"];
export const ACHIEVEMENT_BY_KEY = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.key, a])) as Record<AchievementKey, Achievement>;
export const ACHIEVEMENT_KEYS = ACHIEVEMENTS.map((a) => a.key) as readonly AchievementKey[];
```

Add to `packages/domain/src/index.ts`: `export * from "./achievements";`

- [ ] **Step 4: Run the test and the package typecheck**

Run: `cd packages/domain && pnpm exec vitest run test/achievements.test.ts && pnpm exec tsc --noEmit`
Expected: 4 passed; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git checkout -b achievements
git add packages/domain/src/achievements.ts packages/domain/src/index.ts packages/domain/test/achievements.test.ts
git commit -m "feat(domain): the fifty achievement definitions, as data"
```

---

### Task 2: Pure streak walk in the domain package

Stats' `bestStreaks` is module-private and scans every player; rules need one player's streak from that player's own rows. Lift the walk into a pure function. Stats is left untouched (no refactor in this plan).

**Files:**
- Create: `packages/domain/src/streaks.ts`, `packages/domain/test/streaks.test.ts`
- Modify: `packages/domain/src/index.ts` (add `export * from "./streaks";`)

**Interfaces:**
- Produces: `streakOf(rows: readonly StreakRow[], dayzId: string): { best: number; reachedAt: (n: number) => Date | null }` where `StreakRow = { killer: string | null; victim: string; friendlyFire: boolean; occurredAt: Date }`, rows in ascending time. Rule (same as stats): a non-friendly-fire kill by `dayzId` of someone else extends the run; ANY kill row with `victim === dayzId` and a killer who is another player (friendly fire included) resets it. `reachedAt(n)` is the `occurredAt` of the first kill at which the run first equalled `n`, else null.

- [ ] **Step 1: Failing test**

```ts
// packages/domain/test/streaks.test.ts
import { describe, it, expect } from "vitest";
import { streakOf } from "../src/streaks";
const t = (s: number) => new Date(1_700_000_000_000 + s * 1000);
const K = (killer: string | null, victim: string, at: number, ff = false) => ({ killer, victim, friendlyFire: ff, occurredAt: t(at) });

describe("streakOf", () => {
  it("counts PvP kills until a PvP death, and reports when each length was first reached", () => {
    const rows = [K("A", "x", 1), K("A", "y", 2), K("z", "A", 3), K("A", "x", 4), K("A", "y", 5), K("A", "z", 6)];
    const s = streakOf(rows, "A");
    expect(s.best).toBe(3);
    expect(s.reachedAt(2)).toEqual(t(2));
    expect(s.reachedAt(3)).toEqual(t(6));
    expect(s.reachedAt(4)).toBeNull();
  });
  it("friendly fire neither extends the killer's run nor spares the victim's", () => {
    const rows = [K("A", "x", 1), K("A", "m", 2, true), K("A", "y", 3), K("m", "A", 4, true), K("A", "x", 5)];
    expect(streakOf(rows, "A").best).toBe(2);
  });
  it("a non-player death (no killer) does not reset", () => {
    expect(streakOf([K("A", "x", 1), K(null, "A", 2), K("A", "y", 3)], "A").best).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd packages/domain && pnpm exec vitest run test/streaks.test.ts` → cannot resolve module.

- [ ] **Step 3: Implement**

```ts
// packages/domain/src/streaks.ts
export type StreakRow = { killer: string | null; victim: string; friendlyFire: boolean; occurredAt: Date };

/**
 * One player's PvP streak from their own kill rows, ascending. Same rule as
 * packages/roster/src/stats.ts bestStreaks: a non-friendly-fire kill of
 * another player extends the run; any death to another player (friendly fire
 * included) resets it; a non-player death does not. `reachedAt(n)` is when the
 * run FIRST equalled n — the achievement's earned_at.
 */
export function streakOf(rows: readonly StreakRow[], dayzId: string): { best: number; reachedAt: (n: number) => Date | null } {
  let run = 0, best = 0;
  const firstAt = new Map<number, Date>();
  for (const r of rows) {
    if (r.killer === dayzId && r.victim !== dayzId && !r.friendlyFire) {
      run += 1;
      if (!firstAt.has(run)) firstAt.set(run, r.occurredAt);
      if (run > best) best = run;
    } else if (r.victim === dayzId && r.killer !== null && r.killer !== dayzId) {
      run = 0;
    }
  }
  return { best, reachedAt: (n) => firstAt.get(n) ?? null };
}
```

- [ ] **Step 4: Run** — 3 passed; `pnpm exec tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `git add packages/domain && git commit -m "feat(domain): pure PvP streak walk for the achievement rules"`

---

### Task 3: Schema, migration, notice kind

**Files:**
- Modify: `packages/db/src/schema.ts` (three tables, after `clanNotices`)
- Modify: `packages/domain/src/feed.ts` (`CLAN_NOTICE_KINDS` + `"achievement"`)
- Create: `packages/db/migrations/0031_achievements.sql` (generated)
- Create: `packages/db/test/achievements-schema.test.ts`
- Modify: `apps/bot/src/notice-text.ts` — a placeholder renderer is NOT acceptable; Task 10 adds the branch. Until then `apps/bot` typecheck fails on the `Record<ClanNoticeKind, Renderer>`; so **do Task 3's feed.ts change together with the renderer branch from Task 10 Step 3** (one line, given there), and Task 10 adds its tests.

**Interfaces:**
- Produces drizzle exports `achievementUnlocks`, `achievementProgress`, `achievementCounters` with the columns below.

- [ ] **Step 1: Failing schema test**

```ts
// packages/db/test/achievements-schema.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, achievementUnlocks, achievementProgress, achievementCounters, type Database } from "../src/index.js";
import { sql } from "drizzle-orm";

const URL = requireTestDatabaseUrl();
const at = new Date("2026-09-01T12:00:00Z");

describe("achievement tables", () => {
  let db: Database;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table achievement_unlocks, achievement_progress, achievement_counters restart identity cascade`);
  });

  it("stores one unlock per owner and key; a second insert does nothing", async () => {
    const row = { ownerKind: "player" as const, ownerId: "A".repeat(36), key: "first_blood", earnedAt: at, evidenceId: 7, evidence: { weapon: "M4" } };
    await db.insert(achievementUnlocks).values(row);
    const again = await db.insert(achievementUnlocks).values({ ...row, earnedAt: new Date() }).onConflictDoNothing().returning();
    expect(again).toEqual([]);
    const [u] = await db.select().from(achievementUnlocks);
    expect(u).toMatchObject({ ownerKind: "player", key: "first_blood", earnedAt: at, evidenceId: 7, evidence: { weapon: "M4" } });
    expect(u!.noticedAt).toBeInstanceOf(Date);
  });

  it("refuses coordinates in evidence and an unknown owner kind", async () => {
    await expect(db.insert(achievementUnlocks).values({ ownerKind: "player", ownerId: "A".repeat(36), key: "explorer", earnedAt: at, evidence: { x: 1 } })).rejects.toThrow(/no_coordinates/u);
    await expect(db.insert(achievementUnlocks).values({ ownerKind: "guild" as never, ownerId: "1", key: "alpha", earnedAt: at })).rejects.toThrow(/owner_kind/u);
  });

  it("caches progress and lifetime counters per owner and key", async () => {
    await db.insert(achievementProgress).values({ ownerKind: "clan", ownerId: "3", key: "warpath", count: 4, target: 25, computedAt: at });
    await db.insert(achievementCounters).values({ ownerKind: "player", ownerId: "B".repeat(36), key: "explorer", value: 2, detail: { squares: [1, 2] } });
    expect((await db.select().from(achievementProgress))[0]).toMatchObject({ count: 4, target: 25 });
    expect((await db.select().from(achievementCounters))[0]).toMatchObject({ value: 2, detail: { squares: [1, 2] } });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd packages/db && pnpm exec vitest run test/achievements-schema.test.ts` → `achievementUnlocks` is not exported.

- [ ] **Step 3: Add the tables to `packages/db/src/schema.ts`** (after the `clanNotices` table)

```ts
/**
 * Achievements (spec 2026-09-11 §5). One row per unlock, never deleted; the
 * primary key is what makes a rule firing twice harmless. `earnedAt` is when
 * the EVIDENCE happened — a backfilled Centurion is dated to the 100th kill,
 * not to the backfill. `ownerId` is a dayz_id for a player or the faction id
 * as text for a clan; clan rows survive renames and disbands unchanged.
 */
export const achievementUnlocks = pgTable("achievement_unlocks", {
  ownerKind: text("owner_kind").$type<"player" | "clan">().notNull(),
  ownerId: text("owner_id").notNull(),
  key: text("key").notNull(),
  earnedAt: timestamp("earned_at", { withTimezone: true }).notNull(),
  /** The kill / raid / event / session / defense row that crossed the line, when there is one. */
  evidenceId: bigint("evidence_id", { mode: "number" }),
  evidence: jsonb("evidence").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
  noticedAt: timestamp("noticed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.ownerKind, t.ownerId, t.key] }),
  ownerKindValid: check("achievement_unlocks_owner_kind_valid", sql`${t.ownerKind} IN ('player','clan')`),
  // ⚠️ Same predicate as clan_notices: evidence is rendered on the site and in Discord.
  noCoordinates: check("achievement_unlocks_no_coordinates", sql`NOT (${t.evidence} ? 'poleKey' OR ${t.evidence} ? 'x' OR ${t.evidence} ? 'y' OR ${t.evidence} ? 'z')`),
  byKey: index("achievement_unlocks_key_idx").on(t.key, t.earnedAt),
}));

/** A cache of the last computed count per owner and key — the profile reads one row per achievement. Safe to truncate; a full pass rebuilds it. */
export const achievementProgress = pgTable("achievement_progress", {
  ownerKind: text("owner_kind").$type<"player" | "clan">().notNull(),
  ownerId: text("owner_id").notNull(),
  key: text("key").notNull(),
  count: integer("count").notNull(),
  target: integer("target").notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.ownerKind, t.ownerId, t.key] }) }));

/**
 * Lifetime counters for facts whose source rows vanish: pins are deleted by
 * players (cartographer), positions are retained 30 days (explorer). `detail`
 * holds what the counter needs to stay exact — for explorer the visited
 * 1 km square INDICES (never x/z), plus `crossedAt` once the target was met.
 */
export const achievementCounters = pgTable("achievement_counters", {
  ownerKind: text("owner_kind").$type<"player" | "clan">().notNull(),
  ownerId: text("owner_id").notNull(),
  key: text("key").notNull(),
  value: integer("value").notNull().default(0),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.ownerKind, t.ownerId, t.key] }),
  noCoordinates: check("achievement_counters_no_coordinates", sql`NOT (${t.detail} ? 'x' OR ${t.detail} ? 'z' OR ${t.detail} ? 'poleKey')`),
}));
```

Add `primaryKey` to the `drizzle-orm/pg-core` import at the top of schema.ts if it is not already there.

- [ ] **Step 4: Generate the migration**

Run: `cd packages/db && DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm exec drizzle-kit generate --name achievements`
Expected: `migrations/0031_achievements.sql` with three `CREATE TABLE` statements and the checks; `meta/_journal.json` gains idx 31. Open the SQL and confirm the three CHECK constraints are present by name.

- [ ] **Step 5: Add the notice kind** — in `packages/domain/src/feed.ts` append `"achievement"` to `CLAN_NOTICE_KINDS` (last entry, after `"guest"`). Then in `apps/bot/src/notice-text.ts` add to `RENDERERS` (Task 10 tests it; the line is needed now so the bot typechecks):

```ts
  achievement: (p) => `🏆 ${p.ownerKind === "clan" ? `**${p.ownerName}**` : person(String(p.ownerName))}${p.clanTag && p.ownerKind === "player" && p.public ? ` [${p.clanTag}]` : ""} earned **${p.name}** — ${p.description}.`,
```

- [ ] **Step 6: Run** — `cd packages/db && pnpm exec vitest run test/achievements-schema.test.ts` → 3 passed. Then `pnpm --filter @factions/domain --filter @factions/db --filter @factions/bot typecheck` → clean. Then `cd apps/bot && pnpm exec vitest run test/notice-text.test.ts` → the bijection test passes (kind and renderer both present).

- [ ] **Step 7: Commit** — `git add packages/db packages/domain/src/feed.ts apps/bot/src/notice-text.ts && git commit -m "feat(db): achievement_unlocks, achievement_progress, achievement_counters; notice kind achievement"`

---

### Task 4: Rule types, test seed helpers, and the registry contract

**Files:**
- Create: `apps/bot/src/achievements/types.ts`
- Create: `apps/bot/src/achievements/rules.ts` (registry; starts empty and the test fails until Tasks 5–8 fill it)
- Create: `apps/bot/test/achievements/seed.ts`
- Create: `apps/bot/test/achievements/rules.test.ts` (the key-set contract)

**Interfaces:**
- Produces:
  ```ts
  export type Owner = { kind: "player"; id: string } | { kind: "clan"; id: string };   // clan id is the faction id as text
  export type Evidence = Record<string, string | number | boolean | null>;
  export type RuleResult = { count: number; target: number; earnedAt?: Date; evidenceId?: number | null; evidence?: Evidence; serverId?: number };
  export type Rule = (db: Database, owner: Owner, ctx: { now: Date }) => Promise<RuleResult>;
  export const oneShot: (target: number, hit: { at: Date; id?: number | null; evidence?: Evidence; serverId?: number } | undefined) => RuleResult;
  export const nth: (rows: readonly { at: Date; id?: number | null; serverId?: number }[], target: number, evidence?: (rows) => Evidence) => RuleResult;
  export const clanId: (owner: Owner) => number;   // throws for a player owner
  ```
  and `RULES: Record<AchievementKey, Rule>` from `rules.ts`.
- Seed helpers (all return the inserted row):
  ```ts
  seedServer(db): Promise<{ id: number }>
  seedLink(db, { dayzId, discordId, gamertag, verifiedAt })
  seedKill(db, { serverId, killer, victim, at, weapon?, distanceM?, cause?, friendlyFire?, killerFactionId?, victimFactionId? })  // killer null = non-PvP; cause defaults "pvp" when killer set else required
  seedSession(db, { serverId, dayzId, from, to, closeReason? })  // to = null leaves it open
  seedEvent(db, { serverId, type, at, payload })                 // inserts adm_files row once per server (cached) and the event
  seedMembership(db, { serverId, factionId, dayzId, joinedAt, leftAt? })
  seedRaid(db, { serverId, seasonId, victimFactionId, raiderDayzId, raiderFactionId, at, victimRank?, rankedCount?, points? })
  seedDefense(db, { factionId, seasonId, raisedByDayzId, at, siegeSeconds })
  seedAlphaWeek(db, { seasonId, factionId, weekStart, rank })
  seedSeasonResult(db, { seasonId, factionId, rank, timesRaided, statusAtClose? })
  ```
  plus re-exports of `seedFaction` and `seedSeason` from `../seed`.

- [ ] **Step 1: Write the contract test**

```ts
// apps/bot/test/achievements/rules.test.ts
import { describe, it, expect } from "vitest";
import { ACHIEVEMENT_KEYS } from "@factions/domain";
import { RULES } from "../../src/achievements/rules.js";

describe("the rule registry", () => {
  it("has exactly one rule per achievement key, and no rule for a key that is not defined", () => {
    expect(Object.keys(RULES).sort()).toEqual([...ACHIEVEMENT_KEYS].sort());
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd apps/bot && pnpm exec vitest run test/achievements/rules.test.ts` → cannot resolve `rules.js`.

- [ ] **Step 3: Write types.ts**

```ts
// apps/bot/src/achievements/types.ts
import type { Database } from "@factions/db";

/** Who an achievement belongs to. A clan's id is the faction id as text, so both kinds share one column. */
export type Owner = { kind: "player"; id: string } | { kind: "clan"; id: string };
export type Evidence = Record<string, string | number | boolean | null>;

/**
 * What every rule reports. `count` is in the definition's unit (kills, hours,
 * days, metres). When `count >= target` the rule MUST also set `earnedAt` —
 * the timestamp of the row that crossed the line, never "now" — and may set
 * the evidence row id and a small evidence object (⚠️ never a coordinate).
 */
export type RuleResult = {
  count: number;
  target: number;
  earnedAt?: Date;
  evidenceId?: number | null;
  evidence?: Evidence;
  /** The server the evidence came from, for the notice rows. Optional; the tick falls back to the owner's clan's server. */
  serverId?: number;
};
export type Rule = (db: Database, owner: Owner, ctx: { now: Date }) => Promise<RuleResult>;

export type Hit = { at: Date; id?: number | null; evidence?: Evidence; serverId?: number };

/** A one-shot rule: earned by the first matching row. */
export function oneShot(hit: Hit | undefined): RuleResult {
  return hit
    ? { count: 1, target: 1, earnedAt: hit.at, evidenceId: hit.id ?? null, evidence: hit.evidence, serverId: hit.serverId }
    : { count: 0, target: 1 };
}

/** A counted rule over rows in ascending time: earned when the target-th row lands. */
export function nth(rows: readonly Hit[], target: number, evidence?: (rows: readonly Hit[]) => Evidence): RuleResult {
  const count = rows.length;
  if (count < target) return { count, target };
  const crossing = rows[target - 1]!;
  return { count, target, earnedAt: crossing.at, evidenceId: crossing.id ?? null, evidence: evidence?.(rows) ?? { count }, serverId: crossing.serverId };
}

export function clanId(owner: Owner): number {
  if (owner.kind !== "clan") throw new Error(`rule needs a clan owner, got ${owner.kind}`);
  return Number(owner.id);
}
```

- [ ] **Step 4: Write rules.ts as an empty registry with the final shape**

```ts
// apps/bot/src/achievements/rules.ts
import type { AchievementKey } from "@factions/domain";
import type { Rule } from "./types.js";
import { SOLO_RULES } from "./rules-solo.js";
import { PVE_RULES } from "./rules-pve.js";
import { PVP_RULES } from "./rules-pvp.js";
import { TEAM_RULES } from "./rules-team.js";

/** One rule per key. The test diffs this against ACHIEVEMENT_KEYS in both directions. */
export const RULES: Record<AchievementKey, Rule> = { ...SOLO_RULES, ...PVE_RULES, ...PVP_RULES, ...TEAM_RULES };
```

For now create each of the four files exporting an empty object typed `Partial<Record<AchievementKey, Rule>>`:

```ts
// apps/bot/src/achievements/rules-solo.ts  (and -pve, -pvp, -team)
import type { AchievementKey } from "@factions/domain";
import type { Rule } from "./types.js";
export const SOLO_RULES: Partial<Record<AchievementKey, Rule>> = {};
```

`RULES` will not typecheck as a full `Record` until every key is present — that is intended; the typecheck is the second half of the contract. Until Task 8 lands, run only the vitest file, not `tsc`, for this package.

- [ ] **Step 5: Write the seed helpers**

```ts
// apps/bot/test/achievements/seed.ts
import {
  servers, admFiles, events, kills, playerSessions, identityLinks, membershipHistory, raids, defenses, alphaWeeks, seasonResults,
  type Database,
} from "@factions/db";
export { seedFaction, seedSeason } from "../seed.js";

const admFileFor = new Map<number, number>();

export async function seedServer(db: Database) {
  const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
  admFileFor.clear();
  return s!;
}
async function admFile(db: Database, serverId: number, at: Date): Promise<number> {
  let id = admFileFor.get(serverId);
  if (!id) {
    const [f] = await db.insert(admFiles).values({ serverId, filename: `f${serverId}.ADM`, bootAt: at, linesIngested: 0, complete: true }).returning();
    id = f!.id; admFileFor.set(serverId, id);
  }
  return id;
}
let line = 0;

export async function seedEvent(db: Database, a: { serverId: number; type: string; at: Date; payload: Record<string, unknown> }) {
  const [e] = await db.insert(events).values({
    serverId: a.serverId, admFileId: await admFile(db, a.serverId, a.at), lineIndex: line++, type: a.type as never, occurredAt: a.at, payload: a.payload,
  }).returning();
  return e!;
}
export async function seedLink(db: Database, a: { dayzId: string; discordId: string; gamertag: string; verifiedAt: Date }) {
  const [l] = await db.insert(identityLinks).values(a).returning();
  return l!;
}
export async function seedKill(db: Database, a: {
  serverId: number; killer: string | null; victim: string; at: Date; weapon?: string | null; distanceM?: number | null;
  cause?: string; friendlyFire?: boolean; killerFactionId?: number | null; victimFactionId?: number | null;
}) {
  const ev = await seedEvent(db, { serverId: a.serverId, type: a.killer ? "player.killed" : "player.died", at: a.at, payload: {} });
  const [k] = await db.insert(kills).values({
    serverId: a.serverId, eventId: ev.id, occurredAt: a.at, victimDayzId: a.victim, killerDayzId: a.killer,
    weapon: a.weapon ?? (a.killer ? "M4-A1" : null), distanceM: a.distanceM == null ? null : String(a.distanceM),
    cause: a.cause ?? (a.killer ? "pvp" : "died"), friendlyFire: a.friendlyFire ?? false,
    killerFactionId: a.killerFactionId ?? null, victimFactionId: a.victimFactionId ?? null,
  }).returning();
  return k!;
}
export async function seedSession(db: Database, a: { serverId: number; dayzId: string; from: Date; to: Date | null; closeReason?: "disconnect" | "restart" }) {
  const ev = await seedEvent(db, { serverId: a.serverId, type: "player.connected", at: a.from, payload: { dayzId: a.dayzId } });
  const [s] = await db.insert(playerSessions).values({
    serverId: a.serverId, dayzId: a.dayzId, connectedAt: a.from, connectEventId: ev.id,
    disconnectedAt: a.to, closeReason: a.to ? (a.closeReason ?? "disconnect") : null,
  }).returning();
  return s!;
}
export async function seedMembership(db: Database, a: { serverId: number; factionId: number; dayzId: string; joinedAt: Date; leftAt?: Date | null }) {
  const [m] = await db.insert(membershipHistory).values({ ...a, leftAt: a.leftAt ?? null }).returning();
  return m!;
}
export async function seedRaid(db: Database, a: {
  serverId: number; seasonId: number; victimFactionId: number; raiderDayzId: string; raiderFactionId: number | null; at: Date;
  victimRank?: number | null; rankedCount?: number; points?: number;
}) {
  const ev = await seedEvent(db, { serverId: a.serverId, type: "flag.lowered", at: a.at, payload: {} });
  const week = new Date(a.at); week.setUTCHours(0, 0, 0, 0); week.setUTCDate(week.getUTCDate() - ((week.getUTCDay() + 6) % 7));
  const [r] = await db.insert(raids).values({
    serverId: a.serverId, seasonId: a.seasonId, victimFactionId: a.victimFactionId, raiderDayzId: a.raiderDayzId, raiderFactionId: a.raiderFactionId,
    firstLowerEventId: ev.id, firstLowerAt: a.at, lastLowerEventId: ev.id, lastLowerAt: a.at, lowerCount: 1,
    points: a.points ?? 100, victimRankAtLower: a.victimRank ?? null, rankedCountAtLower: a.rankedCount ?? 0, weekStart: week,
  }).returning();
  return r!;
}
export async function seedDefense(db: Database, a: { serverId: number; factionId: number; seasonId: number; raisedByDayzId: string; at: Date; siegeSeconds: number }) {
  const ev = await seedEvent(db, { serverId: a.serverId, type: "flag.raised", at: a.at, payload: {} });
  const [d] = await db.insert(defenses).values({
    factionId: a.factionId, seasonId: a.seasonId, raisedByDayzId: a.raisedByDayzId, eventId: ev.id,
    flagDownSince: new Date(a.at.getTime() - a.siegeSeconds * 1000), defendedAt: a.at, siegeSeconds: a.siegeSeconds,
  }).returning();
  return d!;
}
export async function seedAlphaWeek(db: Database, a: { seasonId: number; factionId: number; weekStart: Date; rank: number; points?: number }) {
  const [w] = await db.insert(alphaWeeks).values({ ...a, points: a.points ?? 100 }).returning();
  return w!;
}
export async function seedSeasonResult(db: Database, a: { seasonId: number; factionId: number; rank: number; timesRaided: number; statusAtClose?: string; raids?: number; defenses?: number; points?: number }) {
  const [r] = await db.insert(seasonResults).values({
    seasonId: a.seasonId, factionId: a.factionId, rank: a.rank, points: a.points ?? 0, raids: a.raids ?? 0,
    timesRaided: a.timesRaided, defenses: a.defenses ?? 0, statusAtClose: a.statusAtClose ?? "active",
  }).returning();
  return r!;
}

/** The truncate list every achievements test uses. */
export const TRUNCATE = `truncate table achievement_unlocks, achievement_progress, achievement_counters, clan_notices, war_log_events,
  kills, player_sessions, player_positions, clan_pins, defenses, raids, alpha_weeks, season_results, season_standings, seasons,
  membership_history, ceremony_participants, ceremonies, faction_members, declarations, poles, factions, identity_links, players,
  consumer_cursors, events, adm_files, servers restart identity cascade`;
```

Check every column name against `packages/db/src/schema.ts` while writing (`seasonResults.statusAtClose` CHECK values: read the check in the schema and use one of its allowed values as the default). `seasonResults` may also require `serverId`; if the schema has it, add it to the helper's args.

- [ ] **Step 6: Run the contract test** — it now FAILS on the key-set diff with 50 missing keys. That is the correct red for Tasks 5–8.

- [ ] **Step 7: Commit** — `git add apps/bot/src/achievements apps/bot/test/achievements && git commit -m "feat(bot): achievement rule types, registry contract, test seeds"`

---

### Task 5: Solo rules (11)

**Files:**
- Modify: `apps/bot/src/achievements/rules-solo.ts`
- Create: `apps/bot/test/achievements/rules-solo.test.ts`

**Interfaces:**
- Consumes: `Owner, Rule, oneShot, nth` (Task 4), `ACHIEVEMENT_BY_KEY` (Task 1), counters table (Task 3). `explorer` and `cartographer` read `achievement_counters` rows written by Task 9's counters module; their rules are written here against the table.

- [ ] **Step 1: Failing tests**

```ts
// apps/bot/test/achievements/rules-solo.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, achievementCounters, ceremonies, ceremonyParticipants, factions, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { SOLO_RULES } from "../../src/achievements/rules-solo.js";
import { seedServer, seedLink, seedSession, seedEvent, seedMembership, seedFaction, TRUNCATE } from "./seed.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(36);
const t0 = new Date("2026-08-01T10:00:00Z");
const h = (n: number) => new Date(t0.getTime() + n * 3_600_000);
const d = (n: number) => new Date(t0.getTime() + n * 86_400_000);
const player = { kind: "player" as const, id: A };
const ctx = { now: d(60) };
const rule = (k: string) => SOLO_RULES[k as keyof typeof SOLO_RULES]!;

describe("solo rules", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => { await tx.execute(sql`set local client_min_messages = warning`); await tx.execute(sql.raw(TRUNCATE)); });
    serverId = (await seedServer(db)).id;
  });

  it("enlisted: the link, dated to verification", async () => {
    expect(await rule("enlisted")(db, player, ctx)).toEqual({ count: 0, target: 1 });
    await seedLink(db, { dayzId: A, discordId: "1", gamertag: "Ann", verifiedAt: t0 });
    expect(await rule("enlisted")(db, player, ctx)).toMatchObject({ count: 1, target: 1, earnedAt: t0 });
  });

  it("squad_up: the first full membership span", async () => {
    const f = await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: t0, activatedAt: t0 });
    expect((await rule("squad_up")(db, player, ctx)).count).toBe(0);
    await seedMembership(db, { serverId, factionId: f.id, dayzId: A, joinedAt: d(2), leftAt: d(3) });
    await seedMembership(db, { serverId, factionId: f.id, dayzId: A, joinedAt: d(5) });
    expect(await rule("squad_up")(db, player, ctx)).toMatchObject({ count: 1, earnedAt: d(2) });
  });

  it("founder: a participant of the ceremony that produced a clan", async () => {
    const f = await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: t0, activatedAt: d(1) });
    const [c] = await db.insert(ceremonies).values({ serverId, poleKey: "1.00:2.00:3.00", texture: "Flag_Bear", startedAt: t0, endsAt: d(1), status: "completed" } as never).returning();
    await db.update(factions).set({ ceremonyId: c!.id }).where(eq(factions.id, f.id));
    expect((await rule("founder")(db, player, ctx)).count).toBe(0);
    await db.insert(ceremonyParticipants).values({ ceremonyId: c!.id, dayzId: A, discordId: "1", gamertag: "Ann" });
    expect(await rule("founder")(db, player, ctx)).toMatchObject({ count: 1, earnedAt: d(1) });
  });

  it("loyalist: 30 days in one clan, open spans measured to now, earned at day 30", async () => {
    const f = await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: t0, activatedAt: t0 });
    await seedMembership(db, { serverId, factionId: f.id, dayzId: A, joinedAt: t0, leftAt: d(29) });
    expect(await rule("loyalist")(db, player, ctx)).toMatchObject({ count: 29, target: 30 });
    await seedMembership(db, { serverId, factionId: f.id, dayzId: A, joinedAt: d(29) });   // open, now = d(60)
    expect(await rule("loyalist")(db, player, ctx)).toMatchObject({ count: 31, earnedAt: d(59) });
  });

  it("long_haul / veteran: hours from closed sessions, earned when the running total crosses", async () => {
    for (let i = 0; i < 12; i++) await seedSession(db, { serverId, dayzId: A, from: d(i), to: new Date(d(i).getTime() + 2 * 3_600_000) });
    expect(await rule("long_haul")(db, player, ctx)).toMatchObject({ count: 24, earnedAt: new Date(d(11).getTime() + 2 * 3_600_000) });
    expect(await rule("veteran")(db, player, ctx)).toMatchObject({ count: 24, target: 100 });
    await seedSession(db, { serverId, dayzId: A, from: d(20), to: null });   // open: does not count
    expect((await rule("long_haul")(db, player, ctx)).count).toBe(24);
  });

  it("regular: seven consecutive UTC days with a session; a gap restarts the run", async () => {
    for (const i of [0, 1, 2, 4, 5, 6, 7, 8, 9]) await seedSession(db, { serverId, dayzId: A, from: h(24 * i + 1), to: h(24 * i + 2) });
    expect(await rule("regular")(db, player, ctx)).toMatchObject({ count: 6, target: 7 });
    await seedSession(db, { serverId, dayzId: A, from: h(24 * 10 + 1), to: h(24 * 10 + 2) });
    expect(await rule("regular")(db, player, ctx)).toMatchObject({ count: 7, earnedAt: h(24 * 10 + 1) });
  });

  it("wanderer / showman: counted from the player's own events", async () => {
    for (let i = 0; i < 10; i++) await seedEvent(db, { serverId, type: "player.teleported", at: h(i), payload: { dayzId: A, gamertag: "Ann" } });
    await seedEvent(db, { serverId, type: "player.teleported", at: h(20), payload: { dayzId: "B".repeat(36), gamertag: "Ben" } });
    expect(await rule("wanderer")(db, player, ctx)).toMatchObject({ count: 10, earnedAt: h(9) });
    for (let i = 0; i < 49; i++) await seedEvent(db, { serverId, type: "emote.performed", at: h(i), payload: { dayzId: A, gamertag: "Ann", emote: "EmoteWave" } });
    expect(await rule("showman")(db, player, ctx)).toMatchObject({ count: 49, target: 50 });
  });

  it("explorer / cartographer: read the lifetime counters, earned when the counter crossed", async () => {
    expect((await rule("explorer")(db, player, ctx)).count).toBe(0);
    await db.insert(achievementCounters).values({ ownerKind: "player", ownerId: A, key: "explorer", value: 50, detail: { squares: [], crossedAt: h(3).toISOString() } });
    expect(await rule("explorer")(db, player, ctx)).toMatchObject({ count: 50, earnedAt: h(3) });
    await db.insert(achievementCounters).values({ ownerKind: "player", ownerId: A, key: "cartographer", value: 4, detail: {} });
    expect(await rule("cartographer")(db, player, ctx)).toMatchObject({ count: 4, target: 10 });
  });
});
```

Adjust the `ceremonies` insert to the real columns in `packages/db/src/schema.ts` (line ~415); the test needs only a ceremony row a faction can point at.

- [ ] **Step 2: Run to verify it fails** — `cd apps/bot && pnpm exec vitest run test/achievements/rules-solo.test.ts` → every rule undefined.

- [ ] **Step 3: Implement**

```ts
// apps/bot/src/achievements/rules-solo.ts
import { ACHIEVEMENT_BY_KEY, type AchievementKey } from "@factions/domain";
import { achievementCounters, ceremonyParticipants, events, factions, identityLinks, membershipHistory, playerSessions } from "@factions/db";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { nth, oneShot, type Rule } from "./types.js";

const T = (k: AchievementKey) => ACHIEVEMENT_BY_KEY[k].target;
const HOUR = 3_600_000, DAY = 86_400_000;

/** Sessions with a close, ascending. Open sessions never count: their length is not known yet. */
async function closedSessions(db: Parameters<Rule>[0], dayzId: string) {
  return db.select({ id: playerSessions.id, from: playerSessions.connectedAt, to: playerSessions.disconnectedAt, serverId: playerSessions.serverId })
    .from(playerSessions).where(and(eq(playerSessions.dayzId, dayzId), isNotNull(playerSessions.disconnectedAt)))
    .orderBy(asc(playerSessions.connectedAt), asc(playerSessions.id));
}

/** Hours played; earned at the disconnect that carried the total over the target. */
const hoursPlayed = (key: AchievementKey): Rule => async (db, owner) => {
  const target = T(key);
  let ms = 0;
  for (const s of await closedSessions(db, owner.id)) {
    ms += s.to!.getTime() - s.from.getTime();
    if (ms >= target * HOUR) {
      return { count: Math.floor(ms / HOUR), target, earnedAt: s.to!, evidenceId: s.id, evidence: { hours: Math.floor(ms / HOUR) }, serverId: s.serverId };
    }
  }
  return { count: Math.floor(ms / HOUR), target };
};

/** Events of one type naming the player in the payload, ascending. */
async function ownEvents(db: Parameters<Rule>[0], type: string, dayzId: string, extra = sql`true`) {
  const rows = await db.select({ id: events.id, at: events.occurredAt, serverId: events.serverId }).from(events)
    .where(and(eq(events.type, type as never), sql`${events.payload}->>'dayzId' = ${dayzId}`, extra))
    .orderBy(asc(events.occurredAt), asc(events.id));
  return rows;
}

/** A lifetime counter (counters.ts keeps it); earned at the moment the counter recorded crossing. */
const counter = (key: AchievementKey): Rule => async (db, owner) => {
  const target = T(key);
  const [c] = await db.select().from(achievementCounters)
    .where(and(eq(achievementCounters.ownerKind, owner.kind), eq(achievementCounters.ownerId, owner.id), eq(achievementCounters.key, key)));
  if (!c) return { count: 0, target };
  const crossedAt = typeof c.detail.crossedAt === "string" ? new Date(c.detail.crossedAt) : undefined;
  return c.value >= target && crossedAt ? { count: c.value, target, earnedAt: crossedAt, evidence: { count: c.value } } : { count: c.value, target };
};

export const SOLO_RULES: Partial<Record<AchievementKey, Rule>> = {
  enlisted: async (db, owner) => {
    const [l] = await db.select({ id: identityLinks.id, at: identityLinks.verifiedAt }).from(identityLinks).where(eq(identityLinks.dayzId, owner.id));
    return oneShot(l ? { at: l.at, id: l.id } : undefined);
  },

  squad_up: async (db, owner) => {
    const [m] = await db.select({ id: membershipHistory.id, at: membershipHistory.joinedAt, serverId: membershipHistory.serverId, factionId: membershipHistory.factionId })
      .from(membershipHistory).where(eq(membershipHistory.dayzId, owner.id)).orderBy(asc(membershipHistory.joinedAt)).limit(1);
    return oneShot(m ? { at: m.at, id: m.id, serverId: m.serverId, evidence: { factionId: m.factionId } } : undefined);
  },

  founder: async (db, owner) => {
    // A participant of the ceremony a clan points at. Dated to the clan's activation (creation if never activated).
    const [r] = await db.select({ id: factions.id, at: sql<Date>`coalesce(${factions.activatedAt}, ${factions.createdAt})`, serverId: factions.serverId, tag: factions.tag })
      .from(ceremonyParticipants).innerJoin(factions, eq(factions.ceremonyId, ceremonyParticipants.ceremonyId))
      .where(eq(ceremonyParticipants.dayzId, owner.id)).orderBy(asc(factions.createdAt)).limit(1);
    return oneShot(r ? { at: new Date(r.at), id: r.id, serverId: r.serverId, evidence: { tag: r.tag } } : undefined);
  },

  loyalist: async (db, owner, { now }) => {
    // Longest single span; an open span runs to `now` — the one place a rule reads the clock, and the
    // earned_at is still joinedAt + 30 d, so live and backfill agree.
    const target = T("loyalist");
    const spans = await db.select({ id: membershipHistory.id, from: membershipHistory.joinedAt, to: membershipHistory.leftAt, serverId: membershipHistory.serverId, factionId: membershipHistory.factionId })
      .from(membershipHistory).where(eq(membershipHistory.dayzId, owner.id)).orderBy(asc(membershipHistory.joinedAt));
    let best = 0;
    for (const s of spans) {
      const days = Math.floor(((s.to ?? now).getTime() - s.from.getTime()) / DAY);
      if (days > best) best = days;
      if (days >= target) return { count: days, target, earnedAt: new Date(s.from.getTime() + target * DAY), evidenceId: s.id, evidence: { days, factionId: s.factionId }, serverId: s.serverId };
    }
    return { count: best, target };
  },

  long_haul: hoursPlayed("long_haul"),
  veteran: hoursPlayed("veteran"),

  regular: async (db, owner) => {
    // Distinct UTC dates with a session start, ascending; the longest run of consecutive dates.
    const target = T("regular");
    const sessions = await db.select({ id: playerSessions.id, at: playerSessions.connectedAt, serverId: playerSessions.serverId })
      .from(playerSessions).where(eq(playerSessions.dayzId, owner.id)).orderBy(asc(playerSessions.connectedAt));
    let run = 0, best = 0, prevDay = Number.NEGATIVE_INFINITY;
    for (const s of sessions) {
      const day = Math.floor(s.at.getTime() / DAY);
      if (day === prevDay) continue;
      run = day === prevDay + 1 ? run + 1 : 1;
      prevDay = day;
      if (run > best) best = run;
      if (run === target) return { count: run, target, earnedAt: s.at, evidenceId: s.id, evidence: { days: run }, serverId: s.serverId };
    }
    return { count: best, target };
  },

  wanderer: async (db, owner) => nth(await ownEvents(db, "player.teleported", owner.id), T("wanderer")),
  showman: async (db, owner) => nth(await ownEvents(db, "emote.performed", owner.id), T("showman")),
  explorer: counter("explorer"),
  cartographer: counter("cartographer"),
};
```

- [ ] **Step 4: Run** — `pnpm exec vitest run test/achievements/rules-solo.test.ts` → all pass. Fix column names against the schema if an insert fails; do not weaken assertions.
- [ ] **Step 5: Commit** — `git add apps/bot && git commit -m "feat(bot): the eleven solo achievement rules"`

---

### Task 6: PvE rules (12)

**Files:**
- Modify: `apps/bot/src/achievements/rules-pve.ts`
- Create: `apps/bot/test/achievements/rules-pve.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// apps/bot/test/achievements/rules-pve.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { PVE_RULES } from "../../src/achievements/rules-pve.js";
import { seedServer, seedKill, seedSession, seedEvent, TRUNCATE } from "./seed.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(36), B = "B".repeat(36);
const t0 = new Date("2026-08-01T10:00:00Z");
const h = (n: number) => new Date(t0.getTime() + n * 3_600_000);
const player = { kind: "player" as const, id: A };
const ctx = { now: h(1000) };
const rule = (k: string) => PVE_RULES[k as keyof typeof PVE_RULES]!;

describe("pve rules", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => { await tx.execute(sql`set local client_min_messages = warning`); await tx.execute(sql.raw(TRUNCATE)); });
    serverId = (await seedServer(db)).id;
  });

  it("foundation / builder / architect: base.built events by the player", async () => {
    expect((await rule("foundation")(db, player, ctx)).count).toBe(0);
    for (let i = 0; i < 100; i++) await seedEvent(db, { serverId, type: "base.built", at: h(i), payload: { dayzId: A, gamertag: "Ann", part: "Wall", structure: "Fence" } });
    await seedEvent(db, { serverId, type: "base.dismantled", at: h(200), payload: { dayzId: A, gamertag: "Ann" } });
    expect(await rule("foundation")(db, player, ctx)).toMatchObject({ count: 1, earnedAt: h(0) });
    expect(await rule("builder")(db, player, ctx)).toMatchObject({ count: 100, earnedAt: h(99) });
    expect(await rule("architect")(db, player, ctx)).toMatchObject({ count: 100, target: 500 });
  });

  it.each([
    ["wolf_bait", "wolf"], ["bear_necessities", "bear"], ["brains", "infected"], ["gravity_check", "fall"],
    ["sunday_driver", "vehicle"], ["should_have_bandaged", "bled_out"],
  ])("%s: a death with cause %s and no killer", async (key, cause) => {
    await seedKill(db, { serverId, killer: B, victim: A, at: h(0) });                       // a PvP death: not this
    expect((await rule(key)(db, player, ctx)).count).toBe(0);
    const k = await seedKill(db, { serverId, killer: null, victim: A, at: h(1), cause });
    expect(await rule(key)(db, player, ctx)).toMatchObject({ count: 1, earnedAt: h(1), evidenceId: k.id });
  });

  it("lights_out: unconscious events that were not a disconnect", async () => {
    for (let i = 0; i < 9; i++) await seedEvent(db, { serverId, type: "player.unconscious", at: h(i), payload: { dayzId: A, gamertag: "Ann", disconnecting: false } });
    await seedEvent(db, { serverId, type: "player.unconscious", at: h(9), payload: { dayzId: A, gamertag: "Ann", disconnecting: true } });
    expect(await rule("lights_out")(db, player, ctx)).toMatchObject({ count: 9, target: 10 });
    await seedEvent(db, { serverId, type: "player.unconscious", at: h(10), payload: { dayzId: A, gamertag: "Ann", disconnecting: false } });
    expect(await rule("lights_out")(db, player, ctx)).toMatchObject({ count: 10, earnedAt: h(10) });
  });

  it("nine_lives: any death counts", async () => {
    for (let i = 0; i < 8; i++) await seedKill(db, { serverId, killer: i % 2 ? B : null, victim: A, at: h(i), cause: i % 2 ? "pvp" : "fall" });
    expect(await rule("nine_lives")(db, player, ctx)).toMatchObject({ count: 8, target: 9 });
    await seedKill(db, { serverId, killer: B, victim: A, at: h(8), friendlyFire: true });
    expect(await rule("nine_lives")(db, player, ctx)).toMatchObject({ count: 9, earnedAt: h(8) });
  });

  it("ironman: hours played between deaths; a death mid-session keeps only the part after it", async () => {
    // 2 h, death at 1 h into the second session, then 2 h + 2 h + 1.5 h → best run is 1 + 2 + 2 + 1.5 = 6.5 h, crossed inside the last session
    await seedSession(db, { serverId, dayzId: A, from: h(0), to: h(2) });
    await seedSession(db, { serverId, dayzId: A, from: h(3), to: h(5) });
    await seedKill(db, { serverId, killer: null, victim: A, at: h(4), cause: "fall" });
    await seedSession(db, { serverId, dayzId: A, from: h(6), to: h(8) });
    await seedSession(db, { serverId, dayzId: A, from: h(9), to: h(11) });
    expect(await rule("ironman")(db, player, ctx)).toMatchObject({ count: 3, target: 5 });      // 1 + 2 = 3 h so far, floor
    expect((await rule("ironman")(db, player, ctx)).earnedAt).toBeUndefined();
    await seedSession(db, { serverId, dayzId: A, from: h(12), to: h(13.5) });
    // run: (5-4)=1h, +2h = 3h, +2h = 5h → crosses exactly at the end of the fourth session, h(11)
    expect(await rule("ironman")(db, player, ctx)).toMatchObject({ count: 6, earnedAt: h(11) });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — every rule undefined.

- [ ] **Step 3: Implement**

```ts
// apps/bot/src/achievements/rules-pve.ts
import { ACHIEVEMENT_BY_KEY, type AchievementKey } from "@factions/domain";
import { events, kills, playerSessions } from "@factions/db";
import { and, asc, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { nth, oneShot, type Rule } from "./types.js";

const T = (k: AchievementKey) => ACHIEVEMENT_BY_KEY[k].target;
const HOUR = 3_600_000;

async function ownEvents(db: Parameters<Rule>[0], type: string, dayzId: string, extra = sql`true`) {
  return db.select({ id: events.id, at: events.occurredAt, serverId: events.serverId }).from(events)
    .where(and(eq(events.type, type as never), sql`${events.payload}->>'dayzId' = ${dayzId}`, extra))
    .orderBy(asc(events.occurredAt), asc(events.id));
}
const built = (key: AchievementKey): Rule => async (db, owner) => nth(await ownEvents(db, "base.built", owner.id), T(key), (rows) => ({ buildPoints: rows.length }));

/** A death to the environment with the named cause; killer is null for every non-player death. */
const deathBy = (cause: string): Rule => async (db, owner) => {
  const [k] = await db.select({ id: kills.id, at: kills.occurredAt, serverId: kills.serverId }).from(kills)
    .where(and(eq(kills.victimDayzId, owner.id), isNull(kills.killerDayzId), eq(kills.cause, cause)))
    .orderBy(asc(kills.occurredAt), asc(kills.id)).limit(1);
  return oneShot(k ? { at: k.at, id: k.id, serverId: k.serverId, evidence: { cause } } : undefined);
};

export const PVE_RULES: Partial<Record<AchievementKey, Rule>> = {
  foundation: built("foundation"),
  builder: built("builder"),
  architect: built("architect"),

  wolf_bait: deathBy("wolf"),
  bear_necessities: deathBy("bear"),
  brains: deathBy("infected"),
  gravity_check: deathBy("fall"),
  sunday_driver: deathBy("vehicle"),
  should_have_bandaged: deathBy("bled_out"),

  lights_out: async (db, owner) =>
    nth(await ownEvents(db, "player.unconscious", owner.id, sql`coalesce((${events.payload}->>'disconnecting')::boolean, false) = false`), T("lights_out")),

  nine_lives: async (db, owner) => {
    const rows = await db.select({ id: kills.id, at: kills.occurredAt, serverId: kills.serverId }).from(kills)
      .where(eq(kills.victimDayzId, owner.id)).orderBy(asc(kills.occurredAt), asc(kills.id));
    return nth(rows, T("nine_lives"), (r) => ({ deaths: r.length }));
  },

  ironman: async (db, owner) => {
    // Walk closed sessions in order; a death inside a session splits it, and only time after the
    // last death counts toward the run. Earned at the instant the run reaches the target.
    const target = T("ironman");
    const sessions = await db.select({ id: playerSessions.id, from: playerSessions.connectedAt, to: playerSessions.disconnectedAt, serverId: playerSessions.serverId })
      .from(playerSessions).where(and(eq(playerSessions.dayzId, owner.id), isNotNull(playerSessions.disconnectedAt)))
      .orderBy(asc(playerSessions.connectedAt), asc(playerSessions.id));
    const deaths = (await db.select({ at: kills.occurredAt }).from(kills).where(eq(kills.victimDayzId, owner.id)).orderBy(asc(kills.occurredAt))).map((d) => d.at.getTime());
    let di = 0, run = 0, best = 0;
    for (const s of sessions) {
      let from = s.from.getTime();
      const to = s.to!.getTime();
      while (di < deaths.length && deaths[di]! < from) di++;
      while (di < deaths.length && deaths[di]! <= to) { run = 0; from = deaths[di]!; di++; }
      if (run + (to - from) >= target * HOUR) {
        const at = new Date(from + target * HOUR - run);
        return { count: target, target, earnedAt: at, evidenceId: s.id, evidence: { hours: target }, serverId: s.serverId };
      }
      run += to - from;
      if (run > best) best = run;
    }
    return { count: Math.floor(best / HOUR), target };
  },
};
```

Note on the ironman test's final expectation: after the fourth session the run is exactly 5 h at h(11), so `earnedAt` is h(11) and `count` reports the target (5), not 6. Correct the test's last line to `{ count: 5, earnedAt: h(11) }` — the rule stops at the crossing, by design, because the achievement is one-shot at the target.

- [ ] **Step 4: Run** — all pass. **Step 5: Commit** — `git commit -am "feat(bot): the twelve PvE achievement rules"`

---

### Task 7: PvP rules (15)

**Files:**
- Modify: `apps/bot/src/achievements/rules-pvp.ts`
- Create: `apps/bot/test/achievements/rules-pvp.test.ts`

**Interfaces:** consumes `streakOf` (Task 2).

- [ ] **Step 1: Failing tests**

```ts
// apps/bot/test/achievements/rules-pvp.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { PVP_RULES } from "../../src/achievements/rules-pvp.js";
import { seedServer, seedKill, seedSession, seedRaid, seedDefense, seedFaction, seedSeason, TRUNCATE } from "./seed.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(36), B = "B".repeat(36), C = "C".repeat(36);
const t0 = new Date("2026-08-01T10:00:00Z");
const m = (n: number) => new Date(t0.getTime() + n * 60_000);
const player = { kind: "player" as const, id: A };
const ctx = { now: m(100_000) };
const rule = (k: string) => PVP_RULES[k as keyof typeof PVP_RULES]!;

describe("pvp rules", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => { await tx.execute(sql`set local client_min_messages = warning`); await tx.execute(sql.raw(TRUNCATE)); });
    serverId = (await seedServer(db)).id;
  });

  it("first_blood / ten_down / centurion: PvP kills only — friendly fire and being killed do not count", async () => {
    await seedKill(db, { serverId, killer: A, victim: B, at: m(0), friendlyFire: true });
    await seedKill(db, { serverId, killer: B, victim: A, at: m(1) });
    expect((await rule("first_blood")(db, player, ctx)).count).toBe(0);
    for (let i = 0; i < 10; i++) await seedKill(db, { serverId, killer: A, victim: i % 2 ? B : C, at: m(10 + i), weapon: `W${i}`, distanceM: 20 });
    expect(await rule("first_blood")(db, player, ctx)).toMatchObject({ count: 1, earnedAt: m(10) });
    expect(await rule("ten_down")(db, player, ctx)).toMatchObject({ count: 10, earnedAt: m(19), evidence: { kills: 10 } });
    expect(await rule("centurion")(db, player, ctx)).toMatchObject({ count: 10, target: 100 });
  });

  it("marksman / sniper / point_blank: by distance, first qualifying kill, distance in the evidence", async () => {
    await seedKill(db, { serverId, killer: A, victim: B, at: m(0), distanceM: 149.9 });
    await seedKill(db, { serverId, killer: A, victim: B, at: m(1), distanceM: null });
    expect(await rule("marksman")(db, player, ctx)).toMatchObject({ count: 149, target: 150 });    // best so far, floored
    const far = await seedKill(db, { serverId, killer: A, victim: B, at: m(2), distanceM: 312.4, weapon: "Mosin" });
    expect(await rule("marksman")(db, player, ctx)).toMatchObject({ count: 312, earnedAt: m(2), evidenceId: far.id, evidence: { distanceM: 312, weapon: "Mosin" } });
    expect(await rule("sniper")(db, player, ctx)).toMatchObject({ count: 312, earnedAt: m(2) });
    expect((await rule("point_blank")(db, player, ctx)).count).toBe(0);
    await seedKill(db, { serverId, killer: A, victim: B, at: m(3), distanceM: 4.9 });
    expect(await rule("point_blank")(db, player, ctx)).toMatchObject({ count: 1, earnedAt: m(3) });
  });

  it("arsenal: distinct weapons, earned on the kill that brought the tenth", async () => {
    for (let i = 0; i < 12; i++) await seedKill(db, { serverId, killer: A, victim: B, at: m(i), weapon: `W${i % 10}` });
    expect(await rule("arsenal")(db, player, ctx)).toMatchObject({ count: 10, earnedAt: m(9) });
  });

  it("hat_trick: three PvP kills inside one of the killer's sessions", async () => {
    await seedSession(db, { serverId, dayzId: A, from: m(0), to: m(60) });
    await seedSession(db, { serverId, dayzId: A, from: m(100), to: m(160) });
    await seedKill(db, { serverId, killer: A, victim: B, at: m(5) });
    await seedKill(db, { serverId, killer: A, victim: B, at: m(50) });
    await seedKill(db, { serverId, killer: A, victim: B, at: m(105) });
    await seedKill(db, { serverId, killer: A, victim: B, at: m(110), friendlyFire: true });
    expect(await rule("hat_trick")(db, player, ctx)).toMatchObject({ count: 2, target: 3 });
    await seedKill(db, { serverId, killer: A, victim: C, at: m(55) });
    expect(await rule("hat_trick")(db, player, ctx)).toMatchObject({ count: 3, earnedAt: m(55) });
  });

  it("killing_spree / unstoppable: the streak walk, reset by a PvP death", async () => {
    for (let i = 0; i < 4; i++) await seedKill(db, { serverId, killer: A, victim: B, at: m(i) });
    await seedKill(db, { serverId, killer: B, victim: A, at: m(4) });
    for (let i = 0; i < 5; i++) await seedKill(db, { serverId, killer: A, victim: C, at: m(10 + i) });
    expect(await rule("killing_spree")(db, player, ctx)).toMatchObject({ count: 5, earnedAt: m(14) });
    expect(await rule("unstoppable")(db, player, ctx)).toMatchObject({ count: 5, target: 10 });
  });

  it("nemesis: five kills of the same player", async () => {
    for (let i = 0; i < 4; i++) { await seedKill(db, { serverId, killer: A, victim: B, at: m(i) }); await seedKill(db, { serverId, killer: A, victim: C, at: m(100 + i) }); }
    expect(await rule("nemesis")(db, player, ctx)).toMatchObject({ count: 4, target: 5 });
    await seedKill(db, { serverId, killer: A, victim: C, at: m(200) });
    expect(await rule("nemesis")(db, player, ctx)).toMatchObject({ count: 5, earnedAt: m(200), evidence: { victim: C, kills: 5 } });
  });

  it("payback: killing your killer within an hour, not after", async () => {
    await seedKill(db, { serverId, killer: B, victim: A, at: m(0) });
    await seedKill(db, { serverId, killer: A, victim: B, at: m(61) });
    expect((await rule("payback")(db, player, ctx)).count).toBe(0);
    await seedKill(db, { serverId, killer: C, victim: A, at: m(100) });
    const pay = await seedKill(db, { serverId, killer: A, victim: C, at: m(159) });
    expect(await rule("payback")(db, player, ctx)).toMatchObject({ count: 1, earnedAt: m(159), evidenceId: pay.id });
  });

  it("flag_thief / home_defender / blue_on_blue", async () => {
    const bear = await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: t0, activatedAt: t0 });
    const wolf = await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", poleKey: "9000.00:100.00:9000.00", x: 9000, z: 9000, createdAt: t0, activatedAt: t0 });
    const season = await seedSeason(db, serverId, t0);
    expect((await rule("flag_thief")(db, player, ctx)).count).toBe(0);
    await seedRaid(db, { serverId, seasonId: season.id, victimFactionId: wolf.id, raiderDayzId: A, raiderFactionId: bear.id, at: m(5) });
    expect(await rule("flag_thief")(db, player, ctx)).toMatchObject({ count: 1, earnedAt: m(5) });
    await seedDefense(db, { serverId, factionId: bear.id, seasonId: season.id, raisedByDayzId: A, at: m(9), siegeSeconds: 3600 });
    expect(await rule("home_defender")(db, player, ctx)).toMatchObject({ count: 1, earnedAt: m(9), evidence: { siegeSeconds: 3600 } });
    expect((await rule("blue_on_blue")(db, player, ctx)).count).toBe(0);
    await seedKill(db, { serverId, killer: A, victim: B, at: m(20), friendlyFire: true });
    expect(await rule("blue_on_blue")(db, player, ctx)).toMatchObject({ count: 1, earnedAt: m(20) });
  });
});
```

`seedSeason` returns the season row; check `apps/bot/test/seed.ts` — if it returns void, select the row from `seasons` after seeding.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

```ts
// apps/bot/src/achievements/rules-pvp.ts
import { ACHIEVEMENT_BY_KEY, streakOf, type AchievementKey } from "@factions/domain";
import { defenses, kills, playerSessions, raids } from "@factions/db";
import { and, asc, eq, ne, isNotNull, or, sql } from "drizzle-orm";
import { nth, oneShot, type Rule, type RuleResult } from "./types.js";

const T = (k: AchievementKey) => ACHIEVEMENT_BY_KEY[k].target;

/** A PvP kill: another player did it, and it was not friendly fire (Global Constraints). */
const pvpBy = (dayzId: string) => and(eq(kills.killerDayzId, dayzId), ne(kills.victimDayzId, dayzId), eq(kills.friendlyFire, false));
const killCols = { id: kills.id, at: kills.occurredAt, serverId: kills.serverId, victim: kills.victimDayzId, weapon: kills.weapon, distanceM: kills.distanceM };
type KillRow = { id: number; at: Date; serverId: number; victim: string; weapon: string | null; distanceM: string | null };

async function pvpKills(db: Parameters<Rule>[0], dayzId: string): Promise<KillRow[]> {
  return db.select(killCols).from(kills).where(pvpBy(dayzId)).orderBy(asc(kills.occurredAt), asc(kills.id));
}
const killCount = (key: AchievementKey): Rule => async (db, owner) => nth(await pvpKills(db, owner.id), T(key), (r) => ({ kills: r.length }));

/** Distance rules report the best distance so far as progress, and the first kill past the line as the unlock. */
const distance = (key: AchievementKey, qualifies: (d: number) => boolean): Rule => async (db, owner) => {
  const target = T(key);
  let best = 0;
  for (const k of await pvpKills(db, owner.id)) {
    if (k.distanceM === null) continue;
    const d = Number(k.distanceM);
    if (d > best) best = d;
    if (qualifies(d)) return { count: Math.floor(d), target, earnedAt: k.at, evidenceId: k.id, evidence: { distanceM: Math.floor(d), weapon: k.weapon }, serverId: k.serverId };
  }
  return { count: key === "point_blank" ? 0 : Math.floor(best), target };
};

export const PVP_RULES: Partial<Record<AchievementKey, Rule>> = {
  first_blood: killCount("first_blood"),
  ten_down: killCount("ten_down"),
  centurion: killCount("centurion"),
  marksman: distance("marksman", (d) => d >= T("marksman")),
  sniper: distance("sniper", (d) => d >= T("sniper")),
  point_blank: distance("point_blank", (d) => d < T("point_blank")),

  arsenal: async (db, owner) => {
    const target = T("arsenal");
    const seen = new Set<string>();
    for (const k of await pvpKills(db, owner.id)) {
      if (!k.weapon || seen.has(k.weapon)) continue;
      seen.add(k.weapon);
      if (seen.size === target) return { count: target, target, earnedAt: k.at, evidenceId: k.id, evidence: { weapons: [...seen].join(", ") }, serverId: k.serverId };
    }
    return { count: seen.size, target };
  },

  hat_trick: async (db, owner) => {
    // Each PvP kill joined to the killer's session that contains it; the third kill in any one session earns it.
    const target = T("hat_trick");
    const rows = await db.select({ id: kills.id, at: kills.occurredAt, serverId: kills.serverId, session: playerSessions.id })
      .from(kills).innerJoin(playerSessions, and(
        eq(playerSessions.dayzId, kills.killerDayzId),
        sql`${playerSessions.connectedAt} <= ${kills.occurredAt}`,
        sql`(${playerSessions.disconnectedAt} is null or ${kills.occurredAt} < ${playerSessions.disconnectedAt})`,
      ))
      .where(pvpBy(owner.id)).orderBy(asc(kills.occurredAt), asc(kills.id));
    const per = new Map<number, number>();
    let best = 0;
    for (const r of rows) {
      const n = (per.get(r.session) ?? 0) + 1;
      per.set(r.session, n);
      if (n > best) best = n;
      if (n === target) return { count: n, target, earnedAt: r.at, evidenceId: r.id, evidence: { kills: n }, serverId: r.serverId };
    }
    return { count: best, target };
  },

  killing_spree: streak("killing_spree"),
  unstoppable: streak("unstoppable"),

  nemesis: async (db, owner) => {
    const target = T("nemesis");
    const per = new Map<string, number>();
    let best = 0;
    for (const k of await pvpKills(db, owner.id)) {
      const n = (per.get(k.victim) ?? 0) + 1;
      per.set(k.victim, n);
      if (n > best) best = n;
      if (n === target) return { count: n, target, earnedAt: k.at, evidenceId: k.id, evidence: { victim: k.victim, kills: n }, serverId: k.serverId };
    }
    return { count: best, target };
  },

  payback: async (db, owner) => {
    // My kill of V at t, where V killed me at t′ with 0 < t − t′ ≤ 1 h. One SQL self-join, earliest first.
    const k2 = sql`k2`;
    const [row] = await db.execute<{ id: number; at: Date; server_id: number; victim: string }>(sql`
      select k.id, k.occurred_at as at, k.server_id, k.victim_dayz_id as victim
      from kills k
      where k.killer_dayz_id = ${owner.id} and k.victim_dayz_id <> ${owner.id} and k.friendly_fire = false
        and exists (
          select 1 from kills ${k2}
          where ${k2}.killer_dayz_id = k.victim_dayz_id and ${k2}.victim_dayz_id = ${owner.id}
            and ${k2}.occurred_at < k.occurred_at and k.occurred_at - ${k2}.occurred_at <= interval '1 hour'
        )
      order by k.occurred_at, k.id limit 1`);
    return oneShot(row ? { at: new Date(row.at), id: Number(row.id), serverId: Number(row.server_id), evidence: { victim: row.victim } } : undefined);
  },

  flag_thief: async (db, owner) => {
    const [r] = await db.select({ id: raids.id, at: raids.firstLowerAt, serverId: raids.serverId, victim: raids.victimFactionId })
      .from(raids).where(eq(raids.raiderDayzId, owner.id)).orderBy(asc(raids.firstLowerAt)).limit(1);
    return oneShot(r ? { at: r.at, id: r.id, serverId: r.serverId, evidence: { victimFactionId: r.victim } } : undefined);
  },

  home_defender: async (db, owner) => {
    const [d] = await db.select({ id: defenses.id, at: defenses.defendedAt, siege: defenses.siegeSeconds, factionId: defenses.factionId })
      .from(defenses).where(eq(defenses.raisedByDayzId, owner.id)).orderBy(asc(defenses.defendedAt)).limit(1);
    return oneShot(d ? { at: d.at, id: d.id, evidence: { siegeSeconds: d.siege, factionId: d.factionId } } : undefined);
  },

  blue_on_blue: async (db, owner) => {
    const [k] = await db.select(killCols).from(kills).where(and(eq(kills.killerDayzId, owner.id), eq(kills.friendlyFire, true)))
      .orderBy(asc(kills.occurredAt), asc(kills.id)).limit(1);
    return oneShot(k ? { at: k.at, id: k.id, serverId: k.serverId, evidence: { victim: k.victim } } : undefined);
  },
};

function streak(key: AchievementKey): Rule {
  return async (db, owner): Promise<RuleResult> => {
    const target = T(key);
    // Every kill row the player is on either side of, ascending — the walk needs deaths too.
    const rows = await db.select({ id: kills.id, killer: kills.killerDayzId, victim: kills.victimDayzId, friendlyFire: kills.friendlyFire, occurredAt: kills.occurredAt, serverId: kills.serverId })
      .from(kills).where(and(or(eq(kills.killerDayzId, owner.id), eq(kills.victimDayzId, owner.id)), isNotNull(kills.killerDayzId)))
      .orderBy(asc(kills.occurredAt), asc(kills.id));
    const s = streakOf(rows, owner.id);
    const at = s.reachedAt(target);
    if (!at) return { count: s.best, target };
    const crossing = rows.find((r) => r.occurredAt.getTime() === at.getTime() && r.killer === owner.id)!;
    return { count: s.best, target, earnedAt: at, evidenceId: crossing.id, evidence: { streak: target }, serverId: crossing.serverId };
  };
}
```

`home_defender` has no `serverId` on the defenses row; the tick resolves it from the faction (Task 9). Payback's raw SQL uses the real column names from schema.ts — verify them (`killer_dayz_id`, `victim_dayz_id`, `friendly_fire`, `occurred_at`, `server_id`).

- [ ] **Step 4: Run** — all pass. **Step 5: Commit** — `git commit -am "feat(bot): the fifteen PvP achievement rules"`

---

### Task 8: Team rules (12) — closes the registry contract

**Files:**
- Modify: `apps/bot/src/achievements/rules-team.ts`
- Create: `apps/bot/test/achievements/rules-team.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// apps/bot/test/achievements/rules-team.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, factions, seasons, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { TEAM_RULES } from "../../src/achievements/rules-team.js";
import { seedServer, seedFaction, seedSeason, seedMembership, seedRaid, seedDefense, seedAlphaWeek, seedSeasonResult, TRUNCATE } from "./seed.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(36);
const t0 = new Date("2026-08-03T00:00:00Z");   // a Monday
const d = (n: number) => new Date(t0.getTime() + n * 86_400_000);
const rule = (k: string) => TEAM_RULES[k as keyof typeof TEAM_RULES]!;
const ctx = { now: d(400) };

describe("team rules", () => {
  let db: Database; let serverId = 0; let bear = 0; let wolf = 0; let seasonId = 0;
  const clan = () => ({ kind: "clan" as const, id: String(bear) });
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => { await tx.execute(sql`set local client_min_messages = warning`); await tx.execute(sql.raw(TRUNCATE)); });
    serverId = (await seedServer(db)).id;
    bear = (await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: d(0), activatedAt: null })).id;
    wolf = (await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", poleKey: "9000.00:100.00:9000.00", x: 9000, z: 9000, createdAt: d(0), activatedAt: d(0) })).id;
    await seedSeason(db, serverId, d(0));
    seasonId = (await db.select({ id: seasons.id }).from(seasons))[0]!.id;
  });

  it("colors_raised: activation, dated to it", async () => {
    expect((await rule("colors_raised")(db, clan(), ctx)).count).toBe(0);
    await db.update(factions).set({ activatedAt: d(1) }).where(eq(factions.id, bear));
    expect(await rule("colors_raised")(db, clan(), ctx)).toMatchObject({ count: 1, earnedAt: d(1), evidence: { tag: "BEAR" } });
  });

  it("full_strength: ten overlapping membership spans, earned when the tenth joined", async () => {
    for (let i = 0; i < 9; i++) await seedMembership(db, { serverId, factionId: bear, dayzId: `${i}`.padStart(36, "M"), joinedAt: d(i), leftAt: null });
    await seedMembership(db, { serverId, factionId: bear, dayzId: "Z".repeat(36), joinedAt: d(1), leftAt: d(2) });   // gone before the tenth
    expect(await rule("full_strength")(db, clan(), ctx)).toMatchObject({ count: 9, target: 10 });
    await seedMembership(db, { serverId, factionId: bear, dayzId: "T".repeat(36), joinedAt: d(12), leftAt: null });
    expect(await rule("full_strength")(db, clan(), ctx)).toMatchObject({ count: 10, earnedAt: d(12) });
  });

  it("first_raid / warpath / giant_killer / wide_net: from the raids the clan made", async () => {
    expect((await rule("first_raid")(db, clan(), ctx)).count).toBe(0);
    const r1 = await seedRaid(db, { serverId, seasonId, victimFactionId: wolf, raiderDayzId: A, raiderFactionId: bear, at: d(1), victimRank: 2 });
    expect(await rule("first_raid")(db, clan(), ctx)).toMatchObject({ count: 1, earnedAt: d(1), evidenceId: r1.id });
    expect((await rule("giant_killer")(db, clan(), ctx)).count).toBe(0);
    await seedRaid(db, { serverId, seasonId, victimFactionId: wolf, raiderDayzId: A, raiderFactionId: bear, at: d(2), victimRank: 1 });
    expect(await rule("giant_killer")(db, clan(), ctx)).toMatchObject({ count: 1, earnedAt: d(2) });
    expect(await rule("warpath")(db, clan(), ctx)).toMatchObject({ count: 2, target: 25 });
    expect(await rule("wide_net")(db, clan(), ctx)).toMatchObject({ count: 1, target: 5 });
    await seedRaid(db, { serverId, seasonId, victimFactionId: bear, raiderDayzId: A, raiderFactionId: wolf, at: d(3) });   // against us: not ours
    expect((await rule("warpath")(db, clan(), ctx)).count).toBe(2);
  });

  it("fortress: ten defenses", async () => {
    for (let i = 0; i < 10; i++) await seedDefense(db, { serverId, factionId: bear, seasonId, raisedByDayzId: A, at: d(i), siegeSeconds: 60 });
    expect(await rule("fortress")(db, clan(), ctx)).toMatchObject({ count: 10, earnedAt: d(9) });
  });

  it("alpha / dynasty: weeks in the top three; dynasty needs four consecutive week starts", async () => {
    await seedAlphaWeek(db, { seasonId, factionId: bear, weekStart: d(0), rank: 2 });
    expect(await rule("alpha")(db, clan(), ctx)).toMatchObject({ count: 1, earnedAt: d(7) });
    await seedAlphaWeek(db, { seasonId, factionId: bear, weekStart: d(7), rank: 1 });
    await seedAlphaWeek(db, { seasonId, factionId: bear, weekStart: d(21), rank: 3 });   // gap at d(14)
    await seedAlphaWeek(db, { seasonId, factionId: bear, weekStart: d(28), rank: 3 });
    await seedAlphaWeek(db, { seasonId, factionId: bear, weekStart: d(35), rank: 3 });
    expect(await rule("dynasty")(db, clan(), ctx)).toMatchObject({ count: 3, target: 4 });
    await seedAlphaWeek(db, { seasonId, factionId: bear, weekStart: d(42), rank: 2 });
    expect(await rule("dynasty")(db, clan(), ctx)).toMatchObject({ count: 4, earnedAt: d(49) });
  });

  it("podium / untouched / champions: from the closed season", async () => {
    await db.update(seasons).set({ endedAt: d(60), championFactionId: bear }).where(eq(seasons.id, seasonId));
    await db.update(factions).set({ activatedAt: d(0) }).where(eq(factions.id, bear));
    expect((await rule("podium")(db, clan(), ctx)).count).toBe(0);
    await seedSeasonResult(db, { seasonId, factionId: bear, rank: 1, timesRaided: 0 });
    expect(await rule("podium")(db, clan(), ctx)).toMatchObject({ count: 1, earnedAt: d(60), evidence: { rank: 1, season: 1 } });
    expect(await rule("untouched")(db, clan(), ctx)).toMatchObject({ count: 1, earnedAt: d(60) });
    expect(await rule("champions")(db, clan(), ctx)).toMatchObject({ count: 1, earnedAt: d(60) });
  });

  it("untouched needs the whole season: a clan activated mid-season does not qualify", async () => {
    await db.update(seasons).set({ endedAt: d(60) }).where(eq(seasons.id, seasonId));
    await db.update(factions).set({ activatedAt: d(10) }).where(eq(factions.id, bear));
    await seedSeasonResult(db, { seasonId, factionId: bear, rank: 4, timesRaided: 0 });
    expect((await rule("untouched")(db, clan(), ctx)).count).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

```ts
// apps/bot/src/achievements/rules-team.ts
import { ACHIEVEMENT_BY_KEY, type AchievementKey } from "@factions/domain";
import { alphaWeeks, defenses, factions, membershipHistory, raids, seasonResults, seasons } from "@factions/db";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { clanId, nth, oneShot, type Rule } from "./types.js";

const T = (k: AchievementKey) => ACHIEVEMENT_BY_KEY[k].target;
const WEEK = 7 * 86_400_000;

async function ownRaids(db: Parameters<Rule>[0], factionId: number) {
  return db.select({ id: raids.id, at: raids.firstLowerAt, serverId: raids.serverId, victim: raids.victimFactionId, victimRank: raids.victimRankAtLower })
    .from(raids).where(eq(raids.raiderFactionId, factionId)).orderBy(asc(raids.firstLowerAt), asc(raids.id));
}
/** A closed season the clan placed in, with the clan's activation, so "whole season" can be checked. */
async function closedSeasons(db: Parameters<Rule>[0], factionId: number) {
  return db.select({
    id: seasonResults.id, rank: seasonResults.rank, timesRaided: seasonResults.timesRaided, statusAtClose: seasonResults.statusAtClose,
    number: seasons.number, startedAt: seasons.startedAt, endedAt: seasons.endedAt, serverId: seasons.serverId, champion: seasons.championFactionId,
  }).from(seasonResults).innerJoin(seasons, eq(seasons.id, seasonResults.seasonId))
    .where(and(eq(seasonResults.factionId, factionId), isNotNull(seasons.endedAt))).orderBy(asc(seasons.endedAt));
}
const raidCount = (key: AchievementKey): Rule => async (db, owner) => nth(await ownRaids(db, clanId(owner)), T(key), (r) => ({ raids: r.length }));

export const TEAM_RULES: Partial<Record<AchievementKey, Rule>> = {
  colors_raised: async (db, owner) => {
    const [f] = await db.select({ id: factions.id, at: factions.activatedAt, serverId: factions.serverId, tag: factions.tag }).from(factions).where(eq(factions.id, clanId(owner)));
    return oneShot(f?.at ? { at: f.at, id: f.id, serverId: f.serverId, evidence: { tag: f.tag } } : undefined);
  },

  full_strength: async (db, owner) => {
    // Sweep line over spans: +1 at each join, −1 at each leave (leaves before joins at the same instant).
    const target = T("full_strength");
    const spans = await db.select({ id: membershipHistory.id, from: membershipHistory.joinedAt, to: membershipHistory.leftAt, serverId: membershipHistory.serverId })
      .from(membershipHistory).where(eq(membershipHistory.factionId, clanId(owner)));
    const points: { t: number; delta: number; span: typeof spans[number] }[] = [];
    for (const s of spans) { points.push({ t: s.from.getTime(), delta: +1, span: s }); if (s.to) points.push({ t: s.to.getTime(), delta: -1, span: s }); }
    points.sort((a, b) => a.t - b.t || a.delta - b.delta);
    let n = 0, best = 0;
    for (const p of points) {
      n += p.delta;
      if (n > best) best = n;
      if (n === target && p.delta > 0) return { count: n, target, earnedAt: new Date(p.t), evidenceId: p.span.id, evidence: { members: n }, serverId: p.span.serverId };
    }
    return { count: best, target };
  },

  first_raid: raidCount("first_raid"),
  warpath: raidCount("warpath"),

  giant_killer: async (db, owner) => {
    const r = (await ownRaids(db, clanId(owner))).find((x) => x.victimRank === 1);
    return oneShot(r ? { at: r.at, id: r.id, serverId: r.serverId, evidence: { victimFactionId: r.victim } } : undefined);
  },

  wide_net: async (db, owner) => {
    const target = T("wide_net");
    const seen = new Set<number>();
    for (const r of await ownRaids(db, clanId(owner))) {
      if (seen.has(r.victim)) continue;
      seen.add(r.victim);
      if (seen.size === target) return { count: target, target, earnedAt: r.at, evidenceId: r.id, evidence: { clans: target }, serverId: r.serverId };
    }
    return { count: seen.size, target };
  },

  fortress: async (db, owner) => {
    const rows = await db.select({ id: defenses.id, at: defenses.defendedAt }).from(defenses).where(eq(defenses.factionId, clanId(owner))).orderBy(asc(defenses.defendedAt), asc(defenses.id));
    return nth(rows, T("fortress"), (r) => ({ defenses: r.length }));
  },

  alpha: async (db, owner) => {
    const [w] = await db.select({ id: alphaWeeks.id, weekStart: alphaWeeks.weekStart, rank: alphaWeeks.rank }).from(alphaWeeks)
      .where(eq(alphaWeeks.factionId, clanId(owner))).orderBy(asc(alphaWeeks.weekStart)).limit(1);
    // A week is earned when it closes: its start plus seven days.
    return oneShot(w ? { at: new Date(w.weekStart.getTime() + WEEK), id: w.id, evidence: { rank: w.rank } } : undefined);
  },

  dynasty: async (db, owner) => {
    const target = T("dynasty");
    const weeks = await db.select({ id: alphaWeeks.id, weekStart: alphaWeeks.weekStart }).from(alphaWeeks)
      .where(eq(alphaWeeks.factionId, clanId(owner))).orderBy(asc(alphaWeeks.weekStart));
    let run = 0, best = 0, prev = Number.NEGATIVE_INFINITY;
    for (const w of weeks) {
      const t = w.weekStart.getTime();
      run = t - prev === WEEK ? run + 1 : 1;
      prev = t;
      if (run > best) best = run;
      if (run === target) return { count: run, target, earnedAt: new Date(t + WEEK), evidenceId: w.id, evidence: { weeks: run } };
    }
    return { count: best, target };
  },

  podium: async (db, owner) => {
    const s = (await closedSeasons(db, clanId(owner))).find((x) => x.rank <= 3);
    return oneShot(s ? { at: s.endedAt!, id: s.id, serverId: s.serverId, evidence: { rank: s.rank, season: s.number } } : undefined);
  },

  untouched: async (db, owner) => {
    // Never raided across a season the clan was active for ALL of: activated on or before the
    // season opened, and still holding at the close (the result row's status).
    const [f] = await db.select({ activatedAt: factions.activatedAt }).from(factions).where(eq(factions.id, clanId(owner)));
    const s = (await closedSeasons(db, clanId(owner))).find((x) =>
      x.timesRaided === 0 && f?.activatedAt && f.activatedAt.getTime() <= x.startedAt.getTime() && ["active", "dormant", "reserved"].includes(x.statusAtClose));
    return oneShot(s ? { at: s.endedAt!, id: s.id, serverId: s.serverId, evidence: { season: s.number } } : undefined);
  },

  champions: async (db, owner) => {
    const [s] = await db.select({ id: seasons.id, at: seasons.endedAt, serverId: seasons.serverId, number: seasons.number }).from(seasons)
      .where(and(eq(seasons.championFactionId, clanId(owner)), isNotNull(seasons.endedAt))).orderBy(asc(seasons.endedAt)).limit(1);
    return oneShot(s ? { at: s.at!, id: s.id, serverId: s.serverId, evidence: { season: s.number } } : undefined);
  },
};
```

`untouched`'s status list should be `HOLDING_STATUSES` from `@factions/domain` if it is exported (it is — see CLAUDE.md); use it instead of the literal array.

- [ ] **Step 4: Run** — `pnpm exec vitest run test/achievements/` → every rule file passes AND `rules.test.ts` (the registry contract) now passes. Then `pnpm exec tsc --noEmit` in `apps/bot` → clean: `RULES` is a full `Record<AchievementKey, Rule>`.
- [ ] **Step 5: Commit** — `git commit -am "feat(bot): the twelve team achievement rules; registry complete"`

---

### Task 9: Counters, touched set, and the tick

**Files:**
- Create: `apps/bot/src/achievements/counters.ts`, `apps/bot/src/achievements/touched.ts`, `apps/bot/src/achievements/tick.ts`
- Create: `apps/bot/test/achievements/counters.test.ts`, `apps/bot/test/achievements/tick.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // counters.ts
  export const gridSquare: (x: number, z: number) => number;          // Math.floor(x/1000) * 1000 + Math.floor(z/1000) — an index, never a coordinate
  export async function applyPositionCounters(tx, rows: { dayzId: string; x: number; z: number; at: Date }[]): Promise<void>;
  export async function applyPinCounters(tx, rows: { dayzId: string; at: Date }[]): Promise<void>;
  // touched.ts
  export type Watermarks = Record<Source, number>;   // Source = "kills" | "sessions" | "events" | "raids" | "defenses" | "alphaWeeks" | "seasonResults" | "membership" | "ceremonies" | "links" | "pins" | "positions" | "activations"
  export const CURSOR_PREFIX = "achievements:";
  export async function readWatermarks(db): Promise<Watermarks>;
  export async function collectTouched(db, wm: Watermarks, limit: number): Promise<{ owners: Owner[]; next: Watermarks; positions: PositionRow[]; pins: PinRow[] }>;
  // tick.ts
  export type AchievementsTickOpts = { now?: Date; batch?: number; everyone?: boolean; announce?: boolean; achievementsChannelId?: string };
  export type AchievementsTickResult = { evaluated: number; unlocked: number; carried: number; failed: number };
  export async function achievementsTick(db: Database, opts: AchievementsTickOpts): Promise<AchievementsTickResult>;
  export async function evaluateOwner(db, owner: Owner, now: Date): Promise<{ key: AchievementKey; result: RuleResult }[]>;   // exported for the roster's tests and the backfill
  ```

- [ ] **Step 1: Failing counter tests**

```ts
// apps/bot/test/achievements/counters.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, achievementCounters, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { applyPinCounters, applyPositionCounters, gridSquare } from "../../src/achievements/counters.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(36);
const t = (n: number) => new Date(1_756_000_000_000 + n * 60_000);

describe("achievement counters", () => {
  let db: Database;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table achievement_counters`);
  });

  it("gridSquare indexes 1 km squares and is not a coordinate", () => {
    expect(gridSquare(5050, 7020)).toBe(5 * 1000 + 7);
    expect(gridSquare(5999.9, 7000)).toBe(gridSquare(5000, 7999));
  });

  it("explorer: the visited-square set grows across passes, records when it crossed 50, and never stores x/z", async () => {
    const rows = Array.from({ length: 49 }, (_, i) => ({ dayzId: A, x: i * 1000 + 1, z: 500, at: t(i) }));
    await db.transaction((tx) => applyPositionCounters(tx, rows));
    let [c] = await db.select().from(achievementCounters);
    expect(c).toMatchObject({ key: "explorer", value: 49 });
    expect(c!.detail.crossedAt).toBeUndefined();
    await db.transaction((tx) => applyPositionCounters(tx, [{ dayzId: A, x: 1, z: 500, at: t(100) }, { dayzId: A, x: 1, z: 1500, at: t(101) }]));
    [c] = await db.select().from(achievementCounters);
    expect(c).toMatchObject({ value: 50, detail: expect.objectContaining({ crossedAt: t(101).toISOString() }) });
    expect(JSON.stringify(c!.detail)).not.toMatch(/"x"|"z"/u);
  });

  it("cartographer: pins dropped, counted for life, crossing recorded", async () => {
    await db.transaction((tx) => applyPinCounters(tx, Array.from({ length: 9 }, (_, i) => ({ dayzId: A, at: t(i) }))));
    await db.transaction((tx) => applyPinCounters(tx, [{ dayzId: A, at: t(20) }]));
    const [c] = await db.select().from(achievementCounters);
    expect(c).toMatchObject({ key: "cartographer", value: 10, detail: { crossedAt: t(20).toISOString() } });
  });
});
```

- [ ] **Step 2: Implement counters.ts**

```ts
// apps/bot/src/achievements/counters.ts
import { ACHIEVEMENT_BY_KEY } from "@factions/domain";
import { achievementCounters, type Database } from "@factions/db";
import { and, eq } from "drizzle-orm";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** A 1 km square as one integer. ⚠️ Deliberately lossy: the counter must never be able to give a position back. */
export const gridSquare = (x: number, z: number): number => Math.floor(x / 1000) * 1000 + Math.floor(z / 1000);

async function readCounter(tx: Tx, ownerId: string, key: string) {
  const [c] = await tx.select().from(achievementCounters)
    .where(and(eq(achievementCounters.ownerKind, "player"), eq(achievementCounters.ownerId, ownerId), eq(achievementCounters.key, key)));
  return c;
}
async function writeCounter(tx: Tx, ownerId: string, key: string, value: number, detail: Record<string, unknown>) {
  await tx.insert(achievementCounters).values({ ownerKind: "player", ownerId, key, value, detail, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [achievementCounters.ownerKind, achievementCounters.ownerId, achievementCounters.key], set: { value, detail, updatedAt: new Date() } });
}

/** New position fixes, in time order. Squares are added to each player's set; the fix that made it 50 is `crossedAt`. */
export async function applyPositionCounters(tx: Tx, rows: readonly { dayzId: string; x: number; z: number; at: Date }[]): Promise<void> {
  const target = ACHIEVEMENT_BY_KEY.explorer.target;
  const byPlayer = new Map<string, typeof rows>();
  for (const r of rows) byPlayer.set(r.dayzId, [...(byPlayer.get(r.dayzId) ?? []), r]);
  for (const [dayzId, fixes] of byPlayer) {
    const c = await readCounter(tx, dayzId, "explorer");
    const squares = new Set<number>((c?.detail.squares as number[] | undefined) ?? []);
    let crossedAt = c?.detail.crossedAt as string | undefined;
    for (const f of fixes) {
      squares.add(gridSquare(f.x, f.z));
      if (!crossedAt && squares.size >= target) crossedAt = f.at.toISOString();
    }
    await writeCounter(tx, dayzId, "explorer", squares.size, { squares: [...squares].sort((a, b) => a - b), ...(crossedAt ? { crossedAt } : {}) });
  }
}

/** New pins, in time order. Deleting a pin later does not un-drop it. */
export async function applyPinCounters(tx: Tx, rows: readonly { dayzId: string; at: Date }[]): Promise<void> {
  const target = ACHIEVEMENT_BY_KEY.cartographer.target;
  const byPlayer = new Map<string, typeof rows>();
  for (const r of rows) byPlayer.set(r.dayzId, [...(byPlayer.get(r.dayzId) ?? []), r]);
  for (const [dayzId, pins] of byPlayer) {
    const c = await readCounter(tx, dayzId, "cartographer");
    let value = c?.value ?? 0;
    let crossedAt = c?.detail.crossedAt as string | undefined;
    for (const p of pins) { value += 1; if (!crossedAt && value >= target) crossedAt = p.at.toISOString(); }
    await writeCounter(tx, dayzId, "cartographer", value, crossedAt ? { crossedAt } : {});
  }
}
```

- [ ] **Step 3: Run counter tests → pass. Commit** — `git add apps/bot && git commit -m "feat(bot): lifetime counters for explorer and cartographer"`

- [ ] **Step 4: Failing tick tests**

```ts
// apps/bot/test/achievements/tick.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, achievementUnlocks, achievementProgress, clanNotices, consumerCursors, factions, playerPositions, clanPins, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { achievementsTick } from "../../src/achievements/tick.js";
import { RULES } from "../../src/achievements/rules.js";
import { seedServer, seedLink, seedKill, seedFaction, seedMembership, seedEvent, TRUNCATE } from "./seed.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(36), B = "B".repeat(36);
const t0 = new Date("2026-08-01T10:00:00Z");
const m = (n: number) => new Date(t0.getTime() + n * 60_000);
const CH = "123456789012345678";

describe("achievementsTick", () => {
  let db: Database; let serverId = 0; let bear = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => { await tx.execute(sql`set local client_min_messages = warning`); await tx.execute(sql.raw(TRUNCATE)); });
    serverId = (await seedServer(db)).id;
    bear = (await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: t0, activatedAt: t0 })).id;
    await db.update(factions).set({ discordTextChannelId: "999999999999999999" }).where(eq(factions.id, bear));
    await seedLink(db, { dayzId: A, discordId: "111111111111111111", gamertag: "Ann", verifiedAt: t0 });
    await seedMembership(db, { serverId, factionId: bear, dayzId: A, joinedAt: t0, leftAt: null });
  });

  it("evaluates only owners touched since the last pass, unlocks with evidence, and queues the three notices", async () => {
    await seedKill(db, { serverId, killer: A, victim: B, at: m(1), weapon: "Mosin", distanceM: 320 });
    const r = await achievementsTick(db, { now: m(10), achievementsChannelId: CH });
    expect(r.evaluated).toBeGreaterThanOrEqual(2);   // A (killer) and B (victim), plus the clan via membership
    const unlocks = await db.select().from(achievementUnlocks).where(eq(achievementUnlocks.ownerId, A));
    const keys = unlocks.map((u) => u.key).sort();
    expect(keys).toEqual(expect.arrayContaining(["enlisted", "squad_up", "first_blood", "marksman", "sniper"]));
    expect(unlocks.find((u) => u.key === "sniper")).toMatchObject({ earnedAt: m(1), evidence: { distanceM: 320, weapon: "Mosin" } });
    const notices = await db.select().from(clanNotices).where(sql`${clanNotices.payload}->>'key' = 'sniper'`);
    const targets = notices.map((n) => `${n.target}:${n.factionId ?? "-"}:${n.discordTargetId ?? "-"}`).sort();
    expect(targets).toEqual([`channel:${bear}:-`, `channel:-:${CH}`, `dm:${bear}:111111111111111111`].sort());
    expect(notices[0]!.payload).toMatchObject({ key: "sniper", name: "Sniper", ownerKind: "player", ownerName: "Ann", clanTag: "BEAR" });
    // progress cached for every key of the owner's kind
    expect((await db.select().from(achievementProgress).where(eq(achievementProgress.ownerId, A))).length).toBe(38);
    // second pass: nothing new touched, nothing evaluated, nothing duplicated
    const again = await achievementsTick(db, { now: m(11), achievementsChannelId: CH });
    expect(again).toMatchObject({ evaluated: 0, unlocked: 0 });
  });

  it("a team unlock notifies the clan channel, the public channel and every full member by DM", async () => {
    await seedLink(db, { dayzId: B, discordId: "222222222222222222", gamertag: "Ben", verifiedAt: t0 });
    await seedMembership(db, { serverId, factionId: bear, dayzId: B, joinedAt: t0, leftAt: null });
    await db.execute(sql`insert into faction_members (faction_id, server_id, dayz_id, discord_id, role, joined_at, status)
      values (${bear}, ${serverId}, ${A}, '111111111111111111', 'leader', ${t0}, 'full'), (${bear}, ${serverId}, ${B}, '222222222222222222', 'member', ${t0}, 'full')`);
    await achievementsTick(db, { now: m(10), achievementsChannelId: CH });
    const notices = await db.select().from(clanNotices).where(sql`${clanNotices.payload}->>'key' = 'colors_raised'`);
    expect(notices.filter((n) => n.target === "dm").map((n) => n.discordTargetId).sort()).toEqual(["111111111111111111", "222222222222222222"]);
    expect(notices.filter((n) => n.target === "channel")).toHaveLength(2);
  });

  it("a rule that throws skips only itself; the owner's other unlocks land and the pass reports the failure", async () => {
    const original = RULES.enlisted;
    (RULES as Record<string, unknown>).enlisted = async () => { throw new Error("boom"); };
    try {
      await seedKill(db, { serverId, killer: A, victim: B, at: m(1) });
      const r = await achievementsTick(db, { now: m(10) });
      expect(r.failed).toBe(1);
      expect((await db.select().from(achievementUnlocks).where(eq(achievementUnlocks.key, "first_blood"))).length).toBe(1);
    } finally { (RULES as Record<string, unknown>).enlisted = original; }
  });

  it("batches: at most `batch` owners per pass, the rest carried to the next", async () => {
    for (let i = 0; i < 5; i++) await seedKill(db, { serverId, killer: `${i}`.padStart(36, "K"), victim: `${i}`.padStart(36, "V"), at: m(i) });
    const first = await achievementsTick(db, { now: m(10), batch: 4 });
    expect(first.evaluated).toBe(4);
    expect(first.carried).toBeGreaterThan(0);
    const second = await achievementsTick(db, { now: m(11), batch: 4 });
    expect(second.evaluated).toBeGreaterThan(0);
    const third = await achievementsTick(db, { now: m(12), batch: 4 });
    expect(third.evaluated).toBe(0);
  });

  it("backfill: everyone, no notices, and the watermarks land at the head; a second run inserts nothing", async () => {
    await seedKill(db, { serverId, killer: A, victim: B, at: m(1) });
    await achievementsTick(db, { now: m(10), everyone: true, announce: false, achievementsChannelId: CH });
    expect((await db.select().from(clanNotices)).length).toBe(0);
    const n1 = (await db.select().from(achievementUnlocks)).length;
    expect(n1).toBeGreaterThan(0);
    const cursors = await db.select().from(consumerCursors).where(sql`${consumerCursors.consumerName} like 'achievements:%'`);
    expect(cursors.length).toBeGreaterThan(5);
    const r = await achievementsTick(db, { now: m(11), everyone: true, announce: false });
    expect(r.unlocked).toBe(0);
    expect((await db.select().from(achievementUnlocks)).length).toBe(n1);
  });

  it("feeds new positions and pins into the counters", async () => {
    const ev = await seedEvent(db, { serverId, type: "player.position", at: m(1), payload: { dayzId: A } });
    await db.insert(playerPositions).values({ serverId, dayzId: A, x: "5050", z: "7020", alt: "100", occurredAt: m(1), eventId: ev.id });
    await db.insert(clanPins).values({ factionId: bear, dayzId: A, x: "1", z: "2", icon: "loot", note: null, createdAt: m(2), expiresAt: m(1000) });
    await achievementsTick(db, { now: m(10) });
    const progress = await db.select().from(achievementProgress).where(eq(achievementProgress.ownerId, A));
    expect(progress.find((p) => p.key === "explorer")).toMatchObject({ count: 1, target: 50 });
    expect(progress.find((p) => p.key === "cartographer")).toMatchObject({ count: 1, target: 10 });
  });
});
```

- [ ] **Step 5: Run to verify it fails** — module not found.

- [ ] **Step 6: Implement touched.ts**

```ts
// apps/bot/src/achievements/touched.ts
import {
  alphaWeeks, clanPins, consumerCursors, ceremonyParticipants, defenses, events, factions, identityLinks, kills, membershipHistory, playerPositions,
  playerSessions, raids, seasonResults, type Database,
} from "@factions/db";
import { and, asc, gt, inArray, isNotNull, sql } from "drizzle-orm";
import type { Owner } from "./types.js";

export const SOURCES = ["kills", "sessions", "events", "raids", "defenses", "alphaWeeks", "seasonResults", "membership", "ceremonies", "links", "pins", "positions", "activations"] as const;
export type Source = (typeof SOURCES)[number];
export type Watermarks = Record<Source, number>;
export const CURSOR_PREFIX = "achievements:";
/** The event types any rule reads; other types never touch an owner. */
const RULE_EVENT_TYPES = ["base.built", "player.teleported", "emote.performed", "player.unconscious"] as const;

export type PositionRow = { dayzId: string; x: number; z: number; at: Date };
export type PinRow = { dayzId: string; at: Date };

/** Watermarks ride the event-log cursor table under `achievements:<source>`; ids for id-keyed tables, epoch ms for time-keyed ones. */
export async function readWatermarks(db: Database): Promise<Watermarks> {
  const rows = await db.select().from(consumerCursors).where(sql`${consumerCursors.consumerName} like ${CURSOR_PREFIX + "%"}`);
  const wm = Object.fromEntries(SOURCES.map((s) => [s, 0])) as Watermarks;
  for (const r of rows) {
    const s = r.consumerName.slice(CURSOR_PREFIX.length) as Source;
    if (SOURCES.includes(s)) wm[s] = r.lastEventId;
  }
  return wm;
}
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export async function writeWatermarks(tx: Tx, wm: Watermarks): Promise<void> {
  for (const s of SOURCES) {
    await tx.insert(consumerCursors).values({ consumerName: CURSOR_PREFIX + s, lastEventId: wm[s], updatedAt: new Date() })
      .onConflictDoUpdate({ target: consumerCursors.consumerName, set: { lastEventId: wm[s], updatedAt: new Date() } });
  }
}

const player = (id: string): Owner => ({ kind: "player", id });
const clan = (id: number): Owner => ({ kind: "clan", id: String(id) });
const key = (o: Owner) => `${o.kind}:${o.id}`;

/**
 * Owners with rows past each watermark, and the new watermarks. `limit` caps rows read
 * per source per pass; a source that hit the cap keeps its watermark at the last row read,
 * so the rest is picked up next pass (the tick reports `carried`).
 */
export async function collectTouched(db: Database, wm: Watermarks, limit: number): Promise<{ owners: Owner[]; next: Watermarks; positions: PositionRow[]; pins: PinRow[]; carried: boolean }> {
  const owners = new Map<string, Owner>();
  const add = (o: Owner) => owners.set(key(o), o);
  const next = { ...wm };
  let carried = false;
  const advance = <T extends { id: number }>(s: Source, rows: T[]) => { if (rows.length) next[s] = rows[rows.length - 1]!.id; if (rows.length === limit) carried = true; return rows; };

  for (const k of advance("kills", await db.select({ id: kills.id, killer: kills.killerDayzId, victim: kills.victimDayzId }).from(kills).where(gt(kills.id, wm.kills)).orderBy(asc(kills.id)).limit(limit))) {
    add(player(k.victim)); if (k.killer) add(player(k.killer));
  }
  // Sessions are touched when they CLOSE, which is later than their insert: watermark on disconnected_at (epoch ms).
  const closed = await db.select({ id: playerSessions.id, dayzId: playerSessions.dayzId, at: playerSessions.disconnectedAt }).from(playerSessions)
    .where(and(isNotNull(playerSessions.disconnectedAt), sql`${playerSessions.disconnectedAt} > to_timestamp(${wm.sessions / 1000})`)).orderBy(asc(playerSessions.disconnectedAt), asc(playerSessions.id)).limit(limit);
  for (const s of closed) add(player(s.dayzId));
  if (closed.length) next.sessions = closed[closed.length - 1]!.at!.getTime();
  if (closed.length === limit) carried = true;

  for (const e of advance("events", await db.select({ id: events.id, dayzId: sql<string>`${events.payload}->>'dayzId'` }).from(events)
    .where(and(gt(events.id, wm.events), inArray(events.type, [...RULE_EVENT_TYPES] as never[]))).orderBy(asc(events.id)).limit(limit))) {
    if (e.dayzId) add(player(e.dayzId));
  }
  for (const r of advance("raids", await db.select({ id: raids.id, raider: raids.raiderDayzId, clan: raids.raiderFactionId }).from(raids).where(gt(raids.id, wm.raids)).orderBy(asc(raids.id)).limit(limit))) {
    add(player(r.raider)); if (r.clan) add(clan(r.clan));
  }
  for (const d of advance("defenses", await db.select({ id: defenses.id, by: defenses.raisedByDayzId, clan: defenses.factionId }).from(defenses).where(gt(defenses.id, wm.defenses)).orderBy(asc(defenses.id)).limit(limit))) {
    add(player(d.by)); add(clan(d.clan));
  }
  for (const w of advance("alphaWeeks", await db.select({ id: alphaWeeks.id, clan: alphaWeeks.factionId }).from(alphaWeeks).where(gt(alphaWeeks.id, wm.alphaWeeks)).orderBy(asc(alphaWeeks.id)).limit(limit))) add(clan(w.clan));
  for (const s of advance("seasonResults", await db.select({ id: seasonResults.id, clan: seasonResults.factionId }).from(seasonResults).where(gt(seasonResults.id, wm.seasonResults)).orderBy(asc(seasonResults.id)).limit(limit))) add(clan(s.clan));
  // Membership: new spans by id, AND spans closed since (left_at set later) — both matter to full_strength/loyalist.
  const spans = await db.select({ id: membershipHistory.id, dayzId: membershipHistory.dayzId, clan: membershipHistory.factionId, leftAt: membershipHistory.leftAt }).from(membershipHistory)
    .where(sql`${membershipHistory.id} > ${wm.membership} or ${membershipHistory.leftAt} > to_timestamp(${wm.sessions / 1000})`).orderBy(asc(membershipHistory.id)).limit(limit);
  for (const s of advance("membership", spans)) { add(player(s.dayzId)); add(clan(s.clan)); }
  for (const c of advance("ceremonies", await db.select({ id: ceremonyParticipants.id, dayzId: ceremonyParticipants.dayzId }).from(ceremonyParticipants).where(gt(ceremonyParticipants.id, wm.ceremonies)).orderBy(asc(ceremonyParticipants.id)).limit(limit))) add(player(c.dayzId));
  for (const l of advance("links", await db.select({ id: identityLinks.id, dayzId: identityLinks.dayzId }).from(identityLinks).where(gt(identityLinks.id, wm.links)).orderBy(asc(identityLinks.id)).limit(limit))) add(player(l.dayzId));
  const pins = advance("pins", await db.select({ id: clanPins.id, dayzId: clanPins.dayzId, at: clanPins.createdAt }).from(clanPins).where(gt(clanPins.id, wm.pins)).orderBy(asc(clanPins.id)).limit(limit));
  for (const p of pins) add(player(p.dayzId));
  const positions = advance("positions", await db.select({ id: playerPositions.id, dayzId: playerPositions.dayzId, x: playerPositions.x, z: playerPositions.z, at: playerPositions.occurredAt }).from(playerPositions).where(gt(playerPositions.id, wm.positions)).orderBy(asc(playerPositions.id)).limit(limit));
  for (const p of positions) add(player(p.dayzId));
  // Activation happens after the row is inserted: watermark on activated_at.
  const activated = await db.select({ id: factions.id, at: factions.activatedAt }).from(factions).where(sql`${factions.activatedAt} > to_timestamp(${wm.activations / 1000})`).orderBy(asc(factions.activatedAt)).limit(limit);
  for (const f of activated) add(clan(f.id));
  if (activated.length) next.activations = activated[activated.length - 1]!.at!.getTime();
  if (activated.length === limit) carried = true;

  return {
    owners: [...owners.values()], next, carried,
    positions: positions.map((p) => ({ dayzId: p.dayzId, x: Number(p.x), z: Number(p.z), at: p.at })),
    pins: pins.map((p) => ({ dayzId: p.dayzId, at: p.at })),
  };
}

/** Every owner there is — the backfill's set. */
export async function collectEveryone(db: Database): Promise<Owner[]> {
  const ids = new Set<string>();
  for (const r of await db.select({ id: identityLinks.dayzId }).from(identityLinks)) ids.add(r.id);
  for (const r of await db.select({ id: kills.victimDayzId }).from(kills)) ids.add(r.id);
  for (const r of await db.select({ id: kills.killerDayzId }).from(kills).where(isNotNull(kills.killerDayzId))) ids.add(r.id!);
  for (const r of await db.select({ id: playerSessions.dayzId }).from(playerSessions)) ids.add(r.id);
  const clans = await db.select({ id: factions.id }).from(factions);
  return [...[...ids].map(player), ...clans.map((c) => clan(c.id))];
}
```

⚠️ The membership "closed since" clause above compares against `wm.sessions` by mistake — give membership its own time watermark: add `"membershipClosed"` to `SOURCES` and set `next.membershipClosed` to the max `leftAt` seen. The executor must make that correction and the tick test's cursor-count assertion (`> 5`) still holds.

- [ ] **Step 7: Implement tick.ts**

```ts
// apps/bot/src/achievements/tick.ts
import { ACHIEVEMENTS, ACHIEVEMENT_BY_KEY, HOLDING_STATUSES, type AchievementKey } from "@factions/domain";
import { achievementProgress, achievementUnlocks, factionMembers, factions, identityLinks, players, servers, type Database } from "@factions/db";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { appendClanNoticeTx, noticeClanTx, noticeFullMembersTx, noticeUserTx } from "@factions/roster/internal";
import { RULES } from "./rules.js";
import { applyPinCounters, applyPositionCounters } from "./counters.js";
import { collectEveryone, collectTouched, readWatermarks, writeWatermarks } from "./touched.js";
import type { Owner, RuleResult } from "./types.js";

export type AchievementsTickOpts = {
  now?: Date;
  /** Owners evaluated per pass; the rest carry over. */
  batch?: number;
  /** Backfill: every owner, ignoring watermarks. */
  everyone?: boolean;
  /** false = backfill: unlock rows only, no notices. */
  announce?: boolean;
  achievementsChannelId?: string;
  onError?: (owner: Owner, key: AchievementKey, err: unknown) => void;
};
export type AchievementsTickResult = { evaluated: number; unlocked: number; carried: number; failed: number };

const KEYS_FOR = { player: ACHIEVEMENTS.filter((a) => a.owner === "player").map((a) => a.key), clan: ACHIEVEMENTS.filter((a) => a.owner === "clan").map((a) => a.key) } as const;

/** Every rule of the owner's kind; a throw is reported per key and skips only that key. */
export async function evaluateOwner(db: Database, owner: Owner, now: Date, onError?: AchievementsTickOpts["onError"]): Promise<{ key: AchievementKey; result: RuleResult }[]> {
  const out: { key: AchievementKey; result: RuleResult }[] = [];
  for (const key of KEYS_FOR[owner.kind]) {
    try { out.push({ key, result: await RULES[key](db, owner, { now }) }); }
    catch (err) { onError?.(owner, key, err); }
  }
  return out;
}

type Names = { ownerName: string; clanTag: string | null; factionId: number | null; serverId: number; memberDiscordId: string | null };
async function namesFor(db: Database, owner: Owner, serverIdHint?: number): Promise<Names> {
  if (owner.kind === "clan") {
    const [f] = await db.select({ tag: factions.tag, name: factions.name, serverId: factions.serverId }).from(factions).where(eq(factions.id, Number(owner.id)));
    return { ownerName: f?.name ?? owner.id, clanTag: f?.tag ?? null, factionId: Number(owner.id), serverId: f?.serverId ?? serverIdHint ?? 0, memberDiscordId: null };
  }
  const [link] = await db.select({ discordId: identityLinks.discordId, gamertag: identityLinks.gamertag }).from(identityLinks).where(eq(identityLinks.dayzId, owner.id));
  const [seen] = link ? [] : await db.select({ gamertag: players.gamertag }).from(players).where(eq(players.dayzId, owner.id));
  const [m] = await db.select({ factionId: factionMembers.factionId, tag: factions.tag, serverId: factions.serverId })
    .from(factionMembers).innerJoin(factions, eq(factions.id, factionMembers.factionId))
    .where(and(eq(factionMembers.dayzId, owner.id), eq(factionMembers.status, "full"), inArray(factions.status, [...HOLDING_STATUSES]))).orderBy(asc(factions.id)).limit(1);
  let serverId = serverIdHint ?? m?.serverId;
  if (!serverId) { const [s] = await db.select({ id: servers.id }).from(servers).where(and(eq(servers.active, true), isNotNull(servers.nitradoServiceId))).orderBy(asc(servers.id)).limit(1); serverId = s?.id ?? 0; }
  return { ownerName: link?.gamertag ?? seen?.gamertag ?? "a player", clanTag: m?.tag ?? null, factionId: m?.factionId ?? null, serverId, memberDiscordId: link?.discordId ?? null };
}

export async function achievementsTick(db: Database, opts: AchievementsTickOpts): Promise<AchievementsTickResult> {
  const now = opts.now ?? new Date();
  const batch = opts.batch ?? 200;
  const announce = opts.announce ?? true;
  const result: AchievementsTickResult = { evaluated: 0, unlocked: 0, carried: 0, failed: 0 };
  const onError: AchievementsTickOpts["onError"] = (o, k, e) => { result.failed += 1; opts.onError?.(o, k, e); };

  const wm = await readWatermarks(db);
  const touched = opts.everyone ? { owners: await collectEveryone(db), next: wm, positions: [], pins: [], carried: false } : await collectTouched(db, wm, batch * 5);
  // Counters first, in their own transaction: the rules for explorer/cartographer read them.
  if (touched.positions.length || touched.pins.length) {
    await db.transaction(async (tx) => { await applyPositionCounters(tx, touched.positions); await applyPinCounters(tx, touched.pins); });
  }
  const owners = touched.owners.slice(0, batch);
  result.carried = touched.owners.length - owners.length + (touched.carried ? 1 : 0);

  for (const owner of owners) {
    const evaluated = await evaluateOwner(db, owner, now, onError);
    result.evaluated += 1;
    await db.transaction(async (tx) => {
      const existing = new Set((await tx.select({ key: achievementUnlocks.key }).from(achievementUnlocks)
        .where(and(eq(achievementUnlocks.ownerKind, owner.kind), eq(achievementUnlocks.ownerId, owner.id)))).map((r) => r.key));
      let names: Names | undefined;
      for (const { key, result: r } of evaluated) {
        await tx.insert(achievementProgress).values({ ownerKind: owner.kind, ownerId: owner.id, key, count: r.count, target: r.target, computedAt: now })
          .onConflictDoUpdate({ target: [achievementProgress.ownerKind, achievementProgress.ownerId, achievementProgress.key], set: { count: r.count, target: r.target, computedAt: now } });
        if (r.count < r.target || existing.has(key) || !r.earnedAt) continue;
        const inserted = await tx.insert(achievementUnlocks).values({ ownerKind: owner.kind, ownerId: owner.id, key, earnedAt: r.earnedAt, evidenceId: r.evidenceId ?? null, evidence: r.evidence ?? {} })
          .onConflictDoNothing().returning({ key: achievementUnlocks.key });
        if (!inserted.length) continue;   // a concurrent pass won; it also queued the notices
        result.unlocked += 1;
        if (!announce) continue;
        names ??= await namesFor(db, owner, r.serverId);
        const a = ACHIEVEMENT_BY_KEY[key];
        const payload = { key, name: a.name, description: a.description, ownerKind: owner.kind, ownerName: names.ownerName, clanTag: names.clanTag };
        const base = { serverId: names.serverId, kind: "achievement" as const, occurredAt: r.earnedAt, payload };
        if (owner.kind === "clan") {
          await noticeClanTx(tx, { ...base, factionId: names.factionId! });
          await noticeFullMembersTx(tx, { ...base, factionId: names.factionId! });
        } else {
          if (names.factionId) await noticeClanTx(tx, { ...base, factionId: names.factionId });
          if (names.memberDiscordId) await noticeUserTx(tx, { ...base, factionId: names.factionId, discordId: names.memberDiscordId });
        }
        if (opts.achievementsChannelId) {
          await appendClanNoticeTx(tx, { ...base, factionId: null, target: "channel", discordTargetId: opts.achievementsChannelId, payload: { ...payload, public: true } });
        }
      }
    });
  }
  // Watermarks advance only after the batch committed; when owners were carried, hold them so the next pass re-collects.
  if (result.carried === 0 || opts.everyone) {
    await db.transaction((tx) => writeWatermarks(tx, opts.everyone ? await headWatermarks(db) : touched.next));
  }
  return result;
}

/** After a backfill the watermarks jump to the current heads so the live tick starts from now. */
async function headWatermarks(db: Database) {
  const { next } = await collectTouched(db, await readWatermarks(db), Number.MAX_SAFE_INTEGER);
  return next;
}
```

Two corrections the executor must make while implementing: (1) `await` is not allowed inside the non-async arrow in the watermark transaction — compute `const finalWm = opts.everyone ? await headWatermarks(db) : touched.next;` before the transaction; (2) `appendClanNoticeTx`'s `ClanNoticeInput` shape must be checked in `packages/roster/src/internal/notices.ts:37` and the call matched to it (it takes `target` and `discordTargetId` explicitly; if it refuses `factionId: null` for a channel target, extend it — the spec requires a channel notice with no clan). Also verify `apps/bot/src/notice-tick.ts` resolves a `channel` target from `discordTargetId` when `factionId` is null; if it only resolves via `factions.discord_text_channel_id`, add the `discordTargetId ?? faction channel` fallback with a test in `apps/bot/test/notice-tick.test.ts`.

The "carried" semantics: when a pass is capped, the simplest correct behaviour is to NOT advance watermarks (so the next pass re-collects the same head of rows and takes the next `batch` owners). Owners already evaluated are re-evaluated once — harmless (PK) but wasteful; the test only asserts progress across three passes. Keep it simple; do not build a per-owner queue.

- [ ] **Step 8: Run** — `pnpm exec vitest run test/achievements/` → all pass; `pnpm exec tsc --noEmit` clean.
- [ ] **Step 9: Commit** — `git add apps/bot && git commit -m "feat(bot): achievements tick — touched owners, unlocks with evidence, notices"`

---

### Task 10: Renderer, config, and wiring into the bot

**Files:**
- Modify: `apps/bot/src/notice-text.ts` (branch added in Task 3; add tests here)
- Modify: `apps/bot/test/notice-text.test.ts`
- Modify: `apps/bot/src/config.ts`, `apps/bot/test/config.test.ts`
- Modify: `apps/bot/src/discord.ts` (`start()`), `apps/bot/README.md` (env table)

**Interfaces:**
- Config gains `achievementsChannelId: string | undefined` (env `ACHIEVEMENTS_CHANNEL_ID`, optional snowflake) and `achievementsTick: boolean` (env `ACHIEVEMENTS_TICK`, `"1"`/`"true"` = on, default **off** until the backfill has run — spec §10).

- [ ] **Step 1: Failing renderer tests** — append to `apps/bot/test/notice-text.test.ts`:

```ts
describe("achievement", () => {
  const at = new Date("2026-09-11T12:00:00Z");
  const base = { kind: "achievement" as const, occurredAt: at, target: "channel" as const };
  it("names the player as a mention in their clan channel, and with their tag in the public channel", () => {
    const payload = { key: "sniper", name: "Sniper", description: "A kill from 300 m or more", ownerKind: "player", ownerName: "111111111111111111", clanTag: "BEAR" };
    expect(noticeText({ ...base, payload }, at)).toBe("🏆 <@111111111111111111> earned **Sniper** — A kill from 300 m or more.");
    expect(noticeText({ ...base, payload: { ...payload, public: true } }, at)).toBe("🏆 <@111111111111111111> [BEAR] earned **Sniper** — A kill from 300 m or more.");
  });
  it("names a clan in bold, no tag suffix", () => {
    const payload = { key: "fortress", name: "Fortress", description: "10 defenses", ownerKind: "clan", ownerName: "Bear Company", clanTag: "BEAR", public: true };
    expect(noticeText({ ...base, payload }, at)).toBe("🏆 **Bear Company** earned **Fortress** — 10 defenses.");
  });
});
```

The tick (Task 9) puts the player's gamertag in `ownerName`; the renderer's `person()` turns an all-digit value into a mention. Decide ONE of the two and pin it: the notice to a clan channel or DM should mention the player (so put `memberDiscordId ?? gamertag` in `ownerName` for player unlocks in Task 9's payload), and the public channel gets the same. Update the Task 9 test's `ownerName: "Ann"` expectation to the discord id accordingly.

- [ ] **Step 2: Run → fails on the exact strings. Adjust the renderer branch (Task 3 Step 5) until it passes.**

- [ ] **Step 3: Config** — failing test in `apps/bot/test/config.test.ts` (follow the file's existing pattern for `WAR_LOG_CHANNEL_ID`):

```ts
it("ACHIEVEMENTS_CHANNEL_ID is optional and ACHIEVEMENTS_TICK defaults off", () => {
  const cfg = loadConfig(baseEnv());
  expect(cfg.achievementsChannelId).toBeUndefined();
  expect(cfg.achievementsTick).toBe(false);
  expect(loadConfig({ ...baseEnv(), ACHIEVEMENTS_CHANNEL_ID: "123456789012345678", ACHIEVEMENTS_TICK: "1" })).toMatchObject({ achievementsChannelId: "123456789012345678", achievementsTick: true });
  expect(() => loadConfig({ ...baseEnv(), ACHIEVEMENTS_CHANNEL_ID: "nope" })).toThrow(/ACHIEVEMENTS_CHANNEL_ID/u);
});
```

Implement in `config.ts`: type fields `achievementsChannelId: string | undefined; achievementsTick: boolean;` and in `loadConfig`: `achievementsChannelId: optionalSnowflake(env, "ACHIEVEMENTS_CHANNEL_ID"), achievementsTick: ["1", "true"].includes((env.ACHIEVEMENTS_TICK ?? "").toLowerCase()),`. Add both rows to `apps/bot/README.md`'s env table with the note "leave ACHIEVEMENTS_TICK unset until the backfill runbook has run".

- [ ] **Step 4: Wire the tick** in `apps/bot/src/discord.ts` `start()`, inside the runner after the `weekTick` step and before the posters (`feedTick`), matching the neighbouring blocks' shape:

```ts
      // Achievements (spec 2026-09-11 §6.2): after kills, sessions, raids, raises and weeks have
      // settled their rows, before the posters drain what this queues. Gated so a deploy can land
      // the code, run the backfill, and only then start announcing.
      if (cfg.achievementsTick) {
        try {
          const r = await achievementsTick(db, {
            achievementsChannelId: cfg.achievementsChannelId,
            onError: (owner, key, err) => console.error(`achievement rule ${key} failed for ${owner.kind} ${owner.id}`, err),
          });
          if (r.unlocked || r.failed) console.log(`achievements: ${r.evaluated} evaluated, ${r.unlocked} unlocked, ${r.failed} rule failures, ${r.carried} carried`);
        } catch (err) {
          console.error("achievements tick failed", err);
        }
      }
```

with `import { achievementsTick } from "./achievements/tick.js";` at the top. If `start()` has a structural test pinning tick order (grep `apps/bot/test` for `weekTick`), extend it.

- [ ] **Step 5: Run** — `cd apps/bot && pnpm exec vitest run && pnpm exec tsc --noEmit` → all green.
- [ ] **Step 6: Commit** — `git add apps/bot && git commit -m "feat(bot): achievement notices, ACHIEVEMENTS_CHANNEL_ID, gated tick"`

---

### Task 11: Backfill script and runbook

**Files:**
- Create: `scripts/backfill-achievements.ts`
- Modify: root `package.json` scripts: `"backfill:achievements": "tsx scripts/backfill-achievements.ts"`
- Create: `docs/deploy/2026-09-12-achievements.md`
- Modify: `CLAUDE.md` "Where things live" table (one row) and the tick-order paragraph under "Bot" (one sentence)

- [ ] **Step 1: Script** (same shape as `scripts/rebuild-kills.ts`; read it first for the `factions_live` guard and arg parsing, and note CLAUDE.md's warning that root scripts may fail to resolve `drizzle-orm` — if `pnpm backfill:achievements` fails that way, run it as `pnpm --filter @factions/bot exec tsx ../../scripts/backfill-achievements.ts`, and say so in the runbook):

```ts
// scripts/backfill-achievements.ts
import { createClient } from "@factions/db";
import { achievementsTick } from "../apps/bot/src/achievements/tick.js";

const url = process.env.DATABASE_URL;
const allowTest = process.argv.includes("--allow-test-db");
if (!url) { console.error("DATABASE_URL unset"); process.exit(2); }
if (!url.endsWith("/factions_live") && !allowTest) { console.error(`refusing: not factions_live -> ${url} (pass --allow-test-db to override)`); process.exit(2); }

// ⚠️ announce:false — a backfill must never post hundreds of historical unlocks. The
// tick's own watermarks are set to the head when this finishes, so the live tick starts from now.
const db = createClient(url);
const started = Date.now();
const r = await achievementsTick(db, { everyone: true, announce: false, batch: Number.MAX_SAFE_INTEGER,
  onError: (owner, key, err) => console.error(`rule ${key} failed for ${owner.kind} ${owner.id}`, err) });
console.log(`backfill: ${r.evaluated} owners evaluated, ${r.unlocked} unlocks inserted, ${r.failed} rule failures, in ${Date.now() - started}ms`);
process.exit(r.failed ? 1 : 0);
```

- [ ] **Step 2: Prove it against the test database** — run with `DATABASE_URL="postgres://factions:factions@localhost:5434/factions_test_bot" pnpm backfill:achievements --allow-test-db` after seeding nothing: expect `0 owners … 0 unlocks`, exit 0. (The bot test database exists after Task 9's suite ran.)

- [ ] **Step 3: Runbook** `docs/deploy/2026-09-12-achievements.md`, in the house shape (see `docs/deploy/2026-09-11-server-name-strip.md`):

```markdown
# Achievements — runbook

Fifty lifetime achievements (spec `docs/superpowers/specs/2026-09-11-achievements-design.md`).
Migration 0031 adds three tables, all additive; nothing needs stopping for it. The bot tick is
OFF until `ACHIEVEMENTS_TICK=1`, which is the last step — the backfill must run first, or launch
day posts every historical unlock into Discord.

## Steps

1. Apply migration 0031 with the one-off runner from `docs/deploy/2026-09-02-dormancy.md`, after
   confirming `__drizzle_migrations` holds 31 rows and the journal 32 (only 0031 applies).
2. Deploy the bot (git pull, `sudo systemctl restart clan-wars-bot`) with `ACHIEVEMENTS_TICK`
   unset. Confirm `systemctl status clan-wars-bot` and that `events` keeps growing.
3. Backfill: `cd /opt/clan-wars && set -a && . ./.env && set +a && pnpm backfill:achievements`
   (or the bot-package form if the root resolution fails). Expect a summary line and exit 0.
   Check: `select owner_kind, count(*) from achievement_unlocks group by 1;` and
   `select count(*) from clan_notices where kind = 'achievement';` — the second MUST be 0.
4. Create `#achievements` in Discord, give the bot Send Messages there, put its id in `.env` as
   `ACHIEVEMENTS_CHANNEL_ID`, set `ACHIEVEMENTS_TICK=1`, restart the bot.
5. Deploy the web app: `/opt/clan-wars/deploy/deploy-web.sh`.
6. Acceptance: a player profile shows the wall with earned tiles dated in the past; the guide has
   chapter 14; the next real kill by a player one short of Ten Down posts three notices.

## Rolling back

Unset `ACHIEVEMENTS_TICK`, restart the bot. The tables can stay; nothing else reads them.
```

- [ ] **Step 4: CLAUDE.md** — add a "Where things live" row: `| Achievements (50, lifetime) | Definitions \`packages/domain/src/achievements.ts\`; rules and tick \`apps/bot/src/achievements/\`; unlocks in \`achievement_unlocks\`; site via \`achievementsFor()\`. Backfill \`pnpm backfill:achievements\`. Runbook \`docs/deploy/2026-09-12-achievements.md\` |` and one sentence in the tick-order paragraph: "Since achievements, `achievements/tick.ts` runs after `week-tick.ts` and before the posters, gated on `ACHIEVEMENTS_TICK`."

- [ ] **Step 5: Commit** — `git add scripts package.json docs CLAUDE.md && git commit -m "feat: achievements backfill script and runbook"`

---

### Task 12: The roster read

**Files:**
- Create: `packages/roster/src/achievements.ts`, `packages/roster/test/achievements.test.ts`
- Modify: `packages/roster/src/index.ts`, `packages/roster/test/exports.test.ts`, `apps/web/test/smoke.test.ts` (insert `"achievementsFor"` after `"acceptInvite"` in both arrays)

**Interfaces:**
- Produces (public): `achievementsFor(subject: { gamertag: string } | { clanTag: string }): Promise<AchievementWall | null>` where
  ```ts
  export type AchievementTile = { key: AchievementKey; name: string; description: string; group: AchievementGroup; owner: AchievementOwner; target: number; unit: AchievementUnit;
    earnedAt: Date | null; count: number; clanTag: string | null /* set on a team tile shown on a player's wall */ };
  export type AchievementWall = { tiles: AchievementTile[]; earned: number; closest: AchievementTile[] /* up to 3 counted, unearned, highest count/target, players only */ };
  ```
- Internal: `achievementsForDb(db, subject, now)`.

- [ ] **Step 1: Failing test**

```ts
// packages/roster/test/achievements.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, identityLinks, players, membershipHistory, achievementUnlocks, achievementProgress, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { achievementsForDb } from "../src/achievements";
import { seedFaction } from "./seed";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(40);
const t0 = new Date("2026-08-01T00:00:00Z");
const d = (n: number) => new Date(t0.getTime() + n * 86_400_000);

describe("achievementsForDb", () => {
  let db: Database; let serverId = 0; let bear = 0; let wolf = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table achievement_unlocks, achievement_progress, membership_history, declarations, poles, factions, identity_links, players, events, adm_files, servers restart identity cascade`);
    });
    serverId = (await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning())[0]!.id;
    bear = (await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: t0 })).id;
    wolf = (await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", poleKey: "9000.00:100.00:9000.00", x: 9000, z: 9000, createdAt: t0 })).id;
    await db.insert(players).values({ dayzId: A, gamertag: "Ann", firstSeenAt: t0, lastSeenAt: t0 });
    await db.insert(identityLinks).values({ discordId: "1", dayzId: A, gamertag: "Ann", verifiedAt: t0 });
  });

  it("a player's wall: all 50 tiles, their own unlocks, progress, and the team unlocks of clans they were in at the time", async () => {
    await db.insert(membershipHistory).values([{ serverId, factionId: bear, dayzId: A, joinedAt: d(0), leftAt: d(10) }, { serverId, factionId: wolf, dayzId: A, joinedAt: d(20), leftAt: null }]);
    await db.insert(achievementUnlocks).values([
      { ownerKind: "player", ownerId: A, key: "first_blood", earnedAt: d(1) },
      { ownerKind: "clan", ownerId: String(bear), key: "first_raid", earnedAt: d(5) },      // in BEAR then: shown
      { ownerKind: "clan", ownerId: String(bear), key: "fortress", earnedAt: d(15) },       // after leaving BEAR: not shown
      { ownerKind: "clan", ownerId: String(wolf), key: "alpha", earnedAt: d(25) },          // in WOLF now: shown
    ]);
    await db.insert(achievementProgress).values([
      { ownerKind: "player", ownerId: A, key: "ten_down", count: 7, target: 10, computedAt: d(30) },
      { ownerKind: "player", ownerId: A, key: "veteran", count: 90, target: 100, computedAt: d(30) },
      { ownerKind: "player", ownerId: A, key: "builder", count: 10, target: 100, computedAt: d(30) },
    ]);
    const wall = (await achievementsForDb(db, { gamertag: "ann" }, d(30)))!;
    expect(wall.tiles).toHaveLength(50);
    expect(wall.earned).toBe(3);
    const by = (k: string) => wall.tiles.find((t) => t.key === k)!;
    expect(by("first_blood")).toMatchObject({ earnedAt: d(1), count: 1, clanTag: null });
    expect(by("first_raid")).toMatchObject({ earnedAt: d(5), clanTag: "BEAR" });
    expect(by("fortress")).toMatchObject({ earnedAt: null });
    expect(by("alpha")).toMatchObject({ earnedAt: d(25), clanTag: "WOLF" });
    expect(by("ten_down")).toMatchObject({ count: 7, target: 10, earnedAt: null });
    expect(wall.closest.map((t) => t.key)).toEqual(["veteran", "ten_down", "builder"]);   // by count/target, desc
  });

  it("a clan's wall: the 12 team tiles only", async () => {
    await db.insert(achievementUnlocks).values({ ownerKind: "clan", ownerId: String(bear), key: "colors_raised", earnedAt: d(1) });
    const wall = (await achievementsForDb(db, { clanTag: "bear" }, d(30)))!;
    expect(wall.tiles).toHaveLength(12);
    expect(wall.tiles.every((t) => t.group === "team")).toBe(true);
    expect(wall.earned).toBe(1);
    expect(wall.closest).toEqual([]);
  });

  it("null for a name the log has never seen", async () => {
    expect(await achievementsForDb(db, { gamertag: "nobody" }, d(30))).toBeNull();
    expect(await achievementsForDb(db, { clanTag: "NOPE" }, d(30))).toBeNull();
  });
});
```

- [ ] **Step 2: Run → module not found.**

- [ ] **Step 3: Implement**

```ts
// packages/roster/src/achievements.ts
import type { Database } from "@factions/db";
import { achievementProgress, achievementUnlocks, factions, identityLinks, membershipHistory, players } from "@factions/db";
import { ACHIEVEMENTS, type AchievementGroup, type AchievementKey, type AchievementOwner, type AchievementUnit } from "@factions/domain";
import { and, eq, inArray, or, sql } from "drizzle-orm";

export type AchievementTile = {
  key: AchievementKey; name: string; description: string; group: AchievementGroup; owner: AchievementOwner; target: number; unit: AchievementUnit;
  earnedAt: Date | null; count: number;
  /** On a player's wall, the clan a team tile was earned with. */
  clanTag: string | null;
};
export type AchievementWall = { tiles: AchievementTile[]; earned: number; closest: AchievementTile[] };
export type AchievementSubject = { gamertag: string } | { clanTag: string };

/**
 * The wall (spec 2026-09-11 §8). A player's wall carries every player tile plus the team
 * tiles of clans they were a FULL member of at the moment the clan earned them — resolved
 * through membership_history, so later joins and leaves cannot edit the record. A clan's
 * wall is the 12 team tiles. Progress comes from the tick's cache, never recomputed here.
 */
export async function achievementsForDb(db: Database, subject: AchievementSubject, now: Date): Promise<AchievementWall | null> {
  if ("clanTag" in subject) {
    const [f] = await db.select({ id: factions.id, tag: factions.tag }).from(factions).where(sql`lower(${factions.tag}) = lower(${subject.clanTag})`);
    if (!f) return null;
    return wallFor(db, { kind: "clan", id: String(f.id) }, [], now);
  }
  const [p] = await db.select({ dayzId: players.dayzId }).from(players).where(sql`lower(${players.gamertag}) = lower(${subject.gamertag})`);
  const [l] = p ? [] : await db.select({ dayzId: identityLinks.dayzId }).from(identityLinks).where(sql`lower(${identityLinks.gamertag}) = lower(${subject.gamertag})`);
  const dayzId = p?.dayzId ?? l?.dayzId;
  if (!dayzId) return null;
  // Team unlocks the player shared: clan unlock rows whose earned_at falls inside one of the player's spans in that clan.
  const shared = await db.select({ key: achievementUnlocks.key, earnedAt: achievementUnlocks.earnedAt, tag: factions.tag })
    .from(achievementUnlocks)
    .innerJoin(membershipHistory, and(eq(membershipHistory.dayzId, dayzId), sql`${membershipHistory.factionId}::text = ${achievementUnlocks.ownerId}`,
      sql`${membershipHistory.joinedAt} <= ${achievementUnlocks.earnedAt}`, sql`(${membershipHistory.leftAt} is null or ${achievementUnlocks.earnedAt} < ${membershipHistory.leftAt})`))
    .innerJoin(factions, eq(factions.id, membershipHistory.factionId))
    .where(eq(achievementUnlocks.ownerKind, "clan"));
  return wallFor(db, { kind: "player", id: dayzId }, shared, now);
}

async function wallFor(db: Database, owner: { kind: AchievementOwner; id: string }, shared: { key: string; earnedAt: Date; tag: string }[], _now: Date): Promise<AchievementWall> {
  const own = await db.select({ key: achievementUnlocks.key, earnedAt: achievementUnlocks.earnedAt }).from(achievementUnlocks)
    .where(and(eq(achievementUnlocks.ownerKind, owner.kind), eq(achievementUnlocks.ownerId, owner.id)));
  const progress = await db.select({ key: achievementProgress.key, count: achievementProgress.count }).from(achievementProgress)
    .where(and(eq(achievementProgress.ownerKind, owner.kind), eq(achievementProgress.ownerId, owner.id)));
  const earnedBy = new Map(own.map((u) => [u.key, { at: u.earnedAt, tag: null as string | null }]));
  for (const s of shared) { const cur = earnedBy.get(s.key); if (!cur || s.earnedAt < cur.at) earnedBy.set(s.key, { at: s.earnedAt, tag: s.tag }); }
  const countBy = new Map(progress.map((p) => [p.key, p.count]));
  const tiles: AchievementTile[] = ACHIEVEMENTS
    .filter((a) => owner.kind === "player" || a.owner === "clan")
    .map((a) => {
      const e = earnedBy.get(a.key);
      return { key: a.key, name: a.name, description: a.description, group: a.group, owner: a.owner, target: a.target, unit: a.unit,
        earnedAt: e?.at ?? null, count: e ? a.target : (countBy.get(a.key) ?? 0), clanTag: e?.tag ?? null };
    });
  const closest = owner.kind === "player"
    ? tiles.filter((t) => !t.earnedAt && t.target > 1 && t.count > 0).sort((x, y) => y.count / y.target - x.count / x.target).slice(0, 3)
    : [];
  return { tiles, earned: tiles.filter((t) => t.earnedAt).length, closest };
}
```

Add to `packages/roster/src/index.ts`:

```ts
import { achievementsForDb, type AchievementWall, type AchievementTile, type AchievementSubject } from "./achievements";
export type { AchievementWall, AchievementTile, AchievementSubject };
/** The badge wall for a player (by gamertag) or a clan (by tag). Null when the name is unknown. */
export function achievementsFor(subject: AchievementSubject): Promise<AchievementWall | null> {
  return achievementsForDb(db(), subject, new Date());
}
```

and insert `"achievementsFor"` into both allowlist arrays right after `"acceptInvite"`.

- [ ] **Step 4: Run** — `cd packages/roster && pnpm exec vitest run test/achievements.test.ts test/exports.test.ts && pnpm exec tsc --noEmit`; then `cd apps/web && pnpm exec vitest run test/smoke.test.ts`.
- [ ] **Step 5: Commit** — `git add packages/roster apps/web/test/smoke.test.ts && git commit -m "feat(roster): achievementsFor — the badge wall read"`

---

### Task 13: The web surfaces

**Files:**
- Create: `apps/web/lib/achievements-copy.ts`, `apps/web/app/components/achievement-wall.tsx`
- Create: `apps/web/test/achievements-copy.test.ts`, `apps/web/test/achievements-surfaces.test.ts`
- Modify: `apps/web/app/(site)/players/[gamertag]/page.tsx`, `apps/web/app/components/owner.tsx`, `apps/web/app/(site)/clans/[tag]/page.tsx`, `apps/web/app/(site)/clan/page.tsx`

**Interfaces:**
- Consumes `achievementsFor`, `AchievementWall`, `AchievementTile` (Task 12).
- Produces `progressLine(tile): string | null` (copy), `AchievementWall({ wall, title? })`, `ClosestPanel({ wall })`, `TeamRow({ wall })` components.

- [ ] **Step 1: Failing copy test**

```ts
// apps/web/test/achievements-copy.test.ts
import { describe, it, expect } from "vitest";
import { GROUP_LABELS, progressLine, earnedLine } from "../lib/achievements-copy";

const tile = (o: Partial<Parameters<typeof progressLine>[0]>) => ({ key: "ten_down", name: "Ten Down", description: "10 PvP kills", group: "pvp", owner: "player", target: 10, unit: "count", earnedAt: null, count: 3, clanTag: null, ...o }) as Parameters<typeof progressLine>[0];

describe("achievement copy", () => {
  it("labels the four groups in the player's words", () => {
    expect(GROUP_LABELS).toEqual({ solo: "Solo", pve: "Survival", pvp: "Combat", team: "Clan" });
  });
  it("progress reads count over target in the tile's unit; one-shots have no progress line", () => {
    expect(progressLine(tile({}))).toBe("3 / 10");
    expect(progressLine(tile({ key: "veteran", unit: "hours", count: 17, target: 100 }))).toBe("17 / 100 h");
    expect(progressLine(tile({ key: "loyalist", unit: "days", count: 12, target: 30 }))).toBe("12 / 30 days");
    expect(progressLine(tile({ key: "marksman", unit: "m", count: 90, target: 150 }))).toBe("best 90 m of 150 m");
    expect(progressLine(tile({ key: "first_blood", target: 1 }))).toBeNull();
  });
  it("an earned tile says when, and with which clan for a team tile", () => {
    expect(earnedLine(tile({ earnedAt: new Date("2026-09-03T10:00:00Z") }))).toBe("Earned 3 Sept");
    expect(earnedLine(tile({ earnedAt: new Date("2026-09-03T10:00:00Z"), clanTag: "BEAR", group: "team" }))).toBe("Earned 3 Sept with BEAR");
  });
});
```

- [ ] **Step 2: Run → module not found.**

- [ ] **Step 3: Copy module**

```ts
// apps/web/lib/achievements-copy.ts
import type { AchievementTile } from "@factions/roster";

/** Every word the wall says. Thresholds come from the tile (i.e. from the definitions), never typed here. */
export const GROUP_LABELS = { solo: "Solo", pve: "Survival", pvp: "Combat", team: "Clan" } as const;
export const WALL = { title: "Achievements", locked: "Locked", closest: "Closest to unlocking", none: "Nothing in reach yet — play, and this fills in.", earnedOf: (n: number, of: number) => `${n} of ${of}` } as const;

const day = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export function progressLine(t: AchievementTile): string | null {
  if (t.target <= 1) return null;
  switch (t.unit) {
    case "hours": return `${t.count} / ${t.target} h`;
    case "days": return `${t.count} / ${t.target} days`;
    case "m": return `best ${t.count} m of ${t.target} m`;
    default: return `${t.count} / ${t.target}`;
  }
}
export function earnedLine(t: AchievementTile): string | null {
  if (!t.earnedAt) return null;
  return `Earned ${day(t.earnedAt)}${t.group === "team" && t.clanTag ? ` with ${t.clanTag}` : ""}`;
}
```

Note `point_blank` has unit `m` with a "less than" rule; its progress line would read "best 0 m of 5 m" — set its progress to null in `progressLine` by key: `if (t.key === "point_blank") return null;` (a one-shot in practice). Add that to the test.

- [ ] **Step 4: Run copy test → pass. Then the component (server component, no client JS):**

```tsx
// apps/web/app/components/achievement-wall.tsx
import type { AchievementWall as Wall, AchievementTile } from "@factions/roster";
import { ACHIEVEMENT_GROUPS } from "@factions/domain";
import { GROUP_LABELS, WALL, progressLine, earnedLine } from "@/lib/achievements-copy";
import { Panel, PanelBody, kickerSm } from "@/app/components/ui";

function Tile({ t }: { t: AchievementTile }) {
  const earned = t.earnedAt !== null;
  const progress = progressLine(t);
  const pct = earned ? 100 : Math.min(100, Math.round((t.count / t.target) * 100));
  return (
    <li className={`flex flex-col gap-1 border-2 px-3 py-2.5 ${earned ? "border-gold bg-frame" : "border-rule-2 bg-surface opacity-70"}`} aria-label={`${t.name}: ${earned ? earnedLine(t) : WALL.locked}`}>
      <span className={`font-display text-[13px] uppercase tracking-[0.06em] ${earned ? "text-gold" : "text-ink-2"}`}>{t.name}</span>
      <span className="text-[12px] leading-snug text-ink-2">{t.description}</span>
      {earned
        ? <span className={kickerSm}>{earnedLine(t)}</span>
        : progress && <span className="mt-1 flex items-center gap-2"><span className="h-1 flex-1 bg-rule-2"><span className="block h-1 bg-gold" style={{ width: `${pct}%` }} /></span><span className={kickerSm}>{progress}</span></span>}
    </li>
  );
}

/** The wall: fifty tiles (twelve on a clan's), grouped, earned in gold, locked dimmed with progress. */
export function AchievementWall({ wall, title = WALL.title, className }: { wall: Wall; title?: string; className?: string }) {
  const groups = ACHIEVEMENT_GROUPS.filter((g) => wall.tiles.some((t) => t.group === g));
  return (
    <Panel title={title} aside={WALL.earnedOf(wall.earned, wall.tiles.length)} className={className}>
      <PanelBody>
        {groups.map((g) => (
          <section key={g} className="mb-5 last:mb-0">
            <h3 className={`${kickerSm} mb-2`}>{GROUP_LABELS[g]}</h3>
            <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2 xl:grid-cols-3">
              {wall.tiles.filter((t) => t.group === g).map((t) => <Tile key={t.key} t={t} />)}
            </ul>
          </section>
        ))}
      </PanelBody>
    </Panel>
  );
}

/** The owner-only nudge: the three counted achievements nearest their target. */
export function ClosestPanel({ wall, href }: { wall: Wall; href: string }) {
  return (
    <Panel title={WALL.closest}>
      <PanelBody>
        {wall.closest.length === 0
          ? <p className="m-0 text-[13px] text-ink-2">{WALL.none}</p>
          : <ul className="m-0 grid list-none gap-2 p-0">{wall.closest.map((t) => <Tile key={t.key} t={t} />)}</ul>}
        <a className="mt-3 inline-block font-mono text-[11px] uppercase tracking-[0.18em] text-gold hover:underline" href={href}>All achievements →</a>
      </PanelBody>
    </Panel>
  );
}
```

Check `Panel`'s props in `apps/web/app/components/ui.tsx:131` (`num?, title?, aside?, tone?, children, className`) and match them.

- [ ] **Step 5: Failing surface tests** (structural, in the house style):

```ts
// apps/web/test/achievements-surfaces.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const app = join(import.meta.dirname, "..", "app");
const read = (...p: string[]) => readFileSync(join(app, ...p), "utf8");

describe("achievement surfaces", () => {
  it("the player profile renders the wall, after Raiding", () => {
    const src = read("(site)", "players", "[gamertag]", "page.tsx");
    expect(src).toContain("achievementsFor(");
    expect(src).toMatch(/<AchievementWall\b/u);
    expect(src.indexOf('title="Raiding"')).toBeLessThan(src.indexOf("<AchievementWall"));
    expect(src).toMatch(/achievementsFor\([^)]*\)\.catch\(/u);   // never a reason to fail the page
  });
  it("the owner's panels carry the closest-to-unlocking strip", () => {
    expect(read("components", "owner.tsx")).toMatch(/<ClosestPanel\b/u);
  });
  it.each([join("(site)", "clans", "[tag]", "page.tsx"), join("(site)", "clan", "page.tsx")])("%s renders the team wall", (rel) => {
    const src = readFileSync(join(app, rel), "utf8");
    expect(src).toContain("achievementsFor({ clanTag");
    expect(src).toMatch(/<AchievementWall\b/u);
  });
  it("no tile copy or component mentions a coordinate field", () => {
    for (const f of [read("components", "achievement-wall.tsx"), readFileSync(join(import.meta.dirname, "..", "lib", "achievements-copy.ts"), "utf8")]) {
      expect(f).not.toMatch(/\b(x|z|poleKey)\b\s*[:=]/u);
    }
  });
});
```

- [ ] **Step 6: Wire the pages**

Player profile (`players/[gamertag]/page.tsx`): add `achievementsFor` to the roster import; extend the `Promise.all` with `achievementsFor({ gamertag }).catch(() => null)` as a fourth element `wall`; below the Raiding panel render `{wall && <AchievementWall wall={wall} className="lg:col-span-2" />}` (use whatever column-span class the two-column grid there uses for a full-width panel — read the Killed-by/feed panels for the convention). Pass `wall` into `OwnerPanels` as a new optional prop `wall?: AchievementWall | null`; in `owner.tsx`'s `OwnerPanels`, render `{wall && <ClosestPanel wall={wall} href={`/players/${encodeURIComponent(owner.gamertag)}#achievements`} />}` first. Give the wall panel `id="achievements"` (add an `id` prop to `Panel` if it lacks one; the wall's `<Panel>` call passes it).

Clan pages: in `clans/[tag]/page.tsx` add `achievementsFor({ clanTag: tag }).catch(() => null)` to the existing `Promise.all` and render `{wall && <AchievementWall wall={wall} title="Clan achievements" className="lg:col-span-3" />}` between the Placements and War log panels. In `clan/page.tsx` fetch after `clanFor` resolves: `const wall = await achievementsFor({ clanTag: clan.tag }).catch(() => null);` and render the same component after the Roster panel.

- [ ] **Step 7: Run** — `cd apps/web && TEST_DATABASE_URL=… pnpm exec vitest run && pnpm exec tsc --noEmit`. The vocabulary, request-time-rendering and smoke tests all run over the new files; fix anything they catch (they are the point).
- [ ] **Step 8: Look at it** — `pnpm --filter @factions/web dev` against the dev database with a seeded player (see the session-cookie approach in `docs/deploy/`… none exists; use the roster test seeds via a one-off script in `packages/roster`, mint a cookie with `lib/auth/session.ts`'s `encodeSession`, as done on 2026-09-11 for the map fix). Screenshot desktop and 390 px. The wall must not scroll horizontally at 390 px.
- [ ] **Step 9: Commit** — `git add apps/web && git commit -m "feat(web): the achievement wall on profiles and clan pages, closest-to-unlocking for the owner"`

---

### Task 14: The guide chapter, rendered from the definitions

**Files:**
- Create: `apps/web/content/guide/14-achievements.html`
- Modify: `apps/web/lib/guide.ts` (chapter 14 before the appendix), `apps/web/app/guide/render.ts` (an `{{ACHIEVEMENTS}}` block token), `apps/web/test/guide.test.ts` (chapter count 15, appendix index 14, the block token resolves)

- [ ] **Step 1: Failing test additions** in `apps/web/test/guide.test.ts`:

```ts
it("chapter 14 is Achievements, and its table is generated from the definitions, not typed", () => {
  const c = CHAPTERS.find((x) => x.slug === "achievements")!;
  expect(c).toMatchObject({ number: "14", file: "14-achievements.html" });
  expect(CHAPTERS).toHaveLength(15);
  expect(CHAPTERS[14]!.file).toBeNull();   // the appendix stays last
  const raw = readFileSync(join(CONTENT_DIR, c.file!), "utf8");
  expect(raw).toContain("{{ACHIEVEMENTS}}");
  const { html } = renderFragment(raw);
  expect(html).toContain("Sniper");
  expect(html).toContain("A kill from 300 m or more");
  expect((html.match(/<tr>/gu) ?? []).length).toBeGreaterThanOrEqual(50);
});
```

Also update the existing assertions that hard-code `toHaveLength(14)` / `CHAPTERS[13]` to 15 / 14. The hand-typed-number test strips `{{…}}` tokens before scanning, so the fragment must contain no thresholds in prose — the chapter text below has none.

- [ ] **Step 2: Run → fails (no chapter).**

- [ ] **Step 3: Chapter fragment**

```html
<!-- apps/web/content/guide/14-achievements.html -->
<p class="lede">Fifty marks on your record. Earned once, kept for good, and every one of them is proved from the server's own log — nothing here is claimed, only witnessed.</p>

<h2>What they are</h2>
<p>An achievement is a fact about what you did, in four kinds. <strong>Solo</strong> marks are about showing up and getting around. <strong>Survival</strong> marks are the map's doing: what you built and what killed you. <strong>Combat</strong> marks are kills, streaks and flags taken by hand. <strong>Clan</strong> marks belong to the clan, and every full member at the moment they are earned shares them; leave later and you keep the ones you were there for.</p>
<p>Friendly fire counts toward nothing, with one honest exception you will find below. Nothing here scores a point on the scoreboard. It is a record, like your stats.</p>

<h2>Where to see them</h2>
<p>Your profile page carries the wall: earned in gold with the date, the rest dimmed with how far along you are. Your own page shows the three you are closest to. A clan's page shows its twelve. Each unlock is announced in your clan's channel, in <strong>#achievements</strong>, and to you by DM.</p>

<h2>The fifty</h2>
{{ACHIEVEMENTS}}
```

- [ ] **Step 4: Render support** — in `apps/web/app/guide/render.ts`, before token substitution, replace the literal `{{ACHIEVEMENTS}}` with a table built from `ACHIEVEMENTS` (import from `@factions/domain`) and `GROUP_LABELS` (from `@/lib/achievements-copy`):

```ts
function achievementsTable(): string {
  const row = (a: (typeof ACHIEVEMENTS)[number]) => `<tr><td>${escape(a.name)}</td><td>${escape(a.description)}</td></tr>`;
  return ACHIEVEMENT_GROUPS.map((g) =>
    `<h3>${GROUP_LABELS[g]}</h3><table class="numbers"><thead><tr><th>Achievement</th><th>Earned by</th></tr></thead><tbody>` +
    ACHIEVEMENTS.filter((a) => a.group === g).map(row).join("") + `</tbody></table>`).join("");
}
```

with a small `escape()` for `& < >`, and `html = html.replace("{{ACHIEVEMENTS}}", achievementsTable())` as the first step of `renderFragment`. Reuse the appendix table's CSS class (read `guide.css` for the class the "Every number" table uses and apply the same). The `TOKEN` regex in render.ts matches `[A-Z0-9_]+` so `{{ACHIEVEMENTS}}` would otherwise throw as an unknown key — the replacement must run first, and the "every token resolves" test must keep passing (it will, since the token is gone by then).

- [ ] **Step 5: Chapter manifest** — in `apps/web/lib/guide.ts` insert before the appendix entry:

```ts
{ slug: "achievements", number: "14", title: "Achievements", file: "14-achievements.html",
  lede: "Fifty marks on your record, earned once and kept, each one proved from the log." },
```

- [ ] **Step 6: Run** — `cd apps/web && pnpm exec vitest run test/guide.test.ts test/guide-discord.test.ts` (the Discord reconciler test may pin the chapter count too — update it the same way) → pass. Then `pnpm exec vitest run` for the whole package.
- [ ] **Step 7: Commit** — `git add apps/web && git commit -m "feat(guide): chapter 14, Achievements, rendered from the definitions"`

---

### Task 15: Full gate, merge

- [ ] **Step 1: The gate** — from the repo root:

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force 2>&1 | tail -5
```

Expected: `Tasks: 26 successful, 26 total`, `Cached: 0 cached`. Anything else is not done.

- [ ] **Step 2: Inbox** — add a struck-through line to `docs/superpowers/plans/PLAN-3-INBOX.md` in its format: achievements shipped, date, commit; and an OPEN item: "Achievements: `carried` passes re-evaluate the same owners once (touched.ts holds watermarks when capped); fine at today's volume, a per-owner queue if a pass ever carries for more than a few minutes."

- [ ] **Step 3: Merge**

```bash
git checkout main && git pull --ff-only && git merge --no-ff achievements -m "Merge branch 'achievements'" && git push origin main
```

Then hand over to the runbook `docs/deploy/2026-09-12-achievements.md`. Do not deploy from this plan; deploying is the operator's step.

---

## Self-review notes (already applied)

- Spec §3 "Untouched" — the plan checks activation ≤ season start and a holding status at close; the spec's "active through" is satisfied by those two facts because a clan cannot leave and re-enter a season's standings.
- Spec §7 public channel — implemented on the notice queue (channel target with an explicit id), not the war-log queue, because the war-log poster targets one configured channel; `WAR_LOG_KINDS` is unchanged and no kind CHECK migration is needed. Task 9 carries the one verification the executor must do in `notice-tick.ts`.
- Spec §8 `/me` — a redirect; the closest-to-unlocking panel lives in the owner-only column of the player's own profile, which is what `/me` lands on.
- Spec §6.3 backfill path — `scripts/backfill-achievements.ts` at the repo root, matching the repo's convention, not `apps/bot/scripts/`.
- Type consistency: `Owner`, `RuleResult`, `Hit`, `oneShot`, `nth` (Task 4) are the names used in Tasks 5–9; `achievementsTick`/`evaluateOwner` (Task 9) in Tasks 10–11; `AchievementWall`/`AchievementTile`/`achievementsFor` (Task 12) in Tasks 13–14.
