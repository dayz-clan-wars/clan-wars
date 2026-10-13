# Clan Rebrand (Flag Change) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A clan leader can change the clan's flag as part of rename ("Rebrand"). The new flag is pending until a full member raises it at the home pole, and members' past raise stats survive the change.

**Architecture:** Two new tables. `flag_holds` holds pending and released flags. `faction_textures` records which flag a clan flew when. `packages/roster/src/internal/flag-holds.ts` owns every rule: the free pool, start, cancel, complete and sweep. `rename` calls start. `raise-tick` calls complete. A new bot `flag-hold-tick` calls sweep. The supply kit reads the pending flag, and the stats query reads `faction_textures`.

**Tech Stack:** TypeScript, pnpm + turbo, drizzle-orm over postgres.js, vitest, discord.js, Next.js (apps/web).

**Spec:** `docs/superpowers/specs/2026-10-13-clan-rebrand-flag-design.md`

**Spec amendments made by this plan** (fold them into the spec in Task 11):
1. `flag_holds` gains `stamps_cooldown boolean not null`. A flag-only change stamps `renamed_at` at completion, and the completing raise needs to know which kind of change it was finishing.
2. A `pending` hold counts as held **until the sweep deletes it**, even past `until`. A `released` hold counts as held while `until > now`. Without this, another clan could claim a flag in the window where the sweep is still waiting for the log to catch up, which is exactly the window the sweep's guard protects.
3. `faction_textures`' first row per clan is written by an `AFTER INSERT` trigger on `factions`, with `from_at = '-infinity'`, not by `reserve`. Every insert path then gets one, including the test seeds, which insert into `factions` directly. `'-infinity'` keeps `upkeepRaiseCount` exactly as it is today for a clan that never rebrands, because its membership span still bounds the window.
4. The feed kind is `flag_changed`, the same name as the clan notice kind.

## Global Constraints

- Every guide number lives in `packages/domain/src/rules.ts` and reaches the guide through `guide-numbers.ts`. New: `FLAG_CHANGE_WINDOW_MS = 24 * HOUR`, `OLD_FLAG_HOLD_MS = 3 * DAY`.
- Lock order (CLAUDE.md §4.12): `factions` → `flag_holds` → `faction_textures` → … → `faction_events` → `war_log_events` → `clan_notices`. `faction_events` and the notice queues are always last.
- `apps/web` source may not contain the substring "faction" in any identifier (`apps/web/test/copy-vocabulary.test.ts`). `packages/roster` maps names at its boundary.
- `packages/roster` src uses extensionless relative imports (`apps/web` transpiles it).
- Player-facing copy: plain voice, never discourage raiding, punctuation per `brand/02-verbal-identity.md` (em dashes allowed).
- No coordinates in any `faction_events` or `clan_notices` payload.
- Comments explain WHY; `⚠️` marks load-bearing lines whose failure is silent. Match the density of the file being edited.
- Tests run against the local test Postgres on **5440** (per memory: 5434 is currently held by another container). Start a throwaway one once:
  `docker run -d --name cw-test-pg -e POSTGRES_USER=factions -e POSTGRES_PASSWORD=factions -e POSTGRES_DB=factions -p 5440:5432 postgres:16`
  then `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5440/factions"` in every shell that runs tests.
- Never run two vitest/turbo invocations at once (they share `factions_test_<package>`).
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work on branch `feat/clan-rebrand-flag` (already created, spec committed).

## Review Focus

1. **A completing raise and a cancel arrive at the same instant.** Cancel takes the `factions` row FOR UPDATE before deleting the hold, so the two serialise. Pinned in Task 4.
2. **Flag-only Rebrand during the 30-day cooldown.** It must be refused with `cooldown` even though no `factions` column changes. Pinned in Task 4.
3. **A founder picking a flag that is pending for another clan's rebrand.** Refused with `flag-taken`, and the flag never appears in the claim form's free list. Pinned in Task 3.
4. **A rebrand completed during a siege.** The same raise must count as the defense. Pinned in Task 5.
5. **The bot was down past the deadline, and a raise from before the deadline is still unfolded.** The sweep must not lapse the change first. Pinned in Task 6.

---

### Task 1: Schema, migration, domain constants, feed kind

**Files:**
- Modify: `packages/domain/src/rules.ts` (Founding block, after `ACTIVATION_WINDOW_MS`)
- Modify: `packages/domain/src/feed.ts:10-12` (`FACTION_EVENT_KINDS`)
- Modify: `packages/db/src/schema.ts` (new tables after `factions`; `faction_events_kind_valid` at ~line 764)
- Create: `packages/db/migrations/0066_*.sql` (generated, then hand-appended)
- Modify: `packages/roster/src/internal/feed-store.ts` (`FeedPayload.previousTexture`)
- Modify: `packages/copy/src/live-feed.ts:169-188` (`ClanFeedPayload`, `clanFeedLine`)
- Modify: `apps/bot/src/feed-embed.ts:30-35` (`COLOR`)
- Modify: `packages/roster/src/live.ts:13,71` (payload allowlist)
- Test: `packages/db/test/flag-holds-schema.test.ts` (new), `packages/db/test/faction-events-schema.test.ts` (existing, runs against new kind list), `apps/bot/test/feed-embed.test.ts`, `packages/roster/test/live.test.ts`

**Interfaces:**
- Produces: `flagHolds`, `factionTextures` drizzle tables exported from `@factions/db`; `FLAG_CHANGE_WINDOW_MS`, `OLD_FLAG_HOLD_MS` from `@factions/domain`; `FactionEventKind` includes `"flag_changed"`; `FeedPayload.previousTexture?: string`.

- [ ] **Step 1: Domain constants and feed kind**

In `packages/domain/src/rules.ts`, after `export const ACTIVATION_WINDOW_MS = 24 * HOUR;`:

```ts
/** A pending flag change lapses if no full member raises the new flag at home within this (spec 2026-10-13 §1). Same length as activation: a restart must fall inside it, since the kit is the only source of the new flag. */
export const FLAG_CHANGE_WINDOW_MS = 24 * HOUR;
/** After a flag change completes, the old flag stays off the pool this long — it is probably still flying at the base. Equal to RELEASED_POLE_GRACE_MS. */
export const OLD_FLAG_HOLD_MS = 3 * DAY;
```

In `packages/domain/src/feed.ts`:

```ts
export const FACTION_EVENT_KINDS = [
  "founded", "activated", "lapsed", "renamed", "rebound", "dormant", "revived", "disbanded", "flag_changed",
] as const;
```

- [ ] **Step 2: Schema tables**

In `packages/db/src/schema.ts`, change the check at ~line 764 to:

```ts
  kindValid: check("faction_events_kind_valid",
    sql`${t.kind} IN ('founded','activated','lapsed','renamed','rebound','dormant','revived','disbanded','flag_changed')`),
```

Directly after the `factions` table definition, add:

```ts
/**
 * Flags held OUTSIDE `factions.texture` (spec 2026-10-13 §2): a rebrand's
 * pending flag, and a completed rebrand's old flag for OLD_FLAG_HOLD_MS.
 *
 * ⚠️ `flag_holds_texture_uniq` is unconditional: a row exists only while its
 * hold is live, and `sweepFlagHoldsDb` deletes it after. A partial index on
 * `until > now()` is impossible (now() is not immutable), and a stale row
 * left behind would block the texture forever — so every reader filters on
 * liveness itself (`liveHold` in packages/roster/src/internal/flag-holds.ts).
 *
 * ⚠️ One flag, one clan, across TWO tables: `factions_holding_texture_uniq`
 * cannot see this one. Writers that take a flag serialise through
 * `lockIdentity` and check both (`flagTakenTx`).
 */
export const flagHolds = pgTable("flag_holds", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  texture: text("texture").notNull(),
  factionId: bigint("faction_id", { mode: "number" }).notNull().references(() => factions.id, { onDelete: "cascade" }),
  kind: text("kind").$type<"pending" | "released">().notNull(),
  until: timestamp("until", { withTimezone: true }).notNull(),
  /** Pending only: true when the rebrand changed the flag alone, so completion (not submission) starts the rename cooldown. */
  stampsCooldown: boolean("stamps_cooldown").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => ({
  kindValid: check("flag_holds_kind_valid", sql`${t.kind} IN ('pending','released')`),
  uniqTexture: uniqueIndex("flag_holds_texture_uniq").on(t.serverId, t.texture),
  onePending: uniqueIndex("flag_holds_one_pending").on(t.factionId).where(sql`${t.kind} = 'pending'`),
}));

/**
 * Which flag a clan flew, when (spec 2026-10-13 §2). Past raises are
 * attributed through this, not `factions.texture`, so a rebrand does not
 * erase members' upkeep raises.
 *
 * ⚠️ The first row is written by the `faction_textures_first` trigger on
 * `factions` INSERT, with from_at = '-infinity' — every insert path gets one,
 * including test seeds. Only a completed rebrand writes here from code.
 */
export const factionTextures = pgTable("faction_textures", {
  factionId: bigint("faction_id", { mode: "number" }).notNull().references(() => factions.id, { onDelete: "cascade" }),
  texture: text("texture").notNull(),
  fromAt: timestamp("from_at", { withTimezone: true }).notNull(),
  /** Null = the clan's current flag. */
  toAt: timestamp("to_at", { withTimezone: true }),
}, (t) => ({
  pk: primaryKey({ columns: [t.factionId, t.fromAt] }),
  oneOpen: uniqueIndex("faction_textures_one_open").on(t.factionId).where(sql`${t.toAt} IS NULL`),
}));
```

Check that `boolean`, `bigint`, `primaryKey` and `uniqueIndex` are already in the file's `drizzle-orm/pg-core` import, and add any that are missing.

- [ ] **Step 3: Generate the migration, then append the trigger and backfill**

Run: `cd packages/db && npx drizzle-kit generate`
Expected: a new `migrations/0066_<random>.sql` with `CREATE TABLE "flag_holds"`, `CREATE TABLE "faction_textures"`, and a DROP/ADD of `faction_events_kind_valid`. Read the generated SQL before going on, and make sure nothing else is in it.

Append to the end of that file:

```sql
--> statement-breakpoint
-- ⚠️ The first faction_textures row comes from this trigger, not from code:
-- every path that inserts a faction (reserve, and every test seed) gets one.
-- from_at '-infinity' keeps upkeep-raise attribution identical to the old
-- `factions.texture` join for a clan that never rebrands.
CREATE OR REPLACE FUNCTION faction_textures_first() RETURNS trigger AS $$
BEGIN
  INSERT INTO faction_textures (faction_id, texture, from_at, to_at)
  VALUES (NEW.id, NEW.texture, '-infinity', NULL);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER faction_textures_first AFTER INSERT ON factions
  FOR EACH ROW EXECUTE FUNCTION faction_textures_first();
--> statement-breakpoint
INSERT INTO faction_textures (faction_id, texture, from_at, to_at)
SELECT id, texture, '-infinity', NULL FROM factions;
```

- [ ] **Step 4: Write the schema test**

Create `packages/db/test/flag-holds-schema.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, factions, flagHolds, factionTextures, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-10-13T12:00:00Z");

describe("flag_holds and faction_textures", () => {
  let db: Database;
  let serverId = 0;
  let bear = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table flag_holds, faction_textures, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(factions).values({ serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", leaderDiscordId: "d1", createdAt: now }).returning();
    bear = f!.id;
  });

  it("inserting a faction opens exactly one faction_textures row from -infinity", async () => {
    const rows = await db.execute(sql`select texture, from_at = '-infinity'::timestamptz as open_ended, to_at from faction_textures where faction_id = ${bear}`) as unknown as { texture: string; open_ended: boolean; to_at: Date | null }[];
    expect(rows).toEqual([{ texture: "Flag_Bear", open_ended: true, to_at: null }]);
  });

  it("one hold per texture per server, whatever its kind", async () => {
    await db.insert(flagHolds).values({ serverId, texture: "Flag_Wolf", factionId: bear, kind: "pending", until: now, createdAt: now });
    await expect(db.insert(flagHolds).values({ serverId, texture: "Flag_Wolf", factionId: bear, kind: "released", until: now, createdAt: now })).rejects.toThrow(/flag_holds_texture_uniq/);
  });

  it("one pending hold per clan", async () => {
    await db.insert(flagHolds).values({ serverId, texture: "Flag_Wolf", factionId: bear, kind: "pending", until: now, createdAt: now });
    await expect(db.insert(flagHolds).values({ serverId, texture: "Flag_Rex", factionId: bear, kind: "pending", until: now, createdAt: now })).rejects.toThrow(/flag_holds_one_pending/);
  });

  it("one open faction_textures row per clan", async () => {
    await expect(db.insert(factionTextures).values({ factionId: bear, texture: "Flag_Wolf", fromAt: now })).rejects.toThrow(/faction_textures_one_open/);
  });

  it("rejects an unknown hold kind", async () => {
    await expect(db.execute(sql`insert into flag_holds (server_id, texture, faction_id, kind, until, created_at) values (${serverId}, 'Flag_Rex', ${bear}, 'forever', now(), now())`)).rejects.toThrow(/flag_holds_kind_valid/);
  });

  it("deleting a faction takes its holds and history with it", async () => {
    await db.insert(flagHolds).values({ serverId, texture: "Flag_Wolf", factionId: bear, kind: "pending", until: now, createdAt: now });
    await db.delete(factions).where(eq(factions.id, bear));
    expect(await db.select().from(flagHolds)).toEqual([]);
    expect(await db.select().from(factionTextures)).toEqual([]);
  });
});
```

- [ ] **Step 5: Run the db tests**

Run: `pnpm --filter @factions/db exec vitest run test/flag-holds-schema.test.ts test/faction-events-schema.test.ts test/migration-plan.test.ts test/migration-state.test.ts`
Expected: PASS. The faction-events schema test iterates `FACTION_EVENT_KINDS`, so it now covers `flag_changed`. If a test db predates this branch, it re-migrates on its own (the migration is new, not edited).

- [ ] **Step 6: Feed rendering for `flag_changed`**

In `packages/roster/src/internal/feed-store.ts`, add to `FeedPayload` after `previousName`:

```ts
  /** `flag_changed` only: the flag flown before. */
  previousTexture?: string;
```

In `packages/copy/src/live-feed.ts`, extend the payload type and the switch:

```ts
export type ClanFeedPayload = { name: string; tag: string; texture: string; actor?: string; previousName?: string; previousTexture?: string; disbandAt?: string };
```

```ts
    case "flag_changed": return ["New colors", ...by(p.actor), ". Now flying ", { bold: [flagLabel(p.texture)] }, p.previousTexture ? ` — formerly ${flagLabel(p.previousTexture)}.` : "."];
```

In `apps/bot/src/feed-embed.ts` `COLOR`, add `flag_changed: BLUE` beside `renamed: BLUE`.

In `packages/roster/src/live.ts`, add `previousTexture?: string` to the `clans` payload type on line 13. Add `"previousTexture"` to the key allowlist on line 71:

```ts
        for (const k of ["actor", "previousName", "previousTexture", "disbandAt"] as const) if (typeof p[k] === "string") out[k] = p[k];
```

- [ ] **Step 7: Feed tests**

In `apps/bot/test/feed-embed.test.ts`, add next to the `renamed` case:

```ts
  it("flag_changed names the new flag and the old one", () => {
    const d = feedEmbed(ev("flag_changed", { texture: "Flag_Wolf", previousTexture: "Flag_Bear", actor: "Racer" })).description!;
    expect(d).toContain("New colors");
    expect(d).toContain("Wolf");
    expect(d).toContain("formerly Bear");
  });
```

(`ev` is the file's existing helper. If its signature doesn't merge `texture`, pass the payload the way the `renamed` case does.)

In `packages/roster/test/live.test.ts`, next to the existing allowlist test at ~line 149, add a `flag_changed` row with `previousTexture: "Flag_Bear"` and a `poleKey`. Assert that `previousTexture` survives and `poleKey` does not.

Run: `pnpm --filter @factions/bot exec vitest run test/feed-embed.test.ts && pnpm --filter @factions/roster exec vitest run test/live.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck the touched packages**

Run: `npx turbo run typecheck --filter=@factions/domain --filter=@factions/db --filter=@factions/copy --filter=@factions/roster --filter=@factions/bot --force`
Expected: no errors. A `Record<FactionEventKind, …>` this plan missed shows up here.

- [ ] **Step 9: Commit**

```bash
git add packages/domain/src/rules.ts packages/domain/src/feed.ts packages/db/src/schema.ts packages/db/migrations packages/db/test/flag-holds-schema.test.ts packages/roster/src/internal/feed-store.ts packages/copy/src/live-feed.ts apps/bot/src/feed-embed.ts packages/roster/src/live.ts apps/bot/test/feed-embed.test.ts packages/roster/test/live.test.ts
git commit -m "Rebrand: flag_holds, faction_textures, flag_changed feed kind

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Notice kinds and both renderers

**Files:**
- Modify: `packages/domain/src/feed.ts` (`CLAN_NOTICE_KINDS`)
- Modify: `apps/bot/src/notice-text.ts` (`RENDERERS`)
- Modify: `apps/web/lib/notice-copy.ts` (`NOTICE_COPY`)
- Test: `apps/bot/test/notice-text.test.ts`, `apps/web/test/notice-copy.test.ts`

**Interfaces:**
- Produces: `ClanNoticeKind` includes `"flag_change_started" | "flag_changed" | "flag_change_lapsed"`. Payloads:
  - `flag_change_started`: `{ texture: string; until: string /* ISO */ }`
  - `flag_changed`: `{ texture: string; previousTexture: string; gamertag: string }`
  - `flag_change_lapsed`: `{ texture: string }`

- [ ] **Step 1: Add the kinds**

In `CLAN_NOTICE_KINDS`, after `"renamed"`, add `"flag_change_started", "flag_changed", "flag_change_lapsed",`.

- [ ] **Step 2: Run the pin tests to see them fail**

Run: `pnpm --filter @factions/bot exec vitest run test/notice-text.test.ts && pnpm --filter @factions/web exec vitest run test/notice-copy.test.ts`
Expected: FAIL. Typecheck errors on the `Record<ClanNoticeKind, …>` maps, and the pin tests report missing renderers.

- [ ] **Step 3: Bot renderers**

In `apps/bot/src/notice-text.ts`, import `FLAG_CHANGE_WINDOW_MS` from `@factions/domain` and `flagLabel` from `@factions/copy`. After `renamed`, add:

```ts
  flag_change_started: (p) => `🏳️ New flag reserved: **${flagLabel(String(p.texture))}**. It's in your kit at the next restart. Raise it at your pole within ${hours(FLAG_CHANGE_WINDOW_MS)} hours, or it goes back to the pool.`,
  flag_changed: (p, ctx) => `🏳️ ${person(p.gamertag, ctx.site)} raised **${flagLabel(String(p.texture))}**. These are our colors now. **${flagLabel(String(p.previousTexture))}** is held for a few days, then goes back to the pool.`,
  flag_change_lapsed: (p) => `🏳️ Nobody raised **${flagLabel(String(p.texture))}** in time, so it went back to the pool. We still fly our old flag.`,
```

(`hours` and `person` are already defined in this file; use them as the neighbouring renderers do.)

- [ ] **Step 4: Web renderers**

In `apps/web/lib/notice-copy.ts`, import `flagLabel` from `@factions/copy`. After `renamed`, add:

```ts
  flag_change_started: { group: "Roster", render: (p) => ({
    kicker: "Rebrand", title: `New flag reserved: ${flagLabel(String(p.texture))}`,
    body: "It arrives in your kit at the next restart. Raise it at your pole to make it yours." }) },
  flag_changed: { group: "Roster", render: (p) => ({
    kicker: "Rebrand", title: `New colors: ${flagLabel(String(p.texture))}`,
    body: `${who(p.gamertag)} raised it. ${flagLabel(String(p.previousTexture))} is held for a few days, then goes back to the pool.` }) },
  flag_change_lapsed: { group: "Roster", render: (p) => ({
    kicker: "Rebrand", title: "The flag change lapsed",
    body: `Nobody raised ${flagLabel(String(p.texture))} in time. It is back in the pool, and the clan keeps its flag.` }) },
```

- [ ] **Step 5: Add wording tests**

In `apps/bot/test/notice-text.test.ts`, follow the file's existing per-kind pattern and add:

```ts
  it("flag change notices name the flag, never a coordinate", () => {
    const started = renderNotice("flag_change_started", { texture: "Flag_Wolf", until: "2026-10-14T12:00:00.000Z" }, CTX);
    expect(started).toContain("**Wolf**");
    expect(started).toContain("24 hours");
    expect(renderNotice("flag_changed", { texture: "Flag_Wolf", previousTexture: "Flag_Bear", gamertag: "Racer" }, CTX)).toContain("**Bear**");
    expect(renderNotice("flag_change_lapsed", { texture: "Flag_Wolf" }, CTX)).toContain("back to the pool");
  });
```

Use whatever the file calls its render entry point and context constant. Read the top of the test file and use those names.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @factions/bot exec vitest run test/notice-text.test.ts && pnpm --filter @factions/web exec vitest run test/notice-copy.test.ts test/copy-vocabulary.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/domain/src/feed.ts apps/bot/src/notice-text.ts apps/web/lib/notice-copy.ts apps/bot/test/notice-text.test.ts
git commit -m "Rebrand: flag change notice kinds, bot and site wording

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Free pool and the founding guard

**Files:**
- Create: `packages/roster/src/internal/flag-holds.ts`
- Modify: `packages/roster/src/internal/faction-store.ts:164-167` (`reserve`)
- Modify: `packages/roster/src/reads.ts:191-199` (`directoryDb`), `:278-283` (`claimContextDb`)
- Modify: `packages/roster/src/internal/index.ts` (or whatever file backs `@factions/roster/internal`; check `package.json` `exports`) to re-export `flag-holds`
- Test: `packages/roster/test/flag-holds.test.ts` (new)

**Interfaces:**
- Produces (from `packages/roster/src/internal/flag-holds.ts`):
  - `type Tx` (the same alias `holds.ts` uses: `import type { Tx } from "@factions/declarations"`)
  - `liveHold(now: Date): SQL`: the liveness predicate over `flag_holds`
  - `flagTakenTx(tx: Tx | Database, serverId: number, texture: string, now: Date): Promise<boolean>`
  - `freeFlagsDb(db: Tx | Database, serverId: number, now: Date): Promise<string[]>`: in `CLAIMABLE_FLAGS` order

- [ ] **Step 1: Write the failing tests**

Create `packages/roster/test/flag-holds.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, flagHolds, factions, ceremonies, ceremonyParticipants, identityLinks, players, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { CLAIMABLE_FLAGS } from "@factions/domain";
import { flagTakenTx, freeFlagsDb } from "../src/internal/flag-holds";
import { seedFaction } from "./seed";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-10-13T12:00:00Z");
const later = (ms: number) => new Date(now.getTime() + ms);

describe("flag holds: the free pool", () => {
  let db: Database;
  let serverId = 0;
  let bear = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table flag_holds, faction_textures, faction_members, declarations, poles, events, adm_files, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    bear = (await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: now, activatedAt: now })).id;
  });

  it("a holding clan's flag is taken", async () => {
    expect(await flagTakenTx(db, serverId, "Flag_Bear", now)).toBe(true);
    expect(await flagTakenTx(db, serverId, "Flag_Wolf", now)).toBe(false);
  });

  it("a pending hold is taken even past its deadline, until the sweep deletes it", async () => {
    await db.insert(flagHolds).values({ serverId, texture: "Flag_Wolf", factionId: bear, kind: "pending", until: now, createdAt: now });
    expect(await flagTakenTx(db, serverId, "Flag_Wolf", later(3_600_000))).toBe(true);
  });

  it("a released hold is taken only until it expires", async () => {
    await db.insert(flagHolds).values({ serverId, texture: "Flag_Rex", factionId: bear, kind: "released", until: later(1000), createdAt: now });
    expect(await flagTakenTx(db, serverId, "Flag_Rex", now)).toBe(true);
    expect(await flagTakenTx(db, serverId, "Flag_Rex", later(1000))).toBe(false);
  });

  it("freeFlagsDb excludes holding clans and live holds, in pool order", async () => {
    await db.insert(flagHolds).values([
      { serverId, texture: "Flag_Wolf", factionId: bear, kind: "pending", until: now, createdAt: now },
      { serverId, texture: "Flag_Rex", factionId: bear, kind: "released", until: now, createdAt: now }, // already expired
    ]);
    const free = await freeFlagsDb(db, serverId, now);
    expect(free).not.toContain("Flag_Bear");
    expect(free).not.toContain("Flag_Wolf");
    expect(free).toContain("Flag_Rex");
    expect(free).toEqual(CLAIMABLE_FLAGS.filter((f) => free.includes(f)));
  });
});
```

Add a `reserve` case to the same file. A pending hold on `Flag_Wolf` must make `PgFactionStore.reserve({... texture: "Flag_Wolf" ...})` return `"flag-taken"`. Build the ceremony fixture by copying the claim setup in `packages/roster/test/writes.test.ts` (search for `claimCeremonyDb`). It needs `ceremonies` + `ceremonyParticipants` rows for linked players, then a call to `claimCeremonyDb(db, now, "d1", ceremonyId, { name: "Wolves", tag: "WOLF", texture: "Flag_Wolf", memberDayzIds: [...] })`. Assert the result is `"flag-taken"`, and that `factions` has no `WOLF` row afterwards.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @factions/roster exec vitest run test/flag-holds.test.ts`
Expected: FAIL: cannot resolve `../src/internal/flag-holds`.

- [ ] **Step 3: Implement the free pool**

Create `packages/roster/src/internal/flag-holds.ts`:

```ts
import type { Tx } from "@factions/declarations";
import type { Database } from "@factions/db";
import { factions, flagHolds } from "@factions/db";
import { CLAIMABLE_FLAGS, HOLDING_STATUSES } from "@factions/domain";
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";

/**
 * Is a `flag_holds` row still holding its flag?
 *
 * ⚠️ `pending` is live until the SWEEP deletes it, not until `until`. The
 * sweep waits for the raise consumer to fold events past the deadline, so a
 * raise logged before the deadline can still complete the change; if the flag
 * were free the instant `until` passed, a founder could take it in that gap
 * and the completing raise would promote a texture another clan now holds.
 * `released` has no such dependency and expires on the clock.
 */
export function liveHold(now: Date): SQL {
  return or(eq(flagHolds.kind, "pending"), sql`${flagHolds.until} > ${now}`)!;
}

/**
 * One flag, one clan, across `factions` AND `flag_holds`. Binding only under
 * `lockIdentity(tx, serverId)`, which every caller that then takes the flag
 * holds — `factions_holding_texture_uniq` and `flag_holds_texture_uniq`
 * each see only their own table.
 */
export async function flagTakenTx(tx: Tx | Database, serverId: number, texture: string, now: Date): Promise<boolean> {
  const [clan] = await tx.select({ id: factions.id }).from(factions)
    .where(and(eq(factions.serverId, serverId), eq(factions.texture, texture), inArray(factions.status, [...HOLDING_STATUSES])));
  if (clan) return true;
  const [hold] = await tx.select({ id: flagHolds.id }).from(flagHolds)
    .where(and(eq(flagHolds.serverId, serverId), eq(flagHolds.texture, texture), liveHold(now)));
  return hold !== undefined;
}

/** The claim form's and the rebrand picker's one list (spec §2 "Free pool"), in pool order. */
export async function freeFlagsDb(db: Tx | Database, serverId: number, now: Date): Promise<string[]> {
  const held = await db.select({ texture: factions.texture }).from(factions)
    .where(and(eq(factions.serverId, serverId), inArray(factions.status, [...HOLDING_STATUSES])));
  const holds = await db.select({ texture: flagHolds.texture }).from(flagHolds)
    .where(and(eq(flagHolds.serverId, serverId), liveHold(now)));
  const taken = new Set([...held, ...holds].map((r) => r.texture));
  return CLAIMABLE_FLAGS.filter((f) => !taken.has(f));
}
```

Re-export it from the `@factions/roster/internal` entry with `export * from "./flag-holds";`.

- [ ] **Step 4: Guard `reserve`**

In `packages/roster/src/internal/faction-store.ts`, import `flagTakenTx` from `./flag-holds`. Right after the `identityTaken` check inside `reserve`'s transaction, add:

```ts
        // ⚠️ A flag can be held outside `factions` — a rival's pending
        // rebrand, or a just-replaced flag on its 3-day hold — and
        // `factions_holding_texture_uniq` cannot see those. Under the
        // identity lock taken above, which every rebrand also takes.
        if (await flagTakenTx(tx, a.serverId, a.texture, a.at)) throw new ReserveAbort("flag-taken");
```

`freeFlagsDb` and `flagTakenTx` filter `factions` by `HOLDING_STATUSES`, which `packages/db/test/holding-index-drift.test.ts` already pins to `factions_holding_texture_uniq`. That covers the spec's drift-test item, so don't add a second statement of the predicate.

Delete the now-unused `textureHeld` from the `FactionStore` interface and from `PgFactionStore`. `grep -rn textureHeld apps packages` finds no callers.

- [ ] **Step 5: Route the two reads through `freeFlagsDb`**

In `packages/roster/src/reads.ts`, replace `directoryDb`'s `holdingRows`/`taken` block and its `flags:` line with:

```ts
  const free = await freeFlagsDb(db, serverId, new Date());
  ...
    flags: { taken: CLAIMABLE_FLAGS.filter((f) => !free.includes(f)), free },
```

In `claimContextDb`, replace the `holdingRows`/`taken` block with `freeFlags: await freeFlagsDb(db, ceremony.serverId, new Date()),`. Import `freeFlagsDb` from `./internal/flag-holds`.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @factions/roster exec vitest run test/flag-holds.test.ts test/writes.test.ts test/reads.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/roster/src/internal/flag-holds.ts packages/roster/src/internal/faction-store.ts packages/roster/src/reads.ts packages/roster/src/internal packages/roster/test/flag-holds.test.ts
git commit -m "Rebrand: one free-flag pool across factions and flag holds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Start and cancel a flag change (rename + cancelRebrand)

**Files:**
- Modify: `packages/roster/src/internal/flag-holds.ts` (add `startFlagChangeTx`, `cancelFlagChangeDb`)
- Modify: `packages/roster/src/internal/roster-store.ts:83-84` (types), `:1009-1075` (`rename`)
- Modify: `packages/roster/src/writes.ts:115-121` (`renameDb`), add `cancelRebrandDb`
- Modify: `packages/roster/src/api.ts` (Roster: `rename` signature, new `cancelRebrand`)
- Modify: `packages/roster/src/index.ts:50-58` (destructure `cancelRebrand`)
- Modify: `packages/roster/src/reads.ts` (`ClanView.rebrand`, filled in `clanForDb`)
- Modify: `packages/roster/test/exports.test.ts`, `apps/web/test/smoke.test.ts` (allowlists)
- Modify: `packages/copy/src/clan.ts` (`RENAME` outcomes, new `REBRAND_CANCEL` table in `TABLES`)
- Test: `packages/roster/test/rebrand.test.ts` (new)

**Interfaces:**
- Consumes: `flagTakenTx`, `freeFlagsDb`, `liveHold` (Task 3); `FLAG_CHANGE_WINDOW_MS` (Task 1); notice kind `flag_change_started` (Task 2).
- Produces:
  - `RenameArgs` gains `texture?: string`.
  - `RenameOutcome = "ok" | "flag-pending" | "not-leader" | "cooldown" | "name-taken" | "tag-taken" | "name-held" | "tag-held" | "unchanged" | "change-pending" | "not-active" | "flag-taken"`. `"ok"` = name/tag only. `"flag-pending"` = a flag change was started (with or without a name/tag change).
  - `renameDb(db, now, actorDiscordId, r: { name: string; tag?: string; texture?: string }): Promise<RenameOutcome | ActorRefusal | "bad-name" | "bad-tag" | "bad-flag">`
  - `type CancelRebrandOutcome = "ok" | "not-leader" | "nothing-pending"`, `cancelRebrandDb(db, actorDiscordId): Promise<CancelRebrandOutcome | ActorRefusal>`
  - Roster `rename(actorDiscordId, r: { name; tag?; texture? })`, `cancelRebrand(actorDiscordId)`.
  - `ClanView.rebrand: { pending: { texture: string; until: Date } | null; freeFlags: string[] } | null`. Non-null for the leader only.
  - `startFlagChangeTx(tx, a: { serverId: number; factionId: number; texture: string; at: Date; stampsCooldown: boolean }): Promise<Date>`: inserts the pending hold and returns its `until`. It writes **no** notice, because the caller queues notices last.

- [ ] **Step 1: Write the failing tests**

Create `packages/roster/test/rebrand.test.ts`. Copy the `beforeEach` from `writes.test.ts` (servers, players, identity links d1/d3, BEAR seeded with `texture: "Flag_Bear"`, leader d1 full, d3 member full), adding `flag_holds, faction_textures, clan_notices` to the truncate list. Then:

```ts
  const holds = () => db.select().from(flagHolds).where(eq(flagHolds.factionId, factionId));
  const bear = async () => (await db.select().from(factions).where(eq(factions.id, factionId)))[0]!;

  it("a flag-only rebrand reserves the flag, changes nothing on the clan, and starts no cooldown", async () => {
    expect(await renameDb(db, now, "d1", { name: "Bears", texture: "Flag_Wolf" })).toBe("flag-pending");
    const [h] = await holds();
    expect(h).toMatchObject({ texture: "Flag_Wolf", kind: "pending", stampsCooldown: true, until: new Date(now.getTime() + FLAG_CHANGE_WINDOW_MS) });
    expect(await bear()).toMatchObject({ texture: "Flag_Bear", renamedAt: null });
    const [n] = await db.select().from(clanNotices).where(eq(clanNotices.kind, "flag_change_started"));
    expect(n!.payload).toMatchObject({ texture: "Flag_Wolf" });
  });

  it("name plus flag renames now, starts the cooldown now, and leaves the flag pending", async () => {
    expect(await renameDb(db, now, "d1", { name: "Wolves", tag: "WOLF", texture: "Flag_Wolf" })).toBe("flag-pending");
    expect(await bear()).toMatchObject({ name: "Wolves", tag: "WOLF", texture: "Flag_Bear", renamedAt: now });
    expect((await holds())[0]).toMatchObject({ stampsCooldown: false });
  });

  it("refuses a second rebrand while one is pending, even a name-only one", async () => {
    await renameDb(db, now, "d1", { name: "Bears", texture: "Flag_Wolf" });
    expect(await renameDb(db, now, "d1", { name: "Grizzlies" })).toBe("change-pending");
  });

  it("refuses a flag-only rebrand during the rename cooldown", async () => {
    await db.update(factions).set({ renamedAt: now }).where(eq(factions.id, factionId));
    expect(await renameDb(db, now, "d1", { name: "Bears", texture: "Flag_Wolf" })).toBe("cooldown");
    expect(await holds()).toEqual([]);
  });

  it("refuses a flag change for a dormant clan, and refuses a taken or unknown flag", async () => {
    await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", poleKey: "6000.00:100.00:6000.00", x: 6000, z: 6000, leaderDiscordId: "dW", createdAt: now, activatedAt: now });
    expect(await renameDb(db, now, "d1", { name: "Bears", texture: "Flag_Wolf" })).toBe("flag-taken");
    expect(await renameDb(db, now, "d1", { name: "Bears", texture: "Flag_White" })).toBe("bad-flag");
    await db.update(factions).set({ status: "dormant", dormantSince: now, dormantReason: "inactive" }).where(eq(factions.id, factionId));
    expect(await renameDb(db, now, "d1", { name: "Bears", texture: "Flag_Rex" })).toBe("not-active");
  });

  it("only the leader can rebrand or cancel", async () => {
    expect(await renameDb(db, now, "d3", { name: "Bears", texture: "Flag_Wolf" })).toBe("not-leader");
    await renameDb(db, now, "d1", { name: "Bears", texture: "Flag_Wolf" });
    expect(await cancelRebrandDb(db, "d3")).toBe("not-leader");
  });

  it("cancel frees the flag at once and costs no cooldown", async () => {
    await renameDb(db, now, "d1", { name: "Bears", texture: "Flag_Wolf" });
    expect(await cancelRebrandDb(db, "d1")).toBe("ok");
    expect(await holds()).toEqual([]);
    expect(await cancelRebrandDb(db, "d1")).toBe("nothing-pending");
    expect(await renameDb(db, now, "d1", { name: "Bears", texture: "Flag_Rex" })).toBe("flag-pending");
  });

  it("an unchanged submission is still unchanged", async () => {
    expect(await renameDb(db, now, "d1", { name: "Bears", texture: "Flag_Bear" })).toBe("unchanged");
  });

  it("the leader's clan view carries the pending flag and the free pool; a member's does not", async () => {
    await renameDb(db, now, "d1", { name: "Bears", texture: "Flag_Wolf" });
    const lead = await clanForDb(db, "d1", now);
    expect(lead).toMatchObject({ rebrand: { pending: { texture: "Flag_Wolf" } } });
    expect((lead as ClanView).rebrand!.freeFlags).not.toContain("Flag_Wolf");
    expect(((await clanForDb(db, "d3", now)) as ClanView).rebrand).toBeNull();
  });
```

Imports: `flagHolds, clanNotices` from `@factions/db`; `FLAG_CHANGE_WINDOW_MS` from `@factions/domain`; `renameDb, cancelRebrandDb` from `../src/writes`; `clanForDb, type ClanView` from `../src/reads`. Check `clanForDb`'s real name and signature in `reads.ts` (it is the function whose body ends at ~line 164 with `return { clan: { ...clan!, base }, me: …`) and use those.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @factions/roster exec vitest run test/rebrand.test.ts`
Expected: FAIL: `cancelRebrandDb` not exported, and type errors on `texture`.

- [ ] **Step 3: `startFlagChangeTx` and `cancelFlagChangeDb`**

Append to `packages/roster/src/internal/flag-holds.ts`, adding an import for `FLAG_CHANGE_WINDOW_MS`:

```ts
/**
 * Reserve the new flag for this clan (spec §1 "Start"). The caller holds the
 * clan's `factions` row FOR UPDATE and `lockIdentity`, and has checked
 * `flagTakenTx` under that lock. Lock order: after `factions`. Returns the
 * deadline; the caller queues the `flag_change_started` notice LAST, after
 * any `renamed` feed row (§4.12: the queues come after every roster table,
 * and this hold IS a roster table).
 *
 * An expired RELEASED row for this texture may still exist if the sweep has
 * not run; it is deleted here first, or `flag_holds_texture_uniq` would
 * refuse a flag `freeFlagsDb` just offered as free.
 */
export async function startFlagChangeTx(tx: Tx, a: { serverId: number; factionId: number; texture: string; at: Date; stampsCooldown: boolean }): Promise<Date> {
  const until = new Date(a.at.getTime() + FLAG_CHANGE_WINDOW_MS);
  await tx.delete(flagHolds).where(and(
    eq(flagHolds.serverId, a.serverId), eq(flagHolds.texture, a.texture), eq(flagHolds.kind, "released"), sql`${flagHolds.until} <= ${a.at}`,
  ));
  await tx.insert(flagHolds).values({
    serverId: a.serverId, texture: a.texture, factionId: a.factionId, kind: "pending", until, stampsCooldown: a.stampsCooldown, createdAt: a.at,
  });
  return until;
}

/**
 * Drop a clan's pending flag (spec §1: "frees the new flag immediately").
 *
 * ⚠️ Takes the clan's `factions` row FOR UPDATE before touching the hold:
 * raise-tick completes a change under that same row lock, so a cancel and a
 * completing raise serialise instead of both acting on one hold.
 */
export async function cancelFlagChangeDb(db: Database, factionId: number): Promise<"ok" | "nothing-pending"> {
  return db.transaction(async (tx) => {
    await tx.select({ id: factions.id }).from(factions).where(eq(factions.id, factionId)).for("update");
    const gone = await tx.delete(flagHolds)
      .where(and(eq(flagHolds.factionId, factionId), eq(flagHolds.kind, "pending")))
      .returning({ id: flagHolds.id });
    return gone.length > 0 ? "ok" : "nothing-pending";
  });
}
```

- [ ] **Step 4: Extend `rename`**

In `roster-store.ts`, update the types:

```ts
export type RenameArgs = { factionId: number; discordId: string; name: string; tag?: string; texture?: string; at: Date; notBefore: Date };
export type RenameOutcome = "ok" | "flag-pending" | "not-leader" | "cooldown" | "name-taken" | "tag-taken" | "name-held" | "tag-held" | "unchanged" | "change-pending" | "not-active" | "flag-taken";
```

Replace the body of `rename`'s transaction callback down to `return "ok" as const;` with the following. The guarded update, `writeHoldsTx`, `appendFactionEventTx` and `noticeClanTx` calls stay as they are, inside the `if (identityChanged)` block. Import `flagHolds` from `@factions/db` and `flagTakenTx, startFlagChangeTx` from `./flag-holds`.

```ts
      const [before] = await tx.select({ name: factions.name, tag: factions.tag, serverId: factions.serverId, texture: factions.texture, status: factions.status })
        .from(factions).where(eq(factions.id, a.factionId)).for("update");
      if (!before) return "not-leader" as const;

      const newTag = a.tag ?? before.tag;
      const identityChanged = before.name !== a.name || before.tag !== newTag;
      const flagChanged = a.texture !== undefined && a.texture !== before.texture;
      if (!identityChanged && !flagChanged) return "unchanged" as const;

      // Spec §1: one change in flight. A name-only rename is refused too, so
      // the leader never has two half-finished rebrands to reason about.
      const [pending] = await tx.select({ id: flagHolds.id }).from(flagHolds)
        .where(and(eq(flagHolds.factionId, a.factionId), eq(flagHolds.kind, "pending")));
      if (pending) return "change-pending" as const;

      // The identity lock (spec §4.4) before any taken/held check — names
      // AND, since the rebrand, flags. Lock order: right after `factions`.
      await lockIdentity(tx, before.serverId);
      if (identityChanged) {
        const taken = await identityTakenTx(tx, { serverId: before.serverId, name: a.name, tag: newTag, exceptFactionId: a.factionId });
        if (taken) return taken;
      }
      if (flagChanged) {
        // A reserved clan has never flown its flag; a dormant one revives first.
        if (before.status !== "active") return "not-active" as const;
        if (await flagTakenTx(tx, before.serverId, a.texture!, a.at)) return "flag-taken" as const;
      }

      // ⚠️ Order (§4.12): every roster-table write first — factions,
      // identity_holds, flag_holds — then the feed row, then notices.
      let updated: { id: number; serverId: number; tag: string; texture: string } | undefined;
      if (identityChanged) {
        // … the existing guarded `tx.update(factions)…returning(…)` into
        //   `updated`, `if (!updated) return null;`, and writeHoldsTx,
        //   unchanged — but NOT yet the "renamed" feed row or notice …
      } else {
        // ⚠️ Flag only: nothing on `factions` changes, but the leader and
        // cooldown guards still apply — the same predicate the update uses.
        // Null falls through to the not-leader/cooldown read below.
        const [ok] = await tx.select({ id: factions.id }).from(factions).where(and(
          eq(factions.id, a.factionId),
          leaderIs(a.factionId, a.discordId),
          or(isNull(factions.renamedAt), lte(factions.renamedAt, a.notBefore)),
        ));
        if (!ok) return null;
      }

      // Spec §1 cooldown: a name/tag change already stamped renamed_at
      // above; a flag-only change stamps it at completion instead, so a
      // lapsed or cancelled one costs nothing.
      const until = flagChanged
        ? await startFlagChangeTx(tx, { serverId: before.serverId, factionId: a.factionId, texture: a.texture!, at: a.at, stampsCooldown: !identityChanged })
        : null;

      if (updated) {
        // … the existing appendFactionEventTx ("renamed") and
        //   noticeClanTx ("renamed") calls, moved here unchanged …
      }
      if (until) {
        await noticeClanTx(tx, {
          serverId: before.serverId, factionId: a.factionId, kind: "flag_change_started", occurredAt: a.at,
          payload: { texture: a.texture!, until: until.toISOString() },
        });
        return "flag-pending" as const;
      }
      return "ok" as const;
```

Update the doc comment above `rename` with one paragraph saying it now also starts a flag change and pointing at the spec.

- [ ] **Step 5: `renameDb`, `cancelRebrandDb`, API surface**

In `packages/roster/src/writes.ts`:

```ts
export async function renameDb(db: Database, now: Date, actorDiscordId: string, r: { name: string; tag?: string; texture?: string }): Promise<RenameOutcome | ActorRefusal | "bad-name" | "bad-tag" | "bad-flag"> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  if (!validName(r.name)) return "bad-name";
  if (r.tag !== undefined && !validTag(r.tag)) return "bad-tag";
  if (r.texture !== undefined && !isClaimableFlag(r.texture)) return "bad-flag";
  return new PgRosterStore(db).rename({ factionId: a.factionId, discordId: actorDiscordId, name: r.name.trim(), tag: r.tag, texture: r.texture, at: now, notBefore: new Date(now.getTime() - RENAME_COOLDOWN_MS) });
}

export type CancelRebrandOutcome = "ok" | "not-leader" | "nothing-pending";
/** Drop the clan's pending flag. Leader only. */
export async function cancelRebrandDb(db: Database, actorDiscordId: string): Promise<CancelRebrandOutcome | ActorRefusal> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  if (a.role !== "leader") return "not-leader";
  return cancelFlagChangeDb(db, a.factionId);
}
```

(`isClaimableFlag` is already imported for `claimCeremonyDb`.)

In `api.ts`, change `rename` to take `r: { name: string; tag?: string; texture?: string }`, and add after it:

```ts
    /** Drop your clan's pending flag change. Leader only. */
    cancelRebrand: (actorDiscordId: string) => cancelRebrandDb(getDb(), actorDiscordId),
```

Export `CancelRebrandOutcome` wherever `RenameOutcome` is exported (`api.ts` lines 21 and 82, `index.ts` line 31). Add `cancelRebrand` to the destructure in `index.ts`. Add `"cancelRebrand"` in sorted position to the export allowlists in `packages/roster/test/exports.test.ts` and `apps/web/test/smoke.test.ts:100`.

- [ ] **Step 6: `ClanView.rebrand`**

In `reads.ts`, add to `ClanView`:

```ts
  /** The leader's rebrand panel: the pending flag change, if any, and the flags they could pick. Null for everyone else. */
  rebrand: { pending: { texture: string; until: Date } | null; freeFlags: string[] } | null;
```

In the clan-view builder, before the `return`:

```ts
  const rebrand = status === "full" && role === "leader" ? await rebrandFor(db, clan!.serverId, m.factionId, now) : null;
```

and put `rebrand` in the returned object. Add a small helper in `reads.ts`:

```ts
async function rebrandFor(db: Database, serverId: number, factionId: number, now: Date): Promise<NonNullable<ClanView["rebrand"]>> {
  const [p] = await db.select({ texture: flagHolds.texture, until: flagHolds.until }).from(flagHolds)
    .where(and(eq(flagHolds.factionId, factionId), eq(flagHolds.kind, "pending")));
  return { pending: p ?? null, freeFlags: await freeFlagsDb(db, serverId, now) };
}
```

If the clan row selected in that builder has no `serverId`, add it to the select.

- [ ] **Step 7: Copy tables**

In `packages/copy/src/clan.ts`, import `FLAG_CHANGE_WINDOW_MS` and `type CancelRebrandOutcome`. Extend `RENAME`:

```ts
const RENAME: Record<RenameOutcome | ActorRefusal | "bad-name" | "bad-tag" | "bad-flag", string> = {
  ...REFUSAL,
  ok: "Renamed.",
  "flag-pending": `New flag reserved. It arrives in your kit at the next restart. Raise it at your pole within ${hours(FLAG_CHANGE_WINDOW_MS)} to make it yours.`,
  "not-leader": "Only the leader can rebrand the clan.",
  cooldown: `A clan can rebrand once every ${days(RENAME_COOLDOWN_MS)}.`,
  "name-taken": "Another clan has that name.",
  "tag-taken": "Another clan has that tag.",
  "name-held": "That name belongs to a clan that renamed or disbanded and is held.",
  "tag-held": "That tag belongs to a clan that renamed or disbanded and is held.",
  unchanged: "That is already the clan's name, tag and flag.",
  "change-pending": "A flag change is already waiting to be raised. Cancel it first.",
  "not-active": "Only an active clan can change its flag.",
  "flag-taken": "That flag was taken while you were choosing. Pick another.",
  "bad-name": `A clan name is ${CLAN_NAME_LENGTH.min} to ${CLAN_NAME_LENGTH.max} characters.`,
  "bad-tag": `A tag is ${CLAN_TAG_LENGTH.min} to ${CLAN_TAG_LENGTH.max} letters or digits.`,
  "bad-flag": "Pick one of the flags on the list.",
};
const REBRAND_CANCEL: Record<CancelRebrandOutcome | ActorRefusal, string> = {
  ...REFUSAL,
  ok: "Flag change cancelled. The flag is back in the pool.",
  "not-leader": "Only the leader can cancel a flag change.",
  "nothing-pending": "There is no flag change to cancel.",
};
```

Add `rebrandCancel: REBRAND_CANCEL` to `TABLES`.

- [ ] **Step 8: Run tests and typecheck**

Run: `pnpm --filter @factions/roster exec vitest run test/rebrand.test.ts test/writes.test.ts test/exports.test.ts test/viewer.test.ts && npx turbo run typecheck --filter=@factions/roster --filter=@factions/copy --filter=@factions/web --filter=@factions/bot --force`
Expected: PASS and no type errors. `apps/web/app/api/clan/rename/route.ts` still compiles, because `texture` is optional.

- [ ] **Step 9: Commit**

```bash
git add packages/roster packages/copy apps/web/test/smoke.test.ts
git commit -m "Rebrand: rename can start a flag change; leader can cancel it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Completion in raise-tick

**Files:**
- Modify: `packages/roster/src/internal/flag-holds.ts` (add `completeFlagChangeTx`, `announceFlagChangeTx`)
- Modify: `apps/bot/src/raise-tick.ts:58-90` (`done`, the texture check)
- Test: `apps/bot/test/raise-tick.test.ts`

**Interfaces:**
- Consumes: `OLD_FLAG_HOLD_MS` (Task 1), `flag_changed` kinds (Tasks 1, 2).
- Produces:
  - `completeFlagChangeTx(tx: Tx, a: { factionId: number; serverId: number; texture: string; at: Date }): Promise<{ previousTexture: string; name: string; tag: string } | null>`: null when no live pending hold matches.
  - `announceFlagChangeTx(tx: Tx, a: { serverId: number; factionId: number; name: string; tag: string; texture: string; previousTexture: string; gamertag: string; at: Date }): Promise<void>`

- [ ] **Step 1: Write the failing tests**

In `apps/bot/test/raise-tick.test.ts`, add `flag_holds, faction_textures` to the `truncate` list. Import `flagHolds, factionTextures` from `@factions/db` and `FLAG_CHANGE_WINDOW_MS, OLD_FLAG_HOLD_MS` from `@factions/domain`. Add:

```ts
  describe("a pending flag change", () => {
    const pend = (until = new Date(now.getTime() + FLAG_CHANGE_WINDOW_MS), stampsCooldown = true) =>
      db.insert(flagHolds).values({ serverId, texture: "Flag_Wolf", factionId: BEAR, kind: "pending", until, stampsCooldown, createdAt: ago(3_600_000) });
    const bearRow = async () => (await db.select().from(factions).where(eq(factions.id, BEAR)))[0]!;

    it("the old flag still counts while the change is pending", async () => {
      await pend();
      await db.update(factions).set({ flagDownSince: ago(3_600_000), flagDownByDayzId: W1 }).where(eq(factions.id, BEAR));
      await raise(B1, "Bear1", "Flag_Bear", P1, now);
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ defenses: 1 });
      expect((await bearRow()).texture).toBe("Flag_Bear");
    });

    it("a full member raising the new flag at home completes the change", async () => {
      await pend();
      await raise(B1, "Bear1", "Flag_Wolf", P1, now);
      await raiseTick(db, { siteBaseUrl: SITE });
      expect(await bearRow()).toMatchObject({ texture: "Flag_Wolf", renamedAt: now });
      expect(await db.select({ texture: flagHolds.texture, kind: flagHolds.kind, until: flagHolds.until }).from(flagHolds))
        .toEqual([{ texture: "Flag_Bear", kind: "released", until: new Date(now.getTime() + OLD_FLAG_HOLD_MS) }]);
      const hist = await db.select().from(factionTextures).where(eq(factionTextures.factionId, BEAR)).orderBy(factionTextures.fromAt);
      expect(hist.map((h) => [h.texture, h.toAt])).toEqual([["Flag_Bear", now], ["Flag_Wolf", null]]);
      const [fe] = await db.select().from(factionEvents).where(eq(factionEvents.kind, "flag_changed"));
      expect(fe!.payload).toMatchObject({ texture: "Flag_Wolf", previousTexture: "Flag_Bear", actor: "Bear1" });
      expect((await db.select().from(clanNotices).where(eq(clanNotices.kind, "flag_changed")))).toHaveLength(1);
    });

    it("a name-and-flag rebrand does not restamp the cooldown on completion", async () => {
      await pend(undefined, false);
      await raise(B1, "Bear1", "Flag_Wolf", P1, now);
      await raiseTick(db, { siteBaseUrl: SITE });
      expect((await bearRow()).renamedAt).toBeNull();
    });

    it("completing during a siege is also the defense", async () => {
      await pend();
      await db.update(factions).set({ flagDownSince: ago(3_600_000), flagDownByDayzId: W1 }).where(eq(factions.id, BEAR));
      await raise(B1, "Bear1", "Flag_Wolf", P1, now);
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ defenses: 1 });
      expect(await bearRow()).toMatchObject({ texture: "Flag_Wolf", flagDownSince: null });
    });

    it("completing revives a clan that went dormant meanwhile", async () => {
      await pend();
      await db.update(factions).set({ status: "dormant", dormantSince: ago(3_600_000), dormantReason: "inactive" }).where(eq(factions.id, BEAR));
      await raise(B1, "Bear1", "Flag_Wolf", P1, now);
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ revived: 1 });
      expect(await bearRow()).toMatchObject({ texture: "Flag_Wolf", status: "active" });
    });

    it("a raise at or after the deadline does nothing", async () => {
      await pend(now);
      await raise(B1, "Bear1", "Flag_Wolf", P1, now);
      await raiseTick(db, { siteBaseUrl: SITE });
      expect((await bearRow()).texture).toBe("Flag_Bear");
      expect((await db.select().from(flagHolds))[0]).toMatchObject({ kind: "pending" });
    });

    it("the pending flag raised at another pole does nothing", async () => {
      await pend();
      await raise(B1, "Bear1", "Flag_Wolf", P9, now);
      await raiseTick(db, { siteBaseUrl: SITE });
      expect((await bearRow()).texture).toBe("Flag_Bear");
      expect(await db.select().from(clanNotices)).toEqual([]);
    });

    it("a non-member raising the pending flag at home completes nothing", async () => {
      await pend();
      await raise(W1, "Wolfie", "Flag_Wolf", P1, now);
      await raiseTick(db, { siteBaseUrl: SITE });
      expect((await bearRow()).texture).toBe("Flag_Bear");
    });

    it("a second tick does not announce twice", async () => {
      await pend();
      await raise(B1, "Bear1", "Flag_Wolf", P1, now);
      await raiseTick(db, { siteBaseUrl: SITE });
      await raiseTick(db, { siteBaseUrl: SITE });
      expect(await db.select().from(factionEvents).where(eq(factionEvents.kind, "flag_changed"))).toHaveLength(1);
    });
  });
```

The raise-tick fixture's `seedFaction` lives in `apps/bot/test/seed.ts`. If that helper writes its own `faction_textures` row, remove that write; the trigger already does it. Check `factionEvents` and `clanNotices` are imported (they already are).

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @factions/bot exec vitest run test/raise-tick.test.ts`
Expected: the new cases FAIL (texture stays `Flag_Bear`). Every existing case still passes.

- [ ] **Step 3: Implement completion and announcement**

Append to `packages/roster/src/internal/flag-holds.ts`, adding imports for `factionTextures`, `OLD_FLAG_HOLD_MS`, `appendFactionEventTx` (`./feed-store`) and `isNull`, `gt`:

```ts
/**
 * Spec §3: a full member raised the clan's pending flag at its home pole.
 * Promote it. The caller holds the clan's `factions` row FOR UPDATE.
 *
 * Writes `factions` → `flag_holds` → `faction_textures`, the §4.12 order.
 * Takes no new flag (the pending hold already reserved it), so no identity
 * lock. Announcing is separate (`announceFlagChangeTx`) because the feed and
 * notice queues must be written LAST in the caller's transaction, after any
 * defense or revive the same raise also performs.
 *
 * ⚠️ `until` is compared with the EVENT's time, never the wall clock — the
 * same rule as FLAG_DOWN_MS in raise-tick: during a backlog a raise logged
 * in time is folded late and must still count.
 */
export async function completeFlagChangeTx(tx: Tx, a: { factionId: number; serverId: number; texture: string; at: Date }): Promise<{ previousTexture: string; name: string; tag: string } | null> {
  const [hold] = await tx.select({ id: flagHolds.id, stampsCooldown: flagHolds.stampsCooldown }).from(flagHolds)
    .where(and(eq(flagHolds.factionId, a.factionId), eq(flagHolds.kind, "pending"), eq(flagHolds.texture, a.texture), gt(flagHolds.until, a.at)));
  if (!hold) return null;
  const [before] = await tx.select({ texture: factions.texture, name: factions.name, tag: factions.tag }).from(factions).where(eq(factions.id, a.factionId));
  await tx.update(factions)
    .set({ texture: a.texture, ...(hold.stampsCooldown ? { renamedAt: a.at } : {}) })
    .where(eq(factions.id, a.factionId));
  await tx.delete(flagHolds).where(eq(flagHolds.id, hold.id));
  await tx.insert(flagHolds).values({
    serverId: a.serverId, texture: before!.texture, factionId: a.factionId, kind: "released",
    until: new Date(a.at.getTime() + OLD_FLAG_HOLD_MS), createdAt: a.at,
  });
  await tx.update(factionTextures).set({ toAt: a.at })
    .where(and(eq(factionTextures.factionId, a.factionId), isNull(factionTextures.toAt)));
  await tx.insert(factionTextures).values({ factionId: a.factionId, texture: a.texture, fromAt: a.at });
  return { previousTexture: before!.texture, name: before!.name, tag: before!.tag };
}

/** The feed row and the clan-channel notice for a completed flag change. Last in the transaction (§4.12). */
export async function announceFlagChangeTx(tx: Tx, a: { serverId: number; factionId: number; name: string; tag: string; texture: string; previousTexture: string; gamertag: string; at: Date }): Promise<void> {
  await appendFactionEventTx(tx, {
    serverId: a.serverId, factionId: a.factionId, kind: "flag_changed", occurredAt: a.at,
    payload: { name: a.name, tag: a.tag, texture: a.texture, previousTexture: a.previousTexture, actor: a.gamertag },
  });
  await noticeClanTx(tx, {
    serverId: a.serverId, factionId: a.factionId, kind: "flag_changed", occurredAt: a.at,
    payload: { texture: a.texture, previousTexture: a.previousTexture, gamertag: a.gamertag },
  });
}
```

- [ ] **Step 4: Wire it into raise-tick**

In `apps/bot/src/raise-tick.ts`, import `completeFlagChangeTx, announceFlagChangeTx` from `@factions/roster/internal`. Change `done` so queued announcements run before the cursor write:

```ts
        // Queue writes that must land LAST in this transaction (§4.12: the
        // feed and notice queues), after whatever branch below finishes.
        const last: (() => Promise<void>)[] = [];
        const done = async <T,>(v: T): Promise<T> => {
          for (const f of last) await f();
          await writeCursor(tx, RAISE_CONSUMER, ev.id);
          return v;
        };
```

Replace line 88 (`if (p.texture !== clan.texture) return done(null); …`) with:

```ts
          if (p.texture !== clan.texture) {
            // Spec 2026-10-13 §3: the clan's PENDING flag, raised at home by
            // a full member before the deadline, becomes its flag — and this
            // same raise then defends, revives or upkeeps below like any
            // raise of the clan's own colors. Anything else foreign is nothing.
            const changed = clan.status === "active" || clan.status === "dormant"
              ? await completeFlagChangeTx(tx, { factionId: clan.id, serverId: ev.serverId, texture: p.texture, at: ev.occurredAt })
              : null;
            if (!changed) return done(null); // a member raising a foreign flag at home is nothing
            last.push(() => announceFlagChangeTx(tx, {
              serverId: ev.serverId, factionId: clan.id, name: changed.name, tag: changed.tag,
              texture: p.texture, previousTexture: changed.previousTexture, gamertag: p.gamertag, at: ev.occurredAt,
            }));
          }
```

`last` must be declared inside the per-event transaction callback, next to `done`, so each event starts empty.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @factions/bot exec vitest run test/raise-tick.test.ts test/dormancy-tick.test.ts`
Expected: PASS. Use the real dormancy test filename; `ls apps/bot/test | grep dorman` shows it.

- [ ] **Step 6: Commit**

```bash
git add packages/roster/src/internal/flag-holds.ts apps/bot/src/raise-tick.ts apps/bot/test/raise-tick.test.ts apps/bot/test/seed.ts
git commit -m "Rebrand: a member's raise of the pending flag at home completes it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Sweep — lapse pending, release old flags

**Files:**
- Modify: `packages/roster/src/internal/flag-holds.ts` (add `sweepFlagHoldsDb`)
- Create: `apps/bot/src/flag-hold-tick.ts`
- Modify: `apps/bot/src/discord.ts` (after the raise tick's try/catch, ~line 1217)
- Test: `apps/bot/test/flag-hold-tick.test.ts` (new)

**Interfaces:**
- Consumes: `RAISE_CONSUMER` (`apps/bot/src/raise-tick.ts`), `readCursor` (`@factions/event-log`).
- Produces:
  - `sweepFlagHoldsDb(db: Database, a: { now: Date; foldedThrough: Date | null }): Promise<{ lapsed: number; released: number }>`
  - `flagHoldTick(db: Database, now: Date): Promise<{ lapsed: number; released: number }>`

- [ ] **Step 1: Write the failing tests**

Create `apps/bot/test/flag-hold-tick.test.ts`. Copy the server, adm-file, BEAR seed and member setup from `raise-tick.test.ts`'s `beforeEach`. Include the cursor seeding at the max event id, and add `flag_holds, faction_textures` to the truncate list. Then:

```ts
  const pend = (until: Date) => db.insert(flagHolds).values({ serverId, texture: "Flag_Wolf", factionId: BEAR, kind: "pending", until, stampsCooldown: true, createdAt: ago(FLAG_CHANGE_WINDOW_MS) });
  const event = (at: Date) => db.insert(events).values({ serverId, admFileId, lineIndex: lineIndex++, type: "player.connected", occurredAt: at, payload: {} }).returning();
  const foldTo = (id: number) => db.execute(sql`update consumer_cursors set last_event_id = ${id} where consumer_name = 'raise-consumer'`);

  it("lapses a pending change once the raise consumer has folded past its deadline", async () => {
    await pend(now);
    const [e] = await event(new Date(now.getTime() + 1000));
    await foldTo(e!.id);
    expect(await flagHoldTick(db, new Date(now.getTime() + 60_000))).toEqual({ lapsed: 1, released: 0 });
    expect(await db.select().from(flagHolds)).toEqual([]);
    const notices = await db.select({ kind: clanNotices.kind, target: clanNotices.target, to: clanNotices.discordTargetId }).from(clanNotices).orderBy(clanNotices.id);
    expect(notices).toEqual([
      { kind: "flag_change_lapsed", target: "channel", to: null },
      { kind: "flag_change_lapsed", target: "dm", to: "dB1" },
    ]);
  });

  it("does NOT lapse while a raise logged before the deadline may still be unfolded", async () => {
    await pend(now);
    await event(new Date(now.getTime() + 1000)); // ingested, but the cursor sits before it
    expect(await flagHoldTick(db, new Date(now.getTime() + 60_000))).toEqual({ lapsed: 0, released: 0 });
    expect(await db.select().from(flagHolds)).toHaveLength(1);
  });

  it("lapses anyway one full window past the deadline, for a log that stopped", async () => {
    await pend(now);
    expect(await flagHoldTick(db, new Date(now.getTime() + FLAG_CHANGE_WINDOW_MS))).toEqual({ lapsed: 1, released: 0 });
  });

  it("releases an expired old-flag hold silently", async () => {
    await db.insert(flagHolds).values({ serverId, texture: "Flag_Rex", factionId: BEAR, kind: "released", until: now, createdAt: ago(1000) });
    expect(await flagHoldTick(db, now)).toEqual({ lapsed: 0, released: 1 });
    expect(await db.select().from(clanNotices)).toEqual([]);
  });
```

The channel notice's target is null because BEAR has no Discord channel in tests, which matches `noticeClanTx`. Leader `dB1` comes from `seedFaction`'s `leaderDiscordId`. Set it explicitly in the seed call if the default differs.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @factions/bot exec vitest run test/flag-hold-tick.test.ts`
Expected: FAIL: cannot resolve `../src/flag-hold-tick.js`.

- [ ] **Step 3: Implement the sweep**

Append to `flag-holds.ts`, adding imports for `noticeUserTx` (`./notices`) and `lte`:

```ts
/**
 * Spec §2 "Sweep". Released holds go on the clock. A pending hold lapses only
 * once the raise consumer has folded an event at or past its deadline
 * (`foldedThrough`), so a raise logged in time but not yet folded can still
 * complete it — or, as a backstop for a log that has stopped, a full
 * FLAG_CHANGE_WINDOW_MS after the deadline.
 *
 * ⚠️ Each lapse locks the clan's `factions` row first (§4.12) — the same lock
 * a completing raise holds — and re-reads the hold under it.
 */
export async function sweepFlagHoldsDb(db: Database, a: { now: Date; foldedThrough: Date | null }): Promise<{ lapsed: number; released: number }> {
  const released = await db.delete(flagHolds)
    .where(and(eq(flagHolds.kind, "released"), lte(flagHolds.until, a.now)))
    .returning({ id: flagHolds.id });

  const backstop = new Date(a.now.getTime() - FLAG_CHANGE_WINDOW_MS);
  const due = await db.select({ id: flagHolds.id, factionId: flagHolds.factionId }).from(flagHolds).where(and(
    eq(flagHolds.kind, "pending"),
    a.foldedThrough === null
      ? lte(flagHolds.until, backstop)
      : or(lte(flagHolds.until, a.foldedThrough), lte(flagHolds.until, backstop))!,
  ));

  let lapsed = 0;
  for (const d of due) {
    lapsed += await db.transaction(async (tx) => {
      const [clan] = await tx.select({ serverId: factions.serverId, leader: factions.leaderDiscordId }).from(factions)
        .where(eq(factions.id, d.factionId)).for("update");
      const gone = await tx.delete(flagHolds).where(and(eq(flagHolds.id, d.id), eq(flagHolds.kind, "pending")))
        .returning({ texture: flagHolds.texture });
      if (!clan || gone.length === 0) return 0; // completed or cancelled meanwhile
      const payload = { texture: gone[0]!.texture };
      await noticeClanTx(tx, { serverId: clan.serverId, factionId: d.factionId, kind: "flag_change_lapsed", occurredAt: a.now, payload });
      await noticeUserTx(tx, { serverId: clan.serverId, factionId: d.factionId, discordId: clan.leader, kind: "flag_change_lapsed", occurredAt: a.now, payload });
      return 1;
    });
  }
  return { lapsed, released: released.length };
}
```

- [ ] **Step 4: The bot tick**

Create `apps/bot/src/flag-hold-tick.ts`:

```ts
import type { Database } from "@factions/db";
import { events } from "@factions/db";
import { readCursor } from "@factions/event-log";
import { sweepFlagHoldsDb } from "@factions/roster/internal";
import { eq } from "drizzle-orm";
import { RAISE_CONSUMER } from "./raise-tick.js";

/**
 * Lapse pending flag changes and release old flags (spec 2026-10-13 §2).
 *
 * ⚠️ `foldedThrough` is the time of the last event the RAISE consumer
 * committed, not now: a pending change lapses only once every raise that
 * could have completed it has been folded. Runs right after raiseTick so
 * that, on a healthy tick, it is as current as it can be. The cursor is
 * global across servers; with one managed server that is exact, and the
 * backstop in the sweep bounds any other case.
 */
export async function flagHoldTick(db: Database, now: Date): Promise<{ lapsed: number; released: number }> {
  const cursor = await readCursor(db, RAISE_CONSUMER);
  const [last] = cursor === 0 ? [] : await db.select({ at: events.occurredAt }).from(events).where(eq(events.id, cursor));
  return sweepFlagHoldsDb(db, { now, foldedThrough: last?.at ?? null });
}
```

In `apps/bot/src/discord.ts`, import `flagHoldTick` and add after the raise tick's try/catch:

```ts
    // ⚠️ Right after raiseTick, in its own try/catch: it lapses a pending
    // flag change only once raiseTick has folded past the deadline, so it
    // must never run ahead of it — and a raise-tick failure must not stop
    // old flags returning to the pool.
    try {
      const fh = await flagHoldTick(db, new Date());
      if (fh.lapsed > 0 || fh.released > 0) console.log(`flag holds: ${fh.lapsed} lapsed, ${fh.released} released`);
    } catch (err) {
      console.error("flag hold tick failed", err);
    }
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @factions/bot exec vitest run test/flag-hold-tick.test.ts test/raise-tick.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/roster/src/internal/flag-holds.ts apps/bot/src/flag-hold-tick.ts apps/bot/src/discord.ts apps/bot/test/flag-hold-tick.test.ts
git commit -m "Rebrand: lapse unraised flag changes, return old flags to the pool

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Upkeep raises survive a rebrand

**Files:**
- Modify: `packages/roster/src/stats.ts:681-697` (`upkeepRaiseCount`) and its doc comment at ~673
- Test: `packages/roster/test/stats.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/roster/test/stats.test.ts`, inside the `describe` that holds the profile tests (where `p.upkeepRaises` is 3 for "Alpha" under `ALL`), add:

```ts
    it("a rebrand does not erase upkeep raises made under the old flag", async () => {
      const [bear] = await db.select({ id: factions.id }).from(factions).where(eq(factions.tag, "BEAR"));
      const switchAt = h(t50, 20);
      await db.update(factionTextures).set({ toAt: switchAt }).where(and(eq(factionTextures.factionId, bear!.id), isNull(factionTextures.toAt)));
      await db.insert(factionTextures).values({ factionId: bear!.id, texture: "Flag_Rex", fromAt: switchAt });
      await db.update(factions).set({ texture: "Flag_Rex" }).where(eq(factions.id, bear!.id));
      // Under the new flag, a Flag_Bear raise no longer counts; a Flag_Rex one does.
      await mkEvent({ type: "flag.raised", at: h(t50, 21), payload: { dayzId: A, gamertag: "Alpha", texture: "Flag_Bear", poleKey: "BEAR:0:0" } });
      await mkEvent({ type: "flag.raised", at: h(t50, 22), payload: { dayzId: A, gamertag: "Alpha", texture: "Flag_Rex", poleKey: "BEAR:0:0" } });
      const p = (await playerProfileDb(db, "Alpha", ALL, now))!;
      expect(p.upkeepRaises).toBe(4);
    });
```

Use the file's own `h`, `t50`, `A`, `mkEvent` and `ALL` (all already defined there). Add `factionTextures` and the drizzle helpers to the imports. `h(t50, 22)` must fall before `now`; check how `now` relates to `t50` at the top of the file, and pick hours that fit if it doesn't.

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --filter @factions/roster exec vitest run test/stats.test.ts`
Expected: FAIL. The new test gets 1 (only the `Flag_Rex` raise matches the current texture), not 4.

- [ ] **Step 3: Implement**

In `upkeepRaiseCount`, replace the `factions` join with:

```ts
    // Spec 2026-10-13 §3: the flag the clan flew AT THE TIME of the raise,
    // not its current one — a rebrand must not erase members' raises.
    .innerJoin(factionTextures, and(
      eq(factionTextures.factionId, membershipHistory.factionId),
      sql`${factionTextures.texture} = ${events.payload}->>'texture'`,
      sql`${factionTextures.fromAt} <= ${events.occurredAt}`,
      sql`(${factionTextures.toAt} is null or ${events.occurredAt} < ${factionTextures.toAt})`,
    ))
```

Update the doc comment above it to say "the clan's texture at the time of the raise (`faction_textures`)". Remove `factions` from the imports if nothing else in the file uses it.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @factions/roster exec vitest run test/stats.test.ts`
Expected: PASS, including every existing `upkeepRaises` assertion (3 / 2 / the before-membership case).

- [ ] **Step 5: Commit**

```bash
git add packages/roster/src/stats.ts packages/roster/test/stats.test.ts
git commit -m "Rebrand: attribute upkeep raises by the flag flown at the time

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The kit delivers the pending flag

**Files:**
- Modify: `apps/ingest-worker/src/supply-tick.ts:35-75`
- Test: `apps/ingest-worker/test/supply-tick.test.ts`

- [ ] **Step 1: Write the failing test**

In `apps/ingest-worker/test/supply-tick.test.ts`, add `flag_holds, faction_textures` to the truncate list. Add a test that seeds a clan the way the file's other tests do, then inserts a pending hold:

```ts
  it("a clan with a pending flag change gets the NEW flag in its kit", async () => {
    // …seed BEAR (Flag_Bear) with a declaration exactly as the file's first test does…
    await db.insert(flagHolds).values({ serverId, texture: "Flag_Wolf", factionId: bearId, kind: "pending", until: new Date(now.getTime() + 3_600_000), createdAt: now });
    await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    const uploaded = client.uploads.at(-1)!.content; // use the file's own fake-client accessor
    expect(uploaded).toContain("Flag_Wolf");
    expect(uploaded).not.toContain("Flag_Bear");
  });
```

Copy the seeding lines and the fake-client accessor from the first test in this file verbatim. The `offsets` fixture must include the template's white flag, as the existing flag-substitution test's fixture does.

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --filter @factions/ingest-worker exec vitest run test/supply-tick.test.ts`
Expected: FAIL: the upload contains `Flag_Bear`.

- [ ] **Step 3: Implement**

In `supply-tick.ts`, import `flagHolds` from `@factions/db` and `sql` from `drizzle-orm`. Change the select's `texture` and add a left join after the declarations inner join:

```ts
    // ⚠️ The PENDING flag when a rebrand is waiting to be raised: the kit is
    // the only source of a clan flag in game, so without this there is
    // nothing to raise and every flag change lapses (spec 2026-10-13 §4).
    tag: factions.tag, texture: sql<string>`coalesce(${flagHolds.texture}, ${factions.texture})`,
```

```ts
    .leftJoin(flagHolds, and(eq(flagHolds.factionId, factions.id), eq(flagHolds.kind, "pending")))
```

The partial unique index `flag_holds_one_pending` guarantees at most one joined row, so the `orderBy(asc(factions.tag))` stability argument still holds.

- [ ] **Step 4: Run the worker tests**

Run: `pnpm --filter @factions/ingest-worker exec vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ingest-worker/src/supply-tick.ts apps/ingest-worker/test/supply-tick.test.ts
git commit -m "Rebrand: the supply kit carries the pending flag

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Site — the Rebrand panel

**Files:**
- Create: `apps/web/app/components/flag-picker.tsx` (extracted from the claim form)
- Modify: `apps/web/app/(site)/claim/[ceremony]/claim-form.tsx:57-80` (use `FlagPicker`)
- Rename: `apps/web/app/(site)/clan/settings/rename-form.tsx` → `rebrand-form.tsx`
- Modify: `apps/web/app/(site)/clan/settings/page.tsx:80-84`
- Modify: `apps/web/app/api/clan/rename/route.ts`
- Create: `apps/web/app/api/clan/rebrand/cancel/route.ts`
- Modify: `apps/web/lib/field-errors.ts:16-17`
- Test: `apps/web/test/claim-form.test.tsx` (must still pass), `apps/web/test/rebrand-form.test.tsx` (new)

**Interfaces:**
- Consumes: `ClanView.rebrand`, the `rename` texture param and `cancelRebrand` (Task 4); copy codes `rename.flag-pending`, `rename.bad-flag`, `rename.flag-taken`, `rename.change-pending`, `rename.not-active`, `rebrandCancel.*`.
- Produces: `FlagPicker({ flags, name, keep, checked, err, required }: { flags: string[]; name: string; keep?: { texture: string; label: string }; checked?: string; err: FieldErrorT | null; required?: boolean })`

- [ ] **Step 1: Extract `FlagPicker`**

Move the `<fieldset>…</fieldset>` from `claim-form.tsx` lines 59-78 into `apps/web/app/components/flag-picker.tsx` as `FlagPicker`, unchanged except:
- the radio `name` comes from the `name` prop and `defaultChecked` from `checked`;
- an optional `keep` renders one extra first tile with `value=""`, the current flag's thumb, and the caption "Keep <label>". That tile is `defaultChecked` when `checked` is undefined.

Keep every existing comment (L4, H5, the glyph note). In `claim-form.tsx`, render `<FlagPicker flags={freeFlags} name="texture" checked={keptFlag} err={err} required />` inside the existing Panel/PanelBody.

Run: `pnpm --filter @factions/web exec vitest run test/claim-form.test.tsx`
Expected: PASS. The extraction is behaviour-neutral.

- [ ] **Step 2: Write the failing rebrand-form test**

Create `apps/web/test/rebrand-form.test.tsx`, following `claim-form.test.tsx`'s render setup:

```tsx
it("offers keep-current plus the free flags, posting texture", () => {
  const html = render(<RebrandForm name="Bears" tag="BEAR" texture="Flag_Bear" freeFlags={["Flag_Rex", "Flag_Wolf"]} pending={null} err={null} kept={{}} />);
  expect(html).toContain('action="/api/clan/rename"');
  expect(html).toContain('name="texture" value=""');
  expect(html).toContain('value="Flag_Wolf"');
});

it("while a change is pending, shows it with a cancel button and no form", () => {
  const html = render(<RebrandForm name="Bears" tag="BEAR" texture="Flag_Bear" freeFlags={[]} pending={{ texture: "Flag_Wolf", until: new Date("2026-10-14T12:00:00Z") }} err={null} kept={{}} />);
  expect(html).toContain("Wolf");
  expect(html).toContain('action="/api/clan/rebrand/cancel"');
  expect(html).not.toContain('action="/api/clan/rename"');
});
```

Run: `pnpm --filter @factions/web exec vitest run test/rebrand-form.test.tsx`
Expected: FAIL: no `rebrand-form` module.

- [ ] **Step 3: `RebrandForm`**

`git mv` `rename-form.tsx` to `rebrand-form.tsx`, then rename the component to `RebrandForm` with these props:

```tsx
export function RebrandForm({ name, tag, texture, freeFlags, pending, err, kept }: {
  name: string; tag: string; texture: string; freeFlags: string[];
  pending: { texture: string; until: Date } | null;
  err: FieldErrorT | null; kept: { name?: string; tag?: string; texture?: string };
}) {
  if (pending) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm leading-relaxed text-ink-2">
          <strong>{flagLabel(pending.texture)}</strong> is reserved for you. It arrives in your kit at the next restart. Raise it at your pole by <UtcTime at={pending.until} /> to make it yours. Until then you still fly {flagLabel(texture)}.
        </p>
        <form action="/api/clan/rebrand/cancel" method="post">
          <SubmitButton className={`${btnSecondary} self-start`} pending="Cancelling…">Cancel flag change</SubmitButton>
        </form>
      </div>
    );
  }
  return (
    <form className="flex flex-col gap-3" action="/api/clan/rename" method="post">
      {/* …the existing Name and Tag labels, unchanged… */}
      <FlagPicker flags={freeFlags} name="texture" keep={{ texture, label: flagLabel(texture) }} checked={kept.texture} err={err} />
      <p id="rename-note" className="text-xs text-muted">The old name and tag stay held, so nobody else can take them. A new flag is yours once a member raises it at your pole.</p>
      <SubmitButton className={`${btnSecondary} self-start`}>Rebrand</SubmitButton>
    </form>
  );
}
```

`flagLabel` comes from `@factions/copy`. For `UtcTime`, use whatever component the site already uses for UTC timestamps (`grep -rn "UtcTime\|utc-time" apps/web/app/components`). If there isn't one, use `pending.until.toISOString().slice(0, 16).replace("T", " ") + " UTC"`, the format the UTC-times test (`apps/web/test/utc-times.test.ts`) enforces.

In `page.tsx`, change the panel to `title="Rebrand"` and render:

```tsx
<RebrandForm name={clan.name} tag={clan.tag} texture={clan.texture} freeFlags={view.rebrand?.freeFlags ?? []} pending={view.rebrand?.pending ?? null} err={err} kept={{ name: kept.get("name"), tag: kept.get("tag"), texture: kept.get("texture") }} />
```

- [ ] **Step 4: Routes and field errors**

In `apps/web/app/api/clan/rename/route.ts`, read the flag and keep it on refusal. `""` means keep the current flag:

```ts
    const refuse = (c: string): Redirect => ({ back: "/clan/settings", code: c, keep: keepFrom(form, { name: CLAN_NAME_LENGTH.max, tag: CLAN_TAG_LENGTH.max, texture: 40 }) });
    …
    const rawTexture = form.get("texture");
    const texture = typeof rawTexture === "string" && rawTexture !== "" ? rawTexture : undefined;
    const outcome = await rename(session.sub, { name, ...(tag ? { tag } : {}), ...(texture ? { texture } : {}) });
    return outcome === "ok" || outcome === "flag-pending" ? code("rename", outcome) : refuse(code("rename", outcome));
```

Create `apps/web/app/api/clan/rebrand/cancel/route.ts`:

```ts
import type { NextRequest, NextResponse } from "next/server";
import { cancelRebrand } from "@factions/roster";
import { formAction } from "@/lib/form";
import { code } from "@/lib/clan-copy";

/** POST from /clan/settings. Leader only; the package enforces it. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan/settings", async (session) => code("rebrandCancel", await cancelRebrand(session.sub)));
}
```

In `apps/web/lib/field-errors.ts`, add `"rename.bad-flag": "texture", "rename.flag-taken": "texture",`.

- [ ] **Step 5: Run the web tests**

Run: `pnpm --filter @factions/web exec vitest run`
Expected: PASS. Fix any test that pinned the "Rename" panel title or the old `RenameForm` import by updating it to the new name. The behaviour it tested is unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "Rebrand: settings panel picks a new flag; pending state with cancel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Discord — `/clan rename flag:` and `/clan rebrand-cancel`

**Files:**
- Modify: `apps/bot/src/commands/clan.ts`
- Modify: `apps/bot/test/parity.test.ts:28` (`COMMANDS`)
- Test: `apps/bot/test/commands-clan.test.ts` (or whichever file covers `clan rename`; `grep -ln "clan rename" apps/bot/test`)

- [ ] **Step 1: Write the failing tests**

Add `cancelRebrand: "clan rebrand-cancel",` to `COMMANDS` in `parity.test.ts`, after `rename`. Then run it.

Run: `pnpm --filter @factions/bot exec vitest run test/parity.test.ts`
Expected: FAIL: no command registered at `clan rebrand-cancel`.

In the clan-command test file, add cases following its fake-roster pattern:
- `clan rename` with `name: "Bears", flag: "Flag_Wolf"` calls `roster.rename("<actor>", { name: "Bears", texture: "Flag_Wolf" })` and replies with `discordCopy("rename", "flag-pending")`;
- `clan rebrand-cancel` calls `roster.cancelRebrand` and replies with `discordCopy("rebrandCancel", "ok")`;
- the `flag` autocomplete returns `{ name: "Wolf", value: "Flag_Wolf" }` for a leader whose `clanFor` view has `rebrand.freeFlags: ["Flag_Wolf"]`, and `[]` for a non-leader.

- [ ] **Step 2: Implement**

In `apps/bot/src/commands/clan.ts`, import `flagLabel` from `@factions/copy`:

```ts
const rename: Handler = async (ctx, input) => {
  const name = input.string("name");
  if (!name) return { content: "Give the new name.", ephemeral: true };
  const tag = input.string("tag");
  const texture = input.string("flag");
  const outcome = await ctx.roster.rename(input.actorDiscordId, { name, ...(tag ? { tag } : {}), ...(texture ? { texture } : {}) });
  return { content: discordCopy("rename", outcome), ephemeral: true };
};

const rebrandCancel: Handler = async (ctx, input) =>
  ({ content: discordCopy("rebrandCancel", await ctx.roster.cancelRebrand(input.actorDiscordId)), ephemeral: true });

/** The leader's free pool. Discord caps autocomplete at 25; filter by what was typed so all 33 stay reachable. */
const flags: AutocompleteSource = async (ctx, a) => {
  const view = await clanView(ctx, a.actorDiscordId);
  const typed = (a.focused ?? "").toLowerCase();
  return (view?.rebrand?.freeFlags ?? [])
    .filter((f) => flagLabel(f).toLowerCase().includes(typed))
    .slice(0, 25)
    .map((f) => ({ name: flagLabel(f), value: f }));
};
```

Check what `AutocompleteSource`'s second argument calls the typed text (read `commands/types.ts`) and use that field name instead of `focused` if it differs. Update the builder:

```ts
    .addSubcommand((s) => s.setName("rename").setDescription("Rebrand the clan: name, tag, and optionally a new flag")
      .addStringOption((o) => o.setName("name").setDescription("New name (repeat the current one to keep it)").setRequired(true))
      .addStringOption((o) => o.setName("tag").setDescription("New tag").setRequired(false))
      .addStringOption((o) => o.setName("flag").setDescription("New flag. Yours once a member raises it at your pole").setRequired(false).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("rebrand-cancel").setDescription("Cancel a flag change that hasn't been raised yet"))
```

and the specs:

```ts
    { path: "clan rename", handler: rename, autocomplete: { flag: flags } },
    { path: "clan rebrand-cancel", handler: rebrandCancel },
```

- [ ] **Step 3: Run the bot tests**

Run: `pnpm --filter @factions/bot exec vitest run test/parity.test.ts test/command-registration.test.ts` plus the clan-command test file.
Expected: PASS. `command-registration.test.ts` enforces ephemeral replies, and both handlers use them.

- [ ] **Step 4: Commit**

```bash
git add apps/bot/src/commands/clan.ts apps/bot/test
git commit -m "Rebrand: /clan rename flag option and /clan rebrand-cancel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Guide, docs, changelog, full gate

**Files:**
- Modify: `packages/domain/src/guide-numbers.ts:34` (map) and `:179-181` (rows)
- Modify: `apps/web/content/guide/08-running-a-clan.html:46-47`
- Modify: `apps/web/lib/guide-links.ts:18`
- Modify: `CLAUDE.md` (lock-order list; "Where things live" row)
- Modify: `docs/superpowers/specs/2026-10-13-clan-rebrand-flag-design.md` (fold in the four amendments at the top of this plan; Status: approved)
- Modify: `CHANGELOG.md` (`## [Unreleased]`)

- [ ] **Step 1: Guide numbers**

In `guide-numbers.ts`, add `FLAG_CHANGE_WINDOW_MS: R.FLAG_CHANGE_WINDOW_MS, OLD_FLAG_HOLD_MS: R.OLD_FLAG_HOLD_MS,` to the map after `RENAME_COOLDOWN_MS`. Then add rows after the rename row:

```ts
  row("Running a clan", "Rebrand cooldown", "RENAME_COOLDOWN_MS"),
  row("Running a clan", "New flag: raise it within", "FLAG_CHANGE_WINDOW_MS"),
  row("Running a clan", "Old flag held after a rebrand", "OLD_FLAG_HOLD_MS"),
```

The first line replaces the existing "Rename cooldown" row.

- [ ] **Step 2: Guide chapter**

Replace the Rename section of `08-running-a-clan.html` with:

```html
<h2>Rebrand</h2>
<p>Leader only, <strong>once per {{RENAME_COOLDOWN_MS|days}}</strong>. Change the name, the tag, the flag, or any mix of them. The feed announces it. Your old name and tag are held for the rest of the season so nobody can impersonate you.</p>
<p>A new flag works like founding. Pick it on the site, and it is reserved for you at once. It arrives in your kit at the next restart, and it becomes your flag the moment a member <strong>raises it at your pole</strong>. Until then you still fly your old flag, and raising either one at home counts, so a raid in the meantime can still be defended. Nobody raises it within <strong>{{FLAG_CHANGE_WINDOW_MS|hours}}</strong>? It goes back to the pool and you keep your old flag, with no cooldown spent. The old flag is held for {{OLD_FLAG_HOLD_MS|days}}, then goes back to the pool.</p>
```

In `guide-links.ts`, change `heading: "rename"` to `heading: "rebrand"`.

Run: `pnpm --filter @factions/web exec vitest run test/guide.test.ts test/guide-links.test.ts && pnpm --filter @factions/domain exec vitest run`
Expected: PASS. The guide test fails on any hand-typed number, so every number above has to stay a token.

- [ ] **Step 3: CLAUDE.md**

In the lock-order bullet, change `` `factions` → `declarations` → `` to `` `factions` → `flag_holds` → `faction_textures` → `declarations` → ``. Add one sentence after the list: "`flag_holds`/`faction_textures` are written by `packages/roster/src/internal/flag-holds.ts` alone (rename, cancel, raise-tick's completion, the flag-hold sweep), always under the clan's `factions` row lock." Add a "Where things live" row:

`| Rebrand (a clan changes its flag) | Rules in `packages/roster/src/internal/flag-holds.ts` (`freeFlagsDb`, `flagTakenTx`, start/cancel/complete/sweep); `flag_holds` + `faction_textures` (migration 0066, whose `faction_textures_first` trigger writes every clan's first row); completion in `apps/bot/src/raise-tick.ts`; sweep `apps/bot/src/flag-hold-tick.ts` right after raiseTick. ⚠️ A pending hold holds its flag until the SWEEP deletes it, never just until `until` — the sweep waits for the raise consumer to fold past the deadline. ⚠️ The kit (`supply-tick.ts`) delivers the pending flag; without it nothing can be raised. Spec `docs/superpowers/specs/2026-10-13-clan-rebrand-flag-design.md` |`

- [ ] **Step 4: Spec amendments and changelog**

Edit the spec. Set Status to "approved; implemented by `docs/superpowers/plans/2026-10-13-clan-rebrand-flag.md`". Add `stamps_cooldown` to the `flag_holds` table. Rewrite the "Free pool" paragraph so a pending hold is held until swept. Change "Founding (`reserve`) inserts the first row" to describe the trigger and `-infinity`. Note that the feed kind is `flag_changed`.

Add under `## [Unreleased]` in `CHANGELOG.md`, using that file's existing heading style (`### Added`):

```markdown
- **Rebrand: clans can change their flag.** The leader picks a new flag with the rename (now "Rebrand") on the site or with `/clan rename flag:`. It is reserved at once, arrives in the kit at the next restart, and becomes the clan's flag when a member raises it at the base. Until then either flag counts at home. Unraised within 24 hours, it goes back to the pool at no cooldown cost; `/clan rebrand-cancel` drops it sooner. The old flag is held for 3 days. Members' past flag raises keep counting on their profiles.
```

- [ ] **Step 5: Full gate**

Run:
```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5440/factions" \
  npx turbo run typecheck test --concurrency=1 --force
```
Expected: **32/32 tasks successful**. Check the count, not just the exit code. If a `factions_test_<package>` from before this branch fails on 0066, drop that database once and rerun (CLAUDE.md, the 0023 note).

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/guide-numbers.ts apps/web/content/guide/08-running-a-clan.html apps/web/lib/guide-links.ts CLAUDE.md docs/superpowers/specs/2026-10-13-clan-rebrand-flag-design.md CHANGELOG.md
git commit -m "Rebrand: guide chapter, numbers, CLAUDE.md, changelog

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Deploy note (for the PR description, not a task)

Migration 0066 only adds tables, a trigger, and a widened CHECK. Old code runs fine against the new schema, so the standard release deployer (`deploy/deploy-release.sh`, which stops writers before migrating) is enough, with no manual step. The backfill writes one `faction_textures` row per existing faction. After deploy, `select count(*) from factions` should equal `select count(*) from faction_textures where to_at is null`.
