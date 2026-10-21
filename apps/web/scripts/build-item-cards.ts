// Builds public/map-data/nasdara/item-cards.json: one card per item in items.json (name,
// description, weight, size, what fits it, its picture), read from the game's own configs.
//
// Two steps, because the game is installed on another machine:
//   1. on the PC with DayZ:  bash scripts/item-cards/extract.sh   (copy it over first)
//   2. here:                 pnpm --filter @factions/web map:cards
//                            pnpm --filter @factions/web map:cards --host user@pc
//                            pnpm --filter @factions/web map:cards --from <a local copy of the extract>
// Run after a DayZ update or an items.json rebuild, then commit the output.
// ⚠️ This rewrites every card's `image`, so it drops the community pictures. Re-run
// `pnpm --filter @factions/web map:pictures` afterwards (it warns below when pictures/ exists).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { WORLD_MAP } from "@factions/domain";
import { cardFor, parseConfigClasses, parseStringtable, slotIndex, type ItemCardsFile } from "../lib/item-cards";
import type { ItemsFile } from "../lib/item-index";
import { itemImagePath } from "../src/item-images";

/** The long edge of a game preview, in px. ⚠️ 128 if the images ever pass the 25 MB budget. */
const EDGE = 192;
const BUDGET_BYTES = 25 * 1024 * 1024;

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "../public");
const dataDir = join(pub, "map-data", WORLD_MAP);
const imageDir = join(dataDir, "items");
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

// The extract: a local copy if given, else pulled from the PC with scp.
let src = arg("--from");
if (!src) {
  const host = arg("--host") ?? "rraygun@192.168.1.103";
  const tmp = mkdtempSync(join(tmpdir(), "item-cards-"));
  execFileSync("scp", ["-q", "-r", `${host}:clan-wars-item-cards/out`, tmp], { stdio: "inherit" });
  src = join(tmp, "out");
}

// ⚠️ Vanilla first, the Nasdara map's own PBOs last: a later `class X { … }` extends an
// earlier one, so this is the order in which a map patch wins over the base game.
const files = readdirSync(join(src, "configs")).sort((a, b) => Number(a.includes("_nasdara")) - Number(b.includes("_nasdara")) || a.localeCompare(b));
const all = parseConfigClasses(files.map((f) => readFileSync(join(src!, "configs", f), "utf8")).join("\n"));
const table = new Map<string, string>();
for (const f of readdirSync(src).filter((f) => /^stringtable-.*\.csv$/u.test(f))) {
  for (const [k, v] of parseStringtable(readFileSync(join(src, f), "utf8"))) table.set(k, v);
}
const build = JSON.parse(readFileSync(join(src, "build.json"), "utf8")) as Omit<ItemCardsFile["source"], "builtAt">;

// ⚠️ types.xml and the configs do not always agree on a class name's case
// ("Mag_STANAG_30Rnd" against "mag_stanag_30rnd"); the engine does not care, so neither do we.
// Re-keyed under OUR name, so a card is always named the way items.json names the item.
const lower = new Map([...all].map(([k, v]) => [k.toLowerCase(), v]));
const index = JSON.parse(readFileSync(join(dataDir, "items.json"), "utf8")) as ItemsFile;
const ours = new Map<string, Record<string, unknown>>();
for (const { className } of index.items) {
  const props = lower.get(className.toLowerCase());
  if (props) ours.set(className, props);
}
const slots = slotIndex(ours, ours.keys());

// Game previews, by the class they show: "<class>_preview.png" or "<class>_icon.png".
// None exist in today's build (extract.sh's header says why); kept for a build that adds them.
const previews = new Map<string, string>();
for (const f of existsSync(join(src, "previews")) ? readdirSync(join(src, "previews")) : []) {
  previews.set(f.toLowerCase().replace(/_(preview|icon)[^.]*\.png$/u, ""), join(src, "previews", f));
}

rmSync(imageDir, { recursive: true, force: true });
const counts = { game: 0, wiki: 0, none: 0 };
let bytes = 0;
const cards: ItemCardsFile["cards"] = [];
for (const className of [...ours.keys()].sort()) {
  const card = cardFor(className, ours, table, slots)!;
  const preview = previews.get(className.toLowerCase());
  if (preview) {
    mkdirSync(imageDir, { recursive: true });
    const out = join(imageDir, `${className}.webp`);
    await sharp(preview).resize({ width: EDGE, height: EDGE, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toFile(out);
    bytes += statSync(out).size;
    card.image = `/map-data/${WORLD_MAP}/items/${className}.webp`;
    counts.game++;
  } else if (existsSync(join(pub, itemImagePath(className)))) {
    // The kit picker's wiki thumbnails (src/item-images.ts), already committed.
    bytes += statSync(join(pub, itemImagePath(className))).size;
    card.image = `/${itemImagePath(className)}`;
    counts.wiki++;
  } else counts.none++;
  cards.push(card);
}
if (bytes > BUDGET_BYTES) throw new Error(`item images are ${bytes} bytes, over the ${BUDGET_BYTES} budget: lower EDGE to 128`);

const file: ItemCardsFile = { version: 1, source: { ...build, builtAt: new Date().toISOString() }, cards };
writeFileSync(join(dataDir, "item-cards.json"), `${JSON.stringify(file)}\n`);
const missing = index.items.length - cards.length;
console.log(`${cards.length} cards for ${index.items.length} items (${missing} not in the game files); images: ${counts.game} game, ${counts.wiki} wiki, ${counts.none} none; ${(bytes / 1024 / 1024).toFixed(2)} MB at ${EDGE}px`);
if (existsSync(join(dataDir, "pictures"))) console.log(`⚠️ ${join(dataDir, "pictures")} exists but these cards no longer point at it: run \`map:pictures\` now`);
