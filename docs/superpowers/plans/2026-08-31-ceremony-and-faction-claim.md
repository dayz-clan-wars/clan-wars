# Ceremony Detection and Faction Claim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A faction comes into existence by being founded in-game — three linked players raise the neutral flag at one pole, the log proves it, and the faction is ACTIVE only once its own flag physically goes up.

**Architecture:** A fourth event-log consumer (`ceremony-detector`) reads `flag.raised` events, records qualifying neutral-flag raises into a small projection, settles fixed 10-minute windows against the log's own high-water mark, and DMs the participants. `/faction claim` reserves name/tag/flag and a pruned roster; the same tick activates the reservation when it observes that flag raised at that pole by a roster member.

**Tech Stack:** TypeScript, pnpm workspaces, Drizzle ORM on Postgres 16, discord.js v14, vitest.

**Spec:** `docs/superpowers/specs/2026-08-31-ceremony-and-faction-claim-design.md`

## Global Constraints

- **Postgres on host port 5434.** Ports 5432 and 5433 belong to other projects on this machine — never stop, remove, or repoint their containers. DB suites need `TEST_DATABASE_URL=postgres://factions:factions@localhost:5434/factions`.
- **Start the database first:** `docker compose up -d postgres`. Docker Desktop must be running.
- **Full suite:** `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm run ci`. Expected at plan start: **16 tasks, 255 tests, 0 skipped**. Check the test count, not just the exit code — turbo can report success while silently skipping DB suites.
- **The neutral flag is `Flag_White`.** It is reserved and never claimable.
- **33 claimable flags per server.** Do not expand the pool; scarcity is a designed feature (spec §3).
- **Ceremony window: 10 minutes. Provisional expiry: 24h. Reservation expiry: 24h.**
- **Never pre-read then write.** Guard every state transition on the state it assumed, in the same statement, and read its own `.returning()`. Plan 2 needed this correction twice.
- **Migrations are generated, never hand-written:** `cd packages/db && pnpm generate`, then inspect the emitted SQL before committing it.
- **Commit after every task.** Co-author trailer as in recent history.

---

### Why the detector is a separate consumer

`verificationTick` (`identity-verifier`) and the projector (`pole-projector`) already read this log. A third cursor name is mandatory: two consumers sharing a cursor name each skip the other's events, and the symptom is "detection randomly doesn't work" rather than an error.

### Why `white_raises` exists

It makes the 10-minute look-back an indexed range scan rather than a JSON predicate over all of `events`, and — more importantly — it decouples *recording* a raise from *settling* a window. The cursor advances when raises are recorded; if settling then throws, nothing is lost, because the raises are already durable and the next pass settles them. Do not merge these two phases.

---

### Task 1: The claimable flag pool

**Files:**
- Create: `packages/domain/src/flags.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/flags.test.ts`

**Interfaces:**
- Produces: `NEUTRAL_FLAG: "Flag_White"`, `CLAIMABLE_FLAGS: readonly string[]` (33 entries), `isClaimableFlag(texture: string): boolean`, `armbandFor(texture: string): string | null`

- [ ] **Step 1: Write the failing test**

```ts
// packages/domain/test/flags.test.ts
import { describe, it, expect } from "vitest";
import { CLAIMABLE_FLAGS, NEUTRAL_FLAG, isClaimableFlag, armbandFor } from "../src/flags.js";

describe("flag pool", () => {
  it("offers exactly 33 claimable flags", () => {
    expect(CLAIMABLE_FLAGS).toHaveLength(33);
  });

  it("never offers the neutral flag", () => {
    // Flag_White is the unclaimed state and the ceremony's enforcement hook.
    // A faction holding it would make every pole look unclaimed.
    expect(NEUTRAL_FLAG).toBe("Flag_White");
    expect(CLAIMABLE_FLAGS).not.toContain(NEUTRAL_FLAG);
    expect(isClaimableFlag(NEUTRAL_FLAG)).toBe(false);
  });

  it("has no duplicates", () => {
    expect(new Set(CLAIMABLE_FLAGS).size).toBe(CLAIMABLE_FLAGS.length);
  });

  it("derives the armband by substitution", () => {
    expect(armbandFor("Flag_Zenit")).toBe("Armband_Zenit");
  });

  it("refuses an armband for anything outside the pool", () => {
    // A 1:1 mapping only holds for the 33. Returning a plausible-looking
    // string for an unknown texture would invent an item that does not exist.
    expect(armbandFor("Flag_Nonsense")).toBeNull();
    expect(armbandFor(NEUTRAL_FLAG)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @factions/domain test flags`
Expected: FAIL — cannot resolve `../src/flags.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/domain/src/flags.ts

/**
 * The unclaimed flag. Reserved: every pole starts here, and the ceremony is
 * defined as three linked UIDs raising THIS texture. A faction holding it
 * would make its own pole indistinguishable from an unclaimed one.
 */
export const NEUTRAL_FLAG = "Flag_White";

/**
 * The 33 claimable identities, from types.xml (34 flags, minus the neutral).
 *
 * ⚠️ Do not extend this list to relieve scarcity. A hard ceiling is a designed
 * feature (spec §3): 33 is what makes an identity worth having, and the
 * dormancy/disband path exists precisely so the pool can recycle rather than
 * grow.
 */
export const CLAIMABLE_FLAGS: readonly string[] = [
  "Flag_Altis", "Flag_APA", "Flag_BabyDeer", "Flag_Bear", "Flag_Bohemia",
  "Flag_BrainZ", "Flag_Cannibals", "Flag_CDF", "Flag_Chedaki", "Flag_CHEL",
  "Flag_Chernarus", "Flag_CMC", "Flag_Crook", "Flag_DayZ", "Flag_HunterZ",
  "Flag_Livonia", "Flag_LivoniaArmy", "Flag_LivoniaPolice", "Flag_NAPA",
  "Flag_NSahrani", "Flag_Pirates", "Flag_Refuge", "Flag_Rex", "Flag_Rooster",
  "Flag_RSTA", "Flag_Sakhal", "Flag_Snake", "Flag_SSahrani", "Flag_TEC",
  "Flag_UEC", "Flag_Wolf", "Flag_Zagorky", "Flag_Zenit",
] as const;

const CLAIMABLE = new Set(CLAIMABLE_FLAGS);

export function isClaimableFlag(texture: string): boolean {
  return CLAIMABLE.has(texture);
}

/**
 * `Flag_X` → `Armband_X`. All 34 flags have an exactly matching armband, so
 * this is a substitution rather than a curation table — but only for textures
 * actually in the pool, since inventing an armband name for an unknown flag
 * would name an item that does not exist.
 */
export function armbandFor(texture: string): string | null {
  if (!CLAIMABLE.has(texture)) return null;
  return texture.replace(/^Flag_/u, "Armband_");
}
```

- [ ] **Step 4: Export from the package index**

Add to `packages/domain/src/index.ts`:

```ts
export * from "./flags.js";
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm --filter @factions/domain test && pnpm --filter @factions/domain typecheck`
Expected: PASS, 5 new tests.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/flags.ts packages/domain/src/index.ts packages/domain/test/flags.test.ts
git commit -m "feat(domain): the 33-flag claimable pool and armband derivation"
```

---

### Task 2: Pure window settling

**Files:**
- Create: `packages/ceremony/package.json`, `packages/ceremony/tsconfig.json`, `packages/ceremony/vitest.config.ts`, `packages/ceremony/src/index.ts`, `packages/ceremony/src/windows.ts`
- Test: `packages/ceremony/test/windows.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type QualifyingRaise = { eventId: number; dayzId: string; gamertag: string; occurredAt: Date };
  export type SettledWindow = { start: Date; end: Date; raises: QualifyingRaise[]; participants: string[] };
  export const CEREMONY_WINDOW_MS = 600_000;
  export const MIN_PARTICIPANTS = 3;
  export function settleWindows(raises: QualifyingRaise[], highWater: Date, windowMs?: number): SettledWindow[];
  export function qualifies(w: SettledWindow, min?: number): boolean;
  ```

This package is pure — no database, no clock — for the same reason `@factions/verification` is: the window rules are where the subtle bugs live, and they must be testable without fixtures or a running Postgres.

- [ ] **Step 1: Create the package manifest**

```json
// packages/ceremony/package.json
{
  "name": "@factions/ceremony",
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

```json
// packages/ceremony/tsconfig.json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

```ts
// packages/ceremony/vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({});
```

```ts
// packages/ceremony/src/index.ts
export * from "./windows.js";
```

- [ ] **Step 2: Write the failing tests**

```ts
// packages/ceremony/test/windows.test.ts
import { describe, it, expect } from "vitest";
import {
  settleWindows, qualifies, CEREMONY_WINDOW_MS, MIN_PARTICIPANTS,
  type QualifyingRaise,
} from "../src/windows.js";

const T0 = new Date("2026-08-31T12:00:00Z");
const at = (mins: number) => new Date(T0.getTime() + mins * 60_000);
let nextId = 1;
const raise = (dayzId: string, mins: number): QualifyingRaise =>
  ({ eventId: nextId++, dayzId, gamertag: dayzId.slice(0, 4), occurredAt: at(mins) });

describe("settleWindows", () => {
  it("settles a window once the log has advanced past its end", () => {
    const raises = [raise("A", 0), raise("B", 1), raise("C", 2)];
    const [w] = settleWindows(raises, at(11));
    expect(w?.participants.sort()).toEqual(["A", "B", "C"]);
    expect(qualifies(w!)).toBe(true);
  });

  it("does NOT settle while the high-water mark is inside the window", () => {
    // The participant set is not knowable yet: more raises may still arrive
    // in this window, and settling now would silently exclude them.
    const raises = [raise("A", 0), raise("B", 1), raise("C", 2)];
    expect(settleWindows(raises, at(5))).toEqual([]);
  });

  it("includes a fourth participant who arrives at minute nine", () => {
    // The reason windows settle rather than firing on the third raise. A
    // founding member excluded here can never be added: the claim step only
    // prunes.
    const raises = [raise("A", 0), raise("B", 1), raise("C", 2), raise("D", 9)];
    const [w] = settleWindows(raises, at(11));
    expect(w?.participants.sort()).toEqual(["A", "B", "C", "D"]);
  });

  it("counts distinct UIDs, not raises", () => {
    const raises = [raise("A", 0), raise("A", 1), raise("A", 2)];
    const [w] = settleWindows(raises, at(11));
    expect(w?.participants).toEqual(["A"]);
    expect(qualifies(w!)).toBe(false);
  });

  it("anchors the next window at the oldest unconsumed raise, not a slide", () => {
    // 0, 5, 11 is TWO windows (0-10, 11-21), not one. A sliding window would
    // let a slow trickle at a busy pole accumulate into a ceremony nobody
    // performed.
    const raises = [raise("A", 0), raise("B", 5), raise("C", 11)];
    const windows = settleWindows(raises, at(30));
    expect(windows).toHaveLength(2);
    expect(windows[0]!.participants.sort()).toEqual(["A", "B"]);
    expect(windows[1]!.participants).toEqual(["C"]);
    expect(windows.some(qualifies)).toBe(false);
  });

  it("excludes a raise landing exactly on the window end", () => {
    // Half-open [start, start+10m). The boundary raise anchors the next
    // window instead — otherwise the window's own length is ambiguous.
    const raises = [raise("A", 0), raise("B", 1), raise("C", 10)];
    const windows = settleWindows(raises, at(30));
    expect(windows[0]!.participants.sort()).toEqual(["A", "B"]);
    expect(windows[1]!.participants).toEqual(["C"]);
  });

  it("settles earlier windows even when a later one is still open", () => {
    const raises = [raise("A", 0), raise("B", 1), raise("C", 2), raise("D", 25)];
    const windows = settleWindows(raises, at(30));
    expect(windows).toHaveLength(1);
    expect(windows[0]!.participants.sort()).toEqual(["A", "B", "C"]);
  });

  it("orders by event id when two raises share a timestamp", () => {
    // ADM has second granularity, so ties are ordinary, not exotic. Ordering
    // must be total or window anchoring is nondeterministic.
    const a = { eventId: 90, dayzId: "B", gamertag: "B", occurredAt: at(0) };
    const b = { eventId: 80, dayzId: "A", gamertag: "A", occurredAt: at(0) };
    const [w] = settleWindows([a, b], at(11));
    expect(w?.raises.map((r) => r.eventId)).toEqual([80, 90]);
  });

  it("returns nothing for no raises", () => {
    expect(settleWindows([], at(99))).toEqual([]);
  });

  it("uses a ten-minute window and a three-participant floor", () => {
    expect(CEREMONY_WINDOW_MS).toBe(600_000);
    expect(MIN_PARTICIPANTS).toBe(3);
  });
});
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `pnpm --filter @factions/ceremony test`
Expected: FAIL — cannot resolve `../src/windows.js`.

- [ ] **Step 4: Write the implementation**

```ts
// packages/ceremony/src/windows.ts

/** A `flag.raised` that already passed every qualification check. */
export type QualifyingRaise = {
  eventId: number;
  dayzId: string;
  gamertag: string;
  occurredAt: Date;
};

export type SettledWindow = {
  start: Date;
  /** Exclusive. A raise at exactly `end` anchors the NEXT window. */
  end: Date;
  raises: QualifyingRaise[];
  /** Distinct UIDs, in first-seen order. */
  participants: string[];
};

export const CEREMONY_WINDOW_MS = 600_000;
export const MIN_PARTICIPANTS = 3;

/**
 * Group raises into settled, non-overlapping windows.
 *
 * ⚠️ `highWater` is the newest INGESTED event time, not `Date.now()`. A window
 * is only settled once the log itself has advanced past its end. Using the
 * wall clock instead closes windows before their own events have been
 * ingested — the ingest worker is a one-shot batch nothing schedules — and
 * drops every late participant, silently. It also makes a backfill and a live
 * ceremony take different paths, which would render the fixtures meaningless.
 *
 * Windows anchor at the oldest unconsumed raise and do not slide: a slow
 * trickle of raises at a busy pole must not accumulate into a ceremony nobody
 * performed.
 */
export function settleWindows(
  raises: QualifyingRaise[],
  highWater: Date,
  windowMs: number = CEREMONY_WINDOW_MS,
): SettledWindow[] {
  // Total order. ADM timestamps have second granularity, so ties are ordinary;
  // without the id tiebreak, window anchoring would be nondeterministic.
  const sorted = [...raises].sort((a, b) =>
    a.occurredAt.getTime() - b.occurredAt.getTime() || a.eventId - b.eventId);

  const out: SettledWindow[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i]!.occurredAt;
    const end = new Date(start.getTime() + windowMs);
    if (highWater.getTime() < end.getTime()) break;

    const group: QualifyingRaise[] = [];
    while (i < sorted.length && sorted[i]!.occurredAt.getTime() < end.getTime()) {
      group.push(sorted[i]!);
      i++;
    }

    const seen = new Set<string>();
    const participants: string[] = [];
    for (const r of group) {
      if (seen.has(r.dayzId)) continue;
      seen.add(r.dayzId);
      participants.push(r.dayzId);
    }
    out.push({ start, end, raises: group, participants });
  }
  return out;
}

export function qualifies(w: SettledWindow, min: number = MIN_PARTICIPANTS): boolean {
  return w.participants.length >= min;
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm --filter @factions/ceremony test && pnpm --filter @factions/ceremony typecheck`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/ceremony
git commit -m "feat(ceremony): pure settling of non-overlapping ceremony windows"
```

---

### Task 3: Ceremony schema — `white_raises`, `ceremonies`, `ceremony_participants`

**Files:**
- Modify: `packages/db/src/schema.ts` (append; do not reorder existing tables)
- Create: `packages/db/migrations/0006_*.sql` (generated)
- Test: `packages/db/test/ceremony-schema.test.ts`

**Interfaces:**
- Produces: `whiteRaises`, `ceremonies`, `ceremonyParticipants` Drizzle tables, exported from `@factions/db`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/test/ceremony-schema.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, whiteRaises, ceremonies, ceremonyParticipants, servers, admFiles, events, type Database } from "../src/index.js";
import { sql } from "drizzle-orm";

const URL = requireTestDatabaseUrl();
const UID_A = "A".repeat(40);
const now = new Date("2026-08-31T12:00:00Z");

describe("ceremony schema", () => {
  let db: Database;
  let serverId = 0;
  let eventId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table ceremony_participants, ceremonies, white_raises, events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now }).returning();
    const [e] = await db.insert(events).values({
      serverId, admFileId: f!.id, lineIndex: 1, subIndex: 0,
      type: "flag.raised", occurredAt: now, payload: {},
    }).returning();
    eventId = e!.id;
  });

  const raise = (overrides: Record<string, unknown> = {}) => db.insert(whiteRaises).values({
    serverId, poleKey: "1:2:3", dayzId: UID_A, gamertag: "Steve",
    occurredAt: now, eventId, ...overrides,
  });

  it("records a qualifying raise", async () => {
    await raise();
    expect(await db.select().from(whiteRaises)).toHaveLength(1);
  });

  it("refuses to record the same event twice", async () => {
    // The detector re-reads events after a crash. Recording a raise twice
    // would let one player count as two participants in the same window.
    await raise();
    await expect(raise()).rejects.toThrow(/white_raises_event_uniq/);
  });

  const ceremony = (overrides: Record<string, unknown> = {}) => db.insert(ceremonies).values({
    serverId, poleKey: "1:2:3", windowStart: now, windowEnd: new Date(now.getTime() + 600_000),
    status: "provisional", detectedAt: now, expiresAt: new Date(now.getTime() + 86_400_000),
    ...overrides,
  }).returning();

  it("allows only one provisional ceremony per pole", async () => {
    // Otherwise a pole generates a ceremony every ten minutes for as long as
    // people keep raising White on it.
    await ceremony();
    await expect(ceremony()).rejects.toThrow(/ceremonies_open_pole_uniq/);
  });

  it("allows a new ceremony at a pole whose previous one expired", async () => {
    const [first] = await ceremony();
    await db.update(ceremonies).set({ status: "expired" }).where(sql`id = ${first!.id}`);
    await expect(ceremony()).resolves.toBeDefined();
  });

  it("rejects an unknown status", async () => {
    await expect(ceremony({ status: "banana" })).rejects.toThrow(/ceremonies_status_valid/);
  });

  it("refuses a duplicate participant in one ceremony", async () => {
    const [c] = await ceremony();
    const p = { ceremonyId: c!.id, dayzId: UID_A, discordId: "100", gamertag: "Steve" };
    await db.insert(ceremonyParticipants).values(p);
    await expect(db.insert(ceremonyParticipants).values(p)).rejects.toThrow(/ceremony_participants_uniq/);
  });

  it("deletes participants with their ceremony", async () => {
    const [c] = await ceremony();
    await db.insert(ceremonyParticipants).values({ ceremonyId: c!.id, dayzId: UID_A, discordId: "100", gamertag: "Steve" });
    await db.delete(ceremonies).where(sql`id = ${c!.id}`);
    expect(await db.select().from(ceremonyParticipants)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `docker compose up -d postgres && export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm --filter @factions/db test ceremony-schema`
Expected: FAIL — `whiteRaises` is not exported.

- [ ] **Step 3: Add the tables**

Append to `packages/db/src/schema.ts`:

```ts
/**
 * Qualifying neutral-flag raises, as the detector sees them.
 *
 * ⚠️ This table is why recording and settling are separate phases. The
 * detector's cursor advances when a raise is RECORDED; settling happens
 * afterwards from these rows. If settling throws, nothing is lost — the raises
 * are durable and the next pass settles them. Merging the phases would mean a
 * settle failure silently discards events the cursor has already passed.
 */
export const whiteRaises = pgTable("white_raises", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  poleKey: text("pole_key").notNull(),
  dayzId: text("dayz_id").notNull(),
  gamertag: text("gamertag").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  eventId: bigint("event_id", { mode: "number" }).notNull().references(() => events.id),
  /** Null until the window holding this raise has settled. */
  settledAt: timestamp("settled_at", { withTimezone: true }),
}, (t) => ({
  // Replay safety: the detector re-reads events after a crash, and recording
  // one raise twice would let a single player count as two participants.
  uniqEvent: uniqueIndex("white_raises_event_uniq").on(t.eventId),
  // The settling query: unconsumed raises for one pole, in time order.
  byPolePending: index("white_raises_pending_idx")
    .on(t.serverId, t.poleKey, t.occurredAt)
    .where(sql`${t.settledAt} IS NULL`),
}));

/** A detected founding ritual, awaiting a claim. */
export const ceremonies = pgTable("ceremonies", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  poleKey: text("pole_key").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
  status: text("status").notNull(),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  /** Set once every participant has been DM'd. Keeps the notifier idempotent. */
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
}, (t) => ({
  statusValid: check("ceremonies_status_valid",
    sql`${t.status} IN ('provisional','claimed','expired')`),
  // One outstanding ceremony per pole. Partial, because a claimed or expired
  // ceremony no longer holds its pole. Without this, a pole under sustained
  // White raises would produce a ceremony every window and only the first
  // could ever insert — the rest would surface as errors rather than no-ops.
  uniqOpenPole: uniqueIndex("ceremonies_open_pole_uniq")
    .on(t.serverId, t.poleKey)
    .where(sql`${t.status} = 'provisional'`),
  byOpen: index("ceremonies_open_idx").on(t.expiresAt).where(sql`${t.status} = 'provisional'`),
}));

/**
 * Who was counted. `discord_id` and `gamertag` are denormalized at detection
 * time deliberately: the DM path must not re-resolve them, and the row is a
 * record of who was linked THEN, not who is linked now.
 */
export const ceremonyParticipants = pgTable("ceremony_participants", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ceremonyId: bigint("ceremony_id", { mode: "number" })
    .notNull().references(() => ceremonies.id, { onDelete: "cascade" }),
  dayzId: text("dayz_id").notNull(),
  discordId: text("discord_id").notNull(),
  gamertag: text("gamertag").notNull(),
}, (t) => ({
  uniqParticipant: uniqueIndex("ceremony_participants_uniq").on(t.ceremonyId, t.dayzId),
}));
```

- [ ] **Step 4: Generate and apply the migration**

```bash
cd packages/db && pnpm generate
```

Read the emitted `migrations/0006_*.sql` before committing. It must CREATE three tables and add no `DROP` of anything existing. If it proposes dropping or altering an existing table, stop — the schema file was edited wrongly.

- [ ] **Step 5: Run the test**

Run: `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm --filter @factions/db test`
Expected: PASS, 7 new tests.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations packages/db/test/ceremony-schema.test.ts
git commit -m "feat(db): ceremony detection tables with replay-safe raise recording"
```

---

### Task 4: Faction schema — `factions`, `faction_members`, `claim_drafts`

**Files:**
- Modify: `packages/db/src/schema.ts` (append)
- Create: `packages/db/migrations/0007_*.sql` (generated)
- Test: `packages/db/test/faction-schema.test.ts`

**Interfaces:**
- Produces: `factions`, `factionMembers`, `claimDrafts` Drizzle tables, exported from `@factions/db`.

**Holding statuses** are `reserved`, `active`, and `dormant`. All three uniqueness rules are partial over exactly that set, so a `lapsed` or `disbanded` faction releases its flag, tag, and pole in one transition.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/test/faction-schema.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, factions, factionMembers, servers, type Database } from "../src/index.js";
import { sql } from "drizzle-orm";

const URL = requireTestDatabaseUrl();
const UID_A = "A".repeat(40);
const now = new Date("2026-08-31T12:00:00Z");

describe("faction schema", () => {
  let db: Database;
  let serverId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table faction_members, claim_drafts, factions, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
  });

  const faction = (o: Record<string, unknown> = {}) => db.insert(factions).values({
    serverId, name: "The Bears", tag: "BEAR", texture: "Flag_Bear",
    poleKey: "1:2:3", x: "1.00", y: "2.00", z: "3.00",
    status: "reserved", leaderDiscordId: "100", createdAt: now,
    reservedUntil: new Date(now.getTime() + 86_400_000), ...o,
  }).returning();

  it("creates a reserved faction", async () => {
    const [f] = await faction();
    expect(f?.status).toBe("reserved");
  });

  it("rejects an unknown status", async () => {
    await expect(faction({ status: "banana" })).rejects.toThrow(/factions_status_valid/);
  });

  it("allows only one holder of a flag per server", async () => {
    await faction();
    await expect(faction({ tag: "BR2", poleKey: "9:9:9" })).rejects.toThrow(/factions_holding_texture_uniq/);
  });

  it("frees the flag when the holder disbands", async () => {
    // The whole reclamation mechanism. A disbanded faction must release its
    // identity or a 33-slot pool starves permanently.
    const [f] = await faction();
    await db.update(factions).set({ status: "disbanded" }).where(sql`id = ${f!.id}`);
    await expect(faction({ tag: "BR2", poleKey: "9:9:9" })).resolves.toBeDefined();
  });

  it("frees the flag when a reservation lapses", async () => {
    const [f] = await faction();
    await db.update(factions).set({ status: "lapsed" }).where(sql`id = ${f!.id}`);
    await expect(faction({ tag: "BR2", poleKey: "9:9:9" })).resolves.toBeDefined();
  });

  it("treats tags case-insensitively", async () => {
    // BEAR and bear in channel names are the same tag to a human.
    await faction();
    await expect(faction({ tag: "bear", texture: "Flag_Wolf", poleKey: "9:9:9" }))
      .rejects.toThrow(/factions_holding_tag_uniq/);
  });

  it("allows only one faction per pole", async () => {
    await faction();
    await expect(faction({ tag: "WOLF", texture: "Flag_Wolf" }))
      .rejects.toThrow(/factions_holding_pole_uniq/);
  });

  it("refuses a duplicate roster member", async () => {
    const [f] = await faction();
    const m = { factionId: f!.id, dayzId: UID_A, discordId: "100", role: "leader" as const, joinedAt: now };
    await db.insert(factionMembers).values(m);
    await expect(db.insert(factionMembers).values(m)).rejects.toThrow(/faction_members_uniq/);
  });

  it("rejects an unknown role", async () => {
    const [f] = await faction();
    await expect(db.insert(factionMembers).values({
      factionId: f!.id, dayzId: UID_A, discordId: "100", role: "emperor", joinedAt: now,
    })).rejects.toThrow(/faction_members_role_valid/);
  });

  it("requires reserved_until on a reserved faction", async () => {
    // A reservation with no deadline is a permanent hole in the pool.
    await expect(faction({ reservedUntil: null })).rejects.toThrow(/factions_reserved_has_deadline/);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm --filter @factions/db test faction-schema`
Expected: FAIL — `factions` is not exported.

- [ ] **Step 3: Add the tables**

Append to `packages/db/src/schema.ts`:

```ts
/**
 * A faction.
 *
 * ⚠️ Keyed on `server_id` alone, NOT `(server_id, map)`. `servers.map` already
 * exists, so `server_id` determines the map; carrying both invites the two
 * disagreeing. Per-map tenancy holds through the join.
 *
 * There is no `flag_pool` table. The 33 claimable textures are a constant in
 * `@factions/domain`, and availability is that constant minus the rows here in
 * a holding status — so the claim IS the allocation, and disbanding frees the
 * flag with no bookkeeping.
 */
export const factions = pgTable("factions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  name: text("name").notNull(),
  tag: text("tag").notNull(),
  texture: text("texture").notNull(),
  poleKey: text("pole_key").notNull(),
  x: numeric("x", { precision: 12, scale: 2 }).notNull(),
  y: numeric("y", { precision: 12, scale: 2 }).notNull(),
  z: numeric("z", { precision: 12, scale: 2 }).notNull(),
  status: text("status").notNull(),
  leaderDiscordId: text("leader_discord_id").notNull(),
  /** Provenance: which ritual produced this faction. */
  ceremonyId: bigint("ceremony_id", { mode: "number" }).references(() => ceremonies.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  reservedUntil: timestamp("reserved_until", { withTimezone: true }),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
}, (t) => ({
  statusValid: check("factions_status_valid",
    sql`${t.status} IN ('reserved','active','dormant','lapsed','disbanded')`),
  // A reservation with no deadline is a permanent hole in a 33-slot pool.
  reservedHasDeadline: check("factions_reserved_has_deadline",
    sql`${t.status} <> 'reserved' OR ${t.reservedUntil} IS NOT NULL`),
  // The three scarcity rules. All partial over the HOLDING statuses, so a
  // lapsed or disbanded faction releases flag, tag and pole in one transition.
  uniqTexture: uniqueIndex("factions_holding_texture_uniq")
    .on(t.serverId, t.texture)
    .where(sql`${t.status} IN ('reserved','active','dormant')`),
  uniqTag: uniqueIndex("factions_holding_tag_uniq")
    .on(t.serverId, sql`lower(${t.tag})`)
    .where(sql`${t.status} IN ('reserved','active','dormant')`),
  uniqPole: uniqueIndex("factions_holding_pole_uniq")
    .on(t.serverId, t.poleKey)
    .where(sql`${t.status} IN ('reserved','active','dormant')`),
}));

/**
 * The confirmed roster.
 *
 * Created in this plan only because activation must verify that the UID which
 * raised the faction's flag is on it. No command manages membership yet — that
 * is spec §6.
 */
export const factionMembers = pgTable("faction_members", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  factionId: bigint("faction_id", { mode: "number" })
    .notNull().references(() => factions.id, { onDelete: "cascade" }),
  dayzId: text("dayz_id").notNull(),
  discordId: text("discord_id").notNull(),
  role: text("role").notNull(),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull(),
}, (t) => ({
  roleValid: check("faction_members_role_valid",
    sql`${t.role} IN ('leader','officer','member')`),
  uniqMember: uniqueIndex("faction_members_uniq").on(t.factionId, t.dayzId),
}));

/**
 * A claim in progress: name, tag and flag chosen, roster not yet confirmed.
 *
 * ⚠️ Needed because the pruning step is a second interaction. Discord custom
 * ids cap at 100 characters, so a player-chosen faction name cannot ride along
 * in one — the draft has to be durable. Deleted on confirm.
 */
export const claimDrafts = pgTable("claim_drafts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ceremonyId: bigint("ceremony_id", { mode: "number" })
    .notNull().references(() => ceremonies.id, { onDelete: "cascade" }),
  discordId: text("discord_id").notNull(),
  name: text("name").notNull(),
  tag: text("tag").notNull(),
  texture: text("texture").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => ({
  uniqDraft: uniqueIndex("claim_drafts_ceremony_uniq").on(t.ceremonyId),
}));
```

- [ ] **Step 4: Generate and apply the migration**

```bash
cd packages/db && pnpm generate
```

Inspect `migrations/0007_*.sql`. Three CREATE TABLEs, no drops.

- [ ] **Step 5: Run the test**

Run: `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm --filter @factions/db test`
Expected: PASS, 10 new tests.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations packages/db/test/faction-schema.test.ts
git commit -m "feat(db): factions, rosters, and claim drafts with pool scarcity in the index"
```

---

### Task 5: `PgCeremonyStore`

**Files:**
- Create: `apps/bot/src/ceremony-store.ts`
- Modify: `apps/bot/package.json` (add `@factions/ceremony` dependency)
- Test: `apps/bot/test/ceremony-store.test.ts`

**Interfaces:**
- Consumes: `settleWindows`, `QualifyingRaise`, `SettledWindow` (Task 2); `whiteRaises`, `ceremonies`, `ceremonyParticipants`, `factions` (Tasks 3–4).
- Produces:
  ```ts
  export type PoleRef = { serverId: number; poleKey: string };
  export type RecordedRaise = PoleRef & { dayzId: string; gamertag: string; occurredAt: Date; eventId: number };
  export type Participant = { dayzId: string; discordId: string; gamertag: string };
  export interface CeremonyStore {
    highWaterMark(serverId: number): Promise<Date | null>;
    isPoleBound(p: PoleRef): Promise<boolean>;
    linkedDiscordId(dayzId: string): Promise<string | null>;
    recordRaise(r: RecordedRaise): Promise<void>;
    polesWithPendingRaises(): Promise<PoleRef[]>;
    pendingRaises(p: PoleRef): Promise<QualifyingRaise[]>;
    hasOpenCeremony(p: PoleRef): Promise<boolean>;
    settle(p: PoleRef, w: SettledWindow, create: CeremonyDraft | null): Promise<number | null>;
  }
  export type CeremonyDraft = { detectedAt: Date; expiresAt: Date; participants: Participant[] };
  export class PgCeremonyStore implements CeremonyStore { constructor(db: Database) }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/bot/test/ceremony-store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events, identityLinks, factions, ceremonies, whiteRaises, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { PgCeremonyStore } from "../src/ceremony-store.js";

const URL = requireTestDatabaseUrl();
const UID_A = "A".repeat(40);
const UID_B = "B".repeat(40);
const POLE = "1:2:3";
const now = new Date("2026-08-31T12:00:00Z");

describe("PgCeremonyStore", () => {
  let db: Database;
  let store: PgCeremonyStore;
  let serverId = 0;
  let admFileId = 0;
  let line = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table ceremony_participants, ceremonies, white_raises, faction_members, claim_drafts, factions, identity_links, events, raw_lines, adm_files, servers restart identity cascade`);
    store = new PgCeremonyStore(db);
    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now }).returning();
    admFileId = f!.id;
    line = 0;
  });

  const event = async (occurredAt: Date) => {
    const [e] = await db.insert(events).values({
      serverId, admFileId, lineIndex: line++, subIndex: 0,
      type: "flag.raised", occurredAt, payload: {},
    }).returning();
    return e!.id;
  };

  const record = async (dayzId: string, minutes: number) => {
    const occurredAt = new Date(now.getTime() + minutes * 60_000);
    await store.recordRaise({ serverId, poleKey: POLE, dayzId, gamertag: "Steve", occurredAt, eventId: await event(occurredAt) });
  };

  it("reports the newest ingested event time as the high-water mark", async () => {
    await event(now);
    await event(new Date(now.getTime() + 900_000));
    expect(await store.highWaterMark(serverId)).toEqual(new Date(now.getTime() + 900_000));
  });

  it("reports no high-water mark for a server with no events", async () => {
    const [s2] = await db.insert(servers).values({ name: "S2", map: "livonia", clockOffsetMs: 0 }).returning();
    expect(await store.highWaterMark(s2!.id)).toBeNull();
  });

  it("records a raise once, however many times it is replayed", async () => {
    // The detector re-reads events after a crash; a raise counted twice would
    // let one player stand in for two participants.
    const occurredAt = now;
    const eventId = await event(occurredAt);
    const r = { serverId, poleKey: POLE, dayzId: UID_A, gamertag: "Steve", occurredAt, eventId };
    await store.recordRaise(r);
    await store.recordRaise(r);
    expect(await db.select().from(whiteRaises)).toHaveLength(1);
  });

  it("finds a pole bound to a faction in a holding status", async () => {
    await db.insert(factions).values({
      serverId, name: "N", tag: "N", texture: "Flag_Bear", poleKey: POLE,
      x: "1.00", y: "2.00", z: "3.00", status: "active",
      leaderDiscordId: "100", createdAt: now,
    });
    expect(await store.isPoleBound({ serverId, poleKey: POLE })).toBe(true);
  });

  it("does not treat a disbanded faction's pole as bound", async () => {
    await db.insert(factions).values({
      serverId, name: "N", tag: "N", texture: "Flag_Bear", poleKey: POLE,
      x: "1.00", y: "2.00", z: "3.00", status: "disbanded",
      leaderDiscordId: "100", createdAt: now,
    });
    expect(await store.isPoleBound({ serverId, poleKey: POLE })).toBe(false);
  });

  it("resolves a linked UID to its Discord account", async () => {
    await db.insert(identityLinks).values({ discordId: "100", dayzId: UID_A, gamertag: "Steve", verifiedAt: now });
    expect(await store.linkedDiscordId(UID_A)).toBe("100");
    expect(await store.linkedDiscordId(UID_B)).toBeNull();
  });

  it("lists poles with unsettled raises", async () => {
    await record(UID_A, 0);
    expect(await store.polesWithPendingRaises()).toEqual([{ serverId, poleKey: POLE }]);
  });

  it("marks raises settled and creates the ceremony in one transaction", async () => {
    await record(UID_A, 0);
    await record(UID_B, 1);
    const p = { serverId, poleKey: POLE };
    const raises = await store.pendingRaises(p);
    const window = { start: now, end: new Date(now.getTime() + 600_000), raises, participants: [UID_A, UID_B] };
    const id = await store.settle(p, window, {
      detectedAt: now, expiresAt: new Date(now.getTime() + 86_400_000),
      participants: [
        { dayzId: UID_A, discordId: "100", gamertag: "Steve" },
        { dayzId: UID_B, discordId: "200", gamertag: "Bob" },
      ],
    });
    expect(id).not.toBeNull();
    expect(await store.pendingRaises(p)).toHaveLength(0);
    expect(await store.hasOpenCeremony(p)).toBe(true);
  });

  it("consumes the raises of a window that produced no ceremony", async () => {
    // A window that fell short must not be re-settled forever, and its raises
    // must not leak into the next window — that is what makes windows
    // non-overlapping in the database as well as in the pure function.
    await record(UID_A, 0);
    const p = { serverId, poleKey: POLE };
    const raises = await store.pendingRaises(p);
    const window = { start: now, end: new Date(now.getTime() + 600_000), raises, participants: [UID_A] };
    expect(await store.settle(p, window, null)).toBeNull();
    expect(await store.pendingRaises(p)).toHaveLength(0);
    expect(await db.select().from(ceremonies)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm --filter @factions/bot test ceremony-store`
Expected: FAIL — cannot resolve `../src/ceremony-store.js`.

- [ ] **Step 3: Add the dependency**

In `apps/bot/package.json`, add to `dependencies`:

```json
"@factions/ceremony": "workspace:*",
```

Then `pnpm install` from the repo root.

- [ ] **Step 4: Write the implementation**

```ts
// apps/bot/src/ceremony-store.ts
import type { Database } from "@factions/db";
import { whiteRaises, ceremonies, ceremonyParticipants, factions, identityLinks, events } from "@factions/db";
import type { QualifyingRaise, SettledWindow } from "@factions/ceremony";
import { and, asc, eq, inArray, isNull, max, sql } from "drizzle-orm";

export type PoleRef = { serverId: number; poleKey: string };
export type RecordedRaise = PoleRef & {
  dayzId: string; gamertag: string; occurredAt: Date; eventId: number;
};
export type Participant = { dayzId: string; discordId: string; gamertag: string };
export type CeremonyDraft = { detectedAt: Date; expiresAt: Date; participants: Participant[] };

const HOLDING = ["reserved", "active", "dormant"];

export interface CeremonyStore {
  highWaterMark(serverId: number): Promise<Date | null>;
  isPoleBound(p: PoleRef): Promise<boolean>;
  linkedDiscordId(dayzId: string): Promise<string | null>;
  recordRaise(r: RecordedRaise): Promise<void>;
  polesWithPendingRaises(): Promise<PoleRef[]>;
  pendingRaises(p: PoleRef): Promise<QualifyingRaise[]>;
  hasOpenCeremony(p: PoleRef): Promise<boolean>;
  settle(p: PoleRef, w: SettledWindow, create: CeremonyDraft | null): Promise<number | null>;
}

export class PgCeremonyStore implements CeremonyStore {
  constructor(private readonly db: Database) {}

  /**
   * ⚠️ The newest ingested event time for this server — NOT `Date.now()`. This
   * is the clock every settling decision is made against, because the ingest
   * worker is a one-shot batch nothing schedules and its lag is unbounded.
   */
  async highWaterMark(serverId: number): Promise<Date | null> {
    const [row] = await this.db.select({ hw: max(events.occurredAt) })
      .from(events).where(eq(events.serverId, serverId));
    return row?.hw ?? null;
  }

  async isPoleBound(p: PoleRef): Promise<boolean> {
    const [row] = await this.db.select({ id: factions.id }).from(factions)
      .where(and(
        eq(factions.serverId, p.serverId),
        eq(factions.poleKey, p.poleKey),
        inArray(factions.status, HOLDING),
      ));
    return row !== undefined;
  }

  async linkedDiscordId(dayzId: string): Promise<string | null> {
    const [row] = await this.db.select({ discordId: identityLinks.discordId })
      .from(identityLinks).where(eq(identityLinks.dayzId, dayzId));
    return row?.discordId ?? null;
  }

  /**
   * Idempotent on `event_id`: a replayed event must not add a second raise.
   * `onConflictDoNothing` is correct here rather than load-bearing-returning —
   * there is no decision downstream, the row either exists or is created.
   */
  async recordRaise(r: RecordedRaise): Promise<void> {
    await this.db.insert(whiteRaises).values({
      serverId: r.serverId, poleKey: r.poleKey, dayzId: r.dayzId,
      gamertag: r.gamertag, occurredAt: r.occurredAt, eventId: r.eventId,
    }).onConflictDoNothing();
  }

  async polesWithPendingRaises(): Promise<PoleRef[]> {
    return this.db.selectDistinct({ serverId: whiteRaises.serverId, poleKey: whiteRaises.poleKey })
      .from(whiteRaises).where(isNull(whiteRaises.settledAt));
  }

  async pendingRaises(p: PoleRef): Promise<QualifyingRaise[]> {
    return this.db.select({
      eventId: whiteRaises.eventId, dayzId: whiteRaises.dayzId,
      gamertag: whiteRaises.gamertag, occurredAt: whiteRaises.occurredAt,
    }).from(whiteRaises)
      .where(and(
        eq(whiteRaises.serverId, p.serverId),
        eq(whiteRaises.poleKey, p.poleKey),
        isNull(whiteRaises.settledAt),
      ))
      .orderBy(asc(whiteRaises.occurredAt), asc(whiteRaises.eventId));
  }

  async hasOpenCeremony(p: PoleRef): Promise<boolean> {
    const [row] = await this.db.select({ id: ceremonies.id }).from(ceremonies)
      .where(and(
        eq(ceremonies.serverId, p.serverId),
        eq(ceremonies.poleKey, p.poleKey),
        eq(ceremonies.status, "provisional"),
      ));
    return row !== undefined;
  }

  /**
   * Consume a settled window, and create its ceremony when it qualified.
   *
   * ⚠️ One transaction. Marking the raises settled without creating the
   * ceremony loses a real ritual; creating the ceremony without consuming the
   * raises re-settles the same window forever. A window that produced no
   * ceremony still consumes its raises — that is what keeps windows
   * non-overlapping in the database as well as in the pure function.
   */
  async settle(p: PoleRef, w: SettledWindow, create: CeremonyDraft | null): Promise<number | null> {
    const eventIds = w.raises.map((r) => r.eventId);
    return this.db.transaction(async (tx) => {
      let ceremonyId: number | null = null;
      if (create) {
        const [row] = await tx.insert(ceremonies).values({
          serverId: p.serverId, poleKey: p.poleKey,
          windowStart: w.start, windowEnd: w.end, status: "provisional",
          detectedAt: create.detectedAt, expiresAt: create.expiresAt,
        }).returning({ id: ceremonies.id });
        ceremonyId = row!.id;
        await tx.insert(ceremonyParticipants).values(
          create.participants.map((x) => ({ ceremonyId: ceremonyId!, ...x })),
        );
      }
      if (eventIds.length > 0) {
        await tx.update(whiteRaises)
          .set({ settledAt: create?.detectedAt ?? w.end })
          .where(inArray(whiteRaises.eventId, eventIds));
      }
      return ceremonyId;
    });
  }
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm --filter @factions/bot test ceremony-store && pnpm --filter @factions/bot typecheck`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/ceremony-store.ts apps/bot/test/ceremony-store.test.ts apps/bot/package.json pnpm-lock.yaml
git commit -m "feat(bot): ceremony store with transactional window settling"
```

---

### Task 6: The detector tick

**Files:**
- Create: `apps/bot/src/ceremony-tick.ts`
- Test: `apps/bot/test/ceremony-tick.test.ts`

**Interfaces:**
- Consumes: `CeremonyStore` (Task 5), `settleWindows`/`qualifies`/`MIN_PARTICIPANTS` (Task 2), `NEUTRAL_FLAG` (Task 1), `readCursor`/`writeCursor`/`readEventBatch` (`@factions/event-log`).
- Produces:
  ```ts
  export const CEREMONY_CONSUMER = "ceremony-detector";
  export type CeremonyTickResult = { scanned: number; recorded: number; settled: number; detected: number };
  export function ceremonyTick(db: Database, store: CeremonyStore, opts?: { batchSize?: number; now?: Date; provisionalTtlMs?: number }): Promise<CeremonyTickResult>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/bot/test/ceremony-tick.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, identityLinks, factions, ceremonies, ceremonyParticipants, type Database } from "@factions/db";
import { appendEvent } from "@factions/event-log";
import { sql, eq } from "drizzle-orm";
import { PgCeremonyStore } from "../src/ceremony-store.js";
import { ceremonyTick } from "../src/ceremony-tick.js";

const URL = requireTestDatabaseUrl();
const UIDS = ["A", "B", "C", "D"].map((c) => c.repeat(40));
const POLE = "1:2:3";
const T0 = new Date("2026-08-31T12:00:00Z");
const at = (m: number) => new Date(T0.getTime() + m * 60_000);

describe("ceremonyTick", () => {
  let db: Database;
  let store: PgCeremonyStore;
  let serverId = 0;
  let admFileId = 0;
  let line = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table ceremony_participants, ceremonies, white_raises, faction_members, claim_drafts, factions, identity_links, consumer_cursors, events, raw_lines, adm_files, servers restart identity cascade`);
    store = new PgCeremonyStore(db);
    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: T0 }).returning();
    admFileId = f!.id;
    line = 0;
    for (const [i, uid] of UIDS.entries()) {
      await db.insert(identityLinks).values({ discordId: `10${i}`, dayzId: uid, gamertag: `P${i}`, verifiedAt: T0 });
    }
  });

  const raise = (dayzId: string, minutes: number, texture = "Flag_White", poleKey = POLE) =>
    appendEvent(db, {
      serverId, admFileId, lineIndex: line++, subIndex: 0,
      type: "flag.raised", occurredAt: at(minutes),
      payload: { gamertag: "Steve", dayzId, texture, action: "raised", poleKey, pole: { x: 1, y: 2, z: 3 } },
    });

  const tick = (now = at(60)) => ceremonyTick(db, store, { batchSize: 100, now });

  const participantsOf = async (ceremonyId: number) =>
    (await db.select().from(ceremonyParticipants).where(eq(ceremonyParticipants.ceremonyId, ceremonyId)))
      .map((p) => p.dayzId).sort();

  it("detects three linked UIDs raising White at one pole", async () => {
    await raise(UIDS[0]!, 0);
    await raise(UIDS[1]!, 1);
    await raise(UIDS[2]!, 2);
    await raise(UIDS[0]!, 20); // advances the high-water mark past the window
    const r = await tick();
    expect(r.detected).toBe(1);
    const [c] = await db.select().from(ceremonies);
    expect(await participantsOf(c!.id)).toEqual([UIDS[0], UIDS[1], UIDS[2]].sort());
  });

  it("includes a fourth participant who arrives at minute nine", async () => {
    for (const [i, m] of [0, 1, 2, 9].entries()) await raise(UIDS[i]!, m);
    await raise(UIDS[0]!, 20);
    await tick();
    const [c] = await db.select().from(ceremonies);
    expect(await participantsOf(c!.id)).toHaveLength(4);
  });

  it("does not detect two linked UIDs", async () => {
    await raise(UIDS[0]!, 0);
    await raise(UIDS[1]!, 1);
    await raise(UIDS[0]!, 20);
    expect((await tick()).detected).toBe(0);
  });

  it("does not count an unlinked UID", async () => {
    // Only linked players can found a faction: every participant must be
    // reachable by DM, and the claimant check must be a lookup, not trust.
    await db.delete(identityLinks).where(eq(identityLinks.dayzId, UIDS[2]!));
    await raise(UIDS[0]!, 0);
    await raise(UIDS[1]!, 1);
    await raise(UIDS[2]!, 2);
    await raise(UIDS[0]!, 20);
    expect((await tick()).detected).toBe(0);
  });

  it("ignores raises of a claimable flag", async () => {
    for (const [i, m] of [0, 1, 2].entries()) await raise(UIDS[i]!, m, "Flag_Zenit");
    await raise(UIDS[0]!, 20, "Flag_Zenit");
    expect((await tick()).recorded).toBe(0);
  });

  it("ignores a pole already bound to a faction", async () => {
    await db.insert(factions).values({
      serverId, name: "N", tag: "N", texture: "Flag_Bear", poleKey: POLE,
      x: "1.00", y: "2.00", z: "3.00", status: "active", leaderDiscordId: "999", createdAt: T0,
    });
    for (const [i, m] of [0, 1, 2].entries()) await raise(UIDS[i]!, m);
    await raise(UIDS[0]!, 20);
    expect((await tick()).recorded).toBe(0);
  });

  it("does not detect three UIDs spread across eleven minutes", async () => {
    await raise(UIDS[0]!, 0);
    await raise(UIDS[1]!, 5);
    await raise(UIDS[2]!, 11);
    await raise(UIDS[0]!, 40);
    expect((await tick()).detected).toBe(0);
  });

  it("does not settle a window the log has not yet advanced past", async () => {
    // The high-water mark is the newest EVENT time. With no event after the
    // window, the participant set is still unknown.
    await raise(UIDS[0]!, 0);
    await raise(UIDS[1]!, 1);
    await raise(UIDS[2]!, 2);
    const r = await tick(at(999));
    expect(r.recorded).toBe(3);
    expect(r.detected).toBe(0);
  });

  it("opens no second ceremony at a pole that already has one outstanding", async () => {
    for (const [i, m] of [0, 1, 2].entries()) await raise(UIDS[i]!, m);
    await raise(UIDS[0]!, 20);
    await tick();
    for (const [i, m] of [0, 1, 2].entries()) await raise(UIDS[i]!, m + 30);
    await raise(UIDS[0]!, 60);
    const r = await tick(at(90));
    expect(r.detected).toBe(0);
    expect(await db.select().from(ceremonies)).toHaveLength(1);
  });

  it("is idempotent: a second tick over the same events detects nothing new", async () => {
    for (const [i, m] of [0, 1, 2].entries()) await raise(UIDS[i]!, m);
    await raise(UIDS[0]!, 20);
    await tick();
    expect((await tick()).detected).toBe(0);
    expect(await db.select().from(ceremonies)).toHaveLength(1);
  });

  it("expires a provisional ceremony once both clocks pass its deadline", async () => {
    for (const [i, m] of [0, 1, 2].entries()) await raise(UIDS[i]!, m);
    await raise(UIDS[0]!, 20);
    await tick();
    await raise(UIDS[0]!, 60 * 48); // log advances two days
    await tick(at(60 * 48));
    const [c] = await db.select().from(ceremonies);
    expect(c?.status).toBe("expired");
  });

  it("does not expire a ceremony the log has not caught up to", async () => {
    // Wall clock says 48h; the log has only reached minute 20. Expiring here
    // would retire a ceremony whose claim window we never actually observed.
    for (const [i, m] of [0, 1, 2].entries()) await raise(UIDS[i]!, m);
    await raise(UIDS[0]!, 20);
    await tick();
    await tick(new Date(T0.getTime() + 48 * 3_600_000));
    const [c] = await db.select().from(ceremonies);
    expect(c?.status).toBe("provisional");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm --filter @factions/bot test ceremony-tick`
Expected: FAIL — cannot resolve `../src/ceremony-tick.js`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/bot/src/ceremony-tick.ts
import type { Database } from "@factions/db";
import { ceremonies } from "@factions/db";
import { readCursor, writeCursor, readEventBatch } from "@factions/event-log";
import { settleWindows, qualifies } from "@factions/ceremony";
import { NEUTRAL_FLAG } from "@factions/domain";
import { and, eq, lte } from "drizzle-orm";
import type { CeremonyStore, PoleRef, Participant } from "./ceremony-store.js";

/**
 * ⚠️ Distinct from `pole-projector` and `identity-verifier`. Two consumers
 * sharing a cursor name each skip the other's events, and the symptom is
 * "detection randomly doesn't work" rather than an error. This is the third
 * consumer of this log; the collision is no longer hypothetical.
 */
export const CEREMONY_CONSUMER = "ceremony-detector";

export const PROVISIONAL_TTL_MS = 86_400_000;

export type CeremonyTickResult = {
  /** flag.raised events examined. */
  scanned: number;
  /** qualifying neutral-flag raises recorded. */
  recorded: number;
  /** windows consumed, whether or not they produced a ceremony. */
  settled: number;
  /** ceremonies created. */
  detected: number;
};

type FlagPayload = { dayzId: string; gamertag: string; texture: string; poleKey: string };

function readFlagPayload(payload: unknown): FlagPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.dayzId !== "string" || p.dayzId === "") return null;
  if (typeof p.texture !== "string" || p.texture === "") return null;
  if (typeof p.poleKey !== "string" || p.poleKey === "") return null;
  if (typeof p.gamertag !== "string" || p.gamertag === "") return null;
  return { dayzId: p.dayzId, gamertag: p.gamertag, texture: p.texture, poleKey: p.poleKey };
}

/** One pass: record qualifying raises, settle what the log has passed, expire what is stale. */
export async function ceremonyTick(
  db: Database,
  store: CeremonyStore,
  opts: { batchSize?: number; now?: Date; provisionalTtlMs?: number } = {},
): Promise<CeremonyTickResult> {
  const batchSize = opts.batchSize ?? 500;
  const now = opts.now ?? new Date();
  const ttl = opts.provisionalTtlMs ?? PROVISIONAL_TTL_MS;
  const out: CeremonyTickResult = { scanned: 0, recorded: 0, settled: 0, detected: 0 };

  // Phase 1 — record. The cursor advances here and only here.
  let cursor = await readCursor(db, CEREMONY_CONSUMER);
  for (;;) {
    const batch = await readEventBatch(db, cursor, batchSize);
    if (batch.length === 0) break;
    for (const ev of batch) {
      cursor = ev.id;
      if (ev.type !== "flag.raised") continue;
      const p = readFlagPayload(ev.payload);
      // A malformed payload is a parser bug, not a reason to stall the cursor.
      if (!p) continue;
      out.scanned++;
      if (p.texture !== NEUTRAL_FLAG) continue;

      const pole: PoleRef = { serverId: ev.serverId, poleKey: p.poleKey };
      if (await store.isPoleBound(pole)) continue;
      // Linkage is checked at PROCESSING time, not at raise time: someone who
      // links shortly after the ceremony still counts. The forgiving reading,
      // and it costs nothing.
      if (await store.linkedDiscordId(p.dayzId) === null) continue;

      await store.recordRaise({
        ...pole, dayzId: p.dayzId, gamertag: p.gamertag,
        occurredAt: ev.occurredAt, eventId: ev.id,
      });
      out.recorded++;
    }
    await writeCursor(db, CEREMONY_CONSUMER, cursor);
  }

  // Phase 2 — settle. Separate from phase 1 on purpose: the raises are already
  // durable, so a throw here loses nothing and the next pass settles them.
  for (const pole of await store.polesWithPendingRaises()) {
    const highWater = await store.highWaterMark(pole.serverId);
    if (!highWater) continue;
    const pending = await store.pendingRaises(pole);
    for (const w of settleWindows(pending, highWater)) {
      out.settled++;
      // While a ceremony is outstanding at this pole, windows are consumed but
      // never create. Otherwise a pole under sustained White raises would try
      // to insert a ceremony every window and the partial unique index would
      // surface each as an error rather than the no-op it is.
      const blocked = await store.hasOpenCeremony(pole);
      let draft = null;
      if (!blocked && qualifies(w)) {
        const participants: Participant[] = [];
        for (const dayzId of w.participants) {
          const discordId = await store.linkedDiscordId(dayzId);
          // Unlinked between recording and settling: skip rather than write a
          // participant with no Discord account to DM.
          if (!discordId) continue;
          const gamertag = w.raises.find((r) => r.dayzId === dayzId)?.gamertag ?? "";
          participants.push({ dayzId, discordId, gamertag });
        }
        if (qualifies({ ...w, participants: participants.map((x) => x.dayzId) })) {
          draft = { detectedAt: now, expiresAt: new Date(now.getTime() + ttl), participants };
        }
      }
      if (await store.settle(pole, w, draft) !== null) out.detected++;
    }
  }

  // Phase 3 — expire. Both clocks must have passed the deadline.
  //
  // ⚠️ The log-clock half is not redundant. If ingest stalls, wall-clock-only
  // expiry retires a ceremony whose claim window we never had the chance to
  // observe.
  for (const pole of await uniqueServers(store)) {
    const highWater = await store.highWaterMark(pole);
    if (!highWater) continue;
    const cutoff = highWater.getTime() < now.getTime() ? highWater : now;
    await db.update(ceremonies)
      .set({ status: "expired" })
      .where(and(
        eq(ceremonies.serverId, pole),
        eq(ceremonies.status, "provisional"),
        lte(ceremonies.expiresAt, cutoff),
      ));
  }

  return out;
}

/** Servers with at least one outstanding ceremony. */
async function uniqueServers(store: CeremonyStore): Promise<number[]> {
  const poles = await store.polesWithPendingRaises();
  return [...new Set(poles.map((p) => p.serverId))];
}
```

> **Note for the implementer:** `uniqueServers` as written only sees servers that still have *pending raises*, so a ceremony at a quiet pole would never expire. Add `openCeremonyServers(): Promise<number[]>` to `CeremonyStore` (a `selectDistinct` on `ceremonies.serverId where status = 'provisional'`) and use it here instead. The last two tests in Step 1 fail until you do — that is deliberate.

- [ ] **Step 4: Run the tests and typecheck**

Run: `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm --filter @factions/bot test ceremony-tick && pnpm --filter @factions/bot typecheck`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/ceremony-tick.ts apps/bot/src/ceremony-store.ts apps/bot/test/ceremony-tick.test.ts
git commit -m "feat(bot): ceremony detector reading the log's own clock"
```

---

### Task 7: DM the participants

**Files:**
- Create: `apps/bot/src/ceremony-notify.ts`
- Test: `apps/bot/test/ceremony-notify.test.ts`

**Interfaces:**
- Consumes: `Sender`, `Notification` (`apps/bot/src/discord.ts`), `createNotifyFailureLog`, `NotifyFailureLog`.
- Produces:
  ```ts
  export function formatCeremonyDm(c: { poleKey: string; participants: { gamertag: string }[]; expiresAt: Date }): string;
  export function notifyCeremonies(db: Database, send: Sender, now: () => Date, logged?: NotifyFailureLog): Promise<number>;
  ```

Mirrors `notifyCompleted`: a send failure leaves `notified_at` null so the next pass retries, rather than marking it done and dropping the message.

- [ ] **Step 1: Write the failing test**

```ts
// apps/bot/test/ceremony-notify.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, ceremonies, ceremonyParticipants, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { formatCeremonyDm, notifyCeremonies } from "../src/ceremony-notify.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-08-31T12:00:00Z");
const expiresAt = new Date(now.getTime() + 86_400_000);

describe("ceremony notification", () => {
  let db: Database;
  let serverId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table ceremony_participants, ceremonies, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
  });

  const detected = async (n: number) => {
    const [c] = await db.insert(ceremonies).values({
      serverId, poleKey: "1:2:3", windowStart: now, windowEnd: now,
      status: "provisional", detectedAt: now, expiresAt,
    }).returning();
    await db.insert(ceremonyParticipants).values(
      Array.from({ length: n }, (_, i) => ({
        ceremonyId: c!.id, dayzId: `${i}`.repeat(40), discordId: `10${i}`, gamertag: `P${i}`,
      })),
    );
    return c!.id;
  };

  it("states how many linked UIDs were counted", () => {
    // The only feedback available for the invisible near-miss: an unlinked
    // participant has no Discord id, so the group has to work out who is
    // missing from the count.
    const text = formatCeremonyDm({
      poleKey: "1:2:3", participants: [{ gamertag: "A" }, { gamertag: "B" }, { gamertag: "C" }], expiresAt,
    });
    expect(text).toMatch(/3 linked/i);
    expect(text).toContain("A");
    expect(text).toContain("/faction claim");
  });

  it("DMs every participant exactly once", async () => {
    await detected(3);
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await notifyCeremonies(db, send, () => now)).toBe(1);
    expect(send).toHaveBeenCalledTimes(3);
    expect(await notifyCeremonies(db, send, () => now)).toBe(0);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("leaves the ceremony pending when a send fails", async () => {
    // A closed DM must not consume the notification: the ceremony is real and
    // the message should land the moment it can.
    await detected(3);
    const send = vi.fn().mockRejectedValue(new Error("DMs closed"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await notifyCeremonies(db, send, () => now)).toBe(0);
    const [c] = await db.select().from(ceremonies);
    expect(c?.notifiedAt).toBeNull();
    logged.mockRestore();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm --filter @factions/bot test ceremony-notify`
Expected: FAIL — cannot resolve `../src/ceremony-notify.js`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/bot/src/ceremony-notify.ts
import type { Database } from "@factions/db";
import { ceremonies, ceremonyParticipants } from "@factions/db";
import { and, eq, isNull } from "drizzle-orm";
import { createNotifyFailureLog, type NotifyFailureLog, type Sender } from "./discord.js";

export function formatCeremonyDm(c: {
  poleKey: string;
  participants: { gamertag: string }[];
  expiresAt: Date;
}): string {
  const names = c.participants.map((p) => `**${p.gamertag}**`).join(", ");
  return [
    "**A ceremony was witnessed**",
    "",
    `At the flagpole at \`${c.poleKey}\`, ${c.participants.length} linked players raised the neutral flag together.`,
    "",
    `Counted: ${names} — **${c.participants.length} linked** players.`,
    // The near-miss is otherwise invisible: an unlinked participant has no
    // Discord account to write to, so the count is the only way a group that
    // came up short can work out who still needs to run /link.
    "If someone is missing from that list, they had not run `/link` when the ceremony was read.",
    "",
    "Any one of you can found the faction with `/faction claim`.",
    `This expires <t:${Math.floor(c.expiresAt.getTime() / 1000)}:R>.`,
  ].join("\n");
}

/**
 * DM the participants of every ceremony not yet announced.
 *
 * ⚠️ `notified_at` is written only after EVERY participant's DM succeeds. A
 * partial success retries the whole ceremony, which may re-DM someone — the
 * right trade: a duplicate message is a nuisance, a founding member who never
 * hears about their own ceremony is a lost faction.
 */
export async function notifyCeremonies(
  db: Database,
  send: Sender,
  now: () => Date,
  logged: NotifyFailureLog = createNotifyFailureLog(),
): Promise<number> {
  const pending = await db.select().from(ceremonies)
    .where(and(eq(ceremonies.status, "provisional"), isNull(ceremonies.notifiedAt)));

  let announced = 0;
  for (const c of pending) {
    const participants = await db.select().from(ceremonyParticipants)
      .where(eq(ceremonyParticipants.ceremonyId, c.id));
    if (participants.length === 0) continue;
    const content = formatCeremonyDm({ poleKey: c.poleKey, participants, expiresAt: c.expiresAt });
    try {
      for (const p of participants) {
        await send({ discordId: p.discordId, channelId: "", content });
      }
      await db.update(ceremonies).set({ notifiedAt: now() }).where(eq(ceremonies.id, c.id));
      logged.delete(c.id);
      announced++;
    } catch (err) {
      if (!logged.has(c.id)) {
        console.error(`ceremony DM failed for ceremony ${c.id}`, err);
        logged.add(c.id);
      }
    }
  }
  return announced;
}
```

> **Note for the implementer:** `Sender` falls back to a channel when a DM is closed, using `n.channelId`. A ceremony has no originating channel, so `channelId: ""` makes that fallback fail and the ceremony stays pending — which is the correct behaviour here (a ceremony must not be announced in public), but it means `send` will throw for a player with closed DMs. That is why the failure path is tested.

- [ ] **Step 4: Run the tests**

Run: `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm --filter @factions/bot test ceremony-notify`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/ceremony-notify.ts apps/bot/test/ceremony-notify.test.ts
git commit -m "feat(bot): DM ceremony participants with the linked count"
```

---

### Task 8: `/faction claim` command logic

**Files:**
- Create: `apps/bot/src/faction-store.ts`, `apps/bot/src/faction-commands.ts`
- Test: `apps/bot/test/faction-commands.test.ts`

**Interfaces:**
- Consumes: `factions`, `factionMembers`, `claimDrafts`, `ceremonies`, `ceremonyParticipants`; `CLAIMABLE_FLAGS`, `isClaimableFlag` (Task 1).
- Produces:
  ```ts
  export type ClaimDraftInput = { name: string; tag: string; texture: string };
  export type ClaimPrompt = { kind: "claim-confirm"; ceremonyId: number; participants: Participant[]; draft: ClaimDraftInput };
  export type FactionReply = { content: string; ephemeral: true; prompt?: ClaimPrompt };
  export function handleFactionClaim(deps: FactionDeps, discordId: string, input: ClaimDraftInput): Promise<FactionReply>;
  export function handleClaimConfirm(deps: FactionDeps, discordId: string, ceremonyId: number, keepDayzIds: string[]): Promise<FactionReply>;
  export class PgFactionStore implements FactionStore { constructor(db: Database) }
  ```

`FactionDeps` is `{ store: FactionStore; now: () => Date; reservationTtlMs: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/bot/test/faction-commands.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, ceremonies, ceremonyParticipants, factions, factionMembers, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { PgFactionStore } from "../src/faction-store.js";
import { handleFactionClaim, handleClaimConfirm, type FactionDeps } from "../src/faction-commands.js";

const URL = requireTestDatabaseUrl();
const UIDS = ["A", "B", "C"].map((c) => c.repeat(40));
const now = new Date("2026-08-31T12:00:00Z");

describe("faction claim", () => {
  let db: Database;
  let deps: FactionDeps;
  let serverId = 0;
  let ceremonyId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table faction_members, claim_drafts, factions, ceremony_participants, ceremonies, servers restart identity cascade`);
    deps = { store: new PgFactionStore(db), now: () => now, reservationTtlMs: 86_400_000 };
    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [c] = await db.insert(ceremonies).values({
      serverId, poleKey: "1:2:3", windowStart: now, windowEnd: now,
      status: "provisional", detectedAt: now, expiresAt: new Date(now.getTime() + 86_400_000),
    }).returning();
    ceremonyId = c!.id;
    await db.insert(ceremonyParticipants).values(UIDS.map((dayzId, i) => ({
      ceremonyId, dayzId, discordId: `10${i}`, gamertag: `P${i}`,
    })));
  });

  const input = { name: "The Bears", tag: "BEAR", texture: "Flag_Bear" };

  it("prompts a participant to prune the roster", async () => {
    const r = await handleFactionClaim(deps, "100", input);
    expect(r.prompt?.ceremonyId).toBe(ceremonyId);
    expect(r.prompt?.participants).toHaveLength(3);
  });

  it("refuses someone who was not at the ceremony", async () => {
    // §5's defense against claiming a ceremony you did not attend.
    const r = await handleFactionClaim(deps, "999", input);
    expect(r.prompt).toBeUndefined();
    expect(r.content).toMatch(/no ceremony/i);
  });

  it("refuses a flag outside the pool", async () => {
    const r = await handleFactionClaim(deps, "100", { ...input, texture: "Flag_White" });
    expect(r.content).toMatch(/not a claimable flag/i);
  });

  it("refuses a flag another faction holds", async () => {
    await db.insert(factions).values({
      serverId, name: "Other", tag: "OTH", texture: "Flag_Bear", poleKey: "9:9:9",
      x: "1.00", y: "2.00", z: "3.00", status: "active", leaderDiscordId: "900", createdAt: now,
    });
    const r = await handleFactionClaim(deps, "100", input);
    expect(r.content).toMatch(/already taken/i);
  });

  it("reserves the faction on confirm, with the claimant as leader", async () => {
    await handleFactionClaim(deps, "100", input);
    const r = await handleClaimConfirm(deps, "100", ceremonyId, UIDS);
    expect(r.content).toMatch(/reserved/i);
    const [f] = await db.select().from(factions);
    expect(f?.status).toBe("reserved");
    expect(f?.reservedUntil).toEqual(new Date(now.getTime() + 86_400_000));
    const members = await db.select().from(factionMembers).where(eq(factionMembers.factionId, f!.id));
    expect(members).toHaveLength(3);
    expect(members.find((m) => m.discordId === "100")?.role).toBe("leader");
  });

  it("writes only the kept participants to the roster", async () => {
    // The claimant prunes: a stranger who wandered into the ritual must not
    // land on the founding roster.
    await handleFactionClaim(deps, "100", input);
    await handleClaimConfirm(deps, "100", ceremonyId, [UIDS[0]!, UIDS[1]!]);
    const [f] = await db.select().from(factions);
    expect(await db.select().from(factionMembers).where(eq(factionMembers.factionId, f!.id))).toHaveLength(2);
  });

  it("refuses to prune the claimant out of their own faction", async () => {
    await handleFactionClaim(deps, "100", input);
    const r = await handleClaimConfirm(deps, "100", ceremonyId, [UIDS[1]!, UIDS[2]!]);
    expect(r.content).toMatch(/cannot remove yourself/i);
    expect(await db.select().from(factions)).toHaveLength(0);
  });

  it("marks the ceremony claimed", async () => {
    await handleFactionClaim(deps, "100", input);
    await handleClaimConfirm(deps, "100", ceremonyId, UIDS);
    const [c] = await db.select().from(ceremonies);
    expect(c?.status).toBe("claimed");
  });

  it("refuses a second claim of the same ceremony", async () => {
    // Two participants confirming concurrently: the loser must be told, not
    // handed a stack trace, and must not create a second faction.
    await handleFactionClaim(deps, "100", input);
    await handleClaimConfirm(deps, "100", ceremonyId, UIDS);
    const r = await handleClaimConfirm(deps, "101", ceremonyId, UIDS);
    expect(r.content).toMatch(/already been claimed/i);
    expect(await db.select().from(factions)).toHaveLength(1);
  });

  it("refuses to claim an expired ceremony", async () => {
    await db.update(ceremonies).set({ status: "expired" }).where(eq(ceremonies.id, ceremonyId));
    const r = await handleFactionClaim(deps, "100", input);
    expect(r.content).toMatch(/no ceremony/i);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm --filter @factions/bot test faction-commands`
Expected: FAIL — cannot resolve `../src/faction-store.js`.

- [ ] **Step 3: Write the store**

```ts
// apps/bot/src/faction-store.ts
import type { Database } from "@factions/db";
import { ceremonies, ceremonyParticipants, claimDrafts, factions, factionMembers } from "@factions/db";
import { and, eq, inArray } from "drizzle-orm";

const HOLDING = ["reserved", "active", "dormant"];

export type OpenCeremony = {
  id: number; serverId: number; poleKey: string;
  participants: { dayzId: string; discordId: string; gamertag: string }[];
};

export interface FactionStore {
  openCeremonyFor(discordId: string): Promise<OpenCeremony | null>;
  textureHeld(serverId: number, texture: string): Promise<boolean>;
  saveDraft(ceremonyId: number, discordId: string, d: { name: string; tag: string; texture: string }, at: Date): Promise<void>;
  loadDraft(ceremonyId: number, discordId: string): Promise<{ name: string; tag: string; texture: string } | null>;
  reserve(a: ReserveArgs): Promise<"ok" | "ceremony-taken" | "flag-taken" | "tag-taken">;
}

export type ReserveArgs = {
  ceremonyId: number; serverId: number; poleKey: string;
  name: string; tag: string; texture: string;
  leaderDiscordId: string;
  members: { dayzId: string; discordId: string }[];
  at: Date; reservedUntil: Date;
};

export class PgFactionStore implements FactionStore {
  constructor(private readonly db: Database) {}

  async openCeremonyFor(discordId: string): Promise<OpenCeremony | null> {
    const [row] = await this.db.select({ c: ceremonies })
      .from(ceremonies)
      .innerJoin(ceremonyParticipants, eq(ceremonyParticipants.ceremonyId, ceremonies.id))
      .where(and(eq(ceremonyParticipants.discordId, discordId), eq(ceremonies.status, "provisional")));
    if (!row) return null;
    const participants = await this.db.select({
      dayzId: ceremonyParticipants.dayzId,
      discordId: ceremonyParticipants.discordId,
      gamertag: ceremonyParticipants.gamertag,
    }).from(ceremonyParticipants).where(eq(ceremonyParticipants.ceremonyId, row.c.id));
    return { id: row.c.id, serverId: row.c.serverId, poleKey: row.c.poleKey, participants };
  }

  async textureHeld(serverId: number, texture: string): Promise<boolean> {
    const [row] = await this.db.select({ id: factions.id }).from(factions)
      .where(and(
        eq(factions.serverId, serverId),
        eq(factions.texture, texture),
        inArray(factions.status, HOLDING),
      ));
    return row !== undefined;
  }

  async saveDraft(ceremonyId: number, discordId: string, d: { name: string; tag: string; texture: string }, at: Date): Promise<void> {
    await this.db.insert(claimDrafts)
      .values({ ceremonyId, discordId, name: d.name, tag: d.tag, texture: d.texture, createdAt: at })
      .onConflictDoUpdate({
        target: claimDrafts.ceremonyId,
        set: { discordId, name: d.name, tag: d.tag, texture: d.texture, createdAt: at },
      });
  }

  async loadDraft(ceremonyId: number, discordId: string) {
    const [row] = await this.db.select().from(claimDrafts)
      .where(and(eq(claimDrafts.ceremonyId, ceremonyId), eq(claimDrafts.discordId, discordId)));
    return row ? { name: row.name, tag: row.tag, texture: row.texture } : null;
  }

  /**
   * Reserve the faction, write the roster, and retire the ceremony — one
   * transaction.
   *
   * ⚠️ Every guard is part of its own write. The ceremony is retired with
   * `status = 'provisional'` in the WHERE clause and its `.returning()` decides
   * whether we won; a pre-read followed by an unconditional write is exactly
   * the defect Plan 2 had to fix twice. The unique-violation catch is the same
   * story for flag and tag: another transaction may commit between any read and
   * this insert, so the index is the only thing that can decide.
   */
  async reserve(a: ReserveArgs): Promise<"ok" | "ceremony-taken" | "flag-taken" | "tag-taken"> {
    try {
      return await this.db.transaction(async (tx) => {
        const claimed = await tx.update(ceremonies)
          .set({ status: "claimed" })
          .where(and(eq(ceremonies.id, a.ceremonyId), eq(ceremonies.status, "provisional")))
          .returning({ id: ceremonies.id });
        if (claimed.length === 0) return "ceremony-taken" as const;

        const [f] = await tx.insert(factions).values({
          serverId: a.serverId, name: a.name, tag: a.tag, texture: a.texture,
          poleKey: a.poleKey, x: "0.00", y: "0.00", z: "0.00",
          status: "reserved", leaderDiscordId: a.leaderDiscordId,
          ceremonyId: a.ceremonyId, createdAt: a.at, reservedUntil: a.reservedUntil,
        }).returning({ id: factions.id });

        await tx.insert(factionMembers).values(a.members.map((m) => ({
          factionId: f!.id, dayzId: m.dayzId, discordId: m.discordId,
          role: m.discordId === a.leaderDiscordId ? "leader" : "member",
          joinedAt: a.at,
        })));

        await tx.delete(claimDrafts).where(eq(claimDrafts.ceremonyId, a.ceremonyId));
        return "ok" as const;
      });
    } catch (err) {
      const msg = String(err);
      if (msg.includes("factions_holding_texture_uniq")) return "flag-taken";
      if (msg.includes("factions_holding_tag_uniq")) return "tag-taken";
      throw err;
    }
  }
}
```

> **Note for the implementer:** the pole coordinates are written as `0.00` above. Carry the real `x`/`y`/`z` through from the ceremony instead — add them to `ceremonies` in Task 3's table (three `numeric(12,2)` columns alongside `pole_key`, populated from the raise payload in Task 6) and read them here. The pole key alone is enough to bind, but §7's raid credit will want the coordinates and backfilling them later means re-deriving from events.

- [ ] **Step 4: Write the command logic**

```ts
// apps/bot/src/faction-commands.ts
import { isClaimableFlag } from "@factions/domain";
import type { FactionStore } from "./faction-store.js";

export type ClaimDraftInput = { name: string; tag: string; texture: string };
export type ClaimParticipant = { dayzId: string; discordId: string; gamertag: string };
export type ClaimPrompt = {
  kind: "claim-confirm";
  ceremonyId: number;
  participants: ClaimParticipant[];
  draft: ClaimDraftInput;
};
export type FactionReply = { content: string; ephemeral: true; prompt?: ClaimPrompt };

export type FactionDeps = {
  store: FactionStore;
  now: () => Date;
  reservationTtlMs: number;
};

const reply = (content: string): FactionReply => ({ content, ephemeral: true });

const TAG_RE = /^[A-Za-z0-9]{2,5}$/u;

export async function handleFactionClaim(
  deps: FactionDeps,
  discordId: string,
  input: ClaimDraftInput,
): Promise<FactionReply> {
  const ceremony = await deps.store.openCeremonyFor(discordId);
  // §5: the claimant's linked UID must be among the participants. Because
  // participants are linked by construction, this is a lookup rather than a
  // trust decision.
  if (!ceremony) return reply("You have no ceremony to claim. Only someone counted in a witnessed ceremony can found a faction.");

  if (!isClaimableFlag(input.texture)) {
    return reply(`\`${input.texture}\` is not a claimable flag. The neutral flag is reserved, and only the 33 pool flags can be held.`);
  }
  if (!TAG_RE.test(input.tag)) {
    return reply("A tag must be 2-5 letters or digits — it becomes part of channel names.");
  }
  if (await deps.store.textureHeld(ceremony.serverId, input.texture)) {
    return reply(`\`${input.texture}\` is already taken on this server. Pick another.`);
  }

  await deps.store.saveDraft(ceremony.id, discordId, input, deps.now());
  return {
    content: `Founding **${input.name}** [${input.tag}] under \`${input.texture}\`. Confirm who belongs on the founding roster — remove anyone who wandered into the ceremony.`,
    ephemeral: true,
    prompt: { kind: "claim-confirm", ceremonyId: ceremony.id, participants: ceremony.participants, draft: input },
  };
}

export async function handleClaimConfirm(
  deps: FactionDeps,
  discordId: string,
  ceremonyId: number,
  keepDayzIds: string[],
): Promise<FactionReply> {
  const ceremony = await deps.store.openCeremonyFor(discordId);
  if (!ceremony || ceremony.id !== ceremonyId) return reply("That ceremony has already been claimed or has expired.");

  const draft = await deps.store.loadDraft(ceremonyId, discordId);
  if (!draft) return reply("That claim expired. Run `/faction claim` again.");

  const keep = new Set(keepDayzIds);
  const members = ceremony.participants.filter((p) => keep.has(p.dayzId));
  // The leader must be on their own roster, or the faction is created with no
  // one able to act for it.
  if (!members.some((m) => m.discordId === discordId)) {
    return reply("You cannot remove yourself from your own founding roster.");
  }

  const at = deps.now();
  const outcome = await deps.store.reserve({
    ceremonyId, serverId: ceremony.serverId, poleKey: ceremony.poleKey,
    name: draft.name, tag: draft.tag, texture: draft.texture,
    leaderDiscordId: discordId,
    members: members.map((m) => ({ dayzId: m.dayzId, discordId: m.discordId })),
    at, reservedUntil: new Date(at.getTime() + deps.reservationTtlMs),
  });

  if (outcome === "ceremony-taken") return reply("That ceremony has already been claimed.");
  if (outcome === "flag-taken") return reply(`\`${draft.texture}\` was just taken by another faction. Run \`/faction claim\` again with a different flag.`);
  if (outcome === "tag-taken") return reply(`The tag \`${draft.tag}\` was just taken. Run \`/faction claim\` again with a different tag.`);

  return reply([
    `**${draft.name}** [${draft.tag}] is **reserved**.`,
    "",
    `Raise \`${draft.texture}\` at your pole to bring the faction to life. Any member of the roster can do it.`,
    "If the flag is not up within 24 hours the reservation lapses and the flag returns to the pool.",
  ].join("\n"));
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm --filter @factions/bot test faction-commands && pnpm --filter @factions/bot typecheck`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/faction-store.ts apps/bot/src/faction-commands.ts apps/bot/test/faction-commands.test.ts
git commit -m "feat(bot): /faction claim with roster pruning and index-decided races"
```

---

### Task 9: Activation and lapse

**Files:**
- Modify: `apps/bot/src/ceremony-tick.ts` (add phase 2b and extend phase 3)
- Modify: `apps/bot/src/ceremony-store.ts` (add the two methods below)
- Test: `apps/bot/test/activation.test.ts`

**Interfaces:**
- Produces, on `CeremonyStore`:
  ```ts
  reservedFactionAt(p: PoleRef, texture: string): Promise<{ id: number } | null>;
  isRosterMember(factionId: number, dayzId: string): Promise<boolean>;
  activate(factionId: number, at: Date): Promise<boolean>;
  lapseReservations(serverId: number, cutoff: Date): Promise<number>;
  openCeremonyServers(): Promise<number[]>;
  ```
- `CeremonyTickResult` gains `activated: number` and `lapsed: number`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/bot/test/activation.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, identityLinks, factions, factionMembers, type Database } from "@factions/db";
import { appendEvent } from "@factions/event-log";
import { sql, eq } from "drizzle-orm";
import { PgCeremonyStore } from "../src/ceremony-store.js";
import { ceremonyTick } from "../src/ceremony-tick.js";

const URL = requireTestDatabaseUrl();
const MEMBER = "A".repeat(40);
const STRANGER = "Z".repeat(40);
const POLE = "1:2:3";
const T0 = new Date("2026-08-31T12:00:00Z");
const at = (m: number) => new Date(T0.getTime() + m * 60_000);

describe("activation and lapse", () => {
  let db: Database;
  let store: PgCeremonyStore;
  let serverId = 0;
  let admFileId = 0;
  let factionId = 0;
  let line = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table ceremony_participants, ceremonies, white_raises, faction_members, claim_drafts, factions, identity_links, consumer_cursors, events, raw_lines, adm_files, servers restart identity cascade`);
    store = new PgCeremonyStore(db);
    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: T0 }).returning();
    admFileId = f!.id;
    line = 0;
    await db.insert(identityLinks).values({ discordId: "100", dayzId: MEMBER, gamertag: "Steve", verifiedAt: T0 });
    const [fac] = await db.insert(factions).values({
      serverId, name: "The Bears", tag: "BEAR", texture: "Flag_Bear", poleKey: POLE,
      x: "1.00", y: "2.00", z: "3.00", status: "reserved", leaderDiscordId: "100",
      createdAt: T0, reservedUntil: new Date(T0.getTime() + 86_400_000),
    }).returning();
    factionId = fac!.id;
    await db.insert(factionMembers).values({ factionId, dayzId: MEMBER, discordId: "100", role: "leader", joinedAt: T0 });
  });

  const raise = (dayzId: string, minutes: number, texture: string, poleKey = POLE) =>
    appendEvent(db, {
      serverId, admFileId, lineIndex: line++, subIndex: 0,
      type: "flag.raised", occurredAt: at(minutes),
      payload: { gamertag: "Steve", dayzId, texture, action: "raised", poleKey, pole: { x: 1, y: 2, z: 3 } },
    });

  const tick = (now = at(30)) => ceremonyTick(db, store, { batchSize: 100, now });
  const status = async () => (await db.select().from(factions).where(eq(factions.id, factionId)))[0]?.status;

  it("activates when a roster member raises the faction's flag at its pole", async () => {
    await raise(MEMBER, 1, "Flag_Bear");
    expect((await tick()).activated).toBe(1);
    expect(await status()).toBe("active");
    const [f] = await db.select().from(factions);
    expect(f?.activatedAt).toEqual(at(1));
  });

  it("does not activate for a UID off the roster", async () => {
    // The log must prove a roster member was physically at the pole.
    await raise(STRANGER, 1, "Flag_Bear");
    expect((await tick()).activated).toBe(0);
    expect(await status()).toBe("reserved");
  });

  it("does not activate on the wrong texture", async () => {
    await raise(MEMBER, 1, "Flag_Wolf");
    expect(await status()).toBe("reserved");
  });

  it("does not activate at the wrong pole", async () => {
    await raise(MEMBER, 1, "Flag_Bear", "9:9:9");
    await tick();
    expect(await status()).toBe("reserved");
  });

  it("activates only once", async () => {
    await raise(MEMBER, 1, "Flag_Bear");
    await tick();
    await raise(MEMBER, 2, "Flag_Bear");
    expect((await tick()).activated).toBe(0);
    expect(await status()).toBe("active");
  });

  it("lapses a reservation once both clocks pass the deadline", async () => {
    await raise(MEMBER, 60 * 48, "Flag_Wolf"); // log advances two days
    expect((await tick(at(60 * 48))).lapsed).toBe(1);
    expect(await status()).toBe("lapsed");
  });

  it("does not lapse while the log is behind the deadline", async () => {
    // ⚠️ The whole point of the two-clock rule: if ingest stalls, a faction
    // that DID raise its flag would otherwise be retired because the proof was
    // never ingested.
    await raise(MEMBER, 1, "Flag_Wolf");
    expect((await tick(new Date(T0.getTime() + 48 * 3_600_000))).lapsed).toBe(0);
    expect(await status()).toBe("reserved");
  });

  it("frees the flag when a reservation lapses", async () => {
    await raise(MEMBER, 60 * 48, "Flag_Wolf");
    await tick(at(60 * 48));
    await expect(db.insert(factions).values({
      serverId, name: "Other", tag: "OTH", texture: "Flag_Bear", poleKey: "9:9:9",
      x: "1.00", y: "2.00", z: "3.00", status: "reserved", leaderDiscordId: "900",
      createdAt: T0, reservedUntil: new Date(T0.getTime() + 86_400_000),
    })).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm --filter @factions/bot test activation`
Expected: FAIL — `activated` is undefined on the result.

- [ ] **Step 3: Add the store methods**

Append to `PgCeremonyStore` in `apps/bot/src/ceremony-store.ts`:

```ts
  async reservedFactionAt(p: PoleRef, texture: string): Promise<{ id: number } | null> {
    const [row] = await this.db.select({ id: factions.id }).from(factions)
      .where(and(
        eq(factions.serverId, p.serverId),
        eq(factions.poleKey, p.poleKey),
        eq(factions.texture, texture),
        eq(factions.status, "reserved"),
      ));
    return row ?? null;
  }

  async isRosterMember(factionId: number, dayzId: string): Promise<boolean> {
    const [row] = await this.db.select({ id: factionMembers.id }).from(factionMembers)
      .where(and(eq(factionMembers.factionId, factionId), eq(factionMembers.dayzId, dayzId)));
    return row !== undefined;
  }

  /** Guarded on `reserved`: a concurrent lapse must not be overwritten. */
  async activate(factionId: number, at: Date): Promise<boolean> {
    const done = await this.db.update(factions)
      .set({ status: "active", activatedAt: at, reservedUntil: null })
      .where(and(eq(factions.id, factionId), eq(factions.status, "reserved")))
      .returning({ id: factions.id });
    return done.length > 0;
  }

  async lapseReservations(serverId: number, cutoff: Date): Promise<number> {
    const done = await this.db.update(factions)
      .set({ status: "lapsed" })
      .where(and(
        eq(factions.serverId, serverId),
        eq(factions.status, "reserved"),
        lte(factions.reservedUntil, cutoff),
      ))
      .returning({ id: factions.id });
    return done.length;
  }

  async openCeremonyServers(): Promise<number[]> {
    const rows = await this.db.selectDistinct({ serverId: ceremonies.serverId })
      .from(ceremonies).where(eq(ceremonies.status, "provisional"));
    return rows.map((r) => r.serverId);
  }

  async reservedServers(): Promise<number[]> {
    const rows = await this.db.selectDistinct({ serverId: factions.serverId })
      .from(factions).where(eq(factions.status, "reserved"));
    return rows.map((r) => r.serverId);
  }
```

Add `factionMembers` and `lte` to the imports at the top of the file.

- [ ] **Step 4: Wire activation into the tick**

In `apps/bot/src/ceremony-tick.ts`, extend `CeremonyTickResult` with `activated: number; lapsed: number` (initialise both to 0), and inside the phase-1 event loop, **before** the `texture !== NEUTRAL_FLAG` early-continue, insert:

```ts
      // Activation: a reserved faction comes alive when its own flag goes up at
      // its own pole, raised by someone on its roster. Everything needed is
      // already in the event being read.
      if (p.texture !== NEUTRAL_FLAG) {
        const reserved = await store.reservedFactionAt(pole, p.texture);
        if (reserved && await store.isRosterMember(reserved.id, p.dayzId)) {
          if (await store.activate(reserved.id, ev.occurredAt)) out.activated++;
        }
        continue;
      }
```

Note this requires `pole` to be computed before the texture check — move the `const pole: PoleRef = ...` line above it.

Then replace phase 3 wholesale:

```ts
  // Phase 3 — expire and lapse. BOTH clocks must have passed the deadline.
  //
  // ⚠️ The log-clock half is not redundant. If ingest stalls for a day,
  // wall-clock-only expiry retires a ceremony whose claim window we never had
  // the chance to observe, and lapses a faction that DID raise its flag.
  const servers = new Set([...await store.openCeremonyServers(), ...await store.reservedServers()]);
  for (const serverId of servers) {
    const highWater = await store.highWaterMark(serverId);
    if (!highWater) continue;
    const cutoff = highWater.getTime() < now.getTime() ? highWater : now;
    await db.update(ceremonies)
      .set({ status: "expired" })
      .where(and(
        eq(ceremonies.serverId, serverId),
        eq(ceremonies.status, "provisional"),
        lte(ceremonies.expiresAt, cutoff),
      ));
    out.lapsed += await store.lapseReservations(serverId, cutoff);
  }
```

Delete the now-unused `uniqueServers` helper.

- [ ] **Step 5: Run the tests and typecheck**

Run: `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm --filter @factions/bot test && pnpm --filter @factions/bot typecheck`
Expected: PASS — 8 new tests, and the Task 6 suite still green.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/ceremony-tick.ts apps/bot/src/ceremony-store.ts apps/bot/test/activation.test.ts
git commit -m "feat(bot): activate a reservation from the observed flag raise"
```

---

### Task 10: Discord wiring

**Files:**
- Modify: `apps/bot/src/discord.ts`
- Modify: `apps/bot/src/config.ts` (add `reservationTtlMs`)
- Test: `apps/bot/test/faction-wiring.test.ts`, `apps/bot/test/config.test.ts` (extend)

**Interfaces:**
- Consumes: `handleFactionClaim`, `handleClaimConfirm`, `ClaimPrompt` (Task 8); `ceremonyTick` (Tasks 6, 9); `notifyCeremonies` (Task 7).
- Produces: `buildCommands()` gains `/faction claim`; `routeInteraction` handles it; a new `routeComponent(deps, i)` handles the confirm.

- [ ] **Step 1: Write the failing test**

```ts
// apps/bot/test/faction-wiring.test.ts
import { describe, it, expect } from "vitest";
import { buildCommands, claimCustomId, parseClaimCustomId } from "../src/discord.js";

describe("faction wiring", () => {
  it("registers /faction claim with its three options", () => {
    const faction = buildCommands().find((c) => c.name === "faction");
    expect(faction).toBeDefined();
    const claim = (faction as { options?: { name: string; options?: { name: string }[] }[] })
      .options?.find((o) => o.name === "claim");
    expect(claim?.options?.map((o) => o.name)).toEqual(["name", "tag", "flag"]);
  });

  it("round-trips a ceremony id through a custom id", () => {
    expect(parseClaimCustomId(claimCustomId(42))).toBe(42);
  });

  it("refuses a custom id that is not ours", () => {
    // Discord delivers every component interaction in the guild; a foreign
    // custom id must not be parsed into a ceremony id.
    expect(parseClaimCustomId("something-else")).toBeNull();
    expect(parseClaimCustomId("claim-confirm:notanumber")).toBeNull();
  });

  it("keeps the custom id inside Discord's 100-character limit", () => {
    // The reason a claim draft is a database row rather than encoded here.
    expect(claimCustomId(Number.MAX_SAFE_INTEGER).length).toBeLessThanOrEqual(100);
  });
});
```

Extend `apps/bot/test/config.test.ts` with:

```ts
  it("defaults the reservation window to 24 hours", () => {
    expect(loadConfig(baseEnv()).reservationTtlMs).toBe(86_400_000);
  });
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `pnpm --filter @factions/bot test faction-wiring config`
Expected: FAIL — `claimCustomId` is not exported; `reservationTtlMs` is undefined.

- [ ] **Step 3: Add the config value**

In `apps/bot/src/config.ts`, add to `BotConfig` and `loadConfig`:

```ts
    reservationTtlMs: positiveInt(env, "BOT_RESERVATION_TTL_MS", 86_400_000),
```

- [ ] **Step 4: Add the command, the custom id, and the routes**

In `apps/bot/src/discord.ts`:

```ts
export const CLAIM_PREFIX = "claim-confirm:";

/** Discord caps a custom id at 100 characters, which is why only the id rides here. */
export const claimCustomId = (ceremonyId: number): string => `${CLAIM_PREFIX}${ceremonyId}`;

export function parseClaimCustomId(customId: string): number | null {
  if (!customId.startsWith(CLAIM_PREFIX)) return null;
  const n = Number(customId.slice(CLAIM_PREFIX.length));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
```

Add to `buildCommands()`:

```ts
    new SlashCommandBuilder().setName("faction")
      .setDescription("Faction commands")
      .addSubcommand((s) => s.setName("claim")
        .setDescription("Found a faction from a ceremony you took part in")
        .addStringOption((o) => o.setName("name").setDescription("Faction name").setRequired(true).setMaxLength(64))
        .addStringOption((o) => o.setName("tag").setDescription("Short tag, 2-5 letters or digits").setRequired(true).setMaxLength(5))
        .addStringOption((o) => o.setName("flag").setDescription("One of the 33 claimable flags").setRequired(true).setAutocomplete(true))),
```

Extend `InteractionLike` with `options?: { name: string; tag: string; flag: string }` and add to `routeInteraction`, before the `known` check:

```ts
  if (i.commandName === "faction" && i.options) {
    return handleFactionClaim(factionDeps, i.userId, {
      name: i.options.name, tag: i.options.tag, texture: i.options.flag,
    });
  }
```

Add the component route:

```ts
export type ComponentLike = { customId: string; userId: string; values: string[] };

export async function routeComponent(deps: FactionDeps, i: ComponentLike): Promise<FactionReply | null> {
  const ceremonyId = parseClaimCustomId(i.customId);
  if (ceremonyId === null) return null;
  return handleClaimConfirm(deps, i.userId, ceremonyId, i.values);
}
```

- [ ] **Step 5: Render the prompt and handle the component in `start()`**

In the `interactionCreate` handler, after computing `reply`, when `reply.prompt` is present, respond with a string-select of the participants (values are `dayzId`, labels are `gamertag`, `minValues: 1`, `maxValues: participants.length`, all pre-selected via `default: true`) inside an `ActionRowBuilder`, using `claimCustomId(reply.prompt.ceremonyId)` as the select's custom id. Add a second listener branch for `interaction.isStringSelectMenu()` that calls `routeComponent` and replies with its content.

> **⚠️ Use `deferReply({ flags: MessageFlags.Ephemeral })` before `handleFactionClaim`, then `editReply`.** The handler makes four or more database round trips and Discord's initial-response window is 3 seconds; without the defer the first claim can fail with "The application did not respond" *after* the draft row was written. This is inbox item 10, and it is not optional for this command.

- [ ] **Step 6: Wire the tick and the notifier into the loop**

In `start()`, alongside the existing runner body, add `ceremonyTick` and `notifyCeremonies` — each in **its own** try/catch, so a failing detector cannot stop ceremony DMs (inbox item 11):

```ts
    try {
      const c = await ceremonyTick(db, ceremonyStore, { now: () => new Date() });
      if (c.detected > 0 || c.activated > 0 || c.lapsed > 0) {
        console.log(`ceremonies detected ${c.detected}, activated ${c.activated}, lapsed ${c.lapsed}`);
      }
    } catch (err) {
      console.error("ceremony tick failed", err);
    }
    try {
      await notifyCeremonies(db, send, () => new Date(), ceremonyFailures);
    } catch (err) {
      console.error("ceremony notify failed", err);
    }
```

- [ ] **Step 7: Run the full bot suite and typecheck**

Run: `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm --filter @factions/bot test && pnpm --filter @factions/bot typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/bot/src/discord.ts apps/bot/src/config.ts apps/bot/test/faction-wiring.test.ts apps/bot/test/config.test.ts
git commit -m "feat(bot): register /faction claim and run the detector in the loop"
```

---

### Task 11: Acceptance against the production export

**Files:**
- Create: `docs/acceptance/2026-08-31-ceremony-detection.md`

**Interfaces:** none — this task produces evidence, not code.

**⚠️ Use the backfill database, not the test database.** The DB suites truncate the shared one; a backfill followed by a test run reads as a regression when it is only a truncation.

- [ ] **Step 1: Replay the export into the backfill database**

```bash
docker compose up -d postgres
docker compose exec -T postgres psql -U factions -d postgres -c "DROP DATABASE IF EXISTS factions_backfill;" 
docker compose exec -T postgres psql -U factions -d postgres -c "CREATE DATABASE factions_backfill;"
export BACKFILL_URL="postgres://factions:factions@localhost:5434/factions_backfill"
DATABASE_URL="$BACKFILL_URL" pnpm --filter @factions/db exec tsx -e "import {createClient,runMigrations} from './src/index.js'; await runMigrations(createClient(process.env.DATABASE_URL!)); process.exit(0)"
```

Then run the Plan 1 replay entry point (`apps/ingest-worker/src/replay-main.ts`) against `$BACKFILL_URL`, with `CLOCK_OFFSET_MS` set as Plan 1 requires — it has no default and the worker refuses to start without it.

- [ ] **Step 2: Run the detector over the whole backfill**

```bash
DATABASE_URL="$BACKFILL_URL" pnpm --filter @factions/bot exec tsx -e "
import { createClient } from '@factions/db';
import { PgCeremonyStore } from './src/ceremony-store.js';
import { ceremonyTick } from './src/ceremony-tick.js';
const db = createClient(process.env.DATABASE_URL!);
console.log(await ceremonyTick(db, new PgCeremonyStore(db), { batchSize: 1000 }));
process.exit(0);
"
```

- [ ] **Step 3: Verify the counts**

```bash
docker compose exec -T postgres psql -U factions -d factions_backfill -c "select count(*) as ceremonies from ceremonies;"
docker compose exec -T postgres psql -U factions -d factions_backfill -c "select count(*) as white_raises from white_raises;"
docker compose exec -T postgres psql -U factions -d factions_backfill -c "select type, count(*) from events group by type order by 2 desc;"
docker compose exec -T postgres psql -U factions -d factions_backfill -c "select payload->>'action' as action, count(*) from events where type in ('flag.raised','flag.lowered') group by 1;"
```

Acceptance criteria:

| Check | Expected |
|---|---|
| Ceremonies detected | **0** |
| `white_raises` recorded | **0** |
| Flag changes / raises / lowers | **14 / 10 / 4** — unchanged from Plan 1 |
| `emote.performed` | **2,093** — unchanged from Plan 2 |

**Zero is the point.** The export contains no `Flag_White` events across 69,326 lines and five weeks, so a non-zero ceremony count is a false positive on real data at real scale — the single most valuable number this plan can produce. If it is not zero, stop and find out why before continuing; a detector that invents ceremonies would hand out faction identities from a 33-slot pool to nobody.

- [ ] **Step 4: Run the full suite**

```bash
export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"
pnpm run ci
```

Expected: every task passes, 0 skipped, and the test count has grown from **255** by the tests this plan adds. Check the number, not just the exit code.

- [ ] **Step 5: Record the results**

Write `docs/acceptance/2026-08-31-ceremony-detection.md` with the **actual observed** numbers, the commands used, and the date. Include a section headed **"Not yet accepted: a real ceremony"** stating plainly that no human has performed one, that every ceremony fixture encodes an assumption about the wire format, and that the staged-ceremony gate below is outstanding.

- [ ] **Step 6: Record the staged-ceremony gate**

Add to the acceptance doc, as an unchecked item:

```markdown
- [ ] **Staged ceremony (REQUIRED before the detector is trusted in production).**
      Three or more linked players stand at a pole flying Flag_White and each raise
      it within ten minutes. Ingest that day's ADM. Confirm: one ceremony detected,
      the participant list matches who was actually there, and every participant
      received the DM. Record the ADM line excerpts here.
```

- [ ] **Step 7: Commit**

```bash
git add docs/acceptance/2026-08-31-ceremony-detection.md
git commit -m "docs: ceremony detection acceptance — zero false positives on the export"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §2 predicate: raise-only, White, linked-only | 6 (qualification), 2 (windowing) |
| §3 self-evidencing predicate | 6 — texture read off the event, no projector dependency |
| §4 `white_raises` | 3, 5 |
| §4 `ceremonies`, `ceremony_participants` | 3 |
| §4 `factions`, `faction_members`, `claim_drafts` | 4 |
| §4 no `flag_pool` table | 1 (constant), 4 (partial unique indexes) |
| §5 separate cursor | 6 (`ceremony-detector`) |
| §5 windows settle, non-overlapping, anchored | 2 (pure), 5 (`settle` consumes), 6 (loop) |
| §5 log-clock settling | 2, 5 (`highWaterMark`), 6 |
| §5 no second window while provisional outstanding | 6, enforced by 3's partial index |
| §5 DM with linked count | 7 |
| §6 `/faction claim`, pruning | 8, 10 |
| §6 races on indexes | 8 (`reserve`) |
| §6 activation | 9 |
| §6 two-clock lapse | 9 |
| §7 threat model — injection fixture | **Gap: see below** |
| §8 pure core | 2 |
| §8 fixtures | 6, 9 |
| §8 zero-ceremony real-data acceptance | 11 |
| §8 staged-ceremony gate | 11 Step 6 |

**Gap found and closed:** the spec makes one adversarial fixture mandatory — a gamertag containing a White-raise clause, which must not fabricate a participant — and no task above carried it. It belongs in the parser package, where the anchoring guarantee lives, rather than in the detector. **Add to Task 6 as a step before its commit:**

```ts
// packages/adm-parser/test/flag.test.ts — append
it("does not read a raise clause worn in the gamertag", () => {
  // A detector that counts distinct UIDs is a new consumer of the anchoring
  // guarantee, and "3 distinct UIDs" is exactly what an injected line would
  // try to manufacture.
  const line = `12:00:00 | Player "has raised Flag_White on TerritoryFlag" (id=${"A".repeat(40)} pos=<1.0, 2.0, 3.0>) has been disconnected`;
  expect(parseFlagChange(line)).toBeNull();
});
```

**Placeholder scan:** clean. Two `> **Note for the implementer:**` blocks are deliberate — Task 6's names a bug seeded in its own code that its last two tests catch, and Task 8's asks for the pole coordinates to be carried on `ceremonies`. Both state exactly what to do.

**Type consistency:** `QualifyingRaise` and `SettledWindow` are defined once in Task 2 and consumed unchanged by Tasks 5 and 6. `PoleRef` is defined in Task 5 and used by 6 and 9. `CeremonyStore` gains methods only in Task 9, listed explicitly. `FactionReply` is defined in Task 8 and consumed by Task 10. `Participant` (Task 5) and `ClaimParticipant` (Task 8) are the same shape under two names — **use `Participant` from `ceremony-store.ts` in both** and delete `ClaimParticipant`.

**Scope check:** eleven tasks, matching Plan 2's size. Task 10 is the largest and least test-covered, because Discord component rendering is not unit-testable without a client — its logic is pushed into `routeComponent` and `parseClaimCustomId`, which are.
