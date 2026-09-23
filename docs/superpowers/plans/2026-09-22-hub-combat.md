# No Combat at the Hub — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ban anyone who hits, kills or traps at the Fast Travel Hub for one hour, and stop every Hub kill, past and future, from scoring anywhere.

**Architecture:** The parser starts keeping both players' positions on hit and kill payloads. A pure `@factions/domain` predicate decides "at the Hub" (a 100 m, ≥ 900 m-altitude cylinder). A new bot tick, `hub-tick.ts`, writes `hub_combat` rows to `bans` for the existing `banTick` to apply. `kills.at_hub` is set by the kills projector, and every scoring read excludes it, exactly as `friendly_fire` is excluded. The past is fixed by a one-time position backfill, `rebuild:kills`, and a revocation pass over the kill-derived achievements.

**Tech Stack:** TypeScript, vitest, drizzle-orm over postgres.js, discord.js, pnpm + turbo.

**Spec:** `docs/superpowers/specs/2026-09-22-hub-combat-design.md`

## Global Constraints

- Zone: horizontal distance from `HUB_POSITION` (100, 93) ≤ `HUB_ZONE_RADIUS_M` = 100, **and** altitude `pos.y` ≥ `HUB_ZONE_MIN_ALTITUDE_M` = 900.
- Either the attacker's or the victim's position inside the zone makes a hit or kill "at the Hub". A placement is at the Hub when the placer is.
- `HUB_BAN_MS` = 1 hour. `bannedAt = now` (processing time), `expiresAt = now + HUB_BAN_MS`. **Never** the event's `occurredAt`.
- `HUB_RETALIATION_WINDOW_MS` = 2 minutes, per pair: A may hit B back within 2 minutes of B hitting A. The earlier hit need not be at the Hub.
- `HUB_OFFENCE_MAX_AGE_MS` = 24 hours: the tick skips older events but still advances its cursor.
- `HUB_TRAP_CLASSES` = `BearTrap`, `LandMineTrap`, `TripwireTrap`, `ImprovisedExplosive`, `ClaymoreMine`, `Plastic_Explosive`.
- Ban reason `"hub_combat"`. No new ban while the player has a `hub_combat` ban `pending` or `applied` on that server.
- The consumer name is `"hub-watch"`. With no cursor row, the tick seeds itself at the log head and bans nothing on that pass.
- A Hub kill is not a kill, not a death, not a streak term and not a K/D term, for either side, on every board including friendly fire. It stays a **record**: the kill feed, the timeline and encounters show it, marked "at the Hub".
- Payload keys are `victimPos`/`attackerPos` on `player.hit` and `victimPos`/`killerPos` on `player.killed`. **Never `pos`** (`positions-tick.ts`'s `readFix` treats `pos` as a map fix).
- Guide numbers come only from `rules.ts` through `guide-numbers.ts` tokens. Never type a literal.
- Comments explain WHY. `⚠️` marks a silent-failure hazard. Match each file's comment density.
- `packages/domain/src` uses **extensionless** relative imports (it is transpiled by `apps/web`). `packages/adm-parser` and `apps/bot` use `.js`.
- The gate, always with `--force`: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`. Expect 30/30 tasks. Never run two gates at once.

## Review Focus

1. **A simultaneous exchange in the same second.** A→B and B→A both logged at the same `occurredAt`. Exactly one player is banned: the one whose line was logged first (lower `events.id`), not both and not neither. This is pinned in Task 4.
2. **A rule that throws during revocation.** An error is not "no longer earned". A throwing rule must leave the unlock alone and be reported. This is pinned in Task 7.
3. **First run on a server with Hub history.** No `hub-watch` cursor row, and hundreds of past Hub hits in `events`. The first tick seeds at the head and bans nobody. This is pinned in Task 4.
4. **A Hub teamkill (friendly fire *and* at the Hub).** It counts nowhere, not even on the friendly-fire board or the profile's friendly-fire counters. This is pinned in Task 5.
5. **A gamertag carrying `pos=<…>` text.** A name like `x pos=<100.0, 93.0, 998.0>` must not move its owner onto the Hub. Positions are read only from inside the identity block the parser already anchors on. This is pinned in Task 2.

---

## File map

| File | Responsibility |
|---|---|
| `packages/domain/src/rules.ts` | the five `HUB_*` numbers and `HUB_TRAP_CLASSES` |
| `packages/domain/src/hub.ts` (new) | `readVec3`, `atHub`, `hubOffence`: pure, no DB |
| `packages/domain/src/enforcement.ts` | `BAN_REASONS` gains `hub_combat`; `BAN_REASON_TEXT` |
| `packages/domain/src/death-verdict.ts` | `RecentHit.atHub` |
| `packages/domain/src/streaks.ts` | `StreakRow.atHub`, skipped like friendly fire |
| `packages/domain/src/guide-numbers.ts` | three new guide rows |
| `packages/adm-parser/src/coords.ts` | `posInIdentity` |
| `packages/adm-parser/src/hit.ts`, `death.ts` | positions on hit and kill lines |
| `apps/ingest-worker/src/ingest.ts` | `victimPos`/`killerPos` on the kill payload |
| `packages/db/src/schema.ts` + migration 0047 | `kills.at_hub` |
| `apps/bot/src/kills-tick.ts` | sets `at_hub` |
| `apps/bot/src/hub-tick.ts` (new) | the ban tick |
| `apps/bot/src/config.ts`, `discord.ts` | `HUB_BAN_TICK` gate and wiring |
| `apps/bot/src/ban-tick.ts`, `ban-announce-text.ts` | per-reason wording |
| `packages/roster/src/stats.ts` | boards, profile, streaks, encounters, feed |
| `apps/bot/src/{killstreak,long-range,kill,hit}-feed-tick.ts`, `kill-feed-embed.ts` | the feeds |
| `apps/bot/src/achievements/rules-pvp.ts` | PvP rules |
| `apps/bot/src/achievements/revoke.ts` (new), `scripts/revoke-achievements.ts` (new) | revocation |
| `apps/bot/src/hub-backfill.ts` (new), `scripts/backfill-hub-positions.ts` (new) | position backfill |
| `apps/web/lib/feed-copy.ts`, `apps/web/app/components/player-feed.tsx` | the "at the Hub" mark |
| `apps/web/content/guide/{11,12,13}-*.html` | the rule |
| `docs/deploy/2026-09-22-hub-combat.md` (new), `CLAUDE.md`, `CHANGELOG.md` | runbook, map, changelog |

---

### Task 1: The Hub in `@factions/domain`

**Files:**
- Modify: `packages/domain/src/rules.ts` (after `HUB_POSITION`, around line 41)
- Create: `packages/domain/src/hub.ts`
- Modify: `packages/domain/src/index.ts` (add `export * from "./hub";`)
- Modify: `packages/domain/src/enforcement.ts:97`
- Test: `packages/domain/test/hub.test.ts` (new), `packages/domain/test/enforcement.test.ts`

**Interfaces:**
- Produces:
  - `HUB_ZONE_RADIUS_M: 100`, `HUB_ZONE_MIN_ALTITUDE_M: 900`, `HUB_BAN_MS`, `HUB_RETALIATION_WINDOW_MS`, `HUB_OFFENCE_MAX_AGE_MS`, and `HUB_TRAP_CLASSES: readonly string[]`, all from `rules.ts`.
  - `readVec3(v: unknown): Vec3 | null`
  - `atHub(pos: Vec3 | null): boolean`
  - `type HubOffence = { offender: string; gamertag: string; victim: string | null }`
  - `hubOffence(type: string, payload: unknown): HubOffence | null`
  - `BanReason` now includes `"hub_combat"`, and `BAN_REASON_TEXT: Record<BanReason, string>` is exported.

- [ ] **Step 1: Write the failing tests**

`packages/domain/test/hub.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { atHub, hubOffence, readVec3 } from "../src/hub";
import { HUB_POSITION, HUB_TRAP_CLASSES } from "../src/rules";

const A = "A".repeat(40), B = "B".repeat(40);
const HUB = { x: 100, y: 998.6, z: 93 };
const GROUND = { x: 100, y: 310, z: 93 };

describe("atHub", () => {
  it("every Hub door (x 86–114, z 92–111, y 998.6) is inside", () => {
    for (const [x, z] of [[86, 92], [114, 92], [86, 111], [114, 111], [100, 93]]) expect(atHub({ x, y: 998.6, z })).toBe(true);
  });
  it("⚠️ the ground directly below the Hub is outside: the cylinder has a floor", () => {
    expect(atHub(GROUND)).toBe(false);
    expect(atHub({ ...HUB, y: 899.9 })).toBe(false);
    expect(atHub({ ...HUB, y: 900 })).toBe(true);
  });
  it("100 m out is inside, 100.1 m is outside", () => {
    expect(atHub({ x: HUB_POSITION.x + 100, y: 998, z: HUB_POSITION.z })).toBe(true);
    expect(atHub({ x: HUB_POSITION.x + 100.1, y: 998, z: HUB_POSITION.z })).toBe(false);
  });
  it("no position is never inside", () => expect(atHub(null)).toBe(false));
});

describe("readVec3", () => {
  it("reads a stored payload vector", () => expect(readVec3({ x: 1, y: 2, z: 3 })).toEqual({ x: 1, y: 2, z: 3 }));
  it("rejects anything that is not three finite numbers", () => {
    for (const v of [null, undefined, "1,2,3", { x: 1, y: 2 }, { x: "1", y: 2, z: 3 }, { x: NaN, y: 2, z: 3 }]) expect(readVec3(v)).toBeNull();
  });
});

describe("hubOffence", () => {
  const hit = (over: Record<string, unknown> = {}) => ({
    victimDayzId: B, victimGamertag: "Bee", attackerType: "player", attackerDayzId: A, attackerGamertag: "Ay",
    victimPos: HUB, attackerPos: HUB, ...over,
  });
  it("a player hit at the Hub: the attacker offends against the victim", () => {
    expect(hubOffence("player.hit", hit())).toEqual({ offender: A, gamertag: "Ay", victim: B });
  });
  it("either party inside is enough", () => {
    expect(hubOffence("player.hit", hit({ attackerPos: GROUND }))).not.toBeNull();
    expect(hubOffence("player.hit", hit({ victimPos: GROUND }))).not.toBeNull();
    expect(hubOffence("player.hit", hit({ victimPos: GROUND, attackerPos: GROUND }))).toBeNull();
  });
  it("infected, environment and self-inflicted hits are never offences", () => {
    expect(hubOffence("player.hit", hit({ attackerType: "infected", attackerDayzId: null }))).toBeNull();
    expect(hubOffence("player.hit", hit({ attackerType: "environment", attackerDayzId: null }))).toBeNull();
    expect(hubOffence("player.hit", hit({ attackerDayzId: B }))).toBeNull();
  });
  it("a kill at the Hub: the killer offends", () => {
    expect(hubOffence("player.killed", { victimDayzId: B, killerDayzId: A, killerGamertag: "Ay", victimPos: HUB, killerPos: GROUND }))
      .toEqual({ offender: A, gamertag: "Ay", victim: B });
  });
  it("a trap placed at the Hub offends with no victim; a tent does not", () => {
    for (const itemClass of HUB_TRAP_CLASSES) {
      expect(hubOffence("item.placed", { dayzId: A, gamertag: "Ay", itemClass, pos: HUB })).toEqual({ offender: A, gamertag: "Ay", victim: null });
    }
    expect(hubOffence("item.placed", { dayzId: A, gamertag: "Ay", itemClass: "LargeTent", pos: HUB })).toBeNull();
    expect(hubOffence("item.placed", { dayzId: A, gamertag: "Ay", itemClass: "BearTrap", pos: GROUND })).toBeNull();
  });
  it("any other event type is never an offence", () => expect(hubOffence("player.died", hit())).toBeNull());
});
```

Add to `packages/domain/test/enforcement.test.ts`:

```ts
import { BAN_REASONS, BAN_REASON_TEXT } from "../src/enforcement";
it("every ban reason has player-facing wording", () => {
  expect(BAN_REASONS).toContain("hub_combat");
  for (const r of BAN_REASONS) expect(BAN_REASON_TEXT[r]).toMatch(/\S/u);
  expect(BAN_REASON_TEXT.zone).toBe("base-zone enforcement");
  expect(BAN_REASON_TEXT.hub_combat).toBe("combat at the Fast Travel Hub");
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd packages/domain && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/hub.test.ts test/enforcement.test.ts`
Expected: FAIL. `../src/hub` doesn't resolve, and `BAN_REASON_TEXT` is undefined.

- [ ] **Step 3: Implement**

In `rules.ts`, directly after `HUB_POSITION`:

```ts
/**
 * The Hub's no-combat zone (spec 2026-09-22-hub-combat §2.1): a CYLINDER, not a
 * circle. The Hub floats — floor 997.5 m, doors 998.6 m, every door within 22 m
 * of HUB_POSITION — and the ground directly beneath it is ordinary map where a
 * fight is legal.
 * ⚠️ The floor is what makes that so. Drop it and every fight on the hill below
 * the Hub is a one-hour ban.
 */
export const HUB_ZONE_RADIUS_M = 100;
export const HUB_ZONE_MIN_ALTITUDE_M = 900;
/** Every hit, kill or trap at the Hub. Measured from when the bot PROCESSES it — log delay must not eat the hour. */
export const HUB_BAN_MS = 1 * HOUR;
/** Self-defence: A may hit B back this long after B hit A. Per pair. */
export const HUB_RETALIATION_WINDOW_MS = 2 * MIN;
/**
 * ⚠️ Not about the sentence. An unseeded or rewound `hub-watch` cursor would
 * otherwise replay the whole log into bans — including the 2026-09-20 brawl,
 * from before the rule existed. Far longer than any log delay seen.
 */
export const HUB_OFFENCE_MAX_AGE_MS = 24 * HOUR;
/**
 * Placing one of these at the Hub is an offence. The first five were read off
 * `item.placed` payloads in factions_live on 2026-09-22.
 * ⚠️ `Plastic_Explosive` has NEVER been placed on this server — vanilla, and
 * included on that basis; confirm its classname the first time it appears.
 * A missing classname here is a trap the rule silently allows.
 */
export const HUB_TRAP_CLASSES = ["BearTrap", "LandMineTrap", "TripwireTrap", "ImprovisedExplosive", "ClaymoreMine", "Plastic_Explosive"] as const;
```

`packages/domain/src/hub.ts`:

```ts
import { HUB_POSITION, HUB_TRAP_CLASSES, HUB_ZONE_MIN_ALTITUDE_M, HUB_ZONE_RADIUS_M } from "./rules";
import type { Vec3 } from "./vec3";

/** A position as stored in an event payload (jsonb), or null. Never trusts the shape. */
export function readVec3(v: unknown): Vec3 | null {
  if (typeof v !== "object" || v === null) return null;
  const { x, y, z } = v as Record<string, unknown>;
  return typeof x === "number" && typeof y === "number" && typeof z === "number"
    && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

/**
 * Inside the Hub's no-combat cylinder. `y` is altitude (vec3.ts).
 * A missing position is never inside: an event we cannot place is not an
 * offence, and a kill we cannot place still scores.
 */
export function atHub(pos: Vec3 | null): boolean {
  if (pos === null) return false;
  return pos.y >= HUB_ZONE_MIN_ALTITUDE_M
    && Math.hypot(pos.x - HUB_POSITION.x, pos.z - HUB_POSITION.z) <= HUB_ZONE_RADIUS_M;
}

export type HubOffence = { offender: string; gamertag: string; victim: string | null };

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const TRAPS: ReadonlySet<string> = new Set(HUB_TRAP_CLASSES);

/**
 * Who, if anyone, this one event makes an offender at the Hub. Pure: the
 * self-defence exemption needs the event log and is the caller's (hub-tick.ts).
 * `victim` is null for a placement — there is nobody to have hit first.
 */
export function hubOffence(type: string, payload: unknown): HubOffence | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (type === "item.placed") {
    const offender = str(p.dayzId);
    if (!offender || !TRAPS.has(String(p.itemClass)) || !atHub(readVec3(p.pos))) return null;
    return { offender, gamertag: str(p.gamertag) ?? offender, victim: null };
  }
  const [by, name, byPos] = type === "player.hit" ? ["attackerDayzId", "attackerGamertag", "attackerPos"]
    : type === "player.killed" ? ["killerDayzId", "killerGamertag", "killerPos"] : [null, null, null];
  if (by === null) return null;
  // ⚠️ A hit's attacker must be a PLAYER. An infected's hit carries no id, but say so rather than rely on it.
  if (type === "player.hit" && p.attackerType !== "player") return null;
  const offender = str(p[by]); const victim = str(p.victimDayzId);
  if (!offender || !victim || offender === victim) return null;
  if (!atHub(readVec3(p[byPos!])) && !atHub(readVec3(p.victimPos))) return null;
  return { offender, gamertag: str(p[name!]) ?? offender, victim };
}
```

In `enforcement.ts`:

```ts
export const BAN_REASONS = ["zone", "unlinked_pc", "hub_combat"] as const;
export type BanReason = (typeof BAN_REASONS)[number];
/**
 * What a ban is FOR, in words a player reads — the ban DM and #bans both use
 * this. A Record, so a new reason cannot ship without wording.
 */
export const BAN_REASON_TEXT: Record<BanReason, string> = {
  zone: "base-zone enforcement",
  unlinked_pc: "playing on PC without a linked account",
  hub_combat: "combat at the Fast Travel Hub",
};
```

Add `export * from "./hub";` to `packages/domain/src/index.ts`, next to `./spacing`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run the Step 2 command. Expected: PASS. Also run `cd packages/domain && npx tsc --noEmit`, which should produce no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): the Hub's no-combat zone and the hub_combat ban reason"
```

---

### Task 2: Positions on hit and kill payloads

**Files:**
- Modify: `packages/adm-parser/src/coords.ts`, `packages/adm-parser/src/hit.ts`, `packages/adm-parser/src/death.ts`
- Modify: `apps/ingest-worker/src/ingest.ts:175-195` (the `death` case)
- Test: `packages/adm-parser/test/hit.test.ts`, `packages/adm-parser/test/death.test.ts`, `apps/ingest-worker/test/ingest.test.ts`

**Interfaces:**
- Produces:
  - `posInIdentity(tail: string): Vec3 | null` in `coords.ts`
  - `HitLine` gains `victimPos: Vec3 | null` and `attackerPos: Vec3 | null`
  - The `killed` variant of `DeathLine` gains `victimPos: Vec3 | null` and `killerPos: Vec3 | null`
  - Event payloads: `player.hit` carries `victimPos`/`attackerPos`; `player.killed` carries `victimPos`/`killerPos`

- [ ] **Step 1: Write the failing tests**

In `packages/adm-parser/test/hit.test.ts` (it already defines `V` and `K`):

```ts
it("keeps both players' positions — altitude is y, and pos=<x, z, alt> puts it LAST", () => {
  const h = parseHit(`17:24:38 | Player "Vic" (id=${V} pos=<101.0, 95.0, 998.6>)[HP: 71.6] hit by Player "Kil" (id=${K} pos=<99.3, 93.2, 998.6>) into Torso(21) for 28.3 damage (Bullet_556x45) with M4-A1 from 2.6 meters`)!;
  expect(h.victimPos).toEqual({ x: 101, y: 998.6, z: 95 });
  expect(h.attackerPos).toEqual({ x: 99.3, y: 998.6, z: 93.2 });
});
it("⚠️ the Hub's altitude parses — an ALT_MAX below 1000 would blind the Hub rule silently", () => {
  const h = parseHit(`10:00:00 | Player "Vic" (id=${V} pos=<100.0, 93.0, 997.5>)[HP: 50] hit by Player "Kil" (id=${K} pos=<100.0, 93.0, 997.5>) into Torso(1) for 5 damage (MeleeFist)`)!;
  expect(h.victimPos?.y).toBe(997.5);
});
it("a non-player attacker has no position", () => {
  expect(parseHit(`10:00:00 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>)[HP: 50] hit by Infected into Torso(1) for 5 damage (MeleeInfected)`)!.attackerPos).toBeNull();
});
it("⚠️ a gamertag carrying pos=<…> cannot move its owner onto the Hub", () => {
  const h = parseHit(`10:00:00 | Player "x pos=<100.0, 93.0, 998.0>" (id=${V} pos=<5000.0, 5000.0, 300.0>)[HP: 50] hit by Player "y pos=<100.0, 93.0, 998.0>" (id=${K} pos=<5001.0, 5000.0, 300.0>) into Torso(1) for 5 damage (MeleeFist)`)!;
  expect(h.victimPos).toEqual({ x: 5000, y: 300, z: 5000 });
  expect(h.attackerPos).toEqual({ x: 5001, y: 300, z: 5000 });
});
```

In `packages/adm-parser/test/death.test.ts`, add (define `V`/`K` as 40-hex strings if the file doesn't already):

```ts
it("a kill line keeps both positions", () => {
  const d = parseDeath(`10:00:00 | Player "Vic" (DEAD) (id=${V} pos=<101.0, 95.0, 998.6>) killed by Player "Kil" (id=${K} pos=<99.0, 93.0, 998.6>) with M4-A1 from 2.1 meters`)!;
  expect(d).toMatchObject({ kind: "killed", victimPos: { x: 101, y: 998.6, z: 95 }, killerPos: { x: 99, y: 998.6, z: 93 } });
});
it("a mutual kill (killer also DEAD) keeps the killer's position", () => {
  const d = parseDeath(`10:00:00 | Player "Vic" (DEAD) (id=${V} pos=<1.0, 2.0, 3.0>) killed by Player "Kil" (DEAD) (id=${K} pos=<4.0, 5.0, 6.0>) with SCR 17`)!;
  expect(d).toMatchObject({ kind: "killed", killerPos: { x: 4, y: 6, z: 5 } });
});
```

In `apps/ingest-worker/test/ingest.test.ts`, add a case following the file's existing pattern of ingesting lines and reading `events` back. Feed it one hit line and one kill line (the two lines above), then assert:

```ts
const hit = rows.find((r) => r.type === "player.hit")!.payload as Record<string, unknown>;
const kill = rows.find((r) => r.type === "player.killed")!.payload as Record<string, unknown>;
expect(hit).toMatchObject({ victimPos: { x: 101, y: 998.6, z: 95 }, attackerPos: { x: 99.3, y: 998.6, z: 93.2 } });
expect(kill).toMatchObject({ victimPos: expect.any(Object), killerPos: expect.any(Object) });
// ⚠️ `pos` is a map fix to positions-tick's readFix: a kill carrying it would pin the victim on the killer's map.
expect("pos" in hit).toBe(false);
expect("pos" in kill).toBe(false);
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd packages/adm-parser && npx vitest run test/hit.test.ts test/death.test.ts`
Expected: FAIL. `victimPos` is undefined.

- [ ] **Step 3: Implement**

In `coords.ts`, after `parsePlayerPos`:

```ts
const IDENTITY_POS_RE = new RegExp(`pos=${V3}`, "u");

/**
 * The position inside ONE identity block's own tail — the text between its
 * `id=<40 hex>` and its closing paren, which the caller's anchored regex has
 * already captured. Same `pos=<x, z, altitude>` order and bounds as parsePlayerPos.
 * ⚠️ Only ever pass a captured identity tail, never a whole line: a gamertag
 * can carry `pos=<…>` text, and outside the identity block it would be believed.
 */
export function posInIdentity(tail: string): Vec3 | null {
  const m = IDENTITY_POS_RE.exec(tail);
  if (!m) return null;
  const x = parseFloat(m[1]!), z = parseFloat(m[2]!), y = parseFloat(m[3]!);
  if (!inMapBounds(x, z) || !inAltitudeBounds(y)) return null;
  return { x, y, z };
}
```

In `hit.ts`: add `victimPos: Vec3 | null; attackerPos: Vec3 | null;` to `HitLine`, and import `Vec3` from `@factions/domain` and `posInIdentity` from `./coords.js`. Then capture each identity tail and shift the group indices:

```ts
const VICTIM_RE = new RegExp(`Player "([^"]+)" \\(id=(${ID})([^)]*)\\)\\[HP: ([\\d.]+)\\] hit by (.*)$`, "u");
const BY_PLAYER_RE = new RegExp(`^Player "([^"]+)" (?:\\(DEAD\\) )?\\(id=(${ID})([^)]*)\\)(.*)$`, "u");
```

In `parseHit`: set `victimHp: parseFloat(m[4]!)` and `rest = m[5]!`, and add `victimPos: posInIdentity(m[3]!)` to `base`. In the player branch, use `WEAPON_RE.exec(p[4]!)` and add `attackerPos: posInIdentity(p[3]!)`. In the non-player branch, add `attackerPos: null`.

In `death.ts`: extend the `killed` variant with `victimPos: Vec3 | null; killerPos: Vec3 | null`. Then:

```ts
const KILL_RE = new RegExp(`Player "([^"]+)" \\(DEAD\\) \\(id=(${ID})([^)]*)\\) killed by Player "([^"]+)" (?:\\(DEAD\\) )?\\(id=(${ID})([^)]*)\\)(.*)$`, "u");
```

The groups become: 1 victim name, 2 victim id, 3 victim tail, 4 killer name, 5 killer id, 6 killer tail, 7 rest. Update the `killed` return to use those indices, with `victimPos: posInIdentity(k[3]!)` and `killerPos: posInIdentity(k[6]!)`.

In `apps/ingest-worker/src/ingest.ts`, add `victimPos: line.event.victimPos, killerPos: line.event.killerPos,` to the `killed` branch of the `death` case. The `hit` case already spreads `line.event`, so it carries both keys.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd packages/adm-parser && npx vitest run` and `cd apps/ingest-worker && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run`.
Expected: PASS. If an existing ingest test asserts a hit or kill payload with `toEqual`, update it to include the two new keys. Change nothing else in it.

- [ ] **Step 5: Commit**

```bash
git add packages/adm-parser apps/ingest-worker
git commit -m "feat(parser): keep both players' positions on hit and kill events"
```

---

### Task 3: `kills.at_hub`

**Files:**
- Modify: `packages/db/src/schema.ts` (the `kills` table)
- Create: `packages/db/migrations/0047_*.sql` (generated)
- Modify: `packages/domain/src/death-verdict.ts` (`RecentHit`)
- Modify: `apps/bot/src/kills-tick.ts`
- Test: `apps/bot/test/kills-tick.test.ts`

**Interfaces:**
- Consumes: `atHub` and `readVec3` (Task 1); the `victimPos`/`killerPos`/`attackerPos` payload keys (Task 2)
- Produces: `kills.atHub: boolean` (column `at_hub`, not null, default false); `RecentHit.atHub?: boolean`

- [ ] **Step 1: Write the failing tests**

In `apps/bot/test/kills-tick.test.ts`, using the file's existing `ev` helper and ids:

```ts
const HUB = { x: 100, y: 998.6, z: 93 };
const GROUND = { x: 100, y: 310, z: 93 };

it("a kill at the Hub is recorded with atHub — either party inside is enough", async () => {
  await ev("player.killed", { victimDayzId: R, killerDayzId: A, weapon: "M4-A1", distanceM: 3, victimPos: HUB, killerPos: GROUND }, t1);
  await ev("player.killed", { victimDayzId: A, killerDayzId: R, weapon: "M4-A1", distanceM: 3, victimPos: GROUND, killerPos: GROUND }, t5);
  await killsTick(db);
  const rows = await db.select().from(kills).orderBy(kills.occurredAt);
  expect(rows.map((r) => r.atHub)).toEqual([true, false]);
});

it("a kill with no positions (every event before this deploy) is not at the Hub", async () => {
  await ev("player.killed", { victimDayzId: R, killerDayzId: A, weapon: "AKM", distanceM: 1 }, t1);
  await killsTick(db);
  expect((await db.select().from(kills))[0]!.atHub).toBe(false);
});

it("a credited kill is at the Hub when the crediting hit was", async () => {
  await ev("player.hit", { victimDayzId: R, attackerType: "player", attackerDayzId: A, victimHp: 10, weapon: "M4-A1", distanceM: 4, victimPos: HUB, attackerPos: HUB }, t1);
  await ev("player.died", { victimDayzId: R, cause: "died", water: 1000, energy: 1000, bleedSources: 0 }, new Date(t1.getTime() + 20_000));
  await killsTick(db);
  const [k] = await db.select().from(kills);
  expect(k).toMatchObject({ cause: "finished", killerDayzId: A, atHub: true });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/kills-tick.test.ts`
Expected: FAIL. `atHub` does not exist on `kills`, which surfaces as a type error or `undefined`.

- [ ] **Step 3: Implement the schema and generate the migration**

In `schema.ts`, in `kills` after `friendlyFire`:

```ts
  /**
   * The kill happened at the Fast Travel Hub (spec 2026-09-22-hub-combat): the
   * attacker or the victim inside the no-combat cylinder. Like `friendly_fire`,
   * it scores NOWHERE — every scoring read excludes it — and stays a record.
   * False where the payload has no positions (every event before the backfill).
   */
  atHub: boolean("at_hub").notNull().default(false),
```

Run: `cd packages/db && npx drizzle-kit generate`
Then **read the generated SQL.** It must be exactly one statement:
`ALTER TABLE "kills" ADD COLUMN "at_hub" boolean DEFAULT false NOT NULL;`
Anything else (a drop, a rename, a second table) means the snapshot has drifted. Stop and investigate. Do not commit it.

- [ ] **Step 4: Implement the projector**

In `death-verdict.ts`, add to `RecentHit`:

```ts
  /** The hit was at the Hub (kills-tick sets it; the verdict never reads it). A credit from it is a Hub kill. */
  atHub?: boolean;
```

In `kills-tick.ts`:
- Import `atHub, readVec3` from `@factions/domain`.
- Extend `KilledPayload` with `atHub: boolean`, and have `readKilledPayload` return `atHub: atHub(readVec3(p.victimPos)) || atHub(readVec3(p.killerPos))`.
- In `verdictOf`'s `hits.push({...})`, add `atHub: atHub(readVec3(p.victimPos)) || atHub(readVec3(p.attackerPos))`.
- In the `player.killed` insert, add `atHub: payload.atHub`.
- In the `player.died` insert, add:

```ts
            // ⚠️ `finishedBy` returns one of the hits it was given, so the credit's
            // Hub flag is the crediting hit's. A hit at the Hub earns a kill that scores nowhere.
            atHub: finisher?.atHub ?? false,
```

- [ ] **Step 5: Run the tests and confirm they pass, then run the db package tests**

Run the Step 2 command, then `cd packages/db && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run`.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db packages/domain/src/death-verdict.ts apps/bot/src/kills-tick.ts apps/bot/test/kills-tick.test.ts
git commit -m "feat(kills): record kills made at the Hub (migration 0047)"
```

---

### Task 4: The ban tick

**Files:**
- Create: `apps/bot/src/hub-tick.ts`
- Modify: `apps/bot/src/config.ts` (the `unlinkedPcBan` field, its parse at ~line 487, and its guard at ~line 511)
- Modify: `apps/bot/src/discord.ts` (after the `zoneTick` try/catch at ~line 903, and the startup lines at ~line 1697)
- Modify: `apps/bot/src/ban-tick.ts:209`, `apps/bot/src/ban-announce-text.ts`
- Test: `apps/bot/test/hub-tick.test.ts` (new), `apps/bot/test/config.test.ts`, `apps/bot/test/ban-announce-text.test.ts`, `apps/bot/test/ban-tick.test.ts`

**Interfaces:**
- Consumes: `hubOffence`, `HUB_*` and `BAN_REASON_TEXT` (Task 1)
- Produces:
  - `HUB_CONSUMER = "hub-watch"`
  - `type HubTickResult = { seeded: boolean; scanned: number; banned: { dayzId: string; gamertag: string }[] }`
  - `hubTick(db: Database, opts?: { now?: Date; batchSize?: number }): Promise<HubTickResult>`
  - `config.hubBanTick: boolean`

- [ ] **Step 1: Write the failing tests**

`apps/bot/test/hub-tick.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events, bans, consumerCursors, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { hubTick, HUB_CONSUMER } from "../src/hub-tick.js";
import { writeCursor } from "@factions/event-log";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(40), B = "B".repeat(40), C = "C".repeat(40);
const HUB = { x: 100, y: 998.6, z: 93 };
const GROUND = { x: 100, y: 310, z: 93 };
const now = new Date("2026-09-22T12:00:00Z");
const ago = (s: number) => new Date(now.getTime() - s * 1000);

describe("hubTick", () => {
  let db: Database; let serverId = 0; let fileId = 0; let line = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate events, raw_lines, adm_files, bans, consumer_cursors, servers restart identity cascade`);
    serverId = (await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0, nitradoServiceId: 1, active: true }).returning())[0]!.id;
    fileId = (await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: ago(86_400), linesIngested: 0, complete: true }).returning())[0]!.id;
    line = 0;
    await writeCursor(db, HUB_CONSUMER, 0);   // seeded: every test below starts from the beginning
  });
  const ev = (type: string, at: Date, payload: Record<string, unknown>) =>
    db.insert(events).values({ serverId, admFileId: fileId, lineIndex: line++, type: type as never, occurredAt: at, payload }).returning({ id: events.id });
  const hit = (attacker: string, victim: string, at: Date, pos = HUB) =>
    ev("player.hit", at, { attackerType: "player", attackerDayzId: attacker, attackerGamertag: attacker.slice(0, 3), victimDayzId: victim, victimPos: pos, attackerPos: pos });
  const banned = async () => (await db.select().from(bans).orderBy(bans.id)).map((b) => b.dayzId);

  it("the first hitter is banned for an hour from NOW, not from when it happened", async () => {
    await hit(A, B, ago(3 * 3600));   // logged three hours late
    const r = await hubTick(db, { now });
    expect(r.banned.map((b) => b.dayzId)).toEqual([A]);
    const [b] = await db.select().from(bans);
    expect(b).toMatchObject({ reason: "hub_combat", status: "pending", serverId, gamertag: "AAA" });
    expect(b!.bannedAt.toISOString()).toBe(now.toISOString());
    expect(b!.expiresAt!.toISOString()).toBe(new Date(now.getTime() + 3_600_000).toISOString());
    expect(b!.incidentId).toBeNull();
  });

  it("return fire within two minutes is self-defence; after two minutes it is not", async () => {
    await hit(B, A, ago(300));
    await hit(A, B, ago(200));   // 100 s later: self-defence
    await hit(A, B, ago(60));    // 240 s after B's hit: an offence
    await hubTick(db, { now });
    expect(await banned()).toEqual([B, A]);
  });

  it("self-defence is per pair: hitting a third player is still an offence", async () => {
    await hit(B, A, ago(100));
    await hit(A, C, ago(90));
    await hubTick(db, { now });
    expect((await banned()).sort()).toEqual([A, B].sort());
  });

  it("the attack that started it need not be at the Hub", async () => {
    await hit(B, A, ago(100), GROUND);
    await hit(A, B, ago(90));
    await hubTick(db, { now });
    expect(await banned()).toEqual([]);
  });

  it("⚠️ a same-second exchange bans exactly the one logged first", async () => {
    const t = ago(100);
    await hit(A, B, t);
    await hit(B, A, t);
    await hubTick(db, { now });
    expect(await banned()).toEqual([A]);
  });

  it("a kill at the Hub bans the killer; a fight on the ground below bans nobody", async () => {
    await ev("player.killed", ago(50), { killerDayzId: A, killerGamertag: "AAA", victimDayzId: B, victimPos: HUB, killerPos: HUB });
    await hit(C, B, ago(40), GROUND);
    await hubTick(db, { now });
    expect(await banned()).toEqual([A]);
  });

  it("a trap placed at the Hub bans the placer; a tent does not", async () => {
    await ev("item.placed", ago(50), { dayzId: A, gamertag: "AAA", itemClass: "BearTrap", item: "Bear Trap", pos: HUB });
    await ev("item.placed", ago(40), { dayzId: B, gamertag: "BBB", itemClass: "LargeTent", item: "Large Tent", pos: HUB });
    await hubTick(db, { now });
    expect(await banned()).toEqual([A]);
  });

  it("one ban at a time: a brawl is one ban, and a new offence after it ends is a new one", async () => {
    for (let i = 0; i < 20; i++) await hit(A, B, ago(100 - i));
    await hubTick(db, { now });
    expect(await banned()).toEqual([A]);
    await db.update(bans).set({ status: "expired" });
    await hit(A, B, ago(10));
    await hubTick(db, { now });
    expect(await banned()).toEqual([A, A]);
  });

  it("an event older than 24 h is skipped, and the cursor still moves past it", async () => {
    const [e] = await hit(A, B, ago(25 * 3600));
    await hubTick(db, { now });
    expect(await banned()).toEqual([]);
    const [c] = await db.select().from(consumerCursors).where(sql`consumer_name = ${HUB_CONSUMER}`);
    expect(c!.lastEventId).toBe(e!.id);
  });

  it("⚠️ with no cursor row it seeds at the log head and bans nobody — history is never replayed", async () => {
    await db.execute(sql`truncate consumer_cursors`);
    await hit(A, B, ago(100));
    const r = await hubTick(db, { now });
    expect(r.seeded).toBe(true);
    expect(await banned()).toEqual([]);
    await hit(C, B, ago(10));
    await hubTick(db, { now });
    expect(await banned()).toEqual([C]);
  });

  it("an infected's hit at the Hub is never an offence", async () => {
    await ev("player.hit", ago(10), { attackerType: "infected", attackerDayzId: null, victimDayzId: B, victimPos: HUB, attackerPos: null });
    await hubTick(db, { now });
    expect(await banned()).toEqual([]);
  });
});
```

In `apps/bot/test/config.test.ts`, following the existing `UNLINKED_PC_BAN` cases:

```ts
it("HUB_BAN_TICK without ENFORCEMENT_TICK refuses to load — rows would never be applied", () => {
  expect(() => loadConfig({ ...base, HUB_BAN_TICK: "true" })).toThrow(/HUB_BAN_TICK is on but ENFORCEMENT_TICK is off/);
});
it("HUB_BAN_TICK with ENFORCEMENT_TICK loads", () => {
  expect(loadConfig({ ...base, HUB_BAN_TICK: "true", ENFORCEMENT_TICK: "true", NITRADO_TOKEN: "t" }).hubBanTick).toBe(true);
});
```

(Use whatever the file calls its base env and its loader. Copy the shape of the `UNLINKED_PC_BAN` tests.)

In `apps/bot/test/ban-announce-text.test.ts`:

```ts
it("a Hub ban names the Hub", () => {
  expect(banAnnouncementText({ kind: "applied", gamertag: "Ay", reason: "hub_combat", expiresAt: "2026-09-22T13:00:00Z" }))
    .toMatch(/^🔨 \*\*Ay\*\* banned until .+ — combat at the Fast Travel Hub\.$/u);
});
```

In `apps/bot/test/ban-tick.test.ts`, add a case that applies a `reason: "hub_combat"` pending row with `dryRun: false`. Assert that the queued `ban_applied` notice's payload has `reason: "combat at the Fast Travel Hub"`. Mirror the file's existing DM-payload assertion for a zone ban.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/hub-tick.test.ts test/config.test.ts test/ban-announce-text.test.ts test/ban-tick.test.ts`
Expected: FAIL. `../src/hub-tick.js` doesn't exist, and the Hub text isn't there yet.

- [ ] **Step 3: Implement `hub-tick.ts`**

```ts
import type { Database } from "@factions/db";
import { bans, consumerCursors, events } from "@factions/db";
import { readEventBatch, writeCursor } from "@factions/event-log";
import { HUB_BAN_MS, HUB_OFFENCE_MAX_AGE_MS, HUB_RETALIATION_WINDOW_MS, hubOffence } from "@factions/domain";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";

/** ⚠️ Distinct from every other consumer name; two consumers sharing a cursor skip each other's events. */
export const HUB_CONSUMER = "hub-watch";

export type HubTickResult = { seeded: boolean; scanned: number; banned: { dayzId: string; gamertag: string }[] };

const WATCHED = ["player.hit", "player.killed", "item.placed"];
/** A hub ban still to serve. `expired`/`lifted` do not block a new offence. */
const ACTIVE = ["pending", "applied"] as const;

/**
 * No combat at the Fast Travel Hub (spec 2026-09-22-hub-combat): a hit, kill
 * or trap there writes a one-hour `hub_combat` ban.
 *
 * ⚠️ This tick NEVER calls Nitrado. It writes `bans` rows; `banTick` applies,
 * expires and announces them, and its reference counting is what stops a Hub
 * ban's expiry from freeing an account that also holds another ban.
 *
 * ⚠️ The hour runs from NOW, when the bot processes the offence — an offence
 * can reach the ADM log long after it happened, and an hour measured from the
 * event would be spent before the ban ever reached the server.
 */
export async function hubTick(db: Database, opts: { now?: Date; batchSize?: number } = {}): Promise<HubTickResult> {
  const now = opts.now ?? new Date();
  const out: HubTickResult = { seeded: false, scanned: 0, banned: [] };

  // ⚠️ Forward-only. With no cursor row, start at the head: the log already
  // holds a week of Hub fighting from before the rule existed, and replaying it
  // would ban everyone in it. HUB_OFFENCE_MAX_AGE_MS is the backstop if the
  // row is ever lost after that; this is the primary defence.
  const [row] = await db.select({ n: consumerCursors.lastEventId }).from(consumerCursors).where(eq(consumerCursors.consumerName, HUB_CONSUMER));
  if (!row) {
    const [head] = await db.select({ n: sql<number>`coalesce(max(${events.id}), 0)::bigint` }).from(events);
    await writeCursor(db, HUB_CONSUMER, Number(head?.n ?? 0));
    return { ...out, seeded: true };
  }

  let cursor = row.n;
  const staleBefore = now.getTime() - HUB_OFFENCE_MAX_AGE_MS;
  for (;;) {
    const batch = await readEventBatch(db, cursor, opts.batchSize ?? 500);
    if (batch.length === 0) break;
    await db.transaction(async (tx) => {
      for (const ev of batch) {
        if (!WATCHED.includes(ev.type) || ev.occurredAt.getTime() < staleBefore) continue;
        const o = hubOffence(ev.type, ev.payload);
        if (!o) continue;
        out.scanned++;

        if (o.victim !== null) {
          // Self-defence: did the victim hit or kill the offender first? "First"
          // is (occurred_at, id): ⚠️ without the id tie-break a same-second
          // exchange makes each side the other's provocation and bans nobody.
          const [first] = await tx.select({ id: events.id }).from(events).where(and(
            eq(events.serverId, ev.serverId),
            inArray(events.type, ["player.hit", "player.killed"]),
            gte(events.occurredAt, new Date(ev.occurredAt.getTime() - HUB_RETALIATION_WINDOW_MS)),
            lte(events.occurredAt, ev.occurredAt),
            sql`(${events.occurredAt} < ${ev.occurredAt.toISOString()}::timestamptz or ${events.id} < ${ev.id})`,
            sql`${events.payload}->>'victimDayzId' = ${o.offender}`,
            sql`coalesce(${events.payload}->>'attackerDayzId', ${events.payload}->>'killerDayzId') = ${o.victim}`,
          )).limit(1);
          if (first) continue;
        }

        const [serving] = await tx.select({ id: bans.id }).from(bans).where(and(
          eq(bans.serverId, ev.serverId), eq(bans.dayzId, o.offender), eq(bans.reason, "hub_combat"), inArray(bans.status, [...ACTIVE]),
        )).limit(1);
        if (serving) continue;

        await tx.insert(bans).values({
          serverId: ev.serverId, dayzId: o.offender, gamertag: o.gamertag,
          bannedAt: now, expiresAt: new Date(now.getTime() + HUB_BAN_MS),
          status: "pending", reason: "hub_combat",
        });
        out.banned.push({ dayzId: o.offender, gamertag: o.gamertag });
      }
      // ⚠️ Same transaction as the inserts: a crash re-reads the whole batch,
      // and the `serving` check above makes that re-read write nothing twice.
      await writeCursor(tx, HUB_CONSUMER, batch[batch.length - 1]!.id);
    });
    cursor = batch[batch.length - 1]!.id;
  }
  return out;
}
```

If `writeCursor`'s `Tx` type doesn't accept drizzle's transaction handle here, check `packages/event-log/src/cursor.ts`. It is declared `Database | Tx`.

- [ ] **Step 4: Implement the config, wiring and wording**

`config.ts`, beside `unlinkedPcBan`:

```ts
  /**
   * No combat at the Fast Travel Hub. Writes `hub_combat` bans for `banTick`.
   * ⚠️ BAN_DRY_RUN is false in production, so the first Hub ban is REAL the
   * moment this is set — a deliberate act on a chosen day, never a deploy's.
   */
  hubBanTick: boolean;
```

Parse it with `hubBanTick: ["1", "true"].includes((env.HUB_BAN_TICK ?? "").toLowerCase()),`. Guard it next to the `UNLINKED_PC_BAN` guard:

```ts
  if (config.hubBanTick && !config.enforcementTick) {
    throw new Error("HUB_BAN_TICK is on but ENFORCEMENT_TICK is off — ban rows would be written and never applied.");
  }
```

`discord.ts`: import `hubTick`, and add this right after the `zoneTick` try/catch (every tick):

```ts
    // Every tick, beside zone: a Hub offence is written the tick it is read, so
    // banTick's next 5-minute pass applies it.
    if (cfg.hubBanTick) {
      try {
        const h = await hubTick(db, { now: new Date() });
        if (h.seeded) console.log("hub watch: cursor seeded at the log head");
        if (h.banned.length > 0) console.log(`hub watch: ${h.banned.length} ban(s) written: ${h.banned.map((b) => b.gamertag).join(", ")}`);
      } catch (err) {
        console.error("hub tick failed", err);
      }
    }
```

Then add a startup line beside the `UNLINKED_PC_BAN` one:

```ts
    if (!cfg.hubBanTick) console.warn("HUB_BAN_TICK is off: combat at the Fast Travel Hub is not being banned.");
    else console.log("HUB_BAN_TICK on: a hit, kill or trap at the Hub is a one-hour ban.");
```

`ban-tick.ts:209`: replace `reason: "base-zone enforcement",` with `reason: BAN_REASON_TEXT[row.reason],`, and import `BAN_REASON_TEXT` from `@factions/domain`. (That also fixes the PC ban's DM, which said "base-zone enforcement" too.)

`ban-announce-text.ts`: import `BAN_REASON_TEXT`, and replace the three `— base-zone enforcement.` literals with `— ${BAN_REASON_TEXT[a.reason]}.`. The `unlinked_pc` early return stays as it is.

- [ ] **Step 5: Run the tests and confirm they pass**

Run the Step 2 command. Expected: PASS. The existing zone-ban wording tests must still pass unchanged, because `BAN_REASON_TEXT.zone` keeps the old words.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/hub-tick.ts apps/bot/src/config.ts apps/bot/src/discord.ts apps/bot/src/ban-tick.ts apps/bot/src/ban-announce-text.ts apps/bot/test
git commit -m "feat(bot): a one-hour ban for combat at the Fast Travel Hub"
```

---

### Task 5: Discredit Hub kills in the stats

**Files:**
- Modify: `packages/roster/src/stats.ts` (`scoringKill` ~253, `bestStreaks` ~301, the `friendlyFire` board ~443, the profile's friendly-fire counts ~651, `Encounter`/`FeedEntry` types ~128-140, `encountersOf` ~698, and `playerFeedDb`'s union ~736)
- Modify: `packages/domain/src/streaks.ts`
- Test: `packages/roster/test/stats.test.ts`, `packages/domain/test/streaks.test.ts`

**Interfaces:**
- Consumes: `kills.atHub` (Task 3)
- Produces:
  - `Encounter.atHub: boolean`
  - The `kill` and `death` variants of `FeedEntry` gain `atHub: boolean`
  - `StreakRow.atHub?: boolean`

- [ ] **Step 1: Write the failing tests**

In `packages/roster/test/stats.test.ts`, extend `mkKill` with `atHub?: boolean`, passed as `atHub: a.atHub ?? false`. Then add a `describe("Hub kills score nowhere", …)` block using the file's existing setup, reads and ids (`A`, `B`, the all-time scope). It holds one test per surface, and each asserts **both sides**:

```ts
it("not a kill for the killer, not a death for the victim, on the boards", async () => {
  await mkKill({ at: h(t0, 1), victim: B, killer: A });
  await mkKill({ at: h(t0, 2), victim: B, killer: A, atHub: true });
  // read the killers and deaths boards the way the file's existing board tests do
  expect(killersValueFor(A)).toBe(1);
  expect(deathsValueFor(B)).toBe(1);
});
it("neither extends nor breaks a streak", async () => {
  await mkKill({ at: h(t0, 1), victim: B, killer: A });
  await mkKill({ at: h(t0, 2), victim: A, killer: B, atHub: true });   // a Hub death does not reset A
  await mkKill({ at: h(t0, 3), victim: B, killer: A });
  await mkKill({ at: h(t0, 4), victim: B, killer: A, atHub: true });   // a Hub kill does not extend
  expect(streakValueFor(A)).toBe(2);
});
it("⚠️ a Hub teamkill is not on the friendly-fire board or the profile's friendly-fire counts either", async () => {
  await mkKill({ at: h(t0, 1), victim: B, killer: A, victimFactionId: bearId, killerFactionId: bearId, friendlyFire: true, atHub: true });
  expect(friendlyFireValueFor(A)).toBeUndefined();
  const p = await profileOf(A);
  expect([p.friendlyFireKills, p.friendlyFireDeaths]).toEqual([0, 0]);
});
it("not on the profile's kills, deaths, K/D or longest kill", async () => {
  await mkKill({ at: h(t0, 1), victim: B, killer: A, atHub: true, distanceM: 400 });
  const pa = await profileOf(A); const pb = await profileOf(B);
  expect([pa.pvpKills, pb.pvpDeaths, pa.longestKill]).toEqual([0, 0, null]);
});
it("still a record: encounters and the feed carry it, marked atHub", async () => {
  await mkKill({ at: h(t0, 1), victim: B, killer: A, atHub: true });
  expect((await profileOf(A)).encounters[0]).toMatchObject({ atHub: true });
  expect((await feedOf(A)).entries[0]).toMatchObject({ kind: "kill", atHub: true });
});
```

`killersValueFor`, `deathsValueFor`, `streakValueFor`, `friendlyFireValueFor`, `profileOf` and `feedOf` stand for however the file already reads a board row, a profile and a feed page. Use its existing helpers and field names. If a helper doesn't exist, write it as a one-line local. **Do not weaken an assertion to fit.**

In `packages/domain/test/streaks.test.ts`:

```ts
it("a Hub kill neither extends a run nor, as a death, resets one", () => {
  const at = (n: number) => new Date(Date.UTC(2026, 8, 20, 0, n));
  const rows = [
    { killer: "A", victim: "B", friendlyFire: false, occurredAt: at(1) },
    { killer: "B", victim: "A", friendlyFire: false, atHub: true, occurredAt: at(2) },
    { killer: "A", victim: "B", friendlyFire: false, occurredAt: at(3) },
    { killer: "A", victim: "B", friendlyFire: false, atHub: true, occurredAt: at(4) },
  ];
  expect(streakOf(rows, "A").best).toBe(2);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd packages/roster && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/stats.test.ts` and `cd packages/domain && npx vitest run test/streaks.test.ts`.
Expected: FAIL. Hub kills still count.

- [ ] **Step 3: Implement**

`streaks.ts`: add `/** A Hub kill (spec 2026-09-22-hub-combat): skipped on both sides, like friendly fire. */ atHub?: boolean;` to `StreakRow`. In `streakOf`, change both `!r.friendlyFire` conditions to `!r.friendlyFire && !r.atHub`. Extend the doc comment's rule sentence to name Hub kills alongside friendly fire.

`stats.ts`:
- `const scoringKill = and(byAnotherPlayer, eq(kills.friendlyFire, false), eq(kills.atHub, false))!;` Add a line to its comment: `⚠️ A Hub kill (at_hub, spec 2026-09-22-hub-combat) is excluded by the same rule, for the same reason: it is not a fight.`
- `bestStreaks`: select `atHub: kills.atHub`, and write `if (r.friendlyFire || r.atHub) continue;`.
- The `friendlyFire` board and the two profile friendly-fire `killCount`s: add `eq(kills.atHub, false)`.
- `Encounter`, and the `kill`/`death` members of `FeedEntry`: add `atHub: boolean`.
- `encountersOf`: select `atHub: kills.atHub` and map it.
- `playerFeedDb`: add `at_hub` to `Raw` and to the outer `select`. In the kill and death branches, select `${kills.atHub} as at_hub` or `${kills.atHub}`. Every other branch selects `false`, placed right after its existing `friendly_fire` `false`. Map `atHub: r.at_hub` in the `kill` and `death` cases.

- [ ] **Step 4: Run the tests and confirm they pass**

Run the Step 2 commands. Expected: PASS, including every existing friendly-fire test.

- [ ] **Step 5: Commit**

```bash
git add packages/roster packages/domain/src/streaks.ts packages/domain/test/streaks.test.ts
git commit -m "feat(stats): a Hub kill scores nowhere, on either side"
```

---

### Task 6: Discredit Hub kills and hits in the Discord feeds

**Files:**
- Modify: `apps/bot/src/killstreak-feed-tick.ts:37` and its `readAfter`
- Modify: `apps/bot/src/long-range-feed-tick.ts` (`readAfter`'s select and `qualifies` at ~75, and the records counts)
- Modify: `apps/bot/src/kill-feed-tick.ts` (select at ~78, item at ~101, `tally` at ~155), `apps/bot/src/kill-feed-embed.ts`
- Modify: `apps/bot/src/hit-feed-tick.ts` (the input loop at ~149 and `suppressed` at ~286)
- Test: `apps/bot/test/killstreak-feed-store.test.ts`, `long-range-feed-store.test.ts`, `kill-feed-store.test.ts`, `kill-feed-embed.test.ts`, `hit-feed-store.test.ts`

**Interfaces:**
- Consumes: `kills.atHub` (Task 3); `atHub` and `readVec3` (Task 1); the hit payload positions (Task 2)
- Produces: `KillFeedItem.atHub: boolean`

- [ ] **Step 1: Write the failing tests**

Add one case to each store test, using that file's existing seed helpers. If a helper lacks an `atHub` option, add it.

- `killstreak-feed-store.test.ts`: A kills B five times, and the third is `atHub: true`. The item for the Hub kill has `streak: null`. The item for the fifth kill has `streak: 4`. Then add a Hub death of A between two of A's kills and assert A's run is not reset.
- `long-range-feed-store.test.ts`: a 400 m kill with `atHub: true` yields `qualifies: false`. A later 350 m non-Hub kill by the same killer is still a `personalBest`, because the Hub kill doesn't count as their best.
- `kill-feed-store.test.ts`: a Hub kill yields `atHub: true`. Its `tally.killerKills` counts only the killer's non-Hub kills.
- `kill-feed-embed.test.ts`:

```ts
it("a Hub kill is posted, marked, in amber — a record, not a score", () => {
  const e = killFeedEmbed({ ...item, atHub: true }, SITE);
  expect(e.title).toMatch(/^At the Hub — /u);
  expect(e.color).toBe(0xe67e22);
});
```

- `hit-feed-store.test.ts`: an engagement whose hits carry `victimPos`/`attackerPos` at the Hub (`{ x: 100, y: 998.6, z: 93 }`) comes back `suppressed: true`. The cursor still advances past it (assert the item is returned, so `cursorFeedTick` moves past it). An identical engagement on the ground comes back `suppressed: false`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/killstreak-feed-store.test.ts test/long-range-feed-store.test.ts test/kill-feed-store.test.ts test/kill-feed-embed.test.ts test/hit-feed-store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`killstreak-feed-tick.ts`:

```ts
/** A kill that counts toward a streak: PvP, not a clanmate, not at the Hub (spec 2026-09-22-hub-combat). */
const streakable = and(pvp, eq(kills.friendlyFire, false), eq(kills.atHub, false))!;
```

In `readAfter`, select `atHub: kills.atHub` and write `if (r.friendlyFire || r.atHub) {`. Extend the comment: a Hub kill, like a teamkill, neither advances nor breaks a streak. `runUpTo` already uses `streakable` for both the death and the kills, so it picks up the change.

`long-range-feed-tick.ts`: select `atHub: kills.atHub`. Use `const qualifies = !r.atHub && distanceM !== null && Number.isFinite(distanceM) && distanceM >= this.minM;` with the comment `// ⚠️ A Hub kill is never a record-worthy shot: it scores nowhere.`. Add `eq(kills.atHub, false)` to both `count(...)` calls in the records helper.

`kill-feed-embed.ts`: add `/** At the Fast Travel Hub: posted as a record, scores nowhere. */ atHub: boolean;` to `KillFeedItem`. In `killFeedEmbed`, build the title as `${k.atHub ? "At the Hub — " : k.friendlyFire ? "Friendly fire — " : ""}…` and set `color: k.atHub || k.friendlyFire ? AMBER : RUST`.

`kill-feed-tick.ts`: select `atHub: kills.atHub`, pass `atHub: r.atHub` on the item, and add `eq(kills.atHub, false)` to both `tally` counts.

`hit-feed-tick.ts`: import `atHub, readVec3` from `@factions/domain`. Before the input loop, add `const hub = new Set<number>();`. Inside the loop, after the `victimDayzId` guard, add:

```ts
      // ⚠️ Marked here, suppressed below — NOT dropped from `inputs`. A batch of
      // nothing but Hub hits would otherwise form no engagement, move no cursor,
      // and be re-read every tick forever.
      if (atHub(readVec3(p.victimPos)) || atHub(readVec3(p.attackerPos))) hub.add(Number(r.id));
```

Then change `suppressed` to `e.hits.some((h) => hub.has(h.eventId)) || await this.claimedByAKill(...)`. Update the comment above it to say both reasons: a kill claimed the engagement, or it happened at the Hub.

- [ ] **Step 4: Run the tests and confirm they pass**

Run the Step 2 command, then the whole bot suite: `cd apps/bot && TEST_DATABASE_URL=… npx vitest run`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot
git commit -m "feat(feeds): Hub kills and hits count for nothing in the Discord feeds"
```

---

### Task 7: Achievements, and revoking what no longer holds

**Files:**
- Modify: `apps/bot/src/achievements/rules-pvp.ts`
- Create: `apps/bot/src/achievements/revoke.ts`, `scripts/revoke-achievements.ts`
- Modify: root `package.json` (the `revoke:achievements` script)
- Test: `apps/bot/test/achievements/rules-pvp.test.ts`, `apps/bot/test/achievements/revoke.test.ts` (new), `apps/bot/test/achievements/seed.ts`

**Interfaces:**
- Consumes: `kills.atHub`; `StreakRow.atHub` (Task 5)
- Produces:
  - `REVOCABLE_KEYS: readonly AchievementKey[]`
  - `type RevokeResult = { owners: number; revoked: { ownerId: string; key: string }[]; redated: { ownerId: string; key: string }[]; failed: number }`
  - `revokeAchievements(db: Database, opts: { apply: boolean; now?: Date; onError?: (ownerId: string, key: string, err: unknown) => void }): Promise<RevokeResult>`

- [ ] **Step 1: Write the failing tests**

In `seed.ts`, give `seedKill` an `atHub?: boolean` option, written as `atHub: a.atHub ?? false`.

In `rules-pvp.test.ts`:

```ts
it("Hub kills earn nothing: counts, distance, streaks, nemesis and payback all ignore them", async () => {
  await seedKill(db, { serverId, killer: A, victim: B, at: m(0), distanceM: 400, atHub: true });
  expect((await rule("first_blood")(db, player, ctx)).count).toBe(0);
  expect((await rule("sniper")(db, player, ctx)).count).toBe(0);
  for (let i = 0; i < 5; i++) await seedKill(db, { serverId, killer: A, victim: B, at: m(10 + i), atHub: true });
  expect((await rule("nemesis")(db, player, ctx)).count).toBe(0);
  expect((await rule("killing_spree")(db, player, ctx)).count).toBe(0);
  await seedKill(db, { serverId, killer: B, victim: A, at: m(20), atHub: true });   // a Hub death is not "them killing you"
  await seedKill(db, { serverId, killer: A, victim: B, at: m(21) });
  expect((await rule("payback")(db, player, ctx)).count).toBe(0);
});
it("a Hub death does not break a streak", async () => {
  for (let i = 0; i < 3; i++) await seedKill(db, { serverId, killer: A, victim: B, at: m(i) });
  await seedKill(db, { serverId, killer: B, victim: A, at: m(5), atHub: true });
  for (let i = 0; i < 2; i++) await seedKill(db, { serverId, killer: A, victim: C, at: m(10 + i) });
  expect((await rule("killing_spree")(db, player, ctx)).count).toBe(5);
});
```

`apps/bot/test/achievements/revoke.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, achievementUnlocks, achievementProgress, type Database } from "@factions/db";
import { ACHIEVEMENT_BY_KEY } from "@factions/domain";
import { sql } from "drizzle-orm";
import { REVOCABLE_KEYS, revokeAchievements } from "../../src/achievements/revoke.js";
import { PVP_RULES } from "../../src/achievements/rules-pvp.js";
import { seedServer, seedKill, TRUNCATE } from "./seed.js";

const URL = requireTestDatabaseUrl();
const A = "A".repeat(36), B = "B".repeat(36);
const t0 = new Date("2026-09-20T10:00:00Z");
const m = (n: number) => new Date(t0.getTime() + n * 60_000);

describe("revokeAchievements", () => {
  let db: Database; let serverId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => { await tx.execute(sql`set local client_min_messages = warning`); await tx.execute(sql.raw(TRUNCATE)); });
    serverId = (await seedServer(db)).id;
  });
  const unlock = (key: string, earnedAt: Date, evidenceId: number | null = null) =>
    db.insert(achievementUnlocks).values({ ownerKind: "player", ownerId: A, key, earnedAt, evidenceId, evidence: {} });
  const held = async () => (await db.select({ key: achievementUnlocks.key }).from(achievementUnlocks)).map((r) => r.key).sort();

  it("⚠️ only kill-derived PvP keys — never a position, pin, raid or defence rule", () => {
    for (const k of REVOCABLE_KEYS) {
      expect(PVP_RULES[k]).toBeDefined();
      expect(ACHIEVEMENT_BY_KEY[k].group).toBe("pvp");
    }
    for (const k of ["flag_thief", "home_defender", "blue_on_blue"]) expect(REVOCABLE_KEYS).not.toContain(k);
  });

  it("revokes a badge that only Hub kills earned, and resets its progress", async () => {
    const k = await seedKill(db, { serverId, killer: A, victim: B, at: m(0), atHub: true });
    await unlock("first_blood", m(0), k.id);
    const r = await revokeAchievements(db, { apply: true });
    expect(r.revoked).toEqual([{ ownerId: A, key: "first_blood" }]);
    expect(await held()).toEqual([]);
    const [p] = await db.select().from(achievementProgress);
    expect(p).toMatchObject({ key: "first_blood", count: 0 });
  });

  it("keeps a badge that still holds, re-dated to the real kill that earns it", async () => {
    await seedKill(db, { serverId, killer: A, victim: B, at: m(0), atHub: true });
    const real = await seedKill(db, { serverId, killer: A, victim: B, at: m(30) });
    await unlock("first_blood", m(0));
    const r = await revokeAchievements(db, { apply: true });
    expect(r.revoked).toEqual([]);
    expect(r.redated).toEqual([{ ownerId: A, key: "first_blood" }]);
    const [u] = await db.select().from(achievementUnlocks);
    expect(u).toMatchObject({ earnedAt: m(30), evidenceId: real.id });
  });

  it("a dry run reports and writes nothing", async () => {
    await seedKill(db, { serverId, killer: A, victim: B, at: m(0), atHub: true });
    await unlock("first_blood", m(0));
    const r = await revokeAchievements(db, { apply: false });
    expect(r.revoked).toHaveLength(1);
    expect(await held()).toEqual(["first_blood"]);
  });

  it("⚠️ a rule that throws revokes nothing — an error is not 'no longer earned'", async () => {
    await unlock("first_blood", m(0));
    await db.execute(sql`alter table kills rename column at_hub to at_hub_gone`);
    try {
      const errors: string[] = [];
      const r = await revokeAchievements(db, { apply: true, onError: (_o, key) => errors.push(key) });
      expect(r.failed).toBe(1);
      expect(errors).toEqual(["first_blood"]);
      expect(await held()).toEqual(["first_blood"]);
    } finally {
      await db.execute(sql`alter table kills rename column at_hub_gone to at_hub`);
    }
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd apps/bot && TEST_DATABASE_URL=… npx vitest run test/achievements/rules-pvp.test.ts test/achievements/revoke.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the rules**

In `rules-pvp.ts`:
- `pvpBy`: add `eq(kills.atHub, false)`, and update its comment to "…not friendly fire, and not at the Hub (spec 2026-09-22-hub-combat)".
- In `streak`'s select, add `atHub: kills.atHub` so `streakOf` sees it.
- In `payback`'s SQL, add `and k.at_hub = false` to the outer `where`, and `and ${k2}.at_hub = false` inside `exists`.
- Leave `blue_on_blue` unchanged, with this comment above it: `// A record, not a score: a Hub teamkill still counts here (spec 2026-09-22-hub-combat §4.3).`

- [ ] **Step 4: Implement `revoke.ts`**

```ts
import type { AchievementKey } from "@factions/domain";
import { achievementProgress, achievementUnlocks, type Database } from "@factions/db";
import { and, eq, inArray } from "drizzle-orm";
import { PVP_RULES } from "./rules-pvp.js";

/**
 * The achievements a discredited kill can have earned (spec 2026-09-22-hub-combat §2.8).
 *
 * ⚠️ Kill-derived rules ONLY. Re-running a position- or pin-based rule today
 * reads data the reaper has already deleted (POSITION_RETENTION_MS), comes
 * back "not earned", and would revoke a badge that was fairly won. Pinned by
 * revoke.test.ts: every key here is a PvP rule, and none of the three PvP
 * rules that do not read `kills` scoring is here.
 */
export const REVOCABLE_KEYS = [
  "first_blood", "ten_down", "centurion", "marksman", "sniper", "point_blank",
  "arsenal", "hat_trick", "killing_spree", "unstoppable", "nemesis", "payback",
] as const satisfies readonly AchievementKey[];

export type RevokeResult = { owners: number; revoked: { ownerId: string; key: string }[]; redated: { ownerId: string; key: string }[]; failed: number };

/**
 * Re-run the kill-derived rules for every player holding one of their badges.
 * A badge that no longer holds is deleted, silently (spec §2.8). A badge that
 * still holds but was earned at a different kill is re-dated to it: the kill
 * rebuild renumbers `kills.id`, so every kept badge's evidence id is stale anyway.
 */
export async function revokeAchievements(db: Database, opts: { apply: boolean; now?: Date; onError?: (ownerId: string, key: string, err: unknown) => void }): Promise<RevokeResult> {
  const now = opts.now ?? new Date();
  const out: RevokeResult = { owners: 0, revoked: [], redated: [], failed: 0 };
  const rows = await db.select().from(achievementUnlocks)
    .where(and(eq(achievementUnlocks.ownerKind, "player"), inArray(achievementUnlocks.key, [...REVOCABLE_KEYS])));
  const byOwner = new Map<string, typeof rows>();
  for (const r of rows) byOwner.set(r.ownerId, [...(byOwner.get(r.ownerId) ?? []), r]);

  for (const [ownerId, held] of byOwner) {
    out.owners++;
    for (const u of held) {
      const key = u.key as AchievementKey;
      let r;
      // ⚠️ A throw is NOT "no longer earned": skip, count, report. Treating it as
      // a revocation would strip every badge on one bad query.
      try { r = await PVP_RULES[key]!(db, { kind: "player", id: ownerId }, { now }); }
      catch (err) { out.failed++; opts.onError?.(ownerId, key, err); continue; }

      const earned = r.earnedAt !== undefined && r.count >= r.target;
      if (!earned) {
        out.revoked.push({ ownerId, key });
        if (opts.apply) await db.transaction(async (tx) => {
          // Lock order (CLAUDE.md): achievement_unlocks → achievement_progress.
          await tx.delete(achievementUnlocks).where(and(eq(achievementUnlocks.ownerKind, "player"), eq(achievementUnlocks.ownerId, ownerId), eq(achievementUnlocks.key, key)));
          await tx.insert(achievementProgress).values({ ownerKind: "player", ownerId, key, count: r.count, target: r.target, computedAt: now })
            .onConflictDoUpdate({ target: [achievementProgress.ownerKind, achievementProgress.ownerId, achievementProgress.key], set: { count: r.count, target: r.target, computedAt: now } });
        });
      } else if (r.earnedAt!.getTime() !== u.earnedAt.getTime() || (r.evidenceId ?? null) !== u.evidenceId) {
        out.redated.push({ ownerId, key });
        if (opts.apply) await db.update(achievementUnlocks)
          .set({ earnedAt: r.earnedAt!, evidenceId: r.evidenceId ?? null, evidence: r.evidence ?? {} })
          .where(and(eq(achievementUnlocks.ownerKind, "player"), eq(achievementUnlocks.ownerId, ownerId), eq(achievementUnlocks.key, key)));
      }
    }
  }
  return out;
}
```

`scripts/revoke-achievements.ts`:

```ts
/**
 * Revoke achievements that discredited Hub kills earned (spec 2026-09-22-hub-combat §2.8;
 * runbook docs/deploy/2026-09-22-hub-combat.md). A DRY RUN unless `--apply`.
 *
 *   pnpm --filter @factions/bot exec tsx ../../scripts/revoke-achievements.ts [--apply]
 *
 * ⚠️ Run AFTER `rebuild:kills` — before it, `kills.at_hub` is false everywhere and
 * this finds nothing. Same `factions_live` guard as backfill-achievements.ts.
 */
import { createClient } from "@factions/db";
import { revokeAchievements } from "../apps/bot/src/achievements/revoke.js";

const url = process.env.DATABASE_URL;
const allowTest = process.argv.includes("--allow-test-db");
const apply = process.argv.includes("--apply");
if (!url) { console.error("DATABASE_URL unset"); process.exit(2); }
if (!url.endsWith("/factions_live") && !allowTest) { console.error(`refusing: not factions_live -> ${url} (pass --allow-test-db to override)`); process.exit(2); }

const db = createClient(url);
const r = await revokeAchievements(db, { apply, onError: (o, k, err) => console.error(`rule ${k} failed for ${o}`, err) });
for (const x of r.revoked) console.log(`${apply ? "revoked" : "would revoke"}: ${x.key} from ${x.ownerId}`);
for (const x of r.redated) console.log(`${apply ? "re-dated" : "would re-date"}: ${x.key} for ${x.ownerId}`);
console.log(`${apply ? "applied" : "DRY RUN"}: ${r.owners} owners, ${r.revoked.length} revoked, ${r.redated.length} re-dated, ${r.failed} rule failures`);
await db.$client.end();
process.exit(r.failed ? 1 : 0);
```

Add `"revoke:achievements": "tsx scripts/revoke-achievements.ts"` to the root `package.json` scripts, next to `backfill:achievements`.

- [ ] **Step 5: Run the tests and confirm they pass**

Run the Step 2 command, plus `pnpm typecheck:scripts` from the root.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/achievements apps/bot/test/achievements scripts/revoke-achievements.ts package.json
git commit -m "feat(achievements): Hub kills earn nothing; revoke what they earned"
```

---

### Task 8: Backfill positions onto past events

**Files:**
- Modify: `apps/bot/package.json` (add `"@factions/adm-parser": "workspace:*"`), then run `pnpm install`
- Create: `apps/bot/src/hub-backfill.ts`, `scripts/backfill-hub-positions.ts`
- Modify: root `package.json` (the `backfill:hub-positions` script)
- Test: `apps/bot/test/hub-backfill.test.ts` (new)

**Interfaces:**
- Consumes: `parseLine` from `@factions/adm-parser` (Task 2's positions)
- Produces:
  - `type BackfillResult = { scanned: number; updated: number; unparsed: number }`
  - `backfillHubPositions(db: Database, opts: { serverId: number; apply: boolean; batchSize?: number }): Promise<BackfillResult>`

- [ ] **Step 1: Write the failing test**

`apps/bot/test/hub-backfill.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, rawLines, events, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { backfillHubPositions } from "../src/hub-backfill.js";

const URL = requireTestDatabaseUrl();
const V = "A".repeat(40), K = "B".repeat(40);
const HIT = `17:24:38 | Player "Vic" (id=${V} pos=<101.0, 95.0, 998.6>)[HP: 71.6] hit by Player "Kil" (id=${K} pos=<99.3, 93.2, 998.6>) into Torso(21) for 28.3 damage (Bullet_556x45) with M4-A1 from 2.6 meters`;
const KILL = `17:25:00 | Player "Vic" (DEAD) (id=${V} pos=<101.0, 95.0, 998.6>) killed by Player "Kil" (id=${K} pos=<99.0, 93.0, 998.6>) with M4-A1 from 2.1 meters`;

describe("backfillHubPositions", () => {
  let db: Database; let serverId = 0; let fileId = 0; let line = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate events, raw_lines, adm_files, servers restart identity cascade`);
    serverId = (await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning())[0]!.id;
    fileId = (await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: new Date(), linesIngested: 0, complete: true }).returning())[0]!.id;
    line = 0;
  });
  const ingested = async (type: string, content: string, payload: Record<string, unknown>) => {
    const [r] = await db.insert(rawLines).values({ admFileId: fileId, lineIndex: line, content }).returning();
    await db.insert(events).values({ serverId, admFileId: fileId, lineIndex: line++, type: type as never, occurredAt: new Date(), payload, rawLineId: r!.id });
  };
  const payloads = async () => (await db.select().from(events).orderBy(events.id)).map((e) => e.payload as Record<string, unknown>);

  it("adds positions re-parsed from the stored raw line, keeping every existing key", async () => {
    await ingested("player.hit", HIT, { victimDayzId: V, attackerDayzId: K, damage: 28.3 });
    await ingested("player.killed", KILL, { victimDayzId: V, killerDayzId: K });
    const r = await backfillHubPositions(db, { serverId, apply: true });
    expect(r).toEqual({ scanned: 2, updated: 2, unparsed: 0 });
    const [hit, kill] = await payloads();
    expect(hit).toMatchObject({ damage: 28.3, victimPos: { x: 101, y: 998.6, z: 95 }, attackerPos: { x: 99.3, y: 998.6, z: 93.2 } });
    expect(kill).toMatchObject({ victimPos: { x: 101, y: 998.6, z: 95 }, killerPos: { x: 99, y: 998.6, z: 93 } });
    expect("pos" in hit! || "pos" in kill!).toBe(false);
  });

  it("is idempotent and skips events that already carry positions", async () => {
    await ingested("player.hit", HIT, { victimDayzId: V });
    await backfillHubPositions(db, { serverId, apply: true });
    expect(await backfillHubPositions(db, { serverId, apply: true })).toEqual({ scanned: 0, updated: 0, unparsed: 0 });
  });

  it("a dry run counts and writes nothing", async () => {
    await ingested("player.hit", HIT, { victimDayzId: V });
    expect((await backfillHubPositions(db, { serverId, apply: false })).updated).toBe(1);
    expect("victimPos" in (await payloads())[0]!).toBe(false);
  });

  it("an event without a raw line is counted as unparsed, not guessed", async () => {
    await db.insert(events).values({ serverId, admFileId: fileId, lineIndex: line++, type: "player.hit", occurredAt: new Date(), payload: { victimDayzId: V } });
    expect(await backfillHubPositions(db, { serverId, apply: true })).toEqual({ scanned: 1, updated: 0, unparsed: 1 });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd apps/bot && TEST_DATABASE_URL=… npx vitest run test/hub-backfill.test.ts`
Expected: FAIL, because the module doesn't exist.

- [ ] **Step 3: Implement**

Add the dependency and run `pnpm install` from the root.

`apps/bot/src/hub-backfill.ts`:

```ts
import { parseLine } from "@factions/adm-parser";
import { events, rawLines, type Database } from "@factions/db";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

export type BackfillResult = { scanned: number; updated: number; unparsed: number };

/**
 * Give every past `player.hit`/`player.killed` event the positions the parser
 * now keeps (spec 2026-09-22-hub-combat §4.4), so `rebuild:kills` can mark Hub
 * kills retroactively.
 *
 * ⚠️ Re-parses with the SAME `parseLine` the worker uses, and takes the entry
 * at the event's own `sub_index` — the index the worker wrote it under — so a
 * backfilled payload is exactly what ingest would write today. Never a second,
 * hand-written regex: that is two statements of one fact.
 *
 * Idempotent: only events without `victimPos` are read, and the positions are
 * MERGED into the payload, never replacing a key already there.
 */
export async function backfillHubPositions(db: Database, opts: { serverId: number; apply: boolean; batchSize?: number }): Promise<BackfillResult> {
  const out: BackfillResult = { scanned: 0, updated: 0, unparsed: 0 };
  let after = 0;
  for (;;) {
    const batch = await db.select({ id: events.id, type: events.type, subIndex: events.subIndex, content: rawLines.content })
      .from(events).leftJoin(rawLines, eq(rawLines.id, events.rawLineId))
      .where(and(
        eq(events.serverId, opts.serverId), gt(events.id, after),
        inArray(events.type, ["player.hit", "player.killed"]),
        sql`not (${events.payload} ? 'victimPos')`,
      ))
      .orderBy(asc(events.id)).limit(opts.batchSize ?? 1000);
    if (batch.length === 0) break;
    for (const e of batch) {
      out.scanned++;
      const parsed = e.content === null ? undefined : parseLine(e.content)[e.subIndex];
      const add = parsed?.kind === "hit" ? { victimPos: parsed.event.victimPos, attackerPos: parsed.event.attackerPos }
        : parsed?.kind === "death" && parsed.event.kind === "killed" ? { victimPos: parsed.event.victimPos, killerPos: parsed.event.killerPos }
        : null;
      if (!add) { out.unparsed++; continue; }
      out.updated++;
      if (opts.apply) await db.update(events).set({ payload: sql`${events.payload} || ${JSON.stringify(add)}::jsonb` }).where(eq(events.id, e.id));
    }
    // ⚠️ Keyset on id, not OFFSET: a dry run changes nothing, so an offset loop
    // and a `not ? 'victimPos'` filter together would re-read the first page forever.
    after = batch[batch.length - 1]!.id;
  }
  return out;
}
```

`scripts/backfill-hub-positions.ts`: same header and guard shape as `scripts/revoke-achievements.ts`. It requires `--server <id>` (usage error, exit 2), takes `--apply` and `--allow-test-db`, calls `backfillHubPositions`, and prints `${apply ? "applied" : "DRY RUN"}: ${scanned} scanned, ${updated} updated, ${unparsed} unparsed`. Its doc comment carries `⚠️ Run BEFORE rebuild:kills — the rebuild reads these positions.` and the bot-package invocation form.

Add `"backfill:hub-positions": "tsx scripts/backfill-hub-positions.ts"` to the root `package.json`.

- [ ] **Step 4: Run the test and confirm it passes**

Run the Step 2 command, plus `pnpm typecheck:scripts`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/package.json pnpm-lock.yaml apps/bot/src/hub-backfill.ts apps/bot/test/hub-backfill.test.ts scripts/backfill-hub-positions.ts package.json
git commit -m "feat(scripts): backfill positions onto past hit and kill events"
```

---

### Task 9: The site and the guide

**Files:**
- Modify: `apps/web/lib/feed-copy.ts`, `apps/web/app/components/player-feed.tsx`
- Modify: `packages/domain/src/guide-numbers.ts`
- Modify: `apps/web/content/guide/11-getting-around.html`, `12-fair-play.html`, `13-rules-on-one-page.html`
- Test: `apps/web/test/feed-copy.test.ts`, `packages/domain/test/guide-numbers.test.ts`

**Interfaces:**
- Consumes: `Encounter.atHub` and `FeedEntry.atHub` (Task 5); the `HUB_*` numbers (Task 1)
- Produces: `HUB_MARK` in `feed-copy.ts`

- [ ] **Step 1: Write the failing tests**

In `feed-copy.test.ts`, add `HUB_MARK` to the import and `expect(HUB_MARK).toBe("at the Hub — doesn't count");`.

In `guide-numbers.test.ts`, append three labels to `LABELS`: `"Hub: combat ban"`, `"Hub: self-defence window"`, `"Hub: no-combat radius"`. Rename the count test to `"has the 52 rows…"`. Add to `renders the values the guide promised`:

```ts
expect(v["Hub: combat ban"]).toBe("1 h");
expect(v["Hub: self-defence window"]).toBe("2 min");
expect(v["Hub: no-combat radius"]).toBe("100 m");
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd packages/domain && npx vitest run test/guide-numbers.test.ts` and `cd apps/web && npx vitest run test/feed-copy.test.ts`.
Expected: FAIL.

- [ ] **Step 3: Implement**

`feed-copy.ts`: add `export const HUB_MARK = "at the Hub — doesn't count";` next to `FRIENDLY_FIRE_MARK`.

`player-feed.tsx`: import `HUB_MARK`, and add `const Hub = () => <Detail><span className="text-rust-2">{HUB_MARK}</span></Detail>;` next to `FF`. Beside each of the three `{e.friendlyFire && <FF />}`, add `{e.atHub && <Hub />}`.

`guide-numbers.ts`: add `HUB_BAN_MS: R.HUB_BAN_MS, HUB_RETALIATION_WINDOW_MS: R.HUB_RETALIATION_WINDOW_MS, HUB_ZONE_RADIUS_M: R.HUB_ZONE_RADIUS_M,` to `SCALARS`, then add these after the "Window to press charges" row:

```ts
  row("Fair play", "Hub: combat ban", "HUB_BAN_MS"),
  row("Fair play", "Hub: self-defence window", "HUB_RETALIATION_WINDOW_MS"),
  row("Fair play", "Hub: no-combat radius", "HUB_ZONE_RADIUS_M"),
```

`12-fair-play.html`: after the "Combat logging" section, add:

```html
<h2>No combat at the Hub</h2>
<div class="rule"><p><strong>The Fast Travel Hub is a no-combat zone.</strong> Hit someone, kill someone, or place a trap or explosive there, and you are banned for {{HUB_BAN_MS|hours}}. It is automatic: no ticket, no staff. The bot reads it straight from the log.</p></div>
<ul>
<li>Self-defence is allowed. If someone hits you, you may hit them back for {{HUB_RETALIATION_WINDOW_MS|minutes}}. Whoever lands the first hit is the one banned.</li>
<li>The Hub is everything within {{HUB_ZONE_RADIUS_M|m}} of the arrival point, up in the sky. The ground directly below it is ordinary map, and a fight there is fine.</li>
<li>A kill at the Hub counts for nothing: not on the boards, not your K/D, not a streak, not an achievement. That goes for every kill ever made there, not just new ones.</li>
<li>Each offence is one {{HUB_BAN_MS|hours}} ban. More hits while that ban is on its way don't add to it.</li>
</ul>
```

In the chapter's "Enforcement" list, extend the first bullet's exception sentence with: `Combat at the Hub is the other exception: the bot bans it on its own.`

`11-getting-around.html`: replace the `.rule` paragraph with:

```html
<div class="rule"><p><strong>The Hub is shared, neutral, and a no-combat zone.</strong> Other survivors can be standing in it when you arrive, but nobody may hit, kill or trap anyone there — it is an automatic {{HUB_BAN_MS|hours}} ban. See <a href="/guide/fair-play">Fair play</a>.</p></div>
```

`13-rules-on-one-page.html`: replace `<li>The Hub is neutral and shared. Combat logging rules still apply to a fast-travel relog.</li>` with:

```html
<li>The Hub is neutral, shared and a no-combat zone: a hit, a kill or a trap there is an automatic {{HUB_BAN_MS|hours}} ban, and a kill there counts for nothing. Combat logging rules still apply to a fast-travel relog.</li>
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd packages/domain && npx vitest run` and `cd apps/web && TEST_DATABASE_URL=… npx vitest run`. The web suite includes `guide.test.ts`, which fails on a hand-typed number or an unknown token.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web packages/domain/src/guide-numbers.ts packages/domain/test/guide-numbers.test.ts
git commit -m "feat(guide): no combat at the Hub; mark Hub kills on the site"
```

---

### Task 10: Runbook, CLAUDE.md, changelog, and the gate

**Files:**
- Create: `docs/deploy/2026-09-22-hub-combat.md`
- Modify: `CLAUDE.md` (a "Where things live" row)
- Modify: `CHANGELOG.md` (under `## [Unreleased]`)

- [ ] **Step 1: Write the runbook**

`docs/deploy/2026-09-22-hub-combat.md`. It has these sections, in this order:

1. **What ships.** The Hub rule, and `kills.at_hub` (migration 0047, additive, safe with the old bot running). The release deploy applies it and rebuilds the ingest-worker image. From then on, new hit and kill events carry positions.
2. **Before you start.** `ENFORCEMENT_TICK` is on. ⚠️ `BAN_DRY_RUN` is **false** in production, so the first Hub ban is real. Pick a quiet hour, since the bot is stopped from step 3 through step 6.
3. **Stop the bot:** `sudo systemctl stop clan-wars-bot`. Confirm with `systemctl status clan-wars-bot`.
4. **Backfill positions.** First a dry run, `cd /opt/clan-wars && set -a && . ./.env && set +a && pnpm --filter @factions/bot exec tsx ../../scripts/backfill-hub-positions.ts --server 1`, which should show `unparsed` near zero. Then the same command with `--apply`.
5. **Rebuild kills:** `pnpm --filter @factions/bot exec tsx ../../scripts/rebuild-kills.ts --server 1`. Verify:
   ```sql
   select count(*) filter (where at_hub) hub, count(*) from kills;
   ```
   Expect `hub` ≈ 62 as of 2026-09-22, more if there has been fighting since. Explain why the feeds won't repost: every poster keeps its cursor on `kills.event_id`, which the rebuild preserves.
6. **Revoke achievements.** First a dry run, `pnpm --filter @factions/bot exec tsx ../../scripts/revoke-achievements.ts`. **Read the list** before running it with `--apply`. It must be run after step 5.
7. **Turn it on.** Add `HUB_BAN_TICK=true` to `.env`, then `sudo systemctl start clan-wars-bot`. Expect the startup line `HUB_BAN_TICK on: …` and, on the first tick, `hub watch: cursor seeded at the log head`. Nobody is banned for anything before that line.
8. **Verify.** `select id, gamertag, status, banned_at, expires_at from bans where reason = 'hub_combat' order by id desc limit 10;` A ban goes `pending` → `applied` within 5 minutes, and `expired` an hour after `banned_at`.
9. **Known limits.**
   - A ban reaches Nitrado up to one `banTick` block after it is written, and those minutes come out of the hour.
   - A player already online when a ban lands is kept out when they next connect. Whether Nitrado's ban list also kicks a player who is already connected is not established. Fast travel is a relog, so a Hub offender usually reconnects within minutes.
   - `Plastic_Explosive` is unobserved (see `HUB_TRAP_CLASSES`).
   - A PvE survival achievement still counts a Hub death, exactly as it counts a friendly-fire death. Only the PvP rules discredit.
10. **Rollback.** Remove `HUB_BAN_TICK` from `.env` and restart the bot. Pending Hub bans still apply and expire on their own within the hour. Leave `kills.at_hub` in place; the column is harmless.

- [ ] **Step 2: CLAUDE.md and CHANGELOG**

Add a "Where things live" row:

`| No combat at the Hub (a hit, kill or trap there is a one-hour ban; Hub kills score nowhere) | Zone and offence rule `packages/domain/src/hub.ts` (numbers in `rules.ts`), positions on hit/kill payloads (`posInIdentity`, `adm-parser`), the ban tick `apps/bot/src/hub-tick.ts` gated on `HUB_BAN_TICK` (refuses without `ENFORCEMENT_TICK`; writes `bans` rows with `reason = 'hub_combat'` for `banTick`), `kills.at_hub` (migration 0047) excluded beside `friendly_fire` in `scoringKill`, the streak reads, the PvP achievements and the feeds. ⚠️ The ban hour runs from when the bot PROCESSES the offence, never the event's time. ⚠️ `hub-watch` seeds itself at the log head on first run; `HUB_OFFENCE_MAX_AGE_MS` is only the backstop. ⚠️ Payload keys are `victimPos`/`attackerPos`/`killerPos`, never `pos`. Spec `docs/superpowers/specs/2026-09-22-hub-combat-design.md`, runbook `docs/deploy/2026-09-22-hub-combat.md` |`

`CHANGELOG.md` under `## [Unreleased]`, in the file's existing sub-heading style:

```markdown
### Added
- No combat at the Fast Travel Hub: a hit, kill or trap placed there is an automatic one-hour ban (`HUB_BAN_TICK`). Firing back within two minutes of being hit is self-defence.

### Changed
- A kill at the Hub counts for nothing — boards, K/D, streaks, achievements and the Discord feeds — including every Hub kill already on record. Achievements that only Hub kills earned are revoked.
- The ban DM names the real reason for every ban (it said "base-zone enforcement" for all of them).
```

- [ ] **Step 3: Run the full gate**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`
Expected: **30/30 tasks successful.** Check the count, not the exit code. No other gate or vitest may be running at the same time. If a package's test database predates migration 0047 and fails oddly, drop that `factions_test_<package>` once. Never touch `factions_live`.

- [ ] **Step 4: Commit**

```bash
git add docs/deploy/2026-09-22-hub-combat.md CLAUDE.md CHANGELOG.md
git commit -m "docs: hub combat runbook, CLAUDE.md map, changelog"
```
