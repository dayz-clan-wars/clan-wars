# Bunker Online Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the airdrop into "bunker online": one of 11 keycard rooms comes online for one session with the explosives or guns template, placed by the bot.

**Architecture:** The airdrop machinery (decision tick, `airdrop_events` rows, enable attempts, the `cfggameplay.json` splice) stays. What changes is what a drop is. A row's `location` is a room slug and its new `kind` is `boom` or `guns`. At the opening restart the bot downloads `custom/keycard-rooms.json` and the template from the server, places the template on the room with the pure `placeBunker`, uploads `custom/bunker-online.json`, and registers that one fixed path. Every player-facing string says bunker; internal names stay "airdrop".

**Tech Stack:** TypeScript, vitest, drizzle-orm and drizzle-kit (Postgres on 5434 for tests), discord.js, pnpm and turbo.

**Spec:** `docs/superpowers/specs/2026-10-07-bunker-online-design.md`

## Global Constraints

- The clan-wars gate: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force --continue`. Expected: 32/32, except drift tests that read the sibling `../chernarus` checkout before it has the matching chernarus PRs (see the KotH ruling: `koth-drift` presets, and this plan's bunker-rooms drift). Never run two test processes at once.
- The local `../chernarus` checkout is someone else's working copy. **Never check out, stash, pull or commit in it.** Use a worktree.
- Never commit to `main` (protected). Every clan-wars PR adds a `## [Unreleased]` entry to `CHANGELOG.md`, and so does every chernarus PR.
- Internal names stay airdrop: the `airdrop_events` table, the `AIRDROP_*` env vars, `airdrop-tick.ts`, `setAirdropSpawner`. Player-facing strings say bunker. Production's `.env` does not change.
- Rules and numbers are unchanged: `AIRDROP_DECIDE_LEAD_MS`, `AIRDROP_MIN_GAP_MS`, `AIRDROP_HISTORY_MS`, `AIRDROP_NO_REPEAT` = 5, `AIRDROP_MAX_ENABLE_ATTEMPTS` = 2, KotH wins a contested slot, and manual placement skips the weekly cap only.
- Kinds: `boom` → `custom/keycard-bunker-boom.json`; `guns` → `custom/keycard-bunker-guns.json`. A kind is never announced.
- The spawner path is `./custom/bunker-online.json`.
- Copy, verbatim from spec §7:
  - Announcement: `**BUNKER ONLINE: <ROOM NAME UPPERCASE>**` / `Opens at the restart, <countdown>. Bring a punched card.`
  - Scrubbed: `**BUNKER OFFLINE: <ROOM NAME UPPERCASE>**` / `It did not come online. The next one can come any day.`
  - Restart message: `Bunker online at <Room Name> next session.`
- Comment style: comments say WHY, and `⚠️` marks a line whose failure would be silent.

## Review Focus

1. **A row decided before the deploy** (`colour` set, `kind` null, `location` a Livonia slug) reaching an opening restart: it must count a failed enable attempt and scrub after two, never throw or register anything. Pinned in Task 4.
2. **The room name in `keycard-rooms.json` changing** (someone edits a `customString` in the chernarus repo): the opening must fail the attempt with the room named, not place a bunker at the wrong room or at the origin. Pinned in Task 4.
3. **A live bunker whose file vanished mid-session** (a chernarus deploy or a hand delete removed `custom/bunker-online.json`): the re-converge at the bunker's own slot uploads it again before re-registering. Pinned in Task 4.
4. **A template object with `ypr` pitch and roll** (the concrete panels are `[90, 90, 180]`): only yaw turns; pitch and roll are kept exactly. Pinned in Task 2.
5. **A room's yaw plus the turn going past ±180°** (Kamensk −180°, Pavlovo 8°): yaw stays a finite number, normalised to (−180, 180]. Pinned in Task 2.

---

## File Structure

| File | Responsibility |
|---|---|
| `chernarus/custom/keycard-rooms.json` | the four renames (Task 1) |
| `packages/domain/assets/bunker-rooms.json` (new) | the 11 rooms: `{ name, slug, x, y, z, yaw }` |
| `packages/domain/src/bunker.ts` (new) | `BunkerKind`, `BUNKER_KINDS`, `BUNKER_ROOMS`, `bunkerRoom`, `bunkerRoomName`, `BUNKER_SPAWNER_PATH`, `bunkerTemplateFile`, `placeBunker` |
| `packages/domain/src/airdrops.ts` | `AirdropSpec` becomes `{ location, kind }`; `chooseAirdrop` draws rooms and kinds; `airdropSpawnerPath` goes |
| `packages/domain/src/rules.ts` | `AIRDROP_LOCATIONS` and `AIRDROP_COLOURS` go (the retired Livonia slugs move into `bunker.ts`) |
| `packages/db/src/schema.ts` + `migrations/0064_*.sql` | `colour` nullable, `kind`, exactly-one check |
| `apps/bot/src/bunker-stage.ts` (new) | `stageBunker(host, spec)`: download, place, upload |
| `apps/bot/src/cfggameplay.ts` | `setAirdropSpawner(json, on: boolean)` with the fixed path and both marks |
| `apps/bot/src/restart-tick.ts` | intent carries `kind`; stage before the splice; the restart message says bunker |
| `apps/bot/src/airdrop-tick.ts`, `airdrop-text.ts` | the decision writes `kind`; the copy says bunker |
| `apps/bot/src/commands/bunker.ts` (replaces `airdrop.ts`) | `/bunker place room: kind:` |
| `apps/bot/src/commands/kothvote.ts`, `koth-vote-tick.ts` | the "airdrop" wording → bunker |
| `apps/show/src/story/events.ts`, `prompt/system.ts` | room names; the prompt says bunkers |

---

### Task 1: Chernarus: rename four rooms

**Files (chernarus worktree):** Modify `custom/keycard-rooms.json` and `CHANGELOG.md`.

**Interfaces:** Produces the room names Task 2 vendors: Balota Airfield, VMC, Krasnostav Airfield, Pavlovo Military, Tisy Military, Zelenogorsk, NWAF, Kamensk Military, Green Mountain, Bashnya, Prison Island.

- [ ] **Step 1: Worktree**

```bash
W=/private/tmp/claude-501/-Users-steveharmeyer-Development-dayz-clan-wars/d42a6fe4-e41c-4291-b66a-9a7200898c6a/scratchpad/chernarus-bunker
git -C /Users/steveharmeyer/Development/dayz-clan-wars/chernarus fetch -q origin
git -C /Users/steveharmeyer/Development/dayz-clan-wars/chernarus worktree add -q -b feature/bunker-room-names "$W" origin/main
```

- [ ] **Step 2: Rename, and check every other byte is unchanged**

```bash
cd "$W" && python3 - <<'EOF'
p = "custom/keycard-rooms.json"; s = open(p).read()
for old, new in [("Troitskoye Military Base", "Kamensk Military"), ("Pavlovo Military Base", "Pavlovo Military"),
                 ("Tisy Military Base", "Tisy Military"), ("Zelenogorsk Military Base", "Zelenogorsk")]:
    q = f'"customString": "{old}"'
    assert s.count(q) == 1, old
    s = s.replace(q, f'"customString": "{new}"')
open(p, "w").write(s)
EOF
git diff --stat   # Expected: custom/keycard-rooms.json | 8 ++++----
python3 -c 'import json;print([o["customString"] for o in json.load(open("custom/keycard-rooms.json"))["Objects"]])'
```

Expected: the 11 names above, in file order.

- [ ] **Step 3: Changelog** under `## [Unreleased]`:

```markdown

### Changed

- Four keycard rooms have names you can find on the map: Kamensk Military (was Troitskoye), Pavlovo Military, Tisy Military and Zelenogorsk.
```

- [ ] **Step 4: Commit, push, PR**

```bash
cd "$W" && git add -A && git commit -q -m "Rename four keycard rooms to map names

Troitskoye Military Base -> Kamensk Military, Pavlovo/Tisy Military Base ->
Pavlovo/Tisy Military, Zelenogorsk Military Base -> Zelenogorsk. The
clan-wars bunker-online feature announces rooms by these names.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -q -u origin feature/bunker-room-names
gh pr create -R dayz-clan-wars/chernarus --base main --title "Rename four keycard rooms to map names" --body "For clan-wars spec 2026-10-07-bunker-online §3. Ship before the clan-wars bunker release.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 2: Domain: rooms, kinds and `placeBunker`

**Files:**
- Create: `packages/domain/assets/bunker-rooms.json`, `packages/domain/src/bunker.ts`
- Modify: `packages/domain/src/index.ts` (add `export * from "./bunker";` after `export * from "./airdrops";`)
- Test: `packages/domain/test/bunker.test.ts`, `packages/domain/test/bunker-drift.test.ts`

**Interfaces:**
- Produces:
  - `type BunkerKind = "boom" | "guns"`; `BUNKER_KINDS: readonly BunkerKind[]` (`["boom", "guns"]`)
  - `type BunkerRoom = { name: string; slug: string; x: number; y: number; z: number; yaw: number }`; `BUNKER_ROOMS: readonly BunkerRoom[]` (11)
  - `bunkerRoom(slug: string): BunkerRoom | null` (rooms only)
  - `bunkerRoomName(slug: string): string` (room name, else a retired Livonia location capitalised, else the slug)
  - `BUNKER_SPAWNER_PATH = "./custom/bunker-online.json"`; `bunkerTemplateFile(kind: BunkerKind): string` (`keycard-bunker-${kind}.json`)
  - `type SpawnerObject = { name: string; pos: [number, number, number]; ypr: [number, number, number]; scale: number; enableCEPersistency: number; customString: string }`
  - `type BunkerAnchor = { x: number; y: number; z: number; yaw: number }`
  - `placeBunker(template: { Objects: SpawnerObject[] }, room: BunkerAnchor): { Objects: SpawnerObject[] }`

- [ ] **Step 1: Generate `bunker-rooms.json` from Task 1's renamed file**

```bash
cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars
node -e '
const objs = require(process.argv[1]).Objects;
const out = objs.map((o) => ({ name: o.customString, slug: o.customString.toLowerCase().replace(/ /g, "-"),
  x: o.pos[0], y: o.pos[1], z: o.pos[2], yaw: o.ypr[0] }));
if (out.length !== 11) throw new Error(`expected 11 rooms, got ${out.length}`);
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
' /private/tmp/claude-501/-Users-steveharmeyer-Development-dayz-clan-wars/d42a6fe4-e41c-4291-b66a-9a7200898c6a/scratchpad/chernarus-bunker/custom/keycard-rooms.json > packages/domain/assets/bunker-rooms.json
node -e 'console.log(require("./packages/domain/assets/bunker-rooms.json").map(r=>r.slug).join(" "))'
```

Expected: `balota-airfield vmc krasnostav-airfield pavlovo-military tisy-military zelenogorsk nwaf kamensk-military green-mountain bashnya prison-island`

- [ ] **Step 2: Write the failing tests** `packages/domain/test/bunker.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  BUNKER_KINDS, BUNKER_ROOMS, BUNKER_SPAWNER_PATH, bunkerRoom, bunkerRoomName, bunkerTemplateFile, placeBunker,
  type SpawnerObject,
} from "../src/index.js";

const obj = (name: string, pos: [number, number, number], ypr: [number, number, number] = [0, 0, 0]): SpawnerObject =>
  ({ name, pos, ypr, scale: 1, enableCEPersistency: 0, customString: "" });
const ANCHOR = obj("Land_Underground_Stairs_Exit", [100, 10, 200], [0, 0, 0]);
const template = (...rest: SpawnerObject[]) => ({ Objects: [ANCHOR, ...rest] });

describe("rooms and kinds", () => {
  it("has the 11 rooms with unique slugs, and two kinds", () => {
    expect(BUNKER_ROOMS).toHaveLength(11);
    expect(new Set(BUNKER_ROOMS.map((r) => r.slug)).size).toBe(11);
    expect(bunkerRoom("kamensk-military")?.name).toBe("Kamensk Military");
    expect(bunkerRoom("dolnik")).toBeNull();
    expect(BUNKER_KINDS).toEqual(["boom", "guns"]);
    expect(bunkerTemplateFile("guns")).toBe("keycard-bunker-guns.json");
    expect(BUNKER_SPAWNER_PATH).toBe("./custom/bunker-online.json");
  });
  it("names a room, a retired Livonia location, or falls back to the slug", () => {
    expect(bunkerRoomName("nwaf")).toBe("NWAF");
    expect(bunkerRoomName("dolnik")).toBe("Dolnik");
    expect(bunkerRoomName("narnia")).toBe("narnia");
  });
});

describe("placeBunker", () => {
  it("at the anchor's own yaw, every object keeps its offset from the room's exit; the template's exit is left out", () => {
    const out = placeBunker(template(obj("Crate", [101, 11, 203], [10, 0, 0])), { x: 1000, y: 50, z: 2000, yaw: 0 });
    expect(out.Objects).toEqual([obj("Crate", [1001, 51, 2003], [10, 0, 0])]);
  });
  // DayZ yaw is clockwise from north (+z): turning 90° moves a point east of the
  // anchor to south of it.
  it("turned 90°, an offset 1 m east lands 1 m south, and its yaw turns by 90", () => {
    const out = placeBunker(template(obj("Crate", [101, 10, 200], [0, 0, 0])), { x: 1000, y: 50, z: 2000, yaw: 90 });
    const [c] = out.Objects;
    expect(c!.pos[0]).toBeCloseTo(1000, 9); expect(c!.pos[1]).toBe(50); expect(c!.pos[2]).toBeCloseTo(1999, 9);
    expect(c!.ypr[0]).toBeCloseTo(90, 9);
  });
  it("turned 90°, an offset 1 m north lands 1 m east", () => {
    const [c] = placeBunker(template(obj("Crate", [100, 10, 201])), { x: 0, y: 0, z: 0, yaw: 90 }).Objects;
    expect(c!.pos[0]).toBeCloseTo(1, 9); expect(c!.pos[2]).toBeCloseTo(0, 9);
  });
  // ⚠️ Review focus 4: the concrete panels are [90, 90, 180]; only yaw may move.
  it("keeps pitch and roll exactly", () => {
    const [c] = placeBunker(template(obj("StaticObj_Panel_Concrete_1", [101, 11, 201], [90, 89.97, 180])), { x: 0, y: 0, z: 0, yaw: -45 }).Objects;
    expect(c!.ypr[1]).toBe(89.97); expect(c!.ypr[2]).toBe(180);
    expect(c!.ypr[0]).toBeCloseTo(45, 9);
  });
  // ⚠️ Review focus 5.
  it("normalises yaw into (-180, 180]", () => {
    const [c] = placeBunker(template(obj("Crate", [101, 10, 200], [170, 0, 0])), { x: 0, y: 0, z: 0, yaw: 90 }).Objects;
    expect(c!.ypr[0]).toBeCloseTo(-100, 9);
    const [d] = placeBunker(template(obj("Crate", [101, 10, 200], [0, 0, 0])), { x: 0, y: 0, z: 0, yaw: -180 }).Objects;
    expect(d!.ypr[0]).toBeCloseTo(180, 9);
  });
  it("copies name, scale, persistency and customString", () => {
    const o = { ...obj("Mag_SVD_10Rnd", [101, 10, 200]), scale: 0.5, enableCEPersistency: 1, customString: "x" };
    const [c] = placeBunker(template(o), { x: 0, y: 0, z: 0, yaw: 0 }).Objects;
    expect(c).toMatchObject({ name: "Mag_SVD_10Rnd", scale: 0.5, enableCEPersistency: 1, customString: "x" });
  });
  it("refuses a template with no stairs exit, or two", () => {
    expect(() => placeBunker({ Objects: [obj("Crate", [0, 0, 0])] }, { x: 0, y: 0, z: 0, yaw: 0 })).toThrow(/one Land_Underground_Stairs_Exit, found 0/);
    expect(() => placeBunker(template(ANCHOR), { x: 0, y: 0, z: 0, yaw: 0 })).toThrow(/found 2/);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd packages/domain && npx vitest run test/bunker.test.ts`
Expected: FAIL (`placeBunker` and the other names are not exported).

- [ ] **Step 4: Implement** `packages/domain/src/bunker.ts`:

```ts
import rooms from "../assets/bunker-rooms.json";

/** Which template a bunker comes online with (spec 2026-10-07-bunker-online §2). Never announced. */
export type BunkerKind = "boom" | "guns";
export const BUNKER_KINDS: readonly BunkerKind[] = ["boom", "guns"];

export type BunkerRoom = { name: string; slug: string; x: number; y: number; z: number; yaw: number };
/**
 * The 11 keycard rooms, vendored from chernarus/custom/keycard-rooms.json;
 * bunker-drift.test.ts holds them together. ⚠️ Picking and announcing read this
 * list; the placement reads the room from the SERVER's file at the opening
 * (bunker-stage.ts), so a room edited there is caught rather than placed stale.
 */
export const BUNKER_ROOMS: readonly BunkerRoom[] = rooms;

/**
 * The 16 Livonia airdrop locations, retired 2026-10-07. Names only: past rows
 * store these slugs and must keep printing a place, never be drawn again.
 */
const RETIRED_AIRDROP_LOCATIONS: readonly string[] = [
  "airfield", "bielawa", "brena", "dolnik", "gieraltow", "gliniska", "grabin", "lukow",
  "nadbor", "polana", "sarnowek", "sitnik", "sobotka", "tarnow", "topolin", "zalesie",
];

export function bunkerRoom(slug: string): BunkerRoom | null {
  return BUNKER_ROOMS.find((r) => r.slug === slug) ?? null;
}

/** A display name for any event's location, past or present; the slug itself if unknown. */
export function bunkerRoomName(slug: string): string {
  const room = bunkerRoom(slug);
  if (room) return room.name;
  if (RETIRED_AIRDROP_LOCATIONS.includes(slug)) return slug.charAt(0).toUpperCase() + slug.slice(1);
  return slug;
}

/**
 * The one spawner path the feature ever registers. ⚠️ A fixed file the bot
 * rewrites at every opening, so `objectSpawnersArr` never needs one entry per
 * room and kind.
 */
export const BUNKER_SPAWNER_PATH = "./custom/bunker-online.json";

/** The template a kind is built from, in the mission's custom/ directory. */
export function bunkerTemplateFile(kind: BunkerKind): string {
  return `keycard-bunker-${kind}.json`;
}

export type SpawnerObject = {
  name: string; pos: [number, number, number]; ypr: [number, number, number];
  scale: number; enableCEPersistency: number; customString: string;
};
export type BunkerAnchor = { x: number; y: number; z: number; yaw: number };

const ANCHOR = "Land_Underground_Stairs_Exit";
const RAD = Math.PI / 180;

/** Yaw in (-180, 180]. */
function normaliseYaw(deg: number): number {
  const r = ((deg % 360) + 360) % 360;
  return r > 180 ? r - 360 : r;
}

/**
 * The template moved onto a room: every object keeps its offset from the
 * template's stairs exit, turned by the difference in yaw, and the template's
 * own exit is left out because the room already spawns one (spec §4).
 *
 * ⚠️ DayZ yaw is degrees clockwise from north (+z), so turning by θ maps an
 * offset (dx, dz) to (dx·cos θ + dz·sin θ, −dx·sin θ + dz·cos θ). No file in
 * either repo proves this; the first bunker on production is checked in game
 * before the automatic event runs (spec §8).
 */
export function placeBunker(template: { Objects: SpawnerObject[] }, room: BunkerAnchor): { Objects: SpawnerObject[] } {
  const anchors = template.Objects.filter((o) => o.name === ANCHOR);
  if (anchors.length !== 1) throw new Error(`bunker template: expected one ${ANCHOR}, found ${anchors.length}`);
  const a = anchors[0]!;
  const turn = room.yaw - a.ypr[0];
  const c = Math.cos(turn * RAD), s = Math.sin(turn * RAD);
  return {
    Objects: template.Objects.filter((o) => o !== a).map((o) => {
      const dx = o.pos[0] - a.pos[0], dy = o.pos[1] - a.pos[1], dz = o.pos[2] - a.pos[2];
      return {
        ...o,
        pos: [room.x + dx * c + dz * s, room.y + dy, room.z - dx * s + dz * c],
        ypr: [normaliseYaw(o.ypr[0] + turn), o.ypr[1], o.ypr[2]],
      };
    }),
  };
}
```

And in `packages/domain/src/index.ts`, after `export * from "./airdrops";`, add `export * from "./bunker";`.

- [ ] **Step 5: Run it and watch it pass**

Run: `cd packages/domain && npx vitest run test/bunker.test.ts && npx tsc --noEmit -p .`
Expected: PASS (9 tests), no type errors.

- [ ] **Step 6: Drift test** `packages/domain/test/bunker-drift.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BUNKER_ROOMS } from "../src/index.js";

// ⚠️ Two statements of one fact (CLAUDE.md): the chernarus repo holds the rooms;
// this package vendors them for picking and announcing. Skipped where the sibling
// checkout is absent (CI). It reads that checkout's WORKING TREE: if it fails on
// renames you have not pulled yet, `git -C ../chernarus pull` (never commit there;
// it is someone's working copy).
const CHERNARUS = join(__dirname, "../../../../chernarus");
const FILE = join(CHERNARUS, "custom/keycard-rooms.json");

describe.skipIf(!existsSync(FILE))("bunker rooms vs the chernarus repo", () => {
  it("names, positions and yaws match custom/keycard-rooms.json", () => {
    const objs = JSON.parse(readFileSync(FILE, "utf8")).Objects as { customString: string; pos: number[]; ypr: number[] }[];
    expect(BUNKER_ROOMS.map((r) => [r.name, r.x, r.y, r.z, r.yaw]))
      .toEqual(objs.map((o) => [o.customString, o.pos[0], o.pos[1], o.pos[2], o.ypr[0]]));
  });
});
```

Run: `cd packages/domain && npx vitest run test/bunker-drift.test.ts`
Expected: FAIL until the `../chernarus` working tree has Task 1's renames (the four old names differ); PASS after. Record the result in the ledger.

- [ ] **Step 7: Commit**

```bash
git add packages/domain/assets/bunker-rooms.json packages/domain/src/bunker.ts packages/domain/src/index.ts packages/domain/test/bunker.test.ts packages/domain/test/bunker-drift.test.ts
git commit -q -m "Bunker rooms, kinds and placeBunker

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Migration: `kind` beside `colour`

**Files:**
- Modify: `packages/db/src/schema.ts` (the `airdropEvents` table, about lines 1895-1922)
- Create: `packages/db/migrations/0064_<generated>.sql` and its `meta/` snapshot (by drizzle-kit)
- Test: `packages/db/test/airdrop-events.test.ts`

**Interfaces:** Produces `airdropEvents.kind: "boom" | "guns" | null` and `airdropEvents.colour: "blue" | "orange" | "yellow" | null`.

- [ ] **Step 1: Write the failing tests.** Append inside `describe("airdrop_events")` in `packages/db/test/airdrop-events.test.ts`:

```ts
  it("takes a bunker row: a kind and no colour", async () => {
    await db.insert(airdropEvents).values(row({ colour: null, kind: "guns", location: "nwaf" }));
    expect((await db.select().from(airdropEvents))[0]).toMatchObject({ kind: "guns", colour: null });
  });
  it("refuses both a colour and a kind, or neither", async () => {
    await expect(db.insert(airdropEvents).values(row({ kind: "boom" }))).rejects.toThrow();
    await expect(db.insert(airdropEvents).values(row({ colour: null }))).rejects.toThrow();
  });
  it("refuses a kind outside the two", async () => {
    await expect(db.insert(airdropEvents).values(row({ colour: null, kind: "nukes" }))).rejects.toThrow();
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd packages/db && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/airdrop-events.test.ts`
Expected: FAIL (type error or a NOT NULL violation on `colour`).

- [ ] **Step 3: Edit the schema.** In `airdropEvents`, replace the `colour` line with:

```ts
  /** A Livonia airdrop's container colour. Null on bunker rows (since 2026-10-07). */
  colour: text("colour").$type<"blue" | "orange" | "yellow">(),
  /**
   * A bunker's template (spec 2026-10-07-bunker-online §6). Null on the Livonia
   * airdrops that predate it. ⚠️ Exactly one of `colour` and `kind` is set: a row
   * with neither could never be placed, and one with both would be read two ways.
   */
  kind: text("kind").$type<"boom" | "guns">(),
```

and in the table's checks, after `colourValid`, add:

```ts
  kindValid: check("airdrop_events_kind_valid", sql`${t.kind} IN ('boom','guns')`),
  colourXorKind: check("airdrop_events_colour_xor_kind", sql`(${t.colour} IS NULL) <> (${t.kind} IS NULL)`),
```

- [ ] **Step 4: Generate and read the migration**

```bash
cd packages/db && npx drizzle-kit generate && ls migrations/*.sql | tail -1 && cat "$(ls migrations/*.sql | tail -1)"
```

Expected: a new `0064_*.sql` containing exactly `ALTER TABLE "airdrop_events" ALTER COLUMN "colour" DROP NOT NULL;`, `ADD COLUMN "kind" text;` and the two `ADD CONSTRAINT … CHECK` statements. If it contains anything else, stop and fix the schema edit; never hand-edit around drizzle-kit's output.

- [ ] **Step 5: Run the DB tests and watch them pass**

Run: `cd packages/db && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/airdrop-events.test.ts && npx tsc --noEmit -p .`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations packages/db/test/airdrop-events.test.ts
git commit -q -m "airdrop_events: kind beside colour, exactly one set

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The server side: stage the bunker, register one path

**Files:**
- Modify: `packages/domain/src/airdrops.ts` (`AirdropSpec`, `airdropSpawnerPath`, `chooseAirdrop`)
- Modify: `packages/domain/test/airdrops.test.ts` (the catalogue, spawner-path and `chooseAirdrop` tests)
- Create: `apps/bot/src/bunker-stage.ts`; test `apps/bot/test/bunker-stage.test.ts`
- Modify: `apps/bot/src/cfggameplay.ts` (`setAirdropSpawner`, about lines 92-150)
- Modify: `apps/bot/src/restart-tick.ts` (`GameplayEdits.airdrop`, `airdropIntent`, the airdrop block about lines 414-445 and 565-620, `restartMessage` and its call)
- Modify: `apps/bot/src/airdrop-tick.ts` (the decision insert, about lines 169-188)
- Rewrite: `apps/bot/test/airdrop-flip.test.ts`; modify `apps/bot/test/cfggameplay.test.ts`, `apps/bot/test/airdrop-tick.test.ts` and `apps/bot/test/restart-tick.test.ts` where they pass a colour spec to the splice or expect `airdrop-<loc>-<colour>.json` (rows inserted only to block a slot keep their colour: still valid)

**Interfaces:**
- Consumes: Task 2's `BUNKER_ROOMS`, `BUNKER_KINDS`, `BunkerKind`, `bunkerRoom`, `bunkerRoomName`, `BUNKER_SPAWNER_PATH`, `bunkerTemplateFile`, `placeBunker`; Task 3's `airdropEvents.kind`.
- Produces:
  - `type AirdropSpec = { location: string; kind: BunkerKind | null }` (`null` only for a pre-bunker row)
  - `chooseAirdrop(recent: string[], rng: () => number): { location: string; kind: BunkerKind }`
  - `setAirdropSpawner(json: string, on: boolean): { json: string; changed: boolean }`
  - `stageBunker(host: BunkerHost, spec: AirdropSpec): Promise<void>`, where `type BunkerHost = { missionRootDir(): Promise<string>; downloadFile(path: string): Promise<string>; uploadFile(dir: string, name: string, content: string): Promise<void> }`
  - `restartMessage(airdrop: string | null, koth?: string | null)`: `airdrop` is now a display name, printed `Bunker online at <name> next session.`

- [ ] **Step 1: Domain tests first.** In `packages/domain/test/airdrops.test.ts`, replace the imports of `AIRDROP_COLOURS, AIRDROP_LOCATIONS` and `airdropSpawnerPath` with `BUNKER_KINDS, BUNKER_ROOMS`, delete the catalogue and spawner-path tests (lines 13-26), and replace `describe("chooseAirdrop")` with:

```ts
describe("chooseAirdrop", () => {
  const slugs = BUNKER_ROOMS.map((r) => r.slug);
  it("never draws one of the last AIRDROP_NO_REPEAT rooms, and draws a kind", () => {
    const recent = slugs.slice(0, AIRDROP_NO_REPEAT);
    for (let i = 0; i < 200; i++) {
      const spec = chooseAirdrop([...recent], () => i / 200);
      expect(recent).not.toContain(spec.location);
      expect(slugs).toContain(spec.location);
      expect(BUNKER_KINDS).toContain(spec.kind);
    }
  });
  // ⚠️ An empty pool indexes undefined; the fallback is what keeps the tick alive.
  it("falls back to all 11 when every room is recent", () => {
    expect(slugs).toContain(chooseAirdrop([...slugs], () => 0).location);
  });
  it("draws both kinds", () => {
    expect(new Set([0, 0.99].map((r) => chooseAirdrop([], () => r).kind))).toEqual(new Set(["boom", "guns"]));
  });
});
```

- [ ] **Step 2: Bot staging test** `apps/bot/test/bunker-stage.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { placeBunker } from "@factions/domain";
import { stageBunker } from "../src/bunker-stage.js";

const exit = (customString: string, pos: number[], yaw: number) =>
  ({ name: "Land_Underground_Stairs_Exit", pos, ypr: [yaw, 0, 0], scale: 1, enableCEPersistency: 0, customString });
const ROOMS = JSON.stringify({ Objects: [exit("NWAF", [4765.7, 338.8, 10384.0], 149), exit("VMC", [4565.1, 317.7, 8275.3], -167)] });
const TEMPLATE = { Objects: [exit("", [2782.4, 25.9, 1195.4], 0),
  { name: "Land_Underground_Panel", pos: [2785.8, 28.2, 1196.1], ypr: [0, 0, 0], scale: 1, enableCEPersistency: 0, customString: "" }] };

function host(over: Record<string, string | undefined> = {}) {
  const files: Record<string, string | undefined> = {
    "/m/custom/keycard-rooms.json": ROOMS,
    "/m/custom/keycard-bunker-boom.json": JSON.stringify(TEMPLATE),
    "/m/custom/keycard-bunker-guns.json": JSON.stringify(TEMPLATE),
    ...over,
  };
  const uploadFile = vi.fn(async (_d: string, _n: string, _b: string) => {});
  return {
    uploadFile,
    target: {
      missionRootDir: async () => "/m",
      downloadFile: async (p: string) => { const v = files[p]; if (v === undefined) throw new Error(`404 ${p}`); return v; },
      uploadFile,
    },
  };
}

describe("stageBunker", () => {
  it("uploads the template placed on the room, as custom/bunker-online.json", async () => {
    const h = host();
    await stageBunker(h.target, { location: "nwaf", kind: "boom" });
    expect(h.uploadFile).toHaveBeenCalledTimes(1);
    const [dir, name, body] = h.uploadFile.mock.calls[0]!;
    expect([dir, name]).toEqual(["/m/custom", "bunker-online.json"]);
    expect(JSON.parse(body)).toEqual(placeBunker(TEMPLATE as never, { x: 4765.7, y: 338.8, z: 10384.0, yaw: 149 }));
  });
  for (const [what, spec, over, msg] of [
    ["a pre-bunker row with no kind", { location: "dolnik", kind: null }, {}, /no kind/],
    ["a room slug that is not a bunker room", { location: "dolnik", kind: "boom" }, {}, /dolnik is not a bunker room/],
    // ⚠️ Review focus 2: someone renamed the room in the chernarus repo.
    ["a room whose name is not in the server's rooms file", { location: "kamensk-military", kind: "boom" }, {}, /Kamensk Military.*not in .*keycard-rooms\.json/],
    ["a missing template", { location: "nwaf", kind: "guns" }, { "/m/custom/keycard-bunker-guns.json": undefined }, /keycard-bunker-guns\.json/],
    ["a missing rooms file", { location: "nwaf", kind: "boom" }, { "/m/custom/keycard-rooms.json": undefined }, /keycard-rooms\.json/],
    ["an unparseable template", { location: "nwaf", kind: "boom" }, { "/m/custom/keycard-bunker-boom.json": "{" }, /keycard-bunker-boom\.json/],
    ["a template with no stairs exit", { location: "nwaf", kind: "boom" }, { "/m/custom/keycard-bunker-boom.json": JSON.stringify({ Objects: [TEMPLATE.Objects[1]] }) }, /found 0/],
  ] as const) {
    it(`${what} throws and uploads nothing`, async () => {
      const h = host(over as Record<string, string | undefined>);
      await expect(stageBunker(h.target, spec as never)).rejects.toThrow(msg);
      expect(h.uploadFile).not.toHaveBeenCalled();
    });
  }
});
```

- [ ] **Step 3: Rewrite `apps/bot/test/airdrop-flip.test.ts`** for bunkers. Replace the file's `host` and `decide` helpers and the tests that name `airdrop-dolnik-blue.json` or `"dolnik"`:

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
const exit = (customString: string, pos: number[], yaw: number) =>
  ({ name: "Land_Underground_Stairs_Exit", pos, ypr: [yaw, 0, 0], scale: 1, enableCEPersistency: 0, customString });
const ROOMS = JSON.stringify({ Objects: [exit("NWAF", [4765.7, 338.8, 10384.0], 149)] });
const TEMPLATE = JSON.stringify({ Objects: [exit("", [2782.4, 25.9, 1195.4], 0),
  { name: "Land_Underground_Panel", pos: [2785.8, 28.2, 1196.1], ypr: [0, 0, 0], scale: 1, enableCEPersistency: 0, customString: "" }] });

/** A mission on a fake Nitrado. Every path not given 404s. */
function host(gameplay = GAMEPLAY, over: Record<string, string | undefined> = {}) {
  const files = new Map<string, string>(Object.entries({
    "/mission/cfggameplay.json": gameplay,
    "/mission/custom/keycard-rooms.json": ROOMS,
    "/mission/custom/keycard-bunker-boom.json": TEMPLATE,
    "/mission/custom/keycard-bunker-guns.json": TEMPLATE,
  }));
  for (const [k, v] of Object.entries(over)) { if (v === undefined) files.delete(k); else files.set(k, v); }
  const restart = vi.fn(async () => {});
  const uploads: string[] = [];
  const target = {
    status: vi.fn(async () => "started"), restart,
    missionDbDir: vi.fn(async () => "/db"), missionRootDir: vi.fn(async () => "/mission"),
    downloadFile: vi.fn(async (p: string) => { const v = files.get(p); if (v === undefined) throw new Error(`404 ${p}`); return v; }),
    uploadFile: vi.fn(async (d: string, n: string, b: string) => { uploads.push(`${d}/${n}`); files.set(`${d}/${n}`, b); }),
  } as unknown as RestartTarget;
  return {
    target, restart, uploads, file: (p: string) => files.get(p),
    spawners: () => JSON.parse(files.get("/mission/cfggameplay.json")!).WorldsData.objectSpawnersArr as string[],
  };
}
```

`decide()` inserts `location: "nwaf", colour: null, kind: "boom"` instead of `location: "dolnik", colour: "blue"`. The tests become:

```ts
  it("stages the bunker file, then registers it, and marks the row live", async () => {
    await decide();
    const h = host();
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    expect(h.spawners()).toContain("./custom/bunker-online.json");
    // ⚠️ The file first: a spawner registered before its file exists spawns nothing.
    expect(h.uploads.indexOf("/mission/custom/bunker-online.json")).toBeLessThan(h.uploads.indexOf("/mission/cfggameplay.json"));
    expect(JSON.parse(h.file("/mission/custom/bunker-online.json")!).Objects[0].name).toBe("Land_Underground_Panel");
    expect((await state())!.state).toBe("live");
  });

  it("takes it away at the next slot and marks the row ended", async () => {
    await decide({ state: "live" });
    const h = host(GAMEPLAY.replace('"./custom/admin-castle.json"', '"./custom/admin-castle.json",\n\t\t\t"./custom/bunker-online.json"'));
    await restartTick(db, () => h.target, { now: at("2026-09-21T22:00:03Z"), airdrop: { enabled: true } });
    expect(h.spawners()).not.toContain("./custom/bunker-online.json");
    expect((await state())!.state).toBe("ended");
  });

  it("never enables a row whose announcement has not posted", async () => {
    await decide({ announcedAt: null });
    const h = host();
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    expect(h.spawners()).not.toContain("./custom/bunker-online.json");
    expect(h.uploads).not.toContain("/mission/custom/bunker-online.json");
  });

  // ⚠️ Review focus 3: the file vanished mid-session; the re-converge puts it back first.
  it("puts a live bunker's file and entry back if something removed them during its session", async () => {
    await decide({ state: "live" });
    const h = host();
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    expect(h.file("/mission/custom/bunker-online.json")).toBeDefined();
    expect(h.spawners()).toContain("./custom/bunker-online.json");
  });

  it("names the room in the in-game restart warning, and only for that slot", async () => {
    await decide();
    const h = host();
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    expect(h.restart).toHaveBeenCalledWith(restartMessage("NWAF"));
    expect(restartMessage("NWAF")).toContain("Bunker online at NWAF next session.");
    expect(restartMessage(null)).toBe("Scheduled restart");
  });

  // ⚠️ Review focus 1: a row decided before the deploy (colour, no kind, a Livonia slug).
  it("counts a failed attempt for a pre-bunker row, registers nothing, and scrubs it at the second", async () => {
    await decide({ location: "dolnik", colour: "blue", kind: null, manual: true, detail: { by: "42" } });
    const h = host();
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    let row = (await state())!;
    expect(row.state).toBe("announced");
    expect(row.detail.enableAttempts).toBe(1);
    expect(row.detail.by).toBe("42");
    expect(h.spawners()).not.toContain("./custom/bunker-online.json");
    expect(h.restart).toHaveBeenCalledWith("Scheduled restart");
    await db.delete(serverRestarts);
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:04Z"), airdrop: { enabled: true } });
    row = (await state())!;
    expect(row.state).toBe("failed");
    expect(row.detail.enableAttempts).toBe(2);
  });

  it("counts a failed attempt when the template is missing, and uploads nothing", async () => {
    await decide();
    const h = host(GAMEPLAY, { "/mission/custom/keycard-bunker-boom.json": undefined });
    await restartTick(db, () => h.target, { now: at("2026-09-21T20:00:03Z"), airdrop: { enabled: true } });
    expect((await state())!.detail.enableAttempts).toBe(1);
    expect(String((await state())!.detail.error)).toMatch(/keycard-bunker-boom\.json/);
    expect(h.uploads).toEqual([]);
  });
```

Keep the file's other existing tests (the restart-POST failure, the flag off, and the evaluation throw), changing only their `decide()` data and any `airdrop-dolnik-blue.json` path to `./custom/bunker-online.json`. Add `serverRestarts` to the `@factions/db` import and to the `truncate` list.

- [ ] **Step 4: Splice test.** In `apps/bot/test/cfggameplay.test.ts`, change every `setAirdropSpawner(json, { location: …, colour: … })` to `setAirdropSpawner(json, true)`, every `setAirdropSpawner(json, null)` to `setAirdropSpawner(json, false)`, and every expected `./custom/airdrop-<loc>-<colour>.json` to `./custom/bunker-online.json`. Add:

```ts
  it("removes a leftover Livonia airdrop entry when the bunker goes on, rather than refusing", () => {
    const leftover = FIXTURE.replace('"./custom/admin-castle.json"', '"./custom/admin-castle.json",\n\t\t\t"./custom/airdrop-dolnik-blue.json"');
    const out = JSON.parse(setAirdropSpawner(leftover, true).json).WorldsData.objectSpawnersArr as string[];
    expect(out).toContain("./custom/bunker-online.json");
    expect(out.some((e) => e.includes("/airdrop-"))).toBe(false);
  });
```

(Use the file's existing fixture variable name in place of `FIXTURE`.)

- [ ] **Step 5: Run the tests and watch them fail**

Run: `cd packages/domain && npx vitest run test/airdrops.test.ts; cd ../../apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/bunker-stage.test.ts test/airdrop-flip.test.ts test/cfggameplay.test.ts`
Expected: FAIL (`chooseAirdrop` still returns colours, `stageBunker` does not exist, and `setAirdropSpawner` takes a spec).

- [ ] **Step 6: Domain implementation.** In `packages/domain/src/airdrops.ts`:
  - drop `AIRDROP_COLOURS` and `AIRDROP_LOCATIONS` from both the import from `./rules` and the re-export;
  - add `import { BUNKER_KINDS, BUNKER_ROOMS, type BunkerKind } from "./bunker";`;
  - delete `airdropSpawnerPath` and its doc comment;
  - replace the `AirdropSpec` type and `chooseAirdrop` with:

```ts
/**
 * What an event places: a bunker room and its template (spec 2026-10-07-bunker-online).
 * `kind` is null only on a row decided before bunkers existed; staging refuses it.
 */
export type AirdropSpec = { location: string; kind: BunkerKind | null };

/**
 * Pick a room and a kind: uniform across the 11 rooms less the last
 * `AIRDROP_NO_REPEAT` used, and 50/50 between the kinds.
 *
 * ⚠️ The fallback to the full list is not defensive padding: a no-repeat window
 * at or above the list's size empties the pool, and an empty pool indexes
 * undefined and throws inside the decision tick.
 */
export function chooseAirdrop(recentLocations: string[], rng: () => number): { location: string; kind: BunkerKind } {
  const recent = new Set(recentLocations.slice(0, AIRDROP_NO_REPEAT));
  const slugs = BUNKER_ROOMS.map((r) => r.slug);
  const pool = slugs.filter((l) => !recent.has(l));
  const from = pool.length > 0 ? pool : slugs;
  const location = from[Math.floor(rng() * from.length)]!;
  const kind = BUNKER_KINDS[Math.floor(rng() * BUNKER_KINDS.length)]!;
  return { location, kind };
}
```

In `packages/domain/src/rules.ts`, delete the `AIRDROP_LOCATIONS` doc comment and declaration and `AIRDROP_COLOURS` (they live in `bunker.ts` and the schema now).

- [ ] **Step 7: `apps/bot/src/bunker-stage.ts`**

```ts
import { BUNKER_SPAWNER_PATH, bunkerRoom, bunkerTemplateFile, placeBunker, type AirdropSpec, type SpawnerObject } from "@factions/domain";

export type BunkerHost = {
  missionRootDir(): Promise<string>;
  downloadFile(path: string): Promise<string>;
  uploadFile(remoteDir: string, fileName: string, content: string): Promise<void>;
};

const FILE = BUNKER_SPAWNER_PATH.slice("./custom/".length);

async function readJson(host: BunkerHost, path: string): Promise<{ Objects: SpawnerObject[] }> {
  // ⚠️ The path goes into the message: it lands in the row's `detail.error`, and an
  // operator told only "404" cannot tell which of three files to put back.
  const body = await host.downloadFile(path).catch((err: unknown) => {
    throw new Error(`${path} could not be read (${err instanceof Error ? err.message : String(err)})`);
  });
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch (err) { throw new Error(`${path} did not parse (${(err as Error).message})`); }
  const objects = (parsed as { Objects?: unknown })?.Objects;
  if (!Array.isArray(objects)) throw new Error(`${path} has no Objects array`);
  return { Objects: objects as SpawnerObject[] };
}

/**
 * Build and upload `custom/bunker-online.json` for `spec` (spec §5.2): the kind's
 * template, placed on the room as the SERVER's keycard-rooms.json has it.
 *
 * ⚠️ Throws on anything it cannot do, having uploaded nothing. The caller counts
 * that as a failed enable attempt and leaves `objectSpawnersArr` alone, so the
 * spawner is never registered over a missing or stale file.
 */
export async function stageBunker(host: BunkerHost, spec: AirdropSpec): Promise<void> {
  if (spec.kind === null) throw new Error(`the event at ${spec.location} has no kind: it was decided before bunkers existed`);
  const room = bunkerRoom(spec.location);
  if (!room) throw new Error(`${spec.location} is not a bunker room`);
  const custom = `${await host.missionRootDir()}/custom`;
  const rooms = await readJson(host, `${custom}/keycard-rooms.json`);
  // ⚠️ By name, from the server's file: a room renamed in the chernarus repo fails
  // here, named, instead of being placed where the vendored copy remembers it.
  const exits = rooms.Objects.filter((o) => o.name === "Land_Underground_Stairs_Exit" && o.customString === room.name);
  if (exits.length !== 1) throw new Error(`${room.name} is not in ${custom}/keycard-rooms.json exactly once (found ${exits.length})`);
  const e = exits[0]!;
  const template = await readJson(host, `${custom}/${bunkerTemplateFile(spec.kind)}`);
  const placed = placeBunker(template, { x: e.pos[0], y: e.pos[1], z: e.pos[2], yaw: e.ypr[0] });
  await host.uploadFile(custom, FILE, JSON.stringify(placed, null, 4) + "\n");
}
```

- [ ] **Step 8: `setAirdropSpawner`.** In `apps/bot/src/cfggameplay.ts`:
  - change the import to `import { BUNKER_SPAWNER_PATH, type ActiveFlag } from "@factions/domain";`;
  - replace `const AIRDROP_MARK = "/airdrop-";` and its comment with:

```ts
/**
 * What marks an element as this feature's. ⚠️ Both forms: a Livonia-era
 * `/airdrop-<loc>-<colour>.json` left in the file must be cleaned out by the next
 * bunker, not counted as a second registration and refused forever.
 */
const isFeatureEntry = (e: string) => e.includes("/airdrop-") || e.endsWith("/bunker-online.json");
```

  - change the signature to `export function setAirdropSpawner(json: string, on: boolean): { json: string; changed: boolean }`, update its doc's first line to "Set whether `WorldsData.objectSpawnersArr` registers the bunker spawner", and in the body replace `e.includes(AIRDROP_MARK)` with `isFeatureEntry(e)` everywhere, and `const wanted = spec ? airdropSpawnerPath(spec) : null;` with `const wanted = on ? BUNKER_SPAWNER_PATH : null;`. The splice body that follows keeps working unchanged, because it already removes every feature entry and adds `wanted`; confirm by reading lines 150-215 that each `AIRDROP_MARK` there has become `isFeatureEntry`.

- [ ] **Step 9: `restart-tick.ts`**

(a) The `GameplayEdits.airdrop` type and its result type become `{ wanted: AirdropSpec | null }` and `{ wanted: AirdropSpec | null; changed: boolean }` (unchanged names; `AirdropSpec` now carries `kind`). In `applyGameplay`, `setAirdropSpawner(json, edits.airdrop.wanted)` becomes `setAirdropSpawner(json, edits.airdrop.wanted !== null)`.

(b) In `airdropIntent`, change `wanted: holder ? { location: holder.location, colour: holder.colour } : null` to `wanted: holder ? { location: holder.location, kind: holder.kind } : null`.

(c) In the slot block, replace

```ts
        if (opts.airdrop?.enabled) {
          intent = await airdropIntent(db, s.id, slot.start);
          edits.airdrop = { wanted: intent.wanted };
          airdropLocation = intent.enabling?.location ?? intent.wanted?.location ?? null;
        }
```

with

```ts
        if (opts.airdrop?.enabled) {
          intent = await airdropIntent(db, s.id, slot.start);
          // ⚠️ The file BEFORE the splice, every slot the bunker is wanted: an opening
          // registers nothing it has not just uploaded, and a live bunker whose file
          // vanished mid-session gets it back. A staging failure leaves
          // `objectSpawnersArr` untouched and counts as a failed enable below.
          if (intent.wanted) {
            try {
              await stageBunker(nitrado, intent.wanted);
              edits.airdrop = { wanted: intent.wanted };
            } catch (err) {
              stageError = err instanceof Error ? err : new Error(String(err));
            }
          } else {
            edits.airdrop = { wanted: null };
          }
          const where = intent.enabling?.location ?? intent.wanted?.location ?? null;
          airdropLocation = where === null ? null : bunkerRoomName(where);
        }
```

and declare `let stageError: Error | undefined;` beside `let intent: AirdropIntent | undefined;`.

(d) In the bookkeeping block below, replace each use of `gameplay.airdropError` with `airdropError`, declared just after `const gameplay = await applyGameplay(...)` as:

```ts
        // A staging failure is the same fact as a refused splice: nothing
        // registered, one enable attempt spent (spec §5.2.1).
        const airdropError = stageError ?? gameplay.airdropError;
```

In that block's success arm, `enabled = { slotAt, location: intent.wanted!.location, colour: intent.wanted!.colour }` becomes `{ slotAt, location: intent.wanted!.location, kind: intent.wanted!.kind }`, and the `enabled` declaration's type changes `colour: string` to `kind: string | null`. Also change any log line that prints `colour` to print `kind`.

(e) `restartMessage`: change `if (airdrop) parts.push(\`Airdrop at ${cap(airdrop)} next session.\`);` to `if (airdrop) parts.push(\`Bunker online at ${cap(airdrop)} next session.\`);`. The parameter is now a display name, set at (c), so the call at about line 662 stays as it is.

(f) Add `stageBunker` (from `./bunker-stage.js`) and `bunkerRoomName` (from `@factions/domain`) to the imports.

- [ ] **Step 10: The decision insert** in `apps/bot/src/airdrop-tick.ts`. Replace the insert's values line and its comment with:

```ts
        serverId: s.id, slotAt: slot, location: spec.location, kind: spec.kind,
```

and the log line's `${spec.location}/${spec.colour}` with `${spec.location}/${spec.kind}`. In `apps/bot/test/airdrop-tick.test.ts`, change line 59 to `expect(post).toHaveBeenCalledWith(expect.stringContaining(bunkerRoomName(row!.location).toUpperCase()));` and line 60 to `expect(post.mock.calls[0]![0]).not.toMatch(new RegExp(row!.kind!, "i"));` (add `bunkerRoomName` to an `@factions/domain` import). Rows the file inserts directly with a `colour` stay; they are history.

- [ ] **Step 11: Run the tests and watch them pass**

Run: `cd packages/domain && npx vitest run test/airdrops.test.ts test/bunker.test.ts && npx tsc --noEmit -p . && cd ../../apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/bunker-stage.test.ts test/airdrop-flip.test.ts test/cfggameplay.test.ts test/airdrop-tick.test.ts test/restart-tick.test.ts && npx tsc --noEmit -p .`
Expected: PASS. Type errors left in `apps/bot/src/commands/airdrop.ts` (`AIRDROP_COLOURS` and `AIRDROP_LOCATIONS` are gone) are Task 5's; if `tsc` reports only that file, proceed.

- [ ] **Step 12: Commit**

```bash
git add -A packages/domain apps/bot/src/bunker-stage.ts apps/bot/src/cfggameplay.ts apps/bot/src/restart-tick.ts apps/bot/src/airdrop-tick.ts apps/bot/test
git commit -q -m "Stage the bunker before registering it; one spawner path

Spec 2026-10-07-bunker-online §5: the opening downloads keycard-rooms.json
and the kind's template from the server, uploads bunker-online.json placed
by placeBunker, then registers it. A staging failure is a failed enable
attempt. Rows carry kind; chooseAirdrop draws rooms and kinds.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: What players see: posts, `/bunker place`, the vote command, the show

**Files:**
- Modify: `apps/bot/src/airdrop-text.ts`, `apps/bot/src/airdrop-tick.ts` (the two post call sites)
- Create: `apps/bot/src/commands/bunker.ts`; delete `apps/bot/src/commands/airdrop.ts`; modify `apps/bot/src/commands/index.ts`
- Move: `apps/bot/test/airdrop-command.test.ts` → `apps/bot/test/bunker-command.test.ts`
- Modify: `apps/bot/src/commands/kothvote.ts:45`, `apps/bot/src/koth-vote-tick.ts:82`, and the tests that assert those strings
- Modify: `apps/show/src/story/events.ts` (`airdropsForWeek`), `apps/show/src/prompt/system.ts:57`, `apps/show/test/story/events.test.ts`
- Test: `apps/bot/test/airdrop-tick.test.ts` (the text tests, about line 351)

**Interfaces:**
- Consumes: `BUNKER_ROOMS`, `BUNKER_KINDS`, `bunkerRoom`, `bunkerRoomName`, `chooseAirdrop` (Tasks 2 and 4).
- Produces: `airdropText(roomName: string, slotAt: Date): string`, `scrubText(roomName: string): string`; `bunkerGroup: CommandGroup` (path `"bunker place"`).

- [ ] **Step 1: Text tests.** In `apps/bot/test/airdrop-tick.test.ts`, replace the text `describe` (about line 351) with:

```ts
describe("the bunker posts", () => {
  it("names the room, counts down by itself, asks for a punched card, and never names the kind", () => {
    const t = airdropText("Kamensk Military", at("2026-09-21T20:00:00Z"));
    expect(t.split("\n")[0]).toBe("**BUNKER ONLINE: KAMENSK MILITARY**");
    expect(t).toMatch(/^Opens at the restart, <t:\d+:R>\. Bring a punched card\.$/m);
    expect(t).not.toMatch(/boom|guns|explosive/i);
  });
  it("says plainly when it did not come online", () => {
    expect(scrubText("NWAF")).toBe("**BUNKER OFFLINE: NWAF**\nIt did not come online. The next one can come any day.");
  });
});
```

- [ ] **Step 2: Command test.** `git mv apps/bot/test/airdrop-command.test.ts apps/bot/test/bunker-command.test.ts`, then in it:
  - change the import to `import { bunkerGroup } from "../src/commands/bunker.js";`;
  - `const place = bunkerGroup.specs.find((s) => s.path === "bunker place")!.handler;`;
  - replace the input's `location` option with `room` (default `"nwaf"`) and `colour` with `kind`;
  - assert the inserted row is `{ location: "nwaf", kind: <asked or drawn>, colour: null, manual: true }`;
  - assert the reply starts `Announced: **NWAF**`;
  - change the refusal tests' expected text to `is not one of the 11 bunker rooms`, `is not one of the two kinds`, `A bunker is already announced or online. Only one at a time.` and `King of the Hill holds that session. No bunker on top of it.`

Add:

```ts
  it("leaves the kind to chance when it is not given, and never says it", async () => {
    const r = await place(ctx(), input({ kind: undefined }));
    const [row] = await ctx().db.select().from(airdropEvents);
    expect(["boom", "guns"]).toContain(row!.kind);
    expect(posted.join("\n")).not.toMatch(/boom|guns|explosive/i);
    expect(r.content).toContain("NWAF");
  });
```

(Adapt `ctx`, `input` and `posted` to the file's existing helper names.)

- [ ] **Step 3: Run them and watch them fail**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/airdrop-tick.test.ts test/bunker-command.test.ts`
Expected: FAIL (the old copy, and `../src/commands/bunker.js` does not exist).

- [ ] **Step 4: Copy.** Replace the two functions' bodies in `apps/bot/src/airdrop-text.ts`, keeping their ⚠️ doc comments but changing "the colour" to "the kind" in them:

```ts
export function airdropText(roomName: string, slotAt: Date): string {
  const when = rel(slotAt);
  return [
    `**BUNKER ONLINE: ${roomName.toUpperCase()}**`,
    `${when ? `Opens at the restart, ${when}.` : "Opens at the next restart."} Bring a punched card.`,
  ].join("\n");
}

export function scrubText(roomName: string): string {
  return [
    `**BUNKER OFFLINE: ${roomName.toUpperCase()}**`,
    "It did not come online. The next one can come any day.",
  ].join("\n");
}
```

In `apps/bot/src/airdrop-tick.ts`, the three call sites `airdropText(row.location, …)`, `airdropText(spec.location, slot)` and `scrubText(row.location)` pass `bunkerRoomName(<slug>)` instead (import it from `@factions/domain`).

- [ ] **Step 5: `apps/bot/src/commands/bunker.ts`**: a copy of `commands/airdrop.ts` with these changes, then `git rm apps/bot/src/commands/airdrop.ts`:
  - imports: `import { BUNKER_KINDS, BUNKER_ROOMS, bunkerRoom, chooseAirdrop, nextRestartAt, type BunkerKind } from "@factions/domain";`, and `airdropText` from `../airdrop-text.js`;
  - delete the `place` capitaliser;
  - the handler is renamed `placeBunker` → `placeBunkerCommand`, with its doc comment saying "Bring a bunker online by hand, for the next restart" and otherwise unchanged;
  - the validation becomes:

```ts
  if (!input.isAdmin) return reply("Only an admin can bring a bunker online.");
  if (!ctx.serverEvents) {
    return reply("AIRDROP_TICK is off, so nothing would ever bring this bunker online. Turn it on first.");
  }
  const room = bunkerRoom((input.string("room") ?? "").toLowerCase());
  if (!room) return reply(`${input.string("room") || "That"} is not one of the ${BUNKER_ROOMS.length} bunker rooms.`);
  const asked = input.string("kind")?.toLowerCase() ?? null;
  if (asked && !BUNKER_KINDS.includes(asked as BunkerKind)) return reply(`${asked} is not one of the two kinds.`);
  const kind = (asked ?? chooseAirdrop([], Math.random).kind) as BunkerKind;
```

  - the other replies: `"No active server to bring a bunker online on."`, `"A bunker is already announced or online. Only one at a time."`, `"King of the Hill holds that session. No bunker on top of it."`, and the post failure `"I could not post the announcement, so I have not brought the bunker online. Check SERVER_EVENTS_CHANNEL_ID."`;
  - the insert uses `location: room.slug, kind, colour: null`, and `airdropText(room.name, slot)`;
  - the success reply:

```ts
  return reply([
    `Announced: **${room.name}**, ${kind === "boom" ? "explosives" : "guns"}. Only you see the kind.`,
    `It comes online at the ${slot.toISOString()} restart and goes offline at the one after.`,
    "This one does not count against the weekly cap.",
  ].join("\n"));
```

  - the builder:

```ts
export const bunkerGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("bunker")
    .setDescription("Bring a bunker online by hand")
    // ⚠️ Discord's own gate, so the command is hidden from members rather than
    // merely refused. The handler checks again; see its comment.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((c) => c
      .setName("place")
      .setDescription("Bring a bunker online at the next restart, without spending the weekly cap")
      .addStringOption((o) => o
        .setName("room").setDescription("Which keycard room").setRequired(true)
        .addChoices(...BUNKER_ROOMS.map((r) => ({ name: r.name, value: r.slug }))))
      .addStringOption((o) => o
        .setName("kind").setDescription("What is inside (left off, it is rolled)").setRequired(false)
        .addChoices({ name: "Explosives", value: "boom" }, { name: "Guns", value: "guns" }))),
  specs: [{ path: "bunker place", handler: placeBunkerCommand }],
};
```

In `apps/bot/src/commands/index.ts`, replace `airdropGroup` with `bunkerGroup` in both the import (`./bunker.js`) and `GROUPS`.

- [ ] **Step 6: The vote command's wording.** `apps/bot/src/commands/kothvote.ts:45` becomes ``if (taken === "airdrop") return reply(`A bunker comes online at the ${hhmm(slot)} restart.`);`` and `apps/bot/src/koth-vote-tick.ts:82`'s reason becomes `` `${taken === "koth" ? "an event" : "a bunker"} took that restart` ``. Update any test asserting the old strings (`grep -rn "An airdrop is set\|an airdrop took" apps/bot/test`).

- [ ] **Step 7: The show.** In `apps/show/src/story/events.ts`'s `airdropsForWeek`, map `location: bunkerRoomName(r.location)` with the comment `// ⚠️ A name, never a slug: this reaches the script model as written.` (import from `@factions/domain`). In `apps/show/src/prompt/system.ts:57`, change the line to:

```
- airdrops: bunkers that came online this week (players call the event "bunker online": a keycard room opened for one session, with loot inside), with where and when. state "live" means it was still up when this data was pulled; "ended" means it has happened.
```

In `apps/show/test/story/events.test.ts`, the airdrop test's expected `location: "tarnow"` becomes `location: "Tarnow"`, and add:

```ts
  it("bunkers carry the room's name", async () => {
    await fx.airdrop({ location: "kamensk-military", slotAt: at(2, 22) });
    expect((await airdropsForWeek(db, read())).map((a) => a.location)).toContain("Kamensk Military");
  });
```

(If `fx.airdrop` writes a `colour`, that row is still valid: the check needs exactly one of colour and kind.)

- [ ] **Step 8: Run the bot and show suites**

Run: `cd /Users/steveharmeyer/Development/dayz-clan-wars/clan-wars && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --filter=@factions/bot --filter=@factions/show --filter=@factions/domain --filter=@factions/db --concurrency=1 --force --continue`
Expected: all pass except the two sibling-checkout drift checks (`koth-drift` presets, `bunker-drift`) if `../chernarus` has not pulled those PRs.

- [ ] **Step 9: Commit**

```bash
git add -A apps/bot apps/show
git commit -q -m "Players see bunker online: posts, /bunker place, the show

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Changelog, working notes, runbook, gate, PR

**Files:** Modify `CHANGELOG.md` and `CLAUDE.md`; create `docs/deploy/2026-10-07-bunker-online.md`.

- [ ] **Step 1: Changelog** under `## [Unreleased]` (merge into an existing `### Changed` if present):

```markdown
### Changed

- Airdrops are now bunkers. When one comes online, one of the 11 keycard rooms opens for a session with explosives or guns inside. The room is announced; what is inside is not. Bring a punched card: you get them from the locked containers on train wrecks.
```

- [ ] **Step 2: CLAUDE.md.** In the "Airdrop events" row of "Where things live", replace its first cell with `Bunker online (was airdrop events: one of the 11 keycard rooms comes online for one session with the boom or guns template; internal names stay "airdrop")`. Prepend to its second cell: `Rooms, kinds and placement in packages/domain/src/bunker.ts (placeBunker, BUNKER_ROOMS, vendored from chernarus/custom/keycard-rooms.json, held by bunker-drift.test.ts); the opening stages custom/bunker-online.json in apps/bot/src/bunker-stage.ts BEFORE the splice registers it; /bunker place replaces /airdrop place. Spec docs/superpowers/specs/2026-10-07-bunker-online-design.md.` Replace "`/airdrop place` in `apps/bot/src/commands/airdrop.ts`" with "`/bunker place` in `apps/bot/src/commands/bunker.ts`", and "The `livonia` repo FTPs `cfggameplay.json`" with "The `chernarus` repo FTPs `cfggameplay.json`".

- [ ] **Step 3: Runbook** `docs/deploy/2026-10-07-bunker-online.md`:

```markdown
# Deploy: bunker online (2026-10-07)

Spec `docs/superpowers/specs/2026-10-07-bunker-online-design.md`. Migration 0064
(additive: `airdrop_events.colour` nullable, `kind`, exactly-one check) is applied
by the release deployer.

1. **Chernarus first.** The room-renames PR is merged and its Release has deployed
   (`custom/keycard-rooms.json` says Kamensk Military, Pavlovo Military, Tisy
   Military, Zelenogorsk). The templates `custom/keycard-bunker-boom.json` and
   `-guns.json` are on the server.
2. **Switch the automatic event off** on the host, before tagging the release:
   back up `.env` (`cp -p .env .env.bak-<UTC>-bunker`), set `AIRDROP_TICK=0`,
   `sudo -n systemctl restart clan-wars-bot`, and confirm the startup line says the
   airdrop tick is off. This stops the automatic event deciding a bunker between
   the release and the live check. ⚠️ With it off, `/bunker place` refuses
   ("AIRDROP_TICK is off"), which is why step 4 turns it back on first.
3. **Release clan-wars** and wait for `[DEPLOYED]` in `journalctl -u clan-wars-deploy`.
4. **Live check on production.** Set `AIRDROP_TICK=1` again and restart the bot.
   Immediately, before the automatic tick's next decision instant (30 min before a
   restart), run `/bunker place room:<any> kind:boom` for the next restart. From
   then on the manual bunker itself keeps the automatic event away: the
   one-at-a-time guard while it is announced or live, then the 24 h gap after it
   (manual events hold the gap), which is the window for this check. After
   that restart, an admin walks into the room and confirms the door panel, the
   lever, the crates and the loot sit inside it, the right way round. A
   misplacement is gone at the restart after; if one is seen, set `AIRDROP_TICK=0`
   again and report it.
5. Once step 4 passes, leave `AIRDROP_TICK=1`. Nothing else changes in `.env`.
```

- [ ] **Step 4: Full gate**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force --continue 2>&1 | grep -E "Tasks:|FAIL  test"`
Expected: `32 successful, 32 total`, or 31 with only the sibling-checkout drift failures named in Global Constraints. Ledger which.

- [ ] **Step 5: Commit, push, PR**

```bash
git add CHANGELOG.md CLAUDE.md docs/deploy/2026-10-07-bunker-online.md
git commit -q -m "Changelog, working notes and runbook for bunker online

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -q -u origin feature/bunker-online
gh pr create --base main --title "Bunker online (replaces airdrops on Chernarus)" --body "Implements docs/superpowers/specs/2026-10-07-bunker-online-design.md (plan: docs/superpowers/plans/2026-10-07-bunker-online.md). Ship after the chernarus room-renames PR; follow docs/deploy/2026-10-07-bunker-online.md (AIRDROP_TICK off around the live check).

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
