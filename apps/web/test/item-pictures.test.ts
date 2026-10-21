import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { matchPictures } from "../lib/item-pictures";
import type { ItemCardsFile } from "../lib/item-cards";

const card = (className: string, displayName: string) => ({ className, displayName });

describe("matchPictures", () => {
  const cards = [
    card("ak74_woodbttstck", "KA Wooden Buttstock"),
    card("AK_WoodBttstck", "KA Wooden Buttstock"),
    card("WineBottle", "Glass Bottle"),
    card("M4A1", "M4-A1"),
    card("Mag_STANAG_30Rnd", "30rd STANAG Mag"),
  ];

  it("a class-specific file beats a display-name file", () => {
    const m = matchPictures(["KA Wooden Buttstock.webp", "KA Wooden Buttstock (ak74_woodbttstck).webp"], cards);
    expect(m.get("ak74_woodbttstck")).toBe("KA Wooden Buttstock (ak74_woodbttstck).webp");
    expect(m.get("AK_WoodBttstck")).toBe("KA Wooden Buttstock.webp");
  });

  it("matches the bracketed class name case-insensitively", () => {
    const m = matchPictures(["Glass Bottle (WINEBOTTLE).webp"], cards);
    expect(m.get("WineBottle")).toBe("Glass Bottle (WINEBOTTLE).webp");
  });

  it("matches display names ignoring case and punctuation, one file for many cards", () => {
    const m = matchPictures(["m4 a1.webp", "30rd STANAG Mag.webp"], [...cards, card("M4A1_Black", "M4-A1")]);
    expect(m.get("M4A1")).toBe("m4 a1.webp");
    expect(m.get("M4A1_Black")).toBe("m4 a1.webp");
    expect(m.get("Mag_STANAG_30Rnd")).toBe("30rd STANAG Mag.webp");
  });

  it("a class-specific file is not offered to other cards sharing its display name", () => {
    const m = matchPictures(["Glass Bottle (winebottle).webp"], [...cards, card("Other", "Glass Bottle")]);
    expect(m.has("Other")).toBe(false);
  });

  it("leaves a file that matches nothing out", () => {
    const m = matchPictures(["Nothing Here.webp"], cards);
    expect(m.size).toBe(0);
  });
});

describe("committed item-cards.json", () => {
  it("every card image path exists under public/", () => {
    const pub = join(__dirname, "../public");
    const file = JSON.parse(readFileSync(join(pub, "map-data/nasdara/item-cards.json"), "utf8")) as ItemCardsFile;
    const missing = file.cards.filter((c) => c.image && !existsSync(join(pub, c.image))).map((c) => c.image);
    expect(missing).toEqual([]);
  });
});
