import { beforeAll, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORLD_MAP } from "@factions/domain";
import { awardsCatalogue } from "@factions/domain/awards";
import { parseLimits } from "../lib/area-flags";
import type { WorldProto } from "../lib/map-world";
import {
  applySources,
  canSpawnAt,
  parseAttachedTo,
  parseEventChildren,
  parseEventGroupChildren,
  parseProxyTypes,
  parseSpawnGear,
  parseTypes,
  spawnsAnywhere,
  type ItemIndexEntry,
  type ItemsFile,
} from "../lib/item-index";

const fx = (name: string) => readFileSync(join(__dirname, "fixtures/items", name), "utf8");
const limits = parseLimits(readFileSync(join(__dirname, "fixtures/mission/cfglimitsdefinition.xml"), "utf8"));
const bit = (list: string[], ...names: string[]) => names.reduce((m, n) => m | (1 << list.indexOf(n)), 0);
const noSources = { attachedTo: new Map(), spawnGear: new Set<string>(), clanWars: new Map(), events: new Map(), proxies: new Set<string>() };

describe("parseTypes", () => {
  const items = parseTypes(fx("types.xml"), limits);
  const by = (n: string) => items.find((i) => i.className === n)!;

  it("reads M4A1's numbers and masks", () => {
    expect(by("M4A1")).toMatchObject({
      className: "M4A1",
      nominal: 4,
      min: 3,
      categories: bit(limits.categories, "weapons"),
      tags: 0,
      usage: bit(limits.usage, "ContaminatedArea"),
      value: bit(limits.value, "Unique"),
      deloot: false,
      attachedTo: [],
      spawnGear: false,
      clanWars: [],
    });
  });

  it("reads deloot=\"1\" as deloot: true", () => {
    expect(by("GhillieSuit_Desert").deloot).toBe(true);
    expect(by("TunaCan").deloot).toBe(false);
  });

  it("refuses a name the limits file does not define", () => {
    const bad = `<types><type name="X"><nominal>1</nominal><min>0</min><flags deloot="0"/><usage name="Nope"/></type></types>`;
    expect(() => parseTypes(bad, limits)).toThrow(/Nope/);
  });
});

describe("other sources", () => {
  it("records the parent of a cfgspawnabletypes attachment, including through a cfgrandompresets preset", () => {
    const att = parseAttachedTo(fx("cfgspawnabletypes.xml"), fx("cfgrandompresets.xml"));
    expect(att.get("M4_Suppressor")).toEqual(["M4A1"]);
    expect(att.get("Battery9V")).toEqual(["M4A1", "OffroadHatchback"]);
    // Cargo counts too, inline or by preset.
    expect(att.get("TunaCan")).toEqual(["AssaultBag_Ttsko", "OffroadHatchback"]);
  });

  it("records an item nested inside another item under that item", () => {
    const att = parseAttachedTo(fx("cfgspawnabletypes.xml"), fx("cfgrandompresets.xml"));
    expect(att.get("GunCase_White")).toEqual(["WoodenCrate"]);
    expect(att.get("M4A1")).toEqual(["GunCase_White"]);
  });

  it("collects every item type in a spawn gear preset, nested children included, and not the character types", () => {
    expect(parseSpawnGear(fx("spawn-gear.json")).sort()).toEqual(["Battery9V", "Flashlight", "PakolHat_Beige"]);
  });

  it("reads children of active events only", () => {
    const ev = parseEventChildren(fx("events.xml"));
    expect(ev.get("OffroadHatchback")).toEqual(["VehicleOffroadHatchback"]);
    expect(ev.has("Boat_01_Black")).toBe(false);
  });

  it("reads children of cfgeventgroups groups that an active event spawns", () => {
    const spawns = `<eventposdef>
      <event name="VehicleOffroadHatchback"><pos x="1" z="2" a="0" group="Convoy"/></event>
      <event name="VehicleBoat"><pos x="1" z="2" a="0" group="Dock"/></event>
    </eventposdef>`;
    const groups = `<eventgroupdef>
      <group name="Convoy"><child type="StaticObj_Wreck_M1A2_DE" deloot="1" x="0" z="0" a="0"/></group>
      <group name="Dock"><child type="Land_Boat_Small9_DE" x="0" z="0" a="0"/></group>
    </eventgroupdef>`;
    const m = parseEventGroupChildren(fx("events.xml"), spawns, groups);
    expect(m.get("StaticObj_Wreck_M1A2_DE")).toEqual(["VehicleOffroadHatchback"]);
    expect(m.has("Land_Boat_Small9_DE")).toBe(false);
  });

  it("reads dispatch proxy types from placed groups only", () => {
    const xml = `<prototype>
      <group name="Placed"><dispatch><proxy type="AKM" pos="0 0 0"/></dispatch></group>
      <group name="NotPlaced"><dispatch><proxy type="M67Grenade" pos="0 0 0"/></dispatch></group>
    </prototype>`;
    expect([...parseProxyTypes(xml, new Set(["Placed"]))]).toEqual(["AKM"]);
    expect([...parseProxyTypes(xml, new Set(["PLACED"]))]).toEqual(["AKM"]);
  });
});

describe("applySources and spawnsAnywhere", () => {
  const items = parseTypes(fx("types.xml"), limits);
  applySources(items, {
    attachedTo: parseAttachedTo(fx("cfgspawnabletypes.xml"), fx("cfgrandompresets.xml")),
    spawnGear: new Set(parseSpawnGear(fx("spawn-gear.json"))),
    clanWars: new Map([["Orphan_Award", ["award"]]]),
    events: parseEventChildren(fx("events.xml")),
    proxies: new Set<string>(),
  });
  const by = (n: string) => items.find((i) => i.className === n)!;

  it("gives an M4A1 attachment attachedTo [\"M4A1\"] and counts it as spawning", () => {
    expect(by("M4_Suppressor").attachedTo).toEqual(["M4A1"]);
    expect(spawnsAnywhere(by("M4_Suppressor"))).toBe(true);
  });

  it("marks spawn gear and event children", () => {
    expect(by("PakolHat_Beige").spawnGear).toBe(true);
    expect(spawnsAnywhere(by("PakolHat_Beige"))).toBe(true);
    expect(by("OffroadHatchback").events).toEqual(["VehicleOffroadHatchback"]);
    expect(spawnsAnywhere(by("OffroadHatchback"))).toBe(true);
  });

  it("⚠️ Review Focus 3: a nominal-0 item a Clan Wars award hands out spawns, and says so", () => {
    const award: ItemIndexEntry = { ...by("Orphan_Item"), className: "Orphan_Award" };
    applySources([award], { ...noSources, clanWars: new Map([["Orphan_Award", ["award"]]]) });
    expect(award.nominal).toBe(0);
    expect(award.clanWars).toContain("award");
    expect(spawnsAnywhere(award)).toBe(true);
  });

  it("⚠️ matches source names case-insensitively, as DayZ does", () => {
    const hat: ItemIndexEntry = { ...by("Orphan_Item"), className: "MK4Optic_Black" };
    applySources([hat], { ...noSources, clanWars: new Map([["MK4Optic_black", ["KotH loadout"]]]), spawnGear: new Set(["mk4optic_BLACK"]) });
    expect(hat.clanWars).toEqual(["KotH loadout"]);
    expect(hat.spawnGear).toBe(true);
  });

  it("⚠️ nominal 0 and no other source is the only \"does not spawn\"", () => {
    expect(by("Orphan_Item").nominal).toBe(0);
    expect(spawnsAnywhere(by("Orphan_Item"))).toBe(false);
  });

  it("counts any nominal above 0 as spawning, even with no usage", () => {
    expect(spawnsAnywhere(by("Flashlight"))).toBe(true);
    expect(spawnsAnywhere(by("GhillieSuit_Desert"))).toBe(true);
  });
});

describe("canSpawnAt", () => {
  const items = parseTypes(fx("types.xml"), limits);
  const by = (n: string) => items.find((i) => i.className === n)!;
  const u = (...n: string[]) => bit(limits.usage, ...n);
  const v = (...n: string[]) => bit(limits.value, ...n);
  const c = (...n: string[]) => bit(limits.categories, ...n);
  const t = (...n: string[]) => bit(limits.tags, ...n);
  const barracks: WorldProto = {
    name: "Land_Mil_Barracks1",
    usage: u("Military"),
    containers: [
      { categories: c("tools", "containers", "weapons"), tags: t("floor"), points: 9 },
      { categories: c("tools", "containers", "clothes", "food", "books"), tags: t("shelves"), points: 9 },
    ],
  };
  const zoneShed: WorldProto = { name: "Shed", usage: 0, containers: [{ categories: c("weapons"), tags: 0, points: 3 }] };

  it("keeps M4A1 out of a Military Tier4 barracks", () => {
    expect(canSpawnAt(by("M4A1"), barracks, u("Military"), v("Tier4"))).toBe(false);
  });

  it("puts M4A1 in a ContaminatedArea Unique building with a weapons container", () => {
    expect(canSpawnAt(by("M4A1"), zoneShed, u("ContaminatedArea"), v("Unique"))).toBe(true);
    // ...but not in another tier.
    expect(canSpawnAt(by("M4A1"), zoneShed, u("ContaminatedArea"), v("Tier3"))).toBe(false);
  });

  it("never places nominal 0 or deloot items in a building", () => {
    const mil = { ...by("GhillieSuit_Desert") };
    const open: WorldProto = { name: "x", usage: u("Military"), containers: [{ categories: 0, tags: 0, points: 1 }] };
    expect(canSpawnAt(mil, open, 0, v("Tier3"))).toBe(false);
    expect(canSpawnAt({ ...mil, deloot: false }, open, 0, v("Tier3"))).toBe(true);
    expect(canSpawnAt({ ...mil, deloot: false, nominal: 0 }, open, 0, v("Tier3"))).toBe(false);
  });

  it("treats a missing value as any tier, and a missing usage as no building at all", () => {
    const town: WorldProto = { name: "x", usage: u("Town"), containers: [{ categories: c("food"), tags: t("shelves"), points: 1 }] };
    expect(canSpawnAt(by("TunaCan"), town, 0, v("Tier1"))).toBe(true);
    expect(canSpawnAt(by("TunaCan"), town, 0, 0)).toBe(true);
    const anything: WorldProto = { name: "x", usage: u("Town"), containers: [{ categories: 0, tags: 0, points: 1 }] };
    expect(canSpawnAt(by("Flashlight"), anything, u("Town"), v("Tier1"))).toBe(false);
  });

  it("needs both category and tag to fit, with a missing list on either side open on that axis", () => {
    const tuna = by("TunaCan"); // food, shelves
    const mk = (categories: number, tags: number): WorldProto => ({ name: "x", usage: u("Town"), containers: [{ categories, tags, points: 1 }] });
    expect(canSpawnAt(tuna, mk(c("food"), t("shelves")), 0, 0)).toBe(true);
    expect(canSpawnAt(tuna, mk(c("food"), 0), 0, 0)).toBe(true);
    expect(canSpawnAt(tuna, mk(0, t("shelves")), 0, 0)).toBe(true);
    expect(canSpawnAt(tuna, mk(0, 0), 0, 0)).toBe(true);
    expect(canSpawnAt(tuna, mk(c("weapons"), t("shelves")), 0, 0)).toBe(false);
    expect(canSpawnAt(tuna, mk(c("food"), t("floor")), 0, 0)).toBe(false);
    // An item with neither category nor tag fits any container.
    const village: WorldProto = { name: "x", usage: u("Village"), containers: [{ categories: c("weapons"), tags: t("floor"), points: 1 }] };
    expect(canSpawnAt(by("GlassBottle"), village, 0, 0)).toBe(true);
  });

  it("uses the area usage only when the building's group has none", () => {
    expect(canSpawnAt(by("M4A1"), { ...zoneShed, usage: u("Military") }, u("ContaminatedArea"), v("Unique"))).toBe(false);
  });
});

describe("committed items.json", () => {
  // Read in beforeAll, not at collection, so a missing file fails these tests and not the unit ones.
  let file: ItemsFile;
  let by: Map<string, ItemIndexEntry>;
  beforeAll(() => {
    file = JSON.parse(readFileSync(join(__dirname, `../public/map-data/${WORLD_MAP}/items.json`), "utf8")) as ItemsFile;
    by = new Map(file.items.map((i) => [i.className, i]));
  });

  it("⚠️ holds every types.xml entry (2411 on Nasdara) from a recorded mission commit", () => {
    expect(file.version).toBe(1);
    expect(file.source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(file.items).toHaveLength(2411);
  });

  it("matches the M4A1 fact: weapons, ContaminatedArea, Unique, nominal 4", () => {
    const m = by.get("M4A1")!;
    expect(m.nominal).toBe(4);
    expect(m.categories).toBe(1 << file.limits.categories.indexOf("weapons"));
    expect(m.usage).toBe(1 << file.limits.usage.indexOf("ContaminatedArea"));
    expect(m.value).toBe(1 << file.limits.value.indexOf("Unique"));
  });

  it("⚠️ Review Focus 3: every award item with nominal 0 still spawns, as an award", () => {
    const names = Object.values(awardsCatalogue()).flatMap((a) =>
      Object.values(a.slots).flatMap((s) => s.items.flatMap((i) => [i.className, ...(i.extras ?? [])])),
    );
    const zero = names.map((n) => by.get(n)).filter((i): i is ItemIndexEntry => i !== undefined && i.nominal === 0);
    expect(zero.length).toBeGreaterThan(0);
    for (const i of zero) {
      expect(i.clanWars).toContain("award");
      expect(spawnsAnywhere(i)).toBe(true);
    }
  });

  it("⚠️ every clan flag spawns (supply kit), though types.xml gives them nominal 0", () => {
    const flag = by.get("Flag_Wolf")!;
    expect(flag.nominal).toBe(0);
    expect(flag.clanWars).toContain("supply kit");
    expect(spawnsAnywhere(flag)).toBe(true);
  });

  it("puts M4A1 parts on the M4A1 and cars on their events", () => {
    expect(by.get("M4_Suppressor")!.attachedTo).toContain("M4A1");
    expect(by.get("OffroadHatchback")!.events.length).toBeGreaterThan(0);
  });
});
