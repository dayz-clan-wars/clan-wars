# Declarations — implementation plan (increment 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the pole binding off `factions` into a `declarations` table that owns it for clans and solos alike, enforce the 200 m rule with the Hub as a phantom base, give every pole a grace clock, attribute a clan's raises to its roster, add solo declare and lapse, and write the launch-grace runbook.

**Architecture:** `declarations` is one row per declared pole with exactly one owner (clan or player) and exactly one piece of evidence (a ceremony or a raise event), both enforced by CHECK constraints. Every insert goes through one function that takes the server's declaration rows under `FOR UPDATE` and refuses anything under 200 m. `poles` gains `grace_until`, and because the projector that fills `poles` does not run in production, the bot gains a small pole projection consumer of its own. Every existing reader of `factions.pole_key` is rewritten to join `declarations`.

**Tech Stack:** TypeScript, drizzle-orm over postgres.js, drizzle-kit for migrations, vitest with the per-package test database (`TEST_DATABASE_URL` is a base URL; see CLAUDE.md).

**Spec:** `docs/superpowers/specs/2026-09-04-clan-wars-target-state-design.md` §4.1, §4.2, §4.3 (pole columns only), §4.12, §5.1 (attribution), §5.2, §13, §15 increment 1. Builds on `2026-09-03-base-declaration-design.md` §8 (option C).

## Global Constraints

- **Read every generated migration before it goes near `factions_live`.** Nothing applies migrations in production; the runbook in Task 12 is the deploy.
- **Stop the bot before this migration.** It drops columns the running bot selects.
- The full gate: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`. Check the task count, not the exit code.
- After editing a migration rather than adding one, run with `TEST_DATABASE_FRESH=1`.
- Lock order (spec §4.12): `factions → declarations → faction_members → faction_invites → … → faction_events`. Every transaction in this plan that touches both takes `factions` first.
- Every number comes from `@factions/domain`'s `rules.ts` (increment 0). No literals.
- "Full member" in this increment means any `faction_members` row — the `status` column arrives in increment 2. Every query written here filters on roster membership so that adding `status = 'full'` later is one predicate, not a redesign.
- Comments say **why**; `⚠️` marks silent failures. Player-facing strings say **clan**.

---

### Task 1: Spacing rule in the domain package

**Files:**
- Create: `packages/domain/src/spacing.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/spacing.test.ts`

**Interfaces:**
- Produces: `distance2d(a, b): number`, `tooClose(candidate, existing, minM?): { x, z } | null` returning the offending point or null. `type Point2 = { x: number; z: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/domain/test/spacing.test.ts
import { describe, it, expect } from "vitest";
import { distance2d, tooClose, HUB_POSITION, MIN_BASE_SPACING_M } from "../src/index.js";

describe("distance2d", () => {
  it("is planar on x and z, ignoring altitude", () => {
    expect(distance2d({ x: 0, z: 0 }, { x: 3, z: 4 })).toBe(5);
  });
});

describe("tooClose", () => {
  const far = { x: 5000, z: 5000 };

  it("accepts a pole with nothing within 200 m", () => {
    expect(tooClose(far, [{ x: 5300, z: 5000 }])).toBeNull();
  });

  it("refuses a pole 199.99 m from another declaration", () => {
    expect(tooClose(far, [{ x: 5199.99, z: 5000 }])).toEqual({ x: 5199.99, z: 5000 });
  });

  it("accepts exactly 200 m — the rule is strictly less than", () => {
    expect(tooClose(far, [{ x: 5200, z: 5000 }])).toBeNull();
  });

  it("⚠️ treats the Fast Travel Hub as a declaration that always exists", () => {
    const nearHub = { x: HUB_POSITION.x + 50, z: HUB_POSITION.z };
    expect(tooClose(nearHub, [])).toEqual({ x: HUB_POSITION.x, z: HUB_POSITION.z });
  });

  it("uses MIN_BASE_SPACING_M by default", () => {
    expect(tooClose(far, [{ x: far.x + MIN_BASE_SPACING_M - 1, z: far.z }])).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @factions/domain exec vitest run test/spacing.test.ts`
Expected: FAIL — `distance2d` is not exported.

- [ ] **Step 3: Write `spacing.ts`**

```ts
// packages/domain/src/spacing.ts
import { HUB_POSITION, MIN_BASE_SPACING_M } from "./rules.js";

export type Point2 = { x: number; z: number };

/** Planar distance. Altitude is ignored on purpose: a base on a hill is still a base 150 m away. */
export function distance2d(a: Point2, b: Point2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * The 200 m rule (guide ch. 4, "Spacing"). Returns the first declaration
 * closer than `minM`, or null when the candidate is allowed.
 *
 * ⚠️ The Hub is checked even when `existing` is empty. It is never a row in
 * `declarations` — it is not a base and is never published — so if it were
 * not injected here, the one place every traveller lands could be somebody's
 * watch zone. Spec §4.10.
 */
export function tooClose(candidate: Point2, existing: readonly Point2[], minM: number = MIN_BASE_SPACING_M): Point2 | null {
  for (const p of [HUB_POSITION, ...existing]) {
    if (distance2d(candidate, p) < minM) return { x: p.x, z: p.z };
  }
  return null;
}
```

Add `export * from "./spacing.js";` to `packages/domain/src/index.ts`.

- [ ] **Step 4: Run the test, typecheck, commit**

Run: `pnpm --filter @factions/domain exec vitest run test/spacing.test.ts && pnpm --filter @factions/domain typecheck`
Expected: PASS, 6 tests; typecheck exit 0.

```bash
git add packages/domain/src/spacing.ts packages/domain/src/index.ts packages/domain/test/spacing.test.ts
git commit -m "feat(domain): the 200 m spacing rule, with the Hub as a phantom base"
```

---

### Task 2: Schema and migration 0020

**Files:**
- Modify: `packages/db/src/schema.ts` (`poles`, `factions`, new `declarations`)
- Create: `packages/db/migrations/0020_declarations.sql` (generated, then hand-edited)
- Modify: `packages/db/migrations/meta/_journal.json` (generated)
- Modify: `packages/db/test/holding-index-drift.test.ts`
- Test: `packages/db/test/declarations.test.ts` (new)

**Interfaces:**
- Produces: the `declarations` drizzle table with columns `id, serverId, poleKey, x, y, z, ownerFactionId, ownerDayzId, evidenceEventId, evidenceCeremonyId, declaredAt`; `poles.graceUntil`. `factions` loses `poleKey, x, y, z`.

- [ ] **Step 1: Write the failing constraint test**

```ts
// packages/db/test/declarations.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, declarations, ceremonies, events, admFiles, type Database,
} from "../src/index.js";
import { sql } from "drizzle-orm";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-04T12:00:00Z");

describe("declarations", () => {
  let db: Database;
  let serverId = 0;
  let ceremonyId = 0;
  let eventId = 0;
  let factionId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table declarations, factions, ceremonies, events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [c] = await db.insert(ceremonies).values({
      serverId, poleKey: "1.00:2.00:3.00", x: "1.00", y: "2.00", z: "3.00",
      windowStart: now, windowEnd: now, status: "claimed", detectedAt: now, expiresAt: now,
    }).returning();
    ceremonyId = c!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    const [e] = await db.insert(events).values({
      serverId, admFileId: a!.id, lineIndex: 0, type: "flag.raised", occurredAt: now,
      payload: { dayzId: "A", gamertag: "G", texture: "Flag_White", poleKey: "1.00:2.00:3.00" },
    }).returning();
    eventId = e!.id;
    const [f] = await db.insert(factions).values({
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active",
      leaderDiscordId: "d1", createdAt: now,
    }).returning();
    factionId = f!.id;
  });

  const row = (o: Partial<typeof declarations.$inferInsert>) => ({
    serverId, poleKey: "1.00:2.00:3.00", x: "1.00", y: "2.00", z: "3.00", declaredAt: now, ...o,
  });

  it("accepts a clan declaration citing a ceremony", async () => {
    await db.insert(declarations).values(row({ ownerFactionId: factionId, evidenceCeremonyId: ceremonyId }));
  });

  it("accepts a solo declaration citing a raise", async () => {
    await db.insert(declarations).values(row({ ownerDayzId: "A", evidenceEventId: eventId }));
  });

  it("⚠️ refuses a row with no evidence — the site can never bind a pole from nothing", async () => {
    await expect(db.insert(declarations).values(row({ ownerDayzId: "A" }))).rejects.toThrow(/declarations_one_evidence/);
  });

  it("refuses a row with two owners or none", async () => {
    await expect(db.insert(declarations).values(row({ ownerDayzId: "A", ownerFactionId: factionId, evidenceEventId: eventId })))
      .rejects.toThrow(/declarations_one_owner/);
    await expect(db.insert(declarations).values(row({ evidenceEventId: eventId })))
      .rejects.toThrow(/declarations_one_owner/);
  });

  it("allows one declared owner per pole", async () => {
    await db.insert(declarations).values(row({ ownerDayzId: "A", evidenceEventId: eventId }));
    await expect(db.insert(declarations).values(row({ ownerDayzId: "B", evidenceEventId: eventId })))
      .rejects.toThrow(/declarations_pole_uniq/);
  });

  it("allows one base per clan and one per player", async () => {
    await db.insert(declarations).values(row({ ownerFactionId: factionId, evidenceCeremonyId: ceremonyId }));
    await expect(db.insert(declarations).values(row({ poleKey: "9.00:9.00:9.00", ownerFactionId: factionId, evidenceCeremonyId: ceremonyId })))
      .rejects.toThrow(/declarations_faction_uniq/);
    await db.insert(declarations).values(row({ poleKey: "5.00:5.00:5.00", ownerDayzId: "A", evidenceEventId: eventId }));
    await expect(db.insert(declarations).values(row({ poleKey: "6.00:6.00:6.00", ownerDayzId: "A", evidenceEventId: eventId })))
      .rejects.toThrow(/declarations_player_uniq/);
  });

  it("factions no longer carries pole columns", async () => {
    const cols = await db.execute(sql`select column_name from information_schema.columns where table_name = 'factions'`);
    const names = (cols as unknown as { column_name: string }[]).map((c) => c.column_name);
    expect(names).not.toContain("pole_key");
    expect(names).not.toContain("x");
  });

  it("poles carries grace_until", async () => {
    const cols = await db.execute(sql`select column_name from information_schema.columns where table_name = 'poles' and column_name = 'grace_until'`);
    expect(cols.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/db exec vitest run test/declarations.test.ts`
Expected: FAIL — `declarations` is not exported from the schema.

- [ ] **Step 3: Edit `schema.ts`**

In `poles`, after `lastSeenAt`:

```ts
  /**
   * When this pole becomes public if still undeclared (spec §4.2). Set to
   * first sighting + NEW_POLE_GRACE_MS by the bot's pole projection, reset to
   * release + RELEASED_POLE_GRACE_MS whenever a declaration on it is
   * released, and stamped to launch + 7 d by the deploy runbook.
   *
   * ⚠️ Publication is a READ over this column, not a transition: a pole is
   * public iff flag_raised, no declarations row, and grace_until < now.
   */
  graceUntil: timestamp("grace_until", { withTimezone: true }).notNull(),
```

In `factions`, delete the four lines `poleKey`, `x`, `y`, `z` and the `uniqPole` index entry. Leave the texture and tag indexes. Update the docblock on `HOLDING_STATUSES` in `packages/domain/src/factions.ts` to say "mirrored by two partial unique indexes, and by the existence of a `declarations` row".

After `factions`, add:

```ts
/**
 * The pole binding, for clans and solos alike (spec §4.1; base-declaration
 * design §8 option C). One row per declared pole.
 *
 * ⚠️ The two CHECKs are the guard, not the export list. `declarations_one_owner`
 * is rule 3 made structural; `declarations_one_evidence` is what makes it
 * impossible for anything — the site included — to bind a pole without
 * citing a ceremony the detector wrote or a raise the log holds.
 */
export const declarations = pgTable("declarations", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  poleKey: text("pole_key").notNull(),
  x: numeric("x", { precision: 12, scale: 2 }).notNull(),
  y: numeric("y", { precision: 12, scale: 2 }).notNull(),
  z: numeric("z", { precision: 12, scale: 2 }).notNull(),
  ownerFactionId: bigint("owner_faction_id", { mode: "number" }).references(() => factions.id),
  ownerDayzId: text("owner_dayz_id"),
  evidenceEventId: bigint("evidence_event_id", { mode: "number" }).references(() => events.id),
  evidenceCeremonyId: bigint("evidence_ceremony_id", { mode: "number" }).references(() => ceremonies.id),
  declaredAt: timestamp("declared_at", { withTimezone: true }).notNull(),
}, (t) => ({
  oneOwner: check("declarations_one_owner",
    sql`(${t.ownerFactionId} IS NULL) <> (${t.ownerDayzId} IS NULL)`),
  oneEvidence: check("declarations_one_evidence",
    sql`(${t.evidenceEventId} IS NULL) <> (${t.evidenceCeremonyId} IS NULL)`),
  uniqPole: uniqueIndex("declarations_pole_uniq").on(t.serverId, t.poleKey),
  uniqFaction: uniqueIndex("declarations_faction_uniq").on(t.ownerFactionId)
    .where(sql`${t.ownerFactionId} IS NOT NULL`),
  uniqPlayer: uniqueIndex("declarations_player_uniq").on(t.serverId, t.ownerDayzId)
    .where(sql`${t.ownerDayzId} IS NOT NULL`),
}));
```

- [ ] **Step 4: Generate, then hand-edit the migration**

Run: `cd packages/db && npx drizzle-kit generate --name declarations`

Open the generated `0020_declarations.sql`. drizzle emits `CREATE TABLE declarations`, `ALTER TABLE poles ADD COLUMN grace_until … NOT NULL`, `DROP INDEX factions_holding_pole_uniq`, and four `ALTER TABLE factions DROP COLUMN`. **Reorder and add** so the file reads, top to bottom:

```sql
-- 1. New table and indexes (drizzle's CREATE TABLE, FKs and CREATE INDEX statements, unchanged)

--> statement-breakpoint
-- 2. grace_until with a default so existing rows get one; the runbook re-stamps it to launch + 7 d.
ALTER TABLE "poles" ADD COLUMN "grace_until" timestamp with time zone NOT NULL DEFAULT (now() + interval '7 days');
--> statement-breakpoint
ALTER TABLE "poles" ALTER COLUMN "grace_until" DROP DEFAULT;
--> statement-breakpoint
-- 3. Move every holding faction's pole into declarations, citing its ceremony.
INSERT INTO "declarations" ("server_id","pole_key","x","y","z","owner_faction_id","evidence_ceremony_id","declared_at")
SELECT f."server_id", f."pole_key", f."x", f."y", f."z", f."id", f."ceremony_id", COALESCE(f."activated_at", f."created_at")
FROM "factions" f
WHERE f."status" IN ('reserved','active','dormant') AND f."ceremony_id" IS NOT NULL;
--> statement-breakpoint
-- 4. ⚠️ Refuse to drop a pole nobody moved. A holding faction without a ceremony_id is a
--    backfilled row this migration cannot cite evidence for; it must be handled by hand
--    (see docs/deploy/2026-09-xx-declarations.md) before this runs. factions_live holds none.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "factions" WHERE "status" IN ('reserved','active','dormant') AND "ceremony_id" IS NULL) THEN
    RAISE EXCEPTION 'declarations: a holding faction has no ceremony_id; move its pole by hand first';
  END IF;
END $$;
--> statement-breakpoint
-- 5. Drop the old binding (drizzle's DROP INDEX and four DROP COLUMN statements, unchanged)
```

Keep drizzle's `--> statement-breakpoint` markers between every statement.

- [ ] **Step 5: Run the db suite fresh**

Run: `TEST_DATABASE_FRESH=1 TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/db test`
Expected: `declarations.test.ts` PASS (8 tests). `holding-index-drift.test.ts` FAILS because `factions_holding_pole_uniq` is gone — that is the next step.

- [ ] **Step 6: Update the drift test**

In `packages/db/test/holding-index-drift.test.ts`, change `INDEXES` to the two survivors and add the declarations assertion:

```ts
  const INDEXES = [
    "factions_holding_texture_uniq",
    "factions_holding_tag_uniq",
  ];
```

and a second `it`:

```ts
  it("the pole half of HOLDING is the existence of a declarations row", async () => {
    // ⚠️ factions_holding_pole_uniq is gone on purpose (increment 1). A
    // holding faction's pole is now declarations.owner_faction_id, unique on
    // its own; a reader that reintroduces a pole column on factions has
    // recreated the drift this test used to catch.
    const rows = await db.execute(sql`
      select indexname from pg_indexes where schemaname = 'public'
        and indexname in ('declarations_pole_uniq','declarations_faction_uniq','declarations_player_uniq')
    `);
    expect(rows.length).toBe(3);
  });
```

Update the module docblock's "three partial unique indexes" to "two … plus the `declarations` uniques".

- [ ] **Step 7: Run the db suite, commit**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/db test && pnpm --filter @factions/db typecheck`
Expected: PASS. `schema.test.ts` inserts into `poles` without `graceUntil` and will fail typecheck — add `graceUntil: new Date()` to both inserts there.

```bash
git add packages/db packages/domain/src/factions.ts
git commit -m "feat(db): declarations owns the pole binding; poles.grace_until

Migration 0020 moves every holding faction's pole into declarations,
citing its ceremony, and refuses to run if any holding faction has no
ceremony to cite. factions_holding_pole_uniq is replaced by
declarations_pole_uniq and declarations_faction_uniq."
```

⚠️ Every other package now fails typecheck (they select `factions.poleKey`). That is expected until Task 9; do not run the full gate before then.

---

### Task 3: Pole projection in the bot

**Files:**
- Create: `apps/bot/src/pole-tick.ts`
- Test: `apps/bot/test/pole-tick.test.ts`

The projector in `apps/projector` does not run in production (CLAUDE.md: `flag_changes` holds zero rows there), so `poles` — and therefore `grace_until` — would never be populated. The bot folds flag events into `poles` itself, with the same cursor discipline as `player-tick.ts`. It writes `poles` only; `flag_changes` stays the projector's.

**Interfaces:**
- Produces: `runPoleProjection(db, opts?): Promise<{ scanned: number; upserted: number }>`, `POLE_CONSUMER = "pole-projector-bot"`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/bot/test/pole-tick.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, poles, events, admFiles, type Database } from "@factions/db";
import { NEW_POLE_GRACE_MS } from "@factions/domain";
import { sql, eq } from "drizzle-orm";
import { runPoleProjection } from "../src/pole-tick.js";

const URL = requireTestDatabaseUrl();
const t0 = new Date("2026-09-04T12:00:00Z");

describe("runPoleProjection", () => {
  let db: Database;
  let serverId = 0;
  let admFileId = 0;
  let lineIndex = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table poles, consumer_cursors, events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: t0, linesIngested: 0, complete: true }).returning();
    admFileId = a!.id;
    lineIndex = 0;
  });

  const flag = (action: "raised" | "lowered", at: Date, texture = "Flag_White") =>
    db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, type: `flag.${action}`, occurredAt: at,
      payload: { dayzId: "A", gamertag: "G", texture, action, poleKey: "10.00:20.00:30.00", pole: { x: 10, y: 20, z: 30 } },
    });

  it("creates a pole on first sight with grace_until = first sighting + 7 days", async () => {
    await flag("raised", t0);
    const r = await runPoleProjection(db);
    expect(r).toEqual({ scanned: 1, upserted: 1 });
    const [p] = await db.select().from(poles).where(eq(poles.serverId, serverId));
    expect(p!.flagRaised).toBe(true);
    expect(p!.currentTexture).toBe("Flag_White");
    expect(p!.graceUntil.getTime()).toBe(t0.getTime() + NEW_POLE_GRACE_MS);
  });

  it("⚠️ a later event does not move grace_until", async () => {
    await flag("raised", t0);
    await runPoleProjection(db);
    await flag("lowered", new Date(t0.getTime() + 3_600_000));
    await runPoleProjection(db);
    const [p] = await db.select().from(poles).where(eq(poles.serverId, serverId));
    expect(p!.flagRaised).toBe(false);
    expect(p!.graceUntil.getTime()).toBe(t0.getTime() + NEW_POLE_GRACE_MS);
  });

  it("is idempotent across runs — the cursor advances", async () => {
    await flag("raised", t0);
    await runPoleProjection(db);
    expect(await runPoleProjection(db)).toEqual({ scanned: 0, upserted: 0 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/bot exec vitest run test/pole-tick.test.ts`
Expected: FAIL — cannot find `../src/pole-tick.js`.

- [ ] **Step 3: Write `pole-tick.ts`**

```ts
// apps/bot/src/pole-tick.ts
import type { Database } from "@factions/db";
import { poles, servers } from "@factions/db";
import { readCursor, writeCursor, readEventBatch } from "@factions/event-log";
import { NEW_POLE_GRACE_MS } from "@factions/domain";
import { eq, sql } from "drizzle-orm";

/**
 * ⚠️ Distinct from apps/projector's "pole-projector" cursor. That process
 * does not run in production and writes flag_changes too; this one writes
 * poles only. Sharing a cursor name would make each skip the other's events.
 */
export const POLE_CONSUMER = "pole-projector-bot";

export type PoleProjectionResult = { scanned: number; upserted: number };

type FlagPayload = { texture: string; poleKey: string; pole: { x: number; y: number; z: number } };

function readFlagPayload(payload: unknown): FlagPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const pole = p.pole as Record<string, unknown> | undefined;
  if (typeof p.texture !== "string" || typeof p.poleKey !== "string" || p.poleKey === "") return null;
  if (!pole || typeof pole.x !== "number" || typeof pole.y !== "number" || typeof pole.z !== "number") return null;
  return { texture: p.texture, poleKey: p.poleKey, pole: { x: pole.x, y: pole.y, z: pole.z } };
}

/**
 * Fold flag events into `poles`, so grace_until exists for every pole the
 * log has ever seen. The site's public-bases layer and the solo declare
 * page both read this table.
 */
export async function runPoleProjection(db: Database, opts: { batchSize?: number } = {}): Promise<PoleProjectionResult> {
  const batchSize = opts.batchSize ?? 500;
  let cursor = await readCursor(db, POLE_CONSUMER);
  const out: PoleProjectionResult = { scanned: 0, upserted: 0 };
  const maps = new Map<number, string>();

  for (;;) {
    const batch = await readEventBatch(db, cursor, batchSize);
    if (batch.length === 0) break;
    for (const ev of batch) {
      cursor = ev.id;
      if (ev.type !== "flag.raised" && ev.type !== "flag.lowered") continue;
      const p = readFlagPayload(ev.payload);
      if (!p) continue;
      out.scanned++;

      let map = maps.get(ev.serverId);
      if (!map) {
        const [s] = await db.select({ map: servers.map }).from(servers).where(eq(servers.id, ev.serverId));
        if (!s) continue;
        map = s.map;
        maps.set(ev.serverId, map);
      }

      const raised = ev.type === "flag.raised";
      await db.insert(poles).values({
        serverId: ev.serverId, map, poleKey: p.poleKey,
        x: p.pole.x.toFixed(2), y: p.pole.y.toFixed(2), z: p.pole.z.toFixed(2),
        currentTexture: p.texture, flagRaised: raised,
        firstSeenAt: ev.occurredAt, lastSeenAt: ev.occurredAt,
        // ⚠️ Only on insert. The ON CONFLICT below deliberately omits
        // grace_until: a release resets it (declaration-store) and the
        // runbook stamps it, and neither must be undone by the next raise.
        graceUntil: new Date(ev.occurredAt.getTime() + NEW_POLE_GRACE_MS),
      }).onConflictDoUpdate({
        target: [poles.serverId, poles.map, poles.poleKey],
        set: { currentTexture: p.texture, flagRaised: raised, lastSeenAt: ev.occurredAt, foldedAt: null },
        // Events can arrive out of order across ADM files; never let an older line overwrite a newer state.
        setWhere: sql`${poles.lastSeenAt} <= ${ev.occurredAt}`,
      });
      out.upserted++;
    }
    await writeCursor(db, POLE_CONSUMER, cursor);
  }
  return out;
}
```

- [ ] **Step 4: Run the test**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/bot exec vitest run test/pole-tick.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Wire it into the runner**

In `apps/bot/src/discord.ts`, inside the `guardedRunner` job (around line 1116, immediately before `runPlayerProjection`), add:

```ts
      const poleRun = await runPoleProjection(db);
      if (poleRun.upserted > 0) console.log(`pole projection: ${poleRun.upserted} poles`);
```

with `import { runPoleProjection } from "./pole-tick.js";` at the top. It runs before the player projection so the ceremony tick in the same job sees the pole rows.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/pole-tick.ts apps/bot/src/discord.ts apps/bot/test/pole-tick.test.ts
git commit -m "feat(bot): fold flag events into poles so every pole has a grace clock"
```

---

### Task 4: The declaration store

**Files:**
- Create: `apps/bot/src/declaration-store.ts`
- Test: `apps/bot/test/declaration-store.test.ts`

**Interfaces:**
- Produces:
  - `type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0]` (re-exported from here for every later caller).
  - `type DeclareArgs = { serverId; poleKey; x; y; z; owner: { factionId: number } | { dayzId: string }; evidence: { ceremonyId: number } | { eventId: number }; at: Date }`.
  - `declareTx(tx, a): Promise<{ ok: true; id: number } | { ok: false; reason: "too-close" | "pole-taken" | "owner-has-base" }>`.
  - `releaseTx(tx, owner, at): Promise<boolean>` — deletes the row and sets the pole's `grace_until = at + RELEASED_POLE_GRACE_MS`.
  - `declarationForFaction(db, factionId)`, `declarationForPlayer(db, serverId, dayzId)` → `{ id, poleKey, x, y, z, declaredAt } | null`.
  - `publicPoles(db, serverId, now)` → `{ poleKey, x, y, z, texture }[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/bot/test/declaration-store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, declarations, poles, events, admFiles, type Database,
} from "@factions/db";
import { RELEASED_POLE_GRACE_MS, HUB_POSITION } from "@factions/domain";
import { sql, eq, and } from "drizzle-orm";
import { declareTx, releaseTx, declarationForFaction, declarationForPlayer, publicPoles } from "../src/declaration-store.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-04T12:00:00Z");
const key = (x: number, z: number) => `${x.toFixed(2)}:100.00:${z.toFixed(2)}`;

describe("declaration store", () => {
  let db: Database;
  let serverId = 0;
  let eventId = 0;
  let factionId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table declarations, poles, factions, events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    const [e] = await db.insert(events).values({
      serverId, admFileId: a!.id, lineIndex: 0, type: "flag.raised", occurredAt: now,
      payload: { dayzId: "A", gamertag: "G", texture: "Flag_White", poleKey: key(5000, 5000) },
    }).returning();
    eventId = e!.id;
    const [f] = await db.insert(factions).values({
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", leaderDiscordId: "d1", createdAt: now,
    }).returning();
    factionId = f!.id;
  });

  const seedPole = (x: number, z: number, o: { texture?: string; raised?: boolean; graceUntil?: Date } = {}) =>
    db.insert(poles).values({
      serverId, map: "livonia", poleKey: key(x, z), x: x.toFixed(2), y: "100.00", z: z.toFixed(2),
      currentTexture: o.texture ?? "Flag_White", flagRaised: o.raised ?? true,
      firstSeenAt: now, lastSeenAt: now, graceUntil: o.graceUntil ?? new Date(now.getTime() - 1),
    });

  const solo = (x: number, z: number, dayzId = "A") => db.transaction((tx) => declareTx(tx, {
    serverId, poleKey: key(x, z), x, y: 100, z, owner: { dayzId }, evidence: { eventId }, at: now,
  }));

  it("declares a pole with nothing near it", async () => {
    expect(await solo(5000, 5000)).toEqual({ ok: true, id: expect.any(Number) });
    expect(await declarationForPlayer(db, serverId, "A")).toMatchObject({ poleKey: key(5000, 5000) });
  });

  it("refuses a pole within 200 m of another declaration", async () => {
    await solo(5000, 5000, "A");
    expect(await solo(5150, 5000, "B")).toEqual({ ok: false, reason: "too-close" });
  });

  it("⚠️ refuses a pole within 200 m of the Hub even with no declarations", async () => {
    expect(await solo(HUB_POSITION.x + 10, HUB_POSITION.z)).toEqual({ ok: false, reason: "too-close" });
  });

  it("refuses a second base for the same owner", async () => {
    await solo(5000, 5000, "A");
    expect(await solo(9000, 9000, "A")).toEqual({ ok: false, reason: "owner-has-base" });
  });

  it("refuses a pole somebody already declared", async () => {
    await solo(5000, 5000, "A");
    expect(await solo(5000, 5000, "B")).toEqual({ ok: false, reason: "pole-taken" });
  });

  it("⚠️ two concurrent claims 150 m apart produce one declaration", async () => {
    const a = solo(5000, 5000, "A");
    const b = solo(5150, 5000, "B");
    const results = await Promise.all([a, b]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "too-close")).toHaveLength(1);
  });

  it("release deletes the row and gives the pole its 3-day grace", async () => {
    await seedPole(5000, 5000);
    await solo(5000, 5000, "A");
    const at = new Date(now.getTime() + 60_000);
    expect(await db.transaction((tx) => releaseTx(tx, { dayzId: "A", serverId }, at))).toBe(true);
    expect(await declarationForPlayer(db, serverId, "A")).toBeNull();
    const [p] = await db.select().from(poles).where(and(eq(poles.serverId, serverId), eq(poles.poleKey, key(5000, 5000))));
    expect(p!.graceUntil.getTime()).toBe(at.getTime() + RELEASED_POLE_GRACE_MS);
  });

  it("release of an owner with no declaration is false, not an error", async () => {
    expect(await db.transaction((tx) => releaseTx(tx, { factionId }, now))).toBe(false);
  });

  describe("publicPoles", () => {
    it("lists an undeclared, raised pole past its grace, with its texture", async () => {
      await seedPole(5000, 5000, { texture: "Flag_Wolf" });
      expect(await publicPoles(db, serverId, now)).toEqual([{ poleKey: key(5000, 5000), x: "5000.00", y: "100.00", z: "5000.00", texture: "Flag_Wolf" }]);
    });

    it("⚠️ an undeclared base flying a CLAIMED texture is still public", async () => {
      // Base-declaration §2.1: rule 2 is texture-agnostic. This is the one a
      // future "optimisation" is most likely to break.
      await seedPole(5000, 5000, { texture: "Flag_Bear" });
      expect(await publicPoles(db, serverId, now)).toHaveLength(1);
    });

    it("hides a declared pole, a lowered pole, and a pole inside grace", async () => {
      await seedPole(5000, 5000); await solo(5000, 5000, "A");
      await seedPole(6000, 6000, { raised: false });
      await seedPole(7000, 7000, { graceUntil: new Date(now.getTime() + 1) });
      expect(await publicPoles(db, serverId, now)).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/bot exec vitest run test/declaration-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the store**

```ts
// apps/bot/src/declaration-store.ts
import type { Database } from "@factions/db";
import { declarations, poles } from "@factions/db";
import { tooClose, RELEASED_POLE_GRACE_MS } from "@factions/domain";
import { and, eq, isNull, lt, sql } from "drizzle-orm";

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type Owner = { factionId: number } | { dayzId: string; serverId: number };
export type DeclareArgs = {
  serverId: number; poleKey: string; x: number; y: number; z: number;
  owner: { factionId: number } | { dayzId: string };
  evidence: { ceremonyId: number } | { eventId: number };
  at: Date;
};
export type DeclareOutcome =
  | { ok: true; id: number }
  | { ok: false; reason: "too-close" | "pole-taken" | "owner-has-base" };

export type Declaration = { id: number; poleKey: string; x: string; y: string; z: string; declaredAt: Date };

/**
 * The ONLY way a declarations row is written (spec §4.1, §14).
 *
 * ⚠️ Takes the server's existing rows FOR UPDATE before checking distance.
 * The 200 m rule cannot be an index, so without the lock two concurrent
 * claims 150 m apart both read an empty neighbourhood and both commit.
 * Coarse (one server) and fine: declarations are rare.
 *
 * ⚠️ Lock order: the caller holds `factions` (if it holds anything) before
 * calling this. `declarations` comes second in the order for that reason.
 */
export async function declareTx(tx: Tx, a: DeclareArgs): Promise<DeclareOutcome> {
  const existing = await tx.select({ x: declarations.x, z: declarations.z })
    .from(declarations)
    .where(eq(declarations.serverId, a.serverId))
    .for("update");

  if (tooClose({ x: a.x, z: a.z }, existing.map((r) => ({ x: Number(r.x), z: Number(r.z) })))) {
    return { ok: false, reason: "too-close" };
  }

  try {
    const [row] = await tx.insert(declarations).values({
      serverId: a.serverId, poleKey: a.poleKey,
      x: a.x.toFixed(2), y: a.y.toFixed(2), z: a.z.toFixed(2),
      ownerFactionId: "factionId" in a.owner ? a.owner.factionId : null,
      ownerDayzId: "dayzId" in a.owner ? a.owner.dayzId : null,
      evidenceCeremonyId: "ceremonyId" in a.evidence ? a.evidence.ceremonyId : null,
      evidenceEventId: "eventId" in a.evidence ? a.evidence.eventId : null,
      declaredAt: a.at,
    }).returning({ id: declarations.id });
    return { ok: true, id: row!.id };
  } catch (err) {
    // Same pattern as faction-store.reserve: the index decides, the message names it.
    const msg = String(err);
    if (msg.includes("declarations_pole_uniq")) return { ok: false, reason: "pole-taken" };
    if (msg.includes("declarations_faction_uniq") || msg.includes("declarations_player_uniq")) {
      return { ok: false, reason: "owner-has-base" };
    }
    throw err;
  }
}

const ownerWhere = (o: Owner) =>
  "factionId" in o
    ? eq(declarations.ownerFactionId, o.factionId)
    : and(eq(declarations.serverId, o.serverId), eq(declarations.ownerDayzId, o.dayzId))!;

/**
 * Release a declaration and start the pole's 3-day grace (spec §5.2).
 *
 * ⚠️ The grace write is in the same transaction as the delete. A release
 * whose grace never lands publishes the old base the instant it is released
 * — the exact outcome the grace exists to prevent — with no error anywhere.
 */
export async function releaseTx(tx: Tx, owner: Owner, at: Date): Promise<boolean> {
  const [gone] = await tx.delete(declarations).where(ownerWhere(owner))
    .returning({ serverId: declarations.serverId, poleKey: declarations.poleKey });
  if (!gone) return false;
  await tx.update(poles)
    .set({ graceUntil: new Date(at.getTime() + RELEASED_POLE_GRACE_MS) })
    .where(and(eq(poles.serverId, gone.serverId), eq(poles.poleKey, gone.poleKey)));
  return true;
}

const shape = { id: declarations.id, poleKey: declarations.poleKey, x: declarations.x, y: declarations.y, z: declarations.z, declaredAt: declarations.declaredAt };

export async function declarationForFaction(db: Database | Tx, factionId: number): Promise<Declaration | null> {
  const [row] = await db.select(shape).from(declarations).where(eq(declarations.ownerFactionId, factionId));
  return row ?? null;
}

export async function declarationForPlayer(db: Database | Tx, serverId: number, dayzId: string): Promise<Declaration | null> {
  const [row] = await db.select(shape).from(declarations)
    .where(and(eq(declarations.serverId, serverId), eq(declarations.ownerDayzId, dayzId)));
  return row ?? null;
}

/**
 * Rule 2: every raised, undeclared pole past its grace, with the flag flying
 * there (spec §4.2). Texture-agnostic on purpose — see the test.
 */
export async function publicPoles(db: Database, serverId: number, now: Date) {
  return db.select({ poleKey: poles.poleKey, x: poles.x, y: poles.y, z: poles.z, texture: poles.currentTexture })
    .from(poles)
    .leftJoin(declarations, and(eq(declarations.serverId, poles.serverId), eq(declarations.poleKey, poles.poleKey)))
    .where(and(
      eq(poles.serverId, serverId),
      eq(poles.flagRaised, true),
      isNull(declarations.id),
      lt(poles.graceUntil, now),
    ))
    .orderBy(poles.poleKey);
}
```

- [ ] **Step 4: Run the tests**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/bot exec vitest run test/declaration-store.test.ts`
Expected: PASS, 11 tests. If the concurrency test is flaky, the `.for("update")` is missing: two transactions must serialise on the server's rows. With zero existing rows there is nothing to lock — so the race test needs one prior row; if it still passes only sometimes, add `await tx.execute(sql\`select pg_advisory_xact_lock(${a.serverId})\`)` as the first statement of `declareTx` and keep the `for update` (the advisory lock covers the empty-table case, which is the launch-day case).

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/declaration-store.ts apps/bot/test/declaration-store.test.ts
git commit -m "feat(bot): declaration store — the one writer of the pole binding"
```

---

### Task 5: Reservation inserts the declaration

**Files:**
- Modify: `apps/bot/src/faction-store.ts` (`reserve`, `ReserveArgs`, outcomes)
- Modify: `apps/bot/src/faction-commands.ts:79-95` (map the new outcome)
- Test: `apps/bot/test/faction-commands.test.ts`, `apps/bot/test/feed-writers-claim.test.ts` (existing), plus new cases below.

**Interfaces:**
- `reserve` outcome gains `"too-close"`; loses `"pole-taken"` as a factions-index outcome (it now comes from `declareTx`).

- [ ] **Step 1: Add the failing test to `faction-commands.test.ts`**

Find the existing "reserve" describe block (the one that calls `handleClaimConfirm` or equivalent — `grep -n "flag-taken" apps/bot/test/faction-commands.test.ts` locates it) and add beside the `flag-taken` case:

```ts
  it("tells the claimant the pole is too close to another declared base", async () => {
    store.reserve = async () => "too-close";
    const reply = await confirmClaim();   // the helper the neighbouring cases use
    expect(reply.content).toContain("too close to another declared base");
  });
```

- [ ] **Step 2: Rewrite `reserve`**

Replace the `poleKey, x, y, z` in the `factions` insert with a `declareTx` call **immediately after the insert** (lock order: `factions` row exists and is locked by its own insert, then `declarations`):

```ts
        const [f] = await tx.insert(factions).values({
          serverId: a.serverId, name: a.name, tag: a.tag, texture: a.texture,
          status: "reserved", leaderDiscordId: a.leaderDiscordId,
          ceremonyId: a.ceremonyId, createdAt: a.at, reservedUntil: a.reservedUntil,
        }).returning({ id: factions.id });

        // The reservation holds the pole for its 24 h (guide ch. 3), so the
        // declaration is written here, not at activation — and the 200 m
        // refusal happens where the guide says it does: at the claim.
        const declared = await declareTx(tx, {
          serverId: a.serverId, poleKey: a.poleKey, x: Number(a.x), y: Number(a.y), z: Number(a.z),
          owner: { factionId: f!.id }, evidence: { ceremonyId: a.ceremonyId }, at: a.at,
        });
        if (!declared.ok) throw new ReserveAbort(declared.reason === "too-close" ? "too-close" : "pole-taken");
```

with, above the class:

```ts
/** Unwinds the transaction carrying a non-error outcome, the way roster-store's RosterAbort does. */
class ReserveAbort extends Error {
  constructor(readonly outcome: "too-close" | "pole-taken") { super(outcome); }
}
```

and in the `catch`:

```ts
      if (err instanceof ReserveAbort) return err.outcome;
```

before the string matching. Remove the `factions_holding_pole_uniq` line. Change the return type union to `"ok" | "ceremony-taken" | "flag-taken" | "tag-taken" | "pole-taken" | "too-close"` in both the interface and the method. Import `declareTx` from `./declaration-store.js`.

- [ ] **Step 3: Map the outcome in `faction-commands.ts`**

Where `pole-taken` is turned into a reply, add:

```ts
    case "too-close":
      return reply(
        "That pole is too close to another declared base — bases must be 200 m apart. " +
        "The map can't show you private bases, so this refusal is your first warning. Choose another pole.",
      );
```

(The `200 m` in copy is rendered from `MIN_BASE_SPACING_M`: `` `… must be ${MIN_BASE_SPACING_M} m apart …` ``.)

- [ ] **Step 4: Run the two suites**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/bot exec vitest run test/faction-commands.test.ts test/feed-writers-claim.test.ts`
Expected: the new case PASSES. Existing cases that assert on `factions.poleKey` after a reserve fail to typecheck — change them to read `declarationForFaction(db, id)` and assert on `poleKey` there.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/faction-store.ts apps/bot/src/faction-commands.ts apps/bot/test
git commit -m "feat(bot): a reservation declares its pole, 200 m checked at the claim"
```

---

### Task 6: Ceremony eligibility and lapse

**Files:**
- Modify: `apps/bot/src/ceremony-store.ts` (`isPoleBound`, new `soloDeclarantAt`, `reservedFactionAt`, `lapseReservations`)
- Modify: `apps/bot/src/ceremony-tick.ts` (`settlePole`)
- Test: `apps/bot/test/ceremony-store.test.ts`, `apps/bot/test/ceremony-tick.test.ts`

**Interfaces:**
- `CeremonyStore` gains `soloDeclarantAt(p: PoleRef): Promise<string | null>` (the declarant's dayzId, or null).
- `isPoleBound` now means **bound to a clan**.

- [ ] **Step 1: Add failing tests to `ceremony-tick.test.ts`**

The suite has a fake store; extend the fake with `soloDeclarantAt: async () => null` as the default, and add:

```ts
  it("settles a ceremony at a pole declared to one of the participants", async () => {
    store.soloDeclarantAt = async () => "A".repeat(40);   // participant A holds it
    // seed three white raises at the pole by A, B, C inside 10 min, as the qualifying case does
    …
    expect(result.detected).toBe(1);
  });

  it("⚠️ refuses a ceremony at a pole declared to someone absent — no takeover by ceremony", async () => {
    store.soloDeclarantAt = async () => "Z".repeat(40);
    …
    expect(result.detected).toBe(0);
  });
```

Copy the three-raise seeding from the existing "detects a ceremony" case verbatim into both.

- [ ] **Step 2: Rewrite the store methods**

```ts
  /** Bound to a CLAN. A solo declaration does not bind a pole for ceremony purposes — see settlePole. */
  async isPoleBound(p: PoleRef): Promise<boolean> {
    const [row] = await this.db.select({ id: declarations.id }).from(declarations)
      .where(and(
        eq(declarations.serverId, p.serverId),
        eq(declarations.poleKey, p.poleKey),
        isNotNull(declarations.ownerFactionId),
      ));
    return row !== undefined;
  }

  async soloDeclarantAt(p: PoleRef): Promise<string | null> {
    const [row] = await this.db.select({ dayzId: declarations.ownerDayzId }).from(declarations)
      .where(and(eq(declarations.serverId, p.serverId), eq(declarations.poleKey, p.poleKey)));
    return row?.dayzId ?? null;
  }

  async reservedFactionAt(p: PoleRef, texture: string): Promise<{ id: number } | null> {
    const [row] = await this.db.select({ id: factions.id }).from(factions)
      .innerJoin(declarations, eq(declarations.ownerFactionId, factions.id))
      .where(and(
        eq(declarations.serverId, p.serverId),
        eq(declarations.poleKey, p.poleKey),
        eq(factions.texture, texture),
        eq(factions.status, "reserved"),
      ));
    return row ?? null;
  }
```

`isRosterMember` is unchanged. In `lapseReservations`, after the `factionMembers` delete and before the invites update, release each lapsed faction's declaration:

```ts
        // Guide ch. 4: a lapsed pole gets the 3-day grace before going public.
        for (const id of lapsed) await releaseTx(tx, { factionId: id }, cutoff);
```

Import `declarations` from `@factions/db`, `isNotNull` from drizzle, `releaseTx` from `./declaration-store.js`. Add `soloDeclarantAt` to the `CeremonyStore` interface.

- [ ] **Step 3: The participant check in `settlePole`**

Replace the `blocked` line and the draft construction:

```ts
    const blocked = (await store.hasOpenCeremony(pole)) || (await store.isPoleBound(pole));
    // Base-declaration §4: a pole declared to a solo is eligible only if that
    // solo is standing in the ceremony. ⚠️ This is the clause that stops three
    // strangers taking a base from under its sleeping owner.
    const declarant = blocked ? null : await store.soloDeclarantAt(pole);
    const declarantPresent = declarant === null || w.participants.includes(declarant);
    let draft = null;
    if (!blocked && declarantPresent && qualifies(w)) {
```

- [ ] **Step 4: Run both suites**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/bot exec vitest run test/ceremony-tick.test.ts test/ceremony-store.test.ts test/activation.test.ts`
Expected: PASS after the seed helpers in `ceremony-store.test.ts` and `activation.test.ts` are changed per Task 9 (do that part of Task 9 for these two files now if they fail on `poleKey`).

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/ceremony-store.ts apps/bot/src/ceremony-tick.ts apps/bot/test
git commit -m "feat(bot): ceremony eligibility reads declarations; a solo's pole needs the solo present; lapse releases with grace"
```

---

### Task 7: Dormancy reads declarations and counts only roster raises

**Files:**
- Modify: `apps/bot/src/dormancy-store.ts` (`LAST_RAISE`, `clocks`, export `clockQuery`)
- Modify: `apps/bot/src/roster-store.ts:153-190` (`disbandFactionTx` releases)
- Modify: `apps/bot/test/dormancy-index-drift.test.ts`
- Test: `apps/bot/test/dormancy-store.test.ts`, `apps/bot/test/roster-lifecycle.test.ts`

**Interfaces:**
- `clockQuery(db)` — the select builder both `clocks()` and the drift test use, so the two cannot diverge.

- [ ] **Step 1: Add failing tests to `dormancy-store.test.ts`**

Inside `describe("clocks")`, after changing `seedFaction` per Task 9 (it must insert a declaration and, for these tests, a `faction_members` row for UID `"A"`):

```ts
    it("⚠️ a non-member's raise does not wind the clock", async () => {
      const f = await seedFaction({ tag: "BEAR" });
      await seedRaise({ poleKey: "1:2:3", texture: "Flag_Bear", at: ago(1000), dayzId: "STRANGER" });
      const [c] = await store.clocks();
      // No member raise at all → coalesce falls through to created_at.
      expect(c!.lastRaiseAt!.getTime()).toBe(f.createdAt.getTime());
    });

    it("a member's raise does", async () => {
      await seedFaction({ tag: "BEAR" });
      await seedRaise({ poleKey: "1:2:3", texture: "Flag_Bear", at: ago(1000), dayzId: "A" });
      const [c] = await store.clocks();
      expect(c!.lastRaiseAt!.getTime()).toBe(ago(1000).getTime());
    });
```

`seedRaise` gains an optional `dayzId` (default `"A"`) written into the payload.

- [ ] **Step 2: Rewrite `LAST_RAISE` and `clocks`**

```ts
/**
 * ⚠️ Read from `events`, NOT `flag_changes` (see the docblock that was here).
 *
 * Joined to `declarations` for the pole, and — spec §5.1 — restricted to
 * raises by someone on the roster. Base-declaration §7: without the member
 * check any stranger could keep a dead clan's clock alive forever and its
 * flag out of the pool. The member predicate is a Filter, not an index
 * condition, and that is fine: the index has already narrowed to this pole
 * and texture; see dormancy-index-drift.test.ts.
 */
export const LAST_RAISE = sql<Date | null>`(
  select max(e.occurred_at)
  from events e
  where e.type = 'flag.raised'
    and e.server_id = ${factions.serverId}
    and e.payload->>'poleKey' = ${declarations.poleKey}
    and e.payload->>'texture' = ${factions.texture}
    and e.payload->>'dayzId' in (
      select m.dayz_id from faction_members m where m.faction_id = ${factions.id}
    )
)`;

/** The one query both clocks() and the index drift test run. */
export function clockQuery(db: Database) {
  return db.select({
    id: factions.id,
    name: factions.name,
    tag: factions.tag,
    leaderDiscordId: factions.leaderDiscordId,
    status: factions.status,
    dormantSince: factions.dormantSince,
    // ⚠️ COALESCE, and the order matters … (keep the existing comment)
    lastRaiseAt: sql<Date | null>`coalesce(${LAST_RAISE}, ${factions.activatedAt}, ${factions.createdAt})`,
    serverLastEventAt: SERVER_LAST_EVENT,
  }).from(factions)
    // LEFT: a clan with no declaration (post-wipe, increment 4) still has a clock; its LAST_RAISE is null.
    .leftJoin(declarations, eq(declarations.ownerFactionId, factions.id))
    .where(inArray(factions.status, EXAMINED));
}
```

`clocks()` becomes `const rows = await clockQuery(this.db);` followed by the existing `map`. Import `declarations`.

- [ ] **Step 3: Relax the drift test for the member predicate only**

In `dormancy-index-drift.test.ts`, build the query with `clockQuery(db).toSQL()` and replace the last assertion:

```ts
    // The roster predicate is allowed as a Filter — it runs after the index
    // has narrowed to one pole and one texture. poleKey and texture are not.
    const payloadFilters = lines.filter((l) => /Filter:.*payload/.test(l));
    for (const l of payloadFilters) {
      expect(l).not.toContain("'poleKey'");
      expect(l).not.toContain("'texture'");
    }
```

- [ ] **Step 4: Disband releases the declaration**

In `disbandFactionTx`, after the `factionMembers` delete:

```ts
  // Guide ch. 8: the base goes public after its 3-day grace.
  await releaseTx(tx, { factionId }, new Date());
```

Import `releaseTx`. (Lock order holds: `factions` updated first, then `declarations`, then members — reorder so the release comes **before** the members delete.)

- [ ] **Step 5: Run the suites**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/bot exec vitest run test/dormancy-store.test.ts test/dormancy-index-drift.test.ts test/roster-lifecycle.test.ts test/rebind-dormancy.test.ts`
Expected: PASS. If the drift test reports `events_raise_lookup_idx` absent from the plan, the correlated column changed name — check `declarations.poleKey` is what the subquery compares, not a joined alias drizzle renamed.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/dormancy-store.ts apps/bot/src/roster-store.ts apps/bot/test
git commit -m "feat(bot): the dormancy clock reads declarations and counts only roster raises; disband releases"
```

---

### Task 8: Rebind moves the declaration

**Files:**
- Modify: `apps/bot/src/rebind-store.ts` (`factionFor`, `qualifyingRaises`, `rebind`)
- Modify: `apps/bot/src/rebind-commands.ts` (new outcome text)
- Test: `apps/bot/test/rebind-store.test.ts`, `apps/bot/test/rebind-commands.test.ts`

**Interfaces:**
- `rebind` returns `"ok" | "refused" | "too-close"` instead of boolean. `RebindTarget.poleKey` becomes `string | null`.

- [ ] **Step 1: Add failing tests to `rebind-store.test.ts`**

```ts
  it("moves the declaration and gives the old pole its 3-day grace", async () => {
    // seed faction at P1 (declaration + poles row), member raise at P2 ≥ 200 m away
    const out = await store.rebind({ …args for P2… });
    expect(out).toBe("ok");
    expect(await declarationForFaction(db, factionId)).toMatchObject({ poleKey: P2 });
    const [old] = await db.select().from(poles).where(eq(poles.poleKey, P1));
    expect(old!.graceUntil.getTime()).toBe(at.getTime() + RELEASED_POLE_GRACE_MS);
  });

  it("refuses a target within 200 m of another declaration", async () => {
    // a second solo declaration 150 m from P2
    expect(await store.rebind({ …P2… })).toBe("too-close");
    expect(await declarationForFaction(db, factionId)).toMatchObject({ poleKey: P1 });
  });
```

Use the file's existing seeding helpers for the faction, events and member; add `poles` rows for P1 and P2 with `graceUntil: now`.

- [ ] **Step 2: Rewrite the store**

`factionFor`: left-join `declarations` and select `poleKey: declarations.poleKey` (nullable).

`qualifyingRaises`: replace the last `not exists` over `factions` with:

```ts
      sql`not exists (select 1 from ${declarations} d
                      where d.server_id = ${faction.serverId}
                        and d.pole_key = ${events.payload}->>'poleKey')`,
```

and the "never the pole it already holds" predicate becomes conditional: `faction.poleKey === null ? sql\`true\` : sql\`${events.payload}->>'poleKey' <> ${faction.poleKey}\``.

`rebind`:

```ts
  async rebind(a: RebindArgs): Promise<"ok" | "refused" | "too-close"> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select({ status: factions.status }).from(factions).where(eq(factions.id, a.factionId));

      // The guard rides the factions update (lock order: factions first).
      const [row] = await tx.update(factions)
        .set({ status: "active", dormantSince: null, reboundAt: a.at })
        .where(and(
          eq(factions.id, a.factionId),
          leaderIs(a.factionId, a.leaderDiscordId),
          inArray(factions.status, REBINDABLE),
          or(isNull(factions.reboundAt), lte(factions.reboundAt, a.notBefore)),
          // Optimistic concurrency, now against the declaration the candidates were built from.
          sql`exists (select 1 from ${declarations} d where d.owner_faction_id = ${factions.id} and d.pole_key = ${a.expectedPoleKey})`,
        ))
        .returning({ id: factions.id, serverId: factions.serverId, name: factions.name, tag: factions.tag, texture: factions.texture });
      if (!row) return "refused";

      // Release, then declare. ⚠️ Release first, or the clan's own old row
      // trips declarations_faction_uniq — and the 200 m check must not see the
      // old pole either, since a clan may move 150 m down the road.
      await releaseTx(tx, { factionId: a.factionId }, a.at);
      const declared = await declareTx(tx, {
        serverId: row.serverId, poleKey: a.poleKey, x: a.x, y: a.y, z: a.z,
        owner: { factionId: a.factionId }, evidence: { eventId: a.evidenceEventId }, at: a.at,
      });
      if (!declared.ok) throw new RebindAbort(declared.reason === "too-close" ? "too-close" : "refused");

      // … the two appendFactionEventTx calls, unchanged …
      return "ok";
    }).catch((err) => {
      if (err instanceof RebindAbort) return err.outcome;
      throw err;
    });
  }
```

`RebindArgs` gains `evidenceEventId: number` — `qualifyingRaises` must select `eventId: events.id` and `selectCandidates` carry it through (`QualifyingRaise` in `rebind.ts` gains `eventId: number`). Add `class RebindAbort extends Error { constructor(readonly outcome: "refused" | "too-close") { super(outcome); } }`.

- [ ] **Step 3: The command's copy**

In `handleRebindConfirm`, where `false` produced the refusal reply, switch on the string; for `"too-close"`:

```ts
  if (out === "too-close") {
    return reply(`That pole is too close to another declared base — bases must be ${MIN_BASE_SPACING_M} m apart. Your base has not moved.`);
  }
```

- [ ] **Step 4: Run the suites**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/bot exec vitest run test/rebind-store.test.ts test/rebind-commands.test.ts test/rebind.test.ts test/rebind-discord.test.ts test/rebind-dormancy.test.ts`
Expected: PASS. Existing tests asserting `rebind` returned `true`/`false` change to `"ok"`/`"refused"`.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/rebind-store.ts apps/bot/src/rebind.ts apps/bot/src/rebind-commands.ts apps/bot/test
git commit -m "feat(bot): rebind moves the declaration, 200 m checked, old pole gets its grace"
```

---

### Task 9: Every remaining reader, and the test seed helper

**Files:**
- Create: `apps/bot/test/seed.ts`
- Modify: `apps/ingest-worker/src/supply-tick.ts:44-61`
- Modify: `apps/bot/src/roster-store.ts:270-300` (`factionCard`)
- Modify: `apps/bot/src/roster-commands.ts:458`
- Modify: every test file listed by `grep -rl "poleKey" apps/bot/test apps/ingest-worker/test` that seeds `factions` with `poleKey`/`x`/`y`/`z`.

- [ ] **Step 1: The seed helper**

```ts
// apps/bot/test/seed.ts
import { factions, declarations, poles, events, admFiles, type Database } from "@factions/db";
import { NEW_POLE_GRACE_MS } from "@factions/domain";

export type SeedFactionArgs = {
  serverId: number; tag: string; texture: string; status?: string;
  poleKey?: string; x?: number; y?: number; z?: number;
  leaderDiscordId?: string; createdAt: Date; activatedAt?: Date | null; dormantSince?: Date | null;
  reservedUntil?: Date | null; ceremonyId?: number | null; renamedAt?: Date | null; reboundAt?: Date | null;
};

/**
 * Insert a faction AND its declaration, the way the schema now requires.
 * Evidence is a synthetic flag.raised event at the pole, so every seeded
 * faction is one the log could have produced.
 */
export async function seedFaction(db: Database, a: SeedFactionArgs) {
  const poleKey = a.poleKey ?? "1:2:3";
  const [x, y, z] = [a.x ?? 1, a.y ?? 2, a.z ?? 3];
  const [f] = await db.insert(factions).values({
    serverId: a.serverId, name: a.tag, tag: a.tag, texture: a.texture,
    status: a.status ?? "active", leaderDiscordId: a.leaderDiscordId ?? "d1",
    createdAt: a.createdAt, activatedAt: a.activatedAt ?? null, dormantSince: a.dormantSince ?? null,
    reservedUntil: a.reservedUntil ?? null, ceremonyId: a.ceremonyId ?? null,
    renamedAt: a.renamedAt ?? null, reboundAt: a.reboundAt ?? null,
  }).returning();
  const [adm] = await db.insert(admFiles).values({
    serverId: a.serverId, filename: `seed-${f!.id}.ADM`, bootAt: a.createdAt, linesIngested: 0, complete: true,
  }).returning();
  const [ev] = await db.insert(events).values({
    serverId: a.serverId, admFileId: adm!.id, lineIndex: 0, type: "flag.raised", occurredAt: a.createdAt,
    payload: { dayzId: "SEED", gamertag: "seed", texture: a.texture, poleKey, pole: { x, y, z } },
  }).returning();
  await db.insert(poles).values({
    serverId: a.serverId, map: "livonia", poleKey, x: x.toFixed(2), y: y.toFixed(2), z: z.toFixed(2),
    currentTexture: a.texture, flagRaised: true, firstSeenAt: a.createdAt, lastSeenAt: a.createdAt,
    graceUntil: new Date(a.createdAt.getTime() + NEW_POLE_GRACE_MS),
  }).onConflictDoNothing();
  await db.insert(declarations).values({
    serverId: a.serverId, poleKey, x: x.toFixed(2), y: y.toFixed(2), z: z.toFixed(2),
    ownerFactionId: f!.id, evidenceEventId: ev!.id, declaredAt: a.createdAt,
  });
  return f!;
}
```

⚠️ Seeded poles must be ≥ 200 m apart and ≥ 200 m from the Hub at (100, 93). The old default `1:2:3` is 130 m from the Hub — but the seed helper bypasses `declareTx`, so the constraint that bites is only `declarations_pole_uniq`. Tests that seed two factions must give them distinct pole keys (they already must, for the old pole index).

- [ ] **Step 2: Replace every inline faction seed**

For each file the grep lists: replace its local `seedFaction` (or inline `db.insert(factions).values({… poleKey …})`) with `seedFaction(db, {...})` from `./seed.js`, and add `declarations, poles` to its `truncate` list. `truncate … factions …` with `cascade` already clears `declarations` through the FK, but name it anyway so the intent is visible. Mechanical; one commit per five files is fine.

`apps/ingest-worker/test/supply-tick.test.ts` and `supply-drift.test.ts` seed factions too: give the worker its own copy of the helper at `apps/ingest-worker/test/seed.ts` (same code — the spec forbids a shared test package for two files).

- [ ] **Step 3: `supply-tick.ts`**

```ts
  const rows = await db.select({
    tag: factions.tag, texture: factions.texture,
    x: declarations.x, y: declarations.y, z: declarations.z,
  }).from(factions)
    .innerJoin(declarations, eq(declarations.ownerFactionId, factions.id))
    .where(and(
      eq(factions.serverId, deps.serverId),
      inArray(factions.status, [...SUPPLIED_STATUSES]),
    ))
    .orderBy(asc(factions.tag));
```

INNER join on purpose: a supplied clan with no declaration (post-wipe) has nowhere for a kit to land, and the projection must not invent a place.

- [ ] **Step 4: `factionCard` and the `/faction info` line**

`factionCard`: add `.leftJoin(declarations, eq(declarations.ownerFactionId, factions.id))`, select `poleKey: declarations.poleKey`, add `declarations.poleKey` to `groupBy`. `FactionCard.poleKey` becomes `string | null`. In `roster-commands.ts:458`: `` ...(isMember && card.poleKey ? [`Pole: ${card.poleKey}`] : []) ``.

- [ ] **Step 5: The full gate**

Run: `TEST_DATABASE_FRESH=1 TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`
Expected: every task passes. Count them. Anything still selecting `factions.poleKey` fails typecheck here and is fixed the same way as above.

- [ ] **Step 6: Commit**

```bash
git add -A apps packages
git commit -m "refactor: every reader of the pole binding joins declarations; test seeds declare"
```

---

### Task 10: Solo declare and lapse

**Files:**
- Modify: `apps/bot/src/declaration-store.ts` (add `raisedPolesFor`, `declareSolo`, `soloClocks`, `lapseSolos`)
- Modify: `apps/bot/src/dormancy-tick.ts` (call `lapseSolos`)
- Test: `apps/bot/test/solo-declaration.test.ts`

No site page yet (increment 2) and no DM (increment 3's notices queue); this task is the store and the clock. `lapseSolos` returns the lapsed declarants so increment 3 can DM them.

**Interfaces:**
- `raisedPolesFor(db, serverId, dayzId)` → `{ poleKey, x, y, z, eventId, occurredAt }[]` newest first, one per pole — what the site will offer.
- `declareSolo(db, { serverId, dayzId, poleKey, at })` → `DeclareOutcome | { ok: false; reason: "no-raise" | "in-clan" }`.
- `lapseSolos(db, serverId, now)` → `{ dayzId, poleKey }[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/bot/test/solo-declaration.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, factions, factionMembers, events, admFiles, poles, type Database } from "@factions/db";
import { SOLO_LAPSE_MS, RELEASED_POLE_GRACE_MS } from "@factions/domain";
import { sql, eq } from "drizzle-orm";
import { raisedPolesFor, declareSolo, lapseSolos, declarationForPlayer } from "../src/declaration-store.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-04T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const P = "5000.00:100.00:5000.00";

describe("solo declarations", () => {
  let db: Database; let serverId = 0; let admFileId = 0; let line = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table declarations, poles, faction_members, factions, events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    admFileId = a!.id; line = 0;
    await db.insert(poles).values({ serverId, map: "livonia", poleKey: P, x: "5000.00", y: "100.00", z: "5000.00", currentTexture: "Flag_White", flagRaised: true, firstSeenAt: now, lastSeenAt: now, graceUntil: now });
  });

  const raise = (dayzId: string, at: Date, poleKey = P) => db.insert(events).values({
    serverId, admFileId, lineIndex: line++, type: "flag.raised", occurredAt: at,
    payload: { dayzId, gamertag: "G", texture: "Flag_White", poleKey, pole: { x: 5000, y: 100, z: 5000 } },
  });

  it("offers only poles the player has raised at, newest first, one per pole", async () => {
    await raise("A", ago(2000)); await raise("A", ago(1000)); await raise("B", ago(500));
    const offered = await raisedPolesFor(db, serverId, "A");
    expect(offered).toHaveLength(1);
    expect(offered[0]!.occurredAt.getTime()).toBe(ago(1000).getTime());
  });

  it("declares, citing the newest raise as evidence", async () => {
    await raise("A", ago(1000));
    expect(await declareSolo(db, { serverId, dayzId: "A", poleKey: P, at: now })).toEqual({ ok: true, id: expect.any(Number) });
    expect(await declarationForPlayer(db, serverId, "A")).toMatchObject({ poleKey: P });
  });

  it("refuses a pole the player never raised at", async () => {
    expect(await declareSolo(db, { serverId, dayzId: "A", poleKey: P, at: now })).toEqual({ ok: false, reason: "no-raise" });
  });

  it("refuses a player who is in a clan — their declaration is the clan's", async () => {
    const [f] = await db.insert(factions).values({ serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", leaderDiscordId: "d1", createdAt: now }).returning();
    await db.insert(factionMembers).values({ factionId: f!.id, serverId, dayzId: "A", discordId: "d1", role: "leader", joinedAt: now });
    await raise("A", ago(1000));
    expect(await declareSolo(db, { serverId, dayzId: "A", poleKey: P, at: now })).toEqual({ ok: false, reason: "in-clan" });
  });

  it("lapses after 7 days without the declarant's raise, and only theirs", async () => {
    await raise("A", ago(SOLO_LAPSE_MS + 1));
    await declareSolo(db, { serverId, dayzId: "A", poleKey: P, at: ago(SOLO_LAPSE_MS + 1) });
    await raise("STRANGER", ago(1000));
    expect(await lapseSolos(db, serverId, now)).toEqual([{ dayzId: "A", poleKey: P }]);
    expect(await declarationForPlayer(db, serverId, "A")).toBeNull();
    const [p] = await db.select().from(poles).where(eq(poles.poleKey, P));
    expect(p!.graceUntil.getTime()).toBe(now.getTime() + RELEASED_POLE_GRACE_MS);
  });

  it("does not lapse a declarant who raised inside the window", async () => {
    await raise("A", ago(SOLO_LAPSE_MS + 1));
    await declareSolo(db, { serverId, dayzId: "A", poleKey: P, at: ago(SOLO_LAPSE_MS + 1) });
    await raise("A", ago(1000));
    expect(await lapseSolos(db, serverId, now)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/bot exec vitest run test/solo-declaration.test.ts`
Expected: FAIL — `raisedPolesFor` not exported.

- [ ] **Step 3: Add the functions to `declaration-store.ts`**

```ts
import { factionMembers, events } from "@factions/db";
import { SOLO_LAPSE_MS } from "@factions/domain";
import { desc, gte } from "drizzle-orm";

export type RaisedPole = { poleKey: string; x: number; y: number; z: number; eventId: number; occurredAt: Date };

/** Poles the log has seen this player raise a flag at — the only ones a solo may declare (spec §5.2). */
export async function raisedPolesFor(db: Database, serverId: number, dayzId: string): Promise<RaisedPole[]> {
  const rows = await db.select({
    poleKey: sql<string>`${events.payload}->>'poleKey'`,
    x: sql<string>`${events.payload}->'pole'->>'x'`,
    y: sql<string>`${events.payload}->'pole'->>'y'`,
    z: sql<string>`${events.payload}->'pole'->>'z'`,
    eventId: events.id, occurredAt: events.occurredAt,
  }).from(events).where(and(
    eq(events.serverId, serverId), eq(events.type, "flag.raised"),
    sql`${events.payload}->>'dayzId' = ${dayzId}`,
  )).orderBy(desc(events.occurredAt), desc(events.id));
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.poleKey) ? false : (seen.add(r.poleKey), true)))
    .map((r) => ({ poleKey: r.poleKey, x: Number(r.x), y: Number(r.y), z: Number(r.z), eventId: r.eventId, occurredAt: r.occurredAt }));
}

export async function declareSolo(db: Database, a: { serverId: number; dayzId: string; poleKey: string; at: Date }):
  Promise<DeclareOutcome | { ok: false; reason: "no-raise" | "in-clan" }> {
  return db.transaction(async (tx) => {
    // Rule 3: in a clan, your declaration is the clan's. Checked inside the
    // transaction so an accept landing at the same instant cannot slip past.
    const [member] = await tx.select({ id: factionMembers.id }).from(factionMembers)
      .where(and(eq(factionMembers.serverId, a.serverId), eq(factionMembers.dayzId, a.dayzId)));
    if (member) return { ok: false as const, reason: "in-clan" as const };
    const raise = (await raisedPolesFor(tx as unknown as Database, a.serverId, a.dayzId)).find((r) => r.poleKey === a.poleKey);
    if (!raise) return { ok: false as const, reason: "no-raise" as const };
    return declareTx(tx, {
      serverId: a.serverId, poleKey: a.poleKey, x: raise.x, y: raise.y, z: raise.z,
      owner: { dayzId: a.dayzId }, evidence: { eventId: raise.eventId }, at: a.at,
    });
  });
}

/**
 * Rule 4 for solos: no raise by the declarant at the pole for SOLO_LAPSE_MS
 * releases the declaration on the spot (guide ch. 4). Returns who lapsed so
 * the caller can tell them — increment 3 queues the DM.
 */
export async function lapseSolos(db: Database, serverId: number, now: Date): Promise<{ dayzId: string; poleKey: string }[]> {
  const cutoff = new Date(now.getTime() - SOLO_LAPSE_MS);
  const stale = await db.select({ dayzId: declarations.ownerDayzId, poleKey: declarations.poleKey })
    .from(declarations)
    .where(and(
      eq(declarations.serverId, serverId),
      isNotNull(declarations.ownerDayzId),
      sql`not exists (
        select 1 from events e
        where e.type = 'flag.raised' and e.server_id = ${declarations.serverId}
          and e.payload->>'poleKey' = ${declarations.poleKey}
          and e.payload->>'dayzId' = ${declarations.ownerDayzId}
          and e.occurred_at > ${cutoff}
      )`,
    ));
  const lapsed: { dayzId: string; poleKey: string }[] = [];
  for (const s of stale) {
    const done = await db.transaction((tx) => releaseTx(tx, { dayzId: s.dayzId!, serverId }, now));
    if (done) lapsed.push({ dayzId: s.dayzId!, poleKey: s.poleKey });
  }
  return lapsed;
}
```

Add `isNotNull` to the drizzle import. ⚠️ `lapseSolos` reads `events` by `(server_id, poleKey, dayzId, occurred_at)`; `events_raise_lookup_idx` covers `(server_id, poleKey, texture, occurred_at)`, so this is a partial index walk plus a filter on `dayzId` — acceptable for a handful of solos per tick. Note it in the docblock.

- [ ] **Step 4: Call it from the dormancy tick**

In `dormancy-tick.ts`, `dormancyTick` takes `store` only; add an optional `opts.lapseSolos?: (now: Date) => Promise<{ dayzId: string; poleKey: string }[]>` and, at the end of the tick, `out.soloLapsed = opts.lapseSolos ? (await opts.lapseSolos(now)).length : 0`. In `discord.ts` where `dormancyTick` is called, pass:

```ts
        lapseSolos: async (now) => {
          const all: { dayzId: string; poleKey: string }[] = [];
          for (const s of await db.select({ id: servers.id }).from(servers).where(eq(servers.active, true))) {
            all.push(...await lapseSolos(db, s.id, now));
          }
          for (const l of all) console.log(`solo declaration lapsed: ${l.dayzId} at ${l.poleKey}`);
          return all;
        },
```

Add `soloLapsed: number` to `DormancyTickResult` with default `0`.

- [ ] **Step 5: Run the suites, then the gate**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/bot exec vitest run test/solo-declaration.test.ts test/dormancy-tick.test.ts`
Expected: PASS. Then the full gate; count the tasks.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/declaration-store.ts apps/bot/src/dormancy-tick.ts apps/bot/src/discord.ts apps/bot/test/solo-declaration.test.ts apps/bot/test/dormancy-tick.test.ts
git commit -m "feat(bot): solo declare from a raise the log holds; lapse after 7 quiet days"
```

---

### Task 11: The smoke test's structural half, and the write-boundary assertion

**Files:**
- Modify: `apps/web/test/smoke.test.ts`

The site does not import `@factions/db` yet and this increment adds no web code. What it adds is the **database** guard; record it where the capability test will grow:

- [ ] **Step 1: Add one test**

```ts
  it("⚠️ declarations cannot be written without evidence — the guard the capability rule will lean on", async () => {
    // Pinned here, in the web app's own suite, because this is the constraint
    // that makes "the site can never bind a pole from nothing" a property of
    // the database rather than of the export list. See spec §4.1 and §14.
    const sql = readFileSync(resolve(here, "../../../packages/db/migrations/0020_declarations.sql"), "utf8");
    expect(sql).toContain('CONSTRAINT "declarations_one_evidence"');
  });
```

(`here` and `readFileSync` are already in scope in that file's `ROOTS` scan; reuse them.)

- [ ] **Step 2: Run and commit**

Run: `pnpm --filter @factions/web test`
Expected: PASS.

```bash
git add apps/web/test/smoke.test.ts
git commit -m "test(web): pin the evidence constraint the capability rule depends on"
```

---

### Task 12: Runbook, acceptance query, CLAUDE.md

**Files:**
- Create: `docs/deploy/2026-09-xx-declarations.md` (date it on the day)
- Modify: `CLAUDE.md`

- [ ] **Step 1: Write the runbook**

```markdown
# Declarations — deploy runbook

Migration 0020 drops `factions.pole_key/x/y/z` and creates `declarations`. The running bot
selects those columns on every tick, so:

1. `sudo systemctl stop clan-wars-bot`; confirm with `systemctl status clan-wars-bot`.
2. Precheck, read-only:
       select id, tag, status, ceremony_id from factions where status in ('reserved','active','dormant') and ceremony_id is null;
   Any row here has no ceremony to cite and the migration will refuse. On this deployment
   there are none (factions_live holds zero factions). If one ever appears, point it at the
   ceremony that founded it and let the migration do the move:
       update factions f set ceremony_id = c.id from ceremonies c
        where f.id = <id> and c.server_id = f.server_id and c.pole_key = f.pole_key and c.status = 'claimed';
   Re-run the precheck; it must return zero rows before step 3.
3. Apply 0020 with the one-off runner from `docs/deploy/2026-09-02-dormancy.md`. Read the
   SQL first.
4. Launch grace — every pole the log has ever seen gets 7 days from today:
       update poles set grace_until = now() + interval '7 days';
   ⚠️ `poles` may be EMPTY on this host: the projector never ran here. That is fine — the
   bot's new pole projection fills it from `events` on its first tick, stamping
   first-sighting + 7 days, which for a pole first seen weeks ago is already in the past.
   So run step 5, wait one tick, then run the update above. Order matters.
5. Start the bot: `sudo systemctl start clan-wars-bot`. Watch `journalctl -u clan-wars-bot -f`
   for `pole projection: N poles`.
6. Re-run step 4's update, then the acceptance query:
       select count(*) filter (where grace_until > now()) as in_grace, count(*) as total from poles;
   `in_grace` must equal `total`.
7. Dormancy acceptance, rewritten for the join (replaces the query in CLAUDE.md):
       select f.tag, f.status, f.dormant_since,
              now() - coalesce((select max(e.occurred_at) from events e
                where e.type='flag.raised' and e.server_id=f.server_id
                  and e.payload->>'poleKey'=d.pole_key
                  and e.payload->>'texture'=f.texture
                  and e.payload->>'dayzId' in (select dayz_id from faction_members where faction_id=f.id)),
                f.activated_at, f.created_at) as age
       from factions f left join declarations d on d.owner_faction_id = f.id
       where f.status in ('active','dormant');
   Read it together with `select count(*) from factions` — zero rows means two things.
```

- [ ] **Step 2: CLAUDE.md**

- Replace the dormancy acceptance query with step 7's.
- Under invariants, replace the `HOLDING_STATUSES` bullet's "three partial unique indexes" with "two partial unique indexes plus the existence of a `declarations` row".
- Replace the lock-order bullet's first line with spec §4.12's order up to `faction_events`.
- Add a bullet: "**`declarations` is written by `declareTx` and nothing else.** The 200 m rule is a query under a lock inside it, not an index; a second writer is a race."
- Add a bullet: "**`poles` is filled by the bot's `pole-tick.ts`**, not by `apps/projector`, which does not run here. `grace_until` comes from it."
- In Current state, add: "Declarations (increment 1 of the target-state spec) are in the code and migrated in. Solo declare has a store and a lapse clock but no page and no DM yet (increments 2 and 3)."

- [ ] **Step 3: Commit**

```bash
git add docs/deploy CLAUDE.md
git commit -m "docs: declarations runbook and the rewritten acceptance query"
```

---

## Self-review

- **Spec coverage.** §4.1 table, constraints, indexes, 200 m under lock (Tasks 2, 4). §4.2 `grace_until`, publication as a read, texture-agnostic test (Tasks 3, 4). §4.3 pole columns dropped (Task 2). §4.12 order respected in every transaction (Tasks 5–8; the rebind release-before-declare note). §5.1 roster attribution (Task 7). §5.2 releases on lapse, disband, rebind, solo lapse; solo declare from a raise; ceremony eligibility with the participant clause (Tasks 6, 7, 8, 10). §13 drift tests: holding indexes (Task 2), raise-lookup index after the join (Task 7), evidence constraint (Task 11). §15 launch-grace runbook (Task 12). **Deferred by design:** the solo-lapse DM (needs increment 3's queue) and the post-wipe first-raise bind (increment 4); both are named in the spec's build order. **Not covered here, and correctly:** "solo joins a clan releases" and "unlink releases" — both are roster writes that land with `packages/roster` in increment 2; note them in that plan.
- **Placeholders.** Task 6 Step 1 and Task 8 Step 1 say "copy the seeding from the neighbouring case" and mark elided lines with `…`; those tests exist in the repo and the executor has them open. Nothing else is elided.
- **Type consistency.** `declareTx`/`releaseTx`/`DeclareOutcome`/`Tx` are defined in Task 4 with the shapes Tasks 5, 6, 7, 8, 10 use. `RebindArgs.evidenceEventId` and `QualifyingRaise.eventId` are both introduced in Task 8. `seedFaction` in Task 9 accepts every field the old inline seeds passed. `clockQuery` is defined in Task 7 and used by the drift test in the same task.
