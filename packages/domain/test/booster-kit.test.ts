import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { KIT_SLOTS, loadCatalogue, isAllowed } from "../src/booster-kit";
import catalogue from "../assets/booster-catalogue.json";

const GOOD = {
  mask: [{ className: "GasMask", label: "Gas Mask" }],
  jacket: [{ className: "GorkaEJacket_Summer", label: "Gorka Jacket" }],
  eyewear: [], hat: [], pants: [], boots: [], gloves: [], hipPack: [], backpack: [], vest: [],
};

describe("loadCatalogue", () => {
  it("accepts a file with an entry list for every slot", () => {
    const c = loadCatalogue(GOOD);
    expect(Object.keys(c).sort()).toEqual([...KIT_SLOTS].sort());
  });

  it("throws when a slot is missing, naming it", () => {
    const { backpack, ...missing } = GOOD;
    expect(() => loadCatalogue(missing)).toThrow(/backpack/);
  });

  it("throws on a duplicate class name within a slot", () => {
    const dup = { ...GOOD, mask: [...GOOD.mask, { className: "GasMask", label: "Again" }] };
    expect(() => loadCatalogue(dup)).toThrow(/GasMask/);
  });
});

describe("loadCatalogue extras", () => {
  const vest = (extras: unknown) => ({ ...GOOD, vest: [{ className: "PlateCarrierVest", label: "Plate Carrier", extras }] });

  it("accepts an entry with extras", () => {
    const c = loadCatalogue(vest(["PlateCarrierPouches", "PlateCarrierHolster"]));
    expect(c.vest[0]!.extras).toEqual(["PlateCarrierPouches", "PlateCarrierHolster"]);
  });

  it("throws on empty extras, naming the class", () => {
    expect(() => loadCatalogue(vest([]))).toThrow(/PlateCarrierVest/);
  });

  it("throws on a non-string extra", () => {
    expect(() => loadCatalogue(vest([7]))).toThrow(/PlateCarrierVest/);
  });
});

describe("isAllowed", () => {
  it("is true for a class name in that slot", () => {
    expect(isAllowed(loadCatalogue(GOOD), "mask", "GasMask")).toBe(true);
  });

  it("is false for a class name from a different slot", () => {
    expect(isAllowed(loadCatalogue(GOOD), "mask", "GorkaEJacket_Summer")).toBe(false);
  });
});

it("the committed catalogue is valid", () => {
  expect(() => loadCatalogue(catalogue)).not.toThrow();
});

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

/**
 * ⚠️ Items neither wiki has art for (mostly Nasdara 1.30 additions, plus FNOJacket and
 * FNOPants). They render as "No art" tiles. Remove a class from here when its image lands.
 */
const NO_ART_YET = [
  "Keffiyeh_Black", "Keffiyeh_Blue", "Keffiyeh_Brown", "Keffiyeh_Gray", "Keffiyeh_LightBlue",
  "Keffiyeh_LightBrown", "Keffiyeh_LightRed", "Keffiyeh_Red", "DustGoggles_Black",
  "DustGoggles_Transparent", "MilitaryBeret_TK", "GhillieHood_Desert", "OBRCap_Beige",
  "OBRCap_Olive", "PakolHat_Beige", "PakolHat_Black", "PakolHat_Brown", "PakolHat_Grey",
  "PakolHat_White", "TurbanHat_Beige", "TurbanHat_Black", "TurbanHat_Brown", "TurbanHat_Green",
  "TurbanHat_Grey", "TurbanHat_NavyBlue", "TurbanHat_Pink", "TurbanHat_Purple", "TurbanHat_Red",
  "TurbanHat_Skyblue", "TurbanHat_White", "TurbanHat_Yellow", "FNOJacket", "HuntingJacket_Desert",
  "KameezShirt_Beige", "KameezShirt_Black", "KameezShirt_BlueFlowers", "KameezShirt_Brown",
  "KameezShirt_Grey", "KameezShirt_NavyBlue", "KameezShirt_Olive", "KameezShirt_Orange",
  "KameezShirt_Pink", "KameezShirt_Purple", "KameezShirt_Red", "KameezShirt_SkyBlue",
  "KameezShirt_White", "KameezShirt_Yellow", "OBRJacket_Beige", "OBRJacket_Officer",
  "OBRJacket_Olive", "PoliceShortSleeveShirt", "ShortSleeveShirt_Black",
  "ShortSleeveShirt_BlueRectangles", "ShortSleeveShirt_CreamSquares", "ShortSleeveShirt_Green",
  "ShortSleeveShirt_Hawaiian_Black", "ShortSleeveShirt_Hawaiian_Blue",
  "ShortSleeveShirt_Hawaiian_White", "ShortSleeveShirt_Waves", "ShortSleeveShirt_White",
  "TacticalShirt_ION_Olive", "TacticalShirt_ION_Tan", "FNOPants", "HunterPants_Desert",
  "MensShalwarPants_Beige", "MensShalwarPants_Black", "MensShalwarPants_Brown",
  "MensShalwarPants_Grey", "MensShalwarPants_NavyBlue", "MensShalwarPants_SkyBlue",
  "MensShalwarPants_White", "WomensShalwarPants_NavyBlue", "WomensShalwarPants_Olive",
  "WomensShalwarPants_Orange", "WomensShalwarPants_Pink", "WomensShalwarPants_Purple",
  "WomensShalwarPants_Red", "SandalsShoes_Black", "SandalsShoes_Brown", "SandalsShoes_Grey",
  "SandalsShoes_BlueNavy", "TraditionalSandalShoes_Black", "TraditionalSandalShoes_Brown",
  "TraditionalSandalShoes_LightBrown", "TraditionalSandalShoes_NavyBlue", "AssaultBag_Desert",
  "GhillieTop_Desert", "GhillieSuit_Desert", "CoyoteBag_Desert", "ChestRigVest_Khaki",
  "ChestRigVest_Olive", "ChestRigVest_Tan", "UKAssVest_Desert", "HuntingVest_Desert",
  "LinenVest_Black", "LinenVest_Brown", "LinenVest_DarkGrey", "LinenVest_Green", "LinenVest_Grey",
  "LinenVest_NavyBlue", "RobeVest_Beige", "RobeVest_Brown", "RobeVest_Green", "RobeVest_Grey",
  "RobeVest_Navy", "HighCapacityVest_ION",
];

it("every committed entry carries an image, bar the known gaps", () => {
  const c = loadCatalogue(catalogue);
  const missing = KIT_SLOTS.flatMap((s) => c[s].filter((e) => !e.image).map((e) => e.className));
  expect(missing).toEqual(NO_ART_YET);
});

describe("boosterCatalogue()", () => {
  it("uses the package's own asset and validates it", async () => {
    const { boosterCatalogue } = await import("../src/booster-catalogue");
    expect(boosterCatalogue()).toEqual(loadCatalogue(catalogue));
  });

  it("memoises, so repeated calls cost one validation", async () => {
    const { boosterCatalogue } = await import("../src/booster-catalogue");
    expect(boosterCatalogue()).toBe(boosterCatalogue());
  });

  /**
   * ⚠️ `@factions/domain` is in apps/web's `transpilePackages` and its root
   * IS in the browser graph (client components import LINK_EMOTES and
   * friends). Re-exporting this module from the index would drop the whole
   * catalogue into every visitor's client bundle, silently.
   */
  it("is not reachable from the package index", async () => {
    const index = await import("../src/index");
    expect(Object.keys(index)).not.toContain("boosterCatalogue");
  });

  /**
   * ⚠️ IMPORTED, never read from disk, and this test is the pin. `/kit` is
   * force-dynamic, and the web runtime image copies only `.next/standalone`;
   * Next's file tracing does not pull `assets/booster-catalogue.json` into
   * it, so a `readFileSync` here throws ENOENT on every `/kit` request in
   * production while every other page is fine. Confirmed by building the
   * image and finding no such file in it (2026-09-19). Nothing at typecheck,
   * test or `next build` time catches a reintroduced disk read.
   */
  it("reads nothing from disk: the catalogue is a module import", async () => {
    const src = await readFile(new URL("../src/booster-catalogue.ts", import.meta.url), "utf8");
    expect(src).toContain('import raw from "../assets/booster-catalogue.json"');
    // Comments stripped first: that file's docblock has to be free to NAME
    // the disk read it replaced, which is the whole reason it is worth
    // explaining there.
    const code = src.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");
    expect(code).not.toMatch(/readFileSync|node:fs|import\.meta\.url/u);
  });
});
