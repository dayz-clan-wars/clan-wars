# Achievements to 150 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three ADM ingest gaps, then grow the earnable achievement catalogue from 49 to exactly 150 (retire Wolf Bait and Bear Necessities, add 103), with rules, badge art, surfaces, a silent backfill and one summary DM per player.

**Architecture:** Two pull requests. **Part A** (ingest) fixes the parser, adds two event shapes, and adds an in-place payload repair script so history is corrected without deleting events. It ships and runs on production on its own. **Part B** (achievements) adds the data tables in `packages/domain`, a per-owner memo so 100+ rules share their reads, the new definitions with their rules and art group by group, the surfaces, and the summary notice. Each Part B task adds definitions, rules and art together, so the "every key has a rule and a glyph" tests stay green after every task.

**Tech Stack:** TypeScript, pnpm + turbo, vitest, drizzle-orm over postgres.js, Next.js (apps/web), sharp (PNG render).

**Spec:** `docs/superpowers/specs/2026-10-20-achievements-150-design.md`

## Global Constraints

- `EARNABLE_ACHIEVEMENTS.length === 150`; 153 defined; retired: `wanderer`, `wolf_bait`, `bear_necessities`.
- Clan (team) tiles: 12 → 16.
- Every PvP rule counts only kills passing `pvpBy` in `rules-pvp.ts` (killer is the owner, not a self-kill, `friendly_fire = false`, `at_hub = false`). Never respell it.
- A rule's `earnedAt` is the crossing row's time, never `now`; evidence never carries a coordinate.
- Existing unlocks are never revoked by this work.
- Ruin repairs stay `base.built` (`structure: null`); they count toward NO build-point rule or board, but base-zone enforcement keeps seeing them unchanged.
- Gun kills are lifetime and any map; sawed-off variants count toward their parent firearm.
- A kill whose weapon display name is not in the firearm table counts toward no gun/class/Full Armory tile and is logged (still counts for Arsenal, which keeps counting raw strings).
- Backfill: silent (`announce: false`), then one summary DM per linked player who gained new tiles, no public post. Never run `backfill-notices.ts` for it.
- After launch, every new tile announces like every other (no per-tile flag).
- House rules: comments explain why, `⚠️` on load-bearing lines; player copy per `brand/02-verbal-identity.md` (plain voice, em dashes allowed, never discourage raiding); guide numbers through `rules.ts` → `guide-numbers.ts`; every PR adds a committed `## [Unreleased]` CHANGELOG entry.
- Gate: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force` → expect **32/32 tasks**. (If 5434 is held by another project, use a throwaway `postgres:16` on 5440; see memory `local-test-postgres`.)

## Review Focus

1. **A display name nobody mapped** (a new gun, a renamed one, a sawed-off string) must count for nothing and warn once per name per process. It must not throw and must not credit a neighbouring gun. Test in Task B1 and B4.
2. **A burst of 20–40 identical `TransportHit` lines in one second** is one motorbike incident, not 40. Road Rash and Hit and Run count incidents (distinct victim+second). Test in Task B5.
3. **Dog bites followed by a player's kill**: the death belongs to the player, so no Dog Food. `deathBy` already requires `killer_dayz_id IS NULL`. Test in Task B5.
4. **Wolf/bear holders keep their tiles; nobody else ever sees them.** The tick never evaluates them. Test in Task B4.
5. **The summary script run twice sends one DM**, an unlinked player gets none, and a player whose only new unlocks were earned live (after the release) gets none. Test in Task B9.

---

# Part A — Ingest fixes (PR 1, branch `fix/adm-ingest-nasdara`)

### Task A1: Hit labels and dog classification

**Files:**
- Modify: `packages/adm-parser/src/hit.ts` (`BY_OTHER_RE`, `parseHit`)
- Modify: `packages/domain/src/death-verdict.ts` (`ANIMALS`, `classifyEntityLabel`)
- Test: `packages/adm-parser/test/hit.test.ts`, `packages/domain/test/death-verdict.test.ts`

**Interfaces:**
- Produces: `classifyEntityLabel(label: string | null): "wolf" | "bear" | "dog" | "animal" | null`. `HitLine` gains `cause: string | null`: for a non-player hit, the word after ` with ` (`"BarbedWireHit"`, `"TransportHit"`), else null. `attackerLabel` for a no-driver vehicle hit is the vehicle class (`"Motorbike_02_Yellow"`), and for a multi-word animal it is the full name (`"German Shepherd"`, `"Brown Bear"`).

- [ ] **Step 1: Write the failing tests**

```ts
it("multi-word animal labels are kept whole", () => {
  expect(parseHit(`19:35:14 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>)[HP: 71.59] hit by German Shepherd into Head(0) for 10 damage (MeleeWolf)`))
    .toMatchObject({ attackerType: "environment", attackerLabel: "German Shepherd", damage: 10, bodyPart: "Head" });
  expect(parseHit(`… [HP: 80] hit by Brown Bear into Torso(1) for 20 damage (MeleeBear)`)?.attackerLabel).toBe("Brown Bear");
  expect(parseHit(`… [HP: 93] hit by Doberman into Head(0) for 3.5 damage (MeleeWolf)`)?.attackerLabel).toBe("Doberman");
});
it("a vehicle with no driver: the label is the vehicle class, not 'NO'", () => {
  expect(parseHit(`20:58:42 | Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>)[HP: 53.2977] hit by NO DRIVER with TransportHit (Motorbike_02_Yellow)`))
    .toMatchObject({ attackerType: "environment", attackerLabel: "Motorbike_02_Yellow" });
});
it("a driven vehicle: the player is the attacker and the weapon carries the class", () => {
  expect(parseHit(`… [HP: 70] hit by Player "Kil" (id=${K} pos=<4.0, 5.0, 6.0>) with TransportHit (Motorbike_02_Red)`))
    .toMatchObject({ attackerType: "player", attackerDayzId: K, weapon: "TransportHit (Motorbike_02_Red)" });
});
it("a non-player hit keeps its `with` tail as cause", () => {
  expect(parseHit(`… [HP: 99.85] hit by Fence with BarbedWireHit`)).toMatchObject({ attackerLabel: "Fence", cause: "BarbedWireHit" });
});
// existing labels unchanged: Infected, FallDamageHealth, Fence, BearTrap, TripwireTrap, Fireplace, ChickenBreastMeat, explosion
```

```ts
// death-verdict.test.ts
expect(classifyEntityLabel("Doberman")).toBe("dog");
expect(classifyEntityLabel("German Shepherd")).toBe("dog");
expect(classifyEntityLabel("Animal_CanisFamiliaris_Doberman")).toBe("dog");
expect(classifyEntityLabel("Wolf")).toBe("wolf");
expect(classifyEntityLabel("Brown Bear")).toBe("bear");
expect(classifyEntityLabel("Animal_CanisLupus_White")).toBe("wolf");
expect(classifyEntityLabel("Saiga")).toBe(null); // a hit label that is not an Animal_ class stays unclassified
```

- [ ] **Step 2: Run** `pnpm --filter @factions/adm-parser test hit` and `pnpm --filter @factions/domain test death-verdict`. Expected: FAIL (`German`, `NO`, `null` for dogs).
- [ ] **Step 3: Implement.** `NO DRIVER with TransportHit (X)` → label `X` (match it first). Otherwise the label is everything up to the first ` into `, ` with `, ` (` or end of string. Add `[/^(Animal_CanisFamiliaris|Doberman$|German Shepherd$)/u, "dog"]` before the generic `Animal_` row in `ANIMALS`, and `^Wolf$` → wolf, `^Brown Bear$` → bear (display-name hit labels).
- [ ] **Step 4: Run** the same two commands. Expected: PASS.
- [ ] **Step 5: Commit** `fix(adm-parser): whole animal and vehicle hit labels; dogs classify as dog`

### Task A2: Vehicle deaths and dog-inferred deaths

**Files:**
- Modify: `packages/adm-parser/src/death.ts` (`ENTITY_RE`, `ENTITY_CAUSES`, `DeathCause`)
- Modify: `packages/domain/src/death-verdict.ts` (`StatedCause`, `InferredCause`, `DEATH_CAUSES`, `classifyDeath`)
- Test: `packages/adm-parser/test/death.test.ts`, `packages/domain/test/death-verdict.test.ts`

**Interfaces:**
- Produces: `DeathCause` and `StatedCause` gain `"dog"`; `InferredCause` gains `"dog"`. A `kills.cause` of `"dog"` means a dog killed the player, stated or inferred.

- [ ] **Step 1: Write the failing tests**

```ts
it("killed by NO DRIVER (Motorbike…): a vehicle death with the class as entity", () => {
  expect(parseDeath(`01:06:20 | Player "Vic" (DEAD) (id=${V} pos=<10113.2, 11865.4, 208.6>) killed by NO DRIVER (Motorbike_02_Yellow)`))
    .toMatchObject({ kind: "died", cause: "vehicle", entity: "Motorbike_02_Yellow" });
  expect(parseDeath(`… (DEAD) (id=${V} pos=<1, 2, 3>) killed by NO DRIVER (Hatchback_02)`)).toMatchObject({ cause: "vehicle", entity: "Hatchback_02" });
});
it("a stated dog kill", () => {
  expect(parseDeath(`… (DEAD) (id=${V} pos=<1, 2, 3>) killed by Animal_CanisFamiliaris_Shepherd`)).toMatchObject({ cause: "dog" });
});
```

```ts
// classifyDeath
const dogHit = (s: number, hp: number) => ({ attackerType: "environment", attackerLabel: "Doberman", victimHp: hp, secondsBeforeDeath: s });
it("a bare died after dog bites, bleeding: dog", () => {
  expect(classifyDeath({ mechanism: "died", water: 1000, energy: 1000, bleedSources: 2 }, [dogHit(5, 30)], [])).toBe("dog");
});
it("dog and infected both in the window: the lower-HP hit's attacker decides", () => {
  expect(classifyDeath(facts({ bleedSources: 1 }), [dogHit(8, 40), infHit(3, 4)], [])).toBe("mauled");
  expect(classifyDeath(facts({ bleedSources: 1 }), [dogHit(3, 4), infHit(8, 40)], [])).toBe("dog");
});
it("a dog bite with no corroboration is not a dog death", () => {
  expect(classifyDeath(facts({ bleedSources: 0 }), [dogHit(60, 90)], [])).toBe("died");
});
```

- [ ] **Step 2: Run** both package tests. Expected: FAIL.
- [ ] **Step 3: Implement.** In `parseDeath`, read `killed by NO DRIVER \((\w+)\)` as the entity before `ENTITY_RE`, and add `Motorbike_` to the vehicle prefixes. In `classifyDeath`, treat dog hits (`classifyEntityLabel(label) === "dog"`) as hunting evidence with the same three corroborations as infected (bleeding, knocked out, terminal HP ≤ `TERMINAL_HP_MAX` from the dog hits only). When both hunters are present, the attacker of the lowest-`victimHp` hunting hit decides. Fall and starvation/dehydration keep their places above it.
- [ ] **Step 4: Run.** Expected: PASS, along with every existing death-verdict test.
- [ ] **Step 5: Commit** `fix: motorbike and no-driver vehicle deaths; infer dog deaths`

### Task A3: Ruin repairs

**Files:**
- Modify: `packages/adm-parser/src/structure.ts` (`BUILT_RE`, `StructureEvent.structure: string | null`)
- Modify: `packages/roster/src/stats.ts:390` (builders board predicate)
- Modify: `apps/bot/src/achievements/rules-pve.ts` (`built()`)
- Test: `packages/adm-parser/test/structure.test.ts`, `packages/roster/test/stats.test.ts` (builders case), `apps/bot/test/achievements/rules-pve.test.ts`

**Interfaces:**
- Produces: a ruin repair is `base.built` with `payload.structure === null`, `payload.part` (e.g. `door1_metal`, `rubble_rubble1`), `payload.tool` (e.g. `Hammer`). Helper SQL fragment `isBaseBuild = sql\`${events.payload}->>'structure' is not null\`` exported from `packages/roster/src/stats.ts` beside the board, and reused by `built()`.

- [ ] **Step 1: Write the failing tests**

```ts
it("a ruin repair: the object is blank, the tool is real", () => {
  expect(parseStructure(`13:22:15 | Player "M" (id=${ID} pos=<8811.6, 7336.3, 180.4>)Built door2_barricade on  with Brick Trowel`))
    .toMatchObject({ action: "built", part: "door2_barricade", structure: null, tool: "Brick Trowel" });
  expect(parseStructure(`… pos=<1, 2, 3>)Built rubble_rubble1 on  with Shovel`)).toMatchObject({ part: "rubble_rubble1", structure: null, tool: "Shovel" });
  expect(parseStructure(`… pos=<1, 2, 3>)Built ladder_rebuild on  with hands`)).toMatchObject({ structure: null, tool: "hands" });
});
it("a base part is unchanged", () => {
  expect(parseStructure(`… pos=<1, 2, 3>)Built wall_base_down on Fence with Hatchet`)).toMatchObject({ structure: "Fence", tool: "Hatchet" });
});
// rules-pve: 3 Fence builds + 5 ruin repairs → builder count 3; stats: builders board counts 3 for the same seed
```

- [ ] **Step 2: Run** the three package tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Match `Built (\S+) on  with (.+?)\s*$` (two spaces) first, giving `structure: null`. Check every reader of `payload.structure` (`grep -rn "structure" apps/bot/src/zone-tick.ts packages/roster/src`); `zone-tick.ts` already reads `String(p.structure ?? "")`, so a breach on a ruin repair still fires. Pin that with an existing zone-tick test case if one is missing: a non-member's ruin repair inside a zone records a breach.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `fix: ruin repairs parse with a null structure and earn no build points`

### Task A4: Two new shapes — waking up, packing a tent

**Files:**
- Create: `packages/adm-parser/src/conscious.ts`, `packages/adm-parser/src/packed.ts`
- Modify: `packages/adm-parser/src/parse-line.ts` (append both parsers at the END of the chain, and add `ParsedLine` kinds `"conscious"`, `"packed"`), `packages/adm-parser/src/index.ts`, `packages/domain/src/events.ts`, `apps/ingest-worker/src/ingest.ts` (`toPayload`)
- Test: `packages/adm-parser/test/conscious.test.ts`, `packages/adm-parser/test/packed.test.ts`, `packages/adm-parser/test/parse-line.test.ts`

**Interfaces:**
- Produces: event `player.conscious` with payload `{ dayzId, gamertag }`; event `item.packed` with payload `{ dayzId, gamertag, item, pos }`, where `item` is the display name (`"Large Tent"`).

- [ ] **Step 1: Write the failing tests**

```ts
expect(parseConscious(`… Player "Vic" (id=${V} pos=<1, 2, 3>) regained consciousness`)).toEqual({ dayzId: V, gamertag: "Vic" });
expect(parseConscious(`… Player "Vic" (DEAD) (id=${V} pos=<1, 2, 3>) regained consciousness`)).toBeNull();
expect(parsePacked(`… Player "Vic" (id=${V} pos=<1.0, 2.0, 3.0>) packed Large Tent with Hands `)).toMatchObject({ dayzId: V, item: "Large Tent", pos: { x: 1, y: 3, z: 2 } });
expect(parsePacked(`… Player "Vic" (id=${V} pos=<1, 2, 3>) packed Car Tent with Hands`)?.item).toBe("Car Tent");
// parse-line: each yields exactly one ParsedLine; eventTypeFor maps to "player.conscious" / "item.packed"
```

- [ ] **Step 2: Run** `pnpm --filter @factions/adm-parser test`. Expected: FAIL.
- [ ] **Step 3: Implement** with the identity anchor in `identity.ts`. ⚠️ Append them at the end of `parseLine`'s chain: each raw line still yields one ParsedLine, so no `subIndex` moves.
- [ ] **Step 4: Run** the parser tests and `pnpm --filter @factions/ingest-worker test`. Expected: PASS (the `toPayload` exhaustiveness guard compiles).
- [ ] **Step 5: Commit** `feat(adm-parser): regained consciousness and packed tents`

### Task A5: Repair stored payloads in place

**Files:**
- Create: `apps/ingest-worker/src/repayload.ts`, `apps/ingest-worker/src/repayload-main.ts`
- Modify: `apps/ingest-worker/src/ingest.ts` (export `toPayload`), `apps/ingest-worker/package.json` (`"repayload": "tsx src/repayload-main.ts"`)
- Test: `apps/ingest-worker/test/repayload.test.ts`

**Interfaces:**
- Produces: `repayloadEvents(db: Database, opts: { types: EventType[]; apply: boolean; log?: (s: string) => void }): Promise<{ scanned: number; changed: Record<string, number>; typeMismatch: number; noRawLine: number }>`

- [ ] **Step 1: Write the failing test.** Seed an `adm_files` row, three `raw_lines` (a `German Shepherd` hit, a `NO DRIVER (Motorbike_02_Yellow)` death, a ruin `Built … on  with Hammer`), and three `events` carrying the OLD payloads (label `German`, cause `environment`/entity `NO`, structure `"with Hammer"`). Some have `raw_line_id` null, matched by `(adm_file_id, line_index)`.

```ts
const dry = await repayloadEvents(db, { types: ["player.hit", "player.died", "base.built"], apply: false });
expect(dry).toMatchObject({ scanned: 3, changed: { "player.hit": 1, "player.died": 1, "base.built": 1 }, typeMismatch: 0 });
expect((await payloadOf(hitId)).attackerLabel).toBe("German");            // dry run writes nothing
await repayloadEvents(db, { types: ["player.hit", "player.died", "base.built"], apply: true });
expect((await payloadOf(hitId)).attackerLabel).toBe("German Shepherd");
expect(await payloadOf(deathId)).toMatchObject({ cause: "vehicle", entity: "Motorbike_02_Yellow" });
expect(await payloadOf(builtId)).toMatchObject({ structure: null, tool: "Hammer" });
expect(await idsOfAllEvents()).toEqual(idsBefore);                         // no event deleted or added
// a line whose re-parse yields a different TYPE is counted in typeMismatch and left alone
```

- [ ] **Step 2: Run** `pnpm --filter @factions/ingest-worker test repayload`. Expected: FAIL.
- [ ] **Step 3: Implement.** Join `events` to `raw_lines` on `(adm_file_id, line_index)`, re-parse with `parseLine`, take `[sub_index]`, and require `eventTypeFor(parsed) === events.type`. Update only when the JSON differs. Batch by id range. `repayload-main.ts` reads `DATABASE_URL`, defaults to a dry run, needs `--apply` to write, and uses the `factions_live`-or-`--allow-test-db` guard from `scripts/backfill-achievements.ts`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(ingest-worker): repayload — re-derive stored payloads from raw lines in place`

### Task A6: Runbook, CHANGELOG, PR

**Files:**
- Create: `docs/deploy/2026-10-21-ingest-nasdara-fixes.md`
- Modify: `CHANGELOG.md` (`## [Unreleased]` → Fixed: motorbike deaths, dog deaths, ruin repairs; Added: waking up and tent packing are recorded)

- [ ] **Step 1: Write the runbook.** Steps: `pg_dump`; deploy worker and bot; `repayload` dry run, then `--apply` (`player.hit`, `player.died`, `base.built`); `reparse-main.ts` to backfill the two new shapes; `rebuild:kills` with the four feed cursors parked exactly as `docs/deploy/2026-09-10-credited-kills.md` step 4 says (note the bounty-claim and live-feed resync notes in CLAUDE.md). Include the expected numbers measured 2026-10-20, re-measured as the first step:

```sql
select count(*) from events where type='player.died' and payload->>'entity'='NO';                 -- 3 → 0
select count(*) from events where type='player.hit' and payload->>'attackerLabel'='German';       -- 1 → 0
select count(*) from events where type='base.built' and payload->>'structure' like 'with %';      -- ~153 → 0
select count(*) from kills where cause='vehicle';                                                 -- 8 → ≥ 11
```
- [ ] **Step 2: Run the full gate** (Global Constraints). Expected: 32/32.
- [ ] **Step 3: Commit, then open the PR** with `keel:finish-work`. Ship it through the release flow (memory `release-flow`) before Part B's backfill runs.

---

# Part B — Achievements (PR 2, branch `feat/achievements-150`, based on main after Part A merges)

### Task B1: Firearm and evidence tables (pure domain)

**Files:**
- Create: `packages/domain/src/firearms.ts`, `packages/domain/src/achievement-evidence.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/firearms.test.ts`, `packages/domain/test/achievement-evidence.test.ts`

**Interfaces:**
- Produces:
  - `type FirearmClass = "pistol" | "smg" | "shotgun" | "assault_rifle" | "rifle" | "sniper" | "other"`
  - `FIREARMS: readonly { key: FirearmKey; name: string; class: FirearmClass; classnames: readonly string[]; displayNames: readonly string[] }[]` (52 entries)
  - `firearmOf(weapon: string | null): FirearmKey | null`
  - `FIREARM_CLASSES: readonly Exclude<FirearmClass, "other">[]` (6, in order: pistol, smg, shotgun, assault_rifle, rifle, sniper)
  - `isKnife(w)`, `isFist(w)`, `isSledgehammer(w)`, `meleeWeaponOf(weapon: string | null): string | null` (a stable name for a melee kill, null for a firearm)
  - `isDogLabel(label)` (delegates to `classifyEntityLabel === "dog"`), `isMotorbikeClass(s)` (`/^Motorbike_/`), `motorbikeOfWeapon(w)` (`/^TransportHit \((Motorbike_[^)]+)\)$/`)
  - `GRENADE_ENTITY_RE`, `MINE_ENTITIES = ["LandMineTrap", "Claymore"]`, `THROWN_MEAT_RE = /Meat$/`, `TENTS` (display names packed in production: Large Tent, Car Tent, Medium Tent, Canopy Tent, Improvised Shelter, Party Tent), `EMOTES` (the full emote list), `RUIN_RUBBLE_RE = /^rubble_/`, `RUIN_KIND(part) => "door" | "window" | "roof" | "wall" | "rubble" | "ladder" | null`

The 52 keys and classes are spec §2.2's table, keys lower-snake from the classname: `ak101 ak74 akm aks74u asval aug aug_short b95 cz527 cz550 cz61 cz75 colt1911 crossbow deagle derringer fal famas fnx45 glock19 izh18 izh18_shotgun izh43 lee_enfield longhorn luger m16a2 m4a1 m79 mkii mp18 mp5k magnum makarov mosin mp133 p1 pm73 pp19 r12 repeater ruger1022 scarh scarl sks ssg82 svd saiga ump45 vss vikhr winchester70`.

Display names: these are **seen in production kill lines** and must map exactly: `KA-M`→akm, `AUR AX`→aug, `M4-A1`→m4a1, `SCR 17`→scarh, `SCR 16`→scarl, `LAR`→fal, `M16-A2`→m16a2, `VSD`→svd, `KA-101`→ak101, `KA-74`→ak74, `KAS-74U`→aks74u, `Vikhr`→vikhr, `SVAL`→asval, `CR-550 Savanna`→cz550, `CR-527`→cz527, `VSS`→vss, `Mlock-91`→glock19, `M70 Tundra`→winchester70, `R12`→r12, `Sporter 22`→ruger1022, `SK 59/66`→sks, `BK-133`→mp133, `SG5-K`→mp5k, `M79`→m79, `SSG 82`→ssg82, `Mosin 91/30`→mosin, `LE-MAS`→famas, `Bizon`→pp19, `USG-45`→ump45, `Blaze`→b95, `BK-43`→izh43, `Engraved Kolt 1911`→colt1911, `Derringer`→derringer, `Deagle`→deagle, `CR-75`→cz75, `BK-12`→izh18_shotgun, `Lee Enfield`→lee_enfield (hit line), `Luger`→luger (hit line). **Not in the 52 (count for Arsenal only):** `DMR`, `VS-89`, `Pioneer`. Fill the remaining guns (aug_short, cz61, crossbow, fnx45, izh18, longhorn, mkii, mp18, magnum, makarov, p1, pm73, repeater, saiga, colt1911's plain name, sawed-off names) from the game's display names. Mark each such row `// unverified: not yet seen in a log` until a production line confirms it, and add the sawed-off strings to their parent's `displayNames`.

- [ ] **Step 1: Write the failing tests**

```ts
it("52 firearms, 6 counted classes, every one with a display name", () => {
  expect(FIREARMS).toHaveLength(52);
  expect(FIREARMS.every((f) => f.displayNames.length > 0)).toBe(true);
  expect(FIREARMS.filter((f) => f.class === "pistol")).toHaveLength(12);
  // smg 7, shotgun 5, assault_rifle 13, rifle 11, sniper 2, other 2
});
it("no display name maps to two firearms", () => {
  const all = FIREARMS.flatMap((f) => f.displayNames);
  expect(new Set(all).size).toBe(all.length);
});
it.each([["KA-M", "akm"], ["Engraved Kolt 1911", "colt1911"], ["SCR 16", "scarl"], ["SCR 17", "scarh"], ["BK-12", "izh18_shotgun"], ["Mlock-91", "glock19"]])("%s → %s", (n, k) => expect(firearmOf(n)).toBe(k));
it("unknown, non-Nasdara and melee strings map to nothing", () => {
  for (const w of ["DMR", "VS-89", "Pioneer", "Hunting Knife", "(MeleeFist)", "TransportHit (Motorbike_02_Red)", null, ""]) expect(firearmOf(w)).toBeNull();
});
it("every Nasdara firearm classname (types.xml, nominal > 0, weapons) is some firearm's classname", () => {
  const NASDARA = ["AK101","AK101_Black","AK101_Green","AK74","AK74_Black","AK74_Green","AKM","AKM_Gold","AKS74U","AKS74U_Black","AKS74U_Green","ASVAL","Aug","AugShort","B95","CZ527","CZ527_Desert","CZ550","CZ61","CZ75","Colt1911","Crossbow_Black","Crossbow_Wood","Deagle","Deagle_Gold","Derringer_Grey","Engraved1911","FAL","FAMAS","FNX45","Glock19_Tan","Izh18","Izh18Shotgun","Izh43Shotgun","LeeEnfield","Longhorn","Luger","M16A2","M4A1","M4A1_Black","M4A1_Green","M79","MKII","MP18","MP5K","Magnum","Magnum_Gold","MakarovIJ70","Mosin9130","Mosin9130_Black","Mp133Shotgun","P1","PM73Rak","PP19","R12","Repeater","Ruger1022","SCARH","SCARH_Black","SCARL","SCARL_Black","SKS","SKS_Desert","SSG82","SVD","SVD_Wooden","Saiga","UMP45","VSS","Vikhr","Winchester70"];
  const known = new Set(FIREARMS.flatMap((f) => f.classnames));
  expect(NASDARA.filter((c) => !known.has(c))).toEqual([]);
});
// evidence: isKnife("Hunting Knife"), isKnife("Kukri"), isFist("(MeleeFist)"), isFist("(MeleeFist_Heavy)"), meleeWeaponOf("KA-M") === null,
// motorbikeOfWeapon("TransportHit (Motorbike_02_Red)") === "Motorbike_02_Red", RUIN_KIND("window4_metal") === "window", RUIN_KIND("roof1") === "roof"
```

- [ ] **Step 2: Run** `pnpm --filter @factions/domain test`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** both files as data plus small pure functions. `firearmOf` is an exact, trimmed match on a `Map` built once.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(domain): firearm catalogue and achievement evidence tables`

### Task B2: Rule plumbing — per-owner memo, touched sources, indexes

**Files:**
- Modify: `apps/bot/src/achievements/types.ts` (ctx), `apps/bot/src/achievements/tick.ts` (`evaluateOwner`), `apps/bot/src/achievements/touched.ts` (`RULE_EVENT_TYPES`, owner extraction)
- Create: migration via `cd packages/db && npx drizzle-kit generate` (three partial expression indexes, declared in `packages/db/src/schema.ts`)
- Test: `apps/bot/test/achievements/touched.test.ts`, `apps/bot/test/achievements/tick.test.ts`

**Interfaces:**
- Produces: `type RuleCtx = { now: Date; memo: <T>(key: string, fn: () => Promise<T>) => Promise<T> }`; `Rule = (db, owner, ctx: RuleCtx) => Promise<RuleResult>`. `evaluateOwner` builds one memo per owner per pass. Helper `ownPvpKills(db, ctx, dayzId)` in `rules-pvp.ts` uses `ctx.memo("pvpKills", …)`; existing PvP rules switch to it.
- Indexes: `events_hit_victim_idx` on `((payload->>'victimDayzId'))` and `events_hit_attacker_idx` on `((payload->>'attackerDayzId'))`, both `where type = 'player.hit'`; `events_type_player_idx` on `(type, (payload->>'dayzId'))`.

- [ ] **Step 1: Write the failing tests**

```ts
it("a hit touches its victim and its player attacker", async () => {
  await seedEvent(db, { type: "player.hit", payload: { victimDayzId: A, attackerDayzId: B, attackerType: "player" } });
  await seedEvent(db, { type: "player.hit", payload: { victimDayzId: C, attackerDayzId: null, attackerLabel: "Doberman" } });
  expect(touchedPlayerIds(await collectTouched(db, wm0))).toEqual(new Set([A, B, C]));
});
it.each(["item.placed", "item.packed", "player.conscious"])("%s touches its player", async (type) => { /* payload.dayzId */ });
it("memo: two rules asking for the same key share one read", async () => {
  let reads = 0; const ctx = makeCtx(now);
  await Promise.all([ctx.memo("k", async () => ++reads), ctx.memo("k", async () => ++reads)]);
  expect(reads).toBe(1);
});
```

- [ ] **Step 2: Run** `pnpm --filter @factions/bot test achievements`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add `"player.hit"`, `"item.placed"`, `"item.packed"`, `"player.conscious"` to `RULE_EVENT_TYPES`, and extract owners from `payload->>'dayzId'`, `payload->>'victimDayzId'` and `payload->>'attackerDayzId'` (non-null, distinct). ⚠️ Update the string-built `types` list at `touched.ts:204` as well; it is a second statement of the same list. Read the generated migration SQL before committing.
- [ ] **Step 4: Run** the bot achievement tests. Expected: PASS, with every existing rule test still green.
- [ ] **Step 5: Commit** `feat(achievements): per-owner memo, hit/placed/packed/conscious touch owners, indexes`

### Task B3: Badge PNGs from SVG

**Files:**
- Create: `apps/web/scripts/render-achievement-pngs.ts`; add `"achievements:png": "tsx scripts/render-achievement-pngs.ts"` to `apps/web/package.json`
- Test: `apps/web/test/achievement-pngs.test.ts`

**Interfaces:**
- Produces: `renderPngs(keys: string[], opts: { overwrite: boolean }): Promise<string[]>` writes `public/achievements/unlocked/<key>.png` (the SVG as-is, 128×128) and `locked/<key>.png` (shield stroke `#2a2825`, no fill tint, glyph `#4a4640`), using sharp. By default it fills only missing files, so the 50 existing PNGs are never redrawn.

- [ ] **Step 1: Write the failing test:** every `ACHIEVEMENT_KEYS` key has `svg/`, `unlocked/` and `locked/` files, and a locked PNG's dominant non-transparent colour is `#4a4640`-ish (sharp `stats()`).
- [ ] **Step 2: Run** `pnpm --filter @factions/web test achievement-pngs`. Expected: PASS today (50 keys). The test bites from B4 onwards, when a key arrives without its PNGs.
- [ ] **Step 3: Implement** the script. Recolour by string-replacing the group stroke hex and the `rgba(…,0.12)` fill in the SVG source.
- [ ] **Step 4: Run** the script on a scratch key and look at both PNGs, then delete the scratch key.
- [ ] **Step 5: Commit** `feat(web): render achievement badge PNGs from their SVGs`

> **Art for B4–B8.** Each new key needs `public/achievements/svg/<key>.svg` in the existing shape: the 64×64 shield path, then the glyph as ONE path inside `<g transform="translate(17 15) scale(1.25)">` in a 24×24 space, square caps, mitre joins, stroke 2, in the group colour (copy `arsenal.svg` and replace the glyph). Gun tiles share one look: the gun's side silhouette as a single stroked path, so the 52 read as a set. After adding SVGs, run `pnpm --filter @factions/web prebuild` (regenerates `lib/achievement-glyphs.ts`) and `pnpm --filter @factions/web achievements:png`, and commit all three outputs.

### Task B4: Retire wolf/bear; the 59 gun tiles

**Files:**
- Modify: `packages/domain/src/achievements.ts`, `apps/bot/src/achievements/rules-pvp.ts`, `apps/web/public/achievements/**`, `apps/web/lib/achievement-glyphs.ts`
- Test: `packages/domain/test/achievements.test.ts`, `apps/bot/test/achievements/rules-pvp.test.ts`, `apps/bot/test/achievements/tick.test.ts`

**Interfaces:**
- Consumes: `FIREARMS`, `firearmOf`, `FIREARM_CLASSES` (B1); `ctx.memo`, `ownPvpKills` (B2).
- Produces: keys `gun_<firearmKey>` (52, generated from `FIREARMS` in order, name = the firearm's first display name, description `A PvP kill with the <name>`, group `pvp`); `class_pistols class_smgs class_shotguns class_assault_rifles class_rifles class_snipers` (target = the class size, unit count, "A PvP kill with every pistol" etc.); `full_armory` (target 52, "A PvP kill with every firearm on Nasdara"). A new optional def field `section?: "armory"` marks all 59 for the wall (B9). `gunSet(ctx, dayzId)` in `rules-pvp.ts` returns the memoised `Map<FirearmKey, KillRow>` of each firearm's first scoring kill.
- `wolf_bait`, `bear_necessities` get `{ retired: true }`; their rows in `PVE_RULES` are deleted.

- [ ] **Step 1: Write the failing tests**

```ts
it("gun tile: the first scoring kill with that firearm, variants merged", async () => {
  await seedKill(db, { serverId, killer: A, victim: B, at: m(0), weapon: "KA-M", friendlyFire: true }); // does not count
  await seedKill(db, { serverId, killer: A, victim: B, at: m(1), weapon: "KA-M", atHub: true });       // does not count
  await seedKill(db, { serverId, killer: A, victim: C, at: m(2), weapon: "KA-M" });
  expect(await rule("gun_akm")(db, player, ctx())).toMatchObject({ count: 1, earnedAt: m(2) });
});
it("class tile: n of N, earned at the kill completing the class", async () => { /* snipers: VSD at m(1), VSS at m(5) → count 2/2 earnedAt m(5) */ });
it("full_armory progress is distinct firearms of 52", async () => { /* 3 guns → { count: 3, target: 52 } */ });
it("an unmapped display name counts for nothing and warns once", async () => {
  const warn = vi.spyOn(console, "warn");
  await seedKill(db, { serverId, killer: A, victim: B, at: m(0), weapon: "Mystery 9000" });
  await seedKill(db, { serverId, killer: A, victim: C, at: m(1), weapon: "Mystery 9000" });
  expect((await rule("full_armory")(db, player, ctx())).count).toBe(0);
  expect((await rule("arsenal")(db, player, ctx())).count).toBe(1);   // Arsenal still counts raw strings
  expect(warn.mock.calls.filter((c) => String(c[0]).includes("Mystery 9000"))).toHaveLength(1);
});
it("wolf_bait and bear_necessities are retired: holders keep them, the tick never evaluates them", async () => { /* seed an unlock for A; run the tick; row still there; EARNABLE has neither key; A's wall still shows it, B's does not */ });
```

- [ ] **Step 2: Run** domain and bot achievement tests. Expected: FAIL.
- [ ] **Step 3: Implement** the definitions, rules and 59 SVGs (art note above). The `rules.test.ts` two-way diff must pass. The guide and wall tests may need their tile counts moved: update only counts; the copy changes are B9's.
- [ ] **Step 4: Run** the full gate. Expected: 32/32.
- [ ] **Step 5: Commit** `feat(achievements): retire wolf and bear; a tile for every firearm, its class, and Full Armory`

### Task B5: Melee, dogs, motorbikes (11)

**Files:** `packages/domain/src/achievements.ts`, `apps/bot/src/achievements/rules-pvp.ts`, `rules-pve.ts`, art; tests in `rules-pvp.test.ts`, `rules-pve.test.ts`.

**Interfaces:** Consumes B1's melee/dog/motorbike helpers and `ownPvpKills`. Hit reads: `ownHits(db, ctx, dayzId, side: "victim" | "attacker")`, memoised, returning `{ id, at, serverId, attackerLabel, attackerType, weapon, victimDayzId }[]` in time order.

| key | name | description | group | target | rule |
|---|---|---|---|---|---|
| knife_work | Knife Work | A PvP kill with a knife | pvp | 1 | first scoring kill with `isKnife` |
| bare_knuckles | Bare Knuckles | A PvP kill with your fists | pvp | 1 | `isFist` |
| sledge | Sledge | A PvP kill with a sledgehammer | pvp | 1 | `isSledgehammer` |
| melee_mix | Hands On | PvP kills with 5 different melee weapons | pvp | 5 | distinct `meleeWeaponOf` |
| dog_food | Dog Food | Get killed by a dog | pve | 1 | `deathBy("dog")` |
| bad_dog | Bad Dog | Survive a dog attack | pve | 1 | a dog hit, then no death within 10 min; earned at the hit + 10 min |
| chew_toy | Chew Toy | Take 10 dog bites | pve | 10 | dog hit lines |
| road_rash | Road Rash | Get hurt by a motorbike | pve | 1 | victim of a no-driver `Motorbike_` hit |
| wipeout | Wipeout | Get killed by a motorbike | pve | 1 | kill with no killer, cause vehicle, and the victim's death event's entity `isMotorbikeClass` |
| hit_and_run | Hit and Run | Hit a player with a motorbike | pvp | 1 | attacker on a `motorbikeOfWeapon` hit |
| roadkill | Roadkill | A PvP kill with a motorbike | pvp | 1 | scoring kill whose weapon `motorbikeOfWeapon` |

`BAD_DOG_SURVIVE_MS = 10 * 60_000` in `packages/domain/src/rules.ts`. Incidents for road_rash and hit_and_run are distinct `(victim, second)` pairs.

- [ ] **Step 1: Write the failing tests:** one per key, plus: a 30-line burst in one second counts as one incident; dog bites then a PvP kill → no `dog_food`; dog bite, then a death 4 min later → no `bad_dog`; dog bite with an open session and no death → `bad_dog` earned at bite + 10 min only when `ctx.now` ≥ that.
- [ ] **Step 2: Run.** FAIL.
- [ ] **Step 3: Implement** the definitions, rules and 11 SVGs.
- [ ] **Step 4: Run** the gate. 32/32.
- [ ] **Step 5: Commit** `feat(achievements): melee, dog and motorbike tiles`

### Task B6: Ruins, traps and explosives, camp (13)

**Files:** `achievements.ts`, `rules-pve.ts`, art; `rules-pve.test.ts`.

| key | name | description | target | rule |
|---|---|---|---|---|
| squatter | Squatter | Repair a ruined building | 1 | `base.built` with `structure is null` |
| rubble_rouser | Rubble Rouser | Clear 10 rubble piles | 10 | …and `RUIN_KIND = rubble` |
| renovator | Renovator | Make 25 ruin repairs | 25 | ruin repairs |
| fixer_upper | Fixer-Upper | Repair a door, a window and a roof | 1 | earned at the repair completing {door, window, roof} |
| snapped | Snapped | Step in a bear trap | 1 | hit label `BearTrap` |
| tripped | Tripped | Set off a tripwire | 1 | hit label `TripwireTrap` |
| snagged | Snagged | Get caught in barbed wire | 1 | hit `cause = BarbedWireHit` (labels Fence/Watchtower/Gate) |
| minesweeper | Minesweeper | Get killed by a mine or claymore | 1 | death, no killer, entity in `MINE_ENTITIES` |
| frag_out | Frag Out | Get killed by a grenade | 1 | death, no killer, entity matches `GRENADE_ENTITY_RE` |
| barrel_hoarder | Hoarder | Place 10 barrels | 10 | `item.placed` item `Barrel` |
| pack_up | Pack Up | Pack 10 tents | 10 | `item.packed`, item in `TENTS` |
| sea_legs | Sea Legs | Place a sea chest | 1 | `item.placed` `Sea Chest` |
| minefield | Minefield | Place a land mine | 1 | `item.placed` `Land Mine` |

The snagged rule reads `HitLine.cause` (Task A1). (All group pve.)

- [ ] **Steps 1–5** as in B5. Tests also pin: a Fence build earns no ruin tile; 10 ruin repairs that are not rubble do not earn Rubble Rouser. Commit `feat(achievements): ruin, trap, explosive and camp tiles`.

### Task B7: Emotes, oddities, milestones (16)

**Files:** `achievements.ts`, `rules-solo.ts`, `rules-pve.ts`, `rules-pvp.ts`, art; matching tests.

| key | name | description | group | target | rule |
|---|---|---|---|---|---|
| mime | Mime | Perform 10 different emotes | solo | 10 | distinct `payload.emote` |
| full_repertoire | Full Repertoire | Perform every emote | solo | `EMOTES.length` | distinct emotes ∩ `EMOTES` |
| rps_champ | Best of Ten | Play rock-paper-scissors 10 times | solo | 10 | `EmoteRPSRandom` |
| performer | Performer | Perform 500 emotes | solo | 500 | as showman |
| burned | Burned | Get burned by a fire | pve | 1 | hit label `Fireplace` |
| tenderized | Tenderized | Get hit by thrown meat | pve | 1 | hit label matches `THROWN_MEAT_RE` |
| comeback | Comeback | Come round after being knocked out 10 times | pve | 10 | `player.conscious` |
| sleeps_with_fishes | Sleeps With the Fishes | Drown | pve | 1 | `deathBy("drowned")` |
| warlord | Warlord | Get 250 PvP kills | pvp | 250 | `killCount` |
| long_shot | Long Shot | A kill from 500 m or more | pvp | 500 m | `distance` |
| headhunter | Headhunter | Kill 25 different players | pvp | 25 | distinct victims |
| lifer | Lifer | Play for 500 hours | solo | 500 h | `hoursPlayed` |
| devoted | Devoted | Play on 30 consecutive days | solo | 30 d | the `regular` rule, parameterised |
| globetrotter | Globetrotter | Seen in 150 different 1 km grid squares | solo | 150 | the `explorer` counter |
| master_builder | Master Builder | Earn 2,000 build points | pve | 2000 | `built()` |
| hundred_lives | Hundred Lives | Die 100 times, any cause | pve | 100 | as nine_lives |

`EMOTES` is confirmed from production `emote.performed` payloads (36 seen) and the game. ⚠️ A tile listing an emote nobody can perform is unearnable. Before shipping, print the threshold distributions from `factions_live` (read-only: top-10 kills, hours, squares, build points, deaths) into the PR description, and retune within "reachable by the most active players".

- [ ] **Steps 1–5** as in B5. Commit `feat(achievements): emote, oddity and milestone tiles`.

### Task B8: Clan tiles (4), and the final count

**Files:** `achievements.ts`, `rules-team.ts`, art; `rules-team.test.ts`, `packages/domain/test/achievements.test.ts`.

| key | name | description | target | rule |
|---|---|---|---|---|
| clan_armory | Armory | Members get PvP kills with 25 different firearms | 25 | scoring kills with `killer_faction_id = clan`, distinct `firearmOf` |
| clan_renovators | Renovators | Make 50 ruin repairs as a clan | 50 | ruin repairs by players inside a full-member span of this clan at the repair's time |
| clan_warband | Warband | Get 250 PvP kills as a clan | 250 | scoring kills, `killer_faction_id = clan` |
| clan_arsenal | Every Class Covered | Members earn every gun-class tile | 6 | per class, the earliest `class_*` unlock whose `earned_at` falls inside a full-member span of that player in this clan; earned at the 6th |

- [ ] **Step 1: Write the failing tests:** the four rules (including a member who earned `class_snipers` BEFORE joining does not count), plus

```ts
expect(EARNABLE_ACHIEVEMENTS).toHaveLength(150);
expect(ACHIEVEMENTS).toHaveLength(153);
expect(EARNABLE_ACHIEVEMENTS.filter((a) => a.owner === "clan")).toHaveLength(16);
expect(new Set(ACHIEVEMENT_KEYS).size).toBe(153);
```
- [ ] **Steps 2–5** as in B5. Commit `feat(achievements): four clan tiles; 150 earnable`.

### Task B9: Surfaces and the summary DM

**Files:**
- Modify: `apps/web/app/components/achievement-wall.tsx` (an "Armory" sub-section inside pvp holding `section: "armory"` tiles, collapsed by default with its earned count, e.g. "Armory · 7 of 59"), the wall comment ("fifty tiles"), `apps/web/content/guide/14-achievements.html` ("The forty-nine" → a rendered count token, "its twelve" → sixteen), `apps/web/app/guide/render.ts` (if the count token is new), `CLAUDE.md` ("Achievements (50, lifetime; 49 earnable)" → 153/150)
- Modify: `packages/domain/src/feed.ts` (`CLAN_NOTICE_KINDS` + `"achievement_summary"`), `apps/bot/src/notice-text.ts`, `apps/web/lib/notice-copy.ts`
- Modify: `packages/domain/src/achievements.ts` (export `ACHIEVEMENTS_2026_10: readonly AchievementKey[]`, the 103 new keys)
- Create: `scripts/announce-achievement-summary.ts`; root `package.json` script `announce:achievement-summary`
- Test: `apps/web/test/achievement-wall.test.ts` (+ snapshot), `apps/web/test/guide.test.ts`, `apps/web/test/notice-copy.test.ts`, `apps/bot/test/notice-text.test.ts`, `apps/bot/test/achievements/summary.test.ts`

**Interfaces:**
- Produces: `queueAchievementSummaries(db: Database, opts: { release: "2026-10"; keys: readonly AchievementKey[]; before: Date; siteBaseUrl: string }): Promise<{ queued: number; skipped: number }>`. It lives in `apps/bot/src/achievements/summary.ts`; the script calls it.
  - For each LINKED player with ≥1 unlock among `keys` whose `earned_at < before` (the release instant passed by the runbook), it queues one `noticeUserTx` with kind `achievement_summary` and payload `{ release, count, gamertag, wallUrl }`.
  - It skips the player if an `achievement_summary` notice with the same `payload->>'release'` already exists for that Discord id.
- Copy (both renderers say the same): `You already hold {count} of the new achievements. See your wall: {wallUrl}` (no public post).

- [ ] **Step 1: Write the failing tests:** the wall renders an Armory group, collapsed, with "n of 59"; the guide renders "150"; the notice renders identically in bot and web; the summary queues one DM for a linked player with 3 historical new unlocks, zero for an unlinked one, zero for a player whose only new unlock is after `before`, and running it twice queues nothing new.
- [ ] **Step 2: Run.** FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the gate. 32/32.
- [ ] **Step 5: Commit** `feat(achievements): armory section, guide and copy at 150, one summary DM per player`

### Task B10: Runbook, CHANGELOG, PR

**Files:** Create `docs/deploy/2026-10-2x-achievements-150.md`; modify `CHANGELOG.md` (`## [Unreleased]` → Added: 103 achievements; Changed: Wolf Bait and Bear Necessities retired, holders keep them).

- [ ] **Step 1: Write the runbook, in this order:**
  1. `pg_dump`.
  2. Set `ACHIEVEMENTS_TICK` off and restart the bot. ⚠️ Live tick and backfill share watermarks, and a live tick with the new rules would announce history one unlock at a time.
  3. Deploy, letting the release migrate (B2's indexes). Part A's runbook must already have run.
  4. Note the release instant `T`.
  5. `pnpm backfill:achievements` (silent).
  6. `pnpm announce:achievement-summary --before T`, dry run first, printing the count.
  7. `ACHIEVEMENTS_TICK` on, restart the bot.
  8. Verify:

```sql
select count(*) from achievement_unlocks where key in (/* new keys */);
select count(*) from clan_notices where kind = 'achievement_summary';                  -- = linked players with new tiles
select count(*) from clan_notices where kind = 'achievement' and created_at > 'T';      -- ≈ 0 right after
```
- [ ] **Step 2: Run** the gate. 32/32.
- [ ] **Step 3: Commit; open the PR** with `keel:finish-work`. Release per memory `release-flow`; this is a minor bump, so confirm with the owner.
