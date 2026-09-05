# Roster Package (Increment 2c-a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every roster write lives in `packages/roster`, shared by the bot and the site; membership becomes pending-then-full with presence promotion and the cap; join requests, identity holds and the recruiting post exist; and the package exports the writes and reads the 2c-b pages will call — with no page built yet and the slash commands still working over the moved store.

**Architecture:** The bot's four roster stores (`roster-store`, `faction-store`, `rebind-store`, the feed helpers) move into `packages/roster/src/internal/`, reachable by the bot through a second package entry point `@factions/roster/internal` that the web app is forbidden to import. Migration 0022 adds `faction_members.status` (default `full`), `faction_join_requests`, `identity_holds` and the recruiting columns. Every "is a member" read gains `status = 'full'`; invites and accepted requests insert `pending`; a new bot consumer promotes a pending member on the first event that places them within 50 m of their clan's declaration, releasing their solo base in the same transaction; a reaper drops pending members nobody has seen for 7 days. The package's public surface grows by the roster writes and the reads the pages need, pinned on both sides as before.

**Tech Stack:** pnpm workspace + turbo; TypeScript raw-TS packages (extensionless relative imports in transpiled packages); drizzle-orm 0.36 over postgres.js; drizzle-kit for the migration; vitest with per-package test databases; the bot's `@factions/event-log` cursor consumers.

**Spec:** `docs/superpowers/specs/2026-09-04-clan-wars-target-state-design.md` — §4.3 (recruiting columns), §4.4 (`identity_holds`), §4.5 (membership, `faction_join_requests`), §4.12 (lock order), §5.1 (claim/reserve), §5.3 (membership machine, cap, presence, solo release at promotion), §5.5 (unlink refused with any roster row), §7 (presence tick, reapers), §9.1 (commands retired in 2c-b, not here), §10.4 (the capability package), §13 (staged race tests; "pending does not count as a member anywhere `isRosterMember` is used"; "join releases the solo declaration at promotion, not at accept"), §14 (pending members are on the table but not on the roster), §15 row 2c. Predecessor plans: `2026-09-05-site-foundation.md` (2a), `2026-09-05-site-link-and-base.md` (2b).

## Why 2c is two plans

| Plan | Ships | Player-visible change |
|---|---|---|
| **2c-a** (this file) `2026-09-05-roster-package.md` | Migration 0022; the stores in `packages/roster`; `status` pending/full everywhere; cap; presence promotion + pending expiry ticks; `identity_holds` written and consulted; join requests and the recruiting post in the store; the package's roster writes and reads exported and pinned | One: accepting an invite makes you **pending** until the log sees you at the base. The slash commands keep working over the moved store and say so |
| **2c-b** `2026-09-xx-site-roster.md` | `/clan`, `/clans`, `/clans/{tag}`, `/claim/{ceremony}`, `/clan/settings`; `/me` shows pending and invites; the slash commands retired in the same deploy (one line and a link); the `/faction` exclusion in `vocabulary.test.ts` removed with them; the bot's 1 h rebind window retired with the command | The site becomes the tool |

Spec §15's ⚠️ still holds: commands are retired only in the deploy that ships the pages, which is 2c-b. Nothing here removes a command.

**Deliberately not here:** Discord roles/channels at activation and on promotion (`discord_*_id` columns; increment 3 creates them), every `clan_notices` line (`joined`, `became_full`, `left`, `kicked`, `request_accepted`, `pending_expired` … — increment 3's queue), the `flag_down_*`/`dormant_reason`/`disband_warned_at`/`next_vote_allowed_at` columns (3, 7), succession and votes (7), the vault (7), guest passes (7), the `SUPPLIED_STATUSES` → predicate change (3). Where a write here would append a notice in the target state, its docblock says "notice: increment 3".

## Global Constraints

- **`apps/web` imports `@factions/roster` and never `@factions/db`, and never `@factions/roster/internal`** (spec §10.4; §5.4 "through `packages/roster`'s internal store, not through an export the web can reach"). The root export list is the permission list, pinned by name in `packages/roster/test/exports.test.ts` and `apps/web/test/smoke.test.ts`; `smoke.test.ts` also asserts no `/internal` import anywhere under `apps/web`.
- **Every rule lives inside the package's writes**: cap (`CLAN_SIZE_CAP = 10`, counting `full + pending`), one clan per player pending included, the officer/leader guards, cooldowns (`ROSTER_COOLDOWN_MS = 3 d`), rename cooldown (`RENAME_COOLDOWN_MS = 30 d`), the 200 m rule (via `declareTx`), name/tag uniqueness against holding clans **and** unexpired `identity_holds`. Pages (2c-b) and the bot's commands only format outcomes.
- **Membership reads mean `status = 'full'`** (spec §4.5, §14) — dormancy attribution, rebind qualifying raises, ceremony `isRosterMember`, activation, `viewerFor.clan`, `declareSoloTx`'s in-clan refusal, cap counts (both statuses). The two exceptions this document allows: unlink is refused with **any** roster row (§5.5), and `faction_members_server_player_uniq` covers both statuses.
- **A pending member keeps their solo base until promotion** (§5.3 ⚠️). The promotion transaction releases it: `lockDeclarations → releaseTx → faction_members` update, in that order.
- **Every number from `packages/domain/src/rules.ts`**: `CLAN_SIZE_CAP`, `JOIN_PRESENCE_RADIUS_M = 50`, `PENDING_EXPIRY_MS = 7 d` (also the invite and request lifetime — the guide's one row "Invite / request / pending no-show expiry: 7 days"), `ROSTER_COOLDOWN_MS`, `RENAME_COOLDOWN_MS`, `REBIND_COOLDOWN_MS`, `REBIND_CONFIRM_MS = 24 h`, `ACTIVATION_WINDOW_MS = 24 h` (the reservation's life), `CLAN_NAME_LENGTH`, `CLAN_TAG_LENGTH`, `MIN_BASE_SPACING_M`. No literal restates one.
- **Lock order (spec §4.12):** `factions → declarations → poles → faction_members → faction_invites → faction_join_requests → … → faction_events`. `identity_holds` is written right after `factions` (inside the same transaction as the status/name update, before anything else); it is insert-only-ish (upsert) and nothing references it, so no writer needs it locked first. Every new writer pair gets a staged race test (§13).
- **`faction_events` rows in the transition's own transaction** (`appendFactionEventTx`), payload frozen, no coordinates.
- **Player-facing strings say "clan", never "faction"** — the bot's `vocabulary.test.ts` list, and the web tests. New bot reply strings (pending, cap, holds) say clan.
- **`pos` is `{x, y: altitude, z}` once parsed** (`Vec3`); compare `x` with `x` and `z` with `z`. The ADM line's field order was already normalised by the parser; the presence tick must not re-swap.
- **Nothing applies migrations in production.** 0022 adds columns with defaults and two tables: metadata-only, safe with the bot running; the runbook (Task 9) says so.
- **Extensionless relative imports** in every package `apps/web` transpiles — now including `packages/roster/src/internal/**`.
- **The full gate**, from the worktree root, after every task: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force` — expect **26/26**. Ports 5432/5433 belong to other projects; `factions_live` is production.
- **Commit trailers** on every commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Svc2Dv7g1XwWi8CSuY4h5e
  ```

## File structure

**Moved (Task 2)** — `apps/bot/src/X.ts` → `packages/roster/src/internal/X.ts`: `roster-store`, `faction-store`, `rebind-store`, `rebind` (pure candidate selection), `feed-store`, `feed-actor`. Their bot tests stay in `apps/bot/test/` with imports repointed to `@factions/roster/internal`.

**Created**
- `packages/db/migrations/0022_roster_membership.sql` (+ journal, snapshot) (Task 1)
- `packages/roster/src/internal/index.ts` (Task 2), `packages/roster/src/internal/holds.ts` (Task 4), `packages/roster/src/internal/requests.ts` (Task 5)
- `apps/bot/src/presence-tick.ts`, `apps/bot/test/presence-tick.test.ts` (Task 6)
- `packages/roster/src/actor.ts`, `packages/roster/src/writes.ts`, `packages/roster/test/writes.test.ts` (Task 7)
- `packages/roster/src/reads.ts`, `packages/roster/test/reads.test.ts` (Task 8)
- `docs/deploy/2026-09-05-roster-package.md` (Task 9)

**Modified**
- `packages/db/src/schema.ts`; `packages/domain/src/factions.ts` (Task 1)
- `packages/roster/package.json` (`./internal` export), `apps/web/test/smoke.test.ts`, every bot importer (Task 2)
- `packages/roster/src/internal/roster-store.ts`, `faction-store.ts`, `rebind-store.ts`; `packages/roster/src/viewer.ts`; `packages/declarations/src/store.ts`; `apps/bot/src/{ceremony-store,dormancy-store,roster-commands,faction-commands}.ts` and their tests (Tasks 3–5)
- `apps/bot/src/discord.ts` (tick wiring, Task 6)
- `packages/roster/src/index.ts`, both export pins (Tasks 7, 8)
- `CLAUDE.md`, `apps/bot/README.md`, spec §15, `docs/superpowers/plans/PLAN-3-INBOX.md` (Task 9)

---

### Task 1: Migration 0022 — membership status, join requests, identity holds, recruiting columns

**Files:**
- Modify: `packages/db/src/schema.ts` (`factions`, `factionMembers`; two new tables after `rosterCooldowns`), `packages/domain/src/factions.ts`
- Create: `packages/db/migrations/0022_roster_membership.sql` (generated, renamed) + journal entry + snapshot
- Test: `packages/db/test/roster-membership-schema.test.ts`

**Interfaces:**
- Produces: schema exports `identityHolds`, `factionJoinRequests`; columns `factions.recruiting/playWindow/language/pitch`, `factionMembers.status/pendingSince/seenAtBaseEventId`; domain `MEMBER_STATUSES = ["pending", "full"] as const`, `type MemberStatus`.

- [ ] **Step 1: Schema**

In `packages/db/src/schema.ts`, add to `factions` after `reboundAt`:
```ts
  /**
   * The recruiting post (spec §4.3; guide ch. 8). `recruiting` turns on the
   * directory's "Request to join" and is the only gate `requestJoin` checks.
   */
  recruiting: boolean("recruiting").notNull().default(false),
  playWindow: text("play_window"),
  language: text("language"),
  pitch: text("pitch"),
```
Add to `factionMembers` after `joinedAt`:
```ts
  /**
   * `pending` from accept until the log sees the player within
   * JOIN_PRESENCE_RADIUS_M of the clan's declaration; `full` after (spec
   * §5.3). ⚠️ Every "is a member" read means `status = 'full'` (spec §4.5,
   * §14) — a pending member is on this table and NOT on the roster. The cap
   * counts both. Default `full` so every row that predates the column is a
   * member exactly as it was.
   */
  status: text("status").notNull().default("full"),
  /** Set at accept; the 7-day no-show clock runs from here. */
  pendingSince: timestamp("pending_since", { withTimezone: true }),
  /** The event that promoted them — evidence they stood at the base. */
  seenAtBaseEventId: bigint("seen_at_base_event_id", { mode: "number" }).references(() => events.id),
```
and to its constraints block:
```ts
  statusValid: check("faction_members_status_valid", sql`${t.status} IN ('pending','full')`),
```
After `rosterCooldowns`, add:
```ts
/**
 * Names and tags held until season end after a rename or a disband (spec
 * §4.4; guide ch. 8). The uniqueness check at claim and rename consults
 * holding factions AND rows here with `held_until > now()`.
 *
 * ⚠️ `held_until` is the sentinel `'infinity'` until the season closes; the
 * wipe script (spec §8.5) rewrites it to the season's `ended_at`. Compare it
 * in SQL, never in JS — postgres.js hands `infinity` back as an invalid Date.
 * ⚠️ A lapsed reservation writes no hold: nothing was ever flown under it.
 */
export const identityHolds = pgTable("identity_holds", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  kind: text("kind").notNull(),
  valueLower: text("value_lower").notNull(),
  factionId: bigint("faction_id", { mode: "number" }).notNull().references(() => factions.id),
  reason: text("reason").notNull(),
  heldUntil: timestamp("held_until", { withTimezone: true }).notNull(),
}, (t) => ({
  kindValid: check("identity_holds_kind_valid", sql`${t.kind} IN ('name','tag')`),
  reasonValid: check("identity_holds_reason_valid", sql`${t.reason} IN ('renamed','disbanded')`),
  // One live hold per value; a later hold on the same value upserts.
  uniqValue: uniqueIndex("identity_holds_uniq").on(t.serverId, t.kind, t.valueLower),
}));

/**
 * The second door onto a roster (spec §4.5; guide ch. 8): a linked player asks
 * a recruiting clan; an officer decides. Accepting inserts a PENDING member,
 * exactly like an invite.
 */
export const factionJoinRequests = pgTable("faction_join_requests", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  factionId: bigint("faction_id", { mode: "number" }).notNull().references(() => factions.id, { onDelete: "cascade" }),
  serverId: integer("server_id").notNull().references(() => servers.id),
  dayzId: text("dayz_id").notNull(),
  discordId: text("discord_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decidedByDiscordId: text("decided_by_discord_id"),
  decision: text("decision"),
}, (t) => ({
  decisionValid: check("faction_join_requests_decision_valid", sql`${t.decision} IS NULL OR ${t.decision} IN ('accepted','declined')`),
  decisionWithDecided: check("faction_join_requests_decision_requires_decided", sql`(${t.decision} IS NULL) = (${t.decidedAt} IS NULL)`),
  uniqOpen: uniqueIndex("faction_join_requests_open_uniq").on(t.factionId, t.dayzId).where(sql`${t.decidedAt} IS NULL`),
}));
```
In `packages/domain/src/factions.ts` add after `HOLDING_STATUSES`:
```ts
/** faction_members.status (spec §4.5). A pending member is on the table, not on the roster. */
export const MEMBER_STATUSES = ["pending", "full"] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];
```

- [ ] **Step 2: Generate and rename the migration**

```bash
cd packages/db && npx drizzle-kit generate
git mv migrations/0022_*.sql migrations/0022_roster_membership.sql
sed -i '' 's/"tag": "0022_[a-z_]*"/"tag": "0022_roster_membership"/' migrations/meta/_journal.json
cat migrations/0022_roster_membership.sql
```
Expected: `CREATE TABLE "faction_join_requests"` and `CREATE TABLE "identity_holds"` with their CHECKs; `ALTER TABLE "factions" ADD COLUMN` ×4 (`recruiting boolean DEFAULT false NOT NULL`, three nullable text); `ALTER TABLE "faction_members" ADD COLUMN` ×3 (`status text DEFAULT 'full' NOT NULL`, `pending_since`, `seen_at_base_event_id`); the `faction_members_status_valid` CHECK; the FKs; the two unique indexes. Nothing dropped, nothing else touched. If drizzle emits anything else, stop and reconcile before committing.

- [ ] **Step 3: Failing schema test**

`packages/db/test/roster-membership-schema.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, factions, factionMembers, identityHolds, type Database } from "../src/index";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-05T12:00:00Z");

describe("migration 0022", () => {
  let db: Database; let serverId = 0; let factionId = 0;
  beforeAll(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table identity_holds, faction_join_requests, faction_members, factions, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(factions).values({ serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", leaderDiscordId: "d1", createdAt: now }).returning();
    factionId = f!.id;
  });

  it("a member row defaults to full and refuses other statuses", async () => {
    const [m] = await db.insert(factionMembers).values({ factionId, serverId, dayzId: "A".repeat(40), discordId: "d1", role: "leader", joinedAt: now }).returning();
    expect(m!.status).toBe("full");
    await expect(db.insert(factionMembers).values({ factionId, serverId, dayzId: "B".repeat(40), discordId: "d2", role: "member", joinedAt: now, status: "maybe" }))
      .rejects.toThrow(/faction_members_status_valid/u);
  });

  it("a recruiting post defaults off", async () => {
    const [f] = await db.select({ recruiting: factions.recruiting, pitch: factions.pitch }).from(factions);
    expect(f).toEqual({ recruiting: false, pitch: null });
  });

  it("holds compare in SQL and can be infinite", async () => {
    await db.insert(identityHolds).values({ serverId, kind: "name", valueLower: "wolves", factionId, reason: "disbanded", heldUntil: sql`'infinity'::timestamptz` });
    const live = await db.execute(sql`select count(*)::int as n from identity_holds where held_until > now()`);
    expect((live as unknown as { n: number }[])[0]!.n).toBe(1);
    await expect(db.insert(identityHolds).values({ serverId, kind: "colour", valueLower: "x", factionId, reason: "disbanded", heldUntil: now }))
      .rejects.toThrow(/identity_holds_kind_valid/u);
  });

  it("a decision needs a decided_at and vice versa", async () => {
    await expect(db.execute(sql`insert into faction_join_requests (faction_id, server_id, dayz_id, discord_id, created_at, expires_at, decision)
      values (${factionId}, ${serverId}, 'C', 'd3', now(), now(), 'accepted')`)).rejects.toThrow(/decision_requires_decided/u);
  });
});
```

- [ ] **Step 4: Run, expect failure; then typecheck and run green**

```bash
cd packages/db && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/roster-membership-schema.test.ts
```
Before Step 1's edits the file cannot compile (no `identityHolds`); after them and the migration it passes. Then the full gate: 26/26 (drizzle's `$inferInsert` gains optional fields; nothing else changes yet).

- [ ] **Step 5: Commit**

```bash
git add packages/db packages/domain/src/factions.ts
git commit -m "feat(db): migration 0022 — member status pending/full, join requests, identity holds, recruiting post"
```

---

### Task 2: The stores move into `packages/roster/src/internal/`

**Files:**
- Move: `apps/bot/src/{roster-store,faction-store,rebind-store,rebind,feed-store,feed-actor}.ts` → `packages/roster/src/internal/`
- Create: `packages/roster/src/internal/index.ts`
- Modify: `packages/roster/package.json` (exports, deps), every importer in `apps/bot/src` and `apps/bot/test`, `apps/web/test/smoke.test.ts`, `CLAUDE.md` transpile sentence

**Interfaces:**
- Produces: `@factions/roster/internal` re-exporting everything the six files export (`PgRosterStore`, `RosterStore`, every `…Args`/`…Outcome` type, `Role`, `Membership`, `RosterEntry`, `FactionCard`, `leaderIs`, `disbandFactionTx`; `PgFactionStore`, `FactionStore`, `OpenCeremony`, `ReserveArgs`; `PgRebindStore`, `RebindStore`, `RebindTarget`, `RebindArgs`; `selectCandidates`, `cooldownRemainingMs`, `QualifyingRaise`, `REBIND_COOLDOWN_MS`, `RELEASE_GRACE_MS`, `REBIND_WINDOW_MS`; `appendFactionEventTx`, `PgFeedStore`, `FeedStore`, `FeedPayload`, `FactionEventInput`, `QueuedFactionEvent`, `countUnposted`; `actorGamertagTx`). The bot's public root import surface is unchanged.

- [ ] **Step 1: Move and make extensionless**

```bash
mkdir -p packages/roster/src/internal
for f in roster-store faction-store rebind-store rebind feed-store feed-actor; do git mv apps/bot/src/$f.ts packages/roster/src/internal/$f.ts; done
sed -i '' -E 's#from "\./([a-z-]+)\.js"#from "./\1"#g' packages/roster/src/internal/*.ts
grep -n '\.js"' packages/roster/src/internal/*.ts   # expect nothing
```
`rebind.ts` imports rules constants from `@factions/domain` — unchanged. `rebind-store.ts` imported `leaderIs` from `./roster-store.js` and `QualifyingRaise` from `./rebind.js` — both now siblings, extensionless.

`packages/roster/src/internal/index.ts`:
```ts
/**
 * @factions/roster/internal — the roster's store, for the BOT.
 *
 * Spec §5.4: writes that originate from a Discord gateway event, the log or
 * a clock (activation, lapse, dormancy disband, rebind proposals, the
 * guild-removal path in increment 7) go through this store, "not through an
 * export the web can reach". apps/web/test/smoke.test.ts forbids
 * `@factions/roster/internal` under apps/web; the root index.ts exposes only
 * the capability list. Both sides share one copy of every rule.
 */
export * from "./roster-store";
export * from "./faction-store";
export * from "./rebind-store";
export * from "./rebind";
export * from "./feed-store";
export * from "./feed-actor";
```

- [ ] **Step 2: Package plumbing**

`packages/roster/package.json`: `"exports": { ".": "./src/index.ts", "./internal": "./src/internal/index.ts" }`. Dependencies already include `@factions/db`, `@factions/domain`, `@factions/declarations`, `@factions/verification`, `drizzle-orm` — nothing to add. `apps/bot/package.json` gains `"@factions/roster": "workspace:*"`. `pnpm install`.

- [ ] **Step 3: Repoint the bot**

```bash
cd apps/bot
sed -i '' -E 's#from "\./(roster-store|faction-store|rebind-store|rebind|feed-store|feed-actor)\.js"#from "@factions/roster/internal"#g' src/*.ts
sed -i '' -E 's#from "\.\./src/(roster-store|faction-store|rebind-store|rebind|feed-store|feed-actor)\.js"#from "@factions/roster/internal"#g' test/*.ts
grep -rn 'roster-store\|faction-store\|rebind-store\|"\./rebind\.js"\|feed-store\|feed-actor' src test | grep import   # expect nothing
```
Where a file now has two or more `import … from "@factions/roster/internal"` lines, merge them into one (a `type`-only import may stay separate). `apps/bot/test/seed.ts` is unchanged.

- [ ] **Step 4: The web side forbids the internal entry**

In `apps/web/test/smoke.test.ts`, inside `describe("the web app reads nothing")`, add:
```ts
  it("⚠️ never imports the roster's internal store — that entry point is the bot's (spec §5.4)", () => {
    const offenders = sources.filter((s) => s.text.includes("@factions/roster/internal"));
    expect(offenders.map((o) => o.file)).toEqual([]);
  });
```
`transpiled-imports.test.ts` already walks `packages/roster/src` recursively, so `internal/` is scanned for `.js` specifiers.

- [ ] **Step 5: Docs line and gate**

`CLAUDE.md`, the transpile-convention paragraph: after "Today that is `roster`, `db`, `domain`, `declarations` and `verification`" add " — including `packages/roster/src/internal/`, the bot's entry point". Run the bot suite and the full gate: 26/26.

- [ ] **Step 6: Commit**

```bash
git add -A packages/roster apps/bot apps/web/test/smoke.test.ts pnpm-lock.yaml CLAUDE.md
git commit -m "refactor: the roster, faction, rebind and feed stores move into @factions/roster/internal, shared with the bot"
```

---

### Task 3: Membership status — pending on accept, full-only reads, the cap

**Files:**
- Modify: `packages/roster/src/internal/roster-store.ts`, `packages/roster/src/internal/faction-store.ts`, `packages/roster/src/internal/rebind-store.ts`, `packages/roster/src/viewer.ts`, `packages/declarations/src/store.ts` (`declareSoloTx`), `apps/bot/src/ceremony-store.ts` (`isRosterMember`), `apps/bot/src/dormancy-store.ts` (`LAST_RAISE`), `apps/bot/src/roster-commands.ts` (accept + cap replies)
- Test: `apps/bot/test/roster-invites.test.ts`, `apps/bot/test/dormancy-store.test.ts`, `apps/bot/test/rebind-store.test.ts`, `apps/bot/test/ceremony-store.test.ts`, `packages/roster/test/viewer.test.ts`, `packages/declarations/test/solo-declaration.test.ts`, `apps/bot/test/roster-commands.test.ts`

**Interfaces:**
- Produces: `Membership.status: MemberStatus`; `RosterEntry.status: MemberStatus`; `FactionCard.memberCount` (full) and `FactionCard.pendingCount`; `CreateInviteOutcome` and `AcceptInviteOutcome` gain `"cap"`; `Viewer` gains `pending: { id: number; name: string; tag: string } | null`; exported `const FULL_MEMBER = sql\`${factionMembers.status} = 'full'\`` from roster-store for other writers' subqueries.

- [ ] **Step 1: Failing tests**

`apps/bot/test/roster-invites.test.ts` — add beside the existing accept tests (reuse its fixture; it seeds a faction with `seedFaction` and links):
```ts
  it("accepting an invite makes a PENDING member with pending_since, not a full one", async () => {
    const { inviteId } = await createInviteFixture();   // whatever helper the file already uses to issue an invite to UID_B / "200"
    expect(await store.acceptInvite(inviteId!, "200", now)).toBe("ok");
    const [m] = await db.select({ status: factionMembers.status, pendingSince: factionMembers.pendingSince, seen: factionMembers.seenAtBaseEventId })
      .from(factionMembers).where(eq(factionMembers.dayzId, UID_B));
    expect(m).toEqual({ status: "pending", pendingSince: now, seen: null });
    expect((await store.rosterOf(factionId)).find((r) => r.dayzId === UID_B)?.status).toBe("pending");
  });

  it("the cap counts full and pending: the 11th is refused at invite and at accept", async () => {
    // seedFaction gives one leader; add 8 full + 1 pending = 10 on the table.
    for (let i = 0; i < 8; i++) await db.insert(factionMembers).values({ factionId, serverId, dayzId: `F${i}`.padEnd(40, "0"), discordId: `f${i}`, role: "member", joinedAt: now });
    await db.insert(factionMembers).values({ factionId, serverId, dayzId: "P".repeat(40), discordId: "p", role: "member", joinedAt: now, status: "pending", pendingSince: now });
    expect((await store.createInvite({ factionId, serverId, inviteeDiscordId: "200", inviteeDayzId: UID_B, invitedByDiscordId: LEADER, at: now, expiresAt: later })).outcome).toBe("cap");
    // An invite issued while there was room, accepted after the clan filled up, is refused at accept.
    await db.delete(factionMembers).where(eq(factionMembers.dayzId, "P".repeat(40)));
    const { inviteId } = await store.createInvite({ factionId, serverId, inviteeDiscordId: "200", inviteeDayzId: UID_B, invitedByDiscordId: LEADER, at: now, expiresAt: later });
    await db.insert(factionMembers).values({ factionId, serverId, dayzId: "P".repeat(40), discordId: "p", role: "member", joinedAt: now, status: "pending", pendingSince: now });
    expect(await store.acceptInvite(inviteId!, "200", now)).toBe("cap");
    expect(await db.select().from(factionMembers).where(eq(factionMembers.dayzId, UID_B))).toEqual([]);
  });
```
`apps/bot/test/dormancy-store.test.ts` — one test: a `flag.raised` by a PENDING member at the clan's pole with the clan's texture does not move `LAST_RAISE` (seed the member with `status: "pending"`; assert the clock row's `lastRaise` is null / unchanged). `apps/bot/test/rebind-store.test.ts` — one test: a pending member's raise at another pole is not a qualifying raise. `apps/bot/test/ceremony-store.test.ts` — `isRosterMember` is false for a pending member. `packages/roster/test/viewer.test.ts`:
```ts
  it("a pending member has pending set and clan null — not a clan-level viewer", async () => {
    const [f] = await db.insert(factions).values({ serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", leaderDiscordId: "d9", createdAt: now }).returning();
    await db.insert(identityLinks).values({ discordId: "d1", dayzId: "A".repeat(40), gamertag: "Steve", verifiedAt: now });
    await db.insert(factionMembers).values({ factionId: f!.id, serverId, dayzId: "A".repeat(40), discordId: "d1", role: "member", joinedAt: now, status: "pending", pendingSince: now });
    const v = await viewerForDb(db, "d1");
    expect(v.clan).toBeNull();
    expect(v.pending).toEqual({ id: f!.id, name: "Bears", tag: "BEAR" });
  });
```
`packages/declarations/test/solo-declaration.test.ts` — one test: a PENDING member may still declare a solo base (`declareSolo` → ok); the existing "in a clan" test seeds a full member and must still refuse.

- [ ] **Step 2: Run, expect failures** (`status`/`pending` unknown; outcomes not produced).

- [ ] **Step 3: The store**

`packages/roster/src/internal/roster-store.ts`:
- Import `CLAN_SIZE_CAP, type MemberStatus` from `@factions/domain`; export `const FULL_MEMBER = sql\`${factionMembers.status} = 'full'\`;` with a docblock quoting spec §4.5.
- `Membership` gains `status: MemberStatus`; `membershipsFor` selects `status: factionMembers.status` (any status — the bot's `/faction leave` and the site's pending banner both need to see a pending row).
- `RosterEntry` gains `status: MemberStatus`; `rosterOf` selects it and orders `ROLE_ORDER, status desc (full first), joinedAt`.
- `FactionCard`: `memberCount` becomes `count(*) filter (where status = 'full')`, add `pendingCount: count(*) filter (where status = 'pending')` — both via `sql<number>`; `Number()` both.
- `memberOf` is unchanged (any status; callers guard on role and the writes guard themselves).
- `createInvite`: after the cooldown check, `const [n] = await tx.select({ n: sql<number>\`count(*)::int\` }).from(factionMembers).where(eq(factionMembers.factionId, a.factionId)); if (n!.n >= CLAN_SIZE_CAP) return { outcome: "cap" as const, inviteId: null };` — advisory, like the others; the binding check is in accept.
- `acceptInvite`: after the `FOR SHARE` on the faction row and BEFORE the claim UPDATE, count members of `target.factionId` (both statuses) and `if (n >= CLAN_SIZE_CAP) return "cap" as const;` (nothing written yet — a bare return is safe; say so in a comment). The `INSERT … SELECT` gains `status, pending_since`: `'pending', ${at.toISOString()}::timestamptz`. Add `"cap"` to both outcome unions.
- `kick`/`leave`/`setRole`/`transfer`: `setRole` and `transfer` additionally require the TARGET to be full: add `eq(factionMembers.status, "full")` to their UPDATE WHEREs; on zero rows, if the target exists but is pending return `"target-not-member"` (a pending member is not on the roster). `kick` and `leave` remove pending rows too (a pending member may be kicked or may leave; both write the cooldown as before — the guide's "leave / kick cooldown" does not distinguish).

`faction-store.ts` `reserve`: the members insert gains `status: "full"` and a comment: "The ceremony's participants were standing at the base (spec §4.5 ⚠️); the ceremony row is their evidence, so `seen_at_base_event_id` stays null here."

`rebind-store.ts` `qualifyingRaises`: the `exists (select 1 from faction_members …)` gains `and ${factionMembers.status} = 'full'`.

`apps/bot/src/dormancy-store.ts` `LAST_RAISE`: `select m.dayz_id from faction_members m where m.faction_id = ${factions.id} and m.status = 'full'`. Run `apps/bot/test/dormancy-index-drift.test.ts` — the extra filter must not change the index the planner picks.

`apps/bot/src/ceremony-store.ts` `isRosterMember`: add `eq(factionMembers.status, "full")` and a docblock line: "Activation counts a FULL member's raise only (spec §5.1)."

`packages/declarations/src/store.ts` `declareSoloTx`: the `member` read gains `eq(factionMembers.status, "full")` and the comment becomes "Rule 3: in a clan, your declaration is the clan's — once you are IN it. A pending member keeps their solo base until promotion (spec §5.3); the presence tick releases it then."

`packages/roster/src/viewer.ts`: `Viewer` gains `pending: { id: number; name: string; tag: string } | null`. The `clan` query adds `eq(factionMembers.status, "full")`; a second query selects the pending row (status `pending`, holding statuses) → `pending`. Update the docblock's "⚠️ Increment 2c adds …" paragraph to the present tense.

`apps/bot/src/roster-commands.ts`: `handleInviteAccept`'s success reply becomes the existing text plus ` You are pending until the server log sees you at the clan's base — anything you do within ${JOIN_PRESENCE_RADIUS_M} m of the pole.` (import from `@factions/domain`); add a `"cap"` branch to both the invite and accept reply maps: `` `That clan is full — ${CLAN_SIZE_CAP} is the cap, pending members included.` ``. `apps/bot/test/roster-commands.test.ts`: assert the accept reply mentions "pending" and the cap reply prints the number.

- [ ] **Step 4: Run the touched suites, then the gate**

```bash
cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/roster-invites.test.ts test/roster-commands.test.ts test/dormancy-store.test.ts test/dormancy-index-drift.test.ts test/rebind-store.test.ts test/ceremony-store.test.ts test/activation.test.ts
cd ../../packages/roster && TEST_DATABASE_URL=… npx vitest run
cd ../declarations && TEST_DATABASE_URL=… npx vitest run
```
Full gate: 26/26.

- [ ] **Step 5: Commit**

```bash
git add packages apps/bot
git commit -m "feat(roster): members are pending until seen at the base; every membership read means full; the cap counts both"
```

---

### Task 4: Identity holds — written by disband and rename, consulted by claim and rename

**Files:**
- Create: `packages/roster/src/internal/holds.ts`
- Modify: `packages/roster/src/internal/roster-store.ts` (`disbandFactionTx`, `rename`, `RenameArgs`, `RenameOutcome`), `packages/roster/src/internal/faction-store.ts` (`reserve` outcomes), `packages/roster/src/internal/index.ts`, `apps/bot/src/roster-commands.ts` (`handleFactionRename` outcomes), `apps/bot/src/faction-commands.ts` (claim outcomes)
- Test: `apps/bot/test/roster-lifecycle.test.ts`, `apps/bot/test/faction-commands.test.ts` (or `feed-writers-claim.test.ts`, whichever exercises `reserve` directly)

**Interfaces:**
- Produces in `holds.ts`:
  ```ts
  export type HoldReason = "renamed" | "disbanded";
  export async function writeHoldsTx(tx: Tx, a: { serverId: number; factionId: number; name: string; tag: string; reason: HoldReason }): Promise<void>;
  /** "name" or "tag" if either is taken by a holding clan or an unexpired hold (excluding `exceptFactionId`'s own row); null if free. */
  export async function identityTakenTx(tx: Tx, a: { serverId: number; name: string; tag: string; exceptFactionId?: number }): Promise<"name-taken" | "tag-taken" | "name-held" | "tag-held" | null>;
  ```
  `RenameArgs` gains `tag?: string`; `RenameOutcome` = `"ok" | "not-leader" | "cooldown" | "name-taken" | "tag-taken" | "name-held" | "tag-held" | "unchanged"`; `reserve`'s outcome union gains `"name-taken" | "name-held" | "tag-held"`.

- [ ] **Step 1: Failing tests**

`apps/bot/test/roster-lifecycle.test.ts` (has disband and rename fixtures):
```ts
  it("disband holds the name and tag until season end; a new claim on either is refused", async () => {
    expect(await store.disband(factionId, LEADER)).toBe("ok");
    const holds = await db.execute(sql`select kind, value_lower, reason, held_until = 'infinity' as forever from identity_holds order by kind`);
    expect(holds).toEqual([
      { kind: "name", value_lower: "bears", reason: "disbanded", forever: true },
      { kind: "tag", value_lower: "bear", reason: "disbanded", forever: true },
    ]);
    // The same identity, sought by a fresh claim — the tag is the check that fires first.
    expect(await db.transaction((tx) => identityTakenTx(tx, { serverId, name: "Bears", tag: "BEAR" }))).toBe("name-held");
    expect(await db.transaction((tx) => identityTakenTx(tx, { serverId, name: "Wolves", tag: "bear" }))).toBe("tag-held");
    expect(await db.transaction((tx) => identityTakenTx(tx, { serverId, name: "Wolves", tag: "WOLF" }))).toBeNull();
  });

  it("rename holds the OLD name (and old tag when it changes) and refuses a held or taken identity", async () => {
    expect(await store.rename({ factionId, discordId: LEADER, name: "Grizzlies", tag: "GRIZ", at: now, notBefore: now })).toBe("ok");
    const holds = await db.execute(sql`select kind, value_lower, reason from identity_holds order by kind`);
    expect(holds).toEqual([{ kind: "name", value_lower: "bears", reason: "renamed" }, { kind: "tag", value_lower: "bear", reason: "renamed" }]);
    // Renaming back to the held name is refused — even for the clan that held it? No: exceptFactionId frees your own holds.
    await db.update(factions).set({ renamedAt: null }).where(eq(factions.id, factionId));
    expect(await store.rename({ factionId, discordId: LEADER, name: "Bears", at: now, notBefore: now })).toBe("ok");
  });

  it("rename refuses another holding clan's name or tag", async () => {
    await seedFaction(db, { serverId, tag: "WOLF", name: "Wolves", texture: "Flag_Wolf", createdAt: now, poleKey: "9000.00:100.00:9000.00", x: 9000, z: 9000 });
    expect(await store.rename({ factionId, discordId: LEADER, name: "wolves", at: now, notBefore: now })).toBe("name-taken");
    expect(await store.rename({ factionId, discordId: LEADER, name: "Bears2", tag: "wolf", at: now, notBefore: now })).toBe("tag-taken");
  });
```
In the `reserve` test file: after disbanding a clan named "Bears"/"BEAR", `reserve` with the same name → `"name-held"`; with a free name and tag "bear" → `"tag-held"`; with a name a holding clan uses → `"name-taken"`.

- [ ] **Step 2: Run, expect failure** (`identityTakenTx` missing; outcomes wrong).

- [ ] **Step 3: `holds.ts` and the writers**

`packages/roster/src/internal/holds.ts`:
```ts
import type { Tx } from "@factions/declarations";
import { factions, identityHolds } from "@factions/db";
import { HOLDING_STATUSES } from "@factions/domain";
import { and, eq, inArray, ne, sql } from "drizzle-orm";

export type HoldReason = "renamed" | "disbanded";

/**
 * Hold a clan's name and tag until season end (spec §4.4; guide ch. 8).
 *
 * `held_until` is `'infinity'` until the wipe script rewrites it to the
 * season's end (spec §8.5). Upsert: a value can be held again later by
 * another clan, and the newer hold wins. Written inside the transaction that
 * renames or disbands — right after the `factions` write, before anything
 * else (lock order §4.12: nothing references this table, so it needs no
 * place in the order beyond "after factions").
 */
export async function writeHoldsTx(tx: Tx, a: { serverId: number; factionId: number; name: string; tag: string; reason: HoldReason }): Promise<void> {
  const rows = [
    { serverId: a.serverId, kind: "name", valueLower: a.name.toLowerCase(), factionId: a.factionId, reason: a.reason, heldUntil: sql`'infinity'::timestamptz` },
    { serverId: a.serverId, kind: "tag", valueLower: a.tag.toLowerCase(), factionId: a.factionId, reason: a.reason, heldUntil: sql`'infinity'::timestamptz` },
  ];
  await tx.insert(identityHolds).values(rows).onConflictDoUpdate({
    target: [identityHolds.serverId, identityHolds.kind, identityHolds.valueLower],
    set: { factionId: sql`excluded.faction_id`, reason: sql`excluded.reason`, heldUntil: sql`excluded.held_until` },
  });
}

/**
 * Is this name or tag free on the server? Consults holding clans AND
 * unexpired holds (spec §4.4), case-insensitively. `exceptFactionId` lets a
 * clan keep or reclaim its own identity (a rename back to a name it held).
 *
 * ⚠️ Advisory for the tag: `factions_holding_tag_uniq` is the binding check
 * and the caller still maps its violation. Binding for the name and for
 * holds, which have no index of their own — which is why callers run this
 * INSIDE the writing transaction, after taking whatever row lock they take.
 */
export async function identityTakenTx(tx: Tx, a: { serverId: number; name: string; tag: string; exceptFactionId?: number }):
  Promise<"name-taken" | "tag-taken" | "name-held" | "tag-held" | null> {
  const others = a.exceptFactionId === undefined ? sql`true` : ne(factions.id, a.exceptFactionId);
  const [clan] = await tx.select({
    name: sql<boolean>`bool_or(lower(${factions.name}) = ${a.name.toLowerCase()})`,
    tag: sql<boolean>`bool_or(lower(${factions.tag}) = ${a.tag.toLowerCase()})`,
  }).from(factions).where(and(eq(factions.serverId, a.serverId), inArray(factions.status, [...HOLDING_STATUSES]), others));
  if (clan?.name) return "name-taken";
  if (clan?.tag) return "tag-taken";
  const heldBy = a.exceptFactionId === undefined ? sql`true` : ne(identityHolds.factionId, a.exceptFactionId);
  const [hold] = await tx.select({
    name: sql<boolean>`bool_or(${identityHolds.kind} = 'name' and ${identityHolds.valueLower} = ${a.name.toLowerCase()})`,
    tag: sql<boolean>`bool_or(${identityHolds.kind} = 'tag' and ${identityHolds.valueLower} = ${a.tag.toLowerCase()})`,
  }).from(identityHolds).where(and(eq(identityHolds.serverId, a.serverId), sql`${identityHolds.heldUntil} > now()`, heldBy));
  if (hold?.name) return "name-held";
  if (hold?.tag) return "tag-held";
  return null;
}
```
Export it from `internal/index.ts`.

`roster-store.ts`:
- `disbandFactionTx`: immediately after the `factions` update returns `updated`, `await writeHoldsTx(tx, { serverId: updated.serverId, factionId: updated.id, name: updated.name, tag: updated.tag, reason: "disbanded" });` and extend the docblock ("holds first, then the release, then the roster delete").
- `RenameArgs` gains `tag?: string`; `RenameOutcome` as above. `rename`:
  ```ts
    const outcome = await this.db.transaction(async (tx) => {
      const [before] = await tx.select({ name: factions.name, tag: factions.tag, serverId: factions.serverId })
        .from(factions).where(eq(factions.id, a.factionId)).for("update");
      if (!before) return "not-leader" as const;
      const newTag = a.tag ?? before.tag;
      if (before.name === a.name && before.tag === newTag) return "unchanged" as const;
      const taken = await identityTakenTx(tx, { serverId: before.serverId, name: a.name, tag: newTag, exceptFactionId: a.factionId });
      if (taken) return taken;
      const [updated] = await tx.update(factions)
        .set({ name: a.name, tag: newTag, renamedAt: a.at })
        .where(and(eq(factions.id, a.factionId), leaderIs(a.factionId, a.discordId), inArray(factions.status, HOLDING),
          or(isNull(factions.renamedAt), lte(factions.renamedAt, a.notBefore))))
        .returning({ id: factions.id, serverId: factions.serverId, tag: factions.tag, texture: factions.texture });
      if (!updated) return null;
      // Hold what was given up (guide ch. 8: "so nobody can impersonate you").
      await writeHoldsTx(tx, { serverId: updated.serverId, factionId: updated.id, name: before.name, tag: before.tag, reason: "renamed" });
      await appendFactionEventTx(tx, { … payload: { name: a.name, previousName: before.name, tag: updated.tag, texture: updated.texture, actor: … } });
      return "ok" as const;
    });
    if (outcome) return outcome;
    … (the existing not-leader / cooldown disambiguation)
  ```
  The `FOR UPDATE` on the faction row is new: it is what makes the `identityTakenTx` read and the UPDATE one unit against a concurrent rename to the same name by another clan (both serialise on… no — two DIFFERENT clans' rows). Add a staged race test in `roster-races.test.ts`: two clans renaming to the same free name concurrently — exactly one succeeds, the other gets `"name-taken"`. Since two rows cannot serialise on a row lock, take `pg_advisory_xact_lock(hashtext('identity'), serverId)` at the top of `rename` and `reserve`, in a helper `lockIdentity(tx, serverId)` in `holds.ts`, exported; document it as the identity namespace's lock (spec §4.4's uniqueness has no index for names). Lock order: taken after the `factions` row lock in rename and after the `factions` insert in reserve — i.e. it sits with `factions` at the head of the order; nothing takes it after a later table.
  Note the tag is also protected by `factions_holding_tag_uniq`; keep the existing catch → `"tag-taken"`.

`faction-store.ts` `reserve`: after the ceremony claim and BEFORE the `factions` insert, `await lockIdentity(tx, a.serverId); const taken = await identityTakenTx(tx, { serverId: a.serverId, name: a.name, tag: a.tag }); if (taken) throw new ReserveAbort(taken);` — widen `ReserveAbort`'s outcome union and the method's return union with `"name-taken" | "name-held" | "tag-held"`.

Bot replies: `handleFactionRename` maps `name-taken` → "Another clan already uses that name.", `tag-taken` → "Another clan already uses that tag.", `name-held`/`tag-held` → "That name/tag was given up this season and is held until the season ends.", `unchanged` → "That is already your name and tag."; `handleFactionClaim`/confirm map the three new reserve outcomes with the same words. The `/faction rename` command has no tag option today and gets none (2c-b retires it); `tag` is for the site.

- [ ] **Step 4: Run and gate**

```bash
cd apps/bot && TEST_DATABASE_URL=… npx vitest run test/roster-lifecycle.test.ts test/roster-races.test.ts test/faction-commands.test.ts test/feed-writers-claim.test.ts test/roster-commands.test.ts test/dormancy-store.test.ts
```
Full gate: 26/26.

- [ ] **Step 5: Commit**

```bash
git add packages/roster apps/bot
git commit -m "feat(roster): identity holds — disband and rename hold the old name and tag; claim and rename refuse held or taken identities"
```

---

### Task 5: Join requests, invite revocation and the recruiting post

**Files:**
- Create: `packages/roster/src/internal/requests.ts`
- Modify: `packages/roster/src/internal/roster-store.ts` (`revokeInvite`, `invitesOut`, `setRecruitingPost`), `packages/roster/src/internal/index.ts`
- Test: `apps/bot/test/roster-requests.test.ts` (new)

**Interfaces:**
- Produces in `requests.ts` (functions over `Database`, the same style as `packages/declarations`):
  ```ts
  export type JoinRequest = { id: number; factionId: number; serverId: number; dayzId: string; discordId: string; gamertag: string | null; createdAt: Date; expiresAt: Date };
  export type RequestJoinOutcome = "ok" | "not-recruiting" | "not-holding" | "already-member" | "cooldown" | "cap" | "already-requested";
  export type DecideRequestOutcome = "ok" | "not-permitted" | "gone" | "cap" | "cooldown" | "link-changed" | "not-recruiting";
  export function requestJoinDb(db: Database, a: { factionId: number; serverId: number; dayzId: string; discordId: string; at: Date; expiresAt: Date }): Promise<{ outcome: RequestJoinOutcome; requestId: number | null }>;
  export function openRequestsFor(db: Database, factionId: number, at: Date): Promise<JoinRequest[]>;   // officer's inbox, oldest first, unexpired
  export function requestsBy(db: Database, dayzId: string, at: Date): Promise<(JoinRequest & { factionName: string; tag: string })[]>;  // the requester's own open requests
  export function decideRequestDb(db: Database, a: { requestId: number; actorDiscordId: string; decision: "accepted" | "declined"; at: Date }): Promise<DecideRequestOutcome>;
  export function withdrawRequestDb(db: Database, requestId: number, discordId: string, at: Date): Promise<boolean>;
  ```
  On `RosterStore`: `revokeInvite(a: { inviteId: number; factionId: number; actorDiscordId: string; at: Date }): Promise<"ok" | "not-permitted" | "gone">`; `invitesOut(factionId: number, at: Date): Promise<(PendingInvite & { inviteeDiscordId: string; inviteeGamertag: string | null })[]>`; `setRecruitingPost(a: { factionId: number; actorDiscordId: string; recruiting: boolean; playWindow: string | null; language: string | null; pitch: string | null }): Promise<"ok" | "not-permitted">`.

- [ ] **Step 1: Failing tests**

`apps/bot/test/roster-requests.test.ts` — same fixture shape as `roster-invites.test.ts` (copy its `beforeEach`, `seedFaction`, link seeding; truncate adds `faction_join_requests`). Constants: `LEADER = "d1"`, `OFFICER`, `UID_B`/`"200"` a linked outsider.
```ts
  it("a request needs a recruiting clan; accepting makes a pending member and closes the request", async () => {
    expect((await requestJoinDb(db, { factionId, serverId, dayzId: UID_B, discordId: "200", at: now, expiresAt: later })).outcome).toBe("not-recruiting");
    expect(await store.setRecruitingPost({ factionId, actorDiscordId: LEADER, recruiting: true, playWindow: "EU evenings", language: "en", pitch: "Casual, no drama" })).toBe("ok");
    const { outcome, requestId } = await requestJoinDb(db, { factionId, serverId, dayzId: UID_B, discordId: "200", at: now, expiresAt: later });
    expect(outcome).toBe("ok");
    expect((await openRequestsFor(db, factionId, now)).map((r) => r.dayzId)).toEqual([UID_B]);
    expect((await requestsBy(db, UID_B, now))[0]).toMatchObject({ factionName: "Bears", tag: "BEAR" });
    expect(await decideRequestDb(db, { requestId: requestId!, actorDiscordId: LEADER, decision: "accepted", at: now })).toBe("ok");
    const [m] = await db.select({ status: factionMembers.status }).from(factionMembers).where(eq(factionMembers.dayzId, UID_B));
    expect(m).toEqual({ status: "pending" });
    expect(await openRequestsFor(db, factionId, now)).toEqual([]);
    const [req] = await db.select().from(factionJoinRequests).where(eq(factionJoinRequests.id, requestId!));
    expect(req).toMatchObject({ decision: "accepted", decidedByDiscordId: LEADER });
  });

  it("refusals: second open request, member acting, non-recruiting at decide time, declined leaves no member", async () => {
    await store.setRecruitingPost({ factionId, actorDiscordId: LEADER, recruiting: true, playWindow: null, language: null, pitch: null });
    const first = await requestJoinDb(db, { factionId, serverId, dayzId: UID_B, discordId: "200", at: now, expiresAt: later });
    expect((await requestJoinDb(db, { factionId, serverId, dayzId: UID_B, discordId: "200", at: now, expiresAt: later })).outcome).toBe("already-requested");
    expect(await decideRequestDb(db, { requestId: first.requestId!, actorDiscordId: "nobody", decision: "accepted", at: now })).toBe("not-permitted");
    await store.setRecruitingPost({ factionId, actorDiscordId: LEADER, recruiting: false, playWindow: null, language: null, pitch: null });
    expect(await decideRequestDb(db, { requestId: first.requestId!, actorDiscordId: LEADER, decision: "accepted", at: now })).toBe("not-recruiting");
    await store.setRecruitingPost({ factionId, actorDiscordId: LEADER, recruiting: true, playWindow: null, language: null, pitch: null });
    expect(await decideRequestDb(db, { requestId: first.requestId!, actorDiscordId: LEADER, decision: "declined", at: now })).toBe("ok");
    expect(await db.select().from(factionMembers).where(eq(factionMembers.dayzId, UID_B))).toEqual([]);
    expect(await decideRequestDb(db, { requestId: first.requestId!, actorDiscordId: LEADER, decision: "accepted", at: now })).toBe("gone");
  });

  it("the cap refuses at request and at accept; an expired request is not offered", async () => {
    await store.setRecruitingPost({ factionId, actorDiscordId: LEADER, recruiting: true, playWindow: null, language: null, pitch: null });
    for (let i = 0; i < 9; i++) await db.insert(factionMembers).values({ factionId, serverId, dayzId: `F${i}`.padEnd(40, "0"), discordId: `f${i}`, role: "member", joinedAt: now });
    expect((await requestJoinDb(db, { factionId, serverId, dayzId: UID_B, discordId: "200", at: now, expiresAt: later })).outcome).toBe("cap");
    await db.delete(factionMembers).where(eq(factionMembers.dayzId, "F8".padEnd(40, "0")));
    const { requestId } = await requestJoinDb(db, { factionId, serverId, dayzId: UID_B, discordId: "200", at: now, expiresAt: later });
    await db.insert(factionMembers).values({ factionId, serverId, dayzId: "F8".padEnd(40, "0"), discordId: "f8", role: "member", joinedAt: now });
    expect(await decideRequestDb(db, { requestId: requestId!, actorDiscordId: LEADER, decision: "accepted", at: now })).toBe("cap");
    expect(await openRequestsFor(db, factionId, new Date(later.getTime() + 1))).toEqual([]);
  });

  it("an officer revokes an outstanding invite; a member cannot; invitesOut lists the rest", async () => {
    const a = await store.createInvite({ factionId, serverId, inviteeDiscordId: "200", inviteeDayzId: UID_B, invitedByDiscordId: LEADER, at: now, expiresAt: later });
    expect((await store.invitesOut(factionId, now)).map((i) => i.inviteeDiscordId)).toEqual(["200"]);
    expect(await store.revokeInvite({ inviteId: a.inviteId!, factionId, actorDiscordId: "f0", at: now })).toBe("not-permitted");
    expect(await store.revokeInvite({ inviteId: a.inviteId!, factionId, actorDiscordId: LEADER, at: now })).toBe("ok");
    expect(await store.invitesOut(factionId, now)).toEqual([]);
    expect(await store.revokeInvite({ inviteId: a.inviteId!, factionId, actorDiscordId: LEADER, at: now })).toBe("gone");
  });

  it("only leader or officer sets the recruiting post", async () => {
    await db.insert(factionMembers).values({ factionId, serverId, dayzId: "M".repeat(40), discordId: "m", role: "member", joinedAt: now });
    expect(await store.setRecruitingPost({ factionId, actorDiscordId: "m", recruiting: true, playWindow: null, language: null, pitch: null })).toBe("not-permitted");
  });
```
(`f0` in the revoke test must exist as a `member` row; seed it in that test.)

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement**

`packages/roster/src/internal/requests.ts`:
```ts
import type { Database } from "@factions/db";
import { factions, factionJoinRequests, factionMembers, identityLinks, players, rosterCooldowns } from "@factions/db";
import { CLAN_SIZE_CAP, HOLDING_STATUSES } from "@factions/domain";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";

const HOLDING: string[] = [...HOLDING_STATUSES];

export type JoinRequest = { id: number; factionId: number; serverId: number; dayzId: string; discordId: string; gamertag: string | null; createdAt: Date; expiresAt: Date };
export type RequestJoinOutcome = "ok" | "not-recruiting" | "not-holding" | "already-member" | "cooldown" | "cap" | "already-requested";
export type DecideRequestOutcome = "ok" | "not-permitted" | "gone" | "cap" | "cooldown" | "link-changed" | "not-recruiting";

/** Unwinds a decide transaction carrying an outcome — see roster-store's RosterAbort for why a bare return would commit the claim. */
class RequestAbort extends Error { constructor(readonly outcome: DecideRequestOutcome) { super(outcome); } }

const memberCount = (factionId: number) => sql<number>`(select count(*)::int from faction_members where faction_id = ${factionId})`;

/**
 * Ask to join a recruiting clan (spec §4.5, §5.3). The checks here are
 * advisory, as in `createInvite`; `decideRequestDb` re-checks everything
 * at write time. `faction_join_requests_open_uniq` is the binding "one open
 * request per player per clan".
 */
export async function requestJoinDb(db: Database, a: { factionId: number; serverId: number; dayzId: string; discordId: string; at: Date; expiresAt: Date }):
  Promise<{ outcome: RequestJoinOutcome; requestId: number | null }> {
  return db.transaction(async (tx) => {
    const [f] = await tx.select({ recruiting: factions.recruiting, n: memberCount(a.factionId) }).from(factions)
      .where(and(eq(factions.id, a.factionId), inArray(factions.status, HOLDING)));
    if (!f) return { outcome: "not-holding" as const, requestId: null };
    if (!f.recruiting) return { outcome: "not-recruiting" as const, requestId: null };
    const [existing] = await tx.select({ id: factionMembers.id }).from(factionMembers)
      .where(and(eq(factionMembers.serverId, a.serverId), eq(factionMembers.dayzId, a.dayzId)));
    if (existing) return { outcome: "already-member" as const, requestId: null };
    const [cd] = await tx.select({ until: rosterCooldowns.until }).from(rosterCooldowns)
      .where(and(eq(rosterCooldowns.serverId, a.serverId), eq(rosterCooldowns.dayzId, a.dayzId)));
    if (cd && cd.until > a.at) return { outcome: "cooldown" as const, requestId: null };
    if (f.n >= CLAN_SIZE_CAP) return { outcome: "cap" as const, requestId: null };
    const [row] = await tx.insert(factionJoinRequests)
      .values({ factionId: a.factionId, serverId: a.serverId, dayzId: a.dayzId, discordId: a.discordId, createdAt: a.at, expiresAt: a.expiresAt })
      .onConflictDoNothing().returning({ id: factionJoinRequests.id });
    return row ? { outcome: "ok" as const, requestId: row.id } : { outcome: "already-requested" as const, requestId: null };
  });
}

const openWhere = (at: Date) => and(isNull(factionJoinRequests.decidedAt), gt(factionJoinRequests.expiresAt, at));

export async function openRequestsFor(db: Database, factionId: number, at: Date): Promise<JoinRequest[]> {
  return db.select({
    id: factionJoinRequests.id, factionId: factionJoinRequests.factionId, serverId: factionJoinRequests.serverId,
    dayzId: factionJoinRequests.dayzId, discordId: factionJoinRequests.discordId, gamertag: players.gamertag,
    createdAt: factionJoinRequests.createdAt, expiresAt: factionJoinRequests.expiresAt,
  }).from(factionJoinRequests)
    .leftJoin(players, eq(players.dayzId, factionJoinRequests.dayzId))
    .where(and(eq(factionJoinRequests.factionId, factionId), openWhere(at)))
    .orderBy(asc(factionJoinRequests.createdAt));
}

export async function requestsBy(db: Database, dayzId: string, at: Date) {
  return db.select({
    id: factionJoinRequests.id, factionId: factionJoinRequests.factionId, serverId: factionJoinRequests.serverId,
    dayzId: factionJoinRequests.dayzId, discordId: factionJoinRequests.discordId, gamertag: players.gamertag,
    createdAt: factionJoinRequests.createdAt, expiresAt: factionJoinRequests.expiresAt,
    factionName: factions.name, tag: factions.tag,
  }).from(factionJoinRequests)
    .innerJoin(factions, eq(factions.id, factionJoinRequests.factionId))
    .leftJoin(players, eq(players.dayzId, factionJoinRequests.dayzId))
    .where(and(eq(factionJoinRequests.dayzId, dayzId), openWhere(at), inArray(factions.status, HOLDING)))
    .orderBy(asc(factionJoinRequests.createdAt));
}

/**
 * An officer decides. Accepting is `acceptInvite`'s write with a different
 * door: FOR SHARE on the faction row first (lock order: factions before the
 * request row; the same deadlock reasoning as acceptInvite), recruiting and
 * cap re-checked under it, the request claimed with the actor's role in the
 * UPDATE's WHERE, then the pending member inserted from the requester's
 * CURRENT link. Every post-claim refusal throws so the claim rolls back.
 * Notice (`request_accepted` / `request_declined` DM): increment 3.
 */
export async function decideRequestDb(db: Database, a: { requestId: number; actorDiscordId: string; decision: "accepted" | "declined"; at: Date }): Promise<DecideRequestOutcome> {
  try {
    return await db.transaction(async (tx) => {
      const [target] = await tx.select({ factionId: factionJoinRequests.factionId }).from(factionJoinRequests).where(eq(factionJoinRequests.id, a.requestId));
      if (!target) return "gone" as const;
      const [f] = await tx.select({ recruiting: factions.recruiting, n: memberCount(target.factionId) }).from(factions)
        .where(and(eq(factions.id, target.factionId), inArray(factions.status, HOLDING))).for("share");
      if (!f) return "gone" as const;
      if (a.decision === "accepted" && !f.recruiting) return "not-recruiting" as const;
      if (a.decision === "accepted" && f.n >= CLAN_SIZE_CAP) return "cap" as const;
      const actorRole = sql`(select role from faction_members where faction_id = ${target.factionId} and discord_id = ${a.actorDiscordId} and status = 'full')`;
      const [req] = await tx.update(factionJoinRequests)
        .set({ decidedAt: a.at, decidedByDiscordId: a.actorDiscordId, decision: a.decision })
        .where(and(eq(factionJoinRequests.id, a.requestId), isNull(factionJoinRequests.decidedAt), gt(factionJoinRequests.expiresAt, a.at), sql`${actorRole} in ('leader','officer')`))
        .returning();
      if (!req) {
        const [actor] = await tx.select({ role: factionMembers.role }).from(factionMembers)
          .where(and(eq(factionMembers.factionId, target.factionId), eq(factionMembers.discordId, a.actorDiscordId), eq(factionMembers.status, "full")));
        return actor && actor.role !== "member" ? ("gone" as const) : ("not-permitted" as const);
      }
      if (a.decision === "declined") return "ok" as const;
      const [cd] = await tx.select({ until: rosterCooldowns.until }).from(rosterCooldowns)
        .where(and(eq(rosterCooldowns.serverId, req.serverId), eq(rosterCooldowns.dayzId, req.dayzId)));
      if (cd && cd.until > a.at) throw new RequestAbort("cooldown");
      const inserted = await tx.execute(sql`
        insert into faction_members (faction_id, server_id, dayz_id, discord_id, role, joined_at, status, pending_since)
        select ${req.factionId}::bigint, ${req.serverId}::integer, il.dayz_id, ${req.discordId}::text, 'member',
               ${a.at.toISOString()}::timestamptz, 'pending', ${a.at.toISOString()}::timestamptz
        from identity_links il where il.discord_id = ${req.discordId} and il.dayz_id = ${req.dayzId}
        returning id`);
      if ((inserted as unknown as unknown[]).length === 0) throw new RequestAbort("link-changed");
      return "ok" as const;
    });
  } catch (err) {
    if (err instanceof RequestAbort) return err.outcome;
    if (String(err).includes("faction_members_server_player_uniq")) return "gone";
    throw err;
  }
}

/** The requester changes their mind. No expiry gate, like declineInvite. */
export async function withdrawRequestDb(db: Database, requestId: number, discordId: string, at: Date): Promise<boolean> {
  const rows = await db.update(factionJoinRequests).set({ decidedAt: at, decidedByDiscordId: discordId, decision: "declined" })
    .where(and(eq(factionJoinRequests.id, requestId), eq(factionJoinRequests.discordId, discordId), isNull(factionJoinRequests.decidedAt)))
    .returning({ id: factionJoinRequests.id });
  return rows.length > 0;
}
```
`roster-store.ts` — three methods on the interface and class:
```ts
  /** Officer+ withdraws an outstanding offer. The role check rides in the UPDATE's WHERE. */
  async revokeInvite(a: { inviteId: number; factionId: number; actorDiscordId: string; at: Date }): Promise<"ok" | "not-permitted" | "gone"> {
    const actorRole = sql`(select role from faction_members where faction_id = ${a.factionId} and discord_id = ${a.actorDiscordId} and status = 'full')`;
    const rows = await this.db.update(factionInvites).set({ revokedAt: a.at })
      .where(and(eq(factionInvites.id, a.inviteId), eq(factionInvites.factionId, a.factionId),
        isNull(factionInvites.acceptedAt), isNull(factionInvites.declinedAt), isNull(factionInvites.revokedAt),
        sql`${actorRole} in ('leader','officer')`))
      .returning({ id: factionInvites.id });
    if (rows.length > 0) return "ok";
    const [actor] = await this.db.select({ role: factionMembers.role }).from(factionMembers)
      .where(and(eq(factionMembers.factionId, a.factionId), eq(factionMembers.discordId, a.actorDiscordId), eq(factionMembers.status, "full")));
    return actor && actor.role !== "member" ? "gone" : "not-permitted";
  }

  /** Open, unexpired invites this clan has out — the officer's view. */
  async invitesOut(factionId: number, at: Date) {
    return this.db.select({
      id: factionInvites.id, factionId: factionInvites.factionId, factionName: factions.name, tag: factions.tag,
      serverId: factionInvites.serverId, serverName: servers.name, expiresAt: factionInvites.expiresAt,
      inviteeDiscordId: factionInvites.inviteeDiscordId, inviteeGamertag: players.gamertag,
    }).from(factionInvites)
      .innerJoin(factions, eq(factions.id, factionInvites.factionId))
      .innerJoin(servers, eq(servers.id, factionInvites.serverId))
      .leftJoin(players, eq(players.dayzId, factionInvites.inviteeDayzId))
      .where(and(eq(factionInvites.factionId, factionId), isNull(factionInvites.acceptedAt), isNull(factionInvites.declinedAt), isNull(factionInvites.revokedAt), gt(factionInvites.expiresAt, at)))
      .orderBy(asc(factionInvites.expiresAt));
  }

  /** Officer+ edits the recruiting post (guide ch. 8). One guarded UPDATE. */
  async setRecruitingPost(a: { factionId: number; actorDiscordId: string; recruiting: boolean; playWindow: string | null; language: string | null; pitch: string | null }): Promise<"ok" | "not-permitted"> {
    const actorRole = sql`(select role from faction_members where faction_id = ${a.factionId} and discord_id = ${a.actorDiscordId} and status = 'full')`;
    const rows = await this.db.update(factions)
      .set({ recruiting: a.recruiting, playWindow: a.playWindow, language: a.language, pitch: a.pitch })
      .where(and(eq(factions.id, a.factionId), inArray(factions.status, HOLDING), sql`${actorRole} in ('leader','officer')`))
      .returning({ id: factions.id });
    return rows.length > 0 ? "ok" : "not-permitted";
  }
```
Import `players` into roster-store. Export `requests.ts` from `internal/index.ts`.

- [ ] **Step 4: Run and gate**

```bash
cd apps/bot && TEST_DATABASE_URL=… npx vitest run test/roster-requests.test.ts test/roster-invites.test.ts
```
Full gate 26/26.

- [ ] **Step 5: Commit**

```bash
git add packages/roster apps/bot/test/roster-requests.test.ts
git commit -m "feat(roster): join requests, invite revocation and the recruiting post"
```

---

### Task 6: Presence promotion and pending expiry — two bot ticks

**Files:**
- Create: `apps/bot/src/presence-tick.ts`, `apps/bot/test/presence-tick.test.ts`
- Modify: `apps/bot/src/discord.ts` (runner wiring), `apps/bot/README.md` (one paragraph under Running)

**Interfaces:**
- Produces:
  ```ts
  export const PRESENCE_CONSUMER = "presence-promoter";
  export type PresenceResult = { scanned: number; promoted: { factionId: number; dayzId: string; eventId: number; releasedSoloBase: boolean }[] };
  export function presenceTick(db: Database, opts?: { batchSize?: number }): Promise<PresenceResult>;
  export function expirePendingMembers(db: Database, now: Date): Promise<{ factionId: number; dayzId: string; discordId: string }[]>;
  ```

- [ ] **Step 1: Failing tests**

`apps/bot/test/presence-tick.test.ts` — fixture like `solo-declaration.test.ts` (server, admFile, pole at P = 5000/5000, a faction seeded with `seedFaction` at pole P with its declaration; a pending member `UID_B`/"200" with `pendingSince: now`):
```ts
  const position = (dayzId: string, x: number, z: number, at = now) => db.insert(events).values({
    serverId, admFileId, lineIndex: line++, type: "player.position", occurredAt: at,
    payload: { dayzId, gamertag: "G", pos: { x, y: 100, z } },
  }).returning({ id: events.id });

  it("promotes a pending member seen within JOIN_PRESENCE_RADIUS_M of the declaration, citing the event", async () => {
    await position(UID_B, 5000 + JOIN_PRESENCE_RADIUS_M - 1, 5000);
    const r = await presenceTick(db);
    expect(r.promoted).toHaveLength(1);
    const [m] = await db.select({ status: factionMembers.status, seen: factionMembers.seenAtBaseEventId }).from(factionMembers).where(eq(factionMembers.dayzId, UID_B));
    expect(m!.status).toBe("full");
    expect(m!.seen).toBe(r.promoted[0]!.eventId);
    expect((await presenceTick(db)).promoted).toEqual([]);   // idempotent: cursor advanced, row no longer pending
  });

  it("does not promote at radius + 1, nor a stranger, nor a fix near some OTHER clan's pole", async () => {
    await position(UID_B, 5000 + JOIN_PRESENCE_RADIUS_M + 1, 5000);
    await position("S".repeat(40), 5000, 5000);
    expect((await presenceTick(db)).promoted).toEqual([]);
    expect((await db.select({ status: factionMembers.status }).from(factionMembers).where(eq(factionMembers.dayzId, UID_B)))[0]!.status).toBe("pending");
  });

  it("⚠️ compares x with x and z with z — a fix at the pole's x and a far z is NOT at the base", async () => {
    await position(UID_B, 5000, 5000 + 1000);
    expect((await presenceTick(db)).promoted).toEqual([]);
  });

  it("a flag raise at the pole counts as presence (the payload carries the pole, not a pos)", async () => {
    await db.insert(events).values({ serverId, admFileId, lineIndex: line++, type: "flag.raised", occurredAt: now,
      payload: { dayzId: UID_B, gamertag: "G", texture: "Flag_White", poleKey: P, pole: { x: 5000, y: 100, z: 5000 } } });
    expect((await presenceTick(db)).promoted).toHaveLength(1);
  });

  it("promotion releases the joiner's solo base in the same transaction and stamps its grace", async () => {
    // UID_B declared a solo base elsewhere before accepting the invite (spec §5.3 ⚠️: kept until promotion).
    const Q = "7000.00:100.00:7000.00";
    await db.insert(poles).values({ serverId, map: "livonia", poleKey: Q, x: "7000.00", y: "100.00", z: "7000.00", currentTexture: "Flag_White", flagRaised: true, firstSeenAt: now, lastSeenAt: now, graceUntil: now });
    await db.insert(events).values({ serverId, admFileId, lineIndex: line++, type: "flag.raised", occurredAt: ago(5000), payload: { dayzId: UID_B, gamertag: "G", texture: "Flag_White", poleKey: Q, pole: { x: 7000, y: 100, z: 7000 } } });
    // declareSolo refuses a FULL member; UID_B is pending, so this must succeed (Task 3).
    expect(await declareSolo(db, { serverId, dayzId: UID_B, poleKey: Q, at: ago(4000) })).toMatchObject({ ok: true });
    await position(UID_B, 5000, 5000);
    const r = await presenceTick(db);
    expect(r.promoted[0]).toMatchObject({ dayzId: UID_B, releasedSoloBase: true });
    expect(await declarationForPlayer(db, serverId, UID_B)).toBeNull();
    const [q] = await db.select({ graceUntil: poles.graceUntil }).from(poles).where(eq(poles.poleKey, Q));
    expect(q!.graceUntil.getTime()).toBe(now.getTime() + RELEASED_POLE_GRACE_MS);   // `at` = the event's occurredAt = now
  });

  it("expires a pending member unseen for PENDING_EXPIRY_MS, and not one day short of it", async () => {
    expect(await expirePendingMembers(db, new Date(now.getTime() + PENDING_EXPIRY_MS - 1))).toEqual([]);
    expect(await expirePendingMembers(db, new Date(now.getTime() + PENDING_EXPIRY_MS))).toEqual([{ factionId, dayzId: UID_B, discordId: "200" }]);
    expect(await db.select().from(factionMembers).where(eq(factionMembers.dayzId, UID_B))).toEqual([]);
    // Full members are never expired, whatever their pending_since says.
  });
```
Note `presenceTick` must treat `flag.raised`'s point as the pole (`payload.pole`) when there is no `pos`, and the raise's `dayzId` as the player.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: `presence-tick.ts`**

```ts
import type { Database } from "@factions/db";
import { declarations, factionMembers, factions } from "@factions/db";
import { readCursor, writeCursor, readEventBatch } from "@factions/event-log";
import { distance2d, JOIN_PRESENCE_RADIUS_M, PENDING_EXPIRY_MS, HOLDING_STATUSES } from "@factions/domain";
import { lockDeclarations, releaseTx } from "@factions/declarations";
import { and, eq, inArray, lte, sql } from "drizzle-orm";

/** ⚠️ Distinct from every other consumer name; two consumers sharing a cursor skip each other's events. */
export const PRESENCE_CONSUMER = "presence-promoter";

export type PresenceResult = {
  scanned: number;
  promoted: { factionId: number; dayzId: string; eventId: number; releasedSoloBase: boolean }[];
};

type Pending = { memberId: number; factionId: number; serverId: number; dayzId: string; poleX: number; poleZ: number };

/** The point an event places its player at: `pos` when it has one; a flag event's pole otherwise. */
function pointOf(type: string, payload: unknown): { dayzId: string; x: number; z: number } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.dayzId !== "string") return null;
  const v = (p.pos ?? ((type === "flag.raised" || type === "flag.lowered") ? p.pole : undefined)) as Record<string, unknown> | undefined;
  if (!v || typeof v.x !== "number" || typeof v.z !== "number") return null;
  // ⚠️ Vec3 is {x, y: altitude, z} — the parser already put the ADM `pos=<x, z, alt>` fields in their places. Compare x with x, z with z.
  return { dayzId: p.dayzId, x: v.x, z: v.z };
}

/**
 * Promote pending members the log has seen at their clan's base (spec §5.3,
 * §7 "presence"). Idempotent by `seen_at_base_event_id`: the UPDATE is guarded
 * on `status = 'pending'`, so a replayed batch promotes nobody twice.
 *
 * Per event: a pending member with this UID → their clan's declaration →
 * distance in 2-D → within JOIN_PRESENCE_RADIUS_M → one transaction:
 * `lockDeclarations` → `releaseTx` (the joiner's solo base, if any — §5.3 ⚠️
 * "not at accept") → `faction_members` update. Lock order §4.12:
 * declarations → poles → faction_members. Notices (`became_full`): increment 3.
 * Discord role/channel grants: increment 3 (no ids exist yet).
 */
export async function presenceTick(db: Database, opts: { batchSize?: number } = {}): Promise<PresenceResult> {
  const batchSize = opts.batchSize ?? 500;
  let cursor = await readCursor(db, PRESENCE_CONSUMER);
  const out: PresenceResult = { scanned: 0, promoted: [] };
  for (;;) {
    const batch = await readEventBatch(db, cursor, batchSize);
    if (batch.length === 0) break;
    // One read per batch, not per event: who is pending right now, and where their base is.
    const pending = new Map<string, Pending>();
    for (const row of await db.select({
      memberId: factionMembers.id, factionId: factionMembers.factionId, serverId: factionMembers.serverId, dayzId: factionMembers.dayzId,
      poleX: declarations.x, poleZ: declarations.z,
    }).from(factionMembers)
      .innerJoin(factions, eq(factions.id, factionMembers.factionId))
      .innerJoin(declarations, eq(declarations.ownerFactionId, factionMembers.factionId))
      .where(and(eq(factionMembers.status, "pending"), inArray(factions.status, [...HOLDING_STATUSES])))) {
      pending.set(`${row.serverId}:${row.dayzId}`, { ...row, poleX: Number(row.poleX), poleZ: Number(row.poleZ) });
    }
    for (const ev of batch) {
      cursor = ev.id;
      const pt = pointOf(ev.type, ev.payload);
      if (!pt) continue;
      out.scanned++;
      const m = pending.get(`${ev.serverId}:${pt.dayzId}`);
      if (!m) continue;
      if (distance2d({ x: pt.x, z: pt.z }, { x: m.poleX, z: m.poleZ }) > JOIN_PRESENCE_RADIUS_M) continue;
      const result = await db.transaction(async (tx) => {
        await lockDeclarations(tx, m.serverId);
        const released = await releaseTx(tx, { dayzId: m.dayzId, serverId: m.serverId }, ev.occurredAt);
        const rows = await tx.update(factionMembers)
          .set({ status: "full", seenAtBaseEventId: ev.id })
          .where(and(eq(factionMembers.id, m.memberId), eq(factionMembers.status, "pending")))
          .returning({ id: factionMembers.id });
        return rows.length > 0 ? { released } : null;
      });
      if (result) {
        out.promoted.push({ factionId: m.factionId, dayzId: m.dayzId, eventId: ev.id, releasedSoloBase: result.released });
        pending.delete(`${ev.serverId}:${pt.dayzId}`);
      }
    }
    await writeCursor(db, PRESENCE_CONSUMER, cursor);
  }
  return out;
}

/**
 * The reaper's pending half (spec §7): a pending member not seen at the base
 * within PENDING_EXPIRY_MS of accepting is removed. No cooldown — they never
 * joined. Returns who, so increment 3 can DM `pending_expired`.
 */
export async function expirePendingMembers(db: Database, now: Date): Promise<{ factionId: number; dayzId: string; discordId: string }[]> {
  return db.delete(factionMembers)
    .where(and(eq(factionMembers.status, "pending"), lte(factionMembers.pendingSince, new Date(now.getTime() - PENDING_EXPIRY_MS))))
    .returning({ factionId: factionMembers.factionId, dayzId: factionMembers.dayzId, discordId: factionMembers.discordId });
}
```
If `releaseTx`'s `Owner` type needs `{ dayzId, serverId }` in that order it already accepts it (2b's `unlinkDb` uses the same shape). `distance2d` is exported from `@factions/domain` (spacing.ts).

- [ ] **Step 4: Wire the ticks**

In `apps/bot/src/discord.ts`'s runner (the block that runs `runPlayerProjection` then `verificationTick`), add after the player projection, in its own try/catch that logs `presence tick failed`:
```ts
      const pr = await presenceTick(db);
      if (pr.promoted.length > 0) console.log(`presence: ${pr.promoted.length} member(s) now full`);
```
and beside the dormancy tick (60 s cadence, same guarded block), in its own try/catch logging `pending expiry failed`:
```ts
      const expired = await expirePendingMembers(db, new Date());
      if (expired.length > 0) console.log(`pending expiry: ${expired.length} member(s) dropped`);
```
Import both from `./presence-tick.js`. `apps/bot/README.md`, under Running: one paragraph — "The presence tick promotes a pending member on the first log line that places them within 50 m of their clan's base (the guide's number lives in `rules.ts`); the pending-expiry sweep removes a pending member unseen for 7 days. Both are silent in Discord until increment 3's notices."

- [ ] **Step 5: Run and gate**

```bash
cd apps/bot && TEST_DATABASE_URL=… npx vitest run test/presence-tick.test.ts
```
Full gate 26/26.

- [ ] **Step 6: Commit**

```bash
git add apps/bot
git commit -m "feat(bot): presence promotion — a pending member seen at the base becomes full and gives up their solo base; pending expiry after 7 days"
```

---

### Task 7: The package's roster writes — exported, pinned, tested

**Files:**
- Create: `packages/roster/src/actor.ts`, `packages/roster/src/writes.ts`, `packages/roster/test/writes.test.ts`
- Modify: `packages/roster/src/index.ts`, `packages/roster/test/exports.test.ts`, `apps/web/test/smoke.test.ts`

**Interfaces:**
- Consumes: everything in `@factions/roster/internal`; `activeServerId` (`src/server.ts`); rules constants.
- Produces (root exports; every write takes the ACTOR's Discord id first and resolves their clan itself — a page never names a faction id for a write on its own clan):
  ```ts
  // actor.ts
  export type Actor = { discordId: string; dayzId: string; gamertag: string; factionId: number; serverId: number; role: Role; status: MemberStatus } ;
  export type ActorRefusal = "not-linked" | "not-in-clan" | "pending";
  export async function actorFor(db: Database, discordId: string): Promise<Actor | ActorRefusal>;   // "pending" when their only row is pending
  // writes.ts (each has a …Db(db, now, …) twin the tests call; index.ts wraps with db() and new Date())
  export type InviteOutcome = CreateInviteOutcome | ActorRefusal | "not-permitted" | "invitee-not-linked";
  invite(actorDiscordId, inviteeDiscordId): Promise<{ outcome: InviteOutcome; inviteId: number | null }>
  revokeInvite(actorDiscordId, inviteId): Promise<"ok" | "not-permitted" | "gone" | ActorRefusal>
  acceptInvite(discordId, inviteId): Promise<AcceptInviteOutcome | "not-linked">
  declineInvite(discordId, inviteId): Promise<boolean>
  requestJoin(discordId, tag): Promise<{ outcome: RequestJoinOutcome | "not-linked" | "no-such-clan"; requestId: number | null }>
  withdrawRequest(discordId, requestId): Promise<boolean>
  decideRequest(actorDiscordId, requestId, decision: "accepted" | "declined"): Promise<DecideRequestOutcome | ActorRefusal>
  leave(discordId): Promise<LeaveOutcome | "not-linked" | "not-in-clan">          // a pending member may leave
  kick(actorDiscordId, targetDiscordId): Promise<KickOutcome | ActorRefusal>
  promote(actorDiscordId, targetDiscordId): Promise<SetRoleOutcome | ActorRefusal>
  demote(actorDiscordId, targetDiscordId): Promise<SetRoleOutcome | ActorRefusal>
  transfer(actorDiscordId, targetDiscordId): Promise<TransferOutcome | ActorRefusal>
  disband(actorDiscordId): Promise<"ok" | "not-leader" | ActorRefusal>
  rename(actorDiscordId, a: { name: string; tag?: string }): Promise<RenameOutcome | ActorRefusal | "bad-name" | "bad-tag">
  setRecruitingPost(actorDiscordId, post: { recruiting: boolean; playWindow: string | null; language: string | null; pitch: string | null }): Promise<"ok" | "not-permitted" | ActorRefusal>
  claimCeremony(discordId, ceremonyId, a: { name: string; tag: string; texture: string; memberDayzIds: string[] }): Promise<ReserveOutcome | "not-linked" | "no-such-ceremony" | "bad-name" | "bad-tag" | "bad-flag" | "bad-roster">
  confirmRebind(actorDiscordId, poleKey): Promise<"ok" | "refused" | "too-close" | "no-candidate" | "not-leader" | ActorRefusal>
  ```
  where `ReserveOutcome` is `PgFactionStore.reserve`'s union. Validation constants: `CLAN_NAME_LENGTH`, `CLAN_TAG_LENGTH` (letters/digits only for the tag, per guide ch. 3), `isClaimableFlag`. TTLs: invites and requests expire at `now + PENDING_EXPIRY_MS`; cooldowns `now + ROSTER_COOLDOWN_MS`; rename `notBefore = now - RENAME_COOLDOWN_MS`; reservation `reservedUntil = now + ACTIVATION_WINDOW_MS`; rebind candidates from raises within `REBIND_CONFIRM_MS`, `notBefore = now - REBIND_COOLDOWN_MS`.

- [ ] **Step 1: Failing tests**

`packages/roster/test/writes.test.ts` — DB fixture (truncate everything roster touches: `faction_join_requests, identity_holds, faction_invites, roster_cooldowns, faction_members, declarations, poles, factions, ceremony_participants, ceremonies, claim_drafts, identity_links, players, events, raw_lines, adm_files, faction_events, servers`), a server, three linked players (`L` leader "d1", `O` outsider "d2", `T` third "d3"), and a clan seeded the way `apps/bot/test/seed.ts`'s `seedFaction` does (copy the minimal insert: faction row + declaration citing a synthetic `flag.raised` event; keep it in `packages/roster/test/seed.ts`). Cases, one `it` each, asserting outcome AND the row:
1. `actorFor`: not linked → "not-linked"; linked outsider → "not-in-clan"; pending → "pending"; leader → `{ role: "leader", status: "full" }`.
2. `invite` by the leader to `O` → ok; the invite's `expiresAt` = now + `PENDING_EXPIRY_MS`; by a member → "not-permitted"; to an unlinked Discord id → "invitee-not-linked".
3. `acceptInvite` by `O` → ok and a pending row; `leave` by the pending `O` → ok, row gone, cooldown until now + `ROSTER_COOLDOWN_MS`.
4. `requestJoin(d2, "BEAR")` → "not-recruiting"; after `setRecruitingPost` by the leader → ok; `decideRequest(d1, id, "accepted")` → ok, pending row; `requestJoin(d2, "NOPE")` → "no-such-clan".
5. `kick`/`promote`/`demote`/`transfer` happy paths on a full member `T`, and `transfer` refused for a pending target ("target-not-member").
6. `rename(d1, { name: "Grizzlies", tag: "GRIZ" })` → ok and a hold on "bears"/"bear"; `rename(d1, { name: "ab" })` → "bad-name"; `rename(d1, { name: "Fine", tag: "T@G" })` → "bad-tag".
7. `disband(d1)` → ok; `disband(d3)` (member) → "not-leader".
8. `claimCeremony`: seed a provisional ceremony with participants d1, d2, d3 at a free pole 3 km away; `claimCeremony(d1, id, { name: "Wolves", tag: "WOLF", texture: "Flag_Wolf", memberDayzIds: [L, O] })` → ok, a reserved clan with two full members, `reservedUntil` = now + `ACTIVATION_WINDOW_MS`, the declaration citing the ceremony; `memberDayzIds` missing the claimant → "bad-roster"; a texture not in `CLAIMABLE_FLAGS` → "bad-flag"; `claimCeremony(d2, …)` for a ceremony d2 is not in → "no-such-ceremony".
9. `confirmRebind`: seed a raise of the clan's texture by a full member at a free pole 3 km away within the last hour → ok, declaration moved, old pole's grace stamped; with no such raise → "no-candidate"; by an officer → "not-leader".

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: `actor.ts` and `writes.ts`**

`packages/roster/src/actor.ts`:
```ts
import type { Database } from "@factions/db";
import { factions, factionMembers, identityLinks } from "@factions/db";
import { HOLDING_STATUSES, type MemberStatus } from "@factions/domain";
import type { Role } from "./internal";
import { and, asc, eq, inArray } from "drizzle-orm";

export type Actor = { discordId: string; dayzId: string; gamertag: string; factionId: number; serverId: number; role: Role; status: MemberStatus };
export type ActorRefusal = "not-linked" | "not-in-clan" | "pending";

/**
 * Who is acting, and on which clan. The site never names a faction id for a
 * write on the actor's own clan — it is derived here from their link and
 * roster row, so a forged id in a form cannot act on someone else's clan.
 * A pending member is "pending": they may leave or decline, nothing else.
 */
export async function actorFor(db: Database, discordId: string): Promise<Actor | ActorRefusal> {
  const [link] = await db.select({ dayzId: identityLinks.dayzId, gamertag: identityLinks.gamertag }).from(identityLinks).where(eq(identityLinks.discordId, discordId));
  if (!link) return "not-linked";
  const [m] = await db.select({ factionId: factionMembers.factionId, serverId: factionMembers.serverId, role: factionMembers.role, status: factionMembers.status })
    .from(factionMembers).innerJoin(factions, eq(factions.id, factionMembers.factionId))
    .where(and(eq(factionMembers.discordId, discordId), inArray(factions.status, [...HOLDING_STATUSES]))).orderBy(asc(factions.id)).limit(1);
  if (!m) return "not-in-clan";
  if (m.status === "pending") return "pending";
  return { discordId, ...link, factionId: m.factionId, serverId: m.serverId, role: m.role as Role, status: m.status as MemberStatus };
}
export const isRefusal = (a: Actor | ActorRefusal): a is ActorRefusal => typeof a === "string";
```
`packages/roster/src/writes.ts` — every function follows one shape: resolve the actor (or the link, for the joiner-side calls), validate input against rules constants, call the internal store with rules-derived times, return the store's outcome. Written out:
```ts
import type { Database } from "@factions/db";
import { factions, identityLinks, factionMembers } from "@factions/db";
import {
  ACTIVATION_WINDOW_MS, CLAN_NAME_LENGTH, CLAN_TAG_LENGTH, HOLDING_STATUSES, PENDING_EXPIRY_MS, REBIND_CONFIRM_MS, REBIND_COOLDOWN_MS,
  RENAME_COOLDOWN_MS, ROSTER_COOLDOWN_MS, isClaimableFlag,
} from "@factions/domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  PgRosterStore, PgFactionStore, PgRebindStore, selectCandidates, requestJoinDb, decideRequestDb, withdrawRequestDb,
  type CreateInviteOutcome, type AcceptInviteOutcome, type KickOutcome, type LeaveOutcome, type SetRoleOutcome, type TransferOutcome, type RenameOutcome,
  type RequestJoinOutcome, type DecideRequestOutcome,
} from "./internal";
import { actorFor, isRefusal, type ActorRefusal } from "./actor";

export type ReserveOutcome = Awaited<ReturnType<PgFactionStore["reserve"]>>;
const TAG_RE = /^[A-Za-z0-9]+$/u;
export const validName = (s: string) => s.trim().length >= CLAN_NAME_LENGTH.min && s.trim().length <= CLAN_NAME_LENGTH.max;
export const validTag = (s: string) => s.length >= CLAN_TAG_LENGTH.min && s.length <= CLAN_TAG_LENGTH.max && TAG_RE.test(s);

export type InviteOutcome = CreateInviteOutcome | ActorRefusal | "not-permitted" | "invitee-not-linked";
export async function inviteDb(db: Database, now: Date, actorDiscordId: string, inviteeDiscordId: string): Promise<{ outcome: InviteOutcome; inviteId: number | null }> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return { outcome: a, inviteId: null };
  const [invitee] = await db.select({ dayzId: identityLinks.dayzId }).from(identityLinks).where(eq(identityLinks.discordId, inviteeDiscordId));
  if (!invitee) return { outcome: "invitee-not-linked", inviteId: null };
  return new PgRosterStore(db).createInvite({
    factionId: a.factionId, serverId: a.serverId, inviteeDiscordId, inviteeDayzId: invitee.dayzId, invitedByDiscordId: a.discordId,
    at: now, expiresAt: new Date(now.getTime() + PENDING_EXPIRY_MS),
  });
}
export async function revokeInviteDb(db: Database, now: Date, actorDiscordId: string, inviteId: number) {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  return new PgRosterStore(db).revokeInvite({ inviteId, factionId: a.factionId, actorDiscordId, at: now });
}
export async function acceptInviteDb(db: Database, now: Date, discordId: string, inviteId: number): Promise<AcceptInviteOutcome | "not-linked"> {
  const [link] = await db.select({ dayzId: identityLinks.dayzId }).from(identityLinks).where(eq(identityLinks.discordId, discordId));
  if (!link) return "not-linked";
  return new PgRosterStore(db).acceptInvite(inviteId, discordId, now);
}
export const declineInviteDb = (db: Database, now: Date, discordId: string, inviteId: number) => new PgRosterStore(db).declineInvite(inviteId, discordId, now);

export async function requestJoinDbByTag(db: Database, now: Date, discordId: string, tag: string): Promise<{ outcome: RequestJoinOutcome | "not-linked" | "no-such-clan"; requestId: number | null }> {
  const [link] = await db.select({ dayzId: identityLinks.dayzId }).from(identityLinks).where(eq(identityLinks.discordId, discordId));
  if (!link) return { outcome: "not-linked", requestId: null };
  const [clan] = await db.select({ id: factions.id, serverId: factions.serverId }).from(factions)
    .where(and(eq(sql`lower(${factions.tag})`, tag.toLowerCase()), inArray(factions.status, [...HOLDING_STATUSES])));
  if (!clan) return { outcome: "no-such-clan", requestId: null };
  return requestJoinDb(db, { factionId: clan.id, serverId: clan.serverId, dayzId: link.dayzId, discordId, at: now, expiresAt: new Date(now.getTime() + PENDING_EXPIRY_MS) });
}
export const withdrawRequestDbFor = (db: Database, now: Date, discordId: string, requestId: number) => withdrawRequestDb(db, requestId, discordId, now);
export async function decideRequestDbFor(db: Database, now: Date, actorDiscordId: string, requestId: number, decision: "accepted" | "declined"): Promise<DecideRequestOutcome | ActorRefusal> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  return decideRequestDb(db, { requestId, actorDiscordId, decision, at: now });
}

/** Any roster row may leave, pending included — actorFor's "pending" refusal is bypassed on purpose here. */
export async function leaveDb(db: Database, now: Date, discordId: string): Promise<LeaveOutcome | "not-linked" | "not-in-clan"> {
  const [m] = await db.select({ factionId: factionMembers.factionId }).from(factionMembers).innerJoin(factions, eq(factions.id, factionMembers.factionId))
    .where(and(eq(factionMembers.discordId, discordId), inArray(factions.status, [...HOLDING_STATUSES]))).limit(1);
  if (!m) return "not-in-clan";
  return new PgRosterStore(db).leave({ factionId: m.factionId, discordId, at: now, until: new Date(now.getTime() + ROSTER_COOLDOWN_MS) });
}
export async function kickDb(db: Database, now: Date, actorDiscordId: string, targetDiscordId: string): Promise<KickOutcome | ActorRefusal> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  return new PgRosterStore(db).kick({ factionId: a.factionId, actorDiscordId, targetDiscordId, at: now, until: new Date(now.getTime() + ROSTER_COOLDOWN_MS) });
}
async function setRoleDb(db: Database, actorDiscordId: string, targetDiscordId: string, role: "officer" | "member"): Promise<SetRoleOutcome | ActorRefusal> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  return new PgRosterStore(db).setRole({ factionId: a.factionId, actorDiscordId, targetDiscordId, role });
}
export const promoteDb = (db: Database, actorDiscordId: string, targetDiscordId: string) => setRoleDb(db, actorDiscordId, targetDiscordId, "officer");
export const demoteDb = (db: Database, actorDiscordId: string, targetDiscordId: string) => setRoleDb(db, actorDiscordId, targetDiscordId, "member");
export async function transferDb(db: Database, now: Date, actorDiscordId: string, targetDiscordId: string): Promise<TransferOutcome | ActorRefusal> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  return new PgRosterStore(db).transfer({ factionId: a.factionId, fromDiscordId: actorDiscordId, toDiscordId: targetDiscordId, at: now });
}
export async function disbandDb(db: Database, actorDiscordId: string): Promise<"ok" | "not-leader" | ActorRefusal> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  return new PgRosterStore(db).disband(a.factionId, actorDiscordId);
}
export async function renameDb(db: Database, now: Date, actorDiscordId: string, r: { name: string; tag?: string }): Promise<RenameOutcome | ActorRefusal | "bad-name" | "bad-tag"> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  if (!validName(r.name)) return "bad-name";
  if (r.tag !== undefined && !validTag(r.tag)) return "bad-tag";
  return new PgRosterStore(db).rename({ factionId: a.factionId, discordId: actorDiscordId, name: r.name.trim(), tag: r.tag, at: now, notBefore: new Date(now.getTime() - RENAME_COOLDOWN_MS) });
}
export async function setRecruitingPostDb(db: Database, actorDiscordId: string, post: { recruiting: boolean; playWindow: string | null; language: string | null; pitch: string | null }) {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  return new PgRosterStore(db).setRecruitingPost({ factionId: a.factionId, actorDiscordId, ...post });
}

/**
 * The claim (spec §5.1; guide ch. 3): name, tag, flag, and the roster pruned
 * to real participants. The claimant becomes leader and must be on the
 * roster. `reserve` writes the declaration citing the ceremony, so the 200 m
 * refusal happens here, where the guide says it does.
 */
export async function claimCeremonyDb(db: Database, now: Date, discordId: string, ceremonyId: number, a: { name: string; tag: string; texture: string; memberDayzIds: string[] }):
  Promise<ReserveOutcome | "not-linked" | "no-such-ceremony" | "bad-name" | "bad-tag" | "bad-flag" | "bad-roster"> {
  const [link] = await db.select({ dayzId: identityLinks.dayzId }).from(identityLinks).where(eq(identityLinks.discordId, discordId));
  if (!link) return "not-linked";
  const store = new PgFactionStore(db);
  const ceremony = await store.openCeremonyByIdFor(ceremonyId, discordId);
  if (!ceremony) return "no-such-ceremony";
  if (!validName(a.name)) return "bad-name";
  if (!validTag(a.tag)) return "bad-tag";
  if (!isClaimableFlag(a.texture)) return "bad-flag";
  const chosen = ceremony.participants.filter((p) => a.memberDayzIds.includes(p.dayzId));
  if (chosen.length !== a.memberDayzIds.length || !chosen.some((p) => p.dayzId === link.dayzId)) return "bad-roster";
  return store.reserve({
    ceremonyId, serverId: ceremony.serverId, poleKey: ceremony.poleKey, x: ceremony.x, y: ceremony.y, z: ceremony.z,
    name: a.name.trim(), tag: a.tag, texture: a.texture, leaderDiscordId: discordId,
    members: chosen.map((p) => ({ dayzId: p.dayzId, discordId: p.discordId })),
    at: now, reservedUntil: new Date(now.getTime() + ACTIVATION_WINDOW_MS),
  });
}

/** The leader confirms a move (guide ch. 8: within 24 h of the raise — REBIND_CONFIRM_MS, not the bot command's shorter window). */
export async function confirmRebindDb(db: Database, now: Date, actorDiscordId: string, poleKey: string): Promise<"ok" | "refused" | "too-close" | "no-candidate" | "not-leader" | ActorRefusal> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  if (a.role !== "leader") return "not-leader";
  const store = new PgRebindStore(db);
  const clan = await store.factionFor(a.factionId);
  if (!clan || clan.poleKey === null) return "refused";
  const raises = await store.qualifyingRaises(clan, new Date(now.getTime() - REBIND_CONFIRM_MS));
  const candidate = selectCandidates(raises, { currentPoleKey: clan.poleKey, now }).find((c) => c.poleKey === poleKey);
  if (!candidate) return "no-candidate";
  return store.rebind({
    factionId: a.factionId, leaderDiscordId: actorDiscordId, expectedPoleKey: clan.poleKey,
    poleKey: candidate.poleKey, x: candidate.x, y: candidate.y, z: candidate.z, evidenceEventId: candidate.eventId,
    at: now, notBefore: new Date(now.getTime() - REBIND_COOLDOWN_MS),
  });
}
```
`selectCandidates`' second argument shape is whatever `rebind.ts` declares — read it and match (the bot's `handleRebindConfirm` calls it the same way).

`packages/roster/src/index.ts` adds the wrappers, each one line, e.g. `export const invite = (actor: string, invitee: string) => inviteDb(db(), new Date(), actor, invitee);` for: `invite, revokeInvite, acceptInvite, declineInvite, requestJoin, withdrawRequest, decideRequest, leave, kick, promote, demote, transfer, disband, rename, setRecruitingPost, claimCeremony, confirmRebind`, and re-exports the outcome types. The docblock's write list is updated. **Both pins** become, in `Object.keys(...).sort()` order:
`["DECLARE_SOLO_REASONS", "ISSUE_OUTCOME_KINDS", "acceptInvite", "baseFor", "cancelLink", "claimCeremony", "confirmRebind", "decideRequest", "declareSolo", "declineInvite", "demote", "disband", "invite", "kick", "leave", "linkStatus", "promote", "releaseSolo", "rename", "requestJoin", "revokeInvite", "searchGamertags", "setRecruitingPost", "startLink", "transfer", "unlink", "viewerFor", "withdrawRequest"]`.
The bad-substring test in `exports.test.ts` (`activate, dormant, raid, defense, declaration, reserve, createfaction, insert`) must still pass: `claimCeremony` contains none of them (the store's `reserve` is not exported); do not weaken the list. Add to that test's forbidden list: `"rebind"` is NOT forbidden (confirmRebind is a spec export) — leave the list as is.

- [ ] **Step 4: Run and gate**

```bash
cd packages/roster && TEST_DATABASE_URL=… npx vitest run
cd ../../apps/web && npx vitest run test/smoke.test.ts
```
Full gate 26/26.

- [ ] **Step 5: Commit**

```bash
git add packages/roster apps/web/test/smoke.test.ts
git commit -m "feat(roster): the roster writes as package exports — invites, requests, roster changes, rename, disband, claim, rebind confirm"
```

---

### Task 8: The package's reads for the pages — `clanFor`, `directory`, `clanByTag`, `claimContext`, `myInvites`, `myRequests`

**Files:**
- Create: `packages/roster/src/reads.ts`, `packages/roster/test/reads.test.ts`
- Modify: `packages/roster/src/index.ts`, both export pins

**Interfaces:**
- Produces:
  ```ts
  export type RosterRow = { dayzId: string; discordId: string; gamertag: string | null; role: Role; status: MemberStatus; joinedAt: Date; lastSeenAt: Date | null };
  export type ClanView = {
    clan: { id: number; name: string; tag: string; texture: string; status: string; createdAt: Date; activatedAt: Date | null; recruiting: boolean; playWindow: string | null; language: string | null; pitch: string | null };
    me: { role: Role; status: MemberStatus };
    roster: RosterRow[];                       // full first, then pending
    invitesOut: Awaited<ReturnType<PgRosterStore["invitesOut"]>>;   // officer+ only, else []
    requestsIn: JoinRequest[];                 // officer+ only, else []
    rebindCandidates: { poleKey: string; raisedAt: Date; by: string }[];   // leader only, raises within REBIND_CONFIRM_MS; no coordinates
  };
  clanFor(discordId): Promise<ClanView | "not-linked" | "not-in-clan">     // a pending member gets a ClanView with me.status "pending", roster visible, no invites/requests
  export type DirectoryEntry = { tag: string; name: string; texture: string; status: string; memberCount: number; recruiting: boolean; playWindow: string | null; language: string | null; pitch: string | null };
  directory(): Promise<{ clans: DirectoryEntry[]; flags: { taken: string[]; free: string[] } }>   // recruiting first, then by name
  export type ClanPage = DirectoryEntry & { createdAt: Date; roster: { gamertag: string | null; role: Role }[]; canRequest: "yes" | "not-linked" | "in-clan" | "not-recruiting" | "cooldown" | "cap" | "already-requested" };
  clanByTag(tag, viewerDiscordId: string | null): Promise<ClanPage | null>
  export type ClaimContext = { ceremony: { id: number; detectedAt: Date; expiresAt: Date; participants: { dayzId: string; gamertag: string; discordId: string }[] }; freeFlags: string[] } | null;
  claimContext(discordId): Promise<ClaimContext>       // the viewer's open ceremony, or null
  myInvites(discordId): Promise<PendingInvite[]>
  myRequests(discordId): Promise<Awaited<ReturnType<typeof requestsBy>>>
  ```
  Public roster rows carry gamertag and role only (CLAUDE.md: roster membership is public; who someone is is public, where their base is is not). No read here returns a coordinate.

- [ ] **Step 1: Failing tests**

`packages/roster/test/reads.test.ts`, same fixture as Task 7's (share `test/seed.ts`): `clanFor` for leader (invitesOut/requestsIn populated after seeding one each), for a member (both `[]`), for a pending member (`me.status: "pending"`, roster visible); `directory` orders a recruiting clan first and reports `flags.taken` = the seeded textures and `free.length === 33 - taken.length`; `clanByTag` for a stranger → `canRequest: "not-linked"`, for a linked outsider on a recruiting clan → `"yes"`, on cooldown → `"cooldown"`, after requesting → `"already-requested"`; `claimContext` for a participant lists the three participants and excludes held textures from `freeFlags`; `myInvites`/`myRequests` list the seeded rows.

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: `reads.ts`**

Compose from the internal store where a method exists (`PgRosterStore.rosterOf`, `factionById`, `invitesOut`, `pendingInvitesFor`, `PgFactionStore.openCeremonyFor`, `PgRebindStore.factionFor`/`qualifyingRaises`, `openRequestsFor`, `requestsBy`) and write the two new queries — the directory and the flag pool — directly:
```ts
export async function directoryDb(db: Database): Promise<{ clans: DirectoryEntry[]; flags: { taken: string[]; free: string[] } }> {
  const serverId = await activeServerId(db);
  const rows = await db.select({
    tag: factions.tag, name: factions.name, texture: factions.texture, status: factions.status,
    recruiting: factions.recruiting, playWindow: factions.playWindow, language: factions.language, pitch: factions.pitch,
    memberCount: sql<number>`(select count(*)::int from faction_members m where m.faction_id = ${factions.id} and m.status = 'full')`,
  }).from(factions).where(and(eq(factions.serverId, serverId), inArray(factions.status, ["active", "dormant"])))
    .orderBy(desc(factions.recruiting), asc(sql`lower(${factions.name})`));
  const taken = rows.map((r) => r.texture);
  return { clans: rows.map((r) => ({ ...r, memberCount: Number(r.memberCount) })), flags: { taken, free: CLAIMABLE_FLAGS.filter((f) => !taken.includes(f)) } };
}
```
(Reserved clans are not in the directory — a reservation is not yet a clan the public can see — but their flags ARE taken: compute `taken` from a second query over `HOLDING_STATUSES`, not from the directory rows. Fix the snippet accordingly.) `lastSeenAt` on roster rows joins `players`. `rebindCandidates` maps `selectCandidates(...)` to `{ poleKey, raisedAt: occurredAt, by: gamertag }` — the pole key is an identifier the leader already knows from raising there; `x/y/z` are dropped. `canRequest` runs the same advisory checks `requestJoinDb` runs, read-only.

Add to `index.ts`: `clanFor, directory, clanByTag, claimContext, myInvites, myRequests` (each a one-line wrapper) and the types. Both pins gain the six names (sorted into place).

- [ ] **Step 4: Run and gate**

```bash
cd packages/roster && TEST_DATABASE_URL=… npx vitest run
cd ../../apps/web && npx vitest run
```
Full gate 26/26.

- [ ] **Step 5: Commit**

```bash
git add packages/roster apps/web/test/smoke.test.ts
git commit -m "feat(roster): the reads the clan pages need — clanFor, directory, clanByTag, claimContext, myInvites, myRequests"
```

---

### Task 9: Runbook, CLAUDE.md, spec §15, README

**Files:**
- Create: `docs/deploy/2026-09-05-roster-package.md`
- Modify: `CLAUDE.md`, `apps/bot/README.md`, spec §15, `docs/superpowers/plans/PLAN-3-INBOX.md`

- [ ] **Step 1: Runbook**

```markdown
# Roster package (increment 2c-a) — deploy runbook

Migration 0022 adds four columns to `factions`, three to `faction_members` (all with
defaults or nullable) and two tables. Metadata-only; the bot may keep running while it
applies. The one player-visible change ships with the bot: accepting an invite makes a
PENDING member until the log sees them at the base.

1. **Read the migration.** `packages/db/migrations/0022_roster_membership.sql`. Nothing
   applies migrations in production.
2. **Apply 0022** with the one-off runner from `docs/deploy/2026-09-02-dormancy.md`.
3. **Confirm:**

       select column_name, column_default from information_schema.columns
        where table_name = 'faction_members' and column_name = 'status';
       select count(*) from faction_members where status <> 'full';

   `'full'::text` and `0` — every existing member is exactly as they were.
4. **Deploy the bot** (`sudo systemctl restart clan-wars-bot`). Watch one tick:
   `journalctl -u clan-wars-bot -f` — no `presence tick failed` / `pending expiry failed`.
   The web image needs no rebuild for this increment (no page changed), but rebuilding it
   is harmless.
5. **Acceptance.** `/faction invite` a linked player; they `/faction invites` → accept; the
   reply says pending. `select status, pending_since from faction_members where dayz_id =
   '<uid>'` → `pending`. Have them stand at the base (or raise there); within a tick,
   `status = 'full'` and `seen_at_base_event_id` set. Then the dormancy check from
   `docs/deploy/2026-09-05-declarations.md` step 9, with `select count(*) from factions`.
6. **What did not change.** Every slash command still works (retired in 2c-b). No Discord
   role or channel is granted on promotion (increment 3). No DM says "you're full" yet
   (increment 3's notices).
```

- [ ] **Step 2: CLAUDE.md**

- The lock-order bullet: append "Since 2c-a the store itself lives in `packages/roster/src/internal/`; `apps/bot` imports `@factions/roster/internal`, which `apps/web` may never import (`smoke.test.ts`). New writers there: `requestJoinDb`/`decideRequestDb` (`factions FOR SHARE → faction_join_requests → faction_members`), `presenceTick` (`lockDeclarations → releaseTx → faction_members`), `writeHoldsTx` (right after the `factions` write). `lockIdentity(tx, serverId)` — `pg_advisory_xact_lock(hashtext('identity'), serverId)` — serialises name/tag uniqueness in `rename` and `reserve`, since names have no unique index."
- New bullet after "Roster membership is PUBLIC": "**A pending member is on `faction_members` and not on the roster** (spec §4.5, §14). `status = 'full'` is part of every membership read — dormancy attribution, activation, rebind, `viewerFor.clan`, `declareSoloTx`'s in-clan refusal, `isRosterMember`. The cap counts both statuses. A pending member keeps their solo base until the presence tick promotes them and releases it in the same transaction. Unlink is refused with ANY roster row."
- Current state: "Increment 2c-a landed: the roster store in `packages/roster`, pending/full membership with presence promotion and the cap, join requests, identity holds, the recruiting post, and the package's roster writes and reads exported for 2c-b's pages. Slash commands still run."
- The "site is a surface" bullet: "(the `/me` read today; roster writes from increment 2c on)" → "(the `/me` read, and since 2c-a every roster write, through `packages/roster`)".

- [ ] **Step 3: README and spec**

`apps/bot/README.md`: the `BOT_INVITE_TTL_MS` row's description gains "Accepting makes the player *pending* until the log sees them within 50 m of the base (`JOIN_PRESENCE_RADIUS_M`); see the presence tick under Running." `docs/superpowers/specs/2026-09-04-clan-wars-target-state-design.md` §15: replace row 2c with two rows —
`| 2c-a | **Roster package**: migration 0022 (member status, join requests, identity holds, recruiting); the stores in `packages/roster/src/internal` shared with the bot; every membership read `status = 'full'`; cap; presence promotion + pending expiry ticks; the package's roster writes and reads exported | `2026-09-05-roster-package.md` | 2b |`
`| 2c-b | **The site as the tool**: `/clan`, `/clans`, `/clans/{tag}`, `/claim/{ceremony}`, `/clan/settings`; `/me` shows pending and invites; retire the slash commands in the same deploy; the `/faction` exclusion in `vocabulary.test.ts` and the bot's 1 h rebind window removed with them | `2026-09-xx-site-roster.md` | 2c-a |`
and every later row's "Depends on" that said `2c` now says `2c-b`. In `PLAN-3-INBOX.md`, if an open item describes the cap, pending membership or join requests as missing, mark it DONE 2026-09-05 with a one-line pointer; otherwise add nothing.

- [ ] **Step 4: Gate and commit**

Full gate 26/26; `git status` shows only intended files.
```bash
git add docs CLAUDE.md apps/bot/README.md
git commit -m "docs: 2c-a runbook; CLAUDE.md, README and spec §15 record the roster package, pending membership and the 2c split"
```

---

## Self-review

**Spec coverage.** §4.3 recruiting columns (T1, T5). §4.4 `identity_holds` with `'infinity'`, unique per value, consulted at claim and rename, no hold on lapse (T1, T4; lapse untouched). §4.5 `status`/`pending_since`/`seen_at_base_event_id`, uniqueness covers pending, every read `full` (T1, T3), cap counts both (T3, T5), founders full at reserve (T3), `faction_join_requests` with its partial unique and the recruiting gate (T1, T5). §4.12 lock order stated per writer; `lockIdentity` introduced and documented (T4). §5.1 claim → reserved via `claimCeremony` with the pruned roster (T7). §5.3 pending → full at 50 m with `pos` order respected, 7-day expiry, cap, one clan per player, leave/kick cooldown for pending too, solo release at promotion not accept (T3, T6). §5.5 unlink refused with any row (unchanged from 2b; T3 leaves `unlinkDb` alone). §7 presence and reaper ticks under the runner (T6). §10.4 export names as the spec lists them for link/founding/base/roster/rebind/settings groups, minus vault/map/leadership (later increments) — `claimCeremony`, `confirmRebind`, `setRecruitingPost`, the roster group (T7); reads (T8). §13 "pending does not count anywhere `isRosterMember` is used" (T3 tests), "join releases the solo declaration at promotion, not at accept" (T6 test), staged race for the new writer pair (T4's rename race). §14 pending hazard recorded in CLAUDE.md (T9). §15 split recorded (T9).

**Placeholder scan.** Every code step carries code. T8's `directoryDb` snippet is corrected inline about reserved clans' flags; the implementer writes the second query. T3's test for `roster-invites` says "whatever helper the file already uses" — the helper exists in that file; the implementer reads it.

**Type consistency.** `MemberStatus` (T1) used by `Membership`/`RosterEntry` (T3), `Actor` (T7), `RosterRow` (T8). `CreateInviteOutcome`/`AcceptInviteOutcome` gain `"cap"` (T3) and flow into `InviteOutcome` (T7). `RequestJoinOutcome`/`DecideRequestOutcome`/`JoinRequest` (T5) reused by T7/T8. `writeHoldsTx`/`identityTakenTx`/`lockIdentity` (T4) exported from `internal/index.ts`. `revokeInvite`/`invitesOut`/`setRecruitingPost` on `RosterStore` (T5) used by T7/T8. `presenceTick` uses `releaseTx`'s `{ dayzId, serverId }` owner (2b). Pins: T7's 28 names + T8's 6 = 34, both files, sorted uppercase-first.

**Rulings baked in.** (1) 2c splits into 2c-a/2c-b so the data model and package land behind the gate before any page, and the commands retire only with the pages. (2) The stores move whole into `packages/roster/src/internal/` with a second entry point rather than being copied; their tests stay in the bot suite, repointed. (3) Founders are `full` at reserve with a null `seen_at_base_event_id` — the ceremony row is their evidence. (4) Pending members may leave, be kicked (with the cooldown), and keep/declare a solo base; they cannot be promoted or made leader. (5) Name uniqueness gets an advisory lock (`lockIdentity`) rather than a new unique index, so a held name and a live name are checked by one function. (6) Site rebind confirmation uses the guide's 24 h (`REBIND_CONFIRM_MS`); the bot command's 1 h window is left alone until 2c-b retires it. (7) No Discord side effects and no DMs in this increment; every place one belongs says "increment 3".
