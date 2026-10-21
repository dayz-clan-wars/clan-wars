// Where each item can come from on OUR server: the Central Economy's own rules over the
// mission's types.xml, plus every other way an item reaches the world (attachments and
// cargo, fresh-spawn gear, events, fixed building proxies, and Clan Wars' own kits and
// awards). Built by scripts/build-item-index.ts and committed, like world.json.
//
// ⚠️ "Does not spawn on this server" (spawnsAnywhere === false) is the one answer a player
// will act on without checking, so it is only ever given when EVERY source is empty.
// Anything uncertain leans towards "spawns".
import { XMLParser } from "fast-xml-parser";
import { WORLD_MAP } from "@factions/domain";
import type { parseLimits } from "./area-flags";
import { effectiveUsage, type WorldProto } from "./map-world";

type Limits = ReturnType<typeof parseLimits>;

export type ClanWarsSource = "supply kit" | "booster kit" | "award" | "KotH loadout";

export type ItemIndexEntry = {
  className: string;
  nominal: number;
  min: number;
  categories: number; tags: number; usage: number; value: number; // masks over ItemsFile.limits, 0 = none listed
  deloot: boolean; // dynamic-event loot (crash sites and other event wrecks), never a static building
  attachedTo: string[]; // parents in cfgspawnabletypes (attachments or cargo, presets resolved)
  spawnGear: boolean; // in a cfggameplay spawnGearPresetFiles preset
  clanWars: ClanWarsSource[];
  events: string[]; // active db/events.xml events that place it (cars, piles of bricks)
  proxy: boolean; // a fixed <dispatch><proxy> in a placed building's mapgroupproto group
};

export type ItemsFile = {
  version: 1;
  limits: Limits;
  source: { commit: string; builtAt: string };
  items: ItemIndexEntry[];
};

// Same isArray caveat as map-world.ts: it fires for attributes too, so name tags only.
const xml = (...arrays: string[]) =>
  new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", isArray: (name) => arrays.includes(name) });

type Named = { name: string };
type TypeXml = {
  name: string;
  nominal?: number | string;
  min?: number | string;
  flags?: { deloot?: string | number };
  category?: Named[];
  usage?: Named[];
  value?: Named[];
  tag?: Named[];
};

/** db/types.xml, one entry per <type>. Names resolve to bits via `limits`; an unknown name throws. */
export function parseTypes(text: string, limits: Limits): ItemIndexEntry[] {
  const doc = xml("type", "category", "usage", "value", "tag").parse(text) as { types?: { type?: TypeXml[] } };
  // ⚠️ Throw, never skip: the CE silently ignores a name its limits file lacks, and so would
  // we — an item quietly losing its only usage would read as "spawns nowhere here".
  const mask = (list: string[], names: Named[] | undefined, what: string, item: string) =>
    (names ?? []).reduce((m, n) => {
      const i = list.indexOf(n.name);
      if (i < 0) throw new Error(`types.xml: ${item} ${what} "${n.name}" is not in cfglimitsdefinition.xml`);
      return m | (1 << i);
    }, 0);
  return (doc.types?.type ?? []).map((t) => ({
    className: t.name,
    nominal: Number(t.nominal ?? 0),
    min: Number(t.min ?? 0),
    categories: mask(limits.categories, t.category, "category", t.name),
    tags: mask(limits.tags, t.tag, "tag", t.name),
    usage: mask(limits.usage, t.usage, "usage", t.name),
    value: mask(limits.value, t.value, "value", t.name),
    deloot: String(t.flags?.deloot ?? "0") === "1",
    attachedTo: [],
    spawnGear: false,
    clanWars: [],
    events: [],
    proxy: false,
  }));
}

// An <item> may itself carry <cargo>/<attachments> (a gun case holding a rifle and its optic).
type ItemXml = Named & Holder;
type Block = { preset?: string; item?: ItemXml[] };
type Holder = { cargo?: Block[]; attachments?: Block[] };

/**
 * child class → the parents that can carry it, attachments and cargo alike: the
 * cfgspawnabletypes type, or for a nested item, the item it sits inside.
 * ⚠️ `preset="…"` blocks are resolved through cfgrandompresets.xml: on Nasdara most
 * attachments (every battery, every M4 stock) are only ever named there, and skipping the
 * presets would call them "does not spawn". ⚠️ Nested items too: Nasdara's gun cases hold
 * their rifle, optic and mags two levels down, and those are the only source of some optics.
 */
export function parseAttachedTo(spawnable: string, presets: string): Map<string, string[]> {
  const tags = ["type", "cargo", "attachments", "item"];
  const pdoc = xml(...tags).parse(presets) as { randompresets?: { cargo?: (Block & Named)[]; attachments?: (Block & Named)[] } };
  const byPreset = new Map<string, ItemXml[]>();
  for (const p of [...(pdoc.randompresets?.cargo ?? []), ...(pdoc.randompresets?.attachments ?? [])]) {
    byPreset.set(p.name, [...(byPreset.get(p.name) ?? []), ...(p.item ?? [])]);
  }
  const out = new Map<string, Set<string>>();
  const walk = (parent: string, h: Holder): void => {
    for (const block of [...(h.cargo ?? []), ...(h.attachments ?? [])]) {
      if (block.preset !== undefined && !byPreset.has(block.preset)) {
        throw new Error(`cfgspawnabletypes: ${parent} names preset "${block.preset}", which cfgrandompresets.xml does not define`);
      }
      for (const i of [...(block.item ?? []), ...(block.preset ? byPreset.get(block.preset)! : [])]) {
        out.set(i.name, (out.get(i.name) ?? new Set()).add(parent));
        walk(i.name, i);
      }
    }
  };
  const sdoc = xml(...tags).parse(spawnable) as { spawnabletypes?: { type?: (Named & Holder)[] } };
  for (const t of sdoc.spawnabletypes?.type ?? []) walk(t.name, t);
  return new Map([...out].map(([k, v]) => [k, [...v].sort()]));
}

/**
 * Every class a cfggameplay spawn-gear preset can hand out: each `itemType`, and every name in a
 * `simpleChildrenTypes` list, at any depth. `characterTypes` are survivor bodies, not items.
 */
export function parseSpawnGear(text: string): string[] {
  const found = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v !== "object" || v === null) return;
    for (const [k, x] of Object.entries(v)) {
      if (k === "itemType" && typeof x === "string") found.add(x);
      else if (k === "simpleChildrenTypes" && Array.isArray(x)) x.forEach((s) => typeof s === "string" && found.add(s));
      else if (k !== "characterTypes") walk(x);
    }
  };
  walk(JSON.parse(text));
  return [...found];
}

/** child class → names of the ACTIVE db/events.xml events that place it. */
export function parseEventChildren(text: string): Map<string, string[]> {
  const doc = xml("event", "child").parse(text) as {
    events?: { event?: (Named & { active?: number | string; children?: { child?: { type: string }[] } })[] };
  };
  const out = new Map<string, string[]>();
  for (const e of doc.events?.event ?? []) {
    // ⚠️ active 0 is how an operator turns an event off (boats, bears): its children never spawn.
    if (Number(e.active ?? 0) !== 1) continue;
    for (const c of e.children?.child ?? []) out.set(c.type, [...(out.get(c.type) ?? []), e.name]);
  }
  return out;
}

/**
 * child class → ACTIVE events that place it through a cfgeventgroups group: an event's
 * cfgeventspawns <pos group="…"> spawns that whole group (the military convoys' wrecks).
 */
export function parseEventGroupChildren(eventsXml: string, spawnsXml: string, groupsXml: string): Map<string, string[]> {
  const ev = xml("event").parse(eventsXml) as { events?: { event?: (Named & { active?: number | string })[] } };
  const active = new Set((ev.events?.event ?? []).filter((e) => Number(e.active ?? 0) === 1).map((e) => e.name));
  const sp = xml("event", "pos").parse(spawnsXml) as { eventposdef?: { event?: (Named & { pos?: { group?: string }[] })[] } };
  const groupEvents = new Map<string, Set<string>>();
  for (const e of sp.eventposdef?.event ?? []) {
    if (!active.has(e.name)) continue;
    for (const p of e.pos ?? []) if (p.group) groupEvents.set(p.group, (groupEvents.get(p.group) ?? new Set()).add(e.name));
  }
  const gr = xml("group", "child").parse(groupsXml) as { eventgroupdef?: { group?: (Named & { child?: { type: string }[] })[] } };
  const out = new Map<string, Set<string>>();
  for (const g of gr.eventgroupdef?.group ?? []) {
    for (const c of g.child ?? []) for (const e of groupEvents.get(g.name) ?? []) out.set(c.type, (out.get(c.type) ?? new Set()).add(e));
  }
  return new Map([...out].map(([k, v]) => [k, [...v].sort()]));
}

/**
 * Item classes fixed in a building by <dispatch><proxy type>, for groups that are actually placed.
 * ⚠️ Placed-ness is matched case-insensitively: Nasdara's mapgroupproto spells 37 groups with
 * different case from mapgrouppos (Land_Store_Carservice, the refugee tents and more).
 */
export function parseProxyTypes(text: string, placed: Set<string>): Set<string> {
  const doc = xml("group", "dispatch", "proxy").parse(text) as {
    prototype?: { group?: (Named & { dispatch?: { proxy?: { type: string }[] }[] })[] };
  };
  const placedLower = new Set([...placed].map((n) => n.toLowerCase()));
  const out = new Set<string>();
  for (const g of doc.prototype?.group ?? []) {
    if (!placedLower.has(g.name.toLowerCase())) continue;
    for (const d of g.dispatch ?? []) for (const p of d.proxy ?? []) out.add(p.type);
  }
  return out;
}

export type ItemSources = {
  attachedTo: Map<string, string[]>;
  spawnGear: Set<string>;
  clanWars: Map<string, ClanWarsSource[]>;
  events: Map<string, string[]>;
  proxies: Set<string>;
};

/**
 * Fold every non-types.xml source into the entries, in place.
 * ⚠️ By lower-cased name: DayZ class names are case-insensitive, and the KotH presets alone
 * spell MK4Optic_black, Mag_CZ550_10rnd and FAL_OeBttstck differently from types.xml. An exact
 * match would drop those sources and could turn a real item into "does not spawn".
 */
export function applySources(items: ItemIndexEntry[], s: ItemSources): void {
  const fold = <T>(m: Map<string, T[]>) => {
    const out = new Map<string, T[]>();
    for (const [k, v] of m) {
      const key = k.toLowerCase();
      out.set(key, [...new Set([...(out.get(key) ?? []), ...v])]);
    }
    return out;
  };
  const lower = (set: Set<string>) => new Set([...set].map((n) => n.toLowerCase()));
  const [attachedTo, clanWars, events] = [fold(s.attachedTo), fold(s.clanWars), fold(s.events)];
  const [spawnGear, proxies] = [lower(s.spawnGear), lower(s.proxies)];
  for (const i of items) {
    const key = i.className.toLowerCase();
    i.attachedTo = [...(attachedTo.get(key) ?? [])].sort();
    i.spawnGear = spawnGear.has(key);
    i.clanWars = clanWars.get(key) ?? [];
    i.events = events.get(key) ?? [];
    i.proxy = proxies.has(key);
  }
}

/**
 * Can the Central Economy put this item at a loot point of this building?
 *
 * Bohemia publishes no statement of the matching rule: its CE pages
 * (https://community.bistudio.com/wiki/DayZ:Central_Economy_setup_for_custom_terrains,
 * https://community.bistudio.com/wiki/DayZ:Central_Economy_mission_files_modding) describe the
 * files but not how they combine. The sources this follows:
 *  - the dayz plugin's dayz-mapgroups references/cross-file.md §3 ("proto ↔ types.xml: the
 *    four-way match") and rule 6 (the area flags as a second usage router), and its dayz-types
 *    references/keys.md (no <usage> → never building loot; no <value> → any tier);
 *  - https://dayzlooteditor.com/guides/types-xml-explained ("An item without a value tag is not
 *    limited to a tier"; items without usage "may never find a spawn point");
 *  - https://dzconfig.com/wiki/types (deloot: dynamic event loot, not static spawn points).
 *
 * So:
 *  - usage, value, category and tag must ALL fit (not category OR tag);
 *  - a list missing on the item is open on that axis — except usage: an item with no usage is
 *    never building loot (it arrives as cargo, an attachment or an event instead);
 *  - a container that lists no categories (or no tags) is open on that axis. No source states
 *    this; it is inferred from Nasdara's refugee tents, whose "lootweapons" points sit in
 *    containers with neither list and would otherwise hold almost nothing;
 *  - deloot items spawn at dynamic-event wrecks, which are not static buildings.
 */
export function canSpawnAt(item: ItemIndexEntry, proto: WorldProto, areaUsage: number, areaValue: number): boolean {
  if (item.nominal <= 0 || item.deloot) return false;
  // ⚠️ No usage means no building, not every building. On Nasdara that covers twelve items
  // with a nominal (the soda cans, Flashlight, two car wheels…); matching them everywhere
  // would paint every loot building on the map for them.
  if (item.usage === 0 || (effectiveUsage(proto, areaUsage) & item.usage) === 0) return false;
  if (item.value !== 0 && (areaValue & item.value) === 0) return false;
  const fits = (have: number, want: number) => have === 0 || want === 0 || (have & want) !== 0;
  return proto.containers.some((c) => fits(c.categories, item.categories) && fits(c.tags, item.tags));
}

/**
 * false ⇒ "Does not spawn on this server". Any nominal counts (an item with no usage still
 * reaches the world as cargo or through a preset), as does every other source.
 */
export function spawnsAnywhere(item: ItemIndexEntry): boolean {
  return (
    item.nominal > 0 ||
    item.attachedTo.length > 0 ||
    item.spawnGear ||
    item.clanWars.length > 0 ||
    item.events.length > 0 ||
    item.proxy
  );
}

let cached: Promise<ItemIndexEntry[]> | null = null;

/** Fetched once per page load; a failure is not cached, so a retry can succeed. */
export function loadItemIndex(): Promise<ItemIndexEntry[]> {
  cached ??= fetch(`/map-data/${WORLD_MAP}/items.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`items.json ${r.status}`);
      return r.json() as Promise<ItemsFile>;
    })
    .then((f) => f.items)
    .catch((e) => {
      cached = null;
      throw e;
    });
  return cached;
}
