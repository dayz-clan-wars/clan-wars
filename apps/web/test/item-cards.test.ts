import { afterEach, beforeAll, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORLD_MAP } from "@factions/domain";
import {
  cardFor,
  loadItemCards,
  parseConfigClasses,
  parseStringtable,
  resolveString,
  slotIndex,
  type ItemCardsFile,
} from "../lib/item-cards";

// A derapified config.cpp excerpt and a stringtable excerpt, shaped like the real ones
// HEMTT writes out of the game's PBOs (scripts/item-cards/extract.sh).
const fixture = (f: string) => readFileSync(join(__dirname, "fixtures", "item-cards", f), "utf8");
const classes = parseConfigClasses(fixture("config.cpp"));
const table = parseStringtable(fixture("stringtable.csv"));
const onServer = ["M4A1", "M4A1_Green", "Mag_STANAG_30Rnd", "Mag_CMAG_30Rnd", "Ammo_556x45", "Ammo_556x45Tracer", "M4_OEBttstck", "M4_MPHndgrd", "ACOGOptic", "UniversalLight"];
const slots = slotIndex(classes, onServer);

describe("parseConfigClasses", () => {
  it("resolves inheritance: M4A1 gets M4A1_Base's weight, size and magazines", () => {
    const m4 = classes.get("M4A1")!;
    expect(m4.weight).toBe(2276);
    expect(m4.itemsize).toEqual([9, 3]);
    expect(m4.magazines).toEqual(["Mag_STANAG_30Rnd", "Mag_CMAG_30Rnd", "Mag_Drum_TEST"]);
    expect(m4.scope).toBe(2); // its own value wins over the base's 0
  });

  it("follows a chain more than one class deep", () => {
    expect(classes.get("M4A1_Green")!.displayname).toBe("$STR_cfgWeapons_M4A10");
    expect(classes.get("M4A1_Green")!.chamberablefrom).toEqual(["Ammo_556x45", "Ammo_556x45Tracer"]);
  });

  it("appends a += array to the parent's", () => {
    expect(classes.get("M4A1")!.attachments).toEqual(["weaponButtstockM4", "WeaponHandguardM4", "weaponOptics", "weaponFlashlight"]);
  });

  it("reads all three item sections, and skips nested classes and forward declarations", () => {
    expect(classes.has("Mag_STANAG_30Rnd")).toBe(true);
    expect(classes.has("UniversalLight")).toBe(true);
    expect(classes.has("SemiAuto")).toBe(false);
    expect(classes.has("DZ_Weapons_Firearms_M4")).toBe(false); // CfgPatches is not an item
    expect(classes.get("M4A1")!.reloadtime).toBeUndefined();
  });

  it("merges a class defined twice (a later PBO extending an earlier one)", () => {
    const merged = parseConfigClasses(`${fixture("config.cpp")}\nclass CfgVehicles { class ACOGOptic { weight = 300; }; };`);
    expect(merged.get("ACOGOptic")!.weight).toBe(300);
    expect(merged.get("ACOGOptic")!.inventoryslot).toEqual(["weaponOptics", "weaponOpticsAug"]);
  });
});

describe("resolveString", () => {
  it("maps a $STR_ key to English, whatever its case", () => {
    expect(resolveString("$STR_cfgWeapons_M4A10", table)).toBe("M4-A1");
  });

  it("reads quoted commas and doubled quotes in the csv", () => {
    expect(resolveString("$STR_cfgWeapons_M4A11", table)).toBe('Selective-fire assault rifle, fed from a "standardized" magazine.');
  });

  it("falls back to the original column when English is empty", () => {
    expect(resolveString("$STR_CfgMagazines_Mag_STANAG_30Rnd0", table)).toBe("STANAG 30rd Magazine");
  });

  it("passes plain text through and gives an unknown key as empty", () => {
    expect(resolveString("Plain text, not a key.", table)).toBe("Plain text, not a key.");
    expect(resolveString("$STR_nope", table)).toBe("");
  });
});

describe("cardFor", () => {
  it("lists the M4A1's magazines, and its ammo from chamberableFrom", () => {
    const card = cardFor("M4A1", classes, table, slots)!;
    expect(card.displayName).toBe("M4-A1");
    expect(card.description).toBe('Selective-fire assault rifle, fed from a "standardized" magazine.');
    expect(card.weightG).toBe(2276);
    expect(card.size).toEqual([9, 3]);
    expect(card.magazines).toEqual(["Mag_STANAG_30Rnd", "Mag_CMAG_30Rnd"]);
    expect(card.ammo).toEqual(["Ammo_556x45", "Ammo_556x45Tracer"]);
    expect(card.image).toBeNull();
  });

  it("resolves attachments by matching the weapon's slot names against each item's inventorySlot", () => {
    // weaponButtstockM4 ← a plain-string inventorySlot; WeaponHandguardM4 ← a different case;
    // weaponOptics ← one of two slots; weaponFlashlight ← inherited from Flashlight_Base.
    expect(cardFor("M4A1", classes, table, slots)!.attachments).toEqual(["ACOGOptic", "M4_MPHndgrd", "M4_OEBttstck", "UniversalLight"]);
  });

  it("lists only the magazines and ammo the classes it is given have", () => {
    // In the build those are the items on our server: Mag_Drum_TEST is a developer item.
    expect(cardFor("M4A1", classes, table, slots)!.magazines).not.toContain("Mag_Drum_TEST");
    const without = new Map([...classes].filter(([k]) => k !== "Ammo_556x45Tracer"));
    expect(cardFor("M4A1", without, table, slots)!.ammo).toEqual(["Ammo_556x45"]);
  });

  it("gives a magazine its ammo from ammoItems", () => {
    const mag = cardFor("Mag_STANAG_30Rnd", classes, table, slots)!;
    expect(mag.ammo).toEqual(["Ammo_556x45", "Ammo_556x45Tracer"]);
    expect(mag.magazines).toEqual([]);
    expect(mag.description).toBe("Plain text, not a key.");
  });

  it("falls back to the class name with no display name, and null for no weight or size", () => {
    const c = cardFor("M4_MPHndgrd", classes, table, slots)!;
    expect(c.displayName).toBe("M4_MPHndgrd");
    expect(c.weightG).toBeNull();
    expect(c.size).toBeNull();
  });

  it("drops a placeholder description", () => {
    const dots = parseConfigClasses('class CfgVehicles { class GardenPlot { scope = 2; descriptionShort = "..."; }; };');
    expect(cardFor("GardenPlot", dots, table, new Map())!.description).toBe("");
  });

  it("is null for a class the game files do not have", () => {
    expect(cardFor("NoSuchItem", classes, table, slots)).toBeNull();
  });
});

describe("loadItemCards", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keys the cards by class name", async () => {
    const file: ItemCardsFile = {
      version: 1,
      source: { steamBuildId: "1", addonsModified: "2026-10-19T16:57:28Z", hemtt: "1.22.0", builtAt: "2026-10-21T00:00:00Z" },
      cards: [{ className: "M4A1", displayName: "M4-A1", description: "", weightG: 2276, size: [9, 3], attachments: [], magazines: [], ammo: [], image: null }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(file))));
    const cards = await loadItemCards();
    expect(cards.get("M4A1")?.displayName).toBe("M4-A1");
  });
});

describe("the committed cards", () => {
  const read = <T,>(f: string) => JSON.parse(readFileSync(join(__dirname, "..", "public", "map-data", WORLD_MAP, f), "utf8")) as T;
  let file: ItemCardsFile;
  let items: { items: { className: string }[] };
  beforeAll(() => {
    file = read<ItemCardsFile>("item-cards.json");
    items = read<{ items: { className: string }[] }>("items.json");
  });

  it("are only for items in the index, and name the game build", () => {
    const names = new Set(items.items.map((i) => i.className));
    for (const c of file.cards) expect(names.has(c.className)).toBe(true);
    expect(file.source.steamBuildId).toMatch(/^\d+$/u);
  });

  it("know the M4A1 the way the game does", () => {
    const m4 = file.cards.find((c) => c.className === "M4A1")!;
    expect(m4.displayName).toBe("M4-A1");
    expect(m4.magazines).toContain("Mag_STANAG_30Rnd");
    expect(m4.ammo).toContain("Ammo_556x45");
    expect(m4.attachments.length).toBeGreaterThan(0);
  });

  it("point every image at a file that is there", () => {
    for (const c of file.cards) {
      if (c.image === null) continue;
      expect(c.image).toMatch(/^\/[\w\-/]+\.webp$/u);
      expect(() => readFileSync(join(__dirname, "..", "public", c.image!))).not.toThrow();
    }
  });
});
