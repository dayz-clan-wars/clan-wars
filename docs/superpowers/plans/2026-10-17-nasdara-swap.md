# Nasdara Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Clan Wars from Chernarus to Nasdara in one cut: KotH on Nasdara's 66 towns, airdrop (Bunker Online) and fast travel removed, every "Chernarus" gone from what players see, and a dormancy grace so clearing bases does not make clans dormant.

**Architecture:** Mostly deletion plus data swaps. Shared helpers move out of the files being deleted before they go. The one new mechanism is a nullable `servers.map_changed_at` that the dormancy clock reads for active clans only, set on switch day by a guarded `pnpm` script. Historical rows (airdrops, Hub kills, KotH towns, Wanderer unlocks) keep rendering.

**Tech Stack:** pnpm + turbo, TypeScript, vitest, drizzle-orm (Postgres), discord.js, Next.js.

**Spec:** `docs/superpowers/specs/2026-10-17-nasdara-swap-design.md`

## Global Constraints

- Work on branch `feat/nasdara-swap` in `clan-wars`, cut in its own command from `docs/nasdara-swap-design` (which carries the spec and this plan) so one PR ships all of it; `main` is protected. Task 1 is in the separate `nasdara` mission repo, on its `main`.
- The gate, with `--force`, expecting **32/32 tasks**: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`. Never run two test runs at once (shared `factions_test_<package>`). Port 5434 only.
- Map: 16384 m, map key `nasdara`, xam.nu place data version `1.30-6`. World coords from xam.nu: `x = lng * 64`, `z = 16384 + lat * 64`.
- KotH spawn group = town name with only `[A-Za-z0-9]` kept (`Dar-e Ardis` → `DareArdis`); centre = the town's x/z (the group's single `<pos>`). Source: `../nasdara/scripts/spawn-points/towns.json` (`{name, category, x, z}`, 66 entries).
- Comments explain WHY; `⚠️` marks a line whose mistake fails silently. Match surrounding density (CLAUDE.md).
- Player copy: plain voice, punctuation per `brand/02-verbal-identity.md` (em dashes allowed).
- History must keep rendering: past `koth_events`, `airdrop_events`, Hub-discredited kills, `achievement_unlocks` for `wanderer`, `bans.reason = 'hub_combat'`.
- No migration drops a table or column. `airdrop_events`, `travel_uploads` stay.
- Every PR needs a committed `## [Unreleased]` entry in `CHANGELOG.md` (Task 12).

## Review Focus

1. **A clan dormant at the cutover** must stay dormant, not revive, and its disband age must not change (Task 11 test).
2. **An active clan with no declaration** (after `clear-bases`) and a season older than 7 days must not go dormant until 7 days after `map_changed_at` (Task 11 test).
3. **A KotH row scheduled on Chernarus** reaching its slot after the swap must fail with a reason and still print the Chernarus town name (Task 5 test).
4. **A live award whose position is cleared** (position null, `placed_at` kept) must stay `live` and accept a new placement (Task 11 test).
5. **A past `airdrop_events` row** with a Chernarus room slug or a Livonia slug must still name its place in the weekly show (Task 3 test).

---

### Task 1: Nasdara mission fixes (nasdara repo)

**Files:**
- Modify: `../nasdara/db/globals.xml:12`
- Modify: `../nasdara/cfggameplay.json` (`WorldsData.objectSpawnersArr`)

- [ ] **Step 1:** Set `FlagRefreshMaxDuration` to `1209600`.
- [ ] **Step 2:** Set `objectSpawnersArr` to `["./custom/booster-kits.json", "./custom/faction-supplies.json", "./custom/awards.json"]` (Chernarus's order, without its keycard and teleport entries). Keep the file's 2-space formatting.
- [ ] **Step 3: Verify:** `python3 -c 'import json;d=json.load(open("cfggameplay.json"));print(d["WorldsData"]["objectSpawnersArr"])'` prints the three paths; `grep FlagRefreshMaxDuration db/globals.xml` shows 1209600.
- [ ] **Step 4: Commit** `Load the clan spawner files and refresh flags for 14 days` and push. Do NOT cut a release; the runbook (Task 12) does.

---

### Task 2: Move KotH's borrowed helpers out of airdrops.ts

**Files:**
- Modify: `packages/domain/src/koth.ts`, `packages/domain/src/airdrops.ts`, `apps/bot/src/koth-decide-tick.ts:2-4,15-21,42-45,56,67,95`
- Test: `packages/domain/test/koth.test.ts`, `packages/domain/test/koth-auto.test.ts`, `packages/domain/test/airdrops.test.ts`

**Interfaces:**
- Produces (exported from `@factions/domain` via `koth.ts`): `isoWeekStart(now: Date): Date`, `highWater(values: number[]): number`, `kothDecisionInstantFor(slotStart: Date): Date` (= `slotStart - KOTH_REMINDER_LEAD_MS`).

- [ ] **Step 1: Write failing tests** in `koth.test.ts`: move the `highWater`, `isoWeekStart` and `decisionInstantFor` cases from `airdrops.test.ts:34-48,73-80` verbatim, renaming the last to `kothDecisionInstantFor` and asserting `kothDecisionInstantFor(new Date("2026-10-17T12:00:00Z")).toISOString() === "2026-10-17T11:30:00.000Z"` and that it equals `voteClosesAt` for the same slot.
- [ ] **Step 2: Run** `pnpm --filter @factions/domain vitest run test/koth.test.ts` → FAIL (`kothDecisionInstantFor` not exported).
- [ ] **Step 3: Implement** the three in `koth.ts` (move bodies from `airdrops.ts:43,76,83`); delete them from `airdrops.ts` and its tests; switch `koth-decide-tick.ts` imports to `kothDecisionInstantFor`; reword its airdrop comments. Delete `koth-auto.test.ts`'s "keeps the KotH reminder lead and the airdrop decide lead equal" case (the drift it guarded is gone by construction).
- [ ] **Step 4: Run** domain and bot `koth*` tests → PASS; `pnpm --filter @factions/domain typecheck`.
- [ ] **Step 5: Commit** `Move KotH's week and high-water helpers into koth.ts`.

---

### Task 3: Keep past airdrop names resolving without bunker.ts

**Files:**
- Create: `packages/domain/src/retired-airdrops.ts`, `packages/domain/test/retired-airdrops.test.ts`
- Modify: none (Task 4 wires the export)

**Interfaces:**
- Produces: `bunkerRoomName(slug: string): string`, same name, same fallbacks as `bunker.ts:30-35`, names only, from a literal table: the 11 Chernarus rooms (from `assets/bunker-rooms.json`: `balota-airfield`→"Balota Airfield", `vmc`→"VMC", `krasnostav-airfield`, `pavlovo-military`, `tisy-military`, `zelenogorsk`, `nwaf`→"NWAF", `kamensk-military`, `green-mountain`, `bashnya`, `prison-island`) plus the 16 retired Livonia slugs (`bunker.ts:20-23`). `apps/show` keeps importing it unchanged.

- [ ] **Step 1: Failing test** `retired-airdrops.test.ts`: `bunkerRoomName("kamensk-military") === "Kamensk Military"`, `bunkerRoomName("nwaf") === "NWAF"`, `bunkerRoomName("tarnow") === "Tarnow"`, unknown slug falls back exactly as `bunker.test.ts:23-25` asserts today.
- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement** the module. Do NOT export it from `index.ts` yet (`bunker.ts` still exports `bunkerRoomName`); the test imports `../src/retired-airdrops` directly. Task 4 swaps `export * from "./bunker"` for `export * from "./retired-airdrops"` when it deletes `bunker.ts`.
- [ ] **Step 4: Run** `pnpm --filter @factions/domain vitest run test/retired-airdrops.test.ts` → PASS.
- [ ] **Step 5: Commit** `Keep past bunker and airdrop names readable`.

---

### Task 4: Remove the airdrop (Bunker Online)

**Files:**
- Delete: `apps/bot/src/{airdrop-tick,airdrop-text,bunker-stage}.ts`, `apps/bot/src/commands/bunker.ts`, `packages/domain/src/{airdrops,bunker}.ts`, `packages/domain/assets/bunker-rooms.json`, tests `apps/bot/test/{airdrop-tick,airdrop-flip,bunker-stage,bunker-command}.test.ts`, `packages/domain/test/{airdrops,bunker,bunker-drift}.test.ts`
- Modify: `packages/domain/src/{index.ts,rules.ts:388-412,442-443,koth.ts:103,115,126}`, `apps/bot/src/{config.ts,discord.ts,restart-tick.ts,cfggameplay.ts,koth-vote-store.ts,koth-vote-tick.ts,population.ts:28,commands/index.ts,commands/types.ts,commands/koth.ts,commands/kothvote.ts,commands/award.ts:40}`, `packages/roster/src/internal/award-admin.ts:116`
- Test: `apps/bot/test/{restart-tick,cfggameplay,config,tick-order,koth-decide-tick,koth-command,kothvote-command}.test.ts` and the seven test contexts with `serverEvents: null`

**Interfaces (changed signatures):**
- `restartMessage(koth: string | null = null): string` (drops the airdrop argument and the "Bunker online" line).
- `restartTick(db, nitradoFor, opts: { now; lastError?; truckWipe?; raidWindow?; koth?: { open: boolean } })`, no `airdrop`.
- `GameplayEdits` loses `airdrop`; `GameplayResult` loses `airdrop` and `airdropError`; `applyGameplay` early-return becomes `if (!edits.raidWindow && !edits.koth) return {};`.
- `slotTakenBy(db, serverId, slot): Promise<"koth" | null>`.
- `Ctx` loses `serverEvents`. `Config` loses `airdrop`; `serverEventsChannelId` stays (raid window, vehicle wipe, bounties, KotH, referrals).
- `cfggameplay.ts` keeps `isEntry`, `setBaseDamageDisabled`, `readSpawnGearPresets`, `setSpawnGearPresets`; deletes `SPAWNERS_RE`, `isFeatureEntry`, `isFeatureLine`, `setAirdropSpawner`.

- [ ] **Step 1: Rework the tests first.** In `restart-tick.test.ts`: delete the airdrop-only upload test (`:576-624`); rewrite "carries both edits in ONE download and ONE upload" (`:648-659`) with `raidWindow` + `koth: { presets }`; switch `:661-665` to a raid or KotH edit; rewrite `:676-690` as "still applies the raid flip when the KotH preset swap refuses" (an empty preset list makes `setSpawnGearPresets` throw). In `tick-order.test.ts:57-67`: drop `airdropAt`, rename to "runs the vote tick, then the automatic decision, after the restart tick". Delete the bunker cases in `koth-decide-tick.test.ts:86-90`, `kothvote-command.test.ts:94-98`, `koth-command.test.ts:108-116`, `config.test.ts:352-376`, `cfggameplay.test.ts:92-176` (and its `spawners` helper), and remove `serverEvents: null` from the seven contexts.
- [ ] **Step 2: Run** bot tests → FAIL to compile/assert against the old code (e.g. `restartMessage` arity, `Ctx.serverEvents` excess property).
- [ ] **Step 3: Delete and edit** per the Files list. `kothvote.ts:46` becomes `if (taken || await kothOpen(…))`; `koth-vote-tick.ts:82` reason becomes `"an event took that restart"`. Remove `AIRDROP_*` from `rules.ts` and the env vars `AIRDROP_TICK`, `AIRDROP_WEEKLY_CAP`, `AIRDROP_MIN_POP`. Reword every comment that cites airdrop as the reason something exists (the `applyGameplay` single-round-trip warning stays, now justified by raid window + KotH).
- [ ] **Step 4: Run** the full gate → 32/32 PASS (`apps/show` `events.test.ts:99-108` still gets "Tarnow" and "Kamensk Military" through the new module). `grep -rn "airdropTick\|setAirdropSpawner\|bunker-stage\|AIRDROP_" apps packages --include=*.ts` returns nothing outside comments that describe history.
- [ ] **Step 5: Commit** `Remove the airdrop (Bunker Online)`.

---

### Task 5: King of the Hill on Nasdara's towns

**Files:**
- Modify: `packages/domain/assets/koth-locations.json`, `packages/domain/assets/koth-locations-retired.json`, `packages/domain/src/koth.ts:11-25`, `apps/bot/src/{spawn-points.ts:7,10,koth-converge.ts:56,84,koth-vote-tick.ts:86}`
- Test: `packages/domain/test/{koth.test.ts:82-111,koth-drift.test.ts:11}`, `apps/bot/test/{koth-command,koth-converge,koth-vote-tick}.test.ts`, `apps/show/test/story/events.test.ts:75-80` (title only)

**Interfaces:** `KothLocation` and `kothLocation`/`kothTownName`/`chooseKothTown` signatures unchanged. Slugs: lowercase name, strip apostrophes, runs of non-`[a-z0-9]` → `-`, trim (`OKB-754` → `okb-754`).

- [ ] **Step 1: Failing tests** in `koth.test.ts`: `toHaveLength(66)`; `kothLocation("dar-e-ardis")` matches `{ name: "Dar-e Ardis", spawnGroup: "DareArdis", centreX: 3436, centreZ: 4933 }`; `kothLocation("okb-754")?.spawnGroup === "OKB754"`; slug regex loosened to `/^[a-z0-9]+(-[a-z0-9]+)*$/`; centres within `0..WORLD_SIZE_M`; **new:** live slugs and retired slugs are disjoint and retired slugs are unique; `kothTownName("berezino") === "Berezino"` and `kothLocation("berezino") === null` (Chernarus retired, still named). `koth-drift.test.ts` reads `../../../../nasdara` and expects 66 groups with centre = group mean.
- [ ] **Step 2: Run** → FAIL (31 entries).
- [ ] **Step 3: Implement.** Append the 31 Chernarus entries to `koth-locations-retired.json` as `{name, slug, centreX, centreZ}` (drop `spawnGroup`). Regenerate `koth-locations.json` from `towns.json` (66 entries, sorted by name, `{name, slug, spawnGroup, centreX, centreZ}`) with a one-off node command; do not commit a generator. Update comments in `koth.ts` and the bot files to say Nasdara and the nasdara repo.
- [ ] **Step 4: Update bot tests** that use the real asset: replace `"berezino"`/`/Berezino/`/`"BEREZINO"` with `"dashtabad"`/`/Dashtabad/`/`"DASHTABAD"` in `koth-command.test.ts` (autocomplete types `"da"` and expects `"dashtabad"` among results), `koth-converge.test.ts` (fixture groups `Dashtabad`, `Khorramabad`; the `novaya-petrovka` case becomes `dar-e-ardis`/`DareArdis` → "King of the Hill at Dar-e Ardis"), `koth-vote-tick.test.ts:24,62`. **Review Focus 3:** add to `koth-converge.test.ts` "a row scheduled on Chernarus fails at its slot with a reason": a `scheduled` row with `location: "berezino"` reaching its opening slot ends `failed` with reason `berezino is not one of the 66 KotH towns`, and its cancellation text names "Berezino".
- [ ] **Step 5: Run** domain + bot KotH tests → PASS (drift test runs because `../nasdara` exists locally; it skips in CI).
- [ ] **Step 6: Commit** `Move King of the Hill to Nasdara's 66 towns`.

---

### Task 6: Map identity (size, key, place names)

**Files:**
- Modify: `packages/domain/src/rules.ts:155-162`, `apps/web/scripts/refresh-map-places.mjs:31-36,56`, `apps/web/lib/map-places.json`, `packages/roster/src/map.ts:20`
- Test: `apps/web/test/map-places.test.ts:7-15`, `packages/roster/test/map.test.ts:109`

**Interfaces:** `WORLD_SIZE_M = 16384`, `WORLD_MAP = "nasdara"`. `MAPS` becomes `[codename, upstream, version]` triples: `["chernarusplus","chernarusplus","1.29-7"]`, `["enoch","livonia","1.29-7"]`, `["nasdara","nasdara","1.30-6"]`; the CLI version argument, if given, overrides all. Keep the `chernarusplus` and `enoch` keys (tests and history use them).

- [ ] **Step 1: Failing test** in `map-places.test.ts`: `WORLD_MAP` has more than 100 places, includes "Nasdara" and "Dashtabad", and `nearestPlace("nasdara", 9632, 4075, 16384)` names "Nasdara" within 50 m.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the constants and script change; run `node apps/web/scripts/refresh-map-places.mjs` to regenerate `map-places.json` (it must contain a `nasdara` key with 156 places; `assertNonEmpty` guards a bad version). Update the `rules.ts` comment (Nasdara since the swap; Chernarus 15360 before).
- [ ] **Step 4: Run** web + roster + domain tests → PASS. `grep -rn "15360\|\"chernarusplus\"" apps packages --include=*.ts --include=*.tsx` shows only fixtures, `map-places.json` keys and history comments.
- [ ] **Step 5: Commit** `Point the map at Nasdara`.

---

### Task 7: Remove fast travel and the Hub rules (domain + bot)

**Files:**
- Delete: `packages/domain/src/{travel.ts,fast-travel-points.json}`, `apps/bot/src/hub-tick.ts`, tests `packages/domain/test/travel.test.ts`, `apps/bot/test/hub-tick.test.ts`
- Modify: `packages/domain/src/{index.ts,spacing.ts:20,hub.ts,rules.ts:49-93,178-180,guide-numbers.ts:37,40,126,136,191-198}`, `apps/bot/src/{config.ts:213-218,527,554-557,discord.ts:29,1031-1041,1942-1943}`, `packages/declarations/src/store.ts:367-369`
- Test: `packages/domain/test/{spacing,rules,guide-numbers,hub}.test.ts`, `packages/declarations/test/declaration-store.test.ts:70`, `apps/bot/test/config.test.ts:615-623`

**Decisions:** The Hub zone rule stays as a **historical** rule: `atHub`, `hubKillDiscredited`, `HUB_POSITION`, `HUB_ZONE_*`, `HUB_COMBAT_FROM` and `readVec3` remain, with a comment that they describe Chernarus's Hub and only ever match kills from that map (Nasdara has no 900 m sky platform at (100, 93)), so `rebuild:kills` reproduces history and no read side changes. `hub_combat` stays in `BAN_REASONS`. Removed: `hubTick`, `HUB_BAN_TICK`, `HUB_BAN_MS`, `HUB_RETALIATION_WINDOW_MS`, `HUB_OFFENCE_MAX_AGE_MS`, `HUB_TRAP_CLASSES`, `hubOffence`, `HubOffence`, `TRAVEL_POINTS`, `HUB_DESTINATIONS`, `FAST_TRAVEL_*`, and the Hub entry in `tooClose`. `distance2d` stays in `spacing.ts`.

- [ ] **Step 1: Failing tests:** `spacing.test.ts` "a base may sit anywhere the other bases allow (no Hub)": `tooClose({x:100,z:93}, [])` is `null`. `guide-numbers.test.ts` drops the two "Getting around" rows and the three "Fair play" Hub rows, and the row count goes from 60 to 55. `rules.test.ts` drops the 518/31 pins. `hub.test.ts` keeps `atHub`/`hubKillDiscredited` cases and drops `hubOffence`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the deletions and edits above (remove `GUIDE_GROUPS` "Getting around"; `HUB_DESTINATIONS_TOWNS` composite goes).
- [ ] **Step 4: Run** domain, declarations, bot tests → PASS (`kills-tick.test.ts:43-80` still passes unchanged).
- [ ] **Step 5: Commit** `Remove fast travel and the Hub ban`.

---

### Task 8: Remove the travel layer from the map

**Files:**
- Modify: `packages/roster/src/map.ts:5,48-49,127-128`, `apps/web/app/(site)/map/{map-draw.ts:10,35-36,103-106,414-423,map-redraw.ts:17,32,map-view.tsx:23-24,54,61,482,527-531,565-569,map.css:83-85}`, `apps/web/lib/{map-copy.ts:13-16,map-icons.ts:44,147-149,168}`
- Test: `packages/roster/test/map.test.ts:64-65`, `apps/web/test/{map-copy.test.ts:86,map-redraw.test.ts:17,40-42,map-roster.test.ts:66,map-labels.test.ts:40}`, `apps/bot/test/commands-map.test.ts:14,29`

**Interfaces:** `MapState` loses `travelPoints` and `hub`; `LAYER_LABELS` loses `travel`; `DATA_LAYERS` loses `"travel"`. A saved localStorage layer switch named `travel` must be ignored, not crash (keyed reads already skip unknown keys; keep it that way).

- [ ] **Step 1: Failing tests:** `map.test.ts` asserts `"travelPoints" in state === false`; `map-copy.test.ts` sorted keys without `"travel"`; `map-redraw.test.ts` without the travel layer.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** (remove `drawTravel`, `TRAVEL_PANE`, `TRAVEL_CHIP_ZOOM`, the far-zoom toggle if it only served travel, `travelIcon`, the CSS).
- [ ] **Step 4: Run** roster, web, bot tests → PASS; `pnpm --filter @factions/web typecheck`.
- [ ] **Step 5: Commit** `Take the travel points off the map`.

---

### Task 9: Remove the worker's travel projection

**Files:**
- Delete: `apps/ingest-worker/src/{travel.ts,travel-tick.ts}`, `apps/ingest-worker/assets/travel/`, tests `apps/ingest-worker/test/{travel,travel-tick}.test.ts`
- Modify: `apps/ingest-worker/src/{main.ts:7,18-26,82-89,130-139,sweep.ts:7,10,66-75,186-205,projection-upload.ts:37,50,clock-offsets.ts:13-17}`
- Test: `apps/ingest-worker/test/sweep.test.ts:232-255`

**Interfaces:** `SweepDeps` loses `travel`, `onTravelError`, `onTravelUploaded`, `onTravelDrift`. `storeFor` union loses travel; `TRAVEL_STORE` goes; `travel_uploads` table stays. `CLOCK_OFFSET_MS_BY_MAP` gains `nasdara: 7 * 60 * 60 * 1000` (measured on the One Life box; spec checklist step 8).

- [ ] **Step 1: Failing test** in `sweep.test.ts`: a sweep for a server whose mission is `dayzOffline.nasdara` completes with no error callback fired (replace the travel cases).
- [ ] **Step 2: Run** → FAIL (deps type / travel block).
- [ ] **Step 3: Implement** the deletions.
- [ ] **Step 4: Run** ingest-worker tests → PASS.
- [ ] **Step 5: Commit** `Stop uploading fast-travel files`.

---

### Task 10: Retire Wanderer, rewrite the guide and the Chernarus copy

**Files:**
- Modify: `packages/domain/src/achievements.ts:37,1-9`, `apps/bot/src/achievements/{tick.ts:26-29,touched.ts:16}`, `packages/roster/src/achievements.ts:49-60`, `apps/web/app/guide/render.ts:31-45`, `apps/web/lib/guide.ts:23-54`, `apps/web/content/guide/{01,04,10,12,13,14}-*.html`, delete `apps/web/content/guide/11-getting-around.html` and renumber 12–14 → 11–13 (files and manifest), `apps/web/lib/{feed-copy.ts:16-17,map-copy.ts:33}`, `packages/copy/src/live-feed.ts:83`, `apps/bot/src/{bounty-text.ts:36,achievement-embed.ts:7}`, `apps/web/app/api/og/achievement/[key]/route.tsx:68`, `apps/web/app/(site)/page.tsx:48`, `apps/web/app/guide/layout.tsx:63`, `apps/show/src/prompt/system.ts:11,38`, `apps/show/src/script/fact-check.ts:23`
- Test: `packages/domain/test/achievements.test.ts`, `packages/roster/test/achievements.test.ts:42`, `apps/bot/test/achievements/{rules,rules-solo}.test.ts`, `apps/web/test/{guide,guide-links,guide-discord,achievement-glyphs,achievement-share,achievements-copy,feed-copy}.test.ts`, `apps/bot/test/achievement-embed.test.ts:32`, `apps/show/test/{prompt/build,script/fact-check}.test.ts`

**Interfaces:**
- `def(...)` gains an optional `retired: true`; `wanderer` is retired. `ACHIEVEMENTS` stays 50 (keys, glyphs and share PNGs unchanged). New export `EARNABLE_ACHIEVEMENTS` (49).
- The tick evaluates only non-retired keys; existing unlocks are never deleted.
- The wall shows a retired achievement only to owners who hold it; "closest" never lists it; the guide's table lists only earnable ones; copy that says "fifty" says "forty-nine".
- Kept as history (records of what happened): `HUB_MARK` and the "At the Hub — " kill-feed title still render for old kills; `bounty-text.ts`'s line drops "and kills at the Hub".
- Copy: footer `"Clan Wars · Nasdara"`, OG `CLAN WARS · NASDARA`, homepage `· Nasdara`, guide layout `one Xbox server, Nasdara`, `MAP_REGION_LABEL = "Map of Nasdara. Tab moves between markers; Enter opens one."`, chapter 10 lede `"Nasdara, full screen, built for a phone. ..."`, chapter 01 `on Nasdara`. Chapter 04 drops the travel-point paragraph; 10 drops the Travel points row; 12 drops "No combat at the Hub" and the two Hub mentions; 13 drops "Getting around".
- Show prompt: the map is Nasdara; it moved from Chernarus on the cutover date (use the release date of this work; Livonia before 7 October 2026); places to name: Nasdara, Dashtabad, Khorramabad, Bustanshahr, Sabzabad, Gandomabad, Kamar Zir, Shah Yailaq, Bam-e Sabz, the Marek Barq dam; never name a Chernarus place unless the data names it for an event before the move. Fact-check mirrors that.

- [ ] **Step 1: Failing tests:** `achievements.test.ts` `EARNABLE_ACHIEVEMENTS` has 49 and excludes `wanderer`; `rules-solo.test.ts` the tick never unlocks `wanderer` from teleport events but an existing unlock survives; roster wall for a non-holder has 49 tiles and for a holder 50; `guide.test.ts` 14 chapters (13 numbered + appendix), achievements is chapter `"13"`, the Hub-copy loop removed; `guide-discord.test.ts` drops the getting-around cases; embed footer, show prompt and fact-check assertions say Nasdara.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the copy and the retirement.
- [ ] **Step 4: Run** the full gate → 32/32 PASS. `grep -rni "chernarus" apps/web/content apps/web/lib apps/web/app apps/bot/src apps/show/src --include=*.ts --include=*.tsx --include=*.html` returns only history comments and the show's "moved from Chernarus" line.
- [ ] **Step 5: Commit** `Retire Wanderer and say Nasdara everywhere`.

Note for the runbook: renumbering guide chapters makes `publish-guide` create new Discord channels for 11–13 and orphan the old 11–14; the runbook runs it once with `--prune`.

---

### Task 11: Dormancy grace at the map change

**Files:**
- Modify: `packages/db/src/schema.ts:8-66` (`servers.mapChangedAt`), `apps/bot/src/dormancy-store.ts:153-201`, `apps/bot/test/dormancy-index-drift.test.ts:101`
- Create: migration `packages/db/migrations/0068_*.sql` (generated), `apps/bot/src/map-cutover.ts`, `scripts/map-cutover.ts`, root `package.json` script `"map-cutover": "tsx scripts/map-cutover.ts"`
- Test: `apps/bot/test/dormancy-store.test.ts` (inside `describe("clocks")`), `apps/bot/test/map-cutover.test.ts`, `packages/roster/test/awards.test.ts` (Review Focus 4)

**Interfaces:**
- Column `map_changed_at timestamptz` nullable on `servers`; null means no grace.
- `clockQuery`: `lastRaiseAt` = `greatest(coalesce(LAST_RAISE, activated_at, created_at), declarations.declared_at, seasons.started_at, CASE WHEN factions.status = 'active' THEN servers.map_changed_at END)`, joining `servers` on `servers.id = factions.server_id`. ⚠️ The `CASE` is what keeps a clan dormant at the cutover from reading `lastRaiseAt > dormantSince` and reviving (`dormancy.ts:83`).
- `setMapChangedAt(db: Database, serverId: number, at: Date): Promise<void>` in `apps/bot/src/map-cutover.ts`.
- `pnpm map-cutover --server <id> --at <ISO> [--allow-test-db]`, same argument parsing, `--at` required, and `factions_live` guard as `scripts/launch.ts`.

- [ ] **Step 1: Failing tests** in `dormancy-store.test.ts`, with a `seedFaction` variant that deletes the declaration:
  - "⚠️ the map change floors an active clan's clock": raise 20 days ago, season 20 days ago, no declaration, `map_changed_at = ago(1 day)` → `lastRaiseAt` equals `ago(1 day)`, `decide` is `null`.
  - "⚠️ a clan dormant at the map change stays dormant": `status 'dormant'`, `dormant_since = ago(3 days)`, `map_changed_at = ago(1 day)` → `decide` is not `"revive"`, and its disband age is still 3 days.
  - "the grace runs out": `map_changed_at = ago(8 days)`, no raise since → `decide` is `"dormant"`.
  - `map-cutover.test.ts`: sets the column; the script refuses a non-`factions_live` URL without `--allow-test-db`.
  - **Review Focus 4** in `packages/roster/test/awards.test.ts`: a grant with `live_from` in the past, `placed_at` set and `pos_x/y/z` null is `live` and `startAwardPlacementDb` issues a challenge.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the schema change, `cd packages/db && npx drizzle-kit generate`, read the SQL (one `ALTER TABLE servers ADD COLUMN map_changed_at timestamptz`), then the query, the store function and the script. Add `servers` to the drift test's ANALYZE list if the plan check needs it.
- [ ] **Step 4: Run** db, bot, roster tests with `TEST_DATABASE_FRESH=1` for the bot package (new migration) → PASS.
- [ ] **Step 5: Commit** `Give every clan a week to re-raise after a map change`.

---

### Task 12: Switch-day runbook, docs and changelog

**Files:**
- Create: `docs/deploy/2026-10-18-nasdara-swap.md` (date it for the planned switch; structure of `docs/deploy/2026-10-12-carry-bases.md`)
- Modify: `CLAUDE.md` (remove the Bunker online row and the `/airdrop` command mention; KotH row says Nasdara and drops the airdrop sentences; Hub row says historical; map identity in "Current state"; Achievements count 49 earnable of 50), `apps/bot/README.md:58-63`, `CHANGELOG.md` (`## [Unreleased]`)

The runbook, in order, with exact commands:
1. **Before:** release the nasdara mission (Task 1) as v1.0.1 and confirm the FTP deploy uploaded `cfggameplay.json`, `db/globals.xml` and `koth/default/` to `/dayzxb_missions/dayzOffline.nasdara/` on 19831378. Mirror tiles on the host: `sudo ./deploy/mirror-tiles.sh -p 4` from the One Life checkout (its `MAPS` and `dzmap.yaml` already include `nasdara`); check `/var/www/tiles/nasdara/topographic/0/0/0.webp`. Ship this branch's release (migration 0068 applies on deploy). Remove `AIRDROP_*` and `HUB_BAN_TICK` from `.env`.
2. **List what the wipe will cost:** `select id, tag, reserved_until from factions where status = 'reserved'`. A reserved clan's base is cleared with the rest, so it cannot activate and lapses within 24 hours (accepted: it re-founds on Nasdara).
3. **Close open events:** `update koth_events set state = 'cancelled', cancel_posted_at = now() where server_id = 1 and state = 'scheduled'` (a `live` row is left for the restart tick's restore); `update koth_votes set state = 'void', closed_at = now() where state = 'open'`; `update airdrop_events set state = 'ended', ended_at = now() where state in ('announced','live')`.
4. **Clear placements:** `pnpm clear-bases --server 1 --before <cutover ISO> --dry-run`, review, then without `--dry-run` (cascades sightings, zone placements and incidents). `update booster_kits set pos_x = null, pos_y = null, pos_z = null`. `update award_grants set pos_x = null, pos_y = null, pos_z = null where revoked_at is null` (⚠️ keep `placed_at`: nulling it lapses a live award). `update booster_kit_challenges set closed_at = now() where closed_at is null`. `delete from clan_pins`.
5. **Map identity:** `update servers set map = 'nasdara' where id = 1`; `pnpm map-cutover --server 1 --at <cutover ISO>`.
6. **Operator:** switch the mission to `dayzOffline.nasdara` in Nitrado and restart.
7. **Guide channels:** run `publish-guide` once with `--prune` (chapters renumbered).
8. **Checks:** `select clock_offset_ms from servers where id = 1` is still 25200000 and the worker logs no offset change; the RPT names `dayzOffline.nasdara` with no new load complaints; `supply_uploads`, `booster_kit_uploads`, `award_uploads` advance with no worker errors; the restart tick found `koth/default/`; the site map shows Nasdara tiles and place names with no travel layer; `select tag, status, dormant_since from factions where status = 'dormant' and dormant_since > '<cutover>'` returns 0 rows.
9. **Rollback:** the cleanup is irreversible except from the pre-migration dump `deploy-release.sh` takes; switching Nitrado back to Chernarus without the dump leaves clans without bases.

- [ ] **Step 1:** Write the runbook and the doc edits.
- [ ] **Step 2:** CHANGELOG `## [Unreleased]`: `### Changed` "Clan Wars moves to Nasdara. Bases are cleared; clans and members carry over, and every clan has a week to raise its flag again. King of the Hill runs on Nasdara's towns." `### Removed` "Bunker Online and fast travel. The Wanderer achievement can no longer be earned; anyone who has it keeps it."
- [ ] **Step 3: Run** the full gate → 32/32.
- [ ] **Step 4: Commit** `Nasdara swap runbook and changelog` and open the PR with `keel:finish-work`.
