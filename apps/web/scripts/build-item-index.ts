// Builds public/map-data/nasdara/items.json: every types.xml entry, with every way it can
// reach the world on our server. Run by hand after a mission change (or a catalogue, kit or
// KotH change in this repo), then commit the output:
//
//   pnpm --filter @factions/web map:items                  # ../nasdara beside this repo
//   pnpm --filter @factions/web map:items --mission <dir>
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAIMABLE_FLAGS, KIT_SLOTS, KOTH_PRESET_FILES, NEUTRAL_FLAG, WORLD_MAP, armbandFor } from "@factions/domain";
import { boosterCatalogue } from "@factions/domain/catalogue";
import { awardsCatalogue } from "@factions/domain/awards";
import { parseLimits } from "../lib/area-flags";
import { parseGroupPositions } from "../lib/map-world";
import {
  applySources,
  parseAttachedTo,
  parseEventChildren,
  parseEventGroupChildren,
  parseProxyTypes,
  parseSpawnGear,
  parseTypes,
  spawnsAnywhere,
  type ClanWarsSource,
  type ItemsFile,
} from "../lib/item-index";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const argIdx = process.argv.indexOf("--mission");
const mission = resolve(argIdx >= 0 ? process.argv[argIdx + 1]! : join(repoRoot, "../nasdara"));
const out = join(here, `../public/map-data/${WORLD_MAP}/items.json`);

const read = (f: string) => readFileSync(join(mission, f), "utf8");

const limits = parseLimits(read("cfglimitsdefinition.xml"));
const items = parseTypes(read("db/types.xml"), limits);

// Spawn gear: exactly the files cfggameplay.json lists. ⚠️ Not the koth- presets, even though
// they sit in the same folder: the bot adds those to the list only while a KotH session runs
// (koth-converge.ts), so they are "KotH loadout", not everyday fresh-spawn gear.
const gameplay = JSON.parse(read("cfggameplay.json")) as { PlayerData?: { spawnGearPresetFiles?: string[] } };
const gearFiles = gameplay.PlayerData?.spawnGearPresetFiles ?? [];
const spawnGear = new Set(gearFiles.flatMap((f) => parseSpawnGear(read(f))));

const clanWars = new Map<string, ClanWarsSource[]>();
const tagAs = (source: ClanWarsSource, names: Iterable<string>) => {
  for (const n of names) {
    const have = clanWars.get(n) ?? [];
    if (!have.includes(source)) clanWars.set(n, [...have, source]);
  }
};

// Supply kit: the worker's captured template (a static asset; the worker module itself opens a
// database). ⚠️ Its anchor TerritoryFlag is never emitted, and its white flag is swapped for the
// clan's own texture (supplies.ts), so the kit's flags are the 33 claimable ones, never NEUTRAL_FLAG.
const supplyTemplate = JSON.parse(
  readFileSync(join(repoRoot, "apps/ingest-worker/assets/flag-supplies.template.json"), "utf8"),
) as { Objects: { name: string }[] };
tagAs("supply kit", supplyTemplate.Objects.map((o) => o.name).filter((n) => n !== "TerritoryFlag" && n !== NEUTRAL_FLAG));
tagAs("supply kit", CLAIMABLE_FLAGS);

// Booster kit: every catalogue pick with its extras, plus the armband derived from the clan's
// flag (booster-kits.ts).
const kit = boosterCatalogue();
tagAs("booster kit", KIT_SLOTS.flatMap((s) => kit[s].flatMap((e) => [e.className, ...(e.extras ?? [])])));
tagAs("booster kit", CLAIMABLE_FLAGS.map((f) => armbandFor(f)!));

// Awards: each pick spawns with its extras (award-tick.ts).
tagAs(
  "award",
  Object.values(awardsCatalogue()).flatMap((a) =>
    Object.values(a.slots).flatMap((s) => s.items.flatMap((i) => [i.className, ...(i.extras ?? [])])),
  ),
);

// KotH: the 44 preset files the bot swaps in, read from the mission like any other preset.
tagAs("KotH loadout", KOTH_PRESET_FILES.flatMap((f) => parseSpawnGear(read(f))));

// Dispatch proxies only count in buildings that exist: placed by mapgrouppos, or an event's wreck.
// Events place items two ways: their own <children>, and the cfgeventgroups group a spawn
// position names (the convoys' wrecks, whose deloot is the crash and convoy loot).
const events = parseEventChildren(read("db/events.xml"));
for (const [child, names] of parseEventGroupChildren(read("db/events.xml"), read("cfgeventspawns.xml"), read("cfgeventgroups.xml"))) {
  events.set(child, [...new Set([...(events.get(child) ?? []), ...names])]);
}
const placed = new Set([...parseGroupPositions(read("mapgrouppos.xml")).map((g) => g.name), ...events.keys()]);
const proxies = parseProxyTypes(read("mapgroupproto.xml"), placed);

const attachedTo = parseAttachedTo(read("cfgspawnabletypes.xml"), read("cfgrandompresets.xml"));
applySources(items, { attachedTo, spawnGear, clanWars, events, proxies });

const commit = execFileSync("git", ["-C", mission, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const file: ItemsFile = { version: 1, limits, source: { commit, builtAt: new Date().toISOString() }, items };
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(file));

// A Clan Wars source naming a class types.xml lacks is a typo or a removed item; it cannot be
// indexed, so say so rather than let it vanish. Case-insensitive, like applySources.
const known = new Set(items.map((i) => i.className.toLowerCase()));
const unknown = [...clanWars.keys(), ...spawnGear].filter((n) => !known.has(n.toLowerCase()));
if (unknown.length > 0) console.warn("not in types.xml:", [...new Set(unknown)].sort().join(", "));

const count = (f: (i: (typeof items)[number]) => boolean) => items.filter(f).length;
console.log("items", items.length);
console.log("nominal > 0", count((i) => i.nominal > 0));
console.log("deloot", count((i) => i.deloot), "of which nominal > 0", count((i) => i.deloot && i.nominal > 0));
console.log("attachedTo", count((i) => i.attachedTo.length > 0));
console.log("spawnGear", count((i) => i.spawnGear), "from", gearFiles.join(", "));
for (const s of ["supply kit", "booster kit", "award", "KotH loadout"] as const) {
  console.log("clanWars", s, count((i) => i.clanWars.includes(s)));
}
console.log("events", count((i) => i.events.length > 0));
console.log("proxy", count((i) => i.proxy));
const none = items.filter((i) => !spawnsAnywhere(i));
console.log("spawnsAnywhere false", none.length);
console.log(none.map((i) => i.className).sort().join("\n"));
