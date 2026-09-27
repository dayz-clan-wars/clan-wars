# Referral Leaderboards and Weekly Plate Carrier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two new player boards ("Top referrers", "Top referrers this week") counting qualified referrals, and a weekly bot tick that grants the `plate-carrier` award to the week's top referrer(s).

**Architecture:** A referral *qualifies* once the referred player has 2 hours of play; a bot tick records that instant permanently in `referral_qualifications`. Both boards are ordinary `BoardKind`s in `packages/roster/src/stats.ts`, so the site, `/board`, the Discord leaderboards channel and the crowns pick them up through `BOARD_KINDS`. The payout closes each Monday-10:00-UTC week once, in one transaction keyed on `referral_weeks.week_start`, calling the existing `grantAwardTx` exactly as King of the Hill does.

**Tech Stack:** TypeScript, pnpm + turbo, drizzle-orm over postgres.js, drizzle-kit migrations, vitest, discord.js, Next.js (apps/web).

**Spec:** `docs/superpowers/specs/2026-09-27-referral-leaderboard-design.md`

## Global Constraints

- Qualification threshold: `REFERRAL_QUALIFY_MS = 2 * 60 * 60_000` (2 hours), total play, pre-referral play included.
- `qualified_at = max(referrals.created_at, instant cumulative play reached 2h)`; written once, never changed.
- Week: Monday 10:00 UTC to next Monday 10:00 UTC, `REFERRAL_WEEK_START_HOUR_UTC = 10`, half-open `[start, end)`, derived from the calendar, never stored.
- Close grace: `REFERRAL_CLOSE_GRACE_MS = 30 * 60_000`.
- Prize key: `"plate-carrier"` (already in `packages/domain/assets/awards.json`, `durationDays: 7`).
- Board kinds `referrers` / `referrersWeek`; labels "Top referrers" / "Top referrers this week"; slugs `referrers` / `referrers-week`.
- Crown env vars `CROWN_REFERRERS_ROLE_ID`, `CROWN_REFERRERS_WEEK_ROLE_ID` (optional).
- Tick env: `REFERRAL_AWARD_TICK` (gates payout only), `REFERRAL_AWARD_TICK_INTERVAL_MS` (default 300000). `REFERRAL_AWARD_TICK` without `SERVER_EVENTS_CHANNEL_ID` refuses to load.
- Lock order in the payout: `referral_weeks` → `award_grants` → `clan_notices`.
- Never close more than the most recently ended week (no backlog).
- Player-facing copy: plain voice, **no em dashes**, never discourage raiding.
- `packages/copy` imports no runtime value from `@factions/roster` (`packages/copy/test/leaf.test.ts`).
- Gate: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force` → **32/32 tasks**. Never run two test invocations at once. Never point anything at `factions_live` or ports 5432/5433.

## Spec amendments made by this plan

Recorded in the spec in Task 5, Step 1:
1. **Readiness uses the sessions cursor too**, not only the 30-minute grace (the lesson KotH's `scoringReady` encodes): a week closes only once `now >= end + grace`, ingest has seen an event after `end`, and `SESSIONS_CONSUMER`'s cursor has passed every event before `end`.
2. `referral_weeks` gains `detail jsonb not null default '{}'` holding `{ failure?, skipped?: string[], opsAlerted? }` for the ops alerts.
3. The announcement text lives in `apps/bot/src/referral-award-text.ts`, beside `koth-text.ts`, not in `packages/copy`: only the bot says it.

## Review Focus

1. **A referred player who had already played for weeks before being named** is expected to qualify at the referral instant, not in the past. Pinned in Task 1 (`qualifiedAt`) and Task 3 (DB).
2. **A session still open across the Monday boundary** is expected to count up to the instant it crosses 2h, landing the referral in the right week. Pinned in Task 1.
3. **The bot down across a close, or the ingest pipeline lagging at the boundary** is expected to close the week late with correct counts, never early with partial ones, and never to pay a backlog. Pinned in Task 5.
4. **An unlinked referrer at the top** is expected to stay on the board but be skipped at payout, with the next linked referrer winning. Pinned in Task 5.
5. **The clan board's roster narrowing** is expected to apply to the new boards by the referrer's character, like every other board. Pinned in Task 4.

---

## File map

| File | Responsibility |
|---|---|
| `packages/domain/src/rules.ts` (modify) | The four constants |
| `packages/domain/src/restarts.ts` (modify) | Export `mondayMidnightUtc` |
| `packages/domain/src/referrals.ts` (create) | Pure: `referralWeekFor`, `qualifiedAt`, `referralWinners` |
| `packages/domain/src/index.ts` (modify) | Re-export `./referrals` |
| `packages/db/src/schema.ts` (modify) | `referralQualifications`, `referralWeeks`, `referralWeekWinners` |
| `packages/db/migrations/0056_*.sql` (generated + hand-appended trigger) | Tables, indexes, permanence trigger |
| `packages/db/src/clear-referrals.ts` (modify) | Clear qualifications first |
| `packages/roster/src/internal/referral-qualify.ts` (create) | `qualifyReferralsDb` |
| `packages/roster/src/stats.ts` (modify) | Two board kinds, `referrersBoard` |
| `packages/copy/src/stats.ts`, `apps/web/lib/stats-copy.ts`, `apps/web/app/components/stat-boards.tsx`, `apps/web/app/(site)/players/boards/[board]/page.tsx`, `apps/bot/src/config.ts` (modify) | Labels, slugs, the weekly note, the scope picker, crown env |
| `apps/bot/src/referral-award.ts` (create) | `referralWeekReady`, `closeReferralWeek` |
| `apps/bot/src/referral-award-text.ts` (create) | Announcement text |
| `apps/bot/src/referral-award-tick.ts` (create) | Qualify → close → announce → ops |
| `apps/bot/src/discord.ts` (modify) | Wiring |
| `docs/deploy/2026-09-27-referral-leaderboard.md`, `CHANGELOG.md`, `CLAUDE.md` | Runbook, player notes, feature map row |

---

### Task 1: Pure rules: week, qualification instant, winners

**Files:**
- Modify: `packages/domain/src/rules.ts` (append near `KOTH_SCORE_SETTLE_MS`, line ~400)
- Modify: `packages/domain/src/restarts.ts:78` (export `mondayMidnightUtc`)
- Create: `packages/domain/src/referrals.ts`
- Modify: `packages/domain/src/index.ts` (add `export * from "./referrals";`)
- Test: `packages/domain/test/referrals.test.ts`

**Interfaces:**
- Produces:
  - `REFERRAL_QUALIFY_MS`, `REFERRAL_WEEK_START_HOUR_UTC`, `REFERRAL_CLOSE_GRACE_MS`, `REFERRAL_AWARD_KEY` (from `@factions/domain`)
  - `type ReferralWeek = { start: Date; end: Date }`
  - `referralWeekFor(at: Date): ReferralWeek` (week containing `at`)
  - `previousReferralWeek(now: Date): ReferralWeek` (the most recently ended week)
  - `type SessionSpan = { connectedAt: Date; disconnectedAt: Date | null }`
  - `qualifiedAt(sessions: SessionSpan[], referredAt: Date, now: Date, needMs?: number): Date | null`
  - `type ReferrerCount = { discordId: string; count: number }`
  - `referralWinners(counts: ReferrerCount[], isLinked: (discordId: string) => boolean): { winners: string[]; topCount: number; skipped: string[] }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/domain/test/referrals.test.ts
import { describe, it, expect } from "vitest";
import { referralWeekFor, previousReferralWeek, qualifiedAt, referralWinners, REFERRAL_QUALIFY_MS } from "../src/index";

const at = (iso: string) => new Date(iso);
const H = 3_600_000;

describe("referralWeekFor", () => {
  it("runs Monday 10:00 UTC to the next Monday 10:00 UTC", () => {
    expect(referralWeekFor(at("2026-09-30T12:00:00Z"))).toEqual({ start: at("2026-09-28T10:00:00Z"), end: at("2026-10-05T10:00:00Z") });
  });
  it("puts Monday 09:59 in the previous week and Monday 10:00 in the new one", () => {
    expect(referralWeekFor(at("2026-09-28T09:59:59Z")).start).toEqual(at("2026-09-21T10:00:00Z"));
    expect(referralWeekFor(at("2026-09-28T10:00:00Z")).start).toEqual(at("2026-09-28T10:00:00Z"));
  });
  it("treats Sunday as the end of the week, not the start", () => {
    expect(referralWeekFor(at("2026-10-04T23:00:00Z")).start).toEqual(at("2026-09-28T10:00:00Z"));
  });
  it("is unaffected by a European DST change (UTC throughout)", () => {
    expect(referralWeekFor(at("2026-10-26T10:00:00Z")).start).toEqual(at("2026-10-26T10:00:00Z"));
  });
  it("previousReferralWeek is the week that most recently ended", () => {
    expect(previousReferralWeek(at("2026-09-28T10:00:00Z"))).toEqual({ start: at("2026-09-21T10:00:00Z"), end: at("2026-09-28T10:00:00Z") });
  });
});

describe("qualifiedAt", () => {
  const s = (from: string, to: string | null) => ({ connectedAt: at(from), disconnectedAt: to === null ? null : at(to) });
  const now = at("2026-10-01T00:00:00Z");

  it("is null below two hours", () => {
    expect(qualifiedAt([s("2026-09-29T10:00:00Z", "2026-09-29T11:59:00Z")], at("2026-09-29T00:00:00Z"), now)).toBeNull();
  });
  it("is the instant cumulative play reaches two hours, across sessions", () => {
    const sessions = [s("2026-09-29T20:00:00Z", "2026-09-29T21:30:00Z"), s("2026-09-28T10:00:00Z", "2026-09-28T10:10:00Z"), s("2026-09-30T08:00:00Z", "2026-09-30T09:00:00Z")];
    // 10 min + 90 min = 100 min; 20 more minutes into the third session.
    expect(qualifiedAt(sessions, at("2026-09-28T00:00:00Z"), now)).toEqual(at("2026-09-30T08:20:00Z"));
  });
  it("counts an open session up to now, and lands mid-session across the week boundary", () => {
    const sessions = [s("2026-10-05T09:00:00Z", null)];
    expect(qualifiedAt(sessions, at("2026-10-01T00:00:00Z"), at("2026-10-05T12:00:00Z"))).toEqual(at("2026-10-05T11:00:00Z"));
    expect(qualifiedAt(sessions, at("2026-10-01T00:00:00Z"), at("2026-10-05T10:30:00Z"))).toBeNull();
  });
  it("uses the referral instant for a player who already had the play time", () => {
    expect(qualifiedAt([s("2026-01-01T00:00:00Z", "2026-01-01T05:00:00Z")], at("2026-09-29T15:00:00Z"), now)).toEqual(at("2026-09-29T15:00:00Z"));
  });
  it("ignores a zero or negative span", () => {
    expect(qualifiedAt([s("2026-09-29T10:00:00Z", "2026-09-29T09:00:00Z")], at("2026-09-01T00:00:00Z"), now)).toBeNull();
  });
  it("honours needMs", () => {
    expect(qualifiedAt([s("2026-09-29T10:00:00Z", "2026-09-29T10:30:00Z")], at("2026-09-01T00:00:00Z"), now, H / 2)).toEqual(at("2026-09-29T10:30:00Z"));
    expect(REFERRAL_QUALIFY_MS).toBe(2 * H);
  });
});

describe("referralWinners", () => {
  const linked = (...ids: string[]) => (id: string) => ids.includes(id);
  it("is every linked referrer tied at the top", () => {
    expect(referralWinners([{ discordId: "a", count: 3 }, { discordId: "b", count: 3 }, { discordId: "c", count: 1 }], linked("a", "b", "c")))
      .toEqual({ winners: ["a", "b"], topCount: 3, skipped: [] });
  });
  it("skips an unlinked top referrer and gives it to the next", () => {
    expect(referralWinners([{ discordId: "x", count: 5 }, { discordId: "b", count: 2 }], linked("b")))
      .toEqual({ winners: ["b"], topCount: 2, skipped: ["x"] });
  });
  it("has no winner with no counts, or nobody linked", () => {
    expect(referralWinners([], linked())).toEqual({ winners: [], topCount: 0, skipped: [] });
    expect(referralWinners([{ discordId: "x", count: 1 }], linked())).toEqual({ winners: [], topCount: 0, skipped: ["x"] });
  });
  it("lists winners and skipped in a stable order", () => {
    expect(referralWinners([{ discordId: "b", count: 1 }, { discordId: "a", count: 1 }], linked("a", "b")).winners).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @factions/domain exec vitest run test/referrals.test.ts`
Expected: FAIL (`referralWeekFor` is not exported).

- [ ] **Step 3: Write the implementation**

In `packages/domain/src/restarts.ts` change line 78 `function mondayMidnightUtc` to `export function mondayMidnightUtc`.

Append to `packages/domain/src/rules.ts`:

```ts
/** Referral leaderboards (spec 2026-09-27-referral-leaderboard §2, §3). */
/** Play a referred player needs before their referral counts. Total play, including play before they were named. */
export const REFERRAL_QUALIFY_MS = 2 * 60 * 60_000;
/** A referral week starts Monday at this hour, UTC. Its own constant: moving the vehicle wipe's `offHour` must not move the contest. */
export const REFERRAL_WEEK_START_HOUR_UTC = 10;
/** How long after a week ends before it may close, on top of the sessions-cursor check. */
export const REFERRAL_CLOSE_GRACE_MS = 30 * 60_000;
/** The prize. A key in `assets/awards.json`. */
export const REFERRAL_AWARD_KEY = "plate-carrier";
```

Create `packages/domain/src/referrals.ts`:

```ts
import { REFERRAL_QUALIFY_MS, REFERRAL_WEEK_START_HOUR_UTC } from "./rules";
import { mondayMidnightUtc } from "./restarts";

/**
 * Referral weeks and qualification (spec 2026-09-27-referral-leaderboard).
 * Pure: no clock, no I/O.
 */

const HOUR_MS = 60 * 60_000;
const WEEK_MS = 7 * 24 * HOUR_MS;

/** Half-open `[start, end)`. */
export type ReferralWeek = { start: Date; end: Date };

/** The week containing `at`. ⚠️ Derived from the calendar, never stored, like the vehicle rotation. */
export function referralWeekFor(at: Date): ReferralWeek {
  let start = mondayMidnightUtc(at) + REFERRAL_WEEK_START_HOUR_UTC * HOUR_MS;
  // Monday before 10:00 still belongs to the previous week.
  if (start > at.getTime()) start -= WEEK_MS;
  return { start: new Date(start), end: new Date(start + WEEK_MS) };
}

/** The most recently ENDED week at `now`: the only one the payout ever considers (no backlog). */
export function previousReferralWeek(now: Date): ReferralWeek {
  const current = referralWeekFor(now);
  return { start: new Date(current.start.getTime() - WEEK_MS), end: current.start };
}

export type SessionSpan = { connectedAt: Date; disconnectedAt: Date | null };

/**
 * When a referral qualifies: the later of the referral instant and the instant
 * the player's cumulative play reached `needMs`. Null while it has not.
 *
 * An open session counts up to `now`. Sessions are summed in connect order;
 * a span that ends at or before it starts contributes nothing.
 */
export function qualifiedAt(sessions: SessionSpan[], referredAt: Date, now: Date, needMs = REFERRAL_QUALIFY_MS): Date | null {
  const sorted = [...sessions].sort((a, b) => a.connectedAt.getTime() - b.connectedAt.getTime());
  let played = 0;
  for (const s of sorted) {
    const start = s.connectedAt.getTime();
    const end = Math.min((s.disconnectedAt ?? now).getTime(), now.getTime());
    if (end <= start) continue;
    if (played + (end - start) >= needMs) {
      const reached = start + (needMs - played);
      return new Date(Math.max(reached, referredAt.getTime()));
    }
    played += end - start;
  }
  return null;
}

export type ReferrerCount = { discordId: string; count: number };

/**
 * The week's winners: every LINKED referrer tied at the highest count, if that
 * count is at least 1. An unlinked referrer cannot place an award, so they are
 * dropped before ranking; `skipped` lists the ones that would have won or tied,
 * for the ops note.
 */
export function referralWinners(counts: ReferrerCount[], isLinked: (discordId: string) => boolean): { winners: string[]; topCount: number; skipped: string[] } {
  const byId = (a: ReferrerCount, b: ReferrerCount) => (a.discordId < b.discordId ? -1 : a.discordId > b.discordId ? 1 : 0);
  const eligible = counts.filter((c) => c.count > 0 && isLinked(c.discordId));
  const topCount = eligible.reduce((m, c) => Math.max(m, c.count), 0);
  const winners = eligible.filter((c) => c.count === topCount && topCount > 0).sort(byId).map((c) => c.discordId);
  const skipped = counts.filter((c) => c.count > 0 && !isLinked(c.discordId) && c.count >= topCount).sort(byId).map((c) => c.discordId);
  return { winners, topCount, skipped };
}
```

Add `export * from "./referrals";` to `packages/domain/src/index.ts` after `export * from "./restarts";`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @factions/domain exec vitest run test/referrals.test.ts && pnpm --filter @factions/domain run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): referral week, qualification instant and weekly winners"
```

---

### Task 2: Schema, migration and permanence

**Files:**
- Modify: `packages/db/src/schema.ts` (after `referrals`, line ~268)
- Create: `packages/db/migrations/0056_<generated>.sql` + `meta/` snapshot (via drizzle-kit)
- Modify: `packages/db/src/clear-referrals.ts`
- Test: `packages/db/test/referral-qualifications.test.ts`

**Interfaces:**
- Produces (from `@factions/db`): `referralQualifications`, `referralWeeks`, `referralWeekWinners`; `type ReferralWeekDetail = { failure?: string; skipped?: string[]; opsAlerted?: boolean }`. `clearReferrals(db)` now also clears `referral_qualifications`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/test/referral-qualifications.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { createClient, runMigrations, requireTestDatabaseUrl, clearReferrals, referrals, referralQualifications, referralWeeks, type Database } from "../src/index";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-29T12:00:00Z");

describe("referral_qualifications", () => {
  let db: Database;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table referral_week_winners, referral_weeks restart identity cascade`);
    await clearReferrals(db);
    await db.insert(referrals).values({ referredDiscordId: "A", referrerDiscordId: "B", referrerDayzId: "dz-B", source: "later_bot", createdAt: now });
    await db.insert(referralQualifications).values({ referredDiscordId: "A", referrerDiscordId: "B", qualifiedAt: now });
  });

  it("refuses update, delete and truncate", async () => {
    await expect(db.execute(sql`update referral_qualifications set qualified_at = now()`)).rejects.toThrow(/permanent/);
    await expect(db.execute(sql`delete from referral_qualifications`)).rejects.toThrow(/permanent/);
    await expect(db.execute(sql`truncate referral_qualifications`)).rejects.toThrow(/permanent/);
  });

  it("refuses a second qualification for the same referral", async () => {
    await expect(db.insert(referralQualifications).values({ referredDiscordId: "A", referrerDiscordId: "B", qualifiedAt: now })).rejects.toThrow();
  });

  it("clearReferrals clears qualifications before referrals", async () => {
    await clearReferrals(db);
    expect(await db.select().from(referralQualifications)).toEqual([]);
    expect(await db.select().from(referrals)).toEqual([]);
  });

  it("referral_weeks is keyed on week_start with an empty detail by default", async () => {
    const start = new Date("2026-09-21T10:00:00Z");
    await db.insert(referralWeeks).values({ weekStart: start, closedAt: now, topCount: 0 });
    const again = await db.insert(referralWeeks).values({ weekStart: start, closedAt: now, topCount: 0 }).onConflictDoNothing().returning();
    expect(again).toEqual([]);
    expect((await db.select().from(referralWeeks))[0]!.detail).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/db exec vitest run test/referral-qualifications.test.ts`
Expected: FAIL (`referralQualifications` is not exported).

- [ ] **Step 3: Add the schema**

After the `referrals` table in `packages/db/src/schema.ts` (the file already imports `pgTable`, `text`, `timestamp`, `integer`, `bigint`, `jsonb`, `index`, `primaryKey` if used elsewhere; add any missing to the `drizzle-orm/pg-core` import):

```ts
/**
 * When a referral QUALIFIED: the referred player reached `REFERRAL_QUALIFY_MS`
 * of play (spec 2026-09-27-referral-leaderboard §2). Written once by
 * `qualifyReferralsDb`; both referral boards and the weekly payout count these.
 *
 * ⚠️ Permanent like `referrals` (trigger `referral_qualifications_permanent`):
 * a qualification must survive the referred player unlinking, which is why it
 * is recorded rather than derived. `clearReferrals` is the only clearing path.
 */
export const referralQualifications = pgTable("referral_qualifications", {
  referredDiscordId: text("referred_discord_id").primaryKey().references(() => referrals.referredDiscordId),
  /** Copied from `referrals` so the weekly count needs no join. */
  referrerDiscordId: text("referrer_discord_id").notNull(),
  qualifiedAt: timestamp("qualified_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byWeek: index("referral_qualifications_week_idx").on(t.qualifiedAt, t.referrerDiscordId),
}));

export type ReferralWeekDetail = { failure?: string; skipped?: string[]; opsAlerted?: boolean };

/**
 * One row per CLOSED referral week. ⚠️ The insert of this row is the payout's
 * idempotency guard: `ON CONFLICT DO NOTHING` returning nothing means the week
 * was already paid. Lock order `referral_weeks` → `award_grants` → `clan_notices`.
 */
export const referralWeeks = pgTable("referral_weeks", {
  weekStart: timestamp("week_start", { withTimezone: true }).primaryKey(),
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull(),
  /** The winning count; 0 for a week with no winner. */
  topCount: integer("top_count").notNull(),
  /** Set once the public post succeeds. */
  announcedAt: timestamp("announced_at", { withTimezone: true }),
  detail: jsonb("detail").$type<ReferralWeekDetail>().notNull().default({}),
});

export const referralWeekWinners = pgTable("referral_week_winners", {
  weekStart: timestamp("week_start", { withTimezone: true }).notNull().references(() => referralWeeks.weekStart),
  discordId: text("discord_id").notNull(),
  /** Their character at payout, for the announcement. */
  dayzId: text("dayz_id").notNull(),
  awardGrantId: bigint("award_grant_id", { mode: "number" }).notNull().references(() => awardGrants.id),
}, (t) => ({
  pk: primaryKey({ columns: [t.weekStart, t.discordId] }),
}));
```

⚠️ `awardGrants` is declared later in the file (line ~1358); the `references(() => awardGrants.id)` thunk resolves lazily, so declaration order does not matter.

- [ ] **Step 4: Generate the migration and append the trigger**

Run: `pnpm --filter @factions/db run generate`
Expected: a new `packages/db/migrations/0056_<name>.sql` and `meta/0056_snapshot.json`.

Append to the end of that `.sql` file (same shape as 0054's):

```sql
--> statement-breakpoint
CREATE OR REPLACE FUNCTION referral_qualifications_permanent() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'referral qualifications are permanent: % refused', lower(TG_OP);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER referral_qualifications_permanent BEFORE UPDATE OR DELETE ON referral_qualifications
  FOR EACH ROW EXECUTE FUNCTION referral_qualifications_permanent();
--> statement-breakpoint
CREATE TRIGGER referral_qualifications_no_truncate BEFORE TRUNCATE ON referral_qualifications
  FOR EACH STATEMENT EXECUTE FUNCTION referral_qualifications_permanent();
```

- [ ] **Step 5: Extend `clearReferrals`**

In `packages/db/src/clear-referrals.ts`, inside the transaction, replace the three trigger/delete lines with:

```ts
    // ⚠️ Qualifications first: they reference `referrals`, and both are permanent.
    await tx.execute(sql`ALTER TABLE referral_qualifications DISABLE TRIGGER USER`);
    await tx.execute(sql`DELETE FROM referral_qualifications`);
    await tx.execute(sql`ALTER TABLE referral_qualifications ENABLE TRIGGER USER`);
    await tx.execute(sql`ALTER TABLE referrals DISABLE TRIGGER USER`);
    await tx.execute(sql`DELETE FROM referrals`);
    await tx.execute(sql`ALTER TABLE referrals ENABLE TRIGGER USER`);
```

and add "and `referral_qualifications`" to its doc comment's first sentence.

- [ ] **Step 6: Run tests to verify they pass**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/db exec vitest run && pnpm --filter @factions/db run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/db
git commit -m "feat(db): referral_qualifications, referral_weeks and referral_week_winners (0056)"
```

---

### Task 3: Recording qualifications

**Files:**
- Create: `packages/roster/src/internal/referral-qualify.ts`
- Modify: `packages/roster/src/internal/index.ts` (add `export * from "./referral-qualify";`)
- Test: `packages/roster/test/referral-qualify.test.ts`

**Interfaces:**
- Consumes: `qualifiedAt`, `REFERRAL_QUALIFY_MS` (Task 1); `referralQualifications` (Task 2).
- Produces: `qualifyReferralsDb(db: Database, now: Date): Promise<number>` (count newly qualified), from `@factions/roster/internal`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/roster/test/referral-qualify.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import {
  createClient, runMigrations, requireTestDatabaseUrl, clearReferrals,
  servers, admFiles, events, playerSessions, identityLinks, referrals, referralQualifications, type Database,
} from "@factions/db";
import { qualifyReferralsDb } from "../src/internal/referral-qualify";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);

describe("qualifyReferralsDb", () => {
  let db: Database; let serverId = 0; let fileId = 0; let line = 0;
  beforeEach(async () => {
    db = createClient(URL); await runMigrations(db);
    await db.execute(sql`truncate table player_sessions, events, adm_files, identity_links, servers restart identity cascade`);
    await clearReferrals(db);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, active: true }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: at("2026-01-01T00:00:00Z"), linesIngested: 0, complete: true }).returning();
    fileId = f!.id; line = 0;
  });

  const link = (discordId: string, dayzId: string) =>
    db.insert(identityLinks).values({ discordId, dayzId, gamertag: `gt-${dayzId}`, verifiedAt: at("2026-01-01T00:00:00Z") });
  const refer = (referred: string, referrer: string, createdAt: string) =>
    db.insert(referrals).values({ referredDiscordId: referred, referrerDiscordId: referrer, referrerDayzId: `dz-${referrer}`, source: "later_bot", createdAt: at(createdAt) });
  async function session(dayzId: string, from: string, to: string | null) {
    const [e] = await db.insert(events).values({ serverId, admFileId: fileId, lineIndex: line++, type: "player.connected", occurredAt: at(from), payload: { dayzId } }).returning();
    await db.insert(playerSessions).values({ serverId, dayzId, connectedAt: at(from), connectEventId: e!.id,
      disconnectedAt: to === null ? null : at(to), closeReason: to === null ? null : "disconnect" });
  }
  const quals = () => db.select().from(referralQualifications);

  it("records a referral once the referred player passes two hours, at that instant", async () => {
    await link("A", "dz-A"); await link("B", "dz-B");
    await refer("A", "B", "2026-09-28T12:00:00Z");
    await session("dz-A", "2026-09-29T10:00:00Z", "2026-09-29T11:00:00Z");
    expect(await qualifyReferralsDb(db, at("2026-09-29T12:00:00Z"))).toBe(0);
    await session("dz-A", "2026-09-30T10:00:00Z", "2026-09-30T12:00:00Z");
    expect(await qualifyReferralsDb(db, at("2026-09-30T13:00:00Z"))).toBe(1);
    expect(await quals()).toEqual([expect.objectContaining({ referredDiscordId: "A", referrerDiscordId: "B", qualifiedAt: at("2026-09-30T11:00:00Z") })]);
  });

  it("uses the referral instant for a player who already had the play time", async () => {
    await link("A", "dz-A"); await link("B", "dz-B");
    await session("dz-A", "2026-01-02T00:00:00Z", "2026-01-02T05:00:00Z");
    await refer("A", "B", "2026-09-28T12:00:00Z");
    await qualifyReferralsDb(db, at("2026-09-28T12:05:00Z"));
    expect((await quals())[0]!.qualifiedAt).toEqual(at("2026-09-28T12:00:00Z"));
  });

  it("writes nothing twice, and keeps the qualification after the referred player unlinks", async () => {
    await link("A", "dz-A"); await link("B", "dz-B");
    await refer("A", "B", "2026-09-28T12:00:00Z");
    await session("dz-A", "2026-09-29T10:00:00Z", "2026-09-29T13:00:00Z");
    expect(await qualifyReferralsDb(db, at("2026-09-29T14:00:00Z"))).toBe(1);
    await db.delete(identityLinks).where(sql`discord_id = 'A'`);
    expect(await qualifyReferralsDb(db, at("2026-09-29T15:00:00Z"))).toBe(0);
    expect(await quals()).toHaveLength(1);
  });

  it("skips a referred player who is not linked", async () => {
    await link("B", "dz-B");
    await refer("A", "B", "2026-09-28T12:00:00Z");
    await session("dz-A", "2026-09-29T10:00:00Z", "2026-09-29T13:00:00Z");
    expect(await qualifyReferralsDb(db, at("2026-09-29T14:00:00Z"))).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/roster exec vitest run test/referral-qualify.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```ts
// packages/roster/src/internal/referral-qualify.ts
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { identityLinks, playerSessions, referralQualifications, referrals, type Database } from "@factions/db";
import { qualifiedAt, type SessionSpan } from "@factions/domain";

/**
 * Record every referral that has newly qualified (spec 2026-09-27-referral-leaderboard §2).
 * Returns how many were written.
 *
 * Only the referred player's CURRENT link is consulted: an unlinked referred
 * player cannot qualify, but one who already has is kept (the table is permanent).
 * Each qualification is its own insert, `ON CONFLICT DO NOTHING`, so a run that
 * fails partway, or two runs racing, write each row at most once.
 */
export async function qualifyReferralsDb(db: Database, now: Date): Promise<number> {
  const pending = await db.select({
    referredDiscordId: referrals.referredDiscordId, referrerDiscordId: referrals.referrerDiscordId,
    createdAt: referrals.createdAt, dayzId: identityLinks.dayzId,
  }).from(referrals)
    .innerJoin(identityLinks, eq(identityLinks.discordId, referrals.referredDiscordId))
    .leftJoin(referralQualifications, eq(referralQualifications.referredDiscordId, referrals.referredDiscordId))
    .where(isNull(referralQualifications.referredDiscordId));
  if (pending.length === 0) return 0;

  const sessions = await db.select({ dayzId: playerSessions.dayzId, connectedAt: playerSessions.connectedAt, disconnectedAt: playerSessions.disconnectedAt })
    .from(playerSessions)
    .where(inArray(playerSessions.dayzId, pending.map((p) => p.dayzId)))
    .orderBy(asc(playerSessions.connectedAt));
  const byPlayer = new Map<string, SessionSpan[]>();
  for (const s of sessions) {
    const list = byPlayer.get(s.dayzId) ?? [];
    list.push({ connectedAt: s.connectedAt, disconnectedAt: s.disconnectedAt });
    byPlayer.set(s.dayzId, list);
  }

  let written = 0;
  for (const p of pending) {
    const when = qualifiedAt(byPlayer.get(p.dayzId) ?? [], p.createdAt, now);
    if (when === null) continue;
    const rows = await db.insert(referralQualifications)
      .values({ referredDiscordId: p.referredDiscordId, referrerDiscordId: p.referrerDiscordId, qualifiedAt: when })
      .onConflictDoNothing().returning({ id: referralQualifications.referredDiscordId });
    written += rows.length;
  }
  return written;
}
```

Remove the unused `and` import if typecheck flags it. Add `export * from "./referral-qualify";` to `packages/roster/src/internal/index.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/roster exec vitest run test/referral-qualify.test.ts && pnpm --filter @factions/roster run typecheck`
Expected: PASS. If `packages/roster/test/roster-exports.ts` enumerates internal exports, add `qualifyReferralsDb` to it.

- [ ] **Step 5: Commit**

```bash
git add packages/roster
git commit -m "feat(roster): record referral qualifications"
```

---

### Task 4: The two referral boards

Every exhaustive `Record<BoardKind, …>` must gain both kinds in the same commit or typecheck fails, so this task spans roster, copy, web and bot config.

**Files:**
- Modify: `packages/roster/src/stats.ts` (`Boards` type ~line 52, `BOARD_KINDS` line 96, `boardRows` ~441, `boardsFor` ~496; new `referrersBoard`)
- Modify: `packages/copy/src/stats.ts` (`BOARD_LABELS`, `BOARD_SLUGS`)
- Modify: `apps/web/lib/stats-copy.ts` (add `REFERRERS_WEEK_NOTE`)
- Modify: `apps/web/app/components/stat-boards.tsx:23` (`NOTE`)
- Modify: `apps/web/app/(site)/players/boards/[board]/page.tsx:33` (no scope picker on the weekly board)
- Modify: `apps/bot/src/config.ts:308` (`CROWN_ROLE_ENV`)
- Test: `packages/roster/test/referral-boards.test.ts`; update literal counts in existing suites (Step 6)

**Interfaces:**
- Consumes: `referralWeekFor` (Task 1); `referralQualifications`, `referrals` (Task 2).
- Produces: `BOARD_KINDS` with `"referrers"` and `"referrersWeek"` appended; `Boards.referrers: BoardRow[]`, `Boards.referrersWeek: BoardRow[]`; `boardPageDb(db, "referrers" | "referrersWeek", …)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/roster/test/referral-boards.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import {
  createClient, runMigrations, requireTestDatabaseUrl, clearReferrals,
  servers, seasons, players, identityLinks, referrals, referralQualifications, type Database,
} from "@factions/db";
import { playerBoardsDb, boardPageDb, clanBoardDb, BOARD_KINDS } from "../src/stats";
import { seedFaction } from "./seed";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const now = at("2026-09-30T12:00:00Z");               // week of Mon 2026-09-28 10:00
const THIS_WEEK = at("2026-09-29T12:00:00Z");
const LAST_WEEK = at("2026-09-22T12:00:00Z");
const ALL = { kind: "all" } as const;

describe("referral boards", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL); await runMigrations(db);
    await db.execute(sql`truncate table identity_links, players, seasons, servers restart identity cascade`);
    await clearReferrals(db);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, active: true }).returning();
    serverId = s!.id;
  });

  const link = async (discordId: string, dayzId: string, gamertag: string) => {
    await db.insert(players).values({ dayzId, gamertag, firstSeenAt: now, lastSeenAt: now });
    await db.insert(identityLinks).values({ discordId, dayzId, gamertag, verifiedAt: now });
  };
  /** A qualified referral of `referred` by `referrer`, qualifying at `when`. */
  const qualified = async (referred: string, referrer: string, when: Date, snapDayzId = `dz-${referrer}`) => {
    await db.insert(referrals).values({ referredDiscordId: referred, referrerDiscordId: referrer, referrerDayzId: snapDayzId, source: "later_bot", createdAt: when });
    await db.insert(referralQualifications).values({ referredDiscordId: referred, referrerDiscordId: referrer, qualifiedAt: when });
  };

  it("adds both kinds to BOARD_KINDS, last", () => {
    expect(BOARD_KINDS.slice(-2)).toEqual(["referrers", "referrersWeek"]);
  });

  it("counts only qualified referrals, all-time and this week", async () => {
    await link("B", "dz-B", "Otto"); await link("C", "dz-C", "Cleo");
    await qualified("r1", "B", THIS_WEEK); await qualified("r2", "B", LAST_WEEK); await qualified("r3", "C", THIS_WEEK);
    // Recorded but not qualified: counts nowhere.
    await db.insert(referrals).values({ referredDiscordId: "r4", referrerDiscordId: "C", referrerDayzId: "dz-C", source: "later_bot", createdAt: THIS_WEEK });
    const b = await playerBoardsDb(db, ALL, 10, now);
    expect(b.referrers.map((r) => [r.gamertag, r.value])).toEqual([["Otto", 2], ["Cleo", 1]]);
    expect(b.referrersWeek.map((r) => [r.gamertag, r.value])).toEqual([["Cleo", 1], ["Otto", 1]]);
  });

  it("orders a tie by who reached the count first", async () => {
    await link("B", "dz-B", "Otto"); await link("C", "dz-C", "Cleo");
    await qualified("r1", "B", at("2026-09-29T01:00:00Z")); await qualified("r2", "C", at("2026-09-29T02:00:00Z"));
    expect((await playerBoardsDb(db, ALL, 10, now)).referrersWeek.map((r) => r.gamertag)).toEqual(["Otto", "Cleo"]);
  });

  it("referrers follows the season scope; referrersWeek ignores it", async () => {
    await link("B", "dz-B", "Otto");
    await db.insert(seasons).values({ serverId, number: 1, startedAt: at("2026-09-01T00:00:00Z"), endedAt: at("2026-09-25T00:00:00Z") });
    await qualified("r1", "B", LAST_WEEK); await qualified("r2", "B", THIS_WEEK);
    const s1 = await playerBoardsDb(db, { kind: "season", number: 1 }, 10, now);
    expect(s1.referrers.map((r) => r.value)).toEqual([1]);
    expect(s1.referrersWeek.map((r) => r.value)).toEqual([1]);
  });

  it("shows an unlinked referrer by the character the referral snapshotted", async () => {
    await db.insert(players).values({ dayzId: "dz-gone", gamertag: "Ghost", firstSeenAt: now, lastSeenAt: now });
    await qualified("r1", "gone", THIS_WEEK, "dz-gone");
    expect((await playerBoardsDb(db, ALL, 10, now)).referrers).toEqual([{ dayzId: "dz-gone", gamertag: "Ghost", value: 1 }]);
  });

  it("pages like any board", async () => {
    await link("B", "dz-B", "Otto"); await link("C", "dz-C", "Cleo");
    await qualified("r1", "B", THIS_WEEK); await qualified("r2", "C", THIS_WEEK);
    const p = await boardPageDb(db, "referrersWeek", ALL, 1, now, 1);
    expect(p.rows).toHaveLength(1);
    expect(p.hasNext).toBe(true);
  });

  it("the clan board narrows by the referrer's character", async () => {
    const { leaderDiscordId, memberDayzIds } = await seedFaction(db, { serverId });
    const memberDayzId = memberDayzIds[0]!;
    const memberDiscord = (await db.select().from(identityLinks).where(sql`dayz_id = ${memberDayzId}`))[0]!.discordId;
    await link("C", "dz-C", "Cleo");
    await qualified("r1", memberDiscord, THIS_WEEK, memberDayzId); await qualified("r2", "C", THIS_WEEK);
    const b = await clanBoardDb(db, leaderDiscordId, ALL, 10, now);
    if (typeof b === "string") throw new Error(b);
    expect(b.referrers.map((r) => r.dayzId)).toEqual([memberDayzId]);
  });
});
```

⚠️ Before running, open `packages/roster/test/seed.ts` and adjust the last test's destructuring to what `seedFaction` actually returns (it seeds a faction with linked members); the assertion, "only the member's row appears", is what matters.

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/roster exec vitest run test/referral-boards.test.ts`
Expected: FAIL (`b.referrers` undefined / kinds missing).

- [ ] **Step 3: Implement the board in `packages/roster/src/stats.ts`**

Add `referralQualifications, referrals` to the `@factions/db` import and `referralWeekFor` to the `@factions/domain` import.

`Boards` type, after `bountyKills`:

```ts
  /**
   * Qualified referrals (spec 2026-09-27-referral-leaderboard): players this
   * referrer brought in who then reached two hours of play, windowed on when
   * each qualified. Rows are the referrer's current character, else the one the
   * referral snapshotted.
   */
  referrers: BoardRow[];
  /** The same count for the current referral week only. ⚠️ Ignores the scope: always this week. */
  referrersWeek: BoardRow[];
```

`BOARD_KINDS`:

```ts
export const BOARD_KINDS = ["raiders", "killers", "kd", "streaks", "longestKills", "bountyKills", "builders", "playTime", "deaths", "friendlyFire", "referrers", "referrersWeek"] as const;
```

Update the doc comment above it: "The twelve board names … last the two shameful boards (deaths, friendly fire), then the two referral boards."

New function, after `kdBoard`:

```ts
/**
 * Referrers by qualified referrals in `w` (spec 2026-09-27-referral-leaderboard §5).
 * Grouped by the referrer's Discord account; shown as their current character,
 * else the character the referral snapshotted (never a Discord id).
 * Ties: whoever reached the count first, then name.
 */
async function referrersBoard(db: Database, w: Window, roster: string[] | null, limit: number, offset = 0): Promise<BoardRow[]> {
  const counted = sql`
    select ${referrals.referrerDiscordId} as discord_id, max(${referrals.referrerDayzId}) as snap,
           count(*)::int as value, max(${referralQualifications.qualifiedAt}) as reached_at
    from ${referralQualifications}
    join ${referrals} on ${referrals.referredDiscordId} = ${referralQualifications.referredDiscordId}
    where ${inWindow(referralQualifications.qualifiedAt, w)}
    group by ${referrals.referrerDiscordId}`;
  const shown = sql`coalesce(l.dayz_id, c.snap)`;
  const rosterWhere = roster === null ? sql``
    : roster.length === 0 ? sql`where false`
    : sql`where ${shown} = any(array[${sql.join(roster.map((id) => sql`${id}`), sql`, `)}]::text[])`;
  const rows = await db.execute<{ dayzId: string; gamertag: string; value: number }>(sql`
    select ${shown} as "dayzId", coalesce(l.gamertag, p.gamertag, c.snap) as gamertag, c.value
    from (${counted}) c
    left join identity_links l on l.discord_id = c.discord_id
    left join players p on p.dayz_id = ${shown}
    ${rosterWhere}
    order by c.value desc, c.reached_at asc, 2 asc
    limit ${limit} offset ${offset}`);
  return [...rows].map((r) => ({ dayzId: r.dayzId, gamertag: r.gamertag, value: Number(r.value) }));
}
```

`boardRows` switch, after `bountyKills`:

```ts
    case "referrers": return referrersBoard(db, w, roster, limit, offset);
    // ⚠️ Not `w`: the weekly board is always the current referral week, whatever the scope picker says.
    case "referrersWeek": {
      const week = referralWeekFor(now);
      return referrersBoard(db, { from: week.start, to: week.end, seasonId: null }, roster, limit, offset);
    }
```

`boardsFor`: extend the destructure, `Promise.all`, `all` and return object with `referrers` / `referrersWeek`, using `rows("referrers")` and `rows("referrersWeek")`. Update its doc comment "The ten boards" → "The twelve boards", and `Boards.clans`' "across all ten boards" → "across every board".

- [ ] **Step 4: Labels, slugs, notes, picker, crown env**

`packages/copy/src/stats.ts`:

```ts
  friendlyFire: "Most friendly fire",
  referrers: "Top referrers",
  referrersWeek: "Top referrers this week",
```
and in `BOARD_SLUGS`:
```ts
  bountyKills: "bounty-kills",
  referrers: "referrers",
  referrersWeek: "referrers-week",
```
Change "the ten kinds anyway" in `boardKindFromSlug`'s comment to "every kind anyway", and "rewrites ten links and orphans ten messages" to "rewrites every link and orphans every message".

`apps/web/lib/stats-copy.ts`, beside `STREAK_NOTE`:
```ts
/** Under the weekly referrers board: it ignores the season picker. */
export const REFERRERS_WEEK_NOTE = "This week, from Monday 10:00 UTC";
```
`apps/web/app/components/stat-boards.tsx`: import `REFERRERS_WEEK_NOTE` from `@/lib/stats-copy` and set
```ts
const NOTE: Partial<Record<Kind, string>> = { kd: KD_NOTE, builders: BUILD_NOTE, streaks: STREAK_NOTE, referrersWeek: REFERRERS_WEEK_NOTE };
```
`apps/web/app/(site)/players/boards/[board]/page.tsx:33`: render the picker only when it means something:
```tsx
        aside={kind === "referrersWeek" ? <span className="text-[11px]">{REFERRERS_WEEK_NOTE}</span> : <ScopePicker seasons={page.seasons} basePath={`${basePath}/${BOARD_SLUGS[kind]}`} current={page.scope} />} />
```
(import `REFERRERS_WEEK_NOTE` from `@/lib/stats-copy`). Apply the same one-line change to `apps/web/app/(site)/clan/board/` if its full-board page renders a `ScopePicker` for a single kind.

`apps/bot/src/config.ts` `CROWN_ROLE_ENV`:
```ts
  friendlyFire: "CROWN_FRIENDLY_FIRE_ROLE_ID",
  referrers: "CROWN_REFERRERS_ROLE_ID",
  referrersWeek: "CROWN_REFERRERS_WEEK_ROLE_ID",
```
⚠️ The weekly crown moves from holder to holder every Monday and empties until someone qualifies; that is intended. `PgCrownStore` drops a `value <= 0` top, so an empty week holds no crown.

- [ ] **Step 5: Run the new test**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/roster exec vitest run test/referral-boards.test.ts`
Expected: PASS.

- [ ] **Step 6: Update existing suites that hard-code ten boards**

Run: `grep -rnE "toHaveLength\(10\)|\bten\b|\b10 boards|length\)\.toBe\(10\)" packages/roster/test packages/copy/test apps/bot/test apps/web/test`
For each hit that counts board kinds, standing messages, crowns or board slugs, change 10 → 12 (or the equivalent wording), and where a test enumerates every kind literally (e.g. a slug table in `apps/web/test/board-page.test.ts`, `apps/web/test/stats-copy.test.ts`, `apps/bot/test/config.test.ts`'s crown env list), add the two new entries. Leave hits unrelated to boards (a `BOARD_TOP` of 10 rows is NOT a board count) untouched.

Any test that truncates `referrals`-adjacent data without `clearReferrals` and seeds a qualification must call `clearReferrals(db)` in `beforeEach`.

- [ ] **Step 7: Run the full gate**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`
Expected: **32/32** tasks successful.

- [ ] **Step 8: Commit**

```bash
git add packages/roster packages/copy apps/web apps/bot
git commit -m "feat: Top referrers and Top referrers this week boards"
```

---

### Task 5: Closing a week

**Files:**
- Modify: `docs/superpowers/specs/2026-09-27-referral-leaderboard-design.md` (record the three amendments listed at the top of this plan, in §4, §6)
- Create: `apps/bot/src/referral-award.ts`
- Test: `apps/bot/test/referral-award.test.ts`

**Interfaces:**
- Consumes: `previousReferralWeek`, `referralWinners`, `REFERRAL_CLOSE_GRACE_MS`, `REFERRAL_AWARD_KEY`, `type ReferralWeek` (Task 1); tables (Task 2); `grantAwardTx` from `@factions/roster/internal`; `SESSIONS_CONSUMER` from `./sessions-tick.js`; `readCursor` from `@factions/event-log`.
- Produces:
  - `referralWeekReady(db: Database, week: ReferralWeek, now: Date): Promise<boolean>`
  - `type CloseOutcome = { status: "already" } | { status: "closed"; winners: string[]; topCount: number; skipped: string[]; failure?: string }`
  - `closeReferralWeek(db: Database, week: ReferralWeek, opts: { now: Date; siteBaseUrl: string; grantedByDiscordId: string }): Promise<CloseOutcome>`

- [ ] **Step 1: Amend the spec**

In the spec's §4 `referral_weeks` table add the row ``| `detail` | jsonb, not null, default '{}' | `{ failure?, skipped?, opsAlerted? }` for ops alerts |``. In §6 step 2 replace "only once `now >= end + 30 min` (`REFERRAL_CLOSE_GRACE_MS`), giving ingest time to deliver the last sessions." with "only once `now >= end + 30 min` (`REFERRAL_CLOSE_GRACE_MS`) AND ingest has seen an event after `end` AND the `sessions-projector` cursor has passed every event before `end` (the same two-part test as KotH's `scoringReady`)." In §6 **Announcement**, change "Copy (in `packages/copy`, no em dashes)" to "Copy (in `apps/bot/src/referral-award-text.ts`, beside `koth-text.ts`; no em dashes)".

- [ ] **Step 2: Write the failing test**

```ts
// apps/bot/test/referral-award.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  createClient, runMigrations, requireTestDatabaseUrl, clearReferrals,
  servers, admFiles, events, identityLinks, referrals, referralQualifications, referralWeeks, referralWeekWinners, awardGrants, clanNotices,
  type Database,
} from "@factions/db";
import { writeCursor } from "@factions/event-log";
import { SESSIONS_CONSUMER } from "../src/sessions-tick.js";
import { closeReferralWeek, referralWeekReady } from "../src/referral-award.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const WEEK = { start: at("2026-09-21T10:00:00Z"), end: at("2026-09-28T10:00:00Z") };
const IN_WEEK = at("2026-09-24T12:00:00Z");
const CLOSE_AT = at("2026-09-28T11:00:00Z");
const opts = { now: CLOSE_AT, siteBaseUrl: "https://site.test", grantedByDiscordId: "bot" };

describe("closing a referral week", () => {
  let db: Database; let serverId = 0; let fileId = 0; let line = 0; let n = 0;
  beforeEach(async () => {
    db = createClient(URL); await runMigrations(db);
    await db.execute(sql`truncate table referral_week_winners, referral_weeks, award_grants, clan_notices, events, adm_files, identity_links, consumer_cursors, servers restart identity cascade`);
    await clearReferrals(db);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, active: true }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: WEEK.start, linesIngested: 0, complete: true }).returning();
    fileId = f!.id; line = 0; n = 0;
  });

  const link = (discordId: string) => db.insert(identityLinks).values({ discordId, dayzId: `dz-${discordId}`, gamertag: `gt-${discordId}`, verifiedAt: WEEK.start });
  /** `count` qualified referrals for `referrer`, each qualifying at `when`. */
  async function brought(referrer: string, count: number, when = IN_WEEK) {
    for (let i = 0; i < count; i++) {
      const referred = `r${n++}`;
      await db.insert(referrals).values({ referredDiscordId: referred, referrerDiscordId: referrer, referrerDayzId: `dz-${referrer}`, source: "later_bot", createdAt: when });
      await db.insert(referralQualifications).values({ referredDiscordId: referred, referrerDiscordId: referrer, qualifiedAt: when });
    }
  }
  const event = async (iso: string) =>
    (await db.insert(events).values({ serverId, admFileId: fileId, lineIndex: line++, type: "player.connected", occurredAt: at(iso), payload: {} }).returning())[0]!.id;

  it("grants the plate carrier to the top linked referrer, with its DM, once", async () => {
    await link("A"); await link("B");
    await brought("A", 3); await brought("B", 1);
    const out = await closeReferralWeek(db, WEEK, opts);
    expect(out).toEqual({ status: "closed", winners: ["A"], topCount: 3, skipped: [] });
    const grants = await db.select().from(awardGrants);
    expect(grants).toEqual([expect.objectContaining({ awardKey: "plate-carrier", discordId: "A", grantedByDiscordId: "bot" })]);
    expect(await db.select().from(clanNotices)).toEqual([expect.objectContaining({ kind: "award_granted", discordTargetId: "A" })]);
    expect(await db.select().from(referralWeekWinners)).toEqual([expect.objectContaining({ discordId: "A", dayzId: "dz-A", awardGrantId: grants[0]!.id })]);
    expect(await closeReferralWeek(db, WEEK, opts)).toEqual({ status: "already" });
    expect(await db.select().from(awardGrants)).toHaveLength(1);
  });

  it("grants every referrer tied at the top", async () => {
    await link("A"); await link("B");
    await brought("A", 2); await brought("B", 2);
    expect(await closeReferralWeek(db, WEEK, opts)).toMatchObject({ winners: ["A", "B"], topCount: 2 });
    expect(await db.select().from(awardGrants)).toHaveLength(2);
  });

  it("skips an unlinked top referrer and records it for ops", async () => {
    await link("B");
    await brought("X", 5); await brought("B", 1);
    expect(await closeReferralWeek(db, WEEK, opts)).toMatchObject({ winners: ["B"], topCount: 1, skipped: ["X"] });
    expect((await db.select().from(referralWeeks))[0]!.detail).toEqual({ skipped: ["X"] });
  });

  it("counts a referral qualifying one second before the end, not one at the end", async () => {
    await link("A"); await link("B");
    await brought("A", 1, at("2026-09-28T09:59:59Z"));
    await brought("B", 2, WEEK.end);
    expect(await closeReferralWeek(db, WEEK, opts)).toMatchObject({ winners: ["A"], topCount: 1 });
  });

  it("closes a week with no qualified referrals with no grant", async () => {
    expect(await closeReferralWeek(db, WEEK, opts)).toEqual({ status: "closed", winners: [], topCount: 0, skipped: [] });
    expect(await db.select().from(awardGrants)).toEqual([]);
    expect(await db.select().from(referralWeeks)).toEqual([expect.objectContaining({ topCount: 0, announcedAt: null })]);
  });

  describe("readiness", () => {
    it("waits for the grace period", async () => {
      const last = await event("2026-09-28T09:00:00Z"); await event("2026-09-28T10:05:00Z");
      await writeCursor(db, SESSIONS_CONSUMER, last + 1);
      expect(await referralWeekReady(db, WEEK, at("2026-09-28T10:20:00Z"))).toBe(false);
      expect(await referralWeekReady(db, WEEK, at("2026-09-28T10:30:00Z"))).toBe(true);
    });
    it("waits for ingest to pass the boundary, and for the sessions cursor to catch up", async () => {
      const last = await event("2026-09-28T09:00:00Z");
      expect(await referralWeekReady(db, WEEK, CLOSE_AT)).toBe(false);         // nothing after the end yet
      await event("2026-09-28T10:05:00Z");
      await writeCursor(db, SESSIONS_CONSUMER, last - 1);
      expect(await referralWeekReady(db, WEEK, CLOSE_AT)).toBe(false);         // cursor behind
      await writeCursor(db, SESSIONS_CONSUMER, last);
      expect(await referralWeekReady(db, WEEK, CLOSE_AT)).toBe(true);
    });
  });
});
```

Check `clanNotices` column names against `packages/db/src/schema.ts` (`discordTargetId`, `kind`) and adjust the matcher if they differ.

- [ ] **Step 3: Run test to verify it fails**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/bot exec vitest run test/referral-award.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Write the implementation**

```ts
// apps/bot/src/referral-award.ts
import { and, count, eq, gt, gte, inArray, lt, max } from "drizzle-orm";
import { events, identityLinks, referralQualifications, referralWeeks, referralWeekWinners, servers, type Database, type ReferralWeekDetail } from "@factions/db";
import { REFERRAL_AWARD_KEY, REFERRAL_CLOSE_GRACE_MS, referralWinners, type ReferralWeek } from "@factions/domain";
import { awardsCatalogue } from "@factions/domain/awards";
import { readCursor } from "@factions/event-log";
import { grantAwardTx } from "@factions/roster/internal";
import { SESSIONS_CONSUMER } from "./sessions-tick.js";

/**
 * ⚠️ All three, never one (spec §6, the lesson of KotH's `scoringReady`): the grace
 * covers log lag, the "seen past the end" test covers a stalled ingest, and the
 * cursor test covers a bot catching up. Without them a restart after downtime
 * closes a half-ingested week and pays the wrong player, for good.
 */
export async function referralWeekReady(db: Database, week: ReferralWeek, now: Date): Promise<boolean> {
  if (now.getTime() < week.end.getTime() + REFERRAL_CLOSE_GRACE_MS) return false;
  const [past] = await db.select({ id: events.id }).from(events).where(gt(events.occurredAt, week.end)).limit(1);
  if (!past) return false;
  const [last] = await db.select({ id: max(events.id) }).from(events).where(lt(events.occurredAt, week.end));
  return (last?.id ?? 0) <= await readCursor(db, SESSIONS_CONSUMER);
}

export type CloseOutcome =
  | { status: "already" }
  | { status: "closed"; winners: string[]; topCount: number; skipped: string[]; failure?: string };

const reasonFor = (week: ReferralWeek) => `Top referrer, week of ${week.start.toISOString().slice(0, 10)}`;

/**
 * Pay one week, once (spec §6). ONE transaction: the week row, every grant, every
 * DM and every winner row, or none. Lock order referral_weeks → award_grants →
 * clan_notices.
 *
 * ⚠️ The week-row insert is the idempotency guard: no row returned means already
 * paid. A refused grant THROWS so the whole week rolls back and the next tick
 * retries; a prize missing from the catalogue is NOT a refusal, it closes the
 * week with a `failure` for ops, because it would refuse forever.
 */
export async function closeReferralWeek(db: Database, week: ReferralWeek, opts: { now: Date; siteBaseUrl: string; grantedByDiscordId: string }): Promise<CloseOutcome> {
  return db.transaction(async (tx) => {
    const claimed = await tx.insert(referralWeeks).values({ weekStart: week.start, closedAt: opts.now, topCount: 0 })
      .onConflictDoNothing().returning({ weekStart: referralWeeks.weekStart });
    if (claimed.length === 0) return { status: "already" } as const;

    const counts = (await tx.select({ discordId: referralQualifications.referrerDiscordId, count: count() })
      .from(referralQualifications)
      .where(and(gte(referralQualifications.qualifiedAt, week.start), lt(referralQualifications.qualifiedAt, week.end)))
      .groupBy(referralQualifications.referrerDiscordId))
      .map((r) => ({ discordId: r.discordId, count: Number(r.count) }));
    const links = counts.length === 0 ? [] : await tx.select({ discordId: identityLinks.discordId, dayzId: identityLinks.dayzId })
      .from(identityLinks).where(inArray(identityLinks.discordId, counts.map((c) => c.discordId)));
    const dayzOf = new Map(links.map((l) => [l.discordId, l.dayzId]));
    const { winners, topCount, skipped } = referralWinners(counts, (id) => dayzOf.has(id));

    const detail: ReferralWeekDetail = skipped.length > 0 ? { skipped } : {};
    const setWeek = (v: Partial<typeof referralWeeks.$inferInsert>) => tx.update(referralWeeks).set(v).where(eq(referralWeeks.weekStart, week.start));

    if (winners.length > 0 && !awardsCatalogue()[REFERRAL_AWARD_KEY]) {
      const failure = `award "${REFERRAL_AWARD_KEY}" is no longer in awards.json; grant it by hand with /award grant to ${winners.join(", ")}`;
      await setWeek({ topCount, detail: { ...detail, failure } });
      return { status: "closed", winners: [], topCount, skipped, failure } as const;
    }

    if (winners.length > 0) {
      // ⚠️ `clan_notices.server_id` is NOT NULL: the DM needs a server, as in grantAwardDb.
      const [server] = await tx.select({ id: servers.id }).from(servers).where(eq(servers.active, true)).limit(1);
      if (!server) throw new Error("referral award: no active server");
      for (const discordId of winners) {
        const g = await grantAwardTx(tx, {
          awardKey: REFERRAL_AWARD_KEY, winnerDiscordId: discordId, grantedByDiscordId: opts.grantedByDiscordId,
          reason: reasonFor(week), siteBaseUrl: opts.siteBaseUrl, now: opts.now, serverId: server.id,
        });
        if (!g.ok) throw new Error(`referral award: grant refused (${g.reason})`);
        await tx.insert(referralWeekWinners).values({ weekStart: week.start, discordId, dayzId: dayzOf.get(discordId)!, awardGrantId: g.grantId });
      }
    }
    await setWeek({ topCount, detail });
    return { status: "closed", winners, topCount, skipped } as const;
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/bot exec vitest run test/referral-award.test.ts && pnpm --filter @factions/bot run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/referral-award.ts apps/bot/test/referral-award.test.ts docs/superpowers/specs/2026-09-27-referral-leaderboard-design.md
git commit -m "feat(bot): close a referral week and grant the plate carrier"
```

---

### Task 6: The tick, its text, config and wiring

**Files:**
- Create: `apps/bot/src/referral-award-text.ts`
- Create: `apps/bot/src/referral-award-tick.ts`
- Modify: `apps/bot/src/config.ts` (type ~line 174, load ~line 499, refusal ~line 604)
- Modify: `apps/bot/src/discord.ts` (poster ~line 677, tick after KotH ~line 1745, startup "off because" log)
- Test: `apps/bot/test/referral-award-text.test.ts`, `apps/bot/test/referral-award-tick.test.ts`, `apps/bot/test/config.test.ts`

**Interfaces:**
- Consumes: `qualifyReferralsDb` (Task 3); `closeReferralWeek`, `referralWeekReady` (Task 5); `previousReferralWeek` (Task 1).
- Produces:
  - `referralWinnersText(names: string[], count: number): string`
  - `referralAwardTick(db: Database, posters: { announce: (c: string) => Promise<void>; ops: (c: string) => Promise<void> }, opts: { now: Date; siteBaseUrl: string; grantedByDiscordId: string; payout: boolean }): Promise<{ qualified: number; closed: number; posted: number }>`
  - `Config.referralAward: { enabled: boolean; intervalMs: number }`

- [ ] **Step 1: Write the failing text test**

```ts
// apps/bot/test/referral-award-text.test.ts
import { describe, it, expect } from "vitest";
import { referralWinnersText } from "../src/referral-award-text.js";

describe("referralWinnersText", () => {
  it("names one winner", () => {
    expect(referralWinnersText(["Otto"], 3)).toBe("Top referrer this week: **Otto**, who brought in 3 new players. They get a plate carrier for a week.");
  });
  it("says player for one", () => {
    expect(referralWinnersText(["Otto"], 1)).toContain("brought in 1 new player.");
  });
  it("names a tie", () => {
    expect(referralWinnersText(["Otto", "Cleo"], 2)).toBe("Top referrers this week: **Otto** and **Cleo**, with 2 new players each. They each get a plate carrier for a week.");
    expect(referralWinnersText(["A", "B", "C"], 1)).toContain("**A**, **B** and **C**, with 1 new player each.");
  });
  it("escapes markdown in names and uses no em dash", () => {
    expect(referralWinnersText(["_x_"], 1)).toContain("**\\_x\\_**");
    expect(referralWinnersText(["A", "B"], 2)).not.toMatch(/—/);
  });
});
```

- [ ] **Step 2: Write the text**

```ts
// apps/bot/src/referral-award-text.ts
import { escapeMarkdown } from "./kill-feed-embed.js";

/** "**a**", "**a** and **b**", "**a**, **b** and **c**". */
function names(list: string[]): string {
  const bold = list.map((n) => `**${escapeMarkdown(n)}**`);
  return bold.length <= 1 ? bold.join("") : `${bold.slice(0, -1).join(", ")} and ${bold[bold.length - 1]}`;
}

/**
 * The weekly winners post (spec 2026-09-27-referral-leaderboard §6), to the server
 * events channel. Plain voice, no em dashes.
 */
export function referralWinnersText(winners: string[], count: number): string {
  const players = `${count} new player${count === 1 ? "" : "s"}`;
  return winners.length === 1
    ? `Top referrer this week: ${names(winners)}, who brought in ${players}. They get a plate carrier for a week.`
    : `Top referrers this week: ${names(winners)}, with ${players} each. They each get a plate carrier for a week.`;
}
```

Run: `pnpm --filter @factions/bot exec vitest run test/referral-award-text.test.ts` → PASS.

- [ ] **Step 3: Write the failing tick test**

```ts
// apps/bot/test/referral-award-tick.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import {
  createClient, runMigrations, requireTestDatabaseUrl, clearReferrals,
  servers, admFiles, events, identityLinks, players, playerSessions, referrals, referralWeeks, awardGrants, type Database,
} from "@factions/db";
import { writeCursor } from "@factions/event-log";
import { SESSIONS_CONSUMER } from "../src/sessions-tick.js";
import { referralAwardTick } from "../src/referral-award-tick.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);

describe("referralAwardTick", () => {
  let db: Database; let serverId = 0; let fileId = 0; let line = 0;
  let announced: string[]; let ops: string[]; let failAnnounce: boolean;
  const posters = {
    announce: async (c: string) => { if (failAnnounce) throw new Error("discord down"); announced.push(c); },
    ops: async (c: string) => { ops.push(c); },
  };
  const tick = (now: string, payout = true) => referralAwardTick(db, posters, { now: at(now), siteBaseUrl: "https://site.test", grantedByDiscordId: "bot", payout });

  beforeEach(async () => {
    db = createClient(URL); await runMigrations(db);
    await db.execute(sql`truncate table referral_week_winners, referral_weeks, award_grants, clan_notices, player_sessions, events, adm_files, identity_links, players, consumer_cursors, servers restart identity cascade`);
    await clearReferrals(db);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, active: true }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: at("2026-09-01T00:00:00Z"), linesIngested: 0, complete: true }).returning();
    fileId = f!.id; line = 0; announced = []; ops = []; failAnnounce = false;
    for (const [d, g] of [["A", "Otto"], ["N", "Newbie"]] as const) {
      await db.insert(players).values({ dayzId: `dz-${d}`, gamertag: g, firstSeenAt: at("2026-09-01T00:00:00Z"), lastSeenAt: at("2026-09-01T00:00:00Z") });
      await db.insert(identityLinks).values({ discordId: d, dayzId: `dz-${d}`, gamertag: g, verifiedAt: at("2026-09-01T00:00:00Z") });
    }
    await db.insert(referrals).values({ referredDiscordId: "N", referrerDiscordId: "A", referrerDayzId: "dz-A", source: "link_bot", createdAt: at("2026-09-22T12:00:00Z") });
  });

  async function event(iso: string) {
    return (await db.insert(events).values({ serverId, admFileId: fileId, lineIndex: line++, type: "player.connected", occurredAt: at(iso), payload: {} }).returning())[0]!.id;
  }
  /** A 3h session for the referred player in the week of 2026-09-21, and ingest caught up past the boundary. */
  async function playedAndIngested() {
    const e = await event("2026-09-23T18:00:00Z");
    await db.insert(playerSessions).values({ serverId, dayzId: "dz-N", connectedAt: at("2026-09-23T18:00:00Z"), connectEventId: e, disconnectedAt: at("2026-09-23T21:00:00Z"), closeReason: "disconnect" });
    const last = await event("2026-09-28T09:50:00Z");
    await event("2026-09-28T10:10:00Z");
    await writeCursor(db, SESSIONS_CONSUMER, last);
  }

  it("qualifies even with the payout off, and pays nothing", async () => {
    await playedAndIngested();
    expect(await tick("2026-09-28T11:00:00Z", false)).toEqual({ qualified: 1, closed: 0, posted: 0 });
    expect(await db.select().from(referralWeeks)).toEqual([]);
  });

  it("closes the ended week, grants, and announces once", async () => {
    await playedAndIngested();
    expect(await tick("2026-09-28T11:00:00Z")).toEqual({ qualified: 1, closed: 1, posted: 1 });
    expect(announced).toEqual(["Top referrer this week: **Otto**, who brought in 1 new player. They get a plate carrier for a week."]);
    expect(await tick("2026-09-28T11:05:00Z")).toEqual({ qualified: 0, closed: 0, posted: 0 });
    expect(announced).toHaveLength(1);
    expect(await db.select().from(awardGrants)).toHaveLength(1);
  });

  it("retries a failed announcement on the next tick", async () => {
    await playedAndIngested();
    failAnnounce = true;
    expect((await tick("2026-09-28T11:00:00Z")).posted).toBe(0);
    failAnnounce = false;
    expect((await tick("2026-09-28T11:05:00Z")).posted).toBe(1);
    expect(announced).toHaveLength(1);
  });

  it("does not close before ingest has caught up", async () => {
    const e = await event("2026-09-23T18:00:00Z");
    await db.insert(playerSessions).values({ serverId, dayzId: "dz-N", connectedAt: at("2026-09-23T18:00:00Z"), connectEventId: e, disconnectedAt: at("2026-09-23T21:00:00Z"), closeReason: "disconnect" });
    expect((await tick("2026-09-28T11:00:00Z")).closed).toBe(0);
  });

  it("never pays a backlog: after two weeks down, only the latest week closes", async () => {
    await playedAndIngested();                              // qualifies in the week of 09-21
    await event("2026-10-05T10:10:00Z");
    await writeCursor(db, SESSIONS_CONSUMER, 1_000_000);
    expect((await tick("2026-10-05T11:00:00Z")).closed).toBe(1);
    expect((await db.select().from(referralWeeks)).map((w) => w.weekStart)).toEqual([at("2026-09-28T10:00:00Z")]);
    expect(await db.select().from(awardGrants)).toEqual([]);
  });

  it("posts one ops note for a skipped referrer", async () => {
    await db.delete(identityLinks).where(sql`discord_id = 'A'`);
    await playedAndIngested();
    await tick("2026-09-28T11:00:00Z");
    await tick("2026-09-28T11:05:00Z");
    expect(ops).toHaveLength(1);
    expect(ops[0]).toContain("A");
    expect(announced).toEqual([]);
  });
});
```

- [ ] **Step 4: Write the tick**

```ts
// apps/bot/src/referral-award-tick.ts
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { players, referralWeeks, referralWeekWinners, type Database } from "@factions/db";
import { previousReferralWeek } from "@factions/domain";
import { qualifyReferralsDb } from "@factions/roster/internal";
import { closeReferralWeek, referralWeekReady } from "./referral-award.js";
import { referralWinnersText } from "./referral-award-text.js";

export type ReferralPosters = { announce: (c: string) => Promise<void>; ops: (c: string) => Promise<void> };

/**
 * Referral qualification and the weekly plate carrier (spec 2026-09-27-referral-leaderboard §6).
 *
 * 1. Qualify: always, so the boards fill before the prize is on.
 * 2. Close the most recently ended week: only when `payout`, and only once ready.
 *    ⚠️ Never an older week: turning this on, or a long outage, pays no backlog.
 * 3. Announce any closed week with winners and no `announced_at`. Post, THEN stamp.
 * 4. Ops notes for skipped referrers or a missing prize, once each.
 *
 * Each step has its own try/catch: a failing step must not starve the others.
 */
export async function referralAwardTick(
  db: Database, posters: ReferralPosters,
  opts: { now: Date; siteBaseUrl: string; grantedByDiscordId: string; payout: boolean },
): Promise<{ qualified: number; closed: number; posted: number }> {
  const out = { qualified: 0, closed: 0, posted: 0 };
  try {
    out.qualified = await qualifyReferralsDb(db, opts.now);
  } catch (err) {
    console.error("referrals: qualification failed; retrying next tick", err);
  }
  if (!opts.payout) return out;

  try {
    const week = previousReferralWeek(opts.now);
    if (await referralWeekReady(db, week, opts.now)) {
      const r = await closeReferralWeek(db, week, opts);
      if (r.status === "closed") out.closed = 1;
    }
  } catch (err) {
    console.error("referrals: closing the week failed; retrying next tick", err);
  }

  const weeks = await db.select().from(referralWeeks).where(gt(referralWeeks.topCount, 0));
  for (const w of weeks) {
    try {
      if (w.announcedAt === null) {
        const winners = await db.select({ gamertag: players.gamertag, dayzId: referralWeekWinners.dayzId })
          .from(referralWeekWinners)
          .leftJoin(players, eq(players.dayzId, referralWeekWinners.dayzId))
          .where(eq(referralWeekWinners.weekStart, w.weekStart))
          .orderBy(asc(referralWeekWinners.discordId));
        if (winners.length > 0) {
          try {
            await posters.announce(referralWinnersText(winners.map((x) => x.gamertag ?? x.dayzId), w.topCount));
          } catch (err) {
            console.warn("referrals: winners post failed; retrying next tick", err);
            continue;
          }
          await db.update(referralWeeks).set({ announcedAt: opts.now }).where(and(eq(referralWeeks.weekStart, w.weekStart), isNull(referralWeeks.announcedAt)));
          out.posted += 1;
        }
      }
    } catch (err) {
      console.error(`referrals: announcing week ${w.weekStart.toISOString()} failed`, err);
    }
  }

  // Ops: any closed week (winners or not) with something to say, once.
  const all = await db.select().from(referralWeeks);
  for (const w of all) {
    const d = w.detail;
    if (d.opsAlerted || (!d.failure && !(d.skipped && d.skipped.length > 0))) continue;
    const day = w.weekStart.toISOString().slice(0, 10);
    const lines = [
      ...(d.skipped && d.skipped.length > 0 ? [`skipped unlinked top referrer(s) ${d.skipped.join(", ")}`] : []),
      ...(d.failure ? [d.failure] : []),
    ];
    try {
      await posters.ops(`⚠️ Referral week of ${day}: ${lines.join("; ")}`);
      await db.update(referralWeeks).set({ detail: { ...d, opsAlerted: true } }).where(eq(referralWeeks.weekStart, w.weekStart));
    } catch (err) {
      console.warn("referrals: ops note failed; retrying next tick", err);
    }
  }
  return out;
}
```

Note: the "skipped" test's week closes with `top_count = 0` (nobody eligible) and no announcement; its ops line names Discord id `A`, which is correct for the ops channel only (never the public post).

- [ ] **Step 5: Config**

In `apps/bot/src/config.ts`:

Type, after `koth`:
```ts
  /**
   * Referral qualification always runs (the boards need it); `enabled` gates only
   * the weekly plate carrier payout (`referral-award-tick.ts`).
   */
  referralAward: { enabled: boolean; intervalMs: number };
```
Load, after `koth: {…}`:
```ts
    referralAward: {
      enabled: ["1", "true"].includes((env.REFERRAL_AWARD_TICK ?? "").trim().toLowerCase()),
      intervalMs: positiveInt(env, "REFERRAL_AWARD_TICK_INTERVAL_MS", 300_000, MAX_TIMER_MS),
    },
```
Refusal, after the `KOTH_TICK … SERVER_EVENTS_CHANNEL_ID` check:
```ts
  if (config.referralAward.enabled && !config.serverEventsChannelId) {
    throw new Error("REFERRAL_AWARD_TICK is on but SERVER_EVENTS_CHANNEL_ID is unset. The weekly winner would never be announced.");
  }
```
Add to `apps/bot/test/config.test.ts`, following that file's existing KotH refusal test (copy its env-building helper):
```ts
  it("refuses REFERRAL_AWARD_TICK without SERVER_EVENTS_CHANNEL_ID", () => {
    expect(() => loadConfig({ ...baseEnv(), REFERRAL_AWARD_TICK: "1" })).toThrow(/REFERRAL_AWARD_TICK/);
  });
  it("defaults the referral award off, every five minutes", () => {
    expect(loadConfig(baseEnv()).referralAward).toEqual({ enabled: false, intervalMs: 300_000 });
  });
```
(Use the file's actual loader and base-env names.)

- [ ] **Step 6: Wire into `discord.ts`**

Beside `kothPoster` (~line 677):
```ts
  const referralPoster = cfg.referralAward.enabled && cfg.serverEventsChannelId
    ? createChannelPoster(client, cfg.serverEventsChannelId, { allowedMentions: { parse: [] } })
    : null;
  let lastReferralAt = 0;
```
After the KotH block (~line 1745):
```ts
    // ⚠️ After the restart tick, like every server-events poster. Qualification runs
    // whether or not REFERRAL_AWARD_TICK is on (the boards need it); only the payout
    // is gated. Config refuses the payout without SERVER_EVENTS_CHANNEL_ID, so
    // referralPoster is non-null whenever payout is true.
    if (Date.now() - lastReferralAt >= cfg.referralAward.intervalMs && client.user) {
      lastReferralAt = Date.now();
      try {
        const opsPoster = opsChannelPoster ?? (async (content: string) => { console.error(content); });
        const r = await referralAwardTick(db,
          { announce: referralPoster ?? (async () => {}), ops: opsPoster },
          { now: new Date(), siteBaseUrl: cfg.siteBaseUrl, grantedByDiscordId: client.user.id, payout: cfg.referralAward.enabled });
        if (r.qualified + r.closed + r.posted > 0) console.log(`referrals: ${r.qualified} qualified, ${r.closed} closed, ${r.posted} posted`);
      } catch (err) {
        console.error("referral tick failed", err);
      }
    }
```
Import `referralAwardTick` from `./referral-award-tick.js`. In the `clientReady` "feature is off because" log block, add a line for `REFERRAL_AWARD_TICK` in the same style as its neighbours.

- [ ] **Step 7: Run tests and gate**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/bot exec vitest run test/referral-award-tick.test.ts test/referral-award-text.test.ts test/config.test.ts`
Expected: PASS.
Then the full gate: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force` → **32/32**.

- [ ] **Step 8: Commit**

```bash
git add apps/bot
git commit -m "feat(bot): weekly referral award tick"
```

---

### Task 7: Docs, runbook, changelog

**Files:**
- Create: `docs/deploy/2026-09-27-referral-leaderboard.md`
- Modify: `CHANGELOG.md` (Unreleased section at the top)
- Modify: `CLAUDE.md` (feature table row; update "ten leaderboards"/"ten crowns" rows to twelve)

- [ ] **Step 1: Runbook**

```markdown
# Referral leaderboards and the weekly plate carrier: deploy

Spec `docs/superpowers/specs/2026-09-27-referral-leaderboard-design.md`.

1. **Migrate.** `0056` only adds tables; nothing running selects a dropped column, so
   the bot may stay up. Apply it the usual way (`docs/deploy/2026-09-10-launch.md`).
2. **Deploy web and bot.** The leaderboards channel sees two boards it has no message
   for and rebuilds itself once, to twelve messages. Expected; nothing to do.
3. **Boards fill.** Qualification runs every `REFERRAL_AWARD_TICK_INTERVAL_MS`
   (default 5 min) with or without the payout switched on. Existing referrals whose
   player already has 2 hours qualify on the first pass, at their referral time.
4. **Crowns (optional).** Create two roles and set `CROWN_REFERRERS_ROLE_ID`,
   `CROWN_REFERRERS_WEEK_ROLE_ID`. Each must differ from every other crown role.
5. **Switch on the prize** with `REFERRAL_AWARD_TICK=1` (requires
   `SERVER_EVENTS_CHANNEL_ID`). The first payout is the first week that ends after
   this: Monday 10:00 UTC plus 30 minutes and ingest caught up. ⚠️ Older weeks are
   never paid.

**Checking a week:** `select * from referral_weeks order by week_start desc;` and
`referral_week_winners`. A week row means that week is paid; deleting one would pay
it again on the next tick, so never delete one on `factions_live`.

**A missing prize** (`plate-carrier` removed from `awards.json`): the week closes with
no grant and an ops alert naming the winners; grant by hand with `/award grant`.
```

- [ ] **Step 2: CHANGELOG entry** (under the Unreleased heading, matching the file's existing style; no em dashes)

```markdown
- Two new leaderboards: Top referrers and Top referrers this week. A player you bring in counts once they've played for two hours.
- Every Monday, whoever brought in the most players that week gets a plate carrier for a week. If it's a tie, everyone tied gets one.
```

- [ ] **Step 3: CLAUDE.md feature row**

Add to the feature table, after the Event awards row:

```markdown
| Referral boards and the weekly plate carrier (two boards counting qualified referrals; the week's top referrer is granted `plate-carrier`) | Pure rules `packages/domain/src/referrals.ts` (`referralWeekFor`, `previousReferralWeek`, `qualifiedAt`, `referralWinners`; constants in `rules.ts`); `referral_qualifications`, `referral_weeks`, `referral_week_winners` (migration 0056); qualification `qualifyReferralsDb` in `packages/roster/src/internal/referral-qualify.ts`; boards `referrers`/`referrersWeek` in `packages/roster/src/stats.ts` (`referrersBoard`); payout `apps/bot/src/referral-award.ts` (`referralWeekReady`, `closeReferralWeek`), tick `apps/bot/src/referral-award-tick.ts`, text `referral-award-text.ts`. Payout gated on `REFERRAL_AWARD_TICK` (requires `SERVER_EVENTS_CHANNEL_ID`); qualification always runs. ⚠️ `referral_qualifications` is permanent like `referrals` (trigger); `clearReferrals` clears both. ⚠️ A `referral_weeks` row IS the payment record: its insert is the idempotency guard, and deleting one pays that week again. ⚠️ Only the most recently ended week is ever closed: no backlog. ⚠️ `referrersWeek` ignores the scope picker. Spec `docs/superpowers/specs/2026-09-27-referral-leaderboard-design.md`, runbook `docs/deploy/2026-09-27-referral-leaderboard.md` |
```

In the leaderboards-in-Discord and crowns rows, change "ten" to "twelve" where it counts boards/messages/crowns, and add the two crown env var names.

- [ ] **Step 4: Final gate**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`
Expected: **32/32** tasks successful.

- [ ] **Step 5: Commit**

```bash
git add docs/deploy/2026-09-27-referral-leaderboard.md CHANGELOG.md CLAUDE.md
git commit -m "docs: referral leaderboards runbook, changelog and feature map"
```
