import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { KIT_SLOTS, loadCatalogue, isAllowed } from "../src/booster-kit";
import catalogue from "../assets/booster-catalogue.json";

const GOOD = {
  mask: [{ className: "GasMask", label: "Gas Mask" }],
  jacket: [{ className: "GorkaEJacket_Summer", label: "Gorka Jacket" }],
  eyewear: [], hat: [], pants: [], boots: [], gloves: [], hipPack: [], backpack: [],
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
