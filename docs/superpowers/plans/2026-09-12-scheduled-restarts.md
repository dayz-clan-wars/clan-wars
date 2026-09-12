# Scheduled Restarts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The bot restarts every active game server through Nitrado at the top of every even UTC hour, recording one row per server per slot.

**Architecture:** A `restartTick` in the bot's existing 10 s loop computes the current two-hour slot (epoch-aligned, so even UTC hours), and if the slot is inside its ten-minute grace window and has no `server_restarts` row, checks the gameserver status and POSTs Nitrado's restart. The row is written after the POST and is the idempotency guard. `messages.xml` and Discord are untouched.

**Tech Stack:** TypeScript, vitest, drizzle-orm over postgres.js, the existing `@factions/nitrado` client, discord.js bot loop.

**Spec:** `docs/superpowers/specs/2026-09-12-scheduled-restarts-design.md`

## Global Constraints

- Comments explain WHY; `⚠️` marks lines whose failure is silent (CLAUDE.md house style). Match the density of the file you edit.
- Prefer a failing test over a defensive default. Two statements of one fact need a test that fails when they disagree.
- Numbers live in `packages/domain/src/rules.ts`, never as literals elsewhere.
- Packages `apps/web` transpiles (`domain`, `db`, `roster`, …) use extensionless relative imports in `src/`. `apps/bot` and `packages/nitrado` use `.js` suffixes — follow whichever the file you edit uses.
- Database suites need `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"` exported; each package derives its own `factions_test_<package>`.
- Nothing applies migrations in production; 0032 is applied by hand per the runbook.
- Commit after each task on branch `scheduled-restarts`; merge to `main` with `--no-ff` at the end. Commit messages end with the session's attribution lines.

---

### Task 1: The slot arithmetic in the domain package

**Files:**
- Modify: `packages/domain/src/rules.ts` (append after `WATCHTOWER_MAX_HEIGHT`)
- Create: `packages/domain/src/restarts.ts`
- Modify: `packages/domain/src/index.ts` (add `export * from "./restarts";`)
- Test: `packages/domain/test/restarts.test.ts`

**Interfaces:**
- Produces: `RESTART_PERIOD_MS: number` (2 h), `RESTART_GRACE_MS: number` (10 min), `restartSlot(now: Date): { start: Date; due: boolean; missedIfUnhandled: boolean }` — `start` is the newest slot boundary at or before `now`; `due` is `now < start + RESTART_GRACE_MS`; `missedIfUnhandled` is `!due` (the window has closed).

- [ ] **Step 1: Write the failing test**

`packages/domain/test/restarts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { RESTART_PERIOD_MS, RESTART_GRACE_MS, restartSlot } from "../src/restarts";

const at = (iso: string) => new Date(iso);

describe("restartSlot", () => {
  it("is two hours, ten minutes of grace", () => {
    expect(RESTART_PERIOD_MS).toBe(2 * 60 * 60_000);
    expect(RESTART_GRACE_MS).toBe(10 * 60_000);
  });
  it("⚠️ lands on EVEN UTC hours with no phase constant — the epoch is one", () => {
    expect(restartSlot(at("2026-09-12T14:00:00Z")).start).toEqual(at("2026-09-12T14:00:00Z"));
    expect(restartSlot(at("2026-09-12T15:59:59Z")).start).toEqual(at("2026-09-12T14:00:00Z"));
    expect(restartSlot(at("2026-09-12T13:59:59Z")).start).toEqual(at("2026-09-12T12:00:00Z"));
    expect(restartSlot(at("1970-01-01T00:00:00Z")).start).toEqual(at("1970-01-01T00:00:00Z"));
    // Every slot start of a day is an even hour.
    for (let h = 0; h < 24; h++) expect(restartSlot(at(`2026-03-29T${String(h).padStart(2, "0")}:30:00Z`)).start.getUTCHours() % 2).toBe(0);
  });
  it("is due only inside the grace window, and missed after it", () => {
    expect(restartSlot(at("2026-09-12T14:00:00Z"))).toMatchObject({ due: true, missedIfUnhandled: false });
    expect(restartSlot(at("2026-09-12T14:09:59Z"))).toMatchObject({ due: true, missedIfUnhandled: false });
    expect(restartSlot(at("2026-09-12T14:10:00Z"))).toMatchObject({ due: false, missedIfUnhandled: true });
    expect(restartSlot(at("2026-09-12T15:30:00Z"))).toMatchObject({ start: at("2026-09-12T14:00:00Z"), due: false, missedIfUnhandled: true });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/domain && npx vitest run test/restarts.test.ts`
Expected: FAIL — cannot resolve `../src/restarts`.

- [ ] **Step 3: Add the constants and the helper**

Append to `packages/domain/src/rules.ts`:

```ts
/**
 * Scheduled restarts (spec 2026-09-12): the bot restarts the server every
 * RESTART_PERIOD_MS, in slots aligned to the Unix epoch — which is itself an
 * even UTC hour, so there is no phase constant to get wrong. A slot the bot
 * did not fire within RESTART_GRACE_MS of its start is missed, not late: a
 * restart twenty minutes late kicks players who had no countdown.
 */
export const RESTART_PERIOD_MS = 2 * HOUR;
export const RESTART_GRACE_MS = 10 * MIN;
```

(`rules.ts` defines `MIN` and `HOUR` at its top.)

Create `packages/domain/src/restarts.ts`:

```ts
import { RESTART_PERIOD_MS, RESTART_GRACE_MS } from "./rules";
export { RESTART_PERIOD_MS, RESTART_GRACE_MS };

export type RestartSlot = {
  /** The newest slot boundary at or before `now` — an even UTC hour. */
  start: Date;
  /** Inside the grace window: a slot with no row yet should fire now. */
  due: boolean;
  /** Past the grace window: a slot with no row is missed, never fired late. */
  missedIfUnhandled: boolean;
};

/** ⚠️ Pure arithmetic on the epoch: no timezone, no DST, nothing to configure. */
export function restartSlot(now: Date): RestartSlot {
  const start = new Date(Math.floor(now.getTime() / RESTART_PERIOD_MS) * RESTART_PERIOD_MS);
  const due = now.getTime() < start.getTime() + RESTART_GRACE_MS;
  return { start, due, missedIfUnhandled: !due };
}
```

Add `export * from "./restarts";` to `packages/domain/src/index.ts`.

- [ ] **Step 4: Run the domain suite and typecheck**

Run: `cd packages/domain && npx tsc --noEmit && npx vitest run`
Expected: all pass, including the new file. (`guide-numbers` tests do not require every `rules.ts` constant to appear in the guide, so no guide row is needed.)

- [ ] **Step 5: Commit**

```bash
git checkout -b scheduled-restarts
git add packages/domain
git commit -m "feat(domain): restart slots — two-hour, epoch-aligned, ten minutes of grace"
```

---

### Task 2: `NitradoClient.status()` and `.restart()`

**Files:**
- Modify: `packages/nitrado/src/client.ts` (add two methods after `hostname()`)
- Test: `packages/nitrado/test/client.test.ts` (append)

**Interfaces:**
- Produces: `NitradoClient.status(): Promise<string>` — the gameserver's `status` field (`started`, `stopped`, `restarting`, …); `NitradoClient.restart(message: string): Promise<void>` — POSTs `/services/{id}/gameservers/restart` with `{ message, restart_message: message }`, throws on HTTP error or `status:"error"`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/nitrado/test/client.test.ts` (the file already has `fakeFetch` and `GS`):

```ts
describe("NitradoClient.status / restart", () => {
  it("reads the gameserver status", async () => {
    const fetchFn = fakeFetch({ "/gameservers": { status: "success", data: { gameserver: { status: "started" } } } });
    expect(await new NitradoClient("t", 1, fetchFn as unknown as typeof fetch).status()).toBe("started");
  });
  it("posts the restart with the message in both fields", async () => {
    const fetchFn = fakeFetch({ "/gameservers/restart": { status: "success", data: {} } });
    await new NitradoClient("t", 42, fetchFn as unknown as typeof fetch).restart("Scheduled restart");
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.nitrado.net/services/42/gameservers/restart");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ message: "Scheduled restart", restart_message: "Scheduled restart" });
  });
  it("⚠️ throws on Nitrado's HTTP-200 status:error, like every other call", async () => {
    const fetchFn = fakeFetch({ "/gameservers/restart": { status: "error", message: "Service is not running" } });
    await expect(new NitradoClient("t", 1, fetchFn as unknown as typeof fetch).restart("x")).rejects.toThrow(/status=error.*not running/u);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/nitrado && npx vitest run test/client.test.ts`
Expected: FAIL — `status is not a function`, `restart is not a function`.

- [ ] **Step 3: Implement**

In `packages/nitrado/src/client.ts`, after `hostname()`:

```ts
  /** The gameserver's lifecycle status as Nitrado reports it: `started`, `stopped`, `restarting`, `stopping`, … */
  async status(): Promise<string> {
    const gs = (await this.getJson(`/services/${this.serviceId}/gameservers`))?.data?.gameserver;
    return String(gs?.status ?? "unknown");
  }

  /**
   * Restart the game server. `message` goes to Nitrado's log and, where the
   * game supports it, to players; DayZ's own countdown comes from messages.xml
   * and is not this call's concern. Routed through postJson so the
   * HTTP-200-with-status:"error" guard applies.
   */
  async restart(message: string): Promise<void> {
    await this.postJson(`/services/${this.serviceId}/gameservers/restart`, { message, restart_message: message });
  }
```

- [ ] **Step 4: Run the package suite and typecheck**

Run: `cd packages/nitrado && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nitrado
git commit -m "feat(nitrado): status() and restart()"
```

---

### Task 3: The `server_restarts` table and migration 0032

**Files:**
- Modify: `packages/db/src/schema.ts` (append after `achievementUnlocks`/the last table)
- Create: `packages/db/migrations/0032_server_restarts.sql` and `meta/0032_snapshot.json`, journal entry (generated by drizzle-kit)
- Test: `packages/db/test/server-restarts-schema.test.ts`

**Interfaces:**
- Produces: `serverRestarts` drizzle table with columns `serverId: integer`, `scheduledFor: timestamptz`, `issuedAt: timestamptz`, `outcome: "restarted" | "skipped" | "missed"`, `detail: jsonb`; primary key `(server_id, scheduled_for)`.

- [ ] **Step 1: Write the failing test**

`packages/db/test/server-restarts-schema.test.ts` (the same setup shape as `packages/db/test/achievements-schema.test.ts`; note this package's tests import from `../src/index.js`):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { createClient, runMigrations, requireTestDatabaseUrl, serverRestarts, servers, type Database } from "../src/index.js";

const URL = requireTestDatabaseUrl();

describe("server_restarts", () => {
  let db: Database;
  beforeEach(async () => { db = createClient(URL); await runMigrations(db); await db.execute(sql`truncate table server_restarts`); });

  it("holds one row per server per slot — the primary key is the idempotency guard", async () => {
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    const slot = new Date("2026-09-12T14:00:00Z");
    await db.insert(serverRestarts).values({ serverId: s!.id, scheduledFor: slot, issuedAt: new Date(), outcome: "restarted" });
    await expect(db.insert(serverRestarts).values({ serverId: s!.id, scheduledFor: slot, issuedAt: new Date(), outcome: "skipped" })).rejects.toThrow(/server_restarts_pkey|duplicate key/u);
    const again = await db.insert(serverRestarts).values({ serverId: s!.id, scheduledFor: slot, issuedAt: new Date(), outcome: "skipped" }).onConflictDoNothing().returning();
    expect(again).toEqual([]);
  });
  it("refuses an outcome outside the three", async () => {
    const [s] = await db.insert(servers).values({ name: "S2", map: "livonia", clockOffsetMs: 0 }).returning();
    await expect(db.execute(sql`insert into server_restarts (server_id, scheduled_for, issued_at, outcome) values (${s!.id}, now(), now(), 'late')`)).rejects.toThrow(/server_restarts_outcome_valid/u);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/db && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/server-restarts-schema.test.ts`
Expected: FAIL — `serverRestarts` is not exported.

- [ ] **Step 3: Add the table to the schema**

Append to `packages/db/src/schema.ts` (imports `pgTable, integer, timestamp, text, jsonb, primaryKey, check, sql` already exist at the top):

```ts
/**
 * One row per server per two-hour restart slot (spec 2026-09-12 §5): the
 * bot's proof that the schedule ran, and its idempotency guard — a row for
 * (server, slot) means the slot is handled, whatever the outcome.
 *
 * ⚠️ Written by restart-tick.ts alone, in its own transaction, touching no
 * other table; it needs no place in the §4.12 lock order.
 */
export const serverRestarts = pgTable("server_restarts", {
  serverId: integer("server_id").notNull().references(() => servers.id),
  /** The slot start — an even UTC hour. */
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
  /** restarted = Nitrado accepted the POST; skipped = server was not `started`; missed = the grace window closed with nothing fired. */
  outcome: text("outcome").$type<"restarted" | "skipped" | "missed">().notNull(),
  detail: jsonb("detail").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
}, (t) => ({
  pk: primaryKey({ columns: [t.serverId, t.scheduledFor] }),
  outcomeValid: check("server_restarts_outcome_valid", sql`${t.outcome} IN ('restarted','skipped','missed')`),
}));
```

- [ ] **Step 4: Generate the migration and read it**

Run: `cd packages/db && npx drizzle-kit generate --name server_restarts`
Expected: `migrations/0032_server_restarts.sql` created, journal idx 32 appended. Open the SQL: it must contain only `CREATE TABLE IF NOT EXISTS "server_restarts"` with the primary key, the check, and one `ALTER TABLE … FOREIGN KEY` to `servers` — nothing else. If drizzle-kit emitted anything touching another table, stop: the schema drifted from 0031, and that has to be resolved before this goes on.

- [ ] **Step 5: Run the db suite**

Run: `cd packages/db && npx tsc --noEmit && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run`
Expected: PASS, the new test included.

- [ ] **Step 6: Commit**

```bash
git add packages/db
git commit -m "feat(db): server_restarts — migration 0032"
```

---

### Task 4: Bot config — `RESTART_SCHEDULE` and `NITRADO_TOKEN`

**Files:**
- Modify: `apps/bot/src/config.ts` (type at ~line 69–76, `loadConfig` at ~line 240)
- Modify: `apps/bot/README.md` (env table, after the `ACHIEVEMENTS_TICK` row)
- Test: `apps/bot/test/config.test.ts` (append inside `describe("loadConfig")`)

**Interfaces:**
- Produces: `BotConfig.restartSchedule: boolean`, `BotConfig.nitradoToken: string | undefined`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/bot/test/config.test.ts` inside the top-level `describe`:

```ts
  describe("RESTART_SCHEDULE / NITRADO_TOKEN", () => {
    it("defaults off, token optional while off", () => {
      const cfg = loadConfig(OK);
      expect(cfg.restartSchedule).toBe(false);
      expect(cfg.nitradoToken).toBeUndefined();
    });
    it("on with a token loads", () => {
      expect(loadConfig({ ...OK, RESTART_SCHEDULE: "1", NITRADO_TOKEN: "nt" })).toMatchObject({ restartSchedule: true, nitradoToken: "nt" });
      expect(loadConfig({ ...OK, RESTART_SCHEDULE: "true", NITRADO_TOKEN: "nt" }).restartSchedule).toBe(true);
    });
    it("⚠️ on without a token refuses to load — a schedule that cannot authenticate must not look like one that works", () => {
      expect(() => loadConfig({ ...OK, RESTART_SCHEDULE: "1" })).toThrow(/NITRADO_TOKEN/u);
      expect(() => loadConfig({ ...OK, RESTART_SCHEDULE: "1", NITRADO_TOKEN: "  " })).toThrow(/NITRADO_TOKEN/u);
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/bot && npx vitest run test/config.test.ts`
Expected: FAIL — `restartSchedule` undefined / no throw.

- [ ] **Step 3: Implement**

In the `BotConfig` type, after `achievementsTick: boolean;`:

```ts
  /** Restart every active server on even UTC hours through Nitrado (spec 2026-09-12). Off by default. */
  restartSchedule: boolean;
  /** Required when `restartSchedule` is on; the same token the ingest worker uses. */
  nitradoToken: string | undefined;
```

In `loadConfig`, after the `achievementsTick:` line:

```ts
    restartSchedule: ["1", "true"].includes((env.RESTART_SCHEDULE ?? "").toLowerCase()),
    nitradoToken: env.NITRADO_TOKEN?.trim() || undefined,
  };

  // ⚠️ A schedule that is on but cannot authenticate would fail every slot at
  // error level and look, from systemctl, exactly like one that is working.
  if (config.restartSchedule && !config.nitradoToken) {
    throw new Error("RESTART_SCHEDULE is on but NITRADO_TOKEN is unset — the bot cannot restart a server it cannot authenticate to.");
  }

  return config;
```

(Replace the existing `};\n\n  return config;` ending accordingly.)

Add to `apps/bot/README.md` env table after the `ACHIEVEMENTS_TICK` row:

```md
| `RESTART_SCHEDULE` | no (default off; `"1"`/`"true"` = on) | Restart every active server with a `nitrado_service_id` at the top of every even UTC hour (00:00, 02:00 … 22:00), through Nitrado. Off by default. `messages.xml` is not touched — trim its own shutdown entry by hand or both fire. Runbook `docs/deploy/2026-09-12-scheduled-restarts.md`. |
| `NITRADO_TOKEN` | only when `RESTART_SCHEDULE` is on | The Nitrado API token, the same value the ingest worker already reads. Config load fails if the schedule is on without it. |
```

- [ ] **Step 4: Run the config tests and typecheck**

Run: `cd apps/bot && npx tsc --noEmit && npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/config.ts apps/bot/test/config.test.ts apps/bot/README.md
git commit -m "feat(bot): RESTART_SCHEDULE and NITRADO_TOKEN config"
```

---

### Task 5: `restartTick`

**Files:**
- Create: `apps/bot/src/restart-tick.ts`
- Modify: `apps/bot/package.json` (add `"@factions/nitrado": "workspace:*"` to dependencies, then `pnpm install --offline` at the repo root)
- Test: `apps/bot/test/restart-tick.test.ts`

**Interfaces:**
- Consumes: `restartSlot`, `RESTART_GRACE_MS` from `@factions/domain`; `serverRestarts`, `servers` from `@factions/db`.
- Produces:
  ```ts
  export type RestartTarget = { status(): Promise<string>; restart(message: string): Promise<void> };
  export type RestartTickResult = { restarted: number; skipped: number; missed: number; failed: number };
  export function restartTick(db: Database, nitradoFor: (serviceId: number) => RestartTarget, opts: { now: Date }): Promise<RestartTickResult>;
  export const RESTART_MESSAGE = "Scheduled restart";
  ```

- [ ] **Step 1: Add the dependency**

In `apps/bot/package.json` dependencies add `"@factions/nitrado": "workspace:*"` (keep alphabetical). Run `pnpm install --offline` at the repo root. Expected: lockfile updated, no download.

- [ ] **Step 2: Write the failing tests**

`apps/bot/test/restart-tick.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, serverRestarts, servers, type Database } from "@factions/db";
import { asc, sql } from "drizzle-orm";
import { restartTick, RESTART_MESSAGE, type RestartTarget } from "../src/restart-tick.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const SLOT = at("2026-09-12T14:00:00Z");

/** A Nitrado that answers a fixed status and records restarts. */
function fakeNitrado(status = "started", restartImpl?: () => Promise<void>) {
  const restart = vi.fn(restartImpl ?? (async () => {}));
  return { target: { status: vi.fn(async () => status), restart } as RestartTarget, restart };
}

describe("restartTick", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table server_restarts`);
    await db.execute(sql`update servers set active = false`);
    const [s] = await db.insert(servers).values({ name: "R", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 4242, active: true }).returning();
    serverId = s!.id;
  });
  const rows = () => db.select().from(serverRestarts).orderBy(asc(serverRestarts.scheduledFor));

  it("fires once per slot, in the slot's first minutes, and records it", async () => {
    const { target, restart } = fakeNitrado();
    const r = await restartTick(db, () => target, { now: at("2026-09-12T14:00:03Z") });
    expect(r).toEqual({ restarted: 1, skipped: 0, missed: 0, failed: 0 });
    expect(restart).toHaveBeenCalledWith(RESTART_MESSAGE);
    expect(await rows()).toMatchObject([{ serverId, scheduledFor: SLOT, outcome: "restarted" }]);
    // The next pass, same slot: the row exists, nothing fires.
    const again = await restartTick(db, () => target, { now: at("2026-09-12T14:00:13Z") });
    expect(again).toEqual({ restarted: 0, skipped: 0, missed: 0, failed: 0 });
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("does nothing between slots", async () => {
    const { target, restart } = fakeNitrado();
    await restartTick(db, () => target, { now: at("2026-09-12T14:30:00Z") });
    // 14:30 is past 14:00's grace: recorded missed (below), but never restarted.
    expect(restart).not.toHaveBeenCalled();
    await restartTick(db, () => target, { now: at("2026-09-12T15:59:59Z") });
    expect(restart).not.toHaveBeenCalled();
  });

  it("catches up inside the grace window after downtime, and records missed after it", async () => {
    const { target, restart } = fakeNitrado();
    await restartTick(db, () => target, { now: at("2026-09-12T14:03:00Z") });
    expect(restart).toHaveBeenCalledTimes(1);
    await db.execute(sql`truncate table server_restarts`);
    const r = await restartTick(db, () => target, { now: at("2026-09-12T14:20:00Z") });
    expect(r).toEqual({ restarted: 0, skipped: 0, missed: 1, failed: 0 });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(await rows()).toMatchObject([{ scheduledFor: SLOT, outcome: "missed", detail: { reason: "not running" } }]);
  });

  it("retries a failed POST every pass until the window closes, then records missed with the error", async () => {
    let calls = 0;
    const { target, restart } = fakeNitrado("started", async () => { calls++; throw new Error("Nitrado 503 for /restart"); });
    const r1 = await restartTick(db, () => target, { now: at("2026-09-12T14:00:00Z") });
    expect(r1).toEqual({ restarted: 0, skipped: 0, missed: 0, failed: 1 });
    expect(await rows()).toEqual([]);                          // no row: the retry is what the next pass does
    await restartTick(db, () => target, { now: at("2026-09-12T14:00:10Z") });
    expect(calls).toBe(2);
    const r3 = await restartTick(db, () => target, { now: at("2026-09-12T14:10:00Z") });
    expect(r3).toEqual({ restarted: 0, skipped: 0, missed: 1, failed: 0 });
    expect(await rows()).toMatchObject([{ outcome: "missed", detail: { reason: "failed", error: "Nitrado 503 for /restart" } }]);
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it("then succeeds on a later pass: the retry that lands writes restarted", async () => {
    let n = 0;
    const { target } = fakeNitrado("started", async () => { if (n++ === 0) throw new Error("boom"); });
    await restartTick(db, () => target, { now: at("2026-09-12T14:00:00Z") });
    const r = await restartTick(db, () => target, { now: at("2026-09-12T14:00:10Z") });
    expect(r.restarted).toBe(1);
    expect(await rows()).toMatchObject([{ outcome: "restarted" }]);
  });

  it("⚠️ skips, with no POST, a server that is not `started` — a messages.xml shutdown in flight must not be followed by a second restart", async () => {
    const { target, restart } = fakeNitrado("restarting");
    const r = await restartTick(db, () => target, { now: at("2026-09-12T14:00:00Z") });
    expect(r).toEqual({ restarted: 0, skipped: 1, missed: 0, failed: 0 });
    expect(restart).not.toHaveBeenCalled();
    expect(await rows()).toMatchObject([{ outcome: "skipped", detail: { status: "restarting" } }]);
  });

  it("one server's failure never blocks another's", async () => {
    const [s2] = await db.insert(servers).values({ name: "R2", map: "chernarus", clockOffsetMs: 0, nitradoServiceId: 5151, active: true }).returning();
    const bad = fakeNitrado("started", async () => { throw new Error("no"); });
    const good = fakeNitrado();
    const r = await restartTick(db, (id) => (id === 4242 ? bad.target : good.target), { now: at("2026-09-12T14:00:00Z") });
    expect(r).toEqual({ restarted: 1, skipped: 0, missed: 0, failed: 1 });
    expect(good.restart).toHaveBeenCalledTimes(1);
    expect((await rows()).map((x) => x.serverId)).toEqual([s2!.id]);
  });

  it("never touches an inactive server or one with no service id", async () => {
    await db.insert(servers).values([
      { name: "off", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 7, active: false },
      { name: "nosvc", map: "livonia", clockOffsetMs: 0, nitradoServiceId: null, active: true },
    ]);
    const nitradoFor = vi.fn((_: number) => fakeNitrado().target);
    await restartTick(db, nitradoFor, { now: at("2026-09-12T14:00:00Z") });
    expect(nitradoFor.mock.calls.map((c) => c[0])).toEqual([4242]);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/restart-tick.test.ts`
Expected: FAIL — cannot resolve `../src/restart-tick.js`.

- [ ] **Step 4: Implement**

`apps/bot/src/restart-tick.ts`:

```ts
import { serverRestarts, servers, type Database } from "@factions/db";
import { restartSlot } from "@factions/domain";
import { and, eq, isNotNull } from "drizzle-orm";

/** What the tick needs from a Nitrado client — the two methods, so a test can hand it a fake. */
export type RestartTarget = { status(): Promise<string>; restart(message: string): Promise<void> };
export type RestartTickResult = { restarted: number; skipped: number; missed: number; failed: number };
export const RESTART_MESSAGE = "Scheduled restart";

type Outcome = "restarted" | "skipped" | "missed";

/** Record a slot. `onConflictDoNothing`: a row already there means another pass handled it. */
async function record(db: Database, serverId: number, slot: Date, now: Date, outcome: Outcome, detail: Record<string, string | number | boolean | null> = {}): Promise<boolean> {
  const inserted = await db.insert(serverRestarts).values({ serverId, scheduledFor: slot, issuedAt: now, outcome, detail }).onConflictDoNothing().returning({ serverId: serverRestarts.serverId });
  return inserted.length > 0;
}

/**
 * Scheduled restarts (spec 2026-09-12). Every pass: find the current slot; for
 * each active server with a Nitrado service, if the slot has no row —
 *
 *   - inside the grace window: check the status, POST the restart, write
 *     `restarted`. A throw writes NOTHING, so the next pass retries; the
 *     last error is kept in memory for the `missed` row.
 *   - past the grace window: write `missed`. A restart that late kicks players
 *     who had no countdown, and the next slot is at most 110 minutes away.
 *
 * ⚠️ POST first, row second. A row before the POST records a restart that
 * never happened when the POST then fails. The reverse — the process dying
 * between POST and insert — is absorbed by the status check on the retry: the
 * server reports `restarting`, and the slot is recorded `skipped`, not
 * restarted twice.
 *
 * ⚠️ Only `started` is restarted. Any other status is `skipped` with the
 * status in `detail`: a messages.xml shutdown or a manual restart already in
 * flight must not be followed by a second one.
 */
export async function restartTick(db: Database, nitradoFor: (serviceId: number) => RestartTarget, opts: { now: Date }): Promise<RestartTickResult> {
  const result: RestartTickResult = { restarted: 0, skipped: 0, missed: 0, failed: 0 };
  const slot = restartSlot(opts.now);
  const targets = await db.select({ id: servers.id, serviceId: servers.nitradoServiceId }).from(servers)
    .where(and(eq(servers.active, true), isNotNull(servers.nitradoServiceId)));

  for (const s of targets) {
    const serviceId = s.serviceId!;
    try {
      const [handled] = await db.select({ serverId: serverRestarts.serverId }).from(serverRestarts)
        .where(and(eq(serverRestarts.serverId, s.id), eq(serverRestarts.scheduledFor, slot.start))).limit(1);
      if (handled) continue;

      if (slot.missedIfUnhandled) {
        const err = lastError.get(s.id);
        const detail = err ? { reason: "failed", error: err } : { reason: "not running" };
        if (await record(db, s.id, slot.start, opts.now, "missed", detail)) {
          result.missed += 1;
          console.error(`restart: server ${s.id} MISSED slot ${slot.start.toISOString()} (${err ?? "bot was not running"})`);
        }
        lastError.delete(s.id);
        continue;
      }

      const nitrado = nitradoFor(serviceId);
      const status = await nitrado.status();
      if (status !== "started") {
        if (await record(db, s.id, slot.start, opts.now, "skipped", { status })) {
          result.skipped += 1;
          console.warn(`restart: server ${s.id} skipped slot ${slot.start.toISOString()} — status ${status}`);
        }
        continue;
      }
      await nitrado.restart(RESTART_MESSAGE);
      if (await record(db, s.id, slot.start, opts.now, "restarted")) {
        result.restarted += 1;
        console.log(`restart: server ${s.id} restarted for ${slot.start.toISOString()}`);
      }
      lastError.delete(s.id);
    } catch (err) {
      // Per server: one service's failure never blocks another's. No row —
      // the next pass retries until the window closes.
      result.failed += 1;
      lastError.set(s.id, err instanceof Error ? err.message : String(err));
      console.error(`restart: server ${s.id} failed for slot ${slot.start.toISOString()}`, err);
    }
  }
  return result;
}

/** The last error per server, for the `missed` row's detail. Process-local by design: a restarted bot has no error to report, and says "not running". */
const lastError = new Map<number, string>();
```

Note: `lastError` is declared after use inside the module, which is legal (module-level `const` is initialised before any call). Move it above the function if the linter complains.

- [ ] **Step 5: Run the tests and typecheck**

Run: `cd apps/bot && npx tsc --noEmit && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/restart-tick.test.ts`
Expected: PASS, 8 tests. If "does nothing between slots" fails because 14:30 wrote a `missed` row for 14:00 — that is correct behaviour; the test asserts only that `restart` was never called.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/restart-tick.ts apps/bot/test/restart-tick.test.ts apps/bot/package.json pnpm-lock.yaml
git commit -m "feat(bot): restartTick — even UTC hours through Nitrado, one row per slot"
```

---

### Task 6: Wire the tick into the loop

**Files:**
- Modify: `apps/bot/src/discord.ts` (imports at top; the loop after the reaper block, ~line 895; startup log near the `feedChannelId` warning, ~line 1015)
- Test: `apps/bot/test/restart-wiring.test.ts`

**Interfaces:**
- Consumes: `restartTick`, `RestartTarget` from `./restart-tick.js`; `NitradoClient` from `@factions/nitrado`; `cfg.restartSchedule`, `cfg.nitradoToken`.

- [ ] **Step 1: Write the failing test**

`apps/bot/test/restart-wiring.test.ts` (source-level, the shape of `feed-wiring.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dirname, "..", "src", "discord.ts"), "utf8");

describe("restart tick wiring", () => {
  it("runs restartTick in the loop, gated on cfg.restartSchedule, in its own try/catch", () => {
    expect(src).toMatch(/import \{ restartTick[^}]*\} from "\.\/restart-tick\.js"/u);
    expect(src).toMatch(/if \(cfg\.restartSchedule\) \{\s*try \{[\s\S]*?await restartTick\(db, nitradoFor, \{ now: new Date\(\) \}\)/u);
  });
  it("builds one NitradoClient per service id from cfg.nitradoToken", () => {
    expect(src).toMatch(/new NitradoClient\(cfg\.nitradoToken/u);
  });
  it("says at startup when the schedule is off — an off feature must not look broken", () => {
    expect(src).toMatch(/RESTART_SCHEDULE/u);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/bot && npx vitest run test/restart-wiring.test.ts`
Expected: FAIL on all three.

- [ ] **Step 3: Wire it**

Imports in `apps/bot/src/discord.ts`, after `import { reaperTick } from "./reaper-tick.js";`:

```ts
import { restartTick, type RestartTarget } from "./restart-tick.js";
import { NitradoClient } from "@factions/nitrado";
```

In `start()`, near `const noticeSender = createNoticeSender(client);`:

```ts
  // One client per Nitrado service, the shape the ingest worker's `clientFor` has.
  // ⚠️ cfg.nitradoToken is guaranteed by loadConfig whenever restartSchedule is on.
  const nitradoClients = new Map<number, NitradoClient>();
  const nitradoFor = (serviceId: number): RestartTarget => {
    let c = nitradoClients.get(serviceId);
    if (!c) { c = new NitradoClient(cfg.nitradoToken ?? "", serviceId); nitradoClients.set(serviceId, c); }
    return c;
  };
```

In the loop, right after the reaper block's closing `}`:

```ts
    // Scheduled restarts (spec 2026-09-12): housekeeping, not a consumer — it
    // reads no cursor, so it sits with the reaper. Every pass, so a slot's
    // ten-minute grace window is checked at the tick interval.
    if (cfg.restartSchedule) {
      try {
        const r = await restartTick(db, nitradoFor, { now: new Date() });
        if (r.restarted + r.skipped + r.missed + r.failed > 0) console.log(`restart: ${r.restarted} restarted, ${r.skipped} skipped, ${r.missed} missed, ${r.failed} failed`);
      } catch (err) {
        console.error("restart tick failed", err);
      }
    }
```

In `clientReady`, beside the `feedChannelId` warning:

```ts
    if (!cfg.restartSchedule) console.warn("RESTART_SCHEDULE is off: the bot is not restarting the server on a schedule.");
    else console.log("scheduled restarts on: every even UTC hour");
```

- [ ] **Step 4: Typecheck and run the bot suite**

Run: `cd apps/bot && npx tsc --noEmit && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run`
Expected: PASS (~80 files).

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/discord.ts apps/bot/test/restart-wiring.test.ts
git commit -m "feat(bot): run restartTick in the loop behind RESTART_SCHEDULE"
```

---

### Task 7: Runbook and notes

**Files:**
- Create: `docs/deploy/2026-09-12-scheduled-restarts.md`
- Modify: `CLAUDE.md` (the "Where things live" table; the lock-order bullet gets one sentence)

- [ ] **Step 1: Write the runbook**

`docs/deploy/2026-09-12-scheduled-restarts.md`:

```md
# Scheduled restarts from the bot — runbook

Spec `docs/superpowers/specs/2026-09-12-scheduled-restarts-design.md`. The bot restarts every
active server with a `nitrado_service_id` at the top of every even UTC hour (00:00, 02:00 …
22:00), through Nitrado's API, and writes one `server_restarts` row per server per slot.
Migration 0032 adds that table, additively. `messages.xml` is NOT touched by any of this.

⚠️ If `messages.xml` still carries its own shutdown entry, both schedules fire. The bot skips a
slot when the server is not `started` (so a shutdown already in flight is not followed by a
second restart), but two independent schedules is still two sets of restarts. Trim the
shutdown from `messages.xml` by hand when you are happy the bot's are landing.

## Steps

1. Apply migration 0032 with the one-off runner from `docs/deploy/2026-09-02-dormancy.md`,
   after confirming `__drizzle_migrations` holds 32 rows and the journal 33.
2. Deploy the bot with `RESTART_SCHEDULE` unset: `cd /opt/clan-wars && git pull --ff-only &&
   pnpm install --frozen-lockfile && sudo systemctl restart clan-wars-bot`. The journal shows
   `RESTART_SCHEDULE is off` at startup.
3. Pick a moment more than ten minutes past an even hour (so the first slot the bot sees is a
   clean, future one), put `RESTART_SCHEDULE=1` in `.env` (`NITRADO_TOKEN` is already there for
   the worker), and `sudo systemctl restart clan-wars-bot`. The journal shows
   `scheduled restarts on: every even UTC hour`.
4. At the next even hour: `select * from server_restarts order by scheduled_for desc limit 3;`
   shows a `restarted` row within seconds of the hour, the journal shows
   `restart: server 1 restarted for …`, and Nitrado's panel shows the restart. A fresh ADM
   file appears in `adm_files` once the server is back.

## Checking it is working

    select scheduled_for, outcome, detail from server_restarts order by scheduled_for desc limit 12;

Twelve rows a day, all `restarted`. A `skipped` row names the status the server was in; a
`missed` row means the bot was down or Nitrado kept failing for the whole ten-minute window —
`detail` says which. ⚠️ `systemctl status clan-wars-bot` says nothing about any of this.

## Rolling back

Unset `RESTART_SCHEDULE`, restart the bot. The table can stay; nothing else reads it.
```

- [ ] **Step 2: CLAUDE.md**

Add a row to the "Where things live" table:

```md
| Scheduled restarts (even UTC hours) | `apps/bot/src/restart-tick.ts`, gated on `RESTART_SCHEDULE`; slots from `restartSlot()` in `packages/domain/src/restarts.ts` (`RESTART_PERIOD_MS`, `RESTART_GRACE_MS` in `rules.ts`); one row per server per slot in `server_restarts`. `messages.xml` is never touched. Runbook `docs/deploy/2026-09-12-scheduled-restarts.md` |
```

Append one sentence to the lock-order bullet, after "The achievements tick writes the three achievement tables in exactly that order inside each owner's transaction, before it appends that owner's notices.":

```md
  `server_restarts` is outside the order: written by the restart tick alone, in its own transaction, touching nothing else.
```

- [ ] **Step 3: Commit, merge, push**

```bash
git add docs/deploy/2026-09-12-scheduled-restarts.md CLAUDE.md
git commit -m "docs: scheduled restarts runbook and notes"
git checkout main && git merge --no-ff scheduled-restarts -m "Merge branch 'scheduled-restarts'"
git push origin main
```

- [ ] **Step 4: The full gate**

Run from the repo root:

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force
```

Expected: every task green; count the tasks (CLAUDE.md says 26/26 before this work — the count does not change, no new package).
