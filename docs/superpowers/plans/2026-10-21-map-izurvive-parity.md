# Map iZurvive Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add world layers (loot buildings, vehicles, crash sites, bunkers and more), a GPS/metre/place/item/model search box, a cursor readout and a ruler to `/map`, all built from our own Nasdara mission files, so players never need iZurvive.

**Architecture:** Hand-run build scripts read the Nasdara mission checkout (`../nasdara`) and DayZ game data, and write static JSON (plus item images) under `apps/web/public/map-data/nasdara/`. The map fetches that JSON lazily in the browser; nothing reads mission files at runtime, and the bot, the worker and the database are untouched. Pure functions in `apps/web/lib/` (parsing, CE matching, coordinate maths, search) carry the tests; `map-view.tsx` and `map-draw.ts` only wire them to Leaflet.

**Tech Stack:** Next.js 16 / React 19, Leaflet 1.9.4, TypeScript, vitest, tsx scripts. Add `fast-xml-parser` (exact version, devDependency of `@factions/web`) for the mission XML. Use HEMTT on the Ubuntu PC for PBO/config/paa work (Task 10).

**Spec:** `docs/superpowers/specs/2026-10-21-map-izurvive-parity-design.md`

## Global Constraints

- Nasdara only. World size from `WORLD_SIZE_M` (16384) and map key from `WORLD_MAP` (`"nasdara"`) in `packages/domain/src/rules.ts`. Never hard-code either.
- GPS: x = floor(x/100), y = floor((size − z)/100), zero-padded to three digits. One implementation in `lib/map-projection.ts`; every grid ref on the site uses it (spec Decision 9).
- Search input forms: GPS is two 3-digit numbers separated by a space, `/` or `,`; metres are two 4–5 digit numbers, x then z. Anything else that is two numbers shows `Use GPS like 072 087, or metres like 7216 5706`.
- Every event with spawn positions gets a toggle regardless of `active`. Events with no positions get none.
- New layers default **off**, except Bunkers.
- "Does not spawn on this server" appears only when world loot, event loot, spawnable-types parents, spawn gear and Clan Wars catalogues are all empty for that item.
- Ruler only. No other drawing tools. A searched coordinate's marker is local to the searcher; "Pin it" hands off to the existing pin sheet.
- Static world data only on these layers. No live state (active bunkers, vehicle positions).
- Nothing scraped from iZurvive.
- Player-facing copy follows `brand/02-verbal-identity.md`; no identifier or string containing "faction" in web source (`test/copy-vocabulary.test.ts`).
- Generated JSON records the nasdara repo commit it came from (`source.commit`).
- Gate: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`, expect 32/32 tasks. Per memory, port 5434 belongs to One Life now: run a throwaway `postgres:16` on 5440 and point `TEST_DATABASE_URL` there.
- Every PR adds a committed `## [Unreleased]` entry in `CHANGELOG.md`.
- House style: comments say WHY; `⚠️` on load-bearing lines.

## Review Focus

1. **A GPS pair near the map's top or right edge** (`163 000`, `000 163`, `164 000`) must land inside the world or be rejected. It must not clamp silently to a corner. Pinned in Task 1.
2. **Metres that look like GPS**, such as `0100 0200` (leading zeros, 4 digits), must read as metres, and `100 200` as GPS. Digit count decides, not value. Pinned in Task 1.
3. **An item whose only source is a Clan Wars kit or award** (any flag, e.g. `Flag_Chernarus`) must not say "Does not spawn". Pinned in Task 8.
4. **A building type in `mapgrouppos.xml` with no `mapgroupproto.xml` group** (props, wrecks) must not crash the pipeline or appear on a loot layer. Pinned in Task 5.
5. **Every world layer on, zoomed out on a phone** must not draw 13.7k DOM markers. Pinned in Task 6 by a test that `worldView` returns null below the threshold.

---

### Task 1: GPS grid everywhere, plus the coordinate parser

**Files:**
- Modify: `apps/web/lib/map-projection.ts` (`gridRef`, `gridRefKey`, `parseGridRef`, plus new exports)
- Modify: `apps/web/app/(site)/map/map-draw.ts` (`drawGrid`)
- Modify callers that pass no size today: `lib/map-labels.ts`, `lib/map-roster.ts`, `lib/kit-view.ts`, `lib/award-view.ts`, `app/(site)/base/page.tsx`, `app/components/own-clan-hero.tsx`, `app/(site)/map/pin-sheet.tsx`, `app/api/map/pin/route.ts`, `app/(site)/map/map-view.tsx` (compile errors find any others)
- Test: `apps/web/test/map-projection.test.ts`, plus fix expectations in `map-labels`, `map-roster`, `map-url`, `award-view`, `base-report`, `pin-sheet-render`, `map-refresh` tests

**Interfaces:**
- Produces:
  - `gridRef(x: number, z: number, size = WORLD_SIZE_M): string`, returning `"072 087"` in GPS orientation.
  - `gridRefKey(x, z, size = WORLD_SIZE_M): string`.
  - `parseGridRef(key, size): { x; z } | null`, returning the cell centre with z = size − (gy·100 + 50).
  - `type CoordQuery = { kind: "gps" | "metres"; x: number; z: number } | { kind: "bad"; hint: string } | null`. Null means the input isn't two numbers, so it's treated as a name search.
  - `parseCoordQuery(input: string, size: number): CoordQuery`.
  - `COORD_HINT = "Use GPS like 072 087, or metres like 7216 5706"`.

- [ ] **Step 1: Write failing tests** in `map-projection.test.ts`. Replace the old `gridRef` cases.

```ts
const SIZE = 16384;
expect(gridRef(7216, 5706, SIZE)).toBe("072 106");          // (16384-5706)/100 = 106.78
expect(gridRef(0, SIZE, SIZE)).toBe("000 000");             // top-left is 000 000
expect(gridRef(0, 87, SIZE)).toBe("000 162");               // iZurvive: z=87 → Y 1.63 km shown, cell 162
expect(gridRef(-5, SIZE + 50, SIZE)).toBe("000 000");
expect(parseGridRef("072106", SIZE)).toEqual({ x: 7250, z: 16384 - 10650 });
expect(parseGridRef("164000", SIZE)).toBeNull();
expect(parseCoordQuery("072 087", SIZE)).toEqual({ kind: "gps", x: 7250, z: 16384 - 8750 });
expect(parseCoordQuery("072/087", SIZE)?.kind).toBe("gps");
expect(parseCoordQuery("072,087", SIZE)?.kind).toBe("gps");
expect(parseCoordQuery("7216 5706", SIZE)).toEqual({ kind: "metres", x: 7216, z: 5706 });
expect(parseCoordQuery("0100 0200", SIZE)).toEqual({ kind: "metres", x: 100, z: 200 });
expect(parseCoordQuery("100 200", SIZE)?.kind).toBe("gps");
expect(parseCoordQuery("163 000", SIZE)?.kind).toBe("gps");
expect(parseCoordQuery("164 000", SIZE)).toEqual({ kind: "bad", hint: COORD_HINT });
expect(parseCoordQuery("20000 100", SIZE)).toEqual({ kind: "bad", hint: COORD_HINT });
expect(parseCoordQuery("12 34", SIZE)).toEqual({ kind: "bad", hint: COORD_HINT });
expect(parseCoordQuery("No Abad", SIZE)).toBeNull();
```

- [ ] **Step 2: Run** `pnpm --filter @factions/web exec vitest run test/map-projection.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** GPS cell = `Math.floor((size - z) / 100)`, clamped to ≥ 0. Mixed digit counts (`072 7216`) are `bad`. Update the `GRID_KEY` doc comment to say GPS orientation.
- [ ] **Step 4: Fix `drawGrid`** so lines run at `x = k·1000` and `z = size − k·1000`. A 1 km GPS cell is then a drawn cell. Add a `map-draw` unit test: with a stub `L.polyline` recorder, the first horizontal line is at z = size.
- [ ] **Step 5: Update callers and the expectations in the listed tests.** Every fixture's grid string changes to the GPS value. Recompute each one; don't loosen any test.
- [ ] **Step 6: Run** `pnpm --filter @factions/web exec vitest run` and `pnpm --filter @factions/web typecheck`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(map): grid refs follow the in-game GPS`, with a CHANGELOG `Changed` line: "Grid references on the site now match the in-game GPS. Older map links may point somewhere else."

### Task 2: The world data file: schema, loader and mission parsers (events, bunkers, areas, spawns, wrecks)

**Files:**
- Create: `apps/web/lib/map-world.ts` (types, `loadWorld`, pure parsers)
- Create: `apps/web/scripts/build-map-world.ts` (CLI: reads `../nasdara` by default or `--mission <dir>`, writes `public/map-data/nasdara/world.json`)
- Create: `apps/web/test/map-world.test.ts`, with fixtures in `apps/web/test/fixtures/mission/` (small hand-cut XML/JSON copies, 2–3 entries each)
- Modify: `apps/web/package.json` (devDependency `fast-xml-parser`; script `"map:world": "tsx scripts/build-map-world.ts"`)

**Interfaces:**
- Produces:

```ts
export type WorldPoint = { x: number; z: number };
export type WorldEvent = { event: string; points: WorldPoint[] };          // cfgeventspawns name
export type WorldArea = { name: string; x: number; z: number; radius: number };
export type WorldFile = {
  version: 1;
  source: { commit: string; builtAt: string };
  events: WorldEvent[];            // only events with ≥1 position
  bunkers: WorldPoint[];           // cfgbunkerbroadcast.json proxies[].position [x,y,z] → {x, z}
  contaminated: WorldArea[];       // cfgEffectArea.json Areas[].Data.Pos/Radius
  playerSpawns: WorldPoint[];      // cfgplayerspawnpoints.xml <fresh> positions
  props: { type: number; x: number; z: number }[];   // mapgrouppos rows; `type` indexes `types`
  types: { name: string; proto: number | null }[];   // proto indexes `protos` (Task 5), null = no loot group
};
export function parseEventSpawns(xml: string): WorldEvent[];
export function parseBunkers(json: string): WorldPoint[];
export function parseEffectAreas(json: string): WorldArea[];
export function parsePlayerSpawns(xml: string): WorldPoint[];
export function parseGroupPositions(xml: string): { name: string; x: number; z: number }[];
export async function loadWorld(): Promise<WorldFile>;   // fetch("/map-data/nasdara/world.json"), cached in module scope
```

- [ ] **Step 1: Write failing tests** with the fixture files:
  - `parseEventSpawns` returns `StaticWaterTruck` with the fixture's points and drops an event with zero `<pos>`.
  - `parseBunkers` maps `[7216.415, 185.2, 5706.95]` to `{ x: 7216.415, z: 5706.95 }`.
  - `parseEffectAreas` returns `{ name: "Tunnel1", x: 5507, z: 5634, radius: 75 }`.
  - `parseGroupPositions` reads `pos="2005.42 283.01 4348.47"` as x = 2005.42, z = 4348.47 (the middle value is height).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement the parsers** with `fast-xml-parser`. Parse `cfgEffectArea.json` and `cfgbunkerbroadcast.json` with `JSON.parse`. Keep `<pos>` x/z in `cfgeventspawns` and drop y.
- [ ] **Step 4: Implement the script.** It writes `WorldFile` with `source.commit` from `git -C <mission> rev-parse HEAD`. Leave `types[].proto` null until Task 5. Print a count for each section. Run `pnpm --filter @factions/web map:world`. Expected output includes `StaticWaterTruck 66`, `VehicleTruck01 27`, `bunkers 23`, `VehicleCivilianSedan 47`, `ItemBricks 122`, `StaticContainerLocked 28`.
- [ ] **Step 5: Add a test that reads the committed `public/map-data/nasdara/world.json`.** It asserts `bunkers.length === 23`, and that every event in it has points and lies within `0..WORLD_SIZE_M`. Committed output is the contract, as `map-places.test.ts` does.
- [ ] **Step 6: Commit** the script, lib, tests, fixtures and generated JSON.

### Task 3: Area flags decoder (usage and tier per position)

**Files:**
- Create: `apps/web/lib/area-flags.ts`
- Test: `apps/web/test/area-flags.test.ts`

**Interfaces:**
- Produces:

```ts
export type AreaFlags = { cells: number; worldSize: number; at(x: number, z: number): { usage: number; value: number } };
export function decodeAreaFlags(buf: Uint8Array): AreaFlags;
export function parseLimits(xml: string): { usage: string[]; value: string[]; categories: string[]; tags: string[] }; // cfglimitsdefinition.xml order = bit order
```

- [ ] **Step 1: Confirm the layout** on the real file before writing code. The header is six little-endian uint32s (observed: 4096, 4096, 16384, 16384, 32, 0), followed by 4096×4096 cells of 5 bytes. Check whether each cell is a uint32 usage mask plus a uint8 value mask, and whether rows start at z = 0 or z = size. Use a throwaway node one-liner to read the cell at the Zulfiqar missile base (≈ x 2200, z 14700, from `lib/map-places.json`), and at a village. The base must carry the `Military` bit (index 0 in `cfglimitsdefinition.xml`) and Tier3 or Tier4. If the bytes disagree with this hypothesis, record the actual layout in the file's header comment and adapt. Don't guess.
- [ ] **Step 2: Write failing tests.** Build a synthetic 2×2-cell buffer with the confirmed header and layout, and assert `at()` for each quadrant, including the row-order direction confirmed in Step 1. Assert that `parseLimits` on the fixture returns `usage[0] === "Military"` and `value[3] === "Tier4"`.
- [ ] **Step 3: Implement**, then run. Expected: PASS.
- [ ] **Step 4: Commit.**

### Task 4: Wire area flags into the world file

**Files:**
- Modify: `apps/web/scripts/build-map-world.ts`, `apps/web/lib/map-world.ts`
- Test: `apps/web/test/map-world.test.ts`

**Interfaces:**
- Produces: `WorldFile.limits: { usage: string[]; value: string[] }` and `WorldFile.props[i].u` / `.t` (the area usage and value masks at that position).

- [ ] **Step 1: Write a failing test against the committed JSON.** At least one prop whose type name starts with `Land_Mil_` has the Military bit and a Tier3 or Tier4 bit.
- [ ] **Step 2: Implement.** Read `areaflags.map` with `decodeAreaFlags`, and stamp `u`/`t` on every prop.
- [ ] **Step 3: Rerun `map:world`, then the tests.** Expected: PASS.
- [ ] **Step 4: Commit.**

### Task 5: Loot buildings (protos, containers, effective usage)

**Files:**
- Modify: `apps/web/lib/map-world.ts`, `apps/web/scripts/build-map-world.ts`
- Test: `apps/web/test/map-world.test.ts` (+ fixture `mapgroupproto.xml` excerpt with `Land_Mil_Barracks1` and one group without `<usage>`)

**Interfaces:**
- Produces:

```ts
export type WorldProto = {
  name: string;
  usage: number;                       // group <usage> mask, 0 = none (fall back to area flags)
  containers: { categories: number; tags: number; points: number }[];  // masks over limits.categories / limits.tags
};
// WorldFile gains: protos: WorldProto[]; limits.categories: string[]; limits.tags: string[]
export function parseProtos(xml: string, limits: ReturnType<typeof parseLimits>): WorldProto[];
export function effectiveUsage(proto: WorldProto, areaUsage: number): number; // proto.usage || areaUsage
export const LOOT_GROUPS: readonly { key: string; label: string; usage: string[] }[];
```

`LOOT_GROUPS` (labels are player copy):

| key | label | usage names |
|---|---|---|
| `military` | Military | Military, MilitaryEast, MilitaryWest |
| `police` | Police | Police, Prison |
| `medical` | Medical | Medic |
| `fire` | Fire station | Firefighter |
| `industrial` | Industrial | Industrial |
| `town` | Town | Town, Office, School, Lunapark |
| `village` | Village | Village |
| `farm` | Farm | Farm |
| `hunting` | Hunting | Hunting |
| `coast` | Coast | Coast |

- [ ] **Step 1: Write failing tests.**
  - `parseProtos` gives `Land_Mil_Barracks1` the Military usage bit and two containers, `lootFloor` with 9 points and `lootshelves`, with category masks matching tools|containers.
  - `effectiveUsage({usage:0,…}, areaMask) === areaMask`.
  - `LOOT_GROUPS` usage names are all in `limits.usage` from the committed JSON (a drift test).
  - Review Focus 4: a `mapgrouppos` type with no proto keeps `proto: null`, and the script does not throw.
- [ ] **Step 2: Implement.** Set `types[].proto` by name.
- [ ] **Step 3: Rerun `map:world` and the tests.** Expected: PASS. Also check that `world.json` is ≤ 2 MB. If it's bigger, pack `props` as flat number arrays `[type, x, z, u, t]` with x/z rounded to 1 m, and update the loader. Record the size in the commit message.
- [ ] **Step 4: Commit.**

### Task 6: World layers on the map

**Files:**
- Create: `apps/web/lib/world-layers.ts` (the layer registry and the pure selection of what to draw)
- Modify: `apps/web/lib/map-icons.ts` (glyphs for every new layer; Military gets its own accent), `apps/web/lib/map-copy.ts` (labels and group headings), `apps/web/app/(site)/map/map-draw.ts` (`drawWorld`, `worldView`), `apps/web/app/(site)/map/map-view.tsx` (panel sections, groups, persistence)
- Test: `apps/web/test/world-layers.test.ts`, `apps/web/test/map-icons.test.ts`

**Interfaces:**
- Consumes: `WorldFile`, `LOOT_GROUPS`, `effectiveUsage` (Tasks 2–5).
- Produces:

```ts
export type WorldLayerKey = string;   // e.g. "event:StaticWaterTruck", "loot:military", "bunkers", "contaminated", "spawns", "wrecks"
export type WorldLayer = { key: WorldLayerKey; group: "Bunkers" | "Vehicles" | "Crash sites" | "Loot buildings" | "Wrecks" | "World"; label: string; defaultOn: boolean };
export function worldLayers(w: WorldFile): WorldLayer[];          // only layers with ≥1 point
export function pointsFor(w: WorldFile, key: WorldLayerKey, tiers: number): { x: number; z: number; title: string }[];
export const WORLD_STORAGE_KEY = "clan-wars.map.world";
export const WORLD_MIN_ZOOM: number;  // markers below this are not drawn
```

Event → label/group map (the player copy):
- **Vehicles:**
  - StaticWaterTruck → Water truck
  - VehicleTruck01 → Truck
  - VehicleCivilianSedan → Olga
  - VehicleHatchback02 → Gunter
  - VehicleSedan02 → Sarka
  - VehicleOffroadHatchback → Ada
  - VehicleOffroad02 → Hummer
  - VehicleMotorbike → Motorbike
- **Crash sites:**
  - StaticHeliCrash → Heli crash
  - StaticHeliCrashBig → Chinook crash
  - StaticMilitaryConvoy → Military convoy
  - StaticPoliceCar → Police car
  - StaticContainerLocked → Locked container
- **World:**
  - ItemBricks → Bricks
  - TrajectoryFig → Fig trees
  - Ambient* events → Animals (one toggle)
  - `Loot` → Loot piles
- An event not in this map gets a toggle under World, labelled with its raw name. A test lists the current events, so a new one is noticed.

**No rotation labels (Claude's call; amends the spec).** Neither wipe takes a vehicle away for long. `rotationActiveFor` switches the week's car off only inside the Monday off/on window, and the truck wipe's hours are bot env (`TRUCK_WIPE_EVENTS` plus its hours), which the browser can't see. An "Off this week" label would be wrong most of the week. Rows show spawn spots only. Step 5 of Task 12 amends the spec to match.

- [ ] **Step 1: Write failing tests.**
  - `worldLayers(fixtureWorld)` puts `event:StaticWaterTruck` under Vehicles with `defaultOn: false`, and `bunkers` with `defaultOn: true`.
  - No layer is returned for an event with zero points.
  - `pointsFor(w, "loot:military", ALL_TIERS)` returns only props whose `effectiveUsage` overlaps the military bits.
  - Passing the Tier4 bit alone drops a Tier2 barracks.
- [ ] **Step 2: Implement the `world-layers.ts` functions and the icons.** Use one chip glyph per group, with an accent per layer where iZurvive distinguishes them; Military uses a distinct accent. Add `map-icons` tests for each new key returning non-empty SVG.
- [ ] **Step 3: Add `drawWorld` and `worldView(m)` in `map-draw.ts`**, following `drawTravel`/`travelView`:
  - Draw on its own pane under the player markers, and only inside the padded bounds at or above `WORLD_MIN_ZOOM`. Bunkers and contaminated circles draw at every zoom.
  - The popup shows the label, `gridRef`, metres, and for loot buildings the tier names and usage names. This is static world data, so the "no coordinates in popups" rule doesn't apply. Add a comment saying why.
  - Test (Review Focus 5): `worldView` returns null below `WORLD_MIN_ZOOM`.
- [ ] **Step 4: Wire `map-view.tsx`.**
  - After the map is created, run `loadWorld()`, create one `layerGroup` per world layer, and redraw on `moveend`/`zoomend`, as `redrawTravel` does.
  - The layers panel gets the group headings and the new rows below the existing ones on both desktop and the phone sheet. Each row has its count.
  - Switches persist under `WORLD_STORAGE_KEY`; the existing `clan-wars.map.layers` key is untouched. Default to `defaultOn`.
  - If `loadWorld` fails, the panel shows one line, `World layers could not load.`, and the clan layers still work.
- [ ] **Step 5: Run the web tests and typecheck, then check by hand** with `pnpm --filter @factions/web dev`: open `/map`, toggle Water truck, Military and Bunkers, zoom in and out, and do the same on a phone-width window.
- [ ] **Step 6: Commit**, with a CHANGELOG `Added` line.

### Task 7: Search box (places, bunkers, coordinates), cursor readout, ruler

**Files:**
- Create: `apps/web/lib/map-search.ts` (pure ranking), `apps/web/app/(site)/map/map-search.tsx` (the box and results), `apps/web/lib/map-ruler.ts` (pure distance/bearing), `apps/web/app/(site)/map/map-ruler.tsx`
- Modify: `apps/web/app/(site)/map/map-view.tsx`, `apps/web/lib/map-copy.ts`
- Test: `apps/web/test/map-search.test.ts`, `apps/web/test/map-ruler.test.ts`

**Interfaces:**
- Consumes: `parseCoordQuery`, `COORD_HINT`, `gridRef` (Task 1); `WorldFile` (Task 2); `pinAtPoint` (`lib/map-pin.ts`).
- Produces:

```ts
export type SearchHit =
  | { tab: "locations"; label: string; x: number; z: number }
  | { tab: "items"; className: string; label: string }        // filled by Task 9
  | { tab: "models"; typeName: string; label: string; count: number }; // filled by Task 11
export type SearchResult = { coord: CoordQuery; hits: SearchHit[] };
export type SearchCtx = { size: number; places: { name: string; x: number; z: number }[]; bunkers: { x: number; z: number }[] }; // Task 9 adds `items?`, Task 11 adds `models?`
export function searchMap(q: string, ctx: SearchCtx): SearchResult;
export function pathLength(points: { x: number; z: number }[]): number;              // metres
export function bearing(a: { x: number; z: number }, b: { x: number; z: number }): number; // degrees, 0 = north, clockwise
export function formatDistance(m: number): string;                                     // "740 m", "2.3 km"
```

- [ ] **Step 1: Write failing tests.**
  - `searchMap("072 087")` has `coord.kind === "gps"` and no hits.
  - `searchMap("no ab")` puts `No Abad` first, matching case-insensitively from any word start.
  - `searchMap("bunker 7")` returns `Bunker 7`. Bunkers are numbered by their order in the file, 1-based.
  - `pathLength([{0,0},{300,400}]) === 500`.
  - `bearing({0,0},{0,100}) === 0` (north is +z) and `bearing({0,0},{100,0}) === 90`.
  - `formatDistance(740) === "740 m"` and `formatDistance(2300) === "2.3 km"`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Build the UI.**
  - **Search box:** top-left on desktop. The zoom control owns the top-left corner today, so move it to top-right under the sprocket. On a phone, it's a full-width bar under the strips. Results sit in Locations / Items / Models tabs.
  - **Picking a coordinate:** pan to it, zoom to max(current, 5), and drop a reticle marker local to this page (not saved). Its popup shows the GPS, the metres and a **Pin it** button. The button calls the existing pin flow with `pinAtPoint` and is shown only when `layers.pins`.
  - **Bad input:** the `bad` kind shows `COORD_HINT` under the box.
  - **Readout:** the existing bottom-bar `Grid` text becomes `GPS 072 / 087 · 7216, 5706`. On desktop it follows the cursor (`mousemove`, throttled to a frame); on touch it shows the centre. Tapping it copies that text with `navigator.clipboard`, and fails silently.
  - **Ruler:** a button beside Layers. While it's on, each click or tap adds a point, and the line plus the total and last-leg bearing draw on a local layer. A **Clear** button ends it. It has no persistence.
- [ ] **Step 4: Run the tests and typecheck, then check by hand:** search `072 087`, `7216 5706`, `No Abad` and `bunker 3`; measure two legs; use the readout on desktop and phone width.
- [ ] **Step 5: Commit**, with a CHANGELOG `Added` line.

### Task 8: Item index (where each item can come from)

**Files:**
- Create: `apps/web/lib/item-index.ts` (types, the CE match, loader), `apps/web/scripts/build-item-index.ts`
- Test: `apps/web/test/item-index.test.ts` (+ fixtures: `types.xml`, `cfgspawnabletypes.xml`, a spawn-gear preset excerpt)
- Modify: `apps/web/package.json` (script `"map:items"`)

**Interfaces:**
- Consumes: `WorldFile`, `limits`, `protos` (Tasks 2–5); `boosterCatalogue`, `awardsCatalogue`, `KIT_SLOTS` from `@factions/domain`, and the KotH loadout source the bot uses (find it with `grep -rn "koth-" packages/domain/src apps/bot/src` for the preset files; read the nasdara repo's `koth/` presets).
- Produces:

```ts
export type ItemIndexEntry = {
  className: string;
  nominal: number; min: number;
  categories: number; tags: number; usage: number; value: number; // masks over WorldFile.limits
  deloot: boolean;                     // event loot (crash sites)
  attachedTo: string[];                // parents in cfgspawnabletypes (attachments or cargo)
  spawnGear: boolean;                  // in a cfggameplay spawnGearPresetFiles preset
  clanWars: ("supply kit" | "booster kit" | "award" | "KotH loadout")[];
};
export function parseTypes(xml: string, limits: Limits): ItemIndexEntry[];   // other sources merged by the script
export function canSpawnAt(item: ItemIndexEntry, proto: WorldProto, areaUsage: number, areaValue: number): boolean;
export function spawnsAnywhere(item: ItemIndexEntry): boolean;   // false ⇒ "Does not spawn on this server"
export async function loadItemIndex(): Promise<ItemIndexEntry[]>;  // /map-data/nasdara/items.json
```

**CE matching rule** (verify against Bohemia's Central Economy docs before Step 3, and record the source in a comment):

`canSpawnAt` is true when:
- `nominal > 0` and not `deloot`;
- some container accepts it: the container's category mask overlaps the item's categories, or its tag mask overlaps the item's tags. An item with neither category nor tag goes in any container;
- `effectiveUsage(proto, areaUsage)` overlaps `item.usage`, or the item has no usage;
- `areaValue` overlaps `item.value`, or the item has no value.

- [ ] **Step 1: Write failing tests.**
  - The fixture `M4A1` (`category weapons`, usage `ContaminatedArea`, value `Unique`) can't spawn in a Military Tier4 barracks, and can spawn in a proto whose area usage is `ContaminatedArea` with a `Unique` value and a weapons container.
  - **Review Focus 3:** an item with `nominal 0` that appears in `awardsCatalogue()` has `spawnsAnywhere === true` and `clanWars` contains `"award"`.
  - An item with `nominal 0` and no other source has `spawnsAnywhere === false`.
  - An item listed as a `cfgspawnabletypes` attachment of `M4A1` has `attachedTo: ["M4A1"]`.
  - `deloot="1"` gives `deloot: true`.
- [ ] **Step 2: Implement `parseTypes`, `canSpawnAt` and `spawnsAnywhere`, then write the script.** The script writes `items.json` with `source.commit`. Spawn gear comes from the files named in `cfggameplay.json` `PlayerData.spawnGearPresetFiles`.
- [ ] **Step 3: Run `map:items` and the tests.** Expected: PASS. `items.json` must contain 2412 entries, and a test on the committed file asserts that.
- [ ] **Step 4: Commit.**

### Task 9: Item search on the map

**Files:**
- Modify: `apps/web/lib/map-search.ts` (items tab), `apps/web/lib/world-layers.ts` (`itemPoints`), `apps/web/app/(site)/map/map-search.tsx`, `apps/web/app/(site)/map/map-view.tsx`
- Create: `apps/web/app/(site)/map/item-panel.tsx`
- Test: `apps/web/test/map-search.test.ts`, `apps/web/test/world-layers.test.ts`

**Interfaces:**
- Consumes: `ItemIndexEntry`, `canSpawnAt` (Task 8); `ItemCard` (Task 10, optional; the panel works without it).
- Produces: `itemPoints(w: WorldFile, item: ItemIndexEntry): { x: number; z: number; title: string }[]` and `searchMap`'s items hits. Items match on `className` and on the card's `displayName` when cards are loaded.

- [ ] **Step 1: Write failing tests.**
  - `itemPoints` for the M4A1 fixture returns only contaminated-area props.
  - `searchMap("m4a1")` returns an items hit for `M4A1`.
  - Once cards are loaded, `searchMap("M4-A1")` returns it too.
- [ ] **Step 2: Implement the item view.**
  - Picking an item hides the world layers and draws only `itemPoints` in one temporary group. A chip says `Showing where M4-A1 spawns · Clear`, and **Clear** restores the switches as they were.
  - The side panel (bottom sheet on a phone) shows:
    - nominal/min;
    - tiers and usages by name;
    - "Crash sites" when `deloot`;
    - "Comes on: …" from `attachedTo`;
    - "Spawn gear" when it applies;
    - each Clan Wars source;
    - otherwise "Does not spawn on this server";
    - and the card from Task 10 if one exists.
- [ ] **Step 3: Run the tests, then check by hand** with `M4A1`, a common item (`Rag`), an attachment-only item and a flag.
- [ ] **Step 4: Commit**, with a CHANGELOG line.

### Task 10: Item cards from the game files (Ubuntu PC)

**Files:**
- Create: `apps/web/scripts/item-cards/extract.sh` (runs ON `rraygun@192.168.1.103`; read-only against the Steam install), `apps/web/scripts/build-item-cards.ts` (local: copies the remote output, filters to `items.json` class names, converts images, writes `public/map-data/nasdara/item-cards.json` and `public/map-data/nasdara/items/<class>.webp`)
- Create: `apps/web/lib/item-cards.ts`
- Test: `apps/web/test/item-cards.test.ts` (+ fixture: a small derapified `config.cpp` excerpt and a stringtable excerpt)

**Interfaces:**
- Produces:

```ts
export type ItemCard = {
  className: string; displayName: string; description: string;
  weightG: number | null; size: [number, number] | null;
  attachments: string[];      // class names that fit (resolved from inventorySlot ↔ attachments)
  magazines: string[]; ammo: string[];
  image: string | null;       // "/map-data/nasdara/items/M4A1.webp"
};
export function parseConfigClasses(cpp: string): Map<string, Record<string, unknown>>; // resolves inheritance
export function resolveString(v: string, table: Map<string, string>): string;           // "$STR_cfgWeapons_M4A1" → English
export function cardFor(cls: string, classes: Map<…>, table: Map<string, string>, slots: Map<string, string[]>): ItemCard | null;
export async function loadItemCards(): Promise<Map<string, ItemCard>>;
```

- [ ] **Step 1: Spike on the PC (no repo changes) and record what you find in the script's header comment.**
  - Install HEMTT to `~/.local/bin` (user-level, never sudo). Unpack `dz.pbo`/`weapons_*.pbo` to `~/clan-wars-item-cards/work`, then derapify `config.bin`.
  - Find where DayZ keeps item preview images: check for `*_preview*.paa`, `*_icon*.paa` and `editorPreview` in the configs. DayZ draws inventory items as 3D models, so a preview image may not exist for most items.
  - Decide image coverage from the result:
    1. game preview `.paa` files where they exist, converted to WebP;
    2. the 242 existing `public/items/*.webp` (`src/item-images.ts`) where they don't;
    3. otherwise `image: null`, and the card shows no picture.
  - Report the coverage numbers at hand-off.
- [ ] **Step 2: Write failing tests** on the fixture:
  - `parseConfigClasses` resolves `class M4A1: M4A1_Base` inheritance;
  - `resolveString` maps `$STR_` keys from the stringtable fixture;
  - `cardFor("M4A1")` lists the fixture's magazines and its ammo from `chamberableFrom`;
  - `attachments` is resolved by matching the weapon's `attachments[]` slot names against each item's `inventorySlot`.
- [ ] **Step 3: Implement the lib, `extract.sh` and `build-item-cards.ts`.**
  - The remote script writes only under `~/clan-wars-item-cards/`.
  - The local script pulls with `scp -r` and writes cards only for class names in `items.json`.
  - Images are WebP via `sharp`, 192px on the long edge.
  - Record the DayZ build (`Addons` mtime or the game version string) in the JSON `source`.
- [ ] **Step 4: Run it end to end**, then run the tests. Expected: PASS. Check the image count and total size; keep the total ≤ 25 MB, or lower the edge to 128px.
- [ ] **Step 5: Commit** the scripts, lib, tests and generated output.

### Task 11: Models search

**Files:**
- Modify: `apps/web/lib/map-search.ts`, `apps/web/lib/world-layers.ts` (`modelPoints`), `apps/web/app/(site)/map/map-search.tsx`
- Test: `apps/web/test/map-search.test.ts`

**Interfaces:**
- Produces: `modelPoints(w, typeName): { x; z; title }[]` and the models tab hits, with the count of placements per `types[].name`. The label is `typeName` with the `Land_` prefix dropped and `_` turned into spaces.

- [ ] **Step 1: Write failing tests:** `searchMap("barracks")` returns a models hit `Mil Barracks1` with its fixture count, and `modelPoints` returns that many points.
- [ ] **Step 2: Implement.** Picking a model works like an item: a temporary group plus the same "Showing … · Clear" chip.
- [ ] **Step 3: Run the tests.** Commit.

### Task 12: Guide, runbook, gate, PR

**Files:**
- Modify: `apps/web/content/guide/10-the-map.html` (world layers, search forms, GPS grid, ruler), `CHANGELOG.md`
- Create: `docs/deploy/2026-10-21-map-world-layers.md`. It covers:
  - rerunning `map:world`, `map:items` and the item-card build after a mission or DayZ update;
  - the one in-game spot check: stand at a bunker, compare the GPS reading with a search result, and record the outcome there.

- [ ] **Step 1: Update the guide chapter**, run `guide.test.ts`, and run `copy-vocabulary.test.ts`.
- [ ] **Step 2: Run the full gate** (Global Constraints). Expected: 32/32 tasks.
- [ ] **Step 3: Check the generated JSON sizes are in the PR description:** `world.json`, `items.json`, `item-cards.json`, and the image folder.
- [ ] **Step 4: Amend the spec's "Rotated vehicles say so" bullet** to say rows carry no rotation label, and why (see Task 6).
- [ ] **Step 5: Open the PR** with `keel:finish-work`.
