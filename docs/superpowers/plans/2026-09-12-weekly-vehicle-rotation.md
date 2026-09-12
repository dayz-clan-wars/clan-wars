# Weekly rotating vehicle wipe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Monday 08:00 UTC, wipe one of five vehicle types alongside the daily truck wipe, rotating weekly, and announce the coming week's vehicle to Discord 24 hours ahead.

**Architecture:** The rotation is a pure function of the calendar — no stored pointer — so the Sunday announcement and the Monday wipe derive the same vehicle independently. The wipe extends the existing `applyTruckWipe` inside `restart-tick.ts`, converging all five rotation events at every restart slot. The announcement is a new tick over a new single-column-keyed table, following the repo's post-then-mark poster convention.

**Tech Stack:** TypeScript/ESM, vitest, drizzle-orm over postgres.js, discord.js.

**Spec:** `docs/superpowers/specs/2026-09-12-weekly-vehicle-rotation-design.md`

## Global Constraints

- **The full gate, always with `--force`:** `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`. Expect **26/26 tasks**. A cached pass proves nothing; check the count, not the exit code.
- **Comments explain WHY, not what.** `⚠️` marks a line whose failure is silent. Match the density of the file being edited. Code review enforces this.
- **Prefer a failing test over a defensive default.** Several guards here exist because the alternative succeeded while doing nothing useful.
- **Two statements of one fact will drift** — where a constant is mirrored where the compiler cannot see, add a test that fails when they disagree.
- **Every guide-facing number lives in `packages/domain/src/rules.ts`.** These are operational constants, not player-facing guide numbers, so they do NOT go in `guide-numbers.ts`.
- **Nothing applies migrations in production.** A migration is a deliberate deploy step. Generate with `cd packages/db && npx drizzle-kit generate` and read the SQL before it goes near `factions_live`.
- **⚠️ Journal `when` timestamps must increase.** A new migration's `when` must exceed the previous entry's or drizzle-kit silently applies nothing while reporting success.
- **Rotation order is fixed:** `VehicleCivilianSedan` (Olga), `VehicleHatchback02` (Gunter), `VehicleOffroad02` (Hummer), `VehicleOffroadHatchback` (Ada), `VehicleSedan02` (Sarka).
- **`ROTATION_ANCHOR_MS = Date.UTC(2026, 8, 14)`** — Monday 2026-09-14, index 0 (Olga).

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/domain/src/rules.ts` | Add `WEEKLY_WIPE_VEHICLES`, `ROTATION_ANCHOR_MS`, `ANNOUNCE_LEAD_MS`, `ANNOUNCE_CUTOFF_MS`. |
| `packages/domain/src/restarts.ts` | Add `weeklyWipeVehicle()`, `wipeMondayFor()`, `announceAtFor()`, `rotationActiveFor()`. Pure; no I/O. |
| `packages/db/src/schema.ts` | Add `vehicleWipeAnnouncements` table. |
| `packages/db/migrations/0033_*.sql` | The additive table. |
| `apps/bot/src/restart-tick.ts` | Extend `applyTruckWipe` to converge the five rotation events. |
| `apps/bot/src/announce-tick.ts` | **New.** Decide-and-post the weekly announcement. |
| `apps/bot/src/announce-text.ts` | **New.** The message copy, pure, so it is testable without Discord. |
| `apps/bot/src/config.ts` | `WEEKLY_VEHICLE_WIPE`, `ANNOUNCEMENTS_CHANNEL_ID`. |
| `apps/bot/src/discord.ts` | Wire the tick + poster + startup lines. |

---

### Task 1: The rotation, as pure functions

**Files:**
- Modify: `packages/domain/src/rules.ts`
- Modify: `packages/domain/src/restarts.ts`
- Test: `packages/domain/test/restarts.test.ts`

**Interfaces:**
- Consumes: `truckWipeActive`, `ActiveFlag` (already in `restarts.ts`).
- Produces:
  - `WEEKLY_WIPE_VEHICLES: readonly { event: string; name: string }[]`
  - `ROTATION_ANCHOR_MS: number`, `ANNOUNCE_LEAD_MS: number`, `ANNOUNCE_CUTOFF_MS: number`
  - `weeklyWipeVehicle(monday: Date): { event: string; name: string }`
  - `wipeMondayFor(now: Date, offHour: number): Date`
  - `announceAtFor(wipeMonday: Date): Date`
  - `rotationActiveFor(slotStart: Date, offHour: number, onHour: number, event: string): ActiveFlag`

- [ ] **Step 1: Write the failing tests**

Append to `packages/domain/test/restarts.test.ts` (it already imports from `../src/restarts`; extend that import):

```ts
describe("weeklyWipeVehicle", () => {
  const mon = (iso: string) => new Date(`${iso}T00:00:00Z`);

  it("starts the rotation at Olga on the anchor Monday", () => {
    expect(weeklyWipeVehicle(mon("2026-09-14")).name).toBe("Olga");
  });

  it("advances one vehicle per week, in the configured order", () => {
    const got = ["2026-09-14","2026-09-21","2026-09-28","2026-10-05","2026-10-12"]
      .map((d) => weeklyWipeVehicle(mon(d)).name);
    expect(got).toEqual(["Olga", "Gunter", "Hummer", "Ada", "Sarka"]);
  });

  it("wraps back to Olga on the sixth week", () => {
    expect(weeklyWipeVehicle(mon("2026-10-19")).name).toBe("Olga");
  });

  // ⚠️ The wipe and the announcement call this with different instants inside the
  // same week. If the hour changed the answer they could disagree by a vehicle.
  it("gives the same vehicle for every hour of its Monday", () => {
    const names = [0, 8, 10, 23].map((h) =>
      weeklyWipeVehicle(new Date(Date.UTC(2026, 8, 21, h))).name);
    expect(new Set(names)).toEqual(new Set(["Gunter"]));
  });

  it("runs backwards before the anchor without going negative", () => {
    expect(weeklyWipeVehicle(mon("2026-09-07")).name).toBe("Sarka");
    expect(weeklyWipeVehicle(mon("2026-08-31")).name).toBe("Ada");
  });
});

describe("wipeMondayFor", () => {
  it("finds the coming Monday 08:00Z from mid-week", () => {
    expect(wipeMondayFor(new Date("2026-09-12T20:45:00Z"), 8).toISOString())
      .toBe("2026-09-14T08:00:00.000Z");
  });

  it("finds tomorrow from the Sunday announcement moment", () => {
    expect(wipeMondayFor(new Date("2026-09-13T08:00:00Z"), 8).toISOString())
      .toBe("2026-09-14T08:00:00.000Z");
  });

  // ⚠️ Strictly after `now`: during the 08:00-10:00 wipe the tick must already be
  // looking at NEXT week, or it re-announces the wipe currently in progress.
  it("looks at next week once this week's wipe has started", () => {
    expect(wipeMondayFor(new Date("2026-09-14T08:00:00Z"), 8).toISOString())
      .toBe("2026-09-21T08:00:00.000Z");
    expect(wipeMondayFor(new Date("2026-09-14T09:30:00Z"), 8).toISOString())
      .toBe("2026-09-21T08:00:00.000Z");
  });

  it("still points at today's Monday in the hours before it", () => {
    expect(wipeMondayFor(new Date("2026-09-14T07:59:00Z"), 8).toISOString())
      .toBe("2026-09-14T08:00:00.000Z");
  });
});

describe("announceAtFor", () => {
  it("is exactly 24 hours before the wipe", () => {
    expect(announceAtFor(new Date("2026-09-14T08:00:00Z")).toISOString())
      .toBe("2026-09-13T08:00:00.000Z");
  });
});

describe("rotationActiveFor", () => {
  const WEEK1_MON_08 = new Date("2026-09-14T08:00:00Z"); // Olga's week
  const OLGA = "VehicleCivilianSedan";
  const GUNTER = "VehicleHatchback02";

  it("disables this week's vehicle inside the Monday window", () => {
    expect(rotationActiveFor(WEEK1_MON_08, 8, 10, OLGA)).toBe(0);
  });

  it("leaves every other vehicle enabled in that same window", () => {
    expect(rotationActiveFor(WEEK1_MON_08, 8, 10, GUNTER)).toBe(1);
  });

  it("re-enables this week's vehicle at the on hour", () => {
    expect(rotationActiveFor(new Date("2026-09-14T10:00:00Z"), 8, 10, OLGA)).toBe(1);
  });

  // ⚠️ The convergence guarantee. Without it, a bot down across Monday 10:00 leaves
  // that week's vehicle at 0 forever: by the time it returns the rotation has moved
  // on and nothing would ever put the old one back.
  it("enables last week's vehicle on a later slot, healing a missed re-enable", () => {
    expect(rotationActiveFor(new Date("2026-09-14T12:00:00Z"), 8, 10, OLGA)).toBe(1);
    expect(rotationActiveFor(new Date("2026-09-16T08:00:00Z"), 8, 10, OLGA)).toBe(1);
  });

  it("never disables anything on a day that is not Monday", () => {
    // 2026-09-16 is a Wednesday; 08:00 is inside the window hours but not a Monday.
    expect(rotationActiveFor(new Date("2026-09-16T08:00:00Z"), 8, 10, GUNTER)).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars
npx vitest run --root packages/domain test/restarts.test.ts
```

Expected: FAIL — `weeklyWipeVehicle is not defined` and the same for the other three.

- [ ] **Step 3: Add the constants to `rules.ts`**

Append after the existing `RESTART_GRACE_MS` block:

```ts
/**
 * The weekly vehicle rotation (spec 2026-09-12). One of these is wiped each Monday
 * alongside the daily trucks, in this order.
 *
 * ⚠️ The `event` strings must match `<event name="…">` in the mission's db/events.xml
 * exactly. A name that is absent throws at wipe time — logged, restart unaffected, but
 * that week's wipe silently does not happen.
 */
export const WEEKLY_WIPE_VEHICLES = [
  { event: "VehicleCivilianSedan", name: "Olga" },
  { event: "VehicleHatchback02", name: "Gunter" },
  { event: "VehicleOffroad02", name: "Hummer" },
  { event: "VehicleOffroadHatchback", name: "Ada" },
  { event: "VehicleSedan02", name: "Sarka" },
] as const;

/**
 * Monday 2026-09-14 UTC — rotation index 0, so the sequence runs in the order above.
 *
 * ⚠️ Moving this constant re-phases the whole rotation, including weeks already
 * announced. It is the anchor, not a start date to keep current.
 */
export const ROTATION_ANCHOR_MS = Date.UTC(2026, 8, 14);

/** The announcement lands this far before the wipe, and is never posted later than
 *  ANNOUNCE_CUTOFF_MS before it — past that, a notice would describe a wipe that has
 *  effectively already arrived, which is worse than silence. */
export const ANNOUNCE_LEAD_MS = 24 * HOUR;
export const ANNOUNCE_CUTOFF_MS = 1 * HOUR;
```

- [ ] **Step 4: Add the functions to `restarts.ts`**

Extend the existing import line and append:

```ts
import { WEEKLY_WIPE_VEHICLES, ROTATION_ANCHOR_MS, ANNOUNCE_LEAD_MS } from "./rules";
export { WEEKLY_WIPE_VEHICLES, ROTATION_ANCHOR_MS };

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type WipeVehicle = { event: string; name: string };

/** UTC midnight of the Monday of `d`'s week. */
function mondayMidnightUtc(d: Date): number {
  const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = new Date(utc).getUTCDay(); // 0=Sun
  const backToMonday = (dow + 6) % 7;    // Mon->0, Sun->6
  return utc - backToMonday * 24 * 60 * 60 * 1000;
}

/**
 * This week's vehicle, derived from the calendar alone.
 *
 * ⚠️ Deliberately stateless. The Sunday announcement and the Monday wipe each call
 * this, minutes or a day apart, and must never disagree — a stored pointer read at two
 * moments is exactly how a bot announces Olga and wipes Gunter.
 */
export function weeklyWipeVehicle(when: Date): WipeVehicle {
  const weeks = Math.floor((mondayMidnightUtc(when) - ROTATION_ANCHOR_MS) / WEEK_MS);
  const n = WEEKLY_WIPE_VEHICLES.length;
  // ⚠️ Double modulo: JS `%` keeps the sign, so a date before the anchor would index
  // negatively and throw at runtime rather than wrapping.
  return WEEKLY_WIPE_VEHICLES[((weeks % n) + n) % n]!;
}

/**
 * The next wipe Monday at `offHour`:00Z STRICTLY after `now`.
 *
 * ⚠️ Strictly after, so that during the Monday wipe itself this already points at next
 * week. Otherwise the announce tick, seeing no row for the in-progress wipe past its
 * cutoff, would keep re-evaluating a wipe that is already happening.
 */
export function wipeMondayFor(now: Date, offHour: number): Date {
  let monday = mondayMidnightUtc(now) + offHour * 60 * 60 * 1000;
  while (monday <= now.getTime()) monday += WEEK_MS;
  return new Date(monday);
}

export function announceAtFor(wipeMonday: Date): Date {
  return new Date(wipeMonday.getTime() - ANNOUNCE_LEAD_MS);
}

/**
 * The `<active>` value one rotation event should carry for the server booting into
 * `slotStart`: 0 only if it is that week's vehicle and the slot is a Monday inside the
 * wipe window, 1 otherwise.
 *
 * ⚠️ Returns 1 for the other four on purpose — the caller converges ALL five every
 * slot. See the test: a bot down across Monday 10:00 otherwise strands that week's
 * vehicle at 0 permanently, because the rotation has moved on by the time it returns.
 */
export function rotationActiveFor(
  slotStart: Date, offHour: number, onHour: number, event: string,
): ActiveFlag {
  if (slotStart.getUTCDay() !== 1) return 1; // not a Monday
  if (weeklyWipeVehicle(slotStart).event !== event) return 1;
  const h = slotStart.getUTCHours();
  return h >= offHour && h < onHour ? 0 : 1;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run --root packages/domain test/restarts.test.ts
```

Expected: PASS, all tests in the file.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/rules.ts packages/domain/src/restarts.ts packages/domain/test/restarts.test.ts
git commit -m "feat(domain): weekly vehicle rotation derived from the calendar"
```

---

### Task 2: Converge the rotation events in the restart tick

**Files:**
- Modify: `apps/bot/src/restart-tick.ts`
- Test: `apps/bot/test/restart-tick.test.ts`

**Interfaces:**
- Consumes: `rotationActiveFor`, `WEEKLY_WIPE_VEHICLES` from `@factions/domain`; `setEventActive` from `./events-xml.js`; the existing `TruckWipe` type and `applyTruckWipe`.
- Produces: `TruckWipe` gains `rotation: boolean`.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe("restartTick", …)` block, after the truck-wipe tests. Note the existing `XML` helper only carries `VehicleTruck01`; add a richer one:

```ts
  const FULL_XML = (truck: number, olga: number, gunter: number) =>
    `<events>` +
    `<event name="VehicleTruck01"><active>${truck}</active></event>` +
    `<event name="VehicleCivilianSedan"><active>${olga}</active></event>` +
    `<event name="VehicleHatchback02"><active>${gunter}</active></event>` +
    `<event name="VehicleOffroad02"><active>1</active></event>` +
    `<event name="VehicleOffroadHatchback"><active>1</active></event>` +
    `<event name="VehicleSedan02"><active>1</active></event>` +
    `</events>`;

  function fakeFullFiles(xml: string) {
    const uploads: Array<{ dir: string; name: string; content: string }> = [];
    const target = {
      status: vi.fn(async () => "started"),
      restart: vi.fn(async () => {}),
      missionDbDir: vi.fn(async () => "/m/db"),
      downloadFile: vi.fn(async () => xml),
      uploadFile: vi.fn(async (dir: string, name: string, content: string) => {
        uploads.push({ dir, name, content });
      }),
    } as unknown as RestartTarget;
    return { target, uploads, t: target as any };
  }

  const ROT = { events: ["VehicleTruck01"], offHour: 8, onHour: 10, rotation: true };
  const active = (xml: string, event: string) =>
    Number(new RegExp(`<event name="${event}"><active>(\\d)`).exec(xml)![1]);

  // 2026-09-14 is the anchor Monday: Olga's week.
  it("wipes the trucks AND this week's vehicle in one upload on the wipe Monday", async () => {
    const f = fakeFullFiles(FULL_XML(1, 1, 1));
    await restartTick(db, () => f.target, { now: at("2026-09-14T08:00:03Z"), lastError, truckWipe: ROT });
    expect(f.uploads).toHaveLength(1);
    const x = f.uploads[0]!.content;
    expect(active(x, "VehicleTruck01")).toBe(0);
    expect(active(x, "VehicleCivilianSedan")).toBe(0); // Olga
    expect(active(x, "VehicleHatchback02")).toBe(1);   // Gunter untouched
    expect(active(x, "VehicleSedan02")).toBe(1);
  });

  it("restores both at the on hour", async () => {
    const f = fakeFullFiles(FULL_XML(0, 0, 1));
    await restartTick(db, () => f.target, { now: at("2026-09-14T10:00:03Z"), lastError, truckWipe: ROT });
    const x = f.uploads[0]!.content;
    expect(active(x, "VehicleTruck01")).toBe(1);
    expect(active(x, "VehicleCivilianSedan")).toBe(1);
  });

  // ⚠️ The convergence guarantee, end to end: the bot was down across Olga's Monday
  // 10:00, so the file still says 0. Gunter's week must put Olga back.
  it("heals a previous week's vehicle left disabled", async () => {
    const f = fakeFullFiles(FULL_XML(1, 0, 1)); // Olga still off
    await restartTick(db, () => f.target, { now: at("2026-09-21T12:00:03Z"), lastError, truckWipe: ROT });
    expect(f.uploads).toHaveLength(1);
    expect(active(f.uploads[0]!.content, "VehicleCivilianSedan")).toBe(1);
  });

  it("writes nothing on an ordinary slot with everything already correct", async () => {
    const f = fakeFullFiles(FULL_XML(1, 1, 1));
    await restartTick(db, () => f.target, { now: at("2026-09-16T12:00:03Z"), lastError, truckWipe: ROT });
    expect(f.uploads).toEqual([]);
  });

  it("leaves the rotation alone entirely when rotation is off", async () => {
    const f = fakeFullFiles(FULL_XML(1, 1, 1));
    await restartTick(db, () => f.target, {
      now: at("2026-09-14T08:00:03Z"), lastError, truckWipe: { ...ROT, rotation: false },
    });
    const x = f.uploads[0]!.content;
    expect(active(x, "VehicleTruck01")).toBe(0);
    expect(active(x, "VehicleCivilianSedan")).toBe(1); // untouched
  });

  it("runs the rotation even with no daily truck events configured", async () => {
    const f = fakeFullFiles(FULL_XML(1, 1, 1));
    await restartTick(db, () => f.target, {
      now: at("2026-09-14T08:00:03Z"), lastError, truckWipe: { ...ROT, events: [] },
    });
    expect(f.uploads).toHaveLength(1);
    expect(active(f.uploads[0]!.content, "VehicleCivilianSedan")).toBe(0);
    expect(active(f.uploads[0]!.content, "VehicleTruck01")).toBe(1);
  });
```

Also update every existing `WIPE` constant usage in this file to carry `rotation: false`, so the truck-wipe tests keep testing only the trucks:

```ts
  const wipe = { events: ["VehicleTruck01"], offHour: 8, onHour: 10, rotation: false };
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx vitest run --root apps/bot test/restart-tick.test.ts
```

Expected: FAIL — the rotation events are not touched, so `active(x, "VehicleCivilianSedan")` is 1 where 0 is expected.

- [ ] **Step 3: Extend `applyTruckWipe`**

In `apps/bot/src/restart-tick.ts`, extend the import and the type, then the function:

```ts
import { restartSlot, truckWipeActive, rotationActiveFor, WEEKLY_WIPE_VEHICLES } from "@factions/domain";
```

```ts
/** Which events.xml entries the wipe owns, the UTC window they are off for, and
 *  whether the weekly vehicle rotation rides along. */
export type TruckWipe = { events: string[]; offHour: number; onHour: number; rotation: boolean };
```

Replace the body of `applyTruckWipe` with:

```ts
async function applyTruckWipe(nitrado: RestartTarget, wipe: TruckWipe, slot: Date): Promise<boolean> {
  const daily = truckWipeActive(slot, wipe.offHour, wipe.onHour);
  const dir = await nitrado.missionDbDir();
  const original = await nitrado.downloadFile(`${dir}/${EVENTS_FILE}`);

  let xml = original;
  for (const name of wipe.events) xml = setEventActive(xml, name, daily).xml;

  // ⚠️ ALL five every slot, not just this week's. A bot down across a Monday 10:00
  // leaves that week's vehicle at 0, and by the time it returns the rotation has moved
  // on — nothing else would ever put it back. Converging the whole set costs nothing:
  // the download already happened, and an unchanged file is still never re-uploaded.
  if (wipe.rotation) {
    for (const v of WEEKLY_WIPE_VEHICLES) {
      xml = setEventActive(xml, v.event, rotationActiveFor(slot, wipe.offHour, wipe.onHour, v.event)).xml;
    }
  }

  if (xml === original) return false;

  await nitrado.uploadFile(dir, EVENTS_FILE, xml);
  return true;
}
```

Then widen the gate that decides whether to call it at all — it currently requires a
non-empty `events`:

```ts
      // ⚠️ Either half can run alone: the daily truck wipe and the weekly rotation are
      // independently switchable, so this must not require `events` to be non-empty.
      if (opts.truckWipe && (opts.truckWipe.events.length > 0 || opts.truckWipe.rotation)) {
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx vitest run --root apps/bot test/restart-tick.test.ts
```

Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/restart-tick.ts apps/bot/test/restart-tick.test.ts
git commit -m "feat(bot): converge the weekly rotation vehicles at every restart slot"
```

---

### Task 3: The announcements table

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/migrations/0033_vehicle_wipe_announcements.sql` (generated)
- Test: `packages/db/test/schema.test.ts` (or the nearest existing schema suite)

**Interfaces:**
- Produces: `vehicleWipeAnnouncements` exported from `@factions/db`, columns `wipeAt`, `announcedAt`, `eventName`, `outcome`.

- [ ] **Step 1: Add the table to `schema.ts`**

Append after the `serverRestarts` block:

```ts
/**
 * One row per weekly vehicle wipe, written when its announcement is resolved.
 *
 * ⚠️ Keyed on `wipe_at` ALONE — no `server_id`, unlike `server_restarts` which this
 * otherwise copies. The rotation is a property of the calendar, not of a server: every
 * server wipes the same vehicle in the same week, and the announcement is one message to
 * one channel. A per-server key would post one identical message per active server.
 *
 * ⚠️ `event_name` is stored even though it is derivable from `wipe_at`. The row records
 * WHAT WAS ANNOUNCED; recomputing it later against an edited rotation list would make
 * the record lie. Same reason the faction feed freezes its payload at write time.
 */
export const vehicleWipeAnnouncements = pgTable("vehicle_wipe_announcements", {
  /** The Monday wipe slot this announces — an even UTC hour. */
  wipeAt: timestamp("wipe_at", { withTimezone: true }).primaryKey(),
  announcedAt: timestamp("announced_at", { withTimezone: true }).notNull(),
  eventName: text("event_name").notNull(),
  /** posted = the message went out; missed = the cutoff passed with nothing sent. */
  outcome: text("outcome").$type<"posted" | "missed">().notNull(),
}, (t) => ({
  outcomeValid: check("vehicle_wipe_announcements_outcome_valid", sql`${t.outcome} IN ('posted','missed')`),
}));
```

- [ ] **Step 2: Generate the migration**

```bash
cd packages/db && npx drizzle-kit generate && cd ../..
```

- [ ] **Step 3: Read the generated SQL and check the journal**

```bash
cat packages/db/migrations/0033_*.sql
python3 -c "import json; j=json.load(open('packages/db/migrations/meta/_journal.json')); \
print(len(j['entries'])); print(j['entries'][-2]['when'], j['entries'][-1]['when']); \
print('increasing:', j['entries'][-1]['when'] > j['entries'][-2]['when'])"
```

Expected: a single `CREATE TABLE` with the CHECK constraint, no `DROP` or `ALTER` of any
existing table, and `increasing: True`.

⚠️ If `increasing` is False, fix the new entry's `when` to exceed the previous one by
hand — drizzle-kit will otherwise silently apply nothing while reporting success.

- [ ] **Step 4: Verify the migration applies to a fresh test database**

```bash
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  TEST_DATABASE_FRESH=1 npx vitest run --root packages/db
```

Expected: PASS. (`TEST_DATABASE_FRESH=1` must be passed to `vitest` directly — turbo does
not forward it.)

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations
git commit -m "feat(db): vehicle_wipe_announcements, keyed on the wipe slot alone"
```

---

### Task 4: The announcement text

**Files:**
- Create: `apps/bot/src/announce-text.ts`
- Test: `apps/bot/test/announce-text.test.ts`

**Interfaces:**
- Consumes: `WipeVehicle` from `@factions/domain`.
- Produces: `weeklyWipeAnnouncement(vehicle: WipeVehicle, wipeAt: Date): string`

- [ ] **Step 1: Write the failing test**

Create `apps/bot/test/announce-text.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { weeklyWipeAnnouncement } from "../src/announce-text.js";

const OLGA = { event: "VehicleCivilianSedan", name: "Olga" };
const WIPE_AT = new Date("2026-09-14T08:00:00Z");

describe("weeklyWipeAnnouncement", () => {
  it("names the vehicle in game and its events.xml event", () => {
    const t = weeklyWipeAnnouncement(OLGA, WIPE_AT);
    expect(t).toContain("Olga");
    expect(t).toContain("VehicleCivilianSedan");
  });

  it("gives the time in UTC, which is what the restarts are in", () => {
    expect(weeklyWipeAnnouncement(OLGA, WIPE_AT)).toContain("08:00 UTC");
  });

  // ⚠️ The one instruction a player can act on. Losing it makes the notice decorative.
  it("tells players to clear their gear out first", () => {
    expect(weeklyWipeAnnouncement(OLGA, WIPE_AT).toLowerCase()).toMatch(/move|take|empty/);
  });

  it("fits in a Discord message", () => {
    expect(weeklyWipeAnnouncement(OLGA, WIPE_AT).length).toBeLessThan(2000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx vitest run --root apps/bot test/announce-text.test.ts
```

Expected: FAIL — `Failed to load url ../src/announce-text.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/bot/src/announce-text.ts`:

```ts
import type { WipeVehicle } from "@factions/domain";

/**
 * The Sunday notice. Plain content, no embed — it is one short sentence of fact, and
 * the other plain-text poster (#war-log) is the house precedent for that.
 */
export function weeklyWipeAnnouncement(vehicle: WipeVehicle, wipeAt: Date): string {
  const hh = String(wipeAt.getUTCHours()).padStart(2, "0");
  const mm = String(wipeAt.getUTCMinutes()).padStart(2, "0");
  return [
    `🚗 **Weekly vehicle wipe — tomorrow, ${hh}:${mm} UTC**`,
    `This week it's **${vehicle.name}** (\`${vehicle.event}\`). Every one on the map is `
      + `cleared at the ${hh}:${mm} restart and respawns fresh a couple of hours later.`,
    `Move anything you want to keep out of them before then.`,
  ].join("\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx vitest run --root apps/bot test/announce-text.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/announce-text.ts apps/bot/test/announce-text.test.ts
git commit -m "feat(bot): weekly vehicle wipe announcement copy"
```

---

### Task 5: The announce tick

**Files:**
- Create: `apps/bot/src/announce-tick.ts`
- Test: `apps/bot/test/announce-tick.test.ts`

**Interfaces:**
- Consumes: `wipeMondayFor`, `announceAtFor`, `weeklyWipeVehicle`, `ANNOUNCE_CUTOFF_MS` from `@factions/domain`; `weeklyWipeAnnouncement` from `./announce-text.js`; `vehicleWipeAnnouncements` from `@factions/db`.
- Produces:
  - `export type AnnouncePoster = (content: string) => Promise<void>`
  - `export type AnnounceTickResult = { posted: number; missed: number; failed: number }`
  - `export async function announceTick(db, post, opts: { now: Date; offHour: number; onError?: (err: unknown) => void }): Promise<AnnounceTickResult>`

- [ ] **Step 1: Write the failing tests**

Create `apps/bot/test/announce-tick.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, vehicleWipeAnnouncements, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { announceTick } from "../src/announce-tick.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);

describe("announceTick", () => {
  let db: Database;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table vehicle_wipe_announcements`);
  });
  const rows = () => db.select().from(vehicleWipeAnnouncements);

  it("posts at the announce moment, naming this week's vehicle", async () => {
    const post = vi.fn(async () => {});
    const r = await announceTick(db, post, { now: at("2026-09-13T08:00:01Z"), offHour: 8 });
    expect(r).toEqual({ posted: 1, missed: 0, failed: 0 });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]).toContain("Olga");
    expect(await rows()).toMatchObject([
      { wipeAt: at("2026-09-14T08:00:00Z"), eventName: "VehicleCivilianSedan", outcome: "posted" },
    ]);
  });

  it("posts exactly once, however many ticks run", async () => {
    const post = vi.fn(async () => {});
    await announceTick(db, post, { now: at("2026-09-13T08:00:01Z"), offHour: 8 });
    await announceTick(db, post, { now: at("2026-09-13T08:00:11Z"), offHour: 8 });
    await announceTick(db, post, { now: at("2026-09-13T20:00:00Z"), offHour: 8 });
    expect(post).toHaveBeenCalledTimes(1);
    expect(await rows()).toHaveLength(1);
  });

  it("stays silent before the announce moment", async () => {
    const post = vi.fn(async () => {});
    const r = await announceTick(db, post, { now: at("2026-09-13T07:59:00Z"), offHour: 8 });
    expect(r).toEqual({ posted: 0, missed: 0, failed: 0 });
    expect(post).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });

  // ⚠️ Catch-up: a bot that was down all Sunday morning should still give notice.
  it("catches up late on the Sunday", async () => {
    const post = vi.fn(async () => {});
    const r = await announceTick(db, post, { now: at("2026-09-13T20:00:00Z"), offHour: 8 });
    expect(r.posted).toBe(1);
  });

  // ⚠️ ...but a notice that lands after the wipe tells players a wipe is coming that
  // already took their car. Past the cutoff, record it and say nothing.
  it("records missed past the cutoff, without posting", async () => {
    const post = vi.fn(async () => {});
    const r = await announceTick(db, post, { now: at("2026-09-14T07:30:00Z"), offHour: 8 });
    expect(r).toEqual({ posted: 0, missed: 1, failed: 0 });
    expect(post).not.toHaveBeenCalled();
    expect(await rows()).toMatchObject([{ outcome: "missed" }]);
  });

  it("does not re-announce the wipe currently in progress", async () => {
    const post = vi.fn(async () => {});
    const r = await announceTick(db, post, { now: at("2026-09-14T09:00:00Z"), offHour: 8 });
    // 09:00 Monday: the coming wipe is NEXT Monday, whose announce moment is days away.
    expect(r).toEqual({ posted: 0, missed: 0, failed: 0 });
    expect(post).not.toHaveBeenCalled();
  });

  // ⚠️ Post-then-insert: a row written first would record an announcement that never
  // went out. No row means the next tick retries, which is the direction this repo picks.
  it("writes no row when the post fails, so the next tick retries", async () => {
    const bad = vi.fn(async () => { throw new Error("discord down"); });
    const onError = vi.fn();
    const r = await announceTick(db, bad, { now: at("2026-09-13T08:00:01Z"), offHour: 8, onError });
    expect(r).toEqual({ posted: 0, missed: 0, failed: 1 });
    expect(await rows()).toEqual([]);
    expect(onError).toHaveBeenCalled();

    const good = vi.fn(async () => {});
    const again = await announceTick(db, good, { now: at("2026-09-13T08:05:00Z"), offHour: 8 });
    expect(again.posted).toBe(1);
    expect(await rows()).toHaveLength(1);
  });

  // ⚠️ The spec asks for "two servers produce one message". `announceTick` takes no
  // server input at all and never queries `servers`, so a two-server test would assert
  // nothing. The guarantee lives in the schema instead — `wipe_at` is the whole primary
  // key — and this is the test that would fail if a `server_id` were ever added to it.
  it("keys the row on the wipe slot alone, so a second call for that week cannot insert", async () => {
    const post = vi.fn(async () => {});
    await announceTick(db, post, { now: at("2026-09-13T08:00:01Z"), offHour: 8 });
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(Object.keys(all[0]!)).not.toContain("serverId");
  });

  it("advances to the next week once this week's row exists", async () => {
    const post = vi.fn(async () => {});
    await announceTick(db, post, { now: at("2026-09-13T08:00:01Z"), offHour: 8 });
    await announceTick(db, post, { now: at("2026-09-20T08:00:01Z"), offHour: 8 });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]![0]).toContain("Gunter");
    expect(await rows()).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx vitest run --root apps/bot test/announce-tick.test.ts
```

Expected: FAIL — `Failed to load url ../src/announce-tick.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/bot/src/announce-tick.ts`:

```ts
import { eq } from "drizzle-orm";
import { vehicleWipeAnnouncements, type Database } from "@factions/db";
import { wipeMondayFor, announceAtFor, weeklyWipeVehicle, ANNOUNCE_CUTOFF_MS } from "@factions/domain";
import { weeklyWipeAnnouncement } from "./announce-text.js";

export type AnnouncePoster = (content: string) => Promise<void>;
export type AnnounceTickResult = { posted: number; missed: number; failed: number };

/**
 * Announce the coming Monday's vehicle wipe, once, a day ahead.
 *
 * ⚠️ POST first, row second — the house rule from every poster here. A row written
 * first records an announcement that never went out if the post then fails; the reverse
 * costs at most a duplicate message after a crash between the two, which is the
 * direction this repo chooses everywhere (see notice-tick.ts).
 */
export async function announceTick(
  db: Database,
  post: AnnouncePoster,
  opts: { now: Date; offHour: number; onError?: (err: unknown) => void },
): Promise<AnnounceTickResult> {
  const out: AnnounceTickResult = { posted: 0, missed: 0, failed: 0 };

  const wipeAt = wipeMondayFor(opts.now, opts.offHour);
  if (opts.now < announceAtFor(wipeAt)) return out; // too early — nothing to do yet

  const [handled] = await db.select({ wipeAt: vehicleWipeAnnouncements.wipeAt })
    .from(vehicleWipeAnnouncements).where(eq(vehicleWipeAnnouncements.wipeAt, wipeAt)).limit(1);
  if (handled) return out;

  const vehicle = weeklyWipeVehicle(wipeAt);

  // ⚠️ Past the cutoff the notice would describe a wipe that is effectively already
  // here. Record it so the next tick does not keep trying, and stay silent.
  if (opts.now.getTime() >= wipeAt.getTime() - ANNOUNCE_CUTOFF_MS) {
    await db.insert(vehicleWipeAnnouncements)
      .values({ wipeAt, announcedAt: opts.now, eventName: vehicle.event, outcome: "missed" })
      .onConflictDoNothing();
    out.missed++;
    return out;
  }

  try {
    await post(weeklyWipeAnnouncement(vehicle, wipeAt));
  } catch (err) {
    // No row: the next tick retries until the cutoff closes the window.
    opts.onError?.(err);
    out.failed++;
    return out;
  }

  await db.insert(vehicleWipeAnnouncements)
    .values({ wipeAt, announcedAt: opts.now, eventName: vehicle.event, outcome: "posted" })
    .onConflictDoNothing();
  out.posted++;
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx vitest run --root apps/bot test/announce-tick.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/announce-tick.ts apps/bot/test/announce-tick.test.ts
git commit -m "feat(bot): weekly wipe announce tick, post-then-mark with a cutoff"
```

---

### Task 6: Config and wiring

**Files:**
- Modify: `apps/bot/src/config.ts`
- Modify: `apps/bot/src/discord.ts`
- Test: `apps/bot/test/config.test.ts`, `apps/bot/test/restart-wiring.test.ts`

**Interfaces:**
- Consumes: `announceTick`, `createChannelPoster` (already exported from `discord.ts`).
- Produces: `Config.truckWipe.rotation: boolean`, `Config.announcementsChannelId?: string`.

- [ ] **Step 1: Write the failing config tests**

Append inside the `describe("TRUCK_WIPE", …)` block in `apps/bot/test/config.test.ts`:

```ts
    it("leaves the rotation off by default", () => {
      expect(loadConfig({ ...ON }).truckWipe.rotation).toBe(false);
    });

    it("turns the rotation on with WEEKLY_VEHICLE_WIPE", () => {
      expect(loadConfig({ ...ON, WEEKLY_VEHICLE_WIPE: "1" }).truckWipe.rotation).toBe(true);
      expect(loadConfig({ ...ON, WEEKLY_VEHICLE_WIPE: "true" }).truckWipe.rotation).toBe(true);
    });

    // ⚠️ The rotation rides on the restart slots. Configured without them nothing would
    // ever fire it — no error, no log, just a wipe that never happens.
    it("refuses the rotation without RESTART_SCHEDULE", () => {
      expect(() => loadConfig({ ...OK, WEEKLY_VEHICLE_WIPE: "1" })).toThrow(/RESTART_SCHEDULE/u);
    });

    // ⚠️ Independently switchable: the daily truck wipe and the weekly rotation must
    // each be able to run with the other off.
    it("runs the rotation with no daily truck events", () => {
      const c = loadConfig({ ...ON, WEEKLY_VEHICLE_WIPE: "1" });
      expect(c.truckWipe.events).toEqual([]);
      expect(c.truckWipe.rotation).toBe(true);
    });

    it("reads the announcements channel, and leaves it undefined when unset", () => {
      expect(loadConfig({ ...ON }).announcementsChannelId).toBeUndefined();
      expect(loadConfig({ ...ON, ANNOUNCEMENTS_CHANNEL_ID: "123456789012345678" })
        .announcementsChannelId).toBe("123456789012345678");
    });

    it("rejects a malformed announcements channel id", () => {
      expect(() => loadConfig({ ...ON, ANNOUNCEMENTS_CHANNEL_ID: "not-an-id" }))
        .toThrow(/ANNOUNCEMENTS_CHANNEL_ID/u);
    });
```

- [ ] **Step 2: Write the failing wiring tests**

Append to `apps/bot/test/restart-wiring.test.ts`:

```ts
  it("runs the announce tick in the loop, in its own try/catch", () => {
    expect(src).toMatch(/import \{ announceTick[^}]*\} from "\.\/announce-tick\.js"/u);
    expect(src).toMatch(/await announceTick\(db, announcePoster, \{ now: new Date\(\), offHour: cfg\.truckWipe\.offHour/u);
  });

  // ⚠️ Same reason the wipe logs its own state: an unannounced wipe and a broken
  // announcer are indistinguishable from the journal otherwise.
  it("says at startup whether the rotation and the announcements channel are on", () => {
    expect(src).toMatch(/WEEKLY_VEHICLE_WIPE is off/u);
    expect(src).toMatch(/ANNOUNCEMENTS_CHANNEL_ID is unset/u);
  });
```

- [ ] **Step 3: Run both suites to verify they fail**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx vitest run --root apps/bot test/config.test.ts test/restart-wiring.test.ts
```

Expected: FAIL — `rotation` undefined, `announcementsChannelId` undefined, and the
`src` regexes unmatched.

- [ ] **Step 4: Implement the config**

In `apps/bot/src/config.ts`, extend the `Config` type:

```ts
  truckWipe: { events: string[]; offHour: number; onHour: number; rotation: boolean };
  /** Where the weekly wipe notice posts. Unset = the wipe still happens, silently. */
  announcementsChannelId?: string;
```

In the config object literal:

```ts
    truckWipe: {
      events: (env.TRUCK_WIPE_EVENTS ?? "").split(",").map((e) => e.trim()).filter((e) => e !== ""),
      offHour: wipeHour(env, "TRUCK_WIPE_OFF_HOUR", 8),
      onHour: wipeHour(env, "TRUCK_WIPE_ON_HOUR", 10),
      rotation: ["1", "true"].includes((env.WEEKLY_VEHICLE_WIPE ?? "").toLowerCase()),
    },
    announcementsChannelId: optionalSnowflake(env, "ANNOUNCEMENTS_CHANNEL_ID"),
```

Extend the existing `RESTART_SCHEDULE` guard so it covers the rotation too:

```ts
  // ⚠️ Both halves ride on the restart tick's slots. Configured without the schedule
  // neither would ever fire at all — no error, no log, just a wipe that never happens.
  if ((config.truckWipe.events.length > 0 || config.truckWipe.rotation) && !config.restartSchedule) {
    throw new Error("TRUCK_WIPE_EVENTS or WEEKLY_VEHICLE_WIPE is set but RESTART_SCHEDULE is off — both run on the restart slots, so nothing would ever fire them.");
  }
```

- [ ] **Step 5: Implement the wiring**

In `apps/bot/src/discord.ts`, add the import beside the restart-tick one:

```ts
import { announceTick } from "./announce-tick.js";
```

Beside the other posters (near `warLogPoster`):

```ts
  const announcePoster = cfg.announcementsChannelId ? createChannelPoster(client, cfg.announcementsChannelId) : null;
```

Immediately after the `restartTick` block in the loop:

```ts
    // ⚠️ After the restart tick, for the same reason the restart tick runs last: a slow
    // Discord call must not delay a due restart. Its own try/catch, like every step.
    if (cfg.truckWipe.rotation && announcePoster) {
      try {
        const a = await announceTick(db, announcePoster, {
          now: new Date(), offHour: cfg.truckWipe.offHour,
          onError: (err) => console.error("weekly wipe announcement failed; will retry until the cutoff", err),
        });
        if (a.posted + a.missed > 0) console.log(`announce: ${a.posted} posted, ${a.missed} missed`);
      } catch (err) {
        console.error("announce tick failed", err);
      }
    }
```

In the startup block, after the truck-wipe lines:

```ts
    if (!cfg.truckWipe.rotation) console.warn("WEEKLY_VEHICLE_WIPE is off: no weekly vehicle rotation.");
    else console.log(`weekly vehicle rotation on: ${WEEKLY_WIPE_VEHICLES.map((v) => v.name).join(" → ")}`);
    if (!cfg.announcementsChannelId) console.warn("ANNOUNCEMENTS_CHANNEL_ID is unset: wipes happen without notice.");
```

Add `WEEKLY_WIPE_VEHICLES` to the existing `@factions/domain` import in `discord.ts`.

- [ ] **Step 6: Run both suites to verify they pass**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx vitest run --root apps/bot test/config.test.ts test/restart-wiring.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run the full gate**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx turbo run typecheck test --concurrency=1 --force
```

Expected: **26/26 tasks, 0 cached.**

- [ ] **Step 8: Commit**

```bash
git add apps/bot/src/config.ts apps/bot/src/discord.ts apps/bot/test/config.test.ts apps/bot/test/restart-wiring.test.ts
git commit -m "feat(bot): wire the weekly rotation and its announcement"
```

---

### Task 7: Docs and runbook

**Files:**
- Modify: `apps/bot/README.md`, `CLAUDE.md`
- Create: `docs/deploy/2026-09-12-weekly-vehicle-rotation.md`

- [ ] **Step 1: Add the env rows to `apps/bot/README.md`**

After the `TRUCK_WIPE_ON_HOUR` row:

```markdown
| `WEEKLY_VEHICLE_WIPE` | no (default off; `"1"`/`"true"` = on) | Wipe one of five vehicles each Monday, rotating weekly: Olga → Gunter → Hummer → Ada → Sarka. Uses the same window as `TRUCK_WIPE_OFF_HOUR`/`ON_HOUR`. Requires `RESTART_SCHEDULE`; independent of `TRUCK_WIPE_EVENTS`. Runbook `docs/deploy/2026-09-12-weekly-vehicle-rotation.md`. |
| `ANNOUNCEMENTS_CHANNEL_ID` | no (default unset = silent) | Channel for the Sunday 24h-ahead notice naming the coming week's vehicle. Unset means the wipe still happens with no announcement; startup says so. |
```

- [ ] **Step 2: Add the CLAUDE.md table row and lock-order note**

In the lock-order invariant, extend the sentence that exempts `server_restarts`:

```markdown
`server_restarts` and `vehicle_wipe_announcements` are outside the order: each written by
one tick alone, with a single statement, touching no other table.
```

Then add the table row:

After the daily-truck-wipe row:

```markdown
| The weekly vehicle rotation | `rotationActiveFor()`/`weeklyWipeVehicle()` in `packages/domain/src/restarts.ts` (list and anchor in `rules.ts`), applied by `applyTruckWipe` in `apps/bot/src/restart-tick.ts`; the Sunday notice is `apps/bot/src/announce-tick.ts` + `announce-text.ts` over `vehicle_wipe_announcements` (migration 0033). Gated on `WEEKLY_VEHICLE_WIPE` + `ANNOUNCEMENTS_CHANNEL_ID`. ⚠️ The rotation is **derived from the calendar, never stored**, so the announcement and the wipe cannot disagree; and **all five converge every slot**, or a bot down across a Monday 10:00 strands that week's vehicle at `active=0` forever. ⚠️ `vehicle_wipe_announcements` is keyed on `wipe_at` ALONE — no `server_id`, or one message posts per server. Runbook `docs/deploy/2026-09-12-weekly-vehicle-rotation.md` |
```

- [ ] **Step 3: Write the runbook**

Create `docs/deploy/2026-09-12-weekly-vehicle-rotation.md`:

```markdown
# The weekly rotating vehicle wipe — runbook

Every Monday at `TRUCK_WIPE_OFF_HOUR` (08:00 UTC) one vehicle type is wiped alongside the
daily trucks and comes back at `TRUCK_WIPE_ON_HOUR` (10:00). Which one rotates weekly
through five, and the coming week's is announced 24 hours ahead.

Spec `docs/superpowers/specs/2026-09-12-weekly-vehicle-rotation-design.md`. Rides on the
slots from `docs/deploy/2026-09-12-scheduled-restarts.md`; shares the window with
`docs/deploy/2026-09-12-truck-wipe.md`.

## The rotation

| Wipe Monday 08:00Z | Vehicle | events.xml event | Announced Sunday 08:00Z |
|---|---|---|---|
| 2026-09-14 | Olga | `VehicleCivilianSedan` | 2026-09-13 |
| 2026-09-21 | Gunter | `VehicleHatchback02` | 2026-09-20 |
| 2026-09-28 | Hummer | `VehicleOffroad02` | 2026-09-27 |
| 2026-10-05 | Ada | `VehicleOffroadHatchback` | 2026-10-04 |
| 2026-10-12 | Sarka | `VehicleSedan02` | 2026-10-11 |
| 2026-10-19 | Olga | — wraps | 2026-10-18 |

⚠️ Derived from the calendar, never stored. `ROTATION_ANCHOR_MS` in
`packages/domain/src/rules.ts` is what phases it; moving that constant re-phases every
week, including ones already announced. It is an anchor, not a start date to keep current.

⚠️ A week the bot sleeps through is skipped, not owed. The vehicle is a function of the
date.

## Before you start

1. Confirm all five event names exist in the live file. A name that is absent throws every
   slot — logged, restart unaffected, wipe silently does not happen.

       grep -oE '<event name="Vehicle[^"]*"' events.xml

2. Confirm the bot can post in the announcements channel: it needs **View Channel** and
   **Send Messages** there. A missing permission makes every Sunday tick fail and retry
   until the cutoff, then record `missed`.

## Steps

1. **Apply migration 0033** before the new code starts — nothing applies migrations here.
   Use the one-off runner from `docs/deploy/2026-09-02-dormancy.md`. It is additive (a new
   table only), so the bot does not need stopping, but confirm the count afterwards:

       select count(*) from __drizzle_migrations;   -- expect 33

2. **Deploy the code dark** (`WEEKLY_VEHICLE_WIPE` unset):

       cd /opt/clan-wars && git pull --ff-only && sudo systemctl restart clan-wars-bot

   The journal shows `WEEKLY_VEHICLE_WIPE is off` and `ANNOUNCEMENTS_CHANNEL_ID is unset`.

3. **Set the channel first, the wipe second.** In `.env`:

       ANNOUNCEMENTS_CHANNEL_ID=<channel id>
       WEEKLY_VEHICLE_WIPE=1

   Then `sudo systemctl restart clan-wars-bot`. The journal must show BOTH:

       weekly vehicle rotation on: Olga → Gunter → Hummer → Ada → Sarka
       truck wipe on: VehicleTruck01 off at 08:00Z, back on at 10:00Z

## Verifying

- **The Sunday message** lands in the channel at 08:00 UTC naming the right vehicle for
  the table above. It posts exactly once; a bot restart does not repeat it.
- **The Monday file diff**: download `<mission>/db/events.xml` before 08:00 and after, and
  confirm exactly TWO `<active>` digits changed — `VehicleTruck01` and that week's
  vehicle. Everything else, comments included, is byte-identical.
- **The Monday 10:00 restore** puts both back to `1`.
- **Convergence**: on any ordinary slot the bot writes nothing (`no upload` in the
  journal), because the file already holds the wanted state.

## Rolling back

Remove `WEEKLY_VEHICLE_WIPE` from `.env` and restart. The bot stops touching the five
rotation events immediately, leaving them as they are.

⚠️ Rolling back between 08:00 and 10:00 on a Monday leaves that week's vehicle at
`<active>0</active>` and nothing will restore it — set it back to `1` by hand.

Removing only `ANNOUNCEMENTS_CHANNEL_ID` stops the notices and leaves the wipe running,
which is a legitimate state; startup says so every restart.
```

- [ ] **Step 4: Commit**

```bash
git add apps/bot/README.md CLAUDE.md docs/deploy/2026-09-12-weekly-vehicle-rotation.md
git commit -m "docs: weekly vehicle rotation runbook and env table"
```

---

## Verification before deploy

- [ ] Full gate green: **26/26, 0 cached.**
- [ ] `weeklyWipeVehicle(new Date("2026-09-14T08:00:00Z")).name === "Olga"`.
- [ ] Against the live `events.xml`, confirm all five event names are present before enabling:
      `grep -oE '<event name="Vehicle[^"]*"' events.xml`.
