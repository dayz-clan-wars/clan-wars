# Booster Kit: Nasdara Gear, Helmets and Vests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tenth kit slot (Vest), catalogue extras that spawn beside a pick, helmets in Headgear, and every Nasdara-only wearable to the booster kit.

**Architecture:** `KIT_SLOTS` gains `vest` (new nullable `booster_kits.vest` column). `CatalogueEntry` gains the same optional `extras` that `AwardItem` already has, and the booster kit tick expands a pick to `[className, ...extras]` exactly as `award-tick.ts` does. Award slots gain an `optional` flag, set by `expandSlots` for `vest` alone, so live booster-kit award grants keep spawning. The catalogue content is data work in `booster-catalogue.json` plus art.

**Tech Stack:** TypeScript, vitest, drizzle-orm/drizzle-kit, Next.js, pnpm/turbo.

**Spec:** `docs/superpowers/specs/2026-10-18-booster-kit-nasdara-design.md`

## Global Constraints

- Every class name, extras included, must exist in Nasdara's `db/types.xml`: `git -C ../nasdara show origin/main:db/types.xml` (the nasdara repo sits beside this worktree's parent checkout at `/Users/steveharmeyer/Development/dayz-clan-wars/nasdara`).
- Labels are the in-game display names in the catalogue's existing "Name (Colour)" style; unique per slot; each slot's list stays sorted by label.
- Test gate: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5440/factions" npx turbo run typecheck test --concurrency=1 --force`, expecting **32/32**. Port 5440 is a throwaway `postgres:16` container (`docker run -d --name cw-test-pg-5440 -e POSTGRES_USER=factions -e POSTGRES_PASSWORD=factions -e POSTGRES_DB=factions -p 5440:5432 postgres:16` if it is not running). Never 5434 (another project) and never `factions_live`.
- House style: comments explain WHY; `⚠️` on lines whose misuse fails silently. Match the density of the file being edited.
- Every PR adds an entry under `## [Unreleased]` in `CHANGELOG.md`, in player-facing language.
- Ship as **2.2.0**.

## Review Focus

1. A saved kit from before the change (vest null) must still spawn its other picks — Task 1 test.
2. A live `booster-kit` award grant with nine picks and no vest must stay in the award file and stay placeable — Task 2 tests.
3. A vest pick that has since left the catalogue must not count as complete, optional or not — Task 2 test.
4. A plate carrier pick must spawn the vest, then its pouches and holster, and a pick that left the catalogue must spawn none of its extras — Task 1 test.
5. Every extra the kit can spawn has a readable label, so "Comes with" never shows a class name — enforced by the existing award-parts test once Task 3 lands (the booster-kit award carries the kit's extras).

---

### Task 1: Vest slot, catalogue extras, and the kit tick

**Files:**
- Modify: `packages/domain/src/booster-kit.ts` (KIT_SLOTS, KIT_SLOT_LABELS, KIT_GRID_ORDER, CatalogueEntry, loadCatalogue, docblocks saying "nine")
- Modify: `packages/db/src/schema.ts:1411-1427` (`vest: text("vest")` after `backpack`)
- Create: `packages/db/migrations/0069_*.sql` + meta, via `cd packages/db && npx drizzle-kit generate`
- Modify: `apps/ingest-worker/src/booster-kit-tick.ts` (select `vest`, expand extras)
- Modify: `packages/domain/assets/booster-catalogue.json` (add `"vest": []` placeholder so the loader passes; Task 3 fills it)
- Test: `packages/domain/test/booster-kit.test.ts`, `apps/ingest-worker/test/booster-kit-tick.test.ts` (or the file that already tests the tick), `apps/web/test/kit.test.ts`

**Interfaces:**
- Produces: `KIT_SLOTS = ["mask","eyewear","hat","jacket","pants","boots","gloves","hipPack","backpack","vest"]` (vest appended, so no existing order moves); `KIT_SLOT_LABELS.vest = "Vest"`; `KIT_GRID_ORDER = ["jacket","vest","pants","backpack","hipPack","boots","gloves","hat","mask","eyewear"]`; `CatalogueEntry = { className: string; label: string; image?: string; extras?: string[] }`.

- [ ] **Step 1: Failing domain tests** in `packages/domain/test/booster-kit.test.ts`: add `vest: []` to `GOOD`;
  ```ts
  it("accepts an entry with extras", () => {
    const c = loadCatalogue({ ...GOOD, vest: [{ className: "PlateCarrierVest", label: "Plate Carrier", extras: ["PlateCarrierPouches", "PlateCarrierHolster"] }] });
    expect(c.vest[0]!.extras).toEqual(["PlateCarrierPouches", "PlateCarrierHolster"]);
  });
  it("throws on empty extras, naming the class", () => {
    expect(() => loadCatalogue({ ...GOOD, vest: [{ className: "PlateCarrierVest", label: "Plate Carrier", extras: [] }] })).toThrow(/PlateCarrierVest/);
  });
  it("throws on a non-string extra", () => {
    expect(() => loadCatalogue({ ...GOOD, vest: [{ className: "PlateCarrierVest", label: "Plate Carrier", extras: [7] }] })).toThrow(/PlateCarrierVest/);
  });
  ```
  and in `apps/web/test/kit.test.ts` the existing permutation test keeps passing; add `expect(KIT_GRID_ORDER.indexOf("vest")).toBe(KIT_GRID_ORDER.indexOf("jacket") + 1);`.
- [ ] **Step 2:** Run `pnpm --filter @factions/domain test` — expect the three new tests to fail.
- [ ] **Step 3:** Implement in `booster-kit.ts`. Extras validation is the same rule and message shape as `loadAwards` (`booster catalogue: <className> extras must be a non-empty list of class names`). Add `"vest": []` to the JSON. Add the schema column, generate the migration, and read the SQL: it must be exactly one `ALTER TABLE "booster_kits" ADD COLUMN "vest" text;`.
- [ ] **Step 4: Failing tick tests** in the ingest-worker's booster kit tick test: (a) a kit row with `vest: null` and other slots set produces those items and no error; (b) a kit with `vest: "PlateCarrierVest"` produces `PlateCarrierVest, PlateCarrierPouches, PlateCarrierHolster` in that order (use a test catalogue or the committed one once Task 3 lands; if the tick reads the committed catalogue at module scope, test through `generateBoosterKits` input by asserting on the uploaded content's `name` order); (c) a pick no longer in the catalogue contributes neither itself nor extras.
- [ ] **Step 5:** In `booster-kit-tick.ts` select `vest: boosterKits.vest` (the ⚠️ comment above the select already explains why the key must equal the slot string; change its "nine" to "ten") and replace the final `.map((s) => s.className)` with a `flatMap` to `[className, ...(entry.extras ?? [])]`, finding the entry in `CATALOGUE[s.slot]`. Comment: same expansion as `award-tick.ts`, pick first.
- [ ] **Step 6:** Run the full gate. Fix every typecheck fallout from the new slot (tests that build a `Record<KitSlot, …>` by hand, e.g. `packages/roster/test/booster-kit.test.ts` `ALL_PICKS` gains `vest: null` or a vest class once Task 3 adds one — use `null`-safe forms). Expect 32/32.
- [ ] **Step 7: Commit** `feat(kit): a Vest slot, and catalogue extras that spawn beside a pick`.

### Task 2: The Vest is optional for the booster-kit award

**Files:**
- Modify: `packages/domain/src/awards.ts` (`AwardSlot`, `loadAwards`, `picksComplete`)
- Modify: `packages/domain/src/awards-catalogue.ts` (`expandSlots`)
- Modify: `apps/ingest-worker/src/award-tick.ts:80-87`
- Modify: `apps/web/app/(site)/awards/[id]/award-flow.tsx:89`
- Test: `packages/domain/test/awards.test.ts`, the award-tick test, `apps/web/test/award-render.test.tsx`

**Interfaces:**
- Consumes: Task 1's `KIT_SLOTS` with `vest`.
- Produces: `AwardSlot = { label: string; items: AwardItem[]; optional?: true }`; `KIT_AWARD_OPTIONAL_SLOTS: readonly KitSlot[] = ["vest"]` exported from `packages/domain/src/booster-kit.ts`.

- [ ] **Step 1: Failing tests** in `awards.test.ts`:
  ```ts
  it("marks the booster kit award's vest optional, and nothing else", () => {
    const slots = awardsCatalogue()["booster-kit"]!.slots;
    expect(Object.entries(slots).filter(([, s]) => s.optional).map(([k]) => k)).toEqual(["vest"]);
  });
  it("counts a booster kit grant with every slot but the vest as complete", () => {
    const def = awardsCatalogue()["booster-kit"]!;
    const picks = Object.fromEntries(Object.entries(def.slots).filter(([k]) => k !== "vest").map(([k, s]) => [k, s.items[0]!.className]));
    expect(picksComplete(def, picks)).toBe(true);
  });
  it("does not count an optional slot holding a retired class as complete", () => {
    const def = awardsCatalogue()["booster-kit"]!;
    const picks = Object.fromEntries(Object.entries(def.slots).map(([k, s]) => [k, s.items[0]!.className]));
    expect(picksComplete(def, { ...picks, vest: "NotAThing" })).toBe(false);
  });
  it("still requires every non-optional slot", () => { /* drop "jacket" from a full set → false */ });
  it("refuses optional on a hand-written slot that is not true", () => { /* loadAwards with optional: false or "yes" → throws naming the slot */ });
  ```
  Also an award-tick test: a booster-kit grant with no vest pick is included (not in `dropped`) and spawns its nine picks. And an award-render test: the booster-kit award's Place button is enabled with every slot but vest chosen.
- [ ] **Step 2:** Run them; expect failures.
- [ ] **Step 3:** Implement. `loadAwards` accepts `optional` only as `true` or absent. `picksComplete`: an optional slot with no pick passes; any present pick must satisfy `isAwardPick`. `expandSlots` sets `optional: true` for slots in `KIT_AWARD_OPTIONAL_SLOTS`, with a ⚠️ comment that without it every live booster-kit grant would leave the award file the moment a slot was added (spec "Vest is optional for the award"). `award-tick.ts` skips a slot with no pick in its `flatMap` (the `!` on `r.picks[slot]` must go). `award-flow.tsx`'s `complete` ignores optional slots.
- [ ] **Step 4:** Full gate, 32/32.
- [ ] **Step 5: Commit** `feat(awards): the booster kit award's Vest is optional, so live grants keep spawning`.

### Task 3: The catalogue content

**Files:**
- Modify: `packages/domain/assets/booster-catalogue.json`
- Modify: `apps/web/lib/award-parts.ts` (`PART_LABELS`)
- Modify: `packages/domain/test/booster-kit.test.ts` (`NO_ART_YET`, adjusted in Task 4)

**Interfaces:**
- Consumes: Task 1's `vest` slot and `extras`.

- [ ] **Step 1: Resolve every item.** For each class in the spec's "What is added, by slot" list, read its in-game display name and real inventory slot from dayz.wiki.gg (or dayz.fandom.com). Keep a table in the PR description: class, label, slot. Rules from the spec: move an item whose real slot differs from the spec's grouping; drop and list any item whose slot is not one of the ten kit slots. Reuse the plate carrier labels already in `packages/domain/assets/awards.json`'s `plate-carrier` award.
- [ ] **Step 2: Verify class names.** Every catalogue class and every extra must appear as `<type name="X">` in `git -C ../nasdara show origin/main:db/types.xml` (adjust the path to the nasdara checkout). Script it; zero misses.
- [ ] **Step 3: Write the entries** into `booster-catalogue.json`, each slot sorted by label, no `image` yet. Extras, verbatim from the spec:
  - `Mich2001Helmet`: `["NVGoggles", "UniversalLight", "Battery9V", "Battery9V"]`
  - `PlateCarrierVest`: `["PlateCarrierPouches", "PlateCarrierHolster"]`; `_Black`, `_Camo`, `_Green`, `_Winter`: the same with that suffix on both.
- [ ] **Step 4: Part labels.** Add to `PART_LABELS`: `NVGoggles`, `UniversalLight`, and the ten plate carrier pouch and holster classes, readable like the existing entries (e.g. `"Plate carrier pouches (black)"`). `Battery9V` exists.
- [ ] **Step 5:** Set `NO_ART_YET` to every new class (temporarily) so the image test passes, and run the full gate: the existing award-parts test now covers the kit's extras through the booster-kit award. 32/32.
- [ ] **Step 6: Commit** `feat(kit): Nasdara gear, helmets and vests in the booster catalogue`.

### Task 4: Item art

**Files:**
- Modify: `apps/web/src/item-images.ts` (`WIKI_FILENAME`)
- Create: `apps/web/public/items/<className>.webp` for each item with art
- Modify: `packages/domain/assets/booster-catalogue.json` (`image` fields), `packages/domain/test/booster-kit.test.ts` (`NO_ART_YET`)

- [ ] **Step 1:** For each new catalogue class, find its file on dayz.wiki.gg or dayz.fandom.com and add a `WIKI_FILENAME` entry (reviewed by eye, per that module's warning). The `PlateCarrierVest*` images already exist; only their `image` fields are needed.
- [ ] **Step 2:** `pnpm --filter @factions/web exec tsx scripts/fetch-item-images.ts --only <prefix>` per family (never the whole catalogue; it re-encodes 200 files). Check every new file is 192×192 and under 60 KB (the tests enforce it).
- [ ] **Step 3:** Add `"image": "items/<className>.webp"` to each entry with art. `NO_ART_YET` lists exactly the classes with none, in catalogue order.
- [ ] **Step 4:** Full gate, 32/32. **Commit** `feat(web): art for the new booster kit items`.

### Task 5: The page and the copy

**Files:**
- Modify: `apps/web/app/(site)/kit/kit-flow.tsx` ("nine" copy; a "Comes with" line), `apps/web/app/components/owner.tsx:163`, `apps/web/lib/notice-copy.ts:287`, `apps/bot/src/notice-text.ts:230`, `apps/web/lib/kit-copy.ts` comments, `apps/web/app/(site)/kit/page.tsx`, `apps/web/app/api/kit/slot/route.ts`, `packages/roster/src/api.ts`, `packages/roster/src/booster-kit.ts`, `packages/domain/src/awards-catalogue.ts` docblocks
- Modify: `CHANGELOG.md`
- Test: `apps/web/test/kit-render.test.tsx`, `apps/bot/test/notice-text.test.ts` if it pins the sentence

- [ ] **Step 1: Failing render test** in `kit-render.test.tsx`: with `vest: "PlateCarrierVest"` saved, the page contains `Comes with: Plate carrier pouches, Plate carrier holster` (whatever Task 3's labels render through `comesWith`); with no vest, it contains no "Comes with".
- [ ] **Step 2:** In `kit-flow.tsx`, under the grid, render one line per chosen pick with extras, in `KIT_GRID_ORDER`, using `comesWith` from `@/lib/award-parts` and the same markup as `award-flow.tsx:151-152`, prefixed with the item label: `<label> comes with: <parts>`. Adjust the test to that exact text.
- [ ] **Step 3:** Replace every player-facing "nine pieces"/"nine pickers" with "ten", and every code comment that counts the slots. Grep `-i 'nine'` across the files above to finish.
- [ ] **Step 4: CHANGELOG** under `## [Unreleased]`, `### Added`: "The booster kit has a Vest slot, with plate carriers that come with matching pouches and holster. Headgear now includes the MICH helmet, which comes with night vision, a light and batteries, plus the Ballistic and T56 tanker helmets. Nasdara's own clothing is in too: keffiyehs, turbans, pakols, kameez shirts, shalwar pants, sandals, robe and linen vests, OBR uniforms, the desert hunting gear and more, in every colour." Adjust to what Task 3 actually shipped.
- [ ] **Step 5:** Full gate, 32/32. **Commit** `feat(kit): ten slots on the page, and what comes with a pick`.

### Task 6: Release (controller, not a subagent)

- [ ] Open the PR (body lists Task 3's moved and dropped items), comment-review, merge with `--merge`, then `release/2.2.0` per the release flow memory, tag `v2.2.0`, `gh release create`. The deploy timer applies migration 0069 automatically.
