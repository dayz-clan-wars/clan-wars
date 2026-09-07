# Player Stats (increment 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every linked player has a public profile and the server has public boards — play time, sessions, last seen, PvP kills and deaths, K/D, killed-by and killed lists, friendly fire, raid credits, upkeep raises, clan history — per season and all-time, plus the same boards filtered to a clan's roster on `/clan/board`.

**Architecture:** Two new log consumers in the bot project `events` into two new tables: the **sessions consumer** turns `player.connected`/`player.disconnected` into `player_sessions` rows and closes every open session on a server when the log rolls to a new ADM file (the `AdminLog started` boundary, `close_reason = 'restart'`); the **kills consumer** turns `player.killed`/`player.died` into `kills` rows, resolving each party's clan and `friendly_fire` **at the moment of the kill** from a new `membership_history` table. That table is filled by a **membership reconciler** (the 3b pattern): every tick it diffs `faction_members` (full only) against its own open rows, so no roster write path changes and roster invariants stay untouched (§11 ⚠️). The parser gains five event types from One Life's regexes, re-anchored on the identity group. The site reads it all through three new `@factions/roster` exports; `/players` and `/players/{gamertag}` are public, `/clan/board` is clan-level. Kills are stats, never points: nothing here touches `season_standings`.

**Tech Stack:** drizzle-orm 0.36 (one migration, 0026), postgres.js, vitest, Next 16 pages.

**Spec:** `docs/superpowers/specs/2026-09-04-clan-wars-target-state-design.md` — §4.9 (`player_sessions`, `kills`), §6 (kill/death/session/teleport lines, new event types), §7 (sessions + kills consumer), §10.2 (`/players`, `/players/{gamertag}`, `/clan/board`), §11 (every stat's derivation; "kills are stats, never points"), §13 (rebuild scripts), §15 row 6.

## Global Constraints

- **Kills are stats, never points (§11).** No code path from `kills` to `season_standings`, `raids`, `alpha_weeks` or `season_results`. `packages/roster/test/exports.test.ts`'s forbidden-substring test stays green.
- **Every parser regex anchors on the identity group** `(id=[0-9A-F]{40}…)`; gamertags are attacker-controlled (§6, §14). A kill line has two identity groups; both are anchored.
- **Non-player deaths are `kills` rows with `killer_dayz_id null`** so death counts are honest; PvP counts filter on a non-null killer (§4.9). A bare `(DEAD)` marker with no death verb is **not** a death (One Life's rule; the PlayerList re-lists corpses).
- **`friendly_fire` = both parties were full members of the same clan at `occurred_at`** (§4.9), read from `membership_history`, never from current membership.
- **An open session is closed at the next `AdminLog started` boundary with `close_reason = 'restart'`** (§4.9). The boundary is visible to a consumer as the first event of a new `adm_file_id` on that server; the close instant is that file's `adm_files.boot_at`.
- **K/D appears on boards only at ≥ `KD_MIN_KILLS` (10) PvP kills** (§11, `rules.ts`); a profile always shows the raw numbers.
- **"Per season" means the window `[seasons.started_at, coalesce(ended_at, now))`** of the named season on the active server; "all-time" is no window. Kills and sessions are never deleted by the wipe.
- **Names only (§11).** Killed-by / killed lists carry gamertags; no coordinate, weapon distance is a number of metres not a position. Nothing here posts to Discord.
- **`membership_history` is a projection** written only by the bot's reconciler; the roster package never writes it; no existing `faction_members` read, index or write changes (§11 ⚠️ — this is the ruling that keeps the increment off roster invariants). Departure instants are precise to one bot tick; joins are the `faction_members.joined_at` the row already carries (or the tick that saw the promotion to full).
- **Consumer names** `sessions-projector`, `kills-projector` and the reconciler's are distinct from every other consumer name. Both consumers commit their cursor per batch (the `player-tick.ts` pattern; both tables have a unique event key so a replay is a no-op).
- **Teleport lines are recorded as events and nothing else (§6).** The payload carries `from`/`to`, never a `pos` key, so `readFix` (increment 5) does not treat a teleport as a fix.
- `apps/web` imports only `@factions/roster` and `@factions/domain`; the export list grows by exactly `playerBoards`, `playerProfile`, `clanBoard`; both allowlists edited on purpose. No identifier under `apps/web` contains "faction". Every page reading the viewer or importing `@factions/roster` is `force-dynamic`. `/players` and `/players/` are added to the public gate lists (spec §10.2: public); `/clan/board` stays gated.
- Player-facing text says "clan", never "faction". Every number from `rules.ts` (`KD_MIN_KILLS`); no new guide number.
- Full gate before every commit: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force` → **26 successful, 26 total**. Never touch `factions_live`.
- Commit trailers: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01Svc2Dv7g1XwWi8CSuY4h5e`.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/db/migrations/0026_player_stats.sql`, `packages/db/src/schema.ts`, `packages/db/test/player-stats-schema.test.ts` | `player_sessions`, `kills`, `membership_history` |
| `packages/domain/src/events.ts` | five new event types |
| `packages/adm-parser/src/{session,death,teleport}.ts`, `parse-line.ts`, `index.ts`; `apps/ingest-worker/src/ingest.ts` | the lines |
| `apps/bot/src/membership-tick.ts` (create) | the reconciler + `membershipAt` |
| `apps/bot/src/sessions-tick.ts`, `apps/bot/src/kills-tick.ts` (create); `scripts/rebuild-sessions.ts`, `scripts/rebuild-kills.ts` | the consumers and their rebuilds |
| `apps/bot/src/discord.ts`, `apps/bot/README.md` | wiring |
| `packages/roster/src/stats.ts` (create), `src/index.ts`, `test/exports.test.ts`, `apps/web/test/smoke.test.ts` | `playerBoards`, `playerProfile`, `clanBoard` |
| `apps/web/app/players/page.tsx`, `app/players/[gamertag]/page.tsx`, `app/clan/board/page.tsx`, `lib/stats-copy.ts`, `lib/auth/gate.ts`, tests, links | the pages |
| `docs/deploy/2026-09-08-player-stats.md`, `CLAUDE.md`, spec §15 | operations |

---

### Task 1: Migration 0026 — `player_sessions`, `kills`, `membership_history`

**Files:**
- Create: `packages/db/migrations/0026_player_stats.sql` (generated, renamed, journal tag fixed), `packages/db/test/player-stats-schema.test.ts`
- Modify: `packages/db/src/schema.ts` (after `clanPins`)

**Interfaces:**
- Produces (schema exports): `playerSessions`, `kills`, `membershipHistory`.

**Ruling (`membership_history` instead of `faction_members.left_at`):** §11 says the `left_at` column belongs to the membership increment, which has shipped without it, and that the stats increment must not touch roster invariants. A projection table filled by a reconciler gives the same history with zero roster changes. Cost if wrong: departure times precise to a tick (10 s), not to the write.

- [ ] **Step 1: Schema** — add to `packages/db/src/schema.ts` after `clanPins`:

```ts
/** Connect → disconnect, or → the next ADM boundary (`restart`). Spec §4.9. */
export const playerSessions = pgTable("player_sessions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  dayzId: text("dayz_id").notNull(),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull(),
  connectEventId: bigint("connect_event_id", { mode: "number" }).notNull().references(() => events.id),
  disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
  closeReason: text("close_reason"),
}, (t) => ({
  reasonValid: check("player_sessions_reason_valid", sql`${t.closeReason} IS NULL OR ${t.closeReason} IN ('disconnect','restart')`),
  closedIffReason: check("player_sessions_closed_iff_reason", sql`(${t.disconnectedAt} IS NULL) = (${t.closeReason} IS NULL)`),
  uniqConnect: uniqueIndex("player_sessions_connect_uniq").on(t.connectEventId),
  openByPlayer: uniqueIndex("player_sessions_open_uniq").on(t.serverId, t.dayzId).where(sql`${t.disconnectedAt} IS NULL`),
  byPlayer: index("player_sessions_player_idx").on(t.serverId, t.dayzId, t.connectedAt),
}));

/**
 * Every death (spec §4.9). `killer_dayz_id` null = not a player (infected,
 * fall, vehicle, bled out…); PvP reads filter on it being set. Faction ids
 * and `friendly_fire` are resolved AT `occurred_at` from membership_history.
 * ⚠️ Stats, never points: nothing reads this into season_standings (§11).
 */
export const kills = pgTable("kills", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  eventId: bigint("event_id", { mode: "number" }).notNull().references(() => events.id),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  victimDayzId: text("victim_dayz_id").notNull(),
  killerDayzId: text("killer_dayz_id"),
  weapon: text("weapon"),
  distanceM: numeric("distance_m", { precision: 8, scale: 1 }),
  cause: text("cause").notNull(),
  victimFactionId: bigint("victim_faction_id", { mode: "number" }).references(() => factions.id),
  killerFactionId: bigint("killer_faction_id", { mode: "number" }).references(() => factions.id),
  friendlyFire: boolean("friendly_fire").notNull().default(false),
}, (t) => ({
  uniqEvent: uniqueIndex("kills_event_uniq").on(t.eventId),
  byVictim: index("kills_victim_idx").on(t.serverId, t.victimDayzId, t.occurredAt),
  byKiller: index("kills_killer_idx").on(t.serverId, t.killerDayzId, t.occurredAt),
}));

/**
 * Full-membership spans, one row per (clan, player, span), written only by
 * the bot's membership reconciler (spec §11: the stats increment never
 * touches roster invariants). `left_at` null = still a full member.
 */
export const membershipHistory = pgTable("membership_history", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  factionId: bigint("faction_id", { mode: "number" }).notNull().references(() => factions.id),
  dayzId: text("dayz_id").notNull(),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull(),
  leftAt: timestamp("left_at", { withTimezone: true }),
}, (t) => ({
  openUniq: uniqueIndex("membership_history_open_uniq").on(t.factionId, t.dayzId).where(sql`${t.leftAt} IS NULL`),
  byPlayer: index("membership_history_player_idx").on(t.serverId, t.dayzId, t.joinedAt),
}));
```

- [ ] **Step 2: Generate, rename, fix the journal** (`0026_player_stats`), read the SQL: three tables, the two checks, the two partial unique indexes, nothing dropped.
- [ ] **Step 3: Test** `packages/db/test/player-stats-schema.test.ts` (shape of `map-schema.test.ts`): (a) a second open session for the same player on the same server is rejected by `player_sessions_open_uniq` while a second closed one is fine; (b) setting `disconnected_at` without `close_reason` is rejected by `player_sessions_closed_iff_reason`, and `close_reason = 'timeout'` by `player_sessions_reason_valid`; (c) `kills` rejects a duplicate `event_id`; (d) `membership_history` rejects a second open row for the same (faction, player) and accepts one after the first has `left_at`.
- [ ] **Step 4: Run** the test, then the full gate → 26/26. **Commit** — `feat(db): migration 0026 — player_sessions, kills, membership_history`.

---

### Task 2: Parser — sessions, deaths, teleports

**Files:**
- Create: `packages/adm-parser/src/session.ts`, `src/death.ts`, `src/teleport.ts`, `test/session.test.ts`, `test/death.test.ts`, `test/teleport.test.ts`
- Modify: `packages/domain/src/events.ts`, `packages/adm-parser/src/parse-line.ts`, `src/index.ts`, `test/parse-line.test.ts`, `apps/ingest-worker/src/ingest.ts`

**Interfaces:**
- Produces: `EventType` gains `"player.connected" | "player.disconnected" | "player.killed" | "player.died" | "player.teleported"`.
- Payloads: connected/disconnected `{ dayzId, gamertag }`; killed `{ victimDayzId, victimGamertag, killerDayzId, killerGamertag, weapon: string|null, distanceM: number|null }`; died `{ victimDayzId, victimGamertag, cause, entity: string|null }` with `cause` one of `"bled_out" | "drowned" | "suicide" | "infected" | "animal" | "fall" | "vehicle" | "environment" | "died"`; teleported `{ dayzId, gamertag, from: Vec3, to: Vec3, reason }` — **no `pos` key** (§6: not a fix).

- [ ] **Step 1: Failing tests.** `death.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseDeath } from "../src/death.js";
const V = "A".repeat(40), K = "B".repeat(40);
describe("parseDeath", () => {
  it("reads a PvP kill with weapon and distance, both ids anchored", () => {
    expect(parseDeath(`10:00:00 | Player "Vic" (DEAD) (id=${V} pos=<1.0, 2.0, 3.0>) killed by Player "Kil" (id=${K} pos=<4.0, 5.0, 6.0>) with M4A1 from 153.4 meters`))
      .toEqual({ kind: "killed", victimDayzId: V, victimGamertag: "Vic", killerDayzId: K, killerGamertag: "Kil", weapon: "M4A1", distanceM: 153.4 });
  });
  it("reads a PvP kill without distance (melee)", () => {
    expect(parseDeath(`10:00:00 | Player "Vic" (DEAD) (id=${V}) killed by Player "Kil" (id=${K}) with Knife`)).toMatchObject({ kind: "killed", weapon: "Knife", distanceM: null });
  });
  it.each([
    [`killed by Zmb_Male_Farmer`, "infected", "Zmb_Male_Farmer"], [`killed by Animal_UrsusArctos`, "animal", "Animal_UrsusArctos"],
    [`killed by FallDamage`, "fall", "FallDamage"], [`killed by CivilianSedan`, "vehicle", "CivilianSedan"],
    [`killed by SomethingNew`, "environment", "SomethingNew"], [`bled out`, "bled_out", null], [`drowned`, "drowned", null],
    [`committed suicide`, "suicide", null], [`died.`, "died", null],
  ])("classifies '%s' as %s", (tail, cause, entity) => {
    expect(parseDeath(`10:00:00 | Player "Vic" (DEAD) (id=${V} pos=<1.0, 2.0, 3.0>) ${tail}`)).toEqual({ kind: "died", victimDayzId: V, victimGamertag: "Vic", cause, entity });
  });
  it("a bare (DEAD) marker with no death verb is not a death", () => {
    expect(parseDeath(`10:00:00 | Player "Vic" (DEAD) (id=${V} pos=<1.0, 2.0, 3.0>)`)).toBeNull();
  });
  it("ignores a hit line and an unconscious line", () => {
    expect(parseDeath(`10:00:00 | Player "Vic" (DEAD) (id=${V}) hit by Player "Kil" (id=${K}) into Head`)).toBeNull();
    expect(parseDeath(`10:00:00 | Player "Vic" (DEAD) (id=${V} pos=<1.0, 2.0, 3.0>) is unconscious`)).toBeNull();
  });
  it("⚠️ a gamertag that says 'killed by Player' does not forge a killer", () => {
    expect(parseDeath(`10:00:00 | Player "x\" killed by Player \"y" (DEAD) (id=${V}) bled out`)).toMatchObject({ kind: "died", cause: "bled_out" });
    expect(parseDeath(`10:00:00 | Player "Vic (DEAD) (id=${K}) killed by Player" (DEAD) (id=${V}) drowned`)).toMatchObject({ kind: "died", victimDayzId: V });
  });
});
```

`session.test.ts`: `parseSession` reads `is connected` → `{ kind: "connected", dayzId, gamertag }`, `has been disconnected` → `{ kind: "disconnected", … }`, returns null for `is connecting`, for a PlayerList body line, and for a gamertag containing "is connected" on an emote line. `teleport.test.ts`: One Life's real line (with a 40-hex id substituted) parses to `{ dayzId, gamertag, from: {x,y,z}, to: {x,y,z}, reason }` where `from`/`to` are `Vec3`s built from the `<x, alt, z>` order of the `from:`/`to:` triples (⚠️ that order is `x, altitude, z` — like `at <…>`, not like `pos=<…>`); null without an id.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** `death.ts`:

```ts
import { parseIdentity } from "./identity.js";

export type DeathCause = "bled_out" | "drowned" | "suicide" | "infected" | "animal" | "fall" | "vehicle" | "environment" | "died";
export type DeathLine =
  | { kind: "killed"; victimDayzId: string; victimGamertag: string; killerDayzId: string; killerGamertag: string; weapon: string | null; distanceM: number | null }
  | { kind: "died"; victimDayzId: string; victimGamertag: string; cause: DeathCause; entity: string | null };

const ID = "[0-9A-F]{40}";
// ⚠️ Both identities anchored on their 40-hex ids; the victim's `(DEAD)` marker sits between the name and the id.
const KILL_RE = new RegExp(`Player "([^"]+)" \\(DEAD\\) \\(id=(${ID})[^)]*\\) killed by Player "([^"]+)" \\(id=(${ID})[^)]*\\)(.*)$`, "u");
const DEATH_RE = new RegExp(`Player "([^"]+)" \\(DEAD\\) \\(id=(${ID})[^)]*\\)(.*)$`, "u");
const WEAPON_RE = /with (.+?)(?: from ([\d.]+) meters)?\s*$/u;
const ENTITY_RE = /killed by ([A-Za-z0-9_]+)/u;
const VERB_RE = /\b(died|committed suicide|bled out|drowned|killed by)\b/u;
const ENTITY_CAUSES: readonly [RegExp, DeathCause][] = [
  [/^Zmb/u, "infected"], [/^Animal_/u, "animal"], [/^FallDamage$/u, "fall"],
  [/^(CivilianSedan|Hatchback_|Sedan_|Offroad|Truck_|Boat_)/u, "vehicle"],
];

export function parseDeath(raw: string): DeathLine | null {
  if (raw.includes(" hit by ") || raw.includes(" is unconscious")) return null;
  const k = KILL_RE.exec(raw);
  if (k) {
    const w = WEAPON_RE.exec(k[5]!);
    return { kind: "killed", victimGamertag: k[1]!, victimDayzId: k[2]!, killerGamertag: k[3]!, killerDayzId: k[4]!,
      weapon: w ? w[1]!.trim() : null, distanceM: w?.[2] ? parseFloat(w[2]) : null };
  }
  const m = DEATH_RE.exec(raw);
  if (!m) return null;
  const tail = m[3]!; const lower = tail.toLowerCase();
  if (!VERB_RE.test(lower)) return null;      // a corpse re-listed by the PlayerList is not a death
  const entity = ENTITY_RE.exec(tail)?.[1] ?? null;
  const cause: DeathCause =
    lower.includes("bled out") ? "bled_out" : lower.includes("drowned") ? "drowned" : lower.includes("committed suicide") ? "suicide"
    : lower.includes("killed by") ? (entity ? (ENTITY_CAUSES.find(([re]) => re.test(entity))?.[1] ?? "environment") : "environment")
    : "died";
  return { kind: "died", victimGamertag: m[1]!, victimDayzId: m[2]!, cause, entity: lower.includes("killed by") ? entity : null };
}
```

`parseIdentity` is imported for symmetry only if used; drop the import if not. `session.ts`: `CONNECTED_RE = /Player "([^"]+)"\s*\(id=([0-9A-F]{40})[^)]*\) is connected\s*$/u` (reject `is connecting` first), `DISCONNECT_RE = … has been disconnected\s*$/u`; export `parseSession(raw): { kind: "connected" | "disconnected"; dayzId; gamertag } | null`. `teleport.ts`: `TELEPORT_RE = /Player "([^"]+)"\s*\(id=([0-9A-F]{40})[^)]*\) was teleported from: <([^>]+)> to: <([^>]+)>\. Reason: (.+?)\s*$/u`, triples parsed `x, alt, z` → `Vec3 {x, y: alt, z}`; bounds-checked with `inMapBounds`/`inAltitudeBounds` from `coords.ts`. `events.ts`: the five types. `parse-line.ts`: `ParsedLine` gains `{ kind: "session"; event }`, `{ kind: "death"; event: DeathLine }`, `{ kind: "teleport"; event }`; order — after `structure`, before `position`: death, then session, then teleport (none of these lines ends at the identity's `)`, so the PlayerList `ENTRY_RE` cannot match them, and none of the earlier parsers matches them); `eventTypeFor`: `death` → `killed` ? `player.killed` : `player.died`; `session` → `player.connected`/`player.disconnected`; `teleport` → `player.teleported`. `index.ts` exports. `ingest.ts` `toPayload` cases exactly as the Interfaces block. Add one `parse-line.test.ts` case per new kind asserting exactly one entry and the event type.

- [ ] **Step 4: Run** parser + worker suites → PASS; full gate → 26/26. **Commit** — `feat(parser): player.connected/disconnected/killed/died/teleported`.

---

### Task 3: The membership reconciler and `membershipAt`

**Files:**
- Create: `apps/bot/src/membership-tick.ts`, `apps/bot/test/membership-tick.test.ts`

**Interfaces:**
- Produces: `membershipTick(db, now: Date): Promise<{ opened: number; closed: number }>`; `membershipAt(db | tx, serverId, dayzId, at: Date): Promise<number | null>` (the faction id the player was a full member of at `at`, or null).

- [ ] **Step 1: Failing test** `membership-tick.test.ts` (fixture: `seedFaction` ×2, `factionMembers` rows; truncate `membership_history, faction_members, declarations, poles, factions, events, adm_files, servers`):
  1. first run: every current **full** member gets an open row with `joined_at = faction_members.joined_at`; a pending member gets none; result `{ opened: 2, closed: 0 }`; a second run is `{ 0, 0 }`.
  2. delete a member row, run at `t1`: their history row gets `left_at = t1`; `closed: 1`.
  3. promote a pending member (status → full) then run at `t2`: a new open row with `joined_at = t2` (the reconciler saw the promotion at `t2`; the row's `joined_at` predates full membership so it is not used for a promotion) — ruling recorded below.
  4. a member who leaves and rejoins gets two rows; `membershipAt` returns the right clan for an instant inside each span, null between them and null before the first.
  5. `membershipAt` for a player in no clan is null.

**Ruling (join instant on promotion):** `faction_members.joined_at` is stamped at accept, before the player is seen at the base; full membership starts at promotion. On the first run the reconciler has no better instant than `joined_at` for existing full members; afterwards a newly full member's span starts at the tick that observed it. Cost if wrong: a join instant early by the pending interval for members seeded on the first run only.

- [ ] **Step 2: Implement**:

```ts
import type { Database } from "@factions/db";
import { factionMembers, membershipHistory } from "@factions/db";
import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * The membership reconciler (spec §11 ⚠️): diffs `faction_members` (full
 * only) against the open rows of `membership_history` and writes only the
 * differences — a new full member opens a span, a missing one closes it at
 * `now`. Runs every tick; never touches faction_members. On its first run
 * it seeds one open span per current full member using the row's joined_at.
 */
export async function membershipTick(db: Database, now: Date): Promise<{ opened: number; closed: number }> {
  return db.transaction(async (tx) => {
    const current = await tx.select({ serverId: factionMembers.serverId, factionId: factionMembers.factionId, dayzId: factionMembers.dayzId, joinedAt: factionMembers.joinedAt })
      .from(factionMembers).where(eq(factionMembers.status, "full"));
    const open = await tx.select({ id: membershipHistory.id, factionId: membershipHistory.factionId, dayzId: membershipHistory.dayzId })
      .from(membershipHistory).where(isNull(membershipHistory.leftAt));
    const key = (f: number, d: string) => `${f}:${d}`;
    const openKeys = new Set(open.map((o) => key(o.factionId, o.dayzId)));
    const currentKeys = new Set(current.map((c) => key(c.factionId, c.dayzId)));
    const [{ seeded }] = await tx.select({ seeded: sql<number>`count(*)::int` }).from(membershipHistory);
    const firstRun = seeded === 0;
    let opened = 0, closed = 0;
    for (const c of current) {
      if (openKeys.has(key(c.factionId, c.dayzId))) continue;
      await tx.insert(membershipHistory).values({ serverId: c.serverId, factionId: c.factionId, dayzId: c.dayzId, joinedAt: firstRun ? c.joinedAt : now });
      opened++;
    }
    for (const o of open) {
      if (currentKeys.has(key(o.factionId, o.dayzId))) continue;
      await tx.update(membershipHistory).set({ leftAt: now }).where(eq(membershipHistory.id, o.id));
      closed++;
    }
    return { opened, closed };
  });
}

/** The clan `dayzId` was a full member of at `at`, from the history spans. */
export async function membershipAt(db: Database | Tx, serverId: number, dayzId: string, at: Date): Promise<number | null> {
  const [row] = await db.select({ factionId: membershipHistory.factionId }).from(membershipHistory)
    .where(and(eq(membershipHistory.serverId, serverId), eq(membershipHistory.dayzId, dayzId), lte(membershipHistory.joinedAt, at), or(isNull(membershipHistory.leftAt), gt(membershipHistory.leftAt, at))))
    .limit(1);
  return row?.factionId ?? null;
}
```

- [ ] **Step 3: Run** → PASS; full gate → 26/26. **Commit** — `feat(bot): membership history reconciler`.

---

### Task 4: The sessions consumer and its rebuild

**Files:**
- Create: `apps/bot/src/sessions-tick.ts`, `apps/bot/test/sessions-tick.test.ts`, `scripts/rebuild-sessions.ts`
- Modify: root `package.json` (`"rebuild:sessions": "tsx scripts/rebuild-sessions.ts"`)

**Interfaces:**
- Produces: `sessionsTick(db, opts?: { batchSize?: number }): Promise<{ scanned: number; opened: number; closed: number; restarted: number }>`; `SESSIONS_CONSUMER = "sessions-projector"`; `rebuildSessions(db, serverId): Promise<number>` (truncates the server's rows, resets the cursor to 0, replays; returns rows written).

- [ ] **Step 1: Failing test** (fixture: two `admFiles` rows with `bootAt` `t0` and `t0 + 4h`; events inserted with the file id they belong to):
  1. connected at `t0+1m` then disconnected at `t0+30m` → one row, `close_reason = 'disconnect'`, `disconnected_at = t0+30m`; `connect_event_id` is the connect event.
  2. connected in file 1, no disconnect; first event of file 2 (any type, e.g. a position at `t0+4h+1m`) → the open session closes with `disconnected_at = file 2's boot_at`, `close_reason = 'restart'`; `restarted: 1`.
  3. a disconnect with no open session writes nothing (`closed: 0`); a second connect while one is open first closes the open one at the new connect's instant with `'restart'` (a missed disconnect), then opens the new one.
  4. replay (cursor reset) writes no second row (`player_sessions_connect_uniq`) and does not re-close.
  5. `rebuildSessions` reproduces the same rows from scratch (compare `select` output before and after, ignoring ids).

- [ ] **Step 2: Implement** `sessions-tick.ts` — batch loop like `positions-tick.ts`; per batch remember `lastFileByServer: Map<serverId, admFileId>` seeded from the newest `player_sessions.connect_event_id`'s event file per server at the start (one query) so a restart boundary that straddles two ticks is still seen; when `ev.admFileId !== lastFile`, read that file's `boot_at` and `update player_sessions set disconnected_at = boot_at, close_reason = 'restart' where server_id = ? and disconnected_at is null and connected_at < boot_at`; then handle the event: `player.connected` → close any open row for the player at `ev.occurredAt` as `'restart'`, insert `{ connectedAt: ev.occurredAt, connectEventId: ev.id }` with `onConflictDoNothing` on `connect_event_id`; `player.disconnected` → `update … set disconnected_at = ev.occurredAt, close_reason = 'disconnect' where … disconnected_at is null and connected_at <= ev.occurredAt`. Cursor written per batch. `rebuildSessions`: `delete from player_sessions where server_id = ?`, `writeCursor(db, SESSIONS_CONSUMER, 0)`, then `sessionsTick`. ⚠️ Rebuild is per server but the cursor is global; the script refuses to run when more than one active server exists, and says so.
- [ ] **Step 3: Script** `scripts/rebuild-sessions.ts` — the `rebuild-standings.ts` shape: `--server <id>`, the `factions_live` guard, `--allow-test-db`.
- [ ] **Step 4: Run** → PASS; full gate → 26/26. **Commit** — `feat(bot): sessions consumer and rebuild`.

---

### Task 5: The kills consumer and its rebuild

**Files:**
- Create: `apps/bot/src/kills-tick.ts`, `apps/bot/test/kills-tick.test.ts`, `scripts/rebuild-kills.ts`
- Modify: root `package.json` (`"rebuild:kills"`)

**Interfaces:**
- Consumes: `membershipAt` (Task 3).
- Produces: `killsTick(db, opts?: { batchSize?: number }): Promise<{ scanned: number; written: number }>`; `KILLS_CONSUMER = "kills-projector"`; `rebuildKills(db, serverId)`.

- [ ] **Step 1: Failing test** (fixture: clans BEAR and WOLF via `seedFaction`; `membership_history` rows: A in BEAR from `t0`, B in BEAR from `t0` left at `t5`, R in WOLF from `t0`):
  1. `player.killed` A→R at `t1` → row `{ killer A, victim R, killerFactionId BEAR, victimFactionId WOLF, friendlyFire false, weapon, distanceM }`.
  2. A→B at `t1` (both BEAR) → `friendlyFire true`; A→B at `t6` (B has left) → `false`, `victimFactionId null`.
  3. `player.died` (infected) for A → `killerDayzId null`, `cause 'infected'`, `killerFactionId null`, `friendlyFire false`.
  4. a stranger with no history → both faction ids null.
  5. replay writes nothing twice (`kills_event_uniq`); `rebuildKills` reproduces the rows.

- [ ] **Step 2: Implement** — per event: `player.killed` → `membershipAt` for both parties at `ev.occurredAt`; `friendlyFire = kf !== null && kf === vf`; insert with `onConflictDoNothing({ target: kills.eventId })`. `player.died` → victim only, `cause` from payload, `killerDayzId null`. `distanceM` stored as `String(n)` (numeric). Cursor per batch. `rebuildKills`: delete the server's rows, reset cursor, replay; same single-server refusal as Task 4.
- [ ] **Step 3: Script** `scripts/rebuild-kills.ts`.
- [ ] **Step 4: Run** → PASS; full gate → 26/26. **Commit** — `feat(bot): kills consumer and rebuild`.

---

### Task 6: Wiring

**Files:**
- Modify: `apps/bot/src/discord.ts`, `apps/bot/README.md`

- [ ] **Step 1:** in the runner, immediately **before** the presence tick: `membershipTick(db, new Date())` in its own try/catch (⚠️ comment: it must see the roster as it stands before this tick's promotions land, so a promotion recorded by presence this tick opens its span next tick; and it must run before the kills consumer). Immediately **after** the zone tick and before `runStructure("tick")`: `sessionsTick(db)` then `killsTick(db)`, each in its own try/catch with log lines `sessions: N opened, M closed` (only when non-zero) and `kills: N written`. README: the three new ticks and the order.
- [ ] **Step 2:** full gate → 26/26. **Commit** — `feat(bot): membership, sessions and kills ticks wired`.

---

### Task 7: `@factions/roster` — `playerBoards`, `playerProfile`, `clanBoard`

**Files:**
- Create: `packages/roster/src/stats.ts`, `packages/roster/test/stats.test.ts`
- Modify: `packages/roster/src/index.ts`, `test/exports.test.ts`, `apps/web/test/smoke.test.ts` (+ `clanBoard`, `playerBoards`, `playerProfile`, sorted)

**Interfaces:**

```ts
export type StatScope = { kind: "all" } | { kind: "season"; number: number };
export type BoardRow = { dayzId: string; gamertag: string; value: number };
export type Boards = {
  scope: StatScope; seasons: number[];   // the numbers available for the picker, newest first
  raiders: BoardRow[]; killers: BoardRow[]; kd: (BoardRow & { kills: number; deaths: number })[];
  playTime: BoardRow[]; friendlyFire: BoardRow[];
};
export type PlayerProfile = {
  dayzId: string; gamertag: string; linked: boolean; scope: StatScope; seasons: number[];
  playTimeSeconds: number; sessions: number; lastSeenAt: Date | null;
  pvpKills: number; pvpDeaths: number; kd: number | null;
  killedBy: { gamertag: string; count: number }[]; killed: { gamertag: string; count: number }[];
  friendlyFireKills: number; friendlyFireDeaths: number;
  raidCredits: number; upkeepRaises: number;
  clanHistory: { tag: string; name: string; joinedAt: Date; leftAt: Date | null }[];
};
playerBoards(scope: StatScope, limit?: number): Promise<Boards>
playerProfile(gamertag: string, scope: StatScope): Promise<PlayerProfile | null>
clanBoard(discordId: string, scope: StatScope): Promise<Boards | "not-linked" | "not-in-clan" | "pending">
```

**Ruling (upkeep raises):** §11 says "`flag.raised` by the player at their own clan's declaration with the clan's texture while a full member". Declaration history is not kept (rows are deleted on release), so the pole check is dropped: an upkeep raise is a `flag.raised` event by the player whose `texture` equals the texture of the clan they were a full member of at `occurred_at` (via `membership_history`). Cost if wrong: a member raising the clan's flag at a pole that is not the base counts once; that raise already triggers a rebind proposal, so it is rare and visible.

**Ruling (profile identity):** "every linked player has a public profile" — the profile is keyed on `identity_links.gamertag` (case-insensitive exact match; if several, the most recently verified), falling back to `players.gamertag` for an unlinked player with a kill or session so a killed-by name still resolves; `linked` says which.

- [ ] **Step 1: Failing tests** — seed: server, season 1 (`started_at = t0`, closed at `t50`) and season 2 (open from `t50`); clans BEAR/WOLF; links for A, B (BEAR) and R (WOLF); `membership_history` spans; `kills` rows (A kills R ×12 in season 1, R kills A ×3 in season 2, A kills B once friendly, A died to infected once); `player_sessions` (A: two closed sessions of 1 h and 30 min in season 1, one open now); `raids` with `raiderDayzId = A` ×2 in season 2; `flag.raised` events by A with `Flag_Bear` ×3 (two in season 1, one in season 2) and one with `Flag_Wolf`. Assert: boards all-time — raiders `[A:2]`, killers `[A:13, R:3]`, kd includes A (13 kills ≥ `KD_MIN_KILLS`, deaths 3 → 4.33) and excludes R (3 kills), playTime `[A: 5400]`, friendlyFire `[A:1]`; boards season 2 — killers `[R:3]`, raiders `[A:2]`; profile A all-time — every field; profile A season 1 — kills 12, upkeep 2; `playerProfile("nobody")` null; unlinked stranger with a kill row resolves with `linked: false`; `clanBoard` for B filters to BEAR's current full roster (A and B only, no R) and returns the refusals for a pending member and a linked non-member; `seasons` lists `[2, 1]`.
- [ ] **Step 2: Implement** `stats.ts` — one `window(scope)` helper returning `{ from: Date; to: Date | null }` from `seasons`; every aggregate uses `occurred_at >= from and (to is null or occurred_at < to)`; sessions clip play time to the window (`least(coalesce(disconnected_at, now), to) - greatest(connected_at, from)`); killed-by / killed lists join `players` for names, grouped and ordered by count desc then name; `kd = kills / max(deaths, 1)` rounded to 2 dp, `null` on boards under `KD_MIN_KILLS`; `clanBoard` = `playerBoards` with an extra `dayz_id in (current full roster of the actor's clan)` predicate on every query (WHERE, never a post-filter), the actor via `actorFor`. Boards limit default 25.
- [ ] **Step 3: Exports** — three wrappers in `index.ts`; both allowlists. The forbidden-substring test passes (`playerBoards`, `playerProfile`, `clanBoard` contain none of the banned words).
- [ ] **Step 4: Run** → PASS; full gate → 26/26. **Commit** — `feat(roster): playerBoards, playerProfile, clanBoard`.

---

### Task 8: `/players`, `/players/{gamertag}`, `/clan/board`

**Files:**
- Create: `apps/web/app/players/page.tsx`, `apps/web/app/players/[gamertag]/page.tsx`, `apps/web/app/clan/board/page.tsx`, `apps/web/lib/stats-copy.ts`, `apps/web/test/stats-copy.test.ts`
- Modify: `apps/web/lib/auth/gate.ts` (`PUBLIC_PATHS` + `"/players"`; `PUBLIC_PREFIXES` + `"/players/"`), `apps/web/test/auth-gate.test.ts` (pin both; `/clan/board` stays gated), `apps/web/app/page.tsx` (nav link "Players" beside "Scoreboard"), `apps/web/app/clan/page.tsx` ("Board" link), `apps/web/app/clans/[tag]/page.tsx` (roster gamertags link to `/players/{gamertag}`), `apps/web/app/war-log/page.tsx` (gamertags link to profiles)

- [ ] **Step 1: Copy** `lib/stats-copy.ts`: `BOARD_LABELS` (raiders "Top raiders", killers "Top killers", kd "Best K/D", playTime "Most play time", friendlyFire "Most friendly fire"), `KD_NOTE = \`K/D needs ${KD_MIN_KILLS} kills\``, `EMPTY_BOARD = "Nothing yet."`, `NO_PROFILE = "No player by that name."`, `playTime(seconds)` → `"12h 05m"`; `scopeLabel(scope)` → "All-time" / "Season N". Test them.
- [ ] **Step 2: Scope from the query string** — `?season=N` → `{ kind: "season", number: N }` when `N` is a positive integer, `?season=all` → all-time, absent → the open season (the roster returns `seasons`; the page picks `seasons[0]` when present, else all-time). A `<nav>` of links renders the picker (no JS). Never echo the raw query.
- [ ] **Step 3: Pages** — `/players`: `force-dynamic` (public but live), five tables (rank, player link, value; K/D table shows kills/deaths too and the `KD_NOTE`), scope picker. `/players/[gamertag]`: `notFound()` on null; the §10.2 fields in labelled sections; killed-by / killed as two lists; clan history as rows `[TAG] Name · joined … · left …/still a member`; "not linked" chip for `linked: false`. `/clan/board`: `currentSession` → `clanBoard(session.sub, scope)`; refusals render the same copy `/clan` uses for not-linked/not-in-clan and a pending line; otherwise the five tables. The `/clan` page gets a "Board" link; `/clans/[tag]` roster names and `/war-log` gamertags link to profiles with `encodeURIComponent`.
- [ ] **Step 4: Gate + tests** — `PUBLIC_PATHS` and `PUBLIC_PREFIXES` extended; `auth-gate.test.ts` pins both and asserts `pathIsPublic("/clan/board") === false` and `pathIsPublic("/playersomething") === false`; `request-time-rendering` passes (all three pages `force-dynamic`); vocabulary passes; `pnpm --filter @factions/web build` clean.
- [ ] **Step 5: Run** the web suite, `next build`, full gate → 26/26. **Commit** — `feat(web): /players, player profiles, /clan/board`.

---

### Task 9: Runbook and notes

**Files:**
- Create: `docs/deploy/2026-09-08-player-stats.md`
- Modify: `CLAUDE.md`, `docs/superpowers/specs/2026-09-04-clan-wars-target-state-design.md` (§15 row 6 → `2026-09-08-player-stats.md`), `apps/bot/README.md` (if Task 6 left a gap)

- [ ] **Step 1: Runbook** in the shape of `2026-09-07-map.md`: (1) read and apply 0026 (additive; bot may run); (2) **cursor seeding** — unlike the map's consumers, these two are meant to backfill history: leave `sessions-projector` and `kills-projector` **unseeded** (cursor 0) so the first tick replays the whole log into `player_sessions`/`kills` (nothing posts to Discord from either), and say how long to expect (one 500-event batch per round trip; `guardedRunner` skips overlapping ticks meanwhile — the bot posts nothing new until the backfill completes, so schedule the restart in a quiet hour); (3) deploy bot and web; (4) confirm `membership: N opened` on the first tick (one per current full member), then `sessions:`/`kills:` lines; (5) `/players` renders with the backfilled numbers; (6) rebuilds: `pnpm rebuild:sessions --server 1` / `pnpm rebuild:kills --server 1`, single-server only, `factions_live` guard; (7) ⚠️ history before this deploy has no `membership_history`, so `friendly_fire` and faction ids on backfilled kills are null/false for any kill before the first reconciler run — the reconciler's first run seeds spans from `joined_at`, so kills after each member's `joined_at` do resolve; say so plainly.
- [ ] **Step 2: CLAUDE.md** — the three ticks and their order (membership before presence; sessions and kills after zone, before structure); "kills are stats, never points"; `membership_history` is a projection the roster never writes; rebuild scripts. Spec §15 row 6 plan file.
- [ ] **Step 3:** full gate → 26/26. **Commit** — `docs: player stats runbook and notes`.

---

## Self-review

**Spec coverage.** §4.9 `player_sessions`, `kills` (T1, T4, T5; rebuild scripts T4/T5); §6 kill/death/session/teleport lines and the five event types (T2); §7 sessions + kills consumers (T4–T6); §10.2 the three routes (T8); §11 every stat row: play time/sessions/last seen (T7 from sessions + `players.last_seen_at`), PvP kills/deaths/K/D at ≥ 10 (T7, `KD_MIN_KILLS`), killed-by/killed names only (T7), friendly fire (T5, T7), raid credits from `raids.raider_dayz_id` (T7), upkeep raises (T7, ruling), clan history (T3 + T7, ruling on the projection); "kills are stats, never points" (global constraint, no writer touches standings); §13 rebuild scripts (T4, T5); §15 row 6 (T9). `player.teleported` is recorded and read by nothing (§6), as specified.

**Placeholder scan.** T4/T5 give behaviour lists plus the exact SQL predicates rather than full modules; both mirror `positions-tick.ts`, which the implementer reads, and every column, key and reason string is named. T7 names every field and predicate. No TBDs.

**Type consistency.** `membershipAt` (T3) is what T5 and T7 call; `DeathCause`/payload keys (T2) are what T5 reads (`cause`, `entity`, `victimDayzId`, `killerDayzId`, `weapon`, `distanceM`); `StatScope`/`Boards`/`PlayerProfile` (T7) are what T8 renders; `KD_MIN_KILLS` is the one threshold in T7 and T8.
