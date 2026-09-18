# Unlinked PC Ban Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ban a PC ("desktop") player who has not linked their account and is not mid-link, and lift that ban once when they start linking.

**Architecture:** The device type only appears in the server's `.RPT` files, which this pipeline has never read. The ingest worker learns an account's device **on demand** — when a `player.connected` event arrives for an account with no `player_devices` row it fetches the current RPT once and upserts every sighting in it. The bot then runs a level-triggered tick that writes ban rows and lift requests; the existing `banTick` is what actually talks to Nitrado.

**Tech Stack:** TypeScript, pnpm workspace + turbo, vitest, drizzle-orm over postgres.js, discord.js, Nitrado REST API.

**Spec:** `docs/superpowers/specs/2026-09-18-unlinked-pc-ban-design.md`

## Global Constraints

- **Only the exact device string `desktop` is PC.** `console`, or any value a future DayZ build introduces, is **not** a ban. Every unknown reads as "not PC".
- **A device line whose `dpnid` does not resolve to a uid is DROPPED, never guessed.** Not knowing a device is never a reason to ban.
- **Never backfill `player_devices` from retained RPTs.** Forward-only is enforced by the absence of data, not by a flag. A backfill silently converts this into a retroactive sweep that was explicitly not chosen, and bans four known people.
- **Every failure fails closed** (no ban): RPT fetch failure, unresolved dpnid, unknown device string, missing row.
- **`UNLINKED_PC_BAN` is its own gate,** absent by default, independent of `BAN_DRY_RUN`. In production `BAN_DRY_RUN=false` already, so the first PC ban is real the moment the gate is set.
- **One lift per account, for all time.** Derived, no new column: `exists (select 1 from bans where dayz_id = ? and reason = 'unlinked_pc' and status in ('lift_pending','lifted'))`.
- `player_devices` is **outside the lock order** (spec §4.12): one writer, single statement, references nothing.
- Every PR adds an entry under `## [Unreleased]` in `CHANGELOG.md`, **committed**, or the `changelog` CI gate blocks it.
- The gate is `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force` and must report **30/30 tasks, 0 cached**.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/adm-parser/src/device.ts` | **Create.** Pure RPT → `DeviceSighting[]`. |
| `packages/adm-parser/test/device.test.ts` | **Create.** Parser tests, including both drop cases. |
| `packages/adm-parser/src/index.ts` | **Modify.** Export `./device.js`. |
| `packages/domain/src/enforcement.ts` | **Modify.** Add `BAN_REASONS` / `BanReason`. |
| `packages/domain/src/rules.ts` | **Modify.** Add `DEVICE_LOOKUP_LOOKBACK_MS`. |
| `packages/domain/src/pc-gate.ts` | **Create.** The pure predicate. |
| `packages/domain/test/pc-gate.test.ts` | **Create.** Table-driven predicate tests. |
| `packages/db/src/schema.ts` | **Modify.** `playerDevices` table, `bans.reason` column. |
| `packages/db/migrations/0039_*.sql` | **Create** (generated). |
| `packages/nitrado/src/client.ts` | **Modify.** `newestRptPath()`. |
| `packages/nitrado/test/client.test.ts` | **Modify.** Its test. |
| `apps/ingest-worker/src/device-tick.ts` | **Create.** On-demand device resolution. |
| `apps/ingest-worker/test/device-tick.test.ts` | **Create.** |
| `apps/ingest-worker/src/sweep.ts` | **Modify.** Wire the tick in, own try/catch. |
| `apps/bot/src/pc-ban-tick.ts` | **Create.** Writes ban rows and lift requests. |
| `apps/bot/test/pc-ban-tick.test.ts` | **Create.** |
| `apps/bot/src/config.ts` | **Modify.** `unlinkedPcBan` gate. |
| `apps/bot/src/discord.ts` | **Modify.** Run the tick, post to ops. |
| `docs/deploy/2026-09-18-unlinked-pc-ban.md` | **Create.** Runbook. |
| `CLAUDE.md`, `apps/bot/README.md`, `CHANGELOG.md` | **Modify.** |

---

### Task 1: The RPT device parser

**Files:**
- Create: `packages/adm-parser/src/device.ts`
- Create: `packages/adm-parser/test/device.test.ts`
- Modify: `packages/adm-parser/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type DeviceSighting = { dayzId: string; gamertag: string; device: "console" | "desktop" }` and `parseDevices(rpt: string): DeviceSighting[]`.

**Context you need.** The repo's other parsers are in the same directory and are all pure string → object functions with a module-level regex; copy that shape. `index.ts` exports with a `.js` extension (`export * from "./identity.js";`) — this package is **not** in `transpilePackages`, so it keeps explicit extensions. Read `packages/adm-parser/src/identity.ts` first; it is the smallest example.

These are real lines from the live server (2026-09-17). Note that the uid on the first `[StateMachine]` line is **empty** — it is filled about two seconds later, which is why the join must go through the `dpnid`:

```
17:03:01.672 [StateMachine]: Player xARESx7256 (dpnid 1739924331 uid ) Entering AuthPlayerLoginState
17:03:03.313  LOGINQUEUE   : Player 1739924331 updated with device type 'desktop'
17:03:05.31  [StateMachine]: Player xARESx7256 (dpnid 1739924331 uid A9DDCCFAF1B79A6ADE0757193F49647B10A60913) Entering DBGetLoginTimeLoginState
```

- [ ] **Step 1: Write the failing test**

Create `packages/adm-parser/test/device.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseDevices } from "../src/device.js";

const DESKTOP = [
  `17:03:01.672 [StateMachine]: Player xARESx7256 (dpnid 1739924331 uid ) Entering AuthPlayerLoginState`,
  `17:03:03.313  LOGINQUEUE   : Player 1739924331 updated with device type 'desktop'`,
  `17:03:03.313  NETWORK      : Notified of player 1739924331 using device 'desktop' (not headless)`,
  `17:03:05.31  [StateMachine]: Player xARESx7256 (dpnid 1739924331 uid A9DDCCFAF1B79A6ADE0757193F49647B10A60913) Entering DBGetLoginTimeLoginState`,
].join("\n");

const CONSOLE = [
  `17:02:57.100 [StateMachine]: Player SomeGamer99 (dpnid 1858954623 uid ) Entering AuthPlayerLoginState`,
  `17:02:59.532  LOGINQUEUE   : Player 1858954623 updated with device type 'console'`,
  `17:02:59.532  NETWORK      : Notified of player 1858954623 using device 'console' (headless)`,
  `17:03:00.010 [StateMachine]: Player SomeGamer99 (dpnid 1858954623 uid 75E109C86EABE1E14F7ACE47F2C9BF11757ACE0C) Entering DBGetLoginTimeLoginState`,
].join("\n");

describe("parseDevices", () => {
  it("reads a desktop player's uid, gamertag and device", () => {
    expect(parseDevices(DESKTOP)).toEqual([
      { dayzId: "A9DDCCFAF1B79A6ADE0757193F49647B10A60913", gamertag: "xARESx7256", device: "desktop" },
    ]);
  });

  it("reads a console player the same way", () => {
    expect(parseDevices(CONSOLE)).toEqual([
      { dayzId: "75E109C86EABE1E14F7ACE47F2C9BF11757ACE0C", gamertag: "SomeGamer99", device: "console" },
    ]);
  });

  /**
   * ⚠️ The device line is written BEFORE the uid is known. A parser that
   * reads the uid off the nearest StateMachine line above it gets "".
   */
  it("resolves the uid from the LATER StateMachine line, never the empty one above", () => {
    const [only] = parseDevices(DESKTOP);
    expect(only!.dayzId).toBe("A9DDCCFAF1B79A6ADE0757193F49647B10A60913");
  });

  /**
   * ⚠️ Four of these exist in the retained logs: the player's login began in
   * the previous file, so this one has a device line and no StateMachine
   * line to resolve it. Not knowing a device must never become a ban.
   */
  it("drops a device line whose dpnid never resolves to a uid", () => {
    const straddling = `17:02:59.532  LOGINQUEUE   : Player 999999 updated with device type 'desktop'`;
    expect(parseDevices(straddling)).toEqual([]);
  });

  it("returns one sighting per player, not one per device line", () => {
    const twice = DESKTOP + "\n" + `17:05:00.000  LOGINQUEUE   : Player 1739924331 updated with device type 'desktop'`;
    expect(parseDevices(twice)).toHaveLength(1);
  });

  /** ⚠️ An unrecognised device must read as "not PC", so it is not emitted at all. */
  it("ignores a device string that is neither console nor desktop", () => {
    const odd = [
      `17:02:57.100 [StateMachine]: Player Future1 (dpnid 4242 uid ) Entering AuthPlayerLoginState`,
      `17:02:59.532  LOGINQUEUE   : Player 4242 updated with device type 'hologram'`,
      `17:03:00.010 [StateMachine]: Player Future1 (dpnid 4242 uid AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA) Entering DBGetLoginTimeLoginState`,
    ].join("\n");
    expect(parseDevices(odd)).toEqual([]);
  });

  it("handles a gamertag containing spaces", () => {
    const spaced = [
      `17:02:57.100 [StateMachine]: Player Sir Alatorre (dpnid 77 uid ) Entering AuthPlayerLoginState`,
      `17:02:59.532  LOGINQUEUE   : Player 77 updated with device type 'desktop'`,
      `17:03:00.010 [StateMachine]: Player Sir Alatorre (dpnid 77 uid FA15BCA9C4CC97F352B03D710B0A6AC48907909E) Entering DBGetLoginTimeLoginState`,
    ].join("\n");
    expect(parseDevices(spaced)).toEqual([
      { dayzId: "FA15BCA9C4CC97F352B03D710B0A6AC48907909E", gamertag: "Sir Alatorre", device: "desktop" },
    ]);
  });

  it("returns nothing for an RPT with no login activity", () => {
    expect(parseDevices("17:02:15.199 SCRIPT : Module: GameLib; loaded 13x files")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd packages/adm-parser && npx vitest run test/device.test.ts
```

Expected: every test fails — `Cannot find module '../src/device.js'`.

- [ ] **Step 3: Write the parser**

Create `packages/adm-parser/src/device.ts`:

```ts
/**
 * The player's platform, from the server's .RPT file.
 *
 * ⚠️ This is the ONLY place the device type appears. It is not in the .ADM
 * files this package otherwise parses, and there is no Nitrado API for it.
 *
 * ⚠️ The device line names a `dpnid` (a per-session network id), NOT the uid
 * we identify players by — and at the instant it is written the uid is still
 * EMPTY on the StateMachine lines above it, filled about two seconds later.
 * So the uid must be resolved through the dpnid across the WHOLE file, never
 * read from the nearest line above.
 */

export type DeviceSighting = { dayzId: string; gamertag: string; device: "console" | "desktop" };

/** `Player <gamertag> (dpnid <n> uid <40 hex>)` — the empty-uid form deliberately does not match. */
const STATE_RE = /\[StateMachine\]: Player (.+?) \(dpnid (\d+) uid ([0-9A-F]{40})\)/gu;
const DEVICE_RE = /LOGINQUEUE\s+: Player (\d+) updated with device type '(\w+)'/gu;

/** ⚠️ Anything not exactly one of these is not a device we act on. See the drop below. */
const KNOWN = new Set(["console", "desktop"]);

export function parseDevices(rpt: string): DeviceSighting[] {
  const byDpnid = new Map<string, { dayzId: string; gamertag: string }>();
  for (const m of rpt.matchAll(STATE_RE)) {
    byDpnid.set(m[2]!, { dayzId: m[3]!, gamertag: m[1]! });
  }

  const out = new Map<string, DeviceSighting>();
  for (const m of rpt.matchAll(DEVICE_RE)) {
    const device = m[2]!;
    // ⚠️ An unrecognised device string is dropped, not defaulted. A future
    // DayZ build naming a third platform must read as "not PC", never as PC.
    if (!KNOWN.has(device)) continue;
    const who = byDpnid.get(m[1]!);
    // ⚠️ Dropped, never guessed: the login began in the previous file, so this
    // file has no line binding the dpnid to a uid. Four of these exist in the
    // retained logs. Not knowing a device must never become a ban.
    if (!who) continue;
    out.set(`${who.dayzId}:${device}`, { ...who, device: device as "console" | "desktop" });
  }
  return [...out.values()];
}
```

- [ ] **Step 4: Run the tests — all pass**

```bash
cd packages/adm-parser && npx vitest run test/device.test.ts
```

Expected: 8 passed.

- [ ] **Step 5: Export it**

In `packages/adm-parser/src/index.ts`, add alongside the others:

```ts
export * from "./device.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/adm-parser
git commit -m "feat(adm-parser): read player device type from RPT files"
```

---

### Task 2: Schema — `player_devices` and `bans.reason`

**Files:**
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/domain/src/enforcement.ts`
- Create: `packages/db/migrations/0039_*.sql` (generated)

**Interfaces:**
- Consumes: nothing.
- Produces: `playerDevices` table export; `bans.reason` column; `BAN_REASONS` / `BanReason` from `@factions/domain`.

**Context you need.** The last migration is `0038_release_announcements.sql`, so this one is `0039`. Migrations are **generated**, never hand-written: `cd packages/db && npx drizzle-kit generate`. ⚠️ **Read the generated SQL before going further** — it is applied automatically to `factions_live` on the next release deploy.

- [ ] **Step 1: Add the ban reason to the domain**

In `packages/domain/src/enforcement.ts`, beside the existing `BAN_STATUSES`:

```ts
/**
 * Why a ban exists. ⚠️ Load-bearing: the PC-gate tick lifts a ban when the
 * player starts linking, and without this column it would also lift a ban
 * somebody earned by griefing inside another clan's base.
 */
export const BAN_REASONS = ["zone", "unlinked_pc"] as const;
export type BanReason = (typeof BAN_REASONS)[number];
```

- [ ] **Step 2: Add the column and the table**

In `packages/db/src/schema.ts`, add `reason` to the existing `bans` table definition, after `status`:

```ts
  /**
   * ⚠️ Defaults to `'zone'` so the rows that existed before the PC gate keep
   * their meaning. Only `unlinked_pc` rows are ever lifted by starting a link.
   */
  reason: text("reason").$type<BanReason>().notNull().default("zone"),
```

Import `BanReason` from `@factions/domain` alongside the existing `BanStatus` import.

Then add the new table (place it next to the other projection tables):

```ts
/**
 * Which platform an account plays on, learned from the server's .RPT files.
 *
 * ⚠️ Keyed on (dayz_id, device), NOT on dayz_id. An account seen on both
 * platforms gets two rows, so the rule can ask "has this account EVER been
 * seen on desktop?" A single last-write-wins column would let a PC player
 * clear the flag by playing one session on a console.
 *
 * ⚠️ Outside the lock order (spec §4.12): written by the ingest worker alone,
 * one statement, referencing nothing.
 *
 * ⚠️ NEVER backfill this from retained RPT files. It starts empty and fills
 * only as accounts connect, and that emptiness is the entire mechanism by
 * which this feature is forward-only — see the design doc §6.
 */
export const playerDevices = pgTable("player_devices", {
  dayzId: text("dayz_id").notNull(),
  device: text("device").notNull(),
  gamertag: text("gamertag").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.dayzId, t.device] }),
}));
```

`primaryKey` is already imported in this file; check the import list and add it only if missing.

- [ ] **Step 3: Generate the migration**

```bash
cd packages/db && npx drizzle-kit generate
```

Rename the generated file to `0039_player_devices.sql` **only if** drizzle's journal is updated to match; if unsure, leave the generated name alone.

- [ ] **Step 4: Read the SQL**

```bash
cat packages/db/migrations/0039_*.sql
```

Expected: a `CREATE TABLE player_devices` with a composite primary key, and an `ALTER TABLE bans ADD COLUMN reason text DEFAULT 'zone' NOT NULL`. ⚠️ If it contains any `DROP`, stop and report it — nothing in this task drops anything, and this migration reaches `factions_live` automatically.

- [ ] **Step 5: Typecheck and run the db suite**

```bash
cd /path/to/repo
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --filter=@factions/db --filter=@factions/domain --force
```

Expected: pass. If `factions_test_db` carries a stale schema, drop that one database by hand and re-run — **never touch `factions_live`**.

- [ ] **Step 6: Commit**

```bash
git add packages/db packages/domain
git commit -m "feat(db): player_devices table and bans.reason"
```

---

### Task 3: Nitrado — find the newest RPT

**Files:**
- Modify: `packages/nitrado/src/client.ts`
- Modify: `packages/nitrado/test/client.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `newestRptPath(): Promise<string | null>` on `NitradoClient`.

**Context you need.** `listAdmFiles()` in the same file already does the listing work: it resolves the gameserver path, lists `<base>config`, filters by extension, and parses the filename timestamp via the private `parseFilenameTs`. RPT files use the **same** name shape (`DayZServer_X1_x64_2026-09-17_17-02-10.RPT`). Read `listAdmFiles` before writing this. `downloadFile(path)` already exists and is what the caller will use next.

- [ ] **Step 1: Write the failing test**

Add to `packages/nitrado/test/client.test.ts`. The file already has `fakeFetch`,
`listing` and the `GS` fixture at the top; reuse all three rather than adding a
second harness:

```ts
describe("NitradoClient.newestRptPath", () => {
  const rptClient = (entries: unknown[]) =>
    new NitradoClient("t", 1, fakeFetch({
      "/file_server/list": listing(entries),
      "/gameservers": GS,
    }) as unknown as typeof fetch);

  it("returns the newest .RPT by filename timestamp, ignoring .ADM and .log", async () => {
    // ⚠️ Newest by FILENAME, not by modified_at: the biggest modified_at here
    // deliberately belongs to a file that is NOT the answer.
    const path = await rptClient([
      { name: "DayZServer_X1_x64_2026-09-17_19-01-52.RPT", path: "/p/19.RPT", modified_at: 2 },
      { name: "DayZServer_X1_x64_2026-09-17_15-02-05.RPT", path: "/p/15.RPT", modified_at: 1 },
      { name: "DayZServer_X1_x64_2026-09-17_19-01-52.ADM", path: "/p/19.ADM", modified_at: 9 },
      { name: "script_2026-09-17_19-01-56.log", path: "/p/s.log", modified_at: 9 },
    ]).newestRptPath();
    expect(path).toBe("/p/19.RPT");
  });

  it("returns null when the directory holds no RPT at all", async () => {
    expect(await rptClient([{ name: "x.ADM", path: "/p/x.ADM", modified_at: 1 }]).newestRptPath()).toBeNull();
  });

  it("ignores an RPT whose filename carries no parseable timestamp", async () => {
    expect(await rptClient([{ name: "crash.RPT", path: "/p/crash.RPT", modified_at: 5 }]).newestRptPath()).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd packages/nitrado && npx vitest run test/client.test.ts -t newestRptPath
```

Expected: FAIL — `newestRptPath is not a function`.

- [ ] **Step 3: Implement it**

In `packages/nitrado/src/client.ts`, beside `listAdmFiles`:

```ts
  /**
   * The path of the newest .RPT file, or null when there is none.
   *
   * ⚠️ Newest by FILENAME timestamp, like `listAdmFiles`, not by Nitrado's
   * `modified_at`: that is the game server's clock, fixed UTC+4/+7, and
   * comparing it to anything of ours reads as permanent drift.
   *
   * Only the newest is ever wanted. A device is a stable fact about an
   * account, learned once — see the design doc §2 for why this is not a
   * second ingest pipeline.
   */
  async newestRptPath(): Promise<string | null> {
    const gs = await this.getJson(`/services/${this.serviceId}/gameservers`);
    const base = gs?.data?.gameserver?.game_specific?.path;
    if (!base) throw new Error("Nitrado: could not resolve gameserver path");

    const listing = await this.getJson(
      `/services/${this.serviceId}/gameservers/file_server/list?dir=${encodeURIComponent(base + "config")}`,
    );
    const entries: any[] = listing?.data?.entries ?? [];
    let best: { path: string; ts: number } | null = null;
    for (const e of entries) {
      if (!(typeof e.name === "string" && e.name.endsWith(".RPT") && e.path)) continue;
      const ts = this.parseFilenameTs(e.name);
      if (ts === null) continue;
      if (!best || ts > best.ts) best = { path: e.path as string, ts };
    }
    return best?.path ?? null;
  }
```

- [ ] **Step 4: Run the tests**

```bash
cd packages/nitrado && npx vitest run test/client.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/nitrado
git commit -m "feat(nitrado): newestRptPath"
```

---

### Task 4: The worker learns devices on demand

**Files:**
- Create: `apps/ingest-worker/src/device-tick.ts`
- Create: `apps/ingest-worker/test/device-tick.test.ts`
- Modify: `apps/ingest-worker/src/sweep.ts`
- Modify: `packages/domain/src/rules.ts`

**Interfaces:**
- Consumes: `parseDevices` (Task 1), `playerDevices` (Task 2), `newestRptPath` (Task 3).
- Produces: `deviceTick(db, opts): Promise<DeviceTickResult>` where
  `opts = { serverId: number; client: DeviceClient; now?: Date }`,
  `DeviceClient = { newestRptPath(): Promise<string | null>; downloadFile(path: string): Promise<string> }`,
  `DeviceTickResult = { fetched: boolean; upserted: number }`.

**Context you need.** `ingestSweep` in `sweep.ts` runs one block per concern per server, each in **its own try/catch**, with an optional `deps.<concern>` object so tests that only exercise ingestion don't have to stub it. Read the `supplies` block and copy that shape exactly.

⚠️ **This tick must never be the reason a ban happens on bad data.** Its only job is to record what the RPT says. If anything fails, it records nothing, and nothing downstream bans.

- [ ] **Step 1: Add the lookback constant**

In `packages/domain/src/rules.ts`:

```ts
/**
 * How far back the device lookup looks for connections from accounts whose
 * platform we do not know yet.
 *
 * ⚠️ Bounded on purpose. Without a window, an account whose device can never
 * be resolved (its login straddled a restart and the file has since rotated)
 * would make the worker re-download the live RPT every single sweep, forever.
 * Giving up is safe: the player is caught the next time they connect.
 */
export const DEVICE_LOOKUP_LOOKBACK_MS = 30 * 60 * 1000;
```

- [ ] **Step 2: Write the failing test**

Create `apps/ingest-worker/test/device-tick.test.ts`. Follow the database setup used by the other worker suites (read `apps/ingest-worker/test/sweep.test.ts` for how it builds `db` and seeds a server):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, playerDevices, events, admFiles, servers, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { deviceTick } from "../src/device-tick.js";

const URL = requireTestDatabaseUrl();

const RPT = [
  `17:03:01.672 [StateMachine]: Player PCGuy (dpnid 111 uid AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA) Entering AuthPlayerLoginState`,
  `17:03:03.313  LOGINQUEUE   : Player 111 updated with device type 'desktop'`,
  `17:03:04.000 [StateMachine]: Player BoxGuy (dpnid 222 uid BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB) Entering AuthPlayerLoginState`,
  `17:03:05.000  LOGINQUEUE   : Player 222 updated with device type 'console'`,
].join("\n");

describe("deviceTick", () => {
  let db: Database;
  let admFileId: number;
  const now = new Date("2026-09-18T12:00:00Z");
  const client = (rpt = RPT, path: string | null = "/p/live.RPT") => ({
    newestRptPath: async () => path,
    downloadFile: async () => rpt,
  });

  /**
   * ⚠️ `events.adm_file_id` is NOT NULL and references `adm_files`, so a
   * connect cannot be seeded without a file row. `line_index` (not
   * `line_number`) plus `sub_index` form the idempotency key, so each seeded
   * event needs its own line index.
   */
  let line = 0;
  const connected = async (dayzId: string, at: Date) => {
    await db.insert(events).values({
      serverId: 1, admFileId: admFileId, lineIndex: line++, type: "player.connected",
      occurredAt: at, payload: { dayzId },
    } as never);
  };

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate player_devices, events, adm_files, servers restart identity cascade`);
    // `truncate ... restart identity` makes this the id-1 row every test assumes.
    await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 1, active: true });
    const [f] = await db.insert(admFiles)
      .values({ serverId: 1, filename: "t.ADM", bootAt: new Date("2026-09-18T00:00:00Z") })
      .returning();
    admFileId = f!.id;
    line = 0;
  });

  it("does nothing when every recently-connected account already has a device", async () => {
    await connected("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", new Date(now.getTime() - 60_000));
    await db.insert(playerDevices).values({ dayzId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", device: "desktop", gamertag: "PCGuy" });
    expect(await deviceTick(db, { serverId: 1, client: client(), now })).toEqual({ fetched: false, upserted: 0 });
  });

  it("does nothing when nobody has connected recently", async () => {
    await connected("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", new Date(now.getTime() - 60 * 60_000));
    expect(await deviceTick(db, { serverId: 1, client: client(), now })).toEqual({ fetched: false, upserted: 0 });
  });

  /** One fetch, every sighting in the file — the others would each cost another fetch later. */
  it("fetches once for an unknown account and records EVERY sighting in the file", async () => {
    await connected("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", new Date(now.getTime() - 60_000));
    const r = await deviceTick(db, { serverId: 1, client: client(), now });
    expect(r).toEqual({ fetched: true, upserted: 2 });
    const rows = await db.select().from(playerDevices);
    expect(rows.map((x) => [x.dayzId, x.device]).sort()).toEqual([
      ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "desktop"],
      ["BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", "console"],
    ]);
  });

  it("keeps first_seen_at and advances last_seen_at on a repeat sighting", async () => {
    await connected("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", new Date(now.getTime() - 60_000));
    await deviceTick(db, { serverId: 1, client: client(), now });
    const [before] = await db.select().from(playerDevices).where(sql`dayz_id = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'`);
    await db.execute(sql`delete from player_devices where dayz_id = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'`);
    const later = new Date(now.getTime() + 600_000);
    await connected("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", later);
    await deviceTick(db, { serverId: 1, client: client(), now: later });
    const [after] = await db.select().from(playerDevices).where(sql`dayz_id = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'`);
    expect(after!.firstSeenAt).toEqual(before!.firstSeenAt);
    expect(after!.lastSeenAt.getTime()).toBeGreaterThan(before!.lastSeenAt.getTime());
  });

  /** ⚠️ Fails closed: no RPT, no rows, no error. */
  it("records nothing when there is no RPT to read", async () => {
    await connected("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", new Date(now.getTime() - 60_000));
    expect(await deviceTick(db, { serverId: 1, client: client(RPT, null), now })).toEqual({ fetched: false, upserted: 0 });
    expect(await db.select().from(playerDevices)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx vitest run --root apps/ingest-worker test/device-tick.test.ts
```

Expected: FAIL — cannot find `../src/device-tick.js`.

- [ ] **Step 4: Write the tick**

Create `apps/ingest-worker/src/device-tick.ts`:

```ts
import type { Database } from "@factions/db";
import { playerDevices } from "@factions/db";
import { parseDevices } from "@factions/adm-parser";
import { DEVICE_LOOKUP_LOOKBACK_MS } from "@factions/domain";
import { sql } from "drizzle-orm";

/** Only what this tick calls. A full NitradoClient satisfies it. */
export type DeviceClient = {
  newestRptPath(): Promise<string | null>;
  downloadFile(path: string): Promise<string>;
};

export type DeviceTickResult = { fetched: boolean; upserted: number };

/**
 * Learns which platform an account plays on, ON DEMAND.
 *
 * ⚠️ The device only exists in the .RPT files, which are 20x the size of the
 * .ADM files this worker ingests (2.3 MB against ~100 KB) and are rewritten
 * continuously. Downloading them on the ADM schedule would pull about a
 * gigabyte a day from Nitrado to discover, on a busy day, one player's
 * platform. A device is a stable fact about an account, so it is learned once:
 * this tick fetches ONLY when some account that connected recently has no
 * `player_devices` row at all, and then records every sighting in the file it
 * already has in hand.
 *
 * ⚠️ Fails closed, always. No RPT, an unresolvable dpnid, an unknown device
 * string — every one of them records nothing. Downstream, "no row" means "not
 * PC", so a failure here can never produce a ban.
 */
export async function deviceTick(db: Database, opts: { serverId: number; client: DeviceClient; now?: Date }): Promise<DeviceTickResult> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - DEVICE_LOOKUP_LOOKBACK_MS);

  // Does ANY recently-connected account still have an unknown device? One row
  // is enough to justify the fetch, and the fetch answers it for everyone.
  const unknown = await db.execute(sql`
    select 1
    from events e
    where e.server_id = ${opts.serverId}
      and e.type = 'player.connected'
      and e.occurred_at > ${cutoff}
      and not exists (
        select 1 from player_devices d where d.dayz_id = e.payload->>'dayzId'
      )
    limit 1`);
  if (unknown.length === 0) return { fetched: false, upserted: 0 };

  const path = await opts.client.newestRptPath();
  if (!path) return { fetched: false, upserted: 0 };

  const sightings = parseDevices(await opts.client.downloadFile(path));
  if (sightings.length === 0) return { fetched: true, upserted: 0 };

  await db.insert(playerDevices)
    .values(sightings.map((s) => ({ dayzId: s.dayzId, device: s.device, gamertag: s.gamertag, firstSeenAt: now, lastSeenAt: now })))
    // ⚠️ first_seen_at is deliberately NOT in the update set: it is the one
    // fact here that must not move, and it is what tells an operator how long
    // an account has been playing on PC.
    .onConflictDoUpdate({
      target: [playerDevices.dayzId, playerDevices.device],
      set: { gamertag: sql`excluded.gamertag`, lastSeenAt: now },
    });

  return { fetched: true, upserted: sightings.length };
}
```

- [ ] **Step 5: Run the tests — all pass**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx vitest run --root apps/ingest-worker test/device-tick.test.ts
```

Expected: 5 passed.

- [ ] **Step 6: Wire it into the sweep**

In `apps/ingest-worker/src/sweep.ts`, add to `SweepDeps` beside `hostnames`:

```ts
  /**
   * Learns players' platforms from the RPT files. Absent in tests that only
   * exercise ingestion.
   */
  devices?: { clientFor: (nitradoServiceId: number) => DeviceClient };
  onDeviceError?: (serverId: number, err: unknown) => void;
```

and, inside the per-server loop after the supplies block, in **its own try/catch**:

```ts
    // ⚠️ Its own try/catch, like every other concern here: a Nitrado outage
    // must cost us at most the platform of a player we will see again anyway.
    if (deps.devices) {
      try {
        await deviceTick(db, { serverId: s.id, client: deps.devices.clientFor(s.nitradoServiceId!), now: new Date() });
      } catch (err) {
        deps.onDeviceError?.(s.id, err);
      }
    }
```

Import `deviceTick` and `type DeviceClient` from `./device-tick.js`.

- [ ] **Step 7: Wire it in `main.ts`**

Find where `hostnames` is passed to `ingestSweep` in `apps/ingest-worker/src/main.ts` and add, using the same client factory:

```ts
    devices: { clientFor },
    onDeviceError: (serverId, err) => console.error(`device lookup failed for server ${serverId}:`, err),
```

- [ ] **Step 8: Run the worker suite**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx vitest run --root apps/ingest-worker
```

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add apps/ingest-worker packages/domain
git commit -m "feat(ingest): learn player device on demand from the newest RPT"
```

---

### Task 5: The predicate

**Files:**
- Create: `packages/domain/src/pc-gate.ts`
- Create: `packages/domain/test/pc-gate.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export type PcGateFacts = {
  seenOnDesktop: boolean;
  linked: boolean;
  challengeOpen: boolean;
  activeBan: boolean;
  liftSpent: boolean;
};
export type PcGateAction = "none" | "ban" | "lift";
export function pcGateAction(f: PcGateFacts): PcGateAction;
```

**Context you need.** `packages/domain` is pure — no database, no I/O. Read `packages/domain/src/enforcement.ts` for the house style. The tick (Task 6) gathers the five facts and does what this says.

- [ ] **Step 1: Write the failing test**

Create `packages/domain/test/pc-gate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { pcGateAction, type PcGateFacts } from "../src/pc-gate";

const facts = (over: Partial<PcGateFacts> = {}): PcGateFacts => ({
  seenOnDesktop: true, linked: false, challengeOpen: false, activeBan: false, liftSpent: false, ...over,
});

describe("pcGateAction", () => {
  it("bans an unlinked desktop player who is not mid-link", () => {
    expect(pcGateAction(facts())).toBe("ban");
  });

  it("does nothing to a console player, whatever else is true", () => {
    expect(pcGateAction(facts({ seenOnDesktop: false }))).toBe("none");
    expect(pcGateAction(facts({ seenOnDesktop: false, linked: false, activeBan: true }))).toBe("none");
  });

  it("does nothing to a linked desktop player", () => {
    expect(pcGateAction(facts({ linked: true }))).toBe("none");
  });

  it("does not ban someone mid-link", () => {
    expect(pcGateAction(facts({ challengeOpen: true }))).toBe("none");
  });

  it("lifts for a banned player who has started linking", () => {
    expect(pcGateAction(facts({ challengeOpen: true, activeBan: true }))).toBe("lift");
  });

  /** ⚠️ The abuse vector: start a link, get unbanned, never finish, repeat forever. */
  it("refuses a second lift, for all time", () => {
    expect(pcGateAction(facts({ challengeOpen: true, activeBan: true, liftSpent: true }))).toBe("none");
  });

  it("does not ban twice while a ban is already active", () => {
    expect(pcGateAction(facts({ activeBan: true }))).toBe("none");
  });

  it("re-bans after a challenge lapsed and the lift was spent", () => {
    expect(pcGateAction(facts({ liftSpent: true }))).toBe("ban");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd packages/domain && npx vitest run test/pc-gate.test.ts
```

Expected: FAIL — cannot find `../src/pc-gate`.

- [ ] **Step 3: Write it**

Create `packages/domain/src/pc-gate.ts`:

```ts
/**
 * Whether an account should be banned for playing on PC without linking.
 *
 * This server is for Xbox. A PC player is welcome if we know who they are;
 * the ban is what makes linking non-optional for them.
 *
 * ⚠️ Level-triggered. Every pass recomputes what should be true from the five
 * facts, exactly like the truck wipe and the raid window, so a ban that was
 * never written, or a lift lost on its way to the database, is repaired on the
 * next tick rather than leaving someone banned forever with nothing to show
 * why.
 */
export type PcGateFacts = {
  /** ⚠️ EVER seen on desktop, not "last seen on". One console session must not clear it. */
  seenOnDesktop: boolean;
  linked: boolean;
  /** A verification challenge that is live right now: not completed, not canceled, not expired. */
  challengeOpen: boolean;
  /** A ban with reason `unlinked_pc` that is pending, applied, or already being lifted. */
  activeBan: boolean;
  /** ⚠️ This account has had its one lift, ever. See the design doc §4. */
  liftSpent: boolean;
};

export type PcGateAction = "none" | "ban" | "lift";

export function pcGateAction(f: PcGateFacts): PcGateAction {
  // Not a PC player, or a known one: nothing here applies.
  if (!f.seenOnDesktop || f.linked) return "none";

  if (f.challengeOpen) {
    // ⚠️ Starting a link opens the door ONCE. Without liftSpent this is an
    // infinite supply of play time: link, get unbanned, never finish, repeat.
    return f.activeBan && !f.liftSpent ? "lift" : "none";
  }

  return f.activeBan ? "none" : "ban";
}
```

- [ ] **Step 4: Run the tests — all pass**

```bash
cd packages/domain && npx vitest run test/pc-gate.test.ts
```

Expected: 8 passed.

- [ ] **Step 5: Mutation-check lift-once**

Temporarily change `!f.liftSpent` to `true` and re-run. Expected: the "refuses a second lift" test FAILS. Restore the line and re-run; all 8 pass again. ⚠️ Do not skip this: "once" is exactly the kind of rule a test can assert while never actually exercising it.

- [ ] **Step 6: Export and commit**

Add to `packages/domain/src/index.ts`:

```ts
export * from "./pc-gate";
```

```bash
git add packages/domain
git commit -m "feat(domain): the unlinked-PC gate predicate"
```

---

### Task 6: The bot tick

**Files:**
- Create: `apps/bot/src/pc-ban-tick.ts`
- Create: `apps/bot/test/pc-ban-tick.test.ts`

**Interfaces:**
- Consumes: `pcGateAction` (Task 5), `playerDevices` and `bans.reason` (Task 2).
- Produces: `pcBanTick(db, opts): Promise<PcBanTickResult>` where
  `opts = { serverId: number; now?: Date }` and
  `PcBanTickResult = { banned: { dayzId: string; gamertag: string }[]; lifted: { dayzId: string; gamertag: string }[] }`.

**Context you need.** This tick **never calls Nitrado**. It only writes `bans` rows; the existing `banTick` picks them up and applies them, with its reference counting intact. Read `apps/bot/src/violation-tick.ts` for the shape of a tick that queries and writes, and `apps/bot/test/release-store.test.ts` for how a bot suite gets a real database.

- [ ] **Step 1: Write the failing test**

Create `apps/bot/test/pc-ban-tick.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, playerDevices, identityLinks, verificationChallenges, bans, servers, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { pcBanTick } from "../src/pc-ban-tick.js";

const URL = requireTestDatabaseUrl();
const PC = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BOX = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("pcBanTick", () => {
  let db: Database;
  const now = new Date("2026-09-18T12:00:00Z");

  const desktop = (dayzId = PC, gamertag = "PCGuy") =>
    db.insert(playerDevices).values({ dayzId, device: "desktop", gamertag });
  const challenge = (dayzId: string, expiresAt: Date) =>
    db.insert(verificationChallenges).values({
      discordId: "d1", sequence: ["a", "b", "c"], issuedAt: now, expiresAt, targetDayzId: dayzId,
    } as never);

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate player_devices, identity_links, verification_challenges, bans, servers restart identity cascade`);
    // Same shape as apps/bot/test/ban-tick.test.ts; `restart identity` makes it id 1.
    await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 1, active: true });
  });

  it("bans an unlinked desktop player", async () => {
    await desktop();
    const r = await pcBanTick(db, { serverId: 1, now });
    expect(r.banned.map((b) => b.dayzId)).toEqual([PC]);
    const [row] = await db.select().from(bans);
    expect(row!.reason).toBe("unlinked_pc");
    expect(row!.status).toBe("pending");
    expect(row!.expiresAt).toBeNull();   // ⚠️ permanent: a door, not a sentence
    expect(row!.gamertag).toBe("PCGuy");
  });

  it("leaves a console player alone", async () => {
    await db.insert(playerDevices).values({ dayzId: BOX, device: "console", gamertag: "BoxGuy" });
    expect((await pcBanTick(db, { serverId: 1, now })).banned).toEqual([]);
    expect(await db.select().from(bans)).toEqual([]);
  });

  it("leaves a linked desktop player alone", async () => {
    await desktop();
    await db.insert(identityLinks).values({ discordId: "d9", dayzId: PC, gamertag: "PCGuy", verifiedAt: now });
    expect((await pcBanTick(db, { serverId: 1, now })).banned).toEqual([]);
  });

  it("does not ban someone with a live challenge", async () => {
    await desktop();
    await challenge(PC, new Date(now.getTime() + 3600_000));
    expect((await pcBanTick(db, { serverId: 1, now })).banned).toEqual([]);
  });

  it("bans once the challenge has expired", async () => {
    await desktop();
    await challenge(PC, new Date(now.getTime() - 1000));
    expect((await pcBanTick(db, { serverId: 1, now })).banned.map((b) => b.dayzId)).toEqual([PC]);
  });

  it("does not write a second ban while one is active", async () => {
    await desktop();
    await pcBanTick(db, { serverId: 1, now });
    await pcBanTick(db, { serverId: 1, now });
    expect(await db.select().from(bans)).toHaveLength(1);
  });

  it("marks an applied ban lift_pending when the player starts linking", async () => {
    await desktop();
    await pcBanTick(db, { serverId: 1, now });
    await db.update(bans).set({ status: "applied" });
    await challenge(PC, new Date(now.getTime() + 3600_000));
    const r = await pcBanTick(db, { serverId: 1, now });
    expect(r.lifted.map((b) => b.dayzId)).toEqual([PC]);
    const [row] = await db.select().from(bans);
    expect(row!.status).toBe("lift_pending");
  });

  /** ⚠️ The abuse vector. Second time around, the door stays shut. */
  it("refuses a second lift, ever", async () => {
    await desktop();
    await pcBanTick(db, { serverId: 1, now });
    await db.update(bans).set({ status: "lifted" });
    const later = new Date(now.getTime() + 86_400_000);
    await challenge(PC, new Date(later.getTime() + 3600_000));
    // Their lapsed challenge already earned them a fresh ban row.
    await db.insert(bans).values({
      serverId: 1, dayzId: PC, gamertag: "PCGuy", bannedAt: later, status: "applied", reason: "unlinked_pc",
    } as never);
    expect((await pcBanTick(db, { serverId: 1, now: later })).lifted).toEqual([]);
  });

  /** ⚠️ A zone ban is not a PC ban and must never be lifted by starting a link. */
  it("never lifts a zone ban", async () => {
    await desktop();
    await db.insert(bans).values({
      serverId: 1, dayzId: PC, gamertag: "PCGuy", bannedAt: now, status: "applied", reason: "zone",
    } as never);
    await challenge(PC, new Date(now.getTime() + 3600_000));
    const r = await pcBanTick(db, { serverId: 1, now });
    expect(r.lifted).toEqual([]);
    const [row] = await db.select().from(bans).where(eq(bans.reason, "zone"));
    expect(row!.status).toBe("applied");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx vitest run --root apps/bot test/pc-ban-tick.test.ts
```

Expected: FAIL — cannot find `../src/pc-ban-tick.js`.

- [ ] **Step 3: Write the tick**

Create `apps/bot/src/pc-ban-tick.ts`:

```ts
import type { Database } from "@factions/db";
import { bans, identityLinks, playerDevices, verificationChallenges } from "@factions/db";
import { pcGateAction } from "@factions/domain";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";

export type PcBanTickResult = {
  banned: { dayzId: string; gamertag: string }[];
  lifted: { dayzId: string; gamertag: string }[];
};

/** Ban statuses that mean "this ban is in force or on its way out" — not a reason to write another. */
const ACTIVE = ["pending", "applied", "lift_pending"] as const;

/**
 * Bans PC players who have not linked, and opens the door once when they
 * start to.
 *
 * ⚠️ This tick NEVER calls Nitrado. It writes `bans` rows and lift requests;
 * `banTick` is the only thing that talks to the ban list, and its reference
 * counting is what stops a PC ban freeing an account that also has a zone ban.
 *
 * ⚠️ Level-triggered, like the truck wipe and the raid window: every pass
 * recomputes what should be true rather than reacting to an edge. That is
 * what makes a lost lift self-heal, and it is why an expired challenge needs
 * no code of its own to produce a fresh ban.
 *
 * ⚠️ Candidates come from `player_devices`, which fills ONLY as accounts
 * connect. Backfilling that table from retained RPT files turns this into a
 * retroactive sweep over everyone ever seen — see the design doc §6.
 */
export async function pcBanTick(db: Database, opts: { serverId: number; now?: Date }): Promise<PcBanTickResult> {
  const now = opts.now ?? new Date();
  const out: PcBanTickResult = { banned: [], lifted: [] };

  // Everyone ever seen on desktop. Small by nature — 7 accounts in the first
  // three days of retained logs — and it only grows as PC players arrive.
  const candidates = await db.select({ dayzId: playerDevices.dayzId, gamertag: playerDevices.gamertag })
    .from(playerDevices).where(eq(playerDevices.device, "desktop"));

  for (const c of candidates) {
    const [link] = await db.select({ id: identityLinks.id }).from(identityLinks).where(eq(identityLinks.dayzId, c.dayzId));

    const [open] = await db.select({ id: verificationChallenges.id }).from(verificationChallenges).where(and(
      eq(verificationChallenges.targetDayzId, c.dayzId),
      isNull(verificationChallenges.completedAt),
      isNull(verificationChallenges.canceledAt),
      gt(verificationChallenges.expiresAt, now),
    ));

    const mine = await db.select({ id: bans.id, status: bans.status }).from(bans).where(and(
      eq(bans.serverId, opts.serverId),
      eq(bans.dayzId, c.dayzId),
      eq(bans.reason, "unlinked_pc"),
    ));

    const active = mine.find((b) => (ACTIVE as readonly string[]).includes(b.status));
    // ⚠️ "Has had its lift" is derived from the ban history, not a column: any
    // row that ever reached lift_pending or lifted spent this account's one
    // chance, for all time.
    const liftSpent = mine.some((b) => b.status === "lift_pending" || b.status === "lifted");

    const action = pcGateAction({
      seenOnDesktop: true,
      linked: Boolean(link),
      challengeOpen: Boolean(open),
      activeBan: Boolean(active),
      liftSpent,
    });

    if (action === "ban") {
      await db.insert(bans).values({
        serverId: opts.serverId,
        dayzId: c.dayzId,
        gamertag: c.gamertag,
        bannedAt: now,
        // ⚠️ Permanent. This is not a sentence to serve; it is a door that
        // opens when they link.
        expiresAt: null,
        status: "pending",
        reason: "unlinked_pc",
      });
      out.banned.push(c);
    } else if (action === "lift" && active) {
      await db.update(bans).set({ status: "lift_pending" }).where(eq(bans.id, active.id));
      out.lifted.push(c);
    }
  }

  return out;
}
```

- [ ] **Step 4: Run the tests — all pass**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx vitest run --root apps/bot test/pc-ban-tick.test.ts
```

Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/pc-ban-tick.ts apps/bot/test/pc-ban-tick.test.ts
git commit -m "feat(bot): the unlinked-PC ban tick"
```

---

### Task 7: The gate and the wiring

**Files:**
- Modify: `apps/bot/src/config.ts`
- Modify: `apps/bot/src/discord.ts`

**Interfaces:**
- Consumes: `pcBanTick` (Task 6).
- Produces: `cfg.unlinkedPcBan: boolean`.

**Context you need.** Read `apps/bot/src/config.ts` around `enforcementTick` — the house pattern accepts `"1"` and `"true"` and nothing else, precisely because `ENFORCEMENT_TICK=true` once silently left a tick off. In `discord.ts`, `banTick` runs in the 5-minute block beside `reaperTick` (around line 1016), not in the every-tick block; `pcBanTick` writes rows that `banTick` then applies, so it must run **before** `banTick` in the same block.

- [ ] **Step 1: Add the gate**

In `apps/bot/src/config.ts`, beside `enforcementTick` in the type:

```ts
  /**
   * ⚠️ Independent of `banDryRun` on purpose. In production BAN_DRY_RUN is
   * already false, so the first PC ban is REAL the moment this is set. That
   * is a deliberate act on a chosen day, never a side effect of a deploy.
   */
  unlinkedPcBan: boolean;
```

and in the loader beside the `enforcementTick` line:

```ts
    unlinkedPcBan: ["1", "true"].includes((env.UNLINKED_PC_BAN ?? "").toLowerCase()),
```

Then, beside the existing `enforcementTick` validation:

```ts
  if (config.unlinkedPcBan && !config.enforcementTick) {
    throw new Error("UNLINKED_PC_BAN is on but ENFORCEMENT_TICK is off — ban rows would be written and never applied.");
  }
```

- [ ] **Step 2: Run the config tests**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx vitest run --root apps/bot test/config.test.ts
```

Expected: pass. If that file asserts an exact set of config keys, add `unlinkedPcBan` to it.

- [ ] **Step 3: Run the tick in `discord.ts`**

Import it:

```ts
import { pcBanTick } from "./pc-ban-tick.js";
```

In the 5-minute block, immediately **before** the `if (cfg.enforcementTick)` block
that calls `banTick` (around line 1029). `opsChannelPoster` is already built at
line 516 as `cfg.opsChannelId ? createChannelPoster(client, cfg.opsChannelId) : null`,
and line 1299 shows the house fallback for a poster that may be null:

```ts
      // ⚠️ Before banTick, in the same block: this writes the rows banTick
      // applies, so running it afterwards would delay every PC ban by a
      // whole five-minute cycle.
      if (cfg.unlinkedPcBan) {
        // Same fallback shape as the raid-window poster at line 1299: with no
        // OPS_CHANNEL_ID a ban still happens, and must still be visible
        // somewhere, so it goes to the log at error level.
        const ops = opsChannelPoster ?? (async (content: string) => { console.error(content); });
        try {
          const pcServers = await db.select({ id: servers.id })
            .from(servers).where(and(eq(servers.active, true), isNotNull(servers.nitradoServiceId)));
          for (const s of pcServers) {
            try {
              const r = await pcBanTick(db, { serverId: s.id, now: new Date() });
              for (const b of r.banned) {
                await ops(`🚫 PC ban queued: **${b.gamertag}** (\`${b.dayzId}\`) plays on PC and has not linked.`);
              }
              for (const b of r.lifted) {
                await ops(`🔓 PC ban lifting: **${b.gamertag}** (\`${b.dayzId}\`) has started linking — this is their one lift.`);
              }
            } catch (err) {
              console.error(`pc ban tick failed for server ${s.id}`, err);
            }
          }
        } catch (err) {
          console.error("pc ban tick: could not list servers", err);
        }
      }
```

⚠️ `servers`, `and`, `eq` and `isNotNull` are already imported in this file for
the `banTick` block directly below — do not add duplicate imports.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit -p apps/bot
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/config.ts apps/bot/src/discord.ts
git commit -m "feat(bot): gate and wire the unlinked-PC ban tick"
```

---

### Task 8: Documentation

**Files:**
- Create: `docs/deploy/2026-09-18-unlinked-pc-ban.md`
- Modify: `CLAUDE.md`, `apps/bot/README.md`, `CHANGELOG.md`

- [ ] **Step 1: Write the runbook**

Create `docs/deploy/2026-09-18-unlinked-pc-ban.md` covering, in this order:

1. **What ships off.** `UNLINKED_PC_BAN` absent means the tick never runs. The worker still learns devices — that is deliberate, so that when you do enable it the table is already warm and the first tick is not a surprise.
2. **⚠️ There is no dry-run net.** Production runs `BAN_DRY_RUN=false`. The first PC ban is real the moment the gate is set.
3. **How to see who would be banned before enabling:**

```sql
select d.gamertag, d.dayz_id, d.first_seen_at,
       (l.dayz_id is not null) as linked
from player_devices d
left join identity_links l on l.dayz_id = d.dayz_id
where d.device = 'desktop'
order by linked, d.first_seen_at;
```

Every row with `linked = f` is a ban the moment you set the gate.

4. **Enabling:** add `UNLINKED_PC_BAN=1` to `/opt/clan-wars/.env`, `sudo systemctl restart clan-wars-bot`, and watch `OPS_CHANNEL_ID`.
5. **Lifting a ban by hand** (someone caught wrongly), and the fact that a hand-lift spends nothing — only `lift_pending`/`lifted` rows spend the one automatic lift.
6. **⚠️ Never backfill `player_devices`.** State the consequence: it converts forward-only into a retroactive sweep over everyone in retained logs.
7. **Turning it off:** unset the gate and restart. ⚠️ Already-applied bans stay applied — the gate stops new rows, it does not lift existing ones. Lift them deliberately with `update bans set status = 'lift_pending' where reason = 'unlinked_pc' and status = 'applied';`

- [ ] **Step 2: Update `CLAUDE.md`**

Add a row to the "Where things live" table:

```markdown
| Banning unlinked PC players | Device read from the server's `.RPT` by `parseDevices` (`packages/adm-parser/src/device.ts`), learned on demand by `apps/ingest-worker/src/device-tick.ts` into `player_devices`; the rule is `pcGateAction` (`packages/domain/src/pc-gate.ts`), the tick is `apps/bot/src/pc-ban-tick.ts`, gated on `UNLINKED_PC_BAN` (which refuses to run without `ENFORCEMENT_TICK`). ⚠️ `player_devices` must NEVER be backfilled from retained RPTs — its emptiness is what makes the feature forward-only. ⚠️ One lift per account ever, derived from ban history. Runbook `docs/deploy/2026-09-18-unlinked-pc-ban.md` |
```

Add `player_devices` to the lock-order paragraph's list of tables that sit **outside** the order, beside `release_announcements`.

- [ ] **Step 3: Update `apps/bot/README.md`**

Add `UNLINKED_PC_BAN` to the env table: optional, off unless `1`/`true`, requires `ENFORCEMENT_TICK`, and note that `BAN_DRY_RUN` governs whether the resulting ban reaches Nitrado.

- [ ] **Step 4: Add the changelog entry**

Under `## [Unreleased]` in `CHANGELOG.md`, in the player's voice:

```markdown
### Added

- This is an Xbox server, and playing it from a PC now requires a linked
  account. A PC player who has not linked is banned; starting a link lifts
  that ban once, so they can perform the three emotes linking asks for. Console
  players are unaffected, and so is any PC player who has already linked.
```

- [ ] **Step 5: Run the whole gate**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx turbo run typecheck test --concurrency=1 --force
```

Expected: **30/30 successful, 0 cached.** A cached pass proves nothing.

- [ ] **Step 6: Commit**

```bash
git add docs CLAUDE.md apps/bot/README.md CHANGELOG.md
git commit -m "docs: runbook and notes for the unlinked-PC ban"
```

---

## Notes for the executor

- **Do not enable the gate.** This plan ships the feature off. Setting `UNLINKED_PC_BAN` is the operator's deliberate act, described in the runbook.
- **Do not backfill `player_devices`**, in a migration, a script, or "just for testing" against `factions_live`.
- `packages/adm-parser` uses `.js` import extensions; `packages/domain` does not. Match the package you are in.
