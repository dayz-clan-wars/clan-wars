# Raid Window Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flip the game server's `disableBaseDamage` automatically on the raid-window boundaries, state the window's confirmed state on the website, and announce it in Discord.

**Architecture:** One pure domain function answers "what should the file say at this instant", and three consumers read it. The flip rides the existing two-hourly restart slots in `restart-tick.ts`, level-triggered, beside the truck wipe. Every successful flip is recorded, and the website and the open/close announcements read those confirmed records rather than the clock — so a failed flip never produces a confident lie.

**Tech Stack:** TypeScript, pnpm workspace + turbo, vitest, drizzle-orm over postgres.js, discord.js, Next.js (App Router), the Nitrado file-server API.

**Spec:** `docs/superpowers/specs/2026-09-17-raid-window-automation-design.md`

## Global Constraints

- **The window's numbers live in `RAID_WINDOW = { openDow: 5, closeDow: 1 }`** in `packages/domain/src/rules.ts` and are never restated. The guide renders them through `packages/domain/src/guide-numbers.ts`.
- **All time arithmetic is UTC.** No local time, no DST handling anywhere in this feature.
- **The file value, not the player value.** `baseDamageDisabled: true` means raiding is OFF. Nothing inverts this at a write site.
- **Never `JSON.parse` → mutate → `JSON.stringify` on `cfggameplay.json`.** Surgical regex replacement only. A malformed `cfggameplay.json` means the game server does not start, for every player.
- **No upload unless the content actually changed.** The download is the check.
- **⚠️ `@factions/roster` must not export a name containing `raid`.** `packages/roster/test/exports.test.ts` fails any export whose lowercased name contains `activate`, `dormant`, `raid`, `defense`, `declaration`, `reserve`, `createfaction` or `insert`. The read in Task 8 is therefore named **`baseDamageWindow`**, which is also what it literally reports. Do not rename it to `raidWindow`, and do not weaken that guard.
- **Adding a roster export means editing two pinned lists on purpose:** `packages/roster/test/roster-exports.ts` and the inline array in `apps/web/test/smoke.test.ts`.
- **⚠️ `apps/web` source may never contain the substring `faction` in any identifier** (`apps/web/test/copy-vocabulary.test.ts`). Use `clan` in web-side names.
- **The full gate is `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force` and must show 30/30 tasks.** A cached pass proves nothing.
- **Never run the gate twice concurrently** — packages share `factions_test_<package>`.
- **Every PR adds an entry under `## [Unreleased]` in `CHANGELOG.md`, committed.**

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/domain/src/raid-window.ts` | **New.** The one answer: phase, wanted file value, boundaries, skip reason. Pure. |
| `packages/domain/src/index.ts` | **Modify.** Re-export the above. |
| `apps/bot/src/cfggameplay.ts` | **New.** The surgical edit and its guards. Pure, no I/O. |
| `packages/db/src/schema.ts` | **Modify.** Three tables. |
| `packages/db/migrations/0037_*.sql` | **New.** Generated. |
| `packages/nitrado/src/client.ts` | **Modify.** Promote `missionDir()` to public `missionRootDir()`; fix a misleading comment. |
| `apps/bot/src/restart-tick.ts` | **Modify.** `applyRaidWindow()` beside `applyTruckWipe()`. |
| `apps/bot/src/raid-window-text.ts` | **New.** The four message bodies. Pure. |
| `apps/bot/src/raid-window-tick.ts` | **New.** The announcer. |
| `apps/bot/src/config.ts` | **Modify.** `RAID_WINDOW_TICK`, `OPS_CHANNEL_ID`, and the cross-check against `RESTART_SCHEDULE`. |
| `apps/bot/src/discord.ts` | **Modify.** Wire the tick in after `announceTick`. |
| `packages/roster/src/base-damage-window.ts` | **New.** The site's read. |
| `apps/web/app/components/raid-strip.tsx` | **New.** The strip (server component). |
| `apps/web/app/components/raid-countdown.tsx` | **New.** The countdown only (client component). |
| `apps/web/lib/raid-strip.ts` | **New.** Strip text derivation, pure and testable. |
| `scripts/raid-skip.ts` | **New.** Insert a skip row. |
| `docs/deploy/raid-window.md` | **Modify.** Automation + manual fallback. |

---

### Task 1: The domain function

**Files:**
- Create: `packages/domain/src/raid-window.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/raid-window.test.ts`

**Interfaces:**
- Consumes: `RAID_WINDOW` from `packages/domain/src/rules.ts`.
- Produces: `raidWindowAt(when: Date, skips: SkippedWindow[]): RaidWindowState`, and the types `RaidPhase`, `SkippedWindow`, `RaidWindowState` as written below.

- [ ] **Step 1: Write the failing test**

Create `packages/domain/test/raid-window.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { raidWindowAt } from "../src/raid-window";

// 2026-09-18 is a Friday. All instants UTC.
const FRI_OPEN = new Date("2026-09-18T00:00:00.000Z");
const MON_CLOSE = new Date("2026-09-21T00:00:00.000Z");

describe("raidWindowAt", () => {
  it("is open exactly at the Friday boundary", () => {
    const s = raidWindowAt(FRI_OPEN, []);
    expect(s.phase).toBe("open");
    expect(s.baseDamageDisabled).toBe(false);
    expect(s.opensAt.toISOString()).toBe(FRI_OPEN.toISOString());
    expect(s.closesAt.toISOString()).toBe(MON_CLOSE.toISOString());
  });

  it("is still closed one millisecond before the Friday boundary", () => {
    const s = raidWindowAt(new Date(FRI_OPEN.getTime() - 1), []);
    expect(s.phase).toBe("closed");
    expect(s.baseDamageDisabled).toBe(true);
    // The window it points at is the one about to open.
    expect(s.opensAt.toISOString()).toBe(FRI_OPEN.toISOString());
  });

  it("is closed exactly at the Monday boundary — the window is half-open", () => {
    const s = raidWindowAt(MON_CLOSE, []);
    expect(s.phase).toBe("closed");
    expect(s.baseDamageDisabled).toBe(true);
    // ⚠️ Points at NEXT Friday, not the one that just closed.
    expect(s.opensAt.toISOString()).toBe("2026-09-25T00:00:00.000Z");
  });

  it("is open one millisecond before the Monday boundary", () => {
    const s = raidWindowAt(new Date(MON_CLOSE.getTime() - 1), []);
    expect(s.phase).toBe("open");
    expect(s.baseDamageDisabled).toBe(false);
  });

  it("is open in the middle of the weekend", () => {
    const s = raidWindowAt(new Date("2026-09-19T13:45:00.000Z"), []);
    expect(s.phase).toBe("open");
  });

  it("is skipped when a skip names this window's opensAt", () => {
    const s = raidWindowAt(new Date("2026-09-19T13:45:00.000Z"), [
      { opensAt: FRI_OPEN, reason: "first weekend after launch" },
    ]);
    expect(s.phase).toBe("skipped");
    expect(s.baseDamageDisabled).toBe(true);
    expect(s.skipReason).toBe("first weekend after launch");
  });

  it("⚠️ a skip for a DIFFERENT window does not affect this one", () => {
    const s = raidWindowAt(new Date("2026-09-19T13:45:00.000Z"), [
      { opensAt: new Date("2026-09-25T00:00:00.000Z"), reason: "some other weekend" },
    ]);
    expect(s.phase).toBe("open");
    expect(s.skipReason).toBeUndefined();
  });

  it("⚠️ a skip on a CLOSED midweek instant still reports the coming window as skipped", () => {
    // Wednesday, looking forward at a weekend that will not happen.
    const s = raidWindowAt(new Date("2026-09-16T12:00:00.000Z"), [
      { opensAt: FRI_OPEN, reason: "first weekend after launch" },
    ]);
    expect(s.phase).toBe("skipped");
    expect(s.baseDamageDisabled).toBe(true);
    expect(s.skipReason).toBe("first weekend after launch");
    expect(s.opensAt.toISOString()).toBe(FRI_OPEN.toISOString());
  });

  it("tolerates duplicate skip rows for the same window", () => {
    const s = raidWindowAt(FRI_OPEN, [
      { opensAt: FRI_OPEN, reason: "first" },
      { opensAt: FRI_OPEN, reason: "second" },
    ]);
    expect(s.phase).toBe("skipped");
    expect(s.skipReason).toBe("first");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/domain && npx vitest run test/raid-window.test.ts`
Expected: FAIL — `Failed to resolve import "../src/raid-window"`.

- [ ] **Step 3: Write the implementation**

Create `packages/domain/src/raid-window.ts`:

```ts
import { RAID_WINDOW } from "./rules";

const DAY_MS = 24 * 60 * 60 * 1000;

export type RaidPhase = "open" | "closed" | "skipped";
export type SkippedWindow = { opensAt: Date; reason: string };

export type RaidWindowState = {
  phase: RaidPhase;
  /**
   * What GeneralData.disableBaseDamage should be at `when`.
   * ⚠️ The FILE's value, not the player-facing one — true means raiding is OFF.
   * Stated this way so no caller ever has to invert it at a write site.
   */
  baseDamageDisabled: boolean;
  /** The window containing `when`, or the next one if `when` is outside one. */
  opensAt: Date;
  closesAt: Date;
  /** Set only when phase is "skipped". */
  skipReason?: string;
};

/** Midnight UTC on the most recent `dow` at or before `when` (0 = Sunday). */
function lastMidnightOn(when: Date, dow: number): Date {
  const d = new Date(Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate()));
  const back = (d.getUTCDay() - dow + 7) % 7;
  return new Date(d.getTime() - back * DAY_MS);
}

/**
 * The raid window's state at `when`.
 *
 * ⚠️ The window is HALF-OPEN: [opensAt, closesAt). Monday 00:00:00.000 is closed,
 * not open. The guide promises "Friday 00:00 UTC to Monday 00:00 UTC", and a
 * window that included its own closing instant would leave base damage on for one
 * tick of the Monday — which is exactly the moment a clan stops watching.
 *
 * ⚠️ A skip suppresses the window it names, whether `when` is inside that window or
 * merely before it. Thursday's announcement and Saturday's website both have to say
 * "skipped", and they reach this function with very different `when` values.
 */
export function raidWindowAt(when: Date, skips: SkippedWindow[]): RaidWindowState {
  const lastOpen = lastMidnightOn(when, RAID_WINDOW.openDow);
  const closeOfLast = new Date(
    lastOpen.getTime() + ((RAID_WINDOW.closeDow - RAID_WINDOW.openDow + 7) % 7) * DAY_MS,
  );

  const inWindow = when >= lastOpen && when < closeOfLast;
  const opensAt = inWindow ? lastOpen : new Date(lastOpen.getTime() + 7 * DAY_MS);
  const closesAt = inWindow ? closeOfLast : new Date(closeOfLast.getTime() + 7 * DAY_MS);

  const skip = skips.find((s) => s.opensAt.getTime() === opensAt.getTime());
  if (skip) {
    return { phase: "skipped", baseDamageDisabled: true, opensAt, closesAt, skipReason: skip.reason };
  }
  return inWindow
    ? { phase: "open", baseDamageDisabled: false, opensAt, closesAt }
    : { phase: "closed", baseDamageDisabled: true, opensAt, closesAt };
}
```

- [ ] **Step 4: Export it**

In `packages/domain/src/index.ts`, beside the existing `export * from "./restarts";`, add:

```ts
export * from "./raid-window";
```

- [ ] **Step 5: Run the tests**

Run: `cd packages/domain && npx vitest run test/raid-window.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/raid-window.ts packages/domain/src/index.ts packages/domain/test/raid-window.test.ts
git commit -m "feat(domain): the raid window's state at an instant"
```

---

### Task 2: The surgical edit

**Files:**
- Create: `apps/bot/src/cfggameplay.ts`
- Create: `apps/bot/test/fixtures/cfggameplay.json`
- Test: `apps/bot/test/cfggameplay.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `setBaseDamageDisabled(json: string, wanted: boolean): { json: string; changed: boolean }`. Throws on every case it cannot do safely.

- [ ] **Step 1: Create the fixture**

Create `apps/bot/test/fixtures/cfggameplay.json` with the content below. This is the real file from the live server, captured 2026-09-17 (4,450 bytes).

⚠️ **The indentation is TABS, not spaces.** The byte-identical assertions in Step 2 depend on reproducing the file exactly; if your editor converts tabs, the tests will still pass but you will have lost the point of using the real file.

```json
{
	"version": 123,
	"GeneralData": {
		"disableBaseDamage": true,
		"disableContainerDamage": false,
		"disableRespawnDialog": false,
		"disableRespawnInUnconsciousness": true
	},
	"PlayerData": {
		"spawnGearPresetFiles": [
			"./custom/loadout.json"
		],
		"disablePersonalLight": false,
		"StaminaData": {
			"sprintStaminaModifierErc": 0,
			"sprintStaminaModifierCro": 0,
			"staminaWeightLimitThreshold": 6000.0,
			"staminaMax": 100.0,
			"staminaKgToStaminaPercentPenalty": 0,
			"staminaMinCap": 100.0,
			"sprintSwimmingStaminaModifier": 0,
			"sprintLadderStaminaModifier": 0,
			"meleeStaminaModifier": 0,
			"obstacleTraversalStaminaModifier": 1.0,
			"holdBreathStaminaModifier": 1.0
		},
		"ShockHandlingData": {
			"shockRefillSpeedConscious": 5.0,
			"shockRefillSpeedUnconscious": 5.0,
			"allowRefillSpeedModifier": true
		},
		"MovementData": {
			"timeToStrafeJog": 0.1,
			"rotationSpeedJog": 0.3,
			"timeToSprint": 0.45,
			"timeToStrafeSprint": 0.3,
			"rotationSpeedSprint": 0.15,
			"allowStaminaAffectInertia": true
		},
		"DrowningData": {
			"staminaDepletionSpeed": 10.0,
			"healthDepletionSpeed": 10.0,
			"shockDepletionSpeed": 10.0
		},
		"WeaponObstructionData": {
			"staticMode": 1,
			"dynamicMode": 1
		}
	},
	"WorldsData": {
		"lightingConfig": 0,
		"objectSpawnersArr": [
			"./custom/admin-castle.json",
			"./custom/bunker-enhancements.json",
			"./custom/faction-supplies.json",
			"./custom/teleports.json"
		],
		"environmentMinTemps": [
			-7,
			-7.4,
			-4.1,
			1.5,
			7,
			11.3,
			20.4,
			19.1,
			18,
			5.3,
			0.8,
			-3.6
		],
		"environmentMaxTemps": [
			-2.5,
			-2.1,
			2.3,
			9,
			15.5,
			19.4,
			25,
			22,
			21,
			10.5,
			4.2,
			0.1
		],
		"wetnessWeightModifiers": [
			1.0,
			1.0,
			1.33,
			1.66,
			2.0
		],
		"playerRestrictedAreaFiles": [
			"./custom/pra-teleport-castle.json",
			"./custom/pra-teleport-hub.json",
			"./custom/pra-teleport-adamow.json",
			"./custom/pra-teleport-bielawa.json",
			"./custom/pra-teleport-borek.json",
			"./custom/pra-teleport-brena.json",
			"./custom/pra-teleport-dolnik.json",
			"./custom/pra-teleport-drewniki.json",
			"./custom/pra-teleport-gieraltow.json",
			"./custom/pra-teleport-gliniska.json",
			"./custom/pra-teleport-grabin.json",
			"./custom/pra-teleport-huta.json",
			"./custom/pra-teleport-karlin.json",
			"./custom/pra-teleport-kolembrody.json",
			"./custom/pra-teleport-kulno.json",
			"./custom/pra-teleport-lembork.json",
			"./custom/pra-teleport-lipina.json",
			"./custom/pra-teleport-lukow.json",
			"./custom/pra-teleport-muratyn.json",
			"./custom/pra-teleport-nadbor.json",
			"./custom/pra-teleport-nidek.json",
			"./custom/pra-teleport-olszanka.json",
			"./custom/pra-teleport-polana.json",
			"./custom/pra-teleport-radacz.json",
			"./custom/pra-teleport-radunin.json",
			"./custom/pra-teleport-roztoka.json",
			"./custom/pra-teleport-sitnik.json",
			"./custom/pra-teleport-sobotka.json",
			"./custom/pra-teleport-tarnow.json",
			"./custom/pra-teleport-topolin.json",
			"./custom/pra-teleport-wrzeszcz.json",
			"./custom/pra-teleport-zalesie.json",
			"./custom/pra-teleport-zapadlisko.json"
		]
	},
	"BaseBuildingData": {
		"HologramData": {
			"disableIsCollidingBBoxCheck": true,
			"disableIsCollidingPlayerCheck": true,
			"disableIsClippingRoofCheck": true,
			"disableIsBaseViableCheck": true,
			"disableIsCollidingGPlotCheck": true,
			"disableIsCollidingAngleCheck": true,
			"disableIsPlacementPermittedCheck": true,
			"disableHeightPlacementCheck": true,
			"disableIsUnderwaterCheck": true,
			"disableIsInTerrainCheck": true,
			"disableColdAreaBuildingCheck": true,
			"disallowedTypesInUnderground": [
				"FenceKit",
				"TerritoryFlagKit",
				"WatchtowerKit"
			]
		},
		"ConstructionData": {
			"disablePerformRoofCheck": true,
			"disableIsCollidingCheck": true,
			"disableDistanceCheck": true
		}
	},
	"UIData": {
		"use3DMap": false,
		"HitIndicationData": {
			"hitDirectionOverrideEnabled": false,
			"hitDirectionBehaviour": 1,
			"hitDirectionStyle": 0,
			"hitDirectionIndicatorColorStr": "0xffbb0a1e",
			"hitDirectionMaxDuration": 2.0,
			"hitDirectionBreakPointRelative": 0.2,
			"hitDirectionScatter": 10.0,
			"hitIndicationPostProcessEnabled": true
		}
	},
	"MapData": {
		"ignoreMapOwnership": true,
		"ignoreNavItemsOwnership": true,
		"displayPlayerPosition": true,
		"displayNavInfo": true
	},
	"VehicleData": {
		"boatDecayMultiplier": 1
	}
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/bot/test/cfggameplay.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setBaseDamageDisabled } from "../src/cfggameplay.js";

const REAL = readFileSync(join(__dirname, "fixtures/cfggameplay.json"), "utf8");

describe("setBaseDamageDisabled", () => {
  it("opens the window by flipping true -> false", () => {
    const { json, changed } = setBaseDamageDisabled(REAL, false);
    expect(changed).toBe(true);
    expect(JSON.parse(json).GeneralData.disableBaseDamage).toBe(false);
  });

  it("⚠️ changes NOTHING else — every other byte is identical", () => {
    const { json } = setBaseDamageDisabled(REAL, false);
    // The only difference is the one literal. Normalising it back must restore
    // the input exactly: this catches reformatting, reordering and lost tabs.
    expect(json.replace('"disableBaseDamage": false', '"disableBaseDamage": true')).toBe(REAL);
  });

  it("⚠️ does not touch disableContainerDamage", () => {
    const { json } = setBaseDamageDisabled(REAL, false);
    expect(JSON.parse(json).GeneralData.disableContainerDamage).toBe(false);
  });

  it("reports changed=false and returns the input untouched when already correct", () => {
    const { json, changed } = setBaseDamageDisabled(REAL, true);
    expect(changed).toBe(false);
    expect(json).toBe(REAL);
  });

  it("round-trips: false then true returns the original bytes", () => {
    const opened = setBaseDamageDisabled(REAL, false).json;
    const closed = setBaseDamageDisabled(opened, true).json;
    expect(closed).toBe(REAL);
  });

  it("throws when the key is absent", () => {
    const without = JSON.stringify({ GeneralData: { disableContainerDamage: false } }, null, "\t");
    expect(() => setBaseDamageDisabled(without, false)).toThrow(/no "disableBaseDamage"/);
  });

  it("⚠️ throws when the key appears more than once rather than guessing", () => {
    // A second object carrying the same key name. A naive regex would rewrite
    // whichever came first and report success while GeneralData stayed put.
    const twice = REAL.replace(
      '"VehicleData": {',
      '"SomeModData": {\n\t\t"disableBaseDamage": true\n\t},\n\t"VehicleData": {',
    );
    expect(() => setBaseDamageDisabled(twice, false)).toThrow(/appears 2×/);
  });

  it("throws when the input does not parse", () => {
    expect(() => setBaseDamageDisabled('{"GeneralData": {"disableBaseDamage": true,}', false))
      .toThrow(/did not parse/);
  });

  it("⚠️ throws when the edit produced a file whose value is not what was asked for", () => {
    // Guard 2's own case: a file where the key we match is real but sits outside
    // GeneralData, so the edit parses fine and yet achieves nothing.
    const misplaced = '{\n\t"GeneralData": {\n\t\t"disableContainerDamage": false\n\t},\n\t"Other": {\n\t\t"disableBaseDamage": true\n\t}\n}';
    expect(() => setBaseDamageDisabled(misplaced, false)).toThrow(/GeneralData\.disableBaseDamage/);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd apps/bot && npx vitest run test/cfggameplay.test.ts`
Expected: FAIL — `Failed to resolve import "../src/cfggameplay.js"`.

- [ ] **Step 4: Write the implementation**

Create `apps/bot/src/cfggameplay.ts`:

```ts
/**
 * Set `GeneralData.disableBaseDamage` in the game server's cfggameplay.json,
 * returning the new document and whether anything actually changed.
 *
 * ⚠️ A targeted splice, NEVER a parse-and-reserialize. The live file is
 * tab-indented with a specific key order; a round trip through JSON.stringify
 * rewrites all 4,450 bytes, making the diff unreviewable and silently
 * reformatting a file a human may have to read under pressure. Everything
 * outside the one boolean comes back byte-identical.
 *
 * ⚠️ This file is the one whose corruption stops the server BOOTING, for every
 * player — not degrading, like events.xml. That is why every branch below
 * throws rather than doing its best: refusing to write costs at most a window
 * that opens two hours late, and the next slot retries.
 */
const KEY_RE = /("disableBaseDamage"\s*:\s*)(true|false)/g;

export function setBaseDamageDisabled(json: string, wanted: boolean): { json: string; changed: boolean } {
  // Guard: the input itself must be valid. A file that is already broken is not
  // one we should be splicing into and re-uploading.
  try {
    JSON.parse(json);
  } catch (err) {
    throw new Error(`cfggameplay.json: input did not parse — refusing to edit it (${(err as Error).message})`);
  }

  const matches = [...json.matchAll(KEY_RE)];
  if (matches.length === 0) {
    throw new Error('cfggameplay.json: no "disableBaseDamage" key found — refusing to guess where it went');
  }
  if (matches.length > 1) {
    throw new Error(
      `cfggameplay.json: "disableBaseDamage" appears ${matches.length}× — ` +
        "refusing to guess which one the server reads",
    );
  }

  const m = matches[0]!;
  if ((m[2] === "true") === wanted) return { json, changed: false };

  const from = m.index!;
  const to = from + m[0].length;
  const next = json.slice(0, from) + m[1] + String(wanted) + json.slice(to);

  // ⚠️ Guard 2, and it is not redundant with the parse above. A key matched
  // outside GeneralData produces a file that parses perfectly and leaves
  // GeneralData untouched — success by every check except the one that matters.
  // Parsing proves the file is loadable; only reading the value back proves the
  // edit did what it meant to.
  let parsed: unknown;
  try {
    parsed = JSON.parse(next);
  } catch (err) {
    throw new Error(`cfggameplay.json: the edit produced a file that does not parse (${(err as Error).message})`);
  }
  const got = (parsed as { GeneralData?: { disableBaseDamage?: unknown } })?.GeneralData?.disableBaseDamage;
  if (got !== wanted) {
    throw new Error(
      `cfggameplay.json: after the edit GeneralData.disableBaseDamage is ${JSON.stringify(got)}, ` +
        `not ${wanted} — the key that was replaced is not the one the server reads`,
    );
  }

  return { json: next, changed: true };
}
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/bot && npx vitest run test/cfggameplay.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Prove the guard test is load-bearing**

Temporarily delete the whole "Guard 2" block (from `let parsed: unknown;` to the closing brace of the `if (got !== wanted)`) and re-run.
Expected: the test `⚠️ throws when the edit produced a file whose value is not what was asked for` FAILS.
Then restore the block and re-run to green.

⚠️ Do not skip this step. A guard with no test that fails when it is removed is decoration.

- [ ] **Step 7: Commit**

```bash
git add apps/bot/src/cfggameplay.ts apps/bot/test/cfggameplay.test.ts apps/bot/test/fixtures/cfggameplay.json
git commit -m "feat(bot): surgical disableBaseDamage edit for cfggameplay.json"
```

---

### Task 3: Schema and migration

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/migrations/0037_*.sql` (generated)
- Test: `packages/db/test/raid-window-schema.test.ts`

**Interfaces:**
- Produces: `raidWindowFlips`, `raidWindowSkips`, `raidWindowAnnouncements` exported from `@factions/db`.

- [ ] **Step 1: Add the three tables**

Append to `packages/db/src/schema.ts`, after `vehicleWipeAnnouncements`:

```ts
/**
 * One row per raid-window boundary actually brought into effect, per server.
 *
 * ⚠️ `boundary_at` is the WINDOW BOUNDARY, not the restart slot. A repair write at
 * Saturday 14:00 belongs to that Friday's row, not to a row of its own — the table
 * answers "did this window's flip happen", and a row per slot would bury the four
 * rows a week that matter under the 84 checks that do not.
 *
 * ⚠️ A file already in the wanted state writes NO row. Absence of a row for a past
 * boundary is exactly the signal the website and the open/close announcements read
 * as "not confirmed", which is what stops a failed flip producing a confident lie.
 *
 * ⚠️ `previous_content` is the pre-edit file. The truck wipe keeps no such copy and
 * does not need one: a malformed events.xml degrades, a malformed cfggameplay.json
 * stops the server booting for everyone. 4.5 KB per flip buys a one-command recovery.
 *
 * ⚠️ Written by restart-tick.ts alone, with statements that touch no other table;
 * it needs no place in the §4.12 lock order.
 */
export const raidWindowFlips = pgTable("raid_window_flips", {
  serverId: integer("server_id").notNull().references(() => servers.id),
  /** The Friday-open or Monday-close instant this flip realises. */
  boundaryAt: timestamp("boundary_at", { withTimezone: true }).notNull(),
  /** What GeneralData.disableBaseDamage was set to — the FILE's value. */
  wantedDisabled: boolean("wanted_disabled").notNull(),
  /** applied = the upload succeeded; refused = a guard rejected it; failed = the API call failed. */
  outcome: text("outcome").$type<"applied" | "refused" | "failed">().notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  /** Set once the slot's restart is known to have run — an upload without it is not in effect. */
  restartConfirmedAt: timestamp("restart_confirmed_at", { withTimezone: true }),
  previousContent: text("previous_content"),
  detail: jsonb("detail").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
}, (t) => ({
  pk: primaryKey({ columns: [t.serverId, t.boundaryAt] }),
  outcomeValid: check("raid_window_flips_outcome_valid", sql`${t.outcome} IN ('applied','refused','failed')`),
}));

/**
 * A raid weekend deliberately not opened.
 *
 * ⚠️ A skip is a DECISION, never a missed flip to catch up. The runbook's rule is
 * inherited: a skipped weekend is not compensated by opening a window on another day.
 *
 * Keyed on `opens_at` alone — the schedule is a property of the calendar, not of a
 * server, exactly as vehicle_wipe_announcements is.
 */
export const raidWindowSkips = pgTable("raid_window_skips", {
  /** The Friday 00:00 UTC instant that will not open. */
  opensAt: timestamp("opens_at", { withTimezone: true }).primaryKey(),
  reason: text("reason").notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
});

/**
 * One row per raid-window message posted.
 *
 * ⚠️ Keyed on (boundary_at, kind) with NO server_id. These are single messages about
 * a single schedule; a per-server key posts one identical message per active server,
 * which is the bug vehicle_wipe_announcements already carries a ⚠️ about.
 *
 * ⚠️ That key is also what makes a `failure` alert fire ONCE per boundary. The
 * level-triggered tick retries every two hours; without this the same failure would
 * be re-announced 12 times a day and bury the alerts this design needs someone to read.
 */
export const raidWindowAnnouncements = pgTable("raid_window_announcements", {
  boundaryAt: timestamp("boundary_at", { withTimezone: true }).notNull(),
  kind: text("kind").$type<"advance" | "open" | "close" | "failure">().notNull(),
  announcedAt: timestamp("announced_at", { withTimezone: true }).notNull(),
  outcome: text("outcome").$type<"posted" | "missed">().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.boundaryAt, t.kind] }),
  kindValid: check("raid_window_announcements_kind_valid", sql`${t.kind} IN ('advance','open','close','failure')`),
  outcomeValid: check("raid_window_announcements_outcome_valid", sql`${t.outcome} IN ('posted','missed')`),
}));
```

⚠️ `boolean` must be present in the `drizzle-orm/pg-core` import list at the top of `schema.ts`. Add it if it is not already there.

- [ ] **Step 2: Generate the migration**

```bash
cd packages/db && npx drizzle-kit generate
```

- [ ] **Step 3: Read the generated SQL**

Open the new `packages/db/migrations/0037_*.sql` and confirm it contains exactly three `CREATE TABLE` statements, the two composite primary keys, the three check constraints, and one foreign key to `servers`. It must contain no `DROP` and no `ALTER` of any existing table.

⚠️ This is a required read, not a formality. `CLAUDE.md`: read the generated SQL before letting it near `factions_live`.

- [ ] **Step 4: Write the drift test**

Create `packages/db/test/raid-window-schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
// Bootstrap: see the preamble in Task 3, Step 4. No testDb() helper exists.
import { raidWindowFlips, raidWindowSkips, raidWindowAnnouncements } from "../src/schema";

describe("raid window tables", () => {
  it("accepts a flip row and rejects a bad outcome", async () => {
    // `db` comes from the beforeEach preamble.
    await db.execute(sql`insert into servers (id, name, active) values (900, 'T', true) on conflict do nothing`);
    await db.insert(raidWindowFlips).values({
      serverId: 900,
      boundaryAt: new Date("2026-09-18T00:00:00Z"),
      wantedDisabled: false,
      outcome: "applied",
      appliedAt: new Date(),
      previousContent: "{}",
    });
    await expect(
      db.execute(sql`insert into raid_window_flips (server_id, boundary_at, wanted_disabled, outcome)
                     values (900, '2026-09-25T00:00:00Z', false, 'nonsense')`),
    ).rejects.toThrow();
  });

  it("⚠️ one flip row per server per boundary", async () => {
    // `db` comes from the beforeEach preamble.
    await db.execute(sql`insert into servers (id, name, active) values (901, 'T', true) on conflict do nothing`);
    const row = {
      serverId: 901,
      boundaryAt: new Date("2026-09-18T00:00:00Z"),
      wantedDisabled: false,
      outcome: "applied" as const,
    };
    await db.insert(raidWindowFlips).values(row);
    await expect(db.insert(raidWindowFlips).values(row)).rejects.toThrow();
  });

  it("⚠️ one announcement per (boundary, kind) — this is what makes a failure alert fire once", async () => {
    // `db` comes from the beforeEach preamble.
    const row = {
      boundaryAt: new Date("2026-09-18T00:00:00Z"),
      kind: "failure" as const,
      announcedAt: new Date(),
      outcome: "posted" as const,
    };
    await db.insert(raidWindowAnnouncements).values(row);
    await expect(db.insert(raidWindowAnnouncements).values(row)).rejects.toThrow();
    // A different kind at the same boundary is fine.
    await db.insert(raidWindowAnnouncements).values({ ...row, kind: "open" });
  });

  it("one skip per window", async () => {
    // `db` comes from the beforeEach preamble.
    const row = { opensAt: new Date("2026-09-18T00:00:00Z"), reason: "launch", decidedAt: new Date() };
    await db.insert(raidWindowSkips).values(row);
    await expect(db.insert(raidWindowSkips).values(row)).rejects.toThrow();
  });
});
```

⚠️ **There is no `testDb()` helper in this repo.** Every database suite bootstraps
itself the same way — copy this preamble verbatim into each database test in this plan
(Tasks 3, 6 and 8) and drop the `testDb()` calls:

```ts
import { createClient, runMigrations, requireTestDatabaseUrl, type Database } from "@factions/db";
import { sql } from "drizzle-orm";

const URL = requireTestDatabaseUrl();

describe("...", () => {
  let db: Database;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    // ⚠️ Truncate what THIS suite writes, nothing else. Packages share
    // factions_test_<package> across their own suites.
    await db.execute(sql`truncate table raid_window_flips, raid_window_skips, raid_window_announcements`);
  });
  // ... tests, using `db` directly
});
```

See `apps/bot/test/announce-tick.test.ts` for the pattern this copies.

- [ ] **Step 5: Run the tests**

Run: `cd packages/db && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/raid-window-schema.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations packages/db/test/raid-window-schema.test.ts
git commit -m "feat(db): raid window flips, skips and announcements"
```

---

### Task 4: The mission root directory

**Files:**
- Modify: `packages/nitrado/src/client.ts:104-127`

**Interfaces:**
- Produces: `missionRootDir(): Promise<string>` on `NitradoClient`.

- [ ] **Step 1: Promote the private helper**

In `packages/nitrado/src/client.ts`, add a public method beside `missionCustomDir()` and `missionDbDir()`:

```ts
  /**
   * The mission root — where `cfggameplay.json` lives.
   *
   * ⚠️ Verified against the live file server on 2026-09-17: the root holds 25
   * files, `cfggameplay.json` among them, plus the `db`, `env` and `custom`
   * directories.
   */
  async missionRootDir(): Promise<string> {
    return this.missionDir();
  }
```

- [ ] **Step 2: Correct the misleading comment**

`missionDbDir()`'s doc comment currently says:

> the mission root holds only cfgeconomycore.xml, cfgeventspawns.xml, cfgeventgroups.xml and the `db`/`env`/`custom` dirs

Replace the word `only` and that list so it no longer reads as exhaustive:

```
   * ⚠️ NOT the mission root and NOT `custom`. Verified against the live file
   * server on 2026-09-12: a download of `<mission>/events.xml` answers "File
   * doesn't exist (anymore?)", because events.xml lives in `db`. (The root does
   * hold plenty of other files — cfgeconomycore.xml, cfggameplay.json and ~23
   * more — so do not read this as a listing of it.) Composing the wrong one of
   * these three would upload into a directory the game never reads, and report
   * success.
```

⚠️ This is not cosmetic. As written, the comment tells the next reader that `cfggameplay.json` cannot be where Task 5 reads it from.

- [ ] **Step 3: Typecheck**

Run: `cd packages/nitrado && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/nitrado/src/client.ts
git commit -m "feat(nitrado): expose the mission root directory"
```

---

### Task 5: The flip, on the restart slots

**Files:**
- Modify: `apps/bot/src/restart-tick.ts`
- Test: `apps/bot/test/raid-window-flip.test.ts`

**Interfaces:**
- Consumes: `raidWindowAt` (Task 1), `setBaseDamageDisabled` (Task 2), `raidWindowFlips`/`raidWindowSkips` (Task 3), `missionRootDir()` (Task 4).
- Produces: `RaidWindow = { enabled: boolean }` on `restartTick`'s `opts`; `RestartTarget` gains `missionRootDir(): Promise<string>`.

- [ ] **Step 1: Write the failing test**

Create `apps/bot/test/raid-window-flip.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { applyRaidWindow } from "../src/restart-tick.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REAL = readFileSync(join(__dirname, "fixtures/cfggameplay.json"), "utf8");
const FRI = new Date("2026-09-18T00:00:00.000Z");
const WED = new Date("2026-09-16T00:00:00.000Z");

function target(content = REAL) {
  return {
    missionRootDir: vi.fn(async () => "/mission"),
    downloadFile: vi.fn(async () => content),
    uploadFile: vi.fn(async () => undefined),
  };
}

describe("applyRaidWindow", () => {
  it("opens the window at the Friday boundary and uploads once", async () => {
    const t = target();
    const r = await applyRaidWindow(t as never, FRI, []);
    expect(r.changed).toBe(true);
    expect(r.wantedDisabled).toBe(false);
    expect(t.uploadFile).toHaveBeenCalledTimes(1);
    const [, name, body] = t.uploadFile.mock.calls[0]!;
    expect(name).toBe("cfggameplay.json");
    expect(JSON.parse(body as string).GeneralData.disableBaseDamage).toBe(false);
  });

  it("⚠️ never uploads when the file is already in the wanted state", async () => {
    // Midweek: the fixture already says disabled=true, which is correct.
    const t = target();
    const r = await applyRaidWindow(t as never, WED, []);
    expect(r.changed).toBe(false);
    expect(t.downloadFile).toHaveBeenCalledTimes(1); // the download IS the check
    expect(t.uploadFile).not.toHaveBeenCalled();
  });

  it("⚠️ level-triggered: repairs a hand-reverted file mid-weekend", async () => {
    // Saturday, but someone put the file back to disabled=true.
    const t = target();
    const r = await applyRaidWindow(t as never, new Date("2026-09-19T12:00:00.000Z"), []);
    expect(r.changed).toBe(true);
    expect(r.wantedDisabled).toBe(false);
    // ⚠️ The boundary is the FRIDAY, not Saturday's slot.
    expect(r.boundaryAt.toISOString()).toBe(FRI.toISOString());
  });

  it("leaves base damage off for a skipped weekend", async () => {
    const t = target();
    const r = await applyRaidWindow(t as never, FRI, [{ opensAt: FRI, reason: "launch" }]);
    expect(r.wantedDisabled).toBe(true);
    expect(r.changed).toBe(false);
    expect(t.uploadFile).not.toHaveBeenCalled();
  });

  it("⚠️ returns the previous content so a bad write can be undone", async () => {
    const t = target();
    const r = await applyRaidWindow(t as never, FRI, []);
    expect(r.previousContent).toBe(REAL);
  });

  it("⚠️ refuses — and does NOT upload — when a guard rejects the edit", async () => {
    const t = target('{"GeneralData": {"disableContainerDamage": false}}');
    await expect(applyRaidWindow(t as never, FRI, [])).rejects.toThrow(/no "disableBaseDamage"/);
    expect(t.uploadFile).not.toHaveBeenCalled();
  });

  it("⚠️ a midweek slot reports the CLOSE boundary, not the slot", async () => {
    const t = target();
    const r = await applyRaidWindow(t as never, WED, []);
    // Wednesday sits after Monday's close and before Friday's open; the flip that
    // put base damage off is the close, and that is the row it belongs to.
    expect(r.boundaryAt.toISOString()).toBe("2026-09-21T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/bot && npx vitest run test/raid-window-flip.test.ts`
Expected: FAIL — `applyRaidWindow is not exported`.

- [ ] **Step 3: Implement**

In `apps/bot/src/restart-tick.ts`:

Add to the imports:

```ts
import { raidWindowAt, type SkippedWindow } from "@factions/domain";
import { setBaseDamageDisabled } from "./cfggameplay.js";
```

Extend `RestartTarget` (around line 11) with:

```ts
  missionRootDir(): Promise<string>;
```

Add beside `TruckWipe`:

```ts
export type RaidWindow = { enabled: boolean };

/** The cfggameplay.json file name, in the mission ROOT (not `db`, not `custom`). */
const GAMEPLAY_FILE = "cfggameplay.json";

export type RaidFlip = {
  boundaryAt: Date;
  wantedDisabled: boolean;
  changed: boolean;
  previousContent: string;
};
```

Add the function, directly after `applyTruckWipe`:

```ts
/**
 * Bring one server's cfggameplay.json to the state `slot` wants, immediately
 * before its restart.
 *
 * ⚠️ Level-triggered, exactly like applyTruckWipe. Every slot recomputes the
 * wanted value, so a bot down across Friday 00:00 opens the window LATE rather
 * than not at all, and a lost or hand-reverted write is corrected within two
 * hours. An edge-triggered version ("on the Friday slot, set false") loses a
 * whole weekend to one missed tick and nothing anywhere notices.
 *
 * ⚠️ The returned boundaryAt is the WINDOW boundary, never the slot: a Saturday
 * repair belongs to that Friday's row.
 *
 * ⚠️ Throws rather than uploading whenever a guard in setBaseDamageDisabled
 * rejects the edit. Refusing costs a window that opens two hours late; writing a
 * cfggameplay.json that does not parse costs every player the server itself.
 */
export async function applyRaidWindow(
  nitrado: RestartTarget,
  slot: Date,
  skips: SkippedWindow[],
): Promise<RaidFlip> {
  const state = raidWindowAt(slot, skips);
  const dir = await nitrado.missionRootDir();
  const original = await nitrado.downloadFile(`${dir}/${GAMEPLAY_FILE}`);

  const { json, changed } = setBaseDamageDisabled(original, state.baseDamageDisabled);

  // ⚠️ The boundary this flip realises: the open instant while the window is
  // open or skipped, the close instant once it has closed.
  const boundaryAt = state.phase === "open" ? state.opensAt : state.closesAt;

  if (changed) await nitrado.uploadFile(dir, GAMEPLAY_FILE, json);

  return { boundaryAt, wantedDisabled: state.baseDamageDisabled, changed, previousContent: original };
}
```

⚠️ For a `closed` or `skipped` state the boundary is `closesAt`, which for a
midweek instant is the coming Monday. That is intended: a midweek repair belongs to
the close that put base damage off, and the row is upserted so it converges.

- [ ] **Step 4: Run the tests**

Run: `cd apps/bot && npx vitest run test/raid-window-flip.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Call it from the tick, and record the row**

In `restartTick`, inside the per-server `try`, immediately AFTER the `opts.truckWipe` block and BEFORE `await nitrado.restart(RESTART_MESSAGE)`:

```ts
      // ⚠️ BEFORE the restart POST and only for a server actually being restarted:
      // DayZ reads cfggameplay.json at boot, so a write after the POST does not take
      // effect for another two hours. ⚠️ Its own try/catch — a refused flip must
      // never cost the restart, and the next slot recomputes the wanted state anyway.
      let flip: RaidFlip | undefined;
      if (opts.raidWindow?.enabled) {
        // ⚠️ The boundary is computed BEFORE the attempt, so the catch below can key
        // its row on the same boundary a success would have used. Keying a refusal on
        // the SLOT instead would write a fresh row every two hours — up to 12 a day —
        // and the failure alert, which fires once per (boundary, kind), would fire
        // once per slot with it. That is the exact alert-burial this design refuses.
        const skips = await db.select({ opensAt: raidWindowSkips.opensAt, reason: raidWindowSkips.reason })
          .from(raidWindowSkips);
        const state = raidWindowAt(slot.start, skips);
        const boundaryAt = state.phase === "open" ? state.opensAt : state.closesAt;
        try {
          flip = await applyRaidWindow(nitrado, slot.start, skips);
          if (flip.changed) {
            await db.insert(raidWindowFlips).values({
              serverId: s.id,
              boundaryAt: flip.boundaryAt,
              wantedDisabled: flip.wantedDisabled,
              outcome: "applied",
              appliedAt: opts.now,
              previousContent: flip.previousContent,
            }).onConflictDoUpdate({
              target: [raidWindowFlips.serverId, raidWindowFlips.boundaryAt],
              set: { outcome: "applied", appliedAt: opts.now, wantedDisabled: flip.wantedDisabled },
            });
            console.log(`raid window: server ${s.id} set disableBaseDamage=${flip.wantedDisabled} for ${flip.boundaryAt.toISOString()}`);
          }
        } catch (err) {
          const detail = { error: err instanceof Error ? err.message : String(err) };
          console.error(`raid window: server ${s.id} REFUSED the flip for slot ${slot.start.toISOString()} — restarting anyway`, err);
          await db.insert(raidWindowFlips).values({
            serverId: s.id,
            boundaryAt,
            wantedDisabled: state.baseDamageDisabled,
            outcome: "refused",
            detail,
          }).onConflictDoUpdate({
            target: [raidWindowFlips.serverId, raidWindowFlips.boundaryAt],
            // ⚠️ Only downgrade a row that is not already applied. A later slot that
            // fails must never turn a confirmed flip into a refusal — that would make
            // the website stop saying LIVE for a window that genuinely is live.
            setWhere: sql`${raidWindowFlips.outcome} <> 'applied'`,
            set: { outcome: "refused", detail },
          }).catch(() => undefined);
        }
      }
```

And immediately after the `await nitrado.restart(RESTART_MESSAGE);` line succeeds:

```ts
      // ⚠️ An upload whose restart did not happen is NOT in effect. Confirmation is
      // what the website and the open/close announcements read; recording it before
      // the restart would make them assert a flip the server has not loaded.
      if (flip?.changed) {
        await db.update(raidWindowFlips).set({ restartConfirmedAt: opts.now })
          .where(and(eq(raidWindowFlips.serverId, s.id), eq(raidWindowFlips.boundaryAt, flip.boundaryAt)))
          .catch(() => undefined);
      }
```

Extend `restartTick`'s `opts` type with `raidWindow?: RaidWindow;`, add `raidWindowFlips` and `raidWindowSkips` to the `@factions/db` import, and add `sql` to the `drizzle-orm` import.

⚠️ If this drizzle version does not support `setWhere` on `onConflictDoUpdate`, achieve the same thing with a `where` on a preceding `update` — but do not drop the condition. Without it a later failing slot downgrades a confirmed flip and the website stops saying LIVE for a window that is genuinely live.

- [ ] **Step 6: Run the bot suite**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run`
Expected: PASS, including the existing restart-tick tests.

- [ ] **Step 7: Commit**

```bash
git add apps/bot/src/restart-tick.ts apps/bot/test/raid-window-flip.test.ts
git commit -m "feat(bot): flip the raid window on the restart slots"
```

---

### Task 6: The Discord messages

**Files:**
- Create: `apps/bot/src/raid-window-text.ts`
- Create: `apps/bot/src/raid-window-tick.ts`
- Test: `apps/bot/test/raid-window-tick.test.ts`

**Interfaces:**
- Consumes: `raidWindowAt` (Task 1), `raidWindowFlips`/`raidWindowSkips`/`raidWindowAnnouncements` (Task 3).
- Produces: `raidWindowTick(db, posters, opts)` returning `{ posted: number; skipped: number }`.

- [ ] **Step 1: Write the message bodies**

Create `apps/bot/src/raid-window-text.ts`:

```ts
import type { RaidWindowState } from "@factions/domain";

/** Discord's <t:…:F> renders in each reader's own timezone — never hard-code one. */
function stamp(d: Date): string {
  return `<t:${Math.floor(d.getTime() / 1000)}:F>`;
}

export function advanceText(state: RaidWindowState): string {
  if (state.phase === "skipped") {
    return [
      "**No raid weekend this week.**",
      `Base damage stays off. Reason: ${state.skipReason}`,
      "Lowering flags still scores, as always.",
    ].join("\n");
  }
  return [
    "**Raid weekend opens tomorrow.**",
    `Base damage comes on at ${stamp(state.opensAt)} and goes off at ${stamp(state.closesAt)}.`,
    "Lowering flags scores all week; the window only decides whether walls take damage.",
  ].join("\n");
}

export function openText(state: RaidWindowState): string {
  return [
    "**Raid weekend is live.** Base damage is on.",
    `It closes at ${stamp(state.closesAt)}.`,
  ].join("\n");
}

export function closeText(state: RaidWindowState): string {
  return [
    "**Raid weekend is over.** Base damage is off.",
    `The next one opens at ${stamp(state.opensAt)}.`,
  ].join("\n");
}

/**
 * ⚠️ Ops-facing, and deliberately states what the file STILL SAYS rather than what
 * was wanted. Whoever reads this at 02:00 needs to know the server's current
 * behaviour, not the intention that failed.
 */
export function failureText(boundaryAt: Date, wantedDisabled: boolean, error: string): string {
  return [
    "⚠️ **Raid window flip failed.**",
    `Boundary: ${boundaryAt.toISOString()}`,
    `Wanted: disableBaseDamage=${wantedDisabled}`,
    `The file was NOT changed, so base damage is still ${wantedDisabled ? "ON" : "OFF"}.`,
    `Error: ${error}`,
    "The next restart slot retries automatically. This alert fires once per boundary.",
  ].join("\n");
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/bot/test/raid-window-tick.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { raidWindowTick } from "../src/raid-window-tick.js";
// Bootstrap: see the preamble in Task 3, Step 4. No testDb() helper exists.
import { raidWindowFlips, raidWindowAnnouncements } from "@factions/db";
import { sql } from "drizzle-orm";

const FRI = new Date("2026-09-18T00:00:00.000Z");

async function seedServer(db: Database, id: number) {
  await db.execute(sql`insert into servers (id, name, active) values (${id}, 'T', true) on conflict do nothing`);
}

describe("raidWindowTick", () => {
  it("⚠️ does NOT post 'open' while no flip is confirmed", async () => {
    // `db` comes from the beforeEach preamble.
    const post = vi.fn(async () => undefined);
    const r = await raidWindowTick(db, { announce: post, ops: post }, { now: FRI });
    expect(post).not.toHaveBeenCalled();
    expect(r.posted).toBe(0);
  });

  it("posts 'open' once the flip is confirmed, and only once", async () => {
    // `db` comes from the beforeEach preamble.
    await seedServer(db, 910);
    await db.insert(raidWindowFlips).values({
      serverId: 910, boundaryAt: FRI, wantedDisabled: false,
      outcome: "applied", appliedAt: FRI, restartConfirmedAt: FRI,
    });
    const post = vi.fn(async () => undefined);
    const first = await raidWindowTick(db, { announce: post, ops: post }, { now: FRI });
    expect(first.posted).toBe(1);
    expect(post.mock.calls[0]![0]).toMatch(/Raid weekend is live/);

    const second = await raidWindowTick(db, { announce: post, ops: post }, { now: FRI });
    expect(second.posted).toBe(0);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("⚠️ an upload with no confirmed restart is not confirmation", async () => {
    // `db` comes from the beforeEach preamble.
    await seedServer(db, 911);
    await db.insert(raidWindowFlips).values({
      serverId: 911, boundaryAt: FRI, wantedDisabled: false,
      outcome: "applied", appliedAt: FRI, restartConfirmedAt: null,
    });
    const post = vi.fn(async () => undefined);
    const r = await raidWindowTick(db, { announce: post, ops: post }, { now: FRI });
    expect(r.posted).toBe(0);
  });

  it("⚠️ writes no row when the post throws, so the next tick retries", async () => {
    // `db` comes from the beforeEach preamble.
    await seedServer(db, 912);
    await db.insert(raidWindowFlips).values({
      serverId: 912, boundaryAt: FRI, wantedDisabled: false,
      outcome: "applied", appliedAt: FRI, restartConfirmedAt: FRI,
    });
    const post = vi.fn(async () => { throw new Error("discord down"); });
    await raidWindowTick(db, { announce: post, ops: post }, { now: FRI });
    const rows = await db.select().from(raidWindowAnnouncements);
    expect(rows.filter((r) => r.kind === "open")).toEqual([]);
  });

  it("posts the Thursday advance notice once", async () => {
    // `db` comes from the beforeEach preamble.
    const post = vi.fn(async () => undefined);
    const thu = new Date("2026-09-17T12:00:00.000Z");
    const r = await raidWindowTick(db, { announce: post, ops: post }, { now: thu });
    expect(r.posted).toBe(1);
    expect(post.mock.calls[0]![0]).toMatch(/opens tomorrow/);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd apps/bot && npx vitest run test/raid-window-tick.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the tick**

Create `apps/bot/src/raid-window-tick.ts`:

```ts
import { and, eq, isNotNull } from "drizzle-orm";
import { raidWindowAnnouncements, raidWindowFlips, raidWindowSkips, type Database } from "@factions/db";
import { raidWindowAt } from "@factions/domain";
import { advanceText, closeText, openText } from "./raid-window-text.js";

export type RaidPoster = (content: string) => Promise<void>;
export type RaidPosters = { announce: RaidPoster; ops: RaidPoster };
export type RaidWindowTickResult = { posted: number; skipped: number };

/** How far ahead of the open the advance notice goes out. */
const ADVANCE_LEAD_MS = 24 * 60 * 60 * 1000;

async function alreadyPosted(db: Database, boundaryAt: Date, kind: string): Promise<boolean> {
  const [row] = await db.select({ kind: raidWindowAnnouncements.kind })
    .from(raidWindowAnnouncements)
    .where(and(eq(raidWindowAnnouncements.boundaryAt, boundaryAt), eq(raidWindowAnnouncements.kind, kind as never)))
    .limit(1);
  return Boolean(row);
}

/**
 * ⚠️ POST first, row second — the house rule from every poster here. A row written
 * first records an announcement that never went out if the post then fails; the
 * reverse costs at most a duplicate message after a crash between the two, which is
 * the direction this repo chooses everywhere (see notice-tick.ts).
 */
async function postOnce(
  db: Database, post: RaidPoster, boundaryAt: Date,
  kind: "advance" | "open" | "close" | "failure", body: string, now: Date,
): Promise<boolean> {
  if (await alreadyPosted(db, boundaryAt, kind)) return false;
  await post(body);
  await db.insert(raidWindowAnnouncements)
    .values({ boundaryAt, kind, announcedAt: now, outcome: "posted" })
    .onConflictDoNothing();
  return true;
}

/** Has any server confirmed a flip at this boundary — uploaded AND restarted? */
async function confirmed(db: Database, boundaryAt: Date): Promise<boolean> {
  const [row] = await db.select({ serverId: raidWindowFlips.serverId })
    .from(raidWindowFlips)
    .where(and(
      eq(raidWindowFlips.boundaryAt, boundaryAt),
      eq(raidWindowFlips.outcome, "applied"),
      isNotNull(raidWindowFlips.restartConfirmedAt),
    ))
    .limit(1);
  return Boolean(row);
}

export async function raidWindowTick(
  db: Database,
  posters: RaidPosters,
  opts: { now: Date },
): Promise<RaidWindowTickResult> {
  const out: RaidWindowTickResult = { posted: 0, skipped: 0 };
  const skips = await db.select({ opensAt: raidWindowSkips.opensAt, reason: raidWindowSkips.reason })
    .from(raidWindowSkips);
  const state = raidWindowAt(opts.now, skips);

  // Advance notice: within a day of the open, before it.
  if (state.phase !== "open" && opts.now >= new Date(state.opensAt.getTime() - ADVANCE_LEAD_MS)
      && opts.now < state.opensAt) {
    if (await postOnce(db, posters.announce, state.opensAt, "advance", advanceText(state), opts.now)) out.posted++;
  }

  // ⚠️ open/close are gated on a CONFIRMED flip, never on the clock. Announcing at
  // the boundary and flipping separately makes the message a prediction; this makes
  // it evidence. A failed flip must never produce "base damage is on".
  if (state.phase === "open") {
    if (await confirmed(db, state.opensAt)) {
      if (await postOnce(db, posters.announce, state.opensAt, "open", openText(state), opts.now)) out.posted++;
    } else out.skipped++;
  } else if (state.phase === "closed") {
    // The close that just happened is the previous window's closesAt, which for a
    // closed state is exactly one week before the next one.
    const justClosed = new Date(state.opensAt.getTime() - (7 * 24 * 60 * 60 * 1000 - (state.closesAt.getTime() - state.opensAt.getTime())));
    if (await confirmed(db, justClosed)) {
      if (await postOnce(db, posters.announce, justClosed, "close", closeText(state), opts.now)) out.posted++;
    } else out.skipped++;
  }

  // ⚠️ The failure alert. Spec §5: one message per boundary, never per slot.
  // The level-triggered tick retries every two hours; without the (boundary, kind)
  // key this would re-alert 12 times a day and bury the alerts the design needs
  // someone to actually read — the same reasoning as the deploy system's
  // notified-marker sidecars.
  const broken = await db.select({
    boundaryAt: raidWindowFlips.boundaryAt,
    wantedDisabled: raidWindowFlips.wantedDisabled,
    detail: raidWindowFlips.detail,
  }).from(raidWindowFlips).where(inArray(raidWindowFlips.outcome, ["refused", "failed"]));

  for (const b of broken) {
    const err = String(b.detail?.error ?? "unknown");
    if (await postOnce(db, posters.ops, b.boundaryAt, "failure",
        failureText(b.boundaryAt, b.wantedDisabled, err), opts.now)) {
      out.posted++;
    }
  }

  return out;
}
```

Add `inArray` to the `drizzle-orm` import and `failureText` to the `./raid-window-text.js` import.

- [ ] **Step 5: Add the failure-alert tests**

Append to `apps/bot/test/raid-window-tick.test.ts`:

```ts
  it("⚠️ alerts ops once per boundary on a refused flip, not once per slot", async () => {
    await db.execute(sql`insert into servers (id, name, active) values (913, 'T', true) on conflict do nothing`);
    await db.insert(raidWindowFlips).values({
      serverId: 913, boundaryAt: FRI, wantedDisabled: false,
      outcome: "refused", detail: { error: 'no "disableBaseDamage" key found' },
    });
    const announce = vi.fn(async () => undefined);
    const ops = vi.fn(async () => undefined);

    await raidWindowTick(db, { announce, ops }, { now: FRI });
    expect(ops).toHaveBeenCalledTimes(1);
    expect(ops.mock.calls[0]![0]).toMatch(/Raid window flip failed/);
    expect(ops.mock.calls[0]![0]).toMatch(/still ON/);

    // Two hours later the tick runs again. The flip retries; the alert must not.
    await raidWindowTick(db, { announce, ops }, { now: new Date(FRI.getTime() + 2 * 60 * 60 * 1000) });
    expect(ops).toHaveBeenCalledTimes(1);
  });

  it("⚠️ a refused flip never produces an 'open' message", async () => {
    await db.execute(sql`insert into servers (id, name, active) values (914, 'T', true) on conflict do nothing`);
    await db.insert(raidWindowFlips).values({
      serverId: 914, boundaryAt: FRI, wantedDisabled: false,
      outcome: "refused", detail: { error: "boom" },
    });
    const announce = vi.fn(async () => undefined);
    const ops = vi.fn(async () => undefined);
    await raidWindowTick(db, { announce, ops }, { now: FRI });
    expect(announce).not.toHaveBeenCalled();
  });
```

- [ ] **Step 6: Run the tests**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/raid-window-tick.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/bot/src/raid-window-text.ts apps/bot/src/raid-window-tick.ts apps/bot/test/raid-window-tick.test.ts
git commit -m "feat(bot): announce the raid window from confirmed flips"
```

---

### Task 7: Config and wiring

**Files:**
- Modify: `apps/bot/src/config.ts`
- Modify: `apps/bot/src/discord.ts`
- Modify: `apps/bot/README.md`
- Test: `apps/bot/test/config.test.ts` (existing file — add cases)

**Interfaces:**
- Produces: `cfg.raidWindow: { enabled: boolean }`, `cfg.opsChannelId?: string`.

- [ ] **Step 1: Add the failing config tests**

Append to `apps/bot/test/config.test.ts`:

```ts
it("⚠️ refuses RAID_WINDOW_TICK without RESTART_SCHEDULE", () => {
  expect(() => loadConfig({ ...base, RAID_WINDOW_TICK: "1", RESTART_SCHEDULE: "" }))
    .toThrow(/RESTART_SCHEDULE is off/);
});

it("accepts RAID_WINDOW_TICK with RESTART_SCHEDULE on", () => {
  const c = loadConfig({ ...base, RAID_WINDOW_TICK: "1", RESTART_SCHEDULE: "1", NITRADO_TOKEN: "t" });
  expect(c.raidWindow.enabled).toBe(true);
});

it("is off by default", () => {
  expect(loadConfig(base).raidWindow.enabled).toBe(false);
});
```

⚠️ `base` and `loadConfig` must match whatever the existing tests in that file already use — read the top of the file first and follow it rather than inventing names.

- [ ] **Step 2: Implement**

In `apps/bot/src/config.ts`, add to the config type:

```ts
  raidWindow: { enabled: boolean };
  opsChannelId?: string;
```

To the builder, beside `truckWipe`:

```ts
    raidWindow: { enabled: ["1", "true"].includes((env.RAID_WINDOW_TICK ?? "").toLowerCase()) },
    opsChannelId: optionalSnowflake(env, "OPS_CHANNEL_ID"),
```

And beside the existing truck-wipe cross-check:

```ts
  // ⚠️ Same failure shape as the truck wipe's check: the flip takes effect only
  // when the server restarts, and restarts come from the restart slots. On
  // without RESTART_SCHEDULE would write a file nobody ever reloads — the silent
  // no-op class this repo refuses to ship.
  if (config.raidWindow.enabled && !config.restartSchedule) {
    throw new Error("RAID_WINDOW_TICK is on but RESTART_SCHEDULE is off — the flip only takes effect at a restart, so nothing would ever apply it.");
  }
```

- [ ] **Step 3: Wire the tick into `discord.ts`**

Add the import beside `announceTick`:

```ts
import { raidWindowTick } from "./raid-window-tick.js";
```

Pass the gate into the restart tick — change the existing call at ~line 1246 to:

```ts
        const r = await restartTick(db, nitradoFor, { now: new Date(), truckWipe: cfg.truckWipe, raidWindow: cfg.raidWindow });
```

And after the `announceTick` block, add:

```ts
    // ⚠️ After the restart tick, same reason the announce tick is: a slow Discord
    // call must not delay a due restart. Its own try/catch, like every step.
    if (cfg.raidWindow.enabled && announcePoster) {
      try {
        const opsPoster = opsChannelPoster ?? (async (content: string) => { console.error(content); });
        const r = await raidWindowTick(db, { announce: announcePoster, ops: opsPoster }, { now: new Date() });
        if (r.posted > 0) console.log(`raid window: ${r.posted} posted`);
      } catch (err) {
        console.error("raid window tick failed", err);
      }
    }
```

Add `opsChannelPoster` beside the existing `announcePoster` at line 510:

```ts
  const announcePoster = cfg.announcementsChannelId ? createChannelPoster(client, cfg.announcementsChannelId) : null;
  const opsChannelPoster = cfg.opsChannelId ? createChannelPoster(client, cfg.opsChannelId) : null;
```

⚠️ `createChannelPoster` is the existing helper in this file — use it, do not
invent a second channel-fetching pattern. When `cfg.opsChannelId` is unset the
fallback in the tick block logs at error level and nothing else, which is exactly how
`WAR_LOG_CHANNEL_ID` already degrades and is not a regression.

- [ ] **Step 4: Document the env vars**

Add `RAID_WINDOW_TICK` and `OPS_CHANNEL_ID` to the env table in `apps/bot/README.md`, following the existing rows' format.

- [ ] **Step 5: Run the bot suite**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/config.ts apps/bot/src/discord.ts apps/bot/README.md apps/bot/test/config.test.ts
git commit -m "feat(bot): gate and wire the raid window tick"
```

---

### Task 8: The site's read

**Files:**
- Create: `packages/roster/src/base-damage-window.ts`
- Modify: `packages/roster/src/index.ts`
- Modify: `packages/roster/test/roster-exports.ts`
- Modify: `apps/web/test/smoke.test.ts:97`
- Test: `packages/roster/test/base-damage-window.test.ts`

**Interfaces:**
- Produces: `baseDamageWindow(): Promise<BaseDamageWindow>` where

```ts
export type BaseDamageWindow = {
  status: "live" | "closed" | "unconfirmed" | "skipped";
  opensAt: Date;
  closesAt: Date;
  skipReason?: string;
};
```

⚠️ **The name must not contain `raid`.** `packages/roster/test/exports.test.ts` fails any export whose lowercased name contains `raid`, to stop the site gaining a capability that writes a raid. `baseDamageWindow` is both admissible and literally what it reports.

- [ ] **Step 1: Write the failing test**

Create `packages/roster/test/base-damage-window.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
// Bootstrap: see the preamble in Task 3, Step 4. No testDb() helper exists.
import { baseDamageWindowDb } from "../src/base-damage-window";
import { raidWindowFlips, raidWindowSkips } from "@factions/db";

const FRI = new Date("2026-09-18T00:00:00.000Z");

describe("baseDamageWindow", () => {
  it("⚠️ says unconfirmed — never 'live' — when the window is open but no flip is confirmed", async () => {
    // `db` comes from the beforeEach preamble.
    const w = await baseDamageWindowDb(db, FRI);
    expect(w.status).toBe("unconfirmed");
  });

  it("says live once a flip is confirmed", async () => {
    // `db` comes from the beforeEach preamble.
    await db.execute(sql`insert into servers (id, name, active) values (920, 'T', true) on conflict do nothing`);
    await db.insert(raidWindowFlips).values({
      serverId: 920, boundaryAt: FRI, wantedDisabled: false,
      outcome: "applied", appliedAt: FRI, restartConfirmedAt: FRI,
    });
    const w = await baseDamageWindowDb(db, FRI);
    expect(w.status).toBe("live");
    expect(w.closesAt.toISOString()).toBe("2026-09-21T00:00:00.000Z");
  });

  it("⚠️ a confirmed flip from LAST weekend does not confirm this one", async () => {
    // `db` comes from the beforeEach preamble.
    await db.execute(sql`insert into servers (id, name, active) values (921, 'T', true) on conflict do nothing`);
    await db.insert(raidWindowFlips).values({
      serverId: 921, boundaryAt: new Date("2026-09-11T00:00:00.000Z"), wantedDisabled: false,
      outcome: "applied", appliedAt: FRI, restartConfirmedAt: FRI,
    });
    const w = await baseDamageWindowDb(db, FRI);
    expect(w.status).toBe("unconfirmed");
  });

  it("says skipped with the reason", async () => {
    // `db` comes from the beforeEach preamble.
    await db.insert(raidWindowSkips).values({ opensAt: FRI, reason: "launch weekend", decidedAt: FRI });
    const w = await baseDamageWindowDb(db, FRI);
    expect(w.status).toBe("skipped");
    expect(w.skipReason).toBe("launch weekend");
  });

  it("says closed midweek when the close is confirmed", async () => {
    // `db` comes from the beforeEach preamble.
    const wed = new Date("2026-09-16T00:00:00.000Z");
    await db.execute(sql`insert into servers (id, name, active) values (922, 'T', true) on conflict do nothing`);
    await db.insert(raidWindowFlips).values({
      serverId: 922, boundaryAt: new Date("2026-09-14T00:00:00.000Z"), wantedDisabled: true,
      outcome: "applied", appliedAt: wed, restartConfirmedAt: wed,
    });
    const w = await baseDamageWindowDb(db, wed);
    expect(w.status).toBe("closed");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/roster && npx vitest run test/base-damage-window.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/roster/src/base-damage-window.ts`:

```ts
import { and, eq, isNotNull } from "drizzle-orm";
import { raidWindowFlips, raidWindowSkips, type Database } from "@factions/db";
import { raidWindowAt } from "@factions/domain";
import { db as defaultDb } from "./db";

export type BaseDamageWindow = {
  status: "live" | "closed" | "unconfirmed" | "skipped";
  opensAt: Date;
  closesAt: Date;
  skipReason?: string;
};

/**
 * Whether base damage is actually on, for the site's status strip.
 *
 * ⚠️ Reads CONFIRMED flips, not the clock. "It is Friday, therefore raiding is
 * live" is wrong at exactly the moment it matters — a failed flip — and a player
 * finds out by swinging at a wall. `unconfirmed` is the honest answer when the
 * boundary has passed and nothing recorded a flip.
 *
 * ⚠️ Confirmation is per boundary: last weekend's flip never confirms this one.
 */
export async function baseDamageWindowDb(db: Database, now: Date): Promise<BaseDamageWindow> {
  const skips = await db.select({ opensAt: raidWindowSkips.opensAt, reason: raidWindowSkips.reason })
    .from(raidWindowSkips);
  const state = raidWindowAt(now, skips);

  if (state.phase === "skipped") {
    return { status: "skipped", opensAt: state.opensAt, closesAt: state.closesAt, skipReason: state.skipReason };
  }

  const boundary = state.phase === "open"
    ? state.opensAt
    : new Date(state.opensAt.getTime() - (7 * 24 * 60 * 60 * 1000 - (state.closesAt.getTime() - state.opensAt.getTime())));

  const [row] = await db.select({ serverId: raidWindowFlips.serverId })
    .from(raidWindowFlips)
    .where(and(
      eq(raidWindowFlips.boundaryAt, boundary),
      eq(raidWindowFlips.outcome, "applied"),
      isNotNull(raidWindowFlips.restartConfirmedAt),
    ))
    .limit(1);

  if (!row) return { status: "unconfirmed", opensAt: state.opensAt, closesAt: state.closesAt };
  return {
    status: state.phase === "open" ? "live" : "closed",
    opensAt: state.opensAt,
    closesAt: state.closesAt,
  };
}

export async function baseDamageWindow(): Promise<BaseDamageWindow> {
  return baseDamageWindowDb(defaultDb, new Date());
}
```

⚠️ Match the default-database import to whatever `packages/roster/src/` already uses (`./db`, a `getDb()`, etc.) — read `servers.ts` first and follow it.

- [ ] **Step 4: Export it and update BOTH pinned lists**

In `packages/roster/src/index.ts` add `baseDamageWindow` to the export list, alphabetically (it sorts immediately before `baseFor`).

In `packages/roster/test/roster-exports.ts`, add `"baseDamageWindow"` to `ROSTER_EXPORTS`, between `"attention"` and `"baseFor"`.

In `apps/web/test/smoke.test.ts`, add `"baseDamageWindow"` to the inline array at the same position.

⚠️ Both lists, on purpose. That is the capability rule: the export list IS the permission list, and it is pinned from both sides so an export cannot land by accident.

- [ ] **Step 5: Run both pinned suites**

```bash
cd packages/roster && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run
cd ../../apps/web && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/smoke.test.ts
```
Expected: PASS both.

- [ ] **Step 6: Commit**

```bash
git add packages/roster/src/base-damage-window.ts packages/roster/src/index.ts packages/roster/test apps/web/test/smoke.test.ts
git commit -m "feat(roster): expose the confirmed base-damage window to the site"
```

---

### Task 9: The website strip

**Files:**
- Create: `apps/web/lib/raid-strip.ts`
- Create: `apps/web/app/components/raid-strip.tsx`
- Create: `apps/web/app/components/raid-countdown.tsx`
- Modify: `apps/web/app/(site)/layout.tsx`
- Modify: `apps/web/app/guide/layout.tsx`
- Test: `apps/web/test/raid-strip.test.ts`

**Interfaces:**
- Consumes: `baseDamageWindow()` from `@factions/roster` (Task 8).
- Produces: `RaidStrip` component; `raidStripLine(w, now)` pure helper.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/raid-strip.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { raidStripLine } from "@/lib/raid-strip";

const FRI = new Date("2026-09-18T00:00:00.000Z");
const MON = new Date("2026-09-21T00:00:00.000Z");

describe("raidStripLine", () => {
  it("live, with time until close", () => {
    const l = raidStripLine({ status: "live", opensAt: FRI, closesAt: MON }, new Date("2026-09-20T10:00:00.000Z"));
    expect(l.label).toBe("RAID WEEKEND");
    expect(l.value).toBe("LIVE");
    expect(l.detail).toBe("closes in 14h");
    expect(l.tone).toBe("live");
  });

  it("closed, with time until open", () => {
    const l = raidStripLine({ status: "closed", opensAt: FRI, closesAt: MON }, new Date("2026-09-16T00:00:00.000Z"));
    expect(l.value).toBe("CLOSED");
    expect(l.detail).toBe("opens in 2d 0h");
    expect(l.tone).toBe("muted");
  });

  it("⚠️ unconfirmed never reads as live", () => {
    const l = raidStripLine({ status: "unconfirmed", opensAt: FRI, closesAt: MON }, FRI);
    expect(l.value).toBe("OPENING");
    expect(l.detail).toBe("not yet confirmed");
    expect(l.tone).toBe("warn");
  });

  it("skipped shows the reason", () => {
    const l = raidStripLine(
      { status: "skipped", opensAt: FRI, closesAt: MON, skipReason: "launch weekend" },
      new Date("2026-09-16T00:00:00.000Z"),
    );
    expect(l.value).toBe("SKIPPED THIS WEEK");
    expect(l.detail).toBe("launch weekend");
    expect(l.tone).toBe("muted");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/raid-strip.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure helper**

Create `apps/web/lib/raid-strip.ts`:

```ts
import type { BaseDamageWindow } from "@factions/roster";

export type RaidStripLine = {
  label: string;
  value: string;
  detail: string;
  tone: "live" | "muted" | "warn";
};

/** "14h", "2d 0h", "38m" — coarse on purpose; a second-by-second clock invites reloading. */
export function humanizeUntil(from: Date, to: Date): string {
  const ms = Math.max(0, to.getTime() - from.getTime());
  const mins = Math.floor(ms / 60000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h`;
  return `${mins}m`;
}

export function raidStripLine(w: BaseDamageWindow, now: Date): RaidStripLine {
  const label = "RAID WEEKEND";
  switch (w.status) {
    case "live":
      return { label, value: "LIVE", detail: `closes in ${humanizeUntil(now, w.closesAt)}`, tone: "live" };
    case "closed":
      return { label, value: "CLOSED", detail: `opens in ${humanizeUntil(now, w.opensAt)}`, tone: "muted" };
    case "skipped":
      return { label, value: "SKIPPED THIS WEEK", detail: w.skipReason ?? "", tone: "muted" };
    case "unconfirmed":
      // ⚠️ Never "LIVE". The boundary has passed with no confirmed flip, so the
      // server's actual behaviour is unknown — saying LIVE here is the confident
      // lie this whole design exists to avoid.
      return { label, value: "OPENING", detail: "not yet confirmed", tone: "warn" };
  }
}
```

- [ ] **Step 4: Run the test**

Run: `cd apps/web && npx vitest run test/raid-strip.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Build the components**

Create `apps/web/app/components/raid-countdown.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { humanizeUntil } from "@/lib/raid-strip";

/**
 * The countdown only. Everything else in the strip is server-rendered.
 *
 * Refreshes every 30s, matching the map's age labels — coarse enough that a
 * minute-level display never looks stuck and never invites a reload.
 */
export function RaidCountdown({ prefix, target }: { prefix: string; target: string }) {
  const to = new Date(target);
  const [text, setText] = useState(() => humanizeUntil(new Date(), to));
  useEffect(() => {
    const id = setInterval(() => setText(humanizeUntil(new Date(), to)), 30_000);
    return () => clearInterval(id);
  }, [target]);
  return <span>{prefix} {text}</span>;
}
```

Create `apps/web/app/components/raid-strip.tsx`:

```tsx
import type { BaseDamageWindow } from "@factions/roster";
import { raidStripLine } from "@/lib/raid-strip";
import { RaidCountdown } from "./raid-countdown";

const TONE: Record<string, string> = {
  live: "text-gold",
  warn: "text-gold",
  muted: "text-muted",
};

/**
 * The raid-window status strip, in the top bar's frame beneath the server-name
 * marquee. Nothing to show renders nothing — an unreachable read is no strip,
 * never an error and never a guess.
 */
export function RaidStrip({ window: w }: { window: BaseDamageWindow | undefined }) {
  if (!w) return null;
  const line = raidStripLine(w, new Date());
  const target = w.status === "live" ? w.closesAt : w.opensAt;
  const countdownPrefix = w.status === "live" ? "closes in" : "opens in";
  return (
    <div role="status" aria-label="Raid window" className="border-b-2 border-rule-2 bg-frame">
      <div className="flex h-9 items-center gap-2 px-4 font-display text-sm uppercase tracking-[0.04em] text-muted">
        <span>{line.label}:</span>
        <span className={TONE[line.tone]}>{line.value}</span>
        <span className="text-muted">
          {w.status === "live" || w.status === "closed"
            ? <RaidCountdown prefix={countdownPrefix} target={target.toISOString()} />
            : line.detail}
        </span>
      </div>
    </div>
  );
}
```

⚠️ `text-gold`, `text-muted`, `bg-frame` and `border-rule-2` are the tokens `server-strip.tsx` already uses. Do not introduce new colour values — `apps/web/test/theme-tokens.test.ts` holds the palette against the `@theme` block.

- [ ] **Step 6: Render it in both layouts**

In `apps/web/app/(site)/layout.tsx`, beside the existing `liveServers()` read:

```tsx
  // Same shape as the strip above: one cheap read, never a reason to fail the page.
  const raidWindow = await baseDamageWindow().catch(() => undefined);
```

and render `<RaidStrip window={raidWindow} />` immediately after `<ServerStrip lines={serverLines} />`.

Do the same in `apps/web/app/guide/layout.tsx`.

⚠️ `/` sits outside both layouts on purpose (`apps/web/test/menu.test.ts` pins that), so the landing page carries no strip. That is accepted.

- [ ] **Step 7: Run the web suite**

Run: `cd apps/web && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/lib/raid-strip.ts apps/web/app/components/raid-strip.tsx apps/web/app/components/raid-countdown.tsx "apps/web/app/(site)/layout.tsx" apps/web/app/guide/layout.tsx apps/web/test/raid-strip.test.ts
git commit -m "feat(web): the raid window status strip"
```

---

### Task 10: The skip script

**Files:**
- Create: `scripts/raid-skip.ts`
- Modify: `package.json` (root, `scripts`)

**Interfaces:**
- Consumes: `raidWindowSkips` (Task 3).

- [ ] **Step 1: Read the script this one copies**

Read `scripts/wipe.ts` first, specifically its argument parsing, its `factions_live`
guard and its `--allow-test-db` escape. Match its conventions where they differ from
the sketch below — that file is the house pattern and this plan is not.

- [ ] **Step 2: Write the script**

Create `scripts/raid-skip.ts`:

```ts
/**
 * Record a raid weekend deliberately not opened.
 *
 *   pnpm raid:skip --opens 2026-09-18T00:00:00Z --reason "first weekend after launch"
 *
 * ⚠️ A skip is a DECISION, not a missed flip to catch up. Do not use this to
 * compensate for a window that failed to open — the guide promises specific hours,
 * the level-triggered tick already repairs a lost write within two hours, and the
 * scoreboard does not depend on the window at all.
 */
import { createClient, raidWindowSkips } from "@factions/db";
import { RAID_WINDOW } from "@factions/domain";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function usage(msg: string): never {
  console.error(`raid:skip: ${msg}`);
  console.error('usage: pnpm raid:skip --opens <ISO> --reason "<why>" [--allow-test-db]');
  process.exit(2);
}

const opensRaw = arg("opens");
const reason = arg("reason");
if (!opensRaw) usage("--opens is required");
if (!reason || reason.trim() === "") usage("--reason is required and must not be empty");

const opensAt = new Date(opensRaw);
if (Number.isNaN(opensAt.getTime())) usage(`--opens "${opensRaw}" is not an ISO instant`);

// ⚠️ Must be EXACTLY a window's opening instant. A skip keyed to 00:00:01, or to
// the Saturday, matches no window at all: raidWindowAt compares by getTime(), the row
// silently never applies, and the weekend opens anyway while a human believes it was
// called off. Refusing here is the only place that can catch it.
const DAY_MS = 24 * 60 * 60 * 1000;
const midnight = new Date(Date.UTC(opensAt.getUTCFullYear(), opensAt.getUTCMonth(), opensAt.getUTCDate()));
const back = (midnight.getUTCDay() - RAID_WINDOW.openDow + 7) % 7;
const nearest = new Date(midnight.getTime() - back * DAY_MS);
if (opensAt.getTime() !== nearest.getTime()) {
  usage(
    `--opens must be exactly a window opening instant (midnight UTC on day ${RAID_WINDOW.openDow}). ` +
      `Got ${opensAt.toISOString()}; the window covering it opens at ${nearest.toISOString()}.`,
  );
}

const url = process.env.DATABASE_URL ?? "";
if (!url.endsWith("/factions_live") && !process.argv.includes("--allow-test-db")) {
  usage(`DATABASE_URL does not end in /factions_live; pass --allow-test-db if that is deliberate`);
}

const db = createClient(url);
const row = { opensAt, reason: reason.trim(), decidedAt: new Date() };
await db.insert(raidWindowSkips).values(row).onConflictDoUpdate({
  target: raidWindowSkips.opensAt,
  set: { reason: row.reason, decidedAt: row.decidedAt },
});
console.log(`raid:skip: ${opensAt.toISOString()} will NOT open — ${row.reason}`);
process.exit(0);
```

⚠️ `onConflictDoUpdate`, not `onConflictDoNothing`: re-running with a corrected
reason must fix the reason the site and Thursday's notice will show, not silently keep
the old one.

- [ ] **Step 3: Add the script entry**

In the root `package.json` `scripts`:

```json
    "raid:skip": "tsx scripts/raid-skip.ts",
```

- [ ] **Step 4: Verify it refuses bad input**

```bash
pnpm raid:skip --opens 2026-09-19T00:00:00Z --reason "test" --allow-test-db
```
Expected: exits non-zero, saying 2026-09-19 is a Saturday and naming 2026-09-18T00:00:00.000Z.

```bash
pnpm raid:skip --opens 2026-09-18T00:00:00Z --allow-test-db
```
Expected: exit code 2, usage error about the missing `--reason`.

- [ ] **Step 5: Commit**

```bash
git add scripts/raid-skip.ts package.json
git commit -m "feat(scripts): record a deliberately skipped raid weekend"
```

---

### Task 11: Documentation

**Files:**
- Modify: `docs/deploy/raid-window.md`
- Modify: `packages/domain/test/raid-window-runbook.test.ts` (only if the pinned strings move)
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Read the drift test first**

Read `packages/domain/test/raid-window-runbook.test.ts` and note exactly which strings in the runbook it pins against `rules.ts`. Those must survive the rewrite or move in lockstep.

- [ ] **Step 2: Rewrite the runbook**

`docs/deploy/raid-window.md` becomes: what the automation does, how to tell it worked, what to do when it does not, and the manual panel steps as the fallback.

Specific changes, all required:

- The opening "Nothing in this repo flips it … So this runbook is done by hand, twice a week" is now false. Replace it with the automation's description and the `RAID_WINDOW_TICK` gate.
- ⚠️ **Correct this line:** "The window only decides whether walls, gates and containers take damage." `disableContainerDamage` is `false` on the live server and nothing has ever flipped it, so containers are damageable every day of the week. State that plainly, and record that windowing container damage was considered and deliberately rejected on 2026-09-17 as a separate decision needing its own announcement.
  ⚠️ Note explicitly that no player-facing promise is broken: the guide says only that "walls do not take damage" (`05-raiding.html`) and the word "container" appears nowhere in `apps/web/content/guide/` or `guide-numbers.ts`.
- Keep the exceptions table, and add that skips are now recorded with `pnpm raid:skip` and are what the site and Discord read.
- Keep the "If a flip is missed" rule — it now describes what the level-triggered tick does automatically, and it still forbids compensating on another day.
- Keep the manual procedure as the fallback for when the tick is off or a flip is refused.

- [ ] **Step 3: Update CLAUDE.md**

- In the `discord.ts` tick-order paragraph, add `raid-window-tick.ts` after `announce-tick.ts`, gated on `RAID_WINDOW_TICK`.
- Add a row to the "Where things live" table for the raid window, naming `packages/domain/src/raid-window.ts`, `apps/bot/src/cfggameplay.ts`, the three tables and the runbook.
- ⚠️ Update the raid-window row that currently reads "The raid window, flipped by hand twice a week" — it is no longer flipped by hand.
- Note the two new env vars.

- [ ] **Step 4: Changelog**

Add under `## [Unreleased]`:

```markdown
### Added

- The raid weekend opens and closes itself. Base damage is flipped on the
  Friday and Monday boundaries by the bot, on the restart slots that already
  apply it, and repaired within two hours if a write is lost or reverted.
- The site's top bar states whether raiding is live, with a countdown — read
  from confirmed flips, so a failed flip shows "not yet confirmed" rather than
  telling players base damage is on when it is not.
- Discord announces the weekend a day ahead, at its open and at its close, and
  alerts ops once per boundary if a flip is refused.
- `pnpm raid:skip` records a weekend deliberately not opened, with its reason;
  the site and the Thursday notice both explain the skip.

### Fixed

- `docs/deploy/raid-window.md` said the window decides whether "walls, gates and
  containers" take damage. Container damage has never been windowed on this
  server. No player-facing promise was affected — the guide says only that walls
  do not take damage.
```

- [ ] **Step 5: Run the full gate**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx turbo run typecheck test --concurrency=1 --force
```
Expected: **30/30 tasks**. ⚠️ Check the count, not the exit code — a cached pass proves nothing.

- [ ] **Step 6: Commit**

```bash
git add docs/deploy/raid-window.md CLAUDE.md CHANGELOG.md packages/domain/test/raid-window-runbook.test.ts
git commit -m "docs: the raid window is automated"
```

---

## Deployment notes (not tasks — for the runbook that follows)

⚠️ Migration 0037 is additive (three new tables, no `ALTER` of anything existing), so
the stop-the-bot-first rule for NOT NULL migrations does not apply. It still reaches
`factions_live` only through `pnpm db:migrate --apply --production`, or automatically
via `deploy/deploy-release.sh` on the release that carries it.

⚠️ **`RAID_WINDOW_TICK` must stay unset until the migration has applied.** The bot
refuses to start without `RESTART_SCHEDULE`, but nothing stops it starting against a
database without the three tables — the first tick would then fail every two hours.

⚠️ **The first real flip writes to the file that stops the server booting.** Watch the
first boundary rather than assuming it: after the Friday 00:00 slot, confirm
`raid_window_flips` has an `applied` row with `restart_confirmed_at` set, and confirm in
game that a wall takes damage. The `previous_content` column on that row is the recovery
path if it does not.
