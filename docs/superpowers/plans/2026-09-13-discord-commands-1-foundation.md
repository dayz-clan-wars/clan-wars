# Discord Command Parity, Plan 1: Foundation, Link and Base — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared foundation that lets the bot call the same domain layer and the same player-facing copy the site calls, and prove it end to end by shipping `/link` and `/base` as real slash commands.

**Architecture:** `packages/roster`'s ~61 public wrappers are extracted into a `makeRoster(getDb, getNow)` factory so the bot can build its own instance over its own `Database` handle instead of re-deriving actor and clan the way `guest-command.ts` does. The six copy modules holding outcome-keyed records move to a new `packages/copy`, with a compile-time-checked `DISCORD_OVERRIDES` for the handful of site-shaped strings; `apps/web/lib/*-copy.ts` become re-exports so no page changes. A registry in `apps/bot/src/commands/` pairs each command's discord.js JSON with its handler, and a bijection test makes it impossible to register a command with no handler or write a handler no command reaches.

**Tech Stack:** TypeScript (ESM, `"type": "module"`, `.js` import specifiers), pnpm workspaces + turbo, vitest, drizzle-orm over postgres.js, discord.js ^14.27.0.

**Spec:** `docs/superpowers/specs/2026-09-13-discord-command-parity-design.md`

## Global Constraints

- **Every reply is ephemeral.** `MessageFlags.Ephemeral` on every path, no exceptions, no `public:` option. Reason (spec §1): a link challenge sequence posted publicly is a challenge a bystander can perform, binding their own UID to someone else's Discord account. `apps/bot/test/command-registration.test.ts` (Task 3) enforces it.
- **No rule may live in two places.** A handler never re-derives actor, clan, role, cooldown or cap. It calls a `@factions/roster` export and renders the outcome. If a handler needs a fact the export does not return, the fix is a read in `packages/roster`, never a query in `apps/bot`.
- **Player-facing strings say "clan", never "faction".** Identifiers may say faction. `apps/bot/test/vocabulary.test.ts` checks string literals only, with comments and import specifiers stripped.
- **Never point anything at `factions_live`.** Tests run against `factions_test_<package>`, derived by the shared vitest `globalSetup` from `TEST_DATABASE_URL`'s host/port/credentials only.
- **The full gate, always with `--force`:**
  ```
  TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
    npx turbo run typecheck test --concurrency=1 --force
  ```
  Currently **26/26 tasks**. Task 2 adds `packages/copy`, taking it to **28/28**. A cached pass proves nothing — check the count, not the exit code.
- **`RETIRED_COMMANDS` stays registered for the whole of Plans 1 and 2.** It is deleted in Plan 3's final task, once Discord can actually do everything the stub points at. Deleting it earlier leaves players with neither the command nor the pointer.
- **Postgres is port 5434 only.** 5432 and 5433 belong to other projects — never stop, remove, or repoint them.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `packages/roster/src/api.ts` | `makeRoster(getDb, getNow)` — the ~61 wrappers, parameterized. The only place a wrapper body lives. |
| `packages/roster/test/api.test.ts` | Proves an injected-handle instance behaves identically to the singleton. |
| `packages/copy/` | New workspace package: the outcome-keyed copy tables, shared by site and bot. |
| `packages/copy/src/clan.ts` | `TABLES`, `Action`, `REFUSAL`, `DISBAND_WARNING` — moved verbatim from `apps/web/lib/clan-copy.ts`. |
| `packages/copy/src/vault.ts` | Vault `TABLES`, `VaultAction` — moved verbatim. |
| `packages/copy/src/leadership.ts` | Leadership `TABLES`, `LeadershipAction`, `CLAIM_REFUSAL` — moved verbatim. |
| `packages/copy/src/base.ts` | `DECLARE_COPY`, `RELEASE_COPY`, `DECLARED_OK`, `lapsedCopy`. |
| `packages/copy/src/link.ts` | `ISSUE_COPY`, `ENDED_COPY`, `UNLINK_COPY`, `formatRemaining`. |
| `packages/copy/src/map.ts` | Pin `RESULT_COPY`, `PIN_ICON_LABELS`. |
| `packages/copy/src/format.ts` | `days`, `hours`, `when` — the formatters the tables interpolate. |
| `packages/copy/src/discord.ts` | `DISCORD_OVERRIDES` + `discordCopy()` — per-outcome wording tweaks, compile-time keyed. |
| `packages/copy/src/index.ts` | The package's export surface. |
| `packages/copy/test/overrides.test.ts` | Every override names a real outcome; every table entry is non-empty. |
| `apps/bot/src/commands/types.ts` | `Reply`, `Ctx`, `CommandInput`, `Handler`, `AutocompleteSource`, `CommandSpec`, `CommandGroup`. |
| `apps/bot/src/commands/index.ts` | `GROUPS`, `buildCommands()`, `SPECS`, `AUTOCOMPLETE` — the registry. |
| `apps/bot/src/commands/route.ts` | The only file that reads `interaction.*`. Dispatches to handlers. |
| `apps/bot/src/commands/link.ts` | `/link` group: command JSON, four handlers, one autocomplete source. |
| `apps/bot/src/commands/base.ts` | `/base` group: command JSON, three handlers, one autocomplete source. |
| `apps/bot/src/commands/embeds/link.ts` | The `/link status` embed builder. |
| `apps/bot/src/commands/embeds/base.ts` | The `/base show` embed builder. |
| `apps/bot/test/command-registration.test.ts` | Bijection between registered subcommands and handlers; Discord's limits; the ephemeral guard. |
| `apps/bot/test/commands-link.test.ts` | `/link` handlers against a seeded database. |
| `apps/bot/test/commands-base.test.ts` | `/base` handlers against a seeded database. |
| `apps/bot/test/parity.test.ts` | The standing parity guard, seeded with link and base. |
| `docs/deploy/2026-09-13-discord-commands.md` | Runbook (written in Task 7, appended to by Plans 2 and 3). |

**Modified:**

| Path | Change |
|---|---|
| `packages/roster/src/index.ts` | Body replaced by `export const {...} = makeRoster(db)` plus the eight constant re-exports. |
| `packages/roster/package.json` | No change (`api.ts` is reached through `index.ts` and a new `./api` export). |
| `apps/web/lib/clan-copy.ts` | Becomes re-exports + the web-only `RESULT_COPY`/`code()` projection. |
| `apps/web/lib/vault-copy.ts` | Same shape. |
| `apps/web/lib/leadership-copy.ts` | Same shape. |
| `apps/web/lib/base-copy.ts` | Same shape. |
| `apps/web/lib/link-copy.ts` | Same shape. |
| `apps/web/lib/map-copy.ts` | Outcome table re-exported; layer labels and formatters stay. |
| `apps/web/package.json` | Adds `"@factions/copy": "workspace:*"`. |
| `apps/bot/package.json` | Adds `"@factions/copy": "workspace:*"`. |
| `apps/bot/src/discord.ts` | `buildCommands()` composes the registry; `interactionCreate` delegates to `route.ts`. |
| `apps/bot/src/commands.ts` | `Reply` widened to carry embeds. |
| `apps/bot/test/vocabulary.test.ts` | `PLAYER_FACING` extended to `commands/**`; `packages/copy` checked too. |
| `CLAUDE.md` | The "every slash command is retired" invariant is corrected. |

---

## Task 1: Parameterize `@factions/roster`

Spec §3.1. The riskiest change in the whole design and the reason it goes first, alone. `packages/roster/test/exports.test.ts` pins the site's permission list by name against `Object.keys()` of the module namespace; a named destructure produces exactly those runtime bindings, so the test must pass **unchanged**.

**Files:**
- Create: `packages/roster/src/api.ts`
- Create: `packages/roster/test/api.test.ts`
- Modify: `packages/roster/src/index.ts` (whole file)
- Modify: `packages/roster/package.json` (add `"./api"` to `exports`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `makeRoster(getDb: () => Database, getNow?: () => Date): Roster`
  - `type Roster = ReturnType<typeof makeRoster>` — 61 methods, each with the signature its `index.ts` wrapper has today.
  - `packages/roster/src/index.ts` continues to export the same 69 names.

- [ ] **Step 1: Write the failing test**

Create `packages/roster/test/api.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, identityLinks, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { makeRoster } from "../src/api";
import { ROSTER_EXPORTS } from "./exports.test";

const URL = requireTestDatabaseUrl();
const NOW = new Date("2026-09-13T12:00:00Z");
const D = "discord-1";
const UID = "U".repeat(40);

/**
 * The factory is what lets the bot run the site's rules over its own handle
 * (spec §3.1). Two things have to stay true forever: the instance carries
 * every name the singleton exports, and an injected handle reaches the same
 * rows. Anything subtler is `writes.test.ts`'s job, not this file's.
 */
describe("makeRoster", () => {
  let db: Database;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table identity_links, faction_members, declarations, poles, factions, players, servers restart identity cascade`);
    await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 });
  });

  it("carries every function the singleton exports", async () => {
    const roster = makeRoster(() => db, () => NOW);
    const singleton = await import("../src/index");
    // The eight names that are constants, not wrappers: they stay plain re-exports on index.
    const constants = ["BOARD_KINDS", "BOARD_PAGE_SIZE", "DECLARE_SOLO_REASONS", "FEED_PAGE_SIZE", "ISSUE_OUTCOME_KINDS", "SUGGEST_SCOPES", "VAULT_NAME_MAX", "VAULT_NOTE_MAX"];
    const wrappers = ROSTER_EXPORTS.filter((n) => !constants.includes(n));
    expect(Object.keys(roster).sort()).toEqual([...wrappers].sort());
    for (const name of wrappers) {
      expect(typeof singleton[name as keyof typeof singleton]).toBe("function");
    }
  });

  it("reads through the handle it was given", async () => {
    await db.insert(identityLinks).values({ discordId: D, dayzId: UID, gamertag: "Ada", verifiedAt: NOW });
    const roster = makeRoster(() => db, () => NOW);
    const viewer = await roster.viewerFor(D);
    expect(viewer.link?.gamertag).toBe("Ada");
  });

  it("takes its clock from getNow, so a caller can freeze time", async () => {
    const roster = makeRoster(() => db, () => NOW);
    const status = await roster.linkStatus(D);
    expect(status.link).toBeNull();
    expect(status.challenge).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars && \
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
npx vitest run --root packages/roster test/api.test.ts
```
Expected: FAIL — `Cannot find module '../src/api'`.

- [ ] **Step 3: Write `packages/roster/src/api.ts`**

Move every import that `index.ts` currently has at the top of the file (the `*Db` functions and the types) into `api.ts` unchanged, then wrap the bodies. The transform is mechanical and identical for all 61: `db()` becomes `getDb()`, `new Date()` becomes `getNow()`, everything else is verbatim, **including the doc comment above each wrapper** — those comments are the package's documentation and must travel with the code.

```ts
import type { Database } from "@factions/db";
// …every import index.ts has today, moved here verbatim…

/**
 * The site's capability layer, parameterized (spec §3.1).
 *
 * `index.ts` binds this to the package's own pooled client and re-exports the
 * result, so `apps/web` sees exactly the export list `test/exports.test.ts`
 * pins. `apps/bot` binds it to the handle `start()` already owns, which is
 * what stops the two surfaces from growing separate copies of a rule — the
 * duplication increment 2b removed and spec §1 forbids.
 *
 * ⚠️ `getNow` exists so a caller can freeze the clock in a test. It is NOT a
 * way to backdate a write: every store re-reads its own bounds from the row it
 * locks, and a `getNow` in the past produces refusals, not history.
 */
export function makeRoster(getDb: () => Database, getNow: () => Date = () => new Date()) {
  return {
    /** The site bar's two counts: what is waiting on you (/me) and on your clan (/clan). Read on every page, so it is cheap. */
    attention: (discordId: string) => attentionDb(getDb(), discordId, getNow()),

    /** The server strip under the top bar: each live server's in-game name as Nitrado last reported it. The same for every viewer. */
    liveServers: () => liveServersDb(getDb()),

    /** Who is looking: their link and their clan, or null for either. */
    viewerFor: (discordId: string) => viewerForDb(getDb(), discordId),

    /** /link's one read: your link, your open challenge, how the last one ended. */
    linkStatus: (discordId: string) => linkStatusDb(getDb(), discordId, getNow()),

    /** Issue (or re-show) a link challenge for a character the log has seen. */
    startLink: (discordId: string, targetDayzId: string, opts: { newSequence?: boolean } = {}) =>
      startLinkDb(getDb(), { discordId, targetDayzId, newSequence: opts.newSequence, now: getNow(), rng: Math.random }),

    cancelLink: (discordId: string) => cancelLinkDb(getDb(), discordId, getNow()),

    /** Refused while in a clan; releases a solo base. */
    unlink: (discordId: string) => unlinkDb(getDb(), discordId, getNow()),

    searchGamertags: (prefix: string) => searchGamertagsDb(getDb(), prefix),

    /** Autocomplete names for a gamertag box: `seen` for the public player search, `linked` for invites and guest passes. */
    suggestGamertags: (prefix: string, scope: SuggestScope) => suggestGamertagsDb(getDb(), prefix, scope),

    /** /base's one read: your raises, your declaration. */
    baseFor: (discordId: string) => baseForDb(getDb(), discordId),

    /** Declare a solo base at a pole you have raised at. Every rule is inside. */
    declareSolo: (discordId: string, poleKey: string) => declareSoloDb(getDb(), discordId, poleKey, getNow()),

    releaseSolo: (discordId: string) => releaseSoloDb(getDb(), discordId, getNow()),

    /** Invite a linked player to your clan, by Discord id or by gamertag. Officer+ only; the invitee must already be linked. */
    invite: (actorDiscordId: string, invitee: InviteeRef) => inviteDb(getDb(), getNow(), actorDiscordId, invitee),

    // …one entry per remaining wrapper, by the rule stated below…
  };
}

export type Roster = ReturnType<typeof makeRoster>;
```

Apply that identical transform to **all 61** wrappers. In `index.ts` source order they are:

`attention`, `liveServers`, `viewerFor`, `linkStatus`, `startLink`, `cancelLink`, `unlink`, `searchGamertags`, `suggestGamertags`, `baseFor`, `declareSolo`, `releaseSolo`, `invite`, `revokeInvite`, `acceptInvite`, `declineInvite`, `requestJoin`, `withdrawRequest`, `decideRequest`, `leave`, `kick`, `promote`, `demote`, `transfer`, `disband`, `rename`, `setRecruitingPost`, `claimCeremony`, `confirmRebind`, `clanFor`, `directory`, `clanByTag`, `claimContext`, `myInvites`, `myRequests`, `scoreboard`, `alphas`, `seasons`, `warLog`, `mapState`, `dropPin`, `deletePin`, `playerBoards`, `playerProfile`, `achievementsFor`, `clanBoard`, `clanBoardPage`, `boardPage`, `playerFeed`, `claimSuccession`, `openVote`, `castVote`, `vaultFor`, `addLock`, `editLock`, `deleteLock`, `revealLock`, `rotateLocks`, `confirmLock`, `grantGuestPass`, `revokeGuestPass`.

⚠️ **Not every wrapper takes a clock, and the ones that do not must not gain one.** `viewerFor`, `liveServers`, `searchGamertags`, `suggestGamertags`, `baseFor`, `promote`, `demote`, `disband`, `setRecruitingPost`, `directory`, `scoreboard`, `alphas`, `seasons`, `warLog`, `playerBoards`, `playerProfile`, `boardPage`, `deletePin` and `vaultFor` call their `*Db` with no date argument today. Adding `getNow()` to one of them is a signature change to a store, not a refactor, and will fail typecheck.

The rule for every one of the 61: **open `index.ts`, copy the call exactly as it stands, and change only `db()` → `getDb()` and `new Date()` → `getNow()`.** Nothing else moves. When the task is done, `git diff` on `index.ts` should show the wrapper bodies leaving and nothing else changing about them.

- [ ] **Step 4: Rewrite `packages/roster/src/index.ts`**

```ts
/**
 * @factions/roster — what the site and the bot are allowed to do (target spec §10.4).
 *
 * `apps/web` imports this and never @factions/db. The export list below IS
 * the permission list; test/exports.test.ts pins it by name and so does
 * apps/web/test/smoke.test.ts.
 *
 * ⚠️ Since 2026-09-13 the wrapper BODIES live in `api.ts`, behind
 * `makeRoster(getDb, getNow)`. This file binds that factory to the package's
 * own pooled client, so the names below and their behaviour are unchanged.
 * `apps/bot` binds the same factory to its own handle and therefore runs the
 * same rules — spec §3.1. Adding a capability means adding it in `api.ts` AND
 * naming it here, on purpose, in both pinning tests.
 *
 * Nothing here may ever set a clan active or dormant, write a raid or a
 * defense, insert a declaration without citing evidence the log already
 * holds, or create a faction without a ceremony.
 */
import { db } from "./client";
import { makeRoster } from "./api";

export { makeRoster, type Roster } from "./api";

export const {
  acceptInvite, achievementsFor, addLock, alphas, attention, baseFor, boardPage, cancelLink, castVote,
  claimCeremony, claimContext, claimSuccession, clanBoard, clanBoardPage, clanByTag, clanFor, confirmLock,
  confirmRebind, decideRequest, declareSolo, declineInvite, deleteLock, deletePin, demote, directory,
  disband, dropPin, editLock, grantGuestPass, invite, kick, leave, linkStatus, liveServers, mapState,
  myInvites, myRequests, openVote, playerBoards, playerFeed, playerProfile, promote, releaseSolo, rename,
  requestJoin, revealLock, revokeGuestPass, revokeInvite, rotateLocks, scoreboard, searchGamertags, seasons,
  setRecruitingPost, startLink, suggestGamertags, transfer, unlink, vaultFor, viewerFor, warLog, withdrawRequest,
} = makeRoster(db);

export { SUGGEST_SCOPES, type SuggestScope } from "./suggest";
export { DECLARE_SOLO_REASONS } from "./base";
export { ISSUE_OUTCOME_KINDS } from "@factions/verification";
export { BOARD_KINDS, BOARD_PAGE_SIZE, FEED_PAGE_SIZE } from "./stats";
export { VAULT_NAME_MAX, VAULT_NOTE_MAX } from "./vault";

// Every `export type` block from the previous index.ts, moved here unchanged.
```

⚠️ `makeRoster` and `Roster` are now runtime/type exports of this module. `exports.test.ts` asserts `Object.keys(mod)` equals `ROSTER_EXPORTS` exactly — `makeRoster` is a runtime binding and **will** appear. Add `"makeRoster"` to `ROSTER_EXPORTS` in `packages/roster/test/exports.test.ts` and to `apps/web/test/smoke.test.ts`'s copy of the list, deliberately, as part of this step. `Roster` is a type and does not appear.

Then re-run the second assertion in `exports.test.ts` mentally: it rejects any export name containing `activate`, `dormant`, `raid`, `defense`, `declaration`, `reserve`, `createfaction`, `insert`. `makeroster` contains none of them. Good.

Add to `packages/roster/package.json`:

```json
"exports": { ".": "./src/index.ts", "./internal": "./src/internal/index.ts", "./api": "./src/api.ts" }
```

- [ ] **Step 5: Run the roster suite**

Run:
```
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars && \
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
npx vitest run --root packages/roster
```
Expected: PASS, including `exports.test.ts` and `writes.test.ts`.

- [ ] **Step 6: Run the full gate**

Run:
```
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars && \
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
npx turbo run typecheck test --concurrency=1 --force
```
Expected: **26/26 tasks pass.** This is the step that proves the site is untouched. If `apps/web` fails, the destructure list in `index.ts` does not match what a page imports — fix the list, never the page.

- [ ] **Step 7: Commit**

```bash
git add packages/roster/src/api.ts packages/roster/src/index.ts packages/roster/package.json \
        packages/roster/test/api.test.ts packages/roster/test/exports.test.ts apps/web/test/smoke.test.ts
git commit -m "refactor(roster): extract wrappers into makeRoster(getDb, getNow)

The bot can now run the site's rules over its own Database handle instead of
re-deriving actor and clan from @factions/roster/internal. index.ts binds the
factory to the package's pooled client, so the site's export list and
behaviour are unchanged; exports.test.ts gains only makeRoster itself."
```

---

## Task 2: Extract `packages/copy`

Spec §3.2, corrected: six modules hold outcome-keyed records (`clan`, `vault`, `leadership`, `base`, `link`, `map`). `feed-copy.ts`, `scoring-copy.ts`, `stats-copy.ts` and `achievements-copy.ts` hold labels and formatters, not outcome unions, and stay in `apps/web`.

Rather than doubling ~150 entries into `{site, discord}`, there is **one** table plus a `Partial` override map. Coverage therefore cannot diverge at all — only wording can, which is the point.

**Files:**
- Create: `packages/copy/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `packages/copy/src/{format,clan,vault,leadership,base,link,map,discord,index}.ts`
- Create: `packages/copy/test/overrides.test.ts`
- Modify: `apps/web/lib/{clan,vault,leadership,base,link,map}-copy.ts`
- Modify: `apps/web/package.json`, `pnpm-workspace.yaml` (only if it does not already glob `packages/*`)

**Interfaces:**
- Consumes: `@factions/roster`'s outcome types (unchanged by Task 1).
- Produces:
  - `TABLES`, `type Action`, `REFUSAL`, `DISBAND_WARNING` from `@factions/copy`
  - `VAULT_TABLES`, `type VaultAction`; `LEADERSHIP_TABLES`, `type LeadershipAction`, `CLAIM_REFUSAL`
  - `DECLARE_COPY`, `RELEASE_COPY`, `DECLARED_OK`, `lapsedCopy`
  - `ISSUE_COPY`, `ENDED_COPY`, `UNLINK_COPY`, `formatRemaining`
  - `PIN_RESULT_COPY`, `PIN_ICON_LABELS`
  - `days(ms)`, `hours(ms)`, `when(date)`
  - `discordCopy<A extends Action>(action: A, outcome: keyof (typeof TABLES)[A] & string): string`
  - `discordVaultCopy`, `discordLeadershipCopy` — same shape over their tables

- [ ] **Step 1: Scaffold the package**

`packages/copy/package.json`:

```json
{
  "name": "@factions/copy",
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit", "test": "vitest run" },
  "dependencies": {
    "@factions/domain": "workspace:*",
    "@factions/roster": "workspace:*"
  },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^2.1.0" }
}
```

`packages/copy/tsconfig.json` — copy `packages/roster/tsconfig.json` verbatim.

`packages/copy/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

// No database: every test here is over in-memory tables. No globalSetup, so
// this package does not create a factions_test_copy it would never use.
export default defineConfig({});
```

Run `pnpm install` so the workspace links resolve.

- [ ] **Step 2: Write the failing test**

Create `packages/copy/test/overrides.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { TABLES, VAULT_TABLES, LEADERSHIP_TABLES, DISCORD_OVERRIDES, discordCopy } from "../src/index";

const everyTable = { ...TABLES, ...VAULT_TABLES, ...LEADERSHIP_TABLES } as Record<string, Record<string, unknown>>;

/**
 * There is ONE table per action, shared by the site and the bot, so coverage
 * cannot diverge — only wording can, through DISCORD_OVERRIDES. These tests
 * guard the two ways that arrangement can still rot: an override that names an
 * outcome nobody returns any more, and an entry someone left blank.
 */
describe("copy tables", () => {
  it("has non-empty text for every outcome of every action", () => {
    for (const [action, table] of Object.entries(everyTable)) {
      for (const [outcome, text] of Object.entries(table)) {
        expect(typeof text, `${action}.${outcome}`).toBe("string");
        expect((text as string).trim(), `${action}.${outcome}`).not.toBe("");
      }
    }
  });

  it("says clan, never faction", () => {
    for (const [action, table] of Object.entries(everyTable)) {
      for (const [outcome, text] of Object.entries(table)) {
        expect((text as string).toLowerCase(), `${action}.${outcome}`).not.toContain("faction");
      }
    }
  });

  it("overrides only outcomes that exist", () => {
    for (const [action, table] of Object.entries(DISCORD_OVERRIDES as Record<string, Record<string, string>>)) {
      expect(everyTable[action], `unknown action ${action}`).toBeDefined();
      for (const outcome of Object.keys(table)) {
        expect(Object.hasOwn(everyTable[action]!, outcome), `${action}.${outcome} is not an outcome`).toBe(true);
      }
    }
  });

  it("falls through to the shared text when there is no override", () => {
    expect(discordCopy("recruiting", "ok")).toBe("Recruiting post saved.");
  });

  it("prefers the override when there is one", () => {
    expect(discordCopy("disband", "unconfirmed")).toBe("Press Confirm to disband — this cannot be undone.");
    expect(discordCopy("disband", "unconfirmed")).not.toBe(TABLES.disband.unconfirmed);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars && npx vitest run --root packages/copy`
Expected: FAIL — `Cannot find module '../src/index'`.

- [ ] **Step 4: Move the tables**

`packages/copy/src/format.ts` — move `days`, `hours` and `when` out of `apps/web/lib/format.ts` (leave the rest of `format.ts` where it is; `apps/web/lib/format.ts` re-exports the three from `@factions/copy` so its own consumers do not change).

`packages/copy/src/clan.ts` — move the whole body of `apps/web/lib/clan-copy.ts` **except** `code()` and `RESULT_COPY`, which are the web's URL projection and stay in web. Export `REFUSAL`, `DISBAND_WARNING`, `TABLES` and `type Action`. `TABLES` must be exported (it is currently a private `const`) because `discordCopy` and the web's projection both read it.

`packages/copy/src/vault.ts` and `src/leadership.ts` — the same move, exporting `VAULT_TABLES`/`VaultAction` and `LEADERSHIP_TABLES`/`LeadershipAction`/`CLAIM_REFUSAL`. Rename the two private `TABLES` consts on the way so `index.ts` can export all three side by side.

`packages/copy/src/base.ts`:

```ts
import { MIN_BASE_SPACING_M, RELEASED_POLE_GRACE_MS, SOLO_LAPSE_MS, WATCH_ZONE_RADIUS_M } from "@factions/domain";
import type { DeclareSoloReason } from "@factions/roster";
import { days, when } from "./format";

/** What a solo declare refusal says. The guide's wording (ch. 4) for the 200 m rule. */
export const DECLARE_COPY: Record<DeclareSoloReason, string> = {
  "not-linked": "Link your character first.",
  "in-clan": "You are in a clan, so your base is the clan's. Solo declarations are for players outside one.",
  "no-raise": "The server log has not seen you raise a flag at that pole. Raise it, wait for the log to catch up, and try again.",
  "too-close": `Too close to another declared base. No two declared bases sit within ${MIN_BASE_SPACING_M} m of each other — first declared wins. The map cannot show you private bases, so this refusal is your first warning that one is nearby.`,
  "pole-taken": "That pole is already declared by someone else.",
  "owner-has-base": "You already have a declared base. Release it before declaring another.",
};

export const DECLARED_OK = `Declared. Your ${WATCH_ZONE_RADIUS_M} m watch zone is live. Keep raising your flag there — a solo base lapses after ${days(SOLO_LAPSE_MS)} without your raise.`;

export const RELEASE_COPY = {
  released: `Released. The pole stays private for ${days(RELEASED_POLE_GRACE_MS)}, then becomes public if nobody declares it.`,
  nothing: "You had no declared base to release.",
} as const;

/** Shown when a solo declaration has lapsed but is still inside its grace. */
export const lapsedCopy = (at: Date) =>
  `Your declaration lapsed ${when(at)} — no raise in ${days(SOLO_LAPSE_MS)}. Raise your flag at the pole and declare it again below before it goes public.`;
```

`packages/copy/src/link.ts` — move `ISSUE_COPY`, `ENDED_COPY`, `UNLINK_COPY`, `formatRemaining` and the private `name`/`at` helpers verbatim from `apps/web/lib/link-copy.ts`.

`packages/copy/src/map.ts` — move `apps/web/lib/map-copy.ts`'s `RESULT_COPY` (export it as `PIN_RESULT_COPY`) and `PIN_ICON_LABELS`. `LAYER_LABELS`, `LAYER_REASONS`, `MAP_HINT`, `fixAge`, `expiresIn` and `DIM_AFTER_MS` are the visual map's furniture and stay in `apps/web`.

- [ ] **Step 5: Write the override layer**

`packages/copy/src/discord.ts`:

```ts
import { TABLES, type Action } from "./clan";
import { VAULT_TABLES, type VaultAction } from "./vault";
import { LEADERSHIP_TABLES, type LeadershipAction } from "./leadership";

/**
 * Where Discord's wording must differ from the site's.
 *
 * ⚠️ Wording only. There is one table per action and both surfaces read it,
 * so an outcome can never be covered on one surface and blank on the other —
 * which is the failure this arrangement exists to make impossible. Entries
 * here exist because a string names something that is only on the site: a
 * checkbox the player ticks, a form they submit, a page they visit.
 *
 * Compile-time keyed: an outcome that no longer exists stops typechecking,
 * and test/overrides.test.ts catches the same thing at runtime for anything
 * reached dynamically.
 */
export const DISCORD_OVERRIDES: {
  [A in Action]?: Partial<Record<keyof (typeof TABLES)[A] & string, string>>
} = {
  disband: { unconfirmed: "Press Confirm to disband — this cannot be undone." },
  transfer: { unconfirmed: "Press Confirm to hand over leadership." },
  input: { "bad-input": "Something in that was missing or too long. Try again." },
};

export function discordCopy<A extends Action>(action: A, outcome: keyof (typeof TABLES)[A] & string): string {
  const over = (DISCORD_OVERRIDES[action] as Record<string, string> | undefined)?.[outcome];
  return over ?? (TABLES[action][outcome] as string);
}

export const DISCORD_VAULT_OVERRIDES: {
  [A in VaultAction]?: Partial<Record<keyof (typeof VAULT_TABLES)[A] & string, string>>
} = {};

export function discordVaultCopy<A extends VaultAction>(action: A, outcome: keyof (typeof VAULT_TABLES)[A] & string): string {
  const over = (DISCORD_VAULT_OVERRIDES[action] as Record<string, string> | undefined)?.[outcome];
  return over ?? (VAULT_TABLES[action][outcome] as string);
}

export const DISCORD_LEADERSHIP_OVERRIDES: {
  [A in LeadershipAction]?: Partial<Record<keyof (typeof LEADERSHIP_TABLES)[A] & string, string>>
} = {
  "claim-succession": { unconfirmed: "Press Confirm to claim the leader's seat." },
  "open-vote": { unconfirmed: "Press Confirm to open the vote." },
};

export function discordLeadershipCopy<A extends LeadershipAction>(action: A, outcome: keyof (typeof LEADERSHIP_TABLES)[A] & string): string {
  const over = (DISCORD_LEADERSHIP_OVERRIDES[action] as Record<string, string> | undefined)?.[outcome];
  return over ?? (LEADERSHIP_TABLES[action][outcome] as string);
}
```

⚠️ Before writing the three override maps, open `apps/web/lib/{clan,leadership}-copy.ts` and confirm which actions actually have an `unconfirmed` key. Only list actions that have one — an override naming a missing outcome fails typecheck, which is the mechanism working, but fix it by deleting the entry, never by widening the type.

`packages/copy/src/index.ts` re-exports everything named in this task's **Produces** block.

- [ ] **Step 6: Turn the web copy modules into re-exports**

`apps/web/lib/base-copy.ts` becomes:

```ts
import { DECLARE_COPY, DECLARED_OK, RELEASE_COPY, days } from "@factions/copy";

export { DECLARE_COPY, lapsedCopy, days } from "@factions/copy";

/** Every code the two /base route handlers can redirect with. Site-only: the codes are query-string values. */
export const RESULT_COPY: Record<string, string> = {
  declared: DECLARED_OK,
  ...RELEASE_COPY,
  unconfirmed: "Tick the box to confirm before releasing.",
  ...DECLARE_COPY,
};
```

`apps/web/lib/clan-copy.ts` keeps `code()` and `RESULT_COPY` (both are URL projections the bot never uses) and re-exports the rest:

```ts
import { TABLES, type Action } from "@factions/copy";
export { REFUSAL, DISBAND_WARNING, TABLES, type Action } from "@factions/copy";

export function code<A extends Action>(action: A, outcome: keyof (typeof TABLES)[A] & string): string {
  return `${action}.${outcome}`;
}

/** Every code a roster route can redirect with, flattened to "<action>.<outcome>". A null-prototype object so a query-string key cannot reach Object.prototype. */
export const RESULT_COPY: Record<string, string> = Object.assign(Object.create(null), Object.fromEntries(
  Object.entries(TABLES).flatMap(([action, table]) => Object.entries(table).map(([outcome, text]) => [`${action}.${outcome}`, text])),
));
```

`vault-copy.ts` and `leadership-copy.ts` take the same shape over their own tables. `link-copy.ts` and `map-copy.ts` re-export the moved names and keep whatever is web-only.

Add `"@factions/copy": "workspace:*"` to `apps/web/package.json` dependencies, then `pnpm install`.

- [ ] **Step 7: Run the copy suite, then the full gate**

Run: `cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars && npx vitest run --root packages/copy`
Expected: PASS, 5 tests.

Run:
```
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars && \
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
npx turbo run typecheck test --concurrency=1 --force
```
Expected: **28/28 tasks pass.** The two new tasks are `@factions/copy#typecheck` and `@factions/copy#test`. Every existing `apps/web` copy test must pass untouched — that is the proof the move was transparent.

- [ ] **Step 8: Commit**

```bash
git add packages/copy apps/web/lib apps/web/package.json pnpm-lock.yaml
git commit -m "refactor(copy): move the six outcome-copy tables into @factions/copy

One table per action, shared by site and bot, so an outcome cannot be worded
on one surface and blank on the other. DISCORD_OVERRIDES carries the few
site-shaped strings (tick the box, submit the form) and is compile-time keyed
to real outcomes. apps/web/lib/*-copy.ts become re-exports plus their own
URL projections, so no page changes."
```

---

## Task 3: The command registry and router

The scaffolding every later command plugs into. It registers **no new commands** — `buildCommands()` still emits the retired stubs and `/guest` exactly as today — so this task is a pure refactor of the interaction path, provable by the existing suite staying green.

**Files:**
- Create: `apps/bot/src/commands/types.ts`, `apps/bot/src/commands/index.ts`, `apps/bot/src/commands/route.ts`
- Create: `apps/bot/test/command-registration.test.ts`
- Modify: `apps/bot/src/commands.ts` (widen `Reply`)
- Modify: `apps/bot/src/discord.ts:56-66` (`buildCommands`) and `:548-575` (`interactionCreate`)
- Modify: `apps/bot/package.json` (add `@factions/copy`)

**Interfaces:**
- Consumes: `makeRoster`, `Roster` (Task 1).
- Produces:
  - `type Reply = { content?: string; embeds?: EmbedBuilder[]; ephemeral: true }`
  - `type Ctx = { roster: Roster; now: Date; siteBaseUrl: string }`
  - `type CommandInput = { actorDiscordId: string; string(n): string | null; integer(n): number | null; boolean(n): boolean | null; user(n): string | null }`
  - `type Handler = (ctx: Ctx, input: CommandInput) => Promise<Reply>`
  - `type AutocompleteSource = (ctx: Ctx, a: { actorDiscordId: string; value: string }) => Promise<{ name: string; value: string }[]>`
  - `type CommandSpec = { path: string; handler: Handler; autocomplete?: Record<string, AutocompleteSource> }`
  - `type CommandGroup = { command: SlashCommandBuilder; specs: CommandSpec[] }`
  - `GROUPS: CommandGroup[]`, `SPECS: Map<string, CommandSpec>`, `buildCommands()`
  - `routeInteraction(client-free dispatch helpers)` from `route.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/bot/test/command-registration.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GROUPS, SPECS, buildCommands } from "../src/commands/index.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * "Parity" is only a claim unless something checks it. This file checks the
 * half that is structural: every subcommand Discord is told about has a
 * handler, and every handler is reachable by a subcommand. A command
 * registered with no handler answers a player with discord.js's default
 * failure; a handler with no command is dead code that reads as shipped.
 */
describe("command registration", () => {
  it("gives every registered subcommand a handler", () => {
    for (const group of GROUPS) {
      const json = group.command.toJSON();
      const subs = (json.options ?? []).filter((o) => o.type === 1);
      const paths = subs.length === 0 ? [json.name] : subs.map((s) => `${json.name} ${s.name}`);
      for (const path of paths) {
        expect(SPECS.has(path), `no handler for /${path}`).toBe(true);
      }
    }
  });

  it("makes every handler reachable by a registered subcommand", () => {
    const registered = new Set(
      GROUPS.flatMap((g) => {
        const json = g.command.toJSON();
        const subs = (json.options ?? []).filter((o) => o.type === 1);
        return subs.length === 0 ? [json.name] : subs.map((s) => `${json.name} ${s.name}`);
      }),
    );
    for (const path of SPECS.keys()) {
      expect(registered.has(path), `/${path} has a handler but is not registered`).toBe(true);
    }
  });

  it("stays inside Discord's limits", () => {
    const payload = buildCommands();
    expect(payload.length).toBeLessThanOrEqual(100);
    const names = payload.map((c) => c.name);
    expect(new Set(names).size, `duplicate command name in ${names.join(", ")}`).toBe(names.length);
    for (const group of GROUPS) {
      const json = group.command.toJSON();
      expect((json.options ?? []).length, `/${json.name} has too many subcommands`).toBeLessThanOrEqual(25);
    }
  });

  it("names an autocomplete source for every option marked autocomplete", () => {
    for (const group of GROUPS) {
      const json = group.command.toJSON();
      for (const sub of (json.options ?? []).filter((o) => o.type === 1)) {
        for (const opt of ((sub as { options?: { name: string; autocomplete?: boolean }[] }).options ?? [])) {
          if (!opt.autocomplete) continue;
          const spec = SPECS.get(`${json.name} ${sub.name}`);
          expect(spec?.autocomplete?.[opt.name], `/${json.name} ${sub.name} ${opt.name} has no source`).toBeTypeOf("function");
        }
      }
    }
  });
});

/**
 * Spec §1. Every reply a player sees is ephemeral, forever. A grep, not a
 * behavioural test, because the failure it guards is someone adding a NEW
 * reply path months from now and reaching for a plain `interaction.reply`.
 */
describe("commands are ephemeral", () => {
  const files = readdirSync(resolve(here, "..", "src", "commands"), { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"));

  it("has files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("never sets ephemeral to anything but true", () => {
    for (const f of files) {
      const src = readFileSync(resolve(here, "..", "src", "commands", f), "utf8");
      expect(src, f).not.toMatch(/ephemeral:\s*false/u);
    }
  });

  /**
   * `route.ts` acknowledges an interaction in exactly one place, and that
   * place must carry the flag. Asserted structurally rather than by counting
   * `.reply(` calls: the router defers first and edits after, so the literal
   * string ".reply(" never appears and a count-based check would pass
   * vacuously forever.
   */
  it("acknowledges only with MessageFlags.Ephemeral", () => {
    const route = readFileSync(resolve(here, "..", "src", "commands", "route.ts"), "utf8");
    const acks = route.match(/\.(deferReply|reply)\(/gu) ?? [];
    expect(acks.length, "route.ts must acknowledge interactions").toBeGreaterThan(0);
    expect(route).toMatch(/deferReply\(\{\s*flags:\s*MessageFlags\.Ephemeral\s*\}\)/u);
    // An un-flagged acknowledgement would be a public reply.
    expect(route).not.toMatch(/\.reply\(\{(?![^}]*MessageFlags\.Ephemeral)/u);
  });
});
```

There is **one** test file for both guards. Do not create `apps/bot/test/ephemeral.test.ts`; the File Structure table above lists only `command-registration.test.ts` for this reason.

- [ ] **Step 2: Run tests to verify they fail**

Run:
```
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars && \
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
npx vitest run --root apps/bot test/command-registration.test.ts
```
Expected: FAIL — `Cannot find module '../src/commands/index.js'`.

- [ ] **Step 3: Write `apps/bot/src/commands/types.ts`**

```ts
import type { EmbedBuilder, SlashCommandBuilder, SlashCommandSubcommandsOnlyBuilder } from "discord.js";
import type { Roster } from "@factions/roster";

/**
 * ⚠️ Every reply is ephemeral — see the note on `Reply` in
 * `apps/bot/src/commands.ts`. There is no `public` option and there must
 * never be one: a challenge sequence posted publicly is a challenge any
 * bystander can perform, and a clan's roster, base or vault is a raid target.
 */
export type Reply = { content?: string; embeds?: EmbedBuilder[]; ephemeral: true };

/**
 * What a handler is given instead of a discord.js interaction. `route.ts` is
 * the only file that unpacks one; everything downstream is a pure function of
 * these fields and is unit-testable with no client — the shape
 * `handleGuestCommand` already had.
 */
export type CommandInput = {
  /**
   * `interaction.user.id`. The SAME Discord snowflake the site's session
   * cookie holds in `sub`, which is why no new credential is needed: the
   * roster call re-derives everything else from it.
   */
  actorDiscordId: string;
  string: (name: string) => string | null;
  integer: (name: string) => number | null;
  boolean: (name: string) => boolean | null;
  /** A resolved user option's id, or null. */
  user: (name: string) => string | null;
};

export type Ctx = {
  roster: Roster;
  /** For formatting only. Domain time comes from the roster instance's own clock. */
  now: Date;
  siteBaseUrl: string;
};

export type Handler = (ctx: Ctx, input: CommandInput) => Promise<Reply>;

/** Discord allows 25 choices and gives 3 seconds; every source below is one indexed query. */
export type AutocompleteSource = (
  ctx: Ctx,
  a: { actorDiscordId: string; value: string },
) => Promise<{ name: string; value: string }[]>;

export type CommandSpec = {
  /** "base" for a bare command, "base declare" for a subcommand. Matches `command-registration.test.ts`. */
  path: string;
  handler: Handler;
  /** Keyed by option name. */
  autocomplete?: Record<string, AutocompleteSource>;
};

export type CommandGroup = {
  command: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder;
  specs: CommandSpec[];
};
```

Widen `apps/bot/src/commands.ts`'s `Reply` to match, keeping its existing comment, and re-export the new type so `guest-command.ts` keeps compiling:

```ts
export type { Reply } from "./commands/types.js";
```

- [ ] **Step 4: Write `apps/bot/src/commands/index.ts`**

```ts
import { SlashCommandBuilder, type RESTPostAPIApplicationCommandsJSONBody } from "discord.js";
import { RETIRED_COMMANDS, RETIRED_DESCRIPTION } from "../retired-commands.js";
import type { CommandGroup, CommandSpec } from "./types.js";

/**
 * The registry. A group states its Discord JSON and its handlers in one
 * place, and `command-registration.test.ts` asserts the two halves are a
 * bijection — so a command cannot be registered with nothing behind it, and a
 * handler cannot rot unreachable.
 *
 * ⚠️ The retired stubs stay registered until Discord can do everything they
 * point at (spec §1, corrected in plan 1). They are removed in the last task
 * of plan 3, not before: a player who loses the stub before the real command
 * lands gets Discord's "unknown command" and no pointer at all.
 */
export const GROUPS: CommandGroup[] = [];

export const SPECS: Map<string, CommandSpec> = new Map(
  GROUPS.flatMap((g) => g.specs).map((s) => [s.path, s]),
);

export function buildCommands(): RESTPostAPIApplicationCommandsJSONBody[] {
  return [
    ...RETIRED_COMMANDS.map((name) =>
      new SlashCommandBuilder().setName(name).setDescription(RETIRED_DESCRIPTION).toJSON()),
    new SlashCommandBuilder()
      .setName("guest")
      .setDescription("Give someone a 24h voice guest pass")
      .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true))
      .toJSON(),
    ...GROUPS.map((g) => g.command.toJSON()),
  ];
}
```

- [ ] **Step 5: Write `apps/bot/src/commands/route.ts`**

```ts
import { MessageFlags, type AutocompleteInteraction, type ChatInputCommandInteraction, type Interaction } from "discord.js";
import { SPECS } from "./index.js";
import type { CommandInput, Ctx, Reply } from "./types.js";

/** What an unknown command or a stale client gets: a sentence, never discord.js's default failure. */
const UNKNOWN = "That command is no longer available — check the site.";

/** The one place a discord.js interaction is unpacked into a handler's input. */
function inputFor(i: ChatInputCommandInteraction): CommandInput {
  return {
    actorDiscordId: i.user.id,
    string: (n) => i.options.getString(n),
    integer: (n) => i.options.getInteger(n),
    boolean: (n) => i.options.getBoolean(n),
    user: (n) => i.options.getUser(n)?.id ?? null,
  };
}

export function pathOf(commandName: string, subcommand: string | null): string {
  return subcommand ? `${commandName} ${subcommand}` : commandName;
}

export async function handleChatInput(ctx: Ctx, i: ChatInputCommandInteraction): Promise<void> {
  const spec = SPECS.get(pathOf(i.commandName, i.options.getSubcommand(false)));
  if (!spec) return;
  // ⚠️ Defer first. A handler runs one or more database round trips and
  // Discord kills an un-acknowledged interaction after 3 seconds; the reply
  // below then edits the deferred message instead of racing that deadline.
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const reply: Reply = await spec.handler(ctx, inputFor(i));
  await i.editReply({ content: reply.content, embeds: reply.embeds ?? [] });
}

export async function handleAutocomplete(ctx: Ctx, i: AutocompleteInteraction): Promise<void> {
  const focused = i.options.getFocused(true);
  const spec = SPECS.get(pathOf(i.commandName, i.options.getSubcommand(false)));
  const source = spec?.autocomplete?.[focused.name];
  if (!source) { await i.respond([]); return; }
  const choices = await source(ctx, { actorDiscordId: i.user.id, value: String(focused.value ?? "") });
  // Discord rejects more than 25, and a name over 100 characters.
  await i.respond(choices.slice(0, 25).map((c) => ({ name: c.name.slice(0, 100), value: c.value })));
}

/**
 * The bot's whole interaction surface.
 *
 * ⚠️ discord.js does not await this listener's caller; an uncaught throw is
 * an unhandled rejection that takes the bot down. `discord.ts` keeps the
 * try/catch that logs and drops one interaction — do not move it in here and
 * do not remove it.
 */
export async function routeInteraction(ctx: Ctx, interaction: Interaction): Promise<boolean> {
  if (interaction.isAutocomplete()) {
    await handleAutocomplete(ctx, interaction);
    return true;
  }
  if (interaction.isChatInputCommand()) {
    const path = pathOf(interaction.commandName, interaction.options.getSubcommand(false));
    if (!SPECS.has(path)) return false;
    await handleChatInput(ctx, interaction);
    return true;
  }
  return false;
}

export { UNKNOWN };
```

- [ ] **Step 6: Wire it into `discord.ts`**

In `apps/bot/src/discord.ts`, replace the local `buildCommands` (lines 56–66) with a re-export so its existing importers do not change:

```ts
export { buildCommands } from "./commands/index.js";
```

Build the `Ctx` once, where `store`/`ceremonyStore`/etc. are built (around line 425):

```ts
import { makeRoster } from "@factions/roster";
import { routeInteraction } from "./commands/route.js";
import type { Ctx } from "./commands/types.js";

const commandCtx: Ctx = { roster: makeRoster(() => db), now: new Date(), siteBaseUrl: cfg.siteBaseUrl };
```

⚠️ `now` on a long-lived `Ctx` would freeze at boot. Build the context per interaction instead — it is three field reads:

```ts
const roster = makeRoster(() => db);
const ctxNow = (): Ctx => ({ roster, now: new Date(), siteBaseUrl: cfg.siteBaseUrl });
```

Then rewrite the `interactionCreate` listener (lines 548–575), keeping its try/catch verbatim:

```ts
client.on("interactionCreate", async (interaction) => {
  try {
    if (await routeInteraction(ctxNow(), interaction)) return;

    if (interaction.isAutocomplete()) { await interaction.respond([]); return; }
    if (interaction.isChatInputCommand() && interaction.commandName === "guest") {
      const reply = await handleGuestCommand(db, {
        channelId: interaction.channelId,
        actorDiscordId: interaction.user.id,
        targetUserId: interaction.options.getUser("user", true).id,
        now: new Date(),
      });
      await interaction.reply({ content: reply.content, flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.isChatInputCommand()) {
      const sub = interaction.options.getSubcommand(false);
      const reply = retiredReply(cfg.siteBaseUrl, interaction.commandName, sub);
      await interaction.reply({ content: reply.content, flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.isMessageComponent()) {
      const reply = retiredReply(cfg.siteBaseUrl, "faction", interaction.customId.startsWith("invite-") ? "invites" : null);
      await interaction.reply({ content: reply.content, flags: MessageFlags.Ephemeral });
      return;
    }
  } catch (err) {
    // ⚠️ discord.js does not await this listener; an uncaught throw is an unhandled rejection that takes the bot down. Log and drop the one interaction.
    console.error(`interaction failed`, err);
  }
});
```

⚠️ `routeInteraction` returns `true` for **every** autocomplete, including ones for commands it does not own, so the old blanket `respond([])` below it is now dead for autocomplete. That is correct — `handleAutocomplete` already answers `[]` when there is no source. Leave the line in place; it costs nothing and documents the fallback.

Add `"@factions/copy": "workspace:*"` to `apps/bot/package.json` and run `pnpm install`.

- [ ] **Step 7: Run the bot suite**

Run:
```
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars && \
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
npx vitest run --root apps/bot
```
Expected: PASS. `command-registration.test.ts` passes vacuously (`GROUPS` is empty — the bijection holds over the empty set, and "has files to check" passes because `types.ts`, `index.ts` and `route.ts` exist). `retired-commands.test.ts` and `discord.test.ts` must be untouched and green.

- [ ] **Step 8: Run the full gate and commit**

Run:
```
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars && \
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
npx turbo run typecheck test --concurrency=1 --force
```
Expected: 28/28.

```bash
git add apps/bot/src/commands apps/bot/src/commands.ts apps/bot/src/discord.ts \
        apps/bot/package.json apps/bot/test/command-registration.test.ts pnpm-lock.yaml
git commit -m "feat(bot): command registry and interaction router

A group states its Discord JSON and its handlers together; a bijection test
makes it impossible to register a command with no handler or leave a handler
unreachable. Handlers are pure functions of (Ctx, CommandInput), so they test
without a discord.js client. No new command is registered yet — the retired
stubs and /guest are emitted exactly as before."
```

---

## Task 4: `/link status`

The first real command, and the one that proves the read path: roster instance → outcome → embed → ephemeral reply.

**Files:**
- Create: `apps/bot/src/commands/link.ts`
- Create: `apps/bot/src/commands/embeds/link.ts`
- Create: `apps/bot/test/commands-link.test.ts`
- Modify: `apps/bot/src/commands/index.ts` (register the group)

**Interfaces:**
- Consumes: `Ctx`, `CommandInput`, `Reply`, `CommandGroup`, `CommandSpec` (Task 3); `roster.linkStatus` (Task 1); `ENDED_COPY`, `formatRemaining` (Task 2).
- Produces:
  - `linkGroup: CommandGroup`
  - `linkStatusEmbed(status: LinkStatus, now: Date, siteBaseUrl: string): EmbedBuilder`

- [ ] **Step 1: Write the failing test**

Create `apps/bot/test/commands-link.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, identityLinks, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { makeRoster } from "@factions/roster";
import { SPECS } from "../src/commands/index.js";
import type { Ctx, CommandInput } from "../src/commands/types.js";

const URL = requireTestDatabaseUrl();
const NOW = new Date("2026-09-13T12:00:00Z");
const D = "discord-ada";
const UID = "A".repeat(40);

const noOptions: Omit<CommandInput, "actorDiscordId"> = {
  string: () => null, integer: () => null, boolean: () => null, user: () => null,
};
const input = (actorDiscordId: string, over: Partial<CommandInput> = {}): CommandInput =>
  ({ actorDiscordId, ...noOptions, ...over });

describe("/link status", () => {
  let db: Database;
  let ctx: Ctx;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table identity_links, verification_challenges, players, servers restart identity cascade`);
    await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 });
    ctx = { roster: makeRoster(() => db, () => NOW), now: NOW, siteBaseUrl: "https://example.test" };
  });

  const run = (i: CommandInput) => SPECS.get("link status")!.handler(ctx, i);

  it("tells an unlinked player how to start", async () => {
    const reply = await run(input(D));
    expect(reply.ephemeral).toBe(true);
    const embed = reply.embeds![0]!.toJSON();
    expect(embed.description).toContain("/link start");
  });

  it("shows the linked character", async () => {
    await db.insert(identityLinks).values({ discordId: D, dayzId: UID, gamertag: "Ada", verifiedAt: NOW });
    const reply = await run(input(D));
    const embed = reply.embeds![0]!.toJSON();
    expect(JSON.stringify(embed)).toContain("Ada");
  });

  it("never says faction", async () => {
    await db.insert(identityLinks).values({ discordId: D, dayzId: UID, gamertag: "Ada", verifiedAt: NOW });
    const reply = await run(input(D));
    expect(JSON.stringify(reply).toLowerCase()).not.toContain("faction");
  });
});
```

⚠️ Confirm the challenge table's real name before writing the `truncate`: run
`grep -rn "export const verification" packages/db/src/schema*.ts` and use what
it exports. If it is not `verification_challenges`, fix the truncate here and in
every later suite in this plan.

- [ ] **Step 2: Run test to verify it fails**

Run:
```
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars && \
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
npx vitest run --root apps/bot test/commands-link.test.ts
```
Expected: FAIL — `Cannot read properties of undefined (reading 'handler')`, because `SPECS` has no `"link status"`.

- [ ] **Step 3: Write the embed builder**

Create `apps/bot/src/commands/embeds/link.ts`:

```ts
import { EmbedBuilder } from "discord.js";
import type { LinkStatus } from "@factions/roster";
import { ENDED_COPY, formatRemaining } from "@factions/copy";

/** The site's ink. Kept here rather than per-embed so every card matches. */
const GOLD = 0xc8a34a;

/**
 * `/link status` — the card the site's /link page draws, as an embed.
 *
 * ⚠️ The emote sequence IS the secret. It is safe here only because every
 * reply is ephemeral; if this embed ever reaches a public message, anyone
 * reading it can perform the sequence and bind their own UID to this
 * player's account. See `apps/bot/src/commands.ts`.
 */
export function linkStatusEmbed(status: LinkStatus, now: Date, siteBaseUrl: string): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(GOLD).setTitle("Your character");

  if (status.link) {
    embed.setDescription(`Linked to **${status.link.gamertag}**.`);
    embed.addFields({ name: "Unlink", value: "`/link unlink` — refused while you are in a clan.", inline: false });
  } else if (!status.challenge) {
    embed.setDescription("No character linked yet. Run `/link start` and pick your character to draw a challenge.");
  }

  if (status.challenge) {
    const c = status.challenge;
    const steps = c.steps.map((s, n) => `${s.confirmed ? "✅" : `${n + 1}.`} ${s.label}`).join("\n");
    embed.addFields(
      { name: `Challenge for ${c.gamertag}`, value: steps, inline: false },
      { name: "Done", value: `${c.confirmed} of ${c.steps.length}`, inline: true },
      { name: "Expires in", value: formatRemaining(c.expiresAt.getTime() - now.getTime()), inline: true },
      { name: "Redraws left", value: String(c.drawsLeft), inline: true },
    );
    embed.setFooter({ text: "Perform them in order, in game. `/link cancel` drops the challenge." });
  }

  if (status.ended && Object.hasOwn(ENDED_COPY, status.ended)) {
    embed.addFields({ name: "Last attempt", value: ENDED_COPY[status.ended as keyof typeof ENDED_COPY], inline: false });
  }

  embed.setURL(`${siteBaseUrl}/link`);
  return embed;
}
```

- [ ] **Step 4: Write the group with `status` only**

Create `apps/bot/src/commands/link.ts`:

```ts
import { SlashCommandBuilder } from "discord.js";
import { linkStatusEmbed } from "./embeds/link.js";
import type { CommandGroup, Handler } from "./types.js";

const status: Handler = async (ctx, input) => ({
  embeds: [linkStatusEmbed(await ctx.roster.linkStatus(input.actorDiscordId), ctx.now, ctx.siteBaseUrl)],
  ephemeral: true,
});

export const linkGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link your Discord account to your in-game character")
    .addSubcommand((s) => s.setName("status").setDescription("Your link and any open challenge")),
  specs: [{ path: "link status", handler: status }],
};
```

⚠️ `/link` is currently registered as a retired stub. `buildCommands()` would now emit the name twice and Discord's PUT would reject the payload. Remove `"link"` from `RETIRED_COMMANDS` in `apps/bot/src/retired-commands.ts` in this step, and delete the `"link"` case from `retiredPath` and its assertions in `apps/bot/test/retired-commands.test.ts`. The registration test's duplicate-name assertion is what catches this if it is missed.

Register the group in `apps/bot/src/commands/index.ts`:

```ts
import { linkGroup } from "./link.js";

export const GROUPS: CommandGroup[] = [linkGroup];
```

- [ ] **Step 5: Run the test**

Run:
```
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars && \
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
npx vitest run --root apps/bot test/commands-link.test.ts test/command-registration.test.ts test/retired-commands.test.ts
```
Expected: PASS, all three files.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/commands apps/bot/src/retired-commands.ts \
        apps/bot/test/commands-link.test.ts apps/bot/test/retired-commands.test.ts
git commit -m "feat(bot): /link status

The first command through the registry: roster instance to embed to ephemeral
reply, no discord.js client in the test. /link leaves RETIRED_COMMANDS, since
the real command now occupies the name."
```

---

## Task 5: `/link start`, `/link cancel`, `/link unlink`

Adds the write path and the first autocomplete source.

**Files:**
- Modify: `apps/bot/src/commands/link.ts`
- Modify: `apps/bot/test/commands-link.test.ts`

**Interfaces:**
- Consumes: everything from Task 4; `roster.startLink`, `roster.cancelLink`, `roster.unlink`, `roster.searchGamertags` (Task 1); `ISSUE_COPY`, `UNLINK_COPY` (Task 2).
- Produces: three more entries in `linkGroup.specs`, paths `link start`, `link cancel`, `link unlink`; autocomplete source on `link start`'s `character` option.

- [ ] **Step 1: Write the failing tests**

Append to `apps/bot/test/commands-link.test.ts`:

```ts
import { players } from "@factions/db";

describe("/link start", () => {
  let db: Database;
  let ctx: Ctx;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table identity_links, verification_challenges, players, servers restart identity cascade`);
    await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 });
    await db.insert(players).values({ dayzId: UID, gamertag: "Ada", lastSeenAt: NOW });
    ctx = { roster: makeRoster(() => db, () => NOW), now: NOW, siteBaseUrl: "https://example.test" };
  });

  const spec = () => SPECS.get("link start")!;

  it("issues a challenge and shows the sequence", async () => {
    const reply = await spec().handler(ctx, input(D, { string: (n) => (n === "character" ? UID : null) }));
    expect(reply.ephemeral).toBe(true);
    expect(JSON.stringify(reply.embeds![0]!.toJSON())).toContain("Ada");
  });

  it("refuses a character the log has never seen, in the site's words", async () => {
    const reply = await spec().handler(ctx, input(D, { string: (n) => (n === "character" ? "Z".repeat(40) : null) }));
    expect(reply.content).toBe("The server has not seen that character. Pick one from the list — only characters the event log has seen can be linked.");
  });

  it("autocompletes characters the log has seen", async () => {
    const choices = await spec().autocomplete!.character!(ctx, { actorDiscordId: D, value: "Ad" });
    expect(choices).toEqual([{ name: "Ada", value: UID }]);
  });

  it("returns no more than 25 choices", async () => {
    await db.insert(players).values(
      Array.from({ length: 40 }, (_, n) => ({ dayzId: `B${String(n).padStart(39, "0")}`, gamertag: `Ada${n}`, lastSeenAt: NOW })),
    );
    const choices = await spec().autocomplete!.character!(ctx, { actorDiscordId: D, value: "Ada" });
    expect(choices.length).toBeLessThanOrEqual(25);
  });
});

describe("/link cancel and /link unlink", () => {
  let db: Database;
  let ctx: Ctx;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table identity_links, verification_challenges, players, declarations, poles, servers restart identity cascade`);
    await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 });
    ctx = { roster: makeRoster(() => db, () => NOW), now: NOW, siteBaseUrl: "https://example.test" };
  });

  it("says so when there was nothing to cancel", async () => {
    const reply = await SPECS.get("link cancel")!.handler(ctx, input(D));
    expect(reply.content).toBe("You had no open challenge.");
    expect(reply.ephemeral).toBe(true);
  });

  it("unlinks a linked player in the site's words", async () => {
    await db.insert(identityLinks).values({ discordId: D, dayzId: UID, gamertag: "Ada", verifiedAt: NOW });
    const reply = await SPECS.get("link unlink")!.handler(ctx, input(D));
    expect(reply.content).toBe("Unlinked. Your solo base, if you had one, has been released.");
  });

  it("tells a player who was never linked", async () => {
    const reply = await SPECS.get("link unlink")!.handler(ctx, input(D));
    expect(reply.content).toBe("You were not linked to a character.");
  });
});
```

⚠️ Before writing the implementation, read `packages/roster/src/link.ts` for
`UnlinkOutcome`'s exact discriminants and `packages/verification`'s
`IssueOutcome` kinds, and shape the switch below to whatever those actually
are. The three `content` strings asserted above come from `UNLINK_COPY` and
`ISSUE_COPY` in `@factions/copy` — assert against the constants if a literal
drifts, never by loosening the assertion.

- [ ] **Step 2: Run tests to verify they fail**

Run:
```
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars && \
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
npx vitest run --root apps/bot test/commands-link.test.ts
```
Expected: FAIL on the four new describes — `SPECS.get("link start")` is undefined.

- [ ] **Step 3: Implement**

Rewrite `apps/bot/src/commands/link.ts`:

```ts
import { SlashCommandBuilder } from "discord.js";
import { ISSUE_COPY, UNLINK_COPY } from "@factions/copy";
import { linkStatusEmbed } from "./embeds/link.js";
import type { AutocompleteSource, CommandGroup, Handler } from "./types.js";

const status: Handler = async (ctx, input) => ({
  embeds: [linkStatusEmbed(await ctx.roster.linkStatus(input.actorDiscordId), ctx.now, ctx.siteBaseUrl)],
  ephemeral: true,
});

/**
 * `/link start` — issue a challenge, then show it.
 *
 * The outcome kinds that MEAN a challenge is open ("issued", "live") are not
 * rendered from the outcome: the status read is the one place that formats a
 * challenge, so the card a player sees here and the card `/link status` shows
 * them a minute later cannot drift apart.
 */
const start: Handler = async (ctx, input) => {
  const target = input.string("character");
  if (!target) return { content: "Pick a character from the list.", ephemeral: true };

  const outcome = await ctx.roster.startLink(input.actorDiscordId, target, { newSequence: input.boolean("redraw") === true });
  if (outcome.kind === "issued" || outcome.kind === "live") {
    return { embeds: [linkStatusEmbed(await ctx.roster.linkStatus(input.actorDiscordId), ctx.now, ctx.siteBaseUrl)], ephemeral: true };
  }
  return { content: ISSUE_COPY[outcome.kind](outcome), ephemeral: true };
};

const cancel: Handler = async (ctx, input) => {
  const { canceled } = await ctx.roster.cancelLink(input.actorDiscordId);
  return { content: canceled ? "Challenge canceled. Draw a new one with `/link start`." : "You had no open challenge.", ephemeral: true };
};

/** `unlink` releases a solo base and is refused inside a clan; both rules are the store's. */
const unlink: Handler = async (ctx, input) => {
  const outcome = await ctx.roster.unlink(input.actorDiscordId);
  if (outcome.ok) return { content: UNLINK_COPY.ok!, ephemeral: true };
  return { content: UNLINK_COPY[outcome.reason] ?? UNLINK_COPY["not-linked"]!, ephemeral: true };
};

/** The log's own list of characters. Autocomplete is scoped by prefix, not by viewer: the site's /link box is the same. */
const characters: AutocompleteSource = async (ctx, a) => {
  if (a.value.trim().length === 0) return [];
  const matches = await ctx.roster.searchGamertags(a.value.slice(0, 64));
  return matches.map((m) => ({ name: m.gamertag, value: m.dayzId }));
};

export const linkGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link your Discord account to your in-game character")
    .addSubcommand((s) => s.setName("status").setDescription("Your link and any open challenge"))
    .addSubcommand((s) => s
      .setName("start")
      .setDescription("Draw a challenge for one of your characters")
      .addStringOption((o) => o.setName("character").setDescription("Your in-game name").setRequired(true).setAutocomplete(true))
      .addBooleanOption((o) => o.setName("redraw").setDescription("Draw a different sequence")))
    .addSubcommand((s) => s.setName("cancel").setDescription("Drop your open challenge"))
    .addSubcommand((s) => s.setName("unlink").setDescription("Unbind your character")),
  specs: [
    { path: "link status", handler: status },
    { path: "link start", handler: start, autocomplete: { character: characters } },
    { path: "link cancel", handler: cancel },
    { path: "link unlink", handler: unlink },
  ],
};
```

⚠️ `searchGamertags` may return more than 25 rows; `route.ts` slices to 25 before responding, so the "no more than 25" test passes through the router's guarantee. If that test asserts against the source directly (it does), add the slice in `characters` too — it is cheap and makes the source correct on its own.

- [ ] **Step 4: Run the tests**

Run:
```
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars && \
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
npx vitest run --root apps/bot test/commands-link.test.ts test/command-registration.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/commands/link.ts apps/bot/test/commands-link.test.ts
git commit -m "feat(bot): /link start, cancel and unlink

Writes go through the roster instance and render @factions/copy's tables, so
Discord and the site refuse for the same reasons in the same words. The
challenge card is drawn from the status read in both places, so the two views
cannot drift."
```

---

## Task 6: `/base show`, `/base declare`, `/base release`

The second group, and the one that proves an autocomplete source scoped to the **actor** rather than a global prefix search.

**Files:**
- Create: `apps/bot/src/commands/base.ts`
- Create: `apps/bot/src/commands/embeds/base.ts`
- Create: `apps/bot/test/commands-base.test.ts`
- Modify: `apps/bot/src/commands/index.ts`

**Interfaces:**
- Consumes: `roster.baseFor`, `roster.declareSolo`, `roster.releaseSolo` (Task 1); `DECLARE_COPY`, `DECLARED_OK`, `RELEASE_COPY`, `lapsedCopy` (Task 2).
- Produces: `baseGroup: CommandGroup` with paths `base show`, `base declare`, `base release`; `baseEmbed(view: BaseView, siteBaseUrl: string): EmbedBuilder`.

- [ ] **Step 1: Write the failing test**

Create `apps/bot/test/commands-base.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, identityLinks, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { makeRoster } from "@factions/roster";
import { DECLARE_COPY } from "@factions/copy";
import { SPECS } from "../src/commands/index.js";
import type { Ctx, CommandInput } from "../src/commands/types.js";

const URL = requireTestDatabaseUrl();
const NOW = new Date("2026-09-13T12:00:00Z");
const D = "discord-ada";
const UID = "A".repeat(40);

const input = (actorDiscordId: string, over: Partial<CommandInput> = {}): CommandInput => ({
  actorDiscordId, string: () => null, integer: () => null, boolean: () => null, user: () => null, ...over,
});

describe("/base", () => {
  let db: Database;
  let ctx: Ctx;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table identity_links, declarations, poles, events, adm_files, clan_notices, players, servers restart identity cascade`);
    await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 });
    ctx = { roster: makeRoster(() => db, () => NOW), now: NOW, siteBaseUrl: "https://example.test" };
  });

  it("tells an unlinked player to link first", async () => {
    const reply = await SPECS.get("base show")!.handler(ctx, input(D));
    expect(reply.ephemeral).toBe(true);
    expect(JSON.stringify(reply)).toContain("Link your character first");
  });

  it("refuses a declare at a pole the log never saw the player raise", async () => {
    await db.insert(identityLinks).values({ discordId: D, dayzId: UID, gamertag: "Ada", verifiedAt: NOW });
    const reply = await SPECS.get("base declare")!.handler(
      ctx, input(D, { string: (n) => (n === "pole" ? "9000.00:100.00:9000.00" : null) }),
    );
    expect(reply.content).toBe(DECLARE_COPY["no-raise"]);
  });

  it("says so when there was no base to release", async () => {
    await db.insert(identityLinks).values({ discordId: D, dayzId: UID, gamertag: "Ada", verifiedAt: NOW });
    const reply = await SPECS.get("base release")!.handler(ctx, input(D));
    expect(reply.content).toBe("You had no declared base to release.");
  });

  it("offers only poles this player raised at", async () => {
    await db.insert(identityLinks).values({ discordId: D, dayzId: UID, gamertag: "Ada", verifiedAt: NOW });
    const choices = await SPECS.get("base declare")!.autocomplete!.pole!(ctx, { actorDiscordId: D, value: "" });
    expect(choices).toEqual([]);
  });

  it("never says faction", async () => {
    await db.insert(identityLinks).values({ discordId: D, dayzId: UID, gamertag: "Ada", verifiedAt: NOW });
    const reply = await SPECS.get("base show")!.handler(ctx, input(D));
    expect(JSON.stringify(reply).toLowerCase()).not.toContain("faction");
  });
});
```

⚠️ The "offers only poles this player raised at" case asserts the empty list because seeding a raise needs a `flag.raised` event and an `adm_files` row. Adding the positive case is worth doing: copy the raise-seeding block out of `packages/roster/test/base.test.ts` — it already builds exactly that fixture — and assert the pole key comes back. Do not invent a fixture; reuse that one.

- [ ] **Step 2: Run test to verify it fails**

Run:
```
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars && \
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
npx vitest run --root apps/bot test/commands-base.test.ts
```
Expected: FAIL — `SPECS.get("base show")` is undefined.

- [ ] **Step 3: Write the embed**

Create `apps/bot/src/commands/embeds/base.ts`:

```ts
import { EmbedBuilder } from "discord.js";
import type { BaseView } from "@factions/roster";
import { lapsedCopy } from "@factions/copy";

const GOLD = 0xc8a34a;

/**
 * `/base show`.
 *
 * ⚠️ Every coordinate here is the VIEWER's own. `baseFor` never returns
 * another player's pole, because a pole coordinate is a raid target — do not
 * add a field that widens what this card can show.
 */
export function baseEmbed(view: BaseView, siteBaseUrl: string): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(GOLD).setTitle("Your base").setURL(`${siteBaseUrl}/base`);

  if (!view.linked) {
    return embed.setDescription("Link your character first — run `/link start`.");
  }
  if (view.inClan) {
    return embed.setDescription("You are in a clan, so your base is the clan's. Solo declarations are for players outside one.");
  }

  if (view.declaration) {
    const d = view.declaration;
    embed.setDescription(`Declared at **${Math.round(d.x)}, ${Math.round(d.z)}**.`);
    embed.addFields({ name: "Release", value: "`/base release`", inline: false });
  } else {
    embed.setDescription("No declared base. Raise your flag at a pole, then run `/base declare`.");
  }

  if (view.lapsed) embed.addFields({ name: "Lapsed", value: lapsedCopy(view.lapsed.at), inline: false });

  if (view.candidates.length > 0) {
    embed.addFields({
      name: "Poles you have raised at",
      value: view.candidates.map((c) => `• ${Math.round(c.x)}, ${Math.round(c.z)}`).join("\n").slice(0, 1024),
      inline: false,
    });
  }
  return embed;
}
```

- [ ] **Step 4: Write the group**

Create `apps/bot/src/commands/base.ts`:

```ts
import { SlashCommandBuilder } from "discord.js";
import { DECLARE_COPY, DECLARED_OK, RELEASE_COPY } from "@factions/copy";
import { baseEmbed } from "./embeds/base.js";
import type { AutocompleteSource, CommandGroup, Handler } from "./types.js";

const show: Handler = async (ctx, input) => ({
  embeds: [baseEmbed(await ctx.roster.baseFor(input.actorDiscordId), ctx.siteBaseUrl)],
  ephemeral: true,
});

const declare: Handler = async (ctx, input) => {
  const pole = input.string("pole");
  if (!pole) return { content: "Pick a pole from the list.", ephemeral: true };
  const outcome = await ctx.roster.declareSolo(input.actorDiscordId, pole);
  return { content: outcome.ok ? DECLARED_OK : DECLARE_COPY[outcome.reason], ephemeral: true };
};

const release: Handler = async (ctx, input) => {
  const { released } = await ctx.roster.releaseSolo(input.actorDiscordId);
  return { content: released ? RELEASE_COPY.released : RELEASE_COPY.nothing, ephemeral: true };
};

/**
 * Only poles THIS player raised a flag at, which is exactly what `baseFor`
 * returns and nothing wider — the same guarantee the site's /base page
 * relies on.
 */
const poles: AutocompleteSource = async (ctx, a) => {
  const view = await ctx.roster.baseFor(a.actorDiscordId);
  if (!view.linked) return [];
  return view.candidates
    .filter((c) => a.value.trim() === "" || c.poleKey.includes(a.value.trim()))
    .map((c) => ({ name: `${Math.round(c.x)}, ${Math.round(c.z)}`, value: c.poleKey }));
};

export const baseGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("base")
    .setDescription("Your solo base")
    .addSubcommand((s) => s.setName("show").setDescription("Your declaration and the poles you have raised at"))
    .addSubcommand((s) => s
      .setName("declare")
      .setDescription("Declare a solo base at a pole you have raised at")
      .addStringOption((o) => o.setName("pole").setDescription("Which pole").setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("release").setDescription("Give up your declared base")),
  specs: [
    { path: "base show", handler: show },
    { path: "base declare", handler: declare, autocomplete: { pole: poles } },
    { path: "base release", handler: release },
  ],
};
```

Register it in `apps/bot/src/commands/index.ts`:

```ts
import { baseGroup } from "./base.js";
import { linkGroup } from "./link.js";

export const GROUPS: CommandGroup[] = [linkGroup, baseGroup];
```

- [ ] **Step 5: Run the tests and the full gate**

Run:
```
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars && \
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
npx vitest run --root apps/bot
```
Expected: PASS.

Run:
```
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars && \
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
npx turbo run typecheck test --concurrency=1 --force
```
Expected: 28/28.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/commands apps/bot/test/commands-base.test.ts
git commit -m "feat(bot): /base show, declare and release

The pole autocomplete reads baseFor, so it can only ever offer poles this
player raised at — another player's pole is a raid target and never passes
through the command layer."
```

---

## Task 7: The parity guard, the runbook, and CLAUDE.md

Turns "parity" from a claim into a test that fails when a future increment adds a capability to the site and forgets Discord.

**Files:**
- Create: `apps/bot/test/parity.test.ts`
- Create: `docs/deploy/2026-09-13-discord-commands.md`
- Modify: `apps/bot/test/vocabulary.test.ts`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `SPECS` (Task 3); `ROSTER_EXPORTS` (Task 1).
- Produces: `PARITY` — the table Plans 2 and 3 extend, one row per roster write.

- [ ] **Step 1: Write the parity test**

Create `apps/bot/test/parity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SPECS } from "../src/commands/index.js";

/**
 * Spec §2.1: every player WRITE the site can make, Discord can make too.
 *
 * The map below is the claim, written down. `PENDING` is the honest part: a
 * write lands here the moment `packages/roster` exports it, and moves to
 * `COMMANDS` when its command ships. The last assertion is what makes the
 * list expensive to ignore — a new roster export that is neither mapped nor
 * explicitly deferred fails this suite, so parity cannot rot quietly on the
 * next increment.
 *
 * ⚠️ Reads are deliberately NOT here. `/map` and deep board pagination are
 * site-only by design (spec §2.2); a test that demanded a command per read
 * would have to carve out exceptions and would stop meaning anything.
 */
const COMMANDS: Record<string, string> = {
  startLink: "link start",
  cancelLink: "link cancel",
  unlink: "link unlink",
  declareSolo: "base declare",
  releaseSolo: "base release",
};

/** Shipping in plans 2 and 3. Each entry names the plan that removes it. */
const PENDING: Record<string, string> = {
  invite: "plan 2", revokeInvite: "plan 2", acceptInvite: "plan 2", declineInvite: "plan 2",
  requestJoin: "plan 2", withdrawRequest: "plan 2", decideRequest: "plan 2", leave: "plan 2",
  kick: "plan 2", promote: "plan 2", demote: "plan 2", transfer: "plan 2", disband: "plan 2",
  rename: "plan 2", setRecruitingPost: "plan 2", claimCeremony: "plan 2", confirmRebind: "plan 2",
  claimSuccession: "plan 2", openVote: "plan 2", castVote: "plan 2",
  grantGuestPass: "plan 2", revokeGuestPass: "plan 2",
  addLock: "plan 3", editLock: "plan 3", deleteLock: "plan 3", revealLock: "plan 3",
  confirmLock: "plan 3", rotateLocks: "plan 3", dropPin: "plan 3", deletePin: "plan 3",
};

/** Every roster export that WRITES. Reads are excluded by name, on purpose, and reviewed when this list changes. */
const WRITES = [...Object.keys(COMMANDS), ...Object.keys(PENDING)];

describe("Discord parity with the site", () => {
  it("routes every shipped write to a registered command", () => {
    for (const [write, path] of Object.entries(COMMANDS)) {
      expect(SPECS.has(path), `${write} maps to /${path}, which has no handler`).toBe(true);
    }
  });

  it("does not list a write as both shipped and pending", () => {
    for (const write of Object.keys(COMMANDS)) {
      expect(Object.hasOwn(PENDING, write), `${write} is in both COMMANDS and PENDING`).toBe(false);
    }
  });

  it("accounts for every write @factions/roster exports", async () => {
    const { ROSTER_EXPORTS } = await import("../../../packages/roster/test/exports.test.js");
    const known = new Set(WRITES);
    // Names that read. Anything not here and not in `known` is a new export
    // nobody has decided about — which is exactly what this test is for.
    const reads = new Set([
      "attention", "liveServers", "viewerFor", "linkStatus", "searchGamertags", "suggestGamertags",
      "baseFor", "clanFor", "directory", "clanByTag", "claimContext", "myInvites", "myRequests",
      "scoreboard", "alphas", "seasons", "warLog", "mapState", "playerBoards", "playerProfile",
      "achievementsFor", "clanBoard", "clanBoardPage", "boardPage", "playerFeed", "vaultFor",
      "makeRoster",
      "BOARD_KINDS", "BOARD_PAGE_SIZE", "DECLARE_SOLO_REASONS", "FEED_PAGE_SIZE",
      "ISSUE_OUTCOME_KINDS", "SUGGEST_SCOPES", "VAULT_NAME_MAX", "VAULT_NOTE_MAX",
    ]);
    const unaccounted = ROSTER_EXPORTS.filter((n) => !known.has(n) && !reads.has(n));
    expect(unaccounted, "new roster export with no command and no decision — add it to COMMANDS, PENDING, or reads").toEqual([]);
  });
});
```

- [ ] **Step 2: Run it**

Run:
```
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars && \
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
npx vitest run --root apps/bot test/parity.test.ts
```
Expected: PASS. If "accounts for every write" fails, the message names the export — put it in `COMMANDS`, `PENDING` or `reads` deliberately; never delete the assertion.

- [ ] **Step 3: Extend the vocabulary test**

In `apps/bot/test/vocabulary.test.ts`, add the command sources to `PLAYER_FACING`:

```ts
const PLAYER_FACING = [
  "feed-embed.ts", "ceremony-notify.ts", "dormancy-notify.ts", "notify.ts",
  // Increment 2c-b: the one reply every retired command gives.
  "retired-commands.ts",
  // Increment 3c: the clan_notices and war_log_events renderers.
  "notice-text.ts", "war-log-text.ts",
  // 2026-09-13: every slash command reply and embed.
  "commands/link.ts", "commands/base.ts", "commands/route.ts",
  "commands/embeds/link.ts", "commands/embeds/base.ts",
];
```

⚠️ `src(f)` resolves against `apps/bot/src`, so a nested path works as written. Plans 2 and 3 each append their own group files here — the list is deliberately explicit rather than a glob, so adding a player-facing file is a decision someone makes.

- [ ] **Step 4: Write the runbook**

Create `docs/deploy/2026-09-13-discord-commands.md`:

```markdown
# Deploy: Discord slash commands (plan 1 — link and base)

No migration. Nothing in this deploy touches `factions_live`'s schema.

## Order

1. Deploy `apps/web` (copy imports only — `apps/web/lib/*-copy.ts` now re-export
   `@factions/copy`). Independent of the bot; may go before or after.
2. Stop `clan-wars-bot`.
3. Deploy the bot image.
4. Start the bot. Registration is `Routes.applicationGuildCommands` at boot and
   replaces the whole command list in ONE PUT, so `/link` and `/base` appear and
   the `/link` retired stub disappears at the same instant.

## Acceptance

- `/link status` as an unlinked account: the card says to run `/link start`.
- `/link start` autocompletes on a gamertag the log has seen, and the reply shows
  the emote sequence.
- ⚠️ Confirm the reply is **ephemeral** — only you can see it. A public
  challenge sequence is a challenge anyone in the channel can perform.
- `/link cancel`, then `/link status`: no open challenge.
- `/base show` as a linked, clanless account.
- `/base declare` autocompletes only poles that account raised at.
- `/faction`, `/whoami`, `/unlink` still answer with the site pointer — they are
  removed in plan 3, not here.

## Rollback

Redeploy the previous bot image. Its `buildCommands()` PUT restores the old list,
including the `/link` stub. Nothing was written that the old bot cannot read.
```

- [ ] **Step 5: Correct CLAUDE.md**

Line 236 currently reads "Every Discord slash command is retired and answers with one line and a link". Replace that sentence with:

```
Since 2026-09-13 the slash commands are coming BACK, as a second front door onto
the same `@factions/roster` calls the site makes — spec
`docs/superpowers/specs/2026-09-13-discord-command-parity-design.md`. Plan 1
ships `/link` and `/base`; `apps/bot/test/parity.test.ts` lists every write and
which plan carries it. The remaining stubs in `retired-commands.ts` still answer
with one line and a link and are deleted only when parity is complete.
⚠️ Every command reply is ephemeral, always: `apps/bot/src/commands.ts` says why,
and `command-registration.test.ts` enforces it.
```

Also update line 174's "`/guest` is the one live slash command" — it is no longer the only one.

- [ ] **Step 6: Run the full gate**

Run:
```
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars && \
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
npx turbo run typecheck test --concurrency=1 --force
```
Expected: **28/28 tasks pass.** Check the count, not the exit code.

- [ ] **Step 7: Commit**

```bash
git add apps/bot/test/parity.test.ts apps/bot/test/vocabulary.test.ts \
        docs/deploy/2026-09-13-discord-commands.md CLAUDE.md
git commit -m "test(bot): standing parity guard, plus runbook and CLAUDE.md

parity.test.ts lists every roster write and where its command is: shipped,
pending in a named plan, or a read. A new roster export that is none of those
fails the suite, so parity cannot rot silently on the next increment."
```

---

## What plans 2 and 3 carry

Written after this plan is executed and reviewed, so they can be planned against real code rather than a sketch.

- **Plan 2 — clan life.** `/me`, `/clan`, `/roster`, `/clans`, `/found`, `/lead`, `/guest revoke`, and `/guest grant` moved onto `roster.grantGuestPass` (deleting `guest-command.ts` and its channel requirement). Introduces the three interaction kinds this plan does not touch: modals (`/found`), select menus (the flag pool), and confirm buttons (`disband`, `transfer`, `claim`, `vote`). 22 `PENDING` entries clear.
- **Plan 3 — vault, map, reads, and the last of the stubs.** `/vault` (modal code entry), `/map pin|unpin|pins`, and the read embeds `/player`, `/board`, `/scoreboard`, `/warlog`, `/seasons`, `/alphas`, `/achievements`. Ends by deleting `retired-commands.ts`, `RETIRED_COMMANDS` and `retired-commands.test.ts`, and replacing the `isMessageComponent` fallback in `discord.ts`. 8 `PENDING` entries clear and the map goes empty.
