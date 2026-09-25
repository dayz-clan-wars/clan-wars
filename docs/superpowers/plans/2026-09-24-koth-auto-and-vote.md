# King of the Hill: automatic trigger and player vote — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** KotH events start on their own on the server's best nights, and any linked in-game player can call a public vote for one.

**Architecture:** Both new paths end in an ordinary `koth_events` row (`state 'scheduled'`, new `origin` column), so every existing opening/scoring/restore path is reused untouched. A new `koth-decide-tick.ts` applies an airdrop-style high-water rule; a new `/kothvote` command plus `koth-vote-tick.ts` run a frozen-electorate vote in `#server-events`. Both ticks run before `airdropTick`, which already yields a slot to a scheduled KotH.

**Tech Stack:** TypeScript, discord.js, drizzle-orm over postgres.js, vitest, pnpm + turbo.

**Spec:** `docs/superpowers/specs/2026-09-24-koth-auto-and-vote-design.md`

## Global Constraints

- Work only in the worktree `/Users/steveharmeyer/Development/dayz-clan-wars/clan-wars/.claude/worktrees/koth-auto-vote`, branch `feature/koth-auto-vote`. Never `cd` to the main checkout — another session owns it.
- ⚠️ Never run a DB-backed test while the other session may be running one: `factions_test_<package>` is shared across worktrees. Before every test run, ask yourself whether you know the other session is idle; if unsure, ask the user.
- Test env: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"`. Never point anything at `factions_live`. Port 5434 only.
- Single package test: `TEST_DATABASE_URL=… pnpm --filter @factions/<pkg> exec vitest run <file>`.
- Full gate (final task only): `TEST_DATABASE_URL=… npx turbo run typecheck test --concurrency=1 --force` — expect **30/30 tasks**.
- Every command reply is ephemeral (`Reply.ephemeral: true`); the public vote message is a separate bot post.
- Every post of player-controlled text to a public channel uses `allowedMentions: { parse: [] }` and `escapeMarkdown` from `apps/bot/src/site-links.ts`.
- Rules constants live in `packages/domain/src/rules.ts` — never a literal elsewhere. Mirrored literals (SQL) get a drift test.
- Comments explain WHY; mark load-bearing lines `⚠️`. Match the density of the file you edit.
- Row first, post second for anything that creates an event; post first, stamp second for every other post.
- Lock order: `… achievement_counters → koth_votes → koth_vote_voters → koth_events → award_grants → …`.
- `packages/domain` and `packages/roster` use extensionless relative imports in `src/`; `apps/bot` uses `.js` suffixes.
- Commit after every task, message style `feat(bot): …` / `feat(domain): …` / `feat(db): …`, ending with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_013U6oQq72Pc53VHW9hGicHQ
  ```

## Review Focus

1. **A Yes/No press after `closes_at` but before the tick has closed the vote** — must be refused, not counted (Task 9 test "refuses a ballot at or after closes_at even while still open").
2. **The tick closing a vote late but before its slot** (bot hiccup, `closes_at + 5 min`) — must still pass and announce; only `now >= slot_at` voids (Task 10 test "passes when closed late but before the slot").
3. **A Monday 00:00 slot decided on Sunday 23:30** — counts against the NEW week's cap, because the cap is keyed on `slot_at` (Task 6 test "counts the cap by the slot's ISO week").
4. **A bot restart mid-vote** — must not re-edit an unchanged tally every boot; `tally_text` is persisted (Task 10 test "does not edit when the tally is unchanged").
5. **Two `/kothvote` calls racing** — the loser gets the friendly sentence, not the router's generic failure (Task 8 test "maps a unique violation to the matching refusal").

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/domain/src/rules.ts` (modify) | New constants |
| `packages/domain/src/koth.ts` (modify) | `kothGapOk`, `chooseKothTown`, `shouldFireKoth`, `turnoutFloor`, `voteOutcome`, `voteTargetSlot`, `voteClosesAt` |
| `packages/db/src/schema.ts` (modify) | `koth_events` columns; `koth_votes`, `koth_vote_voters` |
| `packages/db/migrations/0052_*.sql` (generated) | The migration |
| `packages/db/test/koth-vote-drift.test.ts` (create) | CHECK literal vs `KOTH_VOTE_TURNOUT_MIN` |
| `apps/bot/src/population.ts` (create) | `popsAt`, `historyInstants` — moved from `airdrop-tick.ts` |
| `apps/bot/src/config.ts` (modify) | `KOTH_AUTO_TICK`, `KOTH_WEEKLY_CAP`, `KOTH_AUTO_MIN_POP`, `KOTH_VOTE` |
| `apps/bot/src/koth-text.ts` (modify) | Vote message, tally, result texts |
| `apps/bot/src/koth-decide-tick.ts` (create) | The automatic decision |
| `apps/bot/src/koth-vote-channel.ts` (create) | `KothVoteChannel` type + button row builder |
| `apps/bot/src/koth-vote-store.ts` (create) | Shared DB reads: electorate, slot checks, last slot |
| `apps/bot/src/commands/kothvote.ts` (create) | `/kothvote` and the ballot handler |
| `apps/bot/src/commands/confirm.ts`, `route.ts`, `types.ts`, `index.ts` (modify) | `cw:v:` ids, routing, `Ctx.kothVote` |
| `apps/bot/src/koth-vote-tick.ts` (create) | Tally, close, post |
| `packages/roster/src/internal/koth-ballots.ts` (create), `removal-store.ts` (modify) | Guild removal drops voter rows |
| `apps/bot/src/discord.ts` (modify) | Channel adapter, ctx, tick wiring |
| `CLAUDE.md`, `apps/bot/README.md`, `CHANGELOG.md`, `docs/deploy/2026-09-24-koth-auto-and-vote.md` | Docs |

---

### Task 1: Domain rules and pure functions

**Files:**
- Modify: `packages/domain/src/rules.ts` (after the KotH block, ~line 416)
- Modify: `packages/domain/src/koth.ts`
- Test: `packages/domain/test/koth-auto.test.ts` (create)

**Interfaces:**
- Produces (all exported from `@factions/domain`):
  - constants `KOTH_MIN_GAP_MS`, `KOTH_HISTORY_MS`, `KOTH_NO_REPEAT`, `KOTH_VOTE_MIN_POP`, `KOTH_VOTE_TURNOUT_MIN`, `KOTH_VOTE_PASS_NUM`, `KOTH_VOTE_PASS_DEN`, `KOTH_VOTE_MIN_OPEN_MS`
  - `kothGapOk(slot: Date, lastSlotAt: Date | null): boolean`
  - `chooseKothTown(recent: string[], rng: () => number): KothLocation`
  - `type KothFireInput = { slot: Date; slotTaken: boolean; voteBlocks: boolean; openEvent: boolean; weekCount: number; weeklyCap: number; lastSlotAt: Date | null; pop: number; threshold: number; minPop: number }`
  - `shouldFireKoth(i: KothFireInput): boolean`
  - `turnoutFloor(electorate: number): number`
  - `type VoteResult = { outcome: "passed" | "failed"; reason: "passed" | "turnout" | "majority" }`
  - `voteOutcome(v: { cast: number; yes: number; floor: number }): VoteResult`
  - `voteTargetSlot(now: Date): Date`
  - `voteClosesAt(slot: Date): Date`

- [ ] **Step 1: Write the failing test** — `packages/domain/test/koth-auto.test.ts`

```ts
import { describe, it, expect } from "vitest";
import {
  chooseKothTown, kothGapOk, shouldFireKoth, turnoutFloor, voteOutcome, voteTargetSlot, voteClosesAt,
  KOTH_LOCATIONS, KOTH_NO_REPEAT, KOTH_MIN_GAP_MS, KOTH_VOTE_TURNOUT_MIN, type KothFireInput,
} from "../src/index.js";

const at = (iso: string) => new Date(iso);
const SLOT = at("2026-10-03T20:00:00Z");

describe("kothGapOk", () => {
  it("allows no previous event", () => expect(kothGapOk(SLOT, null)).toBe(true));
  it("allows exactly 24 h", () => expect(kothGapOk(SLOT, new Date(SLOT.getTime() - KOTH_MIN_GAP_MS))).toBe(true));
  it("refuses 22 h", () => expect(kothGapOk(SLOT, at("2026-10-02T22:00:00Z"))).toBe(false));
});

describe("chooseKothTown", () => {
  it("never draws one of the last KOTH_NO_REPEAT towns", () => {
    const recent = KOTH_LOCATIONS.slice(0, KOTH_NO_REPEAT).map((l) => l.slug);
    for (let i = 0; i < 50; i++) {
      expect(recent).not.toContain(chooseKothTown(recent, () => i / 50).slug);
    }
  });
  // ⚠️ An empty pool indexes undefined; the fallback is what keeps the tick alive.
  it("falls back to the whole list when every town is recent", () => {
    const all = KOTH_LOCATIONS.map((l) => l.slug);
    expect(KOTH_LOCATIONS).toContainEqual(chooseKothTown(all, () => 0));
  });
});

describe("shouldFireKoth", () => {
  const base: KothFireInput = {
    slot: SLOT, slotTaken: false, voteBlocks: false, openEvent: false, weekCount: 0, weeklyCap: 2,
    lastSlotAt: null, pop: 12, threshold: 11, minPop: 10,
  };
  it("fires at a new high", () => expect(shouldFireKoth(base)).toBe(true));
  it("fires on a tie with the high-water mark", () => expect(shouldFireKoth({ ...base, pop: 11 })).toBe(true));
  it("refuses below the high-water mark", () => expect(shouldFireKoth({ ...base, pop: 10 })).toBe(false));
  it("refuses below the floor even with no history", () => expect(shouldFireKoth({ ...base, pop: 9, threshold: 0 })).toBe(false));
  it("refuses a taken slot", () => expect(shouldFireKoth({ ...base, slotTaken: true })).toBe(false));
  it("refuses a slot a vote blocks", () => expect(shouldFireKoth({ ...base, voteBlocks: true })).toBe(false));
  it("refuses while an event is open", () => expect(shouldFireKoth({ ...base, openEvent: true })).toBe(false));
  it("refuses at the weekly cap", () => expect(shouldFireKoth({ ...base, weekCount: 2 })).toBe(false));
  it("refuses inside the gap", () => expect(shouldFireKoth({ ...base, lastSlotAt: at("2026-10-03T00:00:00Z") })).toBe(false));
});

describe("turnoutFloor", () => {
  it("never goes below the minimum", () => {
    expect(turnoutFloor(5)).toBe(KOTH_VOTE_TURNOUT_MIN);
    expect(turnoutFloor(10)).toBe(5);
  });
  it("is half the electorate, rounded up", () => expect(turnoutFloor(11)).toBe(6));
});

describe("voteOutcome", () => {
  it("passes at exactly two-thirds", () => expect(voteOutcome({ cast: 6, yes: 4, floor: 5 })).toEqual({ outcome: "passed", reason: "passed" }));
  it("fails one Yes short", () => expect(voteOutcome({ cast: 7, yes: 4, floor: 5 })).toEqual({ outcome: "failed", reason: "majority" }));
  it("fails one voter short of the floor, even unanimous", () => expect(voteOutcome({ cast: 4, yes: 4, floor: 5 })).toEqual({ outcome: "failed", reason: "turnout" }));
});

describe("voteTargetSlot", () => {
  // Closes at slot − 30 min; must be open at least 10 min.
  it("targets the next slot when its close is 10+ min away", () => {
    expect(voteTargetSlot(at("2026-10-03T19:20:00Z"))).toEqual(SLOT);
  });
  it("rolls to the slot after when under 10 min remain", () => {
    expect(voteTargetSlot(at("2026-10-03T19:21:00Z"))).toEqual(at("2026-10-03T22:00:00Z"));
  });
  it("closes 30 min before the slot", () => expect(voteClosesAt(SLOT)).toEqual(at("2026-10-03T19:30:00Z")));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @factions/domain exec vitest run test/koth-auto.test.ts`
Expected: FAIL — `chooseKothTown` (etc.) is not exported.

- [ ] **Step 3: Add the constants** — in `packages/domain/src/rules.ts`, after `KOTH_WHOLE_FILES`:

```ts
// ─── KotH automatic trigger and vote (spec 2026-09-24-koth-auto-and-vote) ───
/** Every KotH, whatever started it, is at least this long after the last one's slot (§2.2). */
export const KOTH_MIN_GAP_MS = 24 * 60 * 60 * 1000;
/**
 * The automatic trigger's high-water window (§3). Same length as the airdrop's,
 * and the same caveat: `KOTH_AUTO_MIN_POP` is the lever, not this.
 */
export const KOTH_HISTORY_MS = 5 * 24 * 60 * 60 * 1000;
/** How many recent towns the draw excludes (§2.4). */
export const KOTH_NO_REPEAT = 5;
/** Players online needed to open a vote (§6.1). */
export const KOTH_VOTE_MIN_POP = 10;
/**
 * The turnout floor's minimum, and so the smallest electorate a vote may open with.
 * ⚠️ Mirrored as a literal in `koth_votes_electorate_min`; koth-vote-drift.test.ts.
 */
export const KOTH_VOTE_TURNOUT_MIN = 5;
/** Two-thirds, as integers — `yes * DEN >= cast * NUM`, never a float 0.666…. */
export const KOTH_VOTE_PASS_NUM = 2;
export const KOTH_VOTE_PASS_DEN = 3;
/** The shortest a vote may be open before it closes (§4). */
export const KOTH_VOTE_MIN_OPEN_MS = 10 * 60_000;
```

- [ ] **Step 4: Add the functions** — in `packages/domain/src/koth.ts`, extend the rules import and append:

```ts
import {
  KOTH_MIN_GAP_MS, KOTH_NO_REPEAT, KOTH_PRESET_PREFIX, KOTH_REMINDER_LEAD_MS, KOTH_VOTE_MIN_OPEN_MS,
  KOTH_VOTE_PASS_DEN, KOTH_VOTE_PASS_NUM, KOTH_VOTE_TURNOUT_MIN, KOTH_ZONE_RADIUS_M, RESTART_PERIOD_MS,
} from "./rules";
import { nextRestartAt } from "./restarts";
```

```ts
/**
 * Spec §2.2: slot to slot, because for KotH the session is the event.
 * ⚠️ One statement for all three paths — /koth schedule, the automatic trigger and the vote.
 */
export function kothGapOk(slot: Date, lastSlotAt: Date | null): boolean {
  return lastSlotAt === null || slot.getTime() - lastSlotAt.getTime() >= KOTH_MIN_GAP_MS;
}

/**
 * Spec §2.4, `chooseAirdrop`'s shape.
 * ⚠️ The fallback is not padding: an empty pool indexes undefined and throws inside a tick.
 */
export function chooseKothTown(recent: string[], rng: () => number): KothLocation {
  const skip = new Set(recent.slice(0, KOTH_NO_REPEAT));
  const pool = KOTH_LOCATIONS.filter((l) => !skip.has(l.slug));
  const from = pool.length > 0 ? pool : KOTH_LOCATIONS;
  return from[Math.floor(rng() * from.length)]!;
}

export type KothFireInput = {
  slot: Date;
  /** A koth_events row holds the slot, or an announced/live airdrop does. */
  slotTaken: boolean;
  /** A vote for this slot is open or failed (§3.2). */
  voteBlocks: boolean;
  /** A KotH is `scheduled` or `live`. */
  openEvent: boolean;
  /** `origin = 'auto'` rows, not cancelled/failed, in the slot's ISO week. */
  weekCount: number;
  weeklyCap: number;
  lastSlotAt: Date | null;
  pop: number;
  /** ⚠️ Taken strictly before this decision instant — see airdrop-tick.ts. */
  threshold: number;
  minPop: number;
};

/** Spec §3. The refusals in the order that makes one cheapest to read. */
export function shouldFireKoth(i: KothFireInput): boolean {
  if (i.slotTaken || i.voteBlocks || i.openEvent) return false;
  if (i.weekCount >= i.weeklyCap) return false;
  if (!kothGapOk(i.slot, i.lastSlotAt)) return false;
  return i.pop >= Math.max(i.minPop, i.threshold);
}

/** Half the frozen electorate, rounded up, never under the minimum (§4). */
export function turnoutFloor(electorate: number): number {
  return Math.max(KOTH_VOTE_TURNOUT_MIN, Math.ceil(electorate / 2));
}

export type VoteResult = { outcome: "passed" | "failed"; reason: "passed" | "turnout" | "majority" };

/** Turnout first, so a result post can say which bar was missed. */
export function voteOutcome(v: { cast: number; yes: number; floor: number }): VoteResult {
  if (v.cast < v.floor) return { outcome: "failed", reason: "turnout" };
  if (v.yes * KOTH_VOTE_PASS_DEN < v.cast * KOTH_VOTE_PASS_NUM) return { outcome: "failed", reason: "majority" };
  return { outcome: "passed", reason: "passed" };
}

/** A vote closes when the reminder would go out: the announcement is the reminder. */
export function voteClosesAt(slot: Date): Date {
  return new Date(slot.getTime() - KOTH_REMINDER_LEAD_MS);
}

/** The first slot whose vote would be open at least `KOTH_VOTE_MIN_OPEN_MS`. */
export function voteTargetSlot(now: Date): Date {
  let slot = nextRestartAt(now);
  while (voteClosesAt(slot).getTime() - now.getTime() < KOTH_VOTE_MIN_OPEN_MS) {
    slot = new Date(slot.getTime() + RESTART_PERIOD_MS);
  }
  return slot;
}
```

If `restarts.ts` imports from `koth.ts` (circular), import `restartSlot`'s arithmetic inline instead: `new Date(Math.floor(now.getTime() / RESTART_PERIOD_MS) * RESTART_PERIOD_MS + RESTART_PERIOD_MS)`.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @factions/domain exec vitest run test/koth-auto.test.ts test/koth.test.ts`
Expected: PASS. Then `pnpm --filter @factions/domain typecheck`.

- [ ] **Step 6: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): KotH automatic-trigger and vote rules"
```

---

### Task 2: Schema and migration

**Files:**
- Modify: `packages/db/src/schema.ts` (`kothEvents` ~line 2031–2089; new tables after it)
- Generate: `packages/db/migrations/0052_<drizzle-name>.sql` + `meta/`
- Test: `packages/db/test/koth-vote-drift.test.ts` (create)

**Interfaces:**
- Produces: `kothEvents.origin`, `.popAtDecision`, `.threshold`; `scheduledByDiscordId` nullable; `type KothOrigin = "admin" | "auto" | "vote"`; tables `kothVotes`, `kothVoteVoters`; `type KothVoteState = "open" | "passed" | "failed" | "void"`.

- [ ] **Step 1: Write the failing drift test** — `packages/db/test/koth-vote-drift.test.ts`

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, type Database } from "@factions/db";
import { KOTH_VOTE_TURNOUT_MIN } from "@factions/domain";
import { sql } from "drizzle-orm";

const URL = requireTestDatabaseUrl();

/**
 * ⚠️ `KOTH_VOTE_TURNOUT_MIN` exists twice: in rules.ts and as the literal in
 * `koth_votes_electorate_min`. Drift means a vote opens that can never pass, or a
 * legal one is refused by the database with a constraint error the player never
 * sees explained.
 */
describe("koth_votes_electorate_min matches KOTH_VOTE_TURNOUT_MIN", () => {
  let db: Database;
  beforeEach(async () => { db = createClient(URL); await runMigrations(db); });

  it("states the same minimum", async () => {
    const rows = await db.execute<{ def: string }>(sql`
      select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'koth_votes_electorate_min'`);
    const def = [...rows][0]?.def ?? "";
    expect(def).toMatch(new RegExp(`>= ${KOTH_VOTE_TURNOUT_MIN}\\b`));
  });

  it("backfills origin on an old-shaped insert", async () => {
    await db.execute(sql`truncate table koth_events, servers restart identity cascade`);
    await db.execute(sql`insert into servers (name, map, clock_offset_ms, nitrado_service_id, active) values ('R','livonia',0,7,true)`);
    await db.execute(sql`insert into koth_events (server_id, slot_at, location, centre_x, centre_z, state, scheduled_by_discord_id)
      values (1, '2026-10-03T20:00:00Z', 'lembork', 1, 1, 'scheduled', '99')`);
    const [row] = [...await db.execute<{ origin: string }>(sql`select origin from koth_events`)];
    expect(row!.origin).toBe("admin");
  });

  it("refuses an auto row with a scheduler, and an admin row without one", async () => {
    await db.execute(sql`truncate table koth_events, servers restart identity cascade`);
    await db.execute(sql`insert into servers (name, map, clock_offset_ms, nitrado_service_id, active) values ('R','livonia',0,7,true)`);
    await expect(db.execute(sql`insert into koth_events (server_id, slot_at, location, centre_x, centre_z, state, origin, scheduled_by_discord_id)
      values (1, '2026-10-03T20:00:00Z', 'lembork', 1, 1, 'scheduled', 'auto', '99')`)).rejects.toThrow(/koth_events_origin_scheduler/);
    await expect(db.execute(sql`insert into koth_events (server_id, slot_at, location, centre_x, centre_z, state, origin)
      values (1, '2026-10-03T20:00:00Z', 'lembork', 1, 1, 'scheduled', 'admin')`)).rejects.toThrow(/koth_events_origin_scheduler/);
  });
});
```

Check `packages/db/package.json` has `@factions/domain` as a devDependency (`holding-index-drift.test.ts` already imports it); if not, add `"@factions/domain": "workspace:*"` to `devDependencies` and run `pnpm install`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @factions/db exec vitest run test/koth-vote-drift.test.ts`
Expected: FAIL — no constraint `koth_votes_electorate_min`; column `origin` missing.

- [ ] **Step 3: Edit the schema** — in `kothEvents`:

```ts
export type KothOrigin = "admin" | "auto" | "vote";
```
(beside `KothState`), then in the table:

```ts
  /**
   * Who or what started it (spec 2026-09-24 §2.1). Nothing downstream of the row
   * reads it except the weekly cap, which counts `auto` alone.
   * ⚠️ The default is for the pre-0052 bot's inserts during a deploy, not a
   * convenience: every current writer states it.
   */
  origin: text("origin").$type<KothOrigin>().notNull().default("admin"),
  /** Null on `admin`/`vote` rows. On `auto`, what the trigger saw — so a surprise event can be explained. */
  popAtDecision: integer("pop_at_decision"),
  threshold: numeric("threshold"),
```
change `scheduledByDiscordId: text("scheduled_by_discord_id").notNull(),` to `scheduledByDiscordId: text("scheduled_by_discord_id"),` with comment `/** The admin, or a vote's starter. Null exactly on \`auto\` rows (CHECK below). */`, and add to the constraints object:

```ts
  originValid: check("koth_events_origin_valid", sql`${t.origin} IN ('admin','auto','vote')`),
  originScheduler: check("koth_events_origin_scheduler", sql`(${t.origin} = 'auto') = (${t.scheduledByDiscordId} IS NULL)`),
```

After `kothEvents`, add:

```ts
export type KothVoteState = "open" | "passed" | "failed" | "void";

/**
 * A player-called King of the Hill vote (spec 2026-09-24 §5.2, §6).
 * ⚠️ `koth_votes_slot_uq` is UNCONDITIONAL: one vote per slot, ever. A failed or
 * void vote is not re-run for the same session, and the automatic trigger reads a
 * failed one as the players' answer (§3.2).
 */
export const kothVotes = pgTable("koth_votes", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  slotAt: timestamp("slot_at", { withTimezone: true }).notNull(),
  location: text("location").notNull(),
  startedByDiscordId: text("started_by_discord_id").notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
  closesAt: timestamp("closes_at", { withTimezone: true }).notNull(),
  electorateSize: integer("electorate_size").notNull(),
  turnoutFloor: integer("turnout_floor").notNull(),
  channelId: text("channel_id"),
  messageId: text("message_id"),
  /** The last content written to the message, so the tick edits only on a change. */
  tallyText: text("tally_text"),
  state: text("state").$type<KothVoteState>().notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  resultPostedAt: timestamp("result_posted_at", { withTimezone: true }),
  kothEventId: bigint("koth_event_id", { mode: "number" }).references(() => kothEvents.id, { onDelete: "set null" }),
  detail: jsonb("detail").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
}, (t) => ({
  stateValid: check("koth_votes_state_valid", sql`${t.state} IN ('open','passed','failed','void')`),
  closedIffNotOpen: check("koth_votes_closed_iff_not_open", sql`(${t.state} = 'open') = (${t.closedAt} IS NULL)`),
  passedHasEvent: check("koth_votes_passed_has_event", sql`${t.state} <> 'passed' OR ${t.kothEventId} IS NOT NULL`),
  // ⚠️ A literal copy of KOTH_VOTE_TURNOUT_MIN — koth-vote-drift.test.ts.
  electorateMin: check("koth_votes_electorate_min", sql`${t.electorateSize} >= 5`),
  oneOpen: uniqueIndex("koth_votes_one_open").on(t.serverId).where(sql`${t.state} = 'open'`),
  oneSlot: uniqueIndex("koth_votes_slot_uq").on(t.serverId, t.slotAt),
}));

/** The frozen electorate and the ballots: having a row is being eligible (§5.3). */
export const kothVoteVoters = pgTable("koth_vote_voters", {
  voteId: bigint("vote_id", { mode: "number" }).notNull().references(() => kothVotes.id, { onDelete: "cascade" }),
  discordId: text("discord_id").notNull(),
  dayzId: text("dayz_id").notNull(),
  ballot: boolean("ballot"),
  castAt: timestamp("cast_at", { withTimezone: true }),
}, (t) => ({
  pk: primaryKey({ columns: [t.voteId, t.discordId] }),
  castIffBallot: check("koth_vote_voters_cast_iff_ballot", sql`(${t.ballot} IS NULL) = (${t.castAt} IS NULL)`),
}));
```

Add `boolean` and `primaryKey` to the `drizzle-orm/pg-core` import if not already there.

- [ ] **Step 4: Generate and read the migration**

Run: `cd packages/db && npx drizzle-kit generate && cd ../..`
Then read the new `packages/db/migrations/0052_*.sql`. It must contain: `ADD COLUMN "origin" text DEFAULT 'admin' NOT NULL`, `ALTER COLUMN "scheduled_by_discord_id" DROP NOT NULL`, both new `CREATE TABLE`s, the two CHECKs on `koth_events`, both unique indexes, and the FKs. Nothing may DROP or RENAME anything. If drizzle-kit prompts about renames, answer "create column" / "create table".

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @factions/db exec vitest run test/koth-vote-drift.test.ts` then `pnpm --filter @factions/db typecheck`
Expected: PASS.

- [ ] **Step 6: Make every existing insert state its origin**

In `apps/bot/src/commands/koth.ts`, the `insert(kothEvents).values({...})` gains `origin: "admin",`. Run `pnpm --filter @factions/bot typecheck` — any other `kothEvents` insert in tests compiles unchanged (default applies).

- [ ] **Step 7: Commit**

```bash
git add packages/db apps/bot/src/commands/koth.ts
git commit -m "feat(db): koth_events.origin and the KotH vote tables"
```

---

### Task 3: Shared population reads; airdrop skip log

**Files:**
- Create: `apps/bot/src/population.ts`
- Modify: `apps/bot/src/airdrop-tick.ts`
- Test: `apps/bot/test/airdrop-tick.test.ts` (existing, must stay green) + one new case

**Interfaces:**
- Produces:
  - `popsAt(db: Database, serverId: number, instants: Date[]): Promise<number[]>`
  - `historyInstants(decisionInstant: Date, windowMs: number): Date[]` — every `RESTART_PERIOD_MS` step from `decisionInstant − windowMs`, strictly before `decisionInstant`
  - `onlineNow(db: Database, serverId: number, now: Date): Promise<number>` — `(await popsAt(db, serverId, [now]))[0] ?? 0`

- [ ] **Step 1: Write the failing test** — append to `apps/bot/test/airdrop-tick.test.ts` inside the `describe`:

```ts
  it("logs that it skipped a slot King of the Hill took", async () => {
    await online(9, "2026-09-21T18:00:00Z", null);
    await db.insert(kothEvents).values({
      serverId, slotAt: at("2026-09-21T20:00:00Z"), location: "lembork", centreX: "1", centreZ: "1",
      state: "scheduled", origin: "auto", announcedAt: NOW,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await run(vi.fn(async () => {}));
    expect(r.decided).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("airdrop: skipped 2026-09-21T20:00:00.000Z: koth"));
    log.mockRestore();
  });
```

Also create `apps/bot/test/population.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { RESTART_PERIOD_MS } from "@factions/domain";
import { historyInstants } from "../src/population.js";

describe("historyInstants", () => {
  // ⚠️ Strictly before: a window containing the current sample fires on every new record.
  it("stops strictly before the decision instant", () => {
    const d = new Date("2026-09-21T19:30:00Z");
    const xs = historyInstants(d, 3 * RESTART_PERIOD_MS);
    expect(xs.map((x) => x.toISOString())).toEqual([
      "2026-09-21T13:30:00.000Z", "2026-09-21T15:30:00.000Z", "2026-09-21T17:30:00.000Z",
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @factions/bot exec vitest run test/airdrop-tick.test.ts test/population.test.ts`
Expected: FAIL — module `population.js` missing; no skip log.

- [ ] **Step 3: Create `apps/bot/src/population.ts`** — move `popsAt` verbatim (with its doc comment) out of `airdrop-tick.ts`, export it, and add:

```ts
import { RESTART_PERIOD_MS } from "@factions/domain";

/**
 * The trailing history on the slot grid.
 * ⚠️ STRICTLY before `decisionInstant`. With a max rather than a percentile, a
 * window containing the current sample makes `pop >= max` true of every pop that
 * is its own maximum, and the rule fires on any new record, including a record of 1.
 * Shared by the airdrop and KotH triggers so both read one definition.
 */
export function historyInstants(decisionInstant: Date, windowMs: number): Date[] {
  const out: Date[] = [];
  for (let t = decisionInstant.getTime() - windowMs; t < decisionInstant.getTime(); t += RESTART_PERIOD_MS) out.push(new Date(t));
  return out;
}

export async function onlineNow(db: Database, serverId: number, now: Date): Promise<number> {
  return (await popsAt(db, serverId, [now]))[0] ?? 0;
}
```

- [ ] **Step 4: Rewire `airdrop-tick.ts`** — import `{ historyInstants, popsAt }` from `./population.js`; replace the inline `instants` loop with `const instants = historyInstants(decisionInstantFor(slot), AIRDROP_HISTORY_MS);` (keep the ⚠️ comment's substance as a one-line pointer: `// ⚠️ Strictly before this instant — see historyInstants.`); in the KotH-skip branch replace `if (koth) continue;` with:

```ts
      if (koth) {
        console.log(`airdrop: skipped ${slot.toISOString()}: koth`);
        continue;
      }
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @factions/bot exec vitest run test/airdrop-tick.test.ts test/population.test.ts` then `pnpm --filter @factions/bot typecheck`
Expected: PASS, every pre-existing airdrop case included.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/population.ts apps/bot/src/airdrop-tick.ts apps/bot/test/airdrop-tick.test.ts apps/bot/test/population.test.ts
git commit -m "refactor(bot): share the population reads; log an airdrop yielding to KotH"
```

---

### Task 4: Config

**Files:**
- Modify: `apps/bot/src/config.ts` (type ~line 170, parse ~line 488, refusals ~line 586)
- Test: `apps/bot/test/config.test.ts` (the `KOTH_TICK` describe, ~line 384)

**Interfaces:**
- Produces: `config.koth: { enabled: boolean; auto: { enabled: boolean; weeklyCap: number; minPop: number }; vote: { enabled: boolean } }`

- [ ] **Step 1: Write the failing tests** — in `config.test.ts`, change the "enables when both requirements are met" expectation to:

```ts
      expect(cfg.koth).toEqual({ enabled: true, auto: { enabled: false, weeklyCap: 2, minPop: 10 }, vote: { enabled: false } });
```

and add inside `describe("KOTH_TICK", …)`:

```ts
    const KOTH_ON = { ...OK, KOTH_TICK: "true", RESTART_SCHEDULE: "true", NITRADO_TOKEN: "t", SERVER_EVENTS_CHANNEL_ID: "123456789012345678" };

    it("KOTH_AUTO_TICK needs KOTH_TICK", () => {
      expect(() => loadConfig({ ...OK, KOTH_AUTO_TICK: "true" })).toThrow(/KOTH_AUTO_TICK is on but KOTH_TICK is off/u);
    });
    it("KOTH_VOTE needs KOTH_TICK", () => {
      expect(() => loadConfig({ ...OK, KOTH_VOTE: "true" })).toThrow(/KOTH_VOTE is on but KOTH_TICK is off/u);
    });
    it("reads the automatic trigger's cap and floor", () => {
      const cfg = loadConfig({ ...KOTH_ON, KOTH_AUTO_TICK: "true", KOTH_WEEKLY_CAP: "3", KOTH_AUTO_MIN_POP: "12", KOTH_VOTE: "1" });
      expect(cfg.koth).toEqual({ enabled: true, auto: { enabled: true, weeklyCap: 3, minPop: 12 }, vote: { enabled: true } });
    });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @factions/bot exec vitest run test/config.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** — type:

```ts
  /**
   * `KOTH_TICK` gates opening anything; `auto` and `vote` are the two ways a row
   * comes about without an admin (spec 2026-09-24). Both refuse to load without
   * `KOTH_TICK`: a row they create would be decided and never opened.
   */
  koth: { enabled: boolean; auto: { enabled: boolean; weeklyCap: number; minPop: number }; vote: { enabled: boolean } };
```

parse (reuse the existing flag idiom and `positiveInt`):

```ts
    koth: {
      enabled: flag(env.KOTH_TICK),
      auto: {
        enabled: flag(env.KOTH_AUTO_TICK),
        weeklyCap: positiveInt(env, "KOTH_WEEKLY_CAP", 2),
        minPop: positiveInt(env, "KOTH_AUTO_MIN_POP", 10),
      },
      vote: { enabled: flag(env.KOTH_VOTE) },
    },
```

where `flag` is a local `const flag = (v: string | undefined) => ["1", "true"].includes((v ?? "").trim().toLowerCase());` defined once near the top of the parse (if the file already has such a helper, use it). Refusals, after the existing `KOTH_TICK` ones:

```ts
  if (config.koth.auto.enabled && !config.koth.enabled) {
    throw new Error("KOTH_AUTO_TICK is on but KOTH_TICK is off — an automatic event would be decided and announced, and never opened.");
  }
  if (config.koth.vote.enabled && !config.koth.enabled) {
    throw new Error("KOTH_VOTE is on but KOTH_TICK is off — a passed vote would announce an event nothing ever opens.");
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @factions/bot exec vitest run test/config.test.ts` then `pnpm --filter @factions/bot typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/config.ts apps/bot/test/config.test.ts
git commit -m "feat(bot): KOTH_AUTO_TICK, KOTH_WEEKLY_CAP, KOTH_AUTO_MIN_POP and KOTH_VOTE"
```

---

### Task 5: Vote and result texts

**Files:**
- Modify: `apps/bot/src/koth-text.ts`
- Test: `apps/bot/test/koth-text.test.ts`

**Interfaces:**
- Consumes: `turnoutFloor`, `VoteResult` (Task 1)
- Produces:
  - `type VoteView = { town: string; slotAt: Date; closesAt: Date; floor: number; starter: string }`
  - `type Tally = { yes: number; no: number }`
  - `voteMessage(v: VoteView, t: Tally, closed?: string): string` — `closed` replaces the "can vote until" line with a closing sentence
  - `votePassedText(town: string, slotAt: Date, t: Tally): string`
  - `voteFailedText(town: string, t: Tally, floor: number, reason: "turnout" | "majority"): string`
  - `voteVoidText(town: string, why: string): string`
  - `hhmm(d: Date): string` — `"16:00 UTC"`

- [ ] **Step 1: Write the failing test** — append to `koth-text.test.ts`:

```ts
import { voteMessage, votePassedText, voteFailedText, voteVoidText, hhmm } from "../src/koth-text.js";

describe("vote texts", () => {
  const v = { town: "Borek", slotAt: new Date("2026-10-03T16:00:00Z"), closesAt: new Date("2026-10-03T15:30:00Z"), floor: 5, starter: "Mina_*" };
  it("names the slot, the close, the floor and the tally", () => {
    const m = voteMessage(v, { yes: 1, no: 0 });
    expect(m).toContain("**16:00 UTC**");
    expect(m).toContain("**Borek**");
    expect(m).toContain("until **15:30 UTC**");
    expect(m).toContain("needs **5** votes");
    expect(m).toContain("Yes 1 · No 0 · 1 of 5 votes cast");
  });
  // ⚠️ A gamertag is player-controlled.
  it("escapes the starter's gamertag", () => expect(voteMessage(v, { yes: 1, no: 0 })).toContain("Mina\\_\\*"));
  it("swaps the deadline for the closing line once closed", () => {
    const m = voteMessage(v, { yes: 4, no: 1 }, "Voting has closed: passed.");
    expect(m).not.toContain("until");
    expect(m).toContain("Voting has closed: passed.");
  });
  it("says which bar a failed vote missed", () => {
    expect(voteFailedText("Borek", { yes: 3, no: 0 }, 5, "turnout")).toMatch(/3 of the 5 votes/);
    expect(voteFailedText("Borek", { yes: 4, no: 3 }, 5, "majority")).toMatch(/two-thirds/);
  });
  it("announces a passed vote as the event, with no prize", () => {
    const t = votePassedText("Borek", v.slotAt, { yes: 5, no: 1 });
    expect(t).toContain("KING OF THE HILL: BOREK");
    expect(t).toContain("No prize this time");
    expect(t).toContain("Yes 5 · No 1");
  });
  it("renders a void reason", () => expect(voteVoidText("Borek", "voting was switched off")).toContain("voting was switched off"));
  it("formats UTC hours", () => expect(hhmm(new Date("2026-10-03T06:00:00Z"))).toBe("06:00 UTC"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @factions/bot exec vitest run test/koth-text.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement** — append to `koth-text.ts`:

```ts
export const hhmm = (d: Date) => `${d.toISOString().slice(11, 16)} UTC`;

export type VoteView = { town: string; slotAt: Date; closesAt: Date; floor: number; starter: string };
export type Tally = { yes: number; no: number };
const tallyLine = (t: Tally, floor: number) => `Yes ${t.yes} · No ${t.no} · ${t.yes + t.no} of ${floor} votes cast`;

/**
 * The public vote message (spec §6.2). Re-rendered every tick by koth-vote-tick.ts
 * and written only when it differs from `tally_text`.
 * ⚠️ `closed` replaces the deadline line — a closed vote that still says "can vote
 * until" invites presses that will all be refused.
 */
export function voteMessage(v: VoteView, t: Tally, closed?: string): string {
  const who = closed ?? `Linked players who were in game when this opened can vote until **${hhmm(v.closesAt)}**.`;
  return [
    `**King of the Hill vote.** ${esc(v.starter)} wants the **${hhmm(v.slotAt)}** restart to be King of the Hill at **${v.town}**.`,
    `${who} It needs **${v.floor}** votes and two-thirds Yes. No prize, just the hill.`,
    "",
    tallyLine(t, v.floor),
  ].join("\n");
}

/** A passed vote's post IS the event's announcement (and its reminder: it closes at T−30). */
export function votePassedText(town: string, slotAt: Date, t: Tally): string {
  return [`The vote passed (Yes ${t.yes} · No ${t.no}).`, scheduledText(town, slotAt, null)].join("\n");
}

export function voteFailedText(town: string, t: Tally, floor: number, reason: "turnout" | "majority"): string {
  const why = reason === "turnout"
    ? `only ${t.yes + t.no} of the ${floor} votes it needed were cast`
    : `Yes ${t.yes} · No ${t.no} is short of two-thirds`;
  return `The King of the Hill vote for ${town} failed: ${why}.`;
}

export function voteVoidText(town: string, why: string): string {
  return `The King of the Hill vote for ${town} did not go ahead: ${why}.`;
}
```

(The spec's example read "@starter wants King of the Hill…"; the starter is named by gamertag, not a mention, because mentions are off on this poster.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @factions/bot exec vitest run test/koth-text.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/koth-text.ts apps/bot/test/koth-text.test.ts
git commit -m "feat(bot): KotH vote and result texts"
```

---

### Task 6: Shared KotH reads and the automatic decision tick

**Files:**
- Create: `apps/bot/src/koth-vote-store.ts`
- Create: `apps/bot/src/koth-decide-tick.ts`
- Test: `apps/bot/test/koth-decide-tick.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 (`shouldFireKoth`, `chooseKothTown`, `kothGapOk`, `KOTH_HISTORY_MS`), Task 2 (schema), Task 3 (`popsAt`, `historyInstants`, `onlineNow`), Task 5 (`scheduledText`)
- Produces (in `koth-vote-store.ts`, used by Tasks 8 and 10 too):
  - `SLOT_HOLDING_STATES: readonly KothState[]` = `["scheduled","live","awarded","no_winner","finished"]`
  - `slotTakenBy(db: Database | Tx, serverId: number, slot: Date): Promise<"koth" | "airdrop" | null>`
  - `kothOpen(db: Database | Tx, serverId: number): Promise<boolean>`
  - `lastKothSlot(db: Database | Tx, serverId: number, before: Date): Promise<Date | null>`
  - `recentTowns(db: Database, serverId: number): Promise<string[]>`
  - `linkedOnline(db: Database, serverId: number): Promise<{ discordId: string; dayzId: string; gamertag: string }[]>`
- Produces (in `koth-decide-tick.ts`):
  - `kothDecideTick(db: Database, post: (c: string) => Promise<void>, opts: { now: Date; weeklyCap: number; minPop: number; rng?: () => number }): Promise<{ decided: number; posted: number }>`

`Tx` here is `Parameters<Parameters<Database["transaction"]>[0]>[0]`; export it from `koth-vote-store.ts` as `type Tx`.

- [ ] **Step 1: Write the failing test** — `apps/bot/test/koth-decide-tick.test.ts`

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl, admFiles, airdropEvents, events, kothEvents, kothVotes,
  playerSessions, servers, type Database,
} from "@factions/db";
import { sql } from "drizzle-orm";
import { kothDecideTick } from "../src/koth-decide-tick.js";
import { kothTick } from "../src/koth-tick.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const SLOT = at("2026-10-03T20:00:00Z");
const NOW = at("2026-10-03T19:30:00Z");

describe("kothDecideTick", () => {
  let db: Database; let serverId = 0; let line = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table koth_votes, koth_events, airdrop_events, player_sessions, events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "R", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 7, active: true }).returning();
    serverId = s!.id; line = 0;
    await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: at("2026-09-01T00:00:00Z"), linesIngested: 0, complete: true });
  });

  /** Same helper as airdrop-tick.test.ts: n sessions from `from` to `to`. */
  async function online(n: number, from: string, to: string | null) {
    const [file] = await db.select({ id: admFiles.id }).from(admFiles);
    for (let i = 0; i < n; i++) {
      const [e] = await db.insert(events).values({ serverId, admFileId: file!.id, lineIndex: line++, type: "player.connected" as never, occurredAt: at(from), payload: {} }).returning({ id: events.id });
      await db.insert(playerSessions).values({ serverId, dayzId: `p${from}-${i}`, connectedAt: at(from), connectEventId: e!.id, disconnectedAt: to ? at(to) : null, closeReason: to ? "disconnect" : null });
    }
  }
  const rows = () => db.select().from(kothEvents);
  const run = (post: (c: string) => Promise<void> = vi.fn(async () => {}), over = {}) =>
    kothDecideTick(db, post, { now: NOW, weeklyCap: 2, minPop: 10, rng: () => 0, ...over });
  const koth = (over: Partial<typeof kothEvents.$inferInsert>) => db.insert(kothEvents).values({
    serverId, slotAt: SLOT, location: "lembork", centreX: "1", centreZ: "1", state: "scheduled", origin: "admin", scheduledByDiscordId: "99", ...over,
  });

  it("decides, posts, and stamps announced_at and reminded_at together", async () => {
    await online(11, "2026-10-03T18:00:00Z", null);
    const post = vi.fn(async (_c: string) => {});
    expect(await run(post)).toEqual({ decided: 1, posted: 1 });
    const [row] = await rows();
    expect(row).toMatchObject({ slotAt: SLOT, origin: "auto", state: "scheduled", scheduledByDiscordId: null, awardKey: null, popAtDecision: 11 });
    expect(row!.announcedAt).toEqual(NOW);
    expect(row!.remindedAt).toEqual(NOW);
    expect(post.mock.calls[0]![0]).toContain("No prize this time");
  });

  // ⚠️ The decision is AT the reminder instant; koth-tick must not post a second message.
  it("is never followed by a reminder post", async () => {
    await online(11, "2026-10-03T18:00:00Z", null);
    await run();
    const announce = vi.fn(async () => {});
    await kothTick(db, { announce, ops: vi.fn(async () => {}) }, { now: at("2026-10-03T19:31:00Z"), siteBaseUrl: "https://x" });
    expect(announce).not.toHaveBeenCalled();
  });

  it("does nothing before the decision instant", async () => {
    await online(11, "2026-10-03T18:00:00Z", null);
    expect((await run(undefined, { now: at("2026-10-03T19:29:00Z") })).decided).toBe(0);
  });

  it("does not fire below the floor", async () => {
    await online(9, "2026-10-03T18:00:00Z", null);
    expect((await run()).decided).toBe(0);
  });

  it("does not fire below the high-water mark", async () => {
    await online(15, "2026-10-01T19:00:00Z", "2026-10-01T20:00:00Z");
    await online(11, "2026-10-03T18:00:00Z", null);
    expect((await run()).decided).toBe(0);
  });

  it("skips a slot with an open vote, and one with a failed vote", async () => {
    await online(11, "2026-10-03T18:00:00Z", null);
    const vote = { serverId, slotAt: SLOT, location: "borek", startedByDiscordId: "d1", openedAt: at("2026-10-03T19:00:00Z"), closesAt: NOW, electorateSize: 5, turnoutFloor: 5 };
    await db.insert(kothVotes).values({ ...vote, state: "open" });
    expect((await run()).decided).toBe(0);
    await db.execute(sql`update koth_votes set state = 'failed', closed_at = ${NOW.toISOString()}::timestamptz`);
    expect((await run()).decided).toBe(0);
  });

  it("yields to a hand-placed airdrop for the slot", async () => {
    await online(11, "2026-10-03T18:00:00Z", null);
    await db.insert(airdropEvents).values({ serverId, slotAt: SLOT, location: "brena", colour: "blue", decidedAt: at("2026-10-03T12:00:00Z"), popAtDecision: 0, threshold: "0", state: "announced", manual: true, announcedAt: at("2026-10-03T12:00:00Z") });
    expect((await run()).decided).toBe(0);
  });

  it("holds the 24 h gap against an admin event, and not the cap", async () => {
    await online(11, "2026-10-03T18:00:00Z", null);
    await koth({ slotAt: at("2026-10-03T00:00:00Z"), state: "no_winner" });
    expect((await run()).decided).toBe(0);
  });

  it("counts only automatic events against the cap", async () => {
    await online(11, "2026-10-03T18:00:00Z", null);
    await koth({ slotAt: at("2026-09-28T20:00:00Z"), state: "no_winner", origin: "auto", scheduledByDiscordId: null });
    await koth({ slotAt: at("2026-09-30T20:00:00Z"), state: "no_winner", origin: "vote" });
    expect((await run()).decided).toBe(1);
    await db.execute(sql`truncate table koth_events restart identity cascade`);
    await koth({ slotAt: at("2026-09-28T20:00:00Z"), state: "no_winner", origin: "auto", scheduledByDiscordId: null });
    await koth({ slotAt: at("2026-09-30T20:00:00Z"), state: "no_winner", origin: "auto", scheduledByDiscordId: null });
    expect((await run()).decided).toBe(0);
  });

  // Review focus 3: the cap is keyed on the SLOT's week.
  it("counts the cap by the slot's ISO week", async () => {
    const sunNow = at("2026-10-04T23:30:00Z"); // decides the Monday 00:00 slot
    await online(11, "2026-10-04T22:00:00Z", null);
    await koth({ slotAt: at("2026-09-29T20:00:00Z"), state: "no_winner", origin: "auto", scheduledByDiscordId: null });
    await koth({ slotAt: at("2026-10-01T20:00:00Z"), state: "no_winner", origin: "auto", scheduledByDiscordId: null });
    expect((await run(undefined, { now: sunNow })).decided).toBe(1);
  });

  it("retries a failed announcement, and never posts an unannounced row late", async () => {
    await online(11, "2026-10-03T18:00:00Z", null);
    expect(await run(vi.fn(async () => { throw new Error("gone"); }))).toEqual({ decided: 1, posted: 0 });
    const post = vi.fn(async () => {});
    expect(await run(post, { now: at("2026-10-03T19:31:00Z") })).toEqual({ decided: 0, posted: 1 });
    expect((await rows())[0]!.announcedAt).not.toBeNull();
  });

  it("leaves a never-announced row for koth-tick to fail, with no cancellation", async () => {
    await online(11, "2026-10-03T18:00:00Z", null);
    await run(vi.fn(async () => { throw new Error("gone"); }));
    const announce = vi.fn(async () => {});
    await kothTick(db, { announce, ops: vi.fn(async () => {}) }, { now: at("2026-10-03T22:20:00Z"), siteBaseUrl: "https://x" });
    expect((await rows())[0]!.state).toBe("failed");
    expect(announce).not.toHaveBeenCalled();
  });
});
```

The retry test's post-at-19:31 must not re-decide: the slot already has a row. The last test runs `koth-tick` at 22:20 on purpose: with no `server_restarts` row, its missed-opening step fails a row only once its slot is strictly before the CURRENT slot's start (`lt(slotAt, slot.start)`), so at 20:20 the 20:00 row is not yet "missed".

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @factions/bot exec vitest run test/koth-decide-tick.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `apps/bot/src/koth-vote-store.ts`**

```ts
import { airdropEvents, identityLinks, kothEvents, playerSessions, type Database, type KothState } from "@factions/db";
import { and, desc, eq, inArray, isNull, lt, max } from "drizzle-orm";

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Q = Database | Tx;

/**
 * The states that hold a slot — `koth_events_slot_uq`'s predicate.
 * ⚠️ Two statements of one fact with that index; a `cancelled`/`failed` row frees
 * its slot (migration 0050), so it must not count here either.
 */
export const SLOT_HOLDING_STATES: readonly KothState[] = ["scheduled", "live", "awarded", "no_winner", "finished"];

/** What holds `slot`, if anything (spec §2.5: an announced/live airdrop, or any KotH). */
export async function slotTakenBy(db: Q, serverId: number, slot: Date): Promise<"koth" | "airdrop" | null> {
  const [k] = await db.select({ id: kothEvents.id }).from(kothEvents).where(and(
    eq(kothEvents.serverId, serverId), eq(kothEvents.slotAt, slot), inArray(kothEvents.state, [...SLOT_HOLDING_STATES]),
  )).limit(1);
  if (k) return "koth";
  const [a] = await db.select({ slotAt: airdropEvents.slotAt }).from(airdropEvents).where(and(
    eq(airdropEvents.serverId, serverId), eq(airdropEvents.slotAt, slot), inArray(airdropEvents.state, ["announced", "live"]),
  )).limit(1);
  return a ? "airdrop" : null;
}

export async function kothOpen(db: Q, serverId: number): Promise<boolean> {
  const [r] = await db.select({ id: kothEvents.id }).from(kothEvents)
    .where(and(eq(kothEvents.serverId, serverId), inArray(kothEvents.state, ["scheduled", "live"]))).limit(1);
  return r !== undefined;
}

/** The last KotH that ran or will run, any origin (§2.2's gap). */
export async function lastKothSlot(db: Q, serverId: number, before: Date): Promise<Date | null> {
  const [r] = await db.select({ at: max(kothEvents.slotAt) }).from(kothEvents).where(and(
    eq(kothEvents.serverId, serverId), lt(kothEvents.slotAt, before), inArray(kothEvents.state, [...SLOT_HOLDING_STATES]),
  ));
  return r?.at ?? null;
}

export async function recentTowns(db: Database, serverId: number): Promise<string[]> {
  const rs = await db.select({ location: kothEvents.location }).from(kothEvents)
    .where(eq(kothEvents.serverId, serverId)).orderBy(desc(kothEvents.createdAt)).limit(10);
  return rs.map((r) => r.location);
}

/**
 * Every linked player with an open session on the server — the electorate (§6.1).
 * ⚠️ `selectDistinct`: a player can hold two open session rows after a crash the
 * sessions tick has not closed yet, and a duplicate would count them twice.
 */
export async function linkedOnline(db: Database, serverId: number) {
  return db.selectDistinct({ discordId: identityLinks.discordId, dayzId: identityLinks.dayzId, gamertag: identityLinks.gamertag })
    .from(identityLinks).innerJoin(playerSessions, eq(playerSessions.dayzId, identityLinks.dayzId))
    .where(and(eq(playerSessions.serverId, serverId), isNull(playerSessions.disconnectedAt)));
}
```

If drizzle's `max()` over a timestamp returns a string in this version, wrap: `r?.at ? new Date(r.at) : null`. The test's gap case catches a mismatch.

- [ ] **Step 4: Create `apps/bot/src/koth-decide-tick.ts`**

```ts
import { kothEvents, kothVotes, servers, type Database } from "@factions/db";
import {
  KOTH_HISTORY_MS, chooseKothTown, decisionInstantFor, highWater, isoWeekStart, nextRestartAt, shouldFireKoth,
} from "@factions/domain";
import { and, eq, gt, gte, inArray, isNull, lt, notInArray } from "drizzle-orm";
import { scheduledText } from "./koth-text.js";
import { historyInstants, onlineNow, popsAt } from "./population.js";
import { kothOpen, lastKothSlot, recentTowns, slotTakenBy } from "./koth-vote-store.js";
import { kothLocation } from "@factions/domain";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The automatic KotH decision (spec 2026-09-24 §3).
 *
 * ⚠️ Runs BEFORE airdropTick in discord.ts (tick-order.test.ts): on a record night
 * both want the slot, and airdropTick yields to a scheduled KotH row — but only
 * if the row already exists when it looks.
 *
 * ⚠️ Row FIRST, post second — airdrop-tick's order, for its reason: posting first
 * and crashing leaves an event players were told about that nothing opens. An
 * unannounced row is harmless: `kothWanted` refuses it and koth-tick fails it.
 */
export async function kothDecideTick(
  db: Database, post: (c: string) => Promise<void>,
  opts: { now: Date; weeklyCap: number; minPop: number; rng?: () => number },
): Promise<{ decided: number; posted: number }> {
  const out = { decided: 0, posted: 0 };
  const rng = opts.rng ?? Math.random;
  const targets = await db.select({ id: servers.id }).from(servers).where(eq(servers.active, true));
  for (const s of targets) {
    try {
      // 1. Retry an automatic row nobody has been told about, while its slot is ahead.
      const pending = await db.select().from(kothEvents).where(and(
        eq(kothEvents.serverId, s.id), eq(kothEvents.origin, "auto"), eq(kothEvents.state, "scheduled"),
        isNull(kothEvents.announcedAt), gt(kothEvents.slotAt, opts.now),
      ));
      for (const row of pending) out.posted += await announce(db, post, row.id, row.location, row.slotAt, opts.now);
      if (pending.length > 0) continue;

      // 2. A new decision.
      const slot = nextRestartAt(opts.now);
      if (opts.now < decisionInstantFor(slot)) continue;
      const weekStart = isoWeekStart(slot);
      const [week, votes] = await Promise.all([
        db.select({ id: kothEvents.id }).from(kothEvents).where(and(
          eq(kothEvents.serverId, s.id), eq(kothEvents.origin, "auto"), notInArray(kothEvents.state, ["cancelled", "failed"]),
          gte(kothEvents.slotAt, weekStart), lt(kothEvents.slotAt, new Date(weekStart.getTime() + WEEK_MS)),
        )),
        db.select({ id: kothVotes.id }).from(kothVotes).where(and(
          eq(kothVotes.serverId, s.id), eq(kothVotes.slotAt, slot), inArray(kothVotes.state, ["open", "failed"]),
        )),
      ]);
      const pop = await onlineNow(db, s.id, opts.now);
      const threshold = highWater(await popsAt(db, s.id, historyInstants(decisionInstantFor(slot), KOTH_HISTORY_MS)));
      if (!shouldFireKoth({
        slot, slotTaken: (await slotTakenBy(db, s.id, slot)) !== null, voteBlocks: votes.length > 0,
        openEvent: await kothOpen(db, s.id), weekCount: week.length, weeklyCap: opts.weeklyCap,
        lastSlotAt: await lastKothSlot(db, s.id, slot), pop, threshold, minPop: opts.minPop,
      })) continue;

      const town = chooseKothTown(await recentTowns(db, s.id), rng);
      // ⚠️ onConflictDoNothing: a /koth schedule racing this slot owns it if it got
      // there first — counting and posting regardless would announce the wrong town.
      const [row] = await db.insert(kothEvents).values({
        serverId: s.id, slotAt: slot, location: town.slug, centreX: String(town.centreX), centreZ: String(town.centreZ),
        state: "scheduled", origin: "auto", scheduledByDiscordId: null, awardKey: null,
        popAtDecision: pop, threshold: String(threshold),
      }).onConflictDoNothing().returning({ id: kothEvents.id });
      if (!row) continue;
      out.decided += 1;
      console.log(`koth: server ${s.id} decided ${town.slug} for ${slot.toISOString()} (pop ${pop}, threshold ${threshold})`);
      out.posted += await announce(db, post, row.id, town.slug, slot, opts.now);
    } catch (err) {
      console.error(`koth: server ${s.id} automatic decision failed`, err);
    }
  }
  return out;
}

/**
 * ⚠️ `reminded_at` is stamped WITH `announced_at`: the decision is made at the
 * reminder instant, so this post is the reminder. Without it koth-tick posts a
 * second message seconds later.
 */
async function announce(db: Database, post: (c: string) => Promise<void>, id: number, slug: string, slot: Date, now: Date): Promise<number> {
  try {
    await post(scheduledText(kothLocation(slug)?.name ?? slug, slot, null));
  } catch (err) {
    console.warn(`koth: automatic announcement for ${slot.toISOString()} failed to post — retrying next tick`, err);
    return 0;
  }
  await db.update(kothEvents).set({ announcedAt: now, remindedAt: now }).where(eq(kothEvents.id, id));
  return 1;
}
```

Merge the two `@factions/domain` imports into one.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @factions/bot exec vitest run test/koth-decide-tick.test.ts test/koth-tick.test.ts` then `pnpm --filter @factions/bot typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/koth-vote-store.ts apps/bot/src/koth-decide-tick.ts apps/bot/test/koth-decide-tick.test.ts
git commit -m "feat(bot): the automatic King of the Hill decision"
```

---

### Task 7: `/koth schedule` holds the 24 h gap

**Files:**
- Modify: `apps/bot/src/commands/koth.ts` (`schedule`, after the open check)
- Test: `apps/bot/test/koth-command.test.ts`

**Interfaces:**
- Consumes: `kothGapOk` (Task 1), `lastKothSlot` (Task 6)

- [ ] **Step 1: Write the failing test** — append in the `/koth` describe:

```ts
  it("refuses a slot within 24 h of the last event's slot", async () => {
    await db.insert(kothEvents).values({
      serverId, slotAt: at("2026-10-03T00:00:00Z"), location: "borek", centreX: "1", centreZ: "1",
      state: "no_winner", origin: "vote", scheduledByDiscordId: "7",
    });
    const reply = await schedule(ctx(), input());
    expect(reply.content).toMatch(/24 hours/);
    expect((await rows()).filter((r) => r.state === "scheduled")).toHaveLength(0);
  });

  it("writes origin 'admin'", async () => {
    await schedule(ctx(), input());
    expect((await rows())[0]!.origin).toBe("admin");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @factions/bot exec vitest run test/koth-command.test.ts`
Expected: FAIL on the gap case.

- [ ] **Step 3: Implement** — after the `open.length > 0` refusal in `schedule`:

```ts
  // ⚠️ Spec 2026-09-24 §2.2: every path holds the gap, so the three cannot disagree
  // about whether a session is "too soon".
  if (!kothGapOk(slot, await lastKothSlot(ctx.db, server.id, slot))) {
    return reply("That is within 24 hours of the last King of the Hill. Pick a later slot.");
  }
```

Import `kothGapOk` from `@factions/domain` and `lastKothSlot` from `../koth-vote-store.js`. The "24 hours" literal is derived: write it as `` `${KOTH_MIN_GAP_MS / 3_600_000} hours` `` and import `KOTH_MIN_GAP_MS`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @factions/bot exec vitest run test/koth-command.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/commands/koth.ts apps/bot/test/koth-command.test.ts
git commit -m "feat(bot): /koth schedule holds the 24-hour gap"
```

---

### Task 8: `/kothvote` — the command

**Files:**
- Create: `apps/bot/src/koth-vote-channel.ts`
- Create: `apps/bot/src/commands/kothvote.ts`
- Modify: `apps/bot/src/commands/types.ts` (`Ctx`), `apps/bot/src/commands/index.ts` (`GROUPS`), `apps/bot/src/commands/confirm.ts` (vote ids)
- Modify: every test that builds a `Ctx` literal (grep `koth: post` / `bountiesEnabled:`) to add `kothVote: null`
- Test: `apps/bot/test/kothvote-command.test.ts` (create)

**Interfaces:**
- Consumes: Tasks 1, 2, 5, 6
- Produces:
  - `koth-vote-channel.ts`: `type KothVoteChannel = { post(content: string, voteId: number): Promise<{ channelId: string; messageId: string }>; edit(channelId: string, messageId: string, content: string, voteId: number | null): Promise<void> }` — `voteId: null` removes the buttons; `voteButtons(voteId: number): ActionRowBuilder<ButtonBuilder>`
  - `confirm.ts`: `voteButtonId(voteId: number, yes: boolean): string` → `cw:v:kothvote:<voteId>:yes|no`; `parseVoteButtonId(id: string): { voteId: number; yes: boolean } | null`
  - `Ctx.kothVote: { enabled: boolean; channel: KothVoteChannel } | null` (null when `SERVER_EVENTS_CHANNEL_ID` is unset)
  - `commands/kothvote.ts`: `kothVoteGroup: CommandGroup`; `castBallot(ctx: Ctx, a: { actorDiscordId: string; voteId: number; yes: boolean }): Promise<Reply>`; `voteView(v: typeof kothVotes.$inferSelect, starter: string): VoteView`

- [ ] **Step 1: Write the failing test** — `apps/bot/test/kothvote-command.test.ts`

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl, admFiles, airdropEvents, events, identityLinks, kothEvents,
  kothVotes, kothVoteVoters, playerSessions, servers, type Database,
} from "@factions/db";
import { eq, sql } from "drizzle-orm";
import { kothVoteGroup } from "../src/commands/kothvote.js";
import { parseVoteButtonId, voteButtonId } from "../src/commands/confirm.js";
import type { KothVoteChannel } from "../src/koth-vote-channel.js";
import type { Ctx, CommandInput } from "../src/commands/types.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const NOW = at("2026-10-03T15:00:00Z"); // targets the 16:00 slot, closes 15:30
const SLOT = at("2026-10-03T16:00:00Z");
const start = kothVoteGroup.specs.find((s) => s.path === "kothvote")!.handler;

describe("/kothvote", () => {
  let db: Database; let serverId = 0; let line = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table koth_votes, koth_events, airdrop_events, identity_links, player_sessions, events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "R", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 7, active: true }).returning();
    serverId = s!.id; line = 0;
    await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: at("2026-09-01T00:00:00Z"), linesIngested: 0, complete: true });
  });

  /** `linked` linked players d0…, plus `unlinked` strangers, all online now. */
  async function populate(linked: number, unlinked: number) {
    const [file] = await db.select({ id: admFiles.id }).from(admFiles);
    for (let i = 0; i < linked + unlinked; i++) {
      const dayzId = `z${i}`;
      const [e] = await db.insert(events).values({ serverId, admFileId: file!.id, lineIndex: line++, type: "player.connected" as never, occurredAt: at("2026-10-03T14:00:00Z"), payload: {} }).returning({ id: events.id });
      await db.insert(playerSessions).values({ serverId, dayzId, connectedAt: at("2026-10-03T14:00:00Z"), connectEventId: e!.id });
      if (i < linked) await db.insert(identityLinks).values({ discordId: `d${i}`, dayzId, gamertag: `Tag${i}`, verifiedAt: NOW });
    }
  }
  const channel = (): KothVoteChannel & { post: ReturnType<typeof vi.fn> } => ({
    post: vi.fn(async () => ({ channelId: "c1", messageId: "m1" })),
    edit: vi.fn(async () => {}),
  }) as never;
  const ctx = (ch: KothVoteChannel = channel(), enabled = true, now = NOW) =>
    ({ db, now, serverEvents: null, bountiesEnabled: false, koth: null, kothVote: { enabled, channel: ch }, roster: {} as never, siteBaseUrl: "https://x" }) as unknown as Ctx;
  const input = (actor = "d0") => ({ actorDiscordId: actor, isAdmin: false, string: () => null, integer: () => null, boolean: () => null, user: () => null }) as unknown as CommandInput;

  it("opens a vote: frozen electorate, the starter's Yes, the message posted", async () => {
    await populate(6, 5);
    const ch = channel();
    const reply = await start(ctx(ch), input());
    expect(reply.ephemeral).toBe(true);
    const [v] = await db.select().from(kothVotes);
    expect(v).toMatchObject({ slotAt: SLOT, state: "open", electorateSize: 6, turnoutFloor: 5, channelId: "c1", messageId: "m1", startedByDiscordId: "d0" });
    expect(v!.closesAt).toEqual(at("2026-10-03T15:30:00Z"));
    const voters = await db.select().from(kothVoteVoters);
    expect(voters).toHaveLength(6);
    expect(voters.find((r) => r.discordId === "d0")!.ballot).toBe(true);
    expect(ch.post).toHaveBeenCalledWith(expect.stringContaining("Yes 1 · No 0"), v!.id);
    expect(v!.tallyText).toContain("Yes 1 · No 0");
  });

  it("refuses when voting is off", async () => {
    await populate(6, 5);
    expect((await start(ctx(channel(), false), input())).content).toMatch(/switched off/i);
  });
  it("refuses a caller who is not linked", async () => {
    await populate(6, 5);
    expect((await start(ctx(), input("stranger"))).content).toMatch(/in game/i);
  });
  it("refuses a linked caller who is not in game", async () => {
    await populate(6, 5);
    await db.insert(identityLinks).values({ discordId: "dx", dayzId: "offline", gamertag: "Off", verifiedAt: NOW });
    expect((await start(ctx(), input("dx"))).content).toMatch(/in game/i);
  });
  it("refuses under the population minimum", async () => {
    await populate(6, 3);
    expect((await start(ctx(), input())).content).toMatch(/10 players/);
  });
  it("refuses when fewer than five linked players are online", async () => {
    await populate(4, 8);
    expect((await start(ctx(), input())).content).toMatch(/Not enough linked players/);
  });
  it("refuses a second vote while one is open", async () => {
    await populate(6, 5);
    await start(ctx(), input("d0"));
    expect((await start(ctx(), input("d1"))).content).toMatch(/already open/i);
  });
  it("refuses a slot that has already had a vote", async () => {
    await populate(6, 5);
    await start(ctx(), input("d0"));
    await db.execute(sql`update koth_votes set state = 'failed', closed_at = now()`);
    expect((await start(ctx(), input("d1"))).content).toMatch(/already been a vote/i);
  });
  it("refuses a slot an airdrop holds", async () => {
    await populate(6, 5);
    await db.insert(airdropEvents).values({ serverId, slotAt: SLOT, location: "brena", colour: "blue", decidedAt: NOW, popAtDecision: 0, threshold: "0", state: "announced", manual: true, announcedAt: NOW });
    expect((await start(ctx(), input())).content).toMatch(/airdrop/i);
  });
  it("refuses while a KotH is scheduled, and inside the 24 h gap", async () => {
    await populate(6, 5);
    await db.insert(kothEvents).values({ serverId, slotAt: at("2026-10-03T06:00:00Z"), location: "borek", centreX: "1", centreZ: "1", state: "no_winner", origin: "admin", scheduledByDiscordId: "9" });
    expect((await start(ctx(), input())).content).toMatch(/24 hours/);
  });
  it("voids the vote and says so when the message cannot be posted", async () => {
    await populate(6, 5);
    const ch = { post: vi.fn(async () => { throw new Error("gone"); }), edit: vi.fn() } as never;
    expect((await start(ctx(ch), input())).content).toMatch(/could not post/i);
    const [v] = await db.select().from(kothVotes);
    expect(v!.state).toBe("void");
    expect(v!.resultPostedAt).not.toBeNull();
  });
  // Review focus 5.
  it("maps a unique violation to the matching refusal", async () => {
    const { voteConstraintReply } = await import("../src/commands/kothvote.js");
    expect(voteConstraintReply("koth_votes_one_open")).toMatch(/already open/i);
    expect(voteConstraintReply("koth_votes_slot_uq")).toMatch(/already been a vote/i);
    expect(voteConstraintReply("something_else")).toBeNull();
  });
  it("registers /kothvote with no options and no default permissions", () => {
    const json = kothVoteGroup.command.toJSON();
    expect(json.name).toBe("kothvote");
    expect(json.options ?? []).toHaveLength(0);
    expect(json.default_member_permissions ?? null).toBeNull();
  });
  it("round-trips the vote button id", () => {
    expect(parseVoteButtonId(voteButtonId(42, true))).toEqual({ voteId: 42, yes: true });
    expect(parseVoteButtonId(voteButtonId(42, false))).toEqual({ voteId: 42, yes: false });
    expect(parseVoteButtonId("cw:c:x:1:")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @factions/bot exec vitest run test/kothvote-command.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Vote ids in `confirm.ts`** — append:

```ts
/**
 * A PUBLIC vote button: `cw:v:kothvote:<voteId>:yes|no`.
 * ⚠️ Not a `cw:c:` id. Those name one actor and `route.ts` refuses anyone else's
 * press; a vote button is pressed by the whole electorate, and eligibility is
 * `koth_vote_voters`, checked by the handler — never the id.
 */
export function voteButtonId(voteId: number, yes: boolean): string {
  return `${PREFIX}:v:kothvote:${voteId}:${yes ? "yes" : "no"}`;
}

export function parseVoteButtonId(id: string): { voteId: number; yes: boolean } | null {
  const m = /^cw:v:kothvote:(\d+):(yes|no)$/u.exec(id);
  return m ? { voteId: Number(m[1]), yes: m[2] === "yes" } : null;
}
```

- [ ] **Step 4: `apps/bot/src/koth-vote-channel.ts`**

```ts
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { voteButtonId } from "./commands/confirm.js";

/**
 * The one public message a vote lives in. `discord.ts` builds the real one; tests
 * pass a fake. ⚠️ Mentions must be off in the real one — the message carries a
 * gamertag.
 */
export type KothVoteChannel = {
  post(content: string, voteId: number): Promise<{ channelId: string; messageId: string }>;
  /** `voteId: null` removes the buttons — a closed vote must not look pressable. */
  edit(channelId: string, messageId: string, content: string, voteId: number | null): Promise<void>;
};

export function voteButtons(voteId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(voteButtonId(voteId, true)).setLabel("Yes").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(voteButtonId(voteId, false)).setLabel("No").setStyle(ButtonStyle.Secondary),
  );
}
```

- [ ] **Step 5: `Ctx`** — in `types.ts` add after `koth`:

```ts
  /**
   * `/kothvote`'s channel, or null when SERVER_EVENTS_CHANNEL_ID is unset.
   * ⚠️ Present even with `KOTH_VOTE` off (`enabled: false`): the vote tick must
   * still close — and edit — a vote that was open when the flag went off.
   */
  kothVote: { enabled: boolean; channel: KothVoteChannel } | null;
```

Update every test `Ctx` literal found by `grep -rln "bountiesEnabled" apps/bot/test` to include `kothVote: null`.

- [ ] **Step 6: `apps/bot/src/commands/kothvote.ts`**

```ts
import { SlashCommandBuilder } from "discord.js";
import { identityLinks, kothVotes, kothVoteVoters, servers } from "@factions/db";
import {
  KOTH_MIN_GAP_MS, KOTH_VOTE_MIN_POP, KOTH_VOTE_TURNOUT_MIN, chooseKothTown, kothGapOk, kothLocation, turnoutFloor,
  voteClosesAt, voteTargetSlot,
} from "@factions/domain";
import { and, eq } from "drizzle-orm";
import { hhmm, voteMessage, type VoteView } from "../koth-text.js";
import { kothOpen, lastKothSlot, linkedOnline, recentTowns, slotTakenBy } from "../koth-vote-store.js";
import { onlineNow } from "../population.js";
import type { CommandGroup, Ctx, CommandInput, Reply } from "./types.js";

const reply = (content: string): Reply => ({ content, ephemeral: true });
const UNIQUE_VIOLATION = "23505";

/** ⚠️ The pre-checks are plain SELECTs; a racing /kothvote reaches the INSERT. */
export function voteConstraintReply(constraint: string): string | null {
  if (constraint === "koth_votes_one_open") return "A King of the Hill vote is already open.";
  if (constraint === "koth_votes_slot_uq") return "There has already been a vote for that restart.";
  return null;
}

export const voteView = (v: typeof kothVotes.$inferSelect, starter: string): VoteView =>
  ({ town: kothLocation(v.location)?.name ?? v.location, slotAt: v.slotAt, closesAt: v.closesAt, floor: v.turnoutFloor, starter });

async function start(ctx: Ctx, input: CommandInput): Promise<Reply> {
  if (!ctx.kothVote?.enabled) return reply("King of the Hill voting is switched off.");
  const [server] = await ctx.db.select({ id: servers.id }).from(servers).where(eq(servers.active, true)).limit(1);
  if (!server) return reply("No active server.");
  const electorate = await linkedOnline(ctx.db, server.id);
  const me = electorate.find((e) => e.discordId === input.actorDiscordId);
  if (!me) return reply("You need to be linked and in game to start a vote.");
  if (await onlineNow(ctx.db, server.id, ctx.now) < KOTH_VOTE_MIN_POP) {
    return reply(`A vote needs at least ${KOTH_VOTE_MIN_POP} players on the server.`);
  }
  const [open] = await ctx.db.select({ id: kothVotes.id }).from(kothVotes)
    .where(and(eq(kothVotes.serverId, server.id), eq(kothVotes.state, "open"))).limit(1);
  if (open) return reply(voteConstraintReply("koth_votes_one_open")!);
  const slot = voteTargetSlot(ctx.now);
  const [held] = await ctx.db.select({ id: kothVotes.id }).from(kothVotes)
    .where(and(eq(kothVotes.serverId, server.id), eq(kothVotes.slotAt, slot))).limit(1);
  if (held) return reply(voteConstraintReply("koth_votes_slot_uq")!);
  const taken = await slotTakenBy(ctx.db, server.id, slot);
  if (taken === "airdrop") return reply(`An airdrop is set for the ${hhmm(slot)} restart.`);
  if (taken === "koth" || await kothOpen(ctx.db, server.id)) return reply("A King of the Hill event is already scheduled or live.");
  if (!kothGapOk(slot, await lastKothSlot(ctx.db, server.id, slot))) {
    return reply(`The ${hhmm(slot)} restart is within ${KOTH_MIN_GAP_MS / 3_600_000} hours of the last King of the Hill.`);
  }
  // ⚠️ Refused up front: with fewer than the minimum electorate the floor can never
  // be met, and a vote that cannot pass is only a public notice that it failed.
  if (electorate.length < KOTH_VOTE_TURNOUT_MIN) {
    return reply(`Not enough linked players online: a vote needs at least ${KOTH_VOTE_TURNOUT_MIN}.`);
  }

  const town = chooseKothTown(await recentTowns(ctx.db, server.id), Math.random);
  let vote: typeof kothVotes.$inferSelect;
  try {
    vote = await ctx.db.transaction(async (tx) => {
      const [v] = await tx.insert(kothVotes).values({
        serverId: server.id, slotAt: slot, location: town.slug, startedByDiscordId: input.actorDiscordId,
        openedAt: ctx.now, closesAt: voteClosesAt(slot), electorateSize: electorate.length,
        turnoutFloor: turnoutFloor(electorate.length), state: "open",
      }).returning();
      await tx.insert(kothVoteVoters).values(electorate.map((e) => ({
        voteId: v!.id, discordId: e.discordId, dayzId: e.dayzId,
        ...(e.discordId === input.actorDiscordId ? { ballot: true, castAt: ctx.now } : {}),
      })));
      return v!;
    });
  } catch (err) {
    const e = err as { code?: unknown; constraint_name?: unknown };
    const mapped = e?.code === UNIQUE_VIOLATION && typeof e.constraint_name === "string" ? voteConstraintReply(e.constraint_name) : null;
    if (mapped) return reply(mapped);
    throw err;
  }

  const content = voteMessage(voteView(vote, me.gamertag), { yes: 1, no: 0 });
  try {
    const { channelId, messageId } = await ctx.kothVote.channel.post(content, vote.id);
    await ctx.db.update(kothVotes).set({ channelId, messageId, tallyText: content }).where(eq(kothVotes.id, vote.id));
  } catch (err) {
    // ⚠️ A vote nobody can see is not a vote, and an `open` one would block every
    // other vote and the automatic trigger for this slot. `result_posted_at` is
    // set so the tick does not announce a result for it.
    await ctx.db.update(kothVotes).set({ state: "void", closedAt: ctx.now, resultPostedAt: ctx.now, detail: { reason: "never posted" } })
      .where(eq(kothVotes.id, vote.id));
    console.error("kothvote: the vote message failed to post — vote voided", err);
    return reply("I could not post the vote, so there is no vote. Tell an admin.");
  }
  return reply(`Vote opened for the ${hhmm(slot)} restart at ${town.name}. Your Yes is counted.`);
}

/**
 * A Yes/No press (spec §6.3). ⚠️ Eligibility is the voter row, never the button:
 * anyone in the channel can press it.
 */
export async function castBallot(ctx: Ctx, a: { actorDiscordId: string; voteId: number; yes: boolean }): Promise<Reply> {
  const [row] = await ctx.db.select({ state: kothVotes.state, closesAt: kothVotes.closesAt })
    .from(kothVoteVoters).innerJoin(kothVotes, eq(kothVotes.id, kothVoteVoters.voteId))
    .where(and(eq(kothVoteVoters.voteId, a.voteId), eq(kothVoteVoters.discordId, a.actorDiscordId))).limit(1);
  if (!row) return reply("Only linked players who were in game when this vote opened can vote on it.");
  // ⚠️ `closes_at`, not just `state`: the tick may not have closed it yet.
  if (row.state !== "open" || ctx.now >= row.closesAt) return reply("This vote has closed.");
  await ctx.db.update(kothVoteVoters).set({ ballot: a.yes, castAt: ctx.now })
    .where(and(eq(kothVoteVoters.voteId, a.voteId), eq(kothVoteVoters.discordId, a.actorDiscordId)));
  return reply(`Counted: ${a.yes ? "Yes" : "No"}. You can change it until the vote closes.`);
}

export const kothVoteGroup: CommandGroup = {
  // ⚠️ Its own command, not a /koth subcommand: Discord sets permissions per
  // command, and /koth keeps ManageGuild so players never see schedule/cancel.
  command: new SlashCommandBuilder().setName("kothvote").setDescription("Call a vote for King of the Hill at an upcoming restart"),
  specs: [{ path: "kothvote", handler: start }],
};
```

Remove imports that end up unused (`identityLinks`). Register: add `kothVoteGroup` to `GROUPS` in `commands/index.ts`.

- [ ] **Step 7: Run to verify it passes**

Run: `pnpm --filter @factions/bot exec vitest run test/kothvote-command.test.ts test/command-registration.test.ts test/parity.test.ts` then `pnpm --filter @factions/bot typecheck`
Expected: PASS. If `parity.test.ts` complains, `/kothvote` is not a roster write — it needs no entry; read the failure before changing anything.

- [ ] **Step 8: Commit**

```bash
git add apps/bot/src apps/bot/test
git commit -m "feat(bot): /kothvote opens a King of the Hill vote"
```

---

### Task 9: Routing the vote buttons

**Files:**
- Modify: `apps/bot/src/commands/route.ts`
- Test: `apps/bot/test/kothvote-ballot.test.ts` (create)

**Interfaces:**
- Consumes: `parseVoteButtonId` (Task 8), `castBallot` (Task 8)

- [ ] **Step 1: Write the failing test** — `apps/bot/test/kothvote-ballot.test.ts`. Seed a vote directly and test `castBallot`, then test the router with a minimal fake interaction.

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, kothVotes, kothVoteVoters, servers, type Database } from "@factions/db";
import { and, eq, sql } from "drizzle-orm";
import { castBallot } from "../src/commands/kothvote.js";
import { routeInteraction } from "../src/commands/route.js";
import { voteButtonId } from "../src/commands/confirm.js";
import type { Ctx } from "../src/commands/types.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const NOW = at("2026-10-03T15:10:00Z");

describe("koth vote ballots", () => {
  let db: Database; let voteId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table koth_votes, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "R", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 7, active: true }).returning();
    const [v] = await db.insert(kothVotes).values({
      serverId: s!.id, slotAt: at("2026-10-03T16:00:00Z"), location: "borek", startedByDiscordId: "d0",
      openedAt: at("2026-10-03T15:00:00Z"), closesAt: at("2026-10-03T15:30:00Z"), electorateSize: 5, turnoutFloor: 5, state: "open",
    }).returning();
    voteId = v!.id;
    await db.insert(kothVoteVoters).values(["d0", "d1", "d2", "d3", "d4"].map((d) => ({ voteId, discordId: d, dayzId: `z${d}` })));
  });
  const ctx = (now = NOW) => ({ db, now, kothVote: null } as unknown as Ctx);
  const ballot = async (d: string) => (await db.select().from(kothVoteVoters)
    .where(and(eq(kothVoteVoters.voteId, voteId), eq(kothVoteVoters.discordId, d))))[0]!.ballot;

  it("counts an elector's ballot, and lets them change it", async () => {
    await castBallot(ctx(), { actorDiscordId: "d1", voteId, yes: true });
    expect(await ballot("d1")).toBe(true);
    await castBallot(ctx(), { actorDiscordId: "d1", voteId, yes: false });
    expect(await ballot("d1")).toBe(false);
  });
  it("refuses someone outside the frozen electorate", async () => {
    const r = await castBallot(ctx(), { actorDiscordId: "late", voteId, yes: true });
    expect(r.content).toMatch(/when this vote opened/);
  });
  // Review focus 1.
  it("refuses a ballot at or after closes_at even while still open", async () => {
    const r = await castBallot(ctx(at("2026-10-03T15:30:00Z")), { actorDiscordId: "d1", voteId, yes: true });
    expect(r.content).toMatch(/closed/);
    expect(await ballot("d1")).toBeNull();
  });

  it("routes a vote button to the ballot, ephemerally, for any presser", async () => {
    const editReply = vi.fn(async () => {});
    const i = {
      isAutocomplete: () => false, isChatInputCommand: () => false, isModalSubmit: () => false,
      isMessageComponent: () => true, isStringSelectMenu: () => false,
      customId: voteButtonId(voteId, true), user: { id: "d2" },
      deferReply: vi.fn(async () => {}), editReply,
    };
    expect(await routeInteraction(ctx(), i as never)).toBe(true);
    expect(i.deferReply).toHaveBeenCalledWith({ flags: expect.anything() });
    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/Counted: Yes/) }));
    expect(await ballot("d2")).toBe(true);
  });
});
```

`castBallot` uses `ctx.now`; production `ctxNow()` builds a fresh `now` per interaction, so that is the press time.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @factions/bot exec vitest run test/kothvote-ballot.test.ts`
Expected: the router case FAILS (`routeInteraction` returns false); the `castBallot` cases pass.

- [ ] **Step 3: Implement** — in `route.ts`, import `parseVoteButtonId` and `castBallot`, add:

```ts
/**
 * A public vote button. ⚠️ No actor check: `cw:v:` ids are pressed by the whole
 * electorate — `castBallot` checks eligibility against `koth_vote_voters`.
 */
async function handleVoteButton(ctx: Ctx, i: MessageComponentInteraction, v: { voteId: number; yes: boolean }): Promise<void> {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  await finish(i, () => castBallot(ctx, { actorDiscordId: i.user.id, voteId: v.voteId, yes: v.yes }), "koth vote");
}
```

and in `routeInteraction`'s `isMessageComponent` branch, first:

```ts
    const vote = parseVoteButtonId(interaction.customId);
    if (vote) { await handleVoteButton(ctx, interaction, vote); return true; }
```

`castBallot` importing from `./kothvote.js` while `kothvote.ts` imports types only from `route.ts`'s neighbours is not circular; if `index.ts` → `kothvote.ts` → … → `route.ts` ever cycles, move `castBallot` into `apps/bot/src/koth-ballot.ts`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @factions/bot exec vitest run test/kothvote-ballot.test.ts test/command-registration.test.ts`
Expected: PASS (command-registration's "acknowledges only with MessageFlags.Ephemeral" scan must stay green).

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/commands/route.ts apps/bot/test/kothvote-ballot.test.ts
git commit -m "feat(bot): route King of the Hill vote buttons to the ballot"
```

---

### Task 10: The vote tick

**Files:**
- Create: `apps/bot/src/koth-vote-tick.ts`
- Test: `apps/bot/test/koth-vote-tick.test.ts` (create)

**Interfaces:**
- Consumes: Tasks 1, 2, 5, 6, 8 (`KothVoteChannel`, `voteView`)
- Produces: `kothVoteTick(db: Database, channel: KothVoteChannel, announce: (c: string) => Promise<void>, opts: { now: Date; enabled: boolean }): Promise<{ edited: number; closed: number; posted: number }>`

- [ ] **Step 1: Write the failing test** — `apps/bot/test/koth-vote-tick.test.ts`

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl, identityLinks, kothEvents, kothVotes, kothVoteVoters, servers, type Database,
} from "@factions/db";
import { eq, sql } from "drizzle-orm";
import { kothVoteTick } from "../src/koth-vote-tick.js";
import type { KothVoteChannel } from "../src/koth-vote-channel.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const SLOT = at("2026-10-03T16:00:00Z");
const CLOSE = at("2026-10-03T15:30:00Z");

describe("kothVoteTick", () => {
  let db: Database; let serverId = 0; let voteId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table koth_votes, koth_events, airdrop_events, identity_links, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "R", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 7, active: true }).returning();
    serverId = s!.id;
    await db.insert(identityLinks).values({ discordId: "d0", dayzId: "z0", gamertag: "Mina", verifiedAt: CLOSE });
    const [v] = await db.insert(kothVotes).values({
      serverId, slotAt: SLOT, location: "borek", startedByDiscordId: "d0", openedAt: at("2026-10-03T15:00:00Z"),
      closesAt: CLOSE, electorateSize: 6, turnoutFloor: 5, state: "open", channelId: "c1", messageId: "m1", tallyText: "old",
    }).returning();
    voteId = v!.id;
    await db.insert(kothVoteVoters).values(["d0", "d1", "d2", "d3", "d4", "d5"].map((d) => ({ voteId, discordId: d, dayzId: `z${d}` })));
  });

  const vote = async () => (await db.select().from(kothVotes).where(eq(kothVotes.id, voteId)))[0]!;
  const cast = (d: string, yes: boolean) => db.update(kothVoteVoters).set({ ballot: yes, castAt: at("2026-10-03T15:05:00Z") })
    .where(sql`${kothVoteVoters.voteId} = ${voteId} and ${kothVoteVoters.discordId} = ${d}`);
  const channel = () => ({ post: vi.fn(), edit: vi.fn(async () => {}) }) as unknown as KothVoteChannel & { edit: ReturnType<typeof vi.fn> };
  const run = (ch: KothVoteChannel, announce: (c: string) => Promise<void>, now: Date, enabled = true) =>
    kothVoteTick(db, ch, announce, { now, enabled });

  it("edits the tally when it changes, and stores it", async () => {
    await cast("d0", true);
    const ch = channel();
    expect((await run(ch, vi.fn(async () => {}), at("2026-10-03T15:10:00Z"))).edited).toBe(1);
    expect(ch.edit).toHaveBeenCalledWith("c1", "m1", expect.stringContaining("Yes 1 · No 0"), voteId);
    expect((await vote()).tallyText).toContain("Yes 1 · No 0");
  });
  // Review focus 4.
  it("does not edit when the tally is unchanged", async () => {
    await cast("d0", true);
    await run(channel(), vi.fn(async () => {}), at("2026-10-03T15:10:00Z"));
    const ch = channel();
    expect((await run(ch, vi.fn(async () => {}), at("2026-10-03T15:11:00Z"))).edited).toBe(0);
    expect(ch.edit).not.toHaveBeenCalled();
  });

  it("passes: inserts the event, announces it, stamps it, and closes the message", async () => {
    for (const d of ["d0", "d1", "d2", "d3"]) await cast(d, true);
    await cast("d4", false);
    const ch = channel(); const announce = vi.fn(async (_c: string) => {});
    await run(ch, announce, CLOSE);
    const v = await vote();
    expect(v.state).toBe("passed");
    const [ev] = await db.select().from(kothEvents);
    expect(ev).toMatchObject({ id: v.kothEventId, origin: "vote", scheduledByDiscordId: "d0", slotAt: SLOT, location: "borek", awardKey: null, state: "scheduled" });
    expect(ev!.announcedAt).toEqual(CLOSE);
    expect(ev!.remindedAt).toEqual(CLOSE);
    expect(announce.mock.calls[0]![0]).toContain("The vote passed (Yes 4 · No 1)");
    expect(v.resultPostedAt).toEqual(CLOSE);
    expect(ch.edit).toHaveBeenLastCalledWith("c1", "m1", expect.stringContaining("Voting has closed"), null);
  });
  // Review focus 2.
  it("passes when closed late but before the slot", async () => {
    for (const d of ["d0", "d1", "d2", "d3", "d4"]) await cast(d, true);
    await run(channel(), vi.fn(async () => {}), at("2026-10-03T15:35:00Z"));
    expect((await vote()).state).toBe("passed");
  });
  it("fails on turnout", async () => {
    for (const d of ["d0", "d1", "d2", "d3"]) await cast(d, true);
    const announce = vi.fn(async (_c: string) => {});
    await run(channel(), announce, CLOSE);
    expect((await vote()).state).toBe("failed");
    expect(await db.select().from(kothEvents)).toHaveLength(0);
    expect(announce.mock.calls[0]![0]).toMatch(/4 of the 5 votes/);
  });
  it("fails on the majority", async () => {
    for (const d of ["d0", "d1", "d2"]) await cast(d, true);
    for (const d of ["d3", "d4"]) await cast(d, false);
    await run(channel(), vi.fn(async () => {}), CLOSE);
    expect((await vote()).state).toBe("failed");
  });
  it("voids at close if an admin scheduled in the meantime", async () => {
    for (const d of ["d0", "d1", "d2", "d3", "d4"]) await cast(d, true);
    await db.insert(kothEvents).values({ serverId, slotAt: at("2026-10-04T20:00:00Z"), location: "lembork", centreX: "1", centreZ: "1", state: "scheduled", origin: "admin", scheduledByDiscordId: "9", announcedAt: CLOSE });
    const announce = vi.fn(async (_c: string) => {});
    await run(channel(), announce, CLOSE);
    expect((await vote()).state).toBe("void");
    expect(announce.mock.calls[0]![0]).toMatch(/did not go ahead/);
  });
  it("voids a vote the bot reaches only after its slot", async () => {
    for (const d of ["d0", "d1", "d2", "d3", "d4"]) await cast(d, true);
    await run(channel(), vi.fn(async () => {}), at("2026-10-03T16:05:00Z"));
    expect((await vote()).state).toBe("void");
    expect(await db.select().from(kothEvents)).toHaveLength(0);
  });
  it("voids at close when voting was switched off", async () => {
    for (const d of ["d0", "d1", "d2", "d3", "d4"]) await cast(d, true);
    await run(channel(), vi.fn(async () => {}), CLOSE, false);
    expect((await vote()).state).toBe("void");
    expect((await vote()).detail).toMatchObject({ reason: "voting was switched off" });
  });
  it("retries a failed result post, and still records the close", async () => {
    for (const d of ["d0", "d1", "d2", "d3"]) await cast(d, true);
    await run(channel(), vi.fn(async () => { throw new Error("gone"); }), CLOSE);
    expect((await vote()).state).toBe("failed");
    expect((await vote()).resultPostedAt).toBeNull();
    const announce = vi.fn(async () => {});
    await run(channel(), announce, at("2026-10-03T15:31:00Z"));
    expect(announce).toHaveBeenCalledTimes(1);
    expect((await vote()).resultPostedAt).not.toBeNull();
  });
  it("still closes and posts when the message was deleted by hand", async () => {
    for (const d of ["d0", "d1", "d2", "d3"]) await cast(d, true);
    const ch = { post: vi.fn(), edit: vi.fn(async () => { throw new Error("Unknown Message"); }) } as unknown as KothVoteChannel;
    const announce = vi.fn(async () => {});
    await run(ch, announce, CLOSE);
    expect((await vote()).state).toBe("failed");
    expect(announce).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @factions/bot exec vitest run test/koth-vote-tick.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `apps/bot/src/koth-vote-tick.ts`**

```ts
import { identityLinks, kothEvents, kothVotes, kothVoteVoters, servers, type Database } from "@factions/db";
import { kothGapOk, kothLocation, voteOutcome } from "@factions/domain";
import { and, eq, gte, isNotNull, isNull, ne } from "drizzle-orm";
import { voteView } from "./commands/kothvote.js";
import { voteFailedText, voteMessage, votePassedText, voteVoidText, type Tally } from "./koth-text.js";
import type { KothVoteChannel } from "./koth-vote-channel.js";
import { kothOpen, lastKothSlot, slotTakenBy } from "./koth-vote-store.js";

type Vote = typeof kothVotes.$inferSelect;
/** Same bound and reasoning as airdrop-tick's SCRUB_SCAN_MS: never resurrect a long-dead row. */
const RESULT_SCAN_MS = 14 * 24 * 60 * 60 * 1000;

async function tally(db: Database, voteId: number): Promise<Tally> {
  const rows = await db.select({ ballot: kothVoteVoters.ballot }).from(kothVoteVoters).where(eq(kothVoteVoters.voteId, voteId));
  return { yes: rows.filter((r) => r.ballot === true).length, no: rows.filter((r) => r.ballot === false).length };
}
async function starterTag(db: Database, v: Vote): Promise<string> {
  const [l] = await db.select({ g: identityLinks.gamertag }).from(identityLinks).where(eq(identityLinks.discordId, v.startedByDiscordId)).limit(1);
  return l?.g ?? "A player";
}
const town = (v: Vote) => kothLocation(v.location)?.name ?? v.location;

/**
 * Keeps the open vote's tally current, closes it, and posts the result
 * (spec 2026-09-24 §6.4).
 *
 * ⚠️ Runs whether or not KOTH_VOTE is on (`enabled` only decides what a close
 * becomes): switching the feature off must finish a vote already running, and
 * never create an event from one.
 * ⚠️ Runs BEFORE kothDecideTick and airdropTick (tick-order.test.ts): a vote
 * closing at T−30 inserts its row before either looks at that slot.
 */
export async function kothVoteTick(
  db: Database, channel: KothVoteChannel, announce: (c: string) => Promise<void>, opts: { now: Date; enabled: boolean },
) {
  const out = { edited: 0, closed: 0, posted: 0 };
  const targets = await db.select({ id: servers.id }).from(servers).where(eq(servers.active, true));
  for (const s of targets) {
    try {
      const [open] = await db.select().from(kothVotes).where(and(eq(kothVotes.serverId, s.id), eq(kothVotes.state, "open")));
      if (open && opts.now < open.closesAt) {
        const content = voteMessage(voteView(open, await starterTag(db, open)), await tally(db, open.id));
        if (content !== open.tallyText && open.channelId && open.messageId) {
          try {
            await channel.edit(open.channelId, open.messageId, content, open.id);
            await db.update(kothVotes).set({ tallyText: content }).where(eq(kothVotes.id, open.id));
            out.edited += 1;
          } catch (err) {
            console.warn(`kothvote: tally edit for vote ${open.id} failed`, err);
          }
        }
      } else if (open) {
        await close(db, open, opts);
        out.closed += 1;
      }
      out.posted += await postResults(db, s.id, channel, announce, opts.now);
    } catch (err) {
      console.error(`kothvote: server ${s.id} tick failed`, err);
    }
  }
  return out;
}

async function close(db: Database, open: Vote, opts: { now: Date; enabled: boolean }): Promise<void> {
  await db.transaction(async (tx) => {
    // ⚠️ Lock order: koth_votes → koth_vote_voters → koth_events.
    const [v] = await tx.select().from(kothVotes).where(and(eq(kothVotes.id, open.id), eq(kothVotes.state, "open"))).for("update");
    if (!v) return;
    const rows = await tx.select({ ballot: kothVoteVoters.ballot }).from(kothVoteVoters).where(eq(kothVoteVoters.voteId, v.id));
    const t = { yes: rows.filter((r) => r.ballot === true).length, no: rows.filter((r) => r.ballot === false).length };
    const done = (state: "passed" | "failed" | "void", detail: Record<string, string | number>, kothEventId?: number) =>
      tx.update(kothVotes).set({ state, closedAt: opts.now, kothEventId: kothEventId ?? null, detail: { ...detail, yes: t.yes, no: t.no } })
        .where(eq(kothVotes.id, v.id));
    // ⚠️ Never late (KotH spec §2.1): the session it was for has started.
    if (opts.now >= v.slotAt) return void await done("void", { reason: "the vote expired before it could be counted" });
    if (!opts.enabled) return void await done("void", { reason: "voting was switched off" });
    const r = voteOutcome({ cast: t.yes + t.no, yes: t.yes, floor: v.turnoutFloor });
    if (r.outcome === "failed") return void await done("failed", { reason: r.reason });
    // ⚠️ Re-checked under the lock: an admin may have scheduled, or an airdrop been
    // placed, since the vote opened.
    const taken = await slotTakenBy(tx, v.serverId, v.slotAt);
    if (taken) return void await done("void", { reason: `an ${taken === "koth" ? "event" : "airdrop"} took that restart` });
    if (await kothOpen(tx, v.serverId)) return void await done("void", { reason: "another King of the Hill was scheduled first" });
    if (!kothGapOk(v.slotAt, await lastKothSlot(tx, v.serverId, v.slotAt))) return void await done("void", { reason: "another King of the Hill ran too recently" });
    const loc = kothLocation(v.location)!;
    const [ev] = await tx.insert(kothEvents).values({
      serverId: v.serverId, slotAt: v.slotAt, location: v.location, centreX: String(loc.centreX), centreZ: String(loc.centreZ),
      state: "scheduled", origin: "vote", scheduledByDiscordId: v.startedByDiscordId, awardKey: null,
    }).returning({ id: kothEvents.id });
    await done("passed", { reason: "passed" }, ev!.id);
  });
}

/** Post, THEN stamp — a stamp first silences a post that never went out. */
async function postResults(db: Database, serverId: number, channel: KothVoteChannel, announce: (c: string) => Promise<void>, now: Date): Promise<number> {
  const closed = await db.select().from(kothVotes).where(and(
    eq(kothVotes.serverId, serverId), ne(kothVotes.state, "open"), isNull(kothVotes.resultPostedAt),
    isNotNull(kothVotes.closedAt), gte(kothVotes.closedAt, new Date(now.getTime() - RESULT_SCAN_MS)),
  ));
  let posted = 0;
  for (const v of closed) {
    const t: Tally = { yes: Number(v.detail.yes ?? 0), no: Number(v.detail.no ?? 0) };
    const reason = String(v.detail.reason ?? "");
    let text: string | null;
    let line: string;
    if (v.state === "passed") {
      // ⚠️ Past its slot, the event was never announced and koth-tick fails it with
      // no cancellation; announcing it now would name a session already under way.
      text = now < v.slotAt ? votePassedText(town(v), v.slotAt, t) : null;
      line = "Voting has closed: passed.";
    } else if (v.state === "failed") {
      text = voteFailedText(town(v), t, v.turnoutFloor, reason === "turnout" ? "turnout" : "majority");
      line = "Voting has closed: failed.";
    } else {
      text = voteVoidText(town(v), reason);
      line = `Voting has closed: ${reason}.`;
    }
    if (text) {
      try { await announce(text); } catch (err) { console.warn(`kothvote: result for vote ${v.id} failed to post — retrying next tick`, err); continue; }
    }
    await db.transaction(async (tx) => {
      await tx.update(kothVotes).set({ resultPostedAt: now }).where(eq(kothVotes.id, v.id));
      if (v.state === "passed" && text && v.kothEventId) {
        // ⚠️ `reminded_at` WITH `announced_at`: the vote closes at the reminder instant.
        await tx.update(kothEvents).set({ announcedAt: now, remindedAt: now }).where(eq(kothEvents.id, v.kothEventId));
      }
    });
    posted += 1;
    if (v.channelId && v.messageId) {
      const final = voteMessage(voteView(v, await starterTag(db, v)), t, line);
      await channel.edit(v.channelId, v.messageId, final, null)
        .catch((err: unknown) => console.warn(`kothvote: closing edit for vote ${v.id} failed`, err));
    }
  }
  return posted;
}
```

Note the lock order in the pass transaction: `koth_votes` (FOR UPDATE) → `koth_vote_voters` (read) → `koth_events` (insert). `postResults`' stamp transaction updates `koth_votes` then `koth_events`, the same order.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @factions/bot exec vitest run test/koth-vote-tick.test.ts` then `pnpm --filter @factions/bot typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/koth-vote-tick.ts apps/bot/test/koth-vote-tick.test.ts
git commit -m "feat(bot): the King of the Hill vote tick"
```

---

### Task 11: Guild removal drops voter rows

**Files:**
- Create: `packages/roster/src/internal/koth-ballots.ts`
- Modify: `packages/roster/src/internal/removal-store.ts` (before each of the 5 `revokeAwardsForTx(tx, …)` calls)
- Modify: `packages/roster/src/internal/index.ts` only if the internal barrel must re-export it (it need not; it is used only by `removal-store.ts`)
- Test: `packages/roster/test/removal.test.ts`

**Interfaces:**
- Produces: `dropKothBallotsTx(tx: Tx, discordId: string): Promise<number>` (count deleted)

- [ ] **Step 1: Write the failing test** — append to `removal.test.ts` a case that seeds a `koth_votes` row and a `koth_vote_voters` row for an unlinked-and-otherwise-empty user (so it exercises the simplest branch) plus one for a full member (the member branch), calls `removeFromGuildDb`, and asserts both voter rows are gone while the vote's `electorate_size` is unchanged:

```ts
  it("drops the departed user's King of the Hill voter rows, leaving the frozen electorate size", async () => {
    const [v] = await db.insert(kothVotes).values({
      serverId, slotAt: new Date("2026-09-05T16:00:00Z"), location: "borek", startedByDiscordId: "other",
      openedAt: now, closesAt: new Date("2026-09-05T15:30:00Z"), electorateSize: 6, turnoutFloor: 5, state: "open",
    }).returning();
    await db.insert(kothVoteVoters).values([
      { voteId: v!.id, discordId: D.M1, dayzId: UID.M1, ballot: true, castAt: now },
      { voteId: v!.id, discordId: "nobody-else", dayzId: "x" },
    ]);
    await removeFromGuildDb(db, { discordId: D.M1, at: now });
    const left = await db.select().from(kothVoteVoters);
    expect(left.map((r) => r.discordId)).toEqual(["nobody-else"]);
    expect((await db.select().from(kothVotes))[0]!.electorateSize).toBe(6);
  });
```

Add `kothVotes, kothVoteVoters` to the file's `@factions/db` import, and `koth_votes` to its `beforeEach` truncate list (cascade removes voters). Use whichever seeded identity in that file is a full member (`M1` per the header comment); read the `beforeEach` to confirm it is linked and on a roster.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @factions/roster exec vitest run test/removal.test.ts`
Expected: FAIL — rows remain.

- [ ] **Step 3: Implement** — `packages/roster/src/internal/koth-ballots.ts`:

```ts
import { kothVoteVoters } from "@factions/db";
import { eq } from "drizzle-orm";
import type { Tx } from "./tx";

/**
 * A departed user's KotH ballots (spec 2026-09-24 §7). The frozen electorate size
 * and floor do not move — the vote's bar was fixed when it opened.
 * ⚠️ Lock order: koth_vote_voters sits after guest_passes and before award_grants;
 * call this immediately before `revokeAwardsForTx`.
 */
export async function dropKothBallotsTx(tx: Tx, discordId: string): Promise<number> {
  const gone = await tx.delete(kothVoteVoters).where(eq(kothVoteVoters.discordId, discordId)).returning({ v: kothVoteVoters.voteId });
  return gone.length;
}
```

Use the `Tx` type `award-admin.ts` imports (check its import line and copy it exactly — the path above is illustrative). Then in `removal-store.ts`, immediately before every `revokeAwardsForTx(tx, a.discordId, a.at)` (5 sites — `grep -n "revokeAwardsForTx(tx" packages/roster/src/internal/removal-store.ts`), add `await dropKothBallotsTx(tx, a.discordId);`. For the early-return unlinked branch (`if (!link) return { ...NOTHING, revokedAwards: await revokeAwardsForTx(…) }`) rewrite to:

```ts
    if (!link) {
      await dropKothBallotsTx(tx, a.discordId);
      return { ...NOTHING, revokedAwards: await revokeAwardsForTx(tx, a.discordId, a.at) };
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @factions/roster exec vitest run test/removal.test.ts` then `pnpm --filter @factions/roster typecheck`
Expected: PASS. `packages/roster/test/exports.test.ts` must stay green — nothing new is exported from the package root.

- [ ] **Step 5: Commit**

```bash
git add packages/roster
git commit -m "feat(roster): guild removal drops a departed user's KotH ballots"
```

---

### Task 12: Wiring in `discord.ts`

**Files:**
- Modify: `apps/bot/src/discord.ts` (posters ~line 618, `ctxNow` ~line 622, tick block before `if (cfg.airdrop.enabled)` ~line 1640, startup logs ~line 1736)
- Test: `apps/bot/test/tick-order.test.ts`

**Interfaces:**
- Consumes: `kothVoteTick` (Task 10), `kothDecideTick` (Task 6), `KothVoteChannel`/`voteButtons` (Task 8), `cfg.koth.auto`/`cfg.koth.vote` (Task 4)

- [ ] **Step 1: Write the failing test** — append to `tick-order.test.ts`:

```ts
describe("King of the Hill vote and decision wiring (spec 2026-09-24 §6.5)", () => {
  it("runs the vote tick, then the automatic decision, then the airdrop decision, all after the restart tick", () => {
    const restartAt = src.indexOf("await restartTick(db,");
    const voteAt = src.indexOf("await kothVoteTick(db,");
    const decideAt = src.indexOf("await kothDecideTick(db,");
    const airdropAt = src.indexOf("await airdropTick(db,");
    for (const i of [restartAt, voteAt, decideAt, airdropAt]) expect(i).toBeGreaterThan(-1);
    expect(voteAt).toBeGreaterThan(restartAt);
    // ⚠️ The airdrop yields to a scheduled KotH row only if the row exists when it looks.
    expect(decideAt).toBeGreaterThan(voteAt);
    expect(airdropAt).toBeGreaterThan(decideAt);
  });
  it("gates the decision on cfg.koth.auto.enabled", () => {
    expect(src).toMatch(/if \(cfg\.koth\.auto\.enabled\) \{\s*try \{\s*const d = await kothDecideTick\(db,/u);
  });
  // ⚠️ Not gated on KOTH_VOTE: an open vote must still close when the flag goes off.
  it("runs the vote tick whenever the channel exists", () => {
    expect(src).toMatch(/if \(kothVoteChannel\) \{\s*try \{\s*const v = await kothVoteTick\(db,/u);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @factions/bot exec vitest run test/tick-order.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** — add near `createChannelPoster`:

```ts
/**
 * The KotH vote's one message. ⚠️ `allowedMentions: { parse: [] }` on post AND
 * edit: the message carries a gamertag, and an edit re-parses mentions.
 */
export function createKothVoteChannel(client: Client, channelId: string): KothVoteChannel {
  const fetchChannel = async (id: string) => {
    const channel = await client.channels.fetch(id);
    if (!channel?.isSendable() || !channel.isTextBased() || channel.isDMBased()) {
      throw new Error(`channel ${id} is missing or not sendable by this bot`);
    }
    return channel;
  };
  return {
    async post(content, voteId) {
      const sent = await (await fetchChannel(channelId)).send({ content, components: [voteButtons(voteId)], allowedMentions: { parse: [] } });
      return { channelId, messageId: sent.id };
    },
    async edit(id, messageId, content, voteId) {
      const msg = await (await fetchChannel(id)).messages.fetch(messageId);
      await msg.edit({ content, components: voteId === null ? [] : [voteButtons(voteId)], allowedMentions: { parse: [] } });
    },
  };
}
```

After the `kothPoster` definition:

```ts
  // ⚠️ Built whenever the channel exists, not only with KOTH_VOTE on: a vote open
  // when the flag goes off must still be closed and its message edited.
  const kothVoteChannel = cfg.koth.enabled && cfg.serverEventsChannelId ? createKothVoteChannel(client, cfg.serverEventsChannelId) : null;
```

In `ctxNow`: `kothVote: kothVoteChannel ? { enabled: cfg.koth.vote.enabled, channel: kothVoteChannel } : null,`.

Immediately before the `if (cfg.airdrop.enabled) {` tick block:

```ts
    // ⚠️ Vote tick → automatic decision → airdrop, in that order (tick-order.test.ts):
    // a vote closing at T−30 inserts its row before the decision looks, and both
    // before the airdrop, which yields to a scheduled KotH. Each its own try/catch:
    // a throw here must leave the airdrop deciding as normal.
    if (kothVoteChannel) {
      try {
        const v = await kothVoteTick(db, kothVoteChannel, kothPoster!, { now: new Date(), enabled: cfg.koth.vote.enabled });
        if (v.closed + v.posted > 0) console.log(`kothvote: ${v.closed} closed, ${v.posted} posted`);
      } catch (err) {
        console.error("koth vote tick failed", err);
      }
    }
    if (cfg.koth.auto.enabled) {
      try {
        const d = await kothDecideTick(db, kothPoster!, { now: new Date(), weeklyCap: cfg.koth.auto.weeklyCap, minPop: cfg.koth.auto.minPop });
        if (d.decided + d.posted > 0) console.log(`koth: ${d.decided} decided automatically, ${d.posted} posted`);
      } catch (err) {
        console.error("koth decision tick failed", err);
      }
    }
```

(`kothPoster` is non-null whenever `kothVoteChannel` is, and whenever `cfg.koth.auto.enabled` is — both require `KOTH_TICK`, which requires `SERVER_EVENTS_CHANNEL_ID`.) Startup logs beside the existing `king of the hill on` line:

```ts
    if (cfg.koth.auto.enabled) console.log(`king of the hill automation on (cap ${cfg.koth.auto.weeklyCap}/week, floor ${cfg.koth.auto.minPop})`);
    if (cfg.koth.vote.enabled) console.log("king of the hill voting on");
```

Add the imports (`kothVoteTick`, `kothDecideTick`, `KothVoteChannel`, `voteButtons`).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @factions/bot exec vitest run test/tick-order.test.ts test/command-registration.test.ts` then `pnpm --filter @factions/bot typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/discord.ts apps/bot/test/tick-order.test.ts
git commit -m "feat(bot): wire the KotH vote and automatic decision ticks"
```

---

### Task 13: Docs, changelog and the full gate

**Files:**
- Modify: `CLAUDE.md` (lock-order bullet; the King of the Hill row in "Where things live")
- Modify: `apps/bot/README.md` (env table)
- Modify: `CHANGELOG.md` (`## [Unreleased]`)
- Create: `docs/deploy/2026-09-24-koth-auto-and-vote.md`

- [ ] **Step 1: `CLAUDE.md`** — in the lock-order line replace `achievement_counters` → `koth_events` with `achievement_counters` → `koth_votes` → `koth_vote_voters` → `koth_events`, and after the existing `koth_events is written by …` sentence add: "`koth_votes`/`koth_vote_voters` are written by `/kothvote`, the ballot handler and `koth-vote-tick`; the pass transaction takes `koth_votes` → `koth_vote_voters` → `koth_events`, and `removeFromGuildDb` deletes voter rows immediately before `award_grants`." Append to the King of the Hill row: "Since 2026-09-24 an event can also start **automatically** (`apps/bot/src/koth-decide-tick.ts`, gated on `KOTH_AUTO_TICK`: airdrop-style high-water, 24 h gap, `KOTH_WEEKLY_CAP` counting `origin = 'auto'` only) or by a **player vote** (`/kothvote`, `apps/bot/src/koth-vote-tick.ts`, gated on `KOTH_VOTE`: linked in-game players frozen at open, floor max(5, half), two-thirds Yes). Both are prize-less. ⚠️ Both ticks run BEFORE `airdropTick` — KotH takes a record night's slot, and the airdrop then may not fire for up to `AIRDROP_HISTORY_MS`. ⚠️ `koth_votes_slot_uq` is unconditional: one vote per slot, ever. Spec `docs/superpowers/specs/2026-09-24-koth-auto-and-vote-design.md`, runbook `docs/deploy/2026-09-24-koth-auto-and-vote.md`."

- [ ] **Step 2: `apps/bot/README.md`** — add four rows beside `KOTH_TICK` in the env table: `KOTH_AUTO_TICK` (off; requires `KOTH_TICK`), `KOTH_WEEKLY_CAP` (2), `KOTH_AUTO_MIN_POP` (10), `KOTH_VOTE` (off; requires `KOTH_TICK`), each with a one-line description in the table's existing style.

- [ ] **Step 3: Runbook** — `docs/deploy/2026-09-24-koth-auto-and-vote.md`:

```markdown
# King of the Hill: automatic trigger and player vote — deploy

Spec: `docs/superpowers/specs/2026-09-24-koth-auto-and-vote-design.md`

## What changes on the server

Nothing in the mission. Migration 0052 is additive: `koth_events.origin`
(defaulted `'admin'`, so the old bot's inserts keep working), two nullable
columns, `scheduled_by_discord_id` made nullable, and the tables `koth_votes`
and `koth_vote_voters`. The release deployer's stop-then-migrate order covers it.

## Order

1. Deploy the release with `KOTH_AUTO_TICK` and `KOTH_VOTE` unset. Check
   `/kothvote` answers "King of the Hill voting is switched off."
2. Set `KOTH_VOTE=true` in `.env`; `sudo systemctl restart clan-wars-bot`. The
   log says `king of the hill voting on`. On a night with 10+ online and 5+
   linked players in game, watch one vote open in `#server-events`, its tally
   move, and its result post 30 minutes before the restart.
3. Set `KOTH_AUTO_TICK=true` (and `KOTH_WEEKLY_CAP` / `KOTH_AUTO_MIN_POP` if not
   2 / 10); restart. The log says `king of the hill automation on (cap 2/week, floor 10)`.

## What to expect

- The first automatic KotH lands on the next record night, and that night's
  airdrop is skipped in its favour: `airdrop: skipped <slot>: koth` in the log.
  Because the record then becomes the airdrop's high-water mark, airdrops may
  not fire again for up to five days. Intended.
- A failed vote for a slot also stops the automatic trigger for that slot.

## Read-only checks

    docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c "
      select id, slot_at, location, state, detail from koth_votes order by id desc limit 5"
    docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c "
      select id, slot_at, origin, state, pop_at_decision, threshold from koth_events order by id desc limit 5"

## Turning it off

Unset either flag and restart. A vote already open is still closed at its
time, as `void` ("voting was switched off"), and its message edited; nothing
new is created.
```

- [ ] **Step 4: `CHANGELOG.md`** — under `## [Unreleased]`, in the existing subsection style (add `### Added` if absent):

```markdown
- King of the Hill can now start on its own on the server's busiest nights
  (`KOTH_AUTO_TICK`), and players can call one with `/kothvote`: linked players
  in game vote Yes or No, and it runs at the next restart if two-thirds agree.
  Neither kind has a prize. At most one King of the Hill a day.
```

- [ ] **Step 5: Full gate** — confirm with the user that the other session is not running tests, then:

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`
Expected: **30/30 tasks** successful. Read the count, not the exit code. If the test DB predates this branch and a migration error appears, drop only `factions_test_bot`/`factions_test_db`/`factions_test_roster` by hand — never `factions_live`.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md apps/bot/README.md CHANGELOG.md docs/deploy/2026-09-24-koth-auto-and-vote.md
git commit -m "docs: King of the Hill automatic trigger and vote — runbook, notes, changelog"
```
