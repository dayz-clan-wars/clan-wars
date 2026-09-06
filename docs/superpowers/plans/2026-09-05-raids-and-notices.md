# Raids and Notices (increment 3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A non-member lowering a clan's flag starts the 24-hour clock and scores a raid; a member's raise inside it is a defense; every transition and roster event queues its `#war-log` line, clan-channel notice or DM in the same transaction, posted by two new ticks.

**Architecture:** Two new log consumers in the bot (`raid-tick`, `raise-tick`) fold `flag.lowered` and `flag.raised` into `raids`, `defenses`, `season_standings` and the flag-down columns on `factions`, under the victim's row lock. Two new queue tables (`war_log_events`, `clan_notices`) follow the existing `faction_events` discipline: written by the transition's transaction, posted in id order by a tick; `clan_notices` fails per target after three attempts. The dormancy clock gains a second entrance (`raided`), the disband warning, the `lapsed` feed event and the solo-lapse DM. Every roster write in `packages/roster` appends its notice. Nothing here creates Discord roles or channels: channel notices queue with a null target and post once increment 3b fills `factions.discord_text_channel_id`.

**Tech Stack:** drizzle-orm 0.36 / postgres.js, drizzle-kit migrations, discord.js 14, vitest with per-package test databases, `@factions/event-log` cursors.

**Spec:** `docs/superpowers/specs/2026-09-04-clan-wars-target-state-design.md` — §4.3 (factions columns), §4.7 (the three queues), §4.8 (raids, seasons, standings), §5.1 (clan states), §5.8 (the flag-down clock), §7 (ticks), §8.1–8.2 (points and credit), §9.2–9.4 (verbatim lines), §13 (tests), §14 (hazards), §15 row 3. Increment 3b (`2026-09-xx-discord-structure.md`) adds the per-clan role and channels, the `@Linked` role, and the nickname clear.

## Global Constraints

- **Lock order (spec §4.12):** `factions → declarations → poles → faction_members → faction_invites → faction_join_requests → … → faction_events → war_log_events → clan_notices`. The three queues are insert-only and always last. `lockDeclarations(tx, serverId)` sits with `declarations`.
- **Every Discord post goes through a table first, written in the same transaction as the transition it describes** (§4.7). No tick posts from memory.
- **`…_no_coordinates`** on all three queue tables: `payload` may not carry `poleKey`, `x`, `y` or `z`. A `distance` in metres is allowed; a position is not (§9.5).
- **`faction_events` and `war_log_events` post in id order and stop at the first failure**, loudly. **`clan_notices` stops per `discord_target_id`**, marks `failed_at` after **3** attempts.
- **Only a full roster member's raise counts** for activation, defense, revive and the 7-day clock (§5.1). A non-member's raise is a notice, never a state change.
- **No raid** when: the lowerer is a full member of the victim; the pole is undeclared; the clan is `reserved` or `dormant`; the pole is a solo declaration (§8.2).
- **Dedup:** one `raids` row per `(raider_faction_id, victim_faction_id)` per 24 h from `first_lower_at`; solo raiders per `raider_dayz_id`; a different clan's lower is a new raid. Dedup is a query under the victim's `factions` row lock.
- **Points are computed at write time and never recomputed** (§8.1): `ranked` = active clans with season points > 0; `N = count(ranked)`; `r` = victim's rank (points desc, times_raided asc, activated_at asc); ranked & N > 1 → `round(100 × (2 − (r − 1)/(N − 1)))`; ranked & N = 1 → 200; unranked → 100. Solo raider → 0. Worked example: N = 10, r = 4 → 167.
- **Supplied iff `status = 'active' and flag_down_since is null`** (§4.3); `SUPPLIED_STATUSES` is deleted.
- **Copy is verbatim from §9.2–9.4**, says "clan" never "faction"; `{age}` is relative ("6 min ago"); `{duration}` is `Nh Nm`. `apps/bot/test/vocabulary.test.ts` scans the renderer modules.
- **No literal restates a rules.ts number**: `FLAG_DOWN_MS`, `DORMANT_AFTER_MS`, `DISBAND_AFTER_DORMANT_MS`, `RELEASED_POLE_GRACE_MS`, `SOLO_LAPSE_MS`, `ROSTER_COOLDOWN_MS`, `REBIND_CONFIRM_MS`, `POINTS_TOP`, `POINTS_BOTTOM`, `POINTS_UNRANKED` from `@factions/domain`. The disband warning fires 4 days before disband: `DISBAND_AFTER_DORMANT_MS − DISBAND_WARNING_LEAD_MS` with a new `DISBAND_WARNING_LEAD_MS = 4 * DAY` in rules.ts (the guide's "4 days until…").
- **Consumers are idempotent by event id** (cursor + a unique key on the row they write); ticks run under `guardedRunner` in `apps/bot/src/discord.ts` with their own try/catch each.
- **Relative imports inside `packages/*/src` are extensionless.** `apps/web` never imports `@factions/db` or `@factions/roster/internal`; the roster runtime export pin stays at 34 names.
- **Full gate:** from the repo root, `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force` → **26 successful, 26 total**. Never touch `factions_live`. Nothing applies migrations in production.
- **Commits** end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01Svc2Dv7g1XwWi8CSuY4h5e`.

## File structure

**Schema and domain**
- `packages/db/migrations/0023_raids_and_queues.sql` + journal — new columns on `factions`; `seasons`, `raids`, `defenses`, `season_standings`, `war_log_events`, `clan_notices`; the `lapsed` kind.
- `packages/domain/src/feed.ts` — `FACTION_EVENT_KINDS` gains `lapsed`; new `WAR_LOG_KINDS`, `CLAN_NOTICE_KINDS`, `DORMANT_REASONS`.
- `packages/domain/src/scoring.ts` — `pointsFor(rank, ranked)`, `weekStartOf(date)`: pure.
- `packages/domain/src/factions.ts` — `SUPPLIED_STATUSES` deleted; `SUPPLIED_PREDICATE` documented as a rule the worker spells in SQL.
- `packages/domain/src/rules.ts` — `DISBAND_WARNING_LEAD_MS`.

**Queues (shared by bot and site through `@factions/roster/internal`)**
- `packages/roster/src/internal/notices.ts` — `appendClanNoticeTx`, `appendWarLogTx`, payload types, `PgNoticeStore`, `PgWarLogStore`.

**Bot**
- `apps/bot/src/raid-tick.ts` — the raid consumer.
- `apps/bot/src/raise-tick.ts` — defense, revive-with-actor, non-member raise, colors elsewhere, rebind proposal.
- `apps/bot/src/dormancy.ts`, `dormancy-store.ts`, `dormancy-tick.ts` — reason, the raided entrance, the warning, notices.
- `apps/bot/src/ceremony-store.ts` — `lapsed` feed row.
- `apps/bot/src/notice-text.ts` — every §9.3/§9.4 line that exists now, one renderer per kind, drift-tested against `CLAN_NOTICE_KINDS`.
- `apps/bot/src/war-log-text.ts` — the §9.2 lines.
- `apps/bot/src/notice-tick.ts`, `apps/bot/src/war-log-tick.ts` — the posters.
- `apps/bot/src/discord.ts`, `config.ts` — wiring; `WAR_LOG_CHANNEL_ID`.

**Roster writes that gain a notice** — `packages/roster/src/internal/roster-store.ts`, `requests.ts`, `rebind-store.ts`; `apps/bot/src/presence-tick.ts`.

**Worker** — `apps/ingest-worker/src/supply-tick.ts` reads the supplied predicate.

**Site** — `packages/roster/src/base.ts` (`BaseView.lapsed`), `apps/web/app/base/page.tsx`.

**Docs** — `docs/deploy/2026-09-05-raids-and-notices.md`, `CLAUDE.md`, spec §15, bot README.

---

### Task 1: Migration 0023, the domain kinds, the scoring rules

**Files:**
- Modify: `packages/db/src/schema.ts` (factions columns; new tables after `factionEvents`), `packages/domain/src/feed.ts`, `packages/domain/src/factions.ts`, `packages/domain/src/rules.ts`, `packages/domain/src/index.ts`
- Create: `packages/domain/src/scoring.ts`, `packages/domain/test/scoring.test.ts`, `packages/db/test/raids-schema.test.ts`, migration `0023_raids_and_queues.sql` (generated, renamed, journal tag fixed)
- Modify: `packages/db/test/holding-index-drift.test.ts` (the supplied predicate), `apps/ingest-worker/src/supply-tick.ts`, `docs/guide-numbers.json` only if `DISBAND_WARNING_LEAD_MS` must appear in the drift table (it does not: the guide states "4 days" in a sentence, not the numbers table — leave the JSON alone)

**Interfaces:**
- Produces (schema): `factions.flagDownSince`, `flagDownByDayzId`, `dormantReason` (check `in ('raided','inactive')`, and `(dormant_reason is null) = (status <> 'dormant')` is NOT enforced by check — existing dormant rows have no reason; see the runbook), `disbandWarnedAt`, `discordRoleId`, `discordTextChannelId`, `discordVoiceChannelId` (all nullable). Tables: `seasons(id, serverId, number, startedAt, endedAt, championFactionId)` unique partial `(server_id) where ended_at is null`; `raids(id, seasonId, serverId, victimFactionId, raiderDayzId, raiderFactionId nullable, firstLowerEventId unique, firstLowerAt, lastLowerAt, lowerCount int default 1, points int, victimRankAtLower int nullable, rankedCountAtLower int, weekStart)`; `defenses(id, factionId, seasonId, raisedByDayzId, eventId unique, flagDownSince, defendedAt, siegeSeconds int)`; `seasonStandings(seasonId, factionId, points int default 0, raids int default 0, timesRaided int default 0, defenses int default 0)` unique `(season_id, faction_id)`; `warLogEvents(id, serverId, kind, occurredAt, payload, postedAt)` with `war_log_events_no_coordinates` and `war_log_events_kind_valid`; `clanNotices(id, serverId, factionId nullable, target check in ('channel','dm'), discordTargetId nullable, kind, occurredAt, payload, postedAt, failedAt, attempts int default 0)` with `clan_notices_no_coordinates`, `clan_notices_target_valid`, and index `clan_notices_queue_idx on (discord_target_id, id) where posted_at is null and failed_at is null`. `faction_events_kind_valid` gains `'lapsed'`.
- Produces (domain): `FACTION_EVENT_KINDS` + `"lapsed"`; `WAR_LOG_KINDS = ["raid","defense","week_closed","season_closed"]`; `CLAN_NOTICE_KINDS` = the channel kinds `flag_down, defended, dormant_raided, dormant_inactive, revived, disband_warning, non_member_raise, colors_elsewhere, rebind_proposed, rebind_confirmed, joined, became_full, left, kicked, promoted, demoted, transferred, renamed` and the DM kinds `invited, request_accepted, request_declined, pending_expired, solo_non_member_raise, solo_lapsed` (`flag_down` and `kicked` serve both targets); `DORMANT_REASONS = ["raided","inactive"]`; `DISBAND_WARNING_LEAD_MS = 4 * DAY`; `pointsFor(rank: number | null, ranked: number): number`; `weekStartOf(d: Date): Date`.

- [ ] **Step 1: Failing tests**

`packages/domain/test/scoring.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { pointsFor, weekStartOf } from "../src/scoring";
import { POINTS_BOTTOM, POINTS_TOP, POINTS_UNRANKED } from "../src/rules";

describe("pointsFor (spec §8.1)", () => {
  it("gives the top clan POINTS_TOP and the bottom POINTS_BOTTOM", () => {
    expect(pointsFor(1, 10)).toBe(POINTS_TOP);
    expect(pointsFor(10, 10)).toBe(POINTS_BOTTOM);
  });
  it("the guide's worked example: N = 10, r = 4 → 167", () => {
    expect(pointsFor(4, 10)).toBe(167);
  });
  it("a lone ranked clan is worth POINTS_TOP; an unranked victim POINTS_UNRANKED", () => {
    expect(pointsFor(1, 1)).toBe(POINTS_TOP);
    expect(pointsFor(null, 7)).toBe(POINTS_UNRANKED);
    expect(pointsFor(null, 0)).toBe(POINTS_UNRANKED);
  });
});

describe("weekStartOf", () => {
  it("is Monday 00:00 UTC of the same week", () => {
    expect(weekStartOf(new Date("2026-09-05T13:00:00Z")).toISOString()).toBe("2026-08-31T00:00:00.000Z"); // a Saturday
    expect(weekStartOf(new Date("2026-08-31T00:00:00Z")).toISOString()).toBe("2026-08-31T00:00:00.000Z"); // Monday itself
    expect(weekStartOf(new Date("2026-09-06T23:59:59Z")).toISOString()).toBe("2026-08-31T00:00:00.000Z"); // Sunday night
  });
});
```
`packages/db/test/raids-schema.test.ts` (copy the fixture shape of `roster-membership-schema.test.ts`: migrate a fresh test DB, then assert):
```ts
  it("the queue tables refuse a coordinate in the payload", async () => {
    await expect(db.execute(sql`insert into war_log_events (server_id, kind, occurred_at, payload) values (${serverId}, 'raid', now(), '{"x": 1}')`)).rejects.toThrow(/no_coordinates/u);
    await expect(db.execute(sql`insert into clan_notices (server_id, target, kind, occurred_at, payload) values (${serverId}, 'dm', 'kicked', now(), '{"poleKey": "1:2:3"}')`)).rejects.toThrow(/no_coordinates/u);
  });
  it("one open season per server", async () => {
    await db.execute(sql`insert into seasons (server_id, number, started_at) values (${serverId}, 1, now())`);
    await expect(db.execute(sql`insert into seasons (server_id, number, started_at) values (${serverId}, 2, now())`)).rejects.toThrow();
  });
  it("dormant_reason is constrained and faction_events accepts lapsed", async () => {
    await expect(db.execute(sql`update factions set dormant_reason = 'bored' where id = ${factionId}`)).rejects.toThrow(/dormant_reason/u);
    await db.execute(sql`insert into faction_events (server_id, faction_id, kind, occurred_at, payload) values (${serverId}, ${factionId}, 'lapsed', now(), '{"name":"Bears","tag":"BEAR","texture":"Flag_Bear"}')`);
  });
  it("a raid's first lower event is unique, and a defense's event too", async () => { /* two inserts with the same first_lower_event_id → second rejects; same for defenses.event_id */ });
```
`packages/db/test/holding-index-drift.test.ts` — add:
```ts
  it("the supplied predicate is 'active and flag_down_since is null', spelled in the worker's query", () => {
    const worker = readFileSync(join(import.meta.dirname, "..", "..", "..", "apps", "ingest-worker", "src", "supply-tick.ts"), "utf8");
    expect(worker).toMatch(/eq\(factions\.status, "active"\)/u);
    expect(worker).toMatch(/isNull\(factions\.flagDownSince\)/u);
    expect(worker).not.toMatch(/SUPPLIED_STATUSES/u);
  });
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @factions/domain test` → `scoring` module missing. `TEST_DATABASE_URL=… pnpm --filter @factions/db test` → the new tables do not exist.

- [ ] **Step 3: Domain**

`packages/domain/src/rules.ts` — under "Defending": `export const DISBAND_WARNING_LEAD_MS = 4 * DAY;` with the comment `/** The guide's "4 days until this clan is disbanded" warning, measured back from DISBAND_AFTER_DORMANT_MS. */`.

`packages/domain/src/scoring.ts`:
```ts
import { POINTS_BOTTOM, POINTS_TOP, POINTS_UNRANKED } from "./rules";

/**
 * Spec §8.1. `rank` is the victim's 1-based place among the ranked clans at
 * the moment of the lower, or null when the victim is unranked (active but no
 * points yet this season). `ranked` is how many clans were ranked.
 * Computed once, stored on the raid row, never recomputed.
 */
export function pointsFor(rank: number | null, ranked: number): number {
  if (rank === null) return POINTS_UNRANKED;
  if (ranked <= 1) return POINTS_TOP;
  const span = POINTS_TOP - POINTS_BOTTOM;
  return Math.round(POINTS_TOP - span * ((rank - 1) / (ranked - 1)));
}

/** Monday 00:00 UTC of the week containing `d` (spec §8.3). */
export function weekStartOf(d: Date): Date {
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return start;
}
```
(`100 × (2 − (r−1)/(N−1))` equals `200 − 100 × (r−1)/(N−1)`; the constants make the span explicit.)

`packages/domain/src/feed.ts`:
```ts
export const FACTION_EVENT_KINDS = ["founded", "activated", "lapsed", "renamed", "rebound", "dormant", "revived", "disbanded"] as const;
export type FactionEventKind = (typeof FACTION_EVENT_KINDS)[number];

/** #war-log (spec §4.7, §9.2). week_closed and season_closed are written by increment 4. */
export const WAR_LOG_KINDS = ["raid", "defense", "week_closed", "season_closed"] as const;
export type WarLogKind = (typeof WAR_LOG_KINDS)[number];

/**
 * clan_notices kinds that exist as of increment 3a (spec §9.3, §9.4). Kinds
 * the spec lists for later increments (intruder, dismantle, gate_built,
 * leader_removed, succession_*, vote_*, codes_rotated, guest) are added with
 * the increment that writes them; apps/bot/test/notice-text.test.ts pins
 * that every kind here has a renderer and no renderer exists for a kind
 * not here.
 */
export const CLAN_NOTICE_KINDS = [
  "flag_down", "defended", "dormant_raided", "dormant_inactive", "revived", "disband_warning",
  "non_member_raise", "colors_elsewhere", "rebind_proposed", "rebind_confirmed",
  "joined", "became_full", "left", "kicked", "promoted", "demoted", "transferred", "renamed",
  "invited", "request_accepted", "request_declined", "pending_expired", "solo_non_member_raise", "solo_lapsed",
] as const;
export type ClanNoticeKind = (typeof CLAN_NOTICE_KINDS)[number];
export const NOTICE_TARGETS = ["channel", "dm"] as const;
export type NoticeTarget = (typeof NOTICE_TARGETS)[number];

export const DORMANT_REASONS = ["raided", "inactive"] as const;
export type DormantReason = (typeof DORMANT_REASONS)[number];
```
`packages/domain/src/factions.ts` — delete `SUPPLIED_STATUSES` and its docblock; add:
```ts
/**
 * Supplied iff `status = 'active' and flag_down_since is null` (spec §4.3).
 * A predicate, not a status list: a raided clan keeps `active` for the 24 h
 * clock and loses its kit the moment the flag is down. Spelled in SQL by
 * apps/ingest-worker/src/supply-tick.ts; packages/db/test/holding-index-drift.test.ts
 * pins the spelling.
 */
export const SUPPLIED_PREDICATE = "status = 'active' and flag_down_since is null";
```
Export `scoring.ts` and the new names from `packages/domain/src/index.ts`. Fix every importer of `SUPPLIED_STATUSES` (`grep -rn SUPPLIED_STATUSES apps packages`): the worker's `supply-tick.ts` `where` becomes `and(eq(factions.serverId, deps.serverId), eq(factions.status, "active"), isNull(factions.flagDownSince))` with the comment rewritten to cite the predicate; its test (`apps/ingest-worker/test/supply-tick.test.ts` or wherever `SUPPLIED_STATUSES` is asserted) gains one case: an active clan with `flag_down_since` set drops out of the file.

- [ ] **Step 4: Schema**

In `packages/db/src/schema.ts`, `factions` gains:
```ts
  /** Spec §5.8: set by a non-member's lower at the declared pole while active; cleared by a member's raise (defense) or the dormancy transition. */
  flagDownSince: timestamp("flag_down_since", { withTimezone: true }),
  flagDownByDayzId: text("flag_down_by_dayz_id"),
  /** Non-null iff dormant, by convention; the runbook stamps 'inactive' on any dormant row from before this column. */
  dormantReason: text("dormant_reason").$type<DormantReason>(),
  /** The day-10 warning was queued. Cleared by revive. */
  disbandWarnedAt: timestamp("disband_warned_at", { withTimezone: true }),
  /** Filled by increment 3b at activation; null until then. clan_notices with target 'channel' post only once this is set. */
  discordRoleId: text("discord_role_id"),
  discordTextChannelId: text("discord_text_channel_id"),
  discordVoiceChannelId: text("discord_voice_channel_id"),
```
plus in the table's constraints `dormantReasonValid: check("factions_dormant_reason_valid", sql\`${t.dormantReason} IS NULL OR ${t.dormantReason} IN ('raided','inactive')\`)`. `faction_events_kind_valid` gains `'lapsed'`. New tables, after `factionEvents`:
```ts
export const seasons = pgTable("seasons", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  number: integer("number").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  championFactionId: bigint("champion_faction_id", { mode: "number" }).references(() => factions.id),
}, (t) => ({
  oneOpen: uniqueIndex("seasons_open_uniq").on(t.serverId).where(sql`${t.endedAt} IS NULL`),
  uniqNumber: uniqueIndex("seasons_number_uniq").on(t.serverId, t.number),
}));

export const raids = pgTable("raids", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  seasonId: bigint("season_id", { mode: "number" }).notNull().references(() => seasons.id),
  serverId: integer("server_id").notNull().references(() => servers.id),
  victimFactionId: bigint("victim_faction_id", { mode: "number" }).notNull().references(() => factions.id),
  raiderDayzId: text("raider_dayz_id").notNull(),
  raiderFactionId: bigint("raider_faction_id", { mode: "number" }).references(() => factions.id),
  firstLowerEventId: bigint("first_lower_event_id", { mode: "number" }).notNull().references(() => events.id),
  firstLowerAt: timestamp("first_lower_at", { withTimezone: true }).notNull(),
  lastLowerAt: timestamp("last_lower_at", { withTimezone: true }).notNull(),
  lowerCount: integer("lower_count").notNull().default(1),
  /** Spec §8.1: recorded at write time, never recomputed. */
  points: integer("points").notNull(),
  victimRankAtLower: integer("victim_rank_at_lower"),
  rankedCountAtLower: integer("ranked_count_at_lower").notNull(),
  weekStart: timestamp("week_start", { withTimezone: true }).notNull(),
}, (t) => ({
  uniqFirstLower: uniqueIndex("raids_first_lower_uniq").on(t.firstLowerEventId),
  byVictimOpen: index("raids_victim_recent_idx").on(t.victimFactionId, t.firstLowerAt),
  byWeek: index("raids_week_idx").on(t.seasonId, t.weekStart),
}));

export const defenses = pgTable("defenses", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  factionId: bigint("faction_id", { mode: "number" }).notNull().references(() => factions.id),
  seasonId: bigint("season_id", { mode: "number" }).notNull().references(() => seasons.id),
  raisedByDayzId: text("raised_by_dayz_id").notNull(),
  eventId: bigint("event_id", { mode: "number" }).notNull().references(() => events.id),
  flagDownSince: timestamp("flag_down_since", { withTimezone: true }).notNull(),
  defendedAt: timestamp("defended_at", { withTimezone: true }).notNull(),
  siegeSeconds: integer("siege_seconds").notNull(),
}, (t) => ({ uniqEvent: uniqueIndex("defenses_event_uniq").on(t.eventId) }));

export const seasonStandings = pgTable("season_standings", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  seasonId: bigint("season_id", { mode: "number" }).notNull().references(() => seasons.id),
  factionId: bigint("faction_id", { mode: "number" }).notNull().references(() => factions.id),
  points: integer("points").notNull().default(0),
  raids: integer("raids").notNull().default(0),
  timesRaided: integer("times_raided").notNull().default(0),
  defenses: integer("defenses").notNull().default(0),
}, (t) => ({ uniq: uniqueIndex("season_standings_uniq").on(t.seasonId, t.factionId) }));

export const warLogEvents = pgTable("war_log_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  kind: text("kind").$type<WarLogKind>().notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  payload: jsonb("payload").notNull(),
  postedAt: timestamp("posted_at", { withTimezone: true }),
}, (t) => ({
  kindValid: check("war_log_events_kind_valid", sql`${t.kind} IN ('raid','defense','week_closed','season_closed')`),
  noCoordinates: check("war_log_events_no_coordinates", sql`NOT (${t.payload} ? 'poleKey' OR ${t.payload} ? 'x' OR ${t.payload} ? 'y' OR ${t.payload} ? 'z')`),
  queue: index("war_log_events_queue_idx").on(t.id).where(sql`${t.postedAt} IS NULL`),
}));

export const clanNotices = pgTable("clan_notices", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  factionId: bigint("faction_id", { mode: "number" }).references(() => factions.id),
  target: text("target").$type<NoticeTarget>().notNull(),
  /**
   * The user id for a DM. For a channel notice: the clan's text channel id,
   * or NULL when the clan has none yet — increment 3b creates channels; until
   * it does, channel rows wait here (posted_at null, never failed) and the
   * poster resolves the id from factions.discord_text_channel_id at post time.
   */
  discordTargetId: text("discord_target_id"),
  kind: text("kind").$type<ClanNoticeKind>().notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  payload: jsonb("payload").notNull(),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  failedAt: timestamp("failed_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
}, (t) => ({
  targetValid: check("clan_notices_target_valid", sql`${t.target} IN ('channel','dm')`),
  dmHasTarget: check("clan_notices_dm_has_target", sql`${t.target} <> 'dm' OR ${t.discordTargetId} IS NOT NULL`),
  noCoordinates: check("clan_notices_no_coordinates", sql`NOT (${t.payload} ? 'poleKey' OR ${t.payload} ? 'x' OR ${t.payload} ? 'y' OR ${t.payload} ? 'z')`),
  queue: index("clan_notices_queue_idx").on(t.discordTargetId, t.id).where(sql`${t.postedAt} IS NULL AND ${t.failedAt} IS NULL`),
}));
```
Import the new domain types at the top of schema.ts. Generate: `pnpm --filter @factions/db exec drizzle-kit generate`, rename the file to `0023_raids_and_queues.sql`, fix the `tag` in `migrations/meta/_journal.json`, read the SQL in full. Drizzle-kit will not emit the `faction_events_kind_valid` change as a check alteration; append by hand:
```sql
ALTER TABLE "faction_events" DROP CONSTRAINT IF EXISTS "faction_events_kind_valid";--> statement-breakpoint
ALTER TABLE "faction_events" ADD CONSTRAINT "faction_events_kind_valid" CHECK ("faction_events"."kind" IN ('founded','activated','lapsed','renamed','rebound','dormant','revived','disbanded'));
```

- [ ] **Step 5: Run the package suites**

`pnpm --filter @factions/domain test`, `TEST_DATABASE_URL=… pnpm --filter @factions/db test`, `TEST_DATABASE_URL=… pnpm --filter @factions/ingest-worker test` (or whatever the worker's package name is: `grep '"name"' apps/ingest-worker/package.json`) → green. Then the full gate → 26/26 (the migration runs in every package's test DB).

- [ ] **Step 6: Commit**

```bash
git add packages/db packages/domain apps/ingest-worker docs/guide-numbers.json
git commit -m "feat(db,domain): migration 0023 — raids, defenses, seasons, standings, the two new queues, dormant_reason; scoring rules; supplied is a predicate"
```

---

### Task 2: The queue writers and stores — `packages/roster/src/internal/notices.ts`

**Files:**
- Create: `packages/roster/src/internal/notices.ts`, `packages/roster/test/notices.test.ts`
- Modify: `packages/roster/src/internal/index.ts` (re-export)

**Interfaces:**
- Produces:
  ```ts
  export type NoticePayload = Record<string, string | number | boolean | null>;   // no poleKey/x/y/z — the check enforces it, the renderers read named keys
  export type ClanNoticeInput = { serverId: number; factionId: number | null; target: NoticeTarget; discordTargetId: string | null; kind: ClanNoticeKind; occurredAt: Date; payload: NoticePayload };
  export async function appendClanNoticeTx(tx: Tx, n: ClanNoticeInput): Promise<void>;
  /** A channel notice for a clan: target 'channel', discord_target_id = the clan's text channel id if it has one, else null (resolved at post time). */
  export async function noticeClanTx(tx: Tx, a: { serverId: number; factionId: number; kind: ClanNoticeKind; occurredAt: Date; payload: NoticePayload }): Promise<void>;
  /** A DM: target 'dm', discord_target_id = the user. */
  export async function noticeUserTx(tx: Tx, a: { serverId: number; factionId: number | null; discordId: string; kind: ClanNoticeKind; occurredAt: Date; payload: NoticePayload }): Promise<void>;
  /** The same DM to every FULL member of a clan. */
  export async function noticeFullMembersTx(tx: Tx, a: { serverId: number; factionId: number; kind: ClanNoticeKind; occurredAt: Date; payload: NoticePayload }): Promise<number>;
  export type WarLogInput = { serverId: number; kind: WarLogKind; occurredAt: Date; payload: NoticePayload };
  export async function appendWarLogTx(tx: Tx, e: WarLogInput): Promise<void>;
  export type QueuedNotice = { id: number; factionId: number | null; target: NoticeTarget; discordTargetId: string | null; kind: ClanNoticeKind; occurredAt: Date; payload: NoticePayload; attempts: number };
  export interface NoticeStore {
    /** Unposted, unfailed rows in id order; channel rows with a null target are resolved through factions.discord_text_channel_id and returned with it filled, or SKIPPED (not returned) while the clan has no channel. */
    readUnposted(limit: number): Promise<QueuedNotice[]>;
    markPosted(id: number, at: Date): Promise<void>;
    /** attempts += 1; failed_at set when attempts reaches NOTICE_MAX_ATTEMPTS. Returns the new attempts count. */
    markAttempt(id: number, at: Date): Promise<number>;
  }
  export const NOTICE_MAX_ATTEMPTS = 3;
  export class PgNoticeStore implements NoticeStore {}
  export type QueuedWarLog = { id: number; kind: WarLogKind; occurredAt: Date; payload: NoticePayload };
  export interface WarLogStore { readUnposted(limit: number): Promise<QueuedWarLog[]>; markPosted(id: number, at: Date): Promise<void>; }
  export class PgWarLogStore implements WarLogStore {}
  export async function countUnpostedNotices(db: Database): Promise<number>;
  export async function countUnpostedWarLog(db: Database): Promise<number>;
  ```
- Consumes: `clanNotices`, `warLogEvents`, `factions`, `factionMembers` from `@factions/db`; kinds from `@factions/domain`.

- [ ] **Step 1: Failing tests**

`packages/roster/test/notices.test.ts` (fixture like `writes.test.ts`: a server, a clan via the package's seed helper, three members two full one pending with distinct discord ids):
```ts
  it("noticeClanTx queues a channel row with a null target until the clan has a channel, and readUnposted skips it", async () => {
    await db.transaction((tx) => noticeClanTx(tx, { serverId, factionId, kind: "joined", occurredAt: now, payload: { gamertag: "Otto" } }));
    const [row] = await db.select().from(clanNotices);
    expect(row).toMatchObject({ target: "channel", discordTargetId: null, kind: "joined" });
    expect(await new PgNoticeStore(db).readUnposted(10)).toEqual([]);
    await db.update(factions).set({ discordTextChannelId: "chan-1" }).where(eq(factions.id, factionId));
    const [q] = await new PgNoticeStore(db).readUnposted(10);
    expect(q).toMatchObject({ id: row!.id, discordTargetId: "chan-1" });
  });
  it("noticeFullMembersTx DMs every full member and no pending one", async () => {
    const n = await db.transaction((tx) => noticeFullMembersTx(tx, { serverId, factionId, kind: "flag_down", occurredAt: now, payload: { gamertag: "Raider" } }));
    expect(n).toBe(2);
    const rows = await db.select({ t: clanNotices.discordTargetId }).from(clanNotices).where(eq(clanNotices.target, "dm"));
    expect(rows.map((r) => r.t).sort()).toEqual(["d1", "d2"]);
  });
  it("markAttempt fails a row on the third attempt and readUnposted stops returning it", async () => {
    await db.transaction((tx) => noticeUserTx(tx, { serverId, factionId: null, discordId: "d9", kind: "solo_lapsed", occurredAt: now, payload: {} }));
    const store = new PgNoticeStore(db);
    const [q] = await store.readUnposted(10);
    expect(await store.markAttempt(q!.id, now)).toBe(1);
    expect(await store.markAttempt(q!.id, now)).toBe(2);
    expect(await store.markAttempt(q!.id, now)).toBe(3);
    const [row] = await db.select({ failedAt: clanNotices.failedAt }).from(clanNotices).where(eq(clanNotices.id, q!.id));
    expect(row!.failedAt).not.toBeNull();
    expect(await store.readUnposted(10)).toEqual([]);
  });
  it("appendWarLogTx rejects a coordinate at the database", async () => {
    await expect(db.transaction((tx) => appendWarLogTx(tx, { serverId, kind: "raid", occurredAt: now, payload: { x: 1 } as never }))).rejects.toThrow(/no_coordinates/u);
  });
```

- [ ] **Step 2: Run to see them fail**

Run: `TEST_DATABASE_URL=… pnpm --filter @factions/roster exec vitest run test/notices.test.ts` → module missing.

- [ ] **Step 3: Implement**

`packages/roster/src/internal/notices.ts`:
```ts
import type { Database } from "@factions/db";
import { clanNotices, factionMembers, factions, warLogEvents } from "@factions/db";
import type { ClanNoticeKind, NoticeTarget, WarLogKind } from "@factions/domain";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Named display fields, frozen at write time. Never a coordinate — the table's check is the second line of defence. */
export type NoticePayload = Record<string, string | number | boolean | null>;

export type ClanNoticeInput = {
  serverId: number; factionId: number | null; target: NoticeTarget; discordTargetId: string | null;
  kind: ClanNoticeKind; occurredAt: Date; payload: NoticePayload;
};

/**
 * Append one notice. Takes a Tx on purpose (see feed-store.ts): written in
 * the transaction that performs the transition, so a transition without its
 * notice is impossible. Lock order (§4.12): last, after faction_events.
 */
export async function appendClanNoticeTx(tx: Tx, n: ClanNoticeInput): Promise<void> {
  await tx.insert(clanNotices).values({
    serverId: n.serverId, factionId: n.factionId, target: n.target, discordTargetId: n.discordTargetId,
    kind: n.kind, occurredAt: n.occurredAt, payload: n.payload,
  });
}

/**
 * A clan-channel notice. The channel id is copied from the faction row when
 * it has one; otherwise the row queues with a null target and the poster
 * resolves it later (increment 3b creates the channels). Read with a plain
 * select — the caller already holds whatever faction lock its transition
 * needed, and this is after it in the order.
 */
export async function noticeClanTx(tx: Tx, a: { serverId: number; factionId: number; kind: ClanNoticeKind; occurredAt: Date; payload: NoticePayload }): Promise<void> {
  const [f] = await tx.select({ channel: factions.discordTextChannelId }).from(factions).where(eq(factions.id, a.factionId));
  await appendClanNoticeTx(tx, { ...a, target: "channel", discordTargetId: f?.channel ?? null });
}

export async function noticeUserTx(tx: Tx, a: { serverId: number; factionId: number | null; discordId: string; kind: ClanNoticeKind; occurredAt: Date; payload: NoticePayload }): Promise<void> {
  const { discordId, ...rest } = a;
  await appendClanNoticeTx(tx, { ...rest, target: "dm", discordTargetId: discordId });
}

/** The same DM to every full member (spec §9.4 flag_down). Returns how many. */
export async function noticeFullMembersTx(tx: Tx, a: { serverId: number; factionId: number; kind: ClanNoticeKind; occurredAt: Date; payload: NoticePayload }): Promise<number> {
  const members = await tx.select({ discordId: factionMembers.discordId }).from(factionMembers)
    .where(and(eq(factionMembers.factionId, a.factionId), eq(factionMembers.status, "full")));
  for (const m of members) await noticeUserTx(tx, { ...a, discordId: m.discordId });
  return members.length;
}

export type WarLogInput = { serverId: number; kind: WarLogKind; occurredAt: Date; payload: NoticePayload };
export async function appendWarLogTx(tx: Tx, e: WarLogInput): Promise<void> {
  await tx.insert(warLogEvents).values({ serverId: e.serverId, kind: e.kind, occurredAt: e.occurredAt, payload: e.payload });
}

export const NOTICE_MAX_ATTEMPTS = 3;

export type QueuedNotice = {
  id: number; factionId: number | null; target: NoticeTarget; discordTargetId: string | null;
  kind: ClanNoticeKind; occurredAt: Date; payload: NoticePayload; attempts: number;
};

export interface NoticeStore {
  readUnposted(limit: number): Promise<QueuedNotice[]>;
  markPosted(id: number, at: Date): Promise<void>;
  markAttempt(id: number, at: Date): Promise<number>;
}

export class PgNoticeStore implements NoticeStore {
  constructor(private readonly db: Database) {}

  /**
   * Ascending id. A channel row whose clan still has no text channel is not
   * returned: it is neither posted nor failed, it waits. Rows whose own
   * discord_target_id is set are returned as they are (a DM, or a channel id
   * frozen at write time).
   */
  async readUnposted(limit: number): Promise<QueuedNotice[]> {
    const rows = await this.db.select({
      id: clanNotices.id, factionId: clanNotices.factionId, target: clanNotices.target,
      discordTargetId: sql<string | null>`coalesce(${clanNotices.discordTargetId}, ${factions.discordTextChannelId})`,
      kind: clanNotices.kind, occurredAt: clanNotices.occurredAt, payload: clanNotices.payload, attempts: clanNotices.attempts,
    }).from(clanNotices)
      .leftJoin(factions, eq(factions.id, clanNotices.factionId))
      .where(and(isNull(clanNotices.postedAt), isNull(clanNotices.failedAt)))
      .orderBy(asc(clanNotices.id)).limit(limit);
    return rows.filter((r) => r.discordTargetId !== null).map((r) => ({ ...r, payload: r.payload as NoticePayload }));
  }

  async markPosted(id: number, at: Date): Promise<void> {
    await this.db.update(clanNotices).set({ postedAt: at }).where(eq(clanNotices.id, id));
  }

  async markAttempt(id: number, at: Date): Promise<number> {
    const [row] = await this.db.update(clanNotices)
      .set({ attempts: sql`${clanNotices.attempts} + 1`, failedAt: sql`case when ${clanNotices.attempts} + 1 >= ${NOTICE_MAX_ATTEMPTS} then ${at} else null end` })
      .where(eq(clanNotices.id, id)).returning({ attempts: clanNotices.attempts });
    return row!.attempts;
  }
}

export type QueuedWarLog = { id: number; kind: WarLogKind; occurredAt: Date; payload: NoticePayload };
export interface WarLogStore { readUnposted(limit: number): Promise<QueuedWarLog[]>; markPosted(id: number, at: Date): Promise<void>; }
export class PgWarLogStore implements WarLogStore {
  constructor(private readonly db: Database) {}
  async readUnposted(limit: number): Promise<QueuedWarLog[]> {
    const rows = await this.db.select({ id: warLogEvents.id, kind: warLogEvents.kind, occurredAt: warLogEvents.occurredAt, payload: warLogEvents.payload })
      .from(warLogEvents).where(isNull(warLogEvents.postedAt)).orderBy(asc(warLogEvents.id)).limit(limit);
    return rows.map((r) => ({ ...r, payload: r.payload as NoticePayload }));
  }
  async markPosted(id: number, at: Date): Promise<void> {
    await this.db.update(warLogEvents).set({ postedAt: at }).where(eq(warLogEvents.id, id));
  }
}

export async function countUnpostedNotices(db: Database): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(clanNotices).where(and(isNull(clanNotices.postedAt), isNull(clanNotices.failedAt)));
  return r!.n;
}
export async function countUnpostedWarLog(db: Database): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(warLogEvents).where(isNull(warLogEvents.postedAt));
  return r!.n;
}
```
Add `export * from "./notices";` to `packages/roster/src/internal/index.ts`.

- [ ] **Step 4: Run, then commit**

`TEST_DATABASE_URL=… pnpm --filter @factions/roster test` → green.
```bash
git add packages/roster/src/internal/notices.ts packages/roster/src/internal/index.ts packages/roster/test/notices.test.ts
git commit -m "feat(roster): the clan_notices and war_log_events writers and stores"
```

---

### Task 3: The raid consumer

**Files:**
- Create: `apps/bot/src/raid-tick.ts`, `apps/bot/src/season.ts`, `apps/bot/test/raid-tick.test.ts`
- Modify: `apps/bot/test/seed.ts` (a `seedSeason(db, serverId, startedAt)` helper and `seedFlagEvent` if the file lacks one)

**Interfaces:**
- Produces:
  ```ts
  // season.ts
  export async function openSeason(db: Database | Tx, serverId: number): Promise<{ id: number; number: number; startedAt: Date } | null>;
  // raid-tick.ts
  export const RAID_CONSUMER = "raid-consumer";
  export type RaidTickResult = { scanned: number; raids: number; absorbed: number; skippedNoSeason: number };
  export async function raidTick(db: Database, opts?: { batchSize?: number; onNoSeason?: (serverId: number) => void }): Promise<RaidTickResult>;
  ```
- Consumes: `readCursor/writeCursor/readEventBatch` (`@factions/event-log`); `pointsFor`, `weekStartOf`, `RAID_DEDUP_MS` (`@factions/domain`); `appendWarLogTx`, `noticeClanTx`, `noticeFullMembersTx` (Task 2).

- [ ] **Step 1: Failing tests**

`apps/bot/test/raid-tick.test.ts` — fixture: server, `seedSeason`, two clans BEAR (victim, active, pole P1) and WOLF (raider, active, pole P2) via `seedFaction`, full members `B1` in BEAR and `W1` in WOLF (plus links), a solo player `S1`, and a `lower(dayzId, gamertag, texture, poleKey, at)` helper inserting a `flag.lowered` event with payload `{ dayzId, gamertag, texture, poleKey, pole: {x,y,z} }`.
```ts
  it("a non-member lowering an active clan's flag at its declared pole is a raid: row, standings, flag_down, war-log, notices", async () => {
    await lower(W1, "Wolfie", "Flag_Bear", P1, now);
    const r = await raidTick(db);
    expect(r).toMatchObject({ raids: 1, absorbed: 0 });
    const [raid] = await db.select().from(raids);
    expect(raid).toMatchObject({ victimFactionId: BEAR, raiderFactionId: WOLF, raiderDayzId: W1, lowerCount: 1, points: POINTS_UNRANKED, victimRankAtLower: null, rankedCountAtLower: 0 });
    expect(raid!.weekStart.toISOString()).toBe(weekStartOf(now).toISOString());
    const [bear] = await db.select({ f: factions.flagDownSince, by: factions.flagDownByDayzId }).from(factions).where(eq(factions.id, BEAR));
    expect(bear).toEqual({ f: now, by: W1 });
    const standings = await db.select().from(seasonStandings).orderBy(seasonStandings.factionId);
    expect(standings.map((s) => [s.factionId, s.points, s.raids, s.timesRaided])).toEqual([[BEAR, 0, 0, 1], [WOLF, POINTS_UNRANKED, 1, 0]]);
    const [log] = await db.select().from(warLogEvents);
    expect(log).toMatchObject({ kind: "raid", payload: { raiderClan: "WOLF", victimClan: "BEAR", gamertag: "Wolfie", solo: false } });
    const notices = await db.select({ target: clanNotices.target, kind: clanNotices.kind, to: clanNotices.discordTargetId }).from(clanNotices);
    expect(notices).toEqual(expect.arrayContaining([{ target: "channel", kind: "flag_down", to: null }, { target: "dm", kind: "flag_down", to: "dB1" }]));
  });
  it("a second lower by the same clan inside 24 h is absorbed; a different clan's is a new raid", async () => {
    await lower(W1, "Wolfie", "Flag_Bear", P1, now);
    await lower(W1, "Wolfie", "Flag_Bear", P1, new Date(now.getTime() + 3_600_000));
    await lower(S1, "Solo", "Flag_Bear", P1, new Date(now.getTime() + 7_200_000));
    const r = await raidTick(db);
    expect(r).toMatchObject({ raids: 2, absorbed: 1 });
    const rows = await db.select({ raider: raids.raiderFactionId, count: raids.lowerCount, points: raids.points }).from(raids).orderBy(raids.id);
    expect(rows).toEqual([{ raider: WOLF, count: 2, points: POINTS_UNRANKED }, { raider: null, count: 1, points: 0 }]);
    const [bear] = await db.select({ t: seasonStandings.timesRaided }).from(seasonStandings).where(eq(seasonStandings.factionId, BEAR));
    expect(bear!.t).toBe(2);
  });
  it("points come from the victim's rank at the moment of the lower: N = 10, r = 4 → 167", async () => {
    // seed 10 active clans with standings points 1000..100 (BEAR at rank 4 with 700), then WOLF lowers BEAR's flag
    // expect raid.points 167, victimRankAtLower 4, rankedCountAtLower 10
  });
  it("no raid for: a full member's lower (upkeep), a reserved clan, a dormant clan, a solo declaration, an undeclared pole", async () => { /* five lowers, raidTick → raids 0, no flag_down, no rows */ });
  it("a lower with no open season is skipped and reported, and the cursor still advances", async () => { /* delete the season, lower, expect skippedNoSeason 1 and onNoSeason called with serverId; second run scans 0 */ });
  it("is idempotent across a crash between the raid insert and the cursor write", async () => { /* run once, reset the cursor to 0, run again → raids stays 1 (unique first_lower_event_id) */ });
```

- [ ] **Step 2: Run to see them fail**

Run: `TEST_DATABASE_URL=… pnpm --filter @factions/bot exec vitest run test/raid-tick.test.ts` → module missing.

- [ ] **Step 3: Implement**

`apps/bot/src/season.ts`:
```ts
import type { Database } from "@factions/db";
import { seasons } from "@factions/db";
import { and, eq, isNull } from "drizzle-orm";
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** The one open season on a server (seasons_open_uniq), or null before the runbook opens season 1. */
export async function openSeason(db: Database | Tx, serverId: number): Promise<{ id: number; number: number; startedAt: Date } | null> {
  const [s] = await db.select({ id: seasons.id, number: seasons.number, startedAt: seasons.startedAt })
    .from(seasons).where(and(eq(seasons.serverId, serverId), isNull(seasons.endedAt)));
  return s ?? null;
}
```
`apps/bot/src/raid-tick.ts`:
```ts
import type { Database } from "@factions/db";
import { declarations, factionMembers, factions, raids, seasonStandings } from "@factions/db";
import { readCursor, writeCursor, readEventBatch } from "@factions/event-log";
import { RAID_DEDUP_MS, pointsFor, weekStartOf } from "@factions/domain";
import { appendWarLogTx, noticeClanTx, noticeFullMembersTx } from "@factions/roster/internal";
import { and, desc, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { openSeason } from "./season.js";

/** ⚠️ Distinct from every other consumer name; two consumers sharing a cursor skip each other's events. */
export const RAID_CONSUMER = "raid-consumer";

export type RaidTickResult = { scanned: number; raids: number; absorbed: number; skippedNoSeason: number };

type FlagPayload = { dayzId: string; gamertag: string; texture: string; poleKey: string };
function readFlagPayload(payload: unknown): FlagPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.dayzId !== "string" || typeof p.gamertag !== "string" || typeof p.texture !== "string" || typeof p.poleKey !== "string") return null;
  return { dayzId: p.dayzId, gamertag: p.gamertag, texture: p.texture, poleKey: p.poleKey };
}

/**
 * The raid consumer (spec §5.8, §7, §8.2). A `flag.lowered` at a declared
 * ACTIVE clan pole by someone who is not a full member of that clan is a
 * raid: one row per (raider clan, victim) per 24 h from the first lower;
 * later lowers inside the window update `last_lower_at`/`lower_count` and
 * score nothing. Everything happens under the victim's `factions` row lock,
 * then the standings, then the war-log row and the notices — last, per §4.12.
 */
export async function raidTick(db: Database, opts: { batchSize?: number; onNoSeason?: (serverId: number) => void } = {}): Promise<RaidTickResult> {
  const batchSize = opts.batchSize ?? 500;
  const out: RaidTickResult = { scanned: 0, raids: 0, absorbed: 0, skippedNoSeason: 0 };
  let cursor = await readCursor(db, RAID_CONSUMER);
  const warned = new Set<number>();
  for (;;) {
    const batch = await readEventBatch(db, cursor, batchSize);
    if (batch.length === 0) break;
    for (const ev of batch) {
      cursor = ev.id;
      if (ev.type !== "flag.lowered") continue;
      const p = readFlagPayload(ev.payload);
      if (!p) continue;
      out.scanned++;
      const result = await db.transaction(async (tx) => {
        // The victim: the ACTIVE clan whose declaration is this pole. FOR UPDATE on factions first (§4.12).
        const [victim] = await tx.select({ id: factions.id, name: factions.name, tag: factions.tag, texture: factions.texture, flagDownSince: factions.flagDownSince, activatedAt: factions.activatedAt })
          .from(factions).innerJoin(declarations, eq(declarations.ownerFactionId, factions.id))
          .where(and(eq(factions.serverId, ev.serverId), eq(declarations.poleKey, p.poleKey), eq(factions.status, "active")))
          .for("update", { of: factions });
        if (!victim) return "no-raid" as const;
        const [member] = await tx.select({ id: factionMembers.id }).from(factionMembers)
          .where(and(eq(factionMembers.factionId, victim.id), eq(factionMembers.dayzId, p.dayzId), eq(factionMembers.status, "full")));
        if (member) return "no-raid" as const; // upkeep, not a raid
        const season = await openSeason(tx, ev.serverId);
        if (!season) return "no-season" as const;
        // The raider's clan, if any (full membership on this server).
        const [raider] = await tx.select({ factionId: factionMembers.factionId, name: factions.name, tag: factions.tag }).from(factionMembers)
          .innerJoin(factions, eq(factions.id, factionMembers.factionId))
          .where(and(eq(factionMembers.serverId, ev.serverId), eq(factionMembers.dayzId, p.dayzId), eq(factionMembers.status, "full")));
        const raiderFactionId = raider?.factionId ?? null;
        // Dedup under the victim's lock (§8.2).
        const since = new Date(ev.occurredAt.getTime() - RAID_DEDUP_MS);
        const [open] = await tx.select({ id: raids.id }).from(raids).where(and(
          eq(raids.victimFactionId, victim.id), gt(raids.firstLowerAt, since),
          raiderFactionId === null ? and(isNull(raids.raiderFactionId), eq(raids.raiderDayzId, p.dayzId))! : eq(raids.raiderFactionId, raiderFactionId),
        )).orderBy(desc(raids.firstLowerAt)).limit(1);
        if (open) {
          await tx.update(raids).set({ lastLowerAt: ev.occurredAt, lowerCount: sql`${raids.lowerCount} + 1` }).where(eq(raids.id, open.id));
          return "absorbed" as const;
        }
        // Points from the ladder at this moment (§8.1): ranked = active clans with points > 0 this season.
        const ranked = await tx.select({ factionId: seasonStandings.factionId }).from(seasonStandings)
          .innerJoin(factions, eq(factions.id, seasonStandings.factionId))
          .where(and(eq(seasonStandings.seasonId, season.id), eq(factions.status, "active"), gt(seasonStandings.points, 0)))
          .orderBy(desc(seasonStandings.points), asc(seasonStandings.timesRaided), asc(factions.activatedAt));
        const idx = ranked.findIndex((r) => r.factionId === victim.id);
        const rank = idx === -1 ? null : idx + 1;
        const points = raiderFactionId === null ? 0 : pointsFor(rank, ranked.length);
        await tx.insert(raids).values({
          seasonId: season.id, serverId: ev.serverId, victimFactionId: victim.id, raiderDayzId: p.dayzId, raiderFactionId,
          firstLowerEventId: ev.id, firstLowerAt: ev.occurredAt, lastLowerAt: ev.occurredAt, lowerCount: 1,
          points, victimRankAtLower: rank, rankedCountAtLower: ranked.length, weekStart: weekStartOf(ev.occurredAt),
        });
        // Standings: victim times_raided; raider points + raids.
        await tx.insert(seasonStandings).values({ seasonId: season.id, factionId: victim.id, timesRaided: 1 })
          .onConflictDoUpdate({ target: [seasonStandings.seasonId, seasonStandings.factionId], set: { timesRaided: sql`${seasonStandings.timesRaided} + 1` } });
        if (raiderFactionId !== null) {
          await tx.insert(seasonStandings).values({ seasonId: season.id, factionId: raiderFactionId, points, raids: 1 })
            .onConflictDoUpdate({ target: [seasonStandings.seasonId, seasonStandings.factionId], set: { points: sql`${seasonStandings.points} + ${points}`, raids: sql`${seasonStandings.raids} + 1` } });
        }
        // The clock starts on the FIRST lower of an episode; a second raid during flag-down does not restart it.
        if (victim.flagDownSince === null) {
          await tx.update(factions).set({ flagDownSince: ev.occurredAt, flagDownByDayzId: p.dayzId }).where(eq(factions.id, victim.id));
        }
        const payload = { raiderClan: raider?.name ?? null, raiderTag: raider?.tag ?? null, victimClan: victim.name, victimTag: victim.tag, gamertag: p.gamertag, solo: raider === undefined, points };
        await appendWarLogTx(tx, { serverId: ev.serverId, kind: "raid", occurredAt: ev.occurredAt, payload });
        if (victim.flagDownSince === null) {
          const notice = { gamertag: p.gamertag, raiderClan: raider?.name ?? null };
          await noticeClanTx(tx, { serverId: ev.serverId, factionId: victim.id, kind: "flag_down", occurredAt: ev.occurredAt, payload: notice });
          await noticeFullMembersTx(tx, { serverId: ev.serverId, factionId: victim.id, kind: "flag_down", occurredAt: ev.occurredAt, payload: notice });
        }
        return "raid" as const;
      });
      if (result === "raid") out.raids++;
      else if (result === "absorbed") out.absorbed++;
      else if (result === "no-season") {
        out.skippedNoSeason++;
        if (!warned.has(ev.serverId)) { warned.add(ev.serverId); opts.onNoSeason?.(ev.serverId); }
      }
    }
    await writeCursor(db, RAID_CONSUMER, cursor);
  }
  return out;
}
```
(`.for("update", { of: factions })` is drizzle's `FOR UPDATE OF factions`; if the installed drizzle version rejects the `of` option, lock the row with a separate `select … from factions where id = ? for update` right after finding the victim, before any other read.) A second raid inside an open flag-down episode writes its war-log line but no second flag_down notice — the flag was already down.

- [ ] **Step 4: Run, then commit**

`TEST_DATABASE_URL=… pnpm --filter @factions/bot exec vitest run test/raid-tick.test.ts` → green; then the bot suite.
```bash
git add apps/bot/src/raid-tick.ts apps/bot/src/season.ts apps/bot/test/raid-tick.test.ts apps/bot/test/seed.ts
git commit -m "feat(bot): the raid consumer — one row per raider clan per 24 h, points at write time, the flag-down clock starts"
```

---

### Task 4: The raise consumer — defense, revive with a name, non-member raise, colors elsewhere, rebind proposal

**Files:**
- Create: `apps/bot/src/raise-tick.ts`, `apps/bot/test/raise-tick.test.ts`

**Interfaces:**
- Produces: `RAISE_CONSUMER = "raise-consumer"`; `RaiseTickResult = { scanned: number; defenses: number; revived: number; noticed: number }`; `raiseTick(db, opts?: { batchSize?: number; siteBaseUrl: string })`.
- Consumes: `openSeason` (Task 3), `appendWarLogTx`, `noticeClanTx`, `noticeUserTx` (Task 2), `appendFactionEventTx`, `REBIND_CONFIRM_MS`.

- [ ] **Step 1: Failing tests**

`apps/bot/test/raise-tick.test.ts` — same fixture family as Task 3 plus a `raise(...)` helper for `flag.raised`:
```ts
  it("a full member's raise at the declaration while the flag is down is a defense: row, standings, clock cleared, war-log, notice", async () => {
    await db.update(factions).set({ flagDownSince: ago(3 * 3_600_000 + 15 * 60_000), flagDownByDayzId: W1 }).where(eq(factions.id, BEAR));
    await raise(B1, "Bear1", "Flag_Bear", P1, now);
    expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ defenses: 1 });
    const [d] = await db.select().from(defenses);
    expect(d).toMatchObject({ factionId: BEAR, raisedByDayzId: B1, siegeSeconds: 3 * 3600 + 15 * 60 });
    const [bear] = await db.select({ f: factions.flagDownSince }).from(factions).where(eq(factions.id, BEAR));
    expect(bear!.f).toBeNull();
    expect((await db.select().from(warLogEvents))[0]).toMatchObject({ kind: "defense", payload: { victimClan: "BEAR", durationSeconds: 3 * 3600 + 15 * 60 } });
    expect((await db.select().from(clanNotices))[0]).toMatchObject({ kind: "defended", payload: { gamertag: "Bear1", durationSeconds: 3 * 3600 + 15 * 60 } });
  });
  it("a pending member's raise during flag-down is not a defense, and a non-member's raise is a non_member_raise notice", async () => { /* … */ });
  it("a full member's raise at a DORMANT clan's declaration revives it with the raiser named", async () => {
    await db.update(factions).set({ status: "dormant", dormantSince: ago(DAY), dormantReason: "inactive", disbandWarnedAt: ago(1000) }).where(eq(factions.id, BEAR));
    await raise(B1, "Bear1", "Flag_Bear", P1, now);
    expect(await raiseTick(db, { siteBaseUrl: SITE })).toMatchObject({ revived: 1 });
    const [bear] = await db.select({ s: factions.status, r: factions.dormantReason, w: factions.disbandWarnedAt, d: factions.dormantSince }).from(factions).where(eq(factions.id, BEAR));
    expect(bear).toEqual({ s: "active", r: null, w: null, d: null });
    expect((await db.select().from(factionEvents)).at(-1)).toMatchObject({ kind: "revived", payload: { actor: "Bear1" } });
    expect((await db.select().from(clanNotices))[0]).toMatchObject({ kind: "revived", payload: { gamertag: "Bear1" } });
  });
  it("the clan's texture raised at a pole that is not its declaration: a full member → rebind_proposed with the settings link; a non-member → colors_elsewhere", async () => {
    await raise(B1, "Bear1", "Flag_Bear", P3, now);
    await raise(S1, "Solo", "Flag_Bear", P3, now);
    await raiseTick(db, { siteBaseUrl: SITE });
    const kinds = (await db.select({ k: clanNotices.kind, p: clanNotices.payload }).from(clanNotices).orderBy(clanNotices.id));
    expect(kinds[0]).toMatchObject({ k: "rebind_proposed", p: { gamertag: "Bear1", link: `${SITE}/clan/settings` } });
    expect(kinds[1]).toMatchObject({ k: "colors_elsewhere", p: { gamertag: "Solo" } });
  });
  it("a non-member's raise at a SOLO declaration DMs the declarant (solo_non_member_raise)", async () => { /* declare S1 solo at P4 via declareSolo, raise by W1 there → dm to S1's discord id */ });
  it("is idempotent: rerunning from cursor 0 writes no second defense (defenses_event_uniq) and no second notice", async () => { /* … */ });
```

- [ ] **Step 2: Run to see them fail**, then **Step 3: Implement**

`apps/bot/src/raise-tick.ts`:
```ts
import type { Database } from "@factions/db";
import { declarations, defenses, factionMembers, factions, identityLinks, seasonStandings } from "@factions/db";
import { readCursor, writeCursor, readEventBatch } from "@factions/event-log";
import { appendFactionEventTx, appendWarLogTx, noticeClanTx, noticeUserTx } from "@factions/roster/internal";
import { and, eq, sql } from "drizzle-orm";
import { openSeason } from "./season.js";

export const RAISE_CONSUMER = "raise-consumer";
export type RaiseTickResult = { scanned: number; defenses: number; revived: number; noticed: number };

type FlagPayload = { dayzId: string; gamertag: string; texture: string; poleKey: string };
function readFlagPayload(payload: unknown): FlagPayload | null { /* identical to raid-tick's */ }

/**
 * Every `flag.raised` the roster cares about, in one pass (spec §7: defense,
 * revive, non-member raise, colors elsewhere, rebind proposal). Activation
 * stays in ceremony-tick; the 7-day clock stays in dormancy-tick. Order of
 * checks per event:
 *   1. the pole is a clan's declaration → member/non-member branch
 *   2. else the pole is a solo declaration → non-member DM
 *   3. else, if the texture belongs to a clan → proposal or colors elsewhere
 */
export async function raiseTick(db: Database, opts: { batchSize?: number; siteBaseUrl: string }): Promise<RaiseTickResult> {
  const batchSize = opts.batchSize ?? 500;
  const out: RaiseTickResult = { scanned: 0, defenses: 0, revived: 0, noticed: 0 };
  let cursor = await readCursor(db, RAISE_CONSUMER);
  for (;;) {
    const batch = await readEventBatch(db, cursor, batchSize);
    if (batch.length === 0) break;
    for (const ev of batch) {
      cursor = ev.id;
      if (ev.type !== "flag.raised") continue;
      const p = readFlagPayload(ev.payload);
      if (!p) continue;
      out.scanned++;
      const r = await db.transaction(async (tx) => {
        const [decl] = await tx.select({ ownerFactionId: declarations.ownerFactionId, ownerDayzId: declarations.ownerDayzId })
          .from(declarations).where(and(eq(declarations.serverId, ev.serverId), eq(declarations.poleKey, p.poleKey)));

        if (decl?.ownerFactionId) {
          const [clan] = await tx.select({ id: factions.id, name: factions.name, tag: factions.tag, texture: factions.texture, status: factions.status, flagDownSince: factions.flagDownSince })
            .from(factions).where(eq(factions.id, decl.ownerFactionId)).for("update");
          if (!clan) return null;
          const [full] = await tx.select({ id: factionMembers.id }).from(factionMembers)
            .where(and(eq(factionMembers.factionId, clan.id), eq(factionMembers.dayzId, p.dayzId), eq(factionMembers.status, "full")));
          if (!full) {
            if (clan.status === "active" || clan.status === "dormant") {
              await noticeClanTx(tx, { serverId: ev.serverId, factionId: clan.id, kind: "non_member_raise", occurredAt: ev.occurredAt, payload: { gamertag: p.gamertag } });
              return "noticed" as const;
            }
            return null;
          }
          if (p.texture !== clan.texture) return null; // a member raising a foreign flag at home is nothing
          if (clan.status === "active" && clan.flagDownSince !== null) {
            const season = await openSeason(tx, ev.serverId);
            if (!season) return null;
            const siege = Math.max(0, Math.floor((ev.occurredAt.getTime() - clan.flagDownSince.getTime()) / 1000));
            await tx.insert(defenses).values({ factionId: clan.id, seasonId: season.id, raisedByDayzId: p.dayzId, eventId: ev.id, flagDownSince: clan.flagDownSince, defendedAt: ev.occurredAt, siegeSeconds: siege })
              .onConflictDoNothing({ target: defenses.eventId });
            await tx.update(factions).set({ flagDownSince: null, flagDownByDayzId: null }).where(eq(factions.id, clan.id));
            await tx.insert(seasonStandings).values({ seasonId: season.id, factionId: clan.id, defenses: 1 })
              .onConflictDoUpdate({ target: [seasonStandings.seasonId, seasonStandings.factionId], set: { defenses: sql`${seasonStandings.defenses} + 1` } });
            await appendWarLogTx(tx, { serverId: ev.serverId, kind: "defense", occurredAt: ev.occurredAt, payload: { victimClan: clan.name, victimTag: clan.tag, gamertag: p.gamertag, durationSeconds: siege } });
            await noticeClanTx(tx, { serverId: ev.serverId, factionId: clan.id, kind: "defended", occurredAt: ev.occurredAt, payload: { gamertag: p.gamertag, durationSeconds: siege } });
            return "defense" as const;
          }
          if (clan.status === "dormant") {
            await tx.update(factions).set({ status: "active", dormantSince: null, dormantReason: null, disbandWarnedAt: null, flagDownSince: null, flagDownByDayzId: null }).where(eq(factions.id, clan.id));
            await appendFactionEventTx(tx, { serverId: ev.serverId, factionId: clan.id, kind: "revived", occurredAt: ev.occurredAt, payload: { name: clan.name, tag: clan.tag, texture: clan.texture, actor: p.gamertag } });
            await noticeClanTx(tx, { serverId: ev.serverId, factionId: clan.id, kind: "revived", occurredAt: ev.occurredAt, payload: { gamertag: p.gamertag } });
            return "revived" as const;
          }
          return null; // an ordinary upkeep raise: the dormancy clock reads it through LAST_RAISE
        }

        if (decl?.ownerDayzId) {
          if (decl.ownerDayzId === p.dayzId) return null;
          const [link] = await tx.select({ discordId: identityLinks.discordId }).from(identityLinks).where(eq(identityLinks.dayzId, decl.ownerDayzId));
          if (!link) return null;
          await noticeUserTx(tx, { serverId: ev.serverId, factionId: null, discordId: link.discordId, kind: "solo_non_member_raise", occurredAt: ev.occurredAt, payload: { gamertag: p.gamertag } });
          return "noticed" as const;
        }

        // Undeclared pole: does the texture belong to a holding clan on this server?
        const [owner] = await tx.select({ id: factions.id, status: factions.status }).from(factions)
          .where(and(eq(factions.serverId, ev.serverId), eq(factions.texture, p.texture), sql`${factions.status} in ('reserved','active','dormant')`));
        if (!owner || owner.status === "reserved") return null; // activation is ceremony-tick's
        const [full] = await tx.select({ id: factionMembers.id }).from(factionMembers)
          .where(and(eq(factionMembers.factionId, owner.id), eq(factionMembers.dayzId, p.dayzId), eq(factionMembers.status, "full")));
        if (full) {
          await noticeClanTx(tx, { serverId: ev.serverId, factionId: owner.id, kind: "rebind_proposed", occurredAt: ev.occurredAt, payload: { gamertag: p.gamertag, link: `${opts.siteBaseUrl}/clan/settings` } });
        } else {
          await noticeClanTx(tx, { serverId: ev.serverId, factionId: owner.id, kind: "colors_elsewhere", occurredAt: ev.occurredAt, payload: { gamertag: p.gamertag } });
        }
        return "noticed" as const;
      });
      if (r === "defense") out.defenses++;
      else if (r === "revived") out.revived++;
      else if (r === "noticed") out.noticed++;
    }
    await writeCursor(db, RAISE_CONSUMER, cursor);
  }
  return out;
}
```
Idempotency of the notice branches rests on the cursor; a crash between a notice insert and the cursor write can duplicate one notice, the same at-least-once the feed accepts. Defense and revive are guarded (unique `event_id`; status transition). `rebind-store.ts`'s `rebind()` gains `noticeClanTx(... kind: "rebind_confirmed" ...)` after its `rebound` feed row (payload `{}`), with a test in `apps/bot/test/rebind-store.test.ts`.

- [ ] **Step 4: Run, then commit**

```bash
git add apps/bot/src/raise-tick.ts apps/bot/test/raise-tick.test.ts packages/roster/src/internal/rebind-store.ts apps/bot/test/rebind-store.test.ts
git commit -m "feat(bot): the raise consumer — defense, revive by name, non-member raise, colors elsewhere, rebind proposal"
```

---

### Task 5: Dormancy — the raided entrance, the reason, the warning, `lapsed`, the solo-lapse DM

**Files:**
- Modify: `apps/bot/src/dormancy.ts`, `apps/bot/src/dormancy-store.ts`, `apps/bot/src/dormancy-tick.ts`, `apps/bot/src/ceremony-store.ts` (`lapseReservations` appends `lapsed`), `apps/bot/src/feed-embed.ts` (`lapsed` sentence and colour), `apps/bot/src/discord.ts` (`lapseSolos` callback DMs), `packages/declarations/src/store.ts` (`lapseSolos` returns `discordId` too, via a join to identity_links)
- Test: `apps/bot/test/dormancy.test.ts`, `dormancy-store.test.ts`, `dormancy-tick.test.ts`, `ceremony-store.test.ts`, `feed-embed.test.ts`, `packages/declarations/test/solo-declaration.test.ts`

**Interfaces:**
- Produces: `FactionClock` gains `flagDownSince: Date | null; disbandWarnedAt: Date | null`; `Transition` gains `"dormant-raided" | "warn"`; `decide()` order: dormant branch (revive → stamp → pause → warn → disband), active branch (`flagDownSince + FLAG_DOWN_MS <= now` → `"dormant-raided"`; else stale → `"dormant"`); `DormancyStore.goDormant(factionId, at, reason: DormantReason, disbandAt?)` sets `dormant_reason`, clears `flag_down_*`, appends the feed row AND `noticeClanTx` `dormant_raided`/`dormant_inactive`; `DormancyStore.warnDisband(factionId, at): Promise<boolean>` guarded on `dormant and disband_warned_at is null`, sets it and queues `disband_warning`; `revive()` also nulls `dormant_reason`, `disband_warned_at`, `flag_down_*` and queues a `revived` notice with no gamertag (the raise consumer normally gets there first with a name; this is the clock's fallback, and the renderer omits the name when absent); `DormancyTickResult` gains `warned: number`; `lapseSolos` returns `{ dayzId; poleKey; discordId: string | null }[]`.

- [ ] **Step 1: Failing tests** (add to the named files)

`dormancy.test.ts`:
```ts
  it("a flag down for FLAG_DOWN_MS makes an active clan dormant (raided), before the 7-day rule is consulted", () => {
    const c = clock({ status: "active", lastRaiseAt: ago(1000), flagDownSince: ago(FLAG_DOWN_MS) });
    expect(decide(c, now, windows)).toBe("dormant-raided");
    expect(decide(clock({ status: "active", lastRaiseAt: ago(1000), flagDownSince: ago(FLAG_DOWN_MS - 1) }), now, windows)).toBeNull();
  });
  it("warns once, DISBAND_WARNING_LEAD_MS before the disband, and not again", () => {
    const due = ago(windows.disbandAfterDormantMs - DISBAND_WARNING_LEAD_MS);
    expect(decide(clock({ status: "dormant", dormantSince: due, disbandWarnedAt: null, serverLastEventAt: now }), now, windows)).toBe("warn");
    expect(decide(clock({ status: "dormant", dormantSince: due, disbandWarnedAt: now, serverLastEventAt: now }), now, windows)).toBeNull();
  });
```
`dormancy-store.test.ts`: `goDormant(id, now, "raided")` → `dormant_reason = 'raided'`, `flag_down_since` null, a `dormant_raided` channel notice; `goDormant(id, now, "inactive")` → `dormant_inactive`; `warnDisband` true once then false, one `disband_warning` notice; `revive` clears reason and warned_at.
`ceremony-store.test.ts`: `lapseReservations` appends a `lapsed` faction_events row with the frozen name/tag/texture.
`feed-embed.test.ts`: `lapsed` renders "never raised their flag" and the flag label; colour AMBER.
`solo-declaration.test.ts`: `lapseSolos` returns the linked discord id (null for an unlinked declarant).
`dormancy-tick.test.ts`: a `"dormant-raided"` decision calls `goDormant(id, now, "raided", disbandAt)`; a `"warn"` calls `warnDisband` and counts `warned`.

- [ ] **Step 2–3: Run, then implement**

`dormancy.ts`:
```ts
export type FactionClock = { status: string; lastRaiseAt: Date | null; dormantSince: Date | null; serverLastEventAt: Date | null; flagDownSince: Date | null; disbandWarnedAt: Date | null };
export type Transition = "revive" | "dormant" | "dormant-raided" | "warn" | "disband" | "stamp" | "pause" | null;

export function decide(c: FactionClock, now: Date, w: DormancyWindows): Transition {
  const fresh = c.lastRaiseAt !== null && c.lastRaiseAt.getTime() > now.getTime() - w.dormantAfterMs;
  if (c.status === "dormant") {
    if (fresh) return "revive";
    if (c.dormantSince === null) return "stamp";
    const serverLive = c.serverLastEventAt !== null && c.serverLastEventAt.getTime() > now.getTime() - w.dormantAfterMs;
    if (!serverLive) return "pause";
    const age = now.getTime() - c.dormantSince.getTime();
    if (age >= w.disbandAfterDormantMs) return "disband";
    // The guide's "4 days until…" warning, once. Same liveness gate as disband: an unobserved week must not warn early.
    if (c.disbandWarnedAt === null && age >= w.disbandAfterDormantMs - DISBAND_WARNING_LEAD_MS) return "warn";
    return null;
  }
  if (c.status !== "active") return null;
  // ⚠️ The raided entrance first (spec §5.8): a flag down for FLAG_DOWN_MS is dormant even if the 7-day clock is fresh.
  if (c.flagDownSince !== null && now.getTime() - c.flagDownSince.getTime() >= FLAG_DOWN_MS) return "dormant-raided";
  return fresh ? null : "dormant";
}
```
`dormancy-store.ts`: `clockQuery` selects `flagDownSince: factions.flagDownSince, disbandWarnedAt: factions.disbandWarnedAt`; `goDormant(factionId, at, reason, disbandAt?)` sets `{ status: "dormant", dormantSince: at, dormantReason: reason, flagDownSince: null, flagDownByDayzId: null }`, then the feed row (unchanged payload) and `noticeClanTx(tx, { …, kind: reason === "raided" ? "dormant_raided" : "dormant_inactive", payload: {} })`; `revive()` sets `dormantReason: null, disbandWarnedAt: null, flagDownSince: null, flagDownByDayzId: null` too and queues `revived` with `payload: {}`; new `warnDisband(factionId, at)` = guarded update returning the row + `noticeClanTx(kind: "disband_warning", payload: { days: Math.round(DISBAND_WARNING_LEAD_MS / DAY) })`. `dormancy-tick.ts`: the `"dormant"` case passes `"inactive"`, the new `"dormant-raided"` case passes `"raided"` (same disbandAt), `"warn"` calls `warnDisband` and `out.warned++`; the existing leader DMs (`notifyDormancy`) stay for both dormant kinds.

`ceremony-store.ts` `lapseReservations`: inside the transaction, after the status update returns the lapsed rows (select name/tag/texture in the `.returning`), for each: `appendFactionEventTx(tx, { serverId, factionId: id, kind: "lapsed", occurredAt: cutoff, payload: { name, tag, texture } })` — after `releaseTx` and the member delete, per the order. `feed-embed.ts`: `COLOR.lapsed = AMBER`; `describe` case `"lapsed"`: `` `Never raised their flag. ${flagLabel(p.texture)} is back in the pool.` `` (the §9.2 line without the name prefix the embed title already carries).

`packages/declarations/src/store.ts` `lapseSolos`: join `identity_links` on `dayz_id` and return `discordId: string | null`. In `discord.ts`'s `lapseSolos` callback: after collecting, for each lapsed row with a `discordId`, `await db.transaction((tx) => noticeUserTx(tx, { serverId: s.id, factionId: null, discordId, kind: "solo_lapsed", occurredAt: now, payload: { link: \`${cfg.siteBaseUrl}/base\` } }))`. (Written after the release commits, not inside it: `lapseSolos` owns its transaction. A crash between the two loses one DM; the site's `/base` banner shows the same fact — Task 8.)

- [ ] **Step 4: Run the bot and declarations suites, then commit**

```bash
git add apps/bot/src/dormancy.ts apps/bot/src/dormancy-store.ts apps/bot/src/dormancy-tick.ts apps/bot/src/ceremony-store.ts apps/bot/src/feed-embed.ts apps/bot/src/discord.ts packages/declarations/src/store.ts apps/bot/test packages/declarations/test
git commit -m "feat(bot): dormancy has two entrances and a reason; the disband warning; lapsed reservations are announced; solo lapse DMs"
```

---

### Task 6: Every roster write queues its notice

**Files:**
- Modify: `packages/roster/src/internal/roster-store.ts` (`acceptInvite`, `createInvite`, `kick`, `leave`, `setRole`, `transfer`, `rename`), `packages/roster/src/internal/requests.ts` (`decideRequestDb`), `apps/bot/src/presence-tick.ts` (`became_full`; `expirePendingMembers` → `pending_expired`)
- Test: `apps/bot/test/roster-invites.test.ts`, `roster-departures.test.ts`, `roster-roles.test.ts`, `roster-lifecycle.test.ts`, `roster-requests.test.ts`, `presence-tick.test.ts`

**Interfaces:**
- Consumes: `noticeClanTx`, `noticeUserTx` (Task 2); `actorGamertagTx` (`feed-actor.ts`); `ROSTER_COOLDOWN_MS`.
- Produces: the notice each write queues, in its own transaction, after its feed row if it has one:

| Write | Channel notice | DM |
|---|---|---|
| `createInvite` ok | — | `invited` to the invitee `{ clan, tag, link: <site>/me }` |
| `acceptInvite` ok | `joined { gamertag }` | — |
| `decideRequestDb` accepted | `joined { gamertag }` | `request_accepted { clan }` to the requester |
| `decideRequestDb` declined | — | `request_declined { clan }` |
| presence promotion | `became_full { gamertag }` | — |
| `expirePendingMembers` | — | `pending_expired { clan }` |
| `leave` ok | `left { gamertag }` | — |
| `kick` ok | `kicked { gamertag, officer }` | `kicked { clan, until: ISO }` to the target |
| `setRole` ok | `promoted`/`demoted { gamertag }` | — |
| `transfer` ok | `transferred { gamertag, old }` | — |
| `rename` ok | `renamed { name, tag }` | — |

The site link the invite DM carries needs the site base URL inside the package: `packages/roster/src/server.ts` (or a new `site-url.ts`) exports `siteBaseUrl(): string` reading `process.env.SITE_BASE_URL ?? "https://dayzclanwars.com"` — the same variable the bot uses; `apps/web`'s compose env already sets `WEB_BASE_URL`, so the runbook adds `SITE_BASE_URL` to the web container too. `createInvite` takes it as an argument (`siteBaseUrl`) from `inviteDb`, which reads it once; the bot never calls `createInvite` now.

- [ ] **Step 1: Failing tests** — one `it` per row of the table, in the file that already tests the write, asserting the `clan_notices` row(s) `{ target, kind, discordTargetId, payload }` after the write, and that a refused write queues nothing.

- [ ] **Step 2–3: Run, then implement** — at each write's success path, after `appendFactionEventTx` where one exists, before the transaction returns. Actor gamertags via `actorGamertagTx(tx, discordId)` (returns undefined when unknown; fall back to the Discord mention-free `"someone"` is wrong — use the discord id string, which the renderer prints as `<@id>`). `expirePendingMembers` becomes a transaction: delete `.returning(...)` then `noticeUserTx` per row with the clan name joined in. `presenceTick`'s promotion transaction adds `noticeClanTx(became_full)` after the member update.

- [ ] **Step 4: Run the bot and roster suites, then commit**

```bash
git add packages/roster/src apps/bot/src/presence-tick.ts apps/bot/test
git commit -m "feat(roster): every roster write queues its clan notice or DM in the same transaction"
```

---

### Task 7: The renderers and the two posters

**Files:**
- Create: `apps/bot/src/notice-text.ts`, `apps/bot/src/war-log-text.ts`, `apps/bot/src/notice-tick.ts`, `apps/bot/src/war-log-tick.ts`, `apps/bot/test/notice-text.test.ts`, `apps/bot/test/war-log-text.test.ts`, `apps/bot/test/notice-tick.test.ts`, `apps/bot/test/war-log-tick.test.ts`
- Modify: `apps/bot/src/config.ts` (`warLogChannelId: string | undefined` from `WAR_LOG_CHANNEL_ID`, optional like the feed), `apps/bot/test/config.test.ts`, `apps/bot/src/discord.ts` (wiring), `apps/bot/test/vocabulary.test.ts` (`PLAYER_FACING` gains `notice-text.ts`, `war-log-text.ts`), `apps/bot/README.md`

**Interfaces:**
- Produces:
  ```ts
  // notice-text.ts
  export function noticeText(n: { kind: ClanNoticeKind; target: NoticeTarget; occurredAt: Date; payload: NoticePayload }, now: Date): string;
  export const RENDERERS: Record<ClanNoticeKind, (p: NoticePayload, ctx: { target: NoticeTarget; age: string }) => string>;
  export function relativeAge(at: Date, now: Date): string;      // "6 min ago", "2 h ago", "3 d ago"
  export function duration(seconds: number): string;              // "3h 15m"
  // war-log-text.ts
  export function warLogText(e: { kind: WarLogKind; payload: NoticePayload }, siteBaseUrl: string): string;
  // notice-tick.ts
  export type NoticeSender = (target: NoticeTarget, discordTargetId: string, content: string) => Promise<void>;
  export async function noticeTick(store: NoticeStore, send: NoticeSender, opts: { now: Date; batchSize?: number; onError?: (id: number, attempts: number, err: unknown) => void }): Promise<{ posted: number; failed: number; blockedTargets: string[] }>;
  // war-log-tick.ts
  export async function warLogTick(store: WarLogStore, post: (content: string) => Promise<void>, opts: { now: Date; siteBaseUrl: string; batchSize?: number; onError?: (id: number, err: unknown) => void }): Promise<{ posted: number; blockedAt: number | null }>;
  ```

- [ ] **Step 1: Failing tests**

`notice-text.test.ts`:
```ts
  it("has exactly one renderer per CLAN_NOTICE_KINDS entry, and none for a kind not listed (spec §13)", () => {
    expect(Object.keys(RENDERERS).sort()).toEqual([...CLAN_NOTICE_KINDS].sort());
  });
  it("renders the §9.3 lines verbatim", () => {
    expect(noticeText({ kind: "flag_down", target: "channel", occurredAt: now, payload: { gamertag: "Wolfie", raiderClan: "Wolves" } }, now))
      .toBe("🚨 Your flag is down — lowered by Wolfie of Wolves. Re-raise within 24h or go dormant. Supplies paused.");
    expect(noticeText({ kind: "flag_down", target: "channel", occurredAt: now, payload: { gamertag: "Solo", raiderClan: null } }, now))
      .toBe("🚨 Your flag is down — lowered by Solo. Re-raise within 24h or go dormant. Supplies paused.");
    expect(noticeText({ kind: "defended", target: "channel", occurredAt: now, payload: { gamertag: "Bear1", durationSeconds: 11700 } }, now))
      .toBe("🛡️ Bear1 raised the flag. Defended — 3h 15m under siege. Supplies resume at next restart.");
    expect(noticeText({ kind: "non_member_raise", target: "channel", occurredAt: new Date(now.getTime() - 6 * 60_000), payload: { gamertag: "X" } }, now))
      .toBe("⚑ X (not a member) raised your flag at your base — 6 min ago");
    expect(noticeText({ kind: "kicked", target: "dm", occurredAt: now, payload: { clan: "Bears", until: "2026-09-08T00:00:00.000Z" } }, now))
      .toBe("You were removed from **Bears**. You can join a clan again on 8 Sep 2026.");
    expect(noticeText({ kind: "revived", target: "channel", occurredAt: now, payload: {} }, now)).toBe("☀️ The flag was raised. You're active again.");
  });
  it("never contains a coordinate even if a payload smuggled one past the type", () => {
    const text = noticeText({ kind: "joined", target: "channel", occurredAt: now, payload: { gamertag: "A", x: 12 } as never }, now);
    expect(text).not.toMatch(/12/u);
  });
```
`war-log-text.test.ts`: the four §9.2 lines, raid (clan) and raid (solo) and defense with `duration`; `week_closed`/`season_closed` render from their payloads even though nothing writes them yet (`{ first, second, third, p1, p2, p3 }` / `{ number, clan, points }` with `{link}` = `${siteBaseUrl}/seasons`) and "🏆 No Alphas this week — nobody scored." when `first` is null.
`notice-tick.test.ts` (fake store + fake sender): posts in id order per target; a throwing target does not block another target's rows; after three failures the row is failed and later rows for that target still post next tick; `markPosted` after a successful send.
`war-log-tick.test.ts`: stop at first failure, post-then-mark (mirror `feed-tick.test.ts`).

- [ ] **Step 2–3: Run, then implement**

`notice-text.ts` — the verbatim table of §9.3/§9.4, one arrow function per kind reading named payload keys. Rules: `{age}` = `ctx.age`; `{duration}` = `duration(p.durationSeconds)`; `{date}` = `d MMM yyyy` UTC from an ISO string; a missing gamertag renders as `someone`. `revived` with no gamertag: "☀️ The flag was raised. You're active again."; with one: "☀️ {gamertag} raised the flag. You're active again." `disband_warning`: "⚠️ {days} days until this clan is disbanded and the flag returns to the pool." `solo_lapsed`: "Your base declaration lapsed — no raise in 7 days. The pole goes public in 3 days unless you raise there and declare again: {link}" with the 7 and 3 from `days(SOLO_LAPSE_MS)`/`days(RELEASED_POLE_GRACE_MS)` rendered as numerals. `rebind_confirmed`: "📦 Moved. Supplies follow at the next restart. The old base goes public in {n} days." `flag_down` as a DM is the same text as the channel line. `noticeText` picks `RENDERERS[n.kind]` and passes `{ target, age: relativeAge(n.occurredAt, now) }`.

`notice-tick.ts`:
```ts
export async function noticeTick(store, send, opts) {
  const rows = await store.readUnposted(opts.batchSize ?? 50);
  const blocked = new Set<string>();
  const out = { posted: 0, failed: 0, blockedTargets: [] as string[] };
  for (const row of rows) {
    const target = row.discordTargetId!;
    if (blocked.has(target)) continue; // per-target order: nothing behind a failure posts this tick
    try {
      await send(row.target, target, noticeText(row, opts.now));
      await store.markPosted(row.id, opts.now);
      out.posted++;
    } catch (err) {
      const attempts = await store.markAttempt(row.id, opts.now);
      opts.onError?.(row.id, attempts, err);
      if (attempts >= NOTICE_MAX_ATTEMPTS) out.failed++;
      blocked.add(target);
    }
  }
  out.blockedTargets = [...blocked];
  return out;
}
```
`war-log-tick.ts` — a copy of `feedTick` over `WarLogStore` posting `warLogText(row, siteBaseUrl)` as plain content. `discord.ts`: `createChannelPoster(client, channelId)` for content strings; `NoticeSender` = DM via `client.users.fetch(id).send(content)` or channel via `client.channels.fetch(id)` + `isSendable()`; wire `raidTick`, `raiseTick` (after the pole and player projections, before verification), `warLogTick` (when `cfg.warLogChannelId`), `noticeTick` (always — DMs need no channel) after the feed tick; the `clientReady` warning names the war-log queue depth when `WAR_LOG_CHANNEL_ID` is unset. Config test for `WAR_LOG_CHANNEL_ID` mirrors `BOT_FEED_CHANNEL_ID`'s. README env row and a "Running" paragraph naming the two consumers and two posters.

- [ ] **Step 4: Run the bot suite and the gate, then commit**

```bash
git add apps/bot
git commit -m "feat(bot): the war-log and clan-notice posters, every §9 line that exists, the raid and raise consumers wired in"
```

---

### Task 8: `/base` says when the declaration lapsed

**Files:**
- Modify: `packages/roster/src/base.ts` (`BaseView.lapsed`), `packages/roster/test/base.test.ts`, `apps/web/app/base/page.tsx`, `apps/web/lib/base-copy.ts`

**Interfaces:**
- Produces: `BaseView` (linked branch) gains `lapsed: { at: Date } | null` — the viewer's most recent `solo_lapsed` DM row within `RELEASED_POLE_GRACE_MS` of now, when they have no declaration.

- [ ] **Step 1: Failing test** (`base.test.ts`): a linked player with a `solo_lapsed` notice row from an hour ago and no declaration → `lapsed.at` set; with a notice older than `RELEASED_POLE_GRACE_MS` → null; with a live declaration → null.

- [ ] **Step 2–3: Implement**: in `baseForDb`, when `declaration === null`, `select max(occurred_at) from clan_notices where target = 'dm' and kind = 'solo_lapsed' and discord_target_id = $discordId and occurred_at > now() - RELEASED_POLE_GRACE_MS`. The page, when `view.lapsed`, renders above the "Declared" section: `<p className="mt-6 rounded-md border border-gold bg-frame p-4 text-ink">Your declaration lapsed {when(view.lapsed.at)} — no raise in {days(SOLO_LAPSE_MS)}. Raise your flag at the pole and declare it again below before it goes public.</p>` (constants from `@factions/domain`; `when`/`days` from `@/lib/format`).

- [ ] **Step 4: Run roster and web suites, then commit**

```bash
git add packages/roster/src/base.ts packages/roster/test/base.test.ts apps/web/app/base/page.tsx apps/web/lib/base-copy.ts
git commit -m "feat(web): /base shows a lapsed declaration and how to re-declare"
```

---

### Task 9: Runbook, CLAUDE.md, spec §15

**Files:**
- Create: `docs/deploy/2026-09-05-raids-and-notices.md`
- Modify: `CLAUDE.md`, spec §15, `apps/bot/README.md` (if Task 7 left anything stale)

- [ ] **Step 1: Runbook**

```markdown
# Raids and notices (increment 3a) — deploy runbook

Migration 0023 adds seven nullable columns to `factions` and six tables. Nothing is dropped;
the bot may keep running while it applies, but restart it straight after: the raid and
raise consumers start at cursor 0 and fold every `flag.lowered`/`flag.raised` the log
already holds, which is exactly right (a raid last week is a raid) — but only once season 1
exists, so open the season BEFORE the restart.

1. **Read the migration.** `packages/db/migrations/0023_raids_and_queues.sql`.
2. **Apply 0023** with the one-off runner from `docs/deploy/2026-09-02-dormancy.md`.
3. **Stamp any pre-existing dormant clan's reason** (there are none on this deployment):
       update factions set dormant_reason = 'inactive' where status = 'dormant' and dormant_reason is null;
4. **Open season 1** — the raid consumer skips (and logs once per server) until this exists:
       insert into seasons (server_id, number, started_at) select id, 1, now() from servers where active;
5. **Env.** Bot `.env`: `WAR_LOG_CHANNEL_ID=<#war-log channel id>` (optional; without it raids
   queue and post in order once set). Web container (`docker-compose.yml`): `SITE_BASE_URL`
   alongside `WEB_BASE_URL`, same value — the invite DM's link is built inside the package.
6. **Deploy** bot and web together: `docker compose build web && docker compose up -d web &&
   sudo systemctl restart clan-wars-bot`.
7. **Confirm:** `journalctl -u clan-wars-bot -f` — no `raid tick failed` / `raise tick failed` /
   `notice tick failed`; `select count(*) from clan_notices where posted_at is null and
   failed_at is null and target = 'channel'` is the number of channel notices waiting for
   increment 3b's channels (expected: everything channel-bound, none failed).
8. **Acceptance.** A non-member lowers a test clan's flag: within a tick `raids` has a row,
   `factions.flag_down_since` is set, `#war-log` shows the raid line, every full member has a
   flag_down DM. A member raises: `defenses` row, `#war-log` defense line, `flag_down_since`
   null. Then the dormancy check from `docs/deploy/2026-09-05-declarations.md` step 9.
9. **What did not change / what waits.** No clan channel or role exists yet (3b); channel
   notices queue unfailed. `dormant` still DMs the leader as before AND queues the channel
   line. The verification DMs (`linked`, lockouts) still ride `notifyCompleted`, not the queue.
```

- [ ] **Step 2: CLAUDE.md**

- Lock order bullet: append `war_log_events → clan_notices` after `faction_events`, and the sentence "All three queues are insert-only and always last; a channel notice with no channel yet waits with a null target (3b fills it)."
- Replace every mention of `SUPPLIED_STATUSES` with the predicate (`status = 'active' and flag_down_since is null`, spelled in the worker and pinned by `holding-index-drift.test.ts`).
- The "two entrances to dormant" hazard from spec §14 becomes a bullet: `dormant_reason` is a column; anything switching on `status` alone is correct.
- Consumers table/bullet: add `raid-consumer`, `raise-consumer`, the notice poster (per-target, 3 attempts) and the war-log poster (stop-on-failure).
- Current state: "Increment 3a merged; not deployed until `docs/deploy/2026-09-05-raids-and-notices.md`."

- [ ] **Step 3: Spec §15** — row 3 becomes two rows: `3a` **Raids and notices** (`2026-09-05-raids-and-notices.md`: raid and defense consumers, flag-down clock, `dormant_reason`, `war_log_events`, `clan_notices` with the poster, every §9 line that exists by now, `lapsed`, the `/base` lapsed copy) and `3b` **Discord structure** (`2026-09-xx-discord-structure.md`: per-clan role, text and voice channel at activation, deleted at disband, reconciled on start; `@Linked` role on link/unlink; nickname clear on a site unlink; the channel target for queued notices). Rows 4 and 5 depend on `3a`; the notices row 5 needs on `3b` for channel delivery.

- [ ] **Step 4: Gate and commit**

Full gate → 26/26.
```bash
git add docs/deploy/2026-09-05-raids-and-notices.md CLAUDE.md docs/superpowers/specs/2026-09-04-clan-wars-target-state-design.md apps/bot/README.md
git commit -m "docs: 3a runbook; CLAUDE.md for the queues and the supplied predicate; spec §15 splits increment 3"
```

---

## Self-review

**Spec coverage.** §4.3 columns (Task 1; `next_vote_allowed_at` is increment 7's). §4.7 three queues with `no_coordinates`, id order, per-target failure (Tasks 1, 2, 7). §4.8 `seasons`, `raids`, `defenses`, `season_standings` (Task 1; `alpha_weeks`, `season_results` are increment 4's). §5.1 `lapsed` announced, revive clears the raided state (Tasks 4, 5). §5.8 the full clock: raid → flag down → defense or dormant(raided), later lowers absorbed, a defense counts even if lowered again (Tasks 3, 4, 5). §7 raid consumer, defense consumer, dormancy changed, revive with actor, disband warning, non-member raise / colors elsewhere / rebind proposal, the two posters (Tasks 3–7); presence promotion's `became_full` and expiry's `pending_expired` (Task 6). §8.1–8.2 points and credit (Tasks 1, 3). §9.2 raid/defense lines and the feed's `lapsed` (Tasks 5, 7); §9.3/§9.4 every line whose writer exists (Task 7's kind list matches Tasks 3–6's writers). §15 row 3's `/base` lapsed copy (Task 8). Deferred to 3b: role, channels, `@Linked`, nickname clear. Deferred to their increments: intruder, dismantle/gate, succession, votes, vault, guest, week/season close, `ceremony_detected`/`linked`/`link_*` moving onto the queue (they keep their existing delivery paths; a ruling for the executor to confirm).

**Placeholders.** Tasks 3–6 give tests as `it(...)` bodies with comments where the assertion is a mechanical repeat of the pattern above it; each names the exact rows and values to assert. Task 6's table is the specification for eleven small edits of one shape.

**Type consistency.** `noticeClanTx`/`noticeUserTx`/`noticeFullMembersTx`/`appendWarLogTx` (Task 2) are the only writers Tasks 3–6 call; `NoticeStore`/`WarLogStore` (Task 2) are what Task 7's ticks take; `CLAN_NOTICE_KINDS` (Task 1) is what Task 7's drift test pins and what every writer's `kind` must belong to; `openSeason` (Task 3) is shared with Task 4; `DormantReason` (Task 1) is `goDormant`'s parameter (Task 5); `BaseView.lapsed` (Task 8) reads the `solo_lapsed` rows Task 5 writes.
