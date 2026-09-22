import { describe, it, expect } from "vitest";
import { KIT_SLOTS } from "@factions/domain";
import { boosterCatalogue } from "@factions/domain/catalogue";
import { awardsCatalogue } from "@factions/domain/awards";
import { WIKI_FILENAME, wikiFileFor, itemImagePath } from "../src/item-images";

describe("itemImagePath", () => {
  it("is named after our class name, never the wiki's", () => {
    expect(itemImagePath("BalaclavaMask_White")).toBe("items/BalaclavaMask_White.webp");
  });
});

describe("wikiFileFor", () => {
  // ⚠️ Deliberately different from flag-images.ts's wikiFilenameFor, which
  // THROWS on a miss. For a flag, a miss means the pool and the table have
  // diverged, which is a bug. For an item, "no art yet" is a legitimate state
  // the picker renders as a placeholder, so throwing would turn an expected
  // gap into an outage.
  it("returns undefined for an unmapped class rather than throwing", () => {
    expect(wikiFileFor("NoSuchItem")).toBeUndefined();
  });

  it("knows where the Ski Mask art came from", () => {
    expect(wikiFileFor("BalaclavaMask_White")?.file).toBe("BalaclavaWhite.png");
  });
});

describe("the mapping table", () => {
  it("covers every catalogue entry that has an image", () => {
    const entries = [
    ...KIT_SLOTS.flatMap((s) => boosterCatalogue()[s]),
    // ⚠️ Award items share public/items/ with the kit, so both catalogues are
    // one statement of what that directory must hold.
    ...Object.values(awardsCatalogue()).flatMap((a) => Object.values(a.slots).flatMap((s) => s.items)),
  ];
    const missing = entries.filter((e) => e.image && !WIKI_FILENAME[e.className]).map((e) => e.className);
    expect(missing).toEqual([]);
  });
});
