# Ingest & Flag Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest DayZ ADM server logs into an append-only event log and project every territory-flag raise, lower, placement, and fold into queryable state keyed by a durable flagpole identity.

**Architecture:** A pnpm + turbo TypeScript monorepo on Postgres (Drizzle). Raw ADM files are read from disk, captured losslessly into `raw_lines`, parsed into typed events appended to an idempotent `events` table, and folded by a projector into `poles` and `flag_changes` read models. Parsing is pure and file-per-event-type; nothing in the parser touches the database.

**Tech Stack:** Node ≥20, pnpm 9, TypeScript 5.6 (strict), Drizzle ORM, Postgres 16, vitest 2, turbo 2.

**Spec:** `docs/superpowers/specs/2026-08-26-factions-design.md`

## Global Constraints

- Node ≥ 20; pnpm 9; ES modules only (`"type": "module"`); relative imports carry the `.js` extension.
- TypeScript `strict: true` **and** `noUncheckedIndexedAccess: true`. No `any`.
- Package namespace is `@factions/*`.
- DayZ player UID is exactly **40 uppercase hex characters**.
- Every faction-scoped and pole-scoped table carries the composite tenancy key **`(server_id, map)`** — even though only one server is live at launch.
- Flagpole coordinates are normalized to **2 decimal places (1cm)** before being used as an identity key. Never compare raw floats.
- **Player `pos=<…>` is `<x, z, altitude>`. Flagpole `at <…>` is `<x, altitude, z>`.** These orderings differ within the same log line. All parsing returns the normalized shape `Vec3 = { x, y, z }` where `y` is always altitude.
- Pole coordinates must never reach a public-facing read model (spec §11). Nothing in this plan exposes them; later plans must not either.
- Tests use vitest. DB-backed suites require `TEST_DATABASE_URL`.

---

## File Structure

```
factions/
├── package.json                  workspace root, turbo scripts
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── docker-compose.yml            postgres for local dev + tests
├── packages/
│   ├── domain/                   shared types with no dependencies
│   │   └── src/
│   │       ├── vec3.ts           Vec3, poleKey
│   │       ├── events.ts         EventType union, payload types
│   │       └── index.ts
│   ├── adm-parser/               pure functions, no I/O, no db
│   │   └── src/
│   │       ├── coords.ts         parsePlayerPos, parsePoleAt, inMapBounds
│   │       ├── identity.ts       parseIdentity (gamertag + 40-hex uid)
│   │       ├── flag.ts           parseFlagChange (raised/lowered)
│   │       ├── flagpole.ts       parseFlagPole (kit/fold/build/dismantle)
│   │       ├── playerlist.ts     parseRosterHeader, parsePlayerListEntry
│   │       ├── timestamps.ts     parseBootHeader, parseLocalTime, resolveTimestamp
│   │       ├── parse-line.ts     dispatch → ParsedLine[]
│   │       └── index.ts
│   ├── db/                       drizzle schema + client + migrator
│   │   └── src/{schema.ts,client.ts,migrate.ts,index.ts}
│   └── event-log/                append + cursor helpers
│       └── src/{append.ts,cursor.ts,index.ts}
└── apps/
    ├── ingest-worker/            ADM files → raw_lines → events
    │   └── src/{read-adm-file.ts,ingest.ts,main.ts}
    └── projector/                events → poles, flag_changes
        └── src/{fold.ts,run.ts,main.ts}
```

**Boundaries.** `adm-parser` is pure and depends only on `domain`; it can be exercised entirely with string fixtures. `db` owns schema and connection and knows nothing about parsing. `event-log` is a thin, idempotent write path. The two apps are the only places I/O and business rules meet.

---

## Task 1: Workspace scaffold and coordinate parsing

The two coordinate orderings are the single highest-risk detail in the whole system — getting them backwards silently corrupts every pole identity. They come first, with the trap encapsulated so callers cannot get it wrong.

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.gitignore`
- Create: `packages/domain/package.json`, `packages/domain/tsconfig.json`, `packages/domain/src/vec3.ts`, `packages/domain/src/index.ts`
- Create: `packages/adm-parser/package.json`, `packages/adm-parser/tsconfig.json`, `packages/adm-parser/src/coords.ts`, `packages/adm-parser/src/index.ts`
- Test: `packages/adm-parser/test/coords.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Vec3 = { x: number; y: number; z: number }` (y is altitude); `parsePlayerPos(raw: string): Vec3 | null`; `parsePoleAt(raw: string): Vec3 | null`; `inMapBounds(x: number, z: number): boolean`.

- [ ] **Step 1: Create the workspace root files**

`package.json`:
```json
{
  "name": "factions",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "packageManager": "pnpm@9.12.0",
  "scripts": {
    "test": "turbo run test --concurrency=1",
    "typecheck": "turbo run typecheck",
    "ci": "turbo run typecheck test --concurrency=1"
  },
  "devDependencies": {
    "turbo": "^2.1.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "@types/node": "^22.0.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "typecheck": {},
    "test": {}
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true
  }
}
```

`.gitignore`:
```
node_modules/
dist/
.turbo/
*.log
.env
.env.local
```

- [ ] **Step 2: Create the two package manifests**

`packages/domain/package.json`:
```json
{
  "name": "@factions/domain",
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit", "test": "vitest run --passWithNoTests" },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^2.1.0" }
}
```

`packages/adm-parser/package.json`:
```json
{
  "name": "@factions/adm-parser",
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit", "test": "vitest run" },
  "dependencies": { "@factions/domain": "workspace:*" },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^2.1.0" }
}
```

Both `tsconfig.json` files are identical:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

- [ ] **Step 3: Write the failing test**

`packages/adm-parser/test/coords.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parsePlayerPos, parsePoleAt, inMapBounds } from "../src/index.js";

// Real line from production. Note the two orderings inside ONE line:
//   player pos=<x, z, altitude>   pole at <x, altitude, z>
const FLAG_LINE =
  '12:55:19 | Player "XxBE4zyxX" (id=D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1 ' +
  'pos=<2993.0, 1139.0, 448.3>) has lowered Flag_Livonia on TerritoryFlag ' +
  'at <2991.569092, 447.946503, 1138.587646>';

describe("parsePlayerPos", () => {
  it("reads pos=<x, z, altitude> into Vec3 with y as altitude", () => {
    expect(parsePlayerPos(FLAG_LINE)).toEqual({ x: 2993.0, y: 448.3, z: 1139.0 });
  });

  it("returns null when there is no pos block", () => {
    expect(parsePlayerPos('11:00:00 | Player "A" (id=AB) is connected')).toBeNull();
  });

  it("rejects the off-map sentinel in full decimal expansion", () => {
    const sentinel = "-340282346638528859811704183484516925440.0";
    expect(parsePlayerPos(`pos=<${sentinel}, ${sentinel}, 0>`)).toBeNull();
  });

  it("rejects coordinates outside map bounds", () => {
    expect(parsePlayerPos("pos=<99999.0, 100.0, 5.0>")).toBeNull();
  });
});

describe("parsePoleAt", () => {
  it("reads at <x, altitude, z> into Vec3 with y as altitude", () => {
    expect(parsePoleAt(FLAG_LINE)).toEqual({ x: 2991.569092, y: 447.946503, z: 1138.587646 });
  });

  it("does not confuse the player pos block for the pole block", () => {
    const pole = parsePoleAt(FLAG_LINE);
    const player = parsePlayerPos(FLAG_LINE);
    expect(pole).not.toEqual(player);
  });

  it("returns null on a line with no TerritoryFlag clause", () => {
    expect(parsePoleAt('Player "A" (id=AB pos=<100.0, 200.0, 5.0>) folded Flag Pole')).toBeNull();
  });
});

describe("inMapBounds", () => {
  it("accepts in-range horizontals", () => {
    expect(inMapBounds(2991.5, 1138.5)).toBe(true);
  });
  it("rejects out-of-range horizontals", () => {
    expect(inMapBounds(-5000, 1138.5)).toBe(false);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
pnpm install
pnpm --filter @factions/adm-parser test
```
Expected: FAIL — `Failed to resolve import "../src/index.js"`.

- [ ] **Step 5: Write the Vec3 type**

`packages/domain/src/vec3.ts`:
```ts
/** A world position. `y` is ALWAYS altitude, regardless of the source line's field order. */
export type Vec3 = { x: number; y: number; z: number };
```

`packages/domain/src/index.ts`:
```ts
export * from "./vec3.js";
```

- [ ] **Step 6: Write the coordinate parsers**

`packages/adm-parser/src/coords.ts`:
```ts
import type { Vec3 } from "@factions/domain";

/** Player position: `pos=<x, z, altitude>` — the two horizontals come FIRST. */
const PLAYER_POS_RE = /pos=<\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\s*>/u;

/** Flagpole position: `on TerritoryFlag at <x, altitude, z>` — altitude is in the MIDDLE. */
const POLE_AT_RE = /on TerritoryFlag at <\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\s*>/u;

/**
 * Off-map sentinel. DayZ writes an unresolved position in FULL DECIMAL
 * EXPANSION (-340282346638528859811704183484516925440.0), never in e-notation
 * — a pattern written against `-3.4e38` matches nothing. See spec §13.
 */
const SENTINEL_RE = /<\s*-?\d*\.?\d+e/iu;

const MAP_MIN = -1000.0;
const MAP_MAX = 16360.0;

export function inMapBounds(x: number, z: number): boolean {
  return x >= MAP_MIN && x <= MAP_MAX && z >= MAP_MIN && z <= MAP_MAX;
}

export function parsePlayerPos(raw: string): Vec3 | null {
  if (SENTINEL_RE.test(raw)) return null;
  const m = PLAYER_POS_RE.exec(raw);
  if (!m) return null;
  const x = parseFloat(m[1]!);
  const z = parseFloat(m[2]!);
  const y = parseFloat(m[3]!);
  if (!inMapBounds(x, z)) return null;
  return { x, y, z };
}

export function parsePoleAt(raw: string): Vec3 | null {
  if (SENTINEL_RE.test(raw)) return null;
  const m = POLE_AT_RE.exec(raw);
  if (!m) return null;
  const x = parseFloat(m[1]!);
  const y = parseFloat(m[2]!);
  const z = parseFloat(m[3]!);
  if (!inMapBounds(x, z)) return null;
  return { x, y, z };
}
```

`packages/adm-parser/src/index.ts`:
```ts
export * from "./coords.js";
```

- [ ] **Step 7: Run the test to verify it passes**

```bash
pnpm --filter @factions/adm-parser test
pnpm turbo run typecheck
```
Expected: PASS, 9 tests. Typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: workspace scaffold and ADM coordinate parsing

Player pos and flagpole at-coords use different field orderings in the
same log line. Both parsers normalize to Vec3 with y as altitude."
```

---

## Task 2: Player identity and pole key normalization

**Files:**
- Create: `packages/adm-parser/src/identity.ts`
- Create: `packages/domain/src/pole-key.ts`
- Modify: `packages/domain/src/index.ts`, `packages/adm-parser/src/index.ts`
- Test: `packages/adm-parser/test/identity.test.ts`, `packages/domain/test/pole-key.test.ts`

**Interfaces:**
- Consumes: `Vec3` from Task 1.
- Produces: `parseIdentity(raw: string): { gamertag: string; dayzId: string } | null`; `poleKey(at: Vec3): string`; `POLE_KEY_PRECISION = 2`.

- [ ] **Step 1: Write the failing tests**

`packages/adm-parser/test/identity.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseIdentity } from "../src/index.js";

describe("parseIdentity", () => {
  it("extracts gamertag and 40-hex uid", () => {
    const raw = '12:55:19 | Player "XxBE4zyxX" (id=D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1 pos=<1.0, 2.0, 3.0>) has raised Flag_DayZ';
    expect(parseIdentity(raw)).toEqual({
      gamertag: "XxBE4zyxX",
      dayzId: "D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1",
    });
  });

  it("handles gamertags containing spaces", () => {
    const raw = '10:59:52 | Player "Cee Lo GREEN 96" (id=7B1D53CE555E30DD016FBFBA9BCA0AFFD565BEB4) is connected';
    expect(parseIdentity(raw)?.gamertag).toBe("Cee Lo GREEN 96");
  });

  it("returns null when the id is not 40 hex characters", () => {
    expect(parseIdentity('Player "A" (id=SHORT pos=<1.0, 2.0, 3.0>)')).toBeNull();
  });

  it("returns null on a line with no player clause", () => {
    expect(parseIdentity("13:00:07 | ##### PlayerList log: 2 players")).toBeNull();
  });
});
```

`packages/domain/test/pole-key.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { poleKey } from "../src/index.js";

describe("poleKey", () => {
  it("rounds to 1cm and joins with colons", () => {
    expect(poleKey({ x: 2991.569092, y: 447.946503, z: 1138.587646 })).toBe("2991.57:447.95:1138.59");
  });

  it("is stable across float noise below 1cm", () => {
    const a = poleKey({ x: 2991.569092, y: 447.946503, z: 1138.587646 });
    const b = poleKey({ x: 2991.5691, y: 447.9465, z: 1138.5876 });
    expect(a).toBe(b);
  });

  it("distinguishes poles more than 1cm apart", () => {
    const a = poleKey({ x: 2991.57, y: 447.95, z: 1138.59 });
    const b = poleKey({ x: 2991.59, y: 447.95, z: 1138.59 });
    expect(a).not.toBe(b);
  });

  it("always emits two decimal places", () => {
    expect(poleKey({ x: 100, y: 0, z: -5.1 })).toBe("100.00:0.00:-5.10");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @factions/adm-parser test
pnpm --filter @factions/domain test
```
Expected: FAIL — `parseIdentity is not exported`, `poleKey is not exported`.

- [ ] **Step 3: Write the implementations**

`packages/adm-parser/src/identity.ts`:
```ts
const IDENTITY_RE = /Player "([^"]+)"\s*\(id=([0-9A-F]{40})(?![0-9A-F])/u;

export function parseIdentity(raw: string): { gamertag: string; dayzId: string } | null {
  const m = IDENTITY_RE.exec(raw);
  if (!m) return null;
  return { gamertag: m[1]!, dayzId: m[2]! };
}
```

`packages/domain/src/pole-key.ts`:
```ts
import type { Vec3 } from "./vec3.js";

/** Decimal places retained in a pole identity key. 2 == 1cm. */
export const POLE_KEY_PRECISION = 2;

/**
 * Stable identity for a flagpole.
 *
 * Observed `at <...>` coordinates were byte-identical across five weeks of production
 * events, but float formatting is not a contract. Rounding to 1cm makes the key robust
 * without merging genuinely distinct poles — DayZ will not let two flagpoles stand 1cm apart.
 */
export function poleKey(at: Vec3): string {
  const f = (n: number): string => n.toFixed(POLE_KEY_PRECISION);
  return `${f(at.x)}:${f(at.y)}:${f(at.z)}`;
}
```

Add to `packages/domain/src/index.ts`:
```ts
export * from "./pole-key.js";
```

Add to `packages/adm-parser/src/index.ts`:
```ts
export * from "./identity.js";
```

Add `"test": "vitest run"` to `packages/domain/package.json` scripts, replacing `--passWithNoTests`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @factions/adm-parser test
pnpm --filter @factions/domain test
```
Expected: PASS, 8 tests total.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: player identity parsing and 1cm pole key normalization"
```

---

## Task 3: Flag raise and lower parsing

**Files:**
- Create: `packages/adm-parser/src/flag.ts`
- Modify: `packages/adm-parser/src/index.ts`
- Test: `packages/adm-parser/test/flag.test.ts`

**Interfaces:**
- Consumes: `parsePlayerPos`, `parsePoleAt` (Task 1), `parseIdentity` (Task 2), `Vec3`.
- Produces:
```ts
type FlagChangeAction = "raised" | "lowered";
type FlagChange = {
  gamertag: string; dayzId: string;
  action: FlagChangeAction;
  texture: string;        // "Flag_Livonia" — full class name, verbatim
  player: Vec3 | null;
  pole: Vec3;
};
parseFlagChange(raw: string): FlagChange | null;
```

- [ ] **Step 1: Write the failing test**

`packages/adm-parser/test/flag.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseFlagChange } from "../src/index.js";

const RAISED =
  '05:17:25 | Player "XxBE4zyxX" (id=D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1 ' +
  'pos=<2992.5, 1137.4, 448.1>) has raised Flag_Livonia on TerritoryFlag ' +
  'at <2991.569092, 447.946503, 1138.587646>';

const LOWERED =
  '18:25:04 | Player "kpolanco1834" (id=DA18FD2AB3A071758A5B3BA8397C1E5307DF91AB ' +
  'pos=<2993.1, 1137.3, 447.9>) has lowered Flag_Bohemia on TerritoryFlag ' +
  'at <2991.569092, 447.946503, 1138.587646>';

describe("parseFlagChange", () => {
  it("parses a raise", () => {
    expect(parseFlagChange(RAISED)).toEqual({
      gamertag: "XxBE4zyxX",
      dayzId: "D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1",
      action: "raised",
      texture: "Flag_Livonia",
      player: { x: 2992.5, y: 448.1, z: 1137.4 },
      pole: { x: 2991.569092, y: 447.946503, z: 1138.587646 },
    });
  });

  it("parses a lower", () => {
    const r = parseFlagChange(LOWERED);
    expect(r?.action).toBe("lowered");
    expect(r?.texture).toBe("Flag_Bohemia");
  });

  it("keeps the full texture class name including the Flag_ prefix", () => {
    expect(parseFlagChange(RAISED)?.texture).toBe("Flag_Livonia");
  });

  it("gives the same pole coords for both events at one pole", () => {
    expect(parseFlagChange(RAISED)?.pole).toEqual(parseFlagChange(LOWERED)?.pole);
  });

  it("parses multi-word textures such as Flag_LivoniaPolice", () => {
    const raw = RAISED.replace("Flag_Livonia", "Flag_LivoniaPolice");
    expect(parseFlagChange(raw)?.texture).toBe("Flag_LivoniaPolice");
  });

  it("returns null on a flagpole build line", () => {
    expect(parseFlagChange('Player "A" (id=D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1 pos=<1.0, 2.0, 3.0>)Built base on Flag Pole with Sledgehammer')).toBeNull();
  });

  it("returns null on a non-flag line", () => {
    expect(parseFlagChange('Player "A" (id=D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1) is connected')).toBeNull();
  });

  it("returns null when the pole coords are missing", () => {
    expect(parseFlagChange('Player "A" (id=D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1 pos=<1.0, 2.0, 3.0>) has raised Flag_DayZ on TerritoryFlag')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @factions/adm-parser test
```
Expected: FAIL — `parseFlagChange is not exported`.

- [ ] **Step 3: Write the implementation**

`packages/adm-parser/src/flag.ts`:
```ts
import type { Vec3 } from "@factions/domain";
import { parsePlayerPos, parsePoleAt } from "./coords.js";
import { parseIdentity } from "./identity.js";

export type FlagChangeAction = "raised" | "lowered";

export type FlagChange = {
  gamertag: string;
  dayzId: string;
  action: FlagChangeAction;
  texture: string;
  player: Vec3 | null;
  pole: Vec3;
};

const FLAG_CHANGE_RE = /has (raised|lowered) (\S+) on TerritoryFlag/u;

export function parseFlagChange(raw: string): FlagChange | null {
  const m = FLAG_CHANGE_RE.exec(raw);
  if (!m) return null;

  const who = parseIdentity(raw);
  if (!who) return null;

  // A flag change without pole coordinates cannot be bound to an identity, so it is
  // unusable downstream. Drop it rather than emit an event with no key.
  const pole = parsePoleAt(raw);
  if (!pole) return null;

  return {
    gamertag: who.gamertag,
    dayzId: who.dayzId,
    action: m[1]! as FlagChangeAction,
    texture: m[2]!,
    player: parsePlayerPos(raw),
    pole,
  };
}
```

Add to `packages/adm-parser/src/index.ts`:
```ts
export * from "./flag.js";
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @factions/adm-parser test
```
Expected: PASS, 8 flag tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: parse territory flag raise and lower events"
```

---

## Task 4: Flagpole lifecycle parsing

`placed Flag Pole Kit`, `folded Flag Pole`, `Built <part> on Flag Pole`, and `Dismantled <part> from Flag Pole` all describe the pole itself.

**These lines carry no `at <…>` clause** — only the acting player's position. Pole identity for them must be resolved later by proximity to a known pole (Task 11). The parser records the player position and leaves binding to the projector.

**Files:**
- Create: `packages/adm-parser/src/flagpole.ts`
- Modify: `packages/adm-parser/src/index.ts`
- Test: `packages/adm-parser/test/flagpole.test.ts`

**Interfaces:**
- Consumes: `parsePlayerPos`, `parseIdentity`, `Vec3`.
- Produces:
```ts
type FlagPoleAction = "placed_kit" | "folded" | "built" | "dismantled";
type FlagPoleEvent = {
  gamertag: string; dayzId: string;
  action: FlagPoleAction;
  part: string | null;   // "base" | "support" | "pole" | "Base" — null for kit/fold
  tool: string | null;
  player: Vec3 | null;
};
parseFlagPole(raw: string): FlagPoleEvent | null;
```

- [ ] **Step 1: Write the failing test**

`packages/adm-parser/test/flagpole.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseFlagPole } from "../src/index.js";

const ID = "7D7BE4A8627CF9B969DA293B3A72F3369DFD8D8E";

describe("parseFlagPole", () => {
  it("parses a placed flag pole kit", () => {
    const raw = `19:12:44 | Player "Popin 0ps" (id=${ID} pos=<12470.7, 2386.4, 9.5>) placed Flag Pole Kit<TerritoryFlagKit>`;
    expect(parseFlagPole(raw)).toEqual({
      gamertag: "Popin 0ps",
      dayzId: ID,
      action: "placed_kit",
      part: null,
      tool: null,
      player: { x: 12470.7, y: 9.5, z: 2386.4 },
    });
  });

  it("parses a folded flag pole", () => {
    const raw = `09:18:49 | Player "Popin 0ps" (id=${ID} pos=<12469.7, 2387.5, 9.5>) folded Flag Pole`;
    const r = parseFlagPole(raw);
    expect(r?.action).toBe("folded");
    expect(r?.part).toBeNull();
  });

  it("parses a build step, capturing part and tool", () => {
    // NOTE: real logs have NO space between ')' and 'Built'.
    const raw = `09:32:26 | Player "XxBE4zyxX" (id=${ID} pos=<2992.5, 1137.1, 447.9>)Built base on Flag Pole with Sledgehammer`;
    const r = parseFlagPole(raw);
    expect(r?.action).toBe("built");
    expect(r?.part).toBe("base");
    expect(r?.tool).toBe("Sledgehammer");
  });

  it("parses a dismantle step", () => {
    const raw = `12:24:32 | Player "Popin 0ps" (id=${ID} pos=<12469.0, 2387.6, 9.4>)Dismantled Base from Flag Pole with Sledgehammer`;
    const r = parseFlagPole(raw);
    expect(r?.action).toBe("dismantled");
    expect(r?.part).toBe("Base");
    expect(r?.tool).toBe("Sledgehammer");
  });

  it("returns null for a raise, which is a flag change not a pole change", () => {
    const raw = `05:17:25 | Player "A" (id=${ID} pos=<1.0, 2.0, 3.0>) has raised Flag_Livonia on TerritoryFlag at <1.0, 3.0, 2.0>`;
    expect(parseFlagPole(raw)).toBeNull();
  });

  it("returns null for building a fence, which is not a flag pole", () => {
    const raw = `10:00:00 | Player "A" (id=${ID} pos=<1.0, 2.0, 3.0>)Built wall_base_down on Fence with Hammer`;
    expect(parseFlagPole(raw)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @factions/adm-parser test
```
Expected: FAIL — `parseFlagPole is not exported`.

- [ ] **Step 3: Write the implementation**

`packages/adm-parser/src/flagpole.ts`:
```ts
import type { Vec3 } from "@factions/domain";
import { parsePlayerPos } from "./coords.js";
import { parseIdentity } from "./identity.js";

export type FlagPoleAction = "placed_kit" | "folded" | "built" | "dismantled";

export type FlagPoleEvent = {
  gamertag: string;
  dayzId: string;
  action: FlagPoleAction;
  part: string | null;
  tool: string | null;
  player: Vec3 | null;
};

const PLACED_KIT_RE = /placed Flag Pole Kit<TerritoryFlagKit>/u;
const FOLDED_RE = /folded Flag Pole\s*$/u;
// No space before "Built"/"Dismantled" in real logs: `pos=<...>)Built base on Flag Pole`.
const BUILT_RE = /\)\s*Built (\S+) on Flag Pole(?: with (.+?))?\s*$/u;
const DISMANTLED_RE = /\)\s*Dismantled (\S+) from Flag Pole(?: with (.+?))?\s*$/u;

export function parseFlagPole(raw: string): FlagPoleEvent | null {
  const who = parseIdentity(raw);
  if (!who) return null;

  const base = {
    gamertag: who.gamertag,
    dayzId: who.dayzId,
    player: parsePlayerPos(raw),
  };

  if (PLACED_KIT_RE.test(raw)) {
    return { ...base, action: "placed_kit", part: null, tool: null };
  }
  if (FOLDED_RE.test(raw)) {
    return { ...base, action: "folded", part: null, tool: null };
  }

  const built = BUILT_RE.exec(raw);
  if (built) {
    return { ...base, action: "built", part: built[1]!, tool: built[2]?.trim() ?? null };
  }

  const dismantled = DISMANTLED_RE.exec(raw);
  if (dismantled) {
    return { ...base, action: "dismantled", part: dismantled[1]!, tool: dismantled[2]?.trim() ?? null };
  }

  return null;
}
```

Add to `packages/adm-parser/src/index.ts`:
```ts
export * from "./flagpole.js";
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @factions/adm-parser test
```
Expected: PASS, 6 flagpole tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: parse flagpole placement, folding, build and dismantle"
```

---

## Task 5: PlayerList block parsing

The 5-minute position dump. Body lines look like any other player line except that **nothing follows the closing paren** — that is the only discriminator, so the regex must anchor to end of line.

**Files:**
- Create: `packages/adm-parser/src/playerlist.ts`
- Modify: `packages/adm-parser/src/index.ts`
- Test: `packages/adm-parser/test/playerlist.test.ts`

**Interfaces:**
- Consumes: `parsePlayerPos`, `parseIdentity`, `Vec3`.
- Produces: `parseRosterHeader(raw: string): { count: number } | null`; `isRosterTerminator(raw: string): boolean`; `parsePlayerListEntry(raw: string): { gamertag: string; dayzId: string; pos: Vec3 } | null`.

- [ ] **Step 1: Write the failing test**

`packages/adm-parser/test/playerlist.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseRosterHeader, isRosterTerminator, parsePlayerListEntry } from "../src/index.js";

const ID = "13D36CE8B8FEB71D08B02F15FBFD8A7E2640FAD7";

describe("parseRosterHeader", () => {
  it("reads the player count", () => {
    expect(parseRosterHeader("13:00:07 | ##### PlayerList log: 2 players")).toEqual({ count: 2 });
  });
  it("handles a zero-player dump", () => {
    expect(parseRosterHeader("13:00:07 | ##### PlayerList log: 0 players")).toEqual({ count: 0 });
  });
  it("returns null on a normal line", () => {
    expect(parseRosterHeader('Player "A" (id=AB) is connected')).toBeNull();
  });
});

describe("isRosterTerminator", () => {
  it("matches the closing marker", () => {
    expect(isRosterTerminator("13:00:07 | #####")).toBe(true);
  });
  it("does not match the header", () => {
    expect(isRosterTerminator("13:00:07 | ##### PlayerList log: 2 players")).toBe(false);
  });
});

describe("parsePlayerListEntry", () => {
  it("parses a body line ending at the closing paren", () => {
    const raw = `13:00:07 | Player "LowerMarrow774" (id=${ID} pos=<9958.4, 7440.6, 176.4>)`;
    expect(parsePlayerListEntry(raw)).toEqual({
      gamertag: "LowerMarrow774",
      dayzId: ID,
      pos: { x: 9958.4, y: 176.4, z: 7440.6 },
    });
  });

  it("returns null when a verb follows the paren", () => {
    const raw = `13:00:07 | Player "LowerMarrow774" (id=${ID} pos=<9958.4, 7440.6, 176.4>) folded Flag Pole`;
    expect(parsePlayerListEntry(raw)).toBeNull();
  });

  it("returns null for a hit line, which also has trailing content", () => {
    const raw = `13:01:05 | Player "LowerMarrow774" (id=${ID} pos=<9958.3, 7440.8, 176.3>)[HP: 99.1563] hit by BarrelHoles_Yellow with FireDamage`;
    expect(parsePlayerListEntry(raw)).toBeNull();
  });

  it("tolerates trailing whitespace", () => {
    const raw = `13:00:07 | Player "LowerMarrow774" (id=${ID} pos=<9958.4, 7440.6, 176.4>)   `;
    expect(parsePlayerListEntry(raw)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @factions/adm-parser test
```
Expected: FAIL — exports missing.

- [ ] **Step 3: Write the implementation**

`packages/adm-parser/src/playerlist.ts`:
```ts
import type { Vec3 } from "@factions/domain";
import { parsePlayerPos } from "./coords.js";
import { parseIdentity } from "./identity.js";

const HEADER_RE = /#####\s*PlayerList log:\s*(\d+)\s*players?/u;
const TERMINATOR_RE = /#####\s*$/u;
/** A dump body line ends at the closing paren — nothing follows it. */
const ENTRY_RE = /Player "[^"]+"\s*\(id=[0-9A-F]{40}\s+pos=<[^>]*>\)\s*$/u;

export function parseRosterHeader(raw: string): { count: number } | null {
  const m = HEADER_RE.exec(raw);
  if (!m) return null;
  return { count: parseInt(m[1]!, 10) };
}

export function isRosterTerminator(raw: string): boolean {
  if (HEADER_RE.test(raw)) return false;
  return TERMINATOR_RE.test(raw);
}

export function parsePlayerListEntry(
  raw: string,
): { gamertag: string; dayzId: string; pos: Vec3 } | null {
  if (!ENTRY_RE.test(raw)) return null;
  const who = parseIdentity(raw);
  if (!who) return null;
  const pos = parsePlayerPos(raw);
  if (!pos) return null;
  return { gamertag: who.gamertag, dayzId: who.dayzId, pos };
}
```

Add to `packages/adm-parser/src/index.ts`:
```ts
export * from "./playerlist.js";
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @factions/adm-parser test
```
Expected: PASS, 9 playerlist tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: parse the 5-minute PlayerList position dump"
```

---

## Task 6: Timestamp reconstruction

ADM lines carry only a local `HH:MM:SS`. The absolute date comes from the file's boot header, and the clock rolls past midnight within a single file.

**Files:**
- Create: `packages/adm-parser/src/timestamps.ts`
- Modify: `packages/adm-parser/src/index.ts`
- Test: `packages/adm-parser/test/timestamps.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseBootHeader(raw: string): Date | null`; `parseLocalTime(raw: string): { h: number; m: number; s: number } | null`; `class TimelineCursor` with `constructor(bootUtc: Date)`, `advance(raw: string): Date | null`.

- [ ] **Step 1: Write the failing test**

`packages/adm-parser/test/timestamps.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseBootHeader, parseLocalTime, TimelineCursor } from "../src/index.js";

describe("parseBootHeader", () => {
  it("reads the AdminLog boot line as UTC", () => {
    const d = parseBootHeader("AdminLog started on 2026-07-22 at 07:01:37");
    expect(d?.toISOString()).toBe("2026-07-22T07:01:37.000Z");
  });
  it("returns null on a normal line", () => {
    expect(parseBootHeader('Player "A" (id=AB) is connected')).toBeNull();
  });
});

describe("parseLocalTime", () => {
  it("reads the leading HH:MM:SS field", () => {
    expect(parseLocalTime("07:52:16 | Player \"A\" (id=AB) is connected")).toEqual({ h: 7, m: 52, s: 16 });
  });
  it("returns null when there is no time field", () => {
    expect(parseLocalTime("##### PlayerList log: 2 players")).toBeNull();
  });
});

describe("TimelineCursor", () => {
  it("resolves a line on the boot date", () => {
    const c = new TimelineCursor(new Date("2026-07-22T07:01:37.000Z"));
    expect(c.advance("07:52:16 | x")?.toISOString()).toBe("2026-07-22T07:52:16.000Z");
  });

  it("rolls forward one day when the clock wraps past midnight", () => {
    const c = new TimelineCursor(new Date("2026-07-22T23:58:00.000Z"));
    expect(c.advance("23:59:00 | x")?.toISOString()).toBe("2026-07-22T23:59:00.000Z");
    expect(c.advance("00:01:00 | x")?.toISOString()).toBe("2026-07-23T00:01:00.000Z");
  });

  it("does not roll forward on equal timestamps", () => {
    const c = new TimelineCursor(new Date("2026-07-22T10:00:00.000Z"));
    c.advance("10:00:00 | x");
    expect(c.advance("10:00:00 | y")?.toISOString()).toBe("2026-07-22T10:00:00.000Z");
  });

  it("returns null for a line with no time field", () => {
    const c = new TimelineCursor(new Date("2026-07-22T07:01:37.000Z"));
    expect(c.advance("##### PlayerList log: 2 players")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @factions/adm-parser test
```
Expected: FAIL — exports missing.

- [ ] **Step 3: Write the implementation**

`packages/adm-parser/src/timestamps.ts`:
```ts
const BOOT_RE = /AdminLog started on (\d{4})-(\d{2})-(\d{2}) at (\d{2}):(\d{2}):(\d{2})/u;
const LOCAL_TIME_RE = /(?:^|\|)\s*(\d{2}):(\d{2}):(\d{2})\s*\|/u;

/**
 * The ADM header names the file's start, in SERVER-LOCAL wall-clock time (DayZ
 * never writes UTC). Date.UTC is used only to build a fixed-field instant; the
 * per-server clockOffsetMs converts it to a real UTC instant downstream.
 * See spec §13, "Timestamps are server-local, not UTC".
 */
export function parseBootHeader(raw: string): Date | null {
  const m = BOOT_RE.exec(raw);
  if (!m) return null;
  return new Date(
    Date.UTC(
      parseInt(m[1]!, 10), parseInt(m[2]!, 10) - 1, parseInt(m[3]!, 10),
      parseInt(m[4]!, 10), parseInt(m[5]!, 10), parseInt(m[6]!, 10),
    ),
  );
}

export function parseLocalTime(raw: string): { h: number; m: number; s: number } | null {
  const m = LOCAL_TIME_RE.exec(raw);
  if (!m) return null;
  return { h: parseInt(m[1]!, 10), m: parseInt(m[2]!, 10), s: parseInt(m[3]!, 10) };
}

const DAY_MS = 86_400_000;

/**
 * Walks one ADM file, turning each line's local HH:MM:SS into an absolute instant.
 *
 * A single file can span midnight; the only signal is the clock going backwards, so the
 * cursor rolls the date forward whenever it does. Must be fed lines in file order.
 */
export class TimelineCursor {
  #dayStartMs: number;
  #lastMs: number;

  constructor(bootUtc: Date) {
    const t = bootUtc.getTime();
    this.#dayStartMs = Math.floor(t / DAY_MS) * DAY_MS;
    this.#lastMs = t;
  }

  advance(raw: string): Date | null {
    const lt = parseLocalTime(raw);
    if (!lt) return null;

    const offset = (lt.h * 3600 + lt.m * 60 + lt.s) * 1000;
    let ms = this.#dayStartMs + offset;

    if (ms < this.#lastMs) {
      this.#dayStartMs += DAY_MS;
      ms += DAY_MS;
    }

    this.#lastMs = ms;
    return new Date(ms);
  }
}
```

Add to `packages/adm-parser/src/index.ts`:
```ts
export * from "./timestamps.js";
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @factions/adm-parser test
```
Expected: PASS, 8 timestamp tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: reconstruct absolute timestamps from ADM boot header and local time"
```

---

## Task 7: Line dispatch

**Files:**
- Create: `packages/domain/src/events.ts`
- Create: `packages/adm-parser/src/parse-line.ts`
- Modify: `packages/domain/src/index.ts`, `packages/adm-parser/src/index.ts`
- Test: `packages/adm-parser/test/parse-line.test.ts`

**Interfaces:**
- Consumes: every parser from Tasks 3–5.
- Produces:
```ts
type EventType = "flag.raised" | "flag.lowered" | "flagpole.placed"
               | "flagpole.folded" | "flagpole.built" | "flagpole.dismantled"
               | "player.position";
type ParsedLine =
  | { kind: "flag"; change: FlagChange }
  | { kind: "flagpole"; event: FlagPoleEvent }
  | { kind: "roster"; count: number }
  | { kind: "position"; gamertag: string; dayzId: string; pos: Vec3 };
parseLine(raw: string): ParsedLine[];
eventTypeFor(line: ParsedLine): EventType | null;
```

**Dispatch order is a persistence contract.** `subIndex` on an appended event is this array's index. Reordering entries renumbers historical events and collides with the idempotency key. Primary events come first, position last.

- [ ] **Step 1: Write the failing test**

`packages/adm-parser/test/parse-line.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseLine, eventTypeFor } from "../src/index.js";

const ID = "D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1";
const RAISED =
  `05:17:25 | Player "XxBE4zyxX" (id=${ID} pos=<2992.5, 1137.4, 448.1>) ` +
  "has raised Flag_Livonia on TerritoryFlag at <2991.569092, 447.946503, 1138.587646>";

describe("parseLine", () => {
  it("yields the flag change before anything else", () => {
    const out = parseLine(RAISED);
    expect(out[0]?.kind).toBe("flag");
  });

  it("does not emit a position entry for a flag line", () => {
    // The flag change already carries the player position; a second entry would be redundant.
    expect(parseLine(RAISED).filter((l) => l.kind === "position")).toHaveLength(0);
  });

  it("yields a position entry for a PlayerList body line", () => {
    const raw = `13:00:07 | Player "LowerMarrow774" (id=${ID} pos=<9958.4, 7440.6, 176.4>)`;
    const out = parseLine(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      kind: "position",
      gamertag: "LowerMarrow774",
      dayzId: ID,
      pos: { x: 9958.4, y: 176.4, z: 7440.6 },
    });
  });

  it("yields a roster entry for the dump header", () => {
    expect(parseLine("13:00:07 | ##### PlayerList log: 2 players")).toEqual([{ kind: "roster", count: 2 }]);
  });

  it("yields a flagpole entry for a fold", () => {
    const raw = `09:18:49 | Player "A" (id=${ID} pos=<12469.7, 2387.5, 9.5>) folded Flag Pole`;
    expect(parseLine(raw)[0]?.kind).toBe("flagpole");
  });

  it("yields nothing for an unrelated line", () => {
    expect(parseLine(`10:00:00 | Player "A" (id=${ID}) is connected`)).toEqual([]);
  });
});

describe("eventTypeFor", () => {
  it("maps a raise", () => {
    expect(eventTypeFor(parseLine(RAISED)[0]!)).toBe("flag.raised");
  });
  it("maps a fold", () => {
    const raw = `09:18:49 | Player "A" (id=${ID} pos=<12469.7, 2387.5, 9.5>) folded Flag Pole`;
    expect(eventTypeFor(parseLine(raw)[0]!)).toBe("flagpole.folded");
  });
  it("maps a position", () => {
    const raw = `13:00:07 | Player "A" (id=${ID} pos=<9958.4, 7440.6, 176.4>)`;
    expect(eventTypeFor(parseLine(raw)[0]!)).toBe("player.position");
  });
  it("returns null for a roster header, which is not persisted", () => {
    expect(eventTypeFor({ kind: "roster", count: 2 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @factions/adm-parser test
```
Expected: FAIL — `parseLine is not exported`.

- [ ] **Step 3: Write the event type union**

`packages/domain/src/events.ts`:
```ts
export type EventType =
  | "flag.raised"
  | "flag.lowered"
  | "flagpole.placed"
  | "flagpole.folded"
  | "flagpole.built"
  | "flagpole.dismantled"
  | "player.position";
```

Add to `packages/domain/src/index.ts`:
```ts
export * from "./events.js";
```

- [ ] **Step 4: Write the dispatcher**

`packages/adm-parser/src/parse-line.ts`:
```ts
import type { EventType, Vec3 } from "@factions/domain";
import { parseFlagChange, type FlagChange } from "./flag.js";
import { parseFlagPole, type FlagPoleEvent } from "./flagpole.js";
import { parseRosterHeader, parsePlayerListEntry } from "./playerlist.js";

export type ParsedLine =
  | { kind: "flag"; change: FlagChange }
  | { kind: "flagpole"; event: FlagPoleEvent }
  | { kind: "roster"; count: number }
  | { kind: "position"; gamertag: string; dayzId: string; pos: Vec3 };

/**
 * Every ParsedLine a single raw line yields, in a FIXED order.
 *
 * ⚠️ `subIndex` in the event log is this array's index. Changing the order renumbers
 * every historical event and collides with the idempotency unique index. Do not reorder.
 */
export function parseLine(raw: string): ParsedLine[] {
  const roster = parseRosterHeader(raw);
  if (roster) return [{ kind: "roster", count: roster.count }];

  const change = parseFlagChange(raw);
  if (change) return [{ kind: "flag", change }];

  const pole = parseFlagPole(raw);
  if (pole) return [{ kind: "flagpole", event: pole }];

  const entry = parsePlayerListEntry(raw);
  if (entry) {
    return [{ kind: "position", gamertag: entry.gamertag, dayzId: entry.dayzId, pos: entry.pos }];
  }

  return [];
}

export function eventTypeFor(line: ParsedLine): EventType | null {
  switch (line.kind) {
    case "flag":
      return line.change.action === "raised" ? "flag.raised" : "flag.lowered";
    case "flagpole":
      switch (line.event.action) {
        case "placed_kit": return "flagpole.placed";
        case "folded": return "flagpole.folded";
        case "built": return "flagpole.built";
        case "dismantled": return "flagpole.dismantled";
      }
    // eslint-disable-next-line no-fallthrough
    case "position":
      return "player.position";
    case "roster":
      return null;
  }
}
```

Add to `packages/adm-parser/src/index.ts`:
```ts
export * from "./parse-line.js";
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter @factions/adm-parser test
pnpm turbo run typecheck
```
Expected: PASS, 10 dispatch tests. Full parser suite green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: dispatch raw ADM lines to typed parsed events"
```

---

## Task 8: Database schema and migrations

**Files:**
- Create: `docker-compose.yml`
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/drizzle.config.ts`
- Create: `packages/db/src/schema.ts`, `packages/db/src/client.ts`, `packages/db/src/migrate.ts`, `packages/db/src/index.ts`
- Test: `packages/db/test/schema.test.ts`

**Interfaces:**
- Consumes: `EventType` from Task 7.
- Produces: tables `servers`, `admFiles`, `rawLines`, `events`, `consumerCursors`, `poles`, `flagChanges`; `type Database`; `createClient(url: string): Database`; `runMigrations(db: Database): Promise<void>`.

- [ ] **Step 1: Create docker-compose and the package manifest**

`docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: factions
      POSTGRES_PASSWORD: factions
      POSTGRES_DB: factions
    ports: ["5434:5432"]
    volumes: ["factions-pg:/var/lib/postgresql/data"]
volumes:
  factions-pg:
```

`packages/db/package.json`:
```json
{
  "name": "@factions/db",
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "generate": "drizzle-kit generate"
  },
  "dependencies": {
    "@factions/domain": "workspace:*",
    "drizzle-orm": "^0.36.0",
    "postgres": "^3.4.0"
  },
  "devDependencies": {
    "drizzle-kit": "^0.28.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/db/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test", "drizzle.config.ts"] }
```

`packages/db/drizzle.config.ts`:
```ts
import type { Config } from "drizzle-kit";

export default {
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://factions:factions@localhost:5434/factions" },
} satisfies Config;
```

- [ ] **Step 2: Write the failing test**

`packages/db/test/schema.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createClient, runMigrations, servers, poles, type Database } from "../src/index.js";
import { sql } from "drizzle-orm";

const URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL)("schema", () => {
  let db: Database;

  beforeAll(async () => {
    db = createClient(URL!);
    await runMigrations(db);
    await db.execute(sql`truncate table poles, events, raw_lines, adm_files, servers restart identity cascade`);
  });

  it("creates a server row", async () => {
    const [row] = await db.insert(servers).values({ name: "Livonia 10x", map: "livonia" }).returning();
    expect(row?.id).toBeGreaterThan(0);
  });

  it("enforces one pole key per (server, map)", async () => {
    const [srv] = await db.insert(servers).values({ name: "S2", map: "chernarus" }).returning();
    const base = {
      serverId: srv!.id, map: "chernarus",
      poleKey: "1.00:2.00:3.00", x: "1.00", y: "2.00", z: "3.00",
      firstSeenAt: new Date(), lastSeenAt: new Date(),
    };
    await db.insert(poles).values(base);
    await expect(db.insert(poles).values(base)).rejects.toThrow();
  });

  it("allows the same pole key on a different server", async () => {
    const [srv] = await db.insert(servers).values({ name: "S3", map: "chernarus" }).returning();
    const row = await db.insert(poles).values({
      serverId: srv!.id, map: "chernarus",
      poleKey: "1.00:2.00:3.00", x: "1.00", y: "2.00", z: "3.00",
      firstSeenAt: new Date(), lastSeenAt: new Date(),
    }).returning();
    expect(row).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
docker compose up -d postgres
export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"
pnpm --filter @factions/db test
```
Expected: FAIL — cannot resolve `../src/index.js`.

- [ ] **Step 4: Write the schema**

`packages/db/src/schema.ts`:
```ts
import {
  pgTable, bigserial, bigint, integer, text, timestamp, jsonb,
  uniqueIndex, index, numeric, boolean,
} from "drizzle-orm/pg-core";

export const servers = pgTable("servers", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  map: text("map").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqNameMap: uniqueIndex("servers_name_map_uniq").on(t.name, t.map),
}));

export const admFiles = pgTable("adm_files", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  filename: text("filename").notNull(),
  bootAt: timestamp("boot_at", { withTimezone: true }).notNull(),
  linesIngested: integer("lines_ingested").notNull().default(0),
  complete: boolean("complete").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqFile: uniqueIndex("adm_files_server_filename_uniq").on(t.serverId, t.filename),
}));

/** Lossless capture of every non-empty ADM line, so reprocessing never needs the origin server. */
export const rawLines = pgTable("raw_lines", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  admFileId: bigint("adm_file_id", { mode: "number" }).notNull().references(() => admFiles.id),
  lineIndex: integer("line_index").notNull(),
  content: text("content").notNull(),
}, (t) => ({
  uniqLine: uniqueIndex("raw_lines_file_line_uniq").on(t.admFileId, t.lineIndex),
}));

export const events = pgTable("events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  admFileId: bigint("adm_file_id", { mode: "number" }).notNull().references(() => admFiles.id),
  lineIndex: integer("line_index").notNull(),
  subIndex: integer("sub_index").notNull().default(0),
  type: text("type").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  payload: jsonb("payload").notNull(),
  rawLineId: bigint("raw_line_id", { mode: "number" }).references(() => rawLines.id),
}, (t) => ({
  uniqEvent: uniqueIndex("events_idempotency_uniq").on(t.serverId, t.admFileId, t.lineIndex, t.subIndex),
  byType: index("events_type_idx").on(t.type),
  byServerOccurred: index("events_server_occurred_idx").on(t.serverId, t.occurredAt),
}));

export const consumerCursors = pgTable("consumer_cursors", {
  consumerName: text("consumer_name").primaryKey(),
  lastEventId: bigint("last_event_id", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Projection: every flagpole ever observed.
 * Coordinates are numeric(10,2) — already rounded to the 1cm identity precision.
 * ⚠️ These coordinates must never reach a public read model (spec §11).
 */
export const poles = pgTable("poles", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  map: text("map").notNull(),
  poleKey: text("pole_key").notNull(),
  x: numeric("x", { precision: 10, scale: 2 }).notNull(),
  y: numeric("y", { precision: 10, scale: 2 }).notNull(),
  z: numeric("z", { precision: 10, scale: 2 }).notNull(),
  currentTexture: text("current_texture"),
  flagRaised: boolean("flag_raised").notNull().default(false),
  foldedAt: timestamp("folded_at", { withTimezone: true }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
}, (t) => ({
  uniqPole: uniqueIndex("poles_tenant_key_uniq").on(t.serverId, t.map, t.poleKey),
}));

/** Projection: the ordered history of raises and lowers at each pole. */
export const flagChanges = pgTable("flag_changes", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  eventId: bigint("event_id", { mode: "number" }).notNull().references(() => events.id),
  serverId: integer("server_id").notNull().references(() => servers.id),
  map: text("map").notNull(),
  poleKey: text("pole_key").notNull(),
  dayzId: text("dayz_id").notNull(),
  gamertag: text("gamertag").notNull(),
  action: text("action").notNull(),
  texture: text("texture").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
}, (t) => ({
  uniqChange: uniqueIndex("flag_changes_event_uniq").on(t.eventId),
  byPole: index("flag_changes_pole_idx").on(t.serverId, t.map, t.poleKey, t.occurredAt),
  byActor: index("flag_changes_actor_idx").on(t.dayzId, t.occurredAt),
}));
```

- [ ] **Step 5: Write the client and migrator**

`packages/db/src/client.ts`:
```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof createClient>;

export function createClient(url: string) {
  const sql = postgres(url, { max: 10 });
  return drizzle(sql, { schema });
}
```

`packages/db/src/migrate.ts`:
```ts
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Database } from "./client.js";

const here = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: join(here, "..", "migrations") });
}
```

`packages/db/src/index.ts`:
```ts
export * from "./schema.js";
export * from "./client.js";
export * from "./migrate.js";
```

- [ ] **Step 6: Generate the migration and run the test**

```bash
pnpm --filter @factions/db exec drizzle-kit generate
pnpm --filter @factions/db test
```
Expected: PASS, 3 schema tests.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: postgres schema for raw lines, events, poles and flag changes"
```

---

## Task 9: Event log append and cursor

**Files:**
- Create: `packages/event-log/package.json`, `packages/event-log/tsconfig.json`
- Create: `packages/event-log/src/append.ts`, `packages/event-log/src/cursor.ts`, `packages/event-log/src/index.ts`
- Test: `packages/event-log/test/append.test.ts`

**Interfaces:**
- Consumes: `Database`, `events`, `consumerCursors` (Task 8); `EventType` (Task 7).
- Produces:
```ts
type AppendEventInput = {
  serverId: number; admFileId: number; lineIndex: number; subIndex: number;
  type: EventType; occurredAt: Date; payload: unknown; rawLineId?: number;
};
appendEvent(db: Database, input: AppendEventInput): Promise<void>;
readCursor(db: Database, consumer: string): Promise<number>;
writeCursor(db: Database, consumer: string, lastEventId: number): Promise<void>;
```

- [ ] **Step 1: Create the package manifest**

`packages/event-log/package.json`:
```json
{
  "name": "@factions/event-log",
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit", "test": "vitest run" },
  "dependencies": {
    "@factions/db": "workspace:*",
    "@factions/domain": "workspace:*",
    "drizzle-orm": "^0.36.0"
  },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^2.1.0" }
}
```

`packages/event-log/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

- [ ] **Step 2: Write the failing test**

`packages/event-log/test/append.test.ts`:
```ts
import { describe, it, expect, beforeAll } from "vitest";
import { createClient, runMigrations, servers, admFiles, events, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { appendEvent, readCursor, writeCursor } from "../src/index.js";

const URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL)("event log", () => {
  let db: Database;
  let serverId: number;
  let admFileId: number;

  beforeAll(async () => {
    db = createClient(URL!);
    await runMigrations(db);
    await db.execute(sql`truncate table flag_changes, poles, events, raw_lines, adm_files, servers, consumer_cursors restart identity cascade`);
    const [srv] = await db.insert(servers).values({ name: "T", map: "livonia" }).returning();
    serverId = srv!.id;
    const [f] = await db.insert(admFiles).values({
      serverId, filename: "a.ADM", bootAt: new Date("2026-07-22T07:01:37Z"),
    }).returning();
    admFileId = f!.id;
  });

  const input = {
    serverId: 0, admFileId: 0, lineIndex: 5, subIndex: 0,
    type: "flag.raised" as const,
    occurredAt: new Date("2026-07-22T07:52:16Z"),
    payload: { texture: "Flag_Livonia" },
  };

  it("appends an event", async () => {
    await appendEvent(db, { ...input, serverId, admFileId });
    const rows = await db.select().from(events).where(eq(events.serverId, serverId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("flag.raised");
  });

  it("is idempotent on the (server, file, line, sub) key", async () => {
    await appendEvent(db, { ...input, serverId, admFileId });
    await appendEvent(db, { ...input, serverId, admFileId });
    const rows = await db.select().from(events).where(eq(events.serverId, serverId));
    expect(rows).toHaveLength(1);
  });

  it("treats a different subIndex as a distinct event", async () => {
    await appendEvent(db, { ...input, serverId, admFileId, subIndex: 1, type: "player.position" });
    const rows = await db.select().from(events).where(eq(events.serverId, serverId));
    expect(rows).toHaveLength(2);
  });

  it("returns 0 for an unknown consumer cursor", async () => {
    expect(await readCursor(db, "nobody")).toBe(0);
  });

  it("round-trips a cursor", async () => {
    await writeCursor(db, "projector", 42);
    expect(await readCursor(db, "projector")).toBe(42);
  });

  it("overwrites an existing cursor", async () => {
    await writeCursor(db, "projector", 99);
    expect(await readCursor(db, "projector")).toBe(99);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm --filter @factions/event-log test
```
Expected: FAIL — cannot resolve `../src/index.js`.

- [ ] **Step 4: Write the implementation**

`packages/event-log/src/append.ts`:
```ts
import type { Database } from "@factions/db";
import { events } from "@factions/db";
import type { EventType } from "@factions/domain";

export type AppendEventInput = {
  serverId: number;
  admFileId: number;
  lineIndex: number;
  subIndex: number;
  type: EventType;
  occurredAt: Date;
  payload: unknown;
  rawLineId?: number;
};

/** Append one event, ignoring duplicates on the (server, file, line, sub) idempotency key. */
export async function appendEvent(db: Database, input: AppendEventInput): Promise<void> {
  await db.insert(events).values({
    serverId: input.serverId,
    admFileId: input.admFileId,
    lineIndex: input.lineIndex,
    subIndex: input.subIndex,
    type: input.type,
    occurredAt: input.occurredAt,
    payload: input.payload as object,
    rawLineId: input.rawLineId,
  }).onConflictDoNothing({
    target: [events.serverId, events.admFileId, events.lineIndex, events.subIndex],
  });
}
```

`packages/event-log/src/cursor.ts`:
```ts
import type { Database } from "@factions/db";
import { consumerCursors } from "@factions/db";
import { eq } from "drizzle-orm";

export async function readCursor(db: Database, consumer: string): Promise<number> {
  const [row] = await db.select().from(consumerCursors)
    .where(eq(consumerCursors.consumerName, consumer));
  return row?.lastEventId ?? 0;
}

export async function writeCursor(db: Database, consumer: string, lastEventId: number): Promise<void> {
  await db.insert(consumerCursors)
    .values({ consumerName: consumer, lastEventId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: consumerCursors.consumerName,
      set: { lastEventId, updatedAt: new Date() },
    });
}
```

`packages/event-log/src/index.ts`:
```ts
export * from "./append.js";
export * from "./cursor.js";
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter @factions/event-log test
```
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: idempotent event append and consumer cursors"
```

---

## Task 10: Ingest worker

Reads ADM files from a directory, captures every line into `raw_lines`, and appends parsed events. Re-running over the same directory must be a no-op.

**Files:**
- Create: `apps/ingest-worker/package.json`, `apps/ingest-worker/tsconfig.json`
- Create: `apps/ingest-worker/src/read-adm-file.ts`, `apps/ingest-worker/src/ingest.ts`, `apps/ingest-worker/src/main.ts`
- Test: `apps/ingest-worker/test/ingest.test.ts`

**Interfaces:**
- Consumes: `parseLine`, `eventTypeFor`, `parseBootHeader`, `TimelineCursor` (Tasks 6–7); `appendEvent` (Task 9); db tables (Task 8).
- Produces: `readAdmFile(path: string): Promise<{ bootAt: Date; lines: string[] }>`; `ingestFile(db, opts): Promise<{ eventsAppended: number; linesCaptured: number }>` where `opts = { serverId: number; map: string; filename: string; bootAt: Date; lines: string[] }`.

- [ ] **Step 1: Create the package manifest**

`apps/ingest-worker/package.json`:
```json
{
  "name": "@factions/ingest-worker",
  "version": "0.0.0",
  "type": "module",
  "main": "src/main.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "start": "node --experimental-strip-types src/main.ts"
  },
  "dependencies": {
    "@factions/adm-parser": "workspace:*",
    "@factions/db": "workspace:*",
    "@factions/domain": "workspace:*",
    "@factions/event-log": "workspace:*",
    "drizzle-orm": "^0.36.0"
  },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^2.1.0", "@types/node": "^22.0.0" }
}
```

`apps/ingest-worker/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

- [ ] **Step 2: Write the failing test**

`apps/ingest-worker/test/ingest.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, servers, events, rawLines, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { ingestFile } from "../src/ingest.js";

const URL = process.env.TEST_DATABASE_URL;
const ID = "D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1";

const LINES = [
  "AdminLog started on 2026-07-22 at 07:01:37",
  `07:52:16 | Player "YrJustBad" (id=${ID} pos=<2993.4, 1135.7, 447.9>) placed Flag Pole Kit<TerritoryFlagKit>`,
  `10:21:40 | Player "YrJustBad" (id=${ID} pos=<2990.4, 1138.3, 448.0>) has raised Flag_Livonia on TerritoryFlag at <2991.569092, 447.946503, 1138.587646>`,
  "13:00:07 | ##### PlayerList log: 1 players",
  `13:00:07 | Player "YrJustBad" (id=${ID} pos=<9958.4, 7440.6, 176.4>)`,
  "13:00:07 | #####",
  `14:00:00 | Player "YrJustBad" (id=${ID}) is connected`,
];

describe.skipIf(!URL)("ingestFile", () => {
  let db: Database;
  let serverId: number;

  beforeEach(async () => {
    db = createClient(URL!);
    await runMigrations(db);
    await db.execute(sql`truncate table flag_changes, poles, events, raw_lines, adm_files, servers, consumer_cursors restart identity cascade`);
    const [srv] = await db.insert(servers).values({ name: "T", map: "livonia" }).returning();
    serverId = srv!.id;
  });

  const opts = () => ({
    serverId, map: "livonia", filename: "a.ADM",
    bootAt: new Date("2026-07-22T07:01:37Z"), lines: LINES,
  });

  it("captures every line losslessly", async () => {
    const r = await ingestFile(db, opts());
    expect(r.linesCaptured).toBe(LINES.length);
    expect(await db.select().from(rawLines)).toHaveLength(LINES.length);
  });

  it("appends only lines that parse to events", async () => {
    const r = await ingestFile(db, opts());
    // kit placement + raise + one position entry = 3. Roster header, terminator,
    // boot header and "is connected" produce no events.
    expect(r.eventsAppended).toBe(3);
  });

  it("resolves absolute timestamps from the boot header", async () => {
    await ingestFile(db, opts());
    const rows = await db.select().from(events).orderBy(events.lineIndex);
    expect(rows[1]?.occurredAt.toISOString()).toBe("2026-07-22T10:21:40.000Z");
  });

  it("stores the flag texture and pole key in the payload", async () => {
    await ingestFile(db, opts());
    const rows = await db.select().from(events).orderBy(events.lineIndex);
    const raise = rows.find((r) => r.type === "flag.raised");
    expect(raise?.payload).toMatchObject({
      texture: "Flag_Livonia",
      poleKey: "2991.57:447.95:1138.59",
    });
  });

  it("is idempotent when the same file is ingested twice", async () => {
    await ingestFile(db, opts());
    const second = await ingestFile(db, opts());
    expect(second.eventsAppended).toBe(0);
    expect(await db.select().from(events)).toHaveLength(3);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm --filter @factions/ingest-worker test
```
Expected: FAIL — cannot resolve `../src/ingest.js`.

- [ ] **Step 4: Write the file reader**

`apps/ingest-worker/src/read-adm-file.ts`:
```ts
import { readFile } from "node:fs/promises";
import { parseBootHeader } from "@factions/adm-parser";

/**
 * Reads one .ADM file. The boot header names the file's start instant; without it
 * no line in the file can be given an absolute timestamp, so the file is rejected.
 */
export async function readAdmFile(path: string): Promise<{ bootAt: Date; lines: string[] }> {
  const text = await readFile(path, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

  for (const line of lines) {
    const boot = parseBootHeader(line);
    if (boot) return { bootAt: boot, lines };
  }
  throw new Error(`No "AdminLog started on" header found in ${path}`);
}
```

- [ ] **Step 5: Write the ingest routine**

`apps/ingest-worker/src/ingest.ts`:
```ts
import type { Database } from "@factions/db";
import { admFiles, rawLines } from "@factions/db";
import { appendEvent } from "@factions/event-log";
import { poleKey } from "@factions/domain";
import { parseLine, eventTypeFor, TimelineCursor } from "@factions/adm-parser";
import { and, eq } from "drizzle-orm";

export type IngestOptions = {
  serverId: number;
  map: string;
  filename: string;
  bootAt: Date;
  lines: string[];
};

export type IngestResult = { linesCaptured: number; eventsAppended: number };

export async function ingestFile(db: Database, opts: IngestOptions): Promise<IngestResult> {
  const [file] = await db.insert(admFiles)
    .values({ serverId: opts.serverId, filename: opts.filename, bootAt: opts.bootAt })
    .onConflictDoNothing({ target: [admFiles.serverId, admFiles.filename] })
    .returning();

  const admFileId = file?.id ?? (await db.select().from(admFiles).where(
    and(eq(admFiles.serverId, opts.serverId), eq(admFiles.filename, opts.filename)),
  ))[0]!.id;

  const cursor = new TimelineCursor(opts.bootAt);
  let eventsAppended = 0;
  let linesCaptured = 0;

  for (let lineIndex = 0; lineIndex < opts.lines.length; lineIndex++) {
    const raw = opts.lines[lineIndex]!;

    const [stored] = await db.insert(rawLines)
      .values({ admFileId, lineIndex, content: raw })
      .onConflictDoNothing({ target: [rawLines.admFileId, rawLines.lineIndex] })
      .returning();
    if (stored) linesCaptured++;

    const occurredAt = cursor.advance(raw);
    if (!occurredAt) continue;

    const parsed = parseLine(raw);
    for (let subIndex = 0; subIndex < parsed.length; subIndex++) {
      const line = parsed[subIndex]!;
      const type = eventTypeFor(line);
      if (!type) continue;

      const before = await countEvents(db, opts.serverId, admFileId, lineIndex, subIndex);
      await appendEvent(db, {
        serverId: opts.serverId,
        admFileId,
        lineIndex,
        subIndex,
        type,
        occurredAt,
        payload: toPayload(line),
        rawLineId: stored?.id,
      });
      const after = await countEvents(db, opts.serverId, admFileId, lineIndex, subIndex);
      if (after > before) eventsAppended++;
    }
  }

  await db.update(admFiles)
    .set({ linesIngested: opts.lines.length, complete: true })
    .where(eq(admFiles.id, admFileId));

  return { linesCaptured, eventsAppended };
}

async function countEvents(
  db: Database, serverId: number, admFileId: number, lineIndex: number, subIndex: number,
): Promise<number> {
  const { events } = await import("@factions/db");
  const rows = await db.select().from(events).where(and(
    eq(events.serverId, serverId),
    eq(events.admFileId, admFileId),
    eq(events.lineIndex, lineIndex),
    eq(events.subIndex, subIndex),
  ));
  return rows.length;
}

/** Flatten a ParsedLine into the jsonb payload shape the projector reads. */
function toPayload(line: ReturnType<typeof parseLine>[number]): unknown {
  switch (line.kind) {
    case "flag":
      return {
        gamertag: line.change.gamertag,
        dayzId: line.change.dayzId,
        texture: line.change.texture,
        action: line.change.action,
        pole: line.change.pole,
        poleKey: poleKey(line.change.pole),
        player: line.change.player,
      };
    case "flagpole":
      return {
        gamertag: line.event.gamertag,
        dayzId: line.event.dayzId,
        action: line.event.action,
        part: line.event.part,
        tool: line.event.tool,
        player: line.event.player,
      };
    case "position":
      return { gamertag: line.gamertag, dayzId: line.dayzId, pos: line.pos };
    case "roster":
      return { count: line.count };
  }
}
```

- [ ] **Step 6: Write the entry point**

`apps/ingest-worker/src/main.ts`:
```ts
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createClient, servers } from "@factions/db";
import { and, eq } from "drizzle-orm";
import { readAdmFile } from "./read-adm-file.js";
import { ingestFile } from "./ingest.js";

const DATABASE_URL = process.env.DATABASE_URL;
const ADM_DIR = process.env.ADM_DIR;
const SERVER_NAME = process.env.SERVER_NAME;
const MAP = process.env.MAP;

if (!DATABASE_URL || !ADM_DIR || !SERVER_NAME || !MAP) {
  console.error("Set DATABASE_URL, ADM_DIR, SERVER_NAME and MAP.");
  process.exit(1);
}

const db = createClient(DATABASE_URL);

const [existing] = await db.select().from(servers)
  .where(and(eq(servers.name, SERVER_NAME), eq(servers.map, MAP)));
const server = existing ?? (await db.insert(servers)
  .values({ name: SERVER_NAME, map: MAP }).returning())[0]!;

const names = (await readdir(ADM_DIR)).filter((n) => n.endsWith(".ADM")).sort();

for (const filename of names) {
  const { bootAt, lines } = await readAdmFile(join(ADM_DIR, filename));
  const r = await ingestFile(db, { serverId: server.id, map: MAP, filename, bootAt, lines });
  console.log(`${filename}: ${r.linesCaptured} lines, ${r.eventsAppended} events`);
}

process.exit(0);
```

- [ ] **Step 7: Run the test to verify it passes**

```bash
pnpm --filter @factions/ingest-worker test
pnpm turbo run typecheck
```
Expected: PASS, 5 ingest tests.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: ingest worker reads ADM files into raw lines and events"
```

---

## Task 11: Pole and flag-change projector

Folds events into `poles` and `flag_changes`.

**Fold and kit events carry no pole coordinates** — only the acting player's position. They bind to the nearest known pole within 10m, which is sound because a player must stand at a pole to fold it. Unmatched fold events are skipped rather than guessed at.

**Files:**
- Create: `apps/projector/package.json`, `apps/projector/tsconfig.json`
- Create: `apps/projector/src/fold.ts`, `apps/projector/src/run.ts`, `apps/projector/src/main.ts`
- Test: `apps/projector/test/fold.test.ts`

**Interfaces:**
- Consumes: `events`, `poles`, `flagChanges` (Task 8); `readCursor`/`writeCursor` (Task 9).
- Produces: `applyEvent(db, event): Promise<void>`; `runProjector(db, opts?: { batchSize?: number }): Promise<number>` returning the count of events applied; `NEAREST_POLE_RADIUS_M = 10`.

- [ ] **Step 1: Create the package manifest**

`apps/projector/package.json`:
```json
{
  "name": "@factions/projector",
  "version": "0.0.0",
  "type": "module",
  "main": "src/main.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "start": "node --experimental-strip-types src/main.ts"
  },
  "dependencies": {
    "@factions/db": "workspace:*",
    "@factions/domain": "workspace:*",
    "@factions/event-log": "workspace:*",
    "drizzle-orm": "^0.36.0"
  },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^2.1.0", "@types/node": "^22.0.0" }
}
```

`apps/projector/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

- [ ] **Step 2: Write the failing test**

`apps/projector/test/fold.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, servers, admFiles, events, poles, flagChanges, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { runProjector } from "../src/run.js";

const URL = process.env.TEST_DATABASE_URL;
const ID = "D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1";
const POLE = { x: 2991.569092, y: 447.946503, z: 1138.587646 };
const KEY = "2991.57:447.95:1138.59";

describe.skipIf(!URL)("projector", () => {
  let db: Database;
  let serverId: number;
  let admFileId: number;
  let line = 0;

  beforeEach(async () => {
    db = createClient(URL!);
    await runMigrations(db);
    await db.execute(sql`truncate table flag_changes, poles, events, raw_lines, adm_files, servers, consumer_cursors restart identity cascade`);
    const [srv] = await db.insert(servers).values({ name: "T", map: "livonia" }).returning();
    serverId = srv!.id;
    const [f] = await db.insert(admFiles).values({
      serverId, filename: "a.ADM", bootAt: new Date("2026-07-22T00:00:00Z"),
    }).returning();
    admFileId = f!.id;
    line = 0;
  });

  const emit = async (type: string, payload: unknown, at: string) => {
    await db.insert(events).values({
      serverId, admFileId, lineIndex: line++, subIndex: 0,
      type, occurredAt: new Date(at), payload: payload as object,
    });
  };

  const raise = (texture: string, at: string) =>
    emit("flag.raised", { gamertag: "A", dayzId: ID, texture, action: "raised", pole: POLE, poleKey: KEY, player: null }, at);

  it("creates a pole on the first raise", async () => {
    await raise("Flag_Livonia", "2026-07-22T10:00:00Z");
    await runProjector(db);
    const rows = await db.select().from(poles);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.poleKey).toBe(KEY);
    expect(rows[0]?.flagRaised).toBe(true);
    expect(rows[0]?.currentTexture).toBe("Flag_Livonia");
  });

  it("does not duplicate the pole across many events", async () => {
    await raise("Flag_Livonia", "2026-07-22T10:00:00Z");
    await raise("Flag_Livonia", "2026-07-29T10:00:00Z");
    await runProjector(db);
    expect(await db.select().from(poles)).toHaveLength(1);
  });

  it("records each raise and lower in flag_changes", async () => {
    await raise("Flag_Livonia", "2026-07-22T10:00:00Z");
    await emit("flag.lowered", { gamertag: "B", dayzId: ID, texture: "Flag_Livonia", action: "lowered", pole: POLE, poleKey: KEY, player: null }, "2026-07-22T11:00:00Z");
    await runProjector(db);
    expect(await db.select().from(flagChanges)).toHaveLength(2);
  });

  it("clears flagRaised on a lower", async () => {
    await raise("Flag_Livonia", "2026-07-22T10:00:00Z");
    await emit("flag.lowered", { gamertag: "B", dayzId: ID, texture: "Flag_Livonia", action: "lowered", pole: POLE, poleKey: KEY, player: null }, "2026-07-22T11:00:00Z");
    await runProjector(db);
    const [p] = await db.select().from(poles);
    expect(p?.flagRaised).toBe(false);
  });

  it("tracks a texture change on the same pole", async () => {
    await raise("Flag_Livonia", "2026-07-22T10:00:00Z");
    await raise("Flag_Bohemia", "2026-07-23T10:00:00Z");
    await runProjector(db);
    const [p] = await db.select().from(poles);
    expect(p?.currentTexture).toBe("Flag_Bohemia");
  });

  it("binds a fold to the nearest pole within 10m", async () => {
    await raise("Flag_Livonia", "2026-07-22T10:00:00Z");
    await emit("flagpole.folded", {
      gamertag: "C", dayzId: ID, action: "folded", part: null, tool: null,
      player: { x: 2993.0, y: 448.0, z: 1139.0 },
    }, "2026-07-24T10:00:00Z");
    await runProjector(db);
    const [p] = await db.select().from(poles);
    expect(p?.foldedAt?.toISOString()).toBe("2026-07-24T10:00:00.000Z");
  });

  it("ignores a fold with no pole within 10m", async () => {
    await raise("Flag_Livonia", "2026-07-22T10:00:00Z");
    await emit("flagpole.folded", {
      gamertag: "C", dayzId: ID, action: "folded", part: null, tool: null,
      player: { x: 9000.0, y: 100.0, z: 9000.0 },
    }, "2026-07-24T10:00:00Z");
    await runProjector(db);
    const [p] = await db.select().from(poles);
    expect(p?.foldedAt).toBeNull();
  });

  it("advances the cursor so a second run is a no-op", async () => {
    await raise("Flag_Livonia", "2026-07-22T10:00:00Z");
    expect(await runProjector(db)).toBe(1);
    expect(await runProjector(db)).toBe(0);
    expect(await db.select().from(flagChanges)).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm --filter @factions/projector test
```
Expected: FAIL — cannot resolve `../src/run.js`.

- [ ] **Step 4: Write the fold logic**

`apps/projector/src/fold.ts`:
```ts
import type { Database } from "@factions/db";
import { poles, flagChanges } from "@factions/db";
import type { Vec3 } from "@factions/domain";
import { and, eq } from "drizzle-orm";

/** A player must stand at a pole to fold it, so 10m is generous. */
export const NEAREST_POLE_RADIUS_M = 10;

type EventRow = {
  id: number; serverId: number; type: string;
  occurredAt: Date; payload: unknown;
};

type FlagPayload = {
  gamertag: string; dayzId: string; texture: string;
  action: "raised" | "lowered"; pole: Vec3; poleKey: string;
};

type FlagPolePayload = {
  gamertag: string; dayzId: string;
  action: "placed_kit" | "folded" | "built" | "dismantled";
  player: Vec3 | null;
};

export async function applyEvent(db: Database, map: string, ev: EventRow): Promise<void> {
  if (ev.type === "flag.raised" || ev.type === "flag.lowered") {
    return applyFlagChange(db, map, ev, ev.payload as FlagPayload);
  }
  if (ev.type === "flagpole.folded") {
    return applyFold(db, map, ev, ev.payload as FlagPolePayload);
  }
  // placed/built/dismantled and player.position carry no pole identity and are not
  // projected here. Later plans consume them from the event log directly.
}

async function applyFlagChange(db: Database, map: string, ev: EventRow, p: FlagPayload): Promise<void> {
  const raised = p.action === "raised";

  await db.insert(poles).values({
    serverId: ev.serverId,
    map,
    poleKey: p.poleKey,
    x: p.pole.x.toFixed(2),
    y: p.pole.y.toFixed(2),
    z: p.pole.z.toFixed(2),
    currentTexture: p.texture,
    flagRaised: raised,
    firstSeenAt: ev.occurredAt,
    lastSeenAt: ev.occurredAt,
  }).onConflictDoUpdate({
    target: [poles.serverId, poles.map, poles.poleKey],
    set: { currentTexture: p.texture, flagRaised: raised, lastSeenAt: ev.occurredAt },
  });

  await db.insert(flagChanges).values({
    eventId: ev.id,
    serverId: ev.serverId,
    map,
    poleKey: p.poleKey,
    dayzId: p.dayzId,
    gamertag: p.gamertag,
    action: p.action,
    texture: p.texture,
    occurredAt: ev.occurredAt,
  }).onConflictDoNothing({ target: flagChanges.eventId });
}

async function applyFold(db: Database, map: string, ev: EventRow, p: FlagPolePayload): Promise<void> {
  if (!p.player) return;

  const candidates = await db.select().from(poles)
    .where(and(eq(poles.serverId, ev.serverId), eq(poles.map, map)));

  let best: { id: number; d: number } | null = null;
  for (const c of candidates) {
    const dx = Number(c.x) - p.player.x;
    const dz = Number(c.z) - p.player.z;
    const d = Math.hypot(dx, dz);
    if (d <= NEAREST_POLE_RADIUS_M && (!best || d < best.d)) best = { id: c.id, d };
  }
  if (!best) return;

  await db.update(poles)
    .set({ foldedAt: ev.occurredAt, flagRaised: false, lastSeenAt: ev.occurredAt })
    .where(eq(poles.id, best.id));
}
```

- [ ] **Step 5: Write the runner and entry point**

`apps/projector/src/run.ts`:
```ts
import type { Database } from "@factions/db";
import { events, servers } from "@factions/db";
import { readCursor, writeCursor } from "@factions/event-log";
import { asc, gt, eq } from "drizzle-orm";
import { applyEvent } from "./fold.js";

export const CONSUMER = "pole-projector";

/** Applies all unprocessed events in id order. Returns how many were applied. */
export async function runProjector(db: Database, opts: { batchSize?: number } = {}): Promise<number> {
  const batchSize = opts.batchSize ?? 500;
  let cursor = await readCursor(db, CONSUMER);
  let applied = 0;

  for (;;) {
    const batch = await db.select().from(events)
      .where(gt(events.id, cursor)).orderBy(asc(events.id)).limit(batchSize);
    if (batch.length === 0) break;

    for (const ev of batch) {
      const [srv] = await db.select().from(servers).where(eq(servers.id, ev.serverId));
      if (srv) await applyEvent(db, srv.map, ev);
      cursor = ev.id;
      applied++;
    }
    await writeCursor(db, CONSUMER, cursor);
  }

  return applied;
}
```

`apps/projector/src/main.ts`:
```ts
import { createClient } from "@factions/db";
import { runProjector } from "./run.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Set DATABASE_URL.");
  process.exit(1);
}

const applied = await runProjector(createClient(DATABASE_URL));
console.log(`projected ${applied} events`);
process.exit(0);
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
pnpm --filter @factions/projector test
pnpm turbo run typecheck
```
Expected: PASS, 8 projector tests.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: project flag events into pole and flag-change read models"
```

---

## Task 12: Historical backfill and acceptance verification

The production export is a known quantity: **14 flag raise/lower events, all at one pole, across three textures.** Reproducing exactly that is the acceptance test for the whole pipeline.

The export is a derived format — `[Map] ISO-8601  file:line  |  <verbatim ADM line>` — so it needs a small adapter rather than the normal file reader.

**Files:**
- Create: `apps/ingest-worker/src/replay-export.ts`
- Create: `apps/ingest-worker/test/replay-export.test.ts`
- Create: `scripts/backfill.md`

**Interfaces:**
- Consumes: `ingestFile` (Task 10).
- Produces: `parseExportLine(raw: string): { map: string; occurredAt: Date; filename: string; lineIndex: number; content: string } | null`; `groupExportByFile(lines: string[]): Map<string, { map: string; bootAt: Date; lines: string[] }>`.

- [ ] **Step 1: Write the failing test**

`apps/ingest-worker/test/replay-export.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseExportLine, groupExportByFile } from "../src/replay-export.js";

const L1 = '[Livonia] 2026-07-23T17:21:40Z  DayZServer_X1_x64_2026-07-23_09-01-42.ADM:151  |  10:21:40 | Player "XxBE4zyxX" (id=D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1 pos=<2990.4, 1138.3, 448.0>) has raised Flag_Livonia on TerritoryFlag at <2991.569092, 447.946503, 1138.587646>';
const L2 = '[Sakhal] 2026-08-02T02:12:44Z  DayZServer_X1_x64_2026-08-01_19-01-26.ADM:25  |  19:12:44 | Player "Popin 0ps" (id=7D7BE4A8627CF9B969DA293B3A72F3369DFD8D8E pos=<12470.7, 2386.4, 9.5>) placed Flag Pole Kit<TerritoryFlagKit>';

describe("parseExportLine", () => {
  it("splits map, timestamp, filename, line index and verbatim content", () => {
    const r = parseExportLine(L1);
    expect(r?.map).toBe("livonia");
    expect(r?.occurredAt.toISOString()).toBe("2026-07-23T17:21:40.000Z");
    expect(r?.filename).toBe("DayZServer_X1_x64_2026-07-23_09-01-42.ADM");
    expect(r?.lineIndex).toBe(151);
    expect(r?.content.startsWith("10:21:40 | Player")).toBe(true);
  });

  it("preserves the full flag clause in the verbatim content", () => {
    expect(parseExportLine(L1)?.content).toContain("at <2991.569092, 447.946503, 1138.587646>");
  });

  it("returns null for the export's comment header", () => {
    expect(parseExportLine("# DayZ One Life — raw ADM log export")).toBeNull();
  });
});

describe("groupExportByFile", () => {
  it("groups lines by source file and derives bootAt from the earliest line", () => {
    const g = groupExportByFile([L1, L2]);
    expect(g.size).toBe(2);
    const liv = g.get("DayZServer_X1_x64_2026-07-23_09-01-42.ADM");
    expect(liv?.map).toBe("livonia");
    expect(liv?.bootAt.toISOString()).toBe("2026-07-23T09:01:42.000Z");
  });

  it("derives bootAt from the filename timestamp, not the line time", () => {
    const g = groupExportByFile([L2]);
    expect(g.get("DayZServer_X1_x64_2026-08-01_19-01-26.ADM")?.bootAt.toISOString())
      .toBe("2026-08-01T19:01:26.000Z");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @factions/ingest-worker test
```
Expected: FAIL — cannot resolve `../src/replay-export.js`.

- [ ] **Step 3: Write the adapter**

`apps/ingest-worker/src/replay-export.ts`:
```ts
const EXPORT_RE = /^\[(\w+)\]\s+(\S+Z)\s+(\S+\.ADM):(\d+)\s+\|\s+(.*)$/u;
const FILENAME_TIME_RE = /_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.ADM$/u;

export type ExportLine = {
  map: string;
  occurredAt: Date;
  filename: string;
  lineIndex: number;
  content: string;
};

export function parseExportLine(raw: string): ExportLine | null {
  const m = EXPORT_RE.exec(raw);
  if (!m) return null;
  return {
    map: m[1]!.toLowerCase(),
    occurredAt: new Date(m[2]!),
    filename: m[3]!,
    lineIndex: parseInt(m[4]!, 10),
    content: m[5]!,
  };
}

/** The ADM filename encodes the server's boot instant, which the export header does not repeat. */
function bootFromFilename(filename: string): Date | null {
  const m = FILENAME_TIME_RE.exec(filename);
  if (!m) return null;
  return new Date(Date.UTC(
    parseInt(m[1]!, 10), parseInt(m[2]!, 10) - 1, parseInt(m[3]!, 10),
    parseInt(m[4]!, 10), parseInt(m[5]!, 10), parseInt(m[6]!, 10),
  ));
}

export function groupExportByFile(
  lines: string[],
): Map<string, { map: string; bootAt: Date; lines: string[] }> {
  const out = new Map<string, { map: string; bootAt: Date; lines: string[] }>();

  for (const raw of lines) {
    const parsed = parseExportLine(raw);
    if (!parsed) continue;

    const bootAt = bootFromFilename(parsed.filename);
    if (!bootAt) continue;

    let group = out.get(parsed.filename);
    if (!group) {
      group = { map: parsed.map, bootAt, lines: [] };
      out.set(parsed.filename, group);
    }
    group.lines.push(parsed.content);
  }

  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @factions/ingest-worker test
```
Expected: PASS, 5 replay tests.

- [ ] **Step 5: Write the backfill runbook**

`scripts/backfill.md`:
````markdown
# Historical backfill

Replays the production ADM export through ingest and projection, then verifies the
result against known quantities from the log survey.

## Run

```bash
docker compose up -d postgres
export DATABASE_URL="postgres://factions:factions@localhost:5434/factions"
gzcat /path/to/adm-raw-20260826.log.gz > /tmp/adm-export.log
pnpm --filter @factions/ingest-worker exec node --experimental-strip-types \
  src/replay-main.ts /tmp/adm-export.log
pnpm --filter @factions/projector start
```

## Expected results

The survey of this export established the following. Any deviation is a defect.

| Check | Expected |
|---|---|
| Distinct flagpoles with raise/lower events | 1 |
| Total raise + lower events | 14 |
| Raises | 10 |
| Lowers | 4 |
| Distinct textures | 3 — `Flag_Livonia`, `Flag_DayZ`, `Flag_Bohemia` |
| Pole key | `2991.57:447.95:1138.59` |

## Verify

```sql
select count(*) from flag_changes;                       -- 14
select action, count(*) from flag_changes group by action; -- raised 10, lowered 4
select count(distinct pole_key) from flag_changes;       -- 1
select distinct texture from flag_changes order by 1;    -- Bohemia, DayZ, Livonia
select pole_key, current_texture, flag_raised from poles; -- 2991.57:447.95:1138.59
```
````

- [ ] **Step 6: Write the replay entry point**

`apps/ingest-worker/src/replay-main.ts`:
```ts
import { readFile } from "node:fs/promises";
import { createClient, servers } from "@factions/db";
import { and, eq } from "drizzle-orm";
import { groupExportByFile } from "./replay-export.js";
import { ingestFile } from "./ingest.js";

const DATABASE_URL = process.env.DATABASE_URL;
const path = process.argv[2];

if (!DATABASE_URL || !path) {
  console.error("Usage: DATABASE_URL=... node src/replay-main.ts <export.log>");
  process.exit(1);
}

const db = createClient(DATABASE_URL);
const lines = (await readFile(path, "utf8")).split(/\r?\n/);
const groups = groupExportByFile(lines);

for (const [filename, group] of groups) {
  const name = `export-${group.map}`;
  const [existing] = await db.select().from(servers)
    .where(and(eq(servers.name, name), eq(servers.map, group.map)));
  const server = existing ?? (await db.insert(servers)
    .values({ name, map: group.map }).returning())[0]!;

  const r = await ingestFile(db, {
    serverId: server.id, map: group.map, filename,
    bootAt: group.bootAt, lines: group.lines,
  });
  if (r.eventsAppended > 0) console.log(`${filename}: ${r.eventsAppended} events`);
}

console.log(`replayed ${groups.size} files`);
process.exit(0);
```

- [ ] **Step 7: Run the full backfill and verify**

```bash
pnpm turbo run typecheck test --concurrency=1
```
Then follow `scripts/backfill.md` and confirm every expected value.

Expected: all suites green; backfill yields exactly 14 flag changes at 1 pole across 3 textures.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: historical export replay and backfill verification

Acceptance: the production export yields exactly 14 flag changes at one
pole across three textures."
```

---

## Self-Review

**Spec coverage for this plan's scope (spec §13, §3 tenancy, §12 architecture):**

| Spec requirement | Task |
|---|---|
| Flag raise/lower grammar, texture capture | 3 |
| Flagpole placed/folded/built/dismantled grammar | 4 |
| PlayerList 5-minute dump grammar | 5 |
| Coordinate ordering trap (`pos` vs `at`) | 1 |
| Pole coordinate as durable primary key, 1cm normalization | 2, 8 |
| 40-hex UID | 2 |
| `(server_id, map)` composite tenancy | 8 |
| Event-sourced ingest → event log → projections | 8, 9, 10, 11 |
| Pole coordinates excluded from public read models | 8 (documented on `poles`); enforced in Plan 5 |

**Deferred to later plans, deliberately:** ceremony detection, flag pool, faction lifecycle and roster (Plan 2); Discord surface and proximity ping delivery (Plan 3); supply spawner (Plan 4); public directory (Plan 5). Nitrado log fetching is deferred to Plan 3 — this plan ingests from a directory, which is what makes it testable against the historical export today.

**Type consistency:** `Vec3` (y = altitude) is the single position shape across every parser, payload, and projection. `poleKey()` is the only producer of pole identity strings and is used identically in Task 10's payload and Task 11's fold. `parseIdentity` returns `{ gamertag, dayzId }` consistently. `EventType` values in Task 7's `eventTypeFor` match the `type` strings Task 11's `applyEvent` switches on.

**Known follow-up:** `ingestFile` counts appended events with a read-back per row (Task 10, `countEvents`), which is correct but chatty. It is fine for backfill and low log volume; if it becomes a bottleneck, switch `appendEvent` to return the inserted row from `.returning()` and drop the read-back.
