# Booster Kit Item Art Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every booster kit item a thumbnail, show them in a carousel picker, move the way in to `/kit` off the nav, and prompt a booster who has not chosen a kit.

**Architecture:** The 200 images are already committed to `apps/web/public/items/` (192px webp, one per class name). The catalogue gains an optional `image` field pointing at them, 27 wrong labels are corrected, and `loadCatalogue` grows a duplicate-label guard. The picker becomes a client component per slot. The prompt rides the existing `clan_notices` DM path, emitted once by `boosterTick` and deduped by a new nullable column.

**Tech Stack:** TypeScript, Next.js App Router (`apps/web`), drizzle-orm over postgres.js, discord.js, vitest.

**Spec:** `docs/superpowers/specs/2026-09-19-booster-kit-item-images-design.md`

## Global Constraints

- **Image path format is `items/<className>.webp`**, relative to `public/`. Never absolute, never with a leading slash in the catalogue.
- **192px** square webp. Matches what is already committed; `apps/web/test/item-assets.test.ts` (Task 2) pins it.
- **Class names are never changed.** All 200 exist in `livonia/db/types.xml`. Only display labels move.
- **`apps/web` may never reference an identifier containing "faction"** — `apps/web/test/copy-vocabulary.test.ts` bans the substring in web source, identifiers included.
- **Player-facing copy carries no em dashes**, uses plain voice, and never discourages raiding.
- **Every package `apps/web` transpiles uses extensionless relative imports** in its `src/` — that is `roster`, `db`, `domain`, `declarations`, `verification`, `copy`.
- **Lock order (spec §4.12):** `booster_kits` and `booster_kit_challenges` sit outside it; `clan_notices` is always last.
- **The full gate:** `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`, expecting **30/30 tasks**. A cached pass proves nothing — check the count.
- **Every PR adds an entry under `## [Unreleased]` in `CHANGELOG.md`, committed.** Task 9.

---

### Task 1: Catalogue gains `image`, 27 labels corrected, duplicate labels refused

**Files:**
- Modify: `packages/domain/src/booster-kit.ts` (the `CatalogueEntry` type and `loadCatalogue`)
- Modify: `packages/domain/assets/booster-catalogue.json` (labels + image fields)
- Test: `packages/domain/test/booster-kit.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CatalogueEntry` = `{ className: string; label: string; image?: string }`. `loadCatalogue(json: unknown): Catalogue` unchanged in signature, stricter in behaviour.

- [ ] **Step 1: Write the failing tests**

Add to `packages/domain/test/booster-kit.test.ts`:

```ts
it("accepts an entry carrying a well-formed image path", () => {
  const withImage = { ...GOOD, mask: [{ className: "GasMask", label: "Gas Mask", image: "items/GasMask.webp" }] };
  expect(loadCatalogue(withImage).mask[0]!.image).toBe("items/GasMask.webp");
});

it("accepts an entry with no image at all", () => {
  expect(loadCatalogue(GOOD).mask[0]!.image).toBeUndefined();
});

it("throws on an image that is not a string", () => {
  const bad = { ...GOOD, mask: [{ className: "GasMask", label: "Gas Mask", image: 7 }] };
  expect(() => loadCatalogue(bad)).toThrow(/GasMask/);
});

it("throws on an image path that does not match its class name", () => {
  const bad = { ...GOOD, mask: [{ className: "GasMask", label: "Gas Mask", image: "items/Other.webp" }] };
  expect(() => loadCatalogue(bad)).toThrow(/GasMask/);
});

// ⚠️ The guard this closes: "Balaclava (White)" was the label of BOTH
// Balaclava3Holes_White and BalaclavaMask_White in production. Unique class
// names, identical text, and a booster cannot tell the options apart.
it("throws on a duplicate label within a slot", () => {
  const dup = { ...GOOD, mask: [
    { className: "GasMask", label: "Gas Mask" },
    { className: "OtherMask", label: "Gas Mask" },
  ] };
  expect(() => loadCatalogue(dup)).toThrow(/Gas Mask/);
});

it("the committed catalogue has no duplicate label in any slot", () => {
  const c = loadCatalogue(catalogue);
  for (const slot of KIT_SLOTS) {
    const labels = c[slot].map((e) => e.label);
    expect(new Set(labels).size, slot).toBe(labels.length);
  }
});

it("every committed entry carries an image", () => {
  const c = loadCatalogue(catalogue);
  const missing = KIT_SLOTS.flatMap((s) => c[s].filter((e) => !e.image).map((e) => e.className));
  expect(missing).toEqual([]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/domain && npx vitest run test/booster-kit.test.ts`
Expected: FAIL — the image assertions fail because the field is neither typed nor validated, and the duplicate-label test fails because nothing checks labels.

- [ ] **Step 3: Widen the type and the validator**

In `packages/domain/src/booster-kit.ts`, replace the `CatalogueEntry` type and the loop body of `loadCatalogue`:

```ts
export type CatalogueEntry = { className: string; label: string; image?: string };
```

Inside `loadCatalogue`, replace the per-slot loop with:

```ts
    const seen = new Set<string>();
    const seenLabels = new Set<string>();
    for (const e of list as CatalogueEntry[]) {
      if (typeof e?.className !== "string" || typeof e?.label !== "string") {
        throw new Error(`booster catalogue: slot ${slot} has an entry without className and label`);
      }
      if (seen.has(e.className)) throw new Error(`booster catalogue: slot ${slot} lists ${e.className} twice`);
      seen.add(e.className);
      // ⚠️ A duplicate LABEL is the same failure as a duplicate class name —
      // two options a player cannot tell apart — and it is the one that
      // actually shipped: "Balaclava (White)" was on both Balaclava3Holes_White
      // and BalaclavaMask_White. Unique class names hid it completely.
      if (seenLabels.has(e.label)) throw new Error(`booster catalogue: slot ${slot} lists the label ${e.label} twice`);
      seenLabels.add(e.label);
      if (e.image !== undefined) {
        // ⚠️ Named after OUR class name, checked here rather than trusted: the
        // path is what the picker renders and what item-assets.test.ts pins
        // against public/items/, so a typo becomes a broken tile, not an error.
        if (typeof e.image !== "string" || e.image !== `items/${e.className}.webp`) {
          throw new Error(`booster catalogue: ${e.className} has image ${String(e.image)}, expected items/${e.className}.webp`);
        }
      }
    }
```

- [ ] **Step 4: Apply the 27 label corrections and add every image field**

Run this once, from the repo root. It reads the checked list committed beside the spec:

```bash
python3 - <<'PY'
import json
cat_path = "packages/domain/assets/booster-catalogue.json"
fixes = {f["className"]: f["new"] for f in json.load(open("docs/superpowers/specs/2026-09-19-booster-kit-label-fixes.json"))}
names = {r["className"]: r["proposed"] for r in json.load(open("docs/superpowers/specs/2026-09-19-booster-kit-names.json"))}
cat = json.load(open(cat_path))
changed = 0
for slot, items in cat.items():
    for e in items:
        cn = e["className"]
        new = fixes.get(cn) or names.get(cn)
        if new and new != e["label"]:
            e["label"] = new; changed += 1
        e["image"] = f"items/{cn}.webp"
json.dump(cat, open(cat_path, "w"), indent=2, ensure_ascii=False)
open(cat_path, "a").write("\n")
print("labels changed:", changed)
PY
```

Expected: `labels changed: 27`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/domain && npx vitest run test/booster-kit.test.ts`
Expected: PASS, all cases.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/booster-kit.ts packages/domain/assets/booster-catalogue.json packages/domain/test/booster-kit.test.ts
git commit -m "feat(domain): catalogue carries an image, and refuses duplicate labels

27 labels named the wrong item: BalaclavaMask_* is the Ski Mask, CombatBoots_*
is the Hunter Boots, TortillaBag is the Combat Backpack. Verified against each
wiki page's classname field and the 2020 class list independently.

\"Balaclava (White)\" was the label of two different mask entries, which a
booster cannot tell apart. loadCatalogue guarded duplicate class names and not
duplicate labels; it now guards both."
```

---

### Task 2: The catalogue and `public/items/` are held together by a test

**Files:**
- Create: `apps/web/test/item-assets.test.ts`

**Interfaces:**
- Consumes: `boosterCatalogue()` from `@factions/domain/catalogue`, `KIT_SLOTS` from `@factions/domain`.
- Produces: nothing.

- [ ] **Step 1: Write the test**

Create `apps/web/test/item-assets.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { KIT_SLOTS } from "@factions/domain";
import { boosterCatalogue } from "@factions/domain/catalogue";

// ⚠️ Must match EDGE in apps/web/scripts/fetch-item-images.ts — two statements
// of one fact, held together only by this test.
const EDGE = 192;

const ITEMS_DIR = join(import.meta.dirname, "..", "public", "items");

/**
 * ⚠️ The catalogue's `image` paths and the contents of public/items/ are two
 * statements of one fact, and the compiler cannot see the second. Same
 * reasoning as flag-assets.test.ts, and the same silent failure: drift shows
 * up as a blank tile in the picker, not a stack trace.
 *
 * This also closes the class of gap PLAN-3-INBOX item 41 describes, where an
 * asset absent from the built image was invisible until production.
 */
describe("item images match the catalogue", () => {
  const files = readdirSync(ITEMS_DIR).filter((f) => f.endsWith(".webp"));
  const entries = KIT_SLOTS.flatMap((s) => boosterCatalogue()[s]);

  it("every catalogue image resolves to a file", () => {
    const missing = entries
      .filter((e) => e.image && !files.includes(`${e.className}.webp`))
      .map((e) => e.className);
    expect(missing).toEqual([]);
  });

  it("every file belongs to a catalogue entry", () => {
    const known = new Set(entries.map((e) => e.className));
    const orphans = files.filter((f) => !known.has(f.replace(/\.webp$/u, "")));
    expect(orphans).toEqual([]);
  });

  it("there is one per catalogue entry", () => {
    expect(files).toHaveLength(entries.length);
  });

  it("⚠️ every image was actually normalised, not committed raw", () => {
    // The byte ceiling alone cannot catch a skipped resize when the wiki's
    // source is already small, so dimensions are checked too. Committing raw
    // downloads would add tens of MB and nothing else would complain.
    for (const f of files) {
      const bytes = statSync(join(ITEMS_DIR, f)).size;
      expect(bytes, `${f} is ${bytes} bytes`).toBeLessThan(60_000);
      expect(bytes, `${f} is suspiciously small`).toBeGreaterThan(0);
    }
  });

  it("⚠️ every image is a square of exactly EDGE", async () => {
    for (const f of files) {
      const { width, height } = await sharp(join(ITEMS_DIR, f)).metadata();
      expect(width ?? 0, `${f} width`).toBe(EDGE);
      expect(height ?? 0, `${f} height`).toBe(EDGE);
    }
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd apps/web && npx vitest run test/item-assets.test.ts`
Expected: PASS — the 200 images are already committed and the catalogue now names them.

- [ ] **Step 3: Commit**

```bash
git add apps/web/test/item-assets.test.ts
git commit -m "test(web): hold the catalogue and public/items/ together

Drift is silent: a missing asset is a blank tile in the picker, not an error.
Same shape as flag-assets.test.ts, and the same reason."
```

---

### Task 3: `item-images.ts` and the two hand-run scripts

**Files:**
- Create: `apps/web/src/item-images.ts`
- Create: `apps/web/scripts/fetch-item-images.ts`
- Test: `apps/web/test/item-images.test.ts`

**Interfaces:**
- Consumes: the catalogue.
- Produces: `WIKI_FILENAME: Readonly<Record<string, { file: string; wiki: "wiki.gg" | "fandom" }>>`, `wikiFileFor(className: string): { file: string; wiki: string } | undefined`, `itemImagePath(className: string): string`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/item-images.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { KIT_SLOTS } from "@factions/domain";
import { boosterCatalogue } from "@factions/domain/catalogue";
import { WIKI_FILENAME, wikiFileFor, itemImagePath } from "../src/item-images";

describe("itemImagePath", () => {
  it("is named after our class name, never the wiki's", () => {
    expect(itemImagePath("BalaclavaMask_White")).toBe("items/BalaclavaMask_White.webp");
  });
});

describe("wikiFileFor", () => {
  // ⚠️ Deliberately different from flag-images.ts's wikiFilenameFor, which
  // THROWS on a miss. For a flag, a miss means the pool and the table have
  // diverged, which is a bug. For an item, "no art yet" is a legitimate state
  // the picker renders as a placeholder, so throwing would turn an expected
  // gap into an outage.
  it("returns undefined for an unmapped class rather than throwing", () => {
    expect(wikiFileFor("NoSuchItem")).toBeUndefined();
  });

  it("knows where the Ski Mask art came from", () => {
    expect(wikiFileFor("BalaclavaMask_White")?.file).toBe("BalaclavaWhite.png");
  });
});

describe("the mapping table", () => {
  it("covers every catalogue entry that has an image", () => {
    const entries = KIT_SLOTS.flatMap((s) => boosterCatalogue()[s]);
    const missing = entries.filter((e) => e.image && !WIKI_FILENAME[e.className]).map((e) => e.className);
    expect(missing).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run test/item-images.test.ts`
Expected: FAIL — `Cannot find module '../src/item-images'`.

- [ ] **Step 3: Generate the module from the reviewed mapping**

Run from the repo root:

```bash
python3 - <<'PY'
import json
art = json.load(open("/private/tmp/claude-501/-Users-steveharmeyer-Development-dayz-clan-wars/5d39b3c0-4aa4-458c-8363-b3199af084ae/scratchpad/final-art.json"))
rows = []
for cn in sorted(art):
    v = art[cn]
    f = v.get("file") or v.get("url") or ""
    wiki = v.get("wiki") or ("supplied" if v.get("url") else "local")
    rows.append(f'  {cn}: {{ file: {json.dumps(f)}, wiki: {json.dumps(wiki)} }},')
body = "\n".join(rows)
src = '''/**
 * Where each item's committed thumbnail came from.
 *
 * ⚠️ The wikis name files after the in-game DISPLAY name, often adjective
 * first, so essentially nothing maps by rule from a class name:
 *   HunterPants_Autumn  -> AutumnHunterPants.png
 *   AliceBag_Black      -> ALICE Backpack Black.png
 *   HuntingBag_Hannah   -> HannahsBackpack.png
 * This table is the complete, explicit answer, the same shape and for the same
 * reason as flag-images.ts's WIKI_FILENAME. Every entry was reviewed by hand.
 *
 * ⚠️ `wiki: "supplied"` means a URL given by hand because both wikis were
 * wrong; `wiki: "local"` means the image was trimmed out of a photo and has no
 * wiki source to re-fetch. Neither can be refreshed by the fetch script
 * without a human.
 */
export const WIKI_FILENAME: Readonly<Record<string, { file: string; wiki: string }>> = {
%s
};

/**
 * What the wiki calls this item's image, or undefined when we have no source.
 *
 * ⚠️ Returns undefined rather than throwing, UNLIKE flag-images.ts. For a flag
 * a miss is a bug; for an item "no art yet" is a legitimate state the picker
 * renders as a placeholder tile.
 */
export function wikiFileFor(className: string): { file: string; wiki: string } | undefined {
  return WIKI_FILENAME[className];
}

/**
 * Where we serve it, relative to `public/`.
 *
 * ⚠️ Named after OUR class name, never the wiki's, so the wikis' naming stops
 * here at fetch time rather than travelling into the picker or the bot. Same
 * discipline as flagImagePath.
 */
export function itemImagePath(className: string): string {
  return `items/${className}.webp`;
}
''' % body
open("apps/web/src/item-images.ts", "w").write(src)
print("entries:", len(rows))
PY
```

Expected: `entries: 200`

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run test/item-images.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the fetch script**

Create `apps/web/scripts/fetch-item-images.ts`:

```ts
/**
 * Re-fetch the committed item thumbnails from the DayZ community wikis,
 * normalise them, and write them into public/items/.
 *
 * ⚠️ Run BY HAND, never at build or deploy time — the same reasoning as
 * fetch-flags.ts: a build that reaches a third-party wiki fails when that wiki
 * blocks it, and its output can change with nothing in this repository
 * changing.
 *
 * ⚠️ This script REFRESHES what src/item-images.ts already names. It does not
 * discover anything: which file belongs to which class was decided by a human
 * review, because the wikis name files after display names and nothing maps by
 * rule (see that module's own warning).
 *
 *   pnpm --filter @factions/web exec tsx scripts/fetch-item-images.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { KIT_SLOTS } from "@factions/domain";
import { boosterCatalogue } from "@factions/domain/catalogue";
import { wikiFileFor, itemImagePath } from "../src/item-images.js";

const API: Record<string, string> = {
  "wiki.gg": "https://dayz.wiki.gg/api.php",
  fandom: "https://dayz.fandom.com/api.php",
};
const PUBLIC = join(import.meta.dirname, "..", "public");

/** Tiles render near 96px; 192 covers a 2x display with nothing wasted. */
const EDGE = 192;

/** The wikis' CDNs reject requests without a UA. */
const HEADERS = { "User-Agent": "clan-wars-item-fetch/1.0 (private DayZ community server)" };

/**
 * ⚠️ The CDN drops the connection after roughly two dozen sequential downloads
 * from one process — a footnote at 33 flags, a certainty at 200 items. Without
 * this the script dies partway with no obvious cause.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 5, delayMs = 500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

async function imageUrl(api: string, file: string): Promise<string> {
  const url = `${api}?action=query&titles=${encodeURIComponent(`File:${file}`)}&prop=imageinfo&iiprop=url&format=json`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`imageinfo ${file}: HTTP ${res.status}`);
  const body = await res.json() as { query?: { pages?: Record<string, { imageinfo?: { url: string }[] }> } };
  const direct = Object.values(body.query?.pages ?? {})[0]?.imageinfo?.[0]?.url;
  // ⚠️ A missing page comes back as a page with no imageinfo rather than an
  // error, so an unchecked read here writes a zero-byte file and the only
  // symptom is one blank tile.
  if (!direct) throw new Error(`no imageinfo for File:${file} — has the wiki renamed it?`);
  return direct;
}

async function main(): Promise<void> {
  await mkdir(join(PUBLIC, "items"), { recursive: true });
  const entries = KIT_SLOTS.flatMap((s) => boosterCatalogue()[s]);
  let written = 0;
  const skipped: string[] = [];

  for (const entry of entries) {
    const source = wikiFileFor(entry.className);
    if (!source) { skipped.push(`${entry.className} (no source)`); continue; }
    // ⚠️ A supplied URL or a hand-trimmed image has no wiki file to re-fetch.
    // Overwriting it from a guess would silently undo a human decision.
    if (source.wiki === "supplied" || source.wiki === "local") {
      skipped.push(`${entry.className} (${source.wiki}, committed by hand)`);
      continue;
    }
    const api = API[source.wiki];
    if (!api) throw new Error(`${entry.className}: unknown wiki ${source.wiki}`);
    const src = await withRetry(() => imageUrl(api, source.file));
    const raw = await withRetry(async () => {
      const res = await fetch(src, { headers: HEADERS });
      if (!res.ok) throw new Error(`download ${source.file}: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    });
    const resized = await sharp(raw)
      .resize({ width: EDGE, height: EDGE, fit: "inside", withoutEnlargement: true })
      .toBuffer();
    const meta = await sharp(resized).metadata();
    // Square-pad so every tile sits on the same baseline in the grid.
    const out = await sharp({
      create: { width: EDGE, height: EDGE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{
        input: resized,
        left: Math.round((EDGE - (meta.width ?? EDGE)) / 2),
        top: Math.round((EDGE - (meta.height ?? EDGE)) / 2),
      }])
      .webp({ quality: 82 })
      .toBuffer();

    const dest = join(PUBLIC, itemImagePath(entry.className));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, out);
    written++;
    console.log(`${entry.className.padEnd(28)} <- ${source.file.padEnd(34)} ${raw.length} -> ${out.length} bytes`);
  }

  console.log(`\nwrote ${written} item image(s) to public/items/`);
  for (const s of skipped) console.log(`  skipped ${s}`);
}

await main();
```

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/item-images.ts apps/web/scripts/fetch-item-images.ts apps/web/test/item-images.test.ts
git commit -m "feat(web): the item image mapping table and its hand-run fetch script

The wikis name files after display names, adjective first, so nothing maps by
rule from a class name. The table is the explicit answer, same shape as
flag-images.ts. Unlike that module a miss returns undefined rather than
throwing: for an item, no art yet is a legitimate state."
```

---

### Task 4: `ItemCarousel`, the picker component

**Files:**
- Create: `apps/web/app/(site)/kit/item-carousel.tsx`
- Modify: `apps/web/vitest.config.ts` (the `test.include` glob)
- Test: `apps/web/test/item-carousel.test.tsx`

**Interfaces:**
- Consumes: `CatalogueEntry` from `@factions/domain`.
- Produces: `<ItemCarousel slot={KitSlot} options={CatalogueEntry[]} current={string | null} />`, rendering one radio input per option with `name="className"`, plus an empty option whose value is `""`.

- [ ] **Step 0: Let vitest see `.tsx` tests at all**

⚠️ `apps/web/vitest.config.ts` currently includes only `test/**/*.test.ts`.
A `.tsx` test file is not picked up, does not run, and reports nothing — the
task would look complete with a test that never executed. Widen it:

```ts
  test: { include: ["test/**/*.test.ts", "test/**/*.test.tsx"] },
```

The config already sets `esbuild: { jsx: "automatic" }` for exactly this kind
of test, so nothing else is needed; this is the one line that was missing.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/item-carousel.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ItemCarousel } from "../app/(site)/kit/item-carousel";

const OPTIONS = [
  { className: "GasMask", label: "Gas Mask", image: "items/GasMask.webp" },
  { className: "NoArt", label: "No Art Yet" },
];

describe("ItemCarousel", () => {
  it("renders one radio per option, plus the empty one", () => {
    const html = renderToStaticMarkup(<ItemCarousel slot="mask" options={OPTIONS} current={null} />);
    expect(html.match(/type="radio"/gu) ?? []).toHaveLength(3);
    expect(html).toContain('value="GasMask"');
    expect(html).toContain('value=""');
  });

  it("submits under the name the server action reads", () => {
    const html = renderToStaticMarkup(<ItemCarousel slot="mask" options={OPTIONS} current={null} />);
    expect(html).toContain('name="className"');
  });

  it("marks the saved pick as checked", () => {
    const html = renderToStaticMarkup(<ItemCarousel slot="mask" options={OPTIONS} current="GasMask" />);
    const tile = html.slice(html.indexOf('value="GasMask"'));
    expect(tile.slice(0, 200)).toContain("checked");
  });

  it("checks the empty option when nothing is saved", () => {
    const html = renderToStaticMarkup(<ItemCarousel slot="mask" options={OPTIONS} current={null} />);
    const empty = html.slice(html.indexOf('value=""'));
    expect(empty.slice(0, 200)).toContain("checked");
  });

  // ⚠️ Coverage gaps are expected and must look deliberate, not broken.
  it("renders an item with no image as a labelled tile, still selectable", () => {
    const html = renderToStaticMarkup(<ItemCarousel slot="mask" options={OPTIONS} current={null} />);
    expect(html).toContain('value="NoArt"');
    expect(html).toContain("No Art Yet");
  });

  it("is a radiogroup, so arrow keys move between tiles", () => {
    const html = renderToStaticMarkup(<ItemCarousel slot="mask" options={OPTIONS} current={null} />);
    expect(html).toContain('role="radiogroup"');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run test/item-carousel.test.tsx`
Expected: FAIL — `Cannot find module '../app/(site)/kit/item-carousel'`.

- [ ] **Step 3: Write the component**

Create `apps/web/app/(site)/kit/item-carousel.tsx`:

```tsx
import type { CatalogueEntry, KitSlot } from "@factions/domain";

/**
 * One slot's options as a horizontally scrolling strip of image tiles.
 *
 * ⚠️ Radio inputs, not buttons, and no client JavaScript: the form still posts
 * `className` exactly as the <select> it replaces did, so the slot save works
 * with JS off — the same bar every other write on this site clears. Native
 * overflow scroll plus CSS scroll-snap does the carousel; no library.
 *
 * ⚠️ `role="radiogroup"` plus real radios is what gives arrow-key movement for
 * free. Styling them as tiles must not cost that: the input stays in the DOM,
 * visually hidden, never `display: none`.
 */
export function ItemCarousel({ slot, options, current }: {
  slot: KitSlot;
  options: readonly CatalogueEntry[];
  current: string | null;
}) {
  return (
    <div
      role="radiogroup"
      aria-labelledby={`slot-${slot}-label`}
      className="-mx-4 flex snap-x snap-mandatory gap-2 overflow-x-auto px-4 pb-2 lg:-mx-5 lg:px-5"
    >
      <Tile slot={slot} value="" label="Nothing" image={undefined} checked={current === null || current === ""} />
      {options.map((o) => (
        <Tile
          key={o.className}
          slot={slot}
          value={o.className}
          label={o.label}
          image={o.image}
          checked={current === o.className}
        />
      ))}
    </div>
  );
}

function Tile({ slot, value, label, image, checked }: {
  slot: KitSlot;
  value: string;
  label: string;
  image: string | undefined;
  checked: boolean;
}) {
  const id = `slot-${slot}-${value || "none"}`;
  return (
    <label
      htmlFor={id}
      className="group flex w-24 flex-none snap-start cursor-pointer flex-col items-center gap-1 rounded-sm border border-rule-2 p-2 text-center has-[:checked]:border-ink has-[:checked]:bg-paper-2 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2"
    >
      <input
        type="radio"
        id={id}
        name="className"
        value={value}
        defaultChecked={checked}
        className="sr-only"
      />
      {image ? (
        <img src={`/${image}`} alt="" width={64} height={64} className="h-16 w-16 flex-none object-contain" />
      ) : (
        <span className="flex h-16 w-16 flex-none items-center justify-center rounded-sm border border-dashed border-rule-2 text-[10px] uppercase tracking-wide text-ink-2">
          {value ? "No art" : "None"}
        </span>
      )}
      <span className="text-xs leading-tight text-ink-2 group-has-[:checked]:text-ink">{label}</span>
    </label>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run test/item-carousel.test.tsx`
Expected: PASS, all six.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(site)/kit/item-carousel.tsx" apps/web/test/item-carousel.test.tsx
git commit -m "feat(web): ItemCarousel, a scroll-snap strip of item tiles

Radio inputs in a radiogroup, so the form posts className exactly as the select
did and the slot save still works with JavaScript off."
```

---

### Task 5: Wire the carousel into `/kit`

**Files:**
- Modify: `apps/web/app/(site)/kit/page.tsx:45-59` (the `SlotPicker` function)
- Test: `apps/web/test/kit.test.ts`

**Interfaces:**
- Consumes: `ItemCarousel` from Task 4.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/test/kit.test.ts`:

```ts
it("renders the picker as image tiles, not a select", async () => {
  const mod = await import("../app/(site)/kit/page");
  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../app/(site)/kit/page.tsx", import.meta.url), "utf8"));
  expect(src).not.toContain("<select");
  expect(src).toContain("ItemCarousel");
  expect(mod).toBeDefined();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run test/kit.test.ts`
Expected: FAIL — the page still contains `<select`.

- [ ] **Step 3: Replace the select**

In `apps/web/app/(site)/kit/page.tsx`, add the import at the top beside the others:

```ts
import { ItemCarousel } from "./item-carousel";
```

Then replace the whole body of `SlotPicker` with:

```tsx
function SlotPicker({ slot, current }: { slot: KitSlot; current: string | null }) {
  const options = boosterCatalogue()[slot];
  return (
    <form action={saveKit} className="flex flex-col gap-2 border-t border-rule-2 px-4 py-4 first:border-t-0 lg:px-5">
      <input type="hidden" name="slot" value={slot} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className={fieldLabel} id={`slot-${slot}-label`}>{SLOT_LABELS[slot]}</span>
        <button type="submit" className={btnSecondary}>Save</button>
      </div>
      <ItemCarousel slot={slot} options={options} current={current} />
    </form>
  );
}
```

⚠️ The `<label htmlFor>` becomes a `<span id>`: a radiogroup is labelled by `aria-labelledby`, and a `<label>` pointing at a group rather than a single control is wrong.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run test/kit.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the attribution line**

In the same file, inside the "The nine pieces" `Panel`, directly after the `KIT_SLOTS.map(...)` block's closing `</div>`, add:

```tsx
<p className="border-t border-rule-2 px-4 py-3 text-xs text-ink-2 lg:px-5">
  Item pictures come from the DayZ community wikis, used under CC BY-SA until we make our own.
</p>
```

⚠️ Player-facing copy: plain voice, no em dashes.

- [ ] **Step 6: Run the web suite**

Run: `cd apps/web && npx vitest run`
Expected: PASS, including `copy-vocabulary.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add "apps/web/app/(site)/kit/page.tsx" apps/web/test/kit.test.ts
git commit -m "feat(web): the kit picker shows the items

Nine selects become nine carousels. The form shape is unchanged, so the slot
save and its no-JavaScript path are untouched."
```

---

### Task 6: Kit leaves the nav, and appears on the owner's player page

**Files:**
- Modify: `apps/web/lib/menu.ts:31-36` (`MINE`) and `:47-53` (`MINE_LONG`)
- Modify: `apps/web/app/components/owner.tsx:32-42` (`loadOwner`, and the `Owner` type above it)
- Test: `apps/web/test/menu.test.ts`, `apps/web/test/owner-kit.test.ts`

**Interfaces:**
- Consumes: `isOwnPage` from `apps/web/lib/own-page.ts`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/test/menu.test.ts`:

```ts
it("⚠️ Kit is in neither nav list", () => {
  // It means nothing to anyone who is not boosting, and the bar is already
  // full at 1024px (see the `quiet` flag's own comment in menu.ts). The way
  // in is the owner's player page instead.
  for (const signedIn of [true, false]) {
    const all = [...menuFor(signedIn).flat(), ...barFor(signedIn).flat()];
    expect(all.filter((i) => i.href === "/kit")).toEqual([]);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run test/menu.test.ts`
Expected: FAIL — `/kit` is still in `MINE` and `MINE_LONG`.

- [ ] **Step 3: Remove both entries**

In `apps/web/lib/menu.ts`, delete from `MINE`:

```ts
  // ⚠️ `quiet`, like the guide: the bar is full at 1024px (see the flag on
  // MenuItem), and a fourth cell here pushes Sign out off the edge. It is a
  // full item in the drawer, which is where a phone reaches it.
  { label: "Kit", href: "/kit", quiet: true },
```

and from `MINE_LONG`:

```ts
  { label: "Booster kit", href: "/kit" },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run test/menu.test.ts`
Expected: PASS.

- [ ] **Step 5: Teach `loadOwner` whether the viewer is boosting**

`loadOwner` is in `apps/web/app/components/owner.tsx`, not the player page —
the page calls it at line 73. The roster already answers this: `boosterKit`
returns a `BoosterKitView` whose `boosting` comes from `discord_boosters`.

⚠️ `boosterKit` takes the discord id ALONE — the roster wrapper supplies the
clock itself (`api.ts:280`). Passing a second argument is a typecheck failure.

Add the import beside the other roster imports in `owner.tsx`:

```ts
import { boosterKit } from "@factions/roster";
```

Add `boosting` to the `Owner` type, then widen the `Promise.all` and the
return:

```ts
  const [invites, requests, claim, linkState, kit] = await Promise.all([
    myInvites(session.sub), myRequests(session.sub), claimContext(session.sub),
    viewer.link ? null : linkStatus(session.sub),
    boosterKit(session.sub),
  ]);
```

```ts
  return { session, viewer, invites, requests, claim, next, showInvites, boosting: kit.boosting };
```

- [ ] **Step 6: Render the entry point, for a boosting owner only**

In `apps/web/app/components/owner.tsx`, inside `OwnerPanels`, add:

```tsx
{owner.boosting && (
  <Panel num="06" title="Booster kit">
    <PanelBody>
      <p className="text-sm leading-relaxed text-ink-2">
        Thanks for boosting. Pick the ten pieces you respawn with, and the spot they wait at.
      </p>
      <a href="/kit" className={link}>Open your kit</a>
    </PanelBody>
  </Panel>
)}
```

⚠️ Gated on `owner.boosting`, not merely on ownership: an entry point to a page
that will turn a non-booster away is worse than no entry point.

⚠️ Renumber the panel if `06` is taken — the numbers are positional in this
component, not identifiers.

⚠️ Player-facing copy: plain voice, no em dashes.

- [ ] **Step 7: Write the gating test**

Create `apps/web/test/owner-kit.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ⚠️ The entry point must be gated on BOOSTING, not merely on owning the page.
 * /kit turns a non-booster away, and a link that leads somewhere that refuses
 * you is worse than no link. Asserted against the source because rendering
 * OwnerPanels needs a session and a database.
 */
describe("the kit entry point", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "app", "components", "owner.tsx"), "utf8");

  it("is gated on owner.boosting", () => {
    expect(src).toContain("owner.boosting");
  });

  it("links to /kit", () => {
    expect(src).toContain('href="/kit"');
  });

  it("loadOwner reads boosting from the roster, not from a guess", () => {
    expect(src).toContain("boosterKit(");
    expect(src).toContain("boosting: kit.boosting");
  });
});
```

- [ ] **Step 8: Run the web suite**

Run: `cd apps/web && npx vitest run`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/lib/menu.ts apps/web/test/menu.test.ts apps/web/test/owner-kit.test.ts apps/web/app/components/owner.tsx
git commit -m "feat(web): reach the kit from your own page, not the nav

A nav cell meaningless to everyone who is not boosting is the wrong thing to
spend a full bar's width on. \"You\" forwards to the player page, so the entry
point lives in its owner block, shown only to a booster."
```

---

### Task 7: `discord_boosters.kit_prompted_at`

**Files:**
- Modify: `packages/db/src/schema.ts:1258-1262`
- Create: `packages/db/migrations/0044_<generated>.sql`
- Test: `packages/db/test/booster-kits.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `discordBoosters.kitPromptedAt` — `timestamp with time zone`, nullable.

- [ ] **Step 1: Add the column to the schema**

In `packages/db/src/schema.ts`, replace the `discordBoosters` table with:

```ts
export const discordBoosters = pgTable("discord_boosters", {
  discordId: text("discord_id").primaryKey(),
  premiumSince: timestamp("premium_since", { withTimezone: true }).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  /**
   * When we prompted this booster to choose a kit, or null if we have not.
   *
   * ⚠️ The ONLY thing stopping the prompt going out on every tick. "A booster
   * with no kit" stays true until they choose one, and boosterTick is
   * level-triggered by design, so without this the bot DMs every kitless
   * booster every run, forever.
   *
   * ⚠️ On this table rather than in one of its own so that it is deleted with
   * the row when someone stops boosting. Boosting again later is a new
   * relationship and earns a new prompt, which is correct — they may never
   * have seen the first one.
   */
  kitPromptedAt: timestamp("kit_prompted_at", { withTimezone: true }),
});
```

- [ ] **Step 2: Generate the migration**

Run: `cd packages/db && npx drizzle-kit generate`
Expected: a new `0044_*.sql` plus its `meta/0044_snapshot.json`.

- [ ] **Step 3: Read the generated SQL**

Run: `cat packages/db/migrations/0044_*.sql`
Expected, and nothing else:

```sql
ALTER TABLE "discord_boosters" ADD COLUMN "kit_prompted_at" timestamp with time zone;
```

⚠️ A nullable column with no default needs no backfill and does not require stopping the bot. If the generated SQL says anything more than this, stop and read it before going further.

- [ ] **Step 4: Write the test**

Add to `packages/db/test/booster-kits.test.ts`:

```ts
it("a booster starts unprompted", async () => {
  await db.insert(discordBoosters).values({
    discordId: "1", premiumSince: new Date(), observedAt: new Date(),
  });
  const [row] = await db.select().from(discordBoosters).where(eq(discordBoosters.discordId, "1"));
  expect(row!.kitPromptedAt).toBeNull();
});
```

- [ ] **Step 5: Run it**

Run: `cd packages/db && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/booster-kits.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations packages/db/test/booster-kits.test.ts
git commit -m "feat(db): discord_boosters.kit_prompted_at

The only thing stopping the kit prompt DMing every kitless booster on every
tick. On this table so it is deleted when someone stops boosting."
```

---

### Task 8: The prompt — notice kind, renderer, link button, and the tick that emits it

**Files:**
- Modify: `packages/domain/src/feed.ts:25-35` (`CLAN_NOTICE_KINDS`)
- Modify: `apps/bot/src/notice-text.ts` (a renderer for the new kind)
- Modify: `apps/bot/src/notice-tick.ts:10` (`NoticeSender` gains components)
- Modify: `apps/bot/src/discord.ts:505-539` (`createNoticeSender` sends them)
- Modify: `apps/bot/src/booster-tick.ts`
- Modify: `apps/web/lib/notice-copy.ts` (the web renderer — a SECOND renderer, see CLAUDE.md)
- Test: `apps/bot/test/booster-tick.test.ts`, `apps/bot/test/notice-tick.test.ts`

**Interfaces:**
- Consumes: `appendClanNoticeTx` from `@factions/roster/internal`, `discordBoosters.kitPromptedAt` from Task 7.
- Produces: `boosterTick(db, { source, now, serverId, kitUrl })` — two new required deps. `BoosterTickResult` gains `prompted: number`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/bot/test/booster-tick.test.ts`. ⚠️ The file's existing `beforeEach`
truncates `discord_boosters` only, and imports neither of the tables these
assertions read, so widen both first:

```ts
// at the top, beside the existing imports
import { createClient, runMigrations, requireTestDatabaseUrl, discordBoosters,
         boosterKits, clanNotices, type Database } from "@factions/db";
import { eq, sql } from "drizzle-orm";

const now = at("2026-09-19T00:00:00Z");
let serverId: number;

// in beforeEach, replacing the existing truncate
// ⚠️ clan_notices.server_id is NOT NULL and references servers.id, so the
// prompt assertions need a real server row. Without one every one of them
// fails on a foreign key violation, which reads as broken behaviour rather
// than broken setup. Same seeding shape as apps/bot/test/ban-announce-tick.test.ts.
await db.execute(sql`truncate table servers, discord_boosters, booster_kits, clan_notices restart identity cascade`);
const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
serverId = s!.id;
```

⚠️ Add `servers` to the `@factions/db` import, and use `serverId` — not the
literal `1` — in every `boosterTick` call below.

```ts
it("prompts a booster who has never chosen a kit", async () => {
  const res = await boosterTick(db, { source: source([{ discordId: "a", premiumSince: new Date() }]), now, serverId, kitUrl: "https://example.test/kit" });
  expect(res.prompted).toBe(1);
  const [n] = await db.select().from(clanNotices).where(eq(clanNotices.kind, "booster_kit_unchosen"));
  expect(n!.discordTargetId).toBe("a");
  expect(n!.target).toBe("dm");
});

it("does not prompt a booster who already has a kit", async () => {
  await db.insert(boosterKits).values({ discordId: "a", serverId: 1 });
  const res = await boosterTick(db, { source: source([{ discordId: "a", premiumSince: new Date() }]), now, serverId, kitUrl: "https://example.test/kit" });
  expect(res.prompted).toBe(0);
});

// ⚠️ The failure this guards: the condition stays true until they choose, and
// the tick is level-triggered, so without the column every run re-DMs them.
it("does not prompt the same booster twice across two runs", async () => {
  const source = source([{ discordId: "a", premiumSince: new Date() }]);
  await boosterTick(db, { source, now, serverId, kitUrl: "https://example.test/kit" });
  const second = await boosterTick(db, { source, now, serverId, kitUrl: "https://example.test/kit" });
  expect(second.prompted).toBe(0);
  const rows = await db.select().from(clanNotices).where(eq(clanNotices.kind, "booster_kit_unchosen"));
  expect(rows).toHaveLength(1);
});

it("prompts again after someone stops boosting and starts again", async () => {
  await boosterTick(db, { source: source([{ discordId: "a", premiumSince: new Date() }]), now, serverId, kitUrl: "https://example.test/kit" });
  await boosterTick(db, { source: source([]), now, serverId, kitUrl: "https://example.test/kit" });
  const back = await boosterTick(db, { source: source([{ discordId: "a", premiumSince: new Date() }]), now, serverId, kitUrl: "https://example.test/kit" });
  expect(back.prompted).toBe(1);
});

// ⚠️ The tick's existing warning about a Discord outage resolving to an empty
// member list applies here one step worse: a prompt cannot be unsent.
it("emits nothing when the booster fetch throws", async () => {
  await expect(boosterTick(db, { source: failingSource, now, serverId, kitUrl: "https://example.test/kit" })).rejects.toThrow(/gateway down/u);
  const rows = await db.select().from(clanNotices).where(eq(clanNotices.kind, "booster_kit_unchosen"));
  expect(rows).toEqual([]);
});
```

Add to `apps/bot/test/notice-tick.test.ts` — ⚠️ NOT notice-text.test.ts.
`noticeMessage` is exported from `src/notice-tick.ts` and takes three
arguments, the third being the site base url:

```ts
it("renders the booster kit prompt with a link button and no custom_id", () => {
  const msg = noticeMessage({
    kind: "booster_kit_unchosen", target: "dm", occurredAt: new Date(),
    payload: { kitUrl: "https://example.test/kit" },
  }, new Date(), "https://example.test");
  expect(msg.content).toMatch(/kit/iu);
  expect(msg.components?.[0]?.components?.[0]).toMatchObject({ style: 5, url: "https://example.test/kit" });
  // ⚠️ A URL button carries no custom_id and must never be routed. A style: 2
  // button here would need an interaction handler and add state to the bot.
  expect(JSON.stringify(msg.components)).not.toContain("custom_id");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/booster-tick.test.ts test/notice-tick.test.ts`
Expected: FAIL — `booster_kit_unchosen` is not a kind, and `boosterTick` takes no `serverId`.

- [ ] **Step 3: Register the kind**

In `packages/domain/src/feed.ts`, add `"booster_kit_unchosen"` to the end of `CLAN_NOTICE_KINDS`:

```ts
  "zone_warning", "ban_applied", "booster_kit_unchosen",
```

- [ ] **Step 4: Add the renderer and the button**

In `apps/bot/src/notice-text.ts`, add to `RENDERERS`:

```ts
  booster_kit_unchosen: () =>
    "Thanks for boosting. You have a kit waiting: ten pieces of clothing that respawn "
    + "at a spot you pick, every restart, for as long as you keep boosting. Nothing is "
    + "chosen yet, so nothing will spawn.",
```

⚠️ Player-facing copy: plain voice, no em dashes, and it does not discourage anything.

Then add the button builder beside it. ⚠️ `noticeMessage` in `notice-tick.ts`
is what the tick actually calls, so the components have to reach the message
there — adding them only to the sender would never populate `msg.components`:

```ts
/**
 * The components a notice carries, or undefined for the many that carry none.
 *
 * ⚠️ A URL button (style 5) on purpose: it needs no interaction handler, so it
 * adds no state to the bot and nothing has to route it. A style 2 button would
 * need a custom_id and a handler for a message whose only job is a link.
 */
export function noticeComponents(n: { kind: ClanNoticeKind; payload: NoticePayload }):
  { type: 1; components: { type: 2; style: 5; label: string; url: string }[] }[] | undefined {
  if (n.kind !== "booster_kit_unchosen") return undefined;
  const url = n.payload.kitUrl;
  if (typeof url !== "string" || !url) return undefined;
  return [{ type: 1, components: [{ type: 2, style: 5, label: "Choose your kit", url }] }];
}
```

- [ ] **Step 5: Let the sender carry them**

In `apps/bot/src/notice-tick.ts`, widen `NoticeMessage` and have
`noticeMessage` attach the components:

```ts
export type NoticeMessage = { content: string; embeds?: APIEmbed[]; mentionRoleId?: string; components?: unknown[] };
```

In `noticeMessage`, in the non-achievement branch, replace the return with:

```ts
    const components = noticeComponents(row);
    const base = roleId === null ? { content: line } : { content: `<@&${roleId}> ${line}`, mentionRoleId: roleId };
    return components ? { ...base, components } : base;
```

and import it: `import { noticeText, noticeComponents } from "./notice-text.js";`

Then widen the sender type:

```ts
export type NoticeSender = (target: NoticeTarget, discordTargetId: string, content: string, embeds?: APIEmbed[], mentionRoleId?: string, components?: unknown[]) => Promise<void>;
```

and pass them at the call site (line 87):

```ts
      await send(row.target, target, msg.content, msg.embeds, msg.mentionRoleId, msg.components);
```

In `apps/bot/src/discord.ts`, in `createNoticeSender`, widen the signature and the message:

```ts
  return async (target, discordTargetId, content, embeds, mentionRoleId, components) => {
```

```ts
    const message = {
      ...(content ? { content } : {}),
      ...(embeds?.length ? { embeds } : {}),
      ...(components?.length ? { components } : {}),
      ...(mentionRoleId ? { allowedMentions: { parse: ["users" as const], roles: [mentionRoleId] } } : {}),
    };
```

- [ ] **Step 6: Emit from the tick**

In `apps/bot/src/booster-tick.ts`, widen the result and the deps, and add the emit AFTER the existing writes and deletes:

```ts
export type BoosterTickResult = { boosters: number; added: number; removed: number; prompted: number };
```

```ts
export async function boosterTick(db: Database, deps: {
  source: BoosterSource;
  now: Date;
  serverId: number;
  kitUrl: string;
}): Promise<BoosterTickResult> {
```

Then, immediately before the `return`:

```ts
  // ⚠️ AFTER the writes and deletes above, never before. The tick's own
  // warning about a Discord outage resolving to an empty member list applies
  // here one step worse: a kit projection can be recomputed next run, a DM
  // cannot be unsent.
  //
  // ⚠️ The kit_prompted_at check is the whole defence against re-prompting.
  // "Boosting with no kit" stays true until they choose, and this tick is
  // level-triggered, so without it every run DMs every kitless booster again.
  const unprompted = await db.select({ discordId: discordBoosters.discordId })
    .from(discordBoosters)
    .where(and(
      isNull(discordBoosters.kitPromptedAt),
      notExists(db.select({ one: sql`1` }).from(boosterKits)
        .where(eq(boosterKits.discordId, discordBoosters.discordId))),
    ));

  let prompted = 0;
  for (const b of unprompted) {
    await db.transaction(async (tx) => {
      await tx.update(discordBoosters)
        .set({ kitPromptedAt: deps.now })
        .where(eq(discordBoosters.discordId, b.discordId));
      await appendClanNoticeTx(tx, {
        serverId: deps.serverId,
        factionId: null,
        target: "dm",
        discordTargetId: b.discordId,
        kind: "booster_kit_unchosen",
        occurredAt: deps.now,
        payload: { kitUrl: deps.kitUrl },
      });
    });
    prompted++;
  }

  return {
    boosters: current.length,
    added: current.filter((b) => !had.has(b.discordId)).length,
    removed,
    prompted,
  };
```

Add the imports this needs at the top of the file:

```ts
import { discordBoosters, boosterKits, type Database } from "@factions/db";
import { and, eq, isNull, notExists, notInArray, sql } from "drizzle-orm";
import { appendClanNoticeTx } from "@factions/roster/internal";
```

- [ ] **Step 7: Add the web renderer**

In `apps/web/lib/notice-copy.ts`, add the matching entry. ⚠️ CLAUDE.md: this is a SECOND renderer beside the bot's, the kind list is pinned but the wording is not, so read both when changing either.

```ts
  booster_kit_unchosen: () => "You have a booster kit waiting. Nothing is chosen yet.",
```

- [ ] **Step 8: Pass the new deps at the call site**

In `apps/bot/src/discord.ts`, find the `boosterTick(` call and give it the two new deps:

```ts
      await boosterTick(db, {
        source: guildBoosterSource(guild),
        now: new Date(),
        serverId: cfg.serverId,
        kitUrl: `${cfg.webBaseUrl.replace(/\/$/u, "")}/kit`,
      });
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd apps/bot && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run`
Expected: PASS, including `parity.test.ts` and `command-registration.test.ts`.

- [ ] **Step 10: Commit**

```bash
git add packages/domain/src/feed.ts apps/bot/src apps/bot/test apps/web/lib/notice-copy.ts
git commit -m "feat(bot): prompt a booster who has not chosen a kit

One clan_notices DM row, so the bell, /notifications and the Discord DM all
come from one write. The button is a URL button (style 5): no custom_id, no
interaction handler, no new state in the bot.

Emitted after the tick's writes and deletes, and only for a booster whose
kit_prompted_at is null, because a DM cannot be unsent."
```

---

### Task 9: Changelog, and the full gate

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the Unreleased entry**

Under `## [Unreleased]` in `CHANGELOG.md`:

```markdown
### Added
- Booster kits show what you are choosing. Every item in the picker now has a
  picture, and each slot is a strip of tiles instead of a dropdown.
- A booster who has not chosen a kit gets one Discord message about it, with a
  button that opens the picker.

### Changed
- The kit is reached from your own player page instead of the top menu.
- 27 items were named wrong in the picker and are corrected. The Ski Masks were
  labelled Balaclavas, the Hunter Boots were labelled Combat Boots, and the
  Combat Backpack was labelled an Assault Backpack.

### Fixed
- Two different masks were both labelled "Balaclava (White)", so they could not
  be told apart.
```

⚠️ Player-facing copy: plain voice, no em dashes.

- [ ] **Step 2: Run the full gate**

Run:

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx turbo run typecheck test --concurrency=1 --force
```

Expected: **30/30 tasks succeeded.** ⚠️ Check the count, not the exit code — a cached pass proves nothing, which is why `--force` is there.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): booster kit item art, picker and prompt"
```

- [ ] **Step 4: Open the PR**

Use `keel:finish-work`. The branch is `feature/booster-kit-item-art`, base `main` (trunk topology).

---

## Notes for the executor

**What is already done and must not be redone:**
- The 200 images are committed at `apps/web/public/items/`. Do not re-fetch them; `fetch-item-images.ts` exists for a future refresh, not for this work.
- The name mapping and the 27 label corrections were reviewed by a human against two independent sources. `2026-09-19-booster-kit-label-fixes.json` and `2026-09-19-booster-kit-names.json` are that review's output — apply them, do not re-derive them.

**The one image that is not vouched for:** `TortillaBag_Desert` was trimmed out of a video thumbnail whose own caption calls it a retexture, because neither wiki documents that variant. If it looks wrong in the picker, replacing it is a data change, not a code change.

**Deferred deliberately:** our own item renders. Everything here is a placeholder with attribution.
