# Rules module and vocabulary sweep — implementation plan (increment 0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put every timer, cap, radius and cooldown the guide promises into one module, hold it against the guide's own numbers table with a test, route the existing constants through it, and make every public Discord post say "clan".

**Architecture:** A new `packages/domain/src/rules.ts` is the single home for constants. Existing modules (`dormancy.ts`, `rebind.ts`, `ceremony-tick.ts`, `tick.ts`, `config.ts`) keep their exported names but import the values. A checked-in `docs/guide-numbers.json`, regenerated from the guide's `numbers.html` by a script, is compared row-by-row against `rules.ts` by a pure test. Public embeds and DMs are swept for the word "faction".

**Tech Stack:** TypeScript, vitest, pnpm workspace, turbo. No database work in this increment.

**Spec:** `docs/superpowers/specs/2026-09-04-clan-wars-target-state-design.md` §1 (vocabulary and numbers), §13 (drift tests), §15 increment 0.

## Global Constraints

- Every player-facing string says **clan**; identifiers, tables and package names keep **faction** (spec §1).
- Every number in the guide's table lives in `packages/domain/src/rules.ts` and nowhere else in code (spec §1).
- The full gate before any commit that touches more than one package: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force` — expect **22/22** tasks (23 after Task 2 adds a domain test file counts as the same task; the count is of turbo tasks, not files).
- Comments explain **why**; `⚠️` marks a line whose failure is silent (CLAUDE.md house style).
- Commit messages end with the session trailer used in this repo's recent commits.

---

### Task 1: `rules.ts` with every guide number

**Files:**
- Create: `packages/domain/src/rules.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/rules.test.ts`

**Interfaces:**
- Produces: the exported constants below, consumed by Tasks 3 and 4 and by every later increment. Names are final.

- [ ] **Step 1: Write the failing test**

```ts
// packages/domain/test/rules.test.ts
import { describe, it, expect } from "vitest";
import * as R from "../src/rules.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;

describe("rules", () => {
  it("states the guide's timers in milliseconds", () => {
    expect(R.LINK_TTL_MS).toBe(10 * MIN);
    expect(R.CEREMONY_WINDOW_MS).toBe(10 * MIN);
    expect(R.CLAIM_WINDOW_MS).toBe(24 * HOUR);
    expect(R.ACTIVATION_WINDOW_MS).toBe(24 * HOUR);
    expect(R.NEW_POLE_GRACE_MS).toBe(7 * DAY);
    expect(R.RELEASED_POLE_GRACE_MS).toBe(3 * DAY);
    expect(R.SOLO_LAPSE_MS).toBe(7 * DAY);
    expect(R.RAID_DEDUP_MS).toBe(24 * HOUR);
    expect(R.FLAG_DOWN_MS).toBe(24 * HOUR);
    expect(R.DORMANT_AFTER_MS).toBe(7 * DAY);
    expect(R.DISBAND_AFTER_DORMANT_MS).toBe(14 * DAY);
    expect(R.POST_WIPE_BIND_MS).toBe(7 * DAY);
    expect(R.PENDING_EXPIRY_MS).toBe(7 * DAY);
    expect(R.ROSTER_COOLDOWN_MS).toBe(3 * DAY);
    expect(R.LEADER_SILENT_MS).toBe(7 * DAY);
    expect(R.SUCCESSION_WINDOW_MS).toBe(48 * HOUR);
    expect(R.VOTE_LENGTH_MS).toBe(48 * HOUR);
    expect(R.FAILED_VOTE_COOLDOWN_MS).toBe(14 * DAY);
    expect(R.RENAME_COOLDOWN_MS).toBe(30 * DAY);
    expect(R.REBIND_CONFIRM_MS).toBe(24 * HOUR);
    expect(R.REBIND_COOLDOWN_MS).toBe(7 * DAY);
    expect(R.GUEST_PASS_MS).toBe(24 * HOUR);
    expect(R.POSITION_FIX_MS).toBe(5 * MIN);
    expect(R.INTRUDER_ALERT_COOLDOWN_MS).toBe(20 * MIN);
    expect(R.INTRUDER_PIN_TTL_MS).toBe(60 * MIN);
    expect(R.PIN_TTL_MS).toBe(7 * DAY);
    expect(R.COMBAT_LOG_MS).toBe(10 * MIN);
  });

  it("states the guide's counts and distances", () => {
    expect(R.LINK_EMOTES).toBe(3);
    expect(R.FLAG_POOL_SIZE).toBe(33);
    expect(R.CEREMONY_MIN_PARTICIPANTS).toBe(3);
    expect(R.CLAN_NAME_LENGTH).toEqual({ min: 3, max: 32 });
    expect(R.CLAN_TAG_LENGTH).toEqual({ min: 2, max: 5 });
    expect(R.DECLARATIONS_PER_PLAYER).toBe(1);
    expect(R.MIN_BASE_SPACING_M).toBe(200);
    expect(R.WATCH_ZONE_RADIUS_M).toBe(100);
    expect(R.JOIN_PRESENCE_RADIUS_M).toBe(50);
    expect(R.CLAN_SIZE_CAP).toBe(10);
    expect(R.ALPHAS_PER_WEEK).toBe(3);
    expect(R.KD_MIN_KILLS).toBe(10);
    expect(R.VAULT_CODE_DIGITS).toBe(4);
    expect(R.TRAVEL_POINTS).toBe(209);
    expect(R.HUB_DESTINATIONS).toBe(31);
    expect(R.WATCHTOWER_MAX_HEIGHT).toEqual({ grounded: 2, onStructure: 1 });
    expect(R.POINTS_TOP).toBe(200);
    expect(R.POINTS_BOTTOM).toBe(100);
    expect(R.POINTS_UNRANKED).toBe(100);
    expect(R.VOTE_THRESHOLD).toEqual({ num: 2, den: 3 });
    expect(R.HUB_POSITION).toEqual({ x: 100, z: 93 });
  });

  it("⚠️ keeps the released grace strictly shorter than the rebind cooldown", () => {
    // Spec §4.2: equal or longer lets a clan ping-pong two private bases.
    expect(R.RELEASED_POLE_GRACE_MS).toBeLessThan(R.REBIND_COOLDOWN_MS);
  });

  it("⚠️ keeps the watch zone at half the spacing so zones never overlap", () => {
    expect(R.WATCH_ZONE_RADIUS_M * 2).toBeLessThanOrEqual(R.MIN_BASE_SPACING_M);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @factions/domain exec vitest run test/rules.test.ts`
Expected: FAIL — `Cannot find module '../src/rules.js'`.

- [ ] **Step 3: Write `rules.ts`**

```ts
// packages/domain/src/rules.ts
/**
 * Every timer, cap, radius and cooldown the player's guide promises, in one
 * place. The guide (../field-guide/numbers.html) is the authority; this file
 * is its mirror in code, and `test/guide-numbers-drift.test.ts` fails when
 * the two disagree.
 *
 * ⚠️ No other module may state one of these numbers as a literal. A number
 * stated twice will drift, and the symptom is a clock that fires a day early
 * with nothing in any log to say why.
 */

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// Getting in
export const LINK_EMOTES = 3;
export const LINK_TTL_MS = 10 * MIN;

// Founding
export const FLAG_POOL_SIZE = 33;
export const CEREMONY_MIN_PARTICIPANTS = 3;
export const CEREMONY_WINDOW_MS = 10 * MIN;
export const CLAIM_WINDOW_MS = 24 * HOUR;
export const ACTIVATION_WINDOW_MS = 24 * HOUR;
export const CLAN_NAME_LENGTH = { min: 3, max: 32 } as const;
export const CLAN_TAG_LENGTH = { min: 2, max: 5 } as const;

// Bases
export const DECLARATIONS_PER_PLAYER = 1;
export const NEW_POLE_GRACE_MS = 7 * DAY;
export const RELEASED_POLE_GRACE_MS = 3 * DAY;
export const MIN_BASE_SPACING_M = 200;
export const WATCH_ZONE_RADIUS_M = 100;
export const SOLO_LAPSE_MS = 7 * DAY;
/**
 * The Fast Travel Hub's arrival point (fast-travel-points.json, `hub`). The
 * 200 m rule treats it as a declaration that always exists and is never
 * published, so no base can sit inside the one place every traveller lands.
 */
export const HUB_POSITION = { x: 100, z: 93 } as const;

// Raiding
export const RAID_DEDUP_MS = 24 * HOUR;
/** Fri 00:00 → Mon 00:00 UTC. Enforced by the game server's config, not here. */
export const RAID_WINDOW = { openDow: 5, closeDow: 1 } as const;

// Defending
export const FLAG_DOWN_MS = 24 * HOUR;
export const DORMANT_AFTER_MS = 7 * DAY;
export const DISBAND_AFTER_DORMANT_MS = 14 * DAY;

// The scoreboard
export const POINTS_TOP = 200;
export const POINTS_BOTTOM = 100;
export const POINTS_UNRANKED = 100;
export const ALPHAS_PER_WEEK = 3;
export const POST_WIPE_BIND_MS = 7 * DAY;
export const KD_MIN_KILLS = 10;

// Running a clan
export const CLAN_SIZE_CAP = 10;
export const JOIN_PRESENCE_RADIUS_M = 50;
export const PENDING_EXPIRY_MS = 7 * DAY;
export const ROSTER_COOLDOWN_MS = 3 * DAY;
export const LEADER_SILENT_MS = 7 * DAY;
export const SUCCESSION_WINDOW_MS = 48 * HOUR;
export const VOTE_LENGTH_MS = 48 * HOUR;
export const VOTE_THRESHOLD = { num: 2, den: 3 } as const;
export const FAILED_VOTE_COOLDOWN_MS = 14 * DAY;
export const RENAME_COOLDOWN_MS = 30 * DAY;
export const REBIND_CONFIRM_MS = 24 * HOUR;
export const REBIND_COOLDOWN_MS = 7 * DAY;
export const VAULT_CODE_DIGITS = 4;

// Discord
export const GUEST_PASS_MS = 24 * HOUR;

// The map
export const POSITION_FIX_MS = 5 * MIN;
export const INTRUDER_ALERT_COOLDOWN_MS = 20 * MIN;
export const INTRUDER_PIN_TTL_MS = 60 * MIN;
export const PIN_TTL_MS = 7 * DAY;

// Getting around
export const TRAVEL_POINTS = 209;
export const HUB_DESTINATIONS = 31;

// Fair play
export const COMBAT_LOG_MS = 10 * MIN;
export const WATCHTOWER_MAX_HEIGHT = { grounded: 2, onStructure: 1 } as const;
```

Add to `packages/domain/src/index.ts`:

```ts
export * from "./rules.js";
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @factions/domain exec vitest run test/rules.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter @factions/domain typecheck`
Expected: exit 0.

```bash
git add packages/domain/src/rules.ts packages/domain/src/index.ts packages/domain/test/rules.test.ts
git commit -m "feat(domain): rules.ts — every guide number in one module"
```

---

### Task 2: Vendored guide numbers and the drift test

**Files:**
- Create: `scripts/guide-numbers.ts`
- Create: `docs/guide-numbers.json`
- Create: `packages/domain/test/guide-numbers-drift.test.ts`
- Modify: `package.json` (root, add the script)

**Interfaces:**
- Consumes: `rules.ts` from Task 1.
- Produces: `docs/guide-numbers.json` with shape `{ source: string, generatedAt: string, rows: { label: string, value: string }[] }`.

- [ ] **Step 1: Write the extraction script**

The guide's table is one `<table>` of `<tr><td>label</td><td class="v">value</td></tr>` rows plus `<tr class="group">` headers. Extract the label/value pairs only.

```ts
// scripts/guide-numbers.ts
/**
 * Regenerate docs/guide-numbers.json from the field guide's numbers table.
 *
 *   pnpm guide:numbers            # reads ../field-guide/numbers.html
 *   pnpm guide:numbers <path>     # any copy of numbers.html
 *
 * ⚠️ Commit the JSON. The drift test reads the JSON, not the guide, so the
 * test is deterministic in CI, and a stale JSON is caught by the reviewer
 * diffing this file against the guide's commit — which is the point of
 * vendoring it rather than reaching across repositories at test time.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const src = process.argv[2] ?? resolve(process.cwd(), "..", "field-guide", "numbers.html");
const html = readFileSync(src, "utf8");

const ROW = /<tr><td>([^<]*)<\/td><td class="v">([^<]*)<\/td><\/tr>/gu;
const decode = (s: string) =>
  s.replace(/&rarr;/gu, "→").replace(/&ndash;/gu, "–").replace(/&amp;/gu, "&").trim();

const rows = [...html.matchAll(ROW)].map((m) => ({ label: decode(m[1]!), value: decode(m[2]!) }));
if (rows.length < 40) {
  throw new Error(`only ${rows.length} rows matched in ${src}; the table markup has changed`);
}

const out = { source: "field-guide/numbers.html", generatedAt: new Date().toISOString(), rows };
writeFileSync(resolve(process.cwd(), "docs", "guide-numbers.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`${rows.length} rows → docs/guide-numbers.json`);
```

Add to the root `package.json` `scripts`:

```json
"guide:numbers": "tsx scripts/guide-numbers.ts"
```

If `tsx` is not a root devDependency, add it: `pnpm add -Dw tsx`.

- [ ] **Step 2: Generate the JSON**

Run: `pnpm guide:numbers`
Expected: `49 rows → docs/guide-numbers.json`. Open the file and confirm the first row is `Link: emotes to perform` / `3, in order` and the last is `Watchtower height` / `2 (1 on a structure)`.

- [ ] **Step 3: Write the failing drift test**

Every guide row maps to a rendering of a rule. The mapping is explicit so a new guide row with no rule fails loudly.

```ts
// packages/domain/test/guide-numbers-drift.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as R from "../src/rules.js";

const here = dirname(fileURLToPath(import.meta.url));
const json = JSON.parse(readFileSync(resolve(here, "..", "..", "..", "docs", "guide-numbers.json"), "utf8")) as {
  rows: { label: string; value: string }[];
};

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const days = (ms: number) => `${ms / DAY} days`;
const hours = (ms: number) => `${ms / HOUR} h`;
const mins = (ms: number) => `${ms / MIN} min`;

/**
 * ⚠️ Two statements of one fact: the guide's table and rules.ts. This map is
 * the seam. Every row in the JSON must appear here, and every rendering must
 * equal the guide's text exactly — a rule that drifts by a day renders as
 * "8 days" and fails.
 */
const EXPECTED: Record<string, string> = {
  "Link: emotes to perform": `${R.LINK_EMOTES}, in order`,
  "Link: time limit": mins(R.LINK_TTL_MS),
  "Flags in the pool": `${R.FLAG_POOL_SIZE} (white is neutral)`,
  "Ceremony: linked players required": `${R.CEREMONY_MIN_PARTICIPANTS}`,
  "Ceremony: window": mins(R.CEREMONY_WINDOW_MS),
  "Claim window after ceremony": hours(R.CLAIM_WINDOW_MS),
  "Activation window after claim": hours(R.ACTIVATION_WINDOW_MS),
  "Clan name length": `${R.CLAN_NAME_LENGTH.min}–${R.CLAN_NAME_LENGTH.max}`,
  "Clan tag length": `${R.CLAN_TAG_LENGTH.min}–${R.CLAN_TAG_LENGTH.max}`,
  "Declarations per player": `${R.DECLARATIONS_PER_PLAYER}`,
  "New pole grace before public": days(R.NEW_POLE_GRACE_MS),
  "Released pole grace before public": days(R.RELEASED_POLE_GRACE_MS),
  "Minimum distance between declared bases": `${R.MIN_BASE_SPACING_M} m`,
  "Watch zone radius": `${R.WATCH_ZONE_RADIUS_M} m`,
  "Solo declaration lapses after (no raise by declarant)": days(R.SOLO_LAPSE_MS),
  "Raid credit dedup (raider clan → victim)": hours(R.RAID_DEDUP_MS),
  "Raid window (base damage on)": "Fri 00:00 → Mon 00:00 UTC",
  "Flag-down clock": hours(R.FLAG_DOWN_MS),
  "Inactivity → dormant": days(R.DORMANT_AFTER_MS),
  "Dormant → disbanded": days(R.DISBAND_AFTER_DORMANT_MS),
  "Points: raid on #1 / bottom / unranked": `${R.POINTS_TOP} / ${R.POINTS_BOTTOM} / ${R.POINTS_UNRANKED}`,
  "Alpha week": "Mon 00:00 → Mon 00:00 UTC",
  "Alphas per week": `${R.ALPHAS_PER_WEEK}`,
  "Season": "wipe to wipe",
  "After a wipe: raise your flag to bind a new base within": days(R.POST_WIPE_BIND_MS),
  "Player board: minimum kills for K/D": `${R.KD_MIN_KILLS}`,
  "Clan size cap": `${R.CLAN_SIZE_CAP}`,
  "Join: presence radius at base": `${R.JOIN_PRESENCE_RADIUS_M} m`,
  "Invite / request / pending no-show expiry": days(R.PENDING_EXPIRY_MS),
  "Leave / kick cooldown": days(R.ROSTER_COOLDOWN_MS),
  "Leader silent before a succession claim": days(R.LEADER_SILENT_MS),
  "Succession: objection window": hours(R.SUCCESSION_WINDOW_MS),
  "No-confidence vote: length": hours(R.VOTE_LENGTH_MS),
  "No-confidence vote: threshold": "⅔ of all full members",
  "Failed vote cooldown": days(R.FAILED_VOTE_COOLDOWN_MS),
  "Rename cooldown": days(R.RENAME_COOLDOWN_MS),
  "Old name / tag held after rename or disband": "until season end",
  "Rebind: confirm window": hours(R.REBIND_CONFIRM_MS),
  "Rebind: cooldown between moves": days(R.REBIND_COOLDOWN_MS),
  "Vault code length": `${R.VAULT_CODE_DIGITS} digits`,
  "Guest pass": `${hours(R.GUEST_PASS_MS)}, voice only`,
  "Position fix cadence": `${mins(R.POSITION_FIX_MS)} (set by the server)`,
  "Intruder: alert cooldown per player": mins(R.INTRUDER_ALERT_COOLDOWN_MS),
  "Intruder: pin drops off after": mins(R.INTRUDER_PIN_TTL_MS),
  "Pin lifetime": days(R.PIN_TTL_MS),
  "Fast travel points (outhouses, wells, bus stops)": `${R.TRAVEL_POINTS}`,
  "Hub destinations": `${R.HUB_DESTINATIONS} towns`,
  "Combat log rule": `${mins(R.COMBAT_LOG_MS)} after contact`,
  "Watchtower height": `${R.WATCHTOWER_MAX_HEIGHT.grounded} (${R.WATCHTOWER_MAX_HEIGHT.onStructure} on a structure)`,
};

describe("rules.ts matches the guide's numbers table", () => {
  it("covers every row in the vendored table", () => {
    const labels = json.rows.map((r) => r.label);
    expect(Object.keys(EXPECTED).sort()).toEqual([...labels].sort());
  });

  for (const row of json.rows) {
    it(`"${row.label}" is ${row.value}`, () => {
      expect(EXPECTED[row.label]).toBe(row.value);
    });
  }

  it("⚠️ the vote threshold text is the fraction rules.ts states", () => {
    expect(`${R.VOTE_THRESHOLD.num}/${R.VOTE_THRESHOLD.den}`).toBe("2/3");
  });
});
```

- [ ] **Step 4: Run it**

Run: `pnpm --filter @factions/domain exec vitest run test/guide-numbers-drift.test.ts`
Expected: PASS, 51 tests. If a row fails, the guide and `rules.ts` disagree: **the guide wins** — fix `rules.ts`, not the JSON, unless the guide itself is wrong, in which case fix the guide first and regenerate.

- [ ] **Step 5: Commit**

```bash
git add scripts/guide-numbers.ts docs/guide-numbers.json packages/domain/test/guide-numbers-drift.test.ts package.json pnpm-lock.yaml
git commit -m "test(domain): hold rules.ts against the guide's numbers table"
```

---

### Task 3: Route the existing constants through `rules.ts`

**Files:**
- Modify: `apps/bot/src/dormancy.ts` (the two `DEFAULT_*` exports)
- Modify: `apps/bot/src/rebind.ts:2,21` (`REBIND_COOLDOWN_MS`, `RELEASE_GRACE_MS`)
- Modify: `apps/bot/src/ceremony-tick.ts:17` (`PROVISIONAL_TTL_MS`)
- Modify: `apps/bot/src/config.ts:156-163` (challenge TTL, reservation TTL, invite TTL, cooldown, rename cooldown defaults)
- Test: existing suites; `apps/bot/test/rebind.test.ts:85` changes its literal expectation to the rule.

**Interfaces:**
- Consumes: `rules.ts`.
- Produces: unchanged export names, so nothing else moves.

- [ ] **Step 1: Replace the literals**

`apps/bot/src/dormancy.ts` — find the two exports and replace their bodies:

```ts
import { DORMANT_AFTER_MS, DISBAND_AFTER_DORMANT_MS } from "@factions/domain";

/** Re-exported under the names the bot has used since dormancy shipped; the value lives in rules.ts. */
export const DEFAULT_DORMANT_AFTER_MS = DORMANT_AFTER_MS;
export const DEFAULT_DISBAND_AFTER_DORMANT_MS = DISBAND_AFTER_DORMANT_MS;
```

`apps/bot/src/rebind.ts` — keep the docblocks, replace the two values:

```ts
import { REBIND_COOLDOWN_MS as RULE_REBIND_COOLDOWN_MS, RELEASED_POLE_GRACE_MS } from "@factions/domain";

export const REBIND_COOLDOWN_MS = RULE_REBIND_COOLDOWN_MS;
// … existing docblock …
export const RELEASE_GRACE_MS = RELEASED_POLE_GRACE_MS;
```

`apps/bot/src/ceremony-tick.ts:17`:

```ts
import { CLAIM_WINDOW_MS } from "@factions/domain";
export const PROVISIONAL_TTL_MS = CLAIM_WINDOW_MS;
```

`apps/bot/src/config.ts` — change only the default arguments:

```ts
import { LINK_TTL_MS, ACTIVATION_WINDOW_MS, PENDING_EXPIRY_MS, ROSTER_COOLDOWN_MS, RENAME_COOLDOWN_MS } from "@factions/domain";
// …
challengeTtlMs: positiveInt(env, "BOT_CHALLENGE_TTL_MS", LINK_TTL_MS),
reservationTtlMs: positiveInt(env, "BOT_RESERVATION_TTL_MS", ACTIVATION_WINDOW_MS),
inviteTtlMs: positiveInt(env, "BOT_INVITE_TTL_MS", PENDING_EXPIRY_MS),
cooldownMs: positiveInt(env, "BOT_COOLDOWN_MS", ROSTER_COOLDOWN_MS),
renameCooldownMs: positiveInt(env, "BOT_RENAME_COOLDOWN_MS", RENAME_COOLDOWN_MS),
```

⚠️ Two defaults change value here on purpose: the challenge TTL drops from 24 h to the guide's 10 min, and the rename cooldown rises from 7 to 30 days. Both are the guide's numbers. Say so in the commit message.

- [ ] **Step 2: Update the one test that pins a literal**

`apps/bot/test/rebind.test.ts:85` — replace `expect(RELEASE_GRACE_MS).toBe(259_200_000); //  3 days` with:

```ts
expect(RELEASE_GRACE_MS).toBe(RELEASED_POLE_GRACE_MS);
```

and import `RELEASED_POLE_GRACE_MS` from `@factions/domain`. Search the bot tests for `86_400_000` used as a challenge TTL expectation (`grep -n "86_400_000" apps/bot/test/config.test.ts`) and change any default-value assertion to `LINK_TTL_MS`; a test that passes the value explicitly stays.

- [ ] **Step 3: Run the bot suite**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/bot test`
Expected: PASS. If `config.test.ts` fails on a default, it is asserting the old literal — change it to the rule.

- [ ] **Step 4: Commit**

```bash
git add apps/bot/src/dormancy.ts apps/bot/src/rebind.ts apps/bot/src/ceremony-tick.ts apps/bot/src/config.ts apps/bot/test
git commit -m "refactor(bot): read every timer from rules.ts

Two defaults change to the guide's values: the link challenge TTL is
10 min (was 24 h) and the rename cooldown is 30 days (was 7)."
```

---

### Task 4: Vocabulary sweep of public posts and DMs

**Files:**
- Modify: `apps/bot/src/feed-embed.ts`
- Modify: `apps/bot/src/ceremony-notify.ts`
- Modify: `apps/bot/src/dormancy-notify.ts`
- Modify: `apps/bot/src/notify.ts`
- Test: `apps/bot/test/vocabulary.test.ts` (new); existing `feed-embed.test.ts`, `ceremony-notify.test.ts`, `dormancy-notify.test.ts` where they assert on text.

Slash-command replies (`commands.ts`, `roster-commands.ts`, `faction-commands.ts`, `rebind-commands.ts`) are **not** swept: increment 2 retires them.

- [ ] **Step 1: Write the failing test**

```ts
// apps/bot/test/vocabulary.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(resolve(here, "..", "src", f), "utf8");

/**
 * The guide says "clan"; code says "faction". These four modules are the
 * ones whose strings reach players (public embeds and DMs), so every string
 * literal in them must say clan. Identifiers may still say faction — the
 * check strips comments and looks inside quotes only.
 */
const PLAYER_FACING = ["feed-embed.ts", "ceremony-notify.ts", "dormancy-notify.ts", "notify.ts"];

const STRING_LITERALS = /(["'`])(?:\\.|(?!\1)[^\\])*\1/gsu;
const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu;

describe("player-facing strings say clan, not faction", () => {
  for (const file of PLAYER_FACING) {
    it(file, () => {
      const code = src(file).replace(COMMENTS, "");
      const offenders = [...code.matchAll(STRING_LITERALS)]
        .map((m) => m[0])
        .filter((s) => /faction/iu.test(s));
      expect(offenders).toEqual([]);
    });
  }
});
```

- [ ] **Step 2: Run it to see the offenders**

Run: `pnpm --filter @factions/bot exec vitest run test/vocabulary.test.ts`
Expected: FAIL, with the list of offending string literals per file.

- [ ] **Step 3: Rewrite each offender**

For every literal listed, replace the word: `faction` → `clan`, `Faction` → `Clan`, `factions` → `clans`, `#🎌-faction-feed` → `#clan-feed`. A template literal that interpolates an identifier (`${faction.name}`) is not an offender — the regex matches the identifier inside the literal, so if the test flags a template literal for its `${faction.name}` alone, rename the local variable to `clan` in that function rather than weakening the test.

- [ ] **Step 4: Run the four suites that assert on text**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/bot exec vitest run test/vocabulary.test.ts test/feed-embed.test.ts test/ceremony-notify.test.ts test/dormancy-notify.test.ts`
Expected: `vocabulary.test.ts` PASS. The other three may fail on exact-text assertions that still say "faction" — update those expectations to the new text. Do not change behaviour to satisfy a test.

- [ ] **Step 5: Full gate, then commit**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`
Expected: all tasks pass; check the count, not just the exit code.

```bash
git add apps/bot/src/feed-embed.ts apps/bot/src/ceremony-notify.ts apps/bot/src/dormancy-notify.ts apps/bot/src/notify.ts apps/bot/test
git commit -m "feat(bot): public posts and DMs say clan"
```

---

### Task 5: CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` — the "Two statements of one fact" paragraph under Conventions, and the "Where things live" table.

- [ ] **Step 1: Add the rule**

Under **Conventions that matter here**, after the "Two statements of one fact" paragraph, add:

```markdown
**Every guide number lives in `packages/domain/src/rules.ts`.** `docs/guide-numbers.json`
is a vendored copy of the guide's numbers table (`pnpm guide:numbers` regenerates it) and
`packages/domain/test/guide-numbers-drift.test.ts` holds the two together. A new number
goes in `rules.ts` and in the guide, never as a literal in the module that uses it.
```

In **Where things live**, add a row:

```markdown
| The guide's numbers, vendored | `docs/guide-numbers.json` — regenerate with `pnpm guide:numbers` |
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: rules.ts and the vendored guide numbers"
```

---

## Self-review

- **Spec coverage:** §1 vocabulary (Task 4, scoped to what survives increment 2), §1 numbers module (Task 1), §13 guide-numbers drift test (Task 2), §15 increment 0 (all). The two invariants the spec states about numbers — grace shorter than cooldown, watch zone half the spacing — are pinned in Task 1.
- **Placeholders:** none. Task 3's `grep` step names the file and the literal.
- **Type consistency:** `RELEASED_POLE_GRACE_MS`, `REBIND_COOLDOWN_MS`, `CLAIM_WINDOW_MS`, `LINK_TTL_MS`, `ACTIVATION_WINDOW_MS`, `PENDING_EXPIRY_MS`, `ROSTER_COOLDOWN_MS`, `RENAME_COOLDOWN_MS` are defined in Task 1 with exactly the names Tasks 2 and 3 import.
