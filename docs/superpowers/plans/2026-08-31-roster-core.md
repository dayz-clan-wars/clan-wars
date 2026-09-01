# Roster core (Plan 4a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a faction governable — invite, accept, kick, promote, demote, transfer, leave, disband, rename, and read a roster — with every membership rule enforced by a database index rather than by code that remembers to look.

**Architecture:** Command handlers stay pure functions over a `RosterStore` interface, exactly as `handleFactionClaim` already is, so every guard is testable with no Discord client. Each state transition is a single guarded statement whose `WHERE` carries the whole precondition, with the outcome decided from `.returning()` — never a read followed by an unconditional write. Uniqueness (one faction per player per server, exactly one leader per faction) is enforced by unique indexes, and the handlers translate constraint violations into player-facing replies.

**Tech Stack:** TypeScript, pnpm workspaces, turbo, tsx (no build step), vitest, Drizzle ORM on Postgres 16, discord.js.

**Spec:** `docs/superpowers/specs/2026-08-31-roster-management-design.md` (this plan implements §4.1–4.5, §5, §5.3 and §8; §6 succession, pole loss and Discord roles are plans 4b–4d)

## Global Constraints

- **ESM/NodeNext.** Every local import ends in `.js`, including from `.ts` files.
- **Migrations are generated, never hand-written.** Run `pnpm -F @factions/db generate` and commit whatever file drizzle-kit produces. Do not edit the SQL by hand and do not rename it.
- **Tests need a database.** `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"`. **Port 5434 only** — 5432 and 5433 belong to other projects on this machine and must never be stopped, removed, or repointed.
- **Never pre-read then write.** A state transition's precondition belongs in the same statement that performs it; decide the outcome from `.returning()`.
- **The index is the check.** Where a rule can be a unique index, it is one, and the handler catches the violation rather than pre-checking for it.
- **Holding statuses are `reserved`, `active`, `dormant`.** Roster commands work in these three and no others.
- **Every reply is ephemeral except `/faction info` and `/faction roster`.**
- Run the suite with `pnpm test` from the repo root; `pnpm -F @factions/bot test` while iterating.

### Exact values

| Constant | Value | Where |
|---|---|---|
| Kick/leave cooldown | 3 days = `259_200_000` ms | `roster_cooldowns.until` |
| Invite TTL | 7 days = `604_800_000` ms | `faction_invites.expires_at` |
| Rename cooldown | 7 days = `604_800_000` ms | `factions.renamed_at` |
| Roles | `"leader" \| "officer" \| "member"` | `faction_members.role` |

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/db/src/schema.ts` (modify) | `faction_members.server_id`, leader index, `faction_invites`, `roster_cooldowns`, `factions.renamed_at` |
| `apps/bot/src/roster-store.ts` (create) | `RosterStore` interface + `PgRosterStore`: every guarded write |
| `apps/bot/src/roster-commands.ts` (create) | Pure handlers for every roster command |
| `apps/bot/src/roster-context.ts` (create) | Resolving which server a command applies to |
| `apps/bot/src/discord.ts` (modify) | Subcommand registration, routing, button custom ids, autocomplete |
| `apps/bot/src/commands.ts` (modify) | `/unlink` roster gate |
| `apps/bot/src/faction-store.ts` (modify) | `reserve()` writes `serverId` onto member rows |
| `apps/bot/src/ceremony-store.ts` (modify) | Lapsing releases the roster |

---

### Task 1: Schema, migration, and the two uniqueness indexes

**Files:**
- Modify: `packages/db/src/schema.ts`
- Modify: `apps/bot/src/faction-store.ts` (the `reserve()` member insert)
- Test: `packages/db/test/roster-schema.test.ts` (create)

**Interfaces:**
- Consumes: nothing
- Produces: `factionMembers.serverId`, `factionInvites`, `rosterCooldowns`, `factions.renamedAt` — every later task imports these from `@factions/db`.

- [ ] **Step 1: Write the failing test**

Create `packages/db/test/roster-schema.test.ts`. Follow the existing pattern in `packages/db/test/` for obtaining a database and running migrations.

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, factions, factionMembers, type Database } from "@factions/db";
import { sql } from "drizzle-orm";

const URL = requireTestDatabaseUrl();
const A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("roster schema", () => {
  let db: Database;
  let serverId = 0;
  let f1 = 0;
  let f2 = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table faction_members, factions, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({
      name: "S", map: "livonia", clockOffsetMs: 0, nitradoServiceId: null,
    }).returning();
    serverId = s!.id;
    const rows = await db.insert(factions).values([
      { serverId, name: "One", tag: "ONE", texture: "Flag_Alpha", poleKey: "1.00:2.00:3.00",
        x: "1.00", y: "2.00", z: "3.00", status: "active", leaderDiscordId: "d1", createdAt: new Date() },
      { serverId, name: "Two", tag: "TWO", texture: "Flag_Beta", poleKey: "4.00:5.00:6.00",
        x: "4.00", y: "5.00", z: "6.00", status: "active", leaderDiscordId: "d2", createdAt: new Date() },
    ]).returning();
    f1 = rows[0]!.id;
    f2 = rows[1]!.id;
  });

  it("refuses the same player on two factions on one server", async () => {
    await db.insert(factionMembers).values({
      factionId: f1, serverId, dayzId: A, discordId: "d1", role: "leader", joinedAt: new Date(),
    });
    await expect(db.insert(factionMembers).values({
      factionId: f2, serverId, dayzId: A, discordId: "d1", role: "member", joinedAt: new Date(),
    })).rejects.toThrow(/faction_members_server_player_uniq/);
  });

  it("refuses a second leader on one faction", async () => {
    await db.insert(factionMembers).values({
      factionId: f1, serverId, dayzId: A, discordId: "d1", role: "leader", joinedAt: new Date(),
    });
    await expect(db.insert(factionMembers).values({
      factionId: f1, serverId, dayzId: B, discordId: "d2", role: "leader", joinedAt: new Date(),
    })).rejects.toThrow(/faction_members_leader_uniq/);
  });

  it("allows a second officer on one faction", async () => {
    await db.insert(factionMembers).values({
      factionId: f1, serverId, dayzId: A, discordId: "d1", role: "officer", joinedAt: new Date(),
    });
    await db.insert(factionMembers).values({
      factionId: f1, serverId, dayzId: B, discordId: "d2", role: "officer", joinedAt: new Date(),
    });
    const rows = await db.select().from(factionMembers);
    expect(rows).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/db test roster-schema`

Expected: FAIL — `server_id` is not a column on `faction_members`.

- [ ] **Step 3: Add the schema changes**

In `packages/db/src/schema.ts`, modify `factionMembers` to add `serverId` and the leader index. The existing `uniqMember` index on `(factionId, dayzId)` stays — it means "one row per player per faction" and is a different rule from the new one.

```ts
export const factionMembers = pgTable("faction_members", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  factionId: bigint("faction_id", { mode: "number" })
    .notNull().references(() => factions.id, { onDelete: "cascade" }),
  /**
   * Denormalized from the faction so "one player, one faction per server" can
   * be an INDEX rather than a code path that remembers to look.
   *
   * ⚠️ The index below carries no partial predicate, which is only correct
   * because a membership row does not outlive its faction's hold: lapsing and
   * disbanding DELETE the roster. Membership in a lapsed faction is not a
   * weaker membership — it is not a membership.
   */
  serverId: integer("server_id").notNull().references(() => servers.id),
  dayzId: text("dayz_id").notNull(),
  discordId: text("discord_id").notNull(),
  role: text("role").notNull(),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull(),
}, (t) => ({
  roleValid: check("faction_members_role_valid",
    sql`${t.role} IN ('leader','officer','member')`),
  uniqMember: uniqueIndex("faction_members_uniq").on(t.factionId, t.dayzId),
  uniqServerPlayer: uniqueIndex("faction_members_server_player_uniq").on(t.serverId, t.dayzId),
  // Exactly one leader. Transfer is one transaction demoting and promoting;
  // this is what makes two simultaneous transfers impossible rather than
  // merely unlikely.
  uniqLeader: uniqueIndex("faction_members_leader_uniq")
    .on(t.factionId).where(sql`${t.role} = 'leader'`),
}));
```

Add `renamedAt` to `factions`, immediately after `activatedAt`:

```ts
  /** Null means never renamed, so no cooldown applies. Set by `/faction rename`. */
  renamedAt: timestamp("renamed_at", { withTimezone: true }),
```

Add the two new tables after `claimDrafts`:

```ts
/**
 * An outstanding invitation. An offer, not a standing permission — hence the TTL.
 */
export const factionInvites = pgTable("faction_invites", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  factionId: bigint("faction_id", { mode: "number" })
    .notNull().references(() => factions.id, { onDelete: "cascade" }),
  /** Denormalized so the accept guard needs no join. */
  serverId: integer("server_id").notNull().references(() => servers.id),
  inviteeDiscordId: text("invitee_discord_id").notNull(),
  /** The roster keys on the UID; the invite is issued to a Discord user. Both are needed. */
  inviteeDayzId: text("invitee_dayz_id").notNull(),
  invitedByDiscordId: text("invited_by_discord_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  declinedAt: timestamp("declined_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => ({
  /**
   * One outstanding offer per faction per player.
   *
   * ⚠️ The predicate deliberately excludes `expires_at > now()`. A Postgres
   * partial index predicate must be IMMUTABLE and `now()` is not, so such an
   * index is rejected outright at creation. Expiry is enforced on the read and
   * accept paths instead; re-inviting someone whose offer lapsed REFRESHES
   * this row rather than inserting a second one.
   *
   * Scoped to the faction, not the player: several factions may court the same
   * player, and choosing between them is the player's to make.
   */
  uniqPending: uniqueIndex("faction_invites_pending_uniq")
    .on(t.factionId, t.inviteeDayzId)
    .where(sql`${t.acceptedAt} IS NULL AND ${t.declinedAt} IS NULL AND ${t.revokedAt} IS NULL`),
}));

/**
 * How long a player is barred from joining any faction on this server.
 *
 * Stores the DECISION, not the departure event, so the accept path is a
 * NOT EXISTS against one row rather than a "find the newest departure" query.
 * Kicks and voluntary departures are treated identically: §6's reasoning is
 * that the two collapse under collusion ("just kick me"), so punishing them
 * differently buys nothing. Disbanding writes nothing at all.
 */
export const rosterCooldowns = pgTable("roster_cooldowns", {
  serverId: integer("server_id").notNull().references(() => servers.id),
  dayzId: text("dayz_id").notNull(),
  until: timestamp("until", { withTimezone: true }).notNull(),
}, (t) => ({
  pk: uniqueIndex("roster_cooldowns_pk").on(t.serverId, t.dayzId),
}));
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm -F @factions/db generate`

This writes `packages/db/migrations/0011_<name>.sql`. Read it and confirm it is additive: a new column, two new tables, three new indexes. `server_id` is `NOT NULL` with no default, which is safe here — `faction_members` holds zero rows in both `factions` and `factions_backfill` (verified during design). If the generated SQL contains a `DROP`, stop and report it rather than editing the file.

- [ ] **Step 5: Export the new tables**

Confirm `packages/db/src/index.ts` re-exports the schema module wholesale. If it names tables individually, add `factionInvites` and `rosterCooldowns`.

- [ ] **Step 6: Fix `reserve()` to write `serverId`**

In `apps/bot/src/faction-store.ts`, the member insert inside `reserve()` must set the new column:

```ts
        await tx.insert(factionMembers).values(a.members.map((m) => ({
          factionId: f!.id, serverId: a.serverId, dayzId: m.dayzId, discordId: m.discordId,
          role: m.discordId === a.leaderDiscordId ? "leader" : "member",
          joinedAt: a.at,
        })));
```

- [ ] **Step 7: Run the tests**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/db test && pnpm -F @factions/bot test`

Expected: PASS. The bot's existing claim tests must still pass — if `reserve()` was missed, they fail on a null `server_id`.

- [ ] **Step 8: Commit**

```bash
git add packages/db apps/bot/src/faction-store.ts
git commit -m "feat(db): roster uniqueness, invites, and cooldowns"
```

---

### Task 2: Lapsing releases the roster

**Files:**
- Modify: `apps/bot/src/ceremony-store.ts` (`lapseReservations`)
- Test: `apps/bot/test/ceremony-store.test.ts`

**Interfaces:**
- Consumes: `factionMembers.serverId` (Task 1)
- Produces: the invariant Task 1's unqualified index depends on

Task 1's `faction_members_server_player_uniq` has no partial predicate, so it is only correct if a lapsed faction's members stop being members. Without this task, a player whose faction lapsed can never join another faction on that server — permanently, with no command able to fix it.

- [ ] **Step 1: Write the failing test**

Add to `apps/bot/test/ceremony-store.test.ts`, matching the fixtures already in that file:

```ts
  it("releases the roster when a reservation lapses", async () => {
    // ⚠️ The one-faction-per-server index carries no status predicate, so a
    // membership row that outlives its faction's hold locks the player out of
    // every future faction on that server, forever.
    const factionId = await seedReservedFaction();   // existing helper in this file
    await db.insert(factionMembers).values({
      factionId, serverId, dayzId: PLAYER, discordId: "d1", role: "leader", joinedAt: new Date(),
    });

    const lapsed = await store.lapseReservations(serverId, new Date("2026-08-01T00:00:00Z"));

    expect(lapsed).toBe(1);
    const rows = await db.select().from(factionMembers).where(eq(factionMembers.factionId, factionId));
    expect(rows).toEqual([]);
  });
```

If `seedReservedFaction` does not exist, write the faction insert inline with `status: "reserved"` and a `reservedUntil` before the cutoff.

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/bot test ceremony-store`

Expected: FAIL — the membership row is still present.

- [ ] **Step 3: Delete the roster in the same transaction**

```ts
  /**
   * Lapse expired reservations and RELEASE their rosters.
   *
   * ⚠️ The delete is not cleanup. `faction_members_server_player_uniq` carries
   * no status predicate, so a membership row surviving its faction's hold bars
   * that player from every future faction on the server, permanently, with no
   * command able to clear it. One transaction: a faction never exists in the
   * state "lapsed but still rostered".
   */
  async lapseReservations(serverId: number, cutoff: Date): Promise<number> {
    return this.db.transaction(async (tx) => {
      const done = await tx.update(factions)
        .set({ status: "lapsed" })
        .where(and(
          eq(factions.serverId, serverId),
          eq(factions.status, "reserved"),
          lte(factions.reservedUntil, cutoff),
        ))
        .returning({ id: factions.id });
      if (done.length > 0) {
        await tx.delete(factionMembers)
          .where(inArray(factionMembers.factionId, done.map((d) => d.id)));
      }
      return done.length;
    });
  }
```

Add `inArray` to the `drizzle-orm` import and `factionMembers` to the `@factions/db` import if absent.

- [ ] **Step 4: Run the tests**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/bot test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/ceremony-store.ts apps/bot/test/ceremony-store.test.ts
git commit -m "fix(bot): lapsing a reservation releases its roster"
```

---

### Task 3: `RosterStore` reads and server-context resolution

**Files:**
- Create: `apps/bot/src/roster-store.ts`
- Create: `apps/bot/src/roster-context.ts`
- Test: `apps/bot/test/roster-store.test.ts` (create), `apps/bot/test/roster-context.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's schema
- Produces: everything below — later tasks import these names verbatim.

```ts
export type Role = "leader" | "officer" | "member";

export type Membership = {
  factionId: number; serverId: number; serverName: string;
  factionName: string; tag: string; role: Role;
};

export type RosterEntry = {
  dayzId: string; discordId: string; gamertag: string | null; role: Role; joinedAt: Date;
};

export type FactionCard = {
  id: number; serverId: number; serverName: string;
  name: string; tag: string; texture: string; status: string;
  poleKey: string; memberCount: number; leaderDiscordId: string; createdAt: Date;
};
```

- [ ] **Step 1: Write the failing tests**

Create `apps/bot/test/roster-context.test.ts`. `resolveServerContext` is pure — it takes memberships already fetched and an optional requested server id.

```ts
import { describe, it, expect } from "vitest";
import { resolveServerContext } from "../src/roster-context.js";
import type { Membership } from "../src/roster-store.js";

const m = (serverId: number, serverName: string): Membership => ({
  factionId: serverId * 10, serverId, serverName,
  factionName: `F${serverId}`, tag: `T${serverId}`, role: "leader",
});

describe("resolveServerContext", () => {
  it("uses the only membership when there is one", () => {
    expect(resolveServerContext([m(1, "S1")], null)).toEqual({ kind: "ok", membership: m(1, "S1") });
  });

  it("refuses when the player holds no faction", () => {
    expect(resolveServerContext([], null)).toEqual({ kind: "no-faction" });
  });

  it("asks which server when the player holds several and named none", () => {
    const r = resolveServerContext([m(1, "S1"), m(2, "S2")], null);
    expect(r).toEqual({ kind: "ambiguous", choices: [m(1, "S1"), m(2, "S2")] });
  });

  it("uses the named server when the player holds several", () => {
    expect(resolveServerContext([m(1, "S1"), m(2, "S2")], 2)).toEqual({ kind: "ok", membership: m(2, "S2") });
  });

  it("refuses a named server the player holds no faction on", () => {
    expect(resolveServerContext([m(1, "S1"), m(2, "S2")], 3)).toEqual({ kind: "not-on-server" });
  });

  it("honours a named server even when it is the only one", () => {
    // A stale autocomplete choice must not silently act on a different faction.
    expect(resolveServerContext([m(1, "S1")], 9)).toEqual({ kind: "not-on-server" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -F @factions/bot test roster-context`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `roster-context.ts`**

```ts
import type { Membership } from "./roster-store.js";

export type ServerContext =
  | { kind: "ok"; membership: Membership }
  | { kind: "no-faction" }
  | { kind: "not-on-server" }
  | { kind: "ambiguous"; choices: Membership[] };

/**
 * Decide which faction a roster command acts on.
 *
 * A player holds at most one faction per server but may hold several across
 * servers, so a bare command is ambiguous for them and unambiguous for
 * everyone else. An explicitly named server always wins — including when the
 * player holds exactly one faction, because a stale autocomplete choice must
 * refuse rather than quietly act on a different faction than the one named.
 */
export function resolveServerContext(
  memberships: Membership[],
  requestedServerId: number | null,
): ServerContext {
  if (requestedServerId !== null) {
    const found = memberships.find((m) => m.serverId === requestedServerId);
    return found ? { kind: "ok", membership: found } : { kind: "not-on-server" };
  }
  if (memberships.length === 0) return { kind: "no-faction" };
  if (memberships.length === 1) return { kind: "ok", membership: memberships[0]! };
  return { kind: "ambiguous", choices: memberships };
}
```

- [ ] **Step 4: Write the store reads**

Create `apps/bot/src/roster-store.ts` with the types from **Interfaces** above, the `RosterStore` interface below, and a `PgRosterStore` implementing the read methods. Write methods land in Tasks 4–7; declare them in the interface now so later tasks add implementations rather than reshaping the type.

```ts
export interface RosterStore {
  // Reads (this task)
  membershipsFor(discordId: string): Promise<Membership[]>;
  linkFor(discordId: string): Promise<{ dayzId: string; gamertag: string } | null>;
  linkForDayzId(dayzId: string): Promise<{ discordId: string; gamertag: string } | null>;
  memberOf(factionId: number, discordId: string): Promise<{ dayzId: string; role: Role } | null>;
  rosterOf(factionId: number): Promise<RosterEntry[]>;
  factionById(factionId: number): Promise<FactionCard | null>;
  factionByName(name: string): Promise<FactionCard | null>;
  cooldownUntil(serverId: number, dayzId: string): Promise<Date | null>;

  // Writes (Tasks 4-7)
  createInvite(a: CreateInviteArgs): Promise<CreateInviteOutcome>;
  pendingInvitesFor(dayzId: string, at: Date): Promise<PendingInvite[]>;
  acceptInvite(inviteId: number, discordId: string, at: Date): Promise<AcceptInviteOutcome>;
  declineInvite(inviteId: number, discordId: string, at: Date): Promise<boolean>;
  kick(a: KickArgs): Promise<KickOutcome>;
  leave(a: LeaveArgs): Promise<LeaveOutcome>;
  setRole(a: SetRoleArgs): Promise<SetRoleOutcome>;
  transfer(a: TransferArgs): Promise<TransferOutcome>;
  disband(factionId: number, discordId: string): Promise<"ok" | "not-leader">;
  rename(a: RenameArgs): Promise<RenameOutcome>;
}
```

`membershipsFor` joins `faction_members` → `factions` → `servers`, filters `factions.status` to the three holding statuses, and orders by `servers.name` so autocomplete is stable. `rosterOf` left-joins `identity_links` on `dayz_id` for the gamertag — left, not inner, because a link can be removed and a roster entry must still render. Order `rosterOf` by role (leader, officer, member) then `joinedAt`.

`cooldownUntil` returns the `until` instant only when it is in the future; an expired row is `null`, so callers never compare dates themselves.

- [ ] **Step 5: Write the store test**

Create `apps/bot/test/roster-store.test.ts` following `apps/bot/test/ceremony-store.test.ts`'s setup (create client, run migrations, truncate, seed a server and a faction). Cover:

```ts
  it("lists only holding factions", async () => {
    // A lapsed faction's rows are deleted (Task 2), but a DORMANT one's are
    // not — so the status filter is doing real work, not duplicating that.
    await seedMembership({ status: "active", name: "Live" });
    await seedMembership({ status: "disbanded", name: "Gone" });
    const rows = await store.membershipsFor("d1");
    expect(rows.map((r) => r.factionName)).toEqual(["Live"]);
  });

  it("returns a roster entry with a null gamertag when the link is gone", async () => {
    // A left join, not an inner one: /unlink can remove the link, and the
    // roster must still render rather than silently losing a member.
    await db.delete(identityLinks).where(eq(identityLinks.dayzId, PLAYER));
    const [entry] = await store.rosterOf(factionId);
    expect(entry!.dayzId).toBe(PLAYER);
    expect(entry!.gamertag).toBeNull();
  });

  it("reports no cooldown once it has expired", async () => {
    await db.insert(rosterCooldowns).values({ serverId, dayzId: PLAYER, until: new Date("2026-01-01T00:00:00Z") });
    expect(await store.cooldownUntil(serverId, PLAYER)).toBeNull();
  });
```

- [ ] **Step 6: Run the tests**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/bot test roster`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/bot/src/roster-store.ts apps/bot/src/roster-context.ts apps/bot/test/roster-store.test.ts apps/bot/test/roster-context.test.ts
git commit -m "feat(bot): roster store reads and server-context resolution"
```

---

### Task 4: Invitations — create, list, accept, decline

**Files:**
- Modify: `apps/bot/src/roster-store.ts`
- Create: `apps/bot/src/roster-commands.ts`
- Test: `apps/bot/test/roster-invites.test.ts` (create), `apps/bot/test/roster-commands.test.ts` (create)

**Interfaces:**
- Consumes: `RosterStore`, `Membership`, `resolveServerContext`
- Produces:

```ts
export type RosterReply = {
  content: string;
  ephemeral: boolean;
  prompt?: RosterPrompt;
  /**
   * A direct message the Discord layer should attempt after replying.
   *
   * ⚠️ The handler cannot send it: handlers are pure over the store and have
   * no client. It also cannot know whether it landed, which the inviter needs
   * to be told — so the Discord layer appends the outcome to the reply. See
   * Task 9, Step 4a.
   */
  dm?: { discordId: string; content: string; onFailure: string };
};
export type RosterPrompt =
  | { kind: "confirm-transfer"; factionId: number; targetDiscordId: string }
  | { kind: "confirm-disband"; factionId: number };

export type RosterDeps = {
  store: RosterStore;
  now: () => Date;
  inviteTtlMs: number;        // 604_800_000
  cooldownMs: number;         // 259_200_000
  renameCooldownMs: number;   // 604_800_000
};

export type CreateInviteArgs = {
  factionId: number; serverId: number;
  inviteeDiscordId: string; inviteeDayzId: string; invitedByDiscordId: string;
  at: Date; expiresAt: Date;
};
export type CreateInviteOutcome = "ok" | "already-member" | "cooldown" | "not-holding";
export type PendingInvite = {
  id: number; factionId: number; factionName: string; tag: string;
  serverId: number; serverName: string; expiresAt: Date;
};
export type AcceptInviteOutcome = "ok" | "gone" | "already-member" | "cooldown" | "not-holding";
```

- [ ] **Step 1: Write the failing store test**

Create `apps/bot/test/roster-invites.test.ts`:

```ts
  it("refreshes an expired offer rather than inserting a second", async () => {
    // ⚠️ The pending index cannot include `expires_at > now()` (a partial index
    // predicate must be IMMUTABLE), so a lapsed offer still occupies the slot.
    // Re-inviting must therefore UPDATE it, not collide with it.
    await store.createInvite({ ...base, at: t0, expiresAt: new Date(t0.getTime() + 1000) });
    const r = await store.createInvite({ ...base, at: t1, expiresAt: new Date(t1.getTime() + 1000) });
    expect(r).toBe("ok");
    const rows = await db.select().from(factionInvites);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expiresAt.getTime()).toBe(t1.getTime() + 1000);
  });

  it("refuses to invite someone already on a faction on that server", async () => { /* -> "already-member" */ });
  it("refuses to invite someone on cooldown", async () => { /* -> "cooldown" */ });
  it("refuses to invite into a lapsed faction", async () => { /* -> "not-holding" */ });

  it("does not accept an expired invite", async () => {
    await store.createInvite({ ...base, at: t0, expiresAt: t0 });
    expect(await store.acceptInvite(inviteId, "d9", new Date(t0.getTime() + 1))).toBe("gone");
  });

  it("does not accept someone else's invite", async () => {
    // The invite id rides in a button custom id, which is guessable.
    expect(await store.acceptInvite(inviteId, "not-the-invitee", t1)).toBe("gone");
  });

  it("accepting twice adds one member", async () => {
    expect(await store.acceptInvite(inviteId, "d9", t1)).toBe("ok");
    expect(await store.acceptInvite(inviteId, "d9", t1)).toBe("gone");
    const rows = await db.select().from(factionMembers).where(eq(factionMembers.factionId, factionId));
    expect(rows).toHaveLength(2);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/bot test roster-invites`
Expected: FAIL — `createInvite` is not implemented.

- [ ] **Step 3: Implement the invite writes**

`createInvite` upserts on the pending index:

```ts
  async createInvite(a: CreateInviteArgs): Promise<CreateInviteOutcome> {
    return this.db.transaction(async (tx) => {
      const [f] = await tx.select({ id: factions.id }).from(factions)
        .where(and(eq(factions.id, a.factionId), inArray(factions.status, HOLDING)));
      if (!f) return "not-holding" as const;

      const [existing] = await tx.select({ id: factionMembers.id }).from(factionMembers)
        .where(and(eq(factionMembers.serverId, a.serverId), eq(factionMembers.dayzId, a.inviteeDayzId)));
      if (existing) return "already-member" as const;

      const [cd] = await tx.select({ until: rosterCooldowns.until }).from(rosterCooldowns)
        .where(and(eq(rosterCooldowns.serverId, a.serverId), eq(rosterCooldowns.dayzId, a.inviteeDayzId)));
      if (cd && cd.until > a.at) return "cooldown" as const;

      // ⚠️ Refresh, do not insert. The pending index has no expiry term, so a
      // lapsed offer still holds the slot.
      await tx.insert(factionInvites)
        .values({
          factionId: a.factionId, serverId: a.serverId,
          inviteeDiscordId: a.inviteeDiscordId, inviteeDayzId: a.inviteeDayzId,
          invitedByDiscordId: a.invitedByDiscordId,
          createdAt: a.at, expiresAt: a.expiresAt,
        })
        .onConflictDoUpdate({
          target: [factionInvites.factionId, factionInvites.inviteeDayzId],
          targetWhere: sql`accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL`,
          set: { expiresAt: a.expiresAt, createdAt: a.at, invitedByDiscordId: a.invitedByDiscordId },
        });
      return "ok" as const;
    });
  }
```

These three reads are advisory — they produce a good message. The **binding** checks are on `acceptInvite`, which is where the race actually matters:

```ts
  /**
   * ⚠️ Every precondition is part of the write. The invite id travels in a
   * button custom id, so the invitee check is a security guard, not a
   * convenience: without it anyone who can guess an id joins a faction they
   * were never offered.
   */
  async acceptInvite(inviteId: number, discordId: string, at: Date): Promise<AcceptInviteOutcome> {
    try {
      return await this.db.transaction(async (tx) => {
        const claimed = await tx.update(factionInvites)
          .set({ acceptedAt: at })
          .where(and(
            eq(factionInvites.id, inviteId),
            eq(factionInvites.inviteeDiscordId, discordId),
            isNull(factionInvites.acceptedAt),
            isNull(factionInvites.declinedAt),
            isNull(factionInvites.revokedAt),
            gt(factionInvites.expiresAt, at),
          ))
          .returning();
        const inv = claimed[0];
        if (!inv) return "gone" as const;

        const [f] = await tx.select({ id: factions.id }).from(factions)
          .where(and(eq(factions.id, inv.factionId), inArray(factions.status, HOLDING)));
        if (!f) return "not-holding" as const;   // rolls back via the thrown-free return? NO — see below

        const [cd] = await tx.select({ until: rosterCooldowns.until }).from(rosterCooldowns)
          .where(and(eq(rosterCooldowns.serverId, inv.serverId), eq(rosterCooldowns.dayzId, inv.inviteeDayzId)));
        if (cd && cd.until > at) return "cooldown" as const;

        await tx.insert(factionMembers).values({
          factionId: inv.factionId, serverId: inv.serverId,
          dayzId: inv.inviteeDayzId, discordId, role: "member", joinedAt: at,
        });
        return "ok" as const;
      });
    } catch (err) {
      if (String(err).includes("faction_members_server_player_uniq")) return "already-member";
      throw err;
    }
  }
```

⚠️ **Read this before implementing:** returning early from inside a Drizzle transaction callback **commits** it — it does not roll back. The `not-holding` and `cooldown` branches above would therefore consume the invite while adding no member. Fix it by throwing a sentinel and translating it outside, or by checking those two conditions *before* the update. Choose one, implement it, and prove it with a test asserting the invite is still pending after a `cooldown` result.

- [ ] **Step 4: Write the handlers**

Create `apps/bot/src/roster-commands.ts` with `handleFactionInvite`, `handleFactionInvites`, `handleInviteAccept`, `handleInviteDecline`. Each resolves context via `resolveServerContext`, checks the actor's role, and maps store outcomes to replies. Every reply is `ephemeral: true`.

`handleFactionInvite` refuses when the actor is a plain member ("Only the leader and officers can invite."), when the invitee has no linked UID ("**@name** has not linked a character yet — they need to run `/link` first."), and reports each store outcome distinctly.

- [ ] **Step 5: Write the handler tests**

Create `apps/bot/test/roster-commands.test.ts` with a fake `RosterStore` (a plain object, as `faction-commands.test.ts` does). Assert every refusal path returns the exact message and that no store write is attempted when a guard refuses.

- [ ] **Step 6: Run the tests**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/bot test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/bot/src apps/bot/test
git commit -m "feat(bot): faction invitations"
```

---

### Task 5: Kick and leave, with cooldowns

**Files:**
- Modify: `apps/bot/src/roster-store.ts`, `apps/bot/src/roster-commands.ts`
- Test: `apps/bot/test/roster-departures.test.ts` (create), `apps/bot/test/roster-commands.test.ts`

**Interfaces:**
- Produces:

```ts
export type KickArgs = { factionId: number; actorDiscordId: string; targetDiscordId: string; at: Date; until: Date };
export type KickOutcome = "ok" | "not-permitted" | "target-not-member" | "cannot-kick-self" | "cannot-kick-officer" | "cannot-kick-leader";
export type LeaveArgs = { factionId: number; discordId: string; at: Date; until: Date };
export type LeaveOutcome = "ok" | "not-member" | "leader-must-transfer";
```

- [ ] **Step 1: Write the failing tests**

```ts
  it("an officer cannot kick another officer", async () => { /* -> "cannot-kick-officer" */ });
  it("an officer cannot kick the leader", async () => { /* -> "cannot-kick-leader" */ });
  it("the leader can kick an officer", async () => { /* -> "ok" */ });
  it("nobody kicks themselves", async () => { /* -> "cannot-kick-self" */ });
  it("a kick writes a cooldown", async () => { /* rosterCooldowns row with `until` */ });
  it("the leader cannot leave", async () => { /* -> "leader-must-transfer", member row intact */ });
  it("leaving writes the same cooldown a kick does", async () => { /* ... */ });

  it("extends an existing cooldown rather than shortening it", async () => {
    // Upsert must take the LATER of the two, or a quick rejoin-and-leave
    // would shorten a cooldown that is meant to be a floor.
    await store.leave({ ...args, until: far });
    await store.leave({ ...args, until: near });   // after rejoining
    const [row] = await db.select().from(rosterCooldowns);
    expect(row!.until.getTime()).toBe(far.getTime());
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/bot test roster-departures`
Expected: FAIL — `kick` is not implemented.

- [ ] **Step 3: Implement**

Both are one transaction: read the actor's and target's roles, delete the membership with the role condition in the `WHERE`, decide from `.returning()`, then upsert the cooldown with

```ts
        .onConflictDoUpdate({
          target: [rosterCooldowns.serverId, rosterCooldowns.dayzId],
          // The later of the two: a cooldown is a floor, never shortened.
          set: { until: sql`greatest(${rosterCooldowns.until}, excluded.until)` },
        });
```

`leave` refuses the leader by putting `ne(factionMembers.role, "leader")` in the delete's `WHERE` and distinguishing "no row deleted because not a member" from "no row deleted because leader" with one follow-up read — the read is for the *message*, not the decision.

- [ ] **Step 4: Add the handlers**

`handleFactionKick` and `handleFactionLeave`. The kick reply names the cooldown: "They cannot join a faction on **<server>** for 3 days."

- [ ] **Step 5: Run and commit**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/bot test
git add apps/bot && git commit -m "feat(bot): kick and leave, with the shared cooldown"
```

---

### Task 6: Promote, demote, transfer

**Files:**
- Modify: `apps/bot/src/roster-store.ts`, `apps/bot/src/roster-commands.ts`
- Test: `apps/bot/test/roster-roles.test.ts` (create), `apps/bot/test/roster-commands.test.ts`

**Interfaces:**
- Produces:

```ts
export type SetRoleArgs = { factionId: number; actorDiscordId: string; targetDiscordId: string; role: "officer" | "member" };
export type SetRoleOutcome = "ok" | "not-leader" | "target-not-member" | "cannot-target-leader";
export type TransferArgs = { factionId: number; fromDiscordId: string; toDiscordId: string; at: Date };
export type TransferOutcome = "ok" | "not-leader" | "target-not-member";
```

- [ ] **Step 1: Write the failing tests**

```ts
  it("only the leader promotes", async () => { /* officer actor -> "not-leader" */ });
  it("demote cannot target the leader", async () => { /* -> "cannot-target-leader" */ });
  it("transfer swaps both roles in one transaction", async () => {
    expect(await store.transfer({ factionId, fromDiscordId: "d1", toDiscordId: "d2", at })).toBe("ok");
    const rows = await db.select().from(factionMembers).where(eq(factionMembers.factionId, factionId));
    expect(rows.find((r) => r.discordId === "d1")!.role).toBe("officer");
    expect(rows.find((r) => r.discordId === "d2")!.role).toBe("leader");
  });
  it("a transfer by a non-leader changes nothing", async () => { /* -> "not-leader", roles unchanged */ });
  it("transferring to a non-member changes nothing", async () => { /* -> "target-not-member", roles unchanged */ });
```

- [ ] **Step 2: Run to verify failure**

Expected: FAIL — `setRole` is not implemented.

- [ ] **Step 3: Implement**

`transfer` demotes the old leader **first**, then promotes the target, both inside one transaction with the caller's leadership in the demote's `WHERE`. Order matters: `faction_members_leader_uniq` permits only one leader at a time, so promoting first would violate the index against the still-seated leader. Add that reasoning as a comment — it is the kind of ordering a later refactor will otherwise "tidy".

- [ ] **Step 4: Add the handlers**

`handleFactionPromote`, `handleFactionDemote`, `handleFactionTransfer`. Transfer returns `prompt: { kind: "confirm-transfer", factionId, targetDiscordId }` rather than acting immediately — §6 requires confirmation. The store call happens on the button, in Task 9's routing.

- [ ] **Step 5: Run and commit**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/bot test
git add apps/bot && git commit -m "feat(bot): promote, demote, and leadership transfer"
```

---

### Task 7: Disband and rename

**Files:**
- Modify: `apps/bot/src/roster-store.ts`, `apps/bot/src/roster-commands.ts`
- Test: `apps/bot/test/roster-lifecycle.test.ts` (create)

**Interfaces:**
- Produces:

```ts
export type RenameArgs = { factionId: number; discordId: string; name: string; at: Date; notBefore: Date };
export type RenameOutcome = "ok" | "not-leader" | "cooldown";
```

- [ ] **Step 1: Write the failing tests**

```ts
  it("disbanding releases flag, tag, pole and roster", async () => {
    expect(await store.disband(factionId, "d1")).toBe("ok");
    const [f] = await db.select().from(factions).where(eq(factions.id, factionId));
    expect(f!.status).toBe("disbanded");
    expect(await db.select().from(factionMembers).where(eq(factionMembers.factionId, factionId))).toEqual([]);
    // The releasing indexes are partial over the holding statuses, so the
    // texture is immediately re-claimable by someone else.
    await db.insert(factions).values({ /* same serverId + same texture */ });
  });

  it("disbanding writes no cooldowns", async () => {
    await store.disband(factionId, "d1");
    expect(await db.select().from(rosterCooldowns)).toEqual([]);
  });

  it("a rename inside the cooldown is refused and changes nothing", async () => {
    await store.rename({ factionId, discordId: "d1", name: "First", at: t0, notBefore: past });
    const r = await store.rename({ factionId, discordId: "d1", name: "Second", at: t1, notBefore: t1MinusSixDays });
    expect(r).toBe("cooldown");
    const [f] = await db.select().from(factions).where(eq(factions.id, factionId));
    expect(f!.name).toBe("First");
  });

  it("a first rename is always allowed", async () => { /* renamedAt null -> "ok" */ });
```

- [ ] **Step 2: Run to verify failure**

Expected: FAIL — `disband` is not implemented.

- [ ] **Step 3: Implement**

`disband` is one transaction: update status to `disbanded` guarded on `leader_discord_id = discordId` and status in the holding set, then delete the roster if the update returned a row. No cooldowns.

`rename` is a single guarded statement:

```ts
      .where(and(
        eq(factions.id, a.factionId),
        eq(factions.leaderDiscordId, a.discordId),
        inArray(factions.status, HOLDING),
        // Null means never renamed. A cooldown is a floor on the LAST rename,
        // so `notBefore` is `now - renameCooldownMs`, computed by the caller.
        or(isNull(factions.renamedAt), lte(factions.renamedAt, a.notBefore)),
      ))
```

Distinguish `not-leader` from `cooldown` with one follow-up read for the message only.

- [ ] **Step 4: Add the handlers**

`handleFactionDisband` returns `prompt: { kind: "confirm-disband", factionId }`; the store call happens on the button. `handleFactionRename` validates the name: 3–64 characters after trimming, and control characters (`/[\p{Cc}\p{Cf}]/u`) rejected. §10 derives channel names from the tag or id, never the raw name, so the display name needs bounds, not blandness.

- [ ] **Step 5: Run and commit**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/bot test
git add apps/bot && git commit -m "feat(bot): disband and rename"
```

---

### Task 8: Public `info` and `roster`, and the `/unlink` gate

**Files:**
- Modify: `apps/bot/src/roster-commands.ts`, `apps/bot/src/commands.ts`, `apps/bot/src/store.ts`
- Test: `apps/bot/test/roster-commands.test.ts`, `apps/bot/test/commands.test.ts`

**Interfaces:**
- Consumes: `RosterStore.factionByName`, `factionById`, `rosterOf`, `membershipsFor`
- Produces: `handleFactionInfo`, `handleFactionRoster` — both `ephemeral: false`

- [ ] **Step 1: Write the failing test for the gate**

In `apps/bot/test/commands.test.ts`:

```ts
  it("refuses to unlink a faction leader", async () => {
    const r = await handleUnlink(deps, "d1");   // deps.store reports a leader membership
    expect(r.content).toMatch(/transfer/i);
    expect(store.deleted).toBe(false);
  });

  it("refuses to unlink an ordinary member", async () => {
    const r = await handleUnlink(deps, "d2");
    expect(r.content).toMatch(/faction/i);
    expect(store.deleted).toBe(false);
  });

  it("still unlinks someone on no roster", async () => {
    const r = await handleUnlink(deps, "d3");
    expect(store.deleted).toBe(true);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -F @factions/bot test commands`
Expected: FAIL — `handleUnlink` deletes unconditionally.

- [ ] **Step 3: Add the gate**

Add `factionMembershipsFor(discordId): Promise<{ factionName: string; role: Role }[]>` to `VerificationStore` in `apps/bot/src/store.ts` and implement it on the Pg class. In `handleUnlink`, check it first:

```ts
/**
 * ⚠️ Gated on roster membership. Unlinking is what binds a Discord account to
 * a UID, and a faction's leader is identified by their Discord id — so
 * unlinking a leader orphans the faction into exactly the frozen state §6's
 * succession mechanic exists to prevent, reachable in one command.
 */
```

A leader is told to transfer or disband; a member is told to leave first. Name the faction in both messages.

- [ ] **Step 4: Write `info` and `roster`**

`handleFactionInfo(deps, discordId, name | null)`: with a name, look it up; without one, use the caller's own membership through `resolveServerContext`. Renders name, tag, flag, status, member count, pole key and founding date. `handleFactionRoster` renders the roster grouped by role, with gamertags, falling back to the Discord mention when the gamertag is null. Both `ephemeral: false`.

- [ ] **Step 5: Run and commit**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/bot test
git add apps/bot && git commit -m "feat(bot): public faction info and roster, and gate /unlink"
```

---

### Task 9: Discord registration, routing, buttons, and autocomplete

**Files:**
- Modify: `apps/bot/src/discord.ts`
- Test: `apps/bot/test/discord.test.ts`, `apps/bot/test/faction-wiring.test.ts`

**Interfaces:**
- Consumes: every handler from Tasks 4–8
- Produces: custom-id builders and parsers

```ts
export const INVITE_ACCEPT_PREFIX = "invite-accept:";
export const INVITE_DECLINE_PREFIX = "invite-decline:";
export const TRANSFER_PREFIX = "roster-transfer:";
export const DISBAND_PREFIX = "roster-disband:";
```

- [ ] **Step 1: Write the failing tests**

```ts
  it("registers every roster subcommand", () => {
    const faction = buildCommands().find((c) => c.name === "faction")!;
    const names = (faction.options ?? []).map((o: any) => o.name).sort();
    expect(names).toEqual([
      "claim", "demote", "disband", "info", "invite", "invites",
      "kick", "leave", "promote", "rename", "roster", "transfer",
    ]);
  });

  it("parses a transfer custom id and rejects a foreign one", () => {
    expect(parseTransferCustomId("roster-transfer:12:d9")).toEqual({ factionId: 12, targetDiscordId: "d9" });
    expect(parseTransferCustomId("claim-confirm:12")).toBeNull();
  });

  it("keeps every custom id inside Discord's 100-character cap", () => {
    // A Discord custom id longer than 100 chars is rejected at send time, so
    // the message never renders and the player sees nothing at all.
    expect(transferCustomId(9_007_199_254_740_991, "1".repeat(20)).length).toBeLessThanOrEqual(100);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -F @factions/bot test discord`
Expected: FAIL — the subcommands are absent.

- [ ] **Step 3: Register the subcommands**

Add eleven `.addSubcommand(...)` calls beside the existing `claim`. Every command that can be ambiguous (`invite`, `kick`, `promote`, `demote`, `transfer`, `leave`, `disband`, `rename`, `roster`, `info`) takes an optional `server` string option with `.setAutocomplete(true)`. `invite`, `kick`, `promote`, `demote` and `transfer` take a required `user` option.

- [ ] **Step 4: Route them**

Extend the chat-input branch of `start()` to dispatch on `interaction.options.getSubcommand()`, and add a button branch handling the four prefixes. Each parser returns `null` for a custom id that is not its own, and the router must check the id **before** deferring — Discord delivers every component interaction in the guild, and deferring one you will never answer leaves someone else's button stuck on "thinking". That reasoning is already written on `respondToClaimConfirm`; follow it.

The `server` autocomplete responds with the caller's own memberships only, formatted `name: server name, value: server id`.

- [ ] **Step 4a: Deliver invitations by DM**

Spec §2.5: an invitation arrives as a DM carrying the accept and decline buttons. After replying to any handler whose `RosterReply` carries `dm`, attempt it:

```ts
    if (reply.dm) {
      try {
        const user = await client.users.fetch(reply.dm.discordId);
        await user.send({ content: reply.dm.content, components: [inviteButtons(inviteId)] });
      } catch (err) {
        // ⚠️ Not an error path — a closed DM is ordinary. The invitation is
        // already durable, and `/faction invites` is the pull route that makes
        // it reachable. What matters is that the INVITER is told, or they will
        // wait on someone who never saw anything.
        console.warn("invite DM failed", err);
        await interaction.followUp({ content: reply.dm.onFailure, flags: MessageFlags.Ephemeral });
      }
    }
```

Test it with a fake client whose `users.fetch` rejects, and assert the follow-up text names `/faction invites`.

- [ ] **Step 5: Run and commit**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/bot test
git add apps/bot && git commit -m "feat(bot): wire the roster commands into Discord"
```

---

### Task 10: Concurrency proofs and the acceptance document

**Files:**
- Test: `apps/bot/test/roster-races.test.ts` (create)
- Create: `docs/acceptance/2026-08-31-roster-core.md`

**Interfaces:**
- Consumes: everything

The rules in this plan *are* indexes. A test that runs two statements one after the other proves nothing about a constraint whose entire job is deciding a race, so these run genuinely concurrently with `Promise.all` over two separate connections.

- [ ] **Step 1: Write the race tests**

```ts
  it("two factions' invites accepted at the same instant yield one membership", async () => {
    const [r1, r2] = await Promise.all([
      storeA.acceptInvite(inviteToFaction1, "d9", at),
      storeB.acceptInvite(inviteToFaction2, "d9", at),
    ]);
    expect([r1, r2].filter((r) => r === "ok")).toHaveLength(1);
    expect([r1, r2].filter((r) => r === "already-member")).toHaveLength(1);
    const rows = await db.select().from(factionMembers).where(eq(factionMembers.dayzId, PLAYER));
    expect(rows).toHaveLength(1);
  });

  it("two simultaneous transfers cannot both succeed", async () => {
    const [r1, r2] = await Promise.all([
      storeA.transfer({ factionId, fromDiscordId: "d1", toDiscordId: "d2", at }),
      storeB.transfer({ factionId, fromDiscordId: "d1", toDiscordId: "d3", at }),
    ]);
    expect([r1, r2].filter((r) => r === "ok")).toHaveLength(1);
    const leaders = (await db.select().from(factionMembers)
      .where(eq(factionMembers.factionId, factionId))).filter((r) => r.role === "leader");
    expect(leaders).toHaveLength(1);
  });

  it("a kick racing the target's own leave leaves one cooldown and no member", async () => { /* ... */ });
```

If a race surfaces a serialization error rather than a constraint violation, catch it in the store and map it to the same outcome the constraint would have produced — a player must never see a Postgres error string.

- [ ] **Step 2: Run them**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/bot test roster-races`
Expected: PASS. Run three times; a race test that passes once may be passing by scheduling luck.

- [ ] **Step 3: Write the acceptance document**

Create `docs/acceptance/2026-08-31-roster-core.md` following `docs/acceptance/2026-08-31-ceremony-detection.md`. Record the fixture-level evidence with real command output, and add the staged gate **unchecked**:

```markdown
- [ ] **Staged (requires a Discord guild and human hands).** Found a faction,
      invite a second player, have them accept, promote them, transfer
      leadership, kick a third player and confirm the cooldown blocks their
      re-invite, then disband and confirm the flag returns to the pool.
```

State plainly that no roster command has been exercised against a real Discord client, and that this gate joins the two already open: Plan 3's staged ceremony and the live Nitrado tick.

- [ ] **Step 4: Run the whole suite**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`
Expected: every task successful. Record the totals in the acceptance doc.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/test/roster-races.test.ts docs/acceptance/2026-08-31-roster-core.md
git commit -m "test(bot): roster concurrency proofs, and the acceptance record"
```
