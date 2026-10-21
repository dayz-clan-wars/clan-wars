import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORLD_MAP } from "@factions/domain";
import type { WorldFile } from "../lib/map-world";
import { parseLimits } from "../lib/area-flags";
import { parseTypes, type ItemsFile } from "../lib/item-index";
import {
  EVENT_LAYERS, WORLD_MIN_ZOOM, LOOT_MIN_ZOOM, WORLD_STORAGE_KEY, ALWAYS_DRAWN, ITEM_ALWAYS_MAX, ITEM_KEY, ITEM_MANY_KEY,
  allTiers, delootEvents, isDense, itemItems, itemPoints, pointsFor, presentTiers, readWorldSwitches, worldItems, worldLayers, writeWorldSwitches,
} from "../lib/world-layers";
import { drawWorld, worldPopup, worldView } from "../app/(site)/map/map-draw";
import { gridRef } from "../lib/map-projection";

const USAGE = ["Military", "Police", "Medic", "Firefighter", "Industrial", "Farm", "Coast", "Town", "Village", "Hunting",
  "Office", "School", "Prison", "Lunapark", "SeasonalEvent", "ContaminatedArea", "Historical", "MilitaryEast", "MilitaryWest"];
const VALUE = ["Tier1", "Tier2", "Tier3", "Tier4", "Unique"];
const u = (...names: string[]) => names.reduce((m, n) => m | (1 << USAGE.indexOf(n)), 0);
const t = (...names: string[]) => names.reduce((m, n) => m | (1 << VALUE.indexOf(n)), 0);
const ALL_TIERS = t(...VALUE);

/** A small world with one of everything the layers read. */
const W: WorldFile = {
  version: 1,
  limits: { usage: USAGE, value: VALUE, categories: [], tags: [] },
  source: { commit: "0".repeat(40), builtAt: "2026-10-21T00:00:00Z" },
  events: [
    { event: "StaticWaterTruck", points: [{ x: 1000, z: 1000 }, { x: 9000, z: 9000 }] },
    { event: "StaticHeliCrash", points: [{ x: 1100, z: 1100 }] },
    { event: "VehicleTruck01", points: [] },
    { event: "AmbientHare", points: [{ x: 1200, z: 1200 }] },
    { event: "AmbientFox", points: [{ x: 1300, z: 1300 }] },
    { event: "Loot", points: [{ x: 1400, z: 1400 }] },
    { event: "MysteryEvent", points: [{ x: 1500, z: 1500 }] },
  ],
  bunkers: [{ x: 9500, z: 9500 }, { x: 200, z: 200 }],
  contaminated: [{ name: "Tunnel1", x: 9600, z: 9600, radius: 75 }],
  playerSpawns: [{ x: 1600, z: 1600 }],
  props: [
    { type: 0, x: 100, z: 100, u: 0, t: t("Tier2") }, // 0: barracks, own Military usage
    { type: 1, x: 200, z: 200, u: 0, t: t("Tier1") }, // 1: building that is Military AND Town
    { type: 2, x: 300, z: 300, u: u("Military"), t: t("Tier3") }, // 2: shed, no usage of its own, Military cell
    { type: 2, x: 400, z: 400, u: u("Farm"), t: t("Tier1") }, // 3: shed on a Farm cell
    { type: 3, x: 500, z: 500, u: u("Town"), t: t("Tier1") }, // 4: a wreck
    { type: 4, x: 600, z: 600, u: u("Town"), t: t("Tier1") }, // 5: a rock: no proto, never loot
    { type: 0, x: 2500, z: 2500, u: u("Town"), t: t("Tier1") }, // 6: barracks on a Town cell: both routers
  ],
  types: [
    { name: "Land_Mil_Barracks1", proto: 0 },
    { name: "Land_Mil_House", proto: 1 },
    { name: "Land_Shed", proto: 2 },
    { name: "Land_Wreck_UAZ_TK", proto: null },
    { name: "Land_Rock", proto: null },
  ],
  protos: [
    { name: "Land_Mil_Barracks1", usage: u("Military"), containers: [] },
    { name: "Land_Mil_House", usage: u("Town", "Military"), containers: [] },
    { name: "Land_Shed", usage: 0, containers: [] },
  ],
};

const layer = (key: string) => worldLayers(W).find((l) => l.key === key);

describe("worldLayers", () => {
  it("puts the water truck under Vehicles, off, and bunkers on", () => {
    expect(layer("event:StaticWaterTruck")).toEqual({ key: "event:StaticWaterTruck", group: "Vehicles", label: "Water truck", defaultOn: false });
    expect(layer("bunkers")).toMatchObject({ group: "Bunkers", defaultOn: true });
  });

  it("gives an event with no points no layer", () => {
    expect(layer("event:VehicleTruck01")).toBeUndefined();
  });

  it("makes every Ambient* event one Animals toggle", () => {
    expect(layer("animals")).toMatchObject({ group: "World", label: "Animals" });
    expect(worldLayers(W).filter((l) => l.key.startsWith("event:Ambient"))).toEqual([]);
    expect(pointsFor(W, "animals", ALL_TIERS)).toHaveLength(2);
  });

  it("files an unknown event under World with its raw name, and Loot as loot piles", () => {
    expect(layer("event:MysteryEvent")).toMatchObject({ group: "World", label: "MysteryEvent" });
    expect(layer("event:Loot")).toMatchObject({ group: "World", label: "Loot piles" });
  });

  it("offers only loot layers with a building in them, plus wrecks, spawns and contaminated areas", () => {
    const keys = worldLayers(W).map((l) => l.key);
    expect(keys).toEqual(expect.arrayContaining(["loot:military", "loot:town", "loot:farm", "wrecks", "spawns", "contaminated"]));
    expect(keys).not.toContain("loot:hunting");
    expect(worldLayers(W).every((l) => l.key === "bunkers" || !l.defaultOn)).toBe(true);
  });

  it("lists groups in panel order", () => {
    const groups = [...new Set(worldLayers(W).map((l) => l.group))];
    expect(groups).toEqual(["Bunkers", "Vehicles", "Crash sites", "Loot buildings", "Wrecks", "World"]);
  });
});

describe("pointsFor", () => {
  it("returns only buildings whose effective usage overlaps Military", () => {
    const pts = pointsFor(W, "loot:military", ALL_TIERS);
    expect(pts.map((p) => [p.x, p.z])).toEqual([[100, 100], [200, 200], [300, 300], [2500, 2500]]);
  });

  it("⚠️ puts a building on its own usage's layer AND its area's: the area flags are a second router", () => {
    expect(pointsFor(W, "loot:town", ALL_TIERS).map((p) => p.x)).toContain(2500);
    expect(pointsFor(W, "loot:military", ALL_TIERS).map((p) => p.x)).toContain(2500);
  });

  it("drops a Tier2 barracks when only the Tier4 bit is passed", () => {
    expect(pointsFor(W, "loot:military", t("Tier4"))).toEqual([]);
    expect(pointsFor(W, "loot:military", t("Tier2")).map((p) => p.x)).toEqual([100]);
  });

  it("never puts a building with no loot group on a loot layer", () => {
    for (const l of worldLayers(W).filter((l) => l.group === "Loot buildings")) {
      expect(pointsFor(W, l.key, ALL_TIERS).map((p) => p.x)).not.toContain(600);
    }
  });

  it("gives a loot building its tier and usage names for the popup", () => {
    const [house] = pointsFor(W, "loot:town", ALL_TIERS);
    expect(house).toMatchObject({ x: 200, z: 200, title: "Town", tiers: ["Tier1"], usage: ["Military", "Town"] });
  });

  it("finds wrecks by name, whatever the case of 'wreck'", () => {
    expect(pointsFor(W, "wrecks", ALL_TIERS)).toEqual([{ x: 500, z: 500, title: "Wreck" }]);
  });

  it("numbers bunkers and keeps a contaminated area's radius", () => {
    expect(pointsFor(W, "bunkers", 0).map((p) => p.title)).toEqual(["Bunker 1", "Bunker 2"]);
    expect(pointsFor(W, "contaminated", 0)).toEqual([{ x: 9600, z: 9600, title: "Contaminated area", radius: 75 }]);
  });
});

describe("tiers", () => {
  it("lists only the tiers the props carry", () => {
    expect(presentTiers(W).map((p) => p.name)).toEqual(["Tier1", "Tier2", "Tier3"]);
    expect(allTiers(W)).toBe(t("Tier1", "Tier2", "Tier3"));
  });
});

describe("tiers: an untiered area", () => {
  // 8 Nasdara props sit on an areaflags cell with no tier bit at all (t 0): no chip can select them.
  const W0: WorldFile = { ...W, props: [...W.props, { type: 0, x: 3000, z: 3000, u: 0, t: 0 }] };

  it("⚠️ passes the tier filter whatever tiers are picked: the area has no tier to filter by", () => {
    for (const mask of [ALL_TIERS, t("Tier4"), 0]) {
      expect(pointsFor(W0, "loot:military", mask).map((p) => p.x), String(mask)).toContain(3000);
      expect(worldItems(W0, new Set(["loot:military"]), mask).map((i) => i.x), String(mask)).toContain(3000);
    }
  });

  it("adds no tier chip and no tier line", () => {
    expect(presentTiers(W0).map((p) => p.name)).toEqual(["Tier1", "Tier2", "Tier3"]);
    expect(pointsFor(W0, "loot:military", ALL_TIERS).find((p) => p.x === 3000)!.tiers).toEqual([]);
  });
});

describe("worldItems: overlapping loot layers", () => {
  it("draws a building that sits in two loot layers once, as Military", () => {
    const items = worldItems(W, new Set(["loot:military", "loot:town"]), ALL_TIERS);
    const house = items.filter((i) => i.x === 200 && i.z === 200 && i.key.startsWith("loot:"));
    expect(house).toHaveLength(1);
    expect(house[0]!.key).toBe("loot:military");
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it("gives the same building to Town when Military is off", () => {
    const items = worldItems(W, new Set(["loot:town"]), ALL_TIERS);
    expect(items.map((i) => [i.key, i.x])).toEqual([["loot:town", 200], ["loot:town", 2500]]); // 2500: a Military barracks on a Town cell
  });

  it("draws nothing for a layer that is off", () => {
    expect(worldItems(W, new Set(), ALL_TIERS)).toEqual([]);
  });
});

describe("the switches", () => {
  const layers = worldLayers(W);
  it("default to each layer's defaultOn and every present tier", () => {
    const s = readWorldSwitches(null, layers, W);
    expect(s.on["bunkers"]).toBe(true);
    expect(s.on["event:StaticWaterTruck"]).toBe(false);
    expect(s.tiers).toBe(allTiers(W));
  });

  it("round-trip, tiers by name", () => {
    const on = { ...readWorldSwitches(null, layers, W).on, "loot:military": true, bunkers: false };
    const s = readWorldSwitches(writeWorldSwitches(on, t("Tier3"), W), layers, W);
    expect(s.on["loot:military"]).toBe(true);
    expect(s.on["bunkers"]).toBe(false);
    expect(s.tiers).toBe(t("Tier3"));
  });

  it("fall back to defaults on a corrupt value", () => {
    expect(readWorldSwitches("{not json", layers, W).on["bunkers"]).toBe(true);
  });

  it("live under their own key, not the clan layers'", () => {
    expect(WORLD_STORAGE_KEY).toBe("clan-wars.map.world");
  });
});

describe("committed world.json", () => {
  const world = JSON.parse(readFileSync(join(__dirname, "..", "public", "map-data", "nasdara", "world.json"), "utf8")) as WorldFile;

  it("⚠️ has no event the label map does not name — a new one must be given a label here", () => {
    const names = world.events.map((e) => e.event).filter((n) => !n.startsWith("Ambient")).sort();
    expect(names).toEqual([
      "ItemBricks", "StaticContainerLocked", "StaticHeliCrash", "StaticHeliCrashBig", "StaticMilitaryConvoy",
      "StaticPoliceCar", "StaticWaterTruck", "VehicleCivilianSedan", "VehicleHatchback02", "VehicleMotorbike",
      "VehicleOffroad02", "VehicleOffroadHatchback", "VehicleSedan02", "VehicleTruck01",
    ]);
    for (const n of names) expect(EVENT_LAYERS[n], n).toBeDefined();
  });

  it("offers Tier1–3 and Unique only (Nasdara never sets Tier4)", () => {
    expect(presentTiers(world).map((p) => p.name)).toEqual(["Tier1", "Tier2", "Tier3", "Unique"]);
  });
});

describe("worldView (Review Focus 5)", () => {
  const map = (zoom: number) => ({ getZoom: () => zoom, getBounds: () => ({ pad: (n: number) => ({ padded: n }) }) }) as never;
  it("is null below WORLD_MIN_ZOOM, so a zoomed-out phone draws no world markers", () => {
    expect(worldView(map(WORLD_MIN_ZOOM - 0.25))).toBeNull();
    expect(worldView(map(0))).toBeNull();
  });
  it("draws the dense layers only from LOOT_MIN_ZOOM", () => {
    expect(worldView(map(WORLD_MIN_ZOOM))).toMatchObject({ dense: false });
    expect(worldView(map(LOOT_MIN_ZOOM))).toMatchObject({ dense: true });
  });
});

/** A stub Leaflet that records what is added to which group. */
function stub() {
  const groups = new Map<string, Set<unknown>>();
  const made: { kind: string; at: { x: number; z: number }; opts: Record<string, unknown> }[] = [];
  const layerOf = (kind: string, at: { x: number; z: number }, opts: Record<string, unknown>) => {
    const l = {
      kind, at, opts,
      bindPopup: () => l, on: () => l,
      addTo: (g: { add: (x: unknown) => void }) => { g.add(l); return l; },
    };
    made.push(l);
    return l;
  };
  const L = {
    marker: (at: { x: number; z: number }, opts: Record<string, unknown>) => layerOf("marker", at, opts),
    circle: (at: { x: number; z: number }, opts: Record<string, unknown>) => layerOf("circle", at, opts),
    divIcon: (o: unknown) => o,
  };
  const group = (key: string) => {
    if (!groups.has(key)) groups.set(key, new Set());
    const s = groups.get(key)!;
    return { add: (x: unknown) => s.add(x), removeLayer: (x: unknown) => s.delete(x) };
  };
  return { L, groups, made, group };
}
const P = { gold: "#d", ink: "#e", ink2: "#b", olive: "#8", rust2: "#c", frame: "#0", rule2: "#2", military: "#m" };
const inView = (box: [number, number, number, number]) => ({ bounds: { contains: (p: { x: number; z: number }) => p.x >= box[0] && p.z >= box[1] && p.x <= box[2] && p.z <= box[3] }, dense: true });

describe("drawWorld", () => {
  const items = worldItems(W, new Set(["bunkers", "contaminated", "event:StaticWaterTruck", "loot:military"]), ALL_TIERS);
  const ctx = (s: ReturnType<typeof stub>) => ({ L: s.L as never, group: s.group as never, pt: (x: number, z: number) => ({ x, z }) as never, p: P, size: 16384 });

  it("draws bunkers and contaminated circles even zoomed out, and nothing else", () => {
    const s = stub();
    drawWorld(ctx(s), items, null, new Map());
    expect([...s.groups.keys()].sort()).toEqual(["bunkers", "contaminated"]);
    expect(s.groups.get("bunkers")!.size).toBe(2);
    expect(s.made.filter((m) => m.kind === "circle")).toHaveLength(1);
  });

  it("draws only what is inside the view once zoomed in", () => {
    const s = stub();
    drawWorld(ctx(s), items, inView([0, 0, 2000, 2000]) as never, new Map());
    expect(s.groups.get("event:StaticWaterTruck")!.size).toBe(1);
    expect(s.groups.get("loot:military")!.size).toBe(3);
  });

  it("keeps a marker still in view across a redraw and drops one that left", () => {
    const s = stub();
    const drawn = new Map();
    drawWorld(ctx(s), items, inView([0, 0, 2000, 2000]) as never, drawn);
    const truck = [...s.groups.get("event:StaticWaterTruck")!][0];
    const before = s.made.length;
    drawWorld(ctx(s), items, inView([0, 0, 1500, 1500]) as never, drawn);
    expect(s.made.length).toBe(before); // nothing re-created
    expect([...s.groups.get("event:StaticWaterTruck")!][0]).toBe(truck);
    drawWorld(ctx(s), items, inView([0, 0, 250, 250]) as never, drawn);
    expect(s.groups.get("event:StaticWaterTruck")!.size).toBe(0);
    expect(s.groups.get("loot:military")!.size).toBe(2);
  });

  it("skips the dense loot layers between WORLD_MIN_ZOOM and LOOT_MIN_ZOOM", () => {
    const s = stub();
    drawWorld(ctx(s), items, { ...inView([0, 0, 2000, 2000]), dense: false } as never, new Map());
    expect(s.groups.get("loot:military")?.size ?? 0).toBe(0);
    expect(s.groups.get("event:StaticWaterTruck")!.size).toBe(1);
  });
});

describe("worldPopup", () => {
  it("shows the label, GPS, metres, and a loot building's tiers and usage", () => {
    const [barracks] = worldItems(W, new Set(["loot:military"]), ALL_TIERS);
    const html = worldPopup(barracks!, 16384);
    expect(html).toContain(">Military<");
    expect(html).toContain(`GPS ${gridRef(100, 100, 16384)}`);
    expect(html).toContain("metres 100 100");
    expect(html).toContain("Tier: Tier 2");
    expect(html).toContain("Loot: Military");
    expect(html).toContain("min-h-[44px]");
  });

  it("escapes a raw event name", () => {
    const html = worldPopup({ id: "x", key: "event:X", x: 1, z: 1, title: "<b>" }, 16384);
    expect(html).toContain("&lt;b&gt;");
  });
});

describe("itemPoints", () => {
  // The real limits and the real M4A1 entry, so the masks are the ones the CE reads.
  const lim = parseLimits(readFileSync(join(__dirname, "fixtures/mission/cfglimitsdefinition.xml"), "utf8"));
  const entries = parseTypes(readFileSync(join(__dirname, "fixtures/items/types.xml"), "utf8"), lim);
  const entry = (n: string) => ({ ...entries.find((i) => i.className === n)! });
  const ub = (...n: string[]) => n.reduce((m, x) => m | (1 << lim.usage.indexOf(x)), 0);
  const vb = (...n: string[]) => n.reduce((m, x) => m | (1 << lim.value.indexOf(x)), 0);
  const cb = (...n: string[]) => n.reduce((m, x) => m | (1 << lim.categories.indexOf(x)), 0);
  const IW: WorldFile = {
    version: 1,
    limits: lim,
    source: W.source,
    events: [
      { event: "StaticHeliCrash", points: [{ x: 50, z: 50 }, { x: 60, z: 60 }], children: ["Wreck_Mi8_Crashed"] },
      { event: "StaticMilitaryConvoy", points: [{ x: 70, z: 70 }], children: ["Land_Wreck_Uaz"] },
      { event: "StaticPoliceCar", points: [{ x: 80, z: 80 }], children: ["land_wreck_uaz_aban1_police"] },
      { event: "VehicleOffroadHatchback", points: [{ x: 90, z: 90 }, { x: 95, z: 95 }] },
    ],
    bunkers: [], contaminated: [], playerSpawns: [],
    props: [
      { type: 0, x: 100, z: 100, u: ub("ContaminatedArea"), t: vb("Unique") }, // 0: zone shed: M4A1
      { type: 0, x: 200, z: 200, u: ub("ContaminatedArea"), t: vb("Tier3") }, // 1: zone, wrong tier
      { type: 1, x: 300, z: 300, u: ub("Military"), t: vb("Unique") }, // 2: barracks, Unique, not a zone
      { type: 1, x: 400, z: 400, u: ub("ContaminatedArea"), t: vb("Unique") }, // 3: barracks in a zone: M4A1
      { type: 2, x: 500, z: 500, u: ub("ContaminatedArea"), t: vb("Unique") }, // 4: a rock: no proto
      { type: 3, x: 600, z: 600, u: ub("Town"), t: vb("Tier1") }, // 5: car wreck with fixed parts
      { type: 4, x: 700, z: 700, u: ub("ContaminatedArea"), t: vb("Unique") }, // 6: food-only shop in a zone
    ],
    types: [
      { name: "Land_Shed", proto: 0 },
      { name: "Land_Mil_Barracks1", proto: 1 },
      { name: "Land_Rock", proto: null },
      { name: "Land_Wreck_hb01_aban1_blue", proto: 2 },
      { name: "Land_Shop", proto: 3 },
    ],
    protos: [
      { name: "Land_Shed", usage: 0, containers: [{ categories: cb("weapons"), tags: 0, points: 3 }] },
      { name: "Land_Mil_Barracks1", usage: ub("Military"), containers: [{ categories: cb("weapons"), tags: 0, points: 3 }] },
      { name: "Land_Wreck_hb01_aban1_blue", usage: 0, containers: [], proxies: ["hatchbackwheel"] },
      { name: "Land_Shop", usage: 0, containers: [{ categories: cb("food"), tags: 0, points: 3 }] },
      // The event wrecks: never placed props, only reached through their event's children.
      { name: "Wreck_Mi8_Crashed", usage: ub("MilitaryWest"), containers: [{ categories: cb("clothes", "weapons"), tags: 0, points: 15 }] },
      { name: "Land_Wreck_Uaz", usage: ub("MilitaryEast"), containers: [{ categories: cb("clothes", "weapons"), tags: 0, points: 5 }] },
      { name: "Land_Wreck_UAZ_Aban1_Police", usage: ub("Police"), containers: [{ categories: cb("clothes", "weapons"), tags: 0, points: 5 }] },
    ],
  };

  it("puts the M4A1 fixture only in contaminated-area props of its tier with a weapons container", () => {
    const pts = itemPoints(IW, entry("M4A1"));
    expect(pts.map((p) => [p.x, p.z])).toEqual([[100, 100], [400, 400]]);
    expect(pts[0]).toMatchObject({ tiers: ["Unique"], usage: ["ContaminatedArea"] });
  });

  it("adds the spawn points of the events that place it (a car on its vehicle event)", () => {
    const car = { ...entry("OffroadHatchback"), events: ["VehicleOffroadHatchback", "InfectedArmy"] };
    const pts = itemPoints(IW, car);
    expect(pts.map((p) => [p.x, p.z])).toEqual([[90, 90], [95, 95]]);
    expect(pts[0]!.title).toBe("Ada");
  });

  it("⚠️ puts deloot only at the events whose wrecks can hold it: military loot at the heli and convoy", () => {
    const loot = entry("GhillieSuit_Desert"); // deloot; Military, MilitaryEast, MilitaryWest; clothes
    expect(loot.deloot).toBe(true);
    expect(delootEvents(IW, loot)).toEqual(["StaticHeliCrash", "StaticMilitaryConvoy"]);
    const pts = itemPoints(IW, loot);
    expect(pts.map((p) => p.x).sort((a, b) => a - b)).toEqual([50, 60, 70]);
    expect(pts.map((p) => p.title)).toContain("Heli crash");
  });

  it("⚠️ puts Police deloot (PP19) at the police cars and nowhere else", () => {
    const pp19 = entry("PP19");
    expect(delootEvents(IW, pp19)).toEqual(["StaticPoliceCar"]);
    expect(itemPoints(IW, pp19)).toEqual([{ x: 80, z: 80, title: "Police car" }]);
  });

  it("gives deloot no point when no event's wreck fits it, and only deloot gets event wrecks", () => {
    expect(delootEvents(IW, { ...entry("PP19"), usage: 0 })).toEqual([]);
    expect(delootEvents(IW, entry("M4A1"))).toEqual([]);
  });

  it("⚠️ puts a fixed part (dispatch proxy) on every placed wreck that carries it, ignoring case", () => {
    const wheel = { ...entry("Orphan_Item"), className: "HatchbackWheel", proxy: true };
    const pts = itemPoints(IW, wheel);
    expect(pts).toEqual([{ x: 600, z: 600, title: "Fixed spot" }]);
    // proxy false: the flag is the index's word that some placed building carries it.
    expect(itemPoints(IW, { ...wheel, proxy: false })).toEqual([]);
  });

  it("puts a part fixed in an event's wreck (an AKM in the locked armory) at that event's spawns", () => {
    const armory: WorldFile = {
      ...IW,
      events: [...IW.events, { event: "StaticContainerLocked", points: [{ x: 33, z: 33 }], children: ["Land_Armory"] }],
      protos: [...IW.protos, { name: "Land_Armory", usage: 0, containers: [], proxies: ["AKM"] }],
    };
    const akm = { ...entry("Orphan_Item"), className: "akm", proxy: true };
    expect(itemPoints(armory, akm)).toEqual([{ x: 33, z: 33, title: "Locked container" }]);
  });

  it("draws a building once even when it is both loot and a fixed spot", () => {
    const both: WorldFile = { ...IW, protos: IW.protos.map((p, i) => (i === 0 ? { ...p, proxies: ["M4A1"] } : p)) };
    const pts = itemPoints(both, { ...entry("M4A1"), proxy: true });
    expect(pts.filter((p) => p.x === 100)).toHaveLength(1);
  });

  it("has no point for an item with no usage (a soda can), nor for one that only comes on another", () => {
    expect(itemPoints(IW, entry("Flashlight"))).toEqual([]);
    expect(itemPoints(IW, entry("M4_Suppressor"))).toEqual([]);
  });
});

describe("itemItems", () => {
  const pts = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i, z: i, title: "x" }));

  it("⚠️ gives each item its own ids, so a second pick redraws instead of keeping the first item's markers", () => {
    const a = itemItems("M4A1", pts(2)), b = itemItems("AKM", pts(2));
    expect(a.map((i) => i.id)).not.toEqual(b.map((i) => i.id));
  });

  it("draws a few points at every zoom, and many only zoomed in like the loot buildings", () => {
    expect(itemItems("A", pts(ITEM_ALWAYS_MAX)).every((i) => i.key === ITEM_KEY && ALWAYS_DRAWN.has(i.key))).toBe(true);
    const many = itemItems("A", pts(ITEM_ALWAYS_MAX + 1));
    expect(many.every((i) => i.key === ITEM_MANY_KEY && isDense(i.key))).toBe(true);
  });
});

describe("itemPoints on the committed data", () => {
  const world = JSON.parse(readFileSync(join(__dirname, `../public/map-data/${WORLD_MAP}/world.json`), "utf8")) as WorldFile;
  const items = JSON.parse(readFileSync(join(__dirname, `../public/map-data/${WORLD_MAP}/items.json`), "utf8")) as ItemsFile;
  const by = (n: string) => items.items.find((i) => i.className === n)!;
  const zone = 1 << world.limits.usage.indexOf("ContaminatedArea");

  it("puts every M4A1 point in a contaminated area", () => {
    const pts = itemPoints(world, by("M4A1"));
    expect(pts.length).toBeGreaterThan(0);
    for (const p of pts) expect(p.usage).toContain("ContaminatedArea");
    expect(zone).toBeGreaterThan(0);
  });

  it("finds a Hammer in buildings all over; a Rag (crafted, nominal 0 here) and a clan flag at no spot", () => {
    expect(itemPoints(world, by("Hammer")).length).toBeGreaterThan(ITEM_ALWAYS_MAX);
    expect(itemPoints(world, by("Rag"))).toEqual([]);
    expect(itemPoints(world, by("Flag_Wolf"))).toEqual([]);
  });

  it("⚠️ carries each active event's children, so deloot follows the wrecks' own usage", () => {
    expect(world.events.find((e) => e.event === "StaticPoliceCar")!.children).toContain("Land_Wreck_UAZ_Aban1_Police");
    expect(world.events.find((e) => e.event === "StaticHeliCrash")!.children).toContain("Wreck_Mi8_Crashed");
  });

  it("puts the AKM in the locked containers it is fixed in", () => {
    expect(itemPoints(world, by("AKM")).some((p) => p.title === "Locked container")).toBe(true);
  });

  it("⚠️ puts PP19 (Police deloot) at the police cars only, and military deloot at the military wrecks", () => {
    expect(delootEvents(world, by("PP19"))).toEqual(["StaticPoliceCar"]);
    expect(delootEvents(world, by("PressVest_Blue"))).toEqual(["StaticPoliceCar"]);
    // SCARH_Black is ContaminatedArea only: no heli or convoy wreck carries that usage.
    expect(delootEvents(world, by("SCARH_Black"))).not.toContain("StaticHeliCrash");
  });

  it("puts the Ada (OffroadHatchback) on its vehicle spawns", () => {
    const ada = world.events.find((e) => e.event === "VehicleOffroadHatchback")!;
    expect(itemPoints(world, by("OffroadHatchback")).length).toBeGreaterThanOrEqual(ada.points.length);
  });

  it("puts a hatchback wheel on the placed hatchback wrecks", () => {
    expect(itemPoints(world, by("HatchbackWheel")).some((p) => p.title === "Fixed spot")).toBe(true);
  });
});
