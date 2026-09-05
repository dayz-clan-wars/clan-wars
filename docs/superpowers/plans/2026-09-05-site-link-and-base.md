# Site Link and Base (Increment 2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A linked player can link their character on the site (autocomplete, three emotes, ten minutes, a page that polls every 5 s), unlink from `/me`, and declare or release a solo base on `/base` — every write going through `packages/roster`, every rule enforced inside the package, nothing duplicated from the bot.

**Architecture:** The two stores the site needs already exist inside `apps/bot` — `declaration-store.ts` (the only writer of `declarations`) and `store.ts` (`PgVerificationStore`). A package cannot import an app, so both move to packages the bot and `packages/roster` share: the declaration store becomes `@factions/declarations`; the verification store joins the existing `@factions/verification`, together with the challenge-issuing decision logic lifted out of `handleLink` as a pure-outcome function the bot's command now merely formats. Migration 0021 makes `verification_challenges.guild_id/channel_id` nullable so the site can issue a challenge with no channel. `packages/roster` then adds eight exports: `startLink`, `cancelLink`, `unlink`, `linkStatus`, `searchGamertags`, `baseFor`, `declareSolo`, `releaseSolo`. The site adds `/link` (a client component polling `/api/link/status`), `/base` (plain forms posting to two route handlers) and an unlink form on `/me`.

**Tech Stack:** pnpm workspace + turbo; TypeScript raw-TS packages (`exports: ./src/index.ts`, extensionless relative imports wherever `apps/web` transpiles them); drizzle-orm 0.36 over postgres.js; drizzle-kit for the migration; vitest with per-package test databases; Next 16 (App Router, Turbopack) with Tailwind v4 `@theme` tokens; the middleware gate from the discord-login increment.

**Spec:** `docs/superpowers/specs/2026-09-04-clan-wars-target-state-design.md` — §4.11 (`verification_challenges` changed), §4.12 (lock order), §5.2 (base state machine, solo declare), §5.5 (link challenge, unlink), §10.1–10.2 (`/link`, `/me`, `/base`), §10.4 (the capability package), §13 (staged race tests), §15 row 2b. Predecessor plan: `docs/superpowers/plans/2026-09-05-site-foundation.md` (2a), whose "Why increment 2 is three plans" table defines this plan's scope.

## Why 2b is these nine tasks

| Task | Ships | Why it is its own task |
|---|---|---|
| 1 | `@factions/declarations` — the declaration store as a package, plus `declareSoloTx` | Roster needs `raisedPolesFor`/`declareSolo`/`releaseTx`/`lockDeclarations`; an app cannot be imported. Pure move, reviewable as a rename |
| 2 | `@factions/verification` gains `PgVerificationStore`, `searchUnlinkedPlayers`, `latestChallenge` | Same reason for the challenge store; two new reads the site needs and the bot does not |
| 3 | Migration 0021 (nullable `guild_id`/`channel_id`); inbox 7's refusal path; notifier fallbacks | Schema change with its own runbook step; the bot's DM path has to survive a challenge with no channel |
| 4 | `issueChallenge` — `handleLink`'s decision core as a pure-outcome function; the bot formats | The draw cap, the switch-cancel ordering and the two partial-index disambiguations are security logic; they must exist once |
| 5 | Roster link writes: `startLink`, `cancelLink`, `unlink`, `linkStatus`, `searchGamertags` | First writes in the package; unlink releases a solo base inside the same transaction |
| 6 | Roster base writes: `baseFor`, `declareSolo`, `releaseSolo`, with the staged race against `unlink` | New writer pair on the lock order → §13 race test |
| 7 | `/link` page + `/api/link/*` + unlink on `/me` | The user-visible flow; client polling; copy |
| 8 | `/base` page + `/api/base/*` | Forms, no client JS; the guide's 200 m wording |
| 9 | Deploy runbook, CLAUDE.md, spec §15, READMEs | Docs travel with the code |

**Deliberately not here** (recorded in spec §15 by Task 9): the `@Linked` Discord role on link/unlink and the nickname clear on a site unlink — both need the bot to react to a site write, which is the `clan_notices` queue of increment 3; the "your declaration lapsed — raise and re-declare" copy on `/base` — a lapse leaves no row today, so the site cannot know one happened until increment 3's notice exists; retiring the bot's `/link` and `/unlink` commands and `DISCORD_LINK_TTL_MS` (2c); the `/faction` token exclusion in `vocabulary.test.ts` (2c).

## Global Constraints

- **`apps/web` imports `@factions/roster` and never `@factions/db`** (spec §10.4). The roster export list is the permission list, pinned by name in `packages/roster/test/exports.test.ts` and `apps/web/test/smoke.test.ts`; both change together, on purpose. Final allowlist after this plan: `baseFor, cancelLink, declareSolo, linkStatus, releaseSolo, searchGamertags, startLink, unlink, viewerFor`.
- **Every rule lives inside the package's writes, not in a page** (spec §10.4 ⚠️): the roster-row refusal on unlink, the 200 m rule, the one-declaration-per-player rule, the draw cap. Route handlers and pages only format outcomes.
- **Player-facing strings say "clan", never "faction"** (spec §2). `apps/web/test/copy-vocabulary.test.ts` scans `app/`, `src/`, `lib/`; `apps/bot/test/vocabulary.test.ts` scans the listed bot files.
- **Every number comes from `packages/domain/src/rules.ts`**: `LINK_EMOTES = 3`, `LINK_TTL_MS = 10 min`, `MIN_BASE_SPACING_M = 200`, `RELEASED_POLE_GRACE_MS = 3 d`, `SOLO_LAPSE_MS = 7 d`, `WATCH_ZONE_RADIUS_M = 100`. No module states one of these as a literal — copy that prints a number interpolates the constant. The 5 s poll interval and the draw cap (`MAX_DRAWS_PER_TARGET = 3` per `DRAW_WINDOW_MS = 24 h`) are not guide numbers and live where this plan puts them.
- **Lock order (spec §4.12):** `factions → declarations → poles → faction_members → … → faction_events`. `declarations` is written by `declareTx` and nothing else. `lockDeclarations(tx, serverId)` is taken before `releaseTx` in any transaction that might later call `declareTx`, and by every writer this plan adds that touches `declarations`.
- **Every declaration cites evidence** (`declarations_one_evidence`): a solo declaration cites a `flag.raised` event by the declarant at that pole, found by `raisedPolesFor` inside the same transaction.
- **Pages that read the viewer are `force-dynamic`** (`apps/web/test/request-time-rendering.test.ts`). Every `/api/link/*` and `/api/base/*` response carries `Cache-Control: no-store, private`. Pole coordinates shown on `/base` are the viewer's own raises and nobody else's.
- **Extensionless relative imports in every package `apps/web` transpiles** (`apps/web/test/transpiled-imports.test.ts`). This plan adds `@factions/declarations` and `@factions/verification` to `transpilePackages`; both must use extensionless specifiers in `src/`.
- **Nothing applies migrations in production.** 0021 is applied by hand per the runbook (Task 9). Tests apply it via `runMigrations`; no `TEST_DATABASE_FRESH=1` is needed because 0021 is new, not edited.
- **The full gate**, run after every task from the worktree root: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`. Expect **26/26** from Task 1 onward (`packages/declarations` adds `typecheck` and `test`; `packages/verification` was already counted). Ports 5432/5433 belong to other projects; `factions_live` is production.
- **Commit trailers** on every commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Svc2Dv7g1XwWi8CSuY4h5e
  ```

## File structure

**Moved**
- `apps/bot/src/declaration-store.ts` → `packages/declarations/src/store.ts` (Task 1)
- `apps/bot/test/declaration-store.test.ts`, `apps/bot/test/solo-declaration.test.ts` → `packages/declarations/test/` (Task 1)
- `apps/bot/src/store.ts` → `packages/verification/src/store.ts`; `apps/bot/test/store.test.ts` → `packages/verification/test/store.test.ts` (Task 2)

**Created**
- `packages/declarations/{package.json,tsconfig.json,vitest.config.ts,src/index.ts}` (Task 1)
- `packages/verification/vitest.config.ts`, `packages/verification/src/issue.ts`, `packages/verification/test/issue.test.ts` (Tasks 2, 4)
- `packages/db/migrations/0021_site_challenges.sql` (Task 3)
- `packages/roster/src/{server.ts,link.ts,base.ts}`, `packages/roster/test/{link.test.ts,base.test.ts}` (Tasks 5, 6)
- `apps/web/lib/api.ts`, `apps/web/lib/link-copy.ts`, `apps/web/lib/base-copy.ts`, `apps/web/test/{link-copy,base-copy}.test.ts` (Tasks 7, 8)
- `apps/web/app/link/{page.tsx,link-flow.tsx}`, `apps/web/app/api/link/{search,start,cancel,status,unlink}/route.ts` (Task 7)
- `apps/web/app/base/page.tsx`, `apps/web/app/api/base/{declare,release}/route.ts` (Task 8)
- `docs/deploy/2026-09-05-site-link-and-base.md` (Task 9)

**Modified**
- Bot import sites of the two stores; `apps/bot/src/commands.ts` (formats `issueChallenge` outcomes); `apps/bot/src/discord.ts` (sender with a nullable channel, guild fallback for the rename, the already-linked message); `apps/bot/src/notify.ts`; `apps/bot/package.json`
- `packages/db/src/schema.ts`, `packages/verification/{package.json,tsconfig.json,src/index.ts}`, `packages/roster/{package.json,src/index.ts}`, both export pins
- `apps/web/next.config.ts`, `apps/web/app/me/page.tsx`
- `CLAUDE.md`, `apps/bot/README.md`, `apps/web/README.md`, spec §15, `docs/superpowers/plans/PLAN-3-INBOX.md`

---

### Task 1: `@factions/declarations` — the declaration store as a package

**Files:**
- Create: `packages/declarations/package.json`, `packages/declarations/tsconfig.json`, `packages/declarations/vitest.config.ts`, `packages/declarations/src/index.ts`
- Move: `apps/bot/src/declaration-store.ts` → `packages/declarations/src/store.ts`
- Move: `apps/bot/test/declaration-store.test.ts` → `packages/declarations/test/declaration-store.test.ts`; `apps/bot/test/solo-declaration.test.ts` → `packages/declarations/test/solo-declaration.test.ts`
- Modify: `apps/bot/src/{faction-store,roster-store,ceremony-store,rebind-store,discord}.ts` (import specifier), `apps/bot/test/{faction-commands,feed-writers-claim,rebind-store}.test.ts` (import specifier), `apps/bot/package.json`, `packages/roster/package.json`, `apps/web/next.config.ts`, `CLAUDE.md:41`

**Interfaces:**
- Consumes: nothing new.
- Produces: `@factions/declarations` exporting everything `declaration-store.ts` exported (`Tx`, `Owner`, `DeclareArgs`, `DeclareOutcome`, `Declaration`, `RaisedPole`, `lockDeclarations`, `declareTx`, `releaseTx`, `declarationForFaction`, `declarationForPlayer`, `raisedPolesFor`, `declareSolo`, `lapseSolos`, `publicPoles`) plus the new `declareSoloTx(tx: Tx, a: { serverId: number; dayzId: string; poleKey: string; at: Date }): Promise<DeclareOutcome | { ok: false; reason: "no-raise" | "in-clan" }>` — the body of today's `declareSolo` without the transaction, so Task 6 can run it inside a transaction that already holds `lockDeclarations` and has read the caller's link.

- [ ] **Step 1: Create the package skeleton**

`packages/declarations/package.json`:
```json
{
  "name": "@factions/declarations",
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit", "test": "vitest run" },
  "dependencies": {
    "@factions/db": "workspace:*",
    "@factions/domain": "workspace:*",
    "drizzle-orm": "^0.36.0"
  },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^2.1.0" }
}
```

`packages/declarations/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "types": ["node"] },
  "include": ["src", "test"]
}
```

`packages/declarations/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

// ⚠️ `globalSetup` creates this package's own test database
// (`factions_test_declarations`). Without it the suites cannot connect at
// all, which is the intended failure — see inbox item 21 and packages/db.
export default defineConfig({
  test: {
    fileParallelism: false,
    globalSetup: ["../db/src/test-setup.ts"],
  },
});
```

`packages/declarations/src/index.ts`:
```ts
/**
 * @factions/declarations — the ONLY writer of the `declarations` table
 * (target spec §4.1, §14), shared by the bot and by @factions/roster.
 *
 * It left apps/bot in increment 2b because the site's solo declare and
 * unlink need `declareTx`/`releaseTx`, and a package cannot import an app.
 * Nothing about the rules moved with it: the 200 m check, the advisory lock
 * and the grace stamps are exactly where they were, in store.ts.
 */
export * from "./store";
```

- [ ] **Step 2: Move the store and its tests**

```bash
git mv apps/bot/src/declaration-store.ts packages/declarations/src/store.ts
git mv apps/bot/test/declaration-store.test.ts packages/declarations/test/declaration-store.test.ts
git mv apps/bot/test/solo-declaration.test.ts packages/declarations/test/solo-declaration.test.ts
```

In both moved tests, change `from "../src/declaration-store.js"` to `from "../src/store"`. The store itself has no relative imports; leave its body untouched in this step.

- [ ] **Step 3: Add `declareSoloTx`, keeping `declareSolo` as its wrapper**

In `packages/declarations/src/store.ts`, replace the existing `declareSolo` with:

```ts
/**
 * A solo's declaration, inside a transaction the CALLER owns. Use this when
 * the same transaction must first take `lockDeclarations` and read something
 * else — @factions/roster's `declareSolo` reads the caller's identity link
 * under that lock so an `unlink` racing it cannot leave a declaration with no
 * link behind it. Callers that need nothing else use `declareSolo` below.
 */
export async function declareSoloTx(tx: Tx, a: { serverId: number; dayzId: string; poleKey: string; at: Date }):
  Promise<DeclareOutcome | { ok: false; reason: "no-raise" | "in-clan" }> {
  // Rule 3: in a clan, your declaration is the clan's. Checked inside the
  // transaction so an accept landing at the same instant cannot slip past.
  const [member] = await tx.select({ id: factionMembers.id }).from(factionMembers)
    .where(and(eq(factionMembers.serverId, a.serverId), eq(factionMembers.dayzId, a.dayzId)));
  if (member) return { ok: false as const, reason: "in-clan" as const };
  const raise = (await raisedPolesFor(tx, a.serverId, a.dayzId)).find((r) => r.poleKey === a.poleKey);
  if (!raise) return { ok: false as const, reason: "no-raise" as const };
  return declareTx(tx, {
    serverId: a.serverId, poleKey: a.poleKey, x: raise.x, y: raise.y, z: raise.z,
    owner: { dayzId: a.dayzId }, evidence: { eventId: raise.eventId }, at: a.at,
  });
}

/** A solo's declaration: the same pole binding a clan gets, evidenced by a raise. */
export async function declareSolo(db: Database, a: { serverId: number; dayzId: string; poleKey: string; at: Date }):
  Promise<DeclareOutcome | { ok: false; reason: "no-raise" | "in-clan" }> {
  return db.transaction((tx) => declareSoloTx(tx, a));
}
```

- [ ] **Step 4: Repoint the bot and add the dependency**

```bash
sed -i '' 's#from "./declaration-store.js"#from "@factions/declarations"#' \
  apps/bot/src/faction-store.ts apps/bot/src/roster-store.ts apps/bot/src/ceremony-store.ts \
  apps/bot/src/rebind-store.ts apps/bot/src/discord.ts
sed -i '' 's#from "../src/declaration-store.js"#from "@factions/declarations"#' \
  apps/bot/test/faction-commands.test.ts apps/bot/test/feed-writers-claim.test.ts apps/bot/test/rebind-store.test.ts
grep -rn "declaration-store" apps packages --include='*.ts' --exclude-dir=node_modules   # expect no output
```

In `apps/bot/package.json` add `"@factions/declarations": "workspace:*"` to `dependencies` (alphabetical, before `@factions/db`). Add the same line to `packages/roster/package.json` `dependencies` — Tasks 5 and 6 import it. In `apps/web/next.config.ts` add `"@factions/declarations"` to `transpilePackages` (keep the array on one line — `transpiled-imports.test.ts` parses it). Then `pnpm install`.

- [ ] **Step 5: Run the moved suites and the bot's**

```bash
cd packages/declarations && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run
cd ../../apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run
```
Expected: both green; the declarations suite prints the two files' tests (the solo tests include "declares, citing the newest raise as evidence" and "refuses a player who is in a clan").

- [ ] **Step 6: CLAUDE.md gate count and the full gate**

`CLAUDE.md` line 41: change `Expect **24/24 tasks** (`packages/roster` adds `typecheck` and `test`)` to `Expect **26/26 tasks** (`packages/roster` and `packages/declarations` each add `typecheck` and `test`)`. Run the full gate from the repo root. Expected `Tasks: 26 successful, 26 total`.

- [ ] **Step 7: Commit**

```bash
git add -A packages/declarations apps/bot packages/roster/package.json apps/web/next.config.ts pnpm-lock.yaml CLAUDE.md
git commit -m "refactor: the declaration store becomes @factions/declarations, shared by bot and roster"
```

---

### Task 2: `@factions/verification` gains the challenge store and two site reads

**Files:**
- Move: `apps/bot/src/store.ts` → `packages/verification/src/store.ts`; `apps/bot/test/store.test.ts` → `packages/verification/test/store.test.ts`
- Create: `packages/verification/vitest.config.ts`
- Modify: `packages/verification/package.json`, `packages/verification/tsconfig.json`, `packages/verification/src/index.ts`, `packages/verification/src/store.ts` (two new methods), `apps/bot/src/{commands,tick,discord}.ts`, `apps/bot/test/{commands,tick,discord}.test.ts`, `apps/web/next.config.ts`, `packages/roster/package.json`

**Interfaces:**
- Produces: `@factions/verification` now exports `PgVerificationStore`, `VerificationStore`, `LiveChallenge`, `Attempt`, `CancelReason`, `PendingNotification`, `Role` (the store's own copy) alongside `generateSequence`, `isExpired`, `advance`. Two new store methods:
  - `searchUnlinkedPlayers(prefix: string, limit: number): Promise<{ dayzId: string; gamertag: string }[]>` — case-insensitive gamertag prefix, no `identity_links` row, most recently seen first.
  - `latestChallenge(discordId: string): Promise<ChallengeRecord | null>` where `ChallengeRecord = LiveChallenge & { completedAt: Date | null; canceledAt: Date | null; cancelReason: CancelReason | null }` — the newest challenge this account ever drew, whatever its state; Task 5's `linkStatus` derives "your last challenge expired / was canceled because…" from it.

- [ ] **Step 1: Move the files and inline `Role`**

```bash
git mv apps/bot/src/store.ts packages/verification/src/store.ts
git mv apps/bot/test/store.test.ts packages/verification/test/store.test.ts
```

In `packages/verification/src/store.ts` replace `import type { Role } from "./roster-store.js";` with:
```ts
/** A roster role, as `factionMembershipsFor` reports it. The bot's roster-store has the same three. */
export type Role = "leader" | "officer" | "member";
```
In the moved test change `from "../src/store.js"` to `from "../src/store"`.

- [ ] **Step 2: Package plumbing**

`packages/verification/package.json` — add to `dependencies`: `"@factions/db": "workspace:*"`, `"drizzle-orm": "^0.36.0"` (keep `@factions/domain`). `packages/verification/tsconfig.json` becomes:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "types": ["node"] },
  "include": ["src", "test"]
}
```
`packages/verification/vitest.config.ts` (new) — identical to `packages/declarations/vitest.config.ts` from Task 1 with the comment naming `factions_test_verification`.

`packages/verification/src/index.ts` — extensionless (this package is about to be transpiled by `apps/web`):
```ts
export { generateSequence, isExpired } from "./sequence";
export { advance } from "./match";
export * from "./store";
```

- [ ] **Step 3: Repoint the bot**

```bash
sed -i '' 's#from "./store.js"#from "@factions/verification"#' apps/bot/src/commands.ts apps/bot/src/tick.ts apps/bot/src/discord.ts
sed -i '' 's#from "../src/store.js"#from "@factions/verification"#' apps/bot/test/commands.test.ts apps/bot/test/tick.test.ts apps/bot/test/discord.test.ts
grep -rn '"./store.js"\|"../src/store.js"' apps/bot   # expect no output
```
`apps/bot/src/tick.ts` already imports `advance` from `@factions/verification`; merge the two imports into one line. Add `"@factions/verification": "workspace:*"` to `packages/roster/package.json` dependencies and `"@factions/verification"` to `transpilePackages` in `apps/web/next.config.ts`. `pnpm install`.

- [ ] **Step 4: Write the failing tests for the two new reads**

Append to `packages/verification/test/store.test.ts`, inside the `describe("PgVerificationStore")` block (it already has `seedPlayer` and `issue` helpers and truncates `players`/`identity_links`):

```ts
  describe("searchUnlinkedPlayers", () => {
    it("matches a gamertag prefix case-insensitively, newest seen first, linked players excluded", async () => {
      await seedPlayer({ dayzId: UID_A, gamertag: "Ronald", lastSeenAt: now });
      await seedPlayer({ dayzId: UID_B, gamertag: "ronnie", lastSeenAt: later });
      await seedPlayer({ dayzId: "C".repeat(40), gamertag: "Rodrigo", lastSeenAt: now });
      await db.insert(identityLinks).values({ discordId: "9", dayzId: "C".repeat(40), gamertag: "Rodrigo", verifiedAt: now });
      expect(await store.searchUnlinkedPlayers("RON", 10)).toEqual([
        { dayzId: UID_B, gamertag: "ronnie" },
        { dayzId: UID_A, gamertag: "Ronald" },
      ]);
      expect(await store.searchUnlinkedPlayers("ro", 1)).toHaveLength(1);
    });

    it("treats LIKE metacharacters in the prefix literally", async () => {
      await seedPlayer({ dayzId: UID_A, gamertag: "Ronald", lastSeenAt: now });
      await seedPlayer({ dayzId: UID_B, gamertag: "R%n", lastSeenAt: now });
      expect(await store.searchUnlinkedPlayers("R%", 10)).toEqual([{ dayzId: UID_B, gamertag: "R%n" }]);
      expect(await store.searchUnlinkedPlayers("_", 10)).toEqual([]);
    });
  });

  describe("latestChallenge", () => {
    it("returns the newest challenge for the account whatever its state, or null", async () => {
      expect(await store.latestChallenge("100")).toBeNull();
      const first = await issue("100", UID_A);
      await store.cancelChallenge(first.id, now, "budget-exhausted");
      const second = await store.createChallenge({
        discordId: "100", guildId: "g", channelId: "c", sequence: SEQ, issuedAt: later, expiresAt: later, targetDayzId: UID_B,
      });
      const latest = await store.latestChallenge("100");
      expect(latest).toMatchObject({ id: second!.id, targetDayzId: UID_B, completedAt: null, canceledAt: null, cancelReason: null });
      expect((await store.latestChallenge("100"))!.id).not.toBe(first.id);
    });
  });
```
If `seedPlayer` in the moved file does not accept the shape above, read its definition at the top of the file and match it — do not change the helper.

- [ ] **Step 5: Run, expect failure**

```bash
cd packages/verification && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/store.test.ts
```
Expected: the three new tests fail with `store.searchUnlinkedPlayers is not a function` / `store.latestChallenge is not a function`.

- [ ] **Step 6: Implement the two reads**

In `packages/verification/src/store.ts`, add to the `VerificationStore` interface after `recentUnlinkedPlayers`:
```ts
  /**
   * Players the event log has seen whose gamertag starts with `prefix`
   * (case-insensitive) and who have no identity link — the site's `/link`
   * autocomplete (spec §5.5 ⚠️: "gamertags the server has seen that nobody
   * has claimed"). Most recently seen first.
   */
  searchUnlinkedPlayers(prefix: string, limit: number): Promise<{ dayzId: string; gamertag: string }[]>;
  /**
   * The newest challenge this account ever drew, in any state. The site
   * derives "your last challenge expired" / "…was canceled because" from it;
   * null means the account has never drawn one.
   */
  latestChallenge(discordId: string): Promise<ChallengeRecord | null>;
```
Add the type next to `LiveChallenge`:
```ts
export type ChallengeRecord = LiveChallenge & {
  completedAt: Date | null; canceledAt: Date | null; cancelReason: CancelReason | null;
};
```
Add `ilike` to the drizzle-orm import, and the implementations to `PgVerificationStore` after `recentUnlinkedPlayers`:
```ts
  async searchUnlinkedPlayers(prefix: string, limit: number) {
    // ⚠️ Escape LIKE's metacharacters so a typed "%" or "_" matches itself.
    // Postgres's default LIKE escape is the backslash.
    const literal = prefix.replace(/[\\%_]/gu, (c) => `\\${c}`);
    return this.db
      .select({ dayzId: players.dayzId, gamertag: players.gamertag })
      .from(players)
      .leftJoin(identityLinks, eq(identityLinks.dayzId, players.dayzId))
      .where(and(isNull(identityLinks.id), ilike(players.gamertag, `${literal}%`)))
      .orderBy(desc(players.lastSeenAt), desc(players.dayzId))
      .limit(limit);
  }

  async latestChallenge(discordId: string): Promise<ChallengeRecord | null> {
    const [row] = await this.db.select().from(verificationChallenges)
      .where(eq(verificationChallenges.discordId, discordId))
      .orderBy(desc(verificationChallenges.issuedAt), desc(verificationChallenges.id))
      .limit(1);
    if (!row) return null;
    return {
      ...toLive(row),
      completedAt: row.completedAt, canceledAt: row.canceledAt,
      cancelReason: row.cancelReason as CancelReason | null,
    };
  }
```

- [ ] **Step 7: Run the package, the bot, then the full gate**

```bash
cd packages/verification && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run
cd ../../apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run
```
Expected: green. Then the full gate: `26 successful, 26 total`. Also `pnpm --filter @factions/web test -- transpiled-imports` must pass — it now scans `verification` too, which is why Step 2 made `index.ts` extensionless.

- [ ] **Step 8: Commit**

```bash
git add -A packages/verification apps/bot packages/roster/package.json apps/web/next.config.ts pnpm-lock.yaml
git commit -m "refactor: the challenge store joins @factions/verification; search and latestChallenge for the site"
```

---

### Task 3: Migration 0021 — a challenge with no channel; inbox 7's refusal path

**Files:**
- Modify: `packages/db/src/schema.ts:225-232` (`guildId`, `channelId`), `packages/verification/src/store.ts` (types, `completeChallenge`, `CancelReason`), `apps/bot/src/notify.ts`, `apps/bot/src/discord.ts` (`notifyCompleted`, the `send` closure, the call at ~line 1150), `packages/verification/test/store.test.ts`, `apps/bot/test/discord.test.ts`, `docs/superpowers/plans/PLAN-3-INBOX.md:105`
- Create: `packages/db/migrations/0021_site_challenges.sql` (+ journal entry, generated)

**Interfaces:**
- Produces: `LiveChallenge.guildId: string | null`, `LiveChallenge.channelId: string | null`; `createChallenge` accepts both as `string | null`; `CancelReason = "budget-exhausted" | "already-linked"`; `Notification.channelId: string | null`; `notifyCompleted(deps, send, loggedFailures?, renameOnLink?, defaultGuildId?: string)`.

- [ ] **Step 1: Schema change and generated migration**

In `packages/db/src/schema.ts` change the two columns:
```ts
  /**
   * The guild `/link` was run in. NULL when the SITE issued the challenge
   * (increment 2b): there is no interaction to answer, so the notifier falls
   * back to the configured guild for the nickname and DMs only.
   */
  guildId: text("guild_id"),
  /** Where `/link` was run — the fallback reply target when a DM is closed. NULL for a site-issued challenge. */
  channelId: text("channel_id"),
```
Generate, then rename the file and its journal tag so the name says what it does (0020 set this convention):
```bash
cd packages/db && npx drizzle-kit generate
ls migrations | tail -2          # a new 0021_<random>.sql
git mv migrations/0021_*.sql migrations/0021_site_challenges.sql
sed -i '' 's/"tag": "0021_[a-z_]*"/"tag": "0021_site_challenges"/' migrations/meta/_journal.json
cat migrations/0021_site_challenges.sql
```
Expected content, exactly two statements:
```sql
ALTER TABLE "verification_challenges" ALTER COLUMN "guild_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_challenges" ALTER COLUMN "channel_id" DROP NOT NULL;
```
If drizzle-kit emits anything else (an index it thinks drifted, a snapshot diff), stop and reconcile the schema before committing — the migration must be these two lines. The generated `meta/0021_snapshot.json` is committed alongside.

- [ ] **Step 2: Failing tests — nullable insert, the already-linked reason, the DM**

In `packages/verification/test/store.test.ts` add inside the top-level describe:
```ts
  it("issues a challenge with no guild and no channel — the site's shape", async () => {
    const c = await store.createChallenge({
      discordId: "100", guildId: null, channelId: null, sequence: SEQ, issuedAt: now, expiresAt: later, targetDayzId: UID_A,
    });
    expect(c).toMatchObject({ guildId: null, channelId: null, targetDayzId: UID_A });
  });

  it("cancels with reason already-linked when the character belongs to another Discord account (inbox 7)", async () => {
    await db.insert(identityLinks).values({ discordId: "200", dayzId: UID_A, gamertag: "Ronald", verifiedAt: now });
    const c = await issue("100", UID_A);
    expect(await store.completeChallenge(c.id, UID_A, "Ronald", later)).toBe(false);
    const [row] = await db.select().from(verificationChallenges).where(eq(verificationChallenges.id, c.id));
    expect(row!.canceledAt).not.toBeNull();
    expect(row!.cancelReason).toBe("already-linked");
    const pending = await store.pendingNotifications();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: c.id, outcome: "already-linked", boundDayzId: null });
  });
```
In `apps/bot/test/discord.test.ts`, find the existing `notifyCompleted` tests (around line 200) and add beside them, reusing that block's `deps`/`store`/`send` fixture shape:
```ts
    it("tells a player whose character is linked elsewhere, once (inbox 7)", async () => {
      await db.insert(identityLinks).values({ discordId: "200", dayzId: TARGET, gamertag: "Ronald", verifiedAt: now });
      const c = (await store.createChallenge({ discordId: "100", guildId: null, channelId: null, sequence: SEQ, issuedAt: now, expiresAt: later, targetDayzId: TARGET }))!;
      await store.completeChallenge(c.id, TARGET, "Ronald", now);
      const sent: { discordId: string; channelId: string | null; content: string }[] = [];
      const send = async (n: { discordId: string; channelId: string | null; content: string }) => { sent.push(n); };
      expect(await notifyCompleted(deps, send)).toBe(1);
      expect(sent[0]!.content).toContain("already linked to another Discord account");
      expect(sent[0]!.channelId).toBeNull();
      expect(await notifyCompleted(deps, send)).toBe(0);
    });
```
Adapt identifiers (`TARGET`, `SEQ`, `later`) to the names that file already defines; if it seeds the player under another constant, use that.

- [ ] **Step 3: Run, expect failures**

```bash
cd packages/verification && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/store.test.ts
```
Expected: typecheck fails on `guildId: null` (still `string`) and the reason assertion fails (`cancelReason` is `null`).

- [ ] **Step 4: Types, `completeChallenge`, notifier**

`packages/verification/src/store.ts`:
- `LiveChallenge`: `guildId: string | null; channelId: string | null;`
- `createChallenge` input: `guildId: string | null; channelId: string | null;` (both places — interface and class).
- `CancelReason`: `export type CancelReason = "budget-exhausted" | "already-linked";` and extend its docblock: `"already-linked" — the character was bound to another Discord account by the time the sequence completed (inbox 7). The issue-time check refuses this up front; this is the race it cannot see.`
- In `completeChallenge`, change `cancel` to take a reason and use it at both refusal sites:
```ts
      const cancel = async (reason: CancelReason | null) => {
        await tx.update(verificationChallenges)
          .set({ canceledAt: at, cancelReason: reason })
          .where(stillOpen);
        return false;
      };
      …
      if (taken) {
        if (taken.discordId === challenge.discordId) return complete();
        // Inbox 7: the player performed the sequence correctly and used to
        // hear nothing. Carry the reason so the notifier tells them.
        return cancel("already-linked");
      }
      …
      if (inserted.length === 0) {
        // The insert lost to identity_links_dayz_uniq (someone else bound this
        // character meanwhile — say so) or to identity_links_discord_uniq (this
        // account bound something else meanwhile — they already know).
        const [now_] = await tx.select({ discordId: identityLinks.discordId }).from(identityLinks)
          .where(eq(identityLinks.dayzId, dayzId));
        return cancel(now_ && now_.discordId !== challenge.discordId ? "already-linked" : null);
      }
      return complete();
```
`apps/bot/src/notify.ts`: `export type Notification = { discordId: string; channelId: string | null; content: string };`

`apps/bot/src/discord.ts`:
- Signature: `export async function notifyCompleted(deps, send, loggedFailures = createNotifyFailureLog(), renameOnLink?: NicknameApplier, defaultGuildId?: string)`. Add to the docblock: `defaultGuildId is used for the rename when the challenge carries no guild — a site-issued one. Without either, no rename is attempted.`
- In the non-completed branch, choose the message by reason:
```ts
        await send({
          discordId: c.discordId,
          channelId: c.channelId,
          content: c.outcome === "already-linked" ? await alreadyLinkedMessage(deps, c) : await lockedOutMessage(deps, c),
        });
```
- In the completed branch: `const guildId = c.guildId ?? defaultGuildId; if (renameOnLink && guildId) { … renameOnLink(guildId, c.discordId, link.gamertag) … }`.
- Add next to `lockedOutMessage`:
```ts
/** Inbox 7: the sequence was right, but the character already belongs to another account. */
async function alreadyLinkedMessage(deps: CommandDeps, c: { targetDayzId: string }): Promise<string> {
  const name = (await deps.store.playerByDayzId(c.targetDayzId))?.gamertag ?? c.targetDayzId;
  return (
    `Your link challenge for **${name}** was canceled: that character is already linked to another ` +
    "Discord account, so this one cannot claim it. If that character is yours — you changed Discord " +
    "accounts, say — ask an admin to move the link."
  );
}
```
- The `send` closure (~line 1092): a null channel has no fallback surface:
```ts
    } catch {
      if (n.channelId === null) throw new Error(`no reachable surface for ${n.discordId} (DMs closed, site-issued challenge)`);
      const channel = await client.channels.fetch(n.channelId);
```
- The call at ~line 1150: `await notifyCompleted(deps, send, notifyFailures, renameOnLink, config.guildId);` (use whatever the config variable is called in that scope — it is the `BotConfig` passed into `createBot`/`startBot`).
- `handleLink` in `apps/bot/src/commands.ts` still passes strings for both; no change there. Any test fixture that constructs a `Notification` literal with `channelId: "c"` still typechecks.

- [ ] **Step 5: Run the three suites and the gate**

```bash
cd packages/verification && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run
cd ../../apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run
cd ../../packages/db && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run
```
Then the full gate: `26 successful, 26 total`.

- [ ] **Step 6: Inbox 7 done**

In `docs/superpowers/plans/PLAN-3-INBOX.md` change the heading at line 105 to `## 7. ~~Tell the player when their UID belongs to another Discord account~~ — DONE 2026-09-05` and append one line under it: `Closed by increment 2b: \`completeChallenge\` cancels with \`cancel_reason = 'already-linked'\` and the notifier DMs it; the site's \`/link\` shows the same reason from \`latestChallenge\`.`

- [ ] **Step 7: Commit**

```bash
git add packages/db packages/verification apps/bot docs/superpowers/plans/PLAN-3-INBOX.md
git commit -m "feat: migration 0021 — site-issued challenges have no channel; already-linked refusals reach the player (inbox 7)"
```

---

### Task 4: `issueChallenge` — the link decision as a pure-outcome function

**Files:**
- Create: `packages/verification/src/issue.ts`, `packages/verification/test/issue.test.ts`
- Modify: `packages/verification/src/index.ts`, `apps/bot/src/commands.ts:44-256` (`handleLink` becomes a formatter; the two constants move)

**Interfaces:**
- Produces:
  ```ts
  export const ISSUE_OUTCOME_KINDS = ["already-linked", "unknown-character", "taken", "live", "too-many-draws", "just-linked", "issued", "held-by-other", "unavailable"] as const;
  export type IssueOutcome =
    | { kind: "already-linked"; gamertag: string }          // this account already holds a link
    | { kind: "unknown-character" }                          // the log has never seen that UID
    | { kind: "taken"; gamertag: string }                    // that character is linked to another account
    | { kind: "live"; challenge: LiveChallenge; gamertag: string }   // re-shown, not re-issued
    | { kind: "too-many-draws"; gamertag: string }
    | { kind: "just-linked"; gamertag: string }              // the old challenge completed under us
    | { kind: "issued"; challenge: LiveChallenge; gamertag: string; switchedFrom: string | null }
    | { kind: "held-by-other"; gamertag: string; expiresAt: Date }
    | { kind: "unavailable" };
  export type IssueDeps = { rng: () => number; now: Date; ttlMs: number };
  export type IssueContext = { discordId: string; targetDayzId: string; guildId: string | null; channelId: string | null; newSequence?: boolean };
  export function issueChallenge(store: VerificationStore, deps: IssueDeps, ctx: IssueContext): Promise<IssueOutcome>;
  export const MAX_DRAWS_PER_TARGET = 3;
  export const DRAW_WINDOW_MS = 86_400_000;
  ```
  The bot keeps `formatSequence`, `challengeMessage`, `handleUnlink`, `handleWhoami` as they are. Every ephemeral string `handleLink` returns today is returned unchanged; `apps/bot/test/commands.test.ts` is the proof and is not edited.

- [ ] **Step 1: Write the failing test**

`packages/verification/test/issue.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, identityLinks, players, verificationChallenges, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { PgVerificationStore } from "../src/store";
import { issueChallenge, MAX_DRAWS_PER_TARGET, type IssueDeps } from "../src/issue";

const URL = requireTestDatabaseUrl();
const UID_A = "A".repeat(40);
const UID_B = "B".repeat(40);
const now = new Date("2026-09-05T12:00:00Z");
const TTL = 600_000;

describe("issueChallenge", () => {
  let db: Database;
  let store: PgVerificationStore;
  const deps: IssueDeps = { rng: Math.random, now, ttlMs: TTL };
  const ctx = (targetDayzId = UID_A, extra: Partial<{ newSequence: boolean; discordId: string }> = {}) =>
    ({ discordId: "100", targetDayzId, guildId: null, channelId: null, ...extra });

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table challenge_attempts, verification_challenges, identity_links, players restart identity cascade`);
    });
    store = new PgVerificationStore(db);
    await db.insert(players).values([
      { dayzId: UID_A, gamertag: "Ronald", firstSeenAt: now, lastSeenAt: now },
      { dayzId: UID_B, gamertag: "Betty", firstSeenAt: now, lastSeenAt: now },
    ]);
  });

  it("refuses an account that is already linked", async () => {
    await db.insert(identityLinks).values({ discordId: "100", dayzId: UID_B, gamertag: "Betty", verifiedAt: now });
    expect(await issueChallenge(store, deps, ctx())).toEqual({ kind: "already-linked", gamertag: "Betty" });
  });

  it("refuses a character the log has never seen", async () => {
    expect(await issueChallenge(store, deps, ctx("F".repeat(40)))).toEqual({ kind: "unknown-character" });
  });

  it("refuses a character linked to another account", async () => {
    await db.insert(identityLinks).values({ discordId: "200", dayzId: UID_A, gamertag: "Ronald", verifiedAt: now });
    expect(await issueChallenge(store, deps, ctx())).toEqual({ kind: "taken", gamertag: "Ronald" });
  });

  it("issues with the site's shape: no guild, no channel, ttl from deps, three emotes", async () => {
    const out = await issueChallenge(store, deps, ctx());
    expect(out.kind).toBe("issued");
    if (out.kind !== "issued") return;
    expect(out.switchedFrom).toBeNull();
    expect(out.challenge).toMatchObject({ guildId: null, channelId: null, targetDayzId: UID_A });
    expect(out.challenge.sequence).toHaveLength(3);
    expect(out.challenge.expiresAt.getTime()).toBe(now.getTime() + TTL);
  });

  it("re-shows a live challenge for the same character instead of re-issuing", async () => {
    const first = await issueChallenge(store, deps, ctx());
    const again = await issueChallenge(store, deps, ctx());
    expect(again.kind).toBe("live");
    if (first.kind !== "issued" || again.kind !== "live") return;
    expect(again.challenge.id).toBe(first.challenge.id);
    expect(again.challenge.sequence).toEqual(first.challenge.sequence);
  });

  it("newSequence re-rolls; switching character cancels the old one and names it", async () => {
    const first = await issueChallenge(store, deps, ctx());
    const rerolled = await issueChallenge(store, deps, ctx(UID_A, { newSequence: true }));
    expect(rerolled.kind).toBe("issued");
    if (first.kind !== "issued" || rerolled.kind !== "issued") return;
    expect(rerolled.challenge.id).not.toBe(first.challenge.id);
    expect(rerolled.switchedFrom).toBeNull();
    const switched = await issueChallenge(store, deps, ctx(UID_B));
    expect(switched).toMatchObject({ kind: "issued", switchedFrom: "Ronald" });
    const [old] = await db.select().from(verificationChallenges).where(eq(verificationChallenges.id, rerolled.challenge.id));
    expect(old!.canceledAt).not.toBeNull();
    expect(old!.cancelReason).toBeNull();
  });

  it("caps draws per character per window, counting every draw", async () => {
    for (let i = 0; i < MAX_DRAWS_PER_TARGET; i++) {
      expect((await issueChallenge(store, deps, ctx(UID_A, { newSequence: true }))).kind).toBe("issued");
    }
    expect(await issueChallenge(store, deps, ctx(UID_A, { newSequence: true }))).toEqual({ kind: "too-many-draws", gamertag: "Ronald" });
  });

  it("reports a character another account is mid-way through verifying, with when that ends", async () => {
    const theirs = await issueChallenge(store, deps, ctx(UID_A, { discordId: "200" }));
    expect(theirs.kind).toBe("issued");
    const out = await issueChallenge(store, deps, ctx());
    expect(out).toEqual({ kind: "held-by-other", gamertag: "Ronald", expiresAt: new Date(now.getTime() + TTL) });
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd packages/verification && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/issue.test.ts
```
Expected: fails to import `../src/issue`.

- [ ] **Step 3: Write `issue.ts`**

This is `handleLink`'s body with every `return ephemeral(...)` replaced by an outcome. Keep the comments — they are the reasoning, and the bot's copy of them is deleted in Step 4.

```ts
import { generateSequence } from "./sequence";
import type { LiveChallenge, VerificationStore } from "./store";

/**
 * How many times one account may draw a sequence for one character inside
 * DRAW_WINDOW_MS. A security bound, not a courtesy limit: every draw carries
 * its own fresh emote budget (see the bot's MAX_POOL_EMOTES_PER_ATTEMPT), so
 * without this an unlimited succession of short-lived challenges would bound
 * nothing. Counts DRAWS, whatever their outcome — `countDrawsSince`.
 */
export const MAX_DRAWS_PER_TARGET = 3;
export const DRAW_WINDOW_MS = 86_400_000;

export const ISSUE_OUTCOME_KINDS = [
  "already-linked", "unknown-character", "taken", "live", "too-many-draws",
  "just-linked", "issued", "held-by-other", "unavailable",
] as const;
export type IssueOutcomeKind = (typeof ISSUE_OUTCOME_KINDS)[number];

export type IssueOutcome =
  | { kind: "already-linked"; gamertag: string }
  | { kind: "unknown-character" }
  | { kind: "taken"; gamertag: string }
  | { kind: "live"; challenge: LiveChallenge; gamertag: string }
  | { kind: "too-many-draws"; gamertag: string }
  | { kind: "just-linked"; gamertag: string }
  | { kind: "issued"; challenge: LiveChallenge; gamertag: string; switchedFrom: string | null }
  | { kind: "held-by-other"; gamertag: string; expiresAt: Date }
  | { kind: "unavailable" };

export type IssueDeps = { rng: () => number; now: Date; ttlMs: number };
export type IssueContext = {
  discordId: string;
  targetDayzId: string;
  /** Null when the site issues: there is no interaction to answer. */
  guildId: string | null;
  channelId: string | null;
  /** Ask for a different sequence for the SAME character instead of re-showing the live one. */
  newSequence?: boolean;
};

/**
 * Decide whether to issue a link challenge, and issue it. The one copy of
 * the rules the bot's `/link` and the site's `startLink` both apply (spec
 * §5.5); each caller only formats the outcome.
 *
 * ⚠️ Autocomplete is a suggestion, not a constraint — both callers submit
 * whatever the player typed — so "unknown" and "taken" are checked here,
 * server-side. They are the friendlier refusal, not the enforcement: the
 * guarantees behind a lost race are `verification_challenges_open_target_uniq`
 * (one open challenge per character) and `identity_links_dayz_uniq` (one link
 * per character). There is deliberately no foreign key from target_dayz_id to
 * players, so the `playerByDayzId` lookup is the only thing refusing an
 * unknown UID.
 */
export async function issueChallenge(store: VerificationStore, deps: IssueDeps, ctx: IssueContext): Promise<IssueOutcome> {
  const { now } = deps;

  const existing = await store.findLinkByDiscord(ctx.discordId);
  if (existing) return { kind: "already-linked", gamertag: existing.gamertag };

  const target = await store.playerByDayzId(ctx.targetDayzId);
  if (!target) return { kind: "unknown-character" };
  const taken = await store.findLinkByDayzId(target.dayzId);
  if (taken) return { kind: "taken", gamertag: target.gamertag };

  // Re-show rather than re-issue: a player who lost the page must see the SAME
  // three emotes they already walked in game to perform. `newSequence` is the
  // one way past this — a player who cannot perform one of the emotes is
  // asking for different ones, not for the same ones again.
  const live = await store.findLiveChallenge(ctx.discordId, now);
  if (live && live.targetDayzId === target.dayzId && ctx.newSequence !== true) {
    return { kind: "live", challenge: live, gamertag: target.gamertag };
  }

  // ⚠️ Checked on every path that goes on to ISSUE for this character — the
  // explicit re-roll, a first draw, and the switch-away-and-back below. A cap
  // that counted only explicit re-rolls would be bypassable with one extra
  // request.
  const drawn = await store.countDrawsSince(ctx.discordId, target.dayzId, new Date(now.getTime() - DRAW_WINDOW_MS));
  if (drawn >= MAX_DRAWS_PER_TARGET) return { kind: "too-many-draws", gamertag: target.gamertag };

  // Naming a different character switches, it does not re-show: an account
  // gets one open challenge (uniqOpenPerAccount), so re-showing would strand
  // anyone who mis-picked — and strand the abandoned character too, since its
  // slot in verification_challenges_open_target_uniq stays held. Replacing
  // steals nothing: a challenge names the one character that can satisfy it.
  let switchedFrom: string | null = null;
  if (live) {
    // ⚠️ Ordering, not decoration: the cancel must run BEFORE the insert
    // below, or the new row collides with the one it replaces on
    // uniqOpenPerAccount. Left autocommitted on purpose: a crash between the
    // two leaves the old challenge canceled and both index slots free.
    //
    // `cancelChallenge` is the guarded cancel — it touches only a row that is
    // neither completed nor already canceled. False means the row closed under
    // us; the only way it closes as COMPLETE is the tick binding the old
    // target, so re-read the link before issuing anything.
    const canceled = await store.cancelChallenge(live.id, now);
    if (!canceled) {
      const justLinked = await store.findLinkByDiscord(ctx.discordId);
      if (justLinked) return { kind: "just-linked", gamertag: justLinked.gamertag };
    }
    switchedFrom = (await store.playerByDayzId(live.targetDayzId))?.gamertag ?? live.targetDayzId;
  }

  // An expired row still occupies this account's one open-challenge slot
  // (uniqOpenPerAccount), so close those out before the insert below.
  await store.cancelExpired(now);

  const expiresAt = new Date(now.getTime() + deps.ttlMs);
  // One draw, no redraw loop: sequences need not be unique across live
  // challenges, because a challenge can only be satisfied by the character it
  // names (the open-sequence index was retired for that reason).
  const sequence = generateSequence(deps.rng);
  const challenge = await store.createChallenge({
    discordId: ctx.discordId, guildId: ctx.guildId, channelId: ctx.channelId,
    sequence, issuedAt: now, expiresAt, targetDayzId: target.dayzId,
  });
  if (challenge) return { kind: "issued", challenge, gamertag: target.gamertag, switchedFrom };

  // A null insert lost to one of two partial unique indexes, and they mean
  // different things to the player.

  // uniqOpenPerAccount: a concurrent request for this SAME account beat us to
  // the slot. Show theirs — it is the same player, twice.
  const concurrent = await store.findLiveChallenge(ctx.discordId, now);
  if (concurrent) {
    const name = (await store.playerByDayzId(concurrent.targetDayzId))?.gamertag ?? concurrent.targetDayzId;
    return { kind: "live", challenge: concurrent, gamertag: name };
  }

  // ⚠️ uniqOpenTarget: ANOTHER account is verifying this character. Not
  // transient — that index's predicate carries no expiry term, and
  // cancelExpired above does not touch another account's unexpired row — so
  // "try again in a moment" would be a lie for the whole TTL. Say when it
  // ends. The other account's challenge is left strictly alone: cancelling it
  // would hand anyone a way to knock a rival off a character mid-verification.
  const holder = await store.findOpenChallengeByTarget(target.dayzId);
  if (holder && holder.discordId !== ctx.discordId) {
    return { kind: "held-by-other", gamertag: target.gamertag, expiresAt: holder.expiresAt };
  }
  return { kind: "unavailable" };
}
```

Add to `packages/verification/src/index.ts`: `export * from "./issue";`

- [ ] **Step 4: `handleLink` becomes a formatter**

In `apps/bot/src/commands.ts`: delete the `MAX_DRAWS_PER_TARGET`/`DRAW_WINDOW_MS` declarations and their docblock (lines ~44-61), import `issueChallenge` from `@factions/verification`, and replace the body of `handleLink` (everything from `const now = deps.now();` to the final `return ephemeral("Could not issue…")`, plus the `nameOf` helper) with:

```ts
export async function handleLink(deps: CommandDeps, ctx: LinkContext): Promise<Reply> {
  const out = await issueChallenge(deps.store, { rng: deps.rng, now: deps.now(), ttlMs: deps.challengeTtlMs }, {
    discordId: ctx.discordId, targetDayzId: ctx.targetDayzId, guildId: ctx.guildId, channelId: ctx.channelId,
    newSequence: ctx.newSequence,
  });
  // The strings below are the ones this command has always said; the
  // decisions behind them live in @factions/verification's issueChallenge,
  // which the site's /link shares.
  switch (out.kind) {
    case "already-linked":
    case "just-linked":
      return ephemeral(
        (out.kind === "just-linked" ? `You just finished linking to **${out.gamertag}**. ` : `You are already linked to **${out.gamertag}**. `) +
        "Run `/unlink` first if you need to bind a different character.",
      );
    case "unknown-character":
      return ephemeral(
        "I have not seen that character on the server. Pick one from the list — " +
        "only characters the event log has seen can be linked.",
      );
    case "taken":
      return ephemeral(
        `**${out.gamertag}** is already linked to another Discord account. ` +
        "If that character is yours, ask an admin.",
      );
    case "live":
      return ephemeral(challengeMessage(out.challenge.sequence, out.challenge.expiresAt, out.gamertag));
    case "too-many-draws":
      return ephemeral(
        `You have asked for too many sequences for **${out.gamertag}** today. ` +
        "Try again tomorrow — or, if there is an emote you cannot find on the wheel, " +
        "say so in the channel rather than working around it.",
      );
    case "issued": {
      const body = challengeMessage(out.challenge.sequence, out.challenge.expiresAt, out.gamertag);
      // Say the old sequence is dead. A player who switched must not go on
      // performing emotes that can no longer bind anything.
      return ephemeral(out.switchedFrom === null
        ? body
        : `Canceled your challenge for **${out.switchedFrom}** — that sequence no longer works.\n\n${body}`);
    }
    case "held-by-other":
      return ephemeral(
        `Someone else is verifying **${out.gamertag}** right now, so I cannot issue a ` +
        `challenge for that character yet. Their attempt ends <t:${Math.floor(out.expiresAt.getTime() / 1000)}:R> — ` +
        "run `/link` again after that. If that character is yours, ask an admin.",
      );
    case "unavailable":
      return ephemeral("Could not issue a challenge right now. Try again in a moment.");
  }
}
```
Compare each string against the pre-edit file (`git show HEAD:apps/bot/src/commands.ts`) character by character; `commands.test.ts` asserts on them. Update the comment in `apps/bot/src/config.ts:15` that names `MAX_DRAWS_PER_TARGET` to say `@factions/verification's MAX_DRAWS_PER_TARGET`.

- [ ] **Step 5: Run everything**

```bash
cd packages/verification && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run
cd ../../apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/commands.test.ts
```
Expected: green, `commands.test.ts` untouched. Full gate: 26/26.

- [ ] **Step 6: Commit**

```bash
git add packages/verification apps/bot/src/commands.ts apps/bot/src/config.ts
git commit -m "refactor: issueChallenge — the link decision lives once, in @factions/verification; /link formats it"
```

---

### Task 5: Roster link writes — `startLink`, `cancelLink`, `unlink`, `linkStatus`, `searchGamertags`

**Files:**
- Create: `packages/roster/src/server.ts`, `packages/roster/src/link.ts`, `packages/roster/test/link.test.ts`
- Modify: `packages/roster/src/index.ts`, `packages/roster/test/exports.test.ts`, `apps/web/test/smoke.test.ts:92`

**Interfaces:**
- Consumes: `PgVerificationStore`, `issueChallenge`, `IssueOutcome`, `CancelReason`, `MAX_DRAWS_PER_TARGET`, `DRAW_WINDOW_MS` from `@factions/verification`; `lockDeclarations`, `releaseTx` from `@factions/declarations`; `LINK_TTL_MS`, `emoteLabel`, `HOLDING_STATUSES` from `@factions/domain`.
- Produces (package exports, wrapping the `…Db` functions with `db()` and `new Date()`):
  ```ts
  export type LinkStep = { token: string; label: string; confirmed: boolean };
  export type LinkStatus = {
    link: { dayzId: string; gamertag: string; verifiedAt: Date } | null;
    challenge: { id: number; targetDayzId: string; gamertag: string; steps: LinkStep[]; confirmed: number; expiresAt: Date; drawsLeft: number } | null;
    /** How the newest challenge ended when the player did not end it themselves; null otherwise. */
    ended: "expired" | CancelReason | null;
  };
  export function linkStatus(discordId: string): Promise<LinkStatus>;
  export function startLink(discordId: string, targetDayzId: string, opts?: { newSequence?: boolean }): Promise<IssueOutcome>;
  export function cancelLink(discordId: string): Promise<{ canceled: boolean }>;
  export type UnlinkOutcome = { ok: true; releasedBase: boolean } | { ok: false; reason: "not-linked" } | { ok: false; reason: "in-clan"; clanName: string };
  export function unlink(discordId: string): Promise<UnlinkOutcome>;
  export function searchGamertags(prefix: string): Promise<{ dayzId: string; gamertag: string }[]>;  // at most 10
  ```
  Also `activeServerId(db: Database | Tx): Promise<number>` in `server.ts` (internal; Task 6 uses it).

- [ ] **Step 1: Write the failing tests**

`packages/roster/test/link.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, identityLinks, players, poles, events, admFiles, verificationChallenges, challengeAttempts, declarations,
  type Database,
} from "@factions/db";
import { LINK_TTL_MS, LINK_EMOTES, RELEASED_POLE_GRACE_MS } from "@factions/domain";
import { declareSolo } from "@factions/declarations";
import { sql, eq } from "drizzle-orm";
import { linkStatusDb, startLinkDb, cancelLinkDb, unlinkDb, searchGamertagsDb } from "../src/link";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-05T12:00:00Z");
const UID_A = "A".repeat(40);
const P = "5000.00:100.00:5000.00";

describe("roster link writes", () => {
  let db: Database; let serverId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table challenge_attempts, verification_challenges, declarations, poles, faction_members, factions, identity_links, players, events, raw_lines, adm_files, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    await db.insert(players).values({ dayzId: UID_A, gamertag: "Ronald", firstSeenAt: now, lastSeenAt: now });
  });

  const start = (discordId = "d1", extra: { newSequence?: boolean } = {}) =>
    startLinkDb(db, { discordId, targetDayzId: UID_A, now, rng: Math.random, ...extra });

  it("startLink issues the site's challenge: no channel, LINK_TTL_MS, LINK_EMOTES steps", async () => {
    const out = await start();
    expect(out.kind).toBe("issued");
    if (out.kind !== "issued") return;
    expect(out.challenge.guildId).toBeNull();
    expect(out.challenge.channelId).toBeNull();
    expect(out.challenge.expiresAt.getTime()).toBe(now.getTime() + LINK_TTL_MS);
    expect(out.challenge.sequence).toHaveLength(LINK_EMOTES);
  });

  it("linkStatus shows the open challenge with labelled steps and the server's confirmed count", async () => {
    const out = await start();
    if (out.kind !== "issued") throw new Error(out.kind);
    await db.insert(challengeAttempts).values({ challengeId: out.challenge.id, dayzId: UID_A, progressIndex: 2, lastMatchedEventId: 1, seenCount: 2 });
    const s = await linkStatusDb(db, "d1", now);
    expect(s.link).toBeNull();
    expect(s.ended).toBeNull();
    expect(s.challenge).toMatchObject({ id: out.challenge.id, targetDayzId: UID_A, gamertag: "Ronald", confirmed: 2, drawsLeft: 2 });
    expect(s.challenge!.steps.map((x) => x.confirmed)).toEqual([true, true, false]);
    expect(s.challenge!.steps[0]!.label).not.toMatch(/^Emote/u);
  });

  it("linkStatus reports how the last challenge ended: expired, or the cancel reason", async () => {
    const out = await start();
    if (out.kind !== "issued") throw new Error(out.kind);
    const late = new Date(now.getTime() + LINK_TTL_MS + 1);
    expect((await linkStatusDb(db, "d1", late))).toMatchObject({ challenge: null, ended: "expired" });
    await db.update(verificationChallenges).set({ canceledAt: late, cancelReason: "budget-exhausted" }).where(eq(verificationChallenges.id, out.challenge.id));
    expect((await linkStatusDb(db, "d1", late))).toMatchObject({ challenge: null, ended: "budget-exhausted" });
  });

  it("a switch-cancel is not reported as an ending — the player did it", async () => {
    const out = await start();
    if (out.kind !== "issued") throw new Error(out.kind);
    expect(await cancelLinkDb(db, "d1", now)).toEqual({ canceled: true });
    expect((await linkStatusDb(db, "d1", now))).toMatchObject({ challenge: null, ended: null });
    expect(await cancelLinkDb(db, "d1", now)).toEqual({ canceled: false });
  });

  it("searchGamertags offers unclaimed prefix matches only", async () => {
    expect(await searchGamertagsDb(db, "ron")).toEqual([{ dayzId: UID_A, gamertag: "Ronald" }]);
    await db.insert(identityLinks).values({ discordId: "d9", dayzId: UID_A, gamertag: "Ronald", verifiedAt: now });
    expect(await searchGamertagsDb(db, "ron")).toEqual([]);
    expect(await searchGamertagsDb(db, "   ")).toEqual([]);
  });

  describe("unlink", () => {
    beforeEach(async () => {
      await db.insert(identityLinks).values({ discordId: "d1", dayzId: UID_A, gamertag: "Ronald", verifiedAt: now });
    });

    it("refuses while a roster row exists, naming the clan", async () => {
      const [f] = await db.insert(factions).values({ serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", leaderDiscordId: "d1", createdAt: now }).returning();
      await db.insert(factionMembers).values({ factionId: f!.id, serverId, dayzId: UID_A, discordId: "d1", role: "leader", joinedAt: now });
      expect(await unlinkDb(db, "d1", now)).toEqual({ ok: false, reason: "in-clan", clanName: "Bears" });
      expect(await db.select().from(identityLinks)).toHaveLength(1);
    });

    it("releases a solo declaration and stamps the pole's grace, in the same transaction", async () => {
      const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
      await db.insert(poles).values({ serverId, map: "livonia", poleKey: P, x: "5000.00", y: "100.00", z: "5000.00", currentTexture: "Flag_White", flagRaised: true, firstSeenAt: now, lastSeenAt: now, graceUntil: now });
      await db.insert(events).values({ serverId, admFileId: a!.id, lineIndex: 0, type: "flag.raised", occurredAt: now, payload: { dayzId: UID_A, gamertag: "Ronald", texture: "Flag_White", poleKey: P, pole: { x: 5000, y: 100, z: 5000 } } });
      expect(await declareSolo(db, { serverId, dayzId: UID_A, poleKey: P, at: now })).toMatchObject({ ok: true });

      expect(await unlinkDb(db, "d1", now)).toEqual({ ok: true, releasedBase: true });
      expect(await db.select().from(declarations)).toEqual([]);
      expect(await db.select().from(identityLinks)).toEqual([]);
      const [pole] = await db.select({ graceUntil: poles.graceUntil }).from(poles).where(eq(poles.poleKey, P));
      expect(pole!.graceUntil.getTime()).toBe(now.getTime() + RELEASED_POLE_GRACE_MS);
    });

    it("a solo with no base unlinks with releasedBase false; unlinking twice reports not-linked", async () => {
      expect(await unlinkDb(db, "d1", now)).toEqual({ ok: true, releasedBase: false });
      expect(await unlinkDb(db, "d1", now)).toEqual({ ok: false, reason: "not-linked" });
    });
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd packages/roster && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/link.test.ts
```
Expected: cannot resolve `../src/link`.

- [ ] **Step 3: `server.ts` and `link.ts`**

`packages/roster/src/server.ts`:
```ts
import type { Database } from "@factions/db";
import { servers } from "@factions/db";
import type { Tx } from "@factions/declarations";
import { asc, eq } from "drizzle-orm";

/**
 * The server the site acts on. This deployment registers exactly one; the
 * ORDER BY makes a second one a deterministic choice rather than a random
 * one, and the throw makes an empty `servers` table a loud failure instead
 * of a page that quietly declares nothing.
 */
export async function activeServerId(db: Database | Tx): Promise<number> {
  const [s] = await db.select({ id: servers.id }).from(servers)
    .where(eq(servers.active, true)).orderBy(asc(servers.id)).limit(1);
  if (!s) throw new Error("no active server is registered; the site cannot act without one");
  return s.id;
}
```

`packages/roster/src/link.ts`:
```ts
import type { Database } from "@factions/db";
import { factions, factionMembers, identityLinks, servers } from "@factions/db";
import { HOLDING_STATUSES, LINK_TTL_MS, emoteLabel } from "@factions/domain";
import { lockDeclarations, releaseTx } from "@factions/declarations";
import {
  PgVerificationStore, issueChallenge, DRAW_WINDOW_MS, MAX_DRAWS_PER_TARGET,
  type IssueOutcome, type CancelReason,
} from "@factions/verification";
import { and, asc, eq, inArray } from "drizzle-orm";

export type LinkStep = { token: string; label: string; confirmed: boolean };
export type LinkStatus = {
  link: { dayzId: string; gamertag: string; verifiedAt: Date } | null;
  challenge: { id: number; targetDayzId: string; gamertag: string; steps: LinkStep[]; confirmed: number; expiresAt: Date; drawsLeft: number } | null;
  /** How the newest challenge ended when the player did not end it themselves; null otherwise. */
  ended: "expired" | CancelReason | null;
};
export type UnlinkOutcome =
  | { ok: true; releasedBase: boolean }
  | { ok: false; reason: "not-linked" }
  | { ok: false; reason: "in-clan"; clanName: string };

const SEARCH_LIMIT = 10;

/**
 * Everything /link needs to render, in one read. Polled every 5 s while a
 * challenge is open, so it stays a handful of indexed lookups.
 *
 * `confirmed` is the server's count from `challenge_attempts` — never a guess
 * (the page says "the server has confirmed N"). `ended` comes from the newest
 * challenge in any state: expired without an outcome → "expired"; canceled
 * with a reason → that reason; a switch- or self-cancel carries no reason and
 * is not reported, because the player did it.
 */
export async function linkStatusDb(db: Database, discordId: string, now: Date): Promise<LinkStatus> {
  const store = new PgVerificationStore(db);
  const link = await store.findLinkByDiscord(discordId);
  const live = await store.findLiveChallenge(discordId, now);
  if (live) {
    const [attempt, gamertag, drawn] = await Promise.all([
      store.getAttempt(live.id, live.targetDayzId),
      store.playerByDayzId(live.targetDayzId).then((p) => p?.gamertag ?? live.targetDayzId),
      store.countDrawsSince(discordId, live.targetDayzId, new Date(now.getTime() - DRAW_WINDOW_MS)),
    ]);
    const confirmed = attempt?.progressIndex ?? 0;
    return {
      link, ended: null,
      challenge: {
        id: live.id, targetDayzId: live.targetDayzId, gamertag, confirmed, expiresAt: live.expiresAt,
        steps: live.sequence.map((token, i) => ({ token, label: emoteLabel(token) ?? token, confirmed: i < confirmed })),
        drawsLeft: Math.max(0, MAX_DRAWS_PER_TARGET - drawn),
      },
    };
  }
  const latest = await store.latestChallenge(discordId);
  let ended: LinkStatus["ended"] = null;
  if (latest && latest.completedAt === null) {
    if (latest.cancelReason) ended = latest.cancelReason;
    else if (latest.canceledAt === null && latest.expiresAt < now) ended = "expired";
  }
  return { link, challenge: null, ended };
}

export async function startLinkDb(db: Database, a: {
  discordId: string; targetDayzId: string; newSequence?: boolean; now: Date; rng: () => number;
}): Promise<IssueOutcome> {
  // ⚠️ LINK_TTL_MS, the guide's ten minutes — not the bot's 24 h. The site
  // flow assumes the player is already in game (spec §5.5).
  return issueChallenge(new PgVerificationStore(db), { rng: a.rng, now: a.now, ttlMs: LINK_TTL_MS }, {
    discordId: a.discordId, targetDayzId: a.targetDayzId, guildId: null, channelId: null, newSequence: a.newSequence,
  });
}

/** Cancel the caller's live challenge. No reason: they did it, so nobody needs telling. */
export async function cancelLinkDb(db: Database, discordId: string, now: Date): Promise<{ canceled: boolean }> {
  const store = new PgVerificationStore(db);
  const live = await store.findLiveChallenge(discordId, now);
  if (!live) return { canceled: false };
  return { canceled: await store.cancelChallenge(live.id, now) };
}

/**
 * Unlink (spec §5.5): refused while a roster row exists — unlinking a leader
 * would orphan the clan into the frozen state succession exists to prevent —
 * and releases a solo declaration in the same transaction, so a base cannot
 * survive the link that owned it.
 *
 * Lock order (spec §4.12): `lockDeclarations` → `releaseTx` (declarations,
 * then poles) → identity_links, which is outside the ordered set. The
 * advisory lock is what serialises this against a concurrent `declareSolo`
 * for the same player (roster/base.ts takes it before reading the link), so
 * no declaration can be created for a link that is mid-delete.
 */
export async function unlinkDb(db: Database, discordId: string, now: Date): Promise<UnlinkOutcome> {
  return db.transaction(async (tx) => {
    const [link] = await tx.select({ id: identityLinks.id, dayzId: identityLinks.dayzId })
      .from(identityLinks).where(eq(identityLinks.discordId, discordId)).for("update");
    if (!link) return { ok: false as const, reason: "not-linked" as const };

    const [member] = await tx.select({ clanName: factions.name }).from(factionMembers)
      .innerJoin(factions, eq(factions.id, factionMembers.factionId))
      .where(and(eq(factionMembers.discordId, discordId), inArray(factions.status, [...HOLDING_STATUSES])))
      .orderBy(asc(factions.id)).limit(1);
    if (member) return { ok: false as const, reason: "in-clan" as const, clanName: member.clanName };

    let releasedBase = false;
    for (const s of await tx.select({ id: servers.id }).from(servers).where(eq(servers.active, true)).orderBy(asc(servers.id))) {
      await lockDeclarations(tx, s.id);
      if (await releaseTx(tx, { dayzId: link.dayzId, serverId: s.id }, now)) releasedBase = true;
    }
    await tx.delete(identityLinks).where(eq(identityLinks.id, link.id));
    return { ok: true as const, releasedBase };
  });
}

/** Autocomplete: unclaimed gamertags the server has seen, by prefix. Empty prefix → nothing. */
export async function searchGamertagsDb(db: Database, prefix: string): Promise<{ dayzId: string; gamertag: string }[]> {
  const q = prefix.trim();
  if (q.length === 0) return [];
  return new PgVerificationStore(db).searchUnlinkedPlayers(q, SEARCH_LIMIT);
}
```

- [ ] **Step 4: Export from the package and widen both pins**

`packages/roster/src/index.ts` — add after `viewerFor`:
```ts
import {
  linkStatusDb, startLinkDb, cancelLinkDb, unlinkDb, searchGamertagsDb,
  type LinkStatus, type LinkStep, type UnlinkOutcome,
} from "./link";
import type { IssueOutcome, IssueOutcomeKind } from "@factions/verification";
export { ISSUE_OUTCOME_KINDS } from "@factions/verification";
export type { LinkStatus, LinkStep, UnlinkOutcome, IssueOutcome, IssueOutcomeKind };

/** /link's one read: your link, your open challenge, how the last one ended. */
export function linkStatus(discordId: string): Promise<LinkStatus> {
  return linkStatusDb(db(), discordId, new Date());
}
/** Issue (or re-show) a link challenge for a character the log has seen. */
export function startLink(discordId: string, targetDayzId: string, opts: { newSequence?: boolean } = {}): Promise<IssueOutcome> {
  return startLinkDb(db(), { discordId, targetDayzId, newSequence: opts.newSequence, now: new Date(), rng: Math.random });
}
export function cancelLink(discordId: string): Promise<{ canceled: boolean }> {
  return cancelLinkDb(db(), discordId, new Date());
}
/** Refused while in a clan; releases a solo base. */
export function unlink(discordId: string): Promise<UnlinkOutcome> {
  return unlinkDb(db(), discordId, new Date());
}
export function searchGamertags(prefix: string): Promise<{ dayzId: string; gamertag: string }[]> {
  return searchGamertagsDb(db(), prefix);
}
```
Update the module docblock's "holds no writes" sentence to name these. Because `ISSUE_OUTCOME_KINDS` is a runtime export, it appears in `Object.keys` — add it to both pins. `packages/roster/test/exports.test.ts`: `export const ROSTER_EXPORTS = ["ISSUE_OUTCOME_KINDS", "cancelLink", "linkStatus", "searchGamertags", "startLink", "unlink", "viewerFor"] as const;` `apps/web/test/smoke.test.ts:92`: the same array, sorted the way `Object.keys(roster).sort()` sorts (uppercase first: `["ISSUE_OUTCOME_KINDS", "cancelLink", "linkStatus", "searchGamertags", "startLink", "unlink", "viewerFor"]`).

- [ ] **Step 5: Run the roster suite, the web tests, the gate**

```bash
cd packages/roster && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run
cd ../../apps/web && npx vitest run
```
Then the full gate: 26/26.

- [ ] **Step 6: Commit**

```bash
git add packages/roster apps/web/test/smoke.test.ts
git commit -m "feat(roster): startLink, cancelLink, unlink, linkStatus, searchGamertags — the site's link flow over the shared stores"
```

---

### Task 6: Roster base writes — `baseFor`, `declareSolo`, `releaseSolo`, and the race against `unlink`

**Files:**
- Create: `packages/roster/src/base.ts`, `packages/roster/test/base.test.ts`
- Modify: `packages/roster/src/index.ts`, `packages/roster/test/exports.test.ts`, `apps/web/test/smoke.test.ts`

**Interfaces:**
- Consumes: `activeServerId` (Task 5), `lockDeclarations`, `declareSoloTx`, `releaseTx`, `raisedPolesFor`, `declarationForPlayer` from `@factions/declarations`.
- Produces:
  ```ts
  export const DECLARE_SOLO_REASONS = ["not-linked", "in-clan", "no-raise", "too-close", "pole-taken", "owner-has-base"] as const;
  export type DeclareSoloReason = (typeof DECLARE_SOLO_REASONS)[number];
  export type DeclareSoloOutcome = { ok: true } | { ok: false; reason: DeclareSoloReason };
  export type BaseView =
    | { linked: false }
    | { linked: true; gamertag: string; inClan: boolean;
        declaration: { poleKey: string; x: number; z: number; declaredAt: Date } | null;
        candidates: { poleKey: string; x: number; z: number; raisedAt: Date }[] };
  export function baseFor(discordId: string): Promise<BaseView>;
  export function declareSolo(discordId: string, poleKey: string): Promise<DeclareSoloOutcome>;
  export function releaseSolo(discordId: string): Promise<{ released: boolean }>;
  ```
  `candidates` are the poles the log has seen the player raise at (newest raise first), minus the one currently declared. `y` is dropped: a base is a point on the map, and height is neither shown nor needed.

- [ ] **Step 1: Write the failing tests**

`packages/roster/test/base.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, identityLinks, players, poles, events, admFiles, declarations,
  type Database,
} from "@factions/db";
import { RELEASED_POLE_GRACE_MS } from "@factions/domain";
import { declareTx, declarationForPlayer } from "@factions/declarations";
import { sql, eq } from "drizzle-orm";
import { baseForDb, declareSoloDb, releaseSoloDb } from "../src/base";
import { unlinkDb } from "../src/link";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-05T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const UID_A = "A".repeat(40);
const key = (x: number, z: number) => `${x.toFixed(2)}:100.00:${z.toFixed(2)}`;
const P1 = key(5000, 5000);
const P2 = key(6000, 6000);

describe("roster base writes", () => {
  let db: Database; let serverId = 0; let admFileId = 0; let line = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table declarations, poles, faction_members, factions, identity_links, players, events, raw_lines, adm_files, ceremonies, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    admFileId = a!.id; line = 0;
    await db.insert(players).values({ dayzId: UID_A, gamertag: "Ronald", firstSeenAt: now, lastSeenAt: now });
    await db.insert(identityLinks).values({ discordId: "d1", dayzId: UID_A, gamertag: "Ronald", verifiedAt: now });
  });

  const pole = (poleKey: string, x: number, z: number) => db.insert(poles).values({
    serverId, map: "livonia", poleKey, x: x.toFixed(2), y: "100.00", z: z.toFixed(2),
    currentTexture: "Flag_White", flagRaised: true, firstSeenAt: now, lastSeenAt: now, graceUntil: now,
  });
  const raise = async (dayzId: string, poleKey: string, x: number, z: number, at: Date) => {
    const [e] = await db.insert(events).values({
      serverId, admFileId, lineIndex: line++, type: "flag.raised", occurredAt: at,
      payload: { dayzId, gamertag: "G", texture: "Flag_White", poleKey, pole: { x, y: 100, z } },
    }).returning({ id: events.id });
    return e!.id;
  };

  it("an unlinked viewer sees nothing to do", async () => {
    expect(await baseForDb(db, "d-nobody")).toEqual({ linked: false });
  });

  it("lists the poles the player raised at, newest first, without y", async () => {
    await pole(P1, 5000, 5000); await pole(P2, 6000, 6000);
    await raise(UID_A, P1, 5000, 5000, ago(2000));
    await raise(UID_A, P2, 6000, 6000, ago(1000));
    await raise("STRANGER", key(7000, 7000), 7000, 7000, ago(500));
    const v = await baseForDb(db, "d1");
    expect(v).toMatchObject({ linked: true, gamertag: "Ronald", inClan: false, declaration: null });
    if (!v.linked) return;
    expect(v.candidates).toEqual([
      { poleKey: P2, x: 6000, z: 6000, raisedAt: ago(1000) },
      { poleKey: P1, x: 5000, z: 5000, raisedAt: ago(2000) },
    ]);
  });

  it("declares, then shows the declaration and drops it from the candidates", async () => {
    await pole(P1, 5000, 5000); await pole(P2, 6000, 6000);
    await raise(UID_A, P1, 5000, 5000, ago(2000));
    await raise(UID_A, P2, 6000, 6000, ago(1000));
    expect(await declareSoloDb(db, "d1", P1, now)).toEqual({ ok: true });
    const v = await baseForDb(db, "d1");
    if (!v.linked) throw new Error("linked");
    expect(v.declaration).toMatchObject({ poleKey: P1, x: 5000, z: 5000, declaredAt: now });
    expect(v.candidates.map((c) => c.poleKey)).toEqual([P2]);
  });

  it("refuses: not linked, no raise, in a clan", async () => {
    expect(await declareSoloDb(db, "d-nobody", P1, now)).toEqual({ ok: false, reason: "not-linked" });
    await pole(P1, 5000, 5000);
    expect(await declareSoloDb(db, "d1", P1, now)).toEqual({ ok: false, reason: "no-raise" });
    await raise(UID_A, P1, 5000, 5000, ago(1000));
    const [f] = await db.insert(factions).values({ serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", leaderDiscordId: "d1", createdAt: now }).returning();
    await db.insert(factionMembers).values({ factionId: f!.id, serverId, dayzId: UID_A, discordId: "d1", role: "leader", joinedAt: now });
    expect(await declareSoloDb(db, "d1", P1, now)).toEqual({ ok: false, reason: "in-clan" });
  });

  it("refuses too-close to another declared base — the 200 m rule runs inside the package", async () => {
    const near = key(5150, 5000);
    await pole(P1, 5000, 5000); await pole(near, 5150, 5000);
    const [f] = await db.insert(factions).values({ serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", leaderDiscordId: "d9", createdAt: now }).returning();
    const evidence = await raise("Z".repeat(40), near, 5150, 5000, ago(3000));
    await db.transaction((tx) => declareTx(tx, { serverId, poleKey: near, x: 5150, y: 100, z: 5000, owner: { factionId: f!.id }, evidence: { eventId: evidence }, at: ago(3000) }));
    await raise(UID_A, P1, 5000, 5000, ago(1000));
    expect(await declareSoloDb(db, "d1", P1, now)).toEqual({ ok: false, reason: "too-close" });
  });

  it("release deletes the declaration and stamps the pole's grace; nothing to release is false", async () => {
    await pole(P1, 5000, 5000);
    await raise(UID_A, P1, 5000, 5000, ago(1000));
    expect(await releaseSoloDb(db, "d1", now)).toEqual({ released: false });
    await declareSoloDb(db, "d1", P1, now);
    expect(await releaseSoloDb(db, "d1", now)).toEqual({ released: true });
    expect(await declarationForPlayer(db, serverId, UID_A)).toBeNull();
    const [p] = await db.select({ graceUntil: poles.graceUntil }).from(poles).where(eq(poles.poleKey, P1));
    expect(p!.graceUntil.getTime()).toBe(now.getTime() + RELEASED_POLE_GRACE_MS);
  });

  /**
   * Spec §13: a staged race for the new writer pair. `unlinkDb` and
   * `declareSoloDb` both start by taking the server's declaration lock, so a
   * third connection HOLDING that lock parks both; releasing it lets Postgres
   * pick an order. Either order must end with no link and no declaration —
   * declare-then-unlink releases it, unlink-then-declare refuses not-linked.
   * The invariant is asserted, as inbox 20 requires; the ordering is observed
   * via pg_stat_activity, never waited out.
   */
  it("unlink racing declareSolo never leaves a declaration without a link", async () => {
    await pole(P1, 5000, 5000);
    await raise(UID_A, P1, 5000, 5000, ago(1000));

    const holderDb = createClient(URL);
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let taken!: () => void;
    const isTaken = new Promise<void>((r) => { taken = r; });
    const holder = holderDb.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('declarations'), ${serverId})`);
      taken();
      await released;
    });
    try {
      await isTaken;
      const racers = Promise.all([unlinkDb(db, "d1", now), declareSoloDb(db, "d1", P1, now)]);
      for (let i = 0; i < 5000; i++) {
        const rows = await db.execute(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
        if (Number((rows as unknown as { n: number }[])[0]!.n) >= 2) break;
      }
      release();
      const [unlinked, declared] = await racers;
      expect(unlinked.ok).toBe(true);
      // Exactly one of the two orders happened; both are legal.
      if (declared.ok) expect(unlinked).toEqual({ ok: true, releasedBase: true });
      else expect(declared).toEqual({ ok: false, reason: "not-linked" });
    } finally {
      release();
      await holder.catch(() => {});
      await holderDb.$client.end();
    }
    expect(await db.select().from(declarations)).toEqual([]);
    expect(await db.select().from(identityLinks)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd packages/roster && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/base.test.ts
```
Expected: cannot resolve `../src/base`.

- [ ] **Step 3: `base.ts`**

```ts
import type { Database } from "@factions/db";
import { factionMembers, identityLinks } from "@factions/db";
import {
  declarationForPlayer, declareSoloTx, lockDeclarations, raisedPolesFor, releaseTx,
} from "@factions/declarations";
import { and, eq } from "drizzle-orm";
import { activeServerId } from "./server";

export const DECLARE_SOLO_REASONS = ["not-linked", "in-clan", "no-raise", "too-close", "pole-taken", "owner-has-base"] as const;
export type DeclareSoloReason = (typeof DECLARE_SOLO_REASONS)[number];
export type DeclareSoloOutcome = { ok: true } | { ok: false; reason: DeclareSoloReason };

export type BaseView =
  | { linked: false }
  | {
      linked: true; gamertag: string; inClan: boolean;
      declaration: { poleKey: string; x: number; z: number; declaredAt: Date } | null;
      candidates: { poleKey: string; x: number; z: number; raisedAt: Date }[];
    };

/**
 * /base's one read. ⚠️ The candidates are poles THIS player raised a flag
 * at — the log's own record of where they have been — and the declaration
 * is their own. No other player's pole ever passes through here (CLAUDE.md:
 * pole coordinates are a raid target). `y` is dropped: a base is a point on
 * the map.
 */
export async function baseForDb(db: Database, discordId: string): Promise<BaseView> {
  const [link] = await db.select({ dayzId: identityLinks.dayzId, gamertag: identityLinks.gamertag })
    .from(identityLinks).where(eq(identityLinks.discordId, discordId));
  if (!link) return { linked: false };
  const serverId = await activeServerId(db);
  const [member] = await db.select({ id: factionMembers.id }).from(factionMembers)
    .where(and(eq(factionMembers.serverId, serverId), eq(factionMembers.dayzId, link.dayzId)));
  const declaration = await declarationForPlayer(db, serverId, link.dayzId);
  const raised = await raisedPolesFor(db, serverId, link.dayzId);
  return {
    linked: true, gamertag: link.gamertag, inClan: member !== undefined,
    declaration: declaration
      ? { poleKey: declaration.poleKey, x: Number(declaration.x), z: Number(declaration.z), declaredAt: declaration.declaredAt }
      : null,
    candidates: raised
      .filter((r) => r.poleKey !== declaration?.poleKey)
      .map((r) => ({ poleKey: r.poleKey, x: r.x, z: r.z, raisedAt: r.occurredAt })),
  };
}

/**
 * Solo declare (spec §5.2), the site's way. Lock order (spec §4.12): the
 * server's declaration lock FIRST, then the link read, then `declareSoloTx`
 * (declarations → poles). Taking the advisory lock before reading the link
 * is what makes this safe against `unlink`, which takes the same lock before
 * releasing and deleting: whichever commits first, the other sees its result.
 * The 200 m rule, the one-base-per-player rule and the evidence requirement
 * are all `declareTx`'s and are not restated here.
 */
export async function declareSoloDb(db: Database, discordId: string, poleKey: string, now: Date): Promise<DeclareSoloOutcome> {
  return db.transaction(async (tx) => {
    const serverId = await activeServerId(tx);
    await lockDeclarations(tx, serverId);
    const [link] = await tx.select({ dayzId: identityLinks.dayzId }).from(identityLinks)
      .where(eq(identityLinks.discordId, discordId));
    if (!link) return { ok: false as const, reason: "not-linked" as const };
    const out = await declareSoloTx(tx, { serverId, dayzId: link.dayzId, poleKey, at: now });
    return out.ok ? { ok: true as const } : { ok: false as const, reason: out.reason };
  });
}

/** Release the caller's solo base; the pole's 3-day grace is `releaseTx`'s. */
export async function releaseSoloDb(db: Database, discordId: string, now: Date): Promise<{ released: boolean }> {
  return db.transaction(async (tx) => {
    const serverId = await activeServerId(tx);
    const [link] = await tx.select({ dayzId: identityLinks.dayzId }).from(identityLinks)
      .where(eq(identityLinks.discordId, discordId));
    if (!link) return { released: false };
    await lockDeclarations(tx, serverId);
    return { released: await releaseTx(tx, { dayzId: link.dayzId, serverId }, now) };
  });
}
```

- [ ] **Step 4: Export and re-pin**

`packages/roster/src/index.ts` — add:
```ts
import { baseForDb, declareSoloDb, releaseSoloDb, type BaseView, type DeclareSoloOutcome, type DeclareSoloReason } from "./base";
export { DECLARE_SOLO_REASONS } from "./base";
export type { BaseView, DeclareSoloOutcome, DeclareSoloReason };

/** /base's one read: your raises, your declaration. */
export function baseFor(discordId: string): Promise<BaseView> {
  return baseForDb(db(), discordId);
}
/** Declare a solo base at a pole you have raised at. Every rule is inside. */
export function declareSolo(discordId: string, poleKey: string): Promise<DeclareSoloOutcome> {
  return declareSoloDb(db(), discordId, poleKey, new Date());
}
export function releaseSolo(discordId: string): Promise<{ released: boolean }> {
  return releaseSoloDb(db(), discordId, new Date());
}
```
Both pins become, in `Object.keys(...).sort()` order:
`["DECLARE_SOLO_REASONS", "ISSUE_OUTCOME_KINDS", "baseFor", "cancelLink", "declareSolo", "linkStatus", "releaseSolo", "searchGamertags", "startLink", "unlink", "viewerFor"]`.
The second test in `exports.test.ts` (`"declaration"`, `"reserve"`, `"insert"` … must not appear in a lowercased export name) still passes: `declaresolo` and `declare_solo_reasons` contain neither `declaration` nor `reserve`. Do not weaken that list.

- [ ] **Step 5: Run and gate**

```bash
cd packages/roster && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run
cd ../../apps/web && npx vitest run
```
Full gate: 26/26. Run the race test five times in a row (`npx vitest run test/base.test.ts` ×5) — it must never leave a declaration behind.

- [ ] **Step 6: Commit**

```bash
git add packages/roster apps/web/test/smoke.test.ts
git commit -m "feat(roster): baseFor, declareSolo, releaseSolo — solo bases from the site, raced against unlink"
```

---

### Task 7: `/link` — autocomplete, three tickets, a 5 s poll; unlink on `/me`

**Files:**
- Create: `apps/web/lib/api.ts`, `apps/web/lib/link-copy.ts`, `apps/web/test/link-copy.test.ts`, `apps/web/app/link/page.tsx`, `apps/web/app/link/link-flow.tsx`, `apps/web/app/api/link/search/route.ts`, `apps/web/app/api/link/start/route.ts`, `apps/web/app/api/link/cancel/route.ts`, `apps/web/app/api/link/status/route.ts`, `apps/web/app/api/link/unlink/route.ts`
- Modify: `apps/web/app/me/page.tsx`

**Interfaces:**
- Consumes from `@factions/roster`: `linkStatus`, `startLink`, `cancelLink`, `unlink`, `searchGamertags`, `ISSUE_OUTCOME_KINDS`, types `LinkStatus`, `IssueOutcome`, `IssueOutcomeKind`. From `@/lib/viewer`: `currentSession`. From `@factions/domain`: `LINK_EMOTES`.
- Produces: `sessionOr401()` in `lib/api.ts`; JSON shapes below (dates as ISO strings). All routes are gated by the existing middleware (nothing under `/api/link/` is in `PUBLIC_PREFIXES`; `auth-gate.test.ts` pins that list and is not edited). Every JSON response sets `Cache-Control: no-store, private`.

  | Route | Method | Body / query | Response |
  |---|---|---|---|
  | `/api/link/search` | GET | `?q=` | `{ matches: { dayzId, gamertag }[] }` |
  | `/api/link/start` | POST | `{ dayzId: string; newSequence?: boolean }` | `{ outcome: IssueOutcome }` with `challenge.expiresAt`/`issuedAt` as ISO strings |
  | `/api/link/cancel` | POST | — | `{ canceled: boolean }` |
  | `/api/link/status` | GET | — | `LinkStatus` with ISO dates |
  | `/api/link/unlink` | POST (form) | — | 303 → `/me?unlink=ok|in-clan|not-linked` |

- [ ] **Step 1: The pure copy module and its failing test**

`apps/web/lib/link-copy.ts` — every outcome the package can return has a line here, and the test proves it. Wording: the bot's, minus Discord markup, plus "on this page" where the bot said "run `/link`".
```ts
import type { IssueOutcome, IssueOutcomeKind } from "@factions/roster";

/** What /link says for each refusal. "issued" and "live" render the challenge card instead of a line. */
export const ISSUE_COPY: Record<IssueOutcomeKind, (o: IssueOutcome) => string> = {
  "already-linked": (o) => `You are already linked to ${name(o)}. Unlink on your page first if you need to bind a different character.`,
  "just-linked": (o) => `You just finished linking to ${name(o)}. Unlink on your page first if you need to bind a different character.`,
  "unknown-character": () => "The server has not seen that character. Pick one from the list — only characters the event log has seen can be linked.",
  "taken": (o) => `${name(o)} is already linked to another Discord account. If that character is yours, ask an admin.`,
  "live": (o) => `You already have a challenge open for ${name(o)}.`,
  "too-many-draws": (o) => `You have asked for too many sequences for ${name(o)} today. Try again tomorrow — or, if there is an emote you cannot find on the wheel, say so in the Discord rather than working around it.`,
  "issued": (o) => `Challenge issued for ${name(o)}.`,
  "held-by-other": (o) => `Someone else is verifying ${name(o)} right now, so a challenge cannot be issued for that character yet. Their attempt ends ${o.kind === "held-by-other" ? at(o.expiresAt) : ""}. If that character is yours, ask an admin.`,
  "unavailable": () => "Could not issue a challenge right now. Try again in a moment.",
};

/** What /link says about how the last challenge ended, from `LinkStatus.ended`. */
export const ENDED_COPY = {
  "expired": "Your last challenge expired before the three emotes were seen. Draw a new one when you are in game and ready.",
  "budget-exhausted": "Your last challenge was canceled: too many emotes were performed before the sequence was completed. Draw a new one and perform just those three, in order. If one of them is not on your emote wheel, say so in the Discord — it may be an emote no one can perform.",
  "already-linked": "Your last challenge was canceled: that character is already linked to another Discord account. If it is yours — you changed Discord accounts, say — ask an admin to move the link.",
} as const;

/** What /me says after an unlink attempt, keyed by the ?unlink= code. Never echoes the raw value. */
export const UNLINK_COPY: Record<string, string> = {
  ok: "Unlinked. Your solo base, if you had one, has been released.",
  "in-clan": "You are in a clan. Leave it before unlinking — a clan's leader is identified by this link.",
  "not-linked": "You were not linked to a character.",
};

function name(o: IssueOutcome): string {
  return "gamertag" in o ? o.gamertag : "that character";
}
function at(d: Date | string): string {
  return new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}

/** "9:41" from a millisecond remainder; "0:00" once expired. */
export function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
```
`apps/web/test/link-copy.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { ISSUE_OUTCOME_KINDS } from "@factions/roster";
import { ISSUE_COPY, ENDED_COPY, UNLINK_COPY, formatRemaining } from "../lib/link-copy";

describe("link copy", () => {
  it("has a line for every outcome the package can return", () => {
    for (const kind of ISSUE_OUTCOME_KINDS) {
      expect(typeof ISSUE_COPY[kind]).toBe("function");
      expect(ISSUE_COPY[kind]({ kind: "unknown-character" }).length).toBeGreaterThan(10);
    }
  });
  it("covers every way a challenge can end without the player", () => {
    expect(Object.keys(ENDED_COPY).sort()).toEqual(["already-linked", "budget-exhausted", "expired"]);
  });
  it("covers every unlink code the route can redirect with", () => {
    expect(Object.keys(UNLINK_COPY).sort()).toEqual(["in-clan", "not-linked", "ok"]);
  });
  it("formats a remainder as m:ss and clamps at zero", () => {
    expect(formatRemaining(9 * 60_000 + 41_000)).toBe("9:41");
    expect(formatRemaining(5_000)).toBe("0:05");
    expect(formatRemaining(-1)).toBe("0:00");
  });
});
```
Note: importing `@factions/roster` in a web test loads `client.ts`, which throws only when `db()` is *called*; the constant import is safe. If vitest fails to resolve the package's extensionless imports, add `resolve: { conditions: ["import"] }`… it will not — `moduleResolution: Bundler` and vitest both resolve `./link` to `./link.ts`; this is how `smoke.test.ts` already imports the package.

- [ ] **Step 2: Run, expect failure**

```bash
cd apps/web && npx vitest run test/link-copy.test.ts
```
Expected: cannot resolve `../lib/link-copy`.

- [ ] **Step 3: `lib/api.ts` and the five route handlers**

`apps/web/lib/api.ts`:
```ts
import { NextResponse } from "next/server";
import { currentSession } from "./viewer";
import type { Session } from "./auth/session";

/** Every personal read leaves with this. Nothing here is cacheable by anyone. */
export const NO_STORE = { "Cache-Control": "no-store, private" } as const;

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/**
 * The route handlers' gate. The middleware has already refused anonymous
 * requests to /api/link/* and /api/base/*; a null here means the cookie was
 * tampered with or the secret rotated. 401 as JSON, never a redirect — the
 * caller is a fetch() from the page, which reloads on 401.
 */
export async function sessionOr401(): Promise<{ session: Session } | { response: NextResponse }> {
  const session = await currentSession();
  if (!session) return { response: json({ error: "signed-out" }, 401) };
  return { session };
}
```
`apps/web/app/api/link/search/route.ts`:
```ts
import type { NextRequest } from "next/server";
import { searchGamertags } from "@factions/roster";
import { json, sessionOr401 } from "@/lib/api";

export async function GET(req: NextRequest) {
  const s = await sessionOr401();
  if ("response" in s) return s.response;
  const q = req.nextUrl.searchParams.get("q") ?? "";
  return json({ matches: await searchGamertags(q.slice(0, 64)) });
}
```
`apps/web/app/api/link/start/route.ts`:
```ts
import type { NextRequest } from "next/server";
import { startLink } from "@factions/roster";
import { json, sessionOr401 } from "@/lib/api";

/**
 * ⚠️ Re-validated by the package, not trusted from the client: `dayzId` is
 * whatever the browser sent. `issueChallenge` refuses an unknown or taken
 * character server-side, and the two partial unique indexes are the
 * enforcement behind a lost race.
 */
export async function POST(req: NextRequest) {
  const s = await sessionOr401();
  if ("response" in s) return s.response;
  let body: { dayzId?: unknown; newSequence?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad-json" }, 400); }
  if (typeof body.dayzId !== "string" || body.dayzId.length === 0 || body.dayzId.length > 64) return json({ error: "bad-dayz-id" }, 400);
  const outcome = await startLink(s.session.sub, body.dayzId, { newSequence: body.newSequence === true });
  return json({ outcome });
}
```
`apps/web/app/api/link/cancel/route.ts`:
```ts
import { cancelLink } from "@factions/roster";
import { json, sessionOr401 } from "@/lib/api";

export async function POST() {
  const s = await sessionOr401();
  if ("response" in s) return s.response;
  return json(await cancelLink(s.session.sub));
}
```
`apps/web/app/api/link/status/route.ts`:
```ts
import { linkStatus } from "@factions/roster";
import { json, sessionOr401 } from "@/lib/api";

/** Polled every 5 s by /link while a challenge is open. */
export async function GET() {
  const s = await sessionOr401();
  if ("response" in s) return s.response;
  return json(await linkStatus(s.session.sub));
}
```
`apps/web/app/api/link/unlink/route.ts`:
```ts
import { NextResponse, type NextRequest } from "next/server";
import { unlink } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { siteUrl } from "@/lib/auth/site-url";

/**
 * ⚠️ POST only, from the form on /me — a GET unlink could be triggered by
 * any <img> on the internet, the same reasoning as the logout route. The
 * refusal-while-in-a-clan and the solo-base release are the package's, not
 * this file's.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const origin = process.env.WEB_BASE_URL ?? req.nextUrl.origin;
  const session = await currentSession();
  if (!session) return NextResponse.redirect(siteUrl(origin, "/login?next=/me"), { status: 303 });
  const out = await unlink(session.sub);
  const code = out.ok ? "ok" : out.reason;
  return NextResponse.redirect(siteUrl(origin, `/me?unlink=${code}`), { status: 303 });
}
```

- [ ] **Step 4: The page and the client component**

`apps/web/app/link/page.tsx`:
```tsx
import type { Metadata } from "next";
import { linkStatus } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { LinkFlow } from "./link-flow";

export const metadata: Metadata = {
  title: "Clan Wars — link your character",
  robots: { index: false, follow: false },
};

/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

export default async function LinkPage() {
  const session = await currentSession();
  if (!session) {
    return (
      <main className="mx-auto max-w-[34rem] px-4 py-10">
        <p className="text-ink-2">Your session could not be read. <a className="text-gold underline-offset-4 hover:underline" href="/login?next=/link">Sign in again</a>.</p>
      </main>
    );
  }
  const status = await linkStatus(session.sub);
  // Dates cross to the client as strings; the component parses them.
  return (
    <main className="flex min-h-dvh flex-col items-center px-4 pb-18 pt-7">
      <LinkFlow initial={JSON.parse(JSON.stringify(status))} />
    </main>
  );
}
```
`apps/web/app/link/link-flow.tsx` — the whole flow, one client component. Structure and copy are the deleted prototype's (`git show 90061f2^:apps/web/app/link/prove-it.tsx`, `choose-character.tsx`), on Tailwind tokens and driven by the API:
```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { LINK_EMOTES } from "@factions/domain";
import type { IssueOutcome, LinkStatus } from "@factions/roster";
import { ENDED_COPY, ISSUE_COPY, formatRemaining } from "@/lib/link-copy";

/** `LinkStatus` after a trip through JSON: every Date is an ISO string. */
type Wire<T> = T extends Date ? string : T extends object ? { [K in keyof T]: Wire<T[K]> } : T;
type Status = Wire<LinkStatus>;
type Outcome = Wire<IssueOutcome>;

const POLL_MS = 5_000;

const card = "w-full max-w-[390px] rounded-lg border border-rule bg-frame p-6";
const label = "font-mono text-xs uppercase tracking-[0.18em] text-muted";
const button = "flex min-h-[52px] w-full items-center justify-center rounded-md bg-gold px-4 font-display text-base text-ground disabled:opacity-40";
const quiet = "font-mono text-xs uppercase tracking-[0.18em] text-muted underline-offset-4 hover:underline disabled:opacity-40";

export function LinkFlow({ initial }: { initial: Status }) {
  const [status, setStatus] = useState<Status>(initial);
  const [notice, setNotice] = useState<string | null>(initial.ended ? ENDED_COPY[initial.ended] : null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const res = await fetch("/api/link/status", { cache: "no-store" });
    if (res.status === 401) { window.location.assign("/login?next=/link"); return; }
    if (!res.ok) return;
    const next: Status = await res.json();
    setStatus((prev) => {
      // A challenge that vanished between polls ended without us: say why.
      if (prev.challenge && !next.challenge && !next.link && next.ended) setNotice(ENDED_COPY[next.ended]);
      return next;
    });
  };

  // ⚠️ Poll only while a challenge is open. Emotes reach the database in the
  // bot's tick batches, so a confirmation lands seconds to a minute behind
  // the emote; five seconds is often enough to feel live without hammering.
  useEffect(() => {
    if (!status.challenge) return;
    const id = setInterval(() => { void refresh(); }, POLL_MS);
    return () => clearInterval(id);
  }, [status.challenge?.id]);

  const start = async (dayzId: string, newSequence = false) => {
    setBusy(true);
    try {
      const res = await fetch("/api/link/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dayzId, newSequence }) });
      if (res.status === 401) { window.location.assign("/login?next=/link"); return; }
      const { outcome } = (await res.json()) as { outcome: Outcome };
      if (outcome.kind === "issued" || outcome.kind === "live") {
        setNotice(outcome.kind === "issued" && outcome.switchedFrom
          ? `Canceled your challenge for ${outcome.switchedFrom} — that sequence no longer works. Here is the new one.`
          : null);
        await refresh();
      } else {
        setNotice(ISSUE_COPY[outcome.kind](outcome as unknown as IssueOutcome));
      }
    } finally { setBusy(false); }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      await fetch("/api/link/cancel", { method: "POST" });
      setNotice(null);
      await refresh();
    } finally { setBusy(false); }
  };

  if (status.link) return <Verified gamertag={status.link.gamertag} verifiedAt={status.link.verifiedAt} />;
  if (status.challenge) {
    return <ProveIt challenge={status.challenge} notice={notice} busy={busy}
      onDraw={() => start(currentTarget(status), true)} onCancel={cancel} />;
  }
  return <ChooseCharacter notice={notice} busy={busy} onClaim={(dayzId) => start(dayzId)} />;
}

/** The open challenge's target, for the re-roll. Read from status so the client never guesses a UID. */
function currentTarget(status: Status): string {
  return status.challenge?.targetDayzId ?? "";
}

function ChooseCharacter({ notice, busy, onClaim }: { notice: string | null; busy: boolean; onClaim: (dayzId: string) => void }) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<{ dayzId: string; gamertag: string }[]>([]);
  const [denial, setDenial] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = query.trim();
    if (!q) { setMatches([]); return; }
    timer.current = setTimeout(async () => {
      const res = await fetch(`/api/link/search?q=${encodeURIComponent(q)}`, { cache: "no-store" });
      if (res.ok) setMatches((await res.json()).matches);
    }, 200);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [query]);

  /**
   * ⚠️ Resolved from the typed text on submit, not from whatever row was last
   * clicked — autocomplete is a suggestion, and the package re-validates the
   * UID anyway. A full gamertag typed without touching the list still works.
   */
  const claim = () => {
    const typed = query.trim().toLowerCase();
    const found = matches.find((m) => m.gamertag.toLowerCase() === typed);
    if (!found) { setDenial("The server has not seen that character. Pick one from the list — only characters the event log has seen can be linked."); return; }
    setDenial(null);
    onClaim(found.dayzId);
  };

  return (
    <div className={card}>
      <div className={label}>Step 2 of 3 — name your character</div>
      <h1 className="mt-3 font-display text-3xl leading-tight text-ink">Which one is you?</h1>
      <p className="mt-3 text-base leading-relaxed text-ink-2">The gamertag you play under. Only characters the server has actually seen are listed — if yours is missing, play a session first.</p>
      {(notice || denial) && <Refusal label="Not issued">{denial ?? notice}</Refusal>}
      <input className="mt-4 min-h-[52px] w-full rounded-md border border-rule-2 bg-surface px-4 font-mono text-ink" value={query}
        onChange={(e) => { setQuery(e.target.value); setDenial(null); }} placeholder="Gamertag" aria-label="Gamertag" autoComplete="off" spellCheck={false} />
      <div className="mt-2 flex flex-col gap-1" role="listbox" aria-label="Characters the server has seen">
        {query.trim() && matches.length === 0 && <div className="px-2 py-2 font-mono text-xs text-muted">No unclaimed character by that name</div>}
        {matches.map((m) => (
          <button key={m.dayzId} type="button" role="option" aria-selected={m.gamertag.toLowerCase() === query.trim().toLowerCase()}
            className="min-h-[44px] rounded-md px-3 text-left font-mono text-ink hover:bg-surface" onClick={() => setQuery(m.gamertag)}>
            {m.gamertag}
          </button>
        ))}
      </div>
      <button className={`mt-6 ${button}`} type="button" onClick={claim} disabled={busy || !query.trim()}>Claim it</button>
      <div className="mt-4 font-mono text-xs leading-relaxed text-muted">One character per Discord account. You will prove it is you with three emotes in game.</div>
    </div>
  );
}

function ProveIt({ challenge, notice, busy, onDraw, onCancel }: {
  challenge: NonNullable<Status["challenge"]>; notice: string | null; busy: boolean; onDraw: () => void; onCancel: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const remaining = new Date(challenge.expiresAt).getTime() - now;
  const total = challenge.steps.length;

  return (
    <div className={`${card} border-rust`}>
      <div className={label}>Step 3 of 3 — one step left</div>
      <h1 className="mt-3 font-display text-3xl leading-tight text-ink">Prove it&rsquo;s you</h1>
      <div className="mt-2 font-mono text-lg text-gold">{challenge.gamertag}</div>
      {notice && <Refusal label="Switched" neutral>{notice}</Refusal>}
      <p className="mt-3 text-base leading-relaxed text-ink-2">In game as that character, open the emote wheel and perform these {total}, in this order. Other emotes in between are fine — the order is what counts.</p>
      {/* ⚠️ An ordered list, because the order IS the proof. */}
      <ol className="mt-4 flex flex-col gap-2">
        {challenge.steps.map((step, i) => (
          <li key={step.token} className={`flex min-h-[56px] items-center gap-3 rounded-md border px-4 ${step.confirmed ? "border-olive bg-surface" : "border-rule-2"}`}>
            <span className={`font-mono text-xs ${step.confirmed ? "text-olive" : "text-muted"}`}>{i + 1}</span>
            <span className={`font-display text-lg ${step.confirmed ? "text-olive line-through" : "text-ink"}`}>{step.label}</span>
            {step.confirmed && <span className="ml-auto font-mono text-xs uppercase tracking-[0.18em] text-olive">Confirmed</span>}
          </li>
        ))}
      </ol>
      {/* ⚠️ A SIBLING of the list, never an attribute on it: aria-live on the <ol> strips list semantics in several screen readers. */}
      <p role="status" aria-live="polite" className="sr-only">{challenge.confirmed} of {total} confirmed</p>
      <div className="mt-4 rounded-md border border-rule-2 bg-surface p-3 text-sm text-ink-2">
        <strong className="text-ink">The server has confirmed {challenge.confirmed} of {total}.</strong>{" "}
        Emotes reach us from the server log in batches, so a confirmation can take up to a minute to appear. This page checks every few seconds; perform all {LINK_EMOTES} and you can log off — the link catches up on its own.
      </div>
      <div className="mt-4 flex items-center justify-between">
        <div className="font-mono text-xs text-muted">Expires in {formatRemaining(remaining)}</div>
        <div className="flex gap-4">
          <button type="button" className={quiet} onClick={onDraw} disabled={busy || challenge.drawsLeft === 0}>New sequence</button>
          <button type="button" className={quiet} onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
      </div>
      <div className="mt-3 font-mono text-xs text-muted">
        {challenge.drawsLeft > 0
          ? `Can’t find one of these on the wheel? Draw a new sequence — ${challenge.drawsLeft} ${challenge.drawsLeft === 1 ? "draw" : "draws"} left today.`
          : "Out of draws for this character today. If an emote is missing from your wheel, say so in the Discord rather than working around it."}
      </div>
    </div>
  );
}

function Verified({ gamertag, verifiedAt }: { gamertag: string; verifiedAt: string }) {
  return (
    <div className={card}>
      <div className={label}>Linked</div>
      <h1 className="mt-3 font-display text-3xl leading-tight text-ink">You are {gamertag}</h1>
      <p className="mt-3 text-base leading-relaxed text-ink-2">Linked on {new Date(verifiedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}. Your clan, your base and your map hang off this.</p>
      <a className={`mt-6 ${button}`} href="/base">Your base</a>
      <a className={`mt-3 ${quiet} block text-center`} href="/me">Your page</a>
    </div>
  );
}

function Refusal({ label: title, neutral = false, children }: { label: string; neutral?: boolean; children: React.ReactNode }) {
  return (
    <div className={`mt-4 rounded-md border p-3 ${neutral ? "border-rule-2 bg-surface" : "border-rust bg-surface"}`} role={neutral ? "status" : "alert"}>
      <div className={label}>{title}</div>
      <div className="mt-1 text-sm text-ink">{children}</div>
    </div>
  );
}
```
One detail the implementer must keep straight: `Refusal` takes a prop named `label`, which would shadow the module-level `label` class string — the destructuring renames it (`label: title`) as shown; do not leave both named `label`.

- [ ] **Step 5: `/me` links to `/link` and offers unlink**

In `apps/web/app/me/page.tsx`: accept `searchParams`, read `unlink` through `UNLINK_COPY` (import from `@/lib/link-copy`), and replace the "Your character" section body:
```tsx
        {viewer.link ? (
          <>
            <p className="mt-2 text-ink">Linked to <span className="font-mono">{viewer.link.gamertag}</span></p>
            <p className="mt-3 text-sm text-ink-2">
              {viewer.clan
                ? "Unlinking is refused while you are in a clan — leave it first."
                : "Unlinking releases your solo base, if you have declared one."}
            </p>
            <form className="mt-3" action="/api/link/unlink" method="post">
              <button className="font-mono text-xs uppercase tracking-[0.18em] text-muted underline-offset-4 hover:underline" type="submit" disabled={viewer.clan !== null}>Unlink</button>
            </form>
          </>
        ) : (
          <p className="mt-2 text-ink-2">
            Not linked yet. <a className="text-gold underline-offset-4 hover:underline" href="/link">Link your character</a> — three emotes in game, ten minutes.
          </p>
        )}
```
Above the two sections, when `UNLINK_COPY[code]` resolves, render `<p role="status" className="mt-6 rounded-md border border-rule-2 bg-surface p-3 text-sm text-ink">{copy}</p>`. The "ten minutes" in that sentence is the guide's `LINK_TTL_MS`; write it as `{LINK_TTL_MS / 60_000} minutes` with the import from `@factions/domain`, not as a literal. Also add a line under "Your clan": `{!viewer.clan && viewer.link && <a className="text-gold underline-offset-4 hover:underline" href="/base">Your solo base</a>}`. The disabled Unlink button is a convenience; the package refuses regardless.

- [ ] **Step 6: Run the web suite, typecheck, build**

```bash
cd apps/web && npx vitest run && npx tsc --noEmit
DATABASE_URL="postgres://factions:factions@localhost:5434/factions_test_roster" SESSION_SECRET=x pnpm build 2>&1 | tail -20
```
Expected: `copy-vocabulary`, `request-time-rendering` (now also `/link`), `auth-gate`, `smoke`, `link-copy` all green; the build lists `ƒ /link`, `ƒ /me`, and the five `ƒ /api/link/*` routes. Then the full gate, 26/26.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "feat(web): /link — autocomplete, three emote tickets, a 5 s poll; unlink from /me"
```

---

### Task 8: `/base` — declare and release a solo base

**Files:**
- Create: `apps/web/lib/base-copy.ts`, `apps/web/test/base-copy.test.ts`, `apps/web/app/base/page.tsx`, `apps/web/app/api/base/declare/route.ts`, `apps/web/app/api/base/release/route.ts`

**Interfaces:**
- Consumes from `@factions/roster`: `baseFor`, `declareSolo`, `releaseSolo`, `DECLARE_SOLO_REASONS`, types `BaseView`, `DeclareSoloReason`. From `@factions/domain`: `MIN_BASE_SPACING_M`, `WATCH_ZONE_RADIUS_M`, `RELEASED_POLE_GRACE_MS`, `SOLO_LAPSE_MS`.
- Produces: `POST /api/base/declare` (form field `poleKey`) → 303 `/base?result=declared|<reason>`; `POST /api/base/release` (form field `confirm=yes`) → 303 `/base?result=released|nothing|unconfirmed`.

- [ ] **Step 1: Copy module and failing test**

`apps/web/lib/base-copy.ts`:
```ts
import { MIN_BASE_SPACING_M, RELEASED_POLE_GRACE_MS, SOLO_LAPSE_MS, WATCH_ZONE_RADIUS_M } from "@factions/domain";
import type { DeclareSoloReason } from "@factions/roster";

const DAY = 86_400_000;
export const days = (ms: number) => `${Math.round(ms / DAY)} day${Math.round(ms / DAY) === 1 ? "" : "s"}`;

/** What /base says for each `declareSolo` refusal. The guide's wording (ch. 4) for the 200 m rule. */
export const DECLARE_COPY: Record<DeclareSoloReason, string> = {
  "not-linked": "Link your character first.",
  "in-clan": "You are in a clan, so your base is the clan's. Solo declarations are for players outside one.",
  "no-raise": "The server log has not seen you raise a flag at that pole. Raise it, wait for the log to catch up, and try again.",
  "too-close": `Too close to another declared base. No two declared bases sit within ${MIN_BASE_SPACING_M} m of each other — first declared wins. The map cannot show you private bases, so this refusal is your first warning that one is nearby.`,
  "pole-taken": "That pole is already declared by someone else.",
  "owner-has-base": "You already have a declared base. Release it before declaring another.",
};

/** Every code the two route handlers can redirect with. */
export const RESULT_COPY: Record<string, string> = {
  declared: `Declared. Your ${WATCH_ZONE_RADIUS_M} m watch zone is live. Keep raising your flag there — a solo base lapses after ${days(SOLO_LAPSE_MS)} without your raise.`,
  released: `Released. The pole stays private for ${days(RELEASED_POLE_GRACE_MS)}, then becomes public if nobody declares it.`,
  nothing: "You had no declared base to release.",
  unconfirmed: "Tick the box to confirm before releasing.",
  ...DECLARE_COPY,
};
```
`apps/web/test/base-copy.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { DECLARE_SOLO_REASONS } from "@factions/roster";
import { MIN_BASE_SPACING_M } from "@factions/domain";
import { DECLARE_COPY, RESULT_COPY, days } from "../lib/base-copy";

describe("base copy", () => {
  it("has a line for every declareSolo refusal", () => {
    for (const r of DECLARE_SOLO_REASONS) expect(DECLARE_COPY[r].length).toBeGreaterThan(10);
  });
  it("prints the spacing from rules.ts, not a literal", () => {
    expect(DECLARE_COPY["too-close"]).toContain(`${MIN_BASE_SPACING_M} m`);
  });
  it("covers the route handlers' own codes", () => {
    for (const code of ["declared", "released", "nothing", "unconfirmed"]) expect(RESULT_COPY[code]).toBeTruthy();
  });
  it("pluralises days", () => {
    expect(days(86_400_000)).toBe("1 day");
    expect(days(3 * 86_400_000)).toBe("3 days");
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd apps/web && npx vitest run test/base-copy.test.ts
```
Expected: cannot resolve `../lib/base-copy`.

- [ ] **Step 3: Route handlers**

`apps/web/app/api/base/declare/route.ts`:
```ts
import { NextResponse, type NextRequest } from "next/server";
import { declareSolo } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { siteUrl } from "@/lib/auth/site-url";

/** POST from the form on /base. Every rule — 200 m, one base, evidence — is the package's. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const origin = process.env.WEB_BASE_URL ?? req.nextUrl.origin;
  const session = await currentSession();
  if (!session) return NextResponse.redirect(siteUrl(origin, "/login?next=/base"), { status: 303 });
  const form = await req.formData();
  const poleKey = form.get("poleKey");
  if (typeof poleKey !== "string" || poleKey.length === 0 || poleKey.length > 64) {
    return NextResponse.redirect(siteUrl(origin, "/base?result=no-raise"), { status: 303 });
  }
  const out = await declareSolo(session.sub, poleKey);
  return NextResponse.redirect(siteUrl(origin, `/base?result=${out.ok ? "declared" : out.reason}`), { status: 303 });
}
```
`apps/web/app/api/base/release/route.ts`:
```ts
import { NextResponse, type NextRequest } from "next/server";
import { releaseSolo } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { siteUrl } from "@/lib/auth/site-url";

/** POST from the form on /base; requires the confirm checkbox — a release starts a 3-day clock on the pole. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const origin = process.env.WEB_BASE_URL ?? req.nextUrl.origin;
  const session = await currentSession();
  if (!session) return NextResponse.redirect(siteUrl(origin, "/login?next=/base"), { status: 303 });
  const form = await req.formData();
  if (form.get("confirm") !== "yes") return NextResponse.redirect(siteUrl(origin, "/base?result=unconfirmed"), { status: 303 });
  const { released } = await releaseSolo(session.sub);
  return NextResponse.redirect(siteUrl(origin, `/base?result=${released ? "released" : "nothing"}`), { status: 303 });
}
```

- [ ] **Step 4: The page**

`apps/web/app/base/page.tsx`:
```tsx
import type { Metadata } from "next";
import { baseFor } from "@factions/roster";
import { WATCH_ZONE_RADIUS_M } from "@factions/domain";
import { currentSession } from "@/lib/viewer";
import { RESULT_COPY } from "@/lib/base-copy";

export const metadata: Metadata = {
  title: "Clan Wars — your base",
  robots: { index: false, follow: false },
};

/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

const label = "font-mono text-xs uppercase tracking-[0.18em] text-muted";
const when = (d: Date) => d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
/** Metres, whole. These are the viewer's own raises; nobody else's pole reaches this page. */
const at = (x: number, z: number) => `${Math.round(x)}, ${Math.round(z)}`;

export default async function BasePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await currentSession();
  if (!session) {
    return (
      <main className="mx-auto max-w-[34rem] px-4 py-10">
        <p className="text-ink-2">Your session could not be read. <a className="text-gold underline-offset-4 hover:underline" href="/login?next=/base">Sign in again</a>.</p>
      </main>
    );
  }
  const params = await searchParams;
  // ⚠️ Looked up, never echoed: ?result= is attacker-supplied.
  const result = typeof params.result === "string" ? RESULT_COPY[params.result] : undefined;
  const view = await baseFor(session.sub);

  return (
    <main className="mx-auto max-w-[34rem] px-4 py-10">
      <p className={label}>Your base</p>
      <h1 className="mt-1 font-display text-3xl text-ink">Solo declaration</h1>
      {result && <p role="status" className="mt-6 rounded-md border border-rule-2 bg-surface p-3 text-sm text-ink">{result}</p>}

      {!view.linked && (
        <p className="mt-6 text-ink-2"><a className="text-gold underline-offset-4 hover:underline" href="/link">Link your character</a> first — a base is declared by the character that raised the flag.</p>
      )}

      {view.linked && view.inClan && (
        <p className="mt-6 text-ink-2">You are in a clan, so your base is the clan&rsquo;s. Solo declarations are for players outside one.</p>
      )}

      {view.linked && !view.inClan && (
        <>
          <section className="mt-8 rounded-lg border border-rule bg-frame p-5">
            <h2 className={label}>Declared</h2>
            {view.declaration ? (
              <>
                <p className="mt-2 font-mono text-ink">{at(view.declaration.x, view.declaration.z)}</p>
                <p className="mt-1 text-sm text-ink-2">Declared {when(view.declaration.declaredAt)}. Your {WATCH_ZONE_RADIUS_M} m watch zone is live.</p>
                <form className="mt-4" action="/api/base/release" method="post">
                  <label className="flex items-center gap-2 text-sm text-ink-2">
                    <input type="checkbox" name="confirm" value="yes" className="h-5 w-5" /> I understand the pole goes public if nobody declares it within the grace period.
                  </label>
                  <button className="mt-3 min-h-[44px] rounded-md border border-rust px-4 font-display text-ink" type="submit">Release this base</button>
                </form>
              </>
            ) : (
              <p className="mt-2 text-ink-2">Nothing declared. Pick one of the poles below — only poles the server log has seen you raise a flag at can be declared.</p>
            )}
          </section>

          <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
            <h2 className={label}>Poles you have raised at</h2>
            {view.candidates.length === 0 ? (
              <p className="mt-2 text-ink-2">None yet. Raise your flag at your pole in game; the log reaches us within a few minutes.</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-2">
                {view.candidates.map((c) => (
                  <li key={c.poleKey} className="flex min-h-[56px] items-center justify-between gap-3 rounded-md border border-rule-2 px-4">
                    <div>
                      <div className="font-mono text-ink">{at(c.x, c.z)}</div>
                      <div className="text-xs text-ink-2">raised {when(c.raisedAt)}</div>
                    </div>
                    <form action="/api/base/declare" method="post">
                      <input type="hidden" name="poleKey" value={c.poleKey} />
                      <button className="min-h-[44px] rounded-md bg-gold px-4 font-display text-ground disabled:opacity-40" type="submit" disabled={view.declaration !== null}>Declare</button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      <p className="mt-8"><a className="font-mono text-xs uppercase tracking-[0.18em] text-muted underline-offset-4 hover:underline" href="/me">Your page</a></p>
    </main>
  );
}
```

- [ ] **Step 5: Run, build, gate**

```bash
cd apps/web && npx vitest run && npx tsc --noEmit
DATABASE_URL="postgres://factions:factions@localhost:5434/factions_test_roster" SESSION_SECRET=x pnpm build 2>&1 | tail -20
```
Expected: green; build lists `ƒ /base` and both `ƒ /api/base/*` routes. Full gate 26/26.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat(web): /base — declare a solo base at a pole you raised at, or release it"
```

---

### Task 9: Runbook, CLAUDE.md, spec §15, READMEs

**Files:**
- Create: `docs/deploy/2026-09-05-site-link-and-base.md`
- Modify: `CLAUDE.md` (lines ~41, ~108-110, ~159-165, ~184-186, ~276-277), `apps/bot/README.md`, `apps/web/README.md`, `docs/superpowers/specs/2026-09-04-clan-wars-target-state-design.md` §15 rows 2b and 3

- [ ] **Step 1: The runbook**

`docs/deploy/2026-09-05-site-link-and-base.md`:
```markdown
# Site link and base (increment 2b) — deploy runbook

Migration 0021 makes `verification_challenges.guild_id` and `channel_id` nullable. It is
additive and reversible: no data moves, and the running bot keeps inserting both columns.
The order matters only in one direction — the web build that issues challenges with no
channel must not run against the old schema, or its first `/link` fails with a NOT NULL
violation.

1. **Read the migration.** `packages/db/migrations/0021_site_challenges.sql` — two
   `DROP NOT NULL` statements and nothing else. Nothing applies migrations in production.
2. **Apply 0021** with the one-off runner from `docs/deploy/2026-09-02-dormancy.md`. The bot
   may keep running: it neither reads a null there nor writes one until step 4.
3. **Confirm:**

       select is_nullable from information_schema.columns
        where table_name = 'verification_challenges' and column_name in ('guild_id','channel_id');

   Both rows `YES`.
4. **Deploy the bot and the web image together** (`docker compose build web && docker compose
   up -d web`; `sudo systemctl restart clan-wars-bot`). The bot's new code handles a
   null-channel notification (DM only, no channel fallback) and falls back to
   `DISCORD_GUILD_ID` for the nickname on a site-issued link. No new environment variables.
5. **Acceptance, as a linked player.** On the site: `/link` lists unclaimed gamertags the
   server has seen; a challenge shows three emotes and a ten-minute clock; performing them
   in game ticks the tickets within a minute (the bot's tick) and the DM arrives; `/me`
   shows the link; `/base` lists the poles you have raised at; Declare, then Release, with
   the `?result=` copy each time. Then in the database:

       select id, discord_id, guild_id, channel_id, completed_at, cancel_reason
         from verification_challenges order by id desc limit 5;

   Site-issued rows have null `guild_id`/`channel_id`. And the dormancy check from
   `docs/deploy/2026-09-05-declarations.md` step 9, together with `select count(*) from
   factions`, before and after.
6. **What did not change.** Discord's `/link` still issues 24-hour challenges
   (`DISCORD_LINK_TTL_MS`); it is retired in increment 2c with the rest of the commands. The
   `@Linked` role does not exist yet (increment 3).
```

- [ ] **Step 2: CLAUDE.md**

- Line ~41 was already updated in Task 1 (26/26).
- The DATABASE_URL bullet (~108-110): after "only `@factions/roster` reads `DATABASE_URL`", add: "Since 2b the roster package also writes: `startLink`/`cancelLink`/`unlink` and `declareSolo`/`releaseSolo`, over `@factions/verification` and `@factions/declarations` — the same stores the bot uses, moved out of `apps/bot` so neither side has its own copy of a rule."
- Transpile convention (~159-165): "Today that is `roster`, `db` and `domain`" → "Today that is `roster`, `db`, `domain`, `declarations` and `verification`".
- Lock-order bullet (~184-186): replace "It holds no writes yet (increment 2a); 2b and 2c add them…" with "Its first writes landed in 2b: `unlink` takes `lockDeclarations` → `releaseTx` → `identity_links`; `declareSolo` takes `lockDeclarations` before reading the link, which is what serialises the two (`packages/roster/test/base.test.ts` races them). 2c adds the roster writes, every one appending its feed or notice row in the transition's own transaction."
- After "**`declarations` is written by `declareTx` and nothing else.**" add: "`declareTx` lives in `packages/declarations` since 2b; `apps/bot` and `packages/roster` both import it."
- Current state (~276-277): after the 2a sentence add "Increment 2b landed: `/link` (autocomplete, three emotes, ten minutes, 5 s poll), unlink on `/me`, `/base` for solo declare and release; migration 0021; inbox 7 closed. Discord's `/link` still runs beside the page until 2c."

- [ ] **Step 3: READMEs and spec §15**

`apps/bot/README.md`: in the environment table's `BOT_CHALLENGE_TTL_MS` row (or the paragraph near it), add: "Discord's flow only. The site issues ten-minute challenges from `LINK_TTL_MS`; both write the same table, and the bot's tick verifies both." If the README has a section listing the bot's source files or stores, note that `declaration-store.ts` and `store.ts` now live in `packages/declarations` and `packages/verification`.

`apps/web/README.md`: under the routes/pages section add `/link`, `/base`, and the `/api/link/*`, `/api/base/*` handlers, one line each, and the sentence "Every page that reads the viewer is `force-dynamic`; every personal JSON response is `Cache-Control: no-store, private`."

Spec `docs/superpowers/specs/2026-09-04-clan-wars-target-state-design.md` §15:
- Row 2b: plan file `2026-09-xx-site-link-and-base.md` → `2026-09-05-site-link-and-base.md`; append to its description: "; `@factions/declarations` and the challenge store in `@factions/verification` shared by bot and roster".
- Row 3: append to its description: "; `@Linked` role on link/unlink and the nickname clear on a site unlink (deferred from 2b — both need the bot to react to a site write, i.e. this queue); the `/base` 'your declaration lapsed — raise and re-declare' copy (needs the `lapsed` notice)".

- [ ] **Step 4: Gate and commit**

Full gate: 26/26. `pnpm --filter @factions/web build` once more after the doc edits is unnecessary; `git status` must show only the intended files.

```bash
git add docs CLAUDE.md apps/bot/README.md apps/web/README.md
git commit -m "docs: 2b runbook; CLAUDE.md, READMEs and spec §15 record the shared stores and the deferred role work"
```

---

## Self-review

**Spec coverage.** §4.11: TTL 10 min from `rules.ts` (Task 5 `startLinkDb`), nullable `guild_id`/`channel_id` (Task 3), budget/safe pool/lockout untouched, inbox 7 refusal (Task 3), inbox 8 kept. §4.12: `unlink` and `declareSolo` take locks in order; docblocks say so (Tasks 5, 6). §5.2: solo declare offers only raised-at poles, cites the raise (Task 6 via `declareSoloTx`); release stamps grace (`releaseTx`); the "lapsed — re-declare" copy is deferred with a spec note (Task 9). §5.5: seen-and-unclaimed autocomplete (`searchUnlinkedPlayers`), three emotes, ten minutes, 5 s poll, "already linked elsewhere" at pick time (`taken`) and at completion (inbox 7); unlink refused with a roster row, releases a solo declaration; the `@Linked` role and nickname are deferred with a spec note. §10.2: `/link`, `/me` (unlink, cooldowns and invites are 2c), `/base` (declare, release; re-declare after a lapse is the same Declare button). §10.4: exports named as the spec names them (`startLink`, `cancelLink`, `unlink`, `declareSolo`, `releaseSolo`) plus three reads and two constant arrays; both pins updated in every task that adds an export; nothing exported sets a status, writes a raid, or inserts a declaration without evidence. §13: a staged race for the new writer pair with the outcome asserted (Task 6). §15: row 2b filled in (Task 9).

**Placeholder scan.** Every code step carries the code. The two "adapt identifiers" notes (Task 3 Step 2, Task 2 Step 4) point at fixtures the implementer can read in the same file; the values themselves are given.

**Type consistency.** `IssueOutcome`/`IssueContext`/`IssueDeps` (Task 4) are what `startLinkDb` calls (Task 5) and what `link-copy.ts` keys on (Task 7). `LinkStatus.challenge.targetDayzId` (Task 5) is what the re-roll in Task 7 reads. `DeclareSoloOutcome`'s reasons (Task 6) are the union `declareSoloTx` returns (Task 1: `too-close | pole-taken | owner-has-base | no-raise | in-clan`) plus `not-linked`; `DECLARE_COPY` covers all six (Task 8). `Notification.channelId: string | null` (Task 3) matches `LiveChallenge.channelId` after the same task. `activeServerId` takes `Database | Tx` because `declareSoloDb` calls it inside the transaction.

**Rulings baked in.** (1) The stores move to packages rather than being duplicated in roster — a rule stated twice drifts, and 2c retires the bot's `/link` anyway. (2) The challenge store joins the existing `@factions/verification` instead of a new package; the declaration store gets its own because no existing package fits. (3) The draw cap (3 per 24 h) applies to the site as to the bot; with a ten-minute TTL an expired-and-redrawn challenge costs a draw, which is the security bound doing its job — the page says how many draws are left. (4) `@Linked`, the site-unlink nickname clear, and the lapsed-base copy are deferred to increment 3 with the reasons written into spec §15, because each needs the bot to react to a site write and the notices queue is that mechanism. (5) `/base` shows whole-metre coordinates of the viewer's own raises only.
