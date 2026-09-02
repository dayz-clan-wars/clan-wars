# Faction Dormancy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A faction whose flag stops flying loses its supplies after 7 days, and its flag, tag and pole after 14 more.

**Architecture:** A new bot-side `dormancyTick` reads each faction's last qualifying `flag.raised` event, runs a pure `decide()` over it, and applies one of three guarded status transitions. Supplies follow from status alone — the worker's supply projection swaps its `HOLDING_STATUSES` filter for a new, narrower `SUPPLIED_STATUSES`, and the two processes never coordinate.

**Tech Stack:** TypeScript, drizzle-orm 0.36 over postgres.js, vitest, discord.js. pnpm workspace with turbo.

**Spec:** `docs/superpowers/specs/2026-09-02-faction-dormancy-design.md`

## Global Constraints

- **Test database:** every DB-backed suite needs `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"`. Never point it at `factions_live`.
- **Full gate:** `TEST_DATABASE_URL=... npx turbo run typecheck test --concurrency=1 --force` from the repo root. A cached pass proves nothing; always `--force`.
- **`HOLDING_STATUSES` keeps its exact current value** `["reserved", "active", "dormant"]`. It is mirrored by three partial unique indexes in SQL. Nothing in this plan changes it.
- **`SUPPLIED_STATUSES` is `["reserved", "active"]`.** `reserved` is included deliberately — the kit is what lets a new faction raise its flag.
- **Windows:** dormant after `604_800_000` ms (7 days), disband after a further `1_209_600_000` ms (14 days). Both configurable; those are the defaults.
- **Texture matching is part of the signal.** A raise only counts if `payload->>'texture'` equals the faction's own texture.
- **No pole coordinates in any DM.**
- **No public channel announcements.** Dormancy is raid intelligence.
- **Commit after every task.** Message bodies explain *why*, in the style of the existing log.

---

### Task 1: Split identity from supply eligibility

**Files:**
- Modify: `packages/domain/src/factions.ts`
- Test: `packages/domain/test/factions.test.ts` (create if absent)
- Modify: `apps/ingest-worker/src/supply-tick.ts:30-40`
- Test: `apps/ingest-worker/test/supply-tick.test.ts`
- Test: `packages/db/test/holding-index-drift.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `SUPPLIED_STATUSES: readonly ["reserved", "active"]` exported from `@factions/domain`.

- [ ] **Step 1: Write the failing domain test**

Create/append `packages/domain/test/factions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { HOLDING_STATUSES, SUPPLIED_STATUSES } from "../src/factions.js";

describe("faction status sets", () => {
  it("holds identity for reserved, active and dormant", () => {
    // ⚠️ Mirrored by three partial unique indexes in SQL. Changing this
    // without changing them releases a dormant faction's flag, tag and pole.
    expect([...HOLDING_STATUSES]).toEqual(["reserved", "active", "dormant"]);
  });

  it("supplies reserved and active only", () => {
    // Dormant is the whole point: a faction whose flag stopped flying keeps
    // its identity and loses its kit.
    expect([...SUPPLIED_STATUSES]).toEqual(["reserved", "active"]);
  });

  it("every supplied status also holds its pole", () => {
    // A faction receiving supplies at a pole it does not hold is incoherent.
    for (const s of SUPPLIED_STATUSES) expect(HOLDING_STATUSES).toContain(s);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/domain && npx vitest run test/factions.test.ts`
Expected: FAIL — `SUPPLIED_STATUSES` is not exported.

- [ ] **Step 3: Add the constant**

In `packages/domain/src/factions.ts`, sharpen the existing docstring and append:

```ts
/**
 * The statuses in which a faction HOLDS its pole, flag and tag.
 *
 * ⚠️ This set means identity and NOTHING ELSE. It is mirrored by three
 * partial unique indexes (`factions_holding_texture_uniq`,
 * `factions_holding_tag_uniq`, `factions_holding_pole_uniq`), whose
 * predicates enumerate these same three statuses as SQL literals — see
 * `packages/db/test/holding-index-drift.test.ts`, which fails if they
 * diverge. `dormant` is here on purpose: being raided, or going quiet, must
 * never cost a faction its identity.
 *
 * For "does this faction receive supplies", use SUPPLIED_STATUSES.
 */
export const HOLDING_STATUSES = ["reserved", "active", "dormant"] as const;

/**
 * The statuses in which a faction receives a supply kit.
 *
 * `reserved` is included deliberately: the kit is what lets a newly claimed
 * faction raise its flag in the first place (see the supplies design, §2.2).
 *
 * `dormant` is excluded, and that exclusion is the entire mechanism by which
 * a stale flag stops the supplies — the projection reads status and nothing
 * else, so no coordination between the bot and the worker is needed.
 */
export const SUPPLIED_STATUSES = ["reserved", "active"] as const;
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd packages/domain && npx vitest run test/factions.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the failing supply-projection test**

Append inside the existing `describe("supplyTick", ...)` in `apps/ingest-worker/test/supply-tick.test.ts`:

```ts
it("⚠️ omits a dormant faction — this is how a stale flag stops the kit", async () => {
  // The bot sets the status; the worker only reads it. Nothing coordinates
  // the two, which is why this filter is the whole mechanism.
  const active = await seedFaction({ tag: "COK", texture: "Flag_Rooster", x: "1", y: "2", z: "3", status: "active" });
  await seedFaction({ tag: "DRM", texture: "Flag_Wolf", x: "4", y: "5", z: "6", status: "dormant" });
  const bodies: string[] = [];
  const client = { uploadFile: async (_d: string, _n: string, b: string) => { bodies.push(b); } };

  const r = await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
  expect(r.factions).toBe(1);
  const tags = new Set(JSON.parse(bodies[0]!).Objects.map((o: any) => o.customString));
  expect([...tags]).toEqual(["COK"]);
  expect(active.status).toBe("active");
});

it("changes the hash when a faction goes dormant, so the file is re-uploaded", async () => {
  // Without a hash change the tick short-circuits and the dormant faction's
  // kit keeps respawning at every restart forever.
  const f = await seedFaction({ tag: "COK", texture: "Flag_Rooster", x: "1", y: "2", z: "3", status: "active" });
  const bodies: string[] = [];
  const client = { uploadFile: async (_d: string, _n: string, b: string) => { bodies.push(b); } };
  await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
  await db.update(factions).set({ status: "dormant" }).where(eq(factions.id, f.id));
  await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
  expect(bodies).toHaveLength(2);
  expect(JSON.parse(bodies[1]!)).toEqual({ Objects: [] });
});
```

- [ ] **Step 6: Run them and watch them fail**

Run: `cd apps/ingest-worker && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/supply-tick.test.ts`
Expected: FAIL — the dormant faction is included, so `r.factions` is 2 and the second body is not empty.

- [ ] **Step 7: Switch the projection to `SUPPLIED_STATUSES`**

In `apps/ingest-worker/src/supply-tick.ts`, change the import from `HOLDING_STATUSES` to `SUPPLIED_STATUSES` and the filter:

```ts
import { SUPPLIED_STATUSES } from "@factions/domain";
```

```ts
    .where(and(
      eq(factions.serverId, deps.serverId),
      // ⚠️ SUPPLIED, not HOLDING. A dormant faction still holds its flag, tag
      // and pole — that is what HOLDING means — but it does not get a kit.
      // This one line is the whole supply half of faction dormancy.
      inArray(factions.status, [...SUPPLIED_STATUSES]),
    ))
```

⚠️ The `orderBy(asc(factions.tag))` comment above it cites `factions_holding_tag_uniq` as the reason a tag is a total order. That index is over the HOLDING statuses, which is a superset of SUPPLIED, so uniqueness still holds. Leave the comment but extend it with: `SUPPLIED is a subset of HOLDING, so that index still makes tag total here.`

- [ ] **Step 8: Run them and watch them pass**

Run: `cd apps/ingest-worker && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run`
Expected: PASS. The golden-hash test is unaffected — it seeds no dormant factions.

- [ ] **Step 9: Write the index-drift test**

Create `packages/db/test/holding-index-drift.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, type Database } from "@factions/db";
import { HOLDING_STATUSES } from "@factions/domain";
import { sql } from "drizzle-orm";

const URL = requireTestDatabaseUrl();

/**
 * ⚠️ HOLDING_STATUSES exists twice: once in TypeScript, once as a SQL literal
 * in each of three partial unique index predicates. They are two statements
 * of one fact and nothing but this test holds them together. Drift means a
 * faction keeps or loses its flag, tag or pole in a state nobody intended.
 */
describe("faction scarcity indexes match HOLDING_STATUSES", () => {
  let db: Database;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
  });

  const INDEXES = [
    "factions_holding_texture_uniq",
    "factions_holding_tag_uniq",
    "factions_holding_pole_uniq",
  ];

  it("enumerates exactly the holding statuses in every predicate", async () => {
    const rows = await db.execute(sql`
      select indexname, indexdef from pg_indexes
      where schemaname = 'public' and indexname = any(${sql.raw(`ARRAY['${INDEXES.join("','")}']`)})
    `);
    const found = rows as unknown as { indexname: string; indexdef: string }[];
    expect(found.map((r) => r.indexname).sort()).toEqual([...INDEXES].sort());

    for (const row of found) {
      const statuses = [...row.indexdef.matchAll(/'([a-z]+)'::text/g)].map((m) => m[1]);
      expect(new Set(statuses)).toEqual(new Set(HOLDING_STATUSES));
    }
  });
});
```

- [ ] **Step 10: Run it and confirm it passes against the current schema**

Run: `cd packages/db && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/holding-index-drift.test.ts`
Expected: PASS.

Then prove it can fail: temporarily add `"lapsed"` to `HOLDING_STATUSES`, re-run, confirm FAIL, and revert. A drift guard that cannot fail is not a guard.

- [ ] **Step 11: Full gate and commit**

```bash
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force
git add -A && git commit -m "feat(domain): split supply eligibility from pole identity

HOLDING_STATUSES meant two things at once: which statuses hold a flag, tag
and pole, and which receive a supply kit. Dormancy needs those to differ —
a dormant faction keeps its identity and loses its supplies — and the set
cannot simply be narrowed, because it is mirrored by three partial unique
indexes whose predicates are what preserve that identity.

SUPPLIED_STATUSES is the new, narrower set; the supply projection reads it
and nothing else, so no coordination between bot and worker is needed.

Adds a test that reads pg_indexes and fails if the SQL predicates and the
TypeScript constant ever diverge — previously guarded by a comment only."
```

---

### Task 2: Add `factions.dormant_since`

**Files:**
- Modify: `packages/db/src/schema.ts:432-451`
- Create: `packages/db/migrations/00NN_<generated>.sql` (drizzle-kit names it)
- Test: `packages/db/test/dormant-since.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `factions.dormantSince` — `timestamp with time zone`, nullable.

- [ ] **Step 1: Write the failing test**

Create `packages/db/test/dormant-since.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, factions, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-02T12:00:00Z");

describe("factions.dormant_since", () => {
  let db: Database;
  let serverId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
  });

  const seed = () => db.insert(factions).values({
    serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear",
    poleKey: "1:2:3", x: "1", y: "2", z: "3", status: "active",
    leaderDiscordId: "d1", createdAt: now,
  }).returning();

  it("defaults to null, because only a dormant faction has one", async () => {
    const [f] = await seed();
    expect(f!.dormantSince).toBeNull();
  });

  it("stores and clears a timestamp", async () => {
    const [f] = await seed();
    await db.update(factions).set({ status: "dormant", dormantSince: now }).where(eq(factions.id, f!.id));
    const [dormant] = await db.select().from(factions).where(eq(factions.id, f!.id));
    expect(dormant!.dormantSince).toEqual(now);

    await db.update(factions).set({ status: "active", dormantSince: null }).where(eq(factions.id, f!.id));
    const [revived] = await db.select().from(factions).where(eq(factions.id, f!.id));
    expect(revived!.dormantSince).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/db && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/dormant-since.test.ts`
Expected: FAIL — `dormantSince` does not exist on the schema type (typecheck) and the column is absent.

- [ ] **Step 3: Add the column to the schema**

In `packages/db/src/schema.ts`, inside the `factions` table definition, after `activatedAt`:

```ts
  /**
   * When this faction was OBSERVED to go dormant. Null for every other status.
   *
   * ⚠️ Stored rather than derived from the last flag raise, and the reason is
   * the disband clock this feeds. A derived rule runs during periods when
   * nothing was watching: after a three-week bot outage, or for a faction
   * whose activating raise predates the ingested window, the first tick would
   * disband factions that were never given a chance to refresh — releasing a
   * flag, tag and pole with no human in the loop. This column makes "14 days
   * dormant" mean fourteen days actually observed.
   */
  dormantSince: timestamp("dormant_since", { withTimezone: true }),
```

- [ ] **Step 4: Generate the migration**

Run: `cd packages/db && npx drizzle-kit generate`

Expected: a new `migrations/00NN_*.sql` containing
`ALTER TABLE "factions" ADD COLUMN "dormant_since" timestamp with time zone;`
plus a `_journal.json` entry. Read the generated SQL before continuing — it must add one nullable column and nothing else. Any DROP or NOT NULL in that file is a generation accident; stop and investigate rather than applying it.

- [ ] **Step 5: Run the test and watch it pass**

Run: `cd packages/db && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/dormant-since.test.ts`
Expected: PASS (2 tests). `runMigrations` applies the new file.

- [ ] **Step 6: Full gate and commit**

```bash
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force
git add -A && git commit -m "feat(db): factions.dormant_since, observed not derived

The dormancy lifecycle could be derived entirely from a faction's last flag
raise, with no new column. Rejected: a derived disband clock runs during
periods when nothing was watching, so a three-week bot outage — or a faction
whose activating raise predates the ingested window — would disband on the
first tick after deploy, releasing a flag, tag and pole with no human in the
loop.

This column makes '14 days dormant' mean fourteen days actually observed."
```

---

### Task 3: The pure decision function

**Files:**
- Create: `apps/bot/src/dormancy.ts`
- Test: `apps/bot/test/dormancy.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type DormancyWindows = { dormantAfterMs: number; disbandAfterDormantMs: number }`
  - `type FactionClock = { status: string; lastRaiseAt: Date | null; dormantSince: Date | null }`
  - `type Transition = "revive" | "dormant" | "disband" | "stamp" | null`
  - `decide(clock: FactionClock, now: Date, w: DormancyWindows): Transition`
  - `DEFAULT_DORMANT_AFTER_MS = 604_800_000`, `DEFAULT_DISBAND_AFTER_DORMANT_MS = 1_209_600_000`

- [ ] **Step 1: Write the failing tests**

Create `apps/bot/test/dormancy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  decide, DEFAULT_DORMANT_AFTER_MS, DEFAULT_DISBAND_AFTER_DORMANT_MS,
  type FactionClock,
} from "../src/dormancy.js";

const W = {
  dormantAfterMs: DEFAULT_DORMANT_AFTER_MS,
  disbandAfterDormantMs: DEFAULT_DISBAND_AFTER_DORMANT_MS,
};
const now = new Date("2026-09-02T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const clock = (o: Partial<FactionClock>): FactionClock =>
  ({ status: "active", lastRaiseAt: now, dormantSince: null, ...o });

describe("decide", () => {
  it("leaves an active faction alone while its flag is fresh", () => {
    expect(decide(clock({ lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS - 1) }), now, W)).toBeNull();
  });

  it("goes dormant exactly at the window", () => {
    // The server's FlagRefreshMaxDuration is 7 days; at 7 days the base is
    // already decaying, so the boundary belongs to dormancy.
    expect(decide(clock({ lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS) }), now, W)).toBe("dormant");
  });

  it("goes dormant past the window", () => {
    expect(decide(clock({ lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS + 1) }), now, W)).toBe("dormant");
  });

  it("revives a dormant faction whose flag flew again", () => {
    expect(decide(clock({ status: "dormant", lastRaiseAt: ago(1000), dormantSince: ago(DEFAULT_DORMANT_AFTER_MS) }), now, W))
      .toBe("revive");
  });

  it("⚠️ revives rather than disbands when both would apply", () => {
    // A faction that raises its flag on day 20 of dormancy must be rescued by
    // the same tick that could have disbanded it. The loss is irreversible, so
    // the outcome must not depend on tick timing.
    expect(decide(clock({
      status: "dormant",
      lastRaiseAt: ago(1000),
      dormantSince: ago(DEFAULT_DISBAND_AFTER_DORMANT_MS + 86_400_000),
    }), now, W)).toBe("revive");
  });

  it("holds a dormant faction that is not yet due to disband", () => {
    expect(decide(clock({
      status: "dormant", lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS * 2),
      dormantSince: ago(DEFAULT_DISBAND_AFTER_DORMANT_MS - 1),
    }), now, W)).toBeNull();
  });

  it("disbands exactly at the dormant window", () => {
    expect(decide(clock({
      status: "dormant", lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS * 3),
      dormantSince: ago(DEFAULT_DISBAND_AFTER_DORMANT_MS),
    }), now, W)).toBe("disband");
  });

  it("⚠️ never disbands a dormant faction with no dormant_since — it stamps one", () => {
    // Reachable only if something outside this tick set the status. Losing a
    // flag to a missing timestamp is not acceptable; waiting another 14 days is.
    expect(decide(clock({
      status: "dormant", lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS * 10), dormantSince: null,
    }), now, W)).toBe("stamp");
  });

  it("ignores reserved and disbanded factions entirely", () => {
    for (const status of ["reserved", "disbanded", "lapsed"]) {
      expect(decide(clock({ status, lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS * 10) }), now, W)).toBeNull();
    }
  });

  it("treats a faction with no raise at all as stale", () => {
    // The store coalesces to activated_at/created_at, so null should not occur
    // — but a null that reached here must not read as 'fresh'.
    expect(decide(clock({ lastRaiseAt: null }), now, W)).toBe("dormant");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/bot && npx vitest run test/dormancy.test.ts`
Expected: FAIL — cannot resolve `../src/dormancy.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/bot/src/dormancy.ts`:

```ts
/** 7 days — the server's FlagRefreshMaxDuration. See the design's §7. */
export const DEFAULT_DORMANT_AFTER_MS = 604_800_000;
/** 14 further days before the flag, tag and pole return to the pool. */
export const DEFAULT_DISBAND_AFTER_DORMANT_MS = 1_209_600_000;

export type DormancyWindows = { dormantAfterMs: number; disbandAfterDormantMs: number };

/** Everything the decision needs. Deliberately not a faction row: this is pure. */
export type FactionClock = {
  status: string;
  /** Last raise of THIS faction's texture at THIS faction's pole. */
  lastRaiseAt: Date | null;
  dormantSince: Date | null;
};

export type Transition = "revive" | "dormant" | "disband" | "stamp" | null;

/**
 * What should happen to one faction, given its clock.
 *
 * Pure so every boundary is testable without a database — and so the store
 * applies decisions rather than making them.
 *
 * ⚠️ Revive is evaluated BEFORE disband. A faction that raises its flag on day
 * 20 of dormancy must be rescued by the tick that could otherwise have
 * disbanded it: disband is the only transition here that destroys identity,
 * and its outcome must not depend on when the tick happened to run.
 */
export function decide(c: FactionClock, now: Date, w: DormancyWindows): Transition {
  // Strictly greater: a raise exactly at the window boundary is already stale,
  // because the server's own decay has begun by then.
  const fresh = c.lastRaiseAt !== null
    && c.lastRaiseAt.getTime() > now.getTime() - w.dormantAfterMs;

  if (c.status === "dormant") {
    if (fresh) return "revive";
    // A dormant row with no timestamp cannot be aged. Start its clock now
    // rather than guessing, and let it disband 14 days from here.
    if (c.dormantSince === null) return "stamp";
    return now.getTime() - c.dormantSince.getTime() >= w.disbandAfterDormantMs ? "disband" : null;
  }

  // `reserved` has its own 24h reservation lapse and has not raised a flag by
  // definition; `disbanded` and `lapsed` are terminal.
  if (c.status !== "active") return null;

  return fresh ? null : "dormant";
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `cd apps/bot && npx vitest run test/dormancy.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/dormancy.ts apps/bot/test/dormancy.test.ts
git commit -m "feat(bot): pure dormancy decision, with revive beating disband

Every boundary is a unit test with no database: the exact-window cases, a
dormant faction with a fresh raise, and a dormant row with no dormant_since
— which stamps a timestamp rather than disbanding, because losing a flag to
a missing value is not acceptable and waiting another 14 days is.

Revive is evaluated before disband so a faction that raises its flag on day
20 is rescued by the same tick that could have destroyed it."
```

---

### Task 4: Read each faction's clock

**Files:**
- Create: `apps/bot/src/dormancy-store.ts`
- Test: `apps/bot/test/dormancy-store.test.ts`

**Interfaces:**
- Consumes: `FactionClock` from `./dormancy.js` (Task 3).
- Produces:
  - `type FactionClockRow = FactionClock & { id: number; name: string; tag: string; leaderDiscordId: string }`
  - `interface DormancyStore { clocks(): Promise<FactionClockRow[]> }`
  - `class PgDormancyStore implements DormancyStore` — constructor takes `Database`.

- [ ] **Step 1: Write the failing tests**

Create `apps/bot/test/dormancy-store.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, events, admFiles, type Database,
} from "@factions/db";
import { sql } from "drizzle-orm";
import { PgDormancyStore } from "../src/dormancy-store.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-02T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("PgDormancyStore.clocks", () => {
  let db: Database;
  let store: PgDormancyStore;
  let serverId = 0;
  let admFileId = 0;
  let lineIndex = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table events, raw_lines, adm_files, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({
      serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true,
    }).returning();
    admFileId = f!.id;
    lineIndex = 0;
    store = new PgDormancyStore(db);
  });

  const seedFaction = async (o: Partial<{ tag: string; texture: string; poleKey: string; status: string; createdAt: Date; activatedAt: Date | null; dormantSince: Date | null }> = {}) => {
    const [f] = await db.insert(factions).values({
      serverId, name: o.tag ?? "Bears", tag: o.tag ?? "BEAR",
      texture: o.texture ?? "Flag_Bear", poleKey: o.poleKey ?? "1:2:3",
      x: "1", y: "2", z: "3", status: o.status ?? "active",
      leaderDiscordId: "d1", createdAt: o.createdAt ?? ago(999_999_999),
      activatedAt: o.activatedAt ?? null, dormantSince: o.dormantSince ?? null,
      reservedUntil: (o.status ?? "active") === "reserved" ? now : null,
    }).returning();
    return f!;
  };

  const seedRaise = (o: { poleKey: string; texture: string; at: Date; type?: string }) =>
    db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, type: o.type ?? "flag.raised",
      occurredAt: o.at,
      payload: { dayzId: "A", gamertag: "G", texture: o.texture, poleKey: o.poleKey },
    });

  it("reports the last raise of the faction's own flag at its own pole", async () => {
    const f = await seedFaction({ poleKey: "1:2:3", texture: "Flag_Bear" });
    await seedRaise({ poleKey: "1:2:3", texture: "Flag_Bear", at: ago(20_000) });
    await seedRaise({ poleKey: "1:2:3", texture: "Flag_Bear", at: ago(10_000) });

    const [clock] = await store.clocks();
    expect(clock!.id).toBe(f.id);
    expect(clock!.lastRaiseAt).toEqual(ago(10_000));
  });

  it("⚠️ ignores a raise of somebody else's flag at the same pole", async () => {
    // A raider planting their own flag, or a passer-by raising a white one,
    // must not keep a dead faction's supplies alive. Deliberately stricter
    // than DayZ, which refreshes its decay timer on any raise.
    await seedFaction({ poleKey: "1:2:3", texture: "Flag_Bear", activatedAt: ago(500_000) });
    await seedRaise({ poleKey: "1:2:3", texture: "Flag_White", at: ago(10) });

    const [clock] = await store.clocks();
    expect(clock!.lastRaiseAt).toEqual(ago(500_000));
  });

  it("ignores the faction's flag raised at a different pole", async () => {
    await seedFaction({ poleKey: "1:2:3", texture: "Flag_Bear", activatedAt: ago(500_000) });
    await seedRaise({ poleKey: "9:9:9", texture: "Flag_Bear", at: ago(10) });

    const [clock] = await store.clocks();
    expect(clock!.lastRaiseAt).toEqual(ago(500_000));
  });

  it("ignores a lowering", async () => {
    await seedFaction({ poleKey: "1:2:3", texture: "Flag_Bear", activatedAt: ago(500_000) });
    await seedRaise({ poleKey: "1:2:3", texture: "Flag_Bear", at: ago(10), type: "flag.lowered" });

    const [clock] = await store.clocks();
    expect(clock!.lastRaiseAt).toEqual(ago(500_000));
  });

  it("falls back to activated_at, then created_at, when no raise was ingested", async () => {
    await seedFaction({ tag: "AAA", poleKey: "1:1:1", activatedAt: ago(400), createdAt: ago(900) });
    await seedFaction({ tag: "BBB", poleKey: "2:2:2", activatedAt: null, createdAt: ago(800) });

    const clocks = await store.clocks();
    const byTag = Object.fromEntries(clocks.map((c) => [c.tag, c]));
    expect(byTag["AAA"]!.lastRaiseAt).toEqual(ago(400));
    expect(byTag["BBB"]!.lastRaiseAt).toEqual(ago(800));
  });

  it("examines only active and dormant factions", async () => {
    await seedFaction({ tag: "ACT", poleKey: "1:1:1", status: "active" });
    await seedFaction({ tag: "DRM", poleKey: "2:2:2", status: "dormant" });
    await seedFaction({ tag: "RSV", poleKey: "3:3:3", status: "reserved" });
    await seedFaction({ tag: "DSB", poleKey: "4:4:4", status: "disbanded" });

    const clocks = await store.clocks();
    expect(clocks.map((c) => c.tag).sort()).toEqual(["ACT", "DRM"]);
  });

  it("carries the leader and the name, for the DM", async () => {
    await seedFaction({ tag: "BEAR" });
    const [clock] = await store.clocks();
    expect(clock!.leaderDiscordId).toBe("d1");
    expect(clock!.name).toBe("BEAR");
    expect(clock!.dormantSince).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/dormancy-store.test.ts`
Expected: FAIL — cannot resolve `../src/dormancy-store.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/bot/src/dormancy-store.ts`:

```ts
import type { Database } from "@factions/db";
import { factions } from "@factions/db";
import { inArray, sql } from "drizzle-orm";
import type { FactionClock } from "./dormancy.js";

export type FactionClockRow = FactionClock & {
  id: number;
  name: string;
  tag: string;
  leaderDiscordId: string;
};

export interface DormancyStore {
  clocks(): Promise<FactionClockRow[]>;
}

/**
 * ⚠️ Read from `events`, NOT from `flag_changes`. The projector that fills
 * `flag_changes` does not run against the live database — it holds zero rows
 * there — so the read model would report every faction as never having raised
 * a flag. `ceremony-tick` reads the event log directly for the same reason.
 */
const LAST_RAISE = sql<Date | null>`(
  select max(e.occurred_at)
  from events e
  where e.type = 'flag.raised'
    and e.server_id = ${factions.serverId}
    and e.payload->>'poleKey' = ${factions.poleKey}
    and e.payload->>'texture' = ${factions.texture}
)`;

/** Statuses whose clock is worth reading. See dormancy.ts's decide(). */
const EXAMINED = ["active", "dormant"];

export class PgDormancyStore implements DormancyStore {
  constructor(private readonly db: Database) {}

  async clocks(): Promise<FactionClockRow[]> {
    const rows = await this.db.select({
      id: factions.id,
      name: factions.name,
      tag: factions.tag,
      leaderDiscordId: factions.leaderDiscordId,
      status: factions.status,
      dormantSince: factions.dormantSince,
      // ⚠️ COALESCE, and the order matters. A faction is activated BY its flag
      // going up, so a raise normally exists; activated_at covers one whose
      // activating raise predates the ingested window, and created_at covers a
      // row with neither. Without this a faction with no ingested raise reads
      // as infinitely stale and is dormant on the first tick.
      lastRaiseAt: sql<Date | null>`coalesce(${LAST_RAISE}, ${factions.activatedAt}, ${factions.createdAt})`,
    }).from(factions).where(inArray(factions.status, EXAMINED));

    return rows.map((r) => ({
      ...r,
      // postgres.js returns timestamptz as Date, but the value arrives through
      // a raw SQL expression rather than a typed column, so normalise rather
      // than trust the driver's mapping.
      lastRaiseAt: r.lastRaiseAt === null ? null : new Date(r.lastRaiseAt as unknown as string),
      dormantSince: r.dormantSince === null ? null : new Date(r.dormantSince as unknown as string),
    }));
  }
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/dormancy-store.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/dormancy-store.ts apps/bot/test/dormancy-store.test.ts
git commit -m "feat(bot): read each faction's last qualifying flag raise

From \`events\`, not \`flag_changes\` — the projector that fills the read model
does not run against live and it holds zero rows there, so every faction
would look like it had never raised a flag.

A raise counts only if it is the faction's OWN texture at its OWN pole. That
is stricter than DayZ, which refreshes its decay timer on any raise, and the
strictness is the point: a raider planting their flag over your pole must
not keep your supplies alive."
```

---

### Task 5: Apply revive, dormant and stamp

**Files:**
- Modify: `apps/bot/src/dormancy-store.ts`
- Test: `apps/bot/test/dormancy-store.test.ts`

**Interfaces:**
- Consumes: `PgDormancyStore` (Task 4).
- Produces, on `DormancyStore`:
  - `goDormant(factionId: number, at: Date): Promise<boolean>`
  - `revive(factionId: number): Promise<boolean>`
  - `stampDormantSince(factionId: number, at: Date): Promise<boolean>`

Each returns whether it actually changed a row — the guard that makes the DM at-most-once.

- [ ] **Step 1: Write the failing tests**

Append to `apps/bot/test/dormancy-store.test.ts` (inside the same outer `describe`, reusing its `beforeEach` and `seedFaction`):

```ts
describe("transitions", () => {
  it("goes dormant and stamps the timestamp", async () => {
    const f = await seedFaction({ status: "active" });
    expect(await store.goDormant(f.id, now)).toBe(true);
    const [row] = await db.select().from(factions).where(eq(factions.id, f.id));
    expect(row!.status).toBe("dormant");
    expect(row!.dormantSince).toEqual(now);
  });

  it("⚠️ only the transition that actually happened reports true", async () => {
    // This is what makes the DM at-most-once. A second tick that races the
    // first must not send a duplicate warning.
    const f = await seedFaction({ status: "active" });
    expect(await store.goDormant(f.id, now)).toBe(true);
    expect(await store.goDormant(f.id, now)).toBe(false);
  });

  it("refuses to make a reserved faction dormant", async () => {
    const f = await seedFaction({ status: "reserved" });
    expect(await store.goDormant(f.id, now)).toBe(false);
  });

  it("revives, clearing the timestamp", async () => {
    const f = await seedFaction({ status: "dormant", dormantSince: ago(1000) });
    expect(await store.revive(f.id)).toBe(true);
    const [row] = await db.select().from(factions).where(eq(factions.id, f.id));
    expect(row!.status).toBe("active");
    expect(row!.dormantSince).toBeNull();
  });

  it("revives only from dormant, and only once", async () => {
    const f = await seedFaction({ status: "active" });
    expect(await store.revive(f.id)).toBe(false);
  });

  it("stamps a dormant row that has no timestamp, without touching one that has", async () => {
    const bare = await seedFaction({ tag: "AAA", poleKey: "1:1:1", status: "dormant", dormantSince: null });
    const stamped = await seedFaction({ tag: "BBB", poleKey: "2:2:2", status: "dormant", dormantSince: ago(5000) });

    expect(await store.stampDormantSince(bare.id, now)).toBe(true);
    expect(await store.stampDormantSince(stamped.id, now)).toBe(false);

    const [a] = await db.select().from(factions).where(eq(factions.id, bare.id));
    const [b] = await db.select().from(factions).where(eq(factions.id, stamped.id));
    expect(a!.dormantSince).toEqual(now);
    expect(b!.dormantSince).toEqual(ago(5000));
  });
});
```

Add `eq` to the drizzle import at the top of the file: `import { sql, eq } from "drizzle-orm";`

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/dormancy-store.test.ts`
Expected: FAIL — `store.goDormant is not a function`.

- [ ] **Step 3: Write the implementation**

In `apps/bot/src/dormancy-store.ts`, extend the interface and class. Add `and`, `eq`, `isNull` to the drizzle import.

```ts
export interface DormancyStore {
  clocks(): Promise<FactionClockRow[]>;
  goDormant(factionId: number, at: Date): Promise<boolean>;
  revive(factionId: number): Promise<boolean>;
  stampDormantSince(factionId: number, at: Date): Promise<boolean>;
}
```

```ts
  /**
   * ⚠️ Every transition is guarded on the status it expects and reports
   * whether it actually moved a row. That boolean is what makes the DM
   * at-most-once: only the tick that performed the transition sends, so two
   * overlapping ticks cannot both warn the same leader.
   */
  async goDormant(factionId: number, at: Date): Promise<boolean> {
    const rows = await this.db.update(factions)
      .set({ status: "dormant", dormantSince: at })
      .where(and(eq(factions.id, factionId), eq(factions.status, "active")))
      .returning({ id: factions.id });
    return rows.length > 0;
  }

  async revive(factionId: number): Promise<boolean> {
    const rows = await this.db.update(factions)
      .set({ status: "active", dormantSince: null })
      .where(and(eq(factions.id, factionId), eq(factions.status, "dormant")))
      .returning({ id: factions.id });
    return rows.length > 0;
  }

  /**
   * Start the clock on a dormant row that has none. Reachable only if
   * something outside this tick set the status; see decide()'s "stamp".
   */
  async stampDormantSince(factionId: number, at: Date): Promise<boolean> {
    const rows = await this.db.update(factions)
      .set({ dormantSince: at })
      .where(and(
        eq(factions.id, factionId),
        eq(factions.status, "dormant"),
        isNull(factions.dormantSince),
      ))
      .returning({ id: factions.id });
    return rows.length > 0;
  }
```

- [ ] **Step 4: Run them and watch them pass**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/dormancy-store.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/dormancy-store.ts apps/bot/test/dormancy-store.test.ts
git commit -m "feat(bot): guarded dormancy transitions that report what they did

Each transition is guarded on the status it expects and returns whether it
actually moved a row. That boolean is the at-most-once guard for the DM: only
the tick that performed the transition sends one, so two overlapping ticks
cannot both warn the same leader."
```

---

### Task 6: Auto-disband, sharing the real disband transaction

**Files:**
- Modify: `apps/bot/src/roster-store.ts:652-680`
- Modify: `apps/bot/src/dormancy-store.ts`
- Test: `apps/bot/test/dormancy-store.test.ts`

**Interfaces:**
- Consumes: `PgDormancyStore` (Tasks 4-5).
- Produces:
  - `disbandFactionTx(tx: Tx, factionId: number, guard: SQL): Promise<boolean>` exported from `roster-store.ts`
  - `disbandDormant(factionId: number, dormantBefore: Date): Promise<boolean>` on `DormancyStore`

- [ ] **Step 1: Write the failing tests**

Append to the `describe("transitions", ...)` block in `apps/bot/test/dormancy-store.test.ts`. Add `factionMembers`, `factionInvites` to the `@factions/db` import and `isNull` to the drizzle import.

```ts
it("disbands a faction dormant past the window", async () => {
  const f = await seedFaction({ status: "dormant", dormantSince: ago(2000) });
  expect(await store.disbandDormant(f.id, ago(1000))).toBe(true);
  const [row] = await db.select().from(factions).where(eq(factions.id, f.id));
  expect(row!.status).toBe("disbanded");
});

it("does not disband one that is not yet due", async () => {
  const f = await seedFaction({ status: "dormant", dormantSince: ago(500) });
  expect(await store.disbandDormant(f.id, ago(1000))).toBe(false);
});

it("⚠️ never disbands a dormant faction with no dormant_since", async () => {
  // decide() returns "stamp" for this, but the store must refuse it too:
  // a NULL comparison silently matching would release a flag on no evidence.
  const f = await seedFaction({ status: "dormant", dormantSince: null });
  expect(await store.disbandDormant(f.id, ago(1000))).toBe(false);
});

it("refuses an active faction whatever the cutoff", async () => {
  const f = await seedFaction({ status: "active", dormantSince: ago(999_999) });
  expect(await store.disbandDormant(f.id, now)).toBe(false);
});

it("⚠️ clears the roster and revokes invites, exactly as /faction disband does", async () => {
  // A status write alone leaves membership rows pointing at a disbanded
  // faction. They are invisible to their owners — the membership lookup
  // filters on HOLDING_STATUSES — but still collide with
  // faction_members_server_player_uniq if those players join another faction
  // on the same server.
  const f = await seedFaction({ status: "dormant", dormantSince: ago(2000) });
  await db.insert(factionMembers).values({
    factionId: f.id, serverId, discordId: "d1", dayzId: "A".repeat(40), role: "leader", joinedAt: now,
  });
  await db.insert(factionInvites).values({
    factionId: f.id, serverId, inviterDiscordId: "d1", inviteeDiscordId: "d2",
    dayzId: "B".repeat(40), tag: "BEAR", createdAt: now, expiresAt: new Date(now.getTime() + 1000),
  });

  expect(await store.disbandDormant(f.id, ago(1000))).toBe(true);

  expect(await db.select().from(factionMembers).where(eq(factionMembers.factionId, f.id))).toHaveLength(0);
  const [invite] = await db.select().from(factionInvites).where(eq(factionInvites.factionId, f.id));
  expect(invite!.revokedAt).not.toBeNull();
});
```

⚠️ Before writing these, read the real `faction_members` and `faction_invites` schemas in `packages/db/src/schema.ts` and match the required columns exactly — the inserts above name the columns those tables have today, and a NOT NULL added since will fail the insert rather than the assertion.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/dormancy-store.test.ts`
Expected: FAIL — `store.disbandDormant is not a function`.

- [ ] **Step 3: Extract the disband transaction body**

In `apps/bot/src/roster-store.ts`, add above `class PgRosterStore` (keep `leaderIs` where it is):

```ts
/** The transaction handle drizzle hands to `db.transaction`. */
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Everything disbanding a faction does, minus who is allowed to do it.
 *
 * ⚠️ Shared with the dormancy tick's auto-disband rather than reimplemented.
 * The status write is the least of it: membership rows left behind point at a
 * disbanded faction, invisible to their owners because the membership lookup
 * filters on HOLDING_STATUSES, yet still able to collide with
 * `faction_members_server_player_uniq` when those players join elsewhere.
 *
 * ⚠️ Lock order: `factions`, then `faction_members`, then `faction_invites`.
 * Inbox item 19 records a deadlock built out of two separately-correct changes
 * taking two of these tables in opposite orders. Any new writer to this set
 * follows this order.
 *
 * `guard` is the caller's authority to do it — a leader check for
 * `/faction disband`, a dormancy-window check for the tick.
 */
export async function disbandFactionTx(tx: Tx, factionId: number, guard: SQL): Promise<boolean> {
  const updated = await tx.update(factions)
    .set({ status: "disbanded" })
    .where(and(eq(factions.id, factionId), guard, inArray(factions.status, HOLDING)))
    .returning({ id: factions.id });

  if (!updated[0]) return false;

  await tx.delete(factionMembers).where(eq(factionMembers.factionId, factionId));

  // Outstanding offers die with the faction, for the reason spelled out
  // on `pendingInvitesFor`.
  await tx.update(factionInvites)
    .set({ revokedAt: sql`now()` })
    .where(and(
      eq(factionInvites.factionId, factionId),
      isNull(factionInvites.acceptedAt),
      isNull(factionInvites.declinedAt),
      isNull(factionInvites.revokedAt),
    ));

  return true;
}
```

Add `SQL` to the drizzle import: `import { and, asc, eq, gt, inArray, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";`

Then replace the body of `PgRosterStore.disband`:

```ts
  async disband(factionId: number, discordId: string): Promise<"ok" | "not-leader"> {
    return this.db.transaction(async (tx) =>
      await disbandFactionTx(tx, factionId, leaderIs(factionId, discordId)) ? "ok" as const : "not-leader" as const);
  }
```

- [ ] **Step 4: Confirm the existing disband tests still pass**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/roster-lifecycle.test.ts test/roster-races.test.ts`
Expected: PASS — the extraction changed no behaviour. If anything fails here, the extraction is wrong; do not proceed.

- [ ] **Step 5: Add `disbandDormant`**

In `apps/bot/src/dormancy-store.ts`, add to the interface and the class. Import `disbandFactionTx` from `./roster-store.js`, plus `isNotNull` and `lt` from drizzle.

```ts
  /**
   * ⚠️ `isNotNull` is not redundant. `dormant_since < cutoff` is NULL — not
   * false — for a row with no timestamp, and a guard that silently fails to
   * match is the right outcome here only by accident. Stating it makes the
   * rule "a faction is never disbanded without an observed dormancy start"
   * explicit rather than emergent from SQL three-valued logic.
   */
  async disbandDormant(factionId: number, dormantBefore: Date): Promise<boolean> {
    return this.db.transaction(async (tx) => disbandFactionTx(tx, factionId, and(
      eq(factions.status, "dormant"),
      isNotNull(factions.dormantSince),
      lt(factions.dormantSince, dormantBefore),
    )!));
  }
```

- [ ] **Step 6: Run them and watch them pass**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/dormancy-store.test.ts`
Expected: PASS (18 tests)

- [ ] **Step 7: Full gate and commit**

```bash
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force
git add -A && git commit -m "feat(bot): auto-disband shares the real disband transaction

Disbanding is not a status write: it also deletes every faction_members row
and revokes outstanding invites. Membership rows left behind point at a
disbanded faction — invisible to their owners, since the membership lookup
filters on HOLDING_STATUSES — and still collide with
faction_members_server_player_uniq if those players join another faction.

So the transaction body is extracted and shared, with the leader check
replaced by the dormancy-window check. It takes its locks in the documented
order (factions, faction_members, faction_invites); inbox item 19 records a
deadlock built from two writers taking them in opposite orders, and this is
the third writer."
```

---

### Task 7: The tick

**Files:**
- Create: `apps/bot/src/dormancy-tick.ts`
- Test: `apps/bot/test/dormancy-tick.test.ts`
- Modify: `apps/bot/src/config.ts`
- Test: `apps/bot/test/config.test.ts`

**Interfaces:**
- Consumes: `decide`, `DormancyWindows` (Task 3); `DormancyStore` (Tasks 4-6).
- Produces:
  - `type DormancyNotice = { kind: "dormant" | "revive"; factionId: number; leaderDiscordId: string; name: string; tag: string; disbandAt: Date }`
  - `type DormancyTickResult = { examined: number; dormant: number; revived: number; disbanded: number; stamped: number; notices: DormancyNotice[] }`
  - `dormancyTick(store: DormancyStore, opts: { now: Date; windows: DormancyWindows }): Promise<DormancyTickResult>`
  - `BotConfig.dormantAfterMs`, `BotConfig.disbandAfterDormantMs`

- [ ] **Step 1: Write the failing tick tests**

Create `apps/bot/test/dormancy-tick.test.ts`. This suite uses a hand-written fake store — the transitions themselves are covered against the real database in Tasks 5-6, and what needs proving here is the routing and the ordering.

```ts
import { describe, it, expect, vi } from "vitest";
import { dormancyTick } from "../src/dormancy-tick.js";
import { DEFAULT_DORMANT_AFTER_MS, DEFAULT_DISBAND_AFTER_DORMANT_MS } from "../src/dormancy.js";
import type { DormancyStore, FactionClockRow } from "../src/dormancy-store.js";

const now = new Date("2026-09-02T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const windows = {
  dormantAfterMs: DEFAULT_DORMANT_AFTER_MS,
  disbandAfterDormantMs: DEFAULT_DISBAND_AFTER_DORMANT_MS,
};

const row = (o: Partial<FactionClockRow>): FactionClockRow => ({
  id: 1, name: "Bears", tag: "BEAR", leaderDiscordId: "d1",
  status: "active", lastRaiseAt: now, dormantSince: null, ...o,
});

const fakeStore = (clocks: FactionClockRow[], over: Partial<DormancyStore> = {}): DormancyStore => ({
  clocks: async () => clocks,
  goDormant: async () => true,
  revive: async () => true,
  stampDormantSince: async () => true,
  disbandDormant: async () => true,
  ...over,
});

describe("dormancyTick", () => {
  it("makes a stale active faction dormant and returns a notice", async () => {
    const goDormant = vi.fn().mockResolvedValue(true);
    const store = fakeStore([row({ lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS + 1) })], { goDormant });

    const r = await dormancyTick(store, { now, windows });
    expect(goDormant).toHaveBeenCalledWith(1, now);
    expect(r.dormant).toBe(1);
    expect(r.notices).toEqual([{
      kind: "dormant", factionId: 1, leaderDiscordId: "d1", name: "Bears", tag: "BEAR",
      disbandAt: new Date(now.getTime() + DEFAULT_DISBAND_AFTER_DORMANT_MS),
    }]);
  });

  it("⚠️ emits no notice when the transition did not happen", async () => {
    // The guarded update returning false means another tick got there first.
    // Notifying anyway is how a leader gets the same warning twice.
    const store = fakeStore([row({ lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS + 1) })], {
      goDormant: async () => false,
    });
    const r = await dormancyTick(store, { now, windows });
    expect(r.dormant).toBe(0);
    expect(r.notices).toEqual([]);
  });

  it("revives a dormant faction whose flag flew again", async () => {
    const revive = vi.fn().mockResolvedValue(true);
    const store = fakeStore([row({ status: "dormant", lastRaiseAt: ago(10), dormantSince: ago(99999) })], { revive });

    const r = await dormancyTick(store, { now, windows });
    expect(revive).toHaveBeenCalledWith(1);
    expect(r.revived).toBe(1);
    expect(r.notices[0]!.kind).toBe("revive");
  });

  it("⚠️ revives rather than disbands a faction that raised its flag on day 20", async () => {
    const revive = vi.fn().mockResolvedValue(true);
    const disbandDormant = vi.fn().mockResolvedValue(true);
    const store = fakeStore([row({
      status: "dormant", lastRaiseAt: ago(10),
      dormantSince: ago(DEFAULT_DISBAND_AFTER_DORMANT_MS + 86_400_000),
    })], { revive, disbandDormant });

    const r = await dormancyTick(store, { now, windows });
    expect(revive).toHaveBeenCalled();
    expect(disbandDormant).not.toHaveBeenCalled();
    expect(r.disbanded).toBe(0);
  });

  it("disbands a faction dormant past the window, with no notice", async () => {
    // There is nobody to tell: the faction no longer exists, and its roster
    // has been cleared by the same transaction.
    const disbandDormant = vi.fn().mockResolvedValue(true);
    const store = fakeStore([row({
      status: "dormant", lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS * 5),
      dormantSince: ago(DEFAULT_DISBAND_AFTER_DORMANT_MS),
    })], { disbandDormant });

    const r = await dormancyTick(store, { now, windows });
    expect(disbandDormant).toHaveBeenCalledWith(1, new Date(now.getTime() - DEFAULT_DISBAND_AFTER_DORMANT_MS));
    expect(r.disbanded).toBe(1);
    expect(r.notices).toEqual([]);
  });

  it("stamps a dormant row with no timestamp instead of disbanding it", async () => {
    const stampDormantSince = vi.fn().mockResolvedValue(true);
    const disbandDormant = vi.fn();
    const store = fakeStore([row({
      status: "dormant", lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS * 9), dormantSince: null,
    })], { stampDormantSince, disbandDormant });

    const r = await dormancyTick(store, { now, windows });
    expect(stampDormantSince).toHaveBeenCalledWith(1, now);
    expect(disbandDormant).not.toHaveBeenCalled();
    expect(r.stamped).toBe(1);
  });

  it("⚠️ one faction's failure does not cost the others their tick", async () => {
    // A per-faction throw must not abort the sweep: the second faction's
    // supplies depend on its status changing.
    const goDormant = vi.fn()
      .mockRejectedValueOnce(new Error("deadlock"))
      .mockResolvedValueOnce(true);
    const store = fakeStore([
      row({ id: 1, tag: "AAA", lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS + 1) }),
      row({ id: 2, tag: "BBB", lastRaiseAt: ago(DEFAULT_DORMANT_AFTER_MS + 1) }),
    ], { goDormant });
    const onError = vi.fn();

    const r = await dormancyTick(store, { now, windows, onError });
    expect(r.dormant).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(r.examined).toBe(2);
  });

  it("counts what it looked at even when nothing changes", async () => {
    const r = await dormancyTick(fakeStore([row({}), row({ id: 2 })]), { now, windows });
    expect(r).toMatchObject({ examined: 2, dormant: 0, revived: 0, disbanded: 0, stamped: 0 });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/bot && npx vitest run test/dormancy-tick.test.ts`
Expected: FAIL — cannot resolve `../src/dormancy-tick.js`.

- [ ] **Step 3: Write the tick**

Create `apps/bot/src/dormancy-tick.ts`:

```ts
import { decide, type DormancyWindows } from "./dormancy.js";
import type { DormancyStore } from "./dormancy-store.js";

/** A leader who needs telling. Disband produces none — see the tick. */
export type DormancyNotice = {
  kind: "dormant" | "revive";
  factionId: number;
  leaderDiscordId: string;
  name: string;
  tag: string;
  /** When the flag, tag and pole return to the pool if nothing changes. */
  disbandAt: Date;
};

export type DormancyTickResult = {
  examined: number;
  dormant: number;
  revived: number;
  disbanded: number;
  stamped: number;
  notices: DormancyNotice[];
};

/**
 * Move every faction to the status its flag says it should have.
 *
 * ⚠️ A notice is emitted only when the guarded transition actually moved a
 * row. That is the at-most-once guard for the DM: two overlapping ticks
 * cannot both warn the same leader, because only one of their updates
 * matches.
 *
 * ⚠️ Per-faction try/catch. One faction's deadlock or constraint violation
 * must not abort the sweep — every faction after it would keep the status it
 * has, and therefore keep or lose supplies for another whole tick.
 */
export async function dormancyTick(
  store: DormancyStore,
  opts: { now: Date; windows: DormancyWindows; onError?: (factionId: number, err: unknown) => void },
): Promise<DormancyTickResult> {
  const { now, windows } = opts;
  const out: DormancyTickResult = {
    examined: 0, dormant: 0, revived: 0, disbanded: 0, stamped: 0, notices: [],
  };

  for (const clock of await store.clocks()) {
    out.examined++;
    try {
      switch (decide(clock, now, windows)) {
        case "revive":
          if (await store.revive(clock.id)) {
            out.revived++;
            out.notices.push(notice("revive", clock, now, windows));
          }
          break;

        case "dormant":
          if (await store.goDormant(clock.id, now)) {
            out.dormant++;
            out.notices.push(notice("dormant", clock, now, windows));
          }
          break;

        case "disband":
          // No notice: the faction is gone and its roster was cleared by the
          // same transaction, so there is no longer anyone to tell.
          if (await store.disbandDormant(clock.id, new Date(now.getTime() - windows.disbandAfterDormantMs))) {
            out.disbanded++;
          }
          break;

        case "stamp":
          if (await store.stampDormantSince(clock.id, now)) out.stamped++;
          break;
      }
    } catch (err) {
      opts.onError?.(clock.id, err);
    }
  }

  return out;
}

function notice(
  kind: DormancyNotice["kind"],
  clock: { id: number; leaderDiscordId: string; name: string; tag: string },
  now: Date,
  windows: DormancyWindows,
): DormancyNotice {
  return {
    kind,
    factionId: clock.id,
    leaderDiscordId: clock.leaderDiscordId,
    name: clock.name,
    tag: clock.tag,
    disbandAt: new Date(now.getTime() + windows.disbandAfterDormantMs),
  };
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `cd apps/bot && npx vitest run test/dormancy-tick.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Write the failing config tests**

Append to `apps/bot/test/config.test.ts`:

```ts
it("defaults the dormancy windows to 7 and 14 days", () => {
  const cfg = loadConfig(OK);
  expect(cfg.dormantAfterMs).toBe(604_800_000);
  expect(cfg.disbandAfterDormantMs).toBe(1_209_600_000);
});

it("rejects a dormancy window Number() would silently reinterpret", () => {
  for (const raw of ["7e3", " 10 ", "0x10", "soon", "0", "-5"]) {
    expect(() => loadConfig({ ...OK, BOT_DORMANT_AFTER_MS: raw })).toThrow(/BOT_DORMANT_AFTER_MS/);
    expect(() => loadConfig({ ...OK, BOT_DISBAND_AFTER_DORMANT_MS: raw })).toThrow(/BOT_DISBAND_AFTER_DORMANT_MS/);
  }
});
```

The valid-environment fixture in that file is already named `OK` (line 4), so these append as written.

- [ ] **Step 6: Run them and watch them fail**

Run: `cd apps/bot && npx vitest run test/config.test.ts`
Expected: FAIL — `dormantAfterMs` is undefined.

- [ ] **Step 7: Add the config values**

In `apps/bot/src/config.ts`, add to `BotConfig`:

```ts
  dormantAfterMs: number;
  disbandAfterDormantMs: number;
```

and to `loadConfig`, after `renameCooldownMs`:

```ts
    // 7 days, matching the server's FlagRefreshMaxDuration. ⚠️ Copied by hand:
    // change one and not the other and they diverge silently, either cutting
    // supplies at a base that is fine or feeding one that has already decayed.
    // The server's own value is readable from cfggameplay.json — see the
    // dormancy design's §7 for why that is not wired up yet.
    dormantAfterMs: positiveInt(env, "BOT_DORMANT_AFTER_MS", 604_800_000),
    // 14 further days before the flag, tag and pole return to the 33-slot pool.
    disbandAfterDormantMs: positiveInt(env, "BOT_DISBAND_AFTER_DORMANT_MS", 1_209_600_000),
```

- [ ] **Step 8: Run them and watch them pass**

Run: `cd apps/bot && npx vitest run test/config.test.ts test/dormancy-tick.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add apps/bot/src/dormancy-tick.ts apps/bot/test/dormancy-tick.test.ts apps/bot/src/config.ts apps/bot/test/config.test.ts
git commit -m "feat(bot): dormancy tick, routing decisions to guarded transitions

A notice is emitted only when the guarded transition actually moved a row, so
two overlapping ticks cannot both warn one leader. Disband emits none: the
faction is gone and its roster was cleared by the same transaction, so there
is nobody left to tell.

Per-faction try/catch, for the same reason the sweep has one: one faction's
deadlock must not leave every faction after it holding a status its flag
contradicts for another whole tick.

Windows are configuration, defaulting to the server's 7-day
FlagRefreshMaxDuration and a further 14 days."
```

---

### Task 8: Tell the leader

**Files:**
- Create: `apps/bot/src/dormancy-notify.ts`
- Test: `apps/bot/test/dormancy-notify.test.ts`

**Interfaces:**
- Consumes: `DormancyNotice` (Task 7); `Sender` from `./notify.js`.
- Produces:
  - `formatDormancyDm(n: DormancyNotice): string`
  - `notifyDormancy(notices: DormancyNotice[], send: Sender, onError?: (n: DormancyNotice, err: unknown) => void): Promise<number>`

- [ ] **Step 1: Write the failing tests**

Create `apps/bot/test/dormancy-notify.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { formatDormancyDm, notifyDormancy } from "../src/dormancy-notify.js";
import type { DormancyNotice } from "../src/dormancy-tick.js";

const base: DormancyNotice = {
  kind: "dormant", factionId: 1, leaderDiscordId: "d1", name: "Bears", tag: "BEAR",
  disbandAt: new Date("2026-09-16T12:00:00Z"),
};

describe("formatDormancyDm", () => {
  it("tells a dormant leader what happened, what to do, and the deadline", () => {
    const msg = formatDormancyDm(base);
    expect(msg).toMatch(/Bears/);
    expect(msg).toMatch(/supplies/i);
    expect(msg).toMatch(/raise/i);
    expect(msg).toContain(`<t:${Math.floor(base.disbandAt.getTime() / 1000)}:R>`);
  });

  it("confirms a revival", () => {
    const msg = formatDormancyDm({ ...base, kind: "revive" });
    expect(msg).toMatch(/Bears/);
    expect(msg).toMatch(/supplies/i);
    expect(msg).not.toMatch(/returns to the pool/i);
  });

  it("⚠️ never includes pole coordinates", () => {
    // A DM is screenshottable and the message does not need them. Same rule as
    // /faction info's members-only pole line.
    for (const kind of ["dormant", "revive"] as const) {
      expect(formatDormancyDm({ ...base, kind })).not.toMatch(/\d+\.\d+:\d+\.\d+:\d+\.\d+/);
    }
  });
});

describe("notifyDormancy", () => {
  it("⚠️ sends with an empty channel id, so there is no public fallback", async () => {
    // `send` falls back to posting in a channel when a DM fails. For dormancy
    // that fallback would announce whose base is undefended, so it must not be
    // reachable: an empty channel id makes the fallback throw instead.
    const send = vi.fn().mockResolvedValue(undefined);
    await notifyDormancy([base], send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ discordId: "d1", channelId: "" });
  });

  it("⚠️ a failed DM is reported and never retried", async () => {
    // At-most-once, deliberately: the transition has already been written, so
    // there is no state that would tell a later tick to try again — and
    // re-deriving one would re-DM every dormant faction on every tick after
    // any transient Discord failure.
    const send = vi.fn().mockRejectedValue(new Error("DMs closed"));
    const onError = vi.fn();
    expect(await notifyDormancy([base], send, onError)).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("one unreachable leader does not stop the others being told", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("DMs closed"))
      .mockResolvedValueOnce(undefined);
    expect(await notifyDormancy([base, { ...base, factionId: 2, leaderDiscordId: "d2" }], send, vi.fn())).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/bot && npx vitest run test/dormancy-notify.test.ts`
Expected: FAIL — cannot resolve `../src/dormancy-notify.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/bot/src/dormancy-notify.ts`:

```ts
import type { Sender } from "./notify.js";
import type { DormancyNotice } from "./dormancy-tick.js";

/**
 * ⚠️ No pole coordinates. The leader is entitled to them, but a DM is
 * screenshottable and this message does not need them — same rule as
 * `/faction info`'s members-only pole line.
 */
export function formatDormancyDm(n: DormancyNotice): string {
  if (n.kind === "revive") {
    return [
      `**${n.name}** [${n.tag}] is active again`,
      "",
      "Your flag is flying, so the clock is reset. Supplies resume at the next server restart.",
    ].join("\n");
  }

  return [
    `**${n.name}** [${n.tag}] has gone dormant`,
    "",
    // The game says nothing when a flag expires, so this is the only warning
    // a leader ever gets.
    "Your flag has not been raised in seven days, so the base it protects has started to decay " +
    "and your supply kit has stopped.",
    "",
    "Raise your flag in game to start it again — supplies come back at the next server restart.",
    `If nobody raises it, the flag, tag and pole return to the pool <t:${Math.floor(n.disbandAt.getTime() / 1000)}:R>.`,
  ].join("\n");
}

/**
 * DM the leader of each faction that changed state. Returns how many landed.
 *
 * ⚠️ `channelId` is deliberately empty. `send` falls back to posting in a
 * channel when a DM fails, and for dormancy that fallback would announce to
 * everyone whose base is currently undefended. An empty id makes the fallback
 * throw rather than post, which is the outcome we want — the same technique
 * the ceremony notifier uses, and for the same reason.
 *
 * ⚠️ At-most-once. A failed DM is reported and NOT retried: the transition is
 * already written, so nothing would tell a later tick to try again, and
 * re-deriving that from state would re-DM every dormant faction on every tick
 * after any transient Discord failure. This is the opposite trade-off from
 * `notifyCompleted`, which sends before marking — and the reason differs. A
 * missed completion DM strands a player who did everything right; a missed
 * dormancy DM costs a leader a warning about a state they can see and reverse
 * at any time.
 */
export async function notifyDormancy(
  notices: DormancyNotice[],
  send: Sender,
  onError?: (n: DormancyNotice, err: unknown) => void,
): Promise<number> {
  let sent = 0;
  for (const n of notices) {
    try {
      await send({ discordId: n.leaderDiscordId, channelId: "", content: formatDormancyDm(n) });
      sent++;
    } catch (err) {
      onError?.(n, err);
    }
  }
  return sent;
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `cd apps/bot && npx vitest run test/dormancy-notify.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/dormancy-notify.ts apps/bot/test/dormancy-notify.test.ts
git commit -m "feat(bot): DM the leader when a faction goes dormant or revives

Sent with an empty channel id so \`send\`'s public-channel fallback throws
instead of posting: for dormancy that fallback would announce to everyone
whose base is currently undefended.

At-most-once by design. A failed DM is logged and never retried — the
transition is already written, and re-deriving 'should have been told' from
state would re-DM every dormant faction on every tick after any transient
Discord failure. The opposite trade-off from notifyCompleted, because a
missed completion strands a player who did everything right while a missed
dormancy warning costs a leader notice of a state they can see and reverse."
```

---

### Task 9: Wire it into the bot, and verify on live

**Files:**
- Modify: `apps/bot/src/discord.ts:1013-1050` (the `guardedRunner` job) and its store construction near line 762
- Test: `apps/bot/test/discord.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3-8.
- Produces: nothing new.

- [ ] **Step 1: Write the failing wiring test**

Append to `apps/bot/test/discord.test.ts`, in the `describe("discord wiring", ...)` block:

```ts
it("exports a dormancy tick that startBot can run", async () => {
  // ⚠️ The tick, the store and the notifier are each tested alone. Nothing
  // proves they are actually wired into the bot's job, and an unwired tick is
  // silent: no error, no transitions, supplies flowing forever.
  const { dormancyTick } = await import("../src/dormancy-tick.js");
  const { PgDormancyStore } = await import("../src/dormancy-store.js");
  const { notifyDormancy } = await import("../src/dormancy-notify.js");
  expect(typeof dormancyTick).toBe("function");
  expect(typeof notifyDormancy).toBe("function");

  const store = new PgDormancyStore(db);
  const r = await dormancyTick(store, {
    now: new Date("2026-09-02T12:00:00Z"),
    windows: { dormantAfterMs: 604_800_000, disbandAfterDormantMs: 1_209_600_000 },
  });
  expect(r.examined).toBe(0);
});
```

`db` is already in scope in that suite (declared at line 19, built in its `beforeEach`), and its truncate list already clears `factions`.

⚠️ This is a smoke test, not a wiring proof — `startBot` needs a live Discord client, so no test can observe its job list. Step 4's grep is what actually confirms the wiring; do not skip it.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/discord.test.ts`
Expected: FAIL — the modules do not resolve until Tasks 3-8 are merged; if they are, this passes and you may proceed.

- [ ] **Step 3: Wire it into `startBot`**

In `apps/bot/src/discord.ts`, add the imports:

```ts
import { dormancyTick } from "./dormancy-tick.js";
import { PgDormancyStore } from "./dormancy-store.js";
import { notifyDormancy } from "./dormancy-notify.js";
```

Beside `const ceremonyStore = new PgCeremonyStore(db);`:

```ts
const dormancyStore = new PgDormancyStore(db);
```

And at the end of the `guardedRunner` job, after the ceremony notify block:

```ts
    // ⚠️ Its own try/catch, like every other step in this job: a throw here
    // must not stop verification or ceremony DMs. Runs last because nothing
    // else depends on it — supplies are read from status by a different
    // process on its own schedule.
    try {
      const d = await dormancyTick(dormancyStore, {
        now: new Date(),
        windows: {
          dormantAfterMs: cfg.dormantAfterMs,
          disbandAfterDormantMs: cfg.disbandAfterDormantMs,
        },
        onError: (factionId, err) => console.error(`dormancy failed for faction ${factionId}`, err),
      });
      if (d.dormant > 0 || d.revived > 0 || d.disbanded > 0 || d.stamped > 0) {
        console.log(
          `dormancy: ${d.dormant} dormant, ${d.revived} revived, ` +
          `${d.disbanded} disbanded, ${d.stamped} stamped, of ${d.examined} examined`,
        );
      }
      await notifyDormancy(d.notices, send, (n, err) =>
        console.error(`dormancy DM failed for faction ${n.factionId}`, err));
    } catch (err) {
      console.error("dormancy tick failed", err);
    }
```

- [ ] **Step 4: Confirm the wiring by reading it back**

Run: `grep -n "dormancyTick\|notifyDormancy\|PgDormancyStore" apps/bot/src/discord.ts`
Expected: five lines — three imports, the store construction, and the two calls inside the job.

- [ ] **Step 5: Full gate**

```bash
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force
```
Expected: 20/20 tasks pass.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(bot): run the dormancy tick in the bot's guarded job

Last in the job and in its own try/catch, like every other step: a throw here
must not stop verification or ceremony DMs, and nothing downstream depends on
it — the supply projection reads status from a different process on its own
schedule."
```

- [ ] **Step 7: Verify against live before deploying**

⚠️ Read-only. Confirm the live data will not cause a mass transition on the first tick:

```bash
docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c "
  select f.tag, f.status, f.dormant_since,
         (select max(e.occurred_at) from events e
           where e.type='flag.raised' and e.server_id=f.server_id
             and e.payload->>'poleKey'=f.pole_key
             and e.payload->>'texture'=f.texture) as last_raise,
         now() - coalesce((select max(e.occurred_at) from events e
           where e.type='flag.raised' and e.server_id=f.server_id
             and e.payload->>'poleKey'=f.pole_key
             and e.payload->>'texture'=f.texture), f.activated_at, f.created_at) as age
  from factions f where f.status in ('active','dormant')"
```

Expected today: one row, `COK`, `active`, `dormant_since` null, `last_raise` 2026-09-01, `age` well under 7 days. **If any row's `age` exceeds 7 days, stop** — the first tick would make it dormant and cut its supplies. Decide deliberately whether that is correct before deploying.

- [ ] **Step 8: Deploy**

No worker rebuild is needed for the bot change, but Task 1 changed `supply-tick.ts`, so both processes ship:

```bash
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars
set -a && . .env && set +a
docker compose build ingest-worker && docker compose up -d ingest-worker
pkill -f "src/main.ts"      # ⚠️ then CONFIRM zero survivors before starting
ps ax -o pid,command | grep "src/main.ts" | grep -v grep
nohup pnpm --filter @factions/bot start > bot.log 2>&1 &
```

Then confirm: `bot ready` in `bot.log`, one bot tree only (deploy doc §2 — two notifiers DM twice), and a `dormancy:` line absent from the first tick, which is what "nothing transitioned" looks like.

---

## Notes for the executor

- **`decide()` is the only place the rules live.** If a transition looks wrong, fix `decide` and its unit tests, not the store or the tick.
- **The three sets are not interchangeable.** `HOLDING_STATUSES` = holds flag/tag/pole. `SUPPLIED_STATUSES` = gets a kit. `EXAMINED` (in the store) = worth reading a clock for. They overlap and mean different things.
- **Do not add a `dormant` case to `HOLDING_STATUSES` consumers** to "make supplies work". The supply filter is `SUPPLIED_STATUSES` and that is the whole mechanism.
- **Raid-driven dormancy is out of scope** (design §1). If you find yourself reading `flag.lowered`, stop — that is a different trigger with different meaning and needs its own precedence rules against this one.
