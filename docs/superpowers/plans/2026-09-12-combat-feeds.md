# Combat Feeds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three new Discord feeds — #hit-feed (every PvP hit, grouped into engagements), #killstreaks (every 3rd consecutive kill), #long-range (kills at 100 m+) — riding one shared at-least-once cursor loop that the existing kill feed folds into.

**Architecture:** All four feeds are cursor consumers over already-projected data: `events` (`player.hit`) for the hit feed, `kills` for the other three. No migration, no new table. Each feed supplies a **store** (seeded / head / cursor / readAfter / markPosted) and a pure **render** function; `cursorFeedTick` owns the loop. Rendering and grouping are pure modules with no database, client or clock, and carry the bulk of the tests.

**Tech Stack:** TypeScript (ESM, `.js` extension on relative imports), pnpm workspace + turbo, drizzle-orm over postgres.js, discord.js v14, vitest.

**Spec:** `docs/superpowers/specs/2026-09-12-combat-feeds-design.md`

## Global Constraints

- **Never point anything at `factions_live`.** It is production on port 5434. Tests derive their own `factions_test_<package>` from `TEST_DATABASE_URL`; the database named in that URL is discarded by design.
- Test database URL for every command in this plan: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"`
- **The full gate, always with `--force`:** `TEST_DATABASE_URL="…" npx turbo run typecheck test --concurrency=1 --force` — expect **26/26 tasks**. A cached pass proves nothing; check the count, not the exit code. No new package is added, so the count must not change.
- Relative imports carry the `.js` extension (`./kill-feed-embed.js`), even from `.ts` files. This is an ESM workspace.
- Every consumer cursor name must be distinct from every other. Two consumers sharing a cursor skip each other's events.
- Every new feed seeds its cursor at the head on the first run and posts nothing historical.
- Every new channel id env var is **optional**; unset means the feed is off and nothing posts.
- Gamertags always pass through `escapeMarkdown` before reaching an embed. A name is text, never markup.
- No coordinates in any payload or embed, ever — the invariant `faction_events`, `war_log_events` and `clan_notices` all carry.
- `RECENT_HIT_WINDOW_S` (120) and `FINISH_HP_MAX` (25) are existing exports of `@factions/domain`. Import them; never redefine them.

---

### Task 1: Extract the shared cursor feed loop

The existing `killFeedTick` already implements the loop all four feeds need. Extract it, and make the kill feed the first caller. **`apps/bot/test/kill-feed-tick.test.ts` must pass with its assertions unchanged** — it is the regression gate on this refactor.

**Files:**
- Create: `apps/bot/src/cursor-feed.ts`
- Create: `apps/bot/test/cursor-feed.test.ts`
- Modify: `apps/bot/src/kill-feed-tick.ts` (replace the loop body, keep every export name)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type CursorFeedPoster = (embed: APIEmbed) => Promise<void>`
  - `type CursorFeedStore<T> = { seeded(): Promise<boolean>; head(): Promise<number>; cursor(): Promise<number>; readAfter(cursor: number, limit: number): Promise<T[]>; markPosted(eventId: number): Promise<void> }`
  - `type CursorFeedResult = { posted: number; blockedAt: number | null; seeded: boolean }`
  - `type CursorFeedRender<T> = (item: T) => APIEmbed | null`
  - `function cursorFeedTick<T extends { eventId: number }>(store, post, render, opts?): Promise<CursorFeedResult>`
  - `const DEFAULT_FEED_BATCH_SIZE = 20`
  - Unchanged from `kill-feed-tick.ts`: `KILL_FEED_CONSUMER`, `KILL_FEED_BATCH_SIZE`, `KillFeedStore`, `KillFeedPoster`, `KillFeedTickResult`, `killFeedTick`, `PgKillFeedStore`

- [ ] **Step 1: Write the failing test**

Create `apps/bot/test/cursor-feed.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { APIEmbed } from "discord.js";
import { cursorFeedTick, type CursorFeedStore } from "../src/cursor-feed.js";

type Item = { eventId: number; name: string; skip?: boolean };

/** An in-memory store: `cursor` null means never seeded. */
function fakeStore(items: Item[], cursor: number | null): CursorFeedStore<Item> & { at: () => number | null } {
  let c = cursor;
  return {
    at: () => c,
    seeded: async () => c !== null,
    head: async () => Math.max(0, ...items.map((i) => i.eventId)),
    cursor: async () => c ?? 0,
    readAfter: async (after, limit) =>
      items.filter((i) => i.eventId > after).sort((a, b) => a.eventId - b.eventId).slice(0, limit),
    markPosted: async (id) => { c = id; },
  };
}

const render = (i: Item): APIEmbed | null => (i.skip ? null : { title: i.name });

describe("cursorFeedTick", () => {
  it("⚠️ the first run seeds the cursor at the head and posts nothing — history never floods the channel", async () => {
    const store = fakeStore([{ eventId: 10, name: "a" }, { eventId: 30, name: "b" }], null);
    const post = vi.fn(async () => {});
    const r = await cursorFeedTick(store, post, render);
    expect(r).toEqual({ posted: 0, blockedAt: null, seeded: true });
    expect(post).not.toHaveBeenCalled();
    expect(store.at()).toBe(30);
  });

  it("posts every item after the cursor, oldest first, advancing as it goes", async () => {
    const store = fakeStore([{ eventId: 10, name: "a" }, { eventId: 20, name: "b" }, { eventId: 30, name: "c" }], 10);
    const post = vi.fn<(e: APIEmbed) => Promise<void>>(async () => {});
    const r = await cursorFeedTick(store, post, render);
    expect(r).toEqual({ posted: 2, blockedAt: null, seeded: false });
    expect(post.mock.calls.map(([e]) => e.title)).toEqual(["b", "c"]);
    expect(store.at()).toBe(30);
  });

  it("a null render advances the cursor without posting — the item is decided, not pending", async () => {
    const store = fakeStore([{ eventId: 10, name: "a", skip: true }, { eventId: 20, name: "b" }], 0);
    const post = vi.fn<(e: APIEmbed) => Promise<void>>(async () => {});
    const r = await cursorFeedTick(store, post, render);
    expect(r.posted).toBe(1);
    expect(post.mock.calls.map(([e]) => e.title)).toEqual(["b"]);
    expect(store.at()).toBe(20);
  });

  it("stops at the first failure and leaves the cursor on the last success", async () => {
    const store = fakeStore([{ eventId: 10, name: "a" }, { eventId: 20, name: "b" }, { eventId: 30, name: "c" }], 0);
    const post = vi.fn(async (e: APIEmbed) => { if (e.title === "b") throw new Error("discord is down"); });
    const onError = vi.fn();
    const r = await cursorFeedTick(store, post, render, { onError });
    expect(r).toEqual({ posted: 1, blockedAt: 20, seeded: false });
    expect(store.at()).toBe(10);
    expect(onError).toHaveBeenCalledWith(20, expect.any(Error));
  });

  it("honours the batch size", async () => {
    const store = fakeStore([{ eventId: 1, name: "a" }, { eventId: 2, name: "b" }, { eventId: 3, name: "c" }], 0);
    const r = await cursorFeedTick(store, async () => {}, render, { batchSize: 2 });
    expect(r.posted).toBe(2);
    expect(store.at()).toBe(2);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd apps/bot && npx vitest run test/cursor-feed.test.ts
```

Expected: FAIL — `Cannot find module '../src/cursor-feed.js'`.

- [ ] **Step 3: Write the implementation**

Create `apps/bot/src/cursor-feed.ts`:

```ts
import type { APIEmbed } from "discord.js";

export type CursorFeedPoster = (embed: APIEmbed) => Promise<void>;

/** What a feed reads and writes. `T` is one postable unit — a kill, an engagement, a milestone. */
export type CursorFeedStore<T> = {
  /** Whether the cursor row exists at all. */
  seeded(): Promise<boolean>;
  /** The newest candidate's event id, or 0 when there are none. */
  head(): Promise<number>;
  cursor(): Promise<number>;
  /** Candidates after `cursor`, oldest first. Includes items the render will decline. */
  readAfter(cursor: number, limit: number): Promise<T[]>;
  markPosted(eventId: number): Promise<void>;
};

/**
 * One item to one embed, or `null` to decline it.
 *
 * ⚠️ Declining is DECIDING, not deferring: the loop advances the cursor past a
 * declined item. That is what lets a store hand back every candidate in id
 * order — a friendly-fire kill, a short-range kill, an engagement a kill
 * already claimed — and let a pure function apply the rule, without the cursor
 * stalling on a run of items nobody wants.
 */
export type CursorFeedRender<T> = (item: T) => APIEmbed | null;

export type CursorFeedResult = {
  posted: number;
  /** The event id that ended the run, or null if the queue drained. */
  blockedAt: number | null;
  /** True on the run that created the cursor at the head, posting nothing. */
  seeded: boolean;
};

export const DEFAULT_FEED_BATCH_SIZE = 20;

/**
 * The shape every Discord feed in this bot shares: post oldest first, advance
 * the cursor after each success, and let the FIRST failure end the run so the
 * channel stays chronological.
 *
 * ⚠️ The FIRST run seeds the cursor at the head and posts nothing. `kills` and
 * `events` hold history (58 backfilled kills on launch day alone), and a
 * Discord poster that replays history announces last week to a public channel.
 * This is the opposite default to the stats projectors, which are deliberately
 * unseeded so they DO replay — they write rows, not messages.
 *
 * ⚠️ At-least-once: a crash between the post and the cursor write re-posts that
 * item on the next start. See notice-tick.ts.
 */
export async function cursorFeedTick<T extends { eventId: number }>(
  store: CursorFeedStore<T>,
  post: CursorFeedPoster,
  render: CursorFeedRender<T>,
  opts: { batchSize?: number; onError?: (eventId: number, err: unknown) => void } = {},
): Promise<CursorFeedResult> {
  const out: CursorFeedResult = { posted: 0, blockedAt: null, seeded: false };

  if (!(await store.seeded())) {
    await store.markPosted(await store.head());
    out.seeded = true;
    return out;
  }

  const cursor = await store.cursor();
  for (const item of await store.readAfter(cursor, opts.batchSize ?? DEFAULT_FEED_BATCH_SIZE)) {
    const embed = render(item);
    if (embed === null) {
      await store.markPosted(item.eventId);
      continue;
    }
    try {
      await post(embed);
      await store.markPosted(item.eventId);
    } catch (err) {
      opts.onError?.(item.eventId, err);
      out.blockedAt = item.eventId;
      return out;
    }
    out.posted++;
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/bot && npx vitest run test/cursor-feed.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Point the kill feed at the shared loop**

In `apps/bot/src/kill-feed-tick.ts`, replace the `KillFeedStore`, `KillFeedPoster`, `KillFeedTickResult` type declarations and the whole body of `killFeedTick` with the delegating versions below. **Leave `PgKillFeedStore` and the `pvp` constant exactly as they are.** Add the import at the top and drop the now-unused `APIEmbed` import if nothing else in the file uses it.

```ts
import { cursorFeedTick, type CursorFeedPoster, type CursorFeedResult, type CursorFeedStore } from "./cursor-feed.js";

/** ⚠️ Distinct from every other consumer name. Its value is the `events.id` of the last kill posted. */
export const KILL_FEED_CONSUMER = "kill-feed-poster";
export const KILL_FEED_BATCH_SIZE = 20;

export type KillFeedPoster = CursorFeedPoster;
/** What the tick reads and writes; `PgKillFeedStore` is the real one. */
export type KillFeedStore = CursorFeedStore<KillFeedItem>;
export type KillFeedTickResult = CursorFeedResult;

/**
 * Post new PvP kills to #kill-feed, oldest first. The loop lives in
 * `cursor-feed.ts` — every hazard it guards against is documented there.
 * Every kill this store returns is postable, so the render never declines.
 */
export function killFeedTick(
  store: KillFeedStore,
  post: KillFeedPoster,
  opts: { siteBaseUrl: string; flagImage?: FlagImageResolver; batchSize?: number; onError?: (eventId: number, err: unknown) => void },
): Promise<KillFeedTickResult> {
  return cursorFeedTick(store, post, (k) => killFeedEmbed(k, opts.siteBaseUrl, opts.flagImage), {
    batchSize: opts.batchSize ?? KILL_FEED_BATCH_SIZE,
    onError: opts.onError,
  });
}
```

- [ ] **Step 6: Verify the kill feed's existing tests still pass, unedited**

```bash
cd apps/bot && git diff --stat test/kill-feed-tick.test.ts
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/kill-feed-tick.test.ts test/kill-feed-store.test.ts test/kill-feed-embed.test.ts test/cursor-feed.test.ts
```

Expected: `git diff --stat` prints **nothing** (the test file is untouched), and all four suites PASS. If `kill-feed-tick.test.ts` fails, the extraction is wrong — fix `cursor-feed.ts` or the delegation, never the test.

- [ ] **Step 7: Typecheck and commit**

```bash
cd apps/bot && npx tsc --noEmit
cd ../.. && git add apps/bot/src/cursor-feed.ts apps/bot/test/cursor-feed.test.ts apps/bot/src/kill-feed-tick.ts
git commit -m "refactor(bot): extract the shared cursor feed loop

Four feeds will share post-then-advance with first-failure-stops.
kill-feed-tick.test.ts passes unedited — the regression gate."
```

---

### Task 2: The engagement grouping rule

Pure, in `@factions/domain`, because it is the piece most worth testing exhaustively and it must be testable with no database, no Discord client and no clock.

**Files:**
- Create: `packages/domain/src/hit-bursts.ts`
- Create: `packages/domain/test/hit-bursts.test.ts`
- Modify: `packages/domain/src/index.ts` (add the export line)

**Interfaces:**
- Consumes: `RECENT_HIT_WINDOW_S` from `./death-verdict.js` (already exported).
- Produces:
  - `type HitInput = { eventId: number; occurredAt: Date; attackerType: "player" | "infected" | "environment"; attackerDayzId: string | null; victimDayzId: string; weapon: string | null; damage: number | null; bodyPart: string | null; distanceM: number | null; victimHp: number | null }`
  - `type HitEngagement = { firstEventId: number; lastEventId: number; startedAt: Date; endedAt: Date; attackerDayzId: string; victimDayzId: string; weapon: string | null; hits: HitInput[]; closed: boolean }`
  - `function groupHitBursts(hits: HitInput[], opts: { frontier: Date; windowS: number }): HitEngagement[]`
  - `const DEFAULT_HIT_BURST_WINDOW_S = 60`

- [ ] **Step 1: Write the failing test**

Create `packages/domain/test/hit-bursts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { groupHitBursts, type HitInput } from "../src/hit-bursts.js";

const A = "A".repeat(40); const B = "B".repeat(40); const C = "C".repeat(40);
const t0 = new Date("2026-09-12T00:00:00Z");
const s = (n: number) => new Date(t0.getTime() + n * 1000);

let nextId = 0;
function hit(p: Partial<HitInput> & { at: number }): HitInput {
  return {
    eventId: ++nextId, occurredAt: s(p.at),
    attackerType: p.attackerType ?? "player",
    attackerDayzId: p.attackerDayzId === undefined ? A : p.attackerDayzId,
    victimDayzId: p.victimDayzId ?? B,
    weapon: p.weapon === undefined ? "KA-74" : p.weapon,
    damage: p.damage ?? 38, bodyPart: p.bodyPart ?? "Torso",
    distanceM: p.distanceM ?? 41, victimHp: p.victimHp ?? 60,
  };
}

/** Far enough past every hit that nothing is held open by the settle rule. */
const settled = { frontier: s(10_000), windowS: 60 };

describe("groupHitBursts", () => {
  it("runs of hits sharing attacker, victim and weapon become one engagement", () => {
    const out = groupHitBursts([hit({ at: 0 }), hit({ at: 2 }), hit({ at: 5 })], settled);
    expect(out).toHaveLength(1);
    expect(out[0]!.hits).toHaveLength(3);
    expect(out[0]!.attackerDayzId).toBe(A);
    expect(out[0]!.victimDayzId).toBe(B);
    expect(out[0]!.startedAt).toEqual(s(0));
    expect(out[0]!.endedAt).toEqual(s(5));
    expect(out[0]!.closed).toBe(true);
  });

  it("a gap longer than the window starts a new engagement", () => {
    const out = groupHitBursts([hit({ at: 0 }), hit({ at: 61 })], settled);
    expect(out).toHaveLength(2);
  });

  it("a gap exactly the window still joins — the window is the maximum gap, inclusive", () => {
    const out = groupHitBursts([hit({ at: 0 }), hit({ at: 60 })], settled);
    expect(out).toHaveLength(1);
  });

  it("a weapon switch splits, even with no gap at all", () => {
    const out = groupHitBursts([hit({ at: 0, weapon: "KA-74" }), hit({ at: 1, weapon: "Mosin" })], settled);
    expect(out.map((e) => e.weapon)).toEqual(["KA-74", "Mosin"]);
  });

  it("a null weapon is its own key — it never merges with the next named weapon", () => {
    const out = groupHitBursts([hit({ at: 0, weapon: null }), hit({ at: 1, weapon: "Mosin" })], settled);
    expect(out.map((e) => e.weapon)).toEqual([null, "Mosin"]);
  });

  it("different victims of the same attacker are different engagements, interleaved", () => {
    const out = groupHitBursts([hit({ at: 0, victimDayzId: B }), hit({ at: 1, victimDayzId: C }), hit({ at: 2, victimDayzId: B })], settled);
    expect(out).toHaveLength(2);
    expect(out.find((e) => e.victimDayzId === B)!.hits).toHaveLength(2);
  });

  it("PvE hits are dropped entirely", () => {
    const out = groupHitBursts([
      hit({ at: 0, attackerType: "infected", attackerDayzId: null }),
      hit({ at: 1, attackerType: "environment", attackerDayzId: null, weapon: null }),
    ], settled);
    expect(out).toEqual([]);
  });

  it("a self-inflicted hit is not PvP", () => {
    const out = groupHitBursts([hit({ at: 0, attackerDayzId: B, victimDayzId: B })], settled);
    expect(out).toEqual([]);
  });

  it("a player hit with no attacker id is dropped rather than grouped under null", () => {
    const out = groupHitBursts([hit({ at: 0, attackerDayzId: null })], settled);
    expect(out).toEqual([]);
  });

  it("⚠️ an engagement stays OPEN until it is settle-clear of the frontier, even when quiet", () => {
    // Quiet for 90s, but a finished death can still claim it up to 120s out.
    const out = groupHitBursts([hit({ at: 0 })], { frontier: s(90), windowS: 60 });
    expect(out[0]!.closed).toBe(false);
  });

  it("closes once the frontier is a full settle window past the last hit", () => {
    const out = groupHitBursts([hit({ at: 0 })], { frontier: s(120), windowS: 60 });
    expect(out[0]!.closed).toBe(true);
  });

  it("⚠️ a lagging frontier holds everything open — batched ingest must not look like quiet", () => {
    const out = groupHitBursts([hit({ at: 0 }), hit({ at: 2 })], { frontier: s(2), windowS: 60 });
    expect(out[0]!.closed).toBe(false);
  });

  it("a window longer than the settle floor governs instead", () => {
    const out = groupHitBursts([hit({ at: 0 })], { frontier: s(200), windowS: 300 });
    expect(out[0]!.closed).toBe(false);
  });

  it("carries the first and last event ids, and the hits oldest first", () => {
    nextId = 100;
    const out = groupHitBursts([hit({ at: 0 }), hit({ at: 1 }), hit({ at: 2 })], settled);
    expect(out[0]!.firstEventId).toBe(101);
    expect(out[0]!.lastEventId).toBe(103);
    expect(out[0]!.hits.map((h) => h.eventId)).toEqual([101, 102, 103]);
  });

  it("returns engagements in first-event order, so the caller can advance a cursor over them", () => {
    const out = groupHitBursts([hit({ at: 0, victimDayzId: C }), hit({ at: 1, victimDayzId: B })], settled);
    expect(out[0]!.victimDayzId).toBe(C);
    expect(out[1]!.victimDayzId).toBe(B);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd packages/domain && npx vitest run test/hit-bursts.test.ts
```

Expected: FAIL — `Cannot find module '../src/hit-bursts.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/domain/src/hit-bursts.ts`:

```ts
import { RECENT_HIT_WINDOW_S } from "./death-verdict.js";

/** The default quiet gap that closes an engagement. Overridden by `HIT_BURST_WINDOW_S`. */
export const DEFAULT_HIT_BURST_WINDOW_S = 60;

/** One `player.hit` event, flattened. Exactly what the feed needs; no coordinates, ever. */
export type HitInput = {
  eventId: number;
  occurredAt: Date;
  attackerType: "player" | "infected" | "environment";
  attackerDayzId: string | null;
  victimDayzId: string;
  weapon: string | null;
  damage: number | null;
  bodyPart: string | null;
  distanceM: number | null;
  /** The victim's HP AFTER the hit. */
  victimHp: number | null;
};

/** A run of hits sharing (attacker, victim, weapon). `closed` means no further hit can join it. */
export type HitEngagement = {
  firstEventId: number;
  lastEventId: number;
  startedAt: Date;
  endedAt: Date;
  attackerDayzId: string;
  victimDayzId: string;
  weapon: string | null;
  /** Oldest first. */
  hits: HitInput[];
  closed: boolean;
};

/** PvP only: another player, named by id. Infected, environment and self-inflicted are not fights. */
function isPvp(h: HitInput): boolean {
  return h.attackerType === "player" && h.attackerDayzId !== null && h.attackerDayzId !== h.victimDayzId;
}

/**
 * `weapon` is part of the key and may be null, which must NOT collide with a
 * weapon literally named "null" — hence the length prefix rather than a join.
 */
function keyOf(h: HitInput): string {
  const w = h.weapon === null ? "-" : `${h.weapon.length}:${h.weapon}`;
  return `${h.attackerDayzId}|${h.victimDayzId}|${w}`;
}

/**
 * Group PvP hits into engagements.
 *
 * Pure: `frontier` is the caller's notion of "now", and there is no clock here.
 *
 * ⚠️ An engagement closes only when the frontier is
 * `max(windowS, RECENT_HIT_WINDOW_S)` past its last hit. Two separate reasons,
 * both necessary:
 *
 *   - `windowS` is the quiet gap that defines the burst.
 *   - `RECENT_HIT_WINDOW_S` (120) is how far back `kills-tick`'s `verdictOf`
 *     looks to credit a *finished* death. A burst quiet for 60s can still be
 *     claimed by a death 90s later; posting it at 60s would put the same fight
 *     in #hit-feed and #kill-feed.
 *
 * Do not collapse the two into one constant. Raising `windowS` past 120 widens
 * both the burst and the delay; lowering it below 120 widens neither, because
 * the settle floor binds.
 *
 * ⚠️ `frontier` must be the INGEST frontier, not `Date.now()`. The ADM poller
 * ingests in file-sized chunks; against a wall clock, a poller ten minutes
 * behind makes every open engagement look quiet and the feed closes fights
 * that are still being fought.
 */
export function groupHitBursts(hits: HitInput[], opts: { frontier: Date; windowS: number }): HitEngagement[] {
  const settleMs = Math.max(opts.windowS, RECENT_HIT_WINDOW_S) * 1000;
  const windowMs = opts.windowS * 1000;

  const open = new Map<string, HitEngagement>();
  const out: HitEngagement[] = [];

  for (const h of [...hits].sort((a, b) => a.eventId - b.eventId)) {
    if (!isPvp(h)) continue;
    const key = keyOf(h);
    const current = open.get(key);
    if (current && h.occurredAt.getTime() - current.endedAt.getTime() <= windowMs) {
      current.hits.push(h);
      current.lastEventId = h.eventId;
      current.endedAt = h.occurredAt;
      continue;
    }
    const started: HitEngagement = {
      firstEventId: h.eventId, lastEventId: h.eventId,
      startedAt: h.occurredAt, endedAt: h.occurredAt,
      attackerDayzId: h.attackerDayzId!, victimDayzId: h.victimDayzId, weapon: h.weapon,
      hits: [h], closed: false,
    };
    open.set(key, started);
    out.push(started);
  }

  for (const e of out) e.closed = opts.frontier.getTime() - e.endedAt.getTime() >= settleMs;
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/domain && npx vitest run test/hit-bursts.test.ts
```

Expected: PASS, 15 tests.

- [ ] **Step 5: Export it from the package**

Append to `packages/domain/src/index.ts`:

```ts
export * from "./hit-bursts";
```

(No `.js` extension in this file — match the existing lines, which have none.)

- [ ] **Step 6: Typecheck and commit**

```bash
cd packages/domain && npx tsc --noEmit && npx vitest run
cd ../.. && git add packages/domain/src/hit-bursts.ts packages/domain/src/index.ts packages/domain/test/hit-bursts.test.ts
git commit -m "feat(domain): group PvP hits into engagements

Keyed on (attacker, victim, weapon). Closes only when the ingest
frontier is clear of both the quiet window and the 120s window
kills-tick uses to credit a finished death."
```

---

### Task 3: Shared detail lines, and hit detail on the kill feed

The detail line is rendered identically by #hit-feed and #kill-feed, so it lands in `kill-feed-embed.ts` and the hit feed imports it. This task also delivers the kill feed half of the spec: a kill's embed gains the run that produced it.

**Files:**
- Modify: `apps/bot/src/kill-feed-embed.ts`
- Modify: `apps/bot/src/kill-feed-tick.ts` (`PgKillFeedStore.readAfter` only)
- Modify: `apps/bot/test/kill-feed-embed.test.ts`
- Modify: `apps/bot/test/kill-feed-store.test.ts`

**Interfaces:**
- Consumes: `escapeMarkdown`, `profileUrl`, `howLine`, `KillFeedSide`, `KillFeedItem` (all already exported from `kill-feed-embed.ts`); `RECENT_HIT_WINDOW_S` from `@factions/domain`.
- Produces:
  - `type HitDetail = { damage: number | null; bodyPart: string | null; weapon: string | null; distanceM: number | null }`
  - `const DETAIL_LINE_CAP = 10`
  - `function detailLine(d: HitDetail, opts?: { weapon?: boolean }): string`
  - `function cappedLines(lines: string[], noun: string): string[]`
  - `KillFeedItem` gains `hits: HitDetail[]`

- [ ] **Step 1: Write the failing test**

Append to `apps/bot/test/kill-feed-embed.test.ts` (inside the existing top-level `describe`, or as a new one at the end of the file — match whichever the file already uses):

```ts
describe("hit detail lines", () => {
  const base = {
    eventId: 1, occurredAt: new Date("2026-09-12T01:00:00Z"),
    killer: { gamertag: "Steve", tag: "WOLF", texture: null },
    victim: { gamertag: "Dave", tag: "BEAR", texture: null },
    weapon: "KA-74", distanceM: 41, friendlyFire: false, cause: "pvp",
    tally: { killerKills: 12, victimDeaths: 3, season: 2 },
  };
  const site = "https://dayzclanwars.com";

  it("renders one line per hit, with the weapon, because a kill run can switch weapons", () => {
    const e = killFeedEmbed({ ...base, hits: [
      { damage: 38, bodyPart: "Torso", weapon: "KA-74", distanceM: 41 },
      { damage: 22, bodyPart: "Head", weapon: "Mosin", distanceM: 112 },
    ] }, site);
    expect(e.description).toContain("38 dmg · Torso · KA-74 · 41 m");
    expect(e.description).toContain("22 dmg · Head · Mosin · 112 m");
  });

  it("drops the parts the log did not give, without leaving stray separators", () => {
    const e = killFeedEmbed({ ...base, hits: [{ damage: null, bodyPart: "Torso", weapon: null, distanceM: null }] }, site);
    expect(e.description).toContain("Torso");
    expect(e.description).not.toMatch(/·\s*·/u);
    expect(e.description).not.toContain("null");
  });

  it("caps the list at ten and says how many it dropped", () => {
    const hits = Array.from({ length: 16 }, () => ({ damage: 10, bodyPart: "Torso", weapon: "KA-74", distanceM: 40 }));
    const e = killFeedEmbed({ ...base, hits }, site);
    expect(e.description).toContain("… and 6 more");
    expect(e.description!.split("\n").filter((l) => l.includes("dmg"))).toHaveLength(10);
  });

  it("⚠️ a kill with no hits behind it renders exactly as it did before — no empty block", () => {
    const withNone = killFeedEmbed({ ...base, hits: [] }, site);
    expect(withNone.description).not.toContain("dmg");
    expect(withNone.description!.endsWith(" ")).toBe(false);
    expect(withNone.description).not.toMatch(/\n\n$/u);
  });
});
```

Also add `hits: []` to every existing `KillFeedItem` literal in this file and in `apps/bot/test/kill-feed-tick.test.ts`'s `item()` helper — the type now requires it.

⚠️ Adding `hits: []` to `kill-feed-tick.test.ts`'s fixture is the one edit that file may receive; its **assertions** stay untouched.

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd apps/bot && npx vitest run test/kill-feed-embed.test.ts
```

Expected: FAIL — the new detail text is absent from `description`.

- [ ] **Step 3: Implement the shared renderer**

In `apps/bot/src/kill-feed-embed.ts`, add after the existing `howLine` function:

```ts
/** One hit, as both feeds render it. No coordinates — damage, where, what with, how far. */
export type HitDetail = {
  damage: number | null;
  bodyPart: string | null;
  weapon: string | null;
  distanceM: number | null;
};

/**
 * ⚠️ Ten, not Discord's 4096-character description limit. A sustained
 * firefight stops being readable long before it stops being legal.
 */
export const DETAIL_LINE_CAP = 10;

/**
 * `38 dmg · Torso · KA-74 · 41 m`, dropping whatever the log did not give.
 *
 * The weapon is omitted by default because #hit-feed's engagements are keyed
 * on one weapon and already name it in the header; a kill run can switch
 * weapons, so the kill feed passes `{ weapon: true }`.
 */
export function detailLine(d: HitDetail, opts: { weapon?: boolean } = {}): string {
  const parts: string[] = [];
  if (d.damage !== null && Number.isFinite(d.damage)) parts.push(`${Math.round(d.damage)} dmg`);
  if (d.bodyPart) parts.push(escapeMarkdown(d.bodyPart));
  if (opts.weapon && d.weapon) parts.push(escapeMarkdown(d.weapon));
  if (d.distanceM !== null && Number.isFinite(d.distanceM)) parts.push(`${Math.round(d.distanceM)} m`);
  return parts.join(" · ");
}

/** The first `DETAIL_LINE_CAP` lines, plus `… and N more` when there were more. */
export function cappedLines(lines: string[], noun: string): string[] {
  if (lines.length <= DETAIL_LINE_CAP) return lines;
  const extra = lines.length - DETAIL_LINE_CAP;
  return [...lines.slice(0, DETAIL_LINE_CAP), `… and ${extra} more ${noun}`];
}
```

Add `hits` to `KillFeedItem`:

```ts
  /** The killer's own hits on this victim in the RECENT_HIT_WINDOW_S before the kill, oldest first. May be empty. */
  hits: HitDetail[];
```

And in `killFeedEmbed`, after the existing `lines` array is built, append the block:

```ts
  const detail = cappedLines(k.hits.map((h) => detailLine(h, { weapon: true })).filter((l) => l !== ""), "hits");
  if (detail.length > 0) lines.push("", ...detail);
```

⚠️ `.filter((l) => l !== "")` matters: a hit the log gave nothing for renders as an empty string, and an empty line in the middle of the block reads as a formatting bug.

- [ ] **Step 4: Run the embed test to verify it passes**

```bash
cd apps/bot && npx vitest run test/kill-feed-embed.test.ts test/kill-feed-tick.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the failing store test**

Append to `apps/bot/test/kill-feed-store.test.ts`, inside the existing `describe("PgKillFeedStore")` block. It reuses that file's `mkKill` helper, `serverId`, `db`, `store`, `A`, `B`, `R` and `h()`:

```ts
  /** A player.hit event by `attacker` on `victim`. */
  async function mkHit(a: { at: Date; attacker: string | null; victim: string; damage?: number; bodyPart?: string; weapon?: string | null; distanceM?: number | null }) {
    const [file] = await db.select({ id: admFiles.id }).from(admFiles).where(sql`filename = 'f.ADM'`);
    await db.insert(events).values({
      serverId, admFileId: file!.id, lineIndex: 5000 + ids.length, type: "player.hit" as never, occurredAt: a.at,
      payload: {
        victimDayzId: a.victim, victimGamertag: "v", victimHp: 40,
        attackerType: a.attacker ? "player" : "infected",
        attackerDayzId: a.attacker, attackerGamertag: a.attacker ? "k" : null, attackerLabel: a.attacker ? null : "Infected",
        damage: a.damage ?? 38, bodyPart: a.bodyPart ?? "Torso",
        weapon: a.weapon === undefined ? "KA-74" : a.weapon, distanceM: a.distanceM === undefined ? 41 : a.distanceM,
      },
    });
    ids.push(0);
  }

  it("carries the killer's own hits on the victim, oldest first", async () => {
    const at = h(1);
    await mkHit({ at: new Date(at.getTime() - 30_000), attacker: A, victim: B, damage: 38 });
    await mkHit({ at: new Date(at.getTime() - 10_000), attacker: A, victim: B, damage: 22, weapon: "Mosin", distanceM: 112 });
    await mkKill({ at, victim: B, killer: A });
    const [item] = await store.readAfter(0, 10);
    expect(item!.hits.map((x) => x.damage)).toEqual([38, 22]);
    expect(item!.hits.map((x) => x.weapon)).toEqual(["KA-74", "Mosin"]);
  });

  it("ignores hits by anyone else, and PvE hits, on the same victim", async () => {
    const at = h(2);
    await mkHit({ at: new Date(at.getTime() - 20_000), attacker: R, victim: B });
    await mkHit({ at: new Date(at.getTime() - 15_000), attacker: null, victim: B });
    await mkHit({ at: new Date(at.getTime() - 10_000), attacker: A, victim: B, damage: 50 });
    await mkKill({ at, victim: B, killer: A });
    const [item] = await store.readAfter(0, 10);
    expect(item!.hits.map((x) => x.damage)).toEqual([50]);
  });

  it("⚠️ ignores hits older than the attribution window — an unrelated earlier fight is not this kill's run", async () => {
    const at = h(3);
    await mkHit({ at: new Date(at.getTime() - 121_000), attacker: A, victim: B, damage: 11 });
    await mkHit({ at: new Date(at.getTime() - 5_000), attacker: A, victim: B, damage: 99 });
    await mkKill({ at, victim: B, killer: A });
    const [item] = await store.readAfter(0, 10);
    expect(item!.hits.map((x) => x.damage)).toEqual([99]);
  });

  it("a kill with nothing before it carries an empty list, never null", async () => {
    await mkKill({ at: h(4), victim: B, killer: A });
    const [item] = await store.readAfter(0, 10);
    expect(item!.hits).toEqual([]);
  });
```

- [ ] **Step 6: Run it to make sure it fails**

```bash
cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/kill-feed-store.test.ts
```

Expected: FAIL — `hits` is undefined on the returned item.

- [ ] **Step 7: Implement the store read**

In `apps/bot/src/kill-feed-tick.ts`, add to the imports:

```ts
import { RECENT_HIT_WINDOW_S } from "@factions/domain";
import { events } from "@factions/db";
import type { HitDetail } from "./kill-feed-embed.js";
```

Add this private method to `PgKillFeedStore`:

```ts
  /**
   * The killer's OWN hits on this victim in the RECENT_HIT_WINDOW_S before the
   * kill — the run that produced it. Read from `events` rather than a
   * projection because nothing projects hits; `kills-tick`'s `verdictOf` reads
   * the same rows the same way.
   *
   * ⚠️ Matched on occurred_at and the two ids, never on event id order: a
   * reparse backfills hit events at the head of the log with their true
   * occurred_at, and this must still find them.
   */
  private async runOf(serverId: number, killerDayzId: string, victimDayzId: string, at: Date): Promise<HitDetail[]> {
    const from = new Date(at.getTime() - RECENT_HIT_WINDOW_S * 1000);
    const rows = await this.db.select({ payload: events.payload, occurredAt: events.occurredAt }).from(events).where(and(
      eq(events.serverId, serverId),
      eq(events.type, "player.hit"),
      gte(events.occurredAt, from), lte(events.occurredAt, at),
      sql`${events.payload}->>'victimDayzId' = ${victimDayzId}`,
      sql`${events.payload}->>'attackerDayzId' = ${killerDayzId}`,
    )).orderBy(asc(events.occurredAt));

    const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
    return rows.map((r) => {
      const p = r.payload as Record<string, unknown>;
      return {
        damage: num(p.damage), bodyPart: typeof p.bodyPart === "string" ? p.bodyPart : null,
        weapon: typeof p.weapon === "string" ? p.weapon : null, distanceM: num(p.distanceM),
      };
    });
  }
```

In `readAfter`, alongside the existing `tally` call, add the run and pass it through:

```ts
      const [tally, hits] = await Promise.all([
        this.tally(r.serverId, r.killerDayzId!, r.victimDayzId, r.occurredAt),
        this.runOf(r.serverId, r.killerDayzId!, r.victimDayzId, r.occurredAt),
      ]);
```

and add `hits,` to the pushed object.

- [ ] **Step 8: Run the tests to verify they pass**

```bash
cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/kill-feed-store.test.ts test/kill-feed-embed.test.ts test/kill-feed-tick.test.ts
```

Expected: PASS.

- [ ] **Step 9: Typecheck and commit**

```bash
cd apps/bot && npx tsc --noEmit
cd ../.. && git add apps/bot/src/kill-feed-embed.ts apps/bot/src/kill-feed-tick.ts apps/bot/test/kill-feed-embed.test.ts apps/bot/test/kill-feed-store.test.ts apps/bot/test/kill-feed-tick.test.ts
git commit -m "feat(bot): the kill feed carries the run that produced the kill

One detail line per hit by the killer on the victim in the 120s
before the death. Capped at ten. Shared with the hit feed."
```

---

### Task 4: The hit feed embed

Pure. No database, no client, no clock.

**Files:**
- Create: `apps/bot/src/hit-feed-embed.ts`
- Create: `apps/bot/test/hit-feed-embed.test.ts`

**Interfaces:**
- Consumes: `escapeMarkdown`, `profileUrl`, `detailLine`, `cappedLines`, `HitDetail`, `KillFeedSide` from `./kill-feed-embed.js`; `FlagImageResolver`, `flagLabel` from `./feed-embed.js`.
- Produces:
  - `type HitFeedItem = { eventId: number; occurredAt: Date; startedAt: Date; attacker: KillFeedSide; victim: KillFeedSide; weapon: string | null; distanceM: number | null; friendlyFire: boolean; suppressed: boolean; hits: HitDetail[]; totalDamage: number | null; victimHpAfter: number | null }`
  - `function hitFeedEmbed(i: HitFeedItem, siteBaseUrl: string, flagImage?: FlagImageResolver): APIEmbed`

- [ ] **Step 1: Write the failing test**

Create `apps/bot/test/hit-feed-embed.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { hitFeedEmbed, type HitFeedItem } from "../src/hit-feed-embed.js";

const site = "https://dayzclanwars.com";
const base: HitFeedItem = {
  eventId: 7, occurredAt: new Date("2026-09-12T01:00:41Z"), startedAt: new Date("2026-09-12T01:00:00Z"),
  attacker: { gamertag: "Steve", tag: "WOLF", texture: null },
  victim: { gamertag: "Dave", tag: "BEAR", texture: null },
  weapon: "KA-74", distanceM: 41, friendlyFire: false, suppressed: false,
  hits: [
    { damage: 38, bodyPart: "Torso", weapon: "KA-74", distanceM: 41 },
    { damage: 38, bodyPart: "Head", weapon: "KA-74", distanceM: 39 },
  ],
  totalDamage: 76, victimHpAfter: 12,
};

describe("hitFeedEmbed", () => {
  it("titles on the attacker and their tag, and links to the profile", () => {
    const e = hitFeedEmbed(base, site);
    expect(e.title).toBe("Steve [WOLF]");
    expect(e.url).toBe("https://dayzclanwars.com/players/Steve");
  });

  it("names the victim, the count and the weapon", () => {
    const e = hitFeedEmbed(base, site);
    expect(e.description).toContain("hit **[Dave](https://dayzclanwars.com/players/Dave)** [BEAR] 2 times");
    expect(e.description).toContain("KA-74");
  });

  it("says 'once' rather than '1 times'", () => {
    const e = hitFeedEmbed({ ...base, hits: [base.hits[0]!], totalDamage: 38 }, site);
    expect(e.description).toContain("once");
    expect(e.description).not.toContain("1 times");
  });

  it("totals the damage and reports the HP they were left at", () => {
    const e = hitFeedEmbed(base, site);
    expect(e.description).toContain("76 damage");
    expect(e.description).toContain("left them at 12 HP");
  });

  it("omits the HP clause when the log did not give one", () => {
    const e = hitFeedEmbed({ ...base, victimHpAfter: null }, site);
    expect(e.description).not.toContain("HP");
  });

  it("renders a detail line per hit, WITHOUT the weapon — the header already named it", () => {
    const e = hitFeedEmbed(base, site);
    expect(e.description).toContain("38 dmg · Torso · 41 m");
    expect(e.description).not.toContain("Torso · KA-74");
  });

  it("caps the detail lines at ten", () => {
    const hits = Array.from({ length: 14 }, () => ({ damage: 10, bodyPart: "Torso", weapon: "KA-74", distanceM: 40 }));
    const e = hitFeedEmbed({ ...base, hits, totalDamage: 140 }, site);
    expect(e.description).toContain("… and 4 more");
  });

  it("says friendly fire in the title and colours it amber", () => {
    const e = hitFeedEmbed({ ...base, friendlyFire: true }, site);
    expect(e.title).toContain("Friendly fire");
    expect(e.color).toBe(0xe67e22);
  });

  it("⚠️ timestamps the last hit, not the post — a delayed post still reads as when it happened", () => {
    const e = hitFeedEmbed(base, site);
    expect(e.timestamp).toBe("2026-09-12T01:00:41.000Z");
  });

  it("escapes markdown in gamertags — a name is text, never markup", () => {
    const e = hitFeedEmbed({ ...base, attacker: { gamertag: "St*e*ve", tag: null, texture: null } }, site);
    expect(e.title).toBe("St\\*e\\*ve");
  });

  it("uses the attacker's flag as the thumbnail when there is one", () => {
    const e = hitFeedEmbed({ ...base, attacker: { ...base.attacker, texture: "wolf" } }, site, (t) => `https://cdn/${t}.png`);
    expect(e.thumbnail).toEqual({ url: "https://cdn/wolf.png" });
  });

  it("a missing weapon simply drops out of the line", () => {
    const e = hitFeedEmbed({ ...base, weapon: null }, site);
    expect(e.description).not.toContain("null");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd apps/bot && npx vitest run test/hit-feed-embed.test.ts
```

Expected: FAIL — `Cannot find module '../src/hit-feed-embed.js'`.

- [ ] **Step 3: Write the implementation**

Create `apps/bot/src/hit-feed-embed.ts`:

```ts
import type { APIEmbed } from "discord.js";
import type { FlagImageResolver } from "./feed-embed.js";
import { flagLabel } from "./feed-embed.js";
import { cappedLines, detailLine, escapeMarkdown, profileUrl, type HitDetail, type KillFeedSide } from "./kill-feed-embed.js";

/**
 * One engagement, ready to render. Built by `PgHitFeedStore`; never carries a
 * position. `suppressed` means a kill claimed this run and it belongs to
 * #kill-feed instead — the render declines it, the cursor still advances.
 */
export type HitFeedItem = {
  /** The engagement's LAST event id: the feed's cursor value. */
  eventId: number;
  /** The last hit's time. */
  occurredAt: Date;
  /** The first hit's time. */
  startedAt: Date;
  attacker: KillFeedSide;
  victim: KillFeedSide;
  weapon: string | null;
  /** The last hit's distance — the engagement's representative range. */
  distanceM: number | null;
  friendlyFire: boolean;
  suppressed: boolean;
  /** Oldest first. */
  hits: HitDetail[];
  totalDamage: number | null;
  /** The victim's HP after the last hit. */
  victimHpAfter: number | null;
};

/** Duller than the kill feed's rust, so the two channels are distinguishable at a glance. */
const EMBER = 0x8c5a3c;
const AMBER = 0xe67e22;

/** `**[Name](profile)** [TAG]` — the name links to the profile; the tag is plain. */
function who(side: KillFeedSide, siteBaseUrl: string): string {
  const name = `**[${escapeMarkdown(side.gamertag)}](${profileUrl(siteBaseUrl, side.gamertag)})**`;
  return side.tag ? `${name} [${escapeMarkdown(side.tag)}]` : name;
}

/** `once`, `2 times`, `9 times`. "1 times" is not a sentence. */
function times(n: number): string {
  return n === 1 ? "once" : `${n} times`;
}

/**
 * One engagement, one embed. Pure — no client, no I/O, no clock.
 *
 * Attacker-centric, matching the kill feed: the title is the attacker, the
 * thumbnail is their clan flag, both names link to their profiles. Amber and
 * said in the title for friendly fire.
 */
export function hitFeedEmbed(i: HitFeedItem, siteBaseUrl: string, flagImage: FlagImageResolver = () => null): APIEmbed {
  const image = i.attacker.texture ? flagImage(i.attacker.texture) : null;
  const attackerTag = i.attacker.tag ? ` [${escapeMarkdown(i.attacker.tag)}]` : "";

  const head = [`hit ${who(i.victim, siteBaseUrl)} ${times(i.hits.length)}`];
  if (i.weapon) head.push(escapeMarkdown(i.weapon));

  const summary: string[] = [];
  if (i.totalDamage !== null && Number.isFinite(i.totalDamage)) summary.push(`${Math.round(i.totalDamage)} damage`);
  if (i.victimHpAfter !== null && Number.isFinite(i.victimHpAfter)) summary.push(`left them at ${Math.round(i.victimHpAfter)} HP`);

  // The weapon is deliberately not repeated per line: an engagement is keyed
  // on one weapon and the header above already named it.
  const detail = cappedLines(i.hits.map((h) => detailLine(h)).filter((l) => l !== ""), "hits");

  const lines = [head.join(" · "), ...(summary.length > 0 ? [summary.join(" · ")] : []), ...(detail.length > 0 ? ["", ...detail] : [])];

  return {
    title: `${i.friendlyFire ? "Friendly fire — " : ""}${escapeMarkdown(i.attacker.gamertag)}${attackerTag}`,
    url: profileUrl(siteBaseUrl, i.attacker.gamertag),
    description: lines.join("\n"),
    color: i.friendlyFire ? AMBER : EMBER,
    // ⚠️ The last hit's time, not the post's: a delayed post still reads as when it happened.
    timestamp: i.occurredAt.toISOString(),
    ...(image ? { thumbnail: { url: image } } : {}),
    ...(i.attacker.texture ? { fields: [{ name: "Flag", value: flagLabel(i.attacker.texture), inline: true }] } : {}),
  };
}
```

⚠️ `killFeedEmbed` puts the raw gamertag in its title; this one escapes it. That is a deliberate divergence, not an inconsistency to "fix" — the existing kill feed test pins the unescaped form.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/bot && npx vitest run test/hit-feed-embed.test.ts
```

Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
cd ../.. && git add apps/bot/src/hit-feed-embed.ts apps/bot/test/hit-feed-embed.test.ts
git commit -m "feat(bot): the hit feed embed"
```

---

### Task 5: The hit feed store

Reads `player.hit` events, groups them, decides which engagements a kill already claimed, and holds back anything the projectors have not caught up on.

**Files:**
- Create: `apps/bot/src/hit-feed-tick.ts`
- Create: `apps/bot/test/hit-feed-store.test.ts`

**Interfaces:**
- Consumes: `cursorFeedTick`, `CursorFeedStore`, `CursorFeedResult`, `CursorFeedPoster` (Task 1); `groupHitBursts`, `DEFAULT_HIT_BURST_WINDOW_S`, `HitInput` (Task 2); `HitFeedItem`, `hitFeedEmbed` (Task 4); `KILLS_CONSUMER` from `./kills-tick.js`; `membershipAt` from `./membership-tick.js`; `readCursor`, `writeCursor` from `@factions/event-log`.
- Produces:
  - `const HIT_FEED_CONSUMER = "hit-feed-poster"`
  - `class PgHitFeedStore implements CursorFeedStore<HitFeedItem>` — `constructor(db: Database, opts?: { windowS?: number })`
  - `function hitFeedTick(store, post, opts: { siteBaseUrl: string; flagImage?: FlagImageResolver; batchSize?: number; onError?: (eventId: number, err: unknown) => void }): Promise<CursorFeedResult>`

- [ ] **Step 1: Write the failing test**

Create `apps/bot/test/hit-feed-store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events, kills, players, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { writeCursor } from "@factions/event-log";
import { PgHitFeedStore } from "../src/hit-feed-tick.js";
import { KILLS_CONSUMER } from "../src/kills-tick.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(40); const B = "B".repeat(40); const R = "R".repeat(40);
const t0 = new Date("2026-09-12T00:00:00Z");
const s = (n: number) => new Date(t0.getTime() + n * 1000);

describe("PgHitFeedStore", () => {
  let db: Database;
  let serverId: number;
  let store: PgHitFeedStore;
  let line = 0;

  async function mkHit(a: { at: Date; attacker: string | null; victim: string; weapon?: string | null; damage?: number; hp?: number }) {
    const [file] = await db.select({ id: admFiles.id }).from(admFiles).where(sql`filename = 'f.ADM'`);
    const [ev] = await db.insert(events).values({
      serverId, admFileId: file!.id, lineIndex: line++, type: "player.hit" as never, occurredAt: a.at,
      payload: {
        victimDayzId: a.victim, victimGamertag: "v", victimHp: a.hp ?? 60,
        attackerType: a.attacker ? "player" : "infected",
        attackerDayzId: a.attacker, attackerGamertag: a.attacker ? "k" : null,
        attackerLabel: a.attacker ? null : "Infected",
        damage: a.damage ?? 38, bodyPart: "Torso",
        weapon: a.weapon === undefined ? "KA-74" : a.weapon, distanceM: 41,
      },
    }).returning({ id: events.id });
    return ev!.id;
  }

  /** A marker event that moves the ingest frontier forward without being a hit. */
  async function mkFrontier(at: Date) {
    const [file] = await db.select({ id: admFiles.id }).from(admFiles).where(sql`filename = 'f.ADM'`);
    const [ev] = await db.insert(events).values({
      serverId, admFileId: file!.id, lineIndex: line++, type: "player.connected" as never, occurredAt: at, payload: {},
    }).returning({ id: events.id });
    // The kills projector has seen everything up to here.
    await writeCursor(db, KILLS_CONSUMER, ev!.id);
    return ev!.id;
  }

  async function mkKill(a: { at: Date; killer: string; victim: string }) {
    const [file] = await db.select({ id: admFiles.id }).from(admFiles).where(sql`filename = 'f.ADM'`);
    const [ev] = await db.insert(events).values({
      serverId, admFileId: file!.id, lineIndex: line++, type: "player.killed" as never, occurredAt: a.at, payload: {},
    }).returning({ id: events.id });
    await db.insert(kills).values({
      serverId, eventId: ev!.id, occurredAt: a.at, victimDayzId: a.victim, killerDayzId: a.killer,
      weapon: "KA-74", distanceM: "41.0", cause: "pvp", friendlyFire: false,
    });
    return ev!.id;
  }

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table kills, seasons, players, membership_history, declarations, poles, factions, events, raw_lines, adm_files, consumer_cursors, servers restart identity cascade`);
    line = 0;
    const [srv] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = srv!.id;
    await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: t0, linesIngested: 0, complete: true });
    await db.insert(players).values([
      { dayzId: A, gamertag: "Alpha", firstSeenAt: t0, lastSeenAt: t0 },
      { dayzId: B, gamertag: "Bravo", firstSeenAt: t0, lastSeenAt: t0 },
      { dayzId: R, gamertag: "Romeo", firstSeenAt: t0, lastSeenAt: t0 },
    ]);
    store = new PgHitFeedStore(db);
  });

  it("returns one item per closed engagement, with names resolved and damage totalled", async () => {
    await mkHit({ at: s(0), attacker: A, victim: B, damage: 38 });
    await mkHit({ at: s(4), attacker: A, victim: B, damage: 38, hp: 12 });
    await mkFrontier(s(400));
    const items = await store.readAfter(0, 20);
    expect(items).toHaveLength(1);
    expect(items[0]!.attacker.gamertag).toBe("Alpha");
    expect(items[0]!.victim.gamertag).toBe("Bravo");
    expect(items[0]!.hits).toHaveLength(2);
    expect(items[0]!.totalDamage).toBe(76);
    expect(items[0]!.victimHpAfter).toBe(12);
    expect(items[0]!.suppressed).toBe(false);
  });

  it("⚠️ an engagement still open is not returned at all — the cursor must not step over it", async () => {
    await mkHit({ at: s(0), attacker: A, victim: B });
    await mkFrontier(s(30));
    expect(await store.readAfter(0, 20)).toEqual([]);
  });

  it("⚠️ an engagement a kill claimed comes back SUPPRESSED, not absent — it still advances the cursor", async () => {
    await mkHit({ at: s(0), attacker: A, victim: B });
    await mkHit({ at: s(4), attacker: A, victim: B });
    await mkKill({ at: s(6), killer: A, victim: B });
    await mkFrontier(s(400));
    const items = await store.readAfter(0, 20);
    expect(items).toHaveLength(1);
    expect(items[0]!.suppressed).toBe(true);
  });

  it("⚠️ suppression ignores the weapon, so a weapon switch before the kill does not orphan the first half", async () => {
    await mkHit({ at: s(0), attacker: A, victim: B, weapon: "KA-74" });
    await mkHit({ at: s(4), attacker: A, victim: B, weapon: "Mosin" });
    await mkKill({ at: s(6), killer: A, victim: B });
    await mkFrontier(s(400));
    const items = await store.readAfter(0, 20);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.suppressed)).toEqual([true, true]);
  });

  it("a kill by someone else does not suppress this attacker's engagement", async () => {
    await mkHit({ at: s(0), attacker: A, victim: B });
    await mkKill({ at: s(6), killer: R, victim: B });
    await mkFrontier(s(400));
    const items = await store.readAfter(0, 20);
    expect(items[0]!.suppressed).toBe(false);
  });

  it("a kill more than the attribution window after the last hit does not suppress it", async () => {
    await mkHit({ at: s(0), attacker: A, victim: B });
    await mkKill({ at: s(200), killer: A, victim: B });
    await mkFrontier(s(900));
    const items = await store.readAfter(0, 20);
    expect(items[0]!.suppressed).toBe(false);
  });

  it("⚠️ a wedged kills projector holds everything back rather than leaking fatal fights into the feed", async () => {
    await mkHit({ at: s(0), attacker: A, victim: B });
    // Ingest has run far ahead, but the kills cursor is still at 0.
    const [file] = await db.select({ id: admFiles.id }).from(admFiles).where(sql`filename = 'f.ADM'`);
    await db.insert(events).values({ serverId, admFileId: file!.id, lineIndex: line++, type: "player.connected" as never, occurredAt: s(900), payload: {} });
    expect(await store.readAfter(0, 20)).toEqual([]);
  });

  it("PvE and self-inflicted hits never reach the feed", async () => {
    await mkHit({ at: s(0), attacker: null, victim: B });
    await mkHit({ at: s(1), attacker: B, victim: B });
    await mkFrontier(s(400));
    expect(await store.readAfter(0, 20)).toEqual([]);
  });

  it("head is the newest hit event id, and seeded is false until the cursor is written", async () => {
    const id = await mkHit({ at: s(0), attacker: A, victim: B });
    expect(await store.head()).toBe(id);
    expect(await store.seeded()).toBe(false);
    await store.markPosted(id);
    expect(await store.seeded()).toBe(true);
    expect(await store.cursor()).toBe(id);
  });

  it("reads only after the cursor", async () => {
    await mkHit({ at: s(0), attacker: A, victim: B });
    const second = await mkHit({ at: s(300), attacker: A, victim: B });
    await mkFrontier(s(900));
    const items = await store.readAfter(second - 1, 20);
    expect(items).toHaveLength(1);
    expect(items[0]!.eventId).toBe(second);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/hit-feed-store.test.ts
```

Expected: FAIL — `Cannot find module '../src/hit-feed-tick.js'`.

- [ ] **Step 3: Write the implementation**

Create `apps/bot/src/hit-feed-tick.ts`:

```ts
import type { Database } from "@factions/db";
import { consumerCursors, events, factions, kills, players } from "@factions/db";
import { readCursor, writeCursor } from "@factions/event-log";
import { DEFAULT_HIT_BURST_WINDOW_S, RECENT_HIT_WINDOW_S, groupHitBursts, type HitInput } from "@factions/domain";
import { and, asc, eq, gt, gte, lte, sql } from "drizzle-orm";
import { cursorFeedTick, type CursorFeedPoster, type CursorFeedResult, type CursorFeedStore } from "./cursor-feed.js";
import type { FlagImageResolver } from "./feed-embed.js";
import { hitFeedEmbed, type HitFeedItem } from "./hit-feed-embed.js";
import { KILLS_CONSUMER } from "./kills-tick.js";
import { membershipAt } from "./membership-tick.js";

/** ⚠️ Distinct from every other consumer name. Its value is the `events.id` of the last engagement's last hit. */
export const HIT_FEED_CONSUMER = "hit-feed-poster";

/**
 * Post closed PvP engagements to #hit-feed. An engagement a kill claimed is
 * declined by the render — it belongs to #kill-feed — while still advancing
 * the cursor, because it is decided, not pending.
 */
export function hitFeedTick(
  store: CursorFeedStore<HitFeedItem>,
  post: CursorFeedPoster,
  opts: { siteBaseUrl: string; flagImage?: FlagImageResolver; batchSize?: number; onError?: (eventId: number, err: unknown) => void },
): Promise<CursorFeedResult> {
  return cursorFeedTick(store, post, (i) => (i.suppressed ? null : hitFeedEmbed(i, opts.siteBaseUrl, opts.flagImage)), {
    batchSize: opts.batchSize,
    onError: opts.onError,
  });
}

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export class PgHitFeedStore implements CursorFeedStore<HitFeedItem> {
  private readonly windowS: number;
  constructor(private readonly db: Database, opts: { windowS?: number } = {}) {
    this.windowS = opts.windowS ?? DEFAULT_HIT_BURST_WINDOW_S;
  }

  async seeded(): Promise<boolean> {
    const [row] = await this.db.select({ n: consumerCursors.lastEventId }).from(consumerCursors)
      .where(eq(consumerCursors.consumerName, HIT_FEED_CONSUMER));
    return row !== undefined;
  }

  async head(): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`coalesce(max(${events.id}), 0)::bigint` })
      .from(events).where(eq(events.type, "player.hit"));
    return Number(row?.n ?? 0);
  }

  cursor(): Promise<number> {
    return readCursor(this.db, HIT_FEED_CONSUMER);
  }

  markPosted(eventId: number): Promise<void> {
    return writeCursor(this.db, HIT_FEED_CONSUMER, eventId);
  }

  /**
   * ⚠️ "Now" for the closing test, and it is NOT the wall clock.
   *
   * It is the `occurred_at` of the event the KILLS projector has reached. That
   * is by construction at or behind the ingest frontier, so it guards two
   * hazards with one value: batched ingest cannot look like quiet, and a
   * wedged kills projector cannot let a fatal engagement slip into this feed
   * before the `kills` row that would suppress it exists.
   *
   * Null — kills has never run — means nothing closes. Correct: with no
   * projected kills there is no way to tell a fight from a killing.
   */
  private async frontier(): Promise<Date | null> {
    const killsCursor = await readCursor(this.db, KILLS_CONSUMER);
    if (killsCursor === 0) return null;
    const [row] = await this.db.select({ at: events.occurredAt }).from(events).where(eq(events.id, killsCursor));
    return row?.at ?? null;
  }

  async readAfter(cursor: number, limit: number): Promise<HitFeedItem[]> {
    const frontier = await this.frontier();
    if (frontier === null) return [];

    // ⚠️ Read more rows than engagements wanted: one engagement is many hits,
    // and a burst cut in half by the row limit would be posted twice.
    const rows = await this.db.select({ id: events.id, serverId: events.serverId, occurredAt: events.occurredAt, payload: events.payload })
      .from(events)
      .where(and(gt(events.id, cursor), eq(events.type, "player.hit"), lte(events.occurredAt, frontier)))
      .orderBy(asc(events.id))
      .limit(limit * 50);

    if (rows.length === 0) return [];

    // ⚠️ When the row limit truncated the read, the effective frontier is the
    // last row we actually saw: everything past it is unknown, and a burst
    // judged quiet against a frontier we did not read up to is a burst that
    // may still be running.
    const truncated = rows.length === limit * 50;
    const effective = truncated ? rows[rows.length - 1]!.occurredAt : frontier;

    const inputs: HitInput[] = rows.map((r) => {
      const p = r.payload as Record<string, unknown>;
      const type = p.attackerType;
      return {
        eventId: Number(r.id), occurredAt: r.occurredAt,
        attackerType: type === "player" || type === "infected" ? type : "environment",
        attackerDayzId: str(p.attackerDayzId), victimDayzId: str(p.victimDayzId) ?? "",
        weapon: str(p.weapon), damage: num(p.damage), bodyPart: str(p.bodyPart),
        distanceM: num(p.distanceM), victimHp: num(p.victimHp),
      };
    });

    const serverId = rows[0]!.serverId;
    const closed = groupHitBursts(inputs, { frontier: effective, windowS: this.windowS })
      .filter((e) => e.closed)
      .slice(0, limit);

    const out: HitFeedItem[] = [];
    for (const e of closed) {
      const last = e.hits[e.hits.length - 1]!;
      const damages = e.hits.map((h) => h.damage).filter((d): d is number => d !== null);
      const [attacker, victim, suppressed] = await Promise.all([
        this.side(serverId, e.attackerDayzId, e.endedAt),
        this.side(serverId, e.victimDayzId, e.endedAt),
        this.claimedByAKill(serverId, e.attackerDayzId, e.victimDayzId, e.startedAt, e.endedAt),
      ]);
      out.push({
        eventId: e.lastEventId, occurredAt: e.endedAt, startedAt: e.startedAt,
        attacker: attacker.side, victim: victim.side, weapon: e.weapon, distanceM: last.distanceM,
        friendlyFire: attacker.factionId !== null && attacker.factionId === victim.factionId,
        suppressed,
        hits: e.hits.map((h) => ({ damage: h.damage, bodyPart: h.bodyPart, weapon: h.weapon, distanceM: h.distanceM })),
        totalDamage: damages.length > 0 ? damages.reduce((a, b) => a + b, 0) : null,
        victimHpAfter: last.victimHp,
      });
    }
    return out;
  }

  /**
   * The name the log knows, and the clan they were in AT THE ENGAGEMENT — the
   * same rule the kill feed follows, so a member who has since left still
   * shows the clan they fought for.
   */
  private async side(serverId: number, dayzId: string, at: Date) {
    const factionId = await membershipAt(this.db, serverId, dayzId, at);
    const [p] = await this.db.select({ gamertag: players.gamertag }).from(players).where(eq(players.dayzId, dayzId));
    const [f] = factionId === null ? [] : await this.db.select({ tag: factions.tag, texture: factions.texture }).from(factions).where(eq(factions.id, factionId));
    return {
      factionId,
      // `players` is a projection and could lag one tick; the id is never shown, so fall back to a word.
      side: { gamertag: p?.gamertag ?? "Unknown", tag: f?.tag ?? null, texture: f?.texture ?? null },
    };
  }

  /**
   * ⚠️ Keyed on (attacker, victim) with NO weapon term, though the engagement
   * itself is keyed on weapon. If Steve works Dave over with a KA-74 and
   * switches to a Mosin for the kill, a weapon-keyed check would send the
   * Mosin half to #kill-feed and orphan the KA-74 half here — the same fight,
   * two channels, reading as two unrelated events.
   */
  private async claimedByAKill(serverId: number, attacker: string, victim: string, from: Date, to: Date): Promise<boolean> {
    const until = new Date(to.getTime() + RECENT_HIT_WINDOW_S * 1000);
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(kills).where(and(
      eq(kills.serverId, serverId), eq(kills.killerDayzId, attacker), eq(kills.victimDayzId, victim),
      gte(kills.occurredAt, from), lte(kills.occurredAt, until),
    ));
    return Number(row?.n ?? 0) > 0;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/hit-feed-store.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
cd apps/bot && npx tsc --noEmit
cd ../.. && git add apps/bot/src/hit-feed-tick.ts apps/bot/test/hit-feed-store.test.ts
git commit -m "feat(bot): the hit feed store

Groups player.hit into engagements, suppresses the ones a kill
claimed, and closes nothing the kills projector has not reached."
```

---

### Task 6: The killstreak feed

**Files:**
- Create: `apps/bot/src/killstreak-feed-embed.ts`
- Create: `apps/bot/src/killstreak-feed-tick.ts`
- Create: `apps/bot/test/killstreak-feed-embed.test.ts`
- Create: `apps/bot/test/killstreak-feed-store.test.ts`

**Interfaces:**
- Consumes: `cursorFeedTick`, `CursorFeedStore`, `CursorFeedResult`, `CursorFeedPoster`; `escapeMarkdown`, `profileUrl`, `cappedLines`, `KillFeedSide` from `./kill-feed-embed.js`.
- Produces:
  - `type KillstreakFeedItem = { eventId: number; occurredAt: Date; startedAt: Date; killer: KillFeedSide; streak: number | null; victims: string[] }`
  - `function killstreakFeedEmbed(i: KillstreakFeedItem, siteBaseUrl: string, flagImage?: FlagImageResolver): APIEmbed`
  - `const KILLSTREAK_FEED_CONSUMER = "killstreak-feed-poster"`
  - `const DEFAULT_KILLSTREAK_EVERY = 3`
  - `class PgKillstreakFeedStore implements CursorFeedStore<KillstreakFeedItem>`
  - `function killstreakFeedTick(store, post, opts: { siteBaseUrl: string; every: number; flagImage?: FlagImageResolver; batchSize?: number; onError?: (eventId: number, err: unknown) => void }): Promise<CursorFeedResult>`

- [ ] **Step 1: Write the failing embed test**

Create `apps/bot/test/killstreak-feed-embed.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { killstreakFeedEmbed, type KillstreakFeedItem } from "../src/killstreak-feed-embed.js";

const site = "https://dayzclanwars.com";
const base: KillstreakFeedItem = {
  eventId: 9, occurredAt: new Date("2026-09-12T01:41:00Z"), startedAt: new Date("2026-09-12T01:00:00Z"),
  killer: { gamertag: "Steve", tag: "WOLF", texture: null },
  streak: 6, victims: ["Dave", "Rob", "Amy", "Jen", "Kai", "Mo"],
};

describe("killstreakFeedEmbed", () => {
  it("leads with the number", () => {
    const e = killstreakFeedEmbed(base, site);
    expect(e.title).toBe("Steve [WOLF]");
    expect(e.description).toContain("6 kill streak");
  });

  it("lists the victims oldest first", () => {
    const e = killstreakFeedEmbed(base, site);
    expect(e.description).toContain("last 6: Dave, Rob, Amy, Jen, Kai, Mo");
  });

  it("caps a long victim list", () => {
    const victims = Array.from({ length: 15 }, (_, n) => `V${n}`);
    const e = killstreakFeedEmbed({ ...base, streak: 15, victims }, site);
    expect(e.description).toContain("… and 5 more");
  });

  it("says how long the streak has been running, from the kill times", () => {
    const e = killstreakFeedEmbed(base, site);
    expect(e.description).toContain("started 41 minutes ago");
  });

  it("⚠️ timestamps the kill, not the post", () => {
    expect(killstreakFeedEmbed(base, site).timestamp).toBe("2026-09-12T01:41:00.000Z");
  });

  it("escapes markdown in every name", () => {
    const e = killstreakFeedEmbed({ ...base, killer: { gamertag: "S*t*eve", tag: null, texture: null }, victims: ["D_ave"] }, site);
    expect(e.title).toBe("S\\*t\\*eve");
    expect(e.description).toContain("D\\_ave");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd apps/bot && npx vitest run test/killstreak-feed-embed.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the embed**

Create `apps/bot/src/killstreak-feed-embed.ts`:

```ts
import type { APIEmbed } from "discord.js";
import type { FlagImageResolver } from "./feed-embed.js";
import { flagLabel } from "./feed-embed.js";
import { cappedLines, escapeMarkdown, profileUrl, type KillFeedSide } from "./kill-feed-embed.js";

/**
 * One kill, with the streak it belongs to. `streak` is null when the kill
 * cannot carry one — friendly fire — and the render declines it.
 */
export type KillstreakFeedItem = {
  /** The milestone kill's `events.id`: the feed's cursor. */
  eventId: number;
  occurredAt: Date;
  /** The streak's FIRST kill. */
  startedAt: Date;
  killer: KillFeedSide;
  streak: number | null;
  /** The streak's victims, oldest first. */
  victims: string[];
};

const FLAME = 0xd35400;

/** "41 minutes", "2 hours", "35 seconds" — from the kill times, never from a clock. */
function elapsed(from: Date, to: Date): string {
  const s = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (s < 60) return plural(s, "second");
  if (s < 3600) return plural(Math.round(s / 60), "minute");
  return plural(Math.round(s / 3600), "hour");
}

/** One streak milestone, one embed. Pure — no client, no I/O, no clock. */
export function killstreakFeedEmbed(i: KillstreakFeedItem, siteBaseUrl: string, flagImage: FlagImageResolver = () => null): APIEmbed {
  const image = i.killer.texture ? flagImage(i.killer.texture) : null;
  const tag = i.killer.tag ? ` [${escapeMarkdown(i.killer.tag)}]` : "";
  const names = cappedLines(i.victims.map(escapeMarkdown), "more");
  const shown = names.length > 0 && names[names.length - 1]!.startsWith("… and ")
    ? `${names.slice(0, -1).join(", ")} ${names[names.length - 1]}`
    : names.join(", ");

  const lines = [
    `🔥 **${i.streak ?? 0} kill streak**`,
    ...(i.victims.length > 0 ? [`last ${i.victims.length}: ${shown}`] : []),
    `started ${elapsed(i.startedAt, i.occurredAt)} ago`,
  ];

  return {
    title: `${escapeMarkdown(i.killer.gamertag)}${tag}`,
    url: profileUrl(siteBaseUrl, i.killer.gamertag),
    description: lines.join("\n"),
    color: FLAME,
    // ⚠️ The kill's time, not the post's.
    timestamp: i.occurredAt.toISOString(),
    ...(image ? { thumbnail: { url: image } } : {}),
    ...(i.killer.texture ? { fields: [{ name: "Flag", value: flagLabel(i.killer.texture), inline: true }] } : {}),
  };
}
```

- [ ] **Step 4: Run the embed test to verify it passes**

```bash
cd apps/bot && npx vitest run test/killstreak-feed-embed.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Write the failing store test**

Create `apps/bot/test/killstreak-feed-store.test.ts`. Copy the `beforeEach`, `mkKill` helper and constants from `apps/bot/test/hit-feed-store.test.ts` (Task 5, Step 1), changing the import to `PgKillstreakFeedStore` from `../src/killstreak-feed-tick.js`, dropping `mkHit`/`mkFrontier`, and extending `mkKill` with `friendlyFire` and a nullable killer:

```ts
  async function mkKill(a: { at: Date; killer: string | null; victim: string; ff?: boolean }) {
    const [file] = await db.select({ id: admFiles.id }).from(admFiles).where(sql`filename = 'f.ADM'`);
    const [ev] = await db.insert(events).values({
      serverId, admFileId: file!.id, lineIndex: line++, type: "player.killed" as never, occurredAt: a.at, payload: {},
    }).returning({ id: events.id });
    await db.insert(kills).values({
      serverId, eventId: ev!.id, occurredAt: a.at, victimDayzId: a.victim, killerDayzId: a.killer,
      weapon: "KA-74", distanceM: "41.0", cause: a.killer ? "pvp" : "died", friendlyFire: a.ff ?? false,
    });
    return ev!.id;
  }
```

Then the cases:

```ts
  it("counts consecutive kills, oldest first", async () => {
    await mkKill({ at: s(0), killer: A, victim: B });
    await mkKill({ at: s(10), killer: A, victim: R });
    const items = await store.readAfter(0, 20);
    expect(items.map((i) => i.streak)).toEqual([1, 2]);
    expect(items[1]!.victims).toEqual(["Bravo", "Romeo"]);
    expect(items[1]!.startedAt).toEqual(s(0));
  });

  it("⚠️ a death at another player's hand resets the streak", async () => {
    await mkKill({ at: s(0), killer: A, victim: B });
    await mkKill({ at: s(10), killer: A, victim: R });
    await mkKill({ at: s(20), killer: R, victim: A });
    await mkKill({ at: s(30), killer: A, victim: B });
    const items = await store.readAfter(0, 20);
    expect(items.filter((i) => i.eventId === items[items.length - 1]!.eventId)[0]!.streak).toBe(1);
  });

  it("⚠️ a death to the environment does NOT reset it — only a player ends a streak", async () => {
    await mkKill({ at: s(0), killer: A, victim: B });
    await mkKill({ at: s(10), killer: null, victim: A });
    await mkKill({ at: s(20), killer: A, victim: R });
    const items = await store.readAfter(0, 20);
    expect(items[items.length - 1]!.streak).toBe(2);
  });

  it("⚠️ friendly fire neither advances nor breaks a streak", async () => {
    await mkKill({ at: s(0), killer: A, victim: B });
    const ff = await mkKill({ at: s(10), killer: A, victim: R, ff: true });
    await mkKill({ at: s(20), killer: A, victim: B });
    const items = await store.readAfter(0, 20);
    expect(items.find((i) => i.eventId === ff)!.streak).toBeNull();
    expect(items[items.length - 1]!.streak).toBe(2);
  });

  it("a self-kill is not a streak kill and does not break one", async () => {
    await mkKill({ at: s(0), killer: A, victim: B });
    await mkKill({ at: s(10), killer: A, victim: A });
    await mkKill({ at: s(20), killer: A, victim: R });
    expect((await store.readAfter(0, 20))[2]!.streak).toBe(2);
  });

  it("a player never killed by anyone counts all of their kills", async () => {
    await mkKill({ at: s(0), killer: A, victim: B });
    await mkKill({ at: s(10), killer: A, victim: R });
    await mkKill({ at: s(20), killer: A, victim: B });
    expect((await store.readAfter(0, 20))[2]!.streak).toBe(3);
  });

  it("⚠️ a streak spanning a season boundary keeps counting — only death ends one", async () => {
    await db.insert(seasons).values([
      { serverId, number: 1, startedAt: s(-100), endedAt: s(15) },
      { serverId, number: 2, startedAt: s(15), endedAt: null },
    ]);
    await mkKill({ at: s(0), killer: A, victim: B });
    await mkKill({ at: s(20), killer: A, victim: R });
    expect((await store.readAfter(0, 20))[1]!.streak).toBe(2);
  });

  it("resolves the killer's name and the clan they were in", async () => {
    await mkKill({ at: s(0), killer: A, victim: B });
    expect((await store.readAfter(0, 20))[0]!.killer.gamertag).toBe("Alpha");
  });

  it("head is the newest kill event id, and seeded is false until the cursor is written", async () => {
    const id = await mkKill({ at: s(0), killer: A, victim: B });
    expect(await store.head()).toBe(id);
    expect(await store.seeded()).toBe(false);
    await store.markPosted(id);
    expect(await store.seeded()).toBe(true);
  });
```

Add `seasons` to the `@factions/db` import list in this file.

- [ ] **Step 6: Run it to make sure it fails**

```bash
cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/killstreak-feed-store.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 7: Write the store and tick**

Create `apps/bot/src/killstreak-feed-tick.ts`:

```ts
import type { Database } from "@factions/db";
import { consumerCursors, events, factions, kills, players } from "@factions/db";
import { readCursor, writeCursor } from "@factions/event-log";
import { and, asc, desc, eq, gt, isNotNull, lte, sql } from "drizzle-orm";
import { cursorFeedTick, type CursorFeedPoster, type CursorFeedResult, type CursorFeedStore } from "./cursor-feed.js";
import type { FlagImageResolver } from "./feed-embed.js";
import { killstreakFeedEmbed, type KillstreakFeedItem } from "./killstreak-feed-embed.js";
import { membershipAt } from "./membership-tick.js";

/** ⚠️ Distinct from every other consumer name. */
export const KILLSTREAK_FEED_CONSUMER = "killstreak-feed-poster";
/** Post on every Nth kill of a streak. */
export const DEFAULT_KILLSTREAK_EVERY = 3;

/**
 * Post streak milestones to #killstreaks. Every PvP kill is a candidate; the
 * render declines the ones that are not milestones, which is what keeps the
 * cursor moving through ordinary kills.
 */
export function killstreakFeedTick(
  store: CursorFeedStore<KillstreakFeedItem>,
  post: CursorFeedPoster,
  opts: { siteBaseUrl: string; every: number; flagImage?: FlagImageResolver; batchSize?: number; onError?: (eventId: number, err: unknown) => void },
): Promise<CursorFeedResult> {
  const every = opts.every > 0 ? opts.every : DEFAULT_KILLSTREAK_EVERY;
  return cursorFeedTick(
    store, post,
    (i) => (i.streak !== null && i.streak > 0 && i.streak % every === 0 ? killstreakFeedEmbed(i, opts.siteBaseUrl, opts.flagImage) : null),
    { batchSize: opts.batchSize, onError: opts.onError },
  );
}

/** ⚠️ A kill BY another player — the same rule as every PvP read in the roster. */
const pvp = and(isNotNull(kills.killerDayzId), sql`${kills.killerDayzId} <> ${kills.victimDayzId}`)!;
/** A kill that counts toward a streak: PvP, and not a clanmate. */
const streakable = and(pvp, eq(kills.friendlyFire, false))!;

export class PgKillstreakFeedStore implements CursorFeedStore<KillstreakFeedItem> {
  constructor(private readonly db: Database) {}

  async seeded(): Promise<boolean> {
    const [row] = await this.db.select({ n: consumerCursors.lastEventId }).from(consumerCursors)
      .where(eq(consumerCursors.consumerName, KILLSTREAK_FEED_CONSUMER));
    return row !== undefined;
  }

  async head(): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`coalesce(max(${kills.eventId}), 0)::bigint` }).from(kills);
    return Number(row?.n ?? 0);
  }

  cursor(): Promise<number> {
    return readCursor(this.db, KILLSTREAK_FEED_CONSUMER);
  }

  markPosted(eventId: number): Promise<void> {
    return writeCursor(this.db, KILLSTREAK_FEED_CONSUMER, eventId);
  }

  async readAfter(cursor: number, limit: number): Promise<KillstreakFeedItem[]> {
    const rows = await this.db.select({
      eventId: kills.eventId, serverId: kills.serverId, occurredAt: kills.occurredAt,
      killerDayzId: kills.killerDayzId, friendlyFire: kills.friendlyFire,
    }).from(kills)
      .where(and(gt(kills.eventId, cursor), pvp))
      .orderBy(asc(kills.eventId))
      .limit(limit);

    const out: KillstreakFeedItem[] = [];
    for (const r of rows) {
      const killer = r.killerDayzId!;
      const side = await this.side(r.serverId, killer, r.occurredAt);
      if (r.friendlyFire) {
        // ⚠️ Null, not 0: friendly fire neither advances the streak nor breaks
        // it. Without that rule the cheapest 9-streak on the server is three
        // clanmates standing still.
        out.push({ eventId: Number(r.eventId), occurredAt: r.occurredAt, startedAt: r.occurredAt, killer: side, streak: null, victims: [] });
        continue;
      }
      const run = await this.runUpTo(r.serverId, killer, r.occurredAt);
      out.push({
        eventId: Number(r.eventId), occurredAt: r.occurredAt,
        startedAt: run[0]?.occurredAt ?? r.occurredAt,
        killer: side, streak: run.length,
        victims: run.map((k) => k.gamertag ?? "Unknown"),
      });
    }
    return out;
  }

  /**
   * The killer's streakable kills since the last time ANOTHER PLAYER killed
   * them, up to and including `at`.
   *
   * ⚠️ Derived at post time, never stored. A stored counter would have to be
   * rebuilt in lockstep with `kills` and would drift the first time it was
   * not; this reads the same however late the post lands.
   *
   * ⚠️ Not season-scoped, unlike the kill feed's tally. A tally asks "how well
   * is this season going"; a streak asks "how long since you died". Scoping it
   * would silently reset live streaks at the rollover.
   */
  private async runUpTo(serverId: number, killer: string, at: Date) {
    const [death] = await this.db.select({ at: kills.occurredAt }).from(kills).where(and(
      eq(kills.serverId, serverId), eq(kills.victimDayzId, killer), pvp, lte(kills.occurredAt, at),
    )).orderBy(desc(kills.occurredAt)).limit(1);

    const since = death ? sql`${kills.occurredAt} > ${death.at}` : sql`true`;
    return this.db.select({ occurredAt: kills.occurredAt, gamertag: players.gamertag })
      .from(kills)
      .leftJoin(players, eq(players.dayzId, kills.victimDayzId))
      .where(and(eq(kills.serverId, serverId), eq(kills.killerDayzId, killer), streakable, lte(kills.occurredAt, at), since))
      .orderBy(asc(kills.occurredAt));
  }

  /** The name the log knows and the clan they were in at the kill — the kill feed's rule. */
  private async side(serverId: number, dayzId: string, at: Date) {
    const factionId = await membershipAt(this.db, serverId, dayzId, at);
    const [p] = await this.db.select({ gamertag: players.gamertag }).from(players).where(eq(players.dayzId, dayzId));
    const [f] = factionId === null ? [] : await this.db.select({ tag: factions.tag, texture: factions.texture }).from(factions).where(eq(factions.id, factionId));
    return { gamertag: p?.gamertag ?? "Unknown", tag: f?.tag ?? null, texture: f?.texture ?? null };
  }
}
```

- [ ] **Step 8: Run the tests to verify they pass**

```bash
cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/killstreak-feed-store.test.ts test/killstreak-feed-embed.test.ts
```

Expected: PASS.

- [ ] **Step 9: Typecheck and commit**

```bash
cd apps/bot && npx tsc --noEmit
cd ../.. && git add apps/bot/src/killstreak-feed-embed.ts apps/bot/src/killstreak-feed-tick.ts apps/bot/test/killstreak-feed-embed.test.ts apps/bot/test/killstreak-feed-store.test.ts
git commit -m "feat(bot): the killstreak feed

Consecutive PvP kills since the last death at a player's hand.
Friendly fire neither advances nor breaks a streak; PvE deaths
do not reset one; streaks are not season-scoped."
```

---

### Task 7: The long-range feed

**Files:**
- Create: `apps/bot/src/long-range-feed-embed.ts`
- Create: `apps/bot/src/long-range-feed-tick.ts`
- Create: `apps/bot/test/long-range-feed-embed.test.ts`
- Create: `apps/bot/test/long-range-feed-store.test.ts`

**Interfaces:**
- Consumes: `cursorFeedTick`, `CursorFeedStore`, `CursorFeedResult`, `CursorFeedPoster`; `escapeMarkdown`, `profileUrl`, `KillFeedSide` from `./kill-feed-embed.js`.
- Produces:
  - `type LongRangeFeedItem = { eventId: number; occurredAt: Date; killer: KillFeedSide; victim: KillFeedSide; weapon: string | null; distanceM: number | null; friendlyFire: boolean; qualifies: boolean; personalBest: boolean; seasonRank: number | null; season: number | null }`
  - `function longRangeFeedEmbed(i: LongRangeFeedItem, siteBaseUrl: string, flagImage?: FlagImageResolver): APIEmbed`
  - `const LONG_RANGE_FEED_CONSUMER = "long-range-feed-poster"`
  - `const DEFAULT_LONG_RANGE_MIN_M = 100`
  - `const LONG_RANGE_RANK_CAP = 10`
  - `class PgLongRangeFeedStore implements CursorFeedStore<LongRangeFeedItem>` — `constructor(db: Database, opts?: { minM?: number })`
  - `function longRangeFeedTick(store, post, opts: { siteBaseUrl: string; minM: number; flagImage?: FlagImageResolver; batchSize?: number; onError?: (eventId: number, err: unknown) => void }): Promise<CursorFeedResult>`

- [ ] **Step 1: Write the failing embed test**

Create `apps/bot/test/long-range-feed-embed.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { longRangeFeedEmbed, type LongRangeFeedItem } from "../src/long-range-feed-embed.js";

const site = "https://dayzclanwars.com";
const base: LongRangeFeedItem = {
  eventId: 3, occurredAt: new Date("2026-09-12T02:00:00Z"),
  killer: { gamertag: "Steve", tag: "WOLF", texture: null },
  victim: { gamertag: "Dave", tag: "BEAR", texture: null },
  weapon: "Mosin", distanceM: 340, friendlyFire: false, qualifies: true,
  personalBest: true, seasonRank: 2, season: 4,
};

describe("longRangeFeedEmbed", () => {
  it("leads with the distance", () => {
    const e = longRangeFeedEmbed(base, site);
    expect(e.description).toContain("340 m");
  });

  it("names the victim and the weapon", () => {
    const e = longRangeFeedEmbed(base, site);
    expect(e.description).toContain("killed **[Dave](https://dayzclanwars.com/players/Dave)** [BEAR]");
    expect(e.description).toContain("Mosin");
  });

  it("says a personal best and the season rank", () => {
    const e = longRangeFeedEmbed(base, site);
    expect(e.description).toContain("Steve's longest yet");
    expect(e.description).toContain("2nd longest this season");
  });

  it("ordinalises the rank correctly", () => {
    expect(longRangeFeedEmbed({ ...base, seasonRank: 1 }, site).description).toContain("longest this season");
    expect(longRangeFeedEmbed({ ...base, seasonRank: 3 }, site).description).toContain("3rd longest");
    expect(longRangeFeedEmbed({ ...base, seasonRank: 4 }, site).description).toContain("4th longest");
  });

  it("says all-time when the kill predates every season", () => {
    const e = longRangeFeedEmbed({ ...base, season: null, seasonRank: 2 }, site);
    expect(e.description).toContain("2nd longest all-time");
  });

  it("omits each record line independently", () => {
    const neither = longRangeFeedEmbed({ ...base, personalBest: false, seasonRank: null }, site);
    expect(neither.description).not.toContain("longest");
    const onlyBest = longRangeFeedEmbed({ ...base, seasonRank: null }, site);
    expect(onlyBest.description).toContain("longest yet");
    expect(onlyBest.description).not.toContain("this season");
  });

  it("says friendly fire in the title and colours it amber", () => {
    const e = longRangeFeedEmbed({ ...base, friendlyFire: true }, site);
    expect(e.title).toContain("Friendly fire");
    expect(e.color).toBe(0xe67e22);
  });

  it("⚠️ timestamps the kill, not the post", () => {
    expect(longRangeFeedEmbed(base, site).timestamp).toBe("2026-09-12T02:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd apps/bot && npx vitest run test/long-range-feed-embed.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the embed**

Create `apps/bot/src/long-range-feed-embed.ts`:

```ts
import type { APIEmbed } from "discord.js";
import type { FlagImageResolver } from "./feed-embed.js";
import { flagLabel } from "./feed-embed.js";
import { escapeMarkdown, profileUrl, type KillFeedSide } from "./kill-feed-embed.js";

/** One long-range kill, ready to render. `distanceM` null means the log did not say — the render declines it. */
export type LongRangeFeedItem = {
  eventId: number;
  occurredAt: Date;
  killer: KillFeedSide;
  victim: KillFeedSide;
  weapon: string | null;
  distanceM: number | null;
  friendlyFire: boolean;
  /** Whether this kill clears the distance threshold. The render declines it when false. */
  qualifies: boolean;
  /** No earlier kill by this killer went further. */
  personalBest: boolean;
  /** 1-based rank within this kill's season window, or null past the cap. */
  seasonRank: number | null;
  /** The season the rank counts in; null means all-time. */
  season: number | null;
};

const STEEL = 0x4a708b;
const AMBER = 0xe67e22;

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

function who(side: KillFeedSide, siteBaseUrl: string): string {
  const name = `**[${escapeMarkdown(side.gamertag)}](${profileUrl(siteBaseUrl, side.gamertag)})**`;
  return side.tag ? `${name} [${escapeMarkdown(side.tag)}]` : name;
}

/** One long-range kill, one embed. Pure — no client, no I/O, no clock. */
export function longRangeFeedEmbed(i: LongRangeFeedItem, siteBaseUrl: string, flagImage: FlagImageResolver = () => null): APIEmbed {
  const image = i.killer.texture ? flagImage(i.killer.texture) : null;
  const tag = i.killer.tag ? ` [${escapeMarkdown(i.killer.tag)}]` : "";

  const kill = [`killed ${who(i.victim, siteBaseUrl)}`];
  if (i.weapon) kill.push(escapeMarkdown(i.weapon));

  const records: string[] = [];
  if (i.personalBest) records.push(`${escapeMarkdown(i.killer.gamertag)}'s longest yet`);
  if (i.seasonRank !== null) {
    const scope = i.season === null ? "all-time" : "this season";
    records.push(i.seasonRank === 1 ? `longest ${scope}` : `${ordinal(i.seasonRank)} longest ${scope}`);
  }

  const lines = [
    `🎯 **${i.distanceM === null ? "—" : Math.round(i.distanceM)} m**`,
    kill.join(" · "),
    ...(records.length > 0 ? [records.join(" · ")] : []),
  ];

  return {
    title: `${i.friendlyFire ? "Friendly fire — " : ""}${escapeMarkdown(i.killer.gamertag)}${tag}`,
    url: profileUrl(siteBaseUrl, i.killer.gamertag),
    description: lines.join("\n"),
    color: i.friendlyFire ? AMBER : STEEL,
    // ⚠️ The kill's time, not the post's.
    timestamp: i.occurredAt.toISOString(),
    ...(image ? { thumbnail: { url: image } } : {}),
    ...(i.killer.texture ? { fields: [{ name: "Flag", value: flagLabel(i.killer.texture), inline: true }] } : {}),
  };
}
```

- [ ] **Step 4: Run the embed test to verify it passes**

```bash
cd apps/bot && npx vitest run test/long-range-feed-embed.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Write the failing store test**

Create `apps/bot/test/long-range-feed-store.test.ts`. Reuse the `beforeEach`, constants and the `mkKill` helper from Task 6, Step 5, extended with a distance:

```ts
  async function mkKill(a: { at: Date; killer: string | null; victim: string; distanceM?: number | null; ff?: boolean }) {
    const [file] = await db.select({ id: admFiles.id }).from(admFiles).where(sql`filename = 'f.ADM'`);
    const [ev] = await db.insert(events).values({
      serverId, admFileId: file!.id, lineIndex: line++, type: "player.killed" as never, occurredAt: a.at, payload: {},
    }).returning({ id: events.id });
    await db.insert(kills).values({
      serverId, eventId: ev!.id, occurredAt: a.at, victimDayzId: a.victim, killerDayzId: a.killer,
      weapon: "Mosin", distanceM: a.distanceM === undefined ? 340 : a.distanceM === null ? null : String(a.distanceM),
      cause: a.killer ? "pvp" : "died", friendlyFire: a.ff ?? false,
    });
    return ev!.id;
  }
```

The store is constructed as `new PgLongRangeFeedStore(db, { minM: 100 })`. The cases:

```ts
  it("returns qualifying kills with their distance", async () => {
    await mkKill({ at: s(0), killer: A, victim: B, distanceM: 340 });
    const [item] = await store.readAfter(0, 20);
    expect(item!.distanceM).toBe(340);
    expect(item!.qualifies).toBe(true);
  });

  it("the threshold is inclusive", async () => {
    await mkKill({ at: s(0), killer: A, victim: B, distanceM: 100 });
    expect((await store.readAfter(0, 20))[0]!.qualifies).toBe(true);
  });

  it("a shorter kill comes back NOT qualifying, not absent — it still advances the cursor", async () => {
    await mkKill({ at: s(0), killer: A, victim: B, distanceM: 40 });
    const items = await store.readAfter(0, 20);
    expect(items).toHaveLength(1);
    expect(items[0]!.qualifies).toBe(false);
  });

  it("⚠️ a null distance is skipped, never read as zero — the log simply did not say", async () => {
    await mkKill({ at: s(0), killer: A, victim: B, distanceM: null });
    const items = await store.readAfter(0, 20);
    expect(items[0]!.distanceM).toBeNull();
    expect(items[0]!.qualifies).toBe(false);
  });

  it("marks a personal best, and stops marking it once beaten", async () => {
    await mkKill({ at: s(0), killer: A, victim: B, distanceM: 300 });
    await mkKill({ at: s(10), killer: A, victim: R, distanceM: 200 });
    const items = await store.readAfter(0, 20);
    expect(items[0]!.personalBest).toBe(true);
    expect(items[1]!.personalBest).toBe(false);
  });

  it("ranks within the season the kill belongs to", async () => {
    await db.insert(seasons).values({ serverId, number: 1, startedAt: s(-100), endedAt: null });
    await mkKill({ at: s(0), killer: A, victim: B, distanceM: 400 });
    await mkKill({ at: s(10), killer: R, victim: B, distanceM: 300 });
    const items = await store.readAfter(0, 20);
    expect(items[0]!.season).toBe(1);
    expect(items[0]!.seasonRank).toBe(1);
    expect(items[1]!.seasonRank).toBe(2);
  });

  it("a kill before any season ranks all-time", async () => {
    await mkKill({ at: s(0), killer: A, victim: B, distanceM: 400 });
    expect((await store.readAfter(0, 20))[0]!.season).toBeNull();
  });

  it("⚠️ omits a rank past the cap — '17th longest' is not a highlight", async () => {
    for (let n = 0; n < 11; n++) await mkKill({ at: s(n), killer: A, victim: B, distanceM: 500 - n });
    const items = await store.readAfter(0, 20);
    expect(items[10]!.seasonRank).toBeNull();
  });

  it("friendly fire is included — a 400 m shot is remarkable regardless of who it hit", async () => {
    await mkKill({ at: s(0), killer: A, victim: B, distanceM: 400, ff: true });
    const [item] = await store.readAfter(0, 20);
    expect(item!.qualifies).toBe(true);
    expect(item!.friendlyFire).toBe(true);
  });

  it("head is the newest kill event id, and seeded is false until the cursor is written", async () => {
    const id = await mkKill({ at: s(0), killer: A, victim: B });
    expect(await store.head()).toBe(id);
    expect(await store.seeded()).toBe(false);
    await store.markPosted(id);
    expect(await store.seeded()).toBe(true);
  });
```

Add `seasons` to the `@factions/db` import list.

- [ ] **Step 6: Run it to make sure it fails**

```bash
cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/long-range-feed-store.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 7: Write the store and tick**

Create `apps/bot/src/long-range-feed-tick.ts`:

```ts
import type { Database } from "@factions/db";
import { consumerCursors, factions, kills, players, seasons } from "@factions/db";
import { readCursor, writeCursor } from "@factions/event-log";
import { and, asc, desc, eq, gt, gte, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { cursorFeedTick, type CursorFeedPoster, type CursorFeedResult, type CursorFeedStore } from "./cursor-feed.js";
import type { FlagImageResolver } from "./feed-embed.js";
import { longRangeFeedEmbed, type LongRangeFeedItem } from "./long-range-feed-embed.js";
import { membershipAt } from "./membership-tick.js";

/** ⚠️ Distinct from every other consumer name. */
export const LONG_RANGE_FEED_CONSUMER = "long-range-feed-poster";
export const DEFAULT_LONG_RANGE_MIN_M = 100;
/** ⚠️ Past this, the rank is omitted: "17th longest this season" is not a highlight. */
export const LONG_RANGE_RANK_CAP = 10;

/** Post long-range PvP kills. Every PvP kill is a candidate; the render declines the short ones. */
export function longRangeFeedTick(
  store: CursorFeedStore<LongRangeFeedItem>,
  post: CursorFeedPoster,
  opts: { siteBaseUrl: string; minM: number; flagImage?: FlagImageResolver; batchSize?: number; onError?: (eventId: number, err: unknown) => void },
): Promise<CursorFeedResult> {
  return cursorFeedTick(store, post, (i) => (i.qualifies ? longRangeFeedEmbed(i, opts.siteBaseUrl, opts.flagImage) : null), {
    batchSize: opts.batchSize,
    onError: opts.onError,
  });
}

/** ⚠️ A kill BY another player — the same rule as every PvP read in the roster. */
const pvp = and(isNotNull(kills.killerDayzId), sql`${kills.killerDayzId} <> ${kills.victimDayzId}`)!;

export class PgLongRangeFeedStore implements CursorFeedStore<LongRangeFeedItem> {
  private readonly minM: number;
  constructor(private readonly db: Database, opts: { minM?: number } = {}) {
    this.minM = opts.minM ?? DEFAULT_LONG_RANGE_MIN_M;
  }

  async seeded(): Promise<boolean> {
    const [row] = await this.db.select({ n: consumerCursors.lastEventId }).from(consumerCursors)
      .where(eq(consumerCursors.consumerName, LONG_RANGE_FEED_CONSUMER));
    return row !== undefined;
  }

  async head(): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`coalesce(max(${kills.eventId}), 0)::bigint` }).from(kills);
    return Number(row?.n ?? 0);
  }

  cursor(): Promise<number> {
    return readCursor(this.db, LONG_RANGE_FEED_CONSUMER);
  }

  markPosted(eventId: number): Promise<void> {
    return writeCursor(this.db, LONG_RANGE_FEED_CONSUMER, eventId);
  }

  async readAfter(cursor: number, limit: number): Promise<LongRangeFeedItem[]> {
    const rows = await this.db.select({
      eventId: kills.eventId, serverId: kills.serverId, occurredAt: kills.occurredAt,
      killerDayzId: kills.killerDayzId, victimDayzId: kills.victimDayzId,
      weapon: kills.weapon, distanceM: kills.distanceM, friendlyFire: kills.friendlyFire,
    }).from(kills)
      .where(and(gt(kills.eventId, cursor), pvp))
      .orderBy(asc(kills.eventId))
      .limit(limit);

    const out: LongRangeFeedItem[] = [];
    for (const r of rows) {
      // ⚠️ Null is "the log did not say", not zero. Reading it as 0 would be a
      // lie in the one direction this feed cares about.
      const distanceM = r.distanceM === null ? null : Number(r.distanceM);
      const qualifies = distanceM !== null && Number.isFinite(distanceM) && distanceM >= this.minM;

      const base = {
        eventId: Number(r.eventId), occurredAt: r.occurredAt, weapon: r.weapon,
        distanceM, friendlyFire: r.friendlyFire, qualifies,
      };

      if (!qualifies) {
        // Nothing is rendered, so nothing needs resolving — skip four queries.
        out.push({ ...base, killer: blank(), victim: blank(), personalBest: false, seasonRank: null, season: null });
        continue;
      }

      const [killer, victim, records] = await Promise.all([
        this.side(r.serverId, r.killerDayzId!, r.occurredAt),
        this.side(r.serverId, r.victimDayzId, r.occurredAt),
        this.records(r.serverId, r.killerDayzId!, distanceM, r.occurredAt),
      ]);
      out.push({ ...base, killer, victim, ...records });
    }
    return out;
  }

  /**
   * "Longest yet" and the season rank, both counted UP TO AND INCLUDING this
   * kill — so the line reads the same however late the post lands. The same
   * rule the kill feed's tally follows.
   */
  private async records(serverId: number, killer: string, distanceM: number, at: Date) {
    const [season] = await this.db.select({ number: seasons.number, startedAt: seasons.startedAt, endedAt: seasons.endedAt })
      .from(seasons)
      .where(and(eq(seasons.serverId, serverId), lte(seasons.startedAt, at), or(isNull(seasons.endedAt), gt(seasons.endedAt, at))))
      .orderBy(desc(seasons.number)).limit(1);

    const inWindow = season
      ? and(gte(kills.occurredAt, season.startedAt), season.endedAt ? lt(kills.occurredAt, season.endedAt) : sql`true`)!
      : sql`true`;
    const further = sql`${kills.distanceM} > ${String(distanceM)}`;

    const count = (where: ReturnType<typeof and>) =>
      this.db.select({ n: sql<number>`count(*)::int` }).from(kills).where(where).then((r) => Number(r[0]?.n ?? 0));

    const [byKiller, ahead] = await Promise.all([
      count(and(eq(kills.serverId, serverId), pvp, lte(kills.occurredAt, at), eq(kills.killerDayzId, killer), further)),
      count(and(eq(kills.serverId, serverId), pvp, inWindow, lte(kills.occurredAt, at), further)),
    ]);

    const rank = ahead + 1;
    return { personalBest: byKiller === 0, seasonRank: rank <= LONG_RANGE_RANK_CAP ? rank : null, season: season?.number ?? null };
  }

  private async side(serverId: number, dayzId: string, at: Date) {
    const factionId = await membershipAt(this.db, serverId, dayzId, at);
    const [p] = await this.db.select({ gamertag: players.gamertag }).from(players).where(eq(players.dayzId, dayzId));
    const [f] = factionId === null ? [] : await this.db.select({ tag: factions.tag, texture: factions.texture }).from(factions).where(eq(factions.id, factionId));
    return { gamertag: p?.gamertag ?? "Unknown", tag: f?.tag ?? null, texture: f?.texture ?? null };
  }
}

/** A side nothing will render. Only ever reached for a kill the feed declines. */
function blank() {
  return { gamertag: "Unknown", tag: null, texture: null };
}
```

- [ ] **Step 8: Run the tests to verify they pass**

```bash
cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/long-range-feed-store.test.ts test/long-range-feed-embed.test.ts
```

Expected: PASS.

- [ ] **Step 9: Typecheck and commit**

```bash
cd apps/bot && npx tsc --noEmit
cd ../.. && git add apps/bot/src/long-range-feed-embed.ts apps/bot/src/long-range-feed-tick.ts apps/bot/test/long-range-feed-embed.test.ts apps/bot/test/long-range-feed-store.test.ts
git commit -m "feat(bot): the long-range feed

PvP kills at 100 m or more, with a personal-best line and a season
rank. A null distance is skipped, never read as zero."
```

---

### Task 8: Configuration, wiring and the runbook

**Files:**
- Modify: `apps/bot/src/config.ts`
- Modify: `apps/bot/src/discord.ts`
- Modify: `.env`, `.env.production`
- Create: `docs/deploy/2026-09-12-combat-feeds.md`

**Interfaces:**
- Consumes: everything produced by Tasks 1 and 4–7.
- Produces: `BotConfig` gains `hitFeedChannelId?: string`, `killstreakFeedChannelId?: string`, `longRangeFeedChannelId?: string`, `hitBurstWindowS: number`, `killstreakEvery: number`, `longRangeMinM: number`.

- [ ] **Step 1: Add the config fields**

In `apps/bot/src/config.ts`, beside the existing `killFeedChannelId` declaration in the `BotConfig` type:

```ts
  /** #hit-feed. Optional: the hit feed is off unless deliberately turned on. */
  hitFeedChannelId?: string;
  /** #killstreaks. Optional, off unless set. */
  killstreakFeedChannelId?: string;
  /** #long-range. Optional, off unless set. */
  longRangeFeedChannelId?: string;
  /** The quiet gap that closes a hit engagement. ⚠️ The 120s settle floor still binds below this. */
  hitBurstWindowS: number;
  /** Post on every Nth kill of a streak. */
  killstreakEvery: number;
  /** Minimum distance, in metres, for #long-range. */
  longRangeMinM: number;
```

And beside the existing `killFeedChannelId` line in the returned object:

```ts
    hitFeedChannelId: optionalSnowflake(env, "HIT_FEED_CHANNEL_ID"),
    killstreakFeedChannelId: optionalSnowflake(env, "KILLSTREAK_FEED_CHANNEL_ID"),
    longRangeFeedChannelId: optionalSnowflake(env, "LONG_RANGE_FEED_CHANNEL_ID"),
    hitBurstWindowS: positiveInt(env, "HIT_BURST_WINDOW_S", DEFAULT_HIT_BURST_WINDOW_S),
    killstreakEvery: positiveInt(env, "KILLSTREAK_EVERY", DEFAULT_KILLSTREAK_EVERY),
    longRangeMinM: positiveInt(env, "LONG_RANGE_MIN_M", DEFAULT_LONG_RANGE_MIN_M),
```

with the imports:

```ts
import { DEFAULT_HIT_BURST_WINDOW_S } from "@factions/domain";
import { DEFAULT_KILLSTREAK_EVERY } from "./killstreak-feed-tick.js";
import { DEFAULT_LONG_RANGE_MIN_M } from "./long-range-feed-tick.js";
```

- [ ] **Step 2: Verify config loads**

```bash
cd apps/bot && npx tsc --noEmit && npx vitest run
```

Expected: PASS. If a config test asserts an exact `BotConfig` shape, extend that fixture with the six new fields.

- [ ] **Step 3: Wire the three feeds**

In `apps/bot/src/discord.ts`, beside the existing kill feed construction (around line 452):

```ts
  const hitFeedPoster = cfg.hitFeedChannelId ? createFeedPoster(client, cfg.hitFeedChannelId) : null;
  const hitFeedStore = new PgHitFeedStore(db, { windowS: cfg.hitBurstWindowS });
  const killstreakFeedPoster = cfg.killstreakFeedChannelId ? createFeedPoster(client, cfg.killstreakFeedChannelId) : null;
  const killstreakFeedStore = new PgKillstreakFeedStore(db);
  const longRangeFeedPoster = cfg.longRangeFeedChannelId ? createFeedPoster(client, cfg.longRangeFeedChannelId) : null;
  const longRangeFeedStore = new PgLongRangeFeedStore(db, { minM: cfg.longRangeMinM });
```

Beside `const killFeedFailures = new Set<number>();` (around line 611):

```ts
  const hitFeedFailures = new Set<number>();
  const killstreakFeedFailures = new Set<number>();
  const longRangeFeedFailures = new Set<number>();
  let lastReportedHitFeedBlockedAt: number | null = null;
  let lastReportedKillstreakFeedBlockedAt: number | null = null;
  let lastReportedLongRangeFeedBlockedAt: number | null = null;
```

And immediately after the existing `if (killFeedPoster) { … }` block in the tick body, three blocks in the same shape. All three go **after** the kill feed so a kill and every feed derived from it land in one tick:

```ts
    // ⚠️ After killFeedTick: #hit-feed suppresses engagements a kill claimed,
    // and reads the kills-projector cursor to decide what is safe to close.
    if (hitFeedPoster) {
      try {
        const r = await hitFeedTick(hitFeedStore, hitFeedPoster, {
          siteBaseUrl: cfg.siteBaseUrl,
          flagImage: flagImageResolver(cfg.flagImageBaseUrl),
          onError: (id, err) => {
            if (hitFeedFailures.has(id)) return;
            hitFeedFailures.add(id);
            console.error(`hit feed post failed for engagement ending at event ${id}`, err);
          },
        });
        if (r.seeded) console.log("hit feed: cursor seeded at the head; history is not posted");
        if (r.posted > 0) console.log(`hit feed posted ${r.posted}`);
        if (r.blockedAt !== null && r.blockedAt !== lastReportedHitFeedBlockedAt) {
          console.error(
            `hit feed blocked at event ${r.blockedAt}; nothing behind it will post ` +
            `until this one succeeds. Check the bot's View Channel / Send Messages / Embed Links permission on ${cfg.hitFeedChannelId}.`,
          );
          lastReportedHitFeedBlockedAt = r.blockedAt;
        }
      } catch (err) {
        console.error("hit feed tick failed", err);
      }
    }

    if (killstreakFeedPoster) {
      try {
        const r = await killstreakFeedTick(killstreakFeedStore, killstreakFeedPoster, {
          siteBaseUrl: cfg.siteBaseUrl,
          every: cfg.killstreakEvery,
          flagImage: flagImageResolver(cfg.flagImageBaseUrl),
          onError: (id, err) => {
            if (killstreakFeedFailures.has(id)) return;
            killstreakFeedFailures.add(id);
            console.error(`killstreak feed post failed for kill event ${id}`, err);
          },
        });
        if (r.seeded) console.log("killstreak feed: cursor seeded at the head; history is not posted");
        if (r.posted > 0) console.log(`killstreak feed posted ${r.posted}`);
        if (r.blockedAt !== null && r.blockedAt !== lastReportedKillstreakFeedBlockedAt) {
          console.error(
            `killstreak feed blocked at kill event ${r.blockedAt}; nothing behind it will post ` +
            `until this one succeeds. Check the bot's View Channel / Send Messages / Embed Links permission on ${cfg.killstreakFeedChannelId}.`,
          );
          lastReportedKillstreakFeedBlockedAt = r.blockedAt;
        }
      } catch (err) {
        console.error("killstreak feed tick failed", err);
      }
    }

    if (longRangeFeedPoster) {
      try {
        const r = await longRangeFeedTick(longRangeFeedStore, longRangeFeedPoster, {
          siteBaseUrl: cfg.siteBaseUrl,
          minM: cfg.longRangeMinM,
          flagImage: flagImageResolver(cfg.flagImageBaseUrl),
          onError: (id, err) => {
            if (longRangeFeedFailures.has(id)) return;
            longRangeFeedFailures.add(id);
            console.error(`long range feed post failed for kill event ${id}`, err);
          },
        });
        if (r.seeded) console.log("long range feed: cursor seeded at the head; history is not posted");
        if (r.posted > 0) console.log(`long range feed posted ${r.posted}`);
        if (r.blockedAt !== null && r.blockedAt !== lastReportedLongRangeFeedBlockedAt) {
          console.error(
            `long range feed blocked at kill event ${r.blockedAt}; nothing behind it will post ` +
            `until this one succeeds. Check the bot's View Channel / Send Messages / Embed Links permission on ${cfg.longRangeFeedChannelId}.`,
          );
          lastReportedLongRangeFeedBlockedAt = r.blockedAt;
        }
      } catch (err) {
        console.error("long range feed tick failed", err);
      }
    }
```

With the imports at the top of the file:

```ts
import { PgHitFeedStore, hitFeedTick } from "./hit-feed-tick.js";
import { PgKillstreakFeedStore, killstreakFeedTick } from "./killstreak-feed-tick.js";
import { PgLongRangeFeedStore, longRangeFeedTick } from "./long-range-feed-tick.js";
```

- [ ] **Step 4: Set the channel ids**

Append to both `.env` and `.env.production`, beside the existing `KILL_FEED_CHANNEL_ID` line:

```
HIT_FEED_CHANNEL_ID=1548401025038426334
KILLSTREAK_FEED_CHANNEL_ID=1548459035936821358
LONG_RANGE_FEED_CHANNEL_ID=1548459101116178513
```

⚠️ `.env.production` is gitignored along with `.env`; edit both by hand and do not attempt to commit them.

- [ ] **Step 5: Run the full gate**

```bash
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx turbo run typecheck test --concurrency=1 --force
```

Expected: **26/26 tasks** successful. Confirm the count, not just the exit code, and confirm the new suites appear in the output: `hit-bursts`, `cursor-feed`, `hit-feed-embed`, `hit-feed-store`, `killstreak-feed-embed`, `killstreak-feed-store`, `long-range-feed-embed`, `long-range-feed-store`.

- [ ] **Step 6: Write the runbook**

Create `docs/deploy/2026-09-12-combat-feeds.md`:

```markdown
# Combat feeds — deploy

Three new Discord feeds. Each is off until its channel id is set, and each seeds its
cursor at the head on its first run, posting nothing historical.

## Channels

| Channel | Env | Id |
|---|---|---|
| #hit-feed | `HIT_FEED_CHANNEL_ID` | `1548401025038426334` |
| #killstreaks | `KILLSTREAK_FEED_CHANNEL_ID` | `1548459035936821358` |
| #long-range | `LONG_RANGE_FEED_CHANNEL_ID` | `1548459101116178513` |

## Tuning

| Env | Default | Meaning |
|---|---|---|
| `HIT_BURST_WINDOW_S` | `60` | Quiet gap that closes an engagement |
| `KILLSTREAK_EVERY` | `3` | Post on every Nth kill of a streak |
| `LONG_RANGE_MIN_M` | `100` | Minimum distance for #long-range |

⚠️ Lowering `HIT_BURST_WINDOW_S` below 120 does NOT make #hit-feed faster. A separate
120-second floor — `RECENT_HIT_WINDOW_S`, how far back `kills-tick` looks to credit a
finished death — holds every engagement until a late kill can no longer claim it.

## Permissions

The bot needs **View Channel**, **Send Messages** and **Embed Links** on all three. A feed
that cannot post logs `<name> feed blocked at …` once and stops; nothing behind the blocked
item posts until it succeeds, by design, so the channel stays chronological.

## Steps

1. Add the six variables above to `.env` (and `.env.production` on the host).
2. Restart the bot: `set -a && . ./.env && set +a && pnpm --filter @factions/bot start`.
   No migration, no container rebuild — the bot is not containerised.
3. Watch for three `cursor seeded at the head` lines on the first tick. They appear once
   each, ever.
4. Confirm a post in each channel after the next fight.

## Turning one off

Unset its channel id and restart. The cursor row stays where it is, so re-enabling it later
resumes from that point rather than replaying — if the gap is large, delete the consumer's
row from `consumer_cursors` before restarting to have it re-seed at the head instead.

Consumer names: `hit-feed-poster`, `killstreak-feed-poster`, `long-range-feed-poster`.
```

- [ ] **Step 7: Commit**

```bash
git add apps/bot/src/config.ts apps/bot/src/discord.ts docs/deploy/2026-09-12-combat-feeds.md
git commit -m "feat(bot): wire the hit, killstreak and long-range feeds

Three optional channel ids, three tunables, all off when unset.
Each tick runs after the kill feed so a kill and every feed
derived from it land together."
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Part 1 — the engagement, PvP-only, weapon in the key | 2 |
| Part 1 — suppression ignoring weapon | 5 |
| Part 1 — the settle floor and the ingest frontier | 2 (rule), 5 (frontier source) |
| Part 1 — the kills-projector guard | 5 |
| Part 1 — hit feed embed, detail lines, cap | 3, 4 |
| Part 1 — kill feed carries the run | 3 |
| Part 2 — streak count, reset rule, friendly fire, not season-scoped | 6 |
| Part 2 — killstreak embed, victim list, elapsed | 6 |
| Part 3 — threshold, null distance, records, rank cap | 7 |
| Part 4 — the shared loop, kill-feed tests unedited | 1 |
| Configuration — six env vars, consumer names, seed at head | 8 |

**Type consistency:** `KillFeedSide` is the one side type across all four embeds. `HitDetail` and `cappedLines` are defined once in `kill-feed-embed.ts` and imported by `hit-feed-embed.ts`. `CursorFeedStore<T>` requires `T extends { eventId: number }`, satisfied by `KillFeedItem`, `HitFeedItem`, `KillstreakFeedItem` and `LongRangeFeedItem`.

**One deliberate divergence:** `killFeedEmbed` leaves the title's gamertag unescaped (its existing test pins that); the three new embeds escape it. Noted at the point it matters in Task 4.
