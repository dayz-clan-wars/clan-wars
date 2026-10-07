# King of the Hill on Chernarus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run King of the Hill on the Chernarus server: hill spawns from the existing per-town `<fresh>` spawn groups, Livonia's KotH loadouts, faster cleanup including `CleanupAvoidance` 5, and no predators or infected.

**Architecture:** At an opening the bot narrows `koth/default/cfgplayerspawnpoints.xml` to the chosen town's `<fresh>` group and uploads that, instead of copying four per-town files. Everything the bot did with `env/*_territories.xml` and the infected events in `events.xml` is deleted. The Chernarus mission repo stages the defaults at deploy and carries the `koth-*.json` presets.

**Tech Stack:** TypeScript, vitest, drizzle-orm (Postgres on 5434 for tests), pnpm and turbo; GitHub Actions for the mission repo.

**Spec:** `docs/superpowers/specs/2026-10-07-koth-chernarus-design.md`

## Global Constraints

- The clan-wars gate: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`, which must report **32/32** tasks. Never run two of these at once.
- No database migration. `koth_events.infected_snapshot` and `restored_at` stay in the schema, unused.
- `KOTH_GLOBALS = { CleanupLifetimeDeadPlayer: 30, CleanupLifetimeDeadInfected: 10, CleanupAvoidance: 5 }`.
- `KOTH_ZONE_RADIUS_M` stays 500. The start methods, the 24 h gap, `KOTH_NO_REPEAT`, scoring and prizes are unchanged.
- Never commit to `main` in either repo (protected). Branch, open a PR and merge with `--merge`. Every clan-wars PR adds a `## [Unreleased]` entry to `CHANGELOG.md`, and so does every chernarus PR.
- The local `../chernarus` checkout is someone else's working copy. **Never check out, stash or commit in it.** Work on chernarus in a worktree: `git -C ../chernarus worktree add <scratch>/chernarus-koth -b feature/koth-defaults origin/main`.
- House comment style: comments say WHY, and `⚠️` marks a line whose failure would be silent.

## Review Focus

1. **A `<group>` name in some other section of the spawn file** (`<hop>` and `<travel>` reuse names like `Balota`): narrowing must touch `<fresh>` only. Pinned in Task 3 (fixture has a `<hop>` `Balota`).
2. **A commented-out `<group>` inside `<fresh>`** (`<!-- <group name="X"> … -->`): it must not be taken for the real group or counted as a duplicate. Pinned in Task 3.
3. **A session scheduled before the deploy with a Livonia slug** (an automatic or voted row with `location = "adamow"` reaching its slot): the opening must refuse with a reason, not throw out of `planKoth`. Pinned in Task 4.
4. **Past sessions' names** in `/koth status`, the war log and ops alerts: they must still print "Adamów", not `adamow`. Pinned in Task 2.
5. **The in-game restart message for a two-word town**: it must say "King of the Hill at Novaya Petrovka", not "Novaya-petrovka". Pinned in Task 4.

---

## File Structure

| File | Responsibility |
|---|---|
| `chernarus/.github/workflows/deploy.yml` | stage `koth/default/` and refuse a koth preset in the default `cfggameplay.json` |
| `chernarus/custom/koth-*.json` (44) | KotH loadouts, copied from `livonia/custom/` |
| `packages/domain/assets/koth-locations.json` | the 31 Chernarus towns: `{ name, slug, spawnGroup, centreX, centreZ }` |
| `packages/domain/assets/koth-locations-retired.json` | the 31 Livonia towns (moved, unchanged), used for names only |
| `packages/domain/src/koth.ts` | `KothLocation` type, `kothLocation` (playable only), new `kothTownName` (both lists) |
| `packages/domain/src/rules.ts` | `KOTH_GLOBALS` gains `CleanupAvoidance`; `KOTH_INFECTED_EVENTS` and `KOTH_WHOLE_FILES` go |
| `apps/bot/src/spawn-points.ts` (new) | `narrowFreshSpawns(xml, group)`: pure, a targeted splice |
| `apps/bot/src/koth-converge.ts` | opening and restore, now spawn file plus globals plus presets |
| `apps/bot/src/restart-tick.ts` | the infected path out of `applyEvents` and the KotH block; the restart message uses the display name |
| name call sites | `koth-decide-tick.ts`, `koth-vote-tick.ts`, `koth-score.ts`, `koth-tick.ts`, `commands/koth.ts`, `commands/kothvote.ts` |

---

### Task 1: Chernarus mission: stage the KotH defaults and carry the presets

**Files (in the chernarus worktree):**
- Modify: `.github/workflows/deploy.yml` (insert two steps before `- name: Deploy changed files via FTP`)
- Create: `custom/koth-*.json` (44 files copied from `../livonia/custom/`)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces, on the server after a release: `koth/default/cfgplayerspawnpoints.xml`, `koth/default/globals.xml` and `custom/koth-*.json`. Task 4's opening check requires all three.

- [ ] **Step 1: Create the worktree**

```bash
W=/private/tmp/claude-501/-Users-steveharmeyer-Development-dayz-clan-wars/d42a6fe4-e41c-4291-b66a-9a7200898c6a/scratchpad/chernarus-koth
git -C /Users/steveharmeyer/Development/dayz-clan-wars/chernarus fetch -q origin
git -C /Users/steveharmeyer/Development/dayz-clan-wars/chernarus worktree add -q -b feature/koth-defaults "$W" origin/main
```

- [ ] **Step 2: Insert the staging steps** in `$W/.github/workflows/deploy.yml`, directly above `      - name: Deploy changed files via FTP`:

```yaml
      # ⚠️ King of the Hill (clan-wars spec 2026-10-07-koth-chernarus): the bot
      # builds each session's spawn file from koth/default/cfgplayerspawnpoints.xml
      # and restores it from there afterwards, and reads the normal
      # CleanupLifetimeDead{Player,Infected} and CleanupAvoidance values back out
      # of koth/default/globals.xml. They are COPIED here, never committed, so a
      # stale mirror can never undo an edit to the real file. Without this step
      # the bot refuses to open a KotH session at all.
      - name: Stage the KotH defaults
        run: |
          mkdir -p koth/default
          cp cfgplayerspawnpoints.xml koth/default/
          cp db/globals.xml koth/default/

      # ⚠️ The repo's cfggameplay.json must always carry the DEFAULT loadout:
      # the bot swaps in the koth- presets for one session only.
      - name: Refuse a KotH preset in the default cfggameplay.json
        run: |
          if grep -q '"./custom/koth-' cfggameplay.json; then
            echo "cfggameplay.json names a koth- preset; the repo must hold the default loadout" >&2
            exit 1
          fi

```

- [ ] **Step 3: Copy the presets and check the count**

```bash
cp /Users/steveharmeyer/Development/dayz-clan-wars/livonia/custom/koth-*.json "$W/custom/"
ls "$W"/custom/koth-*.json | wc -l      # Expected: 44
grep -q '"./custom/koth-' "$W/cfggameplay.json" && echo BAD || echo ok   # Expected: ok
```

- [ ] **Step 4: Changelog** in `$W/CHANGELOG.md`, directly under `## [Unreleased]`:

```markdown

### Added

- King of the Hill comes to Chernarus: the KotH loadouts are on the server, ready for the bot to hand out during a session.
```

- [ ] **Step 5: Commit, push, open the PR**

```bash
cd "$W" && git add -A && git commit -q -m "Stage the KotH defaults and carry the KotH loadouts

clan-wars spec 2026-10-07-koth-chernarus: the bot narrows
koth/default/cfgplayerspawnpoints.xml to one town's <fresh> group per
session and restores cfgplayerspawnpoints.xml and db/globals.xml from
koth/default/. Presets copied unchanged from livonia/custom.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -q -u origin feature/koth-defaults
gh pr create -R dayz-clan-wars/chernarus --base main --title "Stage the KotH defaults and carry the KotH loadouts" --body "Implements §4 of clan-wars spec 2026-10-07-koth-chernarus. Ship before the clan-wars KotH release.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 2: Domain: Chernarus towns, retired Livonia names, `kothTownName`

**Files:**
- Move: `packages/domain/assets/koth-locations.json` → `packages/domain/assets/koth-locations-retired.json`
- Create: `packages/domain/assets/koth-locations.json`
- Modify: `packages/domain/src/koth.ts:1-19`
- Modify: `packages/domain/test/koth.test.ts` (`describe("catalogue")`)
- Rewrite: `packages/domain/test/koth-drift.test.ts`
- Modify (display names): `apps/bot/src/koth-decide-tick.ts:103`, `apps/bot/src/koth-vote-tick.ts:21`, `apps/bot/src/koth-score.ts:118`, `apps/bot/src/koth-tick.ts:9`, `apps/bot/src/commands/koth.ts:121,130`, `apps/bot/src/commands/kothvote.ts:24`
- Modify (fixtures that schedule): `apps/bot/test/koth-command.test.ts`

**Interfaces:**
- Produces: `type KothLocation = { name: string; slug: string; spawnGroup: string; centreX: number; centreZ: number }`; `KOTH_LOCATIONS: readonly KothLocation[]` (Chernarus, 31); `kothLocation(slug): KothLocation | null` (Chernarus only); `kothTownName(slug: string): string` (Chernarus, then retired Livonia, else the slug).

- [ ] **Step 1: Write the failing tests.** Replace the first `it` in `describe("catalogue")` of `packages/domain/test/koth.test.ts` with:

```ts
  it("has the 31 Chernarus towns and 44 presets, all flat in ./custom/ with the prefix", () => {
    expect(KOTH_LOCATIONS).toHaveLength(31);
    expect(kothLocation("novaya-petrovka")).toMatchObject({ name: "Novaya Petrovka", spawnGroup: "NovayaPetrovka" });
    expect(kothLocation("narnia")).toBeNull();
    expect(KOTH_PRESET_FILES).toHaveLength(44);
    for (const p of KOTH_PRESET_FILES) expect(p).toMatch(/^\.\/custom\/koth-[a-z0-9-]+\.json$/);
  });
  // ⚠️ Review focus 4: past sessions are Livonia rows, and their names must survive the move.
  it("names a retired Livonia town but never offers one", () => {
    expect(kothTownName("lembork")).toBe("Lembork");
    expect(kothTownName("adamow")).toBe("Adamów");
    expect(kothLocation("lembork")).toBeNull();
    expect(kothTownName("novy-sobor")).toBe("Novy Sobor");
    expect(kothTownName("narnia")).toBe("narnia");
  });
  it("keeps slugs unique and every centre on the map", () => {
    expect(new Set(KOTH_LOCATIONS.map((l) => l.slug)).size).toBe(31);
    for (const l of KOTH_LOCATIONS) {
      expect(l.slug).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(l.centreX).toBeGreaterThan(0); expect(l.centreX).toBeLessThan(WORLD_SIZE_M);
      expect(l.centreZ).toBeGreaterThan(0); expect(l.centreZ).toBeLessThan(WORLD_SIZE_M);
    }
  });
```

Add `kothTownName` and `WORLD_SIZE_M` to that file's import from `"../src/index.js"`.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd packages/domain && npx vitest run test/koth.test.ts`
Expected: FAIL (`kothTownName` is not exported, and `novaya-petrovka` is unknown).

- [ ] **Step 3: Move the Livonia list and generate the Chernarus one**

```bash
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars
git mv packages/domain/assets/koth-locations.json packages/domain/assets/koth-locations-retired.json
git -C ../chernarus show origin/main:cfgplayerspawnpoints.xml | node -e '
const xml = require("fs").readFileSync(0, "utf8");
const fresh = xml.split("<fresh>")[1].split("</fresh>")[0];
const out = [...fresh.matchAll(/<group name="([^"]+)">([\s\S]*?)<\/group>/g)].map(([, group, body]) => {
  const pos = [...body.matchAll(/<pos x="([\d.]+)" z="([\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const name = group.replace(/(?<=[a-z])(?=[A-Z])/g, " ");
  return { name, slug: name.toLowerCase().replace(/ /g, "-"), spawnGroup: group,
    centreX: Math.round(pos.reduce((s, p) => s + p[0], 0) / pos.length),
    centreZ: Math.round(pos.reduce((s, p) => s + p[1], 0) / pos.length) };
});
if (out.length !== 31) throw new Error(`expected 31 groups, got ${out.length}`);
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
' > packages/domain/assets/koth-locations.json
node -e 'const l=require("./packages/domain/assets/koth-locations.json");console.log(l.length,l[0],l.find(x=>x.slug==="novaya-petrovka"))'
```

Expected: `31`, Balota's entry, and `{ name: 'Novaya Petrovka', slug: 'novaya-petrovka', spawnGroup: 'NovayaPetrovka', … }`.

- [ ] **Step 4: Replace lines 1-19 of `packages/domain/src/koth.ts`** (the two asset imports through `kothLocation`) with:

```ts
import locations from "../assets/koth-locations.json";
import retired from "../assets/koth-locations-retired.json";
import presets from "../assets/koth-presets.json";
import {
  KOTH_MIN_GAP_MS, KOTH_NO_REPEAT, KOTH_PRESET_PREFIX, KOTH_REMINDER_LEAD_MS, KOTH_VOTE_MIN_OPEN_MS,
  KOTH_VOTE_PASS_DEN, KOTH_VOTE_PASS_NUM, KOTH_VOTE_TURNOUT_MIN, KOTH_ZONE_RADIUS_M, RESTART_PERIOD_MS,
} from "./rules";
import { nextRestartAt } from "./restarts";
import { distance2d } from "./spacing";

/** `spawnGroup` is the town's `<fresh>` group in the chernarus repo's cfgplayerspawnpoints.xml. */
export type KothLocation = { name: string; slug: string; spawnGroup: string; centreX: number; centreZ: number };

/**
 * The 31 Chernarus towns, generated from the chernarus repo's spawn groups;
 * koth-drift.test.ts holds them together. The only towns a session may open at.
 */
export const KOTH_LOCATIONS: readonly KothLocation[] = locations as KothLocation[];
/**
 * Livonia's 31, retired 2026-10-07. Names only: past sessions store these slugs
 * and must keep printing a town, never be offered again. Their scoring centres
 * are frozen in koth_events.centre_x/z, so nothing else needs them.
 */
const RETIRED_LOCATIONS: readonly { name: string; slug: string }[] = retired;
/** Vendored from livonia/custom/koth-*.json, carried by chernarus/custom since 2026-10-07. */
export const KOTH_PRESET_FILES: readonly string[] = presets as string[];

/** ⚠️ Playable towns only: a retired slug is null, so nothing can schedule or open one. */
export function kothLocation(slug: string): KothLocation | null {
  return KOTH_LOCATIONS.find((l) => l.slug === slug) ?? null;
}

/** A town's display name for any session, past or present; the slug itself if unknown. */
export function kothTownName(slug: string): string {
  return (KOTH_LOCATIONS.find((l) => l.slug === slug) ?? RETIRED_LOCATIONS.find((l) => l.slug === slug))?.name ?? slug;
}
```

- [ ] **Step 5: Swap the display-name call sites to `kothTownName`** (add it to each file's `@factions/domain` import, and drop `kothLocation` where it is then unused):

```ts
// apps/bot/src/koth-decide-tick.ts:103
    await post(scheduledText(kothTownName(slug), slot, null));
// apps/bot/src/koth-vote-tick.ts:21
const town = (v: Vote) => kothTownName(v.location);
// apps/bot/src/koth-score.ts:118
    const town = kothTownName(row.location);
// apps/bot/src/koth-tick.ts:9
const town = (r: Row) => kothTownName(r.location);
// apps/bot/src/commands/koth.ts:121
  return reply(`Cancelled ${kothTownName(row.location)}. The channel will be told.`);
// apps/bot/src/commands/koth.ts:130
  const head = `${kothTownName(row.location)}: ${row.state}, slot ${row.slotAt.toISOString()}, prize: ${prizeName(row.awardKey)}.`;
// apps/bot/src/commands/kothvote.ts:24
  ({ town: kothTownName(v.location), slotAt: v.slotAt, closesAt: v.closesAt, floor: v.turnoutFloor, starter });
```

`koth-vote-tick.ts:85` (`kothLocation(v.location)!`) and `commands/koth.ts:54` stay on `kothLocation`: they create sessions, so they must see playable towns only. Change line 85's non-null assertion to a refusal in the same shape as the refusals above it:

```ts
    const loc = kothLocation(v.location);
    // ⚠️ A vote opened before the move to Chernarus names a Livonia town; it can no longer open.
    if (!loc) { await done("void", { reason: "that town is not on this map any more" }); return; }
```

- [ ] **Step 6: Point the schedule fixtures at a Chernarus town.** In `apps/bot/test/koth-command.test.ts`, change the `location` default `"lembork"` → `"berezino"` (line 34), the expected `location: "lembork"` → `"berezino"` (line 45), `/Lembork/` → `/Berezino/` (lines 43, 175, 242, 243), and the autocomplete test (line 266-267) to `value: "be"` and `toContain("berezino")`. Rows inserted directly with `location: "lembork"` (lines 182, 209) stay: they are past sessions, and Step 1 pins their names.

- [ ] **Step 7: Rewrite `packages/domain/test/koth-drift.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { KOTH_LOCATIONS, KOTH_PRESET_FILES } from "../src/index.js";

// ⚠️ Two statements of one fact (CLAUDE.md): the chernarus repo holds the spawn
// groups and the presets; this package vendors them. Skipped where the sibling
// checkout is absent (CI), enforced wherever it is present. It reads that
// checkout's WORKING TREE: if it fails on presets you have not pulled yet,
// `git -C ../chernarus pull` (never commit there; it is someone's working copy).
const CHERNARUS = join(__dirname, "../../../../chernarus");
const present = existsSync(join(CHERNARUS, "cfgplayerspawnpoints.xml"));

function freshGroups(): Map<string, [number, number][]> {
  const xml = readFileSync(join(CHERNARUS, "cfgplayerspawnpoints.xml"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const fresh = xml.split("<fresh>")[1]!.split("</fresh>")[0]!;
  return new Map([...fresh.matchAll(/<group name="([^"]+)">([\s\S]*?)<\/group>/g)].map(([, name, body]) =>
    [name!, [...body!.matchAll(/<pos x="([\d.]+)" z="([\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])] as [number, number])]));
}

describe.skipIf(!present)("KotH catalogue vs the chernarus repo", () => {
  it("the 31 towns are exactly the <fresh> spawn groups", () => {
    expect(KOTH_LOCATIONS.map((l) => l.spawnGroup).sort()).toEqual([...freshGroups().keys()].sort());
  });
  it("each centre is the mean of its group's spawn spots", () => {
    const groups = freshGroups();
    for (const l of KOTH_LOCATIONS) {
      const pos = groups.get(l.spawnGroup)!;
      expect([l.centreX, l.centreZ]).toEqual([
        Math.round(pos.reduce((s, p) => s + p[0], 0) / pos.length),
        Math.round(pos.reduce((s, p) => s + p[1], 0) / pos.length),
      ]);
    }
  });
  it("presets match custom/koth-*.json", () => {
    const names = readdirSync(join(CHERNARUS, "custom")).filter((f) => f.startsWith("koth-") && f.endsWith(".json")).sort();
    expect([...KOTH_PRESET_FILES].sort()).toEqual(names.map((n) => `./custom/${n}`));
  });
});
```

- [ ] **Step 8: Run the domain and bot suites**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --filter=@factions/domain --filter=@factions/bot --concurrency=1 --force`
Expected: PASS. The drift test's presets check passes only once the `../chernarus` working tree has Task 1's files. If it hasn't pulled them yet, that one check fails; confirm the other two pass and note it in the PR.

- [ ] **Step 9: Commit**

```bash
git add -A packages/domain apps/bot
git commit -q -m "KotH towns are Chernarus's 31; Livonia's kept for names

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `narrowFreshSpawns`, a pure splice of the spawn file

**Files:**
- Create: `apps/bot/src/spawn-points.ts`
- Test: `apps/bot/test/spawn-points.test.ts`

**Interfaces:**
- Consumes: `maskComments(xml: string): string` from `apps/bot/src/events-xml.ts`
- Produces: `narrowFreshSpawns(xml: string, group: string): string`. It throws `Error` with a message that starts with `cfgplayerspawnpoints.xml:` when there is no `<fresh>`, no `<generator_posbubbles>` inside it, no such group, a duplicated group, or a group with no `<pos>`.

- [ ] **Step 1: Write the failing test** `apps/bot/test/spawn-points.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { narrowFreshSpawns } from "../src/spawn-points.js";

const SPAWNS = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<playerspawnpoints>
    <fresh>
        <spawn_params>
            <min_dist_player>65</min_dist_player>
        </spawn_params>
        <generator_posbubbles>
            <group name="Balota">
                <pos x="4491.000000" z="2312.000000" />
            </group>
            <!-- <group name="Berezino"><pos x="1.000000" z="1.000000" /></group> -->
            <group name="Berezino">
                <pos x="12928.000000" z="9906.000000" />
                <pos x="12900.000000" z="9900.000000" />
            </group>
            <group name="Chernogorsk">
                <pos x="6542.000000" z="2354.000000" />
            </group>
        </generator_posbubbles>
    </fresh>
    <hop>
        <generator_posbubbles>
            <group name="Balota">
                <pos x="1.000000" z="1.000000" />
            </group>
        </generator_posbubbles>
    </hop>
</playerspawnpoints>
`;

describe("narrowFreshSpawns", () => {
  it("keeps only the chosen <fresh> group; every other byte is untouched", () => {
    expect(narrowFreshSpawns(SPAWNS, "Berezino")).toBe(`<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<playerspawnpoints>
    <fresh>
        <spawn_params>
            <min_dist_player>65</min_dist_player>
        </spawn_params>
        <generator_posbubbles>
            <!-- <group name="Berezino"><pos x="1.000000" z="1.000000" /></group> -->
            <group name="Berezino">
                <pos x="12928.000000" z="9906.000000" />
                <pos x="12900.000000" z="9900.000000" />
            </group>
        </generator_posbubbles>
    </fresh>
    <hop>
        <generator_posbubbles>
            <group name="Balota">
                <pos x="1.000000" z="1.000000" />
            </group>
        </generator_posbubbles>
    </hop>
</playerspawnpoints>
`);
  });
  // ⚠️ Review focus 1: <hop> reuses town names; only <fresh> is narrowed.
  it("leaves a same-named group outside <fresh> alone", () => {
    expect(narrowFreshSpawns(SPAWNS, "Chernogorsk")).toContain(`<hop>
        <generator_posbubbles>
            <group name="Balota">`);
  });
  // ⚠️ Review focus 2: a commented-out copy is neither the group nor a duplicate of it.
  it("ignores a commented-out group", () => {
    expect(() => narrowFreshSpawns(SPAWNS, "Berezino")).not.toThrow();
    const onlyComment = SPAWNS.replace(/            <group name="Berezino">[\s\S]*?<\/group>\n/, "");
    expect(() => narrowFreshSpawns(onlyComment, "Berezino")).toThrow(/no group "Berezino"/);
  });
  it("refuses an unknown group, a duplicate, an empty group, and a file with no <fresh>", () => {
    expect(() => narrowFreshSpawns(SPAWNS, "Narnia")).toThrow(/^cfgplayerspawnpoints\.xml: .*no group "Narnia"/);
    const twice = SPAWNS.replace(`<group name="Chernogorsk">`, `<group name="Balota">`);
    expect(() => narrowFreshSpawns(twice, "Balota")).toThrow(/more than once/);
    const empty = SPAWNS.replace(`                <pos x="6542.000000" z="2354.000000" />\n`, "");
    expect(() => narrowFreshSpawns(empty, "Chernogorsk")).toThrow(/no <pos>/);
    expect(() => narrowFreshSpawns("<playerspawnpoints></playerspawnpoints>", "Balota")).toThrow(/no <fresh>/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/spawn-points.test.ts`
Expected: FAIL, because `../src/spawn-points.js` cannot be resolved.

- [ ] **Step 3: Implement** `apps/bot/src/spawn-points.ts`:

```ts
import { maskComments } from "./events-xml.js";

/**
 * cfgplayerspawnpoints.xml with every `<group>` inside `<fresh>`'s
 * `<generator_posbubbles>` removed except `group`: a King of the Hill session
 * spawns every fresh character at that one town's spots (spec
 * 2026-10-07-koth-chernarus §3.1).
 *
 * ⚠️ A targeted splice, never a parse-and-reserialize: the file belongs to the
 * chernarus repo, and everything but the removed group lines comes back
 * byte-identical, `<hop>`/`<travel>` groups of the same name included.
 * Located in the comment-masked text, so a commented-out group is neither taken
 * for the real one nor counted as a duplicate.
 *
 * ⚠️ Throws rather than returning the input: an un-narrowed file would open a
 * "King of the Hill" with players spawning all over the map, and report success.
 */
export function narrowFreshSpawns(xml: string, group: string): string {
  const masked = maskComments(xml);
  const fresh = /<fresh>[\s\S]*?<\/fresh>/.exec(masked);
  if (!fresh) throw new Error("cfgplayerspawnpoints.xml: no <fresh> section");
  const bubbles = /<generator_posbubbles>([\s\S]*?)<\/generator_posbubbles>/.exec(fresh[0]);
  if (!bubbles) throw new Error("cfgplayerspawnpoints.xml: <fresh> has no <generator_posbubbles>");
  const innerFrom = fresh.index + bubbles.index + "<generator_posbubbles>".length;
  const inner = masked.slice(innerFrom, innerFrom + bubbles[1]!.length);
  // Whole lines: leading indent, the block, trailing spaces and one newline.
  const groups = [...inner.matchAll(/[ \t]*<group\s+name="([^"]*)"[^>]*>[\s\S]*?<\/group>[ \t]*\r?\n?/g)];
  const keep = groups.filter((g) => g[1] === group);
  if (keep.length === 0) throw new Error(`cfgplayerspawnpoints.xml: <fresh> has no group "${group}"`);
  if (keep.length > 1) throw new Error(`cfgplayerspawnpoints.xml: <fresh> group "${group}" appears more than once — refusing to guess`);
  if (!/<pos\s/.test(keep[0]![0])) throw new Error(`cfgplayerspawnpoints.xml: <fresh> group "${group}" has no <pos>`);
  let out = "";
  let cursor = 0;
  for (const g of groups) {
    if (g[1] === group) continue;
    const from = innerFrom + g.index!;
    out += xml.slice(cursor, from);
    cursor = from + g[0].length;
  }
  return out + xml.slice(cursor);
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/spawn-points.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/spawn-points.ts apps/bot/test/spawn-points.test.ts
git commit -q -m "narrowFreshSpawns: one town's <fresh> group, every other byte kept

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Sessions narrow the spawn file; predators and infected removed

**Files:**
- Modify: `packages/domain/src/rules.ts` (the `KOTH_INFECTED_EVENTS`, `KOTH_WHOLE_FILES` and `KOTH_GLOBALS` block, about lines 427-452)
- Modify: `apps/bot/src/koth-converge.ts` (whole file)
- Modify: `apps/bot/src/restart-tick.ts` (`EventsEdits`, `EventsResult` and `applyEvents` at about 29-89; the KotH events block at about 404-429; the comment at about 479; `restartMessage`'s call at about 694)
- Rewrite: `apps/bot/test/koth-converge.test.ts`
- Modify: `apps/bot/test/restart-tick.test.ts` (`describe("applyEvents")`, about 697-733)

**Interfaces:**
- Consumes: `narrowFreshSpawns` (Task 3); `kothLocation`, `kothTownName`, `KOTH_LOCATIONS` (Task 2).
- Produces: `KothPlan = { opening: KothRow | null; presets: string[] | null; files: FileEdit[]; failure: string | null }`; `EventsEdits = { truckWipe?: TruckWipe }`; `EventsResult = { uploaded: boolean; truckWipeError?: Error }`.

- [ ] **Step 1: Rewrite `apps/bot/test/koth-converge.test.ts`** so it describes the new behaviour (failing for now):

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, kothEvents, serverRestarts, servers, type Database } from "@factions/db";
import { KOTH_PRESET_FILES } from "@factions/domain";
import { eq, sql } from "drizzle-orm";
import { planKoth, convergeKothFiles } from "../src/koth-converge.js";
import { narrowFreshSpawns } from "../src/spawn-points.js";
import { restartTick, type RestartTarget } from "../src/restart-tick.js";

const URL = requireTestDatabaseUrl();
const at = (iso: string) => new Date(iso);
const SLOT = at("2026-10-03T20:00:00Z");
const NEXT = at("2026-10-03T22:00:00Z");

const GAMEPLAY = `{\n\t"PlayerData": {\n\t\t"spawnGearPresetFiles": [\n\t\t\t"./custom/loadout.json"\n\t\t]\n\t}\n}`;
const GLOBALS = (player: number, infected: number, avoid: number) => `<variables>
    <var name="CleanupAvoidance" type="0" value="${avoid}"/>
    <var name="CleanupLifetimeDeadInfected" type="0" value="${infected}"/>
    <var name="CleanupLifetimeDeadPlayer" type="0" value="${player}"/>
    <var name="ZombieMaxCount" type="0" value="1000"/>
</variables>`;
const SPAWNS = `<playerspawnpoints>
    <fresh>
        <generator_posbubbles>
            <group name="Balota">
                <pos x="4491.000000" z="2312.000000" />
            </group>
            <group name="Berezino">
                <pos x="12928.000000" z="9906.000000" />
            </group>
        </generator_posbubbles>
    </fresh>
</playerspawnpoints>
`;
const BEREZINO = narrowFreshSpawns(SPAWNS, "Berezino");

/** A mission on a fake Nitrado: every KotH source and default present unless `over` removes it. */
function mission(over: Record<string, string | undefined> = {}) {
  const files: Record<string, string> = {
    "/m/cfggameplay.json": GAMEPLAY,
    "/m/cfgplayerspawnpoints.xml": SPAWNS,
    "/m/koth/default/cfgplayerspawnpoints.xml": SPAWNS,
    "/m/db/globals.xml": GLOBALS(3600, 330, 100),
    "/m/koth/default/globals.xml": GLOBALS(3600, 330, 100),
    ...Object.fromEntries(KOTH_PRESET_FILES.map((p) => [`/m/custom/${p.slice("./custom/".length)}`, "{}"])),
  };
  for (const [k, v] of Object.entries(over)) { if (v === undefined) delete files[k]; else files[k] = v; }
  const store = new Map(Object.entries(files));
  const uploadFile = vi.fn(async (dir: string, name: string, body: string) => { store.set(`${dir}/${name}`, body); });
  // ⚠️ Predators and infected are gone (spec §3.3): touching either is a test failure.
  const forbidden = (p: string) => p.includes("/env/") || p.endsWith("/events.xml");
  const target = {
    missionRootDir: async () => "/m", missionDbDir: async () => "/m/db",
    downloadFile: async (p: string) => {
      if (forbidden(p)) throw new Error(`KotH must not read ${p}`);
      const v = store.get(p); if (v === undefined) throw new Error(`404 ${p}`); return v;
    },
    listFiles: async (d: string) => [...store.keys()].filter((k) => k.startsWith(d + "/") && !k.slice(d.length + 1).includes("/")).map((k) => k.slice(d.length + 1)),
    uploadFile,
  } as unknown as RestartTarget;
  return { target, uploadFile, read: (p: string) => store.get(p) };
}

let db: Database; let serverId = 0;
beforeEach(async () => {
  db = createClient(URL); await runMigrations(db);
  await db.execute(sql`truncate table koth_events, server_restarts, servers restart identity cascade`);
  // ⚠️ nitradoServiceId: restartTick only targets servers that have one.
  const [s] = await db.insert(servers).values({ name: "S", map: "chernarusplus", clockOffsetMs: 0, nitradoServiceId: 1, active: true }).returning();
  serverId = s!.id;
});
const schedule = (over: Record<string, unknown> = {}) => db.insert(kothEvents).values({
  serverId, slotAt: SLOT, location: "berezino", centreX: "12900", centreZ: "9900", state: "scheduled",
  scheduledByDiscordId: "1", announcedAt: at("2026-10-01T00:00:00Z"), ...over,
}).returning().then((r) => r[0]!);
const kothGameplay = GAMEPLAY.replace("./custom/loadout.json", "./custom/koth-ak74-svd.json");

describe("planKoth", () => {
  it("is null when no KotH event has ever existed — nothing to open or restore", async () => {
    expect(await planKoth(db, mission().target, serverId, SLOT, { allowOpen: true })).toBeNull();
  });

  it("opens: the presets, the narrowed spawn file and the three globals, snapshot first", async () => {
    const row = await schedule();
    const p = (await planKoth(db, mission().target, serverId, SLOT, { allowOpen: true }))!;
    expect(p.failure).toBeNull();
    expect(p.opening?.id).toBe(row.id);
    expect(p.presets).toEqual([...KOTH_PRESET_FILES]);
    expect(p.files).toEqual([
      { dir: "/m", name: "cfgplayerspawnpoints.xml", content: BEREZINO },
      { dir: "/m/db", name: "globals.xml", content: GLOBALS(30, 10, 5) },
    ]);
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.loadoutSnapshot).toEqual(["./custom/loadout.json"]);
  });

  // ⚠️ Spec §3.1: a KotH we could not reverse is worse than one that never starts.
  for (const [what, over, msg] of [
    ["a missing default spawn file", { "/m/koth/default/cfgplayerspawnpoints.xml": undefined }, /koth\/default\/cfgplayerspawnpoints\.xml/],
    ["an empty default spawn file", { "/m/koth/default/cfgplayerspawnpoints.xml": "  \n" }, /is empty/],
    ["a default spawn file without the town's group", { "/m/koth/default/cfgplayerspawnpoints.xml": SPAWNS.replace(/<group name="Berezino">[\s\S]*?<\/group>\n/, "") }, /no group "Berezino"/],
    ["a missing default globals.xml", { "/m/koth/default/globals.xml": undefined }, /koth\/default\/globals\.xml/],
    ["a default globals.xml without CleanupAvoidance", { "/m/koth/default/globals.xml": GLOBALS(3600, 330, 100).replace(/.*CleanupAvoidance.*\n/, "") }, /CleanupAvoidance/],
    ["a missing preset", { [`/m/custom/${KOTH_PRESET_FILES[0]!.slice(9)}`]: undefined }, /preset/],
  ] as const) {
    it(`${what} refuses: failed, nothing KotH planned, nothing uploaded`, async () => {
      const row = await schedule();
      const m = mission(over as Record<string, string | undefined>);
      const p = (await planKoth(db, m.target, serverId, SLOT, { allowOpen: true }))!;
      expect(p.failure).toMatch(msg);
      expect(p.opening).toBeNull();
      expect(p.presets).toBeNull();
      expect(m.uploadFile).not.toHaveBeenCalled();
      const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
      expect(saved!.state).toBe("failed");
      expect(saved!.loadoutSnapshot).toBeNull();
    });
  }

  // ⚠️ Review focus 3: a row scheduled on Livonia reaching its slot on Chernarus.
  it("a retired Livonia town refuses with a reason rather than throwing", async () => {
    await schedule({ location: "adamow" });
    const p = (await planKoth(db, mission().target, serverId, SLOT, { allowOpen: true }))!;
    expect(p.failure).toMatch(/adamow is not one of the 31 KotH towns/);
    expect(p.opening).toBeNull();
  });

  // ⚠️ Spec §2.5 of the original: a retried open must never snapshot KotH's own state as the default.
  it("never snapshots a list that already holds koth- entries", async () => {
    const row = await schedule();
    await planKoth(db, mission({ "/m/cfggameplay.json": kothGameplay }).target, serverId, SLOT, { allowOpen: true });
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.loadoutSnapshot).toBeNull();
  });

  it("restores at the next slot: snapshot presets, default spawn file, default globals", async () => {
    await schedule({ state: "live", openedAt: SLOT, loadoutSnapshot: ["./custom/loadout.json"] });
    const m = mission({ "/m/cfggameplay.json": kothGameplay, "/m/cfgplayerspawnpoints.xml": BEREZINO, "/m/db/globals.xml": GLOBALS(30, 10, 5) });
    const p = (await planKoth(db, m.target, serverId, NEXT, { allowOpen: true }))!;
    expect(p.opening).toBeNull();
    expect(p.presets).toEqual(["./custom/loadout.json"]);
    expect(p.files).toEqual([
      { dir: "/m", name: "cfgplayerspawnpoints.xml", content: SPAWNS },
      { dir: "/m/db", name: "globals.xml", content: GLOBALS(3600, 330, 100) },
    ]);
  });

  it("restores globals.xml from koth/default, including a default retuned since the session opened", async () => {
    await schedule({ state: "live", openedAt: SLOT });
    const m = mission({ "/m/db/globals.xml": GLOBALS(30, 10, 5), "/m/koth/default/globals.xml": GLOBALS(1800, 330, 80) });
    const p = (await planKoth(db, m.target, serverId, NEXT, { allowOpen: true }))!;
    expect(p.files).toEqual([{ dir: "/m/db", name: "globals.xml", content: GLOBALS(1800, 330, 80) }]);
  });

  // ⚠️ Skip, never blank.
  it("a missing default spawn file at restore skips it and records why; globals still restore", async () => {
    const row = await schedule({ state: "live", openedAt: SLOT });
    const m = mission({ "/m/cfgplayerspawnpoints.xml": BEREZINO, "/m/db/globals.xml": GLOBALS(30, 10, 5),
      "/m/koth/default/cfgplayerspawnpoints.xml": undefined });
    const p = (await planKoth(db, m.target, serverId, NEXT, { allowOpen: true }))!;
    expect(p.files).toEqual([{ dir: "/m/db", name: "globals.xml", content: GLOBALS(3600, 330, 100) }]);
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(String(saved!.detail.restoreError)).toMatch(/koth\/default\/cfgplayerspawnpoints\.xml/);
  });

  // ⚠️ A refused preset restore leaves ONLY the preset list alone.
  it("a refused preset restore leaves the list alone and records why; the spawn file still restores", async () => {
    const row = await schedule({ state: "live", openedAt: SLOT });
    const m = mission({ "/m/cfggameplay.json": kothGameplay, "/m/cfgplayerspawnpoints.xml": BEREZINO });
    const p = (await planKoth(db, m.target, serverId, NEXT, { allowOpen: true }))!;
    expect(p.presets).toBeNull();
    expect(p.files).toEqual([{ dir: "/m", name: "cfgplayerspawnpoints.xml", content: SPAWNS }]);
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(String(saved!.detail.restoreError)).toMatch(/spawnGearPresetFiles/);
  });

  it("a later user edit survives: no koth- entry → nothing touched", async () => {
    await schedule({ state: "no_winner", openedAt: SLOT, loadoutSnapshot: ["./custom/loadout.json"] });
    const edited = GAMEPLAY.replace('"./custom/loadout.json"', '"./custom/loadout.json",\n\t\t\t"./custom/extra.json"');
    const p = (await planKoth(db, mission({ "/m/cfggameplay.json": edited }).target, serverId, at("2026-10-04T10:00:00Z"), { allowOpen: true }))!;
    expect(p.presets).toBeNull();
    expect(p.files).toEqual([]);
  });
});

describe("convergeKothFiles", () => {
  it("uploads each edit; one failure does not stop the rest", async () => {
    const m = mission();
    const upload = m.uploadFile.getMockImplementation()!;
    m.uploadFile.mockImplementation(async (dir: string, name: string, body: string) => {
      if (name === "globals.xml") throw new Error("ftp refused");
      return upload(dir, name, body);
    });
    const r = await convergeKothFiles(m.target, [
      { dir: "/m/db", name: "globals.xml", content: GLOBALS(30, 10, 5) },
      { dir: "/m", name: "cfgplayerspawnpoints.xml", content: BEREZINO },
    ]);
    expect(r.uploaded).toBe(1);
    expect(r.errors).toEqual([expect.stringMatching(/\/m\/db\/globals\.xml: ftp refused/)]);
    expect(m.read("/m/cfgplayerspawnpoints.xml")).toBe(BEREZINO);
  });
});

describe("restartTick with KotH", () => {
  it("opens at the slot and goes live only after the restart POST; restores at the next slot", async () => {
    const row = await schedule({ location: "novaya-petrovka" });
    const spawns = SPAWNS.replace('"Berezino"', '"NovayaPetrovka"');
    const m = mission({ "/m/cfgplayerspawnpoints.xml": spawns, "/m/koth/default/cfgplayerspawnpoints.xml": spawns });
    const restart = vi.fn(async () => {});
    const target = { ...m.target, status: async () => "started", restart } as unknown as RestartTarget;
    await restartTick(db, () => target, { now: at("2026-10-03T20:00:05Z"), lastError: new Map(), koth: { open: true } });
    // ⚠️ Review focus 5: the display name, never a capitalised slug.
    expect(restart).toHaveBeenCalledWith(expect.stringContaining("King of the Hill at Novaya Petrovka"));
    expect(m.read("/m/cfgplayerspawnpoints.xml")).toBe(narrowFreshSpawns(spawns, "NovayaPetrovka"));
    expect(m.read("/m/cfggameplay.json")).toContain("./custom/koth-");
    expect(m.read("/m/db/globals.xml")).toBe(GLOBALS(30, 10, 5));
    let [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.state).toBe("live");

    await restartTick(db, () => target, { now: at("2026-10-03T22:00:05Z"), lastError: new Map(), koth: { open: true } });
    expect(restart).toHaveBeenLastCalledWith("Scheduled restart");
    expect(m.read("/m/cfgplayerspawnpoints.xml")).toBe(spawns);
    expect(m.read("/m/cfggameplay.json")).toBe(GAMEPLAY);
    expect(m.read("/m/db/globals.xml")).toBe(GLOBALS(3600, 330, 100));
    [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.state).toBe("live");
  });

  // ⚠️ KOTH_TICK off must never OPEN a session, but the restore arm runs regardless.
  it("with KOTH_TICK off, a due row is not opened and stays scheduled; an earlier session still restores", async () => {
    await schedule({ slotAt: at("2026-10-03T18:00:00Z"), state: "no_winner", openedAt: at("2026-10-03T18:00:00Z"), loadoutSnapshot: ["./custom/loadout.json"] });
    const row = await schedule();
    const m = mission({ "/m/cfggameplay.json": kothGameplay, "/m/cfgplayerspawnpoints.xml": BEREZINO });
    const restart = vi.fn(async () => {});
    const target = { ...m.target, status: async () => "started", restart } as unknown as RestartTarget;
    for (const koth of [{ open: false }, undefined]) {
      await db.delete(serverRestarts);
      await restartTick(db, () => target, { now: at("2026-10-03T20:00:05Z"), lastError: new Map(), koth });
      expect(restart).toHaveBeenLastCalledWith("Scheduled restart");
      const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
      expect(saved!.state).toBe("scheduled");
    }
    expect(m.read("/m/cfggameplay.json")).toBe(GAMEPLAY);
    expect(m.read("/m/cfgplayerspawnpoints.xml")).toBe(SPAWNS);
  });

  it("a failed restart POST leaves the row scheduled, not live", async () => {
    const row = await schedule();
    const target = { ...mission().target, status: async () => "started", restart: async () => { throw new Error("503"); } } as unknown as RestartTarget;
    await restartTick(db, () => target, { now: at("2026-10-03T20:00:05Z"), lastError: new Map(), koth: { open: true } });
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.state).toBe("scheduled");
  });

  it("a refused opening still restarts, as a normal restart, with nothing KotH uploaded", async () => {
    const row = await schedule();
    const m = mission({ "/m/koth/default/cfgplayerspawnpoints.xml": undefined });
    const restart = vi.fn(async () => {});
    const target = { ...m.target, status: async () => "started", restart } as unknown as RestartTarget;
    const r = await restartTick(db, () => target, { now: at("2026-10-03T20:00:05Z"), lastError: new Map(), koth: { open: true } });
    expect(r.restarted).toBe(1);
    expect(restart).toHaveBeenCalledWith("Scheduled restart");
    expect(m.uploadFile).not.toHaveBeenCalled();
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.state).toBe("failed");
  });

  it("a refused preset splice fails the row, never advertises it, and still restarts", async () => {
    const row = await schedule();
    const twice = GAMEPLAY.replace('"PlayerData": {', '"PlayerData": {\n\t\t"spawnGearPresetFiles": ["./custom/loadout.json"],');
    const m = mission({ "/m/cfggameplay.json": twice });
    const restart = vi.fn(async () => {});
    const target = { ...m.target, status: async () => "started", restart } as unknown as RestartTarget;
    const r = await restartTick(db, () => target, { now: at("2026-10-03T20:00:05Z"), lastError: new Map(), koth: { open: true } });
    expect(r.restarted).toBe(1);
    expect(restart).toHaveBeenCalledWith("Scheduled restart");
    const [saved] = await db.select().from(kothEvents).where(eq(kothEvents.id, row.id));
    expect(saved!.state).toBe("failed");
    expect(String(saved!.detail.failure)).toMatch(/spawnGearPresetFiles/);
  });
});
```

- [ ] **Step 2: Update the `applyEvents` tests** in `apps/bot/test/restart-tick.test.ts`. Replace the two infected tests ("does the truck wipe and the infected splice in one download and one upload" and "a refused infected splice does not cost the truck wipe") with:

```ts
  it("does the truck wipe in one download and one upload", async () => {
    const h = fakeFiles({ "/mission/db/events.xml": EVENTS });
    const r = await applyEvents(h.target, at("2026-09-12T08:00:00Z"), {
      truckWipe: { events: ["VehicleTruck01"], offHour: 8, onHour: 10, rotation: false },
    });
    expect(r.uploaded).toBe(true);
    expect(h.downloadFile).toHaveBeenCalledTimes(1);
    expect(h.uploadFile).toHaveBeenCalledTimes(1);
    expect(h.read("/mission/db/events.xml")).toContain(`<event name="VehicleTruck01"><active>0</active>`);
  });
```

and change "uploads nothing when nothing changes" to call `applyEvents(h.target, at("2026-09-12T12:00:00Z"), { truckWipe: { events: ["VehicleTruck01"], offHour: 8, onHour: 10, rotation: false } })` (12:00 is outside the 08–10 wipe, so `VehicleTruck01` stays `1`).

- [ ] **Step 3: Run them and watch them fail**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/koth-converge.test.ts test/restart-tick.test.ts`
Expected: FAIL (`CleanupAvoidance` is never set, `/env/` and `events.xml` are still read, and the message says "Novaya-petrovka").

- [ ] **Step 4: Domain constants.** In `packages/domain/src/rules.ts`, delete the `KOTH_INFECTED_EVENTS` and `KOTH_WHOLE_FILES` declarations with their doc comments, and replace the `KOTH_GLOBALS` doc comment and declaration with:

```ts
/**
 * The db/globals.xml `<var>` values a KotH session runs with: bodies clear fast,
 * and players standing near them no longer hold the cleanup off, so a busy hill
 * does not fill with corpses and loot piles. Spliced in place, never a whole-file
 * copy.
 * ⚠️ There is deliberately no "normal" value here. The restore reads each one from
 * the mission's koth/default/globals.xml (staged from db/globals.xml by the
 * chernarus deploy), so the mission repo stays the only statement of the defaults
 * and a retune there is never reverted by the bot.
 */
export const KOTH_GLOBALS: Readonly<Record<string, number>> = {
  CleanupLifetimeDeadPlayer: 30,
  CleanupLifetimeDeadInfected: 10,
  CleanupAvoidance: 5,
};
```

- [ ] **Step 5: Rewrite `apps/bot/src/koth-converge.ts`** (complete file):

```ts
import { kothEvents, type Database } from "@factions/db";
import {
  KOTH_GLOBALS, KOTH_LOCATIONS, KOTH_PRESET_FILES, KOTH_PRESET_PREFIX, kothLocation, kothWanted, restoredPresets,
} from "@factions/domain";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { readSpawnGearPresets } from "./cfggameplay.js";
import { readGlobalVar, setGlobalVar } from "./globals-xml.js";
import { narrowFreshSpawns } from "./spawn-points.js";
import type { RestartTarget } from "./restart-tick.js";

export type KothRow = typeof kothEvents.$inferSelect;
type FileEdit = { dir: string; name: string; content: string };

export type KothPlan = {
  /** The row this slot opens, or null for the default. */
  opening: KothRow | null;
  /** The wanted preset list, or null to leave cfggameplay.json's list alone. */
  presets: string[] | null;
  /** Files to converge (only the ones that differ from the target). */
  files: FileEdit[];
  /** Why an opening was refused (already recorded on the row), or null. */
  failure: string | null;
};

const GAMEPLAY = "cfggameplay.json";
const GLOBALS = "globals.xml";
const SPAWNS = "cfgplayerspawnpoints.xml";
const isKoth = (p: string) => p.includes(`/${KOTH_PRESET_PREFIX}`);

async function readNonEmpty(nitrado: RestartTarget, path: string): Promise<string> {
  // ⚠️ The path goes into the message ourselves: it lands in the row's `detail`
  // and the ops alert, and an operator told only "404" cannot tell which file
  // to put back.
  const body = await nitrado.downloadFile(path).catch((err: unknown) => {
    throw new Error(`${path} could not be read (${err instanceof Error ? err.message : String(err)})`);
  });
  // ⚠️ An empty download is a missing file with a friendlier face; uploading it
  // over a live spawn file would leave a server nobody can spawn on.
  if (body.trim() === "") throw new Error(`${path} is empty`);
  return body;
}

/**
 * db/globals.xml with every `KOTH_GLOBALS` var set to `wanted(name)`, as an edit —
 * or none when the live file already carries those values. A splice of the live
 * file, never a whole-file copy: globals.xml holds far more than these vars.
 */
async function globalsEdit(nitrado: RestartTarget, dbDir: string, wanted: (name: string) => number): Promise<FileEdit[]> {
  const live = await readNonEmpty(nitrado, `${dbDir}/${GLOBALS}`);
  let next = live;
  for (const name of Object.keys(KOTH_GLOBALS)) next = setGlobalVar(next, name, wanted(name)).xml;
  return next === live ? [] : [{ dir: dbDir, name: GLOBALS, content: next }];
}

/**
 * What King of the Hill wants from this slot (spec 2026-10-07-koth-chernarus §3).
 * Null when no KotH row has EVER existed — the only case the restore arm may skip.
 *
 * ⚠️ Not gated on KOTH_TICK by the caller: switching the feature off mid-event
 * must still put the server back. `allowOpen` gates the OPENING branch alone.
 *
 * ⚠️ The opening is verified BEFORE anything is written, and a refusal returns
 * the RESTORE plan: a KotH we could not reverse is worse than one that never
 * starts, and a half-written open from an earlier failed attempt is undone the
 * same way.
 */
export async function planKoth(
  db: Database, nitrado: RestartTarget, serverId: number, slot: Date, opts: { allowOpen: boolean },
): Promise<KothPlan | null> {
  // ⚠️ FIRST, before any Nitrado call: a server that has never had a KotH row
  // must cost the restart tick nothing.
  const [any] = await db.select({ id: kothEvents.id }).from(kothEvents).where(eq(kothEvents.serverId, serverId)).limit(1);
  if (!any) return null;

  const root = await nitrado.missionRootDir();
  const dbDir = await nitrado.missionDbDir();
  const candidates = await db.select().from(kothEvents)
    .where(and(eq(kothEvents.serverId, serverId), eq(kothEvents.state, "scheduled")));
  const opening = opts.allowOpen ? kothWanted(slot, candidates) : null;

  let failure: string | null = null;
  if (opening) {
    try {
      // ⚠️ A row scheduled before the move to Chernarus names a Livonia town:
      // refused here with a reason, never a throw out of planKoth.
      const loc = kothLocation(opening.location);
      if (!loc) throw new Error(`${opening.location} is not one of the ${KOTH_LOCATIONS.length} KotH towns on this map`);
      const custom = new Set(await nitrado.listFiles(`${root}/custom`));
      const missing = KOTH_PRESET_FILES.filter((p) => !custom.has(p.slice("./custom/".length)));
      if (missing.length > 0) throw new Error(`KotH preset(s) missing on the server: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? " …" : ""}`);
      // The default is both the source of the session file and the restore target,
      // so reading it proves both.
      const spawns = narrowFreshSpawns(await readNonEmpty(nitrado, `${root}/koth/default/${SPAWNS}`), loc.spawnGroup);
      // ⚠️ The default is proved readable, var by var, BEFORE the session opens:
      // without it the restore could never put the cleanup values back.
      const globalsDefault = await readNonEmpty(nitrado, `${root}/koth/default/${GLOBALS}`);
      for (const name of Object.keys(KOTH_GLOBALS)) readGlobalVar(globalsDefault, name);
      const globals = await globalsEdit(nitrado, dbDir, (name) => KOTH_GLOBALS[name]!);
      // Snapshot BEFORE any upload. Read-only here; the single upload of
      // cfggameplay.json stays in applyGameplay.
      const presetsNow = readSpawnGearPresets(await nitrado.downloadFile(`${root}/${GAMEPLAY}`));
      // ⚠️ Only from a list with no koth- entry: a retried open after a partial
      // upload would otherwise record KotH's own list as the default.
      if (opening.loadoutSnapshot === null && !presetsNow.some(isKoth)) {
        await db.update(kothEvents).set({ loadoutSnapshot: presetsNow }).where(eq(kothEvents.id, opening.id));
      }
      return {
        opening, presets: [...KOTH_PRESET_FILES],
        files: [...await differing(nitrado, [{ dir: root, name: SPAWNS, content: spawns }]), ...globals], failure: null,
      };
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      await db.update(kothEvents).set({
        state: "failed",
        detail: sql`${kothEvents.detail} || ${JSON.stringify({ failure })}::jsonb`,
      }).where(and(eq(kothEvents.id, opening.id), eq(kothEvents.state, "scheduled")));
      console.error(`koth: server ${serverId} REFUSED to open ${opening.location} for ${slot.toISOString()} — ${failure}`);
    }
  }

  // ── Restore ──────────────────────────────────────────────────────────────
  const [latest] = await db.select().from(kothEvents)
    .where(and(eq(kothEvents.serverId, serverId), isNotNull(kothEvents.loadoutSnapshot)))
    .orderBy(desc(kothEvents.slotAt)).limit(1);
  const presetsNow = readSpawnGearPresets(await nitrado.downloadFile(`${root}/${GAMEPLAY}`));
  const problems: string[] = [];
  let presets: string[] | null;
  try {
    presets = restoredPresets(presetsNow, latest?.loadoutSnapshot ?? null);
  } catch (err) {
    // ⚠️ An empty restore leaves ONLY the preset list alone; the files still restore.
    presets = null;
    problems.push(err instanceof Error ? err.message : String(err));
  }

  let spawns: FileEdit[] = [];
  try {
    spawns = await differing(nitrado, [{ dir: root, name: SPAWNS, content: await readNonEmpty(nitrado, `${root}/koth/default/${SPAWNS}`) }]);
  } catch (err) {
    // ⚠️ Skip, never blank: a missing default must not become an empty spawn file.
    problems.push(err instanceof Error ? err.message : String(err));
  }
  let globals: FileEdit[] = [];
  try {
    const globalsDefault = await readNonEmpty(nitrado, `${root}/koth/default/${GLOBALS}`);
    globals = await globalsEdit(nitrado, dbDir, (name) => readGlobalVar(globalsDefault, name));
  } catch (err) {
    // ⚠️ Skip, never guess: a default we cannot read leaves the live values alone.
    problems.push(err instanceof Error ? err.message : String(err));
  }
  // ⚠️ One write for every restore problem this slot: two separate `||` merges of
  // the same `restoreError` key would leave only whichever landed last.
  if (problems.length > 0) {
    const [newest] = await db.select({ id: kothEvents.id }).from(kothEvents).where(eq(kothEvents.serverId, serverId)).orderBy(desc(kothEvents.slotAt)).limit(1);
    if (newest) await db.update(kothEvents).set({ detail: sql`${kothEvents.detail} || ${JSON.stringify({ restoreError: problems.join("; ") })}::jsonb` }).where(eq(kothEvents.id, newest.id));
    console.error(`koth: server ${serverId} could not restore everything — ${problems.join("; ")}`);
  }

  return { opening: null, presets, files: [...spawns, ...globals], failure };
}

/** Only the edits whose target currently differs. A missing target counts as differing. */
async function differing(nitrado: RestartTarget, edits: FileEdit[]): Promise<FileEdit[]> {
  const out: FileEdit[] = [];
  for (const e of edits) {
    const now = await nitrado.downloadFile(`${e.dir}/${e.name}`).catch(() => null);
    if (now !== e.content) out.push(e);
  }
  return out;
}

/**
 * Upload each edit. Each is independent: one failed upload does not stop the rest.
 * The list is `planKoth`'s, which has already dropped every file that matches its
 * target.
 */
export async function convergeKothFiles(nitrado: RestartTarget, files: FileEdit[]): Promise<{ uploaded: number; errors: string[] }> {
  let uploaded = 0;
  const errors: string[] = [];
  for (const f of files) {
    try {
      await nitrado.uploadFile(f.dir, f.name, f.content);
      uploaded += 1;
    } catch (err) {
      errors.push(`${f.dir}/${f.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { uploaded, errors };
}
```

- [ ] **Step 6: Take the infected path out of `apps/bot/src/restart-tick.ts`**

(a) Replace the `EventsEdits` and `EventsResult` types with:

```ts
export type EventsEdits = { truckWipe?: TruckWipe };
export type EventsResult = { uploaded: boolean; truckWipeError?: Error };
```

(b) In `applyEvents`'s doc comment, change "the truck wipe, the weekly rotation and King of the Hill's infected" to "the truck wipe and the weekly rotation", and drop the sentence "KotH naming a missing event must not cost the truck wipe, or vice versa" and "so a half-applied infected set never uploads". Then delete the whole `if (edits.infected) { … }` block.

(c) Replace the two comment lines starting `// ⚠️ KotH's infected splice rides in the SAME call`, the `const wipeWanted = …` line after them, and the whole `if (wipeWanted || koth?.infected) { … }` block with:

```ts
      const wipeWanted = !!opts.truckWipe && (opts.truckWipe.events.length > 0 || opts.truckWipe.rotation);
      if (wipeWanted) {
        try {
          const r = await applyEvents(nitrado, slot.start, { truckWipe: opts.truckWipe });
          if (r.truckWipeError) console.error(`restart: server ${s.id} truck wipe refused for slot ${slot.start.toISOString()} — restarting anyway`, r.truckWipeError);
          if (r.uploaded) console.log(`restart: server ${s.id} wrote events.xml for ${slot.start.toISOString()}`);
        } catch (err) {
          console.error(`restart: server ${s.id} events.xml failed for slot ${slot.start.toISOString()} — restarting anyway`, err);
        }
      }
```

(d) In the comment near line 479 ("(its infected splice or events.xml write) must not put KotH's presets in"), replace the parenthetical with "(a refused narrowing or globals edit)".

(e) At the restart POST (about line 694), pass the display name:

```ts
      await nitrado.restart(restartMessage(airdropLocation, kothOpening ? kothTownName(kothOpening.location) : null));
```

and add `kothTownName` to the file's `@factions/domain` import. `restartMessage`'s `cap()` leaves an already-capitalised name unchanged.

- [ ] **Step 7: Run the KotH and restart suites**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/koth-converge.test.ts test/restart-tick.test.ts test/spawn-points.test.ts && npx tsc --noEmit -p .`
Expected: PASS, and no type errors (no remaining reference to `KOTH_INFECTED_EVENTS`, `KOTH_WHOLE_FILES`, `infected` or `infectedRestoreRowId`). `grep -rn "KOTH_INFECTED_EVENTS\|KOTH_WHOLE_FILES\|infectedRestoreRowId" apps packages --include='*.ts'` prints nothing outside `node_modules`.

- [ ] **Step 8: Commit**

```bash
git add -A packages/domain/src/rules.ts apps/bot
git commit -q -m "KotH narrows the spawn file to one town; no predators or infected

Spec 2026-10-07-koth-chernarus §3: the opening builds the session's
cfgplayerspawnpoints.xml from koth/default/ with narrowFreshSpawns, sets
CleanupAvoidance 5 alongside the two body timers, and no longer touches
env/*_territories.xml or the infected events in events.xml.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Changelog, the full gate, and the PR

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md` (the King of the Hill row of "Where things live")

- [ ] **Step 1: Changelog**, under `## [Unreleased]`:

```markdown

### Changed

- King of the Hill runs on Chernarus. Any of the 31 fast-travel towns can host it, and fresh spawns start at that town's ten fast-travel arrival spots with a KotH kit. Bodies clear faster on the hill, and standing near them no longer keeps them around. There are no wolves, bears or infected hordes any more.
```

- [ ] **Step 2: CLAUDE.md.** In the King of the Hill row, replace the sentence that begins "⚠️ **The bot owns the four whole files on the server for the session's duration**" through "…restores them from `koth/default/globals.xml` every other slot" with:

```markdown
⚠️ **The bot owns `cfgplayerspawnpoints.xml` for the session's duration**: the opening narrows `koth/default/cfgplayerspawnpoints.xml` to the town's `<fresh>` group (`narrowFreshSpawns`, `apps/bot/src/spawn-points.ts`) and every other slot reverts it to that default, the same rule the raid window and airdrops established for their own files. It also splices three `db/globals.xml` vars (`KOTH_GLOBALS`: dead-player and dead-infected cleanup, 30 s and 10 s, and `CleanupAvoidance` 5) for the session and restores them from `koth/default/globals.xml` every other slot. Since 2026-10-07 (Chernarus) it no longer touches `env/*_territories.xml` or the infected events in `events.xml`; spec `docs/superpowers/specs/2026-10-07-koth-chernarus-design.md`
```

and in the row's first sentence change "at a Livonia town" to "at a Chernarus fast-travel town", "hill spawns, KotH loadouts, infected and predators converge" to "hill spawns, KotH loadouts", and "livonia-staged copy" / "`livonia/db/globals.xml`" to "chernarus-staged copy" / "`chernarus/db/globals.xml`".

- [ ] **Step 3: Run the full gate**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force 2>&1 | grep -E "Tasks:|Failed:|FAIL "`
Expected: `Tasks:    32 successful, 32 total`

- [ ] **Step 4: Commit, push, open the PR**

```bash
git add CHANGELOG.md CLAUDE.md
git commit -q -m "Changelog and working notes for KotH on Chernarus

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -q -u origin feature/koth-chernarus
gh pr create --base main --title "King of the Hill on Chernarus" --body "Implements docs/superpowers/specs/2026-10-07-koth-chernarus-design.md (plan: docs/superpowers/plans/2026-10-07-koth-chernarus.md).

Ship after the chernarus PR that stages koth/default/ and carries the koth-*.json presets. Until then every opening is refused cleanly (spec §7).

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
