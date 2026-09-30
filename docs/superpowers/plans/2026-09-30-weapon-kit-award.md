# Weapon Kit Award Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `weapon-kit` event award: the winner picks one of twelve guns, and it spawns with a fixed set of parts beside it.

**Architecture:** A catalogue item gains an optional `extras: string[]` of class names. The pick is still one class name per slot, so storage and placement do not change; the award tick expands a pick into `[className, ...extras]` when it writes the spawner file. The award page shows a "Comes with" line for the picked gun.

**Tech Stack:** TypeScript, pnpm + turbo monorepo, vitest, Next.js (apps/web), Drizzle/Postgres (worker tests need the test database).

**Spec:** `docs/superpowers/specs/2026-09-30-weapon-kit-award-design.md`

## Global Constraints

- Award key `weapon-kit`, label "Weapon Kit", `durationDays` 3, one slot `weapon` labelled "Weapon".
- Two magazines per gun; the twelve loadouts are exactly the table in spec §3, extras in that order.
- Every class name is already verified present, with exact case, in `livonia/db/types.xml` (checked 2026-09-30).
- Player-facing copy: no em dashes, plain voice.
- An award with no `extras` must produce a byte-identical spawner file to today's.
- `packages/roster`, the database schema and placement do not change.
- Work on a feature branch (use `keel:start-work`), never on `main`. Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **A grant whose picked gun later leaves the catalogue.** Expected: dropped from the file whole, the same as today (the existing `complete` check runs before expansion). Pinned in Task 3.
- **An `extras` entry that repeats (two mags).** Expected: both objects are written, and the page says "2×", not the label twice. Pinned in Tasks 1, 3 and 4.
- **A catalogue extra with no readable label.** Expected: a failing test, never a raw class name on the page. Pinned in Task 4.
- **A picked gun with no art.** Expected: the tile shows the gun's label with no "+", since "+" reads as empty. Pinned in Task 4.
- **The plate carrier and booster kit awards.** Expected: their spawner output is unchanged. Pinned in Task 3.

---

### Task 1: `extras` on the catalogue item

**Files:**
- Modify: `packages/domain/src/awards.ts` (the `AwardItem` type, line 6, and the item loop in `loadAwards`, lines 49-61)
- Test: `packages/domain/test/awards.test.ts`

**Interfaces:**
- Produces: `export type AwardItem = { className: string; label: string; image?: string; extras?: string[] }`. `loadAwards` keeps `extras` on the returned item unchanged.

- [ ] **Step 1: Write the failing tests**

In `packages/domain/test/awards.test.ts`, add to the `it.each` table in `describe("loadAwards")`:

```ts
    ["extras that is not an array", (j: any) => { j["plate-carrier"].slots.vest.items[0].extras = "Mag_STANAG_30Rnd"; }, /extras/],
    ["an empty extras", (j: any) => { j["plate-carrier"].slots.vest.items[0].extras = []; }, /extras/],
    ["a non-string in extras", (j: any) => { j["plate-carrier"].slots.vest.items[0].extras = [7]; }, /extras/],
    ["an empty string in extras", (j: any) => { j["plate-carrier"].slots.vest.items[0].extras = [""]; }, /extras/],
```

and, in the same `describe`, a new case:

```ts
  it("keeps extras, repeats included, and does not count them as duplicate class names", () => {
    const j = clone();
    j["plate-carrier"].slots.vest.items[0].extras = ["Mag_STANAG_30Rnd", "Mag_STANAG_30Rnd", "PlateCarrierHolster_Black"];
    const item = loadAwards(j)["plate-carrier"]!.slots.vest!.items[0]!;
    expect(item.extras).toEqual(["Mag_STANAG_30Rnd", "Mag_STANAG_30Rnd", "PlateCarrierHolster_Black"]);
  });
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @factions/domain test -- awards`
Expected: the four `throws on extras...` cases FAIL (nothing thrown). The "keeps extras" case may already pass; that is fine.

- [ ] **Step 3: Implement**

In `packages/domain/src/awards.ts`, change the type:

```ts
export type AwardItem = { className: string; label: string; image?: string; extras?: string[] };
```

In `loadAwards`, inside the `for (const item of s.items)` loop, after the `image` check, add:

```ts
        // Class names spawned beside the pick (a gun's mags and parts). Repeats
        // are how a loadout gets two mags, so they are allowed here and never
        // added to `names`. ⚠️ Empty is refused rather than read as "none":
        // leave the field out instead, so there is one way to say it.
        if (item.extras !== undefined
          && (!Array.isArray(item.extras) || item.extras.length === 0
            || !item.extras.every((x: unknown) => typeof x === "string" && x !== ""))) {
          throw new Error(`awards: ${item.className} extras must be a non-empty list of class names`);
        }
```

- [ ] **Step 4: Run to see them pass**

Run: `pnpm --filter @factions/domain test -- awards`
Expected: PASS. Then `pnpm --filter @factions/domain typecheck`: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/awards.ts packages/domain/test/awards.test.ts
git commit -m "feat(awards): an award item can carry extras spawned beside it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The `weapon-kit` catalogue entry

**Files:**
- Modify: `packages/domain/assets/awards.json`
- Modify: `apps/web/test/item-assets.test.ts` (the "there is one per catalogue entry" case)
- Modify: `docs/deploy/2026-09-22-awards.md` (the class-name check, lines 15-22)
- Test: `packages/domain/test/awards.test.ts`

**Interfaces:**
- Consumes: `AwardItem.extras` from Task 1.
- Produces: `awardsCatalogue()["weapon-kit"]` with slot `weapon`; the gun class names `M4A1_Green`, `M16A2`, `AKM`, `AK101_Green`, `AK74_Green`, `FAL`, `SCARH`, `Aug`, `ASVAL`, `SVD`, `M14`, `SV98`. Later tasks use `AKM` as their example pick.

- [ ] **Step 1: Write the failing test**

Append to `packages/domain/test/awards.test.ts`:

```ts
describe("the weapon kit award", () => {
  const kit = awardsCatalogue()["weapon-kit"]!;

  it("is one Weapon slot, 3 days by default", () => {
    expect(kit.label).toBe("Weapon Kit");
    expect(kit.durationDays).toBe(3);
    expect(Object.keys(kit.slots)).toEqual(["weapon"]);
    expect(kit.slots.weapon!.label).toBe("Weapon");
  });

  // ⚠️ The loadouts the owner signed off on one by one (spec §3). A change
  // here is a balance change, so it has to be made on purpose.
  it("has the twelve signed-off loadouts", () => {
    const loadouts = Object.fromEntries(kit.slots.weapon!.items.map((i) => [i.className, i.extras]));
    expect(loadouts).toEqual({
      M4A1_Green: ["M4_OEBttstck", "M4_RISHndgrd_Green", "ACOGOptic_6x", "M4_Suppressor", "Mag_STANAG_60Rnd", "Mag_STANAG_60Rnd"],
      M16A2: ["M4_Suppressor", "Mag_STANAG_60Rnd", "Mag_STANAG_60Rnd"],
      AKM: ["AK_PlasticBttstck", "AK_PlasticHndgrd", "KobraOptic", "Battery9V", "AK_Suppressor", "Mag_AKM_Drum75Rnd", "Mag_AKM_Drum75Rnd"],
      AK101_Green: ["AK_FoldingBttstck_Green", "AK_RailHndgrd_Green", "KobraOptic", "Battery9V", "AK_Suppressor", "Mag_AK101_30Rnd", "Mag_AK101_30Rnd"],
      AK74_Green: ["AK_PlasticBttstck_Green", "AK_RailHndgrd_Green", "KobraOptic", "Battery9V", "AK_Suppressor", "Mag_AK74_45Rnd", "Mag_AK74_45Rnd"],
      FAL: ["Fal_OeBttstck", "ACOGOptic_6x", "Mag_FAL_20Rnd", "Mag_FAL_20Rnd"],
      SCARH: ["SCAR_PrecisionBttstck", "ACOGOptic_6x", "Mag_SCARH_20Rnd", "Mag_SCARH_20Rnd"],
      Aug: ["ACOGOptic_6x", "M4_Suppressor", "Mag_STANAG_60Rnd", "Mag_STANAG_60Rnd"],
      ASVAL: ["ACOGOptic_6x", "Mag_Vikhr_30Rnd", "Mag_Vikhr_30Rnd"],
      SVD: ["PSO6Optic", "Battery9V", "AK_Suppressor", "Mag_SVD_10Rnd", "Mag_SVD_10Rnd"],
      M14: ["MK4Optic_black", "Mag_M14_20Rnd", "Mag_M14_20Rnd"],
      SV98: ["MK4Optic_black", "Mag_SV98_10Rnd", "Mag_SV98_10Rnd"],
    });
  });

  it("has no art yet", () => {
    for (const i of kit.slots.weapon!.items) expect(i.image).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --filter @factions/domain test -- awards`
Expected: FAIL, `awardsCatalogue()["weapon-kit"]` is undefined.

- [ ] **Step 3: Add the catalogue entry**

In `packages/domain/assets/awards.json`, add after `"dead-rooster"` (mind the comma after its closing brace):

```json
  "weapon-kit": {
    "label": "Weapon Kit",
    "durationDays": 3,
    "slots": {
      "weapon": {
        "label": "Weapon",
        "items": [
          { "className": "M4A1_Green", "label": "M4A1 (Green)", "extras": ["M4_OEBttstck", "M4_RISHndgrd_Green", "ACOGOptic_6x", "M4_Suppressor", "Mag_STANAG_60Rnd", "Mag_STANAG_60Rnd"] },
          { "className": "M16A2", "label": "M16A2", "extras": ["M4_Suppressor", "Mag_STANAG_60Rnd", "Mag_STANAG_60Rnd"] },
          { "className": "AKM", "label": "AKM", "extras": ["AK_PlasticBttstck", "AK_PlasticHndgrd", "KobraOptic", "Battery9V", "AK_Suppressor", "Mag_AKM_Drum75Rnd", "Mag_AKM_Drum75Rnd"] },
          { "className": "AK101_Green", "label": "AK101 (Green)", "extras": ["AK_FoldingBttstck_Green", "AK_RailHndgrd_Green", "KobraOptic", "Battery9V", "AK_Suppressor", "Mag_AK101_30Rnd", "Mag_AK101_30Rnd"] },
          { "className": "AK74_Green", "label": "AK74 (Green)", "extras": ["AK_PlasticBttstck_Green", "AK_RailHndgrd_Green", "KobraOptic", "Battery9V", "AK_Suppressor", "Mag_AK74_45Rnd", "Mag_AK74_45Rnd"] },
          { "className": "FAL", "label": "FAL", "extras": ["Fal_OeBttstck", "ACOGOptic_6x", "Mag_FAL_20Rnd", "Mag_FAL_20Rnd"] },
          { "className": "SCARH", "label": "SCAR-H", "extras": ["SCAR_PrecisionBttstck", "ACOGOptic_6x", "Mag_SCARH_20Rnd", "Mag_SCARH_20Rnd"] },
          { "className": "Aug", "label": "AUG", "extras": ["ACOGOptic_6x", "M4_Suppressor", "Mag_STANAG_60Rnd", "Mag_STANAG_60Rnd"] },
          { "className": "ASVAL", "label": "AS VAL", "extras": ["ACOGOptic_6x", "Mag_Vikhr_30Rnd", "Mag_Vikhr_30Rnd"] },
          { "className": "SVD", "label": "SVD", "extras": ["PSO6Optic", "Battery9V", "AK_Suppressor", "Mag_SVD_10Rnd", "Mag_SVD_10Rnd"] },
          { "className": "M14", "label": "M14", "extras": ["MK4Optic_black", "Mag_M14_20Rnd", "Mag_M14_20Rnd"] },
          { "className": "SV98", "label": "SV98", "extras": ["MK4Optic_black", "Mag_SV98_10Rnd", "Mag_SV98_10Rnd"] }
        ]
      }
    }
  }
```

- [ ] **Step 4: Run to see it pass**

Run: `pnpm --filter @factions/domain test -- awards`
Expected: PASS.

- [ ] **Step 5: Fix the item-images count, which the new art-less items break**

Run: `pnpm --filter @factions/web test -- item-assets`
Expected: FAIL on "there is one per catalogue entry" (12 more class names than files).

In `apps/web/test/item-assets.test.ts`, replace that case with:

```ts
  it("there is one per catalogue entry that has art", () => {
    // By class name: the booster-kit award lists the kit's own items, so a
    // file serves both entries. ⚠️ Only entries that set `image`: the weapon
    // kit's guns have no art yet (spec §1), and a tile without art is allowed.
    expect(files).toHaveLength(new Set(entries.filter((e) => e.image).map((e) => e.className)).size);
  });
```

Run: `pnpm --filter @factions/web test -- item-assets item-images`
Expected: PASS.

- [ ] **Step 6: Make the runbook's class-name check cover extras**

In `docs/deploy/2026-09-22-awards.md`, replace the `node -e` one-liner in step 1 so it also prints extras:

```
       for c in $(node -e 'const a=require("./clan-wars/packages/domain/assets/awards.json");for(const d of Object.values(a))for(const s of Object.values(d.slots??{}))for(const i of s.items)for(const c of [i.className,...(i.extras??[])])console.log(c)' | sort -u); do
         grep -q "name=\"$c\"" livonia/db/types.xml || echo "MISSING $c"
       done
```

and add one line under the existing parenthetical: `(Extras since 2026-09-30: a weapon kit gun's parts are checked too.)`

Run the loop from `/Users/steveharmeyer/Development/dayz-clan-wars`. Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add packages/domain/assets/awards.json packages/domain/test/awards.test.ts apps/web/test/item-assets.test.ts docs/deploy/2026-09-22-awards.md
git commit -m "feat(awards): the Weapon Kit award, twelve guns with their parts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The award tick spawns the extras

**Files:**
- Modify: `apps/ingest-worker/src/award-tick.ts:76-80` (the `list` mapping)
- Test: `apps/ingest-worker/test/award-tick.test.ts`

**Interfaces:**
- Consumes: `AwardItem.extras` (Task 1); `awardsCatalogue()["weapon-kit"]` with `AKM` (Task 2).
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

Add inside `describe("awardTick")` in `apps/ingest-worker/test/award-tick.test.ts`:

```ts
  it("spawns a weapon kit as the gun, then each extra in order, repeats included", async () => {
    await seed({ awardKey: "weapon-kit", durationDays: 3, picks: { weapon: "AKM" } });
    const client = fakeUploader();
    await tick(client);
    const objs = objects(client.uploaded[0]!);
    expect(objs.map((o) => o.name)).toEqual([
      "AKM", "AK_PlasticBttstck", "AK_PlasticHndgrd", "KobraOptic", "Battery9V", "AK_Suppressor",
      "Mag_AKM_Drum75Rnd", "Mag_AKM_Drum75Rnd",
    ]);
    for (const o of objs) expect(o).toMatchObject({ pos: [100, 5.25, 200], enableCEPersistency: 0, customString: "Ron" });
  });

  it("drops a weapon kit whose gun left the catalogue, whole, extras and all", async () => {
    const [g] = await seed({ awardKey: "weapon-kit", durationDays: 3, picks: { weapon: "Retired_Gun" } });
    const client = fakeUploader();
    expect(await tick(client)).toMatchObject({ awards: 0, dropped: [g!.id] });
    expect(client.uploaded).toEqual(['{"Objects":[]}']);
  });

  it("writes a plate carrier exactly as before: one object per pick, in slot order", async () => {
    await seed();
    const client = fakeUploader();
    await tick(client);
    expect(objects(client.uploaded[0]!).map((o) => o.name)).toEqual([FULL.vest, FULL.pouches, FULL.holster]);
  });
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @factions/ingest-worker test -- award-tick`
Expected: the first case FAILS (only `["AKM"]` is written). The other two should already pass; they guard the change. If `dropped` or `awards` are named differently in the result than `toMatchObject` assumes, read `AwardTickResult` (top of `award-tick.ts`) and match it.

- [ ] **Step 3: Implement**

In `apps/ingest-worker/src/award-tick.ts`, replace the `items:` line in the `list` mapping:

```ts
    // Each pick spawns with its extras (a gun's parts and mags), gun first.
    // `complete` has already checked every pick is in the catalogue, so the
    // lookups cannot miss. An item with no extras writes exactly one object,
    // so every award before the weapon kit produces the same bytes as before.
    items: Object.entries(AWARDS[r.awardKey]!.slots).flatMap(([slot, s]) => {
      const pick = r.picks[slot]!;
      return [pick, ...(s.items.find((i) => i.className === pick)!.extras ?? [])];
    }),
```

- [ ] **Step 4: Run to see them pass**

Run: `pnpm --filter @factions/ingest-worker test -- award-tick`
Expected: PASS, every case including the existing ones. Then `pnpm --filter @factions/ingest-worker typecheck`.

- [ ] **Step 5: Commit**

```bash
git add apps/ingest-worker/src/award-tick.ts apps/ingest-worker/test/award-tick.test.ts
git commit -m "feat(awards): spawn an award item's extras beside it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: "Comes with" on the award page

**Files:**
- Create: `apps/web/lib/award-parts.ts`
- Modify: `apps/web/app/(site)/awards/[id]/award-flow.tsx` (the tile image branch, lines 135-137, and a new line after the tile grid, after line 142)
- Test: `apps/web/test/award-parts.test.ts` (create), `apps/web/test/award-render.test.tsx`

**Interfaces:**
- Consumes: `AwardItem.extras` (Task 1); `awardsCatalogue()["weapon-kit"]` (Task 2).
- Produces: `export const PART_LABELS: Record<string, string>` and `export function comesWith(extras: string[]): string` in `apps/web/lib/award-parts.ts`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/award-parts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { awardsCatalogue } from "@factions/domain/awards";
import { PART_LABELS, comesWith } from "@/lib/award-parts";

describe("award parts", () => {
  // ⚠️ No fallback to the class name on the page: an unlabelled part fails here.
  it("every extra in the catalogue has a readable label", () => {
    const extras = Object.values(awardsCatalogue())
      .flatMap((a) => Object.values(a.slots).flatMap((s) => s.items.flatMap((i) => i.extras ?? [])));
    expect(extras.filter((c) => !PART_LABELS[c])).toEqual([]);
  });

  it("collapses repeats into a count, in first-seen order", () => {
    expect(comesWith(["KobraOptic", "Battery9V", "Mag_AKM_Drum75Rnd", "Mag_AKM_Drum75Rnd"]))
      .toBe("Kobra sight, 9V battery, 2× 75-round AKM drum");
  });
});
```

Add to `apps/web/test/award-render.test.tsx`, inside `describe("the award page")`:

```ts
  it("says what a picked weapon comes with, and nothing before a pick", () => {
    const kit = awardsCatalogue()["weapon-kit"]!;
    const at = (picks: Record<string, string>) =>
      renderToStaticMarkup(createElement(AwardFlow, { initial: view({ label: "Weapon Kit", durationDays: 3, picks }), def: kit }));
    expect(at({ weapon: "AKM" })).toContain("Comes with: AK plastic buttstock, AK plastic handguard, Kobra sight, 9V battery, AK suppressor, 2× 75-round AKM drum");
    expect(at({})).not.toContain("Comes with");
  });

  it("does not show the empty-slot + on a picked item with no art", () => {
    const kit = awardsCatalogue()["weapon-kit"]!;
    const html = renderToStaticMarkup(createElement(AwardFlow, { initial: view({ picks: { weapon: "AKM" } }), def: kit }));
    expect(html).not.toMatch(/aria-hidden="true">\+</u);
  });
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @factions/web test -- award-parts award-render`
Expected: FAIL, `@/lib/award-parts` does not exist; the render cases fail on the missing text and on the "+".

- [ ] **Step 3: Create `apps/web/lib/award-parts.ts`**

```ts
/**
 * Readable names for the parts an award item spawns with (its `extras`).
 *
 * ⚠️ A test requires an entry for every extra in the award catalogue, so a new
 * loadout part fails CI here rather than showing a class name on the page.
 */
export const PART_LABELS: Record<string, string> = {
  M4_OEBttstck: "M4 OE buttstock",
  M4_RISHndgrd_Green: "M4 RIS handguard (green)",
  ACOGOptic_6x: "6x ACOG",
  M4_Suppressor: "M4 suppressor",
  Mag_STANAG_60Rnd: "60-round STANAG mag",
  AK_PlasticBttstck: "AK plastic buttstock",
  AK_PlasticHndgrd: "AK plastic handguard",
  AK_PlasticBttstck_Green: "AK plastic buttstock (green)",
  AK_FoldingBttstck_Green: "AK folding buttstock (green)",
  AK_RailHndgrd_Green: "AK rail handguard (green)",
  KobraOptic: "Kobra sight",
  PSO6Optic: "PSO-6 scope",
  MK4Optic_black: "Mk4 scope",
  Battery9V: "9V battery",
  AK_Suppressor: "AK suppressor",
  Mag_AKM_Drum75Rnd: "75-round AKM drum",
  Mag_AK101_30Rnd: "30-round AK101 mag",
  Mag_AK74_45Rnd: "45-round AK74 mag",
  Fal_OeBttstck: "FAL OE buttstock",
  Mag_FAL_20Rnd: "20-round FAL mag",
  SCAR_PrecisionBttstck: "SCAR precision buttstock",
  Mag_SCARH_20Rnd: "20-round SCAR mag",
  Mag_Vikhr_30Rnd: "30-round Vikhr mag",
  Mag_SVD_10Rnd: "10-round SVD mag",
  Mag_M14_20Rnd: "20-round M14 mag",
  Mag_SV98_10Rnd: "10-round SV98 mag",
};

/** "Kobra sight, 9V battery, 2× 75-round AKM drum": repeats counted, first-seen order. */
export function comesWith(extras: string[]): string {
  const counts = new Map<string, number>();
  for (const c of extras) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts].map(([c, n]) => `${n > 1 ? `${n}× ` : ""}${PART_LABELS[c] ?? c}`).join(", ");
}
```

- [ ] **Step 4: Change the page**

In `apps/web/app/(site)/awards/[id]/award-flow.tsx`, add the import beside the other `@/lib` imports:

```ts
import { comesWith } from "@/lib/award-parts";
```

Replace the tile's image branch (lines 135-137):

```tsx
                  {e?.image
                    ? <img src={`/${e.image}`} alt="" className="my-1.5 h-[62px] w-full object-contain lg:h-24" />
                    // ⚠️ "+" means empty. A picked item with no art (the weapon
                    // kit's guns) keeps the tile's height but shows no "+".
                    : <span className="my-1.5 flex h-[62px] items-center justify-center text-xl text-rule-3 lg:h-24" aria-hidden="true">{e ? "" : "+"}</span>}
```

Directly after the closing `</div>` of the `grid grid-cols-3` tile grid, add:

```tsx
          {slots.map(([slot]) => {
            const e = entry(slot);
            return e?.extras
              ? <p key={slot} className="mt-3 max-w-[34rem] text-[13px] leading-relaxed text-ink-2">Comes with: {comesWith(e.extras)}</p>
              : null;
          })}
```

- [ ] **Step 5: Run to see them pass**

Run: `pnpm --filter @factions/web test -- award-parts award-render item-assets`
Expected: PASS, the existing award-render cases included. Then `pnpm --filter @factions/web typecheck`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/award-parts.ts apps/web/test/award-parts.test.ts apps/web/test/award-render.test.tsx "apps/web/app/(site)/awards/[id]/award-flow.tsx"
git commit -m "feat(web): say what a weapon kit comes with on the award page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Docs, changelog and the full check

**Files:**
- Modify: `CHANGELOG.md` (under `## [Unreleased]`)
- Modify: `CLAUDE.md` (the "Event awards" row, line 444)

- [ ] **Step 1: Changelog**

Under `## [Unreleased]` in `CHANGELOG.md`:

```markdown
### Added

- A new event award: the Weapon Kit. The winner picks one of twelve guns, and it spawns fully kitted with two full mags. It runs for 3 days by default.
```

- [ ] **Step 2: CLAUDE.md**

In the "Event awards" row, before `Spec \`docs/superpowers/specs/2026-09-22-awards-design.md\``, add:

```
⚠️ A catalogue item may carry `extras` (class names spawned beside the pick, repeats allowed, e.g. a gun's two mags); the pick is still the one class name, and `award-tick.ts` expands it to `[className, ...extras]`. Every extra needs a label in `apps/web/lib/award-parts.ts` (a test enforces it). The `weapon-kit` loadouts were signed off gun by gun: change them on purpose. Spec `docs/superpowers/specs/2026-09-30-weapon-kit-award-design.md`.
```

- [ ] **Step 3: Full check**

Run: `pnpm ci`
Expected: typecheck and every test pass. If worker tests fail on the database, `requireTestDatabaseUrl()` names the env var it needs; fix the setup, don't skip the tests.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md CLAUDE.md
git commit -m "docs(awards): the Weapon Kit award

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Test-server check (with the owner, after deploy)**

This is spec §6's in-game check and cannot be automated. After deploy:
1. `/award grant` lists "Weapon Kit". The bot builds the choices from the catalogue at startup, so a restarted bot is enough.
2. Grant one to a test account, pick the AKM, place it.
3. After the next restart, at the spot: all 8 items are there and each can be picked up from the pile, both drums are full, every part fits the AKM, and the battery powers the Kobra.
