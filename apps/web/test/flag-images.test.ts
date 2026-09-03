import { describe, it, expect } from "vitest";
import { CLAIMABLE_FLAGS } from "@factions/domain";
import { WIKI_FILENAME_ALIASES, wikiFilenameFor, flagImagePath } from "../src/flag-images.js";

describe("wikiFilenameFor", () => {
  it("maps a texture to <texture>.png by default", () => {
    expect(wikiFilenameFor("Flag_Wolf")).toBe("Flag_Wolf.png");
    expect(wikiFilenameFor("Flag_Chernarus")).toBe("Flag_Chernarus.png");
  });

  it("⚠️ maps Flag_Sakhal to the wiki's differently-shaped filename", () => {
    // Verified against the Fandom MediaWiki API on 2026-09-03: 32 of the 33
    // claimable textures are <texture>.png, and this one is not. Getting it
    // wrong yields 32 working thumbnails and one silently broken faction.
    expect(wikiFilenameFor("Flag_Sakhal")).toBe("Sakhal_flag.PNG");
  });

  it("⚠️ the alias table contains ONLY textures the default rule cannot serve", () => {
    // A future tidy-up that "generalises" the rule must not leave a stale
    // alias behind, and an alias for a texture the rule already handles is a
    // sign the rule changed under it.
    expect(Object.keys(WIKI_FILENAME_ALIASES)).toEqual(["Flag_Sakhal"]);
  });

  it("every alias key is a real claimable texture", () => {
    for (const key of Object.keys(WIKI_FILENAME_ALIASES)) {
      expect(CLAIMABLE_FLAGS).toContain(key);
    }
  });
});

describe("flagImagePath", () => {
  it("is <texture>.png under flags/, regardless of the wiki's name", () => {
    // ⚠️ Our served filename follows OUR texture, not the wiki's. The bot's
    // resolver builds `${base}/flags/${texture}.png` with no alias table of
    // its own, so the Sakhal exception must be absorbed here, at fetch time.
    expect(flagImagePath("Flag_Wolf")).toBe("flags/Flag_Wolf.png");
    expect(flagImagePath("Flag_Sakhal")).toBe("flags/Flag_Sakhal.png");
  });

  it("covers every claimable flag", () => {
    expect(CLAIMABLE_FLAGS.map(flagImagePath)).toHaveLength(33);
  });
});
