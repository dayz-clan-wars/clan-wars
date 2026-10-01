# Website Live Feeds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Discord feed (players online, hits, kills, killstreaks, long range, clan feed, war log, achievements, bans) is readable on a public `/live/[feed]` page that refreshes itself.

**Architecture:** A new `feed_entries` table holds the four combat feeds, written by bot "recorder" ticks that reuse the existing Discord feed stores under their own cursors (no seeding, so the first run is the backfill; hits seed at the head). The other five feeds are read from tables that already exist. The wording moves from the bot's embed files into `packages/copy` as a small segment model (`Line = Seg[]`), rendered to Discord markdown by the bot and to JSX by the web, so both say the same thing. The web reads through two new `@factions/roster` exports and polls a public GET route.

**Tech Stack:** TypeScript, pnpm + turbo, drizzle-orm 0.36 / drizzle-kit 0.28 over postgres.js, discord.js, Next 16 App Router (React 19, Tailwind v4), vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-website-live-feeds-design.md`

## Global Constraints

- Discord output must not change. Every existing test under `apps/bot/test/*-embed.test.ts`, `war-log-text.test.ts`, `ban-announce-text.test.ts`, `achievement-embed.test.ts`, `online-embed.test.ts`, `feed-embed.test.ts` passes **with no edits**.
- No coordinates in anything this work stores or serves. `feed_entries.payload` carries a CHECK rejecting position keys.
- `packages/copy` imports no runtime value from `@factions/roster` (`packages/copy/test/leaf.test.ts`), and emits no Discord `<t:…>` tokens (`no-discord-tokens.test.ts`); times are `{ time, style }` segments.
- `apps/web` imports only `@factions/roster`, `@factions/domain`, `@factions/copy`; never `@factions/db` or `@factions/roster/internal`. No web identifier contains "faction" (`copy-vocabulary.test.ts`).
- Adding a roster export means editing `packages/roster/src/api.ts`, `packages/roster/src/index.ts`, `packages/roster/test/roster-exports.ts` and the list in `apps/web/test/smoke.test.ts`.
- Every new page/layout under `app/` that imports `@factions/roster` sets `export const dynamic = "force-dynamic"`.
- Web styling uses only `globals.css` tokens and `app/components/ui.tsx` primitives; no raw hex (`raw-hex.test.ts`).
- Web timestamps use `when()` (UTC), never relative times.
- Player-facing copy: plain voice, punctuation per `brand/02-verbal-identity.md` (em dashes and the middot allowed), no exclamation marks, never discourage raiding, never describe flag-down time as a siege or a stand in NEW copy.
- Never point anything at `factions_live`. Tests use `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"`. Never run two vitest/turbo test runs at once.
- Full gate: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force` from `clan-wars/`, expect **32/32 tasks**.
- Commits end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Tj1apLptQ9wFx5XMicQKJh
  ```

## Review Focus

1. **An achievement whose owner is an unlinked player with no gamertag** (payload `ownerName` is a Discord id): the site must say "A player", never print the digits. Pinned in Task 4 (copy) and Task 9 (roster nulls it).
2. **Junk in a frozen jsonb payload** (`disbandAt`, `expiresAt`, `occurredAt` unparseable): the line must degrade the way Discord does (drop the clause), never print "Invalid Date" or "NaN". Pinned in Task 4.
3. **Attacker-supplied query params** (`?before=abc`, `?after=-1`, `?before=1e309`, an unknown `/live/foo`): ignored or 404, never a SQL error or a 500. Pinned in Task 11.
4. **A blocked or unconfigured Discord channel**: the recorder still records, because it has its own cursor and runs whether or not the poster exists. Pinned in Task 8.
5. **A recorder crash between insert and cursor write**: the re-run must not duplicate the entry (`ON CONFLICT DO NOTHING` on `(kind, source_event_id)`). Pinned in Task 8.

---

### Task 1: `feed_entries` table and migration

**Files:**
- Modify: `packages/db/src/schema.ts` (add the table after `banAnnouncements`, ~line 2096)
- Create: `packages/db/migrations/0061_*.sql` and `packages/db/migrations/meta/0061_snapshot.json` (generated)
- Test: `apps/bot/test/feed-entries-schema.test.ts`

**Interfaces:**
- Produces: `feedEntries` table export from `@factions/db` with columns `id, serverId, kind, sourceEventId, occurredAt, payload, createdAt`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/bot/test/feed-entries-schema.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events, feedEntries, type Database } from "@factions/db";
import { sql } from "drizzle-orm";

const URL = requireTestDatabaseUrl();
const t0 = new Date("2026-09-08T00:00:00Z");

describe("feed_entries", () => {
  let db: Database;
  let serverId: number;
  let eventId: number;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table feed_entries, events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: t0, linesIngested: 0, complete: true }).returning();
    const [e] = await db.insert(events).values({ serverId, admFileId: f!.id, lineIndex: 0, type: "player.killed" as never, occurredAt: t0, payload: {} }).returning({ id: events.id });
    eventId = e!.id;
  });

  const row = (payload: unknown, kind = "kill") => ({ serverId, kind: kind as never, sourceEventId: eventId, occurredAt: t0, payload });

  it("accepts a payload with no positions", async () => {
    await db.insert(feedEntries).values(row({ killer: { gamertag: "A", tag: null, texture: null }, hits: [{ damage: 30, bodyPart: "Torso", weapon: "KA-74", distanceM: 41 }] }));
    const rows = await db.select().from(feedEntries);
    expect(rows).toHaveLength(1);
  });

  it.each(["pos", "victimPos", "attackerPos", "killerPos", "poleKey", "x", "y", "z"])("rejects a %s key at the top level", async (k) => {
    await expect(db.insert(feedEntries).values(row({ [k]: 1 }))).rejects.toThrow(/feed_entries_no_coordinates/u);
  });

  it("rejects a position key nested inside a hit line", async () => {
    await expect(db.insert(feedEntries).values(row({ hits: [{ damage: 1, victimPos: [1, 2, 3] }] }))).rejects.toThrow(/feed_entries_no_coordinates/u);
  });

  it("does not trip on a gamertag that merely spells a key", async () => {
    await db.insert(feedEntries).values(row({ killer: { gamertag: "\"x\": 1", tag: "x", texture: null } }));
    expect(await db.select().from(feedEntries)).toHaveLength(1);
  });

  it("rejects an unknown kind", async () => {
    await expect(db.insert(feedEntries).values(row({}, "raid"))).rejects.toThrow(/feed_entries_kind_valid/u);
  });

  it("is unique on (kind, source_event_id) so a re-run cannot double-write", async () => {
    await db.insert(feedEntries).values(row({}));
    await db.insert(feedEntries).values(row({})).onConflictDoNothing();
    expect(await db.select().from(feedEntries)).toHaveLength(1);
    // A different kind for the same kill is a separate entry (a kill can also be a streak milestone).
    await db.insert(feedEntries).values(row({}, "killstreak"));
    expect(await db.select().from(feedEntries)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/feed-entries-schema.test.ts`
Expected: FAIL, `feedEntries` is not exported from `@factions/db`.

- [ ] **Step 3: Add the table to `packages/db/src/schema.ts`**

Add next to `banAnnouncements`. Import `LiveEntryKind` from `@factions/domain` once Task 2 lands; until then type it inline as shown (Task 2 swaps it).

```ts
/**
 * The website's copy of the four combat feeds (spec 2026-09-30-website-live-feeds).
 * Written by the bot's recorder ticks (apps/bot/src/live-recorder.ts), one row
 * per kill, engagement, streak milestone or long-range kill, with the facts
 * its Discord embed is built from FROZEN in `payload`. Read by the site's
 * /live pages through @factions/roster. Nothing updates or deletes a row.
 *
 * ⚠️ The position CHECK runs over the payload's TEXT so it catches a key at any
 * depth: `hits` is an array of objects, and a `?` test only sees the top level.
 * jsonb::text prints keys as `"key": `, and a string VALUE containing that
 * shape is printed escaped (`\"x\": `), so a gamertag cannot trip it.
 */
export const feedEntries = pgTable("feed_entries", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  kind: text("kind").$type<"kill" | "hit" | "killstreak" | "long_range">().notNull(),
  /** The kill's `events.id`, or the last hit event of an engagement: the recorder's cursor value. */
  sourceEventId: bigint("source_event_id", { mode: "number" }).notNull().references(() => events.id),
  /** When it happened in game, not when the row was written; the backfill writes old entries. */
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  kindValid: check("feed_entries_kind_valid", sql`${t.kind} IN ('kill','hit','killstreak','long_range')`),
  noCoordinates: check("feed_entries_no_coordinates",
    sql`NOT (${t.payload}::text ~ '"(pos|victimPos|attackerPos|killerPos|poleKey|x|y|z)": ')`),
  uniqSource: uniqueIndex("feed_entries_source_uniq").on(t.kind, t.sourceEventId),
  byKind: index("feed_entries_kind_idx").on(t.serverId, t.kind, t.id),
}));
```

- [ ] **Step 4: Generate the migration**

Run: `cd packages/db && npx drizzle-kit generate`
Expected: a new `migrations/0061_<name>.sql` containing `CREATE TABLE "feed_entries"`, both CHECKs, the unique index and the kind index, plus `meta/0061_snapshot.json` and a `_journal.json` entry. Read the SQL and confirm the CHECK regex survived quoting intact (`'"(pos|victimPos|attackerPos|killerPos|poleKey|x|y|z)": '`).

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/feed-entries-schema.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations apps/bot/test/feed-entries-schema.test.ts
git commit -m "feat(db): feed_entries, the website's copy of the combat feeds"
```

---

### Task 2: Live feed types in `@factions/domain`

**Files:**
- Create: `packages/domain/src/live-feed.ts`
- Modify: `packages/domain/src/index.ts` (re-export), `packages/db/src/schema.ts` (use `LiveEntryKind`)
- Test: `packages/domain/test/live-feed.test.ts`

**Interfaces:**
- Produces:
  - `LIVE_ENTRY_KINDS = ["kill","hit","killstreak","long_range"] as const`, `type LiveEntryKind`
  - `LIVE_FEEDS = ["online","kills","hits","streaks","long-range","clans","war-log","achievements","bans"] as const`, `type LiveFeed`
  - `LIVE_FEED_KIND: Record<"kills"|"hits"|"streaks"|"long-range", LiveEntryKind>`
  - `isLiveFeed(s: string): s is LiveFeed`
  - `LIVE_PAGE_SIZE = 50`
  - Payload types: `LiveSide`, `LiveHitLine`, `LiveKill`, `LiveHitRun`, `LiveStreak`, `LiveLongRange`, `LivePayload` (map kind → type). All instants are ISO strings.

- [ ] **Step 1: Write the failing test**

```ts
// packages/domain/test/live-feed.test.ts
import { describe, it, expect } from "vitest";
import { LIVE_FEEDS, LIVE_ENTRY_KINDS, LIVE_FEED_KIND, isLiveFeed, LIVE_PAGE_SIZE } from "../src/index";

describe("live feeds", () => {
  it("names the nine Discord feeds in tab order", () => {
    expect([...LIVE_FEEDS]).toEqual(["online", "kills", "hits", "streaks", "long-range", "clans", "war-log", "achievements", "bans"]);
  });
  it("maps every combat tab to a stored kind", () => {
    expect(Object.values(LIVE_FEED_KIND).sort()).toEqual([...LIVE_ENTRY_KINDS].sort());
  });
  it("accepts only known slugs", () => {
    expect(isLiveFeed("kills")).toBe(true);
    expect(isLiveFeed("constructor")).toBe(false);
    expect(isLiveFeed("")).toBe(false);
  });
  it("pages by 50", () => expect(LIVE_PAGE_SIZE).toBe(50));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/domain && npx vitest run test/live-feed.test.ts`
Expected: FAIL, exports missing. (If `packages/domain/test` does not exist, create it; check `packages/domain/package.json` has a `test` script and add `"test": "vitest run"` if not, matching `packages/copy/package.json`.)

- [ ] **Step 3: Write `packages/domain/src/live-feed.ts`**

```ts
/**
 * The website's Live page (spec 2026-09-30-website-live-feeds): one tab per
 * Discord feed. The four combat feeds are stored in `feed_entries` with one of
 * these payloads, frozen at record time. Every instant is an ISO string because
 * jsonb has no timestamp type. No payload ever carries a position.
 */
export const LIVE_ENTRY_KINDS = ["kill", "hit", "killstreak", "long_range"] as const;
export type LiveEntryKind = (typeof LIVE_ENTRY_KINDS)[number];

export const LIVE_FEEDS = ["online", "kills", "hits", "streaks", "long-range", "clans", "war-log", "achievements", "bans"] as const;
export type LiveFeed = (typeof LIVE_FEEDS)[number];
export type LiveCombatFeed = "kills" | "hits" | "streaks" | "long-range";

export const LIVE_FEED_KIND: Record<LiveCombatFeed, LiveEntryKind> = {
  kills: "kill", hits: "hit", streaks: "killstreak", "long-range": "long_range",
};

export const LIVE_PAGE_SIZE = 50;

export function isLiveFeed(s: string): s is LiveFeed {
  return (LIVE_FEEDS as readonly string[]).includes(s);
}

/** One side: the gamertag, and the clan tag and flag at the moment of the entry. */
export type LiveSide = { gamertag: string; tag: string | null; texture: string | null };
export type LiveHitLine = { damage: number | null; bodyPart: string | null; weapon: string | null; distanceM: number | null };

export type LiveKill = {
  occurredAt: string;
  killer: LiveSide; victim: LiveSide;
  weapon: string | null; distanceM: number | null;
  friendlyFire: boolean; atHub: boolean; cause: string;
  tally: { killerKills: number; victimDeaths: number; season: number | null };
  hits: LiveHitLine[];
};

export type LiveHitRun = {
  occurredAt: string; startedAt: string;
  attacker: LiveSide; victim: LiveSide;
  weapon: string | null; friendlyFire: boolean;
  hits: LiveHitLine[]; totalDamage: number | null; victimHpAfter: number | null;
};

export type LiveStreak = { occurredAt: string; startedAt: string; killer: LiveSide; streak: number; victims: string[] };

export type LiveLongRange = {
  occurredAt: string;
  killer: LiveSide; victim: LiveSide;
  weapon: string | null; distanceM: number | null; friendlyFire: boolean;
  personalBest: boolean; seasonRank: number | null; season: number | null;
};

export type LivePayload = { kill: LiveKill; hit: LiveHitRun; killstreak: LiveStreak; long_range: LiveLongRange };
```

Add to `packages/domain/src/index.ts`:

```ts
export * from "./live-feed";
```

(Match the file's existing re-export style; if it lists names explicitly, list these names.)

In `packages/db/src/schema.ts`, import `type LiveEntryKind` from `@factions/domain` and change the column to `text("kind").$type<LiveEntryKind>()`.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd packages/domain && npx vitest run test/live-feed.test.ts && cd ../db && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/domain packages/db/src/schema.ts
git commit -m "feat(domain): live feed slugs and combat payload types"
```

---

### Task 3: Shared combat-feed wording in `@factions/copy`

**Files:**
- Create: `packages/copy/src/live-feed.ts`
- Modify: `packages/copy/src/index.ts`
- Test: `packages/copy/test/live-feed.test.ts`

**Interfaces:**
- Consumes: `LiveKill`, `LiveHitRun`, `LiveStreak`, `LiveLongRange`, `LiveSide`, `LiveHitLine` from Task 2.
- Produces (all exported from `@factions/copy`):
  ```ts
  type Seg =
    | string                                 // fixed copy, printed as is everywhere
    | { text: string }                       // player data; the bot escapes markdown
    | { raw: string }                        // player data the bot has always posted unescaped
    | { bold: Seg[] }
    | { player: string }                     // a gamertag linking to /players/<gt>
    | { clan: string; name?: string }        // a tag linking to /clans/<tag>; with name, "**Name** [TAG]"
    | { time: string; style: "at" | "rel" }  // an ISO instant; only emitted when it parses
    | { page: string; label: string };       // a site-relative link, e.g. "/seasons"
  type Line = Seg[];
  type LiveCard = { title: Line; href: string; lines: Line[]; detail: Line[] };
  who(side: LiveSide): Line
  killCard(k: LiveKill): LiveCard
  hitCard(h: LiveHitRun): LiveCard
  streakCard(s: LiveStreak): LiveCard
  longRangeCard(l: LiveLongRange): LiveCard
  DETAIL_LINE_CAP = 10
  ```
  `href` is site-relative (`/players/<encoded gamertag>`). The bot prefixes `siteBaseUrl`.

The wording below is copied character for character from `apps/bot/src/kill-feed-embed.ts`, `hit-feed-embed.ts`, `killstreak-feed-embed.ts`, `long-range-feed-embed.ts`. Where those files escape a value (`escapeMarkdown(x)`) the segment is `{ text: x }`; where they print it bare the segment is `{ raw: x }`. That split is what keeps Discord byte-identical in Task 5.

- [ ] **Step 1: Write the failing test**

```ts
// packages/copy/test/live-feed.test.ts
import { describe, it, expect } from "vitest";
import type { LiveKill, LiveHitRun, LiveStreak, LiveLongRange } from "@factions/domain";
import { killCard, hitCard, streakCard, longRangeCard, who, type Line, type Seg } from "../src/index";

/** Flatten to plain text the way the site prints it, for readable assertions. */
const plain = (l: Line): string => l.map((s: Seg): string => {
  if (typeof s === "string") return s;
  if ("text" in s) return s.text;
  if ("raw" in s) return s.raw;
  if ("bold" in s) return plain(s.bold);
  if ("player" in s) return s.player;
  if ("clan" in s) return s.name ? `${s.name} [${s.clan}]` : s.clan;
  if ("time" in s) return `<${s.style}:${s.time}>`;
  return s.label;
}).join("");

const A = { gamertag: "Alpha", tag: "AAA", texture: "Flag_Wolf" };
const B = { gamertag: "Bravo", tag: null, texture: null };
const kill: LiveKill = {
  occurredAt: "2026-09-08T01:00:00.000Z", killer: A, victim: B, weapon: "KA-74", distanceM: 41.4,
  friendlyFire: false, atHub: false, cause: "pvp", tally: { killerKills: 3, victimDeaths: 1, season: 2 },
  hits: [{ damage: 38.2, bodyPart: "Torso", weapon: "KA-74", distanceM: 41 }],
};

describe("who", () => {
  it("bolds a linked gamertag and adds a linked tag", () => {
    expect(who(A)).toEqual([{ bold: [{ player: "Alpha" }] }, " [", { clan: "AAA" }, "]"]);
    expect(who(B)).toEqual([{ bold: [{ player: "Bravo" }] }]);
  });
});

describe("killCard", () => {
  it("says who killed whom, how, and the season tally", () => {
    const c = killCard(kill);
    expect(plain(c.title)).toBe("Alpha [AAA]");
    expect(c.href).toBe("/players/Alpha");
    expect(c.lines.map(plain)).toEqual(["killed Bravo", "KA-74 · 41 m", "3 kills for Alpha · 1 death for Bravo this season"]);
    expect(c.detail.map(plain)).toEqual(["38 dmg · Torso · KA-74 · 41 m"]);
  });
  it("labels the Hub ahead of friendly fire, and says finished", () => {
    expect(plain(killCard({ ...kill, atHub: true, friendlyFire: true }).title)).toBe("At the Hub — Alpha [AAA]");
    expect(plain(killCard({ ...kill, friendlyFire: true }).title)).toBe("Friendly fire — Alpha [AAA]");
    expect(plain(killCard({ ...kill, friendlyFire: true, cause: "finished" }).lines[0]!)).toBe("finished their own clanmate Bravo");
  });
  it("counts all-time before any season, and drops an empty how line", () => {
    const c = killCard({ ...kill, weapon: null, distanceM: null, tally: { killerKills: 1, victimDeaths: 2, season: null } });
    expect(c.lines.map(plain)).toEqual(["killed Bravo", "1 kill for Alpha · 2 deaths for Bravo all-time"]);
  });
  it("caps the hit run at ten lines", () => {
    const hits = Array.from({ length: 12 }, () => ({ damage: 10, bodyPart: "Head", weapon: null, distanceM: null }));
    const d = killCard({ ...kill, hits }).detail.map(plain);
    expect(d).toHaveLength(11);
    expect(d[10]).toBe("… and 2 more hits");
  });
});

describe("hitCard", () => {
  const h: LiveHitRun = {
    occurredAt: "2026-09-08T01:00:00.000Z", startedAt: "2026-09-08T00:59:00.000Z", attacker: A, victim: B,
    weapon: "M4-A1", friendlyFire: false, totalDamage: 75.6, victimHpAfter: 12.2,
    hits: [{ damage: 40, bodyPart: "Torso", weapon: "M4-A1", distanceM: 80 }, { damage: 35.6, bodyPart: "LeftLeg", weapon: "M4-A1", distanceM: 81 }],
  };
  it("summarises the engagement without repeating the weapon per hit", () => {
    const c = hitCard(h);
    expect(c.lines.map(plain)).toEqual(["hit Bravo 2 times · M4-A1", "76 damage · left them at 12 HP"]);
    expect(c.detail.map(plain)).toEqual(["40 dmg · Torso · 80 m", "36 dmg · LeftLeg · 81 m"]);
  });
  it("says once for one hit", () => {
    expect(plain(hitCard({ ...h, hits: [h.hits[0]!] }).lines[0]!)).toBe("hit Bravo once · M4-A1");
  });
});

describe("streakCard", () => {
  it("names the streak, the victims and how long it has run", () => {
    const s: LiveStreak = { occurredAt: "2026-09-08T01:00:00.000Z", startedAt: "2026-09-08T00:20:00.000Z", killer: A, streak: 3, victims: ["V1", "V2", "V3"] };
    const c = streakCard(s);
    expect(c.lines.map(plain)).toEqual(["🔥 3 kill streak", "last 3: V1, V2, V3", "started 40 minutes ago"]);
  });
});

describe("longRangeCard", () => {
  const l: LiveLongRange = {
    occurredAt: "2026-09-08T01:00:00.000Z", killer: A, victim: B, weapon: "Mosin", distanceM: 412.6, friendlyFire: false,
    personalBest: true, seasonRank: 3, season: 2,
  };
  it("leads with the distance and names both records", () => {
    expect(longRangeCard(l).lines.map(plain)).toEqual(["🎯 413 m", "killed Bravo · Mosin", "Alpha's longest yet · 3rd longest this season"]);
  });
  it("says longest for rank 1 and omits records it does not hold", () => {
    expect(longRangeCard({ ...l, personalBest: false, seasonRank: 1, season: null }).lines.map(plain)[2]).toBe("longest all-time");
    expect(longRangeCard({ ...l, personalBest: false, seasonRank: null }).lines).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/copy && npx vitest run test/live-feed.test.ts`
Expected: FAIL, exports missing.

- [ ] **Step 3: Write `packages/copy/src/live-feed.ts`**

```ts
import type { LiveHitLine, LiveHitRun, LiveKill, LiveLongRange, LiveSide, LiveStreak } from "@factions/domain";

/**
 * The feeds' wording as data, shared by the bot (Discord markdown) and the
 * site (JSX) so the two can never say different things
 * (spec 2026-09-30-website-live-feeds). Each feed's text is a list of Lines;
 * a Line is a list of segments. Fixed copy is a bare string. Player data is
 * `{ text }` when the bot has always escaped it and `{ raw }` when it has
 * always printed it bare: that split is what keeps Discord byte-identical.
 *
 * ⚠️ No Discord tokens here (`no-discord-tokens.test.ts`). An instant is a
 * `{ time, style }` segment, emitted only when it parses; each renderer
 * formats it its own way.
 */
export type Seg =
  | string
  | { text: string }
  | { raw: string }
  | { bold: Seg[] }
  | { player: string }
  | { clan: string; name?: string }
  | { time: string; style: "at" | "rel" }
  | { page: string; label: string };
export type Line = Seg[];

/** Title (an embed title on Discord), the page it links to, the body lines, and the per-hit lines below a gap. */
export type LiveCard = { title: Line; href: string; lines: Line[]; detail: Line[] };

/** ⚠️ Ten, not Discord's limit: a long firefight stops being readable first. */
export const DETAIL_LINE_CAP = 10;

export const playerPath = (gamertag: string): string => `/players/${encodeURIComponent(gamertag)}`;
export const clanPath = (tag: string): string => `/clans/${encodeURIComponent(tag)}`;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const finite = (n: number | null): n is number => n !== null && Number.isFinite(n);

/** Join non-empty parts with " · ". */
function dotted(parts: Line[]): Line {
  const out: Line = [];
  for (const p of parts.filter((x) => x.length > 0)) {
    if (out.length > 0) out.push(" · ");
    out.push(...p);
  }
  return out;
}

export function who(side: LiveSide): Line {
  const name: Seg = { bold: [{ player: side.gamertag }] };
  return side.tag ? [name, " [", { clan: side.tag }, "]"] : [name];
}

/** The embed title: gamertag bare, tag escaped, exactly as the bot built it. */
function titleOf(prefix: string, side: LiveSide): Line {
  return [...(prefix ? [prefix] : []), { raw: side.gamertag }, ...(side.tag ? [" [", { text: side.tag }, "]"] : [])];
}

/** `KA-74 · 41 m`, or whichever half there is. */
export function howLine(weapon: string | null, distanceM: number | null): Line {
  return dotted([weapon ? [{ text: weapon }] : [], finite(distanceM) ? [`${Math.round(distanceM)} m`] : []]);
}

/** `38 dmg · Torso · KA-74 · 41 m`. The weapon only when asked: the hit feed names it once in the header. */
export function detailLine(d: LiveHitLine, opts: { weapon?: boolean } = {}): Line {
  return dotted([
    finite(d.damage) ? [`${Math.round(d.damage)} dmg`] : [],
    d.bodyPart ? [{ text: d.bodyPart }] : [],
    opts.weapon && d.weapon ? [{ text: d.weapon }] : [],
    finite(d.distanceM) ? [`${Math.round(d.distanceM)} m`] : [],
  ]);
}

export function cappedLines(lines: Line[], noun: string): Line[] {
  if (lines.length <= DETAIL_LINE_CAP) return lines;
  return [...lines.slice(0, DETAIL_LINE_CAP), [`… and ${lines.length - DETAIL_LINE_CAP} more ${noun}`]];
}

export function killCard(k: LiveKill): LiveCard {
  const verb = k.cause === "finished" ? "finished" : "killed";
  const scope = k.tally.season === null ? "all-time" : "this season";
  const how = howLine(k.weapon, k.distanceM);
  return {
    title: titleOf(k.atHub ? "At the Hub — " : k.friendlyFire ? "Friendly fire — " : "", k.killer),
    href: playerPath(k.killer.gamertag),
    lines: [
      k.friendlyFire ? [`${verb} their own clanmate `, ...who(k.victim)] : [`${verb} `, ...who(k.victim)],
      ...(how.length > 0 ? [how] : []),
      [`${plural(k.tally.killerKills, "kill")} for `, { text: k.killer.gamertag }, ` · ${plural(k.tally.victimDeaths, "death")} for `, { text: k.victim.gamertag }, ` ${scope}`],
    ],
    detail: cappedLines(k.hits.map((h) => detailLine(h, { weapon: true })).filter((l) => l.length > 0), "hits"),
  };
}

export function hitCard(h: LiveHitRun): LiveCard {
  const times = h.hits.length === 1 ? "once" : `${h.hits.length} times`;
  const head: Line = [`hit `, ...who(h.victim), ` ${times}`, ...(h.weapon ? [" · ", { text: h.weapon }] : [])];
  const summary = dotted([
    finite(h.totalDamage) ? [`${Math.round(h.totalDamage)} damage`] : [],
    finite(h.victimHpAfter) ? [`left them at ${Math.round(h.victimHpAfter)} HP`] : [],
  ]);
  return {
    title: titleOf(h.friendlyFire ? "Friendly fire — " : "", h.attacker),
    href: playerPath(h.attacker.gamertag),
    lines: [head, ...(summary.length > 0 ? [summary] : [])],
    detail: cappedLines(h.hits.map((x) => detailLine(x)).filter((l) => l.length > 0), "hits"),
  };
}

function elapsed(fromIso: string, toIso: string): string {
  const s = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
  if (!Number.isFinite(s)) return plural(0, "second");
  if (s < 60) return plural(s, "second");
  const m = Math.round(s / 60);
  if (m < 60) return plural(m, "minute");
  return plural(Math.round(s / 3600), "hour");
}

export function streakCard(s: LiveStreak): LiveCard {
  const names = cappedLines(s.victims.map((v) => [{ text: v }]), "victims");
  const joined: Line = [];
  names.forEach((n, i) => { if (i > 0) joined.push(", "); joined.push(...n); });
  return {
    title: titleOf("", s.killer),
    href: playerPath(s.killer.gamertag),
    lines: [
      ["🔥 ", { bold: [`${s.streak} kill streak`] }],
      ...(s.victims.length > 0 ? [[`last ${s.victims.length}: `, ...joined]] : []),
      [`started ${elapsed(s.startedAt, s.occurredAt)} ago`],
    ],
    detail: [],
  };
}

function ordinal(n: number): string {
  const r = n % 100;
  if (r >= 11 && r <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

export function longRangeCard(l: LiveLongRange): LiveCard {
  const scope = l.season === null ? "all-time" : "this season";
  const records = dotted([
    l.personalBest ? [{ text: l.killer.gamertag }, "'s longest yet"] : [],
    l.seasonRank !== null ? [l.seasonRank === 1 ? `longest ${scope}` : `${ordinal(l.seasonRank)} longest ${scope}`] : [],
  ]);
  return {
    title: titleOf(l.friendlyFire ? "Friendly fire — " : "", l.killer),
    href: playerPath(l.killer.gamertag),
    lines: [
      ["🎯 ", { bold: [`${l.distanceM === null ? "—" : Math.round(l.distanceM)} m`] }],
      ["killed ", ...who(l.victim), ...(l.weapon ? [" · ", { text: l.weapon }] : [])],
      ...(records.length > 0 ? [records] : []),
    ],
    detail: [],
  };
}
```

Note: the original `killstreak` embed renders `streak ?? 0`; the stored payload's `streak` is a number (the recorder only stores milestones), and the bot converter in Task 5 passes `i.streak ?? 0`.

Add to `packages/copy/src/index.ts`:

```ts
export {
  type Seg, type Line, type LiveCard, DETAIL_LINE_CAP, playerPath, clanPath,
  who, howLine, detailLine, cappedLines, killCard, hitCard, streakCard, longRangeCard,
} from "./live-feed";
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/copy && npx vitest run`
Expected: PASS, including `leaf.test.ts` and `no-discord-tokens.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/copy
git commit -m "feat(copy): combat feed wording as shared segments"
```

---

### Task 4: Shared wording for clan feed, war log, bans, achievements, online

**Files:**
- Modify: `packages/copy/src/live-feed.ts`, `packages/copy/src/index.ts`
- Test: `packages/copy/test/live-feed-text.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type ClanFeedPayload = { name: string; tag: string; texture: string; actor?: string; previousName?: string; disbandAt?: string };
  clanFeedCard(kind: FactionEventKind, p: ClanFeedPayload): LiveCard   // title "Name [TAG]", href /clans/TAG, one line
  flagLabel(texture: string): string
  warLogLine(kind: WarLogKind, p: Record<string, unknown>, occurredAt?: string): Line
  banLine(a: { kind: BanAnnouncementKind; gamertag: string; reason: BanReason; expiresAt: string | null }): Line
  achievementLine(p: Record<string, unknown>): Line
  onlineLine(p: { gamertag: string; tag: string | null; connectedAt: string }): Line
  ONLINE_TITLE(n: number): string        // "Players online · N"
  ONLINE_EMPTY = "Nobody on the server."
  flagDownDuration(seconds: number): string   // "3h 5m", identical to the bot's notice-text `duration`
  ```

Source files to copy from, character for character: `apps/bot/src/feed-embed.ts` (`describe`, `by`, `DORMANT_SENTENCE`, `flagLabel`), `war-log-text.ts`, `ban-announce-text.ts`, `achievement-embed.ts` (the `who` and description), `online-embed.ts`, `notice-text.ts` (`duration`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/copy/test/live-feed-text.test.ts
import { describe, it, expect } from "vitest";
import { clanFeedCard, warLogLine, banLine, achievementLine, onlineLine, ONLINE_TITLE, ONLINE_EMPTY, flagDownDuration, type Line, type Seg } from "../src/index";

const plain = (l: Line): string => l.map((s: Seg): string => {
  if (typeof s === "string") return s;
  if ("text" in s) return s.text;
  if ("raw" in s) return s.raw;
  if ("bold" in s) return plain(s.bold);
  if ("player" in s) return s.player;
  if ("clan" in s) return s.name ? `${s.name} [${s.clan}]` : s.clan;
  if ("time" in s) return `<${s.style}>`;
  return s.label;
}).join("");

const P = { name: "Wolves", tag: "WLF", texture: "Flag_Wolf" };

describe("clanFeedCard", () => {
  it("titles with name and tag and links the clan", () => {
    const c = clanFeedCard("founded", { ...P, actor: "Alpha" });
    expect(plain(c.title)).toBe("Wolves [WLF]");
    expect(c.href).toBe("/clans/WLF");
    expect(plain(c.lines[0]!)).toBe("Founded by Alpha. The ritual is complete — the flag is reserved.");
  });
  it("never says where a base moved", () => {
    expect(plain(clanFeedCard("rebound", { ...P, actor: "Alpha" }).lines[0]!)).toBe("Moved its base by Alpha.");
  });
  it("adds the pool date to a dormant clan only when it parses", () => {
    expect(plain(clanFeedCard("dormant", { ...P, disbandAt: "2026-10-01T00:00:00.000Z" }).lines[0]!))
      .toBe("Gone dormant — the flag has not been raised, and supplies are cut. The flag, tag and pole return to the pool <rel>.");
    expect(plain(clanFeedCard("dormant", { ...P, disbandAt: "not a date" }).lines[0]!))
      .toBe("Gone dormant — the flag has not been raised, and supplies are cut.");
  });
  it("names the flag back in the pool on a lapse", () => {
    expect(plain(clanFeedCard("lapsed", P).lines[0]!)).toBe("Never raised their flag. Wolf is back in the pool.");
  });
});

describe("warLogLine", () => {
  it("credits the raider and the player who lowered the flag", () => {
    expect(plain(warLogLine("raid", { raiderClan: "Bears", raiderTag: "BRS", victimClan: "Wolves", victimTag: "WLF", gamertag: "Alpha" })))
      .toBe("⚔️ Bears [BRS] raided Wolves [WLF] — flag lowered by Alpha");
  });
  it("drops the close time when it does not parse, never prints Invalid Date", () => {
    const l = plain(warLogLine("season_closed", { number: 2, clan: null }, "garbage"));
    expect(l).toBe("🏁 Season 2 is over. Nobody scored. Full table: seasons");
    expect(l).not.toMatch(/Invalid|NaN/u);
  });
  it("reports an empty week", () => {
    expect(plain(warLogLine("week_closed", { first: null }))).toBe("🏆 No Alphas this week — nobody scored.");
  });
});

describe("banLine", () => {
  it("drops the until clause when expiresAt does not parse", () => {
    expect(plain(banLine({ kind: "applied", gamertag: "Alpha", reason: "base_zone" as never, expiresAt: "nope" }))).not.toMatch(/Invalid|NaN|until/u);
  });
  it("says unbanned when served", () => {
    expect(plain(banLine({ kind: "expired", gamertag: "Alpha", reason: "base_zone" as never, expiresAt: null }))).toBe("🔓 Alpha unbanned — ban served.");
  });
});

describe("achievementLine", () => {
  it("never prints a Discord id for a player with no gamertag", () => {
    const l = plain(achievementLine({ ownerKind: "player", ownerName: "123456789012345678", gamertag: null, name: "First Blood", description: "Get a kill" }));
    expect(l).toBe("A player unlocked First Blood · Get a kill");
    expect(l).not.toMatch(/\d{6,}/u);
  });
  it("links a clan by tag", () => {
    expect(achievementLine({ ownerKind: "clan", clanTag: "WLF", ownerName: "Wolves", name: "N", description: "D" })[0]).toEqual({ bold: [{ clan: "WLF" }] });
  });
});

describe("online", () => {
  it("lists a player with their tag and connect time", () => {
    expect(plain(onlineLine({ gamertag: "Alpha", tag: "WLF", connectedAt: "2026-09-08T00:00:00.000Z" }))).toBe("Alpha [WLF] · on since <rel>");
    expect(ONLINE_TITLE(3)).toBe("Players online · 3");
    expect(ONLINE_EMPTY).toBe("Nobody on the server.");
  });
  it("formats flag-down time as hours and minutes", () => {
    expect(flagDownDuration(11_100)).toBe("3h 5m");
  });
});
```

Before writing `banLine`, open `packages/domain/src/enforcement.ts` and replace `"base_zone" as never` in the test with a real `BanReason` value other than `"unlinked_pc"`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/copy && npx vitest run test/live-feed-text.test.ts`
Expected: FAIL, exports missing.

- [ ] **Step 3: Implement in `packages/copy/src/live-feed.ts`**

```ts
import { BAN_REASON_TEXT, type BanAnnouncementKind, type BanReason, type FactionEventKind, type WarLogKind } from "@factions/domain";

/** An ISO instant as a time segment, or null when it does not parse: the caller drops the clause (war-log-text.ts's rule). */
function instant(iso: unknown, style: "at" | "rel"): Seg | null {
  if (typeof iso !== "string") return null;
  return Number.isFinite(Date.parse(iso)) ? { time: iso, style } : null;
}

export const flagLabel = (texture: string): string => texture.replace(/^Flag_/u, "");

export const flagDownDuration = (seconds: number): string =>
  `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;

export type ClanFeedPayload = { name: string; tag: string; texture: string; actor?: string; previousName?: string; disbandAt?: string };

const DORMANT_SENTENCE = "Gone dormant — the flag has not been raised, and supplies are cut.";
const by = (actor: string | undefined): Line => (actor ? [" by ", { bold: [{ raw: actor }] }] : []);

function clanFeedLine(kind: FactionEventKind, p: ClanFeedPayload): Line {
  switch (kind) {
    case "founded": return ["Founded", ...by(p.actor), ". The ritual is complete — the flag is reserved."];
    case "activated": return ["Colors raised", ...by(p.actor), ". The clan is live."];
    case "renamed": return ["Now flying as ", { bold: [{ raw: p.name }] }, " — formerly ", { bold: [{ raw: p.previousName ?? "its former name" }] }, "."];
    case "rebound": return ["Moved its base", ...by(p.actor), "."];
    case "dormant": {
      const t = instant(p.disbandAt, "rel");
      return t ? [`${DORMANT_SENTENCE} The flag, tag and pole return to the pool `, t, "."] : [DORMANT_SENTENCE];
    }
    case "revived": return ["Active again — the flag is flying and supplies resume at the next restart."];
    case "disbanded": return ["Disbanded. Its flag, tag and pole return to the pool."];
    case "lapsed": return [`Never raised their flag. ${flagLabel(p.texture)} is back in the pool.`];
  }
}

export function clanFeedCard(kind: FactionEventKind, p: ClanFeedPayload): LiveCard {
  return { title: [{ raw: p.name }, " [", { raw: p.tag }, "]"], href: clanPath(p.tag), lines: [clanFeedLine(kind, p)], detail: [] };
}

const clanSeg = (name: unknown, tag: unknown): Seg =>
  typeof tag === "string" && tag !== "" ? { clan: tag, name: String(name) } : { bold: [{ raw: String(name) }] };

export function warLogLine(kind: WarLogKind, p: Record<string, unknown>, occurredAt?: string): Line {
  switch (kind) {
    case "raid":
      return p.solo
        ? ["⚔️ ", clanSeg(p.victimClan, p.victimTag), " was raided — flag lowered by ", { player: String(p.gamertag) }, " (no clan)"]
        : ["⚔️ ", clanSeg(p.raiderClan, p.raiderTag), " raided ", clanSeg(p.victimClan, p.victimTag), " — flag lowered by ", { player: String(p.gamertag) }];
    case "defense":
      return ["🛡️ ", clanSeg(p.victimClan, p.victimTag), ` raised their colors again — ${flagDownDuration(Number(p.durationSeconds))} under siege`];
    case "week_closed": {
      if (p.first === null) return ["🏆 No Alphas this week — nobody scored."];
      const entries: [unknown, unknown, unknown][] = [[p.first, p.t1, p.p1], [p.second, p.t2, p.p2], [p.third, p.t3, p.p3]];
      const present = entries.filter((e) => e[0] !== null && e[0] !== undefined);
      const names: Line = [];
      present.forEach(([name, tag], i) => { if (i > 0) names.push(", "); names.push(clanSeg(name, tag)); });
      return ["🏆 Alphas this week: ", ...names, ` — ${present.map(([, , pts]) => pts).join(" / ")}`];
    }
    case "season_closed": {
      const t = instant(occurredAt, "at");
      const closed: Line = t ? [`Season ${p.number} is over `, t, "."] : [`Season ${p.number} is over.`];
      const link: Line = ["Full table: ", { page: "/seasons", label: "seasons" }];
      return p.clan === null
        ? ["🏁 ", ...closed, " Nobody scored. ", ...link]
        : ["🏁 ", ...closed, " Champion: ", clanSeg(p.clan, p.tag), ` with ${p.points}. `, ...link];
    }
  }
}

export function banLine(a: { kind: BanAnnouncementKind; gamertag: string; reason: BanReason; expiresAt: string | null }): Line {
  const tag: Seg = { bold: [{ text: a.gamertag }] };
  if (a.kind === "expired") return ["🔓 ", tag, " unbanned — ban served."];
  if (a.kind === "lifted") return a.reason === "unlinked_pc" ? ["🔓 ", tag, " unbanned — account linked."] : ["🔓 ", tag, " unbanned."];
  if (a.reason === "unlinked_pc") return ["🔨 ", tag, " banned — playing on PC without a linked account. Link your account to lift it."];
  if (a.expiresAt === null) return ["🔨 ", tag, ` banned permanently — ${BAN_REASON_TEXT[a.reason]}.`];
  const t = instant(a.expiresAt, "at");
  return t
    ? ["🔨 ", tag, " banned until ", t, ` — ${BAN_REASON_TEXT[a.reason]}.`]
    : ["🔨 ", tag, ` banned — ${BAN_REASON_TEXT[a.reason]}.`];
}

const DISCORD_ID = /^\d+$/u;

export function achievementLine(p: Record<string, unknown>): Line {
  const owner: Seg = p.ownerKind === "clan"
    ? (p.clanTag ? { bold: [{ clan: String(p.clanTag) }] } : { bold: [{ raw: `[${p.ownerName}]` }] })
    : (p.gamertag
      ? { bold: [{ player: String(p.gamertag) }] }
      : { bold: [{ raw: p.ownerName === null || p.ownerName === undefined || DISCORD_ID.test(String(p.ownerName)) ? "A player" : String(p.ownerName) }] });
  return [owner, " unlocked ", { bold: [{ raw: String(p.name) }] }, " · ", { raw: String(p.description) }];
}

export const ONLINE_TITLE = (n: number): string => `Players online · ${n}`;
export const ONLINE_EMPTY = "Nobody on the server.";

export function onlineLine(p: { gamertag: string; tag: string | null; connectedAt: string }): Line {
  const t = instant(p.connectedAt, "rel");
  return [{ bold: [{ player: p.gamertag }] }, ...(p.tag ? [" [", { clan: p.tag }, "]"] as Line : []), " · on since ", t ?? "an unknown time"];
}
```

Check before moving on: the original `achievement-embed.ts` prints `**A player**` only when `ownerName` is all digits; the `null`/`undefined` branch is new and only reachable from the website (Task 9 nulls a digits-only `ownerName`). Discord never sees it, because the bot passes the raw payload.

Export the new names from `packages/copy/src/index.ts`.

- [ ] **Step 4: Run the tests**

Run: `cd packages/copy && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/copy
git commit -m "feat(copy): clan feed, war log, ban, achievement and online wording as shared segments"
```

---

### Task 5: Bot renders the combat embeds from the shared cards

**Files:**
- Modify: `apps/bot/src/site-links.ts` (add `lineMarkdown`), `apps/bot/src/kill-feed-embed.ts`, `hit-feed-embed.ts`, `killstreak-feed-embed.ts`, `long-range-feed-embed.ts`
- Create: `apps/bot/src/live-payload.ts` (item → payload converters)
- Test: `apps/bot/test/line-markdown.test.ts`, `apps/bot/test/live-payload.test.ts`; existing embed tests unchanged

**Interfaces:**
- Consumes: `Seg`, `Line`, `killCard`, `hitCard`, `streakCard`, `longRangeCard` (Task 3).
- Produces:
  ```ts
  lineMarkdown(line: Line, siteBaseUrl: string): string        // site-links.ts
  toLiveKill(i: KillFeedItem): LiveKill                         // live-payload.ts
  toLiveHitRun(i: HitFeedItem): LiveHitRun
  toLiveStreak(i: KillstreakFeedItem): LiveStreak               // streak ?? 0
  toLiveLongRange(i: LongRangeFeedItem): LiveLongRange
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/bot/test/line-markdown.test.ts
import { describe, it, expect } from "vitest";
import { lineMarkdown } from "../src/site-links.js";

const site = "https://dayzclanwars.com";

describe("lineMarkdown", () => {
  it("escapes text, leaves raw bare, links players and clans", () => {
    expect(lineMarkdown(["a ", { text: "x_y" }, " ", { raw: "x_y" }], site)).toBe("a x\\_y x_y");
    expect(lineMarkdown([{ bold: [{ player: "Al_pha" }] }], site)).toBe("**[Al\\_pha](<https://dayzclanwars.com/players/Al_pha>)**");
    expect(lineMarkdown([{ clan: "WLF" }], site)).toBe("[WLF](<https://dayzclanwars.com/clans/WLF>)");
    expect(lineMarkdown([{ clan: "WLF", name: "Wolves" }], site)).toBe("**[Wolves](<https://dayzclanwars.com/clans/WLF>)** [WLF]");
    expect(lineMarkdown([{ page: "/seasons", label: "seasons" }], site)).toBe("[seasons](<https://dayzclanwars.com/seasons>)");
  });
  it("renders time as Discord tokens", () => {
    expect(lineMarkdown([{ time: "2026-09-08T00:00:00.000Z", style: "at" }], site)).toBe("<t:1788825600:F>");
    expect(lineMarkdown([{ time: "2026-09-08T00:00:00.000Z", style: "rel" }], site)).toBe("<t:1788825600:R>");
  });
});
```

```ts
// apps/bot/test/live-payload.test.ts
import { describe, it, expect } from "vitest";
import { toLiveKill, toLiveStreak } from "../src/live-payload.js";

describe("live payload converters", () => {
  it("turns dates into ISO strings and drops the cursor id", () => {
    const k = toLiveKill({
      eventId: 9, occurredAt: new Date("2026-09-08T01:00:00Z"),
      killer: { gamertag: "A", tag: null, texture: null }, victim: { gamertag: "B", tag: null, texture: null },
      weapon: null, distanceM: null, friendlyFire: false, atHub: false, cause: "pvp",
      tally: { killerKills: 1, victimDeaths: 1, season: null }, hits: [],
    });
    expect(k.occurredAt).toBe("2026-09-08T01:00:00.000Z");
    expect("eventId" in k).toBe(false);
  });
  it("reads a missing streak as 0, as the embed always has", () => {
    const s = toLiveStreak({ eventId: 1, occurredAt: new Date(0), startedAt: new Date(0), killer: { gamertag: "A", tag: null, texture: null }, streak: null, victims: [] });
    expect(s.streak).toBe(0);
  });
});
```

Check the expected epoch: `new Date("2026-09-08T00:00:00Z").getTime() / 1000`. If it is not `1788825600`, use the real value in the test.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/bot && npx vitest run test/line-markdown.test.ts test/live-payload.test.ts`
Expected: FAIL, functions missing.

- [ ] **Step 3: Implement**

In `apps/bot/src/site-links.ts`:

```ts
import { at, rel, type Line, type Seg } from "@factions/copy";

/** A shared copy Line as Discord markdown (spec 2026-09-30-website-live-feeds). */
export function lineMarkdown(line: Line, siteBaseUrl: string): string {
  return line.map((s) => segMarkdown(s, siteBaseUrl)).join("");
}

function segMarkdown(s: Seg, site: string): string {
  if (typeof s === "string") return s;
  if ("text" in s) return escapeMarkdown(s.text);
  if ("raw" in s) return s.raw;
  if ("bold" in s) return `**${lineMarkdown(s.bold, site)}**`;
  if ("player" in s) return playerLink(site, s.player);
  if ("clan" in s) return clanLink(site, s.clan, s.name);
  if ("time" in s) return (s.style === "at" ? at : rel)(new Date(s.time)) ?? "";
  return `[${s.label}](<${site}${s.page}>)`;
}
```

Create `apps/bot/src/live-payload.ts`:

```ts
import type { LiveHitRun, LiveKill, LiveLongRange, LiveStreak } from "@factions/domain";
import type { KillFeedItem } from "./kill-feed-embed.js";
import type { HitFeedItem } from "./hit-feed-embed.js";
import type { KillstreakFeedItem } from "./killstreak-feed-embed.js";
import type { LongRangeFeedItem } from "./long-range-feed-embed.js";

/**
 * A feed store's item as the plain, frozen payload the shared copy reads and
 * `feed_entries` stores. Drops the cursor id and the store's decline flags;
 * never adds a field the item does not already carry (no positions).
 */
export const toLiveKill = (i: KillFeedItem): LiveKill => ({
  occurredAt: i.occurredAt.toISOString(), killer: i.killer, victim: i.victim, weapon: i.weapon, distanceM: i.distanceM,
  friendlyFire: i.friendlyFire, atHub: i.atHub, cause: i.cause, tally: i.tally, hits: i.hits,
});

export const toLiveHitRun = (i: HitFeedItem): LiveHitRun => ({
  occurredAt: i.occurredAt.toISOString(), startedAt: i.startedAt.toISOString(), attacker: i.attacker, victim: i.victim,
  weapon: i.weapon, friendlyFire: i.friendlyFire, hits: i.hits, totalDamage: i.totalDamage, victimHpAfter: i.victimHpAfter,
});

export const toLiveStreak = (i: KillstreakFeedItem): LiveStreak => ({
  occurredAt: i.occurredAt.toISOString(), startedAt: i.startedAt.toISOString(), killer: i.killer, streak: i.streak ?? 0, victims: i.victims,
});

export const toLiveLongRange = (i: LongRangeFeedItem): LiveLongRange => ({
  occurredAt: i.occurredAt.toISOString(), killer: i.killer, victim: i.victim, weapon: i.weapon, distanceM: i.distanceM,
  friendlyFire: i.friendlyFire, personalBest: i.personalBest, seasonRank: i.seasonRank, season: i.season,
});
```

Then rewrite each embed's title and description to come from the card. For `kill-feed-embed.ts`, `killFeedEmbed` becomes:

```ts
export function killFeedEmbed(k: KillFeedItem, siteBaseUrl: string, flagImage: FlagImageResolver = () => null): APIEmbed {
  const image = k.killer.texture ? flagImage(k.killer.texture) : null;
  const card = killCard(toLiveKill(k));
  const lines = card.lines.map((l) => lineMarkdown(l, siteBaseUrl));
  if (card.detail.length > 0) lines.push("", ...card.detail.map((l) => lineMarkdown(l, siteBaseUrl)));
  return {
    title: lineMarkdown(card.title, siteBaseUrl),
    url: `${siteBaseUrl}${card.href}`,
    description: lines.join("\n"),
    color: k.atHub || k.friendlyFire ? AMBER : RUST,
    footer: { text: k.tally.season === null ? "All-time" : `Season ${k.tally.season}` },
    timestamp: k.occurredAt.toISOString(),
    ...(image ? { thumbnail: { url: image } } : {}),
    ...(k.killer.texture ? { fields: [{ name: "Flag", value: flagLabel(k.killer.texture), inline: true }] } : {}),
  };
}
```

Keep `howLine`, `detailLine`, `cappedLines` exported from `kill-feed-embed.ts` only if something else in `apps/bot/src` imports them (`grep -rn "howLine\|detailLine\|cappedLines" apps/bot/src apps/bot/test`). If only tests import them, make them thin wrappers over the copy versions rendered with `lineMarkdown(…, "")` so those tests still pass unchanged, and say so in a one-line comment.

Do the same for `hitFeedEmbed` (`hitCard(toLiveHitRun(i))`), `killstreakFeedEmbed` (`streakCard(toLiveStreak(i))`) and `longRangeFeedEmbed` (`longRangeCard(toLiveLongRange(i))`). Colors, footer, timestamp, thumbnail and fields stay exactly as they are. Delete the local `times`, `elapsed`, `ordinal` and `plural` helpers that the cards now own.

`url` check: today the embeds use `profileUrl(siteBaseUrl, gamertag)`, which is `${site}/players/${encodeURIComponent(gt)}`. `card.href` is `/players/${encodeURIComponent(gt)}`, so `${siteBaseUrl}${card.href}` is identical.

- [ ] **Step 4: Run every bot embed test, unchanged**

Run: `cd apps/bot && npx vitest run test/line-markdown.test.ts test/live-payload.test.ts test/kill-feed-embed.test.ts test/hit-feed-embed.test.ts test/killstreak-feed-embed.test.ts test/long-range-feed-embed.test.ts && npx tsc --noEmit`
Expected: PASS with no edits to the four existing embed tests. A failure here means the wording drifted; fix the copy, never the old test.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src apps/bot/test/line-markdown.test.ts apps/bot/test/live-payload.test.ts
git commit -m "refactor(bot): combat embeds render from the shared copy cards"
```

---

### Task 6: Bot renders clan feed, war log, bans, achievements and online from shared copy

**Files:**
- Modify: `apps/bot/src/feed-embed.ts`, `war-log-text.ts`, `ban-announce-text.ts`, `achievement-embed.ts`, `online-embed.ts`
- Test: existing `feed-embed.test.ts`, `war-log-text.test.ts`, `ban-announce-text.test.ts`, `achievement-embed.test.ts`, `online-embed.test.ts`, unchanged

**Interfaces:**
- Consumes: `clanFeedCard`, `flagLabel`, `warLogLine`, `banLine`, `achievementLine`, `onlineLine`, `ONLINE_TITLE`, `ONLINE_EMPTY` (Task 4), `lineMarkdown` (Task 5).

- [ ] **Step 1: Confirm the existing tests pass before touching anything**

Run: `cd apps/bot && npx vitest run test/feed-embed.test.ts test/war-log-text.test.ts test/ban-announce-text.test.ts test/achievement-embed.test.ts test/online-embed.test.ts`
Expected: PASS. These are the failing-test step for this task: they pin today's Discord text, and they must still pass after the swap.

- [ ] **Step 2: Swap each renderer to the shared copy**

`feed-embed.ts`:

```ts
import { clanFeedCard, flagLabel } from "@factions/copy";
export { flagLabel };   // other bot files import it from here

export function feedEmbed(e: QueuedFactionEvent, flagImage: FlagImageResolver = NO_IMAGE, siteBaseUrl: string = DEFAULT_SITE_BASE_URL): APIEmbed {
  const p = e.payload;
  const image = flagImage(p.texture);
  const card = clanFeedCard(e.kind, p);
  return {
    title: lineMarkdown(card.title, siteBaseUrl),
    url: `${siteBaseUrl}${card.href}`,
    description: lineMarkdown(card.lines[0]!, siteBaseUrl),
    color: COLOR[e.kind],
    fields: [{ name: "Flag", value: flagLabel(p.texture), inline: true }],
    timestamp: e.occurredAt.toISOString(),
    ...(image ? { thumbnail: { url: image } } : {}),
  };
}
```

Delete `describe`, `by` and `DORMANT_SENTENCE` from the file.

`war-log-text.ts`:

```ts
export function warLogText(e: { kind: WarLogKind; occurredAt?: Date; payload: NoticePayload }, siteBaseUrl: string): string {
  const iso = e.occurredAt && Number.isFinite(e.occurredAt.getTime()) ? e.occurredAt.toISOString() : undefined;
  return lineMarkdown(warLogLine(e.kind, e.payload as Record<string, unknown>, iso), siteBaseUrl);
}
```

`ban-announce-text.ts`: `banAnnouncementText(a)` becomes `lineMarkdown(banLine(a), "")`. A ban line has no links, so the site URL is unused.

`achievement-embed.ts`: the description becomes `lineMarkdown(achievementLine(p as Record<string, unknown>), siteBaseUrl)`. Keep `achievementMention`, `badgeUrl`, `colourInt`, the footer and the thumbnail as they are.

`online-embed.ts`: `lines = sorted.map((p) => lineMarkdown(onlineLine({ gamertag: p.gamertag, tag: p.tag, connectedAt: p.connectedAt.toISOString() }), siteBaseUrl))`, `title: ONLINE_TITLE(players.length)`, and `ONLINE_EMPTY` for the empty description.

Check `notice-text.ts`'s `duration`: leave it where it is, because other notices use it. `flagDownDuration` is a copy of it, and both are pinned by tests.

- [ ] **Step 3: Run the same tests, unchanged, plus typecheck**

Run: `cd apps/bot && npx vitest run test/feed-embed.test.ts test/war-log-text.test.ts test/ban-announce-text.test.ts test/achievement-embed.test.ts test/online-embed.test.ts test/feed-tick.test.ts test/war-log-tick.test.ts test/online-tick.test.ts && npx tsc --noEmit`
Expected: PASS with no test edits.

- [ ] **Step 4: Commit**

```bash
git add apps/bot/src
git commit -m "refactor(bot): clan feed, war log, bans, achievements and online render from shared copy"
```

---

### Task 7: Generic cursor loop, optional seeding, and a cursor name per store

**Files:**
- Modify: `apps/bot/src/cursor-feed.ts`, `kill-feed-tick.ts`, `hit-feed-tick.ts`, `killstreak-feed-tick.ts`, `long-range-feed-tick.ts`
- Test: `apps/bot/test/cursor-feed.test.ts` (add cases), existing `*-feed-tick.test.ts` and `*-feed-store.test.ts` unchanged

**Interfaces:**
- Produces:
  ```ts
  cursorFeedTick<T extends { eventId: number }, M = APIEmbed>(
    store: CursorFeedStore<T>,
    post: (m: M) => Promise<void>,
    render: (item: T) => M | null,
    opts?: { batchSize?: number; onError?: (eventId: number, err: unknown) => void; seedAtHead?: boolean },  // seedAtHead defaults true
  ): Promise<CursorFeedResult>
  new PgKillFeedStore(db, { consumer?: string })
  new PgHitFeedStore(db, { windowS?: number; consumer?: string })
  new PgKillstreakFeedStore(db, { consumer?: string })
  new PgLongRangeFeedStore(db, { minM?: number; consumer?: string })
  isKillstreakMilestone(i: KillstreakFeedItem, every: number): boolean   // killstreak-feed-tick.ts
  ```

- [ ] **Step 1: Write the failing tests** (append to `apps/bot/test/cursor-feed.test.ts`, reusing that file's fake store helper, or this one)

```ts
describe("cursorFeedTick seedAtHead: false", () => {
  it("replays history from the start instead of seeding at the head", async () => {
    let c: number | null = null;
    const items = [{ eventId: 1 }, { eventId: 2 }];
    const store = {
      seeded: async () => c !== null, head: async () => 2, cursor: async () => c ?? 0,
      readAfter: async (after: number, limit: number) => items.filter((i) => i.eventId > after).slice(0, limit),
      markPosted: async (id: number) => { c = id; },
    };
    const posted: number[] = [];
    const r = await cursorFeedTick(store, async (m: number) => { posted.push(m); }, (i) => i.eventId * 10, { seedAtHead: false });
    expect(r).toEqual({ posted: 2, blockedAt: null, seeded: false });
    expect(posted).toEqual([10, 20]);
    expect(c).toBe(2);
  });
});
```

Add one more test: a `PgKillstreakFeedStore` built with `{ consumer: "x-recorder" }` reads and writes that cursor and leaves `killstreak-feed-poster` absent (`readCursor(db, "killstreak-feed-poster")` stays 0). Put it in `apps/bot/test/killstreak-feed-store.test.ts`, using that file's setup.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/cursor-feed.test.ts test/killstreak-feed-store.test.ts`
Expected: FAIL. `seedAtHead` is ignored and seeds, and `consumer` is not a constructor option.

- [ ] **Step 3: Implement**

`cursor-feed.ts`: make the function generic. Keep `CursorFeedPoster` and `CursorFeedRender<T>` as the `APIEmbed` aliases they are today, so callers don't change.

```ts
export async function cursorFeedTick<T extends { eventId: number }, M = APIEmbed>(
  store: CursorFeedStore<T>,
  post: (m: M) => Promise<void>,
  render: (item: T) => M | null,
  opts: { batchSize?: number; onError?: (eventId: number, err: unknown) => void; seedAtHead?: boolean } = {},
): Promise<CursorFeedResult> {
  const out: CursorFeedResult = { posted: 0, blockedAt: null, seeded: false };

  // ⚠️ Seeding is for Discord posters (a replay announces last week to a public
  // channel). The website recorders pass `seedAtHead: false`: they write rows,
  // and replaying history IS their backfill.
  if ((opts.seedAtHead ?? true) && !(await store.seeded())) {
    await store.markPosted(await store.head());
    out.seeded = true;
    return out;
  }
  // …the rest of the loop unchanged, with `render(item)` / `post(m)` typed by M.
}
```

In each of the four stores, add `consumer` to the constructor options and use it in place of the module constant in `seeded`, `cursor` and `markPosted`. Using `PgKillFeedStore` as the example:

```ts
export class PgKillFeedStore implements KillFeedStore {
  private readonly consumer: string;
  constructor(private readonly db: Database, opts: { consumer?: string } = {}) {
    this.consumer = opts.consumer ?? KILL_FEED_CONSUMER;
  }
  // seeded(): …where(eq(consumerCursors.consumerName, this.consumer))
  // cursor(): readCursor(this.db, this.consumer)
  // markPosted(id): writeCursor(this.db, this.consumer, id)
}
```

⚠️ `PgHitFeedStore` also reads `KILLS_CONSUMER` for its frontier (`hit-feed-tick.ts:122`). That one is the kills projector's cursor, not the feed's own, so leave it alone.

In `killstreak-feed-tick.ts`, pull the poster's predicate out so the recorder can share it:

```ts
/** A streak post: a positive multiple of `every`. Shared by the Discord poster and the website recorder. */
export function isKillstreakMilestone(i: KillstreakFeedItem, every: number): boolean {
  const n = every > 0 ? every : DEFAULT_KILLSTREAK_EVERY;
  return i.streak !== null && i.streak > 0 && i.streak % n === 0;
}
```

and make `killstreakFeedTick`'s render `(i) => (isKillstreakMilestone(i, opts.every) ? killstreakFeedEmbed(…) : null)`.

- [ ] **Step 4: Run the feed tests**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/cursor-feed.test.ts test/kill-feed-tick.test.ts test/hit-feed-tick.test.ts test/killstreak-feed-tick.test.ts test/kill-feed-store.test.ts test/hit-feed-store.test.ts test/killstreak-feed-store.test.ts test/long-range-feed-store.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src apps/bot/test
git commit -m "refactor(bot): cursor loop takes any message type, optional seeding, per-store cursor name"
```

---

### Task 8: Recorder ticks write `feed_entries`, wired into the runner

**Files:**
- Create: `apps/bot/src/live-recorder.ts`
- Modify: `apps/bot/src/discord.ts` (store construction ~line 703; ticks after each poster block, ~lines 1540–1640)
- Test: `apps/bot/test/live-recorder.test.ts`

**Interfaces:**
- Consumes: `cursorFeedTick` with `seedAtHead` (Task 7), the store `consumer` option (Task 7), `isKillstreakMilestone` (Task 7), the `toLive*` converters (Task 5), `feedEntries` (Task 1).
- Produces:
  ```ts
  LIVE_RECORDER_CONSUMERS: { kill: "kill-feed-recorder"; hit: "hit-feed-recorder"; killstreak: "killstreak-feed-recorder"; long_range: "long-range-feed-recorder" }
  LIVE_RECORDER_BATCH_SIZE = 100
  type LiveRecord = { eventId: number; occurredAt: string; kind: LiveEntryKind; payload: LivePayload[LiveEntryKind] }
  insertFeedEntry(db: Database): (r: LiveRecord) => Promise<void>
  recordKills(db, store, opts?): Promise<CursorFeedResult>
  recordHits(db, store, opts?): Promise<CursorFeedResult>            // seeds at head
  recordKillstreaks(db, store, every, opts?): Promise<CursorFeedResult>
  recordLongRange(db, store, opts?): Promise<CursorFeedResult>
  ```

- [ ] **Step 1: Write the failing test**

Use the setup from `apps/bot/test/kill-feed-store.test.ts`: servers, `adm_files`, players, and the `mkKill` helper. Add `feed_entries` to the truncate list.

```ts
// apps/bot/test/live-recorder.test.ts  (setup copied from kill-feed-store.test.ts: db, serverId, mkKill, A/B/R players)
import { feedEntries } from "@factions/db";
import { readCursor } from "@factions/event-log";
import { PgKillFeedStore, KILL_FEED_CONSUMER } from "../src/kill-feed-tick.js";
import { PgKillstreakFeedStore } from "../src/killstreak-feed-tick.js";
import { PgHitFeedStore } from "../src/hit-feed-tick.js";
import { recordKills, recordKillstreaks, recordHits, insertFeedEntry, LIVE_RECORDER_CONSUMERS } from "../src/live-recorder.js";

it("first run replays every PvP kill already in the table: the backfill", async () => {
  await mkKill({ at: h(1), killer: A, victim: B });
  await mkKill({ at: h(2), killer: A, victim: R });
  await mkKill({ at: h(3), killer: null, victim: B }); // PvE: never a feed entry
  const store = new PgKillFeedStore(db, { consumer: LIVE_RECORDER_CONSUMERS.kill });
  const r = await recordKills(db, store);
  expect(r.seeded).toBe(false);
  const rows = await db.select().from(feedEntries).orderBy(feedEntries.id);
  expect(rows.map((x) => x.kind)).toEqual(["kill", "kill"]);
  expect((rows[1]!.payload as { tally: { killerKills: number } }).tally.killerKills).toBe(2);
  expect(rows[0]!.serverId).toBe(serverId);
});

it("does not touch the Discord poster's cursor, and runs with no poster at all", async () => {
  await mkKill({ at: h(1), killer: A, victim: B });
  await recordKills(db, new PgKillFeedStore(db, { consumer: LIVE_RECORDER_CONSUMERS.kill }));
  expect(await readCursor(db, KILL_FEED_CONSUMER)).toBe(0);
  expect(await db.select().from(feedEntries)).toHaveLength(1);
});

it("a crash between insert and cursor write does not duplicate on the re-run", async () => {
  const id = await mkKill({ at: h(1), killer: A, victim: B });
  const store = new PgKillFeedStore(db, { consumer: LIVE_RECORDER_CONSUMERS.kill });
  const [item] = await store.readAfter(0, 1);
  // Simulate: the row landed, the cursor did not.
  await insertFeedEntry(db)({ eventId: id, occurredAt: item!.occurredAt.toISOString(), kind: "kill", payload: {} as never });
  await recordKills(db, store);
  expect(await db.select().from(feedEntries)).toHaveLength(1);
});

it("records only streak milestones", async () => {
  for (let n = 1; n <= 4; n++) await mkKill({ at: h(n), killer: A, victim: n % 2 ? B : R });
  await recordKillstreaks(db, new PgKillstreakFeedStore(db, { consumer: LIVE_RECORDER_CONSUMERS.killstreak }), 3);
  const rows = await db.select().from(feedEntries);
  expect(rows.map((r) => (r.payload as { streak: number }).streak)).toEqual([3]);
});

it("the hit recorder seeds at the head on its first run: hit history starts at deploy", async () => {
  const r = await recordHits(db, new PgHitFeedStore(db, { consumer: LIVE_RECORDER_CONSUMERS.hit }));
  expect(r.seeded).toBe(true);
  expect(await db.select().from(feedEntries)).toHaveLength(0);
});

it("stores no position, even though hit events carry them", async () => {
  // Insert a player.hit event whose payload has victimPos/attackerPos for the kill's
  // run window (see kill-feed-store.test.ts for the hit-event shape), then record the kill.
  // Assert JSON.stringify(row.payload) matches none of /Pos"|"x"|"y"|"z"/.
});
```

Finish the last test using the hit-event helper in `kill-feed-store.test.ts`; don't leave it as a comment.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/live-recorder.test.ts`
Expected: FAIL, the module is missing.

- [ ] **Step 3: Implement `apps/bot/src/live-recorder.ts`**

```ts
import type { Database } from "@factions/db";
import { events, feedEntries } from "@factions/db";
import type { LiveEntryKind, LivePayload } from "@factions/domain";
import { eq, sql } from "drizzle-orm";
import { cursorFeedTick, type CursorFeedResult, type CursorFeedStore } from "./cursor-feed.js";
import type { KillFeedItem } from "./kill-feed-embed.js";
import type { HitFeedItem } from "./hit-feed-embed.js";
import type { KillstreakFeedItem } from "./killstreak-feed-embed.js";
import type { LongRangeFeedItem } from "./long-range-feed-embed.js";
import { isKillstreakMilestone } from "./killstreak-feed-tick.js";
import { toLiveHitRun, toLiveKill, toLiveLongRange, toLiveStreak } from "./live-payload.js";

/**
 * The website's copy of the four combat feeds (spec 2026-09-30-website-live-feeds).
 *
 * Each recorder runs its Discord feed's OWN store under a separate cursor, so
 * it records exactly what the poster would post, whether or not the poster
 * exists or is wedged on a channel permission. It writes a `feed_entries` row
 * instead of an embed.
 *
 * ⚠️ No seeding, except hits: the first run replays every kill, which is the
 * backfill. The store queries count tallies, bests and streaks up to and
 * including each kill, so a replayed row says what Discord said at the time.
 * Hits seed at the head: regrouping every historical hit event is the cost
 * the spec chose not to pay.
 *
 * ⚠️ At-least-once, like the posters. A crash between the insert and the cursor
 * write re-runs the item; `ON CONFLICT DO NOTHING` on (kind, source_event_id)
 * absorbs it.
 */
export const LIVE_RECORDER_CONSUMERS = {
  kill: "kill-feed-recorder",
  hit: "hit-feed-recorder",
  killstreak: "killstreak-feed-recorder",
  long_range: "long-range-feed-recorder",
} as const satisfies Record<LiveEntryKind, string>;

/** Bigger than the posters' 20: no rate limit on an insert, and the first run has history to chew through. */
export const LIVE_RECORDER_BATCH_SIZE = 100;

export type LiveRecord = { eventId: number; occurredAt: string; kind: LiveEntryKind; payload: LivePayload[LiveEntryKind] };

type Opts = { batchSize?: number; onError?: (eventId: number, err: unknown) => void };

export function insertFeedEntry(db: Database) {
  return async (r: LiveRecord): Promise<void> => {
    const [ev] = await db.select({ serverId: events.serverId }).from(events).where(eq(events.id, r.eventId));
    if (!ev) throw new Error(`feed entry source event ${r.eventId} not found`);
    await db.insert(feedEntries).values({
      serverId: ev.serverId, kind: r.kind, sourceEventId: r.eventId, occurredAt: new Date(r.occurredAt), payload: r.payload,
    }).onConflictDoNothing({ target: [feedEntries.kind, feedEntries.sourceEventId] });
  };
}

function record<T extends { eventId: number }>(
  db: Database, store: CursorFeedStore<T>, kind: LiveEntryKind,
  toRecord: (i: T) => LivePayload[LiveEntryKind] | null, seedAtHead: boolean, opts: Opts,
): Promise<CursorFeedResult> {
  return cursorFeedTick<T, LiveRecord>(store, insertFeedEntry(db), (i) => {
    const payload = toRecord(i);
    return payload === null ? null : { eventId: i.eventId, occurredAt: (payload as { occurredAt: string }).occurredAt, kind, payload };
  }, { batchSize: opts.batchSize ?? LIVE_RECORDER_BATCH_SIZE, onError: opts.onError, seedAtHead });
}

export const recordKills = (db: Database, store: CursorFeedStore<KillFeedItem>, opts: Opts = {}) =>
  record(db, store, "kill", toLiveKill, false, opts);

export const recordHits = (db: Database, store: CursorFeedStore<HitFeedItem>, opts: Opts = {}) =>
  record(db, store, "hit", (i) => (i.suppressed ? null : toLiveHitRun(i)), true, opts);

export const recordKillstreaks = (db: Database, store: CursorFeedStore<KillstreakFeedItem>, every: number, opts: Opts = {}) =>
  record(db, store, "killstreak", (i) => (isKillstreakMilestone(i, every) ? toLiveStreak(i) : null), false, opts);

export const recordLongRange = (db: Database, store: CursorFeedStore<LongRangeFeedItem>, opts: Opts = {}) =>
  record(db, store, "long_range", (i) => (i.qualifies ? toLiveLongRange(i) : null), false, opts);
```

Remove the unused `sql` import if typecheck flags it.

Wire it into `apps/bot/src/discord.ts`. Next to the existing stores (~line 703):

```ts
// The website's /live recorders (spec 2026-09-30-website-live-feeds): the same
// stores under their own cursors, built whether or not a Discord channel is set.
const killRecordStore = new PgKillFeedStore(db, { consumer: LIVE_RECORDER_CONSUMERS.kill });
const hitRecordStore = new PgHitFeedStore(db, { windowS: cfg.hitBurstWindowS, consumer: LIVE_RECORDER_CONSUMERS.hit });
const killstreakRecordStore = new PgKillstreakFeedStore(db, { consumer: LIVE_RECORDER_CONSUMERS.killstreak });
const longRangeRecordStore = new PgLongRangeFeedStore(db, { minM: cfg.longRangeMinM, consumer: LIVE_RECORDER_CONSUMERS.long_range });
const liveRecordFailures = new Set<string>();
```

Directly after each of the four poster blocks (kill ~1540, hit ~1567, killstreak ~1592, long range ~1618), add an **ungated** block. The kill one:

```ts
// ⚠️ Not gated on a channel: the site keeps its feed with Discord off.
try {
  const r = await recordKills(db, killRecordStore, {
    onError: (id, err) => {
      const key = `kill:${id}`;
      if (liveRecordFailures.has(key)) return;
      liveRecordFailures.add(key);
      console.error(`live recorder failed for kill event ${id}`, err);
    },
  });
  if (r.posted > 0) console.log(`live recorder: ${r.posted} kills`);
} catch (err) {
  console.error("live kill recorder tick failed", err);
}
```

Repeat for hits (`recordHits`, which logs `"live recorder: hit cursor seeded at the head"` when `r.seeded`), killstreaks (`recordKillstreaks(db, killstreakRecordStore, cfg.killstreakEvery, …)`) and long range. Keep the order kill → hit → killstreak → long range, each right after its poster, so the hit recorder runs after the kills tick, like the hit poster.

- [ ] **Step 4: Run the recorder tests and the wiring test**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/live-recorder.test.ts test/feed-wiring.test.ts && npx tsc --noEmit`
Expected: PASS. If `feed-wiring.test.ts` pins the list of consumer names or tick order, add the four recorders to it deliberately.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/live-recorder.ts apps/bot/src/discord.ts apps/bot/test/live-recorder.test.ts apps/bot/test/feed-wiring.test.ts
git commit -m "feat(bot): record the combat feeds to feed_entries for the website"
```

---

### Task 9: Roster reads, `liveFeed` and `onlineNow`

**Files:**
- Create: `packages/roster/src/live.ts`
- Modify: `packages/roster/src/api.ts`, `packages/roster/src/index.ts`, `packages/roster/test/roster-exports.ts`, `apps/web/test/smoke.test.ts`
- Test: `packages/roster/test/live.test.ts`

**Interfaces:**
- Consumes: `feedEntries` (Task 1), `LIVE_FEED_KIND`, `LIVE_PAGE_SIZE`, `LiveFeed` (Task 2); existing tables `factionEvents`, `warLogEvents`, `clanNotices`, `banAnnouncements`, `playerSessions`, `players`, `membershipHistory`, `factions`; `activeServerId` from `./server`.
- Produces (exported from `@factions/roster`):
  ```ts
  type LiveRow =
    | { feed: "kills" | "hits" | "streaks" | "long-range"; id: number; occurredAt: Date; payload: LivePayload[LiveEntryKind] }
    | { feed: "clans"; id: number; occurredAt: Date; kind: FactionEventKind; payload: { name: string; tag: string; texture: string; actor?: string; previousName?: string; disbandAt?: string } }
    | { feed: "war-log"; id: number; occurredAt: Date; kind: WarLogKind; payload: Record<string, unknown> }
    | { feed: "achievements"; id: number; occurredAt: Date; payload: { key: string; name: string; description: string; ownerKind: "player" | "clan"; ownerName: string | null; gamertag: string | null; clanTag: string | null } }
    | { feed: "bans"; id: number; occurredAt: Date; kind: BanAnnouncementKind; payload: { gamertag: string; reason: BanReason; expiresAt: string | null } };
  type LiveQuery = { before?: number; after?: number; limit?: number };
  type OnlinePlayerRow = { gamertag: string; tag: string | null; connectedAt: Date };
  liveFeed(feed: Exclude<LiveFeed, "online">, q?: LiveQuery): Promise<LiveRow[]>   // newest first
  onlineNow(): Promise<OnlinePlayerRow[]>                                             // longest connected first
  ```

Rules:
- Every read is scoped to `activeServerId(db)`.
- `after` takes precedence over `before`: with `after`, return rows with `id > after`, newest first, capped at `limit`.
- `limit` is clamped to `1..LIVE_PAGE_SIZE`, default `LIVE_PAGE_SIZE`.
- Achievements read `clan_notices` where `kind = 'achievement' AND target = 'channel' AND faction_id IS NULL AND payload->>'public' = 'true'`. `ownerName` is set to `null` when it is all digits, and `ownerId` and `public` are dropped.
- Bans select only `gamertag`, `reason`, `expiresAt` from the payload, never anything else.
- `onlineNow` returns no `dayzId`.

- [ ] **Step 1: Write the failing test**

Base the setup on `packages/roster/test/notices.test.ts` and `scoring.test.ts` (they seed a server and clans through `./seed`). Truncate `feed_entries, clan_notices, faction_events, war_log_events, ban_announcements, player_sessions` as well.

```ts
// packages/roster/test/live.test.ts  (setup: db, serverId, an events row per feed_entries row)
import { liveFeedDb, onlineNowDb } from "../src/live";

it("pages newest first with before, and returns only newer rows with after", async () => {
  const ids = await seedKills(5);            // five feed_entries rows of kind 'kill'
  const first = await liveFeedDb(db, "kills", { limit: 2 });
  expect(first.map((r) => r.id)).toEqual([ids[4], ids[3]]);
  const older = await liveFeedDb(db, "kills", { before: ids[3], limit: 2 });
  expect(older.map((r) => r.id)).toEqual([ids[2], ids[1]]);
  const newer = await liveFeedDb(db, "kills", { after: ids[2] });
  expect(newer.map((r) => r.id)).toEqual([ids[4], ids[3]]);
});

it("keeps each combat tab to its own kind", async () => {
  await seedEntry("kill"); await seedEntry("long_range");
  expect((await liveFeedDb(db, "long-range")).every((r) => r.feed === "long-range")).toBe(true);
  expect(await liveFeedDb(db, "long-range")).toHaveLength(1);
});

it("clamps the limit", async () => {
  await seedKills(3);
  expect(await liveFeedDb(db, "kills", { limit: 0 })).toHaveLength(1);
  expect(await liveFeedDb(db, "kills", { limit: 10_000 })).toHaveLength(3);
});

it("reads only the public achievement posts and never hands back a Discord id", async () => {
  await insertNotice({ target: "channel", factionId: null, payload: { key: "k", name: "N", description: "D", ownerKind: "player", ownerId: "x", ownerName: "123456789012345678", gamertag: null, clanTag: null, public: true } });
  await insertNotice({ target: "channel", factionId: clanId, payload: { key: "k", name: "N", description: "D", ownerKind: "clan", ownerName: "Wolves", public: false } });
  const rows = await liveFeedDb(db, "achievements");
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toMatch(/123456789012345678|ownerId/u);
});

it("lists who is online without their DayZ id", async () => {
  await openSession("A".repeat(40), "Alpha");
  const rows = await onlineNowDb(db);
  expect(rows).toEqual([{ gamertag: "Alpha", tag: null, connectedAt: expect.any(Date) }]);
});

it("reads the war log from war_log_events, all four kinds", async () => {
  // insert one row each of raid, defense, week_closed, season_closed; expect 4 back, newest first
});

it("bans carry only gamertag, reason and expiry", async () => {
  // insert a ban_announcements row with an extra payload key; expect it absent in the result
});
```

Write real helpers (`seedKills`, `seedEntry`, `insertNotice`, `openSession`) in the test file, and fill in the two remaining tests completely. Each `feed_entries` row needs an `events` row for its FK.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/roster && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/live.test.ts`
Expected: FAIL, the module is missing.

- [ ] **Step 3: Implement `packages/roster/src/live.ts`**

```ts
import type { Database } from "@factions/db";
import { banAnnouncements, clanNotices, factionEvents, factions, feedEntries, membershipHistory, playerSessions, players, warLogEvents } from "@factions/db";
import { LIVE_FEED_KIND, LIVE_PAGE_SIZE, type LiveFeed } from "@factions/domain";
import { and, asc, desc, eq, gt, isNull, lt, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { activeServerId } from "./server";
// LiveRow, LiveQuery, OnlinePlayerRow types as in Interfaces above.

const clamp = (n: number | undefined) => Math.min(LIVE_PAGE_SIZE, Math.max(1, Math.trunc(n ?? LIVE_PAGE_SIZE) || 1));

/** `id < before` or `id > after`; after wins. Both are integers the caller has already validated. */
function window(id: AnyPgColumn, q: LiveQuery): SQL | undefined {
  if (q.after !== undefined) return gt(id, q.after);
  if (q.before !== undefined) return lt(id, q.before);
  return undefined;
}

const DISCORD_ID = /^\d+$/u;

export async function liveFeedDb(db: Database, feed: Exclude<LiveFeed, "online">, q: LiveQuery = {}): Promise<LiveRow[]> {
  const serverId = await activeServerId(db);
  const limit = clamp(q.limit);
  switch (feed) {
    case "kills": case "hits": case "streaks": case "long-range": {
      const rows = await db.select({ id: feedEntries.id, occurredAt: feedEntries.occurredAt, payload: feedEntries.payload }).from(feedEntries)
        .where(and(eq(feedEntries.serverId, serverId), eq(feedEntries.kind, LIVE_FEED_KIND[feed]), window(feedEntries.id, q)))
        .orderBy(desc(feedEntries.id)).limit(limit);
      return rows.map((r) => ({ feed, id: r.id, occurredAt: r.occurredAt, payload: r.payload as never }));
    }
    case "clans": {
      const rows = await db.select({ id: factionEvents.id, occurredAt: factionEvents.occurredAt, kind: factionEvents.kind, payload: factionEvents.payload }).from(factionEvents)
        .where(and(eq(factionEvents.serverId, serverId), window(factionEvents.id, q)))
        .orderBy(desc(factionEvents.id)).limit(limit);
      return rows.map((r) => ({ feed, ...r, payload: r.payload as never }));
    }
    case "war-log": {
      const rows = await db.select({ id: warLogEvents.id, occurredAt: warLogEvents.occurredAt, kind: warLogEvents.kind, payload: warLogEvents.payload }).from(warLogEvents)
        .where(and(eq(warLogEvents.serverId, serverId), window(warLogEvents.id, q)))
        .orderBy(desc(warLogEvents.id)).limit(limit);
      return rows.map((r) => ({ feed, ...r, payload: r.payload as Record<string, unknown> }));
    }
    case "achievements": {
      const rows = await db.select({ id: clanNotices.id, occurredAt: clanNotices.occurredAt, payload: clanNotices.payload }).from(clanNotices)
        .where(and(
          eq(clanNotices.serverId, serverId), eq(clanNotices.kind, "achievement"), eq(clanNotices.target, "channel"),
          isNull(clanNotices.factionId), sql`${clanNotices.payload}->>'public' = 'true'`, window(clanNotices.id, q),
        ))
        .orderBy(desc(clanNotices.id)).limit(limit);
      return rows.map((r) => {
        const p = r.payload as Record<string, unknown>;
        const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
        const ownerName = str(p.ownerName);
        return {
          feed, id: r.id, occurredAt: r.occurredAt,
          payload: {
            key: String(p.key), name: String(p.name), description: String(p.description),
            ownerKind: p.ownerKind === "clan" ? "clan" : "player",
            ownerName: ownerName !== null && DISCORD_ID.test(ownerName) ? null : ownerName,
            gamertag: str(p.gamertag), clanTag: str(p.clanTag),
          },
        };
      });
    }
    case "bans": {
      const rows = await db.select({ id: banAnnouncements.id, occurredAt: banAnnouncements.occurredAt, kind: banAnnouncements.kind, payload: banAnnouncements.payload }).from(banAnnouncements)
        .where(and(eq(banAnnouncements.serverId, serverId), window(banAnnouncements.id, q)))
        .orderBy(desc(banAnnouncements.id)).limit(limit);
      return rows.map((r) => {
        const p = r.payload as Record<string, unknown>;
        return { feed, id: r.id, occurredAt: r.occurredAt, kind: r.kind, payload: { gamertag: String(p.gamertag), reason: p.reason as never, expiresAt: typeof p.expiresAt === "string" ? p.expiresAt : null } };
      });
    }
  }
}

/** The bot's #players-online board (apps/bot/src/online-tick.ts PgOnlineStore), minus the DayZ id. */
export async function onlineNowDb(db: Database): Promise<OnlinePlayerRow[]> {
  const serverId = await activeServerId(db);
  const rows = await db.select({ gamertag: players.gamertag, connectedAt: playerSessions.connectedAt, tag: factions.tag }).from(playerSessions)
    .leftJoin(players, eq(players.dayzId, playerSessions.dayzId))
    .leftJoin(membershipHistory, and(eq(membershipHistory.serverId, playerSessions.serverId), eq(membershipHistory.dayzId, playerSessions.dayzId), isNull(membershipHistory.leftAt)))
    .leftJoin(factions, eq(factions.id, membershipHistory.factionId))
    .where(and(eq(playerSessions.serverId, serverId), isNull(playerSessions.disconnectedAt)))
    .orderBy(asc(playerSessions.connectedAt));
  return rows.map((r) => ({ gamertag: r.gamertag ?? "Unknown", tag: r.tag ?? null, connectedAt: r.connectedAt }));
}
```

Check before writing it: confirm the ban payload's key names in `apps/bot/src/ban-tick.ts` (`announceTx`) and the war log's `kind` column type. Adjust the field names to match, but don't widen what gets selected.

In `api.ts`, inside `makeRoster`, beside `warLog`:

```ts
liveFeed: (feed: Exclude<LiveFeed, "online">, q?: LiveQuery): Promise<LiveRow[]> => liveFeedDb(getDb(), feed, q),
onlineNow: (): Promise<OnlinePlayerRow[]> => onlineNowDb(getDb()),
```

and re-export the types `LiveRow`, `LiveQuery`, `OnlinePlayerRow` from `api.ts`.

In `index.ts`, add `liveFeed, onlineNow` to the destructured `makeRoster(db)` list and `export type { LiveRow, LiveQuery, OnlinePlayerRow } from "./api";`.

Add `"liveFeed"` and `"onlineNow"` in sorted position to `ROSTER_EXPORTS` (`packages/roster/test/roster-exports.ts`) and to the array in `apps/web/test/smoke.test.ts:100`.

- [ ] **Step 4: Run the tests**

Run: `cd packages/roster && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/live.test.ts test/exports.test.ts && npx tsc --noEmit && cd ../../apps/web && npx vitest run test/smoke.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/roster apps/web/test/smoke.test.ts
git commit -m "feat(roster): liveFeed and onlineNow reads for the website"
```

---

### Task 10: Public gate, GET allowlist and nav

**Files:**
- Modify: `apps/web/lib/auth/gate.ts`, `apps/web/test/auth-gate.test.ts`, `apps/web/test/api-routes.test.ts`, `apps/web/lib/menu.ts`, `apps/web/test/menu.test.ts`

**Interfaces:**
- Produces: `/live` (path), `/live/` and `/api/live/` (prefixes) public; `/api/live/` allowed to export GET; menu items `{ label: "Live", href: "/live", also: ["/war-log"] }` in the bar, `{ label: "Live", href: "/live" }` in the drawer.

- [ ] **Step 1: Update the pinning tests first (they fail)**

In `test/auth-gate.test.ts`:
- Add `"/live"` to the `PUBLIC_PATHS` expectation after `"/war-log"`.
- Add `"/live/"` and `"/api/live/"` to the `PUBLIC_PREFIXES` expectation, at the end.
- Add `expect(pathIsPublic("/live/kills")).toBe(true); expect(pathIsPublic("/api/live/kills")).toBe(true); expect(pathIsPublic("/livestream")).toBe(false);`.

In `test/api-routes.test.ts`, add `` `${sep}api${sep}live${sep}` `` to `GET_ALLOWED`, with the comment "`/api/live/` is the Live page's poll: a public read, mutating nothing."

In `test/menu.test.ts`, update the bar expectation so "Live" replaces "War log" in `BOARDS` with `also: ["/war-log"]`, and update the drawer expectation so `BOARDS_LONG` gains `{ label: "Live", href: "/live" }` after "Seasons", with "War log" kept.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && npx vitest run test/auth-gate.test.ts test/api-routes.test.ts test/menu.test.ts`
Expected: FAIL on the new expectations.

- [ ] **Step 3: Make the changes**

`lib/auth/gate.ts`: add `"/live"` to `PUBLIC_PATHS` after `"/war-log"`, and add `"/live/", "/api/live/"` to the end of `PUBLIC_PREFIXES`. Extend the prefix comment: "`/live/` is the Live page's tabs and `/api/live/` its poll (spec 2026-09-30-website-live-feeds): the same public feeds the bot posts to Discord, never a coordinate."

`lib/menu.ts`:

```ts
const BOARDS: readonly MenuItem[] = [
  { label: "Clans", href: "/clans" },
  { label: "Players", href: "/players" },
  { label: "Scoreboard", href: "/scoreboard", also: ["/alphas", "/seasons"] },
  // ⚠️ Live replaces War log in the bar: there is no room for another cell at
  // 1024px. The war log is a Live tab, and /war-log still lights this up.
  { label: "Live", href: "/live", also: ["/war-log"] },
];

const BOARDS_LONG: readonly MenuItem[] = [
  { label: "Clans", href: "/clans" },
  { label: "Players", href: "/players" },
  { label: "Scoreboard", href: "/scoreboard" },
  { label: "Alphas", href: "/alphas" },
  { label: "Seasons", href: "/seasons" },
  { label: "Live", href: "/live" },
  { label: "War log", href: "/war-log" },
];
```

Check that the `also` matching treats `/live/kills` as lighting up "Live" (prefix match). Read the bar's active logic in `app/(site)/site-bar.tsx` and add a test case to `menu.test.ts` if there's a helper for it.

- [ ] **Step 4: Run them to verify they pass**

Run: `cd apps/web && npx vitest run test/auth-gate.test.ts test/api-routes.test.ts test/menu.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib apps/web/test
git commit -m "feat(web): make /live public and put it in the nav"
```

---

### Task 11: Live data shaping for the web (`lib/live.ts`) and the card component

**Files:**
- Create: `apps/web/lib/live.ts`, `apps/web/app/(site)/live/live-card.tsx`, `apps/web/app/(site)/live/rich.tsx`
- Test: `apps/web/test/live.test.ts`, `apps/web/test/live-card.test.tsx`

**Interfaces:**
- Consumes: `liveFeed`, `onlineNow`, `LiveRow`, `OnlinePlayerRow` (Task 9); `killCard`, `hitCard`, `streakCard`, `longRangeCard`, `clanFeedCard`, `warLogLine`, `banLine`, `achievementLine`, `onlineLine`, `Line` (Tasks 3–4); `isLiveFeed`, `LIVE_FEEDS` (Task 2).
- Produces:
  ```ts
  // lib/live.ts  (pure, no I/O except loadLive)
  type LiveItem = {
    id: number;
    at: string;                 // ISO
    title: Line | null;         // null for one-line feeds
    href: string | null;
    lines: Line[];
    detail: Line[];
    flag: string | null;        // texture, for flagThumbPath
    badge: { key: string } | null;
    tone: "plain" | "warn";     // warn: friendly fire / Hub
  };
  LIVE_TABS: { feed: LiveFeed; label: string }[]   // Online, Kills, Hits, Streaks, Long range, Clans, War log, Achievements, Bans
  parseCursor(v: string | string[] | null | undefined): number | undefined   // positive safe integer or undefined
  toLiveItem(row: LiveRow): LiveItem
  loadLive(feed: Exclude<LiveFeed, "online">, q: { before?: number; after?: number }): Promise<LiveItem[]>
  // live-card.tsx
  <LiveCardView item={LiveItem} />    // server-safe, no hooks
  // rich.tsx
  <Rich line={Line} />
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/test/live.test.ts
import { describe, it, expect } from "vitest";
import { parseCursor, toLiveItem, LIVE_TABS } from "../lib/live";
import { LIVE_FEEDS } from "@factions/domain";

describe("parseCursor", () => {
  it.each([["12", 12], ["1", 1]])("accepts %s", (v, n) => expect(parseCursor(v)).toBe(n));
  it.each(["abc", "-1", "0", "1.5", "1e309", "9007199254740993", "", " 12"])("ignores %s", (v) => expect(parseCursor(v)).toBeUndefined());
  it("ignores arrays and absence", () => {
    expect(parseCursor(["1", "2"])).toBeUndefined();
    expect(parseCursor(undefined)).toBeUndefined();
    expect(parseCursor(null)).toBeUndefined();
  });
});

describe("LIVE_TABS", () => {
  it("has one tab per feed, in order", () => expect(LIVE_TABS.map((t) => t.feed)).toEqual([...LIVE_FEEDS]));
});

describe("toLiveItem", () => {
  it("marks friendly fire and Hub kills as warn and carries the killer's flag", () => {
    const item = toLiveItem({
      feed: "kills", id: 7, occurredAt: new Date("2026-09-08T01:00:00Z"),
      payload: {
        occurredAt: "2026-09-08T01:00:00.000Z", killer: { gamertag: "A", tag: "AAA", texture: "Flag_Wolf" }, victim: { gamertag: "B", tag: null, texture: null },
        weapon: null, distanceM: null, friendlyFire: true, atHub: false, cause: "pvp", tally: { killerKills: 1, victimDeaths: 1, season: 1 }, hits: [],
      },
    } as never);
    expect(item).toMatchObject({ id: 7, at: "2026-09-08T01:00:00.000Z", tone: "warn", flag: "Flag_Wolf", href: "/players/A" });
  });
  it("gives one-line feeds no title", () => {
    const item = toLiveItem({ feed: "bans", id: 1, occurredAt: new Date(0), kind: "expired", payload: { gamertag: "A", reason: "x" as never, expiresAt: null } });
    expect(item.title).toBeNull();
    expect(item.lines).toHaveLength(1);
  });
  it("gives an achievement its badge", () => {
    const item = toLiveItem({ feed: "achievements", id: 1, occurredAt: new Date(0), payload: { key: "first_blood", name: "N", description: "D", ownerKind: "player", ownerName: null, gamertag: "A", clanTag: null } });
    expect(item.badge).toEqual({ key: "first_blood" });
  });
});
```

```tsx
// apps/web/test/live-card.test.tsx
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Rich } from "../app/(site)/live/rich";
import { when } from "../lib/format";

describe("Rich", () => {
  it("links players and clans and prints time in UTC", () => {
    const html = renderToStaticMarkup(createElement(Rich, { line: [{ bold: [{ player: "Al pha" }] }, " [", { clan: "WLF" }, "] ", { time: "2026-09-07T22:14:00.000Z", style: "at" }] }));
    expect(html).toContain('href="/players/Al%20pha"');
    expect(html).toContain('href="/clans/WLF"');
    expect(html).toContain(when(new Date("2026-09-07T22:14:00.000Z")));
  });
  it("escapes player text rather than rendering it as HTML", () => {
    expect(renderToStaticMarkup(createElement(Rich, { line: [{ raw: "<b>x</b>" }] }))).toContain("&lt;b&gt;");
  });
});
```

Check `apps/web/vitest.config.*` picks up `.test.tsx`. Other `*.test.tsx` files already exist, so it should.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && npx vitest run test/live.test.ts test/live-card.test.tsx`
Expected: FAIL, the modules are missing.

- [ ] **Step 3: Implement**

`apps/web/lib/live.ts`:

```ts
import { liveFeed, type LiveRow } from "@factions/roster";
import { LIVE_FEEDS, type LiveFeed, type LiveKill, type LiveHitRun, type LiveStreak, type LiveLongRange } from "@factions/domain";
import { killCard, hitCard, streakCard, longRangeCard, clanFeedCard, warLogLine, banLine, achievementLine, type Line, type LiveCard } from "@factions/copy";

export type LiveItem = {
  id: number; at: string; title: Line | null; href: string | null; lines: Line[]; detail: Line[];
  flag: string | null; badge: { key: string } | null; tone: "plain" | "warn";
};

const LABELS: Record<LiveFeed, string> = {
  online: "Online", kills: "Kills", hits: "Hits", streaks: "Streaks", "long-range": "Long range",
  clans: "Clans", "war-log": "War log", achievements: "Achievements", bans: "Bans",
};
export const LIVE_TABS = LIVE_FEEDS.map((feed) => ({ feed, label: LABELS[feed] }));

/** ⚠️ Attacker-supplied. A positive safe integer, or nothing: never reaches SQL as anything else. */
export function parseCursor(v: string | string[] | null | undefined): number | undefined {
  if (typeof v !== "string" || !/^[1-9][0-9]{0,15}$/u.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : undefined;
}

const card = (c: LiveCard, row: { id: number; occurredAt: Date }, extra: Partial<LiveItem>): LiveItem => ({
  id: row.id, at: row.occurredAt.toISOString(), title: c.title, href: c.href, lines: c.lines, detail: c.detail,
  flag: null, badge: null, tone: "plain", ...extra,
});
const line = (l: Line, row: { id: number; occurredAt: Date }, extra: Partial<LiveItem> = {}): LiveItem => ({
  id: row.id, at: row.occurredAt.toISOString(), title: null, href: null, lines: [l], detail: [],
  flag: null, badge: null, tone: "plain", ...extra,
});

export function toLiveItem(row: LiveRow): LiveItem {
  switch (row.feed) {
    case "kills": { const k = row.payload as LiveKill; return card(killCard(k), row, { flag: k.killer.texture, tone: k.friendlyFire || k.atHub ? "warn" : "plain" }); }
    case "hits": { const h = row.payload as LiveHitRun; return card(hitCard(h), row, { flag: h.attacker.texture, tone: h.friendlyFire ? "warn" : "plain" }); }
    case "streaks": { const s = row.payload as LiveStreak; return card(streakCard(s), row, { flag: s.killer.texture }); }
    case "long-range": { const l = row.payload as LiveLongRange; return card(longRangeCard(l), row, { flag: l.killer.texture, tone: l.friendlyFire ? "warn" : "plain" }); }
    case "clans": return card(clanFeedCard(row.kind, row.payload), row, { flag: row.payload.texture });
    case "war-log": return line(warLogLine(row.kind, row.payload, row.occurredAt.toISOString()), row);
    case "achievements": return line(achievementLine(row.payload), row, { badge: { key: row.payload.key } });
    case "bans": return line(banLine({ kind: row.kind, ...row.payload }), row);
  }
}

export async function loadLive(feed: Exclude<LiveFeed, "online">, q: { before?: number; after?: number }): Promise<LiveItem[]> {
  return (await liveFeed(feed, q)).map(toLiveItem);
}
```

`apps/web/app/(site)/live/rich.tsx`:

```tsx
import type { Line, Seg } from "@factions/copy";
import { when } from "@/lib/format";
import { link } from "@/app/components/ui";

/** A shared copy Line as JSX: the site's half of what the bot does with lineMarkdown. */
export function Rich({ line }: { line: Line }) {
  return <>{line.map((s, i) => <Part key={i} s={s} />)}</>;
}

function Part({ s }: { s: Seg }) {
  if (typeof s === "string") return <>{s}</>;
  if ("text" in s) return <>{s.text}</>;
  if ("raw" in s) return <>{s.raw}</>;
  if ("bold" in s) return <strong className="text-ink"><Rich line={s.bold} /></strong>;
  if ("player" in s) return <a className={link} href={`/players/${encodeURIComponent(s.player)}`}>{s.player}</a>;
  if ("clan" in s) {
    const a = <a className={link} href={`/clans/${encodeURIComponent(s.clan)}`}>{s.name ?? s.clan}</a>;
    return s.name ? <><strong className="text-ink">{a}</strong> [{s.clan}]</> : a;
  }
  if ("time" in s) return <time dateTime={s.time}>{when(new Date(s.time))}</time>;
  return <a className={link} href={s.page}>{s.label}</a>;
}
```

`apps/web/app/(site)/live/live-card.tsx`: one `<li>` per item. On the left is the flag thumbnail (`flagThumbPath(item.flag)`, 40px, `alt=""`) or the achievement badge (`<AchievementBadge achievementKey={…} group={…} state="unlocked" size={40} />`, with `group` from `ACHIEVEMENT_BY_KEY[key]?.group`; read `achievement-badge.tsx` for the exact props). On the right:
- the title, if present, in `font-display`, linked to `item.href`, and `text-rust` when `tone === "warn"`
- the lines as `<p className="text-ink-2">`
- the detail lines as `font-mono text-xs text-muted`
- a `when(new Date(item.at))` stamp in a `<time>`, styled like `kicker`

Use only existing tokens.

- [ ] **Step 4: Run them to verify they pass**

Run: `cd apps/web && npx vitest run test/live.test.ts test/live-card.test.tsx test/raw-hex.test.ts test/copy-vocabulary.test.ts test/smoke.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/live.ts "apps/web/app/(site)/live" apps/web/test/live.test.ts apps/web/test/live-card.test.tsx
git commit -m "feat(web): shape live feed rows into cards and render shared copy"
```

---

### Task 12: `/live/[feed]` pages, the poll route and the self-refreshing list

**Files:**
- Create: `apps/web/app/(site)/live/page.tsx` (redirect), `apps/web/app/(site)/live/[feed]/page.tsx`, `apps/web/app/(site)/live/live-list.tsx` (client), `apps/web/app/(site)/live/online-board.tsx` (client), `apps/web/app/api/live/[feed]/route.ts`
- Modify: `apps/web/lib/guide-links.ts` only if `page-titles.test.ts` or `guide-links.test.ts` require an entry for every page
- Test: `apps/web/test/live-route.test.ts`; existing `request-time-rendering.test.ts`, `page-titles.test.ts`, `route-param.test.ts`, `api-routes.test.ts`

**Interfaces:**
- Consumes: `LIVE_TABS`, `parseCursor`, `loadLive`, `LiveItem` (Task 11), `onlineNow` (Task 9), `isLiveFeed`, `LIVE_PAGE_SIZE` (Task 2), `onlineLine`, `ONLINE_TITLE`, `ONLINE_EMPTY` (Task 4), `visiblePoll` (`lib/visible-poll.ts`), `json` (`lib/api.ts`).
- Produces:
  - `GET /api/live/[feed]?before=&after=` → `{ items: LiveItem[] }`
  - `GET /api/live/online` → `{ players: { gamertag, tag, connectedAt: string }[] }`
  - unknown feed → 404 `{ error: "unknown-feed" }`
  - `LIVE_POLL_MS = 15_000` exported from `live-list.tsx`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/live-route.test.ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@factions/roster", () => ({
  liveFeed: vi.fn(async () => []),
  onlineNow: vi.fn(async () => [{ gamertag: "A", tag: null, connectedAt: new Date("2026-09-08T00:00:00Z") }]),
}));

const { GET } = await import("../app/api/live/[feed]/route");
const roster = await import("@factions/roster");
const call = (feed: string, qs = "") =>
  GET(new Request(`http://x/api/live/${feed}${qs}`) as never, { params: Promise.resolve({ feed }) });

describe("GET /api/live/[feed]", () => {
  it("404s an unknown feed without touching the database", async () => {
    const r = await call("constructor");
    expect(r.status).toBe(404);
    expect(roster.liveFeed).not.toHaveBeenCalled();
  });
  it("drops junk cursors instead of passing them on", async () => {
    await call("kills", "?before=abc&after=-1");
    expect(roster.liveFeed).toHaveBeenLastCalledWith("kills", { before: undefined, after: undefined });
  });
  it("passes a valid after cursor", async () => {
    await call("kills", "?after=42");
    expect(roster.liveFeed).toHaveBeenLastCalledWith("kills", { before: undefined, after: 42 });
  });
  it("serves the online list with ISO times and no-store", async () => {
    const r = await call("online");
    expect(r.headers.get("cache-control")).toBe("no-store, private");
    expect(await r.json()).toEqual({ players: [{ gamertag: "A", tag: null, connectedAt: "2026-09-08T00:00:00.000Z" }] });
  });
});
```

Check how existing route tests build a `NextRequest`, and the second-argument shape for dynamic params in this Next version (`node_modules/next/dist/docs/`, per `apps/web/AGENTS.md`). Match both in the test and the route.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run test/live-route.test.ts`
Expected: FAIL, the route is missing.

- [ ] **Step 3: Implement the route**

```ts
// apps/web/app/api/live/[feed]/route.ts
import type { NextRequest } from "next/server";
import { onlineNow } from "@factions/roster";
import { isLiveFeed } from "@factions/domain";
import { json } from "@/lib/api";
import { loadLive, parseCursor } from "@/lib/live";

/**
 * The Live page's poll (spec 2026-09-30-website-live-feeds). Public, like the
 * page: the same feeds the bot posts to Discord, never a coordinate. A read;
 * mutates nothing (test/api-routes.test.ts allows it a GET).
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ feed: string }> }) {
  const { feed } = await ctx.params;
  if (!isLiveFeed(feed)) return json({ error: "unknown-feed" }, 404);
  if (feed === "online") {
    const players = await onlineNow();
    return json({ players: players.map((p) => ({ ...p, connectedAt: p.connectedAt.toISOString() })) });
  }
  const sp = req.nextUrl.searchParams;
  return json({ items: await loadLive(feed, { before: parseCursor(sp.get("before")), after: parseCursor(sp.get("after")) }) });
}
```

`loadLive` calls `liveFeed(feed, q)` with exactly `{ before, after }`, which is what the test asserts.

- [ ] **Step 4: Implement the pages**

`app/(site)/live/page.tsx`:

```tsx
import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";
export default function LiveIndex() { redirect("/live/kills"); }
```

`app/(site)/live/[feed]/page.tsx`:

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { onlineNow } from "@factions/roster";
import { isLiveFeed } from "@factions/domain";
import { Page, PageHead, Body, Panel, SegNav } from "@/app/components/ui";
import { LIVE_TABS, loadLive, parseCursor } from "@/lib/live";
import { LiveList } from "../live-list";
import { OnlineBoard } from "../online-board";

export const metadata: Metadata = { title: "Clan Wars — live" };
/** ⚠️ Public but live: rendered per request, never baked into a static chunk. */
export const dynamic = "force-dynamic";

export default async function LivePage({ params, searchParams }: { params: Promise<{ feed: string }>; searchParams: Promise<{ before?: string | string[] }> }) {
  const { feed } = await params;
  if (!isLiveFeed(feed)) notFound();
  const tab = LIVE_TABS.find((t) => t.feed === feed)!;
  const nav = <SegNav label="Feed" className="overflow-x-auto" items={LIVE_TABS.map((t) => ({ label: t.label, href: `/live/${t.feed}`, current: t.feed === feed }))} />;

  if (feed === "online") {
    const players = (await onlineNow()).map((p) => ({ ...p, connectedAt: p.connectedAt.toISOString() }));
    return (
      <Page wide>
        <PageHead kicker="Live" title={tab.label} aside={nav} />
        <Body><Panel><OnlineBoard initial={players} /></Panel></Body>
      </Page>
    );
  }

  const before = parseCursor((await searchParams).before);
  const items = await loadLive(feed, { before });
  return (
    <Page wide>
      <PageHead kicker="Live" title={tab.label} aside={nav} />
      <Body>
        <Panel>
          <LiveList feed={feed} initial={items} live={before === undefined} />
        </Panel>
      </Body>
    </Page>
  );
}
```

Check `page-titles.test.ts` for the title rule and match it. If `SegNav` wraps rather than scrolls at phone width, keep the wrap: it's the existing primitive, and nine short labels wrap acceptably. Check the page at 375px in Step 7.

`app/(site)/live/live-list.tsx`, a client component:

```tsx
"use client";
import { useEffect, useRef, useState } from "react";
import type { LiveFeed } from "@factions/domain";
import type { LiveItem } from "@/lib/live";
import { visiblePoll } from "@/lib/visible-poll";
import { btnSecondary } from "@/app/components/ui";
import { LiveCardView } from "./live-card";

export const LIVE_POLL_MS = 15_000;

/**
 * The tab's entries, newest first. While the newest page is on screen (`live`)
 * it polls for `after=<newest id>` and puts new entries on top. "Older" fetches
 * `before=<oldest id>` and appends. Both go through /api/live/<feed>.
 */
export function LiveList({ feed, initial, live }: { feed: Exclude<LiveFeed, "online">; initial: LiveItem[]; live: boolean }) {
  const [items, setItems] = useState(initial);
  const [more, setMore] = useState(initial.length > 0);
  const newest = useRef(initial[0]?.id ?? 0);

  useEffect(() => {
    if (!live) return;
    return visiblePoll(document, async () => {
      try {
        const qs = newest.current > 0 ? `?after=${newest.current}` : "";
        const r = await fetch(`/api/live/${feed}${qs}`, { cache: "no-store" });
        if (!r.ok) return;
        const { items: fresh } = (await r.json()) as { items: LiveItem[] };
        if (fresh.length === 0) return;
        newest.current = Math.max(newest.current, fresh[0]!.id);
        setItems((cur) => {
          const seen = new Set(cur.map((i) => i.id));
          return [...fresh.filter((i) => !seen.has(i.id)), ...cur];
        });
      } catch { /* a missed poll is retried in 15 s */ }
    }, LIVE_POLL_MS);
  }, [feed, live]);

  async function older() {
    const last = items[items.length - 1];
    if (!last) return;
    const r = await fetch(`/api/live/${feed}?before=${last.id}`, { cache: "no-store" });
    if (!r.ok) return;
    const { items: page } = (await r.json()) as { items: LiveItem[] };
    setItems((cur) => [...cur, ...page.filter((i) => !cur.some((c) => c.id === i.id))]);
    if (page.length === 0) setMore(false);
  }

  if (items.length === 0) return <p className="text-ink-2">Nothing here yet. It fills in as it happens on the server.</p>;
  return (
    <>
      <ol className="divide-y divide-rule">{items.map((i) => <LiveCardView key={i.id} item={i} />)}</ol>
      {more && <div className="mt-4"><button type="button" className={btnSecondary} onClick={older}>Older</button></div>}
    </>
  );
}
```

`live-card.tsx` must stay free of server-only imports so this client component can render it. If `flagThumbPath` or `AchievementBadge` import anything server-only, render the image through a plain `<img src>` built by a client-safe helper instead.

⚠️ `when()` in a client component runs in the browser. It formats with `timeZone: "UTC"`, so server and client produce the same string and there is no hydration mismatch (`utc-times.test.ts` covers the same concern for `/link`).

`app/(site)/live/online-board.tsx`: a client component taking `initial: { gamertag; tag; connectedAt: string }[]`. It renders `ONLINE_TITLE(n)` as a kicker and one `<li>` per player via `<Rich line={onlineLine(p)} />`, or `ONLINE_EMPTY`. It re-fetches `/api/live/online` every `LIVE_POLL_MS` through `visiblePoll` and replaces the list. Players come sorted longest-connected first from the read; keep that order.

- [ ] **Step 5: Run the web tests**

Run: `cd apps/web && npx vitest run test/live-route.test.ts test/request-time-rendering.test.ts test/page-titles.test.ts test/route-param.test.ts test/api-routes.test.ts test/smoke.test.ts test/copy-vocabulary.test.ts test/raw-hex.test.ts test/tap-targets.test.tsx test/touch-targets.test.ts && npx tsc --noEmit`
Expected: PASS. If `route-param.test.ts` requires dynamic segments to be validated a particular way, follow it.

- [ ] **Step 6: Build check**

Run: `cd apps/web && npx next build`
Expected: the build succeeds. This is the check that catches a server-only import (`@factions/roster`) leaking into the client bundle through `live-list.tsx` → `@/lib/live`. If it fails with "Can't resolve 'fs'", split `lib/live.ts`: move `LiveItem`, `parseCursor`, `toLiveItem` and `LIVE_TABS` into `lib/live-items.ts` (no roster import), keep `loadLive` in `lib/live.ts`, and have client files import only `lib/live-items.ts`.

- [ ] **Step 7: Look at it**

Run the web app locally per `apps/web/README` or the `run` skill. Open `/live/kills`, `/live/online`, `/live/war-log` and `/live/foo` (expect a 404), at desktop width and at 375px. Confirm:
- there is no horizontal page scroll
- the tabs are reachable
- entries render with flags and links
- "Older" appends

Take a screenshot of each for the PR.

- [ ] **Step 8: Commit**

```bash
git add "apps/web/app/(site)/live" apps/web/app/api/live apps/web/test/live-route.test.ts apps/web/lib
git commit -m "feat(web): /live tabs with a self-refreshing feed and the online board"
```

---

### Task 13: Home page "Online now" panel and the `/war-log` cross-link

**Files:**
- Modify: `apps/web/app/(site)/page.tsx`, `apps/web/app/(site)/war-log/page.tsx`
- Test: `apps/web/test/site-strips.test.ts` (or a new `apps/web/test/home-online.test.tsx` if that file is about something else)

**Interfaces:**
- Consumes: `onlineNow` (Task 9), `ONLINE_EMPTY` (Task 4), `Rich` (Task 11).
- Produces: `HOME_ONLINE_CAP = 10` and `<OnlineNow players={…} />` in `app/(site)/live/online-now.tsx` (server component).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/test/home-online.test.tsx
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OnlineNow, HOME_ONLINE_CAP } from "../app/(site)/live/online-now";

const p = (n: number) => ({ gamertag: `P${n}`, tag: null, connectedAt: new Date("2026-09-08T00:00:00Z") });

describe("OnlineNow", () => {
  it("shows the count and at most ten names, linking to the full list", () => {
    const html = renderToStaticMarkup(createElement(OnlineNow, { players: Array.from({ length: 12 }, (_, i) => p(i)) }));
    expect(html).toContain("12");
    expect(html).toContain("P9");
    expect(html).not.toContain("P10");
    expect(html).toContain('href="/live/online"');
    expect(HOME_ONLINE_CAP).toBe(10);
  });
  it("says so when nobody is on", () => {
    expect(renderToStaticMarkup(createElement(OnlineNow, { players: [] }))).toContain("Nobody on the server.");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run test/home-online.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`app/(site)/live/online-now.tsx`:

```tsx
import type { OnlinePlayerRow } from "@factions/roster";
import { ONLINE_EMPTY } from "@factions/copy";
import { Panel, linkMono } from "@/app/components/ui";

export const HOME_ONLINE_CAP = 10;

/** The landing page's "Online now" panel: a count and the first ten names, longest on first. */
export function OnlineNow({ players }: { players: OnlinePlayerRow[] }) {
  const shown = players.slice(0, HOME_ONLINE_CAP);
  return (
    <Panel title={`Online now · ${players.length}`} aside={<a className={linkMono} href="/live/online">All<span className="sr-only"> players online</span> <span aria-hidden="true">→</span></a>}>
      {shown.length === 0 ? <p className="text-ink-2">{ONLINE_EMPTY}</p> : (
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          {shown.map((p) => (
            <li key={`${p.gamertag}@${p.connectedAt.toISOString()}`}>
              <a className="text-ink hover:text-gold" href={`/players/${encodeURIComponent(p.gamertag)}`}>{p.gamertag}</a>
              {p.tag && <span className="text-muted"> [{p.tag}]</span>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
```

In `app/(site)/page.tsx`, add `onlineNow()` to the `Promise.all` (line 24), and render `<OnlineNow players={online} />` as a panel beside the existing numbered panels. Follow the page's `num` sequence: renumber the panels after it if they're numbered in order, and check `site-strips.test.ts` for a pinned order.

In `app/(site)/war-log/page.tsx`, add one line under the "The last 200 …" footnote:

```tsx
<p className="mt-2 font-mono text-[11px] text-muted">Every war log post, including week and season closes, is on <a className="text-gold underline-offset-4 hover:underline" href="/live/war-log">Live</a>.</p>
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && npx vitest run test/home-online.test.tsx test/site-strips.test.ts test/request-time-rendering.test.ts test/raw-hex.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(site)" apps/web/test/home-online.test.tsx
git commit -m "feat(web): Online now on the landing page, and the war log points to Live"
```

---

### Task 14: Changelog, deploy notes and the full gate

**Files:**
- Modify: `CHANGELOG.md` (the Unreleased section; check `scripts/check_changelog.py` for the required format)
- Create: `docs/deploy/2026-09-30-live-feeds.md`

- [ ] **Step 1: Add the changelog entry**

Under Unreleased, in the format the file already uses:

```markdown
### Added
- A public Live page (`/live`) with every Discord feed: players online, kills, hits, streaks, long range, clan feed, war log, achievements and bans. It refreshes every 15 seconds while open.
- "Online now" on the landing page.
- `feed_entries` (migration 0061): the website's copy of the four combat feeds, recorded by the bot. Kills, streaks and long range backfill on the first run; hits start at deploy.
```

- [ ] **Step 2: Write the deploy note**

`docs/deploy/2026-09-30-live-feeds.md` covers:
- Migration 0061 is additive (one new table). It is safe to apply with the bot running.
- On the first tick after the bot restarts, the kill, killstreak and long-range recorders replay every PvP kill, 100 per recorder per tick, about 600 a minute. Watch for `live recorder: N kills` lines until they stop. A 5,000-kill history takes roughly 10 minutes, and Discord is unaffected.
- The hit recorder logs `live recorder: hit cursor seeded at the head` once.
- The web deploy needs the new image (`deploy/deploy-web.sh`). `/live` is public.
- Rollback: the recorders are harmless to leave running. To stop them, revert the bot, then optionally run `delete from consumer_cursors where consumer_name like '%-feed-recorder'` and `drop table feed_entries` against the right database only. Never run that against `factions_live` without a backup.

- [ ] **Step 3: Run the full gate**

Run, from `clan-wars/`:
`TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`
Expected: **32/32 tasks** successful. Read the count, not just the exit code. Fix any failures at their cause.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md docs/deploy/2026-09-30-live-feeds.md
git commit -m "docs: changelog and deploy note for the Live page"
```
