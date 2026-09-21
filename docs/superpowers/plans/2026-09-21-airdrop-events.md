# Airdrop events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the hand-enabled Livonia airdrop into an automatic event: the bot picks a location and colour when the server is genuinely busy, announces the location before a restart, enables that spawner for exactly one two-hour session, and takes it away again.

**Architecture:** Two ticks over one new table. `airdrop-tick.ts` decides and announces at T-30min before a restart slot; `restart-tick.ts` enables and disables by splicing `WorldsData.objectSpawnersArr` in `cfggameplay.json` — sharing the single download/upload the raid-window flip already makes on that file each slot. Every decision that can be pure is pure and lives in `packages/domain/src/airdrops.ts`.

**Tech Stack:** TypeScript, pnpm workspace + turbo, vitest, drizzle-orm over postgres.js, discord.js, Nitrado file API.

**Spec:** `docs/superpowers/specs/2026-09-20-airdrop-events-design.md` (amended 2026-09-21, commit `81bec14`)

## Global Constraints

- **One read-modify-write of `cfggameplay.json` per slot, shared with the raid flip** (spec §5). Two independent download/upload pairs mean the second upload silently discards the first's edit.
- **Spawner file names are `./custom/airdrop-<location>-<colour>.json`** — location then colour. The match token is `/airdrop-`.
- **The 16 locations, exactly:** `airfield bielawa brena dolnik gieraltow gliniska grabin lukow nadbor polana sarnowek sitnik sobotka tarnow topolin zalesie`.
- **The 3 colours, exactly:** `blue orange yellow`.
- **A drop is never enabled without a posted announcement** (spec §9). The gate is `announced_at is not null`, never the state alone.
- **Nothing here may block, delay or cancel a restart** (spec §9). Every airdrop step sits inside its own try/catch under the restart tick's outer one.
- **Every guard in a `cfggameplay.json` edit throws rather than writing.** Refusing costs one event; a file that does not parse costs every player the server itself.
- **Player-facing copy carries no em dashes** and never discourages raiding.
- **`AIRDROP_WEEKLY_CAP` is a cap, never a quota** (spec §3.2). A dead week gets zero drops.
- **Every PR adds a committed entry under `## [Unreleased]` in `CHANGELOG.md`.**
- **The gate, always with `--force`:** `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force` — expect **30/30 tasks**.
- **Never point anything at `factions_live`.** Tests derive `factions_test_<package>` from the base URL on their own.

---

### Task 1: The pure decisions (`packages/domain`)

**Files:**
- Create: `packages/domain/src/airdrops.ts`
- Modify: `packages/domain/src/rules.ts` (append the constants)
- Modify: `packages/domain/src/index.ts` (one export line)
- Test: `packages/domain/test/airdrops.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AIRDROP_LOCATIONS: readonly string[]`, `AIRDROP_COLOURS: readonly string[]`, `AIRDROP_NO_REPEAT: number`, `AIRDROP_DECIDE_LEAD_MS: number`, `AIRDROP_MIN_GAP_MS: number`, `AIRDROP_HISTORY_MS: number`, `type AirdropSpec = { location: string; colour: string }`, `airdropSpawnerPath(spec: AirdropSpec): string`, `chooseAirdrop(recentLocations: string[], rng: () => number): AirdropSpec`, `p90(values: number[]): number`, `type FireInput`, `shouldFire(i: FireInput): boolean`, `isoWeekStart(now: Date): Date`, `decisionInstantFor(slotStart: Date): Date`.

- [ ] **Step 1: Write the failing test**

Create `packages/domain/test/airdrops.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  AIRDROP_COLOURS, AIRDROP_LOCATIONS, AIRDROP_MIN_GAP_MS, AIRDROP_NO_REPEAT,
  airdropSpawnerPath, chooseAirdrop, decisionInstantFor, isoWeekStart, p90, shouldFire,
} from "../src/airdrops";

const at = (iso: string) => new Date(iso);
const fire = (over: Partial<Parameters<typeof shouldFire>[0]> = {}) => shouldFire({
  pop: 6, threshold: 5, minPop: 5, weekCount: 0, weeklyCap: 2,
  lastFireAt: null, openEvent: false, now: at("2026-09-21T19:30:00Z"), ...over,
});

describe("the menu", () => {
  it("is the 16 staged locations and 3 colours, and nothing else", () => {
    expect(AIRDROP_LOCATIONS).toHaveLength(16);
    expect(AIRDROP_COLOURS).toEqual(["blue", "orange", "yellow"]);
  });

  // ⚠️ location THEN colour. The spec's first draft had them the other way round,
  // which names 48 files that do not exist — and the miss is silent: the file is
  // registered, the server boots, and no container ever spawns.
  it("names the spawner file location-then-colour", () => {
    expect(airdropSpawnerPath({ location: "dolnik", colour: "blue" }))
      .toBe("./custom/airdrop-dolnik-blue.json");
  });
});

describe("chooseAirdrop", () => {
  it("never repeats a location inside the no-repeat window", () => {
    const recent = AIRDROP_LOCATIONS.slice(0, AIRDROP_NO_REPEAT);
    for (let i = 0; i < 200; i++) {
      const spec = chooseAirdrop([...recent], () => i / 200);
      expect(recent).not.toContain(spec.location);
      expect(AIRDROP_COLOURS).toContain(spec.colour);
    }
  });

  // ⚠️ A window longer than the menu would otherwise empty the pool and throw on
  // an undefined index — a crash in the one tick that is supposed to be optional.
  it("falls back to the full menu rather than emptying the pool", () => {
    const spec = chooseAirdrop([...AIRDROP_LOCATIONS], () => 0);
    expect(AIRDROP_LOCATIONS).toContain(spec.location);
  });
});

describe("p90", () => {
  it("interpolates, and is 0 on no history", () => {
    expect(p90([])).toBe(0);
    expect(p90([1, 1, 1, 1, 1, 1, 1, 1, 1, 10])).toBeCloseTo(1.9, 5);
    expect(p90([5])).toBe(5);
  });
});

describe("shouldFire", () => {
  it("fires at a real peak", () => expect(fire()).toBe(true));
  it("holds the floor when the percentile has collapsed", () =>
    expect(fire({ pop: 3, threshold: 2 })).toBe(false));
  it("holds the percentile once the server has grown past the floor", () =>
    expect(fire({ pop: 6, threshold: 8 })).toBe(false));
  // ⚠️ §3.2: a cap, never a quota. A quiet week gets zero drops, on purpose.
  it("refuses once the week's cap is spent", () =>
    expect(fire({ weekCount: 2 })).toBe(false));
  it("refuses inside the 24h gap and allows just outside it", () => {
    expect(fire({ lastFireAt: at("2026-09-21T02:00:00Z") })).toBe(false);
    expect(fire({ lastFireAt: new Date(at("2026-09-21T19:30:00Z").getTime() - AIRDROP_MIN_GAP_MS - 1) })).toBe(true);
  });
  it("refuses while another drop is announced or live", () =>
    expect(fire({ openEvent: true })).toBe(false));
});

describe("the calendar", () => {
  it("starts the ISO week on Monday 00:00 UTC", () => {
    expect(isoWeekStart(at("2026-09-21T19:30:00Z")).toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(isoWeekStart(at("2026-09-20T23:59:59Z")).toISOString()).toBe("2026-09-14T00:00:00.000Z");
  });
  it("puts the decision 30 minutes before the slot", () => {
    expect(decisionInstantFor(at("2026-09-21T20:00:00Z")).toISOString()).toBe("2026-09-21T19:30:00.000Z");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd packages/domain && npx vitest run test/airdrops.test.ts`
Expected: FAIL — `Failed to resolve import "../src/airdrops"`.

- [ ] **Step 3: Add the constants to `rules.ts`**

Append to `packages/domain/src/rules.ts`, matching the file's existing comment density:

```ts
/**
 * The 16 Livonia locations with a staged locked-container spawner, and the three
 * colours each is staged in (spec §1).
 *
 * ⚠️ A literal list, deliberately, not a directory read: the bot runs nowhere near
 * the mission tree, and a location named here that has no staged file registers a
 * spawner the server silently ignores. Adding a location means staging three files
 * in the `livonia` repo FIRST.
 */
export const AIRDROP_LOCATIONS = [
  "airfield", "bielawa", "brena", "dolnik", "gieraltow", "gliniska", "grabin", "lukow",
  "nadbor", "polana", "sarnowek", "sitnik", "sobotka", "tarnow", "topolin", "zalesie",
] as const;

export const AIRDROP_COLOURS = ["blue", "orange", "yellow"] as const;

/** How many recent locations are excluded from the draw (spec §3.3). */
export const AIRDROP_NO_REPEAT = 5;

/** How long before a restart slot the decision is taken (spec §3.1). */
export const AIRDROP_DECIDE_LEAD_MS = 30 * 60 * 1000;

/** Minimum gap between two drops (spec §3.1). */
export const AIRDROP_MIN_GAP_MS = 24 * 60 * 60 * 1000;

/** How far back the trailing percentile looks (spec §3.1). */
export const AIRDROP_HISTORY_MS = 14 * 24 * 60 * 60 * 1000;
```

- [ ] **Step 4: Write `packages/domain/src/airdrops.ts`**

```ts
import {
  AIRDROP_COLOURS, AIRDROP_DECIDE_LEAD_MS, AIRDROP_HISTORY_MS, AIRDROP_LOCATIONS,
  AIRDROP_MIN_GAP_MS, AIRDROP_NO_REPEAT,
} from "./rules";
export {
  AIRDROP_COLOURS, AIRDROP_DECIDE_LEAD_MS, AIRDROP_HISTORY_MS, AIRDROP_LOCATIONS,
  AIRDROP_MIN_GAP_MS, AIRDROP_NO_REPEAT,
};

export type AirdropSpec = { location: string; colour: string };

/**
 * The spawner file a spec names, as `objectSpawnersArr` spells it.
 *
 * ⚠️ Location THEN colour, and the `./custom/` prefix is part of it. The one
 * statement of this fact: `setAirdropSpawner` matches on the `/airdrop-` in it,
 * and a file name assembled a second way somewhere else would register a path the
 * server ignores in silence — no error, no log, no container.
 */
export function airdropSpawnerPath(spec: AirdropSpec): string {
  return `./custom/airdrop-${spec.location}-${spec.colour}.json`;
}

/**
 * Pick a location and a colour (spec §3.3). Uniform across the 16 less the last
 * `AIRDROP_NO_REPEAT` used, and uniform across the three colours.
 *
 * ⚠️ The fallback to the full menu is not defensive padding: a no-repeat window
 * at or above the menu size empties the pool, and an empty pool indexes undefined
 * and throws inside the decision tick.
 */
export function chooseAirdrop(recentLocations: string[], rng: () => number): AirdropSpec {
  const recent = new Set(recentLocations.slice(0, AIRDROP_NO_REPEAT));
  const pool = AIRDROP_LOCATIONS.filter((l) => !recent.has(l));
  const locations: readonly string[] = pool.length > 0 ? pool : AIRDROP_LOCATIONS;
  const location = locations[Math.floor(rng() * locations.length)]!;
  const colour = AIRDROP_COLOURS[Math.floor(rng() * AIRDROP_COLOURS.length)]!;
  return { location, colour };
}

/**
 * Linear-interpolated 90th percentile.
 *
 * ⚠️ Computed here rather than with Postgres `percentile_cont` so the threshold the
 * row records and the threshold the rule applies are one statement, and so this can
 * be tested without a database. No history returns 0, which leaves
 * `max(AIRDROP_MIN_POP, p90)` at the floor — the correct behaviour on day one.
 */
export function p90(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = 0.9 * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo]! + (s[hi]! - s[lo]!) * (idx - lo);
}

export type FireInput = {
  /** Players online at the decision instant. */
  pop: number;
  /** p90 of the trailing 14 days of decision-instant pops. */
  threshold: number;
  minPop: number;
  /** Drops decided this ISO week, `failed` rows excluded — the budget is refunded. */
  weekCount: number;
  weeklyCap: number;
  lastFireAt: Date | null;
  /** Any row still `announced` or `live`. */
  openEvent: boolean;
  now: Date;
};

/** Spec §3.1. All four conditions, in the order that makes a refusal cheapest to read. */
export function shouldFire(i: FireInput): boolean {
  if (i.openEvent) return false;
  if (i.weekCount >= i.weeklyCap) return false;
  if (i.lastFireAt && i.now.getTime() - i.lastFireAt.getTime() < AIRDROP_MIN_GAP_MS) return false;
  return i.pop >= Math.max(i.minPop, i.threshold);
}

/** Monday 00:00 UTC of `now`'s ISO week. */
export function isoWeekStart(now: Date): Date {
  const utc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const backToMonday = (new Date(utc).getUTCDay() + 6) % 7;
  return new Date(utc - backToMonday * 24 * 60 * 60 * 1000);
}

/** The instant a slot's decision is taken: `AIRDROP_DECIDE_LEAD_MS` before it. */
export function decisionInstantFor(slotStart: Date): Date {
  return new Date(slotStart.getTime() - AIRDROP_DECIDE_LEAD_MS);
}
```

Add to `packages/domain/src/index.ts`, beside the `restarts` and `raid-window` lines:

```ts
export * from "./airdrops";
```

- [ ] **Step 5: Run the tests**

Run: `cd packages/domain && npx vitest run test/airdrops.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/airdrops.ts packages/domain/src/rules.ts packages/domain/src/index.ts packages/domain/test/airdrops.test.ts
git commit -m "feat(airdrops): the pure decisions - menu, draw, percentile and trigger"
```

---

### Task 2: The `cfggameplay.json` splice

**Files:**
- Modify: `apps/bot/src/cfggameplay.ts` (append; `setBaseDamageDisabled` is untouched)
- Test: `apps/bot/test/cfggameplay.test.ts` (append a second `describe`)

**Interfaces:**
- Consumes: `AirdropSpec`, `airdropSpawnerPath` (Task 1).
- Produces: `setAirdropSpawner(json: string, spec: AirdropSpec | null): { json: string; changed: boolean }`.

- [ ] **Step 1: Write the failing test**

Append to `apps/bot/test/cfggameplay.test.ts` (the file already reads `fixtures/cfggameplay.json` into `REAL`, whose `objectSpawnersArr` holds four non-airdrop entries):

```ts
import { setAirdropSpawner } from "../src/cfggameplay.js";

const DOLNIK = { location: "dolnik", colour: "blue" };
const spawners = (json: string) => JSON.parse(json).WorldsData.objectSpawnersArr as string[];

describe("setAirdropSpawner", () => {
  it("adds the spawner and leaves the other four alone", () => {
    const { json, changed } = setAirdropSpawner(REAL, DOLNIK);
    expect(changed).toBe(true);
    expect(spawners(json)).toEqual([
      "./custom/airdrop-dolnik-blue.json",
      "./custom/admin-castle.json",
      "./custom/bunker-enhancements.json",
      "./custom/faction-supplies.json",
      "./custom/teleports.json",
    ]);
  });

  it("⚠️ changes NOTHING outside the array — every other byte is identical", () => {
    const { json } = setAirdropSpawner(REAL, DOLNIK);
    expect(json.replace('\t\t\t"./custom/airdrop-dolnik-blue.json",\n', "")).toBe(REAL);
  });

  it("round-trips: add then remove returns the original bytes", () => {
    const on = setAirdropSpawner(REAL, DOLNIK).json;
    expect(setAirdropSpawner(on, null).json).toBe(REAL);
  });

  it("swaps one drop for another without stacking them", () => {
    const on = setAirdropSpawner(REAL, DOLNIK).json;
    const { json } = setAirdropSpawner(on, { location: "nadbor", colour: "yellow" });
    expect(spawners(json).filter((e) => e.includes("/airdrop-")))
      .toEqual(["./custom/airdrop-nadbor-yellow.json"]);
  });

  // ⚠️ The only-element case is the one that breaks a naive line delete: removing
  // the last entry leaves the previous line's comma in front of `]`, which is a
  // file that does not parse — the exact failure that stops the server booting.
  it("removes a drop that is the only element without stranding a comma", () => {
    const empty = REAL.replace(/("objectSpawnersArr"\s*:\s*\[)[^\]]*(\])/, "$1\n$2");
    const one = setAirdropSpawner(empty, DOLNIK).json;
    expect(spawners(one)).toEqual(["./custom/airdrop-dolnik-blue.json"]);
    const off = setAirdropSpawner(one, null);
    expect(spawners(off.json)).toEqual([]);
    expect(off.json).toBe(empty);
  });

  it("reports changed=false and returns the input untouched when already correct", () => {
    expect(setAirdropSpawner(REAL, null)).toEqual({ json: REAL, changed: false });
    const on = setAirdropSpawner(REAL, DOLNIK).json;
    expect(setAirdropSpawner(on, DOLNIK)).toEqual({ json: on, changed: false });
  });

  it("throws on input that does not parse", () => {
    expect(() => setAirdropSpawner("{ nope", DOLNIK)).toThrow(/did not parse/);
  });

  it("throws when objectSpawnersArr is missing or not an array of strings", () => {
    expect(() => setAirdropSpawner(JSON.stringify({ WorldsData: {} }), DOLNIK)).toThrow(/objectSpawnersArr/);
    expect(() => setAirdropSpawner(JSON.stringify({ WorldsData: { objectSpawnersArr: [1] } }), DOLNIK)).toThrow(/objectSpawnersArr/);
  });

  // ⚠️ Two live drops is a state the bot never creates, so reaching it means a hand
  // edit or a half-applied write. Guessing which to remove could take away the one
  // players were told about and leave the other standing.
  it("throws on two airdrop entries rather than guessing which is live", () => {
    const two = setAirdropSpawner(setAirdropSpawner(REAL, DOLNIK).json, DOLNIK).json
      .replace('"./custom/admin-castle.json"', '"./custom/airdrop-lukow-orange.json"');
    expect(() => setAirdropSpawner(two, null)).toThrow(/2×|two/i);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd apps/bot && npx vitest run test/cfggameplay.test.ts`
Expected: FAIL — `setAirdropSpawner` is not exported.

- [ ] **Step 3: Implement it**

Append to `apps/bot/src/cfggameplay.ts`:

```ts
import { airdropSpawnerPath, type AirdropSpec } from "@factions/domain";

/** The array body, bounded by its own brackets. Textual, like KEY_RE above. */
const SPAWNERS_RE = /("objectSpawnersArr"\s*:\s*\[)([^\]]*)(\])/g;
/** What marks an element as this feature's — see `airdropSpawnerPath`. */
const AIRDROP_MARK = "/airdrop-";

/** Is this array-body line an element, rather than the blank after `[` or the indent before `]`? */
const isEntry = (line: string) => line.trim().startsWith('"');

/**
 * Set which airdrop spawner, if any, `WorldsData.objectSpawnersArr` registers,
 * returning the new document and whether anything actually changed.
 *
 * ⚠️ A targeted splice, NEVER a parse-and-reserialize, for the reason
 * `setBaseDamageDisabled` gives above: the live file is tab-indented with a
 * specific key order, and a round trip rewrites all 4,450 bytes. Only the lines
 * inside this one array are touched; every byte outside comes back identical.
 *
 * ⚠️ Same refuse-rather-than-guess discipline, and for the same reason: this is
 * the file whose corruption stops the server BOOTING, for every player. Refusing
 * costs one event; the next slot recomputes and retries.
 */
export function setAirdropSpawner(json: string, spec: AirdropSpec | null): { json: string; changed: boolean } {
  let input: unknown;
  try {
    input = JSON.parse(json);
  } catch (err) {
    throw new Error(`cfggameplay.json: input did not parse — refusing to edit it (${(err as Error).message})`);
  }

  // ⚠️ The parsed array is the authority on the current state, never the regex:
  // the regex finds bytes to splice and cannot tell WorldsData's key from one that
  // has drifted elsewhere in the file.
  const current = (input as { WorldsData?: { objectSpawnersArr?: unknown } })?.WorldsData?.objectSpawnersArr;
  if (!Array.isArray(current) || current.some((e) => typeof e !== "string")) {
    throw new Error(
      "cfggameplay.json: WorldsData.objectSpawnersArr is missing or is not an array of strings — " +
        "refusing to guess where the list the server reads went",
    );
  }

  const present = (current as string[]).filter((e) => e.includes(AIRDROP_MARK));
  if (present.length > 1) {
    throw new Error(
      `cfggameplay.json: objectSpawnersArr registers ${present.length}× airdrop spawners — ` +
        "refusing to guess which one is live",
    );
  }

  const wanted = spec ? airdropSpawnerPath(spec) : null;
  if ((present[0] ?? null) === wanted) return { json, changed: false };

  const matches = [...json.matchAll(SPAWNERS_RE)];
  if (matches.length !== 1) {
    throw new Error(
      `cfggameplay.json: "objectSpawnersArr" appears ${matches.length}× — ` +
        "refusing to guess which one the server reads",
    );
  }

  const m = matches[0]!;
  const [, head, body, tail] = m as unknown as [string, string, string, string];
  const lines = body.split("\n");
  const kept = lines.filter((l) => !l.includes(AIRDROP_MARK));
  const firstEntry = kept.findIndex(isEntry);
  const indent = (kept.find(isEntry) ?? '\t\t\t"').match(/^\s*/)![0];

  let next = kept;
  if (wanted) {
    const line = `${indent}"${wanted}"`;
    next = firstEntry === -1
      // An empty array: the new element is the only one, and the blank line after
      // `[` plus the indent before `]` are all that is around it.
      ? [kept[0] ?? "", line, kept[kept.length - 1] ?? ""]
      : [...kept.slice(0, firstEntry), line, ...kept.slice(firstEntry)];
  }

  // ⚠️ Commas are rebuilt across the element lines, not left where they fell.
  // Deleting the LAST element otherwise leaves the one before it ending in `,`
  // directly in front of `]` — a file that does not parse, which is exactly the
  // failure this whole module exists to avoid.
  const entries = next.filter(isEntry);
  let seen = 0;
  const rebuilt = next.map((l) => {
    if (!isEntry(l)) return l;
    seen += 1;
    return l.replace(/,\s*$/, "") + (seen < entries.length ? "," : "");
  });

  const from = m.index!;
  const nextJson = json.slice(0, from) + head + rebuilt.join("\n") + tail + json.slice(from + m[0].length);

  // ⚠️ Guard 2, not redundant with the parse above, and it is the same one
  // setBaseDamageDisabled carries: parsing proves the file is loadable, and only
  // reading the value back proves the edit did what it meant to.
  let parsed: unknown;
  try {
    parsed = JSON.parse(nextJson);
  } catch (err) {
    throw new Error(`cfggameplay.json: the edit produced a file that does not parse (${(err as Error).message})`);
  }
  const got = (parsed as { WorldsData?: { objectSpawnersArr?: string[] } })?.WorldsData?.objectSpawnersArr ?? [];
  const after = got.filter((e) => e.includes(AIRDROP_MARK));
  if (after.length !== (wanted ? 1 : 0) || (wanted && after[0] !== wanted)) {
    throw new Error(
      `cfggameplay.json: after the edit objectSpawnersArr holds ${JSON.stringify(after)}, ` +
        `not ${wanted ? JSON.stringify([wanted]) : "[]"} — the array that was edited is not the one the server reads`,
    );
  }

  return { json: nextJson, changed: true };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/bot && npx vitest run test/cfggameplay.test.ts`
Expected: PASS — the existing `setBaseDamageDisabled` tests plus 9 new ones.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/cfggameplay.ts apps/bot/test/cfggameplay.test.ts
git commit -m "feat(airdrops): splice the spawner into objectSpawnersArr"
```

---

### Task 3: The state table

**Files:**
- Modify: `packages/db/src/schema.ts` (append beside `raidWindowAnnouncements`)
- Create: `packages/db/migrations/00NN_<generated>.sql` (drizzle-kit names it)
- Test: `packages/db/test/airdrop-events.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `airdropEvents` — columns `serverId`, `slotAt`, `location`, `colour`, `decidedAt`, `popAtDecision`, `threshold`, `state`, `announcedAt`, `endedAt`, `detail`; primary key `(serverId, slotAt)`.

- [ ] **Step 1: Write the failing test**

Create `packages/db/test/airdrop-events.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, airdropEvents, servers, type Database } from "../src/index";
import { sql } from "drizzle-orm";

const URL = requireTestDatabaseUrl();

describe("airdrop_events", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table airdrop_events, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "A", map: "livonia", clockOffsetMs: 0, active: true }).returning();
    serverId = s!.id;
  });

  const row = (over: Record<string, unknown> = {}) => ({
    serverId, slotAt: new Date("2026-09-21T20:00:00Z"), location: "dolnik", colour: "blue",
    decidedAt: new Date("2026-09-21T19:30:00Z"), popAtDecision: 6, threshold: "5", state: "announced" as const, ...over,
  });

  it("holds one row per server per slot", async () => {
    await db.insert(airdropEvents).values(row());
    await expect(db.insert(airdropEvents).values(row({ location: "lukow" }))).rejects.toThrow();
  });

  it("refuses a state outside the four", async () => {
    await expect(db.insert(airdropEvents).values(row({ state: "pending" }))).rejects.toThrow();
  });

  it("refuses a colour outside the three", async () => {
    await expect(db.insert(airdropEvents).values(row({ colour: "green" }))).rejects.toThrow();
  });

  it("defaults to a non-manual drop", async () => {
    await db.insert(airdropEvents).values(row());
    expect((await db.select().from(airdropEvents))[0]!.manual).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd packages/db && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/airdrop-events.test.ts`
Expected: FAIL — `airdropEvents` is not exported.

- [ ] **Step 3: Add the table**

Append to `packages/db/src/schema.ts`, after `raidWindowAnnouncements`:

```ts
/**
 * One airdrop event per restart slot (spec §7).
 *
 * ⚠️ Per-server keyed, following `server_restarts` rather than
 * `vehicle_wipe_announcements`: a drop is a file on one mission, and two servers
 * would each need their own.
 *
 * ⚠️ `threshold` is STORED, never recomputed. The row records what was decided at
 * the time; recomputing it later against a grown population would make the record
 * lie about why the event fired.
 *
 * ⚠️ `announced_at` is the enable gate, not `state`. Spec §9: with only the
 * location announced and no in-world marker, an unannounced drop is one nobody
 * ever finds — strictly worse than no drop, because it spends a week's budget on
 * nothing. A row that is `announced` with a null `announced_at` has been decided
 * and not yet posted, and must never be enabled.
 */
export const airdropEvents = pgTable("airdrop_events", {
  serverId: integer("server_id").notNull().references(() => servers.id),
  /** The restart slot the drop goes live at. */
  slotAt: timestamp("slot_at", { withTimezone: true }).notNull(),
  location: text("location").notNull(),
  colour: text("colour").$type<"blue" | "orange" | "yellow">().notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
  popAtDecision: integer("pop_at_decision").notNull(),
  threshold: numeric("threshold").notNull(),
  state: text("state").$type<"announced" | "live" | "ended" | "failed">().notNull(),
  /**
   * Placed by an admin with `/airdrop place`, not by the trigger.
   *
   * ⚠️ A manual drop is excluded from the WEEKLY CAP only (§3.1's second
   * condition). It still holds the 24h gap and the nothing-announced-or-live
   * guard shut, because those two are about the players' experience of the
   * event, not about the budget: two drops in an evening reads as noise
   * whoever asked for them, and two at once is a state the file cannot hold.
   */
  manual: boolean("manual").notNull().default(false),
  announcedAt: timestamp("announced_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  detail: jsonb("detail").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
}, (t) => ({
  pk: primaryKey({ columns: [t.serverId, t.slotAt] }),
  stateValid: check("airdrop_events_state_valid", sql`${t.state} IN ('announced','live','ended','failed')`),
  colourValid: check("airdrop_events_colour_valid", sql`${t.colour} IN ('blue','orange','yellow')`),
}));
```

- [ ] **Step 4: Generate and read the migration**

Run: `cd packages/db && npx drizzle-kit generate`
Then **read the generated SQL** (`packages/db/migrations/00NN_*.sql`) and confirm it only creates `airdrop_events`, its primary key, its `manual` default and its two checks. Anything else in that file is a schema drift someone else left behind — stop and ask before continuing.

- [ ] **Step 5: Run the tests**

Run: `cd packages/db && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/airdrop-events.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations packages/db/test/airdrop-events.test.ts
git commit -m "feat(airdrops): the airdrop_events state table"
```

---

### Task 4: One read-modify-write of cfggameplay.json

**Files:**
- Modify: `apps/bot/src/restart-tick.ts` (`applyRaidWindow` becomes `applyGameplay`; its call site changes)
- Test: `apps/bot/test/raid-window-flip.test.ts` (existing tests must stay green), `apps/bot/test/restart-tick.test.ts` (one new composition test)

This task changes no behaviour on its own. It is the structural precondition for Task 5, and it ships separately so a reviewer can reject the refactor without rejecting the feature.

**Interfaces:**
- Consumes: `setBaseDamageDisabled`, `setAirdropSpawner` (Task 2), `raidWindowAt`.
- Produces:
```ts
export type GameplayEdits = {
  raidWindow?: { skips: SkippedWindow[] };
  airdrop?: { wanted: AirdropSpec | null };
};
export type GameplayResult = {
  flip?: RaidFlip;
  flipError?: Error;
  airdrop?: { wanted: AirdropSpec | null; changed: boolean };
  airdropError?: Error;
};
export async function applyGameplay(
  nitrado: RestartTarget, slot: Date, edits: GameplayEdits,
): Promise<GameplayResult>;
```

- [ ] **Step 1: Write the failing test**

Add to `apps/bot/test/restart-tick.test.ts`, in its own `describe`:

```ts
import { applyGameplay } from "../src/restart-tick.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const GAMEPLAY = readFileSync(join(__dirname, "fixtures/cfggameplay.json"), "utf8");

/** A Nitrado that serves one cfggameplay.json and records what is written back. */
function fakeGameplayHost(content = GAMEPLAY) {
  let stored = content;
  const uploadFile = vi.fn(async (_dir: string, _name: string, body: string) => { stored = body; });
  const downloadFile = vi.fn(async () => stored);
  const target = {
    status: vi.fn(async () => "started"), restart: vi.fn(async () => {}),
    missionDbDir: vi.fn(async () => "/db"), missionRootDir: vi.fn(async () => "/mission"),
    downloadFile, uploadFile,
  } as unknown as RestartTarget;
  return { target, downloadFile, uploadFile, read: () => stored };
}

describe("applyGameplay", () => {
  // ⚠️ THE test for this task. Two independent download/upload pairs on the same
  // file in the same slot means the second upload silently discards the first's
  // edit: a raid weekend that never opens, or a drop that never lands, with every
  // guard passing and nothing logged.
  it("carries both edits in ONE download and ONE upload", async () => {
    const host = fakeGameplayHost();
    const out = await applyGameplay(host.target, at("2026-09-18T02:00:00Z"), {
      raidWindow: { skips: [] },
      airdrop: { wanted: { location: "dolnik", colour: "blue" } },
    });
    expect(host.downloadFile).toHaveBeenCalledTimes(1);
    expect(host.uploadFile).toHaveBeenCalledTimes(1);
    const after = JSON.parse(host.read());
    expect(after.GeneralData.disableBaseDamage).toBe(out.flip!.wantedDisabled);
    expect(after.WorldsData.objectSpawnersArr).toContain("./custom/airdrop-dolnik-blue.json");
  });

  it("uploads nothing when neither edit changes anything", async () => {
    const host = fakeGameplayHost();
    await applyGameplay(host.target, at("2026-09-16T02:00:00Z"), { airdrop: { wanted: null } });
    expect(host.uploadFile).not.toHaveBeenCalled();
  });

  it("downloads nothing when neither feature is configured", async () => {
    const host = fakeGameplayHost();
    const out = await applyGameplay(host.target, at("2026-09-16T02:00:00Z"), {});
    expect(host.downloadFile).not.toHaveBeenCalled();
    expect(out).toEqual({});
  });

  // ⚠️ One refusal must not take the other feature down with it. A raid weekend is
  // worth more than a drop, and a drop is worth more than nothing.
  it("still applies and uploads the raid flip when the airdrop splice refuses", async () => {
    const twoDrops = GAMEPLAY.replace(
      '"./custom/admin-castle.json"',
      '"./custom/airdrop-lukow-blue.json",\n\t\t\t"./custom/airdrop-nadbor-blue.json"',
    );
    const host = fakeGameplayHost(twoDrops);
    const out = await applyGameplay(host.target, at("2026-09-18T02:00:00Z"), {
      raidWindow: { skips: [] }, airdrop: { wanted: null },
    });
    expect(out.airdropError).toBeInstanceOf(Error);
    expect(out.flip!.changed).toBe(true);
    expect(host.uploadFile).toHaveBeenCalledTimes(1);
    expect(JSON.parse(host.read()).GeneralData.disableBaseDamage).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd apps/bot && npx vitest run test/restart-tick.test.ts -t applyGameplay`
Expected: FAIL — `applyGameplay` is not exported.

- [ ] **Step 3: Replace `applyRaidWindow` with `applyGameplay`**

In `apps/bot/src/restart-tick.ts`, replace the whole `applyRaidWindow` function (keeping `RaidFlip` and the `GAMEPLAY_FILE` constant as they are) with:

```ts
export type GameplayEdits = {
  /** Present when RAID_WINDOW_TICK is on. */
  raidWindow?: { skips: SkippedWindow[] };
  /** Present when AIRDROP_TICK is on. `wanted` is the drop this slot should register, or null for none. */
  airdrop?: { wanted: AirdropSpec | null };
};

export type GameplayResult = {
  flip?: RaidFlip;
  flipError?: Error;
  airdrop?: { wanted: AirdropSpec | null; changed: boolean };
  airdropError?: Error;
};

/**
 * Bring one server's cfggameplay.json to the state `slot` wants — both the raid
 * window's `GeneralData.disableBaseDamage` and the airdrop's entry in
 * `WorldsData.objectSpawnersArr` — immediately before its restart.
 *
 * ⚠️ ONE download and ONE upload, for BOTH features (spec §5). They edit the same
 * file on the same slot; two independent download/upload pairs mean whichever
 * uploads second silently discards the other's edit, with every guard passing and
 * nothing logged. That is the entire reason this function exists rather than two.
 *
 * ⚠️ Level-triggered, exactly like applyTruckWipe. Every slot recomputes both
 * wanted values, so a bot down across Friday 00:00 opens the window LATE rather
 * than not at all, and a lost, hand-reverted or FTP-deploy-clobbered write is
 * corrected within two hours (spec §6).
 *
 * ⚠️ Each splice is attempted in its OWN try/catch and its refusal is RETURNED,
 * never thrown. A guard rejecting the airdrop must not cost the raid weekend, and
 * vice versa; the caller records each outcome against its own feature's rows.
 */
export async function applyGameplay(
  nitrado: RestartTarget, slot: Date, edits: GameplayEdits,
): Promise<GameplayResult> {
  if (!edits.raidWindow && !edits.airdrop) return {};

  const dir = await nitrado.missionRootDir();
  const original = await nitrado.downloadFile(`${dir}/${GAMEPLAY_FILE}`);
  const out: GameplayResult = {};
  let json = original;

  if (edits.raidWindow) {
    const state = raidWindowAt(slot, edits.raidWindow.skips);
    try {
      const r = setBaseDamageDisabled(json, state.baseDamageDisabled);
      json = r.json;
      // ⚠️ state.boundaryAt, never a local derivation. The announcer and the
      // website key their confirmation lookups on the same field; deriving it here
      // independently is how the writer and the readers ended up disagreeing about
      // midweek instants.
      out.flip = {
        boundaryAt: state.boundaryAt, wantedDisabled: state.baseDamageDisabled,
        changed: r.changed, previousContent: original,
      };
    } catch (err) {
      out.flipError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (edits.airdrop) {
    try {
      const r = setAirdropSpawner(json, edits.airdrop.wanted);
      json = r.json;
      out.airdrop = { wanted: edits.airdrop.wanted, changed: r.changed };
    } catch (err) {
      out.airdropError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (json !== original) await nitrado.uploadFile(dir, GAMEPLAY_FILE, json);
  return out;
}
```

Add the imports at the top of the file:

```ts
import { setAirdropSpawner, setBaseDamageDisabled } from "./cfggameplay.js";
import { ..., type AirdropSpec } from "@factions/domain";
```

- [ ] **Step 4: Update the call site**

Inside `restartTick`, in the `if (opts.raidWindow?.enabled)` block, replace

```ts
            flip = await applyRaidWindow(nitrado, slot.start, skips);
```

with

```ts
            const gameplay = await applyGameplay(nitrado, slot.start, { raidWindow: { skips } });
            if (gameplay.flipError) throw gameplay.flipError;
            flip = gameplay.flip;
```

⚠️ Rethrowing here keeps this task behaviour-preserving: the existing `catch` below writes the `refused` row exactly as it did before. Task 5 replaces this block outright.

- [ ] **Step 5: Run the tests**

Run: `cd apps/bot && npx vitest run test/restart-tick.test.ts test/raid-window-flip.test.ts`
Expected: PASS — every existing raid-window test, plus the 4 new `applyGameplay` tests.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/restart-tick.ts apps/bot/test/restart-tick.test.ts
git commit -m "refactor(restart): one cfggameplay.json read-modify-write per slot"
```

---

### Task 5: Enable and disable at the slot

**Files:**
- Modify: `apps/bot/src/restart-tick.ts`
- Test: `apps/bot/test/airdrop-flip.test.ts` (new file, beside `raid-window-flip.test.ts`)

**Interfaces:**
- Consumes: `applyGameplay` (Task 4), `airdropEvents` (Task 3).
- Produces: `restartTick`'s `opts` gains `airdrop?: { enabled: boolean }`; `restartMessage(location: string | null): string` replaces the `RESTART_MESSAGE` constant (which stays exported, as the no-drop value, because tests and the runbook name it).

- [ ] **Step 1: Write the failing test**

Create `apps/bot/test/airdrop-flip.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, airdropEvents, servers, type Database } from "@factions/db";
import { eq, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { restartTick, restartMessage, type RestartTarget } from "../src/restart-tick.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const SLOT = at("2026-09-21T20:00:00Z");
const GAMEPLAY = readFileSync(join(__dirname, "fixtures/cfggameplay.json"), "utf8");

function host(content = GAMEPLAY) {
  let stored = content;
  const restart = vi.fn(async () => {});
  const target = {
    status: vi.fn(async () => "started"), restart,
    missionDbDir: vi.fn(async () => "/db"), missionRootDir: vi.fn(async () => "/mission"),
    downloadFile: vi.fn(async () => stored),
    uploadFile: vi.fn(async (_d: string, _n: string, b: string) => { stored = b; }),
  } as unknown as RestartTarget;
  return { target, restart, spawners: () => JSON.parse(stored).WorldsData.objectSpawnersArr as string[] };
}

describe("the airdrop at the slot", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table airdrop_events, server_restarts, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "R", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 7, active: true }).returning();
    serverId = s!.id;
  });

  const decide = (over: Record<string, unknown> = {}) => db.insert(airdropEvents).values({
    serverId, slotAt: SLOT, location: "dolnik", colour: "blue", decidedAt: at("2026-09-21T19:30:00Z"),
    popAtDecision: 6, threshold: "5", state: "announced", announcedAt: at("2026-09-21T19:30:01Z"), ...over,
  });
  const state = async () => (await db.select().from(airdropEvents).where(eq(airdropEvents.slotAt, SLOT)))[0];

  it("registers the spawner at the slot and marks the row live", async () => {
    await decide();
    const h = host();
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    expect(h.spawners()).toContain("./custom/airdrop-dolnik-blue.json");
    expect((await state())!.state).toBe("live");
  });

  it("takes it away at the next slot and marks the row ended", async () => {
    await decide({ state: "live" });
    const h = host();
    await restartTick(db, () => h.target, { now: at("2026-09-21T22:00:03Z"), airdrop: { enabled: true } });
    expect(h.spawners().filter((e) => e.includes("/airdrop-"))).toEqual([]);
    expect((await state())!.state).toBe("ended");
    expect((await state())!.endedAt).not.toBeNull();
  });

  // ⚠️ Spec §9: a drop nobody was told about is strictly worse than no drop.
  it("never enables a row whose announcement has not posted", async () => {
    await decide({ announcedAt: null });
    const h = host();
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    expect(h.spawners().filter((e) => e.includes("/airdrop-"))).toEqual([]);
    expect((await state())!.state).toBe("announced");
  });

  // ⚠️ Level-triggered (spec §6): this is what survives the livonia FTP deploy
  // clobbering the file mid-event.
  it("puts a drop back that something else removed, while its session is running", async () => {
    await decide({ state: "live" });
    const h = host();
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    expect(h.spawners()).toContain("./custom/airdrop-dolnik-blue.json");
  });

  it("carries the location in the in-game restart warning, and only for that slot", async () => {
    await decide();
    const h = host();
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    expect(h.restart).toHaveBeenCalledWith(restartMessage("dolnik"));
    expect(restartMessage("dolnik")).toContain("Dolnik");
    expect(restartMessage(null)).toBe("Scheduled restart");
  });

  // ⚠️ Spec §9: nothing here may cost the restart.
  it("restarts anyway when the splice refuses, and records the refusal", async () => {
    await decide();
    const twoDrops = GAMEPLAY.replace(
      '"./custom/admin-castle.json"',
      '"./custom/airdrop-lukow-blue.json",\n\t\t\t"./custom/airdrop-nadbor-blue.json"',
    );
    const h = host(twoDrops);
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    expect(h.restart).toHaveBeenCalled();
    const row = (await state())!;
    expect(row.state).toBe("announced");
    expect(row.detail.enableAttempts).toBe(1);
  });

  it("scrubs the drop after two failed enables and refunds the budget", async () => {
    await decide({ detail: { enableAttempts: 1 } });
    const twoDrops = GAMEPLAY.replace(
      '"./custom/admin-castle.json"',
      '"./custom/airdrop-lukow-blue.json",\n\t\t\t"./custom/airdrop-nadbor-blue.json"',
    );
    const h = host(twoDrops);
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    expect((await state())!.state).toBe("failed");
  });

  it("does nothing at all when the flag is off", async () => {
    await decide();
    const h = host();
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z") });
    expect(h.spawners().filter((e) => e.includes("/airdrop-"))).toEqual([]);
    expect((await state())!.state).toBe("announced");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd apps/bot && npx vitest run test/airdrop-flip.test.ts`
Expected: FAIL — `restartMessage` is not exported.

- [ ] **Step 3: Implement the wanted-state read and the message**

In `apps/bot/src/restart-tick.ts`, add above `restartTick`:

```ts
export const RESTART_MESSAGE = "Scheduled restart";

/**
 * The in-game restart warning. When a drop goes live in the session this restart
 * opens, it says where (spec §8) — that is the half of the announcement that
 * reaches everyone who is not in Discord.
 *
 * ⚠️ Never the colour. Players are told where, never which key opens it (spec §3.4).
 */
export function restartMessage(location: string | null): string {
  if (!location) return RESTART_MESSAGE;
  const name = location.charAt(0).toUpperCase() + location.slice(1);
  return `${RESTART_MESSAGE}. Airdrop at ${name} next session.`;
}

/** How many enable attempts a drop gets before it is scrubbed (spec §9). */
const AIRDROP_MAX_ENABLE_ATTEMPTS = 2;

export type AirdropIntent = {
  /** What this slot should register, or null for none. */
  wanted: AirdropSpec | null;
  /** The row to move to `live` once the upload succeeds, if any. */
  enabling?: { slotAt: Date; location: string; attempts: number };
  /** Rows to move to `ended` once the upload succeeds. */
  ending: Date[];
};

/**
 * What the airdrop wants from this slot, read from the rows alone (spec §6:
 * level-triggered on database intent).
 *
 * ⚠️ `announced_at is not null` is part of the enable query, not a check after it.
 * A decided-but-unannounced drop must never go live — spec §9.
 */
async function airdropIntent(db: Database, serverId: number, slot: Date): Promise<AirdropIntent> {
  const open = await db.select().from(airdropEvents).where(and(
    eq(airdropEvents.serverId, serverId),
    inArray(airdropEvents.state, ["announced", "live"]),
  ));

  const live = open.find((r) => r.state === "live" && r.slotAt.getTime() === slot.getTime());
  const enabling = open.find((r) =>
    r.state === "announced" && r.announcedAt !== null && r.slotAt.getTime() <= slot.getTime());
  // Anything live from an earlier slot has had its session and is over.
  const ending = open.filter((r) => r.state === "live" && r.slotAt.getTime() < slot.getTime()).map((r) => r.slotAt);

  // ⚠️ `live` wins over `enabling`: a drop already live for THIS slot is being
  // re-converged (the FTP-clobber repair), not enabled a second time.
  const holder = live ?? enabling ?? null;
  return {
    wanted: holder ? { location: holder.location, colour: holder.colour } : null,
    enabling: enabling && !live
      ? { slotAt: enabling.slotAt, location: enabling.location, attempts: Number(enabling.detail.enableAttempts ?? 0) }
      : undefined,
    ending,
  };
}
```

Add `airdropEvents` to the `@factions/db` import and `inArray` to the drizzle import.

- [ ] **Step 4: Wire it into `restartTick`**

Replace the `if (opts.raidWindow?.enabled) { … }` block's body so both features share one `applyGameplay` call. The shape:

```ts
      let flip: RaidFlip | undefined;
      let raidBoundaryAt: Date | undefined;
      let intent: AirdropIntent | undefined;
      let airdropLocation: string | null = null;
      try {
        const edits: GameplayEdits = {};
        let state: ReturnType<typeof raidWindowAt> | undefined;
        if (opts.raidWindow?.enabled) {
          const skips = await db.select({ opensAt: raidWindowSkips.opensAt, reason: raidWindowSkips.reason })
            .from(raidWindowSkips);
          state = raidWindowAt(slot.start, skips);
          raidBoundaryAt = state.boundaryAt;
          edits.raidWindow = { skips };
        }
        if (opts.airdrop?.enabled) {
          intent = await airdropIntent(db, s.id, slot.start);
          edits.airdrop = { wanted: intent.wanted };
          // ⚠️ The message is settled BEFORE the upload, and names the drop this
          // slot is bringing up. A drop being taken away must not be advertised.
          airdropLocation = intent.enabling?.location ?? intent.wanted?.location ?? null;
        }

        const gameplay = await applyGameplay(nitrado, slot.start, edits);

        // …the existing raid-window bookkeeping, unchanged, using gameplay.flip and
        // gameplay.flipError in place of the old try/catch around applyRaidWindow…

        if (opts.airdrop?.enabled && intent) {
          // ⚠️ Its own try/catch: airdrop bookkeeping must never cost the raid
          // window's, nor the restart below.
          try {
            if (gameplay.airdropError) {
              const attempts = (intent.enabling?.attempts ?? 0) + 1;
              const detail = { enableAttempts: attempts, error: gameplay.airdropError.message };
              console.error(`airdrop: server ${s.id} REFUSED the splice for slot ${slot.start.toISOString()} — restarting anyway`, gameplay.airdropError);
              if (intent.enabling) {
                await db.update(airdropEvents).set({
                  // ⚠️ Two attempts and it scrubs (spec §9): a failed enable costs one
                  // event, and a row left `announced` forever would hold the "nothing
                  // announced or live" guard shut and stop the feature dead.
                  ...(attempts >= AIRDROP_MAX_ENABLE_ATTEMPTS ? { state: "failed" as const, endedAt: opts.now } : {}),
                  detail,
                }).where(and(eq(airdropEvents.serverId, s.id), eq(airdropEvents.slotAt, intent.enabling.slotAt)));
              }
              airdropLocation = null;
            } else {
              if (intent.enabling) {
                await db.update(airdropEvents).set({ state: "live" })
                  .where(and(eq(airdropEvents.serverId, s.id), eq(airdropEvents.slotAt, intent.enabling.slotAt)));
                console.log(`airdrop: server ${s.id} enabled ${intent.wanted!.location}/${intent.wanted!.colour} for ${slot.start.toISOString()}`);
              }
              for (const slotAt of intent.ending) {
                await db.update(airdropEvents).set({ state: "ended", endedAt: opts.now })
                  .where(and(eq(airdropEvents.serverId, s.id), eq(airdropEvents.slotAt, slotAt)));
                console.log(`airdrop: server ${s.id} ended the drop from ${slotAt.toISOString()}`);
              }
            }
          } catch (err) {
            // ⚠️ Swallowed, like the raid window's: the upload already happened, and a
            // throw here would abort the slot's server_restarts row and make the next
            // pass restart the server a second time. A `live` row that failed to become
            // `ended` is retried at the next slot, which is why the disable never gives up.
            console.error(`airdrop: server ${s.id} could not record the slot ${slot.start.toISOString()}`, err);
          }
        }
      } catch (err) {
        console.error(`restart: server ${s.id} could not evaluate cfggameplay.json for slot ${slot.start.toISOString()} — restarting anyway`, err);
      }

      await nitrado.restart(restartMessage(airdropLocation));
```

Add `airdrop?: { enabled: boolean }` to `restartTick`'s `opts` type.

- [ ] **Step 5: Run the tests**

Run: `cd apps/bot && npx vitest run test/airdrop-flip.test.ts test/restart-tick.test.ts test/raid-window-flip.test.ts`
Expected: PASS — the 8 new tests and every existing restart and raid-window test.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/restart-tick.ts apps/bot/test/airdrop-flip.test.ts
git commit -m "feat(airdrops): enable at the slot, disable at the next"
```

---

### Task 6: The decision tick and the announcement

**Files:**
- Create: `apps/bot/src/airdrop-text.ts`
- Create: `apps/bot/src/airdrop-tick.ts`
- Test: `apps/bot/test/airdrop-tick.test.ts`

**Interfaces:**
- Consumes: `chooseAirdrop`, `shouldFire`, `p90`, `isoWeekStart`, `decisionInstantFor`, `nextRestartAt`, `AIRDROP_HISTORY_MS` (Task 1); `airdropEvents` (Task 3).
- Produces: `airdropText(location: string, slotAt: Date): string`, `scrubText(location: string): string`, `airdropTick(db, post: (content: string) => Promise<void>, opts: { now: Date; weeklyCap: number; minPop: number; rng?: () => number }): Promise<{ decided: number; posted: number; failed: number }>`.

- [ ] **Step 1: Write the failing test**

Create `apps/bot/test/airdrop-tick.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, admFiles, airdropEvents, events, playerSessions, servers, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { airdropTick } from "../src/airdrop-tick.js";
import { airdropText } from "../src/airdrop-text.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
/** 19:30Z: the decision instant for the 20:00Z slot. */
const NOW = at("2026-09-21T19:30:00Z");

describe("airdropTick", () => {
  let db: Database; let serverId = 0; let line = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table airdrop_events, player_sessions, events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "R", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 7, active: true }).returning();
    serverId = s!.id;
    line = 0;
    await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: at("2026-09-01T00:00:00Z"), linesIngested: 0, complete: true });
  });

  /**
   * n players online from `from` until `to` (null = still connected).
   * ⚠️ Each session needs a real connect event, the way the schema requires —
   * the same shape `online-store.test.ts`'s `mkSession` uses.
   */
  async function online(n: number, from: string, to: string | null) {
    const [file] = await db.select({ id: admFiles.id }).from(admFiles);
    for (let i = 0; i < n; i++) {
      const [e] = await db.insert(events).values({
        serverId, admFileId: file!.id, lineIndex: line++, type: "player.connected" as never,
        occurredAt: at(from), payload: {},
      }).returning({ id: events.id });
      await db.insert(playerSessions).values({
        serverId, dayzId: `p${from}-${i}`, connectedAt: at(from), connectEventId: e!.id,
        disconnectedAt: to ? at(to) : null, closeReason: to ? "disconnect" : null,
      });
    }
  }

  const rows = () => db.select().from(airdropEvents);
  const run = (post: (c: string) => Promise<void>, over = {}) =>
    airdropTick(db, post, { now: NOW, weeklyCap: 2, minPop: 5, rng: () => 0, ...over });

  it("decides and announces at a real peak", async () => {
    await online(6, "2026-09-21T18:00:00Z", null);
    const post = vi.fn(async () => {});
    const r = await run(post);
    expect(r).toEqual({ decided: 1, posted: 1, failed: 0 });
    const [row] = await rows();
    expect(row).toMatchObject({ slotAt: at("2026-09-21T20:00:00Z"), state: "announced", popAtDecision: 6 });
    expect(row!.announcedAt).not.toBeNull();
    expect(post).toHaveBeenCalledWith(expect.stringContaining(row!.location.charAt(0).toUpperCase() + row!.location.slice(1)));
    // ⚠️ The colour is the gamble (spec §3.4) — it must not be in the message.
    expect(post.mock.calls[0]![0]).not.toContain(row!.colour);
  });

  it("does nothing before the decision instant", async () => {
    await online(9, "2026-09-21T18:00:00Z", null);
    const r = await run(vi.fn(async () => {}), { now: at("2026-09-21T19:00:00Z") });
    expect(r.decided).toBe(0);
    expect(await rows()).toHaveLength(0);
  });

  it("does not fire below the floor", async () => {
    await online(3, "2026-09-21T18:00:00Z", null);
    expect((await run(vi.fn(async () => {}))).decided).toBe(0);
  });

  // ⚠️ Spec §9: an unannounced drop is never enabled, and its budget comes back.
  it("marks the row failed and refunds the budget when the post fails", async () => {
    await online(6, "2026-09-21T18:00:00Z", null);
    const r = await run(vi.fn(async () => { throw new Error("channel gone"); }));
    expect(r).toEqual({ decided: 1, posted: 0, failed: 1 });
    const [row] = await rows();
    expect(row!.state).toBe("failed");
    expect(row!.announcedAt).toBeNull();
  });

  it("retries the post for a decided-but-unannounced row while the slot is still ahead", async () => {
    await online(6, "2026-09-21T18:00:00Z", null);
    await run(vi.fn(async () => { throw new Error("nope"); }));
    await db.update(airdropEvents).set({ state: "announced" });
    const post = vi.fn(async () => {});
    const r = await run(post, { now: at("2026-09-21T19:40:00Z") });
    expect(r.posted).toBe(1);
    expect(post).toHaveBeenCalled();
    expect((await rows())[0]!.announcedAt).not.toBeNull();
  });

  it("refuses a second drop inside 24 hours", async () => {
    await online(6, "2026-09-21T18:00:00Z", null);
    await run(vi.fn(async () => {}));
    await db.update(airdropEvents).set({ state: "ended" });
    const r = await run(vi.fn(async () => {}), { now: at("2026-09-22T13:30:00Z") });
    expect(r.decided).toBe(0);
  });

  // ⚠️ The whole point of the manual command: an admin drop must not eat the week.
  it("does not count a manual drop against the week's cap", async () => {
    await online(6, "2026-09-21T18:00:00Z", null);
    await db.insert(airdropEvents).values({
      serverId, slotAt: at("2026-09-19T20:00:00Z"), location: "lukow", colour: "blue",
      decidedAt: at("2026-09-19T19:30:00Z"), popAtDecision: 4, threshold: "0",
      state: "ended", manual: true, announcedAt: at("2026-09-19T19:30:01Z"),
    });
    const r = await run(vi.fn(async () => {}), { weeklyCap: 1 });
    expect(r.decided).toBe(1);
  });

  it("refuses once the week's cap is spent", async () => {
    await online(6, "2026-09-21T18:00:00Z", null);
    await run(vi.fn(async () => {}));
    await db.update(airdropEvents).set({ state: "ended" });
    const r = await run(vi.fn(async () => {}), { now: at("2026-09-23T19:30:00Z"), weeklyCap: 1 });
    expect(r.decided).toBe(0);
  });

  // ⚠️ §3.1's percentile: a peak is relative to the server's own recent peaks, and
  // the floor alone must not let a routine evening spend the week's budget.
  it("holds the percentile once the server has grown past the floor", async () => {
    // 14 days where every decision instant had 9 on: p90 is 9, and 6 is not a peak.
    for (let d = 0; d < 14; d++) {
      await online(9, `2026-09-${String(7 + d).padStart(2, "0")}T00:00:00Z`, `2026-09-${String(8 + d).padStart(2, "0")}T00:00:00Z`);
    }
    const r = await run(vi.fn(async () => {}));
    expect(r.decided).toBe(0);
  });
});

describe("airdropText", () => {
  it("names the place, counts down by itself, and says nothing about the colour", () => {
    const body = airdropText("dolnik", at("2026-09-21T20:00:00Z"));
    expect(body).toContain("Dolnik");
    expect(body).toContain(`<t:${1790020800}:R>`);
    expect(body).not.toMatch(/blue|orange|yellow/i);
    // House rule: no em dashes in player-facing copy.
    expect(body).not.toContain("—");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd apps/bot && npx vitest run test/airdrop-tick.test.ts`
Expected: FAIL — `Failed to resolve import "../src/airdrop-tick.js"`.

- [ ] **Step 3: Write `apps/bot/src/airdrop-text.ts`**

```ts
/** Discord's <t:…:R> counts down by itself, in each reader's own timezone. */
function countdown(d: Date): string {
  return `<t:${Math.floor(d.getTime() / 1000)}:R>`;
}

const place = (location: string) => location.charAt(0).toUpperCase() + location.slice(1);

/**
 * The one player-facing message, posted at decision time (spec §8).
 *
 * ⚠️ The location, never the colour. The colour is the gamble (spec §3.4), and a
 * clan holding the wrong key opening nothing is the intent, not a bug.
 *
 * ⚠️ No em dashes, and nothing that talks anybody out of going for it.
 */
export function airdropText(location: string, slotAt: Date): string {
  return [
    `**Airdrop inbound: ${place(location)}**`,
    `A locked container drops at ${place(location)} when the server comes back up, ${countdown(slotAt)}.`,
    "We are not saying which colour. Bring your keys.",
    "It is gone at the restart after that.",
  ].join("\n");
}

/** Posted when a decided drop could not be placed and has been scrubbed (spec §9). */
export function scrubText(location: string): string {
  return [
    `**The ${place(location)} drop is off.**`,
    "We could not get it placed this session. The next one still counts against nothing, so it can come any day now.",
  ].join("\n");
}
```

- [ ] **Step 4: Write `apps/bot/src/airdrop-tick.ts`**

```ts
import { airdropEvents, playerSessions, servers, type Database } from "@factions/db";
import {
  AIRDROP_HISTORY_MS, chooseAirdrop, decisionInstantFor, isoWeekStart, nextRestartAt, p90,
  RESTART_PERIOD_MS, shouldFire,
} from "@factions/domain";
import { and, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { airdropText } from "./airdrop-text.js";

export type AirdropPoster = (content: string) => Promise<void>;
export type AirdropTickResult = { decided: number; posted: number; failed: number };

/**
 * Players connected at `instant`, from the session spans (spec §2's
 * reconstruction, as a single statement per instant set).
 */
async function popsAt(db: Database, serverId: number, instants: Date[]): Promise<number[]> {
  if (instants.length === 0) return [];
  const rows = await db.execute<{ t: Date; c: number }>(sql`
    select t, (
      select count(*)::int from player_sessions s
      where s.server_id = ${serverId}
        and s.connected_at <= t
        and (s.disconnected_at is null or s.disconnected_at > t)
    ) as c
    from unnest(${sql.raw(`array[${instants.map((d) => `'${d.toISOString()}'::timestamptz`).join(",")}]`)}) as t
  `);
  return [...rows].map((r) => Number(r.c));
}

/**
 * Decide and announce (spec §3, §8). Runs every tick; does nothing until the first
 * tick at or after T-30min before a slot.
 *
 * ⚠️ Row FIRST, post second — the opposite of every other poster here, and it is
 * spec §9 that reverses it. Posting first and crashing before the row leaves a drop
 * players were told about that nothing will ever enable. Writing first and failing
 * the post leaves a row whose `announced_at` is null, which the enable query in
 * `restart-tick.ts` refuses to act on: the harmless direction.
 */
export async function airdropTick(
  db: Database, post: AirdropPoster,
  opts: { now: Date; weeklyCap: number; minPop: number; rng?: () => number },
): Promise<AirdropTickResult> {
  const out: AirdropTickResult = { decided: 0, posted: 0, failed: 0 };
  const rng = opts.rng ?? Math.random;
  const targets = await db.select({ id: servers.id }).from(servers).where(eq(servers.active, true));

  for (const s of targets) {
    try {
      const slot = nextRestartAt(opts.now);

      // 1. An earlier decision that has not been announced yet: retry the post
      //    while its slot is still ahead, and scrub it once the slot has passed.
      const pending = await db.select().from(airdropEvents).where(and(
        eq(airdropEvents.serverId, s.id), eq(airdropEvents.state, "announced"), isNull(airdropEvents.announcedAt),
      ));
      for (const row of pending) {
        if (row.slotAt.getTime() <= opts.now.getTime()) {
          // ⚠️ The slot it was for has come and gone with nobody told. Fail it and
          // refund the budget rather than announcing a drop for the wrong session.
          await db.update(airdropEvents).set({ state: "failed", endedAt: opts.now, detail: { reason: "never announced" } })
            .where(and(eq(airdropEvents.serverId, s.id), eq(airdropEvents.slotAt, row.slotAt)));
          out.failed += 1;
          continue;
        }
        try {
          await post(airdropText(row.location, row.slotAt));
          await db.update(airdropEvents).set({ announcedAt: opts.now })
            .where(and(eq(airdropEvents.serverId, s.id), eq(airdropEvents.slotAt, row.slotAt)));
          out.posted += 1;
        } catch (err) {
          console.warn(`airdrop: announcement for ${row.slotAt.toISOString()} failed to post — retrying next tick`, err);
        }
      }
      if (pending.length > 0) continue;

      // 2. A new decision, at or after T-30min and not yet taken for this slot.
      if (opts.now < decisionInstantFor(slot)) continue;
      const [already] = await db.select({ slotAt: airdropEvents.slotAt }).from(airdropEvents)
        .where(and(eq(airdropEvents.serverId, s.id), eq(airdropEvents.slotAt, slot))).limit(1);
      if (already) continue;

      const open = await db.select({ slotAt: airdropEvents.slotAt }).from(airdropEvents).where(and(
        eq(airdropEvents.serverId, s.id), inArray(airdropEvents.state, ["announced", "live"]),
      ));
      // ⚠️ `failed` rows are excluded from BOTH counts: spec §9 refunds the budget,
      // and a scrubbed drop is not one the server ever had.
      // ⚠️ `manual` rows are excluded from THIS count only. An admin placing a drop
      // by hand is not spending the automatic budget — but the `last` lookup and the
      // `open` guard below both still see it, so a hand-placed drop does hold the
      // 24h gap and does stop a second drop being decided on top of it.
      const week = await db.select({ slotAt: airdropEvents.slotAt }).from(airdropEvents).where(and(
        eq(airdropEvents.serverId, s.id), ne(airdropEvents.state, "failed"),
        eq(airdropEvents.manual, false),
        gte(airdropEvents.decidedAt, isoWeekStart(opts.now)),
      ));
      const [last] = await db.select({ decidedAt: airdropEvents.decidedAt }).from(airdropEvents)
        .where(and(eq(airdropEvents.serverId, s.id), ne(airdropEvents.state, "failed")))
        .orderBy(sql`${airdropEvents.decidedAt} desc`).limit(1);

      // The trailing history: every decision instant on the slot grid, 14 days back.
      const instants: Date[] = [];
      for (let t = decisionInstantFor(slot).getTime() - AIRDROP_HISTORY_MS;
           t < decisionInstantFor(slot).getTime(); t += RESTART_PERIOD_MS) {
        instants.push(new Date(t));
      }
      const [pop] = await popsAt(db, s.id, [opts.now]);
      const threshold = p90(await popsAt(db, s.id, instants));

      if (!shouldFire({
        pop: pop ?? 0, threshold, minPop: opts.minPop, weekCount: week.length,
        weeklyCap: opts.weeklyCap, lastFireAt: last?.decidedAt ?? null,
        openEvent: open.length > 0, now: opts.now,
      })) continue;

      const recent = await db.select({ location: airdropEvents.location }).from(airdropEvents)
        .where(eq(airdropEvents.serverId, s.id)).orderBy(sql`${airdropEvents.decidedAt} desc`).limit(5);
      const spec = chooseAirdrop(recent.map((r) => r.location), rng);

      await db.insert(airdropEvents).values({
        serverId: s.id, slotAt: slot, location: spec.location, colour: spec.colour,
        decidedAt: opts.now, popAtDecision: pop ?? 0, threshold: String(threshold), state: "announced",
      }).onConflictDoNothing();
      out.decided += 1;
      console.log(`airdrop: server ${s.id} decided ${spec.location}/${spec.colour} for ${slot.toISOString()} (pop ${pop}, threshold ${threshold.toFixed(2)})`);

      try {
        await post(airdropText(spec.location, slot));
        await db.update(airdropEvents).set({ announcedAt: opts.now })
          .where(and(eq(airdropEvents.serverId, s.id), eq(airdropEvents.slotAt, slot)));
        out.posted += 1;
      } catch (err) {
        // ⚠️ Left `announced` with a null announced_at, NOT failed outright: the
        // slot is still 30 minutes away, so the retry above gets the rest of the
        // window to land the message before the drop is written off.
        console.warn(`airdrop: announcement for ${slot.toISOString()} failed to post — retrying next tick`, err);
      }
    } catch (err) {
      console.error(`airdrop: server ${s.id} decision failed`, err);
    }
  }
  return out;
}
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/bot && npx vitest run test/airdrop-tick.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/airdrop-tick.ts apps/bot/src/airdrop-text.ts apps/bot/test/airdrop-tick.test.ts
git commit -m "feat(airdrops): decide at T-30 and announce the location"
```

---

### Task 7: Config and wiring

**Files:**
- Modify: `apps/bot/src/config.ts`
- Modify: `apps/bot/src/discord.ts`
- Modify: `apps/bot/README.md` (the env table)
- Test: `apps/bot/test/config.test.ts`

**Interfaces:**
- Consumes: `airdropTick` (Task 6), `restartTick`'s `airdrop` option (Task 5).
- Produces: `cfg.airdrop = { enabled: boolean; weeklyCap: number; minPop: number }`, `cfg.serverEventsChannelId: string | undefined`.

- [ ] **Step 1: Write the failing test**

Add to `apps/bot/test/config.test.ts`, following the shape of its existing raid-window cases:

```ts
it("refuses AIRDROP_TICK without RESTART_SCHEDULE", () => {
  expect(() => loadConfig({ ...BASE, AIRDROP_TICK: "true", RESTART_SCHEDULE: "false" }))
    .toThrow(/AIRDROP_TICK is on but RESTART_SCHEDULE is off/);
});

// ⚠️ Fatal, exactly like RAID_WINDOW_TICK without ANNOUNCEMENTS_CHANNEL_ID, and
// doubly so: spec §9 makes a drop that cannot be announced a drop that does not
// happen, so nowhere to post is misconfigured, not degraded.
it("refuses AIRDROP_TICK without SERVER_EVENTS_CHANNEL_ID", () => {
  expect(() => loadConfig({ ...BASE, AIRDROP_TICK: "true", RESTART_SCHEDULE: "true", NITRADO_TOKEN: "t", SERVER_EVENTS_CHANNEL_ID: "" }))
    .toThrow(/AIRDROP_TICK is on but SERVER_EVENTS_CHANNEL_ID is unset/);
});

it("defaults the cap to 2 and the floor to 5", () => {
  const cfg = loadConfig({ ...BASE, AIRDROP_TICK: "true", RESTART_SCHEDULE: "true", NITRADO_TOKEN: "t", SERVER_EVENTS_CHANNEL_ID: "123456789012345678" });
  expect(cfg.airdrop).toEqual({ enabled: true, weeklyCap: 2, minPop: 5 });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd apps/bot && npx vitest run test/config.test.ts`
Expected: FAIL — no error is thrown; `cfg.airdrop` is undefined.

- [ ] **Step 3: Add the config**

In `apps/bot/src/config.ts`, beside `raidWindow`:

```ts
    airdrop: {
      enabled: ["1", "true"].includes((env.AIRDROP_TICK ?? "").toLowerCase()),
      weeklyCap: positiveInt(env, "AIRDROP_WEEKLY_CAP", 2),
      minPop: positiveInt(env, "AIRDROP_MIN_POP", 5),
    },
    serverEventsChannelId: optionalSnowflake(env, "SERVER_EVENTS_CHANNEL_ID"),
```

and, beside the raid-window checks:

```ts
  // ⚠️ Same failure shape as RAID_WINDOW_TICK's check: the spawner only takes
  // effect when the server restarts, and restarts come from the restart slots. On
  // without RESTART_SCHEDULE would decide events nothing ever places.
  if (config.airdrop.enabled && !config.restartSchedule) {
    throw new Error("AIRDROP_TICK is on but RESTART_SCHEDULE is off — a drop is only ever placed at a restart, so nothing would ever apply it.");
  }
  // ⚠️ Fatal, following RAID_WINDOW_TICK/ANNOUNCEMENTS_CHANNEL_ID, and spec §9
  // makes it doubly so: only the location is announced and there is no in-world
  // marker, so a drop nobody was told about is one nobody ever finds. With no
  // channel this feature cannot work at all, rather than working less well.
  if (config.airdrop.enabled && !config.serverEventsChannelId) {
    throw new Error("AIRDROP_TICK is on but SERVER_EVENTS_CHANNEL_ID is unset — the location announcement is the only way a drop is ever found, so with no channel to post it this is misconfigured, not merely degraded.");
  }
```

- [ ] **Step 4: Wire the ticks in `discord.ts`**

Beside the existing `announcePoster` line (~603):

```ts
  const serverEventsPoster = cfg.serverEventsChannelId ? createChannelPoster(client, cfg.serverEventsChannelId) : null;
```

Pass the flag to the restart tick (~1558):

```ts
        const r = await restartTick(db, nitradoFor, { now: new Date(), truckWipe: cfg.truckWipe, raidWindow: cfg.raidWindow, airdrop: cfg.airdrop });
```

And add the decision tick immediately after the raid-window tick block:

```ts
    // ⚠️ AFTER the restart tick, like the raid window and for the same reason: a
    // slow Discord call must never delay a due restart. Its own try/catch.
    // ⚠️ Gated on the flag alone — config load refuses AIRDROP_TICK without
    // SERVER_EVENTS_CHANNEL_ID, so serverEventsPoster is non-null here.
    if (cfg.airdrop.enabled) {
      try {
        const a = await airdropTick(db, serverEventsPoster!, {
          now: new Date(), weeklyCap: cfg.airdrop.weeklyCap, minPop: cfg.airdrop.minPop,
        });
        if (a.decided + a.posted + a.failed > 0) console.log(`airdrop: ${a.decided} decided, ${a.posted} posted, ${a.failed} failed`);
      } catch (err) {
        console.error("airdrop tick failed", err);
      }
    }
```

with `import { airdropTick } from "./airdrop-tick.js";` at the top, and a startup line beside the other feature notices (~1635):

```ts
    if (!cfg.airdrop.enabled) console.warn("AIRDROP_TICK is off: airdrops are not being placed automatically.");
    else console.log(`airdrop automation on (cap ${cfg.airdrop.weeklyCap}/week, floor ${cfg.airdrop.minPop})`);
```

- [ ] **Step 5: Document the env vars**

Add four rows to the env table in `apps/bot/README.md`: `AIRDROP_TICK` (off unless `1`/`true`; requires `RESTART_SCHEDULE` and `SERVER_EVENTS_CHANNEL_ID`), `SERVER_EVENTS_CHANNEL_ID` (fatal when the tick is on), `AIRDROP_WEEKLY_CAP` (default 2, a cap and never a quota), `AIRDROP_MIN_POP` (default 5, the floor under the trailing p90).

- [ ] **Step 6: Run the tests**

Run: `cd apps/bot && npx vitest run test/config.test.ts`
Expected: PASS, 3 new cases plus the existing ones.

- [ ] **Step 7: Commit**

```bash
git add apps/bot/src/config.ts apps/bot/src/discord.ts apps/bot/README.md apps/bot/test/config.test.ts
git commit -m "feat(airdrops): config, wiring and the env table"
```

---

### Task 8: `/airdrop place` — the manual trigger

**Files:**
- Create: `apps/bot/src/commands/airdrop.ts`
- Modify: `apps/bot/src/commands/index.ts` (one group in `GROUPS`)
- Modify: `apps/bot/src/commands/types.ts` (`Ctx` gains `db` and `serverEvents`; `CommandInput` gains `isAdmin`)
- Modify: `apps/bot/src/commands/route.ts` (`inputFor` fills `isAdmin`)
- Modify: `apps/bot/src/discord.ts` (`ctxNow` fills the two new `Ctx` fields)
- Test: `apps/bot/test/airdrop-command.test.ts`

An admin places a drop by hand, for the next restart, without spending the week's
budget. Everything else about it is an ordinary drop: the same announcement, the
same enable at the slot, the same disable two hours later.

**Interfaces:**
- Consumes: `airdropText` (Task 6), `airdropEvents.manual` (Task 3), `chooseAirdrop`, `nextRestartAt`, `AIRDROP_LOCATIONS`, `AIRDROP_COLOURS` (Task 1).
- Produces: `airdropGroup: CommandGroup` exposing `/airdrop place location:<choice> [colour:<choice>]`; `Ctx.db: Database`; `Ctx.serverEvents: ((content: string) => Promise<void>) | null`; `CommandInput.isAdmin: boolean`.

- [ ] **Step 1: Write the failing test**

Create `apps/bot/test/airdrop-command.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, airdropEvents, servers, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { airdropGroup } from "../src/commands/airdrop.js";
import type { Ctx, CommandInput } from "../src/commands/types.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const NOW = at("2026-09-21T19:05:00Z");
const SLOT = at("2026-09-21T20:00:00Z");
const place = airdropGroup.specs.find((s) => s.path === "airdrop place")!.handler;

describe("/airdrop place", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table airdrop_events, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "R", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 7, active: true }).returning();
    serverId = s!.id;
  });

  const ctx = (post: ((c: string) => Promise<void>) | null = vi.fn(async () => {})) =>
    ({ db, now: NOW, serverEvents: post, roster: {} as never, siteBaseUrl: "https://x" }) as unknown as Ctx;
  const input = (over: Partial<CommandInput> & { location?: string; colour?: string | null } = {}) => ({
    actorDiscordId: "99", isAdmin: true,
    string: (n: string) => (n === "location" ? over.location ?? "dolnik" : over.colour ?? null),
    integer: () => null, boolean: () => null, user: () => null,
    ...over,
  }) as unknown as CommandInput;
  const rows = () => db.select().from(airdropEvents);

  it("places a drop at the next slot, announces it, and marks it manual", async () => {
    const post = vi.fn(async () => {});
    const reply = await place(ctx(post), input());
    expect(reply.ephemeral).toBe(true);
    expect(reply.content).toContain("Dolnik");
    const [row] = await rows();
    expect(row).toMatchObject({ slotAt: SLOT, location: "dolnik", state: "announced", manual: true });
    expect(row!.announcedAt).not.toBeNull();
    expect(post).toHaveBeenCalledWith(expect.stringContaining("Dolnik"));
  });

  it("takes the colour when given one and rolls it when not", async () => {
    await place(ctx(), input({ colour: "yellow" }));
    expect((await rows())[0]!.colour).toBe("yellow");
  });

  // ⚠️ Defence in depth. The command JSON also carries
  // setDefaultMemberPermissions(ManageGuild), so Discord hides it — but a
  // permission overwrite on a channel can put it back, and placing loot on the
  // map is not something a member gets to do by finding a gap in a UI.
  it("refuses a non-admin and writes nothing", async () => {
    const reply = await place(ctx(), input({ isAdmin: false }));
    expect(reply.content).toMatch(/admin/i);
    expect(await rows()).toHaveLength(0);
  });

  it("refuses a location that is not on the menu", async () => {
    const reply = await place(ctx(), input({ location: "narnia" }));
    expect(reply.content).toMatch(/not one of the/i);
    expect(await rows()).toHaveLength(0);
  });

  // ⚠️ Two drops at once is a state cfggameplay.json cannot hold: one element,
  // one spawner. The splice would refuse and the restart tick would scrub a drop
  // players had already been told about.
  it("refuses while another drop is announced or live", async () => {
    await db.insert(airdropEvents).values({
      serverId, slotAt: SLOT, location: "lukow", colour: "blue", decidedAt: NOW,
      popAtDecision: 4, threshold: "0", state: "announced", announcedAt: NOW,
    });
    const reply = await place(ctx(), input());
    expect(reply.content).toMatch(/already/i);
    expect(await rows()).toHaveLength(1);
  });

  // ⚠️ Spec §9 applies to a hand-placed drop too: nobody finds an unannounced one.
  it("places nothing when the announcement cannot post", async () => {
    const reply = await place(ctx(vi.fn(async () => { throw new Error("channel gone"); })), input());
    expect(reply.content).toMatch(/could not/i);
    expect((await rows())[0]!.state).toBe("failed");
  });

  it("refuses when the feature is switched off", async () => {
    const reply = await place(ctx(null), input());
    expect(reply.content).toMatch(/AIRDROP_TICK/);
    expect(await rows()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd apps/bot && npx vitest run test/airdrop-command.test.ts`
Expected: FAIL — `Failed to resolve import "../src/commands/airdrop.js"`.

- [ ] **Step 3: Widen `Ctx` and `CommandInput`**

In `apps/bot/src/commands/types.ts`, add to `Ctx`:

```ts
  /**
   * ⚠️ The only command that touches this is `/airdrop place`, which has no
   * roster call to make: an airdrop is server state, not clan state, so there is
   * nothing for `@factions/roster` to export. Do not reach for it from a clan
   * command — those go through `roster`, which is what keeps the site and the
   * commands one set of rules rather than two.
   */
  db: Database;
  /** The `SERVER_EVENTS_CHANNEL_ID` poster, or null when `AIRDROP_TICK` is off. */
  serverEvents: ((content: string) => Promise<void>) | null;
```

and to `CommandInput`:

```ts
  /**
   * Whether the caller holds Manage Server in this guild.
   *
   * ⚠️ Read from the interaction's OWN member permissions, never from a role id
   * in config: a role can be renamed, deleted or handed out, and the permission
   * is the thing Discord actually enforces.
   */
  isAdmin: boolean;
```

In `apps/bot/src/commands/route.ts`, in `inputFor`:

```ts
    isAdmin: i.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
```

with `PermissionFlagsBits` added to the discord.js import.

In `apps/bot/src/discord.ts`, extend `ctxNow` (the `serverEventsPoster` const comes from Task 7):

```ts
  const ctxNow = (): Ctx => ({
    roster, now: new Date(), siteBaseUrl: cfg.siteBaseUrl,
    db, serverEvents: cfg.airdrop.enabled ? serverEventsPoster : null,
  });
```

- [ ] **Step 4: Write the command**

Create `apps/bot/src/commands/airdrop.ts`:

```ts
import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { airdropEvents, servers } from "@factions/db";
import { AIRDROP_COLOURS, AIRDROP_LOCATIONS, chooseAirdrop, nextRestartAt } from "@factions/domain";
import { and, eq, inArray } from "drizzle-orm";
import { airdropText } from "../airdrop-text.js";
import type { CommandGroup, Ctx, CommandInput, Reply } from "./types.js";

const reply = (content: string): Reply => ({ content, ephemeral: true });
const place = (l: string) => l.charAt(0).toUpperCase() + l.slice(1);

/**
 * Place a drop by hand, for the next restart (§3 does not get a vote on it).
 *
 * ⚠️ `manual: true` is the whole point: the weekly cap is a budget for the
 * AUTOMATIC trigger, and an admin placing one for an event, a stream or a test
 * must not spend it. The 24h gap and the one-at-a-time guard still apply — see
 * the column's comment in the schema for why those two are different.
 *
 * ⚠️ Row first, post second, and the row is FAILED if the post throws. Spec §9:
 * only the location is announced and there is no in-world marker, so a drop
 * nobody was told about is a drop nobody ever finds.
 */
async function placeAirdrop(ctx: Ctx, input: CommandInput): Promise<Reply> {
  if (!input.isAdmin) return reply("Only an admin can place an airdrop.");
  if (!ctx.serverEvents) {
    return reply("AIRDROP_TICK is off, so nothing would ever place this drop. Turn it on first.");
  }

  const location = (input.string("location") ?? "").toLowerCase();
  if (!AIRDROP_LOCATIONS.includes(location as never)) {
    return reply(`${location || "That"} is not one of the ${AIRDROP_LOCATIONS.length} staged locations.`);
  }
  const asked = input.string("colour")?.toLowerCase() ?? null;
  if (asked && !AIRDROP_COLOURS.includes(asked as never)) {
    return reply(`${asked} is not one of the three colours.`);
  }
  const colour = asked ?? chooseAirdrop([], Math.random).colour;

  // ⚠️ Per server, like the tick: a drop is a file on one mission. One active
  // server today; a second one makes this command need a `server:` option, and
  // `airdropTick` already loops rather than assuming.
  const [server] = await ctx.db.select({ id: servers.id }).from(servers)
    .where(eq(servers.active, true)).limit(1);
  if (!server) return reply("No active server to place a drop on.");

  const open = await ctx.db.select({ slotAt: airdropEvents.slotAt }).from(airdropEvents).where(and(
    eq(airdropEvents.serverId, server.id),
    inArray(airdropEvents.state, ["announced", "live"]),
  ));
  if (open.length > 0) {
    return reply("A drop is already announced or live. Only one at a time.");
  }

  const slot = nextRestartAt(ctx.now);
  await ctx.db.insert(airdropEvents).values({
    serverId: server.id, slotAt: slot, location, colour, decidedAt: ctx.now,
    // ⚠️ pop and threshold are recorded as 0, not as the live numbers: this row
    // is not evidence of a peak, and storing the current pop would make the
    // history read as if the trigger had fired when it had not.
    popAtDecision: 0, threshold: "0", state: "announced", manual: true,
    detail: { by: input.actorDiscordId },
  });

  try {
    await ctx.serverEvents(airdropText(location, slot));
  } catch (err) {
    await ctx.db.update(airdropEvents).set({ state: "failed", endedAt: ctx.now, detail: { reason: "never announced" } })
      .where(and(eq(airdropEvents.serverId, server.id), eq(airdropEvents.slotAt, slot)));
    console.error("airdrop: manual announcement failed to post — nothing placed", err);
    return reply("I could not post the announcement, so I have not placed the drop. Check SERVER_EVENTS_CHANNEL_ID.");
  }

  await ctx.db.update(airdropEvents).set({ announcedAt: ctx.now })
    .where(and(eq(airdropEvents.serverId, server.id), eq(airdropEvents.slotAt, slot)));
  console.log(`airdrop: ${input.actorDiscordId} placed ${location}/${colour} by hand for ${slot.toISOString()}`);

  return reply([
    `Announced: **${place(location)}**, ${colour}.`,
    `It goes in at the ${slot.toISOString()} restart and comes out at the one after.`,
    "This one does not count against the weekly cap.",
  ].join("\n"));
}

export const airdropGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("airdrop")
    .setDescription("Place an airdrop by hand")
    // ⚠️ Discord's own gate, so the command is hidden from members rather than
    // merely refused. The handler checks again; see its comment.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((c) => c
      .setName("place")
      .setDescription("Place a drop at the next restart, without spending the weekly cap")
      .addStringOption((o) => o
        .setName("location").setDescription("Where it lands").setRequired(true)
        .addChoices(...AIRDROP_LOCATIONS.map((l) => ({ name: place(l), value: l }))))
      .addStringOption((o) => o
        .setName("colour").setDescription("Which container (left off, it is rolled)").setRequired(false)
        .addChoices(...AIRDROP_COLOURS.map((c2) => ({ name: c2, value: c2 }))))),
  specs: [{ path: "airdrop place", handler: placeAirdrop }],
};
```

Add the group to `apps/bot/src/commands/index.ts`:

```ts
import { airdropGroup } from "./airdrop.js";
```

and append `airdropGroup` to the `GROUPS` array.

- [ ] **Step 5: Run the tests**

Run: `cd apps/bot && npx vitest run test/airdrop-command.test.ts test/command-registration.test.ts test/parity.test.ts`
Expected: PASS. ⚠️ `command-registration.test.ts` asserts the specs and handlers are a bijection and that the JSON stays inside Discord's limits — 16 location choices is under the 25 cap. `parity.test.ts` maps roster WRITES to commands; `/airdrop place` makes no roster write, so it needs no entry there.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/commands/airdrop.ts apps/bot/src/commands/index.ts apps/bot/src/commands/types.ts apps/bot/src/commands/route.ts apps/bot/src/discord.ts apps/bot/test/airdrop-command.test.ts
git commit -m "feat(airdrops): /airdrop place, outside the weekly cap"
```

---

### Task 9: The runbook, the notes and the gate

**Files:**
- Create: `docs/deploy/2026-09-21-airdrops.md`
- Modify: `CLAUDE.md` (one row in "Where things live")
- Modify: `CHANGELOG.md` (an entry under `## [Unreleased]`)

- [ ] **Step 1: Write the runbook**

`docs/deploy/2026-09-21-airdrops.md` covers, in order:

1. **Prerequisite in the `livonia` repo.** Remove `"./custom/airdrop-dolnik-blue.json"` from `WorldsData.objectSpawnersArr` in `livonia/cfggameplay.json`, commit, tag, and **publish the Release** (publishing is what deploys — `livonia/CLAUDE.md`). ⚠️ Until this lands, the repo baseline re-enables Dolnik on every deploy and the bot's disable is undone at the next release.
2. **Migrate.** Stop the bot, `pnpm db:migrate` dry run, read the SQL, `--apply --production`, start the bot. (On the auto-deploy path the release deployer does this; the manual path is `docs/deploy/2026-09-14-db-migrate.md`.)
3. **Env.** `AIRDROP_TICK=true`, `SERVER_EVENTS_CHANNEL_ID=…`, `AIRDROP_WEEKLY_CAP=1` for the first fortnight (spec §12), `AIRDROP_MIN_POP=5`, all in `.env` — ⚠️ not on the start command line, the hazard `BOT_FEED_CHANNEL_ID` already carries.
4. **Verify.** `select * from airdrop_events order by decided_at desc limit 5;` and the `airdrop:` log lines. A decided row with a null `announced_at` older than its slot means the channel is wrong. `/airdrop place location:Dolnik` is the one-command end-to-end check: it announces immediately, goes in at the next restart, and does not spend the week's cap.
5. **The deploy clobber.** A `livonia` Release published during a live drop removes it; the next slot puts it back if the session is still running. Do not publish one mid-event if it can wait.
6. **Turning it off.** `AIRDROP_TICK=false` stops new decisions but does **not** remove a live drop: the tick that disables is gated on the same flag. Let the live row end first, or remove the spawner by hand and set the row to `ended`.
7. **`/airdrop place`.** Admins only (Manage Server). It places a drop at the next restart and is excluded from the weekly cap, but not from the 24h gap or the one-at-a-time rule, so it will refuse while another drop is announced or live.
8. **Rollback.** Revert the code, and hand-remove the airdrop element from `objectSpawnersArr` if one is registered.

- [ ] **Step 2: Add the `CLAUDE.md` row**

In the "Where things live" table, after the raid-window row:

```markdown
| Airdrop events (a locked container at one of 16 Livonia locations, for one session) | Decisions in `packages/domain/src/airdrops.ts` (`chooseAirdrop`, `shouldFire`, `p90`; the menu and windows in `rules.ts`), the splice in `apps/bot/src/cfggameplay.ts` (`setAirdropSpawner`), the decision tick `apps/bot/src/airdrop-tick.ts` + `airdrop-text.ts`, enable/disable inside `apps/bot/src/restart-tick.ts` (`applyGameplay`), state in `airdrop_events`, the manual `/airdrop place` in `apps/bot/src/commands/airdrop.ts`. Gated on `AIRDROP_TICK`; requires `RESTART_SCHEDULE` and `SERVER_EVENTS_CHANNEL_ID`. ⚠️ **`applyGameplay` is the ONLY place `cfggameplay.json` is downloaded and uploaded** — the raid flip and the airdrop share one round trip per slot, and splitting them back into two silently loses whichever edit uploads first. ⚠️ A drop is never enabled without `announced_at` set: only the location is announced and there is no in-world marker, so an unannounced drop is one nobody finds. ⚠️ The `livonia` repo FTPs `cfggameplay.json` on every published Release, over whatever the bot wrote; per-slot recomputation is what repairs it. ⚠️ `airdrop_events.manual` is excluded from the weekly cap and from NOTHING else — a hand-placed drop still holds the 24h gap and the one-at-a-time guard shut. Spec `docs/superpowers/specs/2026-09-20-airdrop-events-design.md`, runbook `docs/deploy/2026-09-21-airdrops.md` |
```

- [ ] **Step 3: Add the changelog entry**

Under `## [Unreleased]` in `CHANGELOG.md`:

```markdown
### Added
- Airdrop events: when the server is genuinely busy, the bot picks one of 16 Livonia
  locations and one of three container colours, announces the location before a
  restart, places the drop for exactly one session, and takes it away again. At most
  `AIRDROP_WEEKLY_CAP` a week, never within 24 hours of the last one, and never on a
  week with no good moment in it.
- `/airdrop place` for admins: put a drop at the next restart by hand. It announces
  and expires like any other, and does not count against the weekly cap.
```

- [ ] **Step 4: Run the full gate**

Run:

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx turbo run typecheck test --concurrency=1 --force
```

Expected: **30/30 tasks** successful. ⚠️ Check the count, not the exit code — a cached pass proves nothing, and nothing else may be running the suite at the same time.

- [ ] **Step 5: Commit**

```bash
git add docs/deploy/2026-09-21-airdrops.md CLAUDE.md CHANGELOG.md
git commit -m "docs(airdrops): runbook, working notes and changelog"
```

---

## Not in this plan, on purpose

- **A `#server-events` failure alert to ops.** Spec §9 asks for one after a second failed *disable*. The enable path scrubs itself after two attempts and says so in the channel; the disable path retries forever and logs at error level. Add the ops alert in a follow-up, keyed `(server_id, slot_at)` so it fires once per event and not once per slot — the burial `raid_window_announcements` already guards against.
- **A site surface.** No page, timer or map pin. The drop is a Discord and in-game event for now.
- **Choosing the colour by what keys are in circulation.** Spec §3.4 is explicit that the gamble is the point.
