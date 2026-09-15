# Base-Zone Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A non-member who builds, dismantles, or stacks boost items inside a declared base's 100 m watch zone is detected from the ADM log, warned, and — only if the base's owner presses charges — automatically banned in game for a term proportional to the damage.

**Architecture:** Detection is folded into the existing `zone-tick.ts`, which already resolves the zone and rejects members. Acts accumulate into a `zone_incidents` row that closes after a quiet gap; a new `violation-tick.ts` closes incidents and DMs participants. Charges are pressed on the owner-gated `/base` page, which computes a sentence with a pure domain function and writes a `bans` row. A new `ban-tick.ts` reconciles `bans` against Nitrado's `settings.general.bans`.

**Tech Stack:** TypeScript, pnpm workspace + turbo, drizzle-orm over postgres.js, vitest, discord.js, Next.js (App Router).

**Spec:** `docs/superpowers/specs/2026-09-15-zone-enforcement-design.md` — read it before Task 1. Every task argues from it.

## Global Constraints

- **Every timer, radius, cap and cooldown goes in `packages/domain/src/rules.ts`.** No other module may state one as a literal. This is enforced by convention and reviewed; a number stated twice will drift.
- **Player-facing numbers must flow into `packages/domain/src/guide-numbers.ts`** so the guide renders them from the same source. Operational-only numbers are deliberately excluded (see `POSITION_RETENTION_MS`'s comment for the precedent).
- **`clan_notices` payloads may not contain `x`, `y`, `z` or `poleKey`** — the `clan_notices_no_coordinates` CHECK (`packages/db/src/schema.ts:1057`) rejects the row. Coordinates belong on the owner-gated `/base` page only.
- **New ADM parsers must anchor on the identity block's own closing paren** (`\(id=[0-9A-F]{40}[^)]*\)`), never a bare `\)`. The gamertag is attacker-controlled and sits earlier on the line. See the comment block at `packages/adm-parser/src/structure.ts:12-19`.
- **Never reorder branches inside `parseLine`'s returned array.** `subIndex` in the event log is that array's index; renumbering collides with the idempotency unique index. Appending a new `if` branch that returns a single-element array is safe.
- **Bans are placed against `dayz_id` AND gamertag, both frozen at ban-creation time.** Never resolve a gamertag through a join at apply time.
- **`BAN_DRY_RUN` defaults to `true`.** Audit rows are always written; Nitrado writes require explicitly setting it `false`.
- **Nothing applies migrations automatically.** Generate with `cd packages/db && npx drizzle-kit generate`, **read the generated SQL**, and commit it. `scripts/migrate.ts` is the deploy path.
- **Tests:** `TEST_DATABASE_URL` is a base URL whose database name is discarded; each package derives `factions_test_<package>`. Set it to `postgres://factions:factions@localhost:5434/factions`.
- Run the full suite with `pnpm turbo run test`. Expect **28/28 tasks** before this plan; new packages add to that count.

---

## File Structure

**`packages/domain`** — pure rules, no I/O.
- Modify `src/rules.ts` — the thirteen new constants (§9 of the spec).
- Modify `src/events.ts` — add `"item.placed"` to `EventType`.
- Modify `src/feed.ts` — add `zone_warning` and `ban_applied` to `CLAN_NOTICE_KINDS`.
- Create `src/enforcement.ts` — `IncidentDamage`, `sentenceMsFor`, `BoostPlacement`, `boostStackFor`. Pure functions, the only place the ladder and the stack rule are stated.
- Modify `src/index.ts` — re-export.

**`packages/adm-parser`** — one file per log-line shape.
- Create `src/placement.ts` — `parsePlacement`, the generic `placed X<Class>` line.
- Modify `src/parse-line.ts` — append the branch, map to `item.placed`.

**`packages/db`** — schema and migrations.
- Modify `src/schema.ts` — `zonePlacements`, `zoneIncidents`, `zoneViolations`, `zoneIncidentParticipants`, `bans`.
- Create `migrations/0036_*.sql` — generated, then read.

**`packages/nitrado`** — the game-server API.
- Modify `src/client.ts` — `getBans`, `setBans`, `addBans`, `removeBans`.

**`apps/bot`** — consumers.
- Modify `src/zone-tick.ts` — write placements, violations and incidents beside the existing alerts.
- Create `src/violation-tick.ts` — close quiet incidents, queue warning DMs.
- Create `src/ban-tick.ts` — apply and expire bans against Nitrado, reference-counted.
- Modify `src/notice-text.ts` — renderers for the two new kinds.
- Modify `src/config.ts` — `BAN_DRY_RUN`, `ENFORCEMENT_TICK`.
- Modify `src/discord.ts` — register the two new ticks.

**`packages/roster`** — the site's data layer.
- Create `src/internal/incidents.ts` — `reportableIncidentsDb`, `reportIncidentDb`.
- Modify `src/base.ts` — surface incidents on `BaseView`.
- Modify `src/api.ts` / `src/index.ts` — export the wrappers.

**`apps/web`** — the report surface.
- Modify `app/(site)/base/page.tsx` — the incident list.
- Create `app/(site)/base/report-button.tsx` — the client component.
- Create `app/api/base/report/route.ts` — the POST.

**Guide and docs** — Task 11.

---

## Task 1: The sentence and the stack rule

Pure domain functions with no I/O. Everything downstream depends on these names, so they land first.

**Files:**
- Modify: `packages/domain/src/rules.ts`
- Create: `packages/domain/src/enforcement.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/enforcement.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type IncidentDamage = { partsDismantled: number; partsBuilt: number; stackItems: number; hasBreach: boolean; hasGate: boolean }`
  - `sentenceMsFor(damage: IncidentDamage, priorOffences: number): number | null` — `null` means permanent.
  - `type BoostPlacement = { dayzId: string; x: number; y: number; z: number; occurredAt: Date }`
  - `boostStackFor(recent: readonly BoostPlacement[], latest: BoostPlacement): BoostPlacement[] | null`
  - The thirteen constants from spec §9.

- [ ] **Step 1: Write the failing tests**

Create `packages/domain/test/enforcement.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  sentenceMsFor, boostStackFor, type IncidentDamage, type BoostPlacement,
  BAN_BASE_MS, BAN_BREACH_MS, BAN_GATE_MS, BAN_PER_DISMANTLE_MS,
  BAN_FIRST_OFFENCE_CAP_MS, BOOST_STACK_RADIUS_M,
} from "../src/index.js";

const HOUR = 3_600_000;
const damage = (d: Partial<IncidentDamage> = {}): IncidentDamage => ({
  partsDismantled: 0, partsBuilt: 0, stackItems: 0, hasBreach: false, hasGate: false, ...d,
});

describe("sentenceMsFor", () => {
  it("a bare incident is the base term", () => {
    expect(sentenceMsFor(damage(), 0)).toBe(BAN_BASE_MS);
  });

  it("any breach adds the flat breach term, regardless of how many items caused it", () => {
    const one = sentenceMsFor(damage({ hasBreach: true, stackItems: 2 }), 0);
    const many = sentenceMsFor(damage({ hasBreach: true, stackItems: 5 }), 0);
    expect(one).toBe(BAN_BASE_MS + BAN_BREACH_MS);
    expect(many).toBe(one);
  });

  it("a gate conversion adds its own term on top of the breach", () => {
    expect(sentenceMsFor(damage({ hasBreach: true, hasGate: true, partsBuilt: 1 }), 0))
      .toBe(BAN_BASE_MS + BAN_BREACH_MS + BAN_GATE_MS);
  });

  it("loss scales per dismantled part", () => {
    expect(sentenceMsFor(damage({ partsDismantled: 3 }), 0))
      .toBe(BAN_BASE_MS + 3 * BAN_PER_DISMANTLE_MS);
  });

  it("a first offence is capped", () => {
    expect(sentenceMsFor(damage({ partsDismantled: 100, hasBreach: true, hasGate: true }), 0))
      .toBe(BAN_FIRST_OFFENCE_CAP_MS);
  });

  it("a second offence doubles, and the cap applies before the multiplier", () => {
    expect(sentenceMsFor(damage({ partsDismantled: 100 }), 1)).toBe(BAN_FIRST_OFFENCE_CAP_MS * 2);
    expect(sentenceMsFor(damage(), 1)).toBe(BAN_BASE_MS * 2);
  });

  it("a third offence in the season is permanent", () => {
    expect(sentenceMsFor(damage(), 2)).toBeNull();
    expect(sentenceMsFor(damage({ partsDismantled: 1 }), 7)).toBeNull();
  });
});

describe("boostStackFor", () => {
  const t0 = new Date("2026-09-15T12:00:00Z");
  const at = (ms: number) => new Date(t0.getTime() + ms);
  const p = (x: number, y: number, z: number, ms: number, dayzId = "A".repeat(40)): BoostPlacement =>
    ({ dayzId, x, y, z, occurredAt: at(ms) });

  it("two co-located placements with the player rising is a stack", () => {
    const first = p(100, 10.0, 100, 0);
    const second = p(100.4, 10.9, 100.3, 60_000);
    const stack = boostStackFor([first], second);
    expect(stack).toHaveLength(2);
    expect(stack![0]).toBe(first);
  });

  it("a side-by-side farm is not a stack — the plots are further apart than their own footprint", () => {
    const first = p(100, 10.0, 100, 0);
    const second = p(100 + BOOST_STACK_RADIUS_M + 1, 10.0, 100, 60_000);
    expect(boostStackFor([first], second)).toBeNull();
  });

  it("two cook-fires on a hillside are not a stack — the rise is there but they are not co-located", () => {
    const first = p(100, 10.0, 100, 0);
    const second = p(106, 12.5, 100, 60_000);
    expect(boostStackFor([first], second)).toBeNull();
  });

  it("a fireplace dropped and replaced in one spot is not a stack — co-located but no rise", () => {
    const first = p(100, 10.0, 100, 0);
    const second = p(100.2, 10.05, 100.1, 60_000);
    expect(boostStackFor([first], second)).toBeNull();
  });

  it("a placement outside the time window does not join the cluster", () => {
    const old = p(100, 10.0, 100, -(4 * HOUR));
    const fresh = p(100.2, 11.0, 100.1, 0);
    expect(boostStackFor([old], fresh)).toBeNull();
  });

  it("mixed contributors both appear in the cluster — a stack may be a one- or two-man job", () => {
    const a = p(100, 10.0, 100, 0, "A".repeat(40));
    const b = p(100.3, 11.0, 100.2, 30_000, "B".repeat(40));
    const stack = boostStackFor([a], b);
    expect(stack!.map((s) => s.dayzId)).toEqual(["A".repeat(40), "B".repeat(40)]);
  });

  it("a three-high stack returns all three in chronological order", () => {
    const a = p(100, 10.0, 100, 0);
    const b = p(100.2, 10.8, 100.1, 20_000);
    const c = p(100.1, 11.7, 100.2, 40_000);
    expect(boostStackFor([a, b], c)).toEqual([a, b, c]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/domain && npx vitest run test/enforcement.test.ts`
Expected: FAIL — `sentenceMsFor is not a function` / no export `BAN_BASE_MS`.

- [ ] **Step 3: Add the constants**

Append to `packages/domain/src/rules.ts`, after the "Fair play" section:

```ts
// Base-zone enforcement (spec 2026-09-15)
/** How long a base's owner has to press charges on a closed incident. */
export const VIOLATION_REPORT_WINDOW_MS = 7 * DAY;
/** Quiet time that closes an open incident. */
export const VIOLATION_INCIDENT_GAP_MS = 30 * MIN;

/**
 * A boost stack: fireplaces or garden plots stacked to climb a wall.
 *
 * ⚠️ BOTH signals must agree, and each rules out a different false positive.
 * RADIUS separates stacking from farming — a garden plot's own footprint is
 * ~2.5 m, so two side-by-side plots cannot be this close unless one is on top
 * of the other. RISE separates stacking from a cluster of ground-level
 * placements — to put the second item on the first you must stand on the
 * first, so the player's own altitude climbs. Tightness alone flags a
 * fireplace dropped and replaced in one spot; rise alone flags two cook-fires
 * on a hillside.
 *
 * These two are the only numbers in this block derived from physical
 * reasoning rather than a policy choice, and are the likeliest to need
 * tuning after live observation.
 */
export const BOOST_STACK_MIN_ITEMS = 2;
export const BOOST_STACK_RADIUS_M = 1.5;
export const BOOST_STACK_MIN_RISE_M = 0.5;
export const BOOST_STACK_WINDOW_MS = 30 * MIN;

/**
 * The sentence. Breach is FLAT, loss is SCALED — they are different crimes.
 * Breaching is binary: one watchtower is the whole act, and five stacked
 * fireplaces are not worse than three. Loss is cumulative: twenty walls is
 * twice ten, and it is the only class that costs the owner materials to undo.
 */
export const BAN_BASE_MS = 24 * HOUR;
export const BAN_BREACH_MS = 48 * HOUR;
export const BAN_GATE_MS = 24 * HOUR;
export const BAN_PER_DISMANTLE_MS = 12 * HOUR;
export const BAN_FIRST_OFFENCE_CAP_MS = 7 * DAY;
export const BAN_REPEAT_MULTIPLIER = 2;
/** The nth upheld report against one dayz_id within a season is permanent. */
export const BAN_PERMANENT_AT_OFFENCE = 3;

/**
 * DayZ classnames that can be stacked into a boost.
 *
 * ⚠️ VERIFY AGAINST A REAL ADM LINE before trusting this list. It is inferred
 * from the single `placed …<…>` sample in the flagpole parser's test, not
 * observed. A missing classname is a silently unenforced exploit.
 */
export const BOOST_ITEM_CLASSES = ["Fireplace", "FireplaceIndoor", "GardenPlot"] as const;
```

- [ ] **Step 4: Write the implementation**

Create `packages/domain/src/enforcement.ts`:

```ts
import {
  BAN_BASE_MS, BAN_BREACH_MS, BAN_GATE_MS, BAN_PER_DISMANTLE_MS,
  BAN_FIRST_OFFENCE_CAP_MS, BAN_REPEAT_MULTIPLIER, BAN_PERMANENT_AT_OFFENCE,
  BOOST_STACK_MIN_ITEMS, BOOST_STACK_RADIUS_M, BOOST_STACK_MIN_RISE_M, BOOST_STACK_WINDOW_MS,
} from "./rules.js";

/** What one closed incident cost the base, as counted from the log. */
export type IncidentDamage = {
  partsDismantled: number;
  partsBuilt: number;
  stackItems: number;
  hasBreach: boolean;
  hasGate: boolean;
};

/**
 * The ban term for an incident, in ms. `null` means permanent.
 *
 * `priorOffences` is the number of upheld reports already standing against
 * this dayz_id THIS SEASON — 0 for a first offence.
 *
 * ⚠️ The cap applies BEFORE the repeat multiplier: the cap is a first-offence
 * mercy, not a ceiling on the whole ladder, so a second offence can reach
 * twice it.
 */
export function sentenceMsFor(damage: IncidentDamage, priorOffences: number): number | null {
  if (priorOffences >= BAN_PERMANENT_AT_OFFENCE - 1) return null;
  let ms = BAN_BASE_MS;
  if (damage.hasBreach) ms += BAN_BREACH_MS;
  if (damage.hasGate) ms += BAN_GATE_MS;
  ms += damage.partsDismantled * BAN_PER_DISMANTLE_MS;
  ms = Math.min(ms, BAN_FIRST_OFFENCE_CAP_MS);
  return priorOffences === 0 ? ms : ms * BAN_REPEAT_MULTIPLIER;
}

/** One boost-item placement inside a zone, as recorded by the log. */
export type BoostPlacement = {
  dayzId: string;
  x: number;
  y: number;
  z: number;
  occurredAt: Date;
};

/**
 * The placements forming a boost stack with `latest`, chronologically, or
 * null if this is ordinary cooking or farming.
 *
 * `recent` is every boost placement already recorded in the same zone, and
 * must NOT include `latest`. Callers bound it by BOOST_STACK_WINDOW_MS at the
 * query; the filter here is belt-and-braces and also drops anything dated
 * after `latest` (a replayed or out-of-order event).
 */
export function boostStackFor(
  recent: readonly BoostPlacement[], latest: BoostPlacement,
): BoostPlacement[] | null {
  const end = latest.occurredAt.getTime();
  const near = recent.filter((p) => {
    const t = p.occurredAt.getTime();
    if (t > end || end - t > BOOST_STACK_WINDOW_MS) return false;
    return Math.hypot(p.x - latest.x, p.z - latest.z) <= BOOST_STACK_RADIUS_M;
  });
  const cluster = [...near, latest].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  if (cluster.length < BOOST_STACK_MIN_ITEMS) return null;
  // A RISE over time, not a spread: the player climbed as they stacked.
  const rise = cluster[cluster.length - 1]!.y - cluster[0]!.y;
  if (rise < BOOST_STACK_MIN_RISE_M) return null;
  return cluster;
}
```

Add to `packages/domain/src/index.ts`:

```ts
export * from "./enforcement.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/domain && npx vitest run test/enforcement.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 6: Check the guide-numbers two-way diff still passes**

`packages/domain/test/` pins that guide-numbers and rules agree. Run the package suite:

Run: `cd packages/domain && npx vitest run`
Expected: PASS. If a two-way diff test fails naming the new constants, add the player-facing ones (`VIOLATION_REPORT_WINDOW_MS`, `BAN_BASE_MS`, `BAN_BREACH_MS`, `BAN_GATE_MS`, `BAN_PER_DISMANTLE_MS`, `BAN_FIRST_OFFENCE_CAP_MS`) to `guide-numbers.ts` and leave the rest out — `BOOST_STACK_*` and `BAN_PERMANENT_AT_OFFENCE` are detection internals the guide states in prose, not numerals.

- [ ] **Step 7: Commit**

```bash
git add packages/domain/src/rules.ts packages/domain/src/enforcement.ts packages/domain/src/index.ts packages/domain/test/enforcement.test.ts packages/domain/src/guide-numbers.ts
git commit -m "feat(domain): zone-enforcement sentence ladder and boost-stack rule"
```

---

## Task 2: The `item.placed` parser

**Files:**
- Create: `packages/adm-parser/src/placement.ts`
- Modify: `packages/adm-parser/src/parse-line.ts`
- Modify: `packages/domain/src/events.ts`
- Test: `packages/adm-parser/test/placement.test.ts`

**Interfaces:**
- Consumes: `Vec3` from `@factions/domain`; `parseIdentity`, `parsePlayerPos` from this package.
- Produces:
  - `type PlacementEvent = { gamertag: string; dayzId: string; item: string; itemClass: string; pos: Vec3 }`
  - `parsePlacement(raw: string): PlacementEvent | null`
  - `ParsedLine` gains `{ kind: "placement"; event: PlacementEvent }`, mapping to `EventType` `"item.placed"`.

**⚠️ Before writing the regex:** confirm the real log shape. Pull a recent ADM file and grep it:

```bash
grep -h "placed " /path/to/*.ADM | grep -iE "fireplace|garden" | head -5
```

If the observed classnames differ from `BOOST_ITEM_CLASSES`, fix `rules.ts` in this task and note it in the commit. This is the spec's one blocking open item (§4.1).

- [ ] **Step 1: Write the failing test**

Create `packages/adm-parser/test/placement.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parsePlacement } from "../src/placement.js";
import { parseLine, eventTypeFor } from "../src/parse-line.js";

const ID = "A".repeat(40);

describe("parsePlacement", () => {
  it("parses a fireplace placement with the classname and the player position", () => {
    const raw = `19:12:44 | Player "Popin 0ps" (id=${ID} pos=<12470.7, 2386.4, 9.5>) placed Fireplace<Fireplace>`;
    expect(parsePlacement(raw)).toEqual({
      gamertag: "Popin 0ps", dayzId: ID, item: "Fireplace", itemClass: "Fireplace",
      pos: { x: 12470.7, y: 9.5, z: 2386.4 },
    });
  });

  it("parses a garden plot, whose DISPLAY NAME is useless", () => {
    // ⚠️ Observed verbatim in DayZServer_X1_x64_2026-09-15_11-01-51.ADM. A garden
    // plot logs its display name as "Nameless Object" — which is precisely why
    // detection keys on the CLASSNAME in the angle brackets and never on the
    // display name. Do not "fix" this test to say "Garden Plot".
    const raw = `11:58:12 | Player "Sasha" (id=${ID} pos=<9727.9, 8545.3, 214.3>) placed Nameless Object<GardenPlot>`;
    expect(parsePlacement(raw)).toMatchObject({ item: "Nameless Object", itemClass: "GardenPlot" });
  });

  it("parses a fireplace", () => {
    // Observed verbatim in DayZServer_X1_x64_2026-09-14_19-01-58.ADM.
    const raw = `19:58:00 | Player "Sasha" (id=${ID} pos=<2523.7, 12605.6, 304.8>) placed Fireplace<Fireplace>`;
    expect(parsePlacement(raw)).toMatchObject({ item: "Fireplace", itemClass: "Fireplace" });
  });

  it("parses a classname carrying an underscore", () => {
    // `Barrel_Blue` is real and observed; \w+ must cover it even though barrels
    // are not currently in BOOST_ITEM_CLASSES.
    const raw = `11:47:20 | Player "Sasha" (id=${ID} pos=<10774.3, 12572.5, 228.0>) placed Barrel<Barrel_Blue>`;
    expect(parsePlacement(raw)).toMatchObject({ item: "Barrel", itemClass: "Barrel_Blue" });
  });

  it("a gamertag carrying placement-shaped text cannot forge an event", () => {
    // The `placed X<Y>` text sits BEFORE the identity block, worn in the name.
    const raw = `19:12:44 | Player "X) placed Fireplace<Fireplace>" (id=${ID} pos=<100.0, 200.0, 12.0>) has connected`;
    expect(parsePlacement(raw)).toBeNull();
  });

  it("a line with no identity block is not a placement", () => {
    expect(parsePlacement(`19:12:44 | placed Fireplace<Fireplace>`)).toBeNull();
  });

  it("a flag pole kit still yields flagpole.placed, not item.placed", () => {
    const raw = `19:12:44 | Player "Popin 0ps" (id=${ID} pos=<12470.7, 2386.4, 9.5>) placed Flag Pole Kit<TerritoryFlagKit>`;
    const [line] = parseLine(raw);
    expect(line!.kind).toBe("flagpole");
    expect(eventTypeFor(line!)).toBe("flagpole.placed");
  });

  it("parseLine maps a fireplace to item.placed", () => {
    const raw = `19:12:44 | Player "Sasha" (id=${ID} pos=<100.0, 200.0, 12.0>) placed Fireplace<Fireplace>`;
    const [line] = parseLine(raw);
    expect(line!.kind).toBe("placement");
    expect(eventTypeFor(line!)).toBe("item.placed");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/adm-parser && npx vitest run test/placement.test.ts`
Expected: FAIL — cannot resolve `../src/placement.js`.

- [ ] **Step 3: Write the parser**

Create `packages/adm-parser/src/placement.ts`:

```ts
import type { Vec3 } from "@factions/domain";
import { parsePlayerPos } from "./coords.js";
import { parseIdentity } from "./identity.js";

export type PlacementEvent = {
  gamertag: string; dayzId: string;
  /** The display name, e.g. "Garden Plot". */
  item: string;
  /** The DayZ classname inside the angle brackets, e.g. "GardenPlot". */
  itemClass: string;
  pos: Vec3;
};

// ⚠️ Anchored on the identity block's OWN closing paren, exactly as
// structure.ts's BUILT_RE is and for the same reason: the gamertag is
// attacker-controlled and sits before the identity block, so a bare
// `placed (.+?)<(\w+)>` lets a gamertag carrying placement-shaped text forge
// an event from an ordinary connect line.
const PLACED_RE = /\(id=[0-9A-F]{40}[^)]*\)\s*placed (.+?)<(\w+)>\s*$/u;

export function parsePlacement(raw: string): PlacementEvent | null {
  const who = parseIdentity(raw);
  if (!who) return null;
  const pos = parsePlayerPos(raw);
  if (!pos) return null;
  const m = PLACED_RE.exec(raw);
  if (!m) return null;
  return {
    gamertag: who.gamertag, dayzId: who.dayzId,
    item: m[1]!.trim(), itemClass: m[2]!, pos,
  };
}
```

- [ ] **Step 4: Wire it into `parseLine`**

In `packages/adm-parser/src/parse-line.ts`:

Add the import beside the others:

```ts
import { parsePlacement, type PlacementEvent } from "./placement.js";
```

Add to the `ParsedLine` union:

```ts
  | { kind: "placement"; event: PlacementEvent }
```

Append the branch to `parseLine`, **after** the `emote` branch and immediately before `return []`. It must come after `parseFlagPole` (which runs third) so a flag pole kit keeps yielding `flagpole.placed`:

```ts
  const placement = parsePlacement(raw);
  if (placement) return [{ kind: "placement", event: placement }];
```

Add to `eventTypeFor`'s switch:

```ts
    case "placement":
      return "item.placed";
```

In `packages/domain/src/events.ts`, add to the `EventType` union:

```ts
  | "item.placed"
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/adm-parser && npx vitest run`
Expected: PASS. The existing `flagpole` and `structure` suites must be green — if `parseLine` now returns `placement` for a line that used to return `flagpole`, the branch is in the wrong position.

- [ ] **Step 6: Commit**

```bash
git add packages/adm-parser/src/placement.ts packages/adm-parser/src/parse-line.ts packages/adm-parser/test/placement.test.ts packages/domain/src/events.ts
git commit -m "feat(adm-parser): item.placed for deployable placements"
```

---

## Task 3: Schema and migration

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/migrations/0036_*.sql` (generated)
- Modify: `packages/domain/src/feed.ts`

**Interfaces:**
- Produces: drizzle tables `zonePlacements`, `zoneIncidents`, `zoneViolations`, `zoneIncidentParticipants`, `bans`; types `ViolationKind`, `BanStatus`; notice kinds `zone_warning`, `ban_applied`.

- [ ] **Step 1: Add the domain types**

⚠️ **The two new `CLAN_NOTICE_KINDS` do NOT belong in this task — they moved to Task 5.** `apps/bot/test/notice-text.test.ts` asserts a two-way diff between `CLAN_NOTICE_KINDS` and the renderer map, so adding a kind here leaves the whole `apps/bot` suite red until Task 5 ships the renderers. The kind and its renderer are two statements of one fact and must land in one commit. (Found the hard way: Task 3's first attempt did exactly this and broke the suite.)

Create the status unions in `packages/domain/src/enforcement.ts`:

```ts
export const VIOLATION_KINDS = ["dismantle", "build", "gate", "stack"] as const;
export type ViolationKind = (typeof VIOLATION_KINDS)[number];

/**
 * ⚠️ `pending` means "not yet on the Nitrado list". A Nitrado error must move
 * the row to `failed`, never leave it `pending` — a stuck `pending` renders
 * as a ban that no query ever revisits and no tick can ever lift.
 * `lift_pending` is the only route to `lifted`: never short-circuit.
 */
export const BAN_STATUSES = ["pending", "applied", "lift_pending", "lifted", "expired", "failed"] as const;
export type BanStatus = (typeof BAN_STATUSES)[number];
/** A Nitrado error this many times moves the row to `failed`. */
export const BAN_MAX_ATTEMPTS = 3;
```

- [ ] **Step 2: Add the tables**

Append to `packages/db/src/schema.ts` (import `ViolationKind`, `BanStatus` at the top beside the other domain types):

```ts
/**
 * Every boost-item placement inside a declared zone by a non-member.
 *
 * ⚠️ A LONE placement is recorded here and is NOT a violation: a player may
 * legitimately place a fireplace to cook or a garden plot to farm near a base
 * without knowing the base is there. The row exists so a LATER placement can
 * form a stack with it (spec §2.3). Only `boostStackFor` promotes these to a
 * violation.
 */
export const zonePlacements = pgTable("zone_placements", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  declarationId: bigint("declaration_id", { mode: "number" }).notNull().references(() => declarations.id, { onDelete: "cascade" }),
  eventId: bigint("event_id", { mode: "number" }).notNull(),
  dayzId: text("dayz_id").notNull(),
  gamertag: text("gamertag").notNull(),
  itemClass: text("item_class").notNull(),
  x: numeric("x", { precision: 12, scale: 2 }).notNull(),
  y: numeric("y", { precision: 12, scale: 2 }).notNull(),
  z: numeric("z", { precision: 12, scale: 2 }).notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
}, (t) => ({
  /** One row per event: a replayed event must not double-count. */
  oneRowPerEvent: uniqueIndex("zone_placements_event_uq").on(t.eventId),
  lookup: index("zone_placements_zone_idx").on(t.declarationId, t.occurredAt),
}));

/**
 * One incident per (declaration, rolling window). Opens on the first
 * violating act, extends on each later one, closes after
 * VIOLATION_INCIDENT_GAP_MS of quiet.
 */
export const zoneIncidents = pgTable("zone_incidents", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  declarationId: bigint("declaration_id", { mode: "number" }).notNull().references(() => declarations.id, { onDelete: "cascade" }),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
  lastActAt: timestamp("last_act_at", { withTimezone: true }).notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  partsDismantled: integer("parts_dismantled").notNull().default(0),
  partsBuilt: integer("parts_built").notNull().default(0),
  stackItems: integer("stack_items").notNull().default(0),
  hasBreach: boolean("has_breach").notNull().default(false),
  hasGate: boolean("has_gate").notNull().default(false),
  reportedAt: timestamp("reported_at", { withTimezone: true }),
  reportedByDiscordId: text("reported_by_discord_id"),
}, (t) => ({
  /** At most one OPEN incident per declaration — the partial index is the guard. */
  oneOpen: uniqueIndex("zone_incidents_one_open").on(t.declarationId).where(sql`closed_at IS NULL`),
  closedUnreported: index("zone_incidents_closed_idx").on(t.closedAt).where(sql`reported_at IS NULL`),
}));

/** One row per violating act. */
export const zoneViolations = pgTable("zone_violations", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  incidentId: bigint("incident_id", { mode: "number" }).notNull().references(() => zoneIncidents.id, { onDelete: "cascade" }),
  eventId: bigint("event_id", { mode: "number" }).notNull(),
  kind: text("kind").$type<ViolationKind>().notNull(),
  dayzId: text("dayz_id").notNull(),
  /** The part or item name as the log spelled it — "Fence", "Garden Plot". */
  what: text("what").notNull(),
  x: numeric("x", { precision: 12, scale: 2 }).notNull(),
  y: numeric("y", { precision: 12, scale: 2 }).notNull(),
  z: numeric("z", { precision: 12, scale: 2 }).notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
}, (t) => ({
  /** ⚠️ This is what makes a replayed event unable to double-count damage. */
  oneRowPerEvent: uniqueIndex("zone_violations_event_uq").on(t.eventId),
  byIncident: index("zone_violations_incident_idx").on(t.incidentId),
}));

/** Who took part. Liability is JOINT: each is sentenced on the incident total. */
export const zoneIncidentParticipants = pgTable("zone_incident_participants", {
  incidentId: bigint("incident_id", { mode: "number" }).notNull().references(() => zoneIncidents.id, { onDelete: "cascade" }),
  dayzId: text("dayz_id").notNull(),
  /** ⚠️ Frozen at event time — never re-resolved through identity_links later. */
  gamertag: text("gamertag").notNull(),
  warnedAt: timestamp("warned_at", { withTimezone: true }),
}, (t) => ({
  pk: primaryKey({ columns: [t.incidentId, t.dayzId] }),
}));

/**
 * Durable ban audit. Never rebuilt, never deleted.
 *
 * ⚠️ `dayzId` AND `gamertag` are both frozen here at creation. The ID is what
 * survives a rename; resolving the gamertag through a join at apply time is
 * how One Life's enforcer produced phantom re-bans (their
 * CODE-REVIEW-2026-08-04.md, finding 1).
 *
 * ⚠️ `expiresAt` NULL means PERMANENT, not "unknown".
 */
export const bans = pgTable("bans", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  incidentId: bigint("incident_id", { mode: "number" }).references(() => zoneIncidents.id),
  dayzId: text("dayz_id").notNull(),
  gamertag: text("gamertag").notNull(),
  bannedAt: timestamp("banned_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  status: text("status").$type<BanStatus>().notNull().default("pending"),
  /** Written from BAN_DRY_RUN at creation; a dry-run row never reaches Nitrado. */
  dryRun: boolean("dry_run").notNull().default(true),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  liftedAt: timestamp("lifted_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
}, (t) => ({
  /** One ban per incident per person. */
  oneperIncident: uniqueIndex("bans_incident_person_uq").on(t.incidentId, t.dayzId),
  work: index("bans_work_idx").on(t.status, t.expiresAt),
  byPerson: index("bans_person_idx").on(t.dayzId, t.bannedAt),
}));
```

- [ ] **Step 3: Generate and read the migration**

```bash
cd packages/db && npx drizzle-kit generate
```

Then **read the generated SQL** in `packages/db/migrations/0036_*.sql`. Confirm:
- It is `CREATE TABLE` only — no `ALTER … DROP`, no `ALTER … SET NOT NULL` on an existing table. This migration adds tables and nothing else, so the bot does **not** need stopping for it.
- The two partial indexes (`zone_incidents_one_open`, `zone_incidents_closed_idx`) carry their `WHERE` clauses. drizzle-kit has dropped partial predicates before; if the `WHERE` is missing, hand-edit the SQL to add it and note the hand-edit in `CLAUDE.md`'s migration warnings, as `0023` did.

- [ ] **Step 4: Verify the migration applies**

```bash
cd packages/db && TEST_DATABASE_FRESH=1 npx vitest run
```
Expected: PASS — a fresh `factions_test_db` builds through 0036.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations packages/domain/src/feed.ts packages/domain/src/enforcement.ts
git commit -m "feat(db): zone incident, violation, placement and ban tables (0036)"
```

---

## Task 4: Detection in `zone-tick.ts`

**Files:**
- Modify: `apps/bot/src/zone-tick.ts`
- Test: `apps/bot/test/zone-enforcement.test.ts`

**Interfaces:**
- Consumes: `boostStackFor`, `BoostPlacement`, `BOOST_ITEM_CLASSES`, `VIOLATION_INCIDENT_GAP_MS` from `@factions/domain`; `zonesFor`, `zoneContaining`, `isMemberOf`, `Zone`, `Tx` from `./zones.js`; the tables from Task 3.
- Produces: `zoneTick`'s `ZoneTickResult` gains `violations: number`. No new exported function — detection lives inside the existing loop.

- [ ] **Step 1: Write the failing test**

Create `apps/bot/test/zone-enforcement.test.ts`. It reuses `zone-tick.test.ts`'s harness verbatim — read that file first and copy its `beforeEach`, adding the new tables to the `truncate`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events,
  factionMembers, declarations, zoneIncidents, zoneViolations, zonePlacements,
  zoneIncidentParticipants, type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { zoneTick } from "../src/zone-tick.js";
import { seedFaction } from "./seed.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-15T12:00:00Z");
const at = (ms: number) => new Date(now.getTime() + ms);
const MEMBER = "M".repeat(40); const STRANGER = "X".repeat(40); const FRIEND = "F".repeat(40);

describe("zoneTick enforcement", () => {
  let db: Database; let serverId = 0; let admFileId = 0; let factionId = 0; let line = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table bans, zone_incident_participants, zone_violations, zone_placements, zone_incidents, intruder_sightings, clan_notices, declarations, poles, faction_members, factions, identity_links, events, raw_lines, adm_files, consumer_cursors, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true }).returning();
    admFileId = a!.id; line = 0;
    factionId = (await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", createdAt: at(-100_000), x: 5000, z: 5000 })).id;
    await db.insert(factionMembers).values([
      { factionId, serverId, dayzId: MEMBER, discordId: "1", role: "leader", joinedAt: now, status: "full" },
    ]);
  });

  const structure = (dayzId: string, x: number, z: number, part: string, kind: "base.built" | "base.dismantled", str = "Fence", when = now) =>
    db.insert(events).values({
      serverId, admFileId, lineIndex: line++, type: kind, occurredAt: when,
      payload: { dayzId, gamertag: "Sasha", action: kind === "base.built" ? "built" : "dismantled", part, structure: str, tool: null, pos: { x, y: 100, z } },
    }).returning({ id: events.id });

  const placed = (dayzId: string, x: number, y: number, z: number, itemClass: string, when = now) =>
    db.insert(events).values({
      serverId, admFileId, lineIndex: line++, type: "item.placed", occurredAt: when,
      payload: { dayzId, gamertag: "Sasha", item: itemClass, itemClass, pos: { x, y, z } },
    }).returning({ id: events.id });

  const incidents = () => db.select().from(zoneIncidents).orderBy(zoneIncidents.id);
  const violations = () => db.select().from(zoneViolations).orderBy(zoneViolations.id);

  it("a non-member dismantling inside the zone opens an incident and counts the loss", async () => {
    await structure(STRANGER, 5010, 5010, "Fence Kit", "base.dismantled");
    await structure(STRANGER, 5011, 5010, "Fence Kit", "base.dismantled");
    await zoneTick(db, { now });
    const [i] = await incidents();
    expect(i).toMatchObject({ partsDismantled: 2, partsBuilt: 0, hasBreach: false, hasGate: false, closedAt: null });
    expect(await violations()).toHaveLength(2);
  });

  it("a full member is never a violation", async () => {
    await structure(MEMBER, 5010, 5010, "Fence Kit", "base.dismantled");
    await zoneTick(db, { now });
    expect(await incidents()).toHaveLength(0);
  });

  it("an act outside the zone is never a violation", async () => {
    await structure(STRANGER, 5300, 5300, "Fence Kit", "base.dismantled");
    await zoneTick(db, { now });
    expect(await incidents()).toHaveLength(0);
  });

  it("building is a breach, and a gate sets hasGate too", async () => {
    await structure(STRANGER, 5010, 5010, "Watchtower Kit", "base.built");
    await structure(STRANGER, 5012, 5010, "Gate", "base.built");
    await zoneTick(db, { now });
    const [i] = await incidents();
    expect(i).toMatchObject({ partsBuilt: 2, hasBreach: true, hasGate: true });
  });

  it("a lone fireplace is recorded but is not a violation", async () => {
    await placed(STRANGER, 5010, 100, 5010, "Fireplace");
    await zoneTick(db, { now });
    expect(await db.select().from(zonePlacements)).toHaveLength(1);
    expect(await incidents()).toHaveLength(0);
  });

  it("a co-located pair with a rise is a stack: one breach, both items counted", async () => {
    await placed(STRANGER, 5010, 100.0, 5010, "Fireplace");
    await placed(STRANGER, 5010.3, 100.9, 5010.2, "GardenPlot", at(60_000));
    await zoneTick(db, { now: at(120_000) });
    const [i] = await incidents();
    expect(i).toMatchObject({ stackItems: 2, hasBreach: true, hasGate: false });
  });

  it("three garden plots side by side are a farm, not a stack", async () => {
    await placed(STRANGER, 5010, 100, 5010, "GardenPlot");
    await placed(STRANGER, 5013, 100, 5010, "GardenPlot", at(60_000));
    await placed(STRANGER, 5016, 100, 5010, "GardenPlot", at(120_000));
    await zoneTick(db, { now: at(180_000) });
    expect(await incidents()).toHaveLength(0);
  });

  it("every contributor to one incident becomes a participant, gamertag frozen", async () => {
    await structure(STRANGER, 5010, 5010, "Fence Kit", "base.dismantled");
    await structure(FRIEND, 5011, 5010, "Fence Kit", "base.dismantled");
    await zoneTick(db, { now });
    const [i] = await incidents();
    const parts = await db.select().from(zoneIncidentParticipants).where(eq(zoneIncidentParticipants.incidentId, i!.id));
    expect(parts.map((p) => p.dayzId).sort()).toEqual([FRIEND, STRANGER].sort());
    expect(parts.every((p) => p.gamertag === "Sasha")).toBe(true);
  });

  it("acts separated by more than the gap belong to different incidents", async () => {
    await structure(STRANGER, 5010, 5010, "Fence Kit", "base.dismantled");
    await zoneTick(db, { now });
    await db.update(zoneIncidents).set({ closedAt: at(60_000) });
    await structure(STRANGER, 5010, 5010, "Fence Kit", "base.dismantled", "Fence", at(120_000));
    await zoneTick(db, { now: at(180_000) });
    expect(await incidents()).toHaveLength(2);
  });

  it("a replayed event does not double-count damage", async () => {
    const [e] = await structure(STRANGER, 5010, 5010, "Fence Kit", "base.dismantled");
    await zoneTick(db, { now });
    await db.execute(sql`update consumer_cursors set last_event_id = ${e!.id - 1} where consumer = 'zone-watch'`);
    await zoneTick(db, { now });
    const [i] = await incidents();
    expect(i!.partsDismantled).toBe(1);
    expect(await violations()).toHaveLength(1);
  });

  it("a stale act is skipped entirely — a rewound cursor cannot manufacture incidents", async () => {
    await structure(STRANGER, 5010, 5010, "Fence Kit", "base.dismantled", "Fence", at(-10 * 86_400_000));
    await zoneTick(db, { now });
    expect(await incidents()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/bot && npx vitest run test/zone-enforcement.test.ts`
Expected: FAIL — `zone_incidents` has no rows; the tick does not write them yet.

- [ ] **Step 3: Add the incident writer to `zone-tick.ts`**

Add these helpers above `zoneTick` in `apps/bot/src/zone-tick.ts`:

```ts
/**
 * The open incident for this zone, extended to `occurredAt`, or a new one.
 *
 * ⚠️ `zone_incidents_one_open` (partial unique on declaration_id WHERE
 * closed_at IS NULL) is what makes two acts in the same batch share one row
 * rather than race into two.
 */
async function openIncident(tx: Tx, zone: Zone, serverId: number, occurredAt: Date): Promise<number> {
  const [open] = await tx.select({ id: zoneIncidents.id, lastActAt: zoneIncidents.lastActAt })
    .from(zoneIncidents)
    .where(and(eq(zoneIncidents.declarationId, zone.declarationId), isNull(zoneIncidents.closedAt)));
  if (open) {
    if (occurredAt > open.lastActAt) {
      await tx.update(zoneIncidents).set({ lastActAt: occurredAt }).where(eq(zoneIncidents.id, open.id));
    }
    return open.id;
  }
  const [fresh] = await tx.insert(zoneIncidents)
    .values({ serverId, declarationId: zone.declarationId, openedAt: occurredAt, lastActAt: occurredAt })
    .returning({ id: zoneIncidents.id });
  return fresh!.id;
}

/**
 * Record one violating act and fold it into the incident's totals.
 *
 * Returns false when the event was already recorded — the `zone_violations_event_uq`
 * conflict. ⚠️ The totals are updated ONLY on a fresh insert, which is what
 * makes a replayed event unable to double-count damage.
 */
async function recordViolation(
  tx: Tx, incidentId: number, eventId: number, kind: ViolationKind,
  dayzId: string, gamertag: string, what: string, pos: Vec3, occurredAt: Date,
): Promise<boolean> {
  const [row] = await tx.insert(zoneViolations).values({
    incidentId, eventId, kind, dayzId, what,
    x: pos.x.toFixed(2), y: pos.y.toFixed(2), z: pos.z.toFixed(2), occurredAt,
  }).onConflictDoNothing({ target: zoneViolations.eventId }).returning({ id: zoneViolations.id });
  if (!row) return false;

  const bump = kind === "dismantle" ? { partsDismantled: sql`${zoneIncidents.partsDismantled} + 1` }
    : kind === "stack" ? { stackItems: sql`${zoneIncidents.stackItems} + 1`, hasBreach: true }
    : { partsBuilt: sql`${zoneIncidents.partsBuilt} + 1`, hasBreach: true };
  await tx.update(zoneIncidents)
    .set({ ...bump, ...(kind === "gate" ? { hasGate: true, hasBreach: true } : {}) })
    .where(eq(zoneIncidents.id, incidentId));

  await tx.insert(zoneIncidentParticipants)
    .values({ incidentId, dayzId, gamertag })
    .onConflictDoNothing();
  return true;
}
```

Note `kind === "gate"` must *also* increment `partsBuilt` — a gate is a build. Write the `bump` so that `gate` falls into the built branch and the `hasGate` spread adds to it; the ternary above does exactly that because `"gate"` is not `"dismantle"` or `"stack"`.

- [ ] **Step 4: Handle the three act types in the tick loop**

Inside `zoneTick`'s per-event block, extend the existing `isBuild` arm and add an `item.placed` arm. The existing owner-alert behaviour is unchanged; this is added beside it:

```ts
        if (isBuild) {
          const incidentId = await openIncident(tx, hit.zone, ev.serverId, ev.occurredAt);
          const part = readPart(ev.payload);
          if (ev.type === "base.dismantled") {
            if (await recordViolation(tx, incidentId, ev.id, "dismantle", fix.dayzId, gamertag, part, fix, ev.occurredAt)) out.violations++;
            if (await alertOwner(tx, hit.zone, ev.serverId, "dismantle", ev.occurredAt, { gamertag, part })) out.alerts++;
          } else {
            const kind = isGate(ev.payload) ? "gate" : "build";
            if (await recordViolation(tx, incidentId, ev.id, kind, fix.dayzId, gamertag, part, fix, ev.occurredAt)) out.violations++;
            if (kind === "gate" && await alertOwner(tx, hit.zone, ev.serverId, "gate_built", ev.occurredAt, { gamertag })) out.alerts++;
          }
          return done();
        }
```

Add the placement arm, after the build arm and before the position arm:

```ts
        if (isPlacement) {
          // ⚠️ A LONE placement is recorded and is NOT a violation (spec §2.3):
          // a player may legitimately cook or farm near a base they cannot see.
          // It becomes one only when a LATER placement stacks on it.
          const [row] = await tx.insert(zonePlacements).values({
            serverId: ev.serverId, declarationId: hit.zone.declarationId, eventId: ev.id,
            dayzId: fix.dayzId, gamertag, itemClass: readItemClass(ev.payload),
            x: fix.x.toFixed(2), y: fix.y.toFixed(2), z: fix.z.toFixed(2), occurredAt: ev.occurredAt,
          }).onConflictDoNothing({ target: zonePlacements.eventId })
            .returning({ id: zonePlacements.id });
          if (!row) return done();   // replay

          const recent = await tx.select({
            dayzId: zonePlacements.dayzId, x: zonePlacements.x, y: zonePlacements.y,
            z: zonePlacements.z, occurredAt: zonePlacements.occurredAt, id: zonePlacements.id,
          }).from(zonePlacements).where(and(
            eq(zonePlacements.declarationId, hit.zone.declarationId),
            gte(zonePlacements.occurredAt, new Date(ev.occurredAt.getTime() - BOOST_STACK_WINDOW_MS)),
            ne(zonePlacements.id, row.id),
          ));
          const latest: BoostPlacement = { dayzId: fix.dayzId, x: fix.x, y: fix.y, z: fix.z, occurredAt: ev.occurredAt };
          const stack = boostStackFor(recent.map(toBoostPlacement), latest);
          if (!stack) return done();

          const incidentId = await openIncident(tx, hit.zone, ev.serverId, ev.occurredAt);
          if (await recordViolation(tx, incidentId, ev.id, "stack", fix.dayzId, gamertag, readItemClass(ev.payload), fix, ev.occurredAt)) out.violations++;
          // Everyone who contributed to the cluster is a participant, even
          // where their own placement predates the stack becoming one.
          for (const member of stack) {
            await tx.insert(zoneIncidentParticipants)
              .values({ incidentId, dayzId: member.dayzId, gamertag })
              .onConflictDoNothing();
          }
          return done();
        }
```

Add the small readers beside `readPart`:

```ts
function readItemClass(payload: unknown): string {
  const c = (payload as Record<string, unknown>).itemClass;
  return typeof c === "string" && c !== "" ? c : "unknown";
}

const toBoostPlacement = (r: { dayzId: string; x: string; y: string; z: string; occurredAt: Date }): BoostPlacement =>
  ({ dayzId: r.dayzId, x: Number(r.x), y: Number(r.y), z: Number(r.z), occurredAt: r.occurredAt });
```

And extend the event filter near the top of the loop so `item.placed` is scanned — it must be gated on `BOOST_ITEM_CLASSES`, so an ordinary tent or barrel placement is ignored entirely:

```ts
      const isPlacement = ev.type === "item.placed"
        && (BOOST_ITEM_CLASSES as readonly string[]).includes(readItemClass(ev.payload));
      if (!isPosition && !isBuild && !isPlacement) continue;
```

Add `violations: 0` to `out`'s initialiser and `violations: number` to `ZoneTickResult`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/bot && npx vitest run test/zone-enforcement.test.ts test/zone-tick.test.ts`
Expected: PASS. **`zone-tick.test.ts` must stay green** — the existing intruder, dismantle and gate alerts are unchanged behaviour.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/zone-tick.ts apps/bot/test/zone-enforcement.test.ts
git commit -m "feat(bot): detect zone build/dismantle/stack violations into incidents"
```

---

## Task 5: Close incidents and warn

**Files:**
- Create: `apps/bot/src/violation-tick.ts`
- Modify: `apps/bot/src/notice-text.ts`
- Test: `apps/bot/test/violation-tick.test.ts`

**Interfaces:**
- Consumes: `VIOLATION_INCIDENT_GAP_MS` from `@factions/domain`; `noticeUserTx` from `@factions/roster/internal`; Task 3's tables.
- Produces: `violationTick(db: Database, opts?: { now?: Date }): Promise<{ closed: number; warned: number }>`.

- [ ] **Step 1: Write the failing test**

Create `apps/bot/test/violation-tick.test.ts`, reusing Task 4's `beforeEach` verbatim plus an `identityLinks` insert:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, identityLinks, declarations, zoneIncidents, zoneIncidentParticipants, clanNotices, type Database } from "@factions/db";
import { VIOLATION_INCIDENT_GAP_MS } from "@factions/domain";
import { sql, eq } from "drizzle-orm";
import { violationTick } from "../src/violation-tick.js";
// …harness as in Task 4, plus:
//   await db.insert(identityLinks).values({ dayzId: STRANGER, discordId: "99", gamertag: "Sasha", linkedAt: now });

describe("violationTick", () => {
  it("closes an incident that has been quiet for the gap and warns each linked participant once", async () => {
    // seed: an incident with lastActAt = now - gap - 1min, one participant STRANGER
    const r = await violationTick(db, { now });
    expect(r).toMatchObject({ closed: 1, warned: 1 });
    const [n] = await db.select().from(clanNotices).where(eq(clanNotices.kind, "zone_warning"));
    expect(n).toMatchObject({ target: "dm", discordTargetId: "99", factionId: null });
    expect(n!.payload).not.toHaveProperty("x");
  });

  it("does not close an incident still inside the gap", async () => {
    // lastActAt = now - 1min
    expect(await violationTick(db, { now })).toMatchObject({ closed: 0, warned: 0 });
  });

  it("warns each participant exactly once, even across two ticks", async () => {
    await violationTick(db, { now });
    await violationTick(db, { now });
    expect(await db.select().from(clanNotices).where(eq(clanNotices.kind, "zone_warning"))).toHaveLength(1);
  });

  it("an unlinked participant gets no DM but the incident still closes", async () => {
    // participant UNLINKED with no identity_links row
    const r = await violationTick(db, { now });
    expect(r).toMatchObject({ closed: 1, warned: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/bot && npx vitest run test/violation-tick.test.ts`
Expected: FAIL — cannot resolve `../src/violation-tick.js`.

- [ ] **Step 3: Write the tick**

Create `apps/bot/src/violation-tick.ts`:

```ts
import type { Database } from "@factions/db";
import { identityLinks, zoneIncidents, zoneIncidentParticipants, factions, declarations } from "@factions/db";
import { VIOLATION_INCIDENT_GAP_MS } from "@factions/domain";
import { noticeUserTx } from "@factions/roster/internal";
import { and, eq, isNull, lte } from "drizzle-orm";

export type ViolationTickResult = { closed: number; warned: number };

/**
 * Closes incidents that have gone quiet and warns their participants.
 *
 * ⚠️ The warning is a HEADS-UP, not a charge. There is no helper permit
 * (spec §2.4), so a player the base owner invited to help WILL receive this
 * message. Its wording is the only thing standing between an invited friend
 * and a support ticket — see notice-text.ts.
 *
 * `warned_at` on the participant row is what makes the DM exactly-once.
 */
export async function violationTick(db: Database, opts: { now?: Date } = {}): Promise<ViolationTickResult> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - VIOLATION_INCIDENT_GAP_MS);
  const out: ViolationTickResult = { closed: 0, warned: 0 };

  const due = await db.select({ id: zoneIncidents.id, serverId: zoneIncidents.serverId, declarationId: zoneIncidents.declarationId })
    .from(zoneIncidents)
    .where(and(isNull(zoneIncidents.closedAt), lte(zoneIncidents.lastActAt, cutoff)));

  for (const incident of due) {
    await db.transaction(async (tx) => {
      const [row] = await tx.update(zoneIncidents).set({ closedAt: now })
        .where(and(eq(zoneIncidents.id, incident.id), isNull(zoneIncidents.closedAt)))
        .returning({
          id: zoneIncidents.id, partsDismantled: zoneIncidents.partsDismantled,
          partsBuilt: zoneIncidents.partsBuilt, stackItems: zoneIncidents.stackItems,
        });
      if (!row) return;   // another tick closed it
      out.closed++;

      const tag = await ownerTagFor(tx, incident.declarationId);
      const participants = await tx.select({ dayzId: zoneIncidentParticipants.dayzId })
        .from(zoneIncidentParticipants)
        .where(and(eq(zoneIncidentParticipants.incidentId, incident.id), isNull(zoneIncidentParticipants.warnedAt)));

      for (const p of participants) {
        const [link] = await tx.select({ discordId: identityLinks.discordId })
          .from(identityLinks).where(eq(identityLinks.dayzId, p.dayzId));
        // Mark warned either way: an unlinked offender is not owed a second
        // attempt if they link later, and the ban does not need the link.
        await tx.update(zoneIncidentParticipants).set({ warnedAt: now })
          .where(and(eq(zoneIncidentParticipants.incidentId, incident.id), eq(zoneIncidentParticipants.dayzId, p.dayzId)));
        if (!link) continue;
        await noticeUserTx(tx, {
          serverId: incident.serverId, factionId: null, discordId: link.discordId,
          kind: "zone_warning", occurredAt: now,
          // ⚠️ No coordinates — clan_notices_no_coordinates rejects x/y/z/poleKey.
          payload: { tag, dismantled: row.partsDismantled, built: row.partsBuilt, stacked: row.stackItems },
        });
        out.warned++;
      }
    });
  }
  return out;
}
```

And `ownerTagFor` in the same file:

```ts
/**
 * How the warning DM names the base's owner.
 *
 * ⚠️ A solo declaration renders as "a declared base", never as the owner's
 * name. Naming a solo player to a stranger who was just inside their zone
 * hands an attacker the one fact the map is built to withhold.
 */
async function ownerTagFor(tx: Tx, declarationId: number): Promise<string> {
  const [row] = await tx.select({ tag: factions.tag })
    .from(declarations)
    .leftJoin(factions, eq(factions.id, declarations.ownerFactionId))
    .where(eq(declarations.id, declarationId));
  return row?.tag ? `[${row.tag}]` : "a declared base";
}
```

- [ ] **Step 4: Add the notice kinds AND their renderers, in ONE commit**

First, in `packages/domain/src/feed.ts`, append the two kinds to the END of `CLAN_NOTICE_KINDS` so existing order is untouched:

```ts
  "zone_warning", "ban_applied",
```

⚠️ These moved here from Task 3. `apps/bot/test/notice-text.test.ts` asserts a two-way diff between `CLAN_NOTICE_KINDS` and the renderer map below — a kind without a renderer turns the entire `apps/bot` suite red, and a renderer without a kind does the same. They are two statements of one fact; commit them together.

Then in `apps/bot/src/notice-text.ts`, add to the renderer map:

```ts
  zone_warning: (p) => {
    const acts = [
      Number(p.dismantled) > 0 ? `dismantling ${p.dismantled} part(s)` : null,
      Number(p.built) > 0 ? `building ${p.built} part(s)` : null,
      Number(p.stacked) > 0 ? `stacking ${p.stacked} item(s)` : null,
    ].filter(Boolean).join(" and ");
    return `⚠️ The log recorded you ${acts} inside ${p.tag}'s declared base zone. **If they asked you to help, ignore this.** If not, an officer of that clan can report it, and the penalty scales with the damage.`;
  },
  ban_applied: (p) => p.until
    ? `⛔ You are banned from the server until ${p.until} — ${p.reason}.`
    : `⛔ You are permanently banned from the server — ${p.reason}.`,
```

`apps/bot/test/notice-text.test.ts` pins that every kind in `CLAN_NOTICE_KINDS` has a renderer and vice versa; it will fail until both are added.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/bot && npx vitest run test/violation-tick.test.ts test/notice-text.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/violation-tick.ts apps/bot/src/notice-text.ts apps/bot/test/violation-tick.test.ts
git commit -m "feat(bot): close quiet incidents and warn participants"
```

---

## Task 6: The report read and write

**Files:**
- Create: `packages/roster/src/internal/incidents.ts`
- Modify: `packages/roster/src/base.ts`, `packages/roster/src/api.ts`, `packages/roster/src/index.ts`, `packages/roster/src/internal/index.ts`
- Test: `packages/roster/test/incidents.test.ts`

**Interfaces:**
- Consumes: `actorFor`, `isRefusal`, `ActorRefusal` from `./actor`; `activeServerId` from `./server`; `sentenceMsFor`, `IncidentDamage`, `VIOLATION_REPORT_WINDOW_MS` from `@factions/domain`.
- Produces:
  - `type ReportableIncident = { id: number; openedAt: Date; closedAt: Date; partsDismantled: number; partsBuilt: number; stackItems: number; hasBreach: boolean; hasGate: boolean; participants: { gamertag: string }[]; acts: { kind: ViolationKind; what: string; x: number; z: number; at: Date }[] }`
  - `reportableIncidentsDb(db: Database, now: Date, discordId: string): Promise<ReportableIncident[]>`
  - `REPORT_REASONS = ["not-linked", "not-owner", "not-officer", "no-incident", "window-closed", "already-reported"] as const`
  - `reportIncidentDb(db: Database, now: Date, discordId: string, incidentId: number): Promise<{ ok: true; banned: number } | { ok: false; reason: ReportReason }>`
  - `BaseView`'s linked branch gains `incidents: ReportableIncident[]`.

- [ ] **Step 1: Write the failing test**

Create `packages/roster/test/incidents.test.ts` following `packages/roster/test/base.test.ts`'s harness. Cases:

```ts
it("a solo declarant sees incidents at their own base and nobody else's", async () => { /* … */ });
it("a clan officer sees incidents at the clan's base", async () => { /* … */ });
it("a full member who is not an officer sees them but cannot report", async () => {
  expect(await reportIncidentDb(db, now, MEMBER_DISCORD, id)).toEqual({ ok: false, reason: "not-officer" });
});
it("an incident older than the report window is not reportable", async () => {
  const late = new Date(closedAt.getTime() + VIOLATION_REPORT_WINDOW_MS + 1000);
  expect(await reportIncidentDb(db, late, OFFICER, id)).toEqual({ ok: false, reason: "window-closed" });
});
it("an open incident is not reportable", async () => { /* closedAt null → no-incident */ });
it("reporting writes one ban per participant with the joint incident total", async () => {
  const r = await reportIncidentDb(db, now, OFFICER, id);
  expect(r).toEqual({ ok: true, banned: 2 });
  const rows = await db.select().from(bans);
  // both offenders serve the SAME term: liability is joint
  expect(new Set(rows.map((b) => b.expiresAt!.getTime())).size).toBe(1);
});
it("a second report on the same incident is refused", async () => {
  await reportIncidentDb(db, now, OFFICER, id);
  expect(await reportIncidentDb(db, now, OFFICER, id)).toEqual({ ok: false, reason: "already-reported" });
});
it("a repeat offender's second upheld report doubles the term", async () => { /* … */ });
it("a third upheld report in the season is permanent — expiresAt is null", async () => { /* … */ });
it("the ban freezes dayzId and the gamertag recorded at event time", async () => { /* … */ });
it("a stranger cannot report an incident at a base they do not own", async () => {
  expect(await reportIncidentDb(db, now, STRANGER_DISCORD, id)).toEqual({ ok: false, reason: "not-owner" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/roster && npx vitest run test/incidents.test.ts`
Expected: FAIL — no module `../src/internal/incidents`.

- [ ] **Step 3: Write the store**

Create `packages/roster/src/internal/incidents.ts`. The reporting write, in one transaction:

```ts
/**
 * Press charges on a bot-witnessed incident.
 *
 * ⚠️ This is a PROSECUTION TOGGLE, not a report form. It carries no free text
 * and cannot describe an act the log did not witness — the reporter chooses
 * only WHETHER to charge, never WHAT the charge is. That property is the
 * whole reason a player's click may trigger a ban with no staff adjudicator
 * in the loop (spec §1). Do not add a caller-supplied field to it.
 *
 * Liability is JOINT (spec §7): every participant is sentenced on the
 * incident's full damage total, which removes the incentive to spread
 * dismantling across accounts to stay under a threshold.
 */
export async function reportIncidentDb(
  db: Database, now: Date, discordId: string, incidentId: number,
): Promise<ReportOutcome> {
  return db.transaction(async (tx) => {
    const [link] = await tx.select({ dayzId: identityLinks.dayzId })
      .from(identityLinks).where(eq(identityLinks.discordId, discordId));
    if (!link) return { ok: false as const, reason: "not-linked" as const };

    // Lock order (CLAUDE.md §4.12): declarations before zone_incidents.
    const [incident] = await tx.select().from(zoneIncidents)
      .where(eq(zoneIncidents.id, incidentId)).for("update");
    if (!incident || incident.closedAt === null) return { ok: false as const, reason: "no-incident" as const };
    if (incident.reportedAt !== null) return { ok: false as const, reason: "already-reported" as const };
    if (now.getTime() - incident.closedAt.getTime() > VIOLATION_REPORT_WINDOW_MS) {
      return { ok: false as const, reason: "window-closed" as const };
    }

    const [decl] = await tx.select({
      ownerFactionId: declarations.ownerFactionId, ownerDayzId: declarations.ownerDayzId,
    }).from(declarations).where(eq(declarations.id, incident.declarationId));
    if (!decl) return { ok: false as const, reason: "no-incident" as const };

    if (decl.ownerFactionId === null) {
      // A solo base: only the declarant may press charges.
      if (decl.ownerDayzId !== link.dayzId) return { ok: false as const, reason: "not-owner" as const };
    } else {
      // A clan base: officer+, the same gate grantGuestPassDbFor uses.
      const [member] = await tx.select({ role: factionMembers.role }).from(factionMembers)
        .where(and(
          eq(factionMembers.factionId, decl.ownerFactionId),
          eq(factionMembers.dayzId, link.dayzId),
          eq(factionMembers.status, "full"),
        ));
      if (!member) return { ok: false as const, reason: "not-owner" as const };
      if (member.role !== "leader" && member.role !== "officer") {
        return { ok: false as const, reason: "not-officer" as const };
      }
    }

    await tx.update(zoneIncidents)
      .set({ reportedAt: now, reportedByDiscordId: discordId })
      .where(eq(zoneIncidents.id, incidentId));

    const damage: IncidentDamage = {
      partsDismantled: incident.partsDismantled, partsBuilt: incident.partsBuilt,
      stackItems: incident.stackItems, hasBreach: incident.hasBreach, hasGate: incident.hasGate,
    };
    const seasonStart = await seasonStartFor(tx, incident.serverId, now);
    const participants = await tx.select({
      dayzId: zoneIncidentParticipants.dayzId, gamertag: zoneIncidentParticipants.gamertag,
    }).from(zoneIncidentParticipants).where(eq(zoneIncidentParticipants.incidentId, incidentId));

    let banned = 0;
    for (const p of participants) {
      // Prior UPHELD reports this season — the bans table is the tally.
      const prior = await tx.select({ id: bans.id }).from(bans).where(and(
        eq(bans.dayzId, p.dayzId), gte(bans.bannedAt, seasonStart),
      ));
      const ms = sentenceMsFor(damage, prior.length);
      await tx.insert(bans).values({
        serverId: incident.serverId, incidentId, dayzId: p.dayzId,
        // ⚠️ Frozen here, both of them. Never re-resolved at apply time.
        gamertag: p.gamertag,
        bannedAt: now,
        // ⚠️ null means PERMANENT, not unknown.
        expiresAt: ms === null ? null : new Date(now.getTime() + ms),
        // `dry_run` is left at the column default and STAMPED BY ban-tick at
        // apply time with the mode that actually ran. The web app must not
        // need to know the bot's BAN_DRY_RUN setting.
        status: "pending",
      }).onConflictDoNothing();
      banned++;
    }
    return { ok: true as const, banned };
  });
}
```

`seasonStartFor` reads the open season's `started_at` for the server, falling back to the epoch when no season is open, so an unseeded database cannot accidentally read every historical ban as a prior offence.

⚠️ The lock order in `CLAUDE.md` §4.12 is `factions` → `declarations` → `poles` → … Add `zone_incidents` → `zone_incident_participants` → `bans` at the END of that order and take them in that sequence here.

- [ ] **Step 4: Surface them on `BaseView`**

In `packages/roster/src/base.ts`, add `incidents: ReportableIncident[]` to the linked branch of `BaseView` and populate it from `reportableIncidentsDb`. Export the wrappers through `api.ts` and `index.ts`.

⚠️ `packages/roster/test/roster-exports.ts` and `apps/web/test/smoke.test.ts` both pin the exact export list of `@factions/roster`. Add `reportIncident` and `REPORT_REASONS` to both arrays, in alphabetical position, or those two suites fail.

⚠️ **`apps/bot/test/parity.test.ts` will also fail.** It asserts that every *write* `@factions/roster` exports maps either to a shipped Discord command (`COMMANDS`) or to an explicitly deferred one (`PENDING`) — and `PENDING` is currently empty on purpose, so that "parity cannot rot quietly on the next increment". `reportIncident` is a write.

Add it to `PENDING`, not to `COMMANDS`, with a comment naming this plan and the reason:

```ts
const PENDING: Record<string, string> = {
  // 2026-09-15 zone enforcement. Pressing charges triggers an automatic ban, and
  // the evidence an officer needs to decide — part names, distances, timestamps,
  // coordinates — cannot be shown in Discord: `clan_notices_no_coordinates`
  // forbids coordinates in any notice payload, and the guide's rule that a base's
  // location never appears in Discord is the reason that CHECK exists. So the
  // decision surface is the owner-gated /base page. A `/base report` command that
  // listed incidents by id WITHOUT the evidence would be a ban trigger with the
  // reasoning stripped out, which is worse than no command.
  reportIncident: "base report",
};
```

This is bookkeeping, not a decision to skip parity — it records the debt where the next increment will see it. Whether a `/base report` command should ship anyway is a product call for the repo's owner, and is out of scope here.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/roster && npx vitest run`
Expected: PASS, including `roster-exports`.

- [ ] **Step 6: Commit**

```bash
git add packages/roster/src packages/roster/test
git commit -m "feat(roster): reportable incidents and the prosecution write"
```

---

## Task 7: The `/base` report surface

**Files:**
- Modify: `apps/web/app/(site)/base/page.tsx`
- Create: `apps/web/app/(site)/base/report-button.tsx`
- Create: `apps/web/app/api/base/report/route.ts`
- Test: `apps/web/test/base-report.test.ts`

**Interfaces:**
- Consumes: `baseFor`, `reportIncident`, `REPORT_REASONS` from `@factions/roster`.
- Produces: `POST /api/base/report` with body `{ incidentId: number }`, answering `{ ok: true; banned: number }` or `{ ok: false; reason: ReportReason }`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/base-report.test.ts`:

```ts
it("the route refuses an unauthenticated caller", async () => { /* 401 */ });
it("the route rejects a non-numeric incidentId without touching the store", async () => { /* 400 */ });
it("a refusal reason renders as copy, never as a raw enum", async () => {
  for (const reason of REPORT_REASONS) expect(REPORT_COPY[reason]).toBeTruthy();
});
it("the response is never cached", async () => {
  expect(res.headers.get("cache-control")).toContain("no-store");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run test/base-report.test.ts`
Expected: FAIL — the route does not exist.

- [ ] **Step 3: Write the route and the component**

`app/api/base/report/route.ts`, following the existing `apps/web/app/api/` handlers for the session lookup:

```ts
import { reportIncident } from "@factions/roster";
import { NextResponse } from "next/server";
import { sessionDiscordId } from "@/lib/session";

/** This response names offenders and their sentences. It is never cached. */
const HEADERS = { "Cache-Control": "no-store, private" };

export async function POST(req: Request) {
  const discordId = await sessionDiscordId();
  if (!discordId) return NextResponse.json({ ok: false, reason: "not-linked" }, { status: 401, headers: HEADERS });

  const body = await req.json().catch(() => null) as { incidentId?: unknown } | null;
  const incidentId = Number(body?.incidentId);
  // Validate BEFORE touching the store: NaN would otherwise reach a query.
  if (!Number.isInteger(incidentId) || incidentId <= 0) {
    return NextResponse.json({ ok: false, reason: "no-incident" }, { status: 400, headers: HEADERS });
  }

  const result = await reportIncident(new Date(), discordId, incidentId);
  return NextResponse.json(result, { status: result.ok ? 200 : 409, headers: HEADERS });
}
```

`Cache-Control: no-store, private` is the same header rule `apps/web/test/map-route-headers.test.ts` pins for position responses.

`report-button.tsx` is a client component: a confirm step that states the computed term before the click, then the POST. The confirm must say plainly that this bans the named players automatically.

In `page.tsx`, render the incident list only when `view.linked && view.incidents.length > 0`. Coordinates **may** be shown here — this page is already gated to the viewer's own base, which is what makes it the right home for evidence (spec §6.2).

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && npx vitest run && npx next build`
Expected: PASS and a clean build.

⚠️ `next build` is the only thing that catches a client component importing `@factions/roster`'s barrel — that pulls the pooled postgres client in and fails with "Can't resolve 'fs'", which no typecheck or vitest run catches. It broke a deploy on 2026-09-13. Keep `report-button.tsx` free of roster imports; pass everything in as props.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app apps/web/test/base-report.test.ts
git commit -m "feat(web): press charges on a witnessed incident from /base"
```

---

## Task 8: Nitrado ban-list methods

Ported from `~/Development/dayz-one-life/one-life/packages/nitrado/src/client.ts:39-96`. Read that file first.

**Files:**
- Modify: `packages/nitrado/src/client.ts`
- Test: `packages/nitrado/test/bans.test.ts`

**Interfaces:**
- Produces on `NitradoClient`: `getBans(): Promise<string[]>`, `addBans(names: string[]): Promise<void>`, `removeBans(names: string[]): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `packages/nitrado/test/bans.test.ts`, injecting `fetchFn` as the existing client tests do:

```ts
it("getBans splits the \\r\\n-joined field and drops blanks", async () => { /* … */ });
it("addBans writes both entries in ONE read-modify-write", async () => {
  await client.addBans(["ABC123", "Ronald"]);
  expect(posts).toHaveLength(1);
  expect(posts[0].value).toBe("existing\r\nABC123\r\nRonald");
});
it("addBans skips entries already present and does not duplicate", async () => { /* … */ });
it("addBans issues NO post when every entry is already present", async () => {
  expect(posts).toHaveLength(0);
});
it("addBans drops blank and whitespace-only names", async () => { /* … */ });
it("addBans deduplicates within its own input", async () => { /* … */ });
it("removeBans removes both entries in ONE read-modify-write", async () => { /* … */ });
it("removeBans issues NO post when nothing was present", async () => { /* … */ });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/nitrado && npx vitest run test/bans.test.ts`
Expected: FAIL — `client.getBans is not a function`.

- [ ] **Step 3: Port the methods**

Add to `packages/nitrado/src/client.ts`, after `uploadFile`. Copy the four methods from One Life verbatim, keeping their comments, and route them through this package's existing `getJson`/`postJson` (which already run `assertSuccess` — Nitrado answers some errors with HTTP 200 and `status:"error"`).

```ts
  // ── Ban list. Stored as a single \r\n-joined string in settings.general.bans;
  // every mutation is a whole-field read-modify-write. ⚠️ A caller needing N
  // entries must NOT loop a single-entry helper: that is N round trips with a
  // lost-update window between each.
  async getBans(): Promise<string[]> {
    const body = await this.getJson(`/services/${this.serviceId}/gameservers/settings`);
    const raw: string = body?.data?.settings?.general?.bans ?? "";
    return raw.split(/\r\n|\r|\n/).map((s) => s.trim()).filter((s) => s !== "");
  }

  private async setBans(names: string[]): Promise<void> {
    await this.postJson(`/services/${this.serviceId}/gameservers/settings`, {
      category: "general", key: "bans", value: names.join("\r\n"),
    });
  }
```

`addBans` and `removeBans` exactly as in the source, including the two no-op write suppressions.

- [ ] **Step 4: Run the tests**

Run: `cd packages/nitrado && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nitrado/src/client.ts packages/nitrado/test/bans.test.ts
git commit -m "feat(nitrado): batched ban-list read-modify-write"
```

---

## Task 9: `ban-tick.ts`

The riskiest task in the plan. Every ⚠️ below is a real production incident from One Life's `CODE-REVIEW-2026-08-04.md` — read it before starting.

**Files:**
- Create: `apps/bot/src/ban-tick.ts`
- Modify: `apps/bot/src/config.ts`
- Test: `apps/bot/test/ban-tick.test.ts`

**Interfaces:**
- Consumes: `NitradoClient` from `@factions/nitrado`; `BAN_MAX_ATTEMPTS`, `BanStatus` from `@factions/domain`; `bans` from `@factions/db`.
- Produces: `banTick(db: Database, client: NitradoClient, opts: { now?: Date; dryRun: boolean; since: Date }): Promise<{ applied: number; expired: number; failed: number }>`.

- [ ] **Step 1: Write the failing test**

Create `apps/bot/test/ban-tick.test.ts` with a fake client recording calls:

```ts
it("applies a pending ban: one addBans carrying BOTH the dayzId and the gamertag", async () => {
  expect(fake.added).toEqual([[DAYZ_ID, "Sasha"]]);
  expect((await db.select().from(bans))[0]).toMatchObject({ status: "applied" });
});

it("a dry-run row is never sent to Nitrado but is still marked applied", async () => {
  expect(fake.added).toEqual([]);
});

it("does not apply rows older than `since` — a dry-run flip must not fire the backlog", async () => {
  // ⚠️ One Life's unbounded detect query applied every historical row at once
  // the moment ENFORCER_DRY_RUN went false.
  expect(fake.added).toEqual([]);
});

it("an expired ban is removed and marked expired", async () => {
  expect(fake.removed).toEqual([[DAYZ_ID, "Sasha"]]);
});

it("a permanent ban (expiresAt null) is never expired", async () => {
  expect(fake.removed).toEqual([]);
});

it("two overlapping bans on one account: the earlier expiry does NOT free the later ban", async () => {
  // ⚠️ Both bans share ONE Nitrado list entry. Remove it only when no other
  // active ban still needs it.
  expect(fake.removed).toEqual([]);
  expect(await activeStatuses()).toContain("applied");
});

it("a Nitrado error increments attempts and leaves the row retryable", async () => {
  expect((await db.select().from(bans))[0]).toMatchObject({ status: "pending", attempts: 1 });
});

it("BAN_MAX_ATTEMPTS errors move the row to failed, not pending", async () => {
  // ⚠️ A stuck `pending` renders as a ban no query revisits and no tick lifts.
  expect((await db.select().from(bans))[0]).toMatchObject({ status: "failed" });
});

it("a lift_pending row is removed and becomes lifted only after Nitrado confirms", async () => {
  // ⚠️ Never short-circuit to `lifted`.
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/bot && npx vitest run test/ban-tick.test.ts`
Expected: FAIL — no module `../src/ban-tick.js`.

- [ ] **Step 3: Write the tick**

Create `apps/bot/src/ban-tick.ts` with three arms — apply, expire, lift — and a shared helper that is the heart of the reference-counting:

```ts
/**
 * The ban-list entries this person still needs.
 *
 * ⚠️ Two simultaneously-active bans for one account share a SINGLE Nitrado
 * list entry, so removing the entry when the FIRST one expires silently frees
 * the second. Only remove when no other active ban for that dayz_id remains.
 * One Life shipped the naive version and it failed open.
 */
async function stillBanned(db: Database, dayzId: string, now: Date, excludingBanId: number): Promise<boolean> {
  const rows = await db.select({ id: bans.id }).from(bans).where(and(
    eq(bans.dayzId, dayzId),
    eq(bans.status, "applied"),
    eq(bans.dryRun, false),
    ne(bans.id, excludingBanId),
    or(isNull(bans.expiresAt), gt(bans.expiresAt, now)),
  ));
  return rows.length > 0;
}
```

The apply arm:

```ts
  // ⚠️ `since` BOUNDS this query. One Life's unbounded version meant that the
  // moment dry-run was turned off, the entire historical backlog of intended
  // bans fired at Nitrado in a single tick.
  const pending = await db.select().from(bans).where(and(
    eq(bans.status, "pending"),
    gte(bans.bannedAt, opts.since),
    lt(bans.attempts, BAN_MAX_ATTEMPTS),
  ));
  for (const row of pending) {
    try {
      // A dry-run row never reaches Nitrado, but IS stamped and closed, so the
      // audit shows exactly what would have happened.
      if (!opts.dryRun) await client.addBans([row.dayzId, row.gamertag]);
      await db.update(bans)
        .set({ status: "applied", appliedAt: now, dryRun: opts.dryRun, lastError: null })
        .where(and(eq(bans.id, row.id), eq(bans.status, "pending")));
      out.applied++;
    } catch (err) {
      const attempts = row.attempts + 1;
      // ⚠️ On the last attempt the row must become `failed`, NOT stay
      // `pending`. A stuck `pending` renders as an active ban that no query
      // revisits and no tick can ever lift.
      await db.update(bans).set({
        attempts,
        status: attempts >= BAN_MAX_ATTEMPTS ? "failed" : "pending",
        lastError: String(err).slice(0, 500),
      }).where(eq(bans.id, row.id));
      if (attempts >= BAN_MAX_ATTEMPTS) out.failed++;
    }
  }
```

The expire arm:

```ts
  const due = await db.select().from(bans).where(and(
    eq(bans.status, "applied"),
    isNotNull(bans.expiresAt),      // ⚠️ a permanent ban is never expired
    lte(bans.expiresAt, now),
  ));
  for (const row of due) {
    try {
      if (!row.dryRun && !(await stillBanned(db, row.dayzId, now, row.id))) {
        await client.removeBans([row.dayzId, row.gamertag]);
      }
      await db.update(bans).set({ status: "expired" })
        .where(and(eq(bans.id, row.id), eq(bans.status, "applied")));
      out.expired++;
    } catch (err) {
      await db.update(bans).set({ lastError: String(err).slice(0, 500) }).where(eq(bans.id, row.id));
    }
  }
```

The lift arm is the same shape over `status = 'lift_pending'` → `'lifted'`, gated on the same `stillBanned` check, and writing `liftedAt`. **Nothing anywhere writes `lifted` directly** — One Life's short-circuit left players banned on the server while the database said they were free.

In `apps/bot/src/config.ts`:

```ts
    /**
     * ⚠️ Defaults TRUE. Real bans require explicitly setting it "false".
     * Audit rows are written either way, so a dry-run deployment still shows
     * exactly what would have happened.
     *
     * ⚠️ NEVER set this back to true while a ban is `applied`. The expire arm
     * then closes the row WITHOUT calling Nitrado, orphaning the list entry
     * permanently — and an orphaned account hash cannot be shed by renaming.
     */
    banDryRun: (env.BAN_DRY_RUN ?? "true") !== "false",
    enforcementTick: env.ENFORCEMENT_TICK === "1",
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/bot && npx vitest run test/ban-tick.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/ban-tick.ts apps/bot/src/config.ts apps/bot/test/ban-tick.test.ts
git commit -m "feat(bot): reconcile bans against the Nitrado ban list"
```

---

## Task 10: Register the ticks

**Files:**
- Modify: `apps/bot/src/discord.ts`
- Modify: `apps/bot/README.md`
- Test: `apps/bot/test/tick-order.test.ts` (extend if it exists; otherwise assert in `discord.test.ts`)

- [ ] **Step 1: Write the failing test**

Assert the order: `violationTick` runs **after** `zoneTick` (it closes what zone opens) and **before** the posters (so a warning queued this tick is posted this tick). `banTick` runs beside `reaper-tick` on the 5-minute schedule, not every tick — a ban-list read-modify-write every 10 s is a Nitrado rate-limit waiting to happen.

- [ ] **Step 2: Register them**

In `start()`, add `violationTick` immediately after the existing `zoneTick` call, and `banTick` into the 5-minute block beside `reaperTick`. Gate both on `config.enforcementTick`, and pass `since` as the bot's process start time so a first run after a dry-run flip cannot fire a historical backlog.

- [ ] **Step 3: Document the env**

Add `BAN_DRY_RUN` and `ENFORCEMENT_TICK` to `apps/bot/README.md`'s env table, both with their defaults and the dry-run warning.

- [ ] **Step 4: Run the full suite**

Run: `pnpm turbo run test`
Expected: PASS, all tasks.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/discord.ts apps/bot/README.md apps/bot/test
git commit -m "feat(bot): run the violation and ban ticks"
```

---

## Task 11: Rules, guide and runbook

The code is useless if the guide still promises the old rules. This task is not optional polish.

**Files:**
- Modify: `apps/web/content/guide/12-fair-play.html`
- Modify: `apps/web/content/guide/13-rules-on-one-page.html`
- Modify: `apps/web/content/guide/05-raiding.html`
- Modify: `CLAUDE.md`
- Create: `docs/deploy/2026-09-15-zone-enforcement.md`

- [ ] **Step 1: Delete the in-window dismantle carve-out**

In `12-fair-play.html`, the "Boost raids outside the window" section currently ends: *"Inside the window, dismantling from within a base you are raiding is part of raiding. Outside it, it never is."* **Delete that sentence.** Rewrite the section so the rule is unconditional: you may boost in and lower the flag outside the window; you may never dismantle any part of a base that is not yours, and you may never turn a fence into a gate, in the window or out.

Check `05-raiding.html` for any sentence that repeats the carve-out and fix it there too.

- [ ] **Step 2: Move fireplaces and garden plots out of "Exploits — permanent ban"**

The bullet currently reads *"Legal boosting: a two-player boost, vehicles, and up to two stacked watchtowers, both grounded. Not legal: garden plots, fireplaces, backpacks, car parts, or anything of that kind."*

Stacked garden plots and fireplaces are now sentenced on the proportional ladder, not as permanent-ban exploits. Move that clause into the Bases section and state the ladder.

**Backpacks and car parts stay where they are**, keeping the exploit rule and the ticket path — but do **not** justify that in the copy by saying the log cannot see them. ⚠️ An earlier draft of this plan and of the spec's §10 both claimed the bot "cannot see them in the log". That is **false**, verified against 12 live ADM files on 2026-09-15: barrels, wooden crates, large tents, sea chests and fire barrels all log `placed X<Class>` with a position. They are excluded because the approved spec scopes the rule to fireplaces and garden plots, not because they are invisible. Write the copy so it does not claim otherwise.

⚠️ **Do not add barrels to `BOOST_ITEM_CLASSES` on the strength of the log alone.** A barrel cannot be stood on in DayZ, so a barrel cluster is not a boost however tightly packed it is. Which deployables actually bear a player's weight is a game fact the log cannot tell you — it must be confirmed in game before any item family joins the list.

- [ ] **Step 3: State the enforcement**

Replace *"A member of the victim clan reports it; staff read the log"* with the automated path: the bot records it, warns the offender, and an officer of the owning clan (or a solo declarant) can press charges from `/base` within `{{VIOLATION_REPORT_WINDOW_MS|days}}`. The sentence is automatic and scales with the damage. Use `{{KEY|format}}` tokens for every numeral so the guide renders from `guide-numbers.ts`.

Say plainly that a warning DM is not an accusation and that an owner who invited a helper simply will not report them.

- [ ] **Step 4: Update `13-rules-on-one-page.html`** with the same rule, one line.

- [ ] **Step 5: Update `CLAUDE.md`**

- Extend the §4.12 lock order with `zone_incidents` → `zone_incident_participants` → `bans`.
- Add a row to the feature table pointing at the new files.
- Add `BAN_DRY_RUN`'s two warnings to the "read this before touching anything" section — the backlog-on-flip hazard and the never-re-enable-while-applied hazard.

- [ ] **Step 6: Write the runbook**

`docs/deploy/2026-09-15-zone-enforcement.md`, following `docs/deploy/2026-09-07-map.md`'s shape:

1. Apply migration 0036 (tables only — the bot does **not** need stopping).
2. Deploy with `ENFORCEMENT_TICK=1` and **`BAN_DRY_RUN` unset** (dry-run).
3. Watch for a week. Confirm `zone_incidents` rows match real events, and check `zone_placements` for farms wrongly promoted to stacks — this is where `BOOST_STACK_RADIUS_M` and `BOOST_STACK_MIN_RISE_M` get tuned.
4. **Before flipping `BAN_DRY_RUN=false`:** confirm no `bans` row is `status='applied'`, and confirm the tick's `since` bound means the dry-run backlog cannot fire.
5. Rollback: set `ENFORCEMENT_TICK=0`. ⚠️ Do **not** roll back by re-enabling `BAN_DRY_RUN` while any ban is `applied` — that orphans the Nitrado entry permanently.

- [ ] **Step 7: Run the guide tests and the full suite**

Run: `pnpm turbo run test`
Expected: PASS. `packages/domain`'s guide-numbers two-way diff and `apps/web`'s guide-token tests both fail on an unrecognised `{{TOKEN}}`.

- [ ] **Step 8: Commit**

```bash
git add apps/web/content/guide CLAUDE.md docs/deploy/2026-09-15-zone-enforcement.md
git commit -m "docs: zone enforcement rules, guide and runbook"
```

---

## Self-review notes

**Spec coverage:** §1 → Task 6's store comment. §2 → Tasks 4, 11. §2.3 → Task 4 Step 4 and its test. §2.4 → Tasks 5, 11. §3 → Task 4. §4 → Tasks 1, 2, 4. §5 → Task 3. §6 → Tasks 5, 6, 7. §7 → Task 1. §8 → Tasks 8, 9. §9 → Task 1. §10 → Task 11. §11 → distributed across every task's tests. §12 is out of scope by construction.

**Deliberately deferred:** Task 2's `BOOST_ITEM_CLASSES` verification is the one place the plan asks the implementer to check reality before pinning a test. It is called out as blocking in both the spec and the task.

**Not in this plan:** the `FlagRefreshMaxDuration` 7→14 day copy fix. Independent bounded work.
