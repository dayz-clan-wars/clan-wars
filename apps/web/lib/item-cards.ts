// Item cards: what an item IS (name, description, weight, size, what fits it), read from
// the game's own config files. scripts/item-cards/extract.sh pulls the configs out of the
// DayZ install; scripts/build-item-cards.ts runs them through this file and commits
// public/map-data/<map>/item-cards.json. Nothing here comes from iZurvive or any other site.
//
// Pure apart from loadItemCards, so the parsing is tested on a fixture without the game.
import { WORLD_MAP } from "@factions/domain";

export type ItemCard = {
  className: string;
  displayName: string;
  description: string;
  weightG: number | null;
  size: [number, number] | null;
  attachments: string[]; // class names that fit (resolved from inventorySlot ↔ attachments)
  magazines: string[];
  ammo: string[];
  image: string | null; // "/map-data/nasdara/items/M4A1.webp", or a wiki thumbnail, or none
};

export type ItemCardsFile = {
  version: 1;
  source: { steamBuildId: string; addonsModified: string; hemtt: string; builtAt: string }; // the DayZ build read, and the tool that read it
  cards: ItemCard[];
};

type Value = string | number | Value[];
type Def = { key: string; append: boolean; value: Value };
type Raw = { parent: string | null; defs: Def[] };

/**
 * The config sections an inventory item can live in. ⚠️ CfgAmmo is left out on purpose: its
 * classes are projectiles ("Bullet_556x45"), and the ammo a player holds is a CfgMagazines
 * class ("Ammo_556x45"), so reading CfgAmmo too would only add names that collide.
 */
const ITEM_SECTIONS = ["cfgvehicles", "cfgweapons", "cfgmagazines"];

/** Tokens of derapified config text: punctuation, quoted strings ("" is a quote), and bare words. */
function tokenize(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const end = src.indexOf("*/", i + 2); i = end < 0 ? src.length : end + 2; continue; }
    if (c === '"') {
      let s = "";
      i++;
      while (i < src.length) {
        if (src[i] === '"' && src[i + 1] === '"') { s += '"'; i += 2; continue; }
        if (src[i] === '"') { i++; break; }
        s += src[i++];
      }
      // A leading NUL marks a string token, so "1" stays a string and 1 a number.
      out.push(`\0${s}`);
      continue;
    }
    if (c === "+" && src[i + 1] === "=") { out.push("+="); i += 2; continue; }
    if ("{}[];:=,".includes(c)) { out.push(c); i++; continue; }
    let w = "";
    while (i < src.length && !" \t\n\r{}[];:=,\"".includes(src[i]!)) w += src[i++];
    out.push(w);
  }
  return out;
}

class Reader {
  i = 0;
  constructor(readonly t: string[]) {}
  peek(): string | undefined { return this.t[this.i]; }
  next(): string { const v = this.t[this.i++]; if (v === undefined) throw new Error("config: unexpected end"); return v; }
  expect(v: string) { const got = this.next(); if (got !== v) throw new Error(`config: expected ${v}, got ${got} at token ${this.i}`); }
}

function readValue(r: Reader): Value {
  const t = r.next();
  if (t === "{") {
    const arr: Value[] = [];
    while (r.peek() !== "}") {
      arr.push(readValue(r));
      if (r.peek() === ",") r.next();
    }
    r.next();
    return arr;
  }
  if (t.startsWith("\0")) return t.slice(1);
  const n = Number(t);
  return Number.isFinite(n) && t !== "" ? n : t;
}

/** Skip a class body we do not keep (a nested class, or a section that holds no items). */
function skipBody(r: Reader) {
  r.expect("{");
  let depth = 1;
  while (depth > 0) {
    const t = r.next();
    if (t === "{") depth++;
    else if (t === "}") depth--;
  }
}

/** Skip one `key = value;` or `key[] = {…};` (a section's own setting, not a class). */
function skipStatement(r: Reader) {
  let depth = 0;
  for (;;) {
    const t = r.next();
    if (t === "{") depth++;
    else if (t === "}") depth--;
    else if (t === ";" && depth === 0) return;
  }
}

/** One item class's own lines: assignments kept, nested classes skipped. */
function readItemBody(r: Reader): Def[] {
  const defs: Def[] = [];
  r.expect("{");
  while (r.peek() !== "}") {
    const t = r.next();
    if (t === ";") continue;
    if (t === "class") {
      r.next();
      if (r.peek() === ":") { r.next(); r.next(); }
      if (r.peek() === "{") skipBody(r);
      continue;
    }
    if (t === "delete") { r.next(); continue; }
    if (r.peek() === "[") { r.next(); r.expect("]"); }
    const op = r.next();
    defs.push({ key: t.toLowerCase(), append: op === "+=", value: readValue(r) });
  }
  r.next();
  return defs;
}

/**
 * Every item class in derapified config text, with inheritance resolved: a class's own
 * values over its parent's, all the way up. Property keys come back lower case (the
 * engine reads them case-insensitively, and the game's own files mix "itemSize" and
 * "itemsize"); class names keep their case.
 *
 * Pass every config.cpp at once, concatenated: a later file's `class X { … }` for a class
 * already seen extends it, which is how one PBO patches another's class.
 */
export function parseConfigClasses(cpp: string): Map<string, Record<string, unknown>> {
  const r = new Reader(tokenize(cpp));
  const sections = new Map<string, Map<string, Raw>>(ITEM_SECTIONS.map((s) => [s, new Map()]));
  const names = new Map<string, string>(); // original-case class names by their lower-case key
  while (r.peek() !== undefined) {
    const t = r.next();
    if (t !== "class") continue;
    const name = r.next().toLowerCase();
    if (r.peek() === ":") { r.next(); r.next(); }
    if (r.peek() !== "{") continue; // a forward declaration
    const section = sections.get(name);
    if (!section) { skipBody(r); continue; }
    r.expect("{");
    while (r.peek() !== "}") {
      const k = r.next();
      if (k !== "class") { if (k !== ";") skipStatement(r); continue; }
      const cls = r.next();
      let parent: string | null = null;
      if (r.peek() === ":") { r.next(); parent = r.next(); }
      if (r.peek() !== "{") continue; // `class Rifle_Base;`: defined in another file
      const defs = readItemBody(r);
      // ⚠️ Keyed lower case: one PBO writes "cfgWeapons", a class's patch may spell its name
      // differently, and the engine treats both as the same class.
      const prev = section.get(cls.toLowerCase());
      section.set(cls.toLowerCase(), prev ? { parent: parent ?? prev.parent, defs: [...prev.defs, ...defs] } : { parent, defs });
      names.set(cls.toLowerCase(), names.get(cls.toLowerCase()) ?? cls);
    }
    r.next();
  }

  const out = new Map<string, Record<string, unknown>>();
  for (const section of sections.values()) {
    const done = new Map<string, Record<string, unknown>>();
    const resolve = (key: string, seen: Set<string>): Record<string, unknown> => {
      const hit = done.get(key);
      if (hit) return hit;
      const raw = section.get(key);
      if (!raw) return {};
      if (seen.has(key)) throw new Error(`config: inheritance loop at ${key}`);
      seen.add(key);
      const props: Record<string, unknown> = raw.parent ? { ...resolve(raw.parent.toLowerCase(), seen) } : {};
      for (const d of raw.defs) {
        const before = props[d.key];
        props[d.key] = d.append && Array.isArray(before) && Array.isArray(d.value) ? [...before, ...d.value] : d.value;
      }
      done.set(key, props);
      return props;
    };
    for (const key of section.keys()) {
      const props = resolve(key, new Set());
      const name = names.get(key)!;
      // A name in two sections: keep the public (scope 2) one, the one an item can be.
      const had = out.get(name);
      if (!had || had.scope !== 2) out.set(name, props);
    }
  }
  return out;
}

/** One CSV row per record; quoted fields may hold commas, doubled quotes and newlines. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

/**
 * The game's stringtable.csv as key → English. Keys lower case, as the file writes them.
 * An empty English cell falls back to the "original" column.
 */
export function parseStringtable(csv: string): Map<string, string> {
  const [head, ...rows] = csvRows(csv);
  const cols = (head ?? []).map((h) => h.toLowerCase());
  const en = cols.indexOf("english"), orig = cols.indexOf("original");
  const table = new Map<string, string>();
  for (const r of rows) {
    const text = (en >= 0 ? r[en] : "") || (orig >= 0 ? r[orig] : "") || "";
    if (r[0]) table.set(r[0].toLowerCase(), text);
  }
  return table;
}

/**
 * A config string as a player reads it: "$STR_cfgWeapons_M4A10" → "M4-A1". Plain text passes
 * through; a key the table lacks is "" so a caller can fall back, never "$STR_…" on screen.
 * "$UNT$" is the stringtable's own "not translated yet" mark, never part of the text.
 */
export function resolveString(v: string, table: Map<string, string>): string {
  const text = /^\$str_/iu.test(v) ? table.get(v.slice(1).toLowerCase()) ?? "" : v;
  return text.replace(/^\$UNT\$/u, "").trim();
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" && v ? [v] : []);
const unique = (xs: string[]): string[] => [...new Set(xs)];

/**
 * Slot name (lower case) → the class names, among `names`, that go in it. ⚠️ Lower case
 * because the game spells one slot two ways: the M4 lists "WeaponHandguardM4" and its
 * handguards say "weaponHandguardM4". Pass only the items on our server, so a card never
 * lists an attachment nobody can find.
 */
export function slotIndex(classes: Map<string, Record<string, unknown>>, names: Iterable<string>): Map<string, string[]> {
  const slots = new Map<string, string[]>();
  for (const n of names) {
    for (const s of strings(classes.get(n)?.inventoryslot)) {
      const key = s.toLowerCase();
      slots.set(key, [...(slots.get(key) ?? []), n]);
    }
  }
  return slots;
}

/**
 * One item's card, or null when the game files do not have the class. `image` is left null:
 * the build script picks the picture, since that is a question about files on disk.
 */
export function cardFor(
  cls: string,
  classes: Map<string, Record<string, unknown>>,
  table: Map<string, string>,
  slots: Map<string, string[]>,
): ItemCard | null {
  const c = classes.get(cls);
  if (!c) return null;
  const text = (v: unknown) => (typeof v === "string" ? resolveString(v, table) : "");
  // ⚠️ Only classes we were given: the build passes the items on our server, so a card never
  // names a magazine nobody can find (the AKM's list carries a developer "Mag_AKM_Drum_TEST").
  const known = (names: string[]) => unique(names).filter((n) => classes.has(n));
  const size = Array.isArray(c.itemsize) && c.itemsize.length === 2 && c.itemsize.every((n) => typeof n === "number" && n > 0)
    ? [c.itemsize[0] as number, c.itemsize[1] as number] as [number, number]
    : null;
  const attachments = unique(strings(c.attachments).flatMap((s) => slots.get(s.toLowerCase()) ?? []))
    .filter((n) => n !== cls)
    .sort();
  return {
    className: cls,
    displayName: text(c.displayname) || cls,
    // "..." is the files' own placeholder (the garden plots), not a description.
    description: /^\.*$/u.test(text(c.descriptionshort)) ? "" : text(c.descriptionshort),
    // ⚠️ 0 is "not set" in these files (a base class's placeholder), never a real weight.
    weightG: typeof c.weight === "number" && c.weight > 0 ? c.weight : null,
    size,
    attachments,
    magazines: known(strings(c.magazines)),
    // A gun takes loose rounds through chamberableFrom; a magazine says what fills it in ammoItems.
    ammo: known([...strings(c.chamberablefrom), ...strings(c.ammoitems)]),
    image: null,
  };
}

let cached: Promise<Map<string, ItemCard>> | null = null;

/**
 * Fetched once per page load; a failure is not cached, so a retry can succeed. ⚠️ Optional
 * at runtime: a caller must keep item search and the item panel working when this rejects.
 */
export function loadItemCards(): Promise<Map<string, ItemCard>> {
  cached ??= fetch(`/map-data/${WORLD_MAP}/item-cards.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`item-cards.json ${r.status}`);
      return r.json() as Promise<ItemCardsFile>;
    })
    .then((f) => new Map(f.cards.map((c) => [c.className, c])))
    .catch((e) => {
      cached = null;
      throw e;
    });
  return cached;
}
