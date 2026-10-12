# Carry Bases Through the Wipe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A clan's base survives a same-map wipe (its kit spawns at the old spot and the first nearby raise adopts the new pole), and a one-off script clears the Livonia-era bases so Chernarus raises can move clans now.

**Architecture:** A nullable `declarations.carried_since` marks a base whose pole was wiped. `wipeTx` stamps it instead of deleting declarations. A new `adoptCarriedTx` in `packages/declarations` (the one module that writes `declarations`) re-points a carried row to a new pole under the declarations lock, and `raise-tick` calls it for a full member's white or own-flag raise within `CARRIED_ADOPT_RADIUS_M`. A `pnpm clear-bases` script releases declarations older than a cutoff through the existing `releaseTx`.

**Tech Stack:** TypeScript, drizzle-orm over postgres.js, vitest, pnpm + turbo.

**Spec:** `docs/superpowers/specs/2026-10-12-carry-bases-through-wipe-design.md`

## Global Constraints

- `CARRIED_ADOPT_RADIUS_M = 100`, measured 2D on x/z (`distance2d` from `@factions/domain`).
- `MIN_BASE_SPACING_M` (200 m) still applies to an adoption, against every OTHER declaration on the server.
- Only a `full` member of an `active` or `dormant` clan adopts; texture must be `Flag_White` (`NEUTRAL_FLAG`) or the clan's own texture.
- Lock order §4.12: `factions` FOR UPDATE → `lockDeclarations` → `declarations` → `poles` → … → `faction_events` → `clan_notices`.
- Every write to `declarations` lives in `packages/declarations` (`declareTx`, `releaseTx`, new `adoptCarriedTx`), except `wipeTx`'s existing bulk write.
- `clear-bases` refuses a `DATABASE_URL` not ending in `/factions_live` unless `--allow-test-db`; `--before` is required, no default; usage errors exit 2.
- No coordinates in `faction_events` payloads or any Discord/site text.
- Comments explain WHY; `⚠️` marks lines whose misuse fails silently. Match surrounding density.
- Test gate: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force` — expect 32/32 tasks. Never run two test runs at once.
- `CHANGELOG.md` gets an `## [Unreleased]` entry, committed. Player-facing copy: plain voice (`brand/02-verbal-identity.md`).

## Review Focus

1. A raise replayed after an adoption (cursor rewound) must not move the base again or write a second `rebound` event: the second pass finds the pole declared and takes the clan-declaration branch.
2. A raiser who is a full member of a clan that is NOT carried, raising white near some other clan's carried spot, must not adopt anything (adoption keys off the raiser's own clan).
3. Two clans whose carried spots are within 100 m of the same new pole: only the raiser's clan adopts; the other is refused by the 200 m spacing check if it tries next.
4. A wipe run twice (re-run guard) must not change `carried_since` on the second run.
5. `clear-bases --dry-run` must leave every row in place (rolled back), and still print what it would release.

---

### Task 1: Schema, rule constant, guide number

**Files:**
- Modify: `packages/db/src/schema.ts:699-721` (declarations table)
- Create: `packages/db/migrations/0065_*.sql` (generated) + `meta` snapshot/journal
- Modify: `packages/domain/src/rules.ts:108` area
- Modify: `packages/domain/src/guide-numbers.ts` (SCALARS + a row after the `POST_WIPE_BIND_MS` row at line 167)
- Modify: `packages/domain/test/guide-numbers.test.ts` (label list)
- Modify: `packages/declarations/src/store.ts` (`Declaration` type and `shape`)

**Interfaces:**
- Produces: `declarations.carriedSince` (drizzle column, `Date | null`); `CARRIED_ADOPT_RADIUS_M: number` exported from `@factions/domain`; `Declaration` gains `carriedSince: Date | null` (returned by `declarationForFaction`/`declarationForPlayer`).

- [ ] **Step 1: Add the column to the schema**

In `packages/db/src/schema.ts`, inside `declarations`, after `declaredAt`:

```ts
  /**
   * Set by the wipe: this base outlived its pole. Null means the base sits on
   * a pole that exists. While set, raise-tick lets the clan's first nearby
   * raise adopt a new pole (`adoptCarriedTx`) and the supply kit keeps
   * spawning at x/z. ⚠️ Only the wipe sets it; only `adoptCarriedTx` and a
   * fresh `declareTx` row clear it.
   */
  carriedSince: timestamp("carried_since", { withTimezone: true }),
```

- [ ] **Step 2: Generate and read the migration**

Run: `cd packages/db && npx drizzle-kit generate`
Expected: one new file `migrations/0065_<name>.sql` containing exactly
`ALTER TABLE "declarations" ADD COLUMN "carried_since" timestamp with time zone;`
Read it. If it contains anything else, stop and investigate.

- [ ] **Step 3: Add the rule constant**

In `packages/domain/src/rules.ts`, directly under `export const POST_WIPE_BIND_MS = 7 * DAY;`:

```ts
/**
 * After a wipe a base keeps its spot but loses its pole. The clan's first
 * white or own-flag raise at a new pole this close to the old spot becomes the
 * base with no confirmation; further away is an ordinary move.
 */
export const CARRIED_ADOPT_RADIUS_M = 100;
```

- [ ] **Step 4: Add the guide number**

In `packages/domain/src/guide-numbers.ts`, add `CARRIED_ADOPT_RADIUS_M: R.CARRIED_ADOPT_RADIUS_M,` to `SCALARS` beside `POST_WIPE_BIND_MS`, and directly after the `POST_WIPE_BIND_MS` row:

```ts
  row("The scoreboard", "After a wipe: a new pole this close to your old base becomes your base", "CARRIED_ADOPT_RADIUS_M"),
```

In `packages/domain/test/guide-numbers.test.ts`, insert the label `"After a wipe: a new pole this close to your old base becomes your base"` into the expected-label list immediately after `"After a wipe: raise your flag to bind a new base within"`.

- [ ] **Step 5: Expose `carriedSince` on `Declaration`**

In `packages/declarations/src/store.ts`:

```ts
export type Declaration = { id: number; poleKey: string; x: string; y: string; z: string; declaredAt: Date; carriedSince: Date | null };
```

and add `carriedSince: declarations.carriedSince` to `const shape = { … }`.

- [ ] **Step 6: Run the affected suites**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --filter=@factions/db --filter=@factions/domain --filter=@factions/declarations --concurrency=1 --force`
Expected: PASS. A failure in `guide-numbers.test.ts` means the label order in Step 4 is off.

- [ ] **Step 7: Commit**

```bash
git add packages/db packages/domain packages/declarations
git commit -m "feat(db): declarations.carried_since and the 100 m adopt radius"
```

---

### Task 2: `adoptCarriedTx`

**Files:**
- Modify: `packages/declarations/src/store.ts` (new function after `releaseTx`)
- Modify: `packages/declarations/src/index.ts` (export it, if the index re-exports by name — check)
- Test: `packages/declarations/test/adopt-carried.test.ts` (new)

**Interfaces:**
- Consumes: `declarations.carriedSince` (Task 1), `lockDeclarations`, `tooClose` from `@factions/domain`.
- Produces:
  ```ts
  export type AdoptArgs = { serverId: number; factionId: number; poleKey: string; x: number; y: number; z: number; eventId: number; at: Date };
  export type AdoptOutcome = { ok: true } | { ok: false; reason: "not-carried" | "too-close" | "pole-taken" };
  export async function adoptCarriedTx(tx: Tx, a: AdoptArgs): Promise<AdoptOutcome>;
  ```
  The radius check is the caller's (raise-tick decides whether the raise is an adoption at all); this function re-checks only what can change under concurrency.

- [ ] **Step 1: Write the failing tests**

Create `packages/declarations/test/adopt-carried.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, declarations, events, admFiles, type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { adoptCarriedTx, declarationForFaction } from "../src/store";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-10-20T12:00:00Z");
const key = (x: number, z: number) => `${x.toFixed(2)}:100.00:${z.toFixed(2)}`;

describe("adoptCarriedTx", () => {
  let db: Database;
  let serverId = 0;
  let admFileId = 0;
  let line = 0;
  let BEAR = 0;
  let WOLF = 0;

  const event = async () => {
    const [e] = await db.insert(events).values({
      serverId, admFileId, lineIndex: line++, type: "flag.raised", occurredAt: now, payload: {},
    }).returning();
    return e!.id;
  };
  const clan = async (tag: string) => {
    const [f] = await db.insert(factions).values({
      serverId, name: tag, tag, texture: `Flag_${tag}`, status: "active", leaderDiscordId: "d", createdAt: now,
    }).returning();
    return f!.id;
  };
  const declare = async (factionId: number, x: number, z: number, carried: boolean) => {
    await db.insert(declarations).values({
      serverId, poleKey: key(x, z), x: x.toFixed(2), y: "100.00", z: z.toFixed(2),
      ownerFactionId: factionId, evidenceEventId: await event(), declaredAt: now,
      carriedSince: carried ? now : null,
    });
  };
  const adopt = async (factionId: number, x: number, z: number) => {
    const eventId = await event();
    return db.transaction((tx) => adoptCarriedTx(tx, {
      serverId, factionId, poleKey: key(x, z), x, y: 100, z, eventId, at: now,
    }));
  };

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table declarations, factions, events, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "chernarusplus", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    admFileId = a!.id;
    line = 0;
    BEAR = await clan("BEAR");
    WOLF = await clan("WOLF");
  });

  it("re-points a carried declaration to the new pole and clears carried_since", async () => {
    await declare(BEAR, 5000, 5000, true);
    expect(await adopt(BEAR, 5040, 5030)).toEqual({ ok: true });
    const d = await declarationForFaction(db, BEAR);
    expect(d).toMatchObject({ poleKey: key(5040, 5030), x: "5040.00", z: "5030.00", carriedSince: null, declaredAt: now });
    const [row] = await db.select().from(declarations).where(eq(declarations.ownerFactionId, BEAR));
    expect(row!.evidenceEventId).not.toBeNull();
    expect(row!.evidenceCeremonyId).toBeNull();
    expect(await db.select().from(declarations)).toHaveLength(1);
  });

  it("refuses a declaration that is not carried", async () => {
    await declare(BEAR, 5000, 5000, false);
    expect(await adopt(BEAR, 5040, 5030)).toEqual({ ok: false, reason: "not-carried" });
    expect(await declarationForFaction(db, BEAR)).toMatchObject({ poleKey: key(5000, 5000) });
  });

  it("refuses a clan with no declaration as not-carried", async () => {
    expect(await adopt(BEAR, 5040, 5030)).toEqual({ ok: false, reason: "not-carried" });
  });

  it("refuses a pole within 200 m of another base, ignoring the clan's own", async () => {
    await declare(BEAR, 5000, 5000, true);
    await declare(WOLF, 5250, 5000, true);
    expect(await adopt(BEAR, 5080, 5000)).toEqual({ ok: false, reason: "too-close" });
    expect(await declarationForFaction(db, BEAR)).toMatchObject({ poleKey: key(5000, 5000), carriedSince: now });
  });

  it("refuses a pole another base already sits on", async () => {
    await declare(BEAR, 5000, 5000, true);
    await declare(WOLF, 9000, 9000, false);
    // Spacing would also catch this; the pole-taken check must win so the
    // reason names the real problem.
    expect(await adopt(BEAR, 9000, 9000)).toEqual({ ok: false, reason: "pole-taken" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/adopt-carried.test.ts` (from `packages/declarations`)
Expected: FAIL — `adoptCarriedTx` is not exported.

- [ ] **Step 3: Implement**

In `packages/declarations/src/store.ts` (its existing imports cover everything used), add after `releaseTx`:

```ts
export type AdoptArgs = { serverId: number; factionId: number; poleKey: string; x: number; y: number; z: number; eventId: number; at: Date };
export type AdoptOutcome = { ok: true } | { ok: false; reason: "not-carried" | "too-close" | "pole-taken" };

/**
 * Move a base the wipe carried (`carried_since` set) onto the pole the clan
 * just raised near it, in place.
 *
 * ⚠️ An UPDATE, never `releaseTx` + `declareTx`. Release-then-declare passes
 * through "no base": inside one transaction nobody sees it, but the delete
 * stamps the old pole's release grace and the insert would need the
 * savepoint dance `declareTx` does — and it would hand the row a new id, which
 * the zone consumer's sightings hang off. Same lock, same spacing query, so
 * this is still the one module that writes `declarations`.
 *
 * The radius check is the caller's: whether a raise counts as an adoption at
 * all is raise-tick's decision. This re-checks only what a concurrent writer
 * can change between the caller's read and this lock: the carried flag, the
 * neighbours, and the pole.
 *
 * Lock order (spec §4.12): the caller holds the clan's `factions` row first.
 */
export async function adoptCarriedTx(tx: Tx, a: AdoptArgs): Promise<AdoptOutcome> {
  await lockDeclarations(tx, a.serverId);
  const rows = await tx.select({ id: declarations.id, poleKey: declarations.poleKey, x: declarations.x, z: declarations.z, ownerFactionId: declarations.ownerFactionId, carriedSince: declarations.carriedSince })
    .from(declarations)
    .where(eq(declarations.serverId, a.serverId))
    .for("update");

  const own = rows.find((r) => r.ownerFactionId === a.factionId);
  if (!own || own.carriedSince === null) return { ok: false, reason: "not-carried" };
  const others = rows.filter((r) => r.id !== own.id);
  if (others.some((r) => r.poleKey === a.poleKey)) return { ok: false, reason: "pole-taken" };
  if (tooClose({ x: a.x, z: a.z }, others.map((r) => ({ x: Number(r.x), z: Number(r.z) })))) {
    return { ok: false, reason: "too-close" };
  }

  await tx.update(declarations).set({
    poleKey: a.poleKey, x: a.x.toFixed(2), y: a.y.toFixed(2), z: a.z.toFixed(2),
    evidenceEventId: a.eventId, evidenceCeremonyId: null, declaredAt: a.at, carriedSince: null,
  }).where(eq(declarations.id, own.id));
  return { ok: true };
}
```

Then check `packages/declarations/src/index.ts`: if it re-exports names explicitly, add `adoptCarriedTx`, `AdoptArgs`, `AdoptOutcome`; if it is `export * from "./store"`, nothing to do.

- [ ] **Step 4: Run to verify pass**

Run: same command as Step 2.
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/declarations
git commit -m "feat(declarations): adoptCarriedTx moves a carried base onto a new pole"
```

---

### Task 3: The wipe carries bases; guide and notes say so

**Files:**
- Modify: `apps/bot/src/wipe.ts`
- Modify: `apps/bot/test/wipe.test.ts:109-154` and the re-run tests
- Modify: `apps/web/content/guide/07-the-scoreboard.html:14-15`
- Modify: `apps/web/content/guide/13-rules-on-one-page.html:40`
- Modify: `CLAUDE.md` (the wipe row in "Where things live")

**Interfaces:**
- Consumes: `declarations.carriedSince` (Task 1).
- Produces: `WipeResult.declarationsCarried: number` replacing `declarationsDeleted`.

- [ ] **Step 1: Update the wipe test first**

In `apps/bot/test/wipe.test.ts`, in `"does §8.5 in one transaction"`:
- change `declarationsDeleted: 3` to `declarationsCarried: 3`;
- replace `expect(await db.select().from(declarations)).toEqual([]);` with:

```ts
    // The wipe keeps every base and marks it carried: the kit keeps spawning
    // at the old spot until the clan adopts a new pole (raise-tick).
    const decls = await db.select().from(declarations);
    expect(decls).toHaveLength(3);
    for (const d of decls) expect(d.carriedSince).toEqual(wipeAt);
```

Add a test after `"⚠️ wipe twice is once"`:

```ts
  it("⚠️ a skipped re-run leaves carried_since at the first wipe", async () => {
    await wipe(db, serverId, wipeAt);
    const later = new Date(wipeAt.getTime() + 60_000);
    expect((await wipe(db, serverId, later)).skipped).toBe(true);
    for (const d of await db.select().from(declarations)) expect(d.carriedSince).toEqual(wipeAt);
  });
```

Read the remaining tests in this file (`"⚠️ wipe twice is once"`, the racing test, the rollback test). Their `snapshot()` compares declaration COUNTS, which are now 3 before and after — keep them; change only an assertion that expects declarations to be gone.

- [ ] **Step 2: Run to verify failure**

Run (from `apps/bot`): `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/wipe.test.ts`
Expected: FAIL — `declarationsCarried` missing / declarations deleted.

- [ ] **Step 3: Implement in `wipeTx`**

In `apps/bot/src/wipe.ts`:
- `WipeResult`: rename `declarationsDeleted` → `declarationsCarried` (both the type and the skipped-return literal).
- Replace the doc comment's "clear every declaration" with "mark every declaration carried", and in the guard paragraph replace "closing it would clear declarations clans re-bound after the restart" with "closing it would re-mark as carried the bases clans adopted after the restart".
- Replace step (5)'s header comment with `// (5) Mark every declaration carried, after taking the declarations advisory lock.` and replace

```ts
  const declRows = await tx.delete(declarations).where(eq(declarations.serverId, serverId)).returning({ id: declarations.id });
```

with

```ts
  // ⚠️ Carried, not deleted. The wipe takes the poles but the spot is still
  // the clan's: the supply sweep keeps placing the kit at x/z, and raise-tick
  // lets the clan's first raise within CARRIED_ADOPT_RADIUS_M adopt the new
  // pole. An already-carried row (never adopted since the last wipe) is
  // re-stamped; nothing reads the timestamp beyond "is it set".
  const declRows = await tx.update(declarations)
    .set({ carriedSince: wipeAt })
    .where(eq(declarations.serverId, serverId))
    .returning({ id: declarations.id });
```

- In the returned object: `declarationsCarried: declRows.length,`.
- The sightings delete stays (wipe-scoped map state); update its comment: drop "Sightings cascade with the declarations deleted below;" and keep "the explicit delete is what clears them".

- [ ] **Step 4: Run to verify pass**

Run: same as Step 2. Expected: all wipe tests pass.

- [ ] **Step 5: Update the guide**

`apps/web/content/guide/07-the-scoreboard.html`, replace the paragraph at line 14 and the first `<li>` at line 16 with:

```html
<p>Identities and rosters do <strong>not</strong> reset. A wipe resets the world; it does not dissolve clans. A wipe takes every pole with it, but not your base: your clan keeps its spot, and your supply kit spawns there after the wipe.</p>
<ul>
<li>A clan keeps its name, tag, flag and roster, but not the flag itself: clan flags never spawn as loot, and your kit brings yours. Build a pole within {{CARRIED_ADOPT_RADIUS_M|m}} of your old base and have a member raise a white flag or your clan's flag on it. That pole is your base, with no cooldown and no confirmation step. Further away, a white flag does nothing for your clan; your own flag asks your leader to confirm a move. The {{MIN_BASE_SPACING_M|m}} rule still applies.</li>
```

(the remaining `<li>`s stay). In `13-rules-on-one-page.html:40` replace the sentence beginning "A wipe clears every base;" with:

```
A wipe keeps your base's spot: your kit spawns there, and the first member raise of a white flag (or your own) at a pole within {{CARRIED_ADOPT_RADIUS_M|m}} of it becomes your new base.
```

Read the surrounding `<li>` first and keep its sentence style; check `guide.test.ts` still passes (it fails on a hand-typed number, so the token form is required).

- [ ] **Step 6: Update CLAUDE.md**

In the "The wipe, the launch grace stamp, and a standings rebuild" row, after `i.e. one a wipe just opened)`, add: `; since 2026-10-12 the wipe KEEPS declarations and stamps \`carried_since\` instead of deleting them — see raise-tick's adopt branch and \`adoptCarriedTx\``.

- [ ] **Step 7: Run bot + web suites**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --filter=@factions/bot --filter=@factions/web --concurrency=1 --force`
Expected: PASS. Any other test that asserted a wipe deletes declarations: update it to the carried assertion, and say so in the commit message.

- [ ] **Step 8: Commit**

```bash
git add apps/bot/src/wipe.ts apps/bot/test/wipe.test.ts apps/web/content/guide CLAUDE.md
git commit -m "feat(wipe): keep bases through a wipe, marked carried"
```

---

### Task 4: raise-tick adopts a new pole near a carried base

**Files:**
- Modify: `apps/bot/src/raise-tick.ts`
- Test: `apps/bot/test/raise-tick.test.ts` (new `describe` after `"post-wipe bind (§8.5)"`)

**Interfaces:**
- Consumes: `adoptCarriedTx`, `AdoptOutcome` (Task 2); `CARRIED_ADOPT_RADIUS_M` (Task 1); `declarationForFaction` returning `carriedSince` (Task 1).
- Produces: `RaiseTickResult.adopted: number`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/bot/test/raise-tick.test.ts`, inside the top-level `describe("raiseTick")`, after the `post-wipe bind` describe. Note `seedFaction` wrote BEAR's declaration with key `P1` but coordinates 5000/5000; these tests set coordinates explicitly.

```ts
  describe("adopting a pole near a carried base", () => {
    // BEAR's old spot, carried by a wipe.
    const OLD = { x: 6000, z: 6000 };
    const NEAR = "6060.00:100.00:6040.00";   // ~72 m
    const EDGE = "6100.00:100.00:6000.00";   // exactly 100 m
    const FAR = "6101.00:100.00:6000.00";    // 101 m

    beforeEach(async () => {
      await db.update(declarations).set({
        poleKey: "6000.00:100.00:6000.00", x: "6000.00", z: "6000.00", carriedSince: ago(86_400_000),
      }).where(eq(declarations.ownerFactionId, BEAR));
    });

    it("a full member's White raise within 100 m adopts the pole: no notice, a rebound event", async () => {
      await raise(B1, "Bear1", "Flag_White", NEAR, now);
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ adopted: 1, bound: 0, noticed: 0 });
      expect(await declarationForFaction(db, BEAR)).toMatchObject({ poleKey: NEAR, carriedSince: null });
      expect((await db.select().from(factionEvents)).map((r) => r.kind)).toEqual(["rebound"]);
      expect(await db.select().from(clanNotices)).toEqual([]);
    });

    it("the clan's own flag at exactly 100 m adopts too", async () => {
      await raise(B1, "Bear1", "Flag_Bear", EDGE, now);
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ adopted: 1 });
      expect(await declarationForFaction(db, BEAR)).toMatchObject({ poleKey: EDGE, carriedSince: null });
    });

    it("101 m away the clan's own flag falls through to the rebind proposal, and the base stays carried", async () => {
      await raise(B1, "Bear1", "Flag_Bear", FAR, now);
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ adopted: 0, noticed: 1 });
      expect((await db.select({ k: clanNotices.kind }).from(clanNotices))[0]).toEqual({ k: "rebind_proposed" });
      expect(await declarationForFaction(db, BEAR)).toMatchObject({ x: "6000.00", carriedSince: ago(86_400_000) });
    });

    it("101 m away a White raise does nothing for the clan", async () => {
      await raise(B1, "Bear1", "Flag_White", FAR, now);
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ adopted: 0, bound: 0, noticed: 0 });
      expect(await declarationForFaction(db, BEAR)).toMatchObject({ x: "6000.00" });
    });

    it("a dormant clan's adoption revives it", async () => {
      await db.update(factions).set({ status: "dormant", dormantSince: ago(86_400_000), dormantReason: "inactive" }).where(eq(factions.id, BEAR));
      await raise(B1, "Bear1", "Flag_White", NEAR, now);
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ adopted: 1 });
      const [bear] = await db.select({ s: factions.status }).from(factions).where(eq(factions.id, BEAR));
      expect(bear).toEqual({ s: "active" });
      expect((await db.select().from(factionEvents).orderBy(factionEvents.id)).map((r) => r.kind)).toEqual(["rebound", "revived"]);
    });

    it("a pending member, a foreign flag, or a clanless player adopts nothing", async () => {
      const PEND = "PEND-DAYZID-000000000000000000000000";
      await db.insert(factionMembers).values({ factionId: BEAR, serverId, dayzId: PEND, discordId: "dPend", role: "member", joinedAt: now, status: "pending", pendingSince: now });
      await raise(PEND, "Pendy", "Flag_White", NEAR, now);
      await raise(B1, "Bear1", "Flag_Wolf", NEAR, new Date(now.getTime() + 1000));
      await raise(W1, "Wanderer", "Flag_White", NEAR, new Date(now.getTime() + 2000));
      expect((await raiseTick(db, { siteBaseUrl: SITE })).adopted).toBe(0);
      expect(await declarationForFaction(db, BEAR)).toMatchObject({ x: "6000.00", carriedSince: ago(86_400_000) });
    });

    it("⚠️ a clan whose base is NOT carried is never moved by a nearby White raise", async () => {
      await db.update(declarations).set({ carriedSince: null }).where(eq(declarations.ownerFactionId, BEAR));
      await raise(B1, "Bear1", "Flag_White", NEAR, now);
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ adopted: 0, bound: 0 });
      expect(await declarationForFaction(db, BEAR)).toMatchObject({ x: "6000.00" });
    });

    it("too close to another base adopts nothing and writes nothing", async () => {
      const wolf = await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", poleKey: "6200.00:100.00:6040.00", x: 6200, y: 100, z: 6040, createdAt: now, activatedAt: now });
      const rows = (await db.execute(sql`select coalesce(max(id), 0)::int as n from events`)) as unknown as { n: number }[];
      await db.execute(sql`update consumer_cursors set last_event_id = ${rows[0]!.n} where consumer_name = 'raise-consumer'`);
      await raise(B1, "Bear1", "Flag_White", NEAR, now); // 140 m from WOLF
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ adopted: 0 });
      expect(await declarationForFaction(db, BEAR)).toMatchObject({ x: "6000.00", carriedSince: ago(86_400_000) });
      expect(await declarationForFaction(db, wolf.id)).toMatchObject({ x: "6200.00" });
      expect(await db.select().from(factionEvents)).toHaveLength(0);
    });

    it("⚠️ a replay after the adoption moves nothing and writes no second rebound", async () => {
      await raise(B1, "Bear1", "Flag_White", NEAR, now);
      await raiseTick(db, { siteBaseUrl: SITE });
      await db.execute(sql`update consumer_cursors set last_event_id = ${cursorAfterSetup} where consumer_name = 'raise-consumer'`);
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ adopted: 0 });
      expect(await declarationForFaction(db, BEAR)).toMatchObject({ poleKey: NEAR });
      expect(await db.select().from(factionEvents)).toHaveLength(1);
      expect(await db.select().from(clanNotices)).toEqual([]);
    });

    it("⚠️ only the raiser's own clan adopts, never a neighbour's carried base", async () => {
      // WOLF is carried 210 m from NEAR (clear of the spacing rule); B1 is in
      // BEAR. BEAR adopts; WOLF is untouched.
      const wolf = await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", poleKey: "6270.00:100.00:6040.00", x: 6270, y: 100, z: 6040, createdAt: now, activatedAt: now });
      await db.update(declarations).set({ carriedSince: ago(86_400_000) }).where(eq(declarations.ownerFactionId, wolf.id));
      const rows = (await db.execute(sql`select coalesce(max(id), 0)::int as n from events`)) as unknown as { n: number }[];
      await db.execute(sql`update consumer_cursors set last_event_id = ${rows[0]!.n} where consumer_name = 'raise-consumer'`);
      await raise(B1, "Bear1", "Flag_White", NEAR, now);
      expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ adopted: 1 });
      expect(await declarationForFaction(db, wolf.id)).toMatchObject({ x: "6270.00", carriedSince: ago(86_400_000) });
    });
  });
```

Distances, for checking: NEAR is 72 m from OLD; the spacing test's WOLF (6200, 6040) is 140 m from NEAR; the neighbour test's WOLF (6270, 6040) is 210 m from NEAR.

- [ ] **Step 2: Run to verify failure**

Run (from `apps/bot`): `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/raise-tick.test.ts`
Expected: the new tests FAIL (`adopted` undefined); existing tests pass.

- [ ] **Step 3: Implement**

In `apps/bot/src/raise-tick.ts`:

Imports:

```ts
import { adoptCarriedTx, declarationForFaction, declareTx } from "@factions/declarations";
import { CARRIED_ADOPT_RADIUS_M, FLAG_DOWN_MS, NEUTRAL_FLAG, distance2d } from "@factions/domain";
```

Result type and initialiser: add `adopted: number` / `adopted: 0`, and in the counting block at the end of the loop add `else if (r === "adopted") out.adopted++;`.

Update the doc comment's order list to:

```
 *   1. the pole is a clan's declaration → member/non-member branch
 *   2. else the pole is a solo declaration → non-member DM
 *   3. else the raiser's clan has a carried base within CARRIED_ADOPT_RADIUS_M → adopt
 *   4. else White → bind a baseless clan; the clan's texture → proposal or colors elsewhere
```

Insert, immediately after the `if (decl?.ownerDayzId) { … }` block and before the `// Undeclared pole, White flag:` comment:

```ts
        // Undeclared pole near the raiser's own carried base (the wipe kept
        // the spot, not the pole): the clan's first White or own-flag raise
        // within CARRIED_ADOPT_RADIUS_M is its new base, no confirmation.
        // ⚠️ Keyed off the RAISER's clan, never "any carried base nearby": a
        // White raise beside a neighbour's kit must not move the neighbour.
        // ⚠️ FOR UPDATE per §4.12, factions before adoptCarriedTx's
        // declarations lock. Falls through on anything else, so a raise
        // further out is still an ordinary bind, proposal or nothing.
        const [mine] = await tx.select({ id: factions.id, name: factions.name, tag: factions.tag, texture: factions.texture, status: factions.status }).from(factions)
          .innerJoin(factionMembers, eq(factionMembers.factionId, factions.id))
          .where(and(
            eq(factions.serverId, ev.serverId), sql`${factions.status} in ('active','dormant')`,
            eq(factionMembers.dayzId, p.dayzId), eq(factionMembers.status, "full"),
          ))
          .for("update", { of: factions });
        if (mine && (p.texture === NEUTRAL_FLAG || p.texture === mine.texture)) {
          const carried = await declarationForFaction(tx, mine.id);
          if (carried?.carriedSince && distance2d({ x: p.pole.x, z: p.pole.z }, { x: Number(carried.x), z: Number(carried.z) }) <= CARRIED_ADOPT_RADIUS_M) {
            const adopted = await adoptCarriedTx(tx, {
              serverId: ev.serverId, factionId: mine.id, poleKey: p.poleKey, x: p.pole.x, y: p.pole.y, z: p.pole.z, eventId: ev.id, at: ev.occurredAt,
            });
            if (!adopted.ok) {
              console.info(`raise-tick: adopt refused for faction ${mine.id} at ${p.poleKey}: ${adopted.reason}`);
              return done(null);
            }
            await afterRebindTx(tx, ev, p, mine);
            return done("adopted" as const);
          }
        }
```

Refactor `bindTx` so the event-and-revive tail is shared:

```ts
async function bindTx(tx: Tx, ev: { id: number; serverId: number; occurredAt: Date }, p: FlagPayload, clan: BindingClan): Promise<"bound" | null> {
  const declared = await declareTx(tx, { /* unchanged */ });
  if (!declared.ok) { /* unchanged */ return null; }
  await afterRebindTx(tx, ev, p, clan);
  return "bound";
}

/** The `rebound` feed row and, for a dormant clan, the revive — shared by a bind and an adoption. */
async function afterRebindTx(tx: Tx, ev: { serverId: number; occurredAt: Date }, p: FlagPayload, clan: BindingClan): Promise<void> {
  await appendFactionEventTx(tx, {
    serverId: ev.serverId, factionId: clan.id, kind: "rebound", occurredAt: ev.occurredAt,
    payload: { name: clan.name, tag: clan.tag, texture: clan.texture },
  });
  if (clan.status === "dormant") {
    await reviveFactionTx(tx, clan.id, ev.occurredAt, { dayzId: p.dayzId, gamertag: p.gamertag });
  }
}
```

Then check every caller of `raiseTick`'s result (`grep -rn "raiseTick(" apps/bot/src`), e.g. a log line in `discord.ts`: if it prints fields, add `adopted`.

- [ ] **Step 4: Run to verify pass**

Run: same as Step 2. Expected: all raise-tick tests pass, old and new.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/raise-tick.ts apps/bot/test/raise-tick.test.ts apps/bot/src/discord.ts
git commit -m "feat(raise-tick): a clan's first raise near its carried base adopts the pole"
```

---

### Task 5: `pnpm clear-bases`, runbook, changelog

**Files:**
- Create: `apps/bot/src/clear-bases.ts`
- Create: `scripts/clear-bases.ts`
- Modify: root `package.json` (scripts)
- Test: `apps/bot/test/clear-bases.test.ts`
- Create: `docs/deploy/2026-10-12-carry-bases.md`
- Modify: `CHANGELOG.md`, `CLAUDE.md` (wipe row)

**Interfaces:**
- Consumes: `releaseTx`, `lockDeclarations` from `@factions/declarations`.
- Produces:
  ```ts
  export type ClearedBase = { owner: string; declaredAt: Date; x: number; z: number };
  export type ClearBasesResult = { dryRun: boolean; released: ClearedBase[]; clansCleared: number };
  export async function clearBasesBefore(db: Database, serverId: number, before: Date, opts: { at: Date; dryRun: boolean }): Promise<ClearBasesResult>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/bot/test/clear-bases.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, declarations, factionMembers, type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { clearBasesBefore } from "../src/clear-bases.js";
import { seedFaction } from "./seed.js";

const URL = requireTestDatabaseUrl();
const cutoff = new Date("2026-10-08T00:00:00Z");
const before = new Date("2026-09-14T00:00:00Z");
const after = new Date("2026-10-10T00:00:00Z");
const at = new Date("2026-10-12T20:00:00Z");

describe("clearBasesBefore", () => {
  let db: Database;
  let serverId = 0;
  let OLD = 0;
  let NEW = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table declarations, poles, faction_members, events, adm_files, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "chernarusplus", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    OLD = (await seedFaction(db, { serverId, tag: "OLD", texture: "Flag_Old", poleKey: "2000.00:100.00:2000.00", x: 2000, y: 100, z: 2000, createdAt: before, activatedAt: before, status: "dormant", dormantSince: before })).id;
    await db.update(factions).set({ flagDownSince: before, flagDownByDayzId: "X", disbandWarnedAt: before }).where(eq(factions.id, OLD));
    await db.insert(factionMembers).values({ factionId: OLD, serverId, dayzId: "M", discordId: "dM", role: "leader", joinedAt: before, status: "full" });
    NEW = (await seedFaction(db, { serverId, tag: "NEW", texture: "Flag_New", poleKey: "8000.00:100.00:8000.00", x: 8000, y: 100, z: 8000, createdAt: after, activatedAt: after })).id;
  });

  it("releases only bases declared before the cutoff and clears their clans' flag-down state", async () => {
    const r = await clearBasesBefore(db, serverId, cutoff, { at, dryRun: false });
    expect(r).toEqual({ dryRun: false, clansCleared: 1, released: [{ owner: "OLD", declaredAt: before, x: 2000, z: 2000 }] });
    const left = await db.select({ f: declarations.ownerFactionId }).from(declarations);
    expect(left).toEqual([{ f: NEW }]);
    const [old] = await db.select().from(factions).where(eq(factions.id, OLD));
    expect(old).toMatchObject({ status: "dormant", flagDownSince: null, flagDownByDayzId: null, disbandWarnedAt: null });
    expect(await db.select().from(factionMembers)).toHaveLength(1); // roster untouched
  });

  it("⚠️ a dry run reports the same rows and writes nothing", async () => {
    const r = await clearBasesBefore(db, serverId, cutoff, { at, dryRun: true });
    expect(r).toMatchObject({ dryRun: true, released: [{ owner: "OLD" }] });
    expect(await db.select().from(declarations)).toHaveLength(2);
    const [old] = await db.select({ f: factions.flagDownSince }).from(factions).where(eq(factions.id, OLD));
    expect(old!.f).toEqual(before);
  });

  it("is a no-op the second time", async () => {
    await clearBasesBefore(db, serverId, cutoff, { at, dryRun: false });
    expect(await clearBasesBefore(db, serverId, cutoff, { at, dryRun: false })).toEqual({ dryRun: false, released: [], clansCleared: 0 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run (from `apps/bot`): `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/clear-bases.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/bot/src/clear-bases.ts`**

```ts
import type { Database } from "@factions/db";
import { declarations, factions } from "@factions/db";
import { lockDeclarations, releaseTx } from "@factions/declarations";
import { and, asc, eq, inArray, lt } from "drizzle-orm";

export type ClearedBase = { owner: string; declaredAt: Date; x: number; z: number };
export type ClearBasesResult = { dryRun: boolean; released: ClearedBase[]; clansCleared: number };

/** Thrown to roll a dry run back after it has done (and counted) everything. */
class DryRun extends Error {
  constructor(readonly result: ClearBasesResult) { super("dry run"); }
}

/**
 * Release every base declared before `before` — the one-off for a map change
 * (Livonia → Chernarus, 2026-10-08), when old coordinates point at nothing on
 * the new map. The wipe keeps bases; this is the tool for when it should not.
 *
 * Each row goes through `releaseTx`, the path disband and unlink use, so this
 * adds no writer of `declarations` and sightings/zone incidents cascade as
 * they always do. A released clan's flag-down state is cleared like the
 * wipe's step (7): its base is gone, so a raid clock on it means nothing.
 * Rosters, statuses and Discord structure are untouched.
 *
 * Lock order §4.12: the server's `factions` rows FOR UPDATE, then
 * `lockDeclarations`, then `releaseTx` (declarations → poles).
 */
export async function clearBasesBefore(db: Database, serverId: number, before: Date, opts: { at: Date; dryRun: boolean }): Promise<ClearBasesResult> {
  try {
    return await db.transaction(async (tx) => {
      await tx.select({ id: factions.id }).from(factions).where(eq(factions.serverId, serverId)).for("update");
      await lockDeclarations(tx, serverId);
      const rows = await tx.select({
        ownerFactionId: declarations.ownerFactionId, ownerDayzId: declarations.ownerDayzId, tag: factions.tag,
        declaredAt: declarations.declaredAt, x: declarations.x, z: declarations.z,
      }).from(declarations)
        .leftJoin(factions, eq(factions.id, declarations.ownerFactionId))
        .where(and(eq(declarations.serverId, serverId), lt(declarations.declaredAt, before)))
        .orderBy(asc(declarations.declaredAt));

      for (const r of rows) {
        await releaseTx(tx, r.ownerFactionId !== null ? { factionId: r.ownerFactionId } : { dayzId: r.ownerDayzId!, serverId }, opts.at);
      }
      const clanIds = rows.flatMap((r) => (r.ownerFactionId === null ? [] : [r.ownerFactionId]));
      const cleared = clanIds.length === 0 ? [] : await tx.update(factions)
        .set({ flagDownSince: null, flagDownByDayzId: null, disbandWarnedAt: null })
        .where(inArray(factions.id, clanIds))
        .returning({ id: factions.id });

      const result: ClearBasesResult = {
        dryRun: opts.dryRun,
        released: rows.map((r) => ({ owner: r.tag ?? r.ownerDayzId!, declaredAt: r.declaredAt, x: Number(r.x), z: Number(r.z) })),
        clansCleared: cleared.length,
      };
      if (opts.dryRun) throw new DryRun(result);
      return result;
    });
  } catch (err) {
    if (err instanceof DryRun) return err.result;
    throw err;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: same as Step 2. Expected: 3 passed.

- [ ] **Step 5: The script**

Create `scripts/clear-bases.ts`, modelled on `scripts/wipe.ts`:

```ts
/**
 * Release every base declared before a cutoff — the one-off for a map change.
 *
 *   DATABASE_URL=postgres://... pnpm clear-bases --server 1 --before 2026-10-08T00:00:00Z --dry-run
 *
 * `--before` is REQUIRED, with no default: it decides which bases a live
 * server loses. Usage errors exit 2. Prints the bases (with coordinates — this
 * is an operator's terminal, never a channel) as JSON.
 *
 * ⚠️ Refuses a URL whose database is not `factions_live` unless
 * `--allow-test-db` is passed, as `wipe` and `launch` do.
 */
import { createClient } from "@factions/db";
import { clearBasesBefore } from "../apps/bot/src/clear-bases.js";

const args = process.argv.slice(2);
const USAGE = "usage: clear-bases --server <id> --before <ISO> [--dry-run] [--allow-test-db]";
function usageError(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}
const valueOf = (flag: string) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

const serverArg = valueOf("--server");
if (!serverArg || !/^\d+$/u.test(serverArg)) usageError(`--server is missing or not a positive integer (got: ${serverArg ?? "nothing"})`);
const beforeArg = valueOf("--before");
if (!beforeArg) usageError("--before is required (there is no default).");
const before = new Date(beforeArg);
if (Number.isNaN(before.getTime())) usageError(`--before is not a valid date (got: ${beforeArg})`);

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set.");
if (!args.includes("--allow-test-db") && !url.endsWith("/factions_live")) {
  throw new Error(`DATABASE_URL does not end in /factions_live. Pass --allow-test-db to run against a non-production database.`);
}

const db = createClient(url);
const result = await clearBasesBefore(db, Number(serverArg), before, { at: new Date(), dryRun: args.includes("--dry-run") });
console.log(JSON.stringify(result, null, 2));
await db.$client.end();
```

(The error message deliberately does not echo the URL; it carries credentials.) In root `package.json` scripts, after `"launch"`: `"clear-bases": "tsx scripts/clear-bases.ts",`.

Smoke-test against the test database:
Run: `DATABASE_URL="postgres://factions:factions@localhost:5434/factions_test_bot" pnpm clear-bases --server 1 --before 2026-10-08T00:00:00Z --dry-run --allow-test-db`
Expected: JSON with `"dryRun": true` (an empty `released` is fine). And `pnpm clear-bases --server 1` exits 2 with the usage line.

- [ ] **Step 6: Runbook**

Create `docs/deploy/2026-10-12-carry-bases.md`:

```markdown
# Carry bases through the wipe — deploy and Livonia cleanup

Spec: `docs/superpowers/specs/2026-10-12-carry-bases-through-wipe-design.md`.

## 1. Deploy

The release carries migration 0065 (`declarations.carried_since`, nullable,
additive). `deploy-release.sh` applies it with the bot stopped. Nothing else.

## 2. Clear the Livonia bases (once, after the deploy)

On the host, in `/opt/clan-wars`, with `DATABASE_URL` from `.env`:

    pnpm clear-bases --server 1 --before 2026-10-08T00:00:00Z --dry-run

Expect exactly the Livonia-era bases (2026-10-12: SKULL, ADM, VOLK, Z2,
WOOKI, all declared in September). Anything declared on or after
2026-10-08 in that list means the cutoff is wrong: stop.

Then the same command without `--dry-run`. The bot can keep running: every
writer takes the same declarations lock.

## 3. Check

    select count(*) from declarations where declared_at < '2026-10-08';  -- 0

Within one ingest sweep `faction-supplies.json` re-uploads without those
clans (`supply_uploads.uploaded_at` moves). Tell VOLK their 2026-10-12 raise
was before the cleanup: one full member raises a white flag again.

## Rollback

The release: the column is nullable and unread by older code. The cleanup
is not reversible except from the deploy's pre-migration dump; the bases it
removes point at nothing on Chernarus.
```

- [ ] **Step 7: Changelog and CLAUDE.md**

`CHANGELOG.md`, under `## [Unreleased]`:

```markdown
### Changed

- A wipe no longer takes your base. Your clan keeps its spot and your supply kit spawns there. Build a pole within 100 m and raise a white flag or your clan's flag on it, and that pole is your base. No confirmation needed.
- Bases left over from Livonia are cleared. If your clan had one, a single member raising a white flag at a free pole on Chernarus now makes that your base.
```

`CLAUDE.md` wipe row: append `` `pnpm clear-bases --server <id> --before <ISO> [--dry-run]` (`scripts/clear-bases.ts`) releases every base declared before a cutoff — for a map change, which the wipe no longer handles; same `factions_live` guard. Runbook `docs/deploy/2026-10-12-carry-bases.md`. ``

- [ ] **Step 8: Full gate**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`
Expected: 32/32 tasks successful (check the count).

- [ ] **Step 9: Commit**

```bash
git add apps/bot/src/clear-bases.ts apps/bot/test/clear-bases.test.ts scripts/clear-bases.ts package.json docs/deploy/2026-10-12-carry-bases.md CHANGELOG.md CLAUDE.md
git commit -m "feat: pnpm clear-bases for a map change, runbook and changelog"
```
