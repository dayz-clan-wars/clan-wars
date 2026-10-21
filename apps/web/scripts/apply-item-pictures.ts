// Puts community-supplied item pictures on the map's item cards: writes resized copies to
// public/map-data/<map>/pictures/<className>.webp and points each card's `image` at them.
//
//   pnpm --filter @factions/web map:pictures                  (reads <repo>/../item_images)
//   pnpm --filter @factions/web map:pictures --from <dir>
//
// ⚠️ Run it AFTER `map:cards`. map:cards rewrites item-cards.json from the game files and
// drops every picture; it prints a warning when a pictures/ folder is still there. (Chosen
// over having map:cards call this step: the pictures folder lives outside the repo and the
// source is unconfirmed, so the build should not depend on it.)
// ⚠️ The pictures came from a Discord user, source unconfirmed. They live in ONE folder,
// pictures/, and nothing else depends on them: delete it and run map:cards to remove them.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { WORLD_MAP } from "@factions/domain";
import type { ItemCardsFile } from "../lib/item-cards";
import { matchPictures } from "../lib/item-pictures";
import { itemImagePath } from "../src/item-images";

const EDGE = 192; // same long edge as map:cards
const BUDGET_BYTES = 25 * 1024 * 1024;

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "../public");
const dataDir = join(pub, "map-data", WORLD_MAP);
const outDir = join(dataDir, "pictures");
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const from = resolve(arg("--from") ?? join(here, "../../../../item_images"));
if (!existsSync(from)) throw new Error(`no pictures folder at ${from}; pass --from <dir>`);

const cardsPath = join(dataDir, "item-cards.json");
const file = JSON.parse(readFileSync(cardsPath, "utf8")) as ItemCardsFile;
const files = readdirSync(from).filter((f) => /\.webp$/iu.test(f));
const matched = matchPictures(files, file.cards);

// ⚠️ Wipe first: a card that lost its picture must not keep a stale file or a stale path.
// The README is rewritten from git, not here, so keep it.
const readme = existsSync(join(outDir, "README.md")) ? readFileSync(join(outDir, "README.md")) : null;
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
if (readme) writeFileSync(join(outDir, "README.md"), readme);

const counts = { supplied: 0, wiki: 0, none: 0 };
let bytes = 0;
const used = new Set<string>();
for (const card of file.cards) {
  const pic = matched.get(card.className);
  if (pic) {
    const out = join(outDir, `${card.className}.webp`);
    await sharp(join(from, pic)).resize({ width: EDGE, height: EDGE, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toFile(out);
    bytes += statSync(out).size;
    card.image = `/map-data/${WORLD_MAP}/pictures/${card.className}.webp`;
    used.add(pic);
    counts.supplied++;
  } else if (existsSync(join(pub, itemImagePath(card.className)))) {
    // Recomputed, not kept: on a re-run `image` may hold last run's picture path.
    card.image = `/${itemImagePath(card.className)}`;
    bytes += statSync(join(pub, itemImagePath(card.className))).size;
    counts.wiki++;
  } else {
    card.image = null;
    counts.none++;
  }
}
if (bytes > BUDGET_BYTES) throw new Error(`item images are ${bytes} bytes, over the ${BUDGET_BYTES} budget: lower EDGE to 128`);

const note = { count: counts.supplied, suppliedBy: "a community member, 2026-10-21", sourceConfirmed: false };
file.source = { ...file.source, pictures: note } as ItemCardsFile["source"];
writeFileSync(cardsPath, `${JSON.stringify(file)}\n`);

const unmatched = files.filter((f) => !used.has(f) && ![...matched.values()].includes(f));
console.log(`${file.cards.length} cards; pictures: ${counts.supplied} supplied, ${counts.wiki} keep a wiki image, ${counts.none} none`);
console.log(`${unmatched.length} of ${files.length} files unmatched${unmatched.length ? `, e.g. ${unmatched.slice(0, 8).join("; ")}` : ""}`);
console.log(`${(bytes / 1024 / 1024).toFixed(2)} MB at ${EDGE}px`);
