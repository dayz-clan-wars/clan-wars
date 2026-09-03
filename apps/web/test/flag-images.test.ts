import { describe, it, expect } from "vitest";
import { CLAIMABLE_FLAGS } from "@factions/domain";
import { WIKI_FILENAME, wikiFilenameFor, flagImagePath } from "../src/flag-images.js";

describe("WIKI_FILENAME", () => {
  it("has an entry for every claimable texture", () => {
    const missing = CLAIMABLE_FLAGS.filter((t) => !(t in WIKI_FILENAME));
    expect(missing).toEqual([]);
  });

  it("has no entries beyond the claimable textures", () => {
    const extra = Object.keys(WIKI_FILENAME).filter((t) => !CLAIMABLE_FLAGS.includes(t));
    expect(extra).toEqual([]);
  });

  it("⚠️ pins the non-obvious in-game-abbreviation mappings", () => {
    // These are the ones a well-meaning future edit would most plausibly
    // "correct" back to a rule-derived name that does not exist on the wiki.
    expect(WIKI_FILENAME.Flag_Rooster).toBe("Flag_cock_co.png");
    expect(WIKI_FILENAME.Flag_BabyDeer).toBe("Flag_fawn_co.png");
    expect(WIKI_FILENAME.Flag_NSahrani).toBe("Flag_dros_co.png");
    expect(WIKI_FILENAME.Flag_SSahrani).toBe("Flag_kos_co.png");
  });
});

describe("wikiFilenameFor", () => {
  it("looks up the map for a known texture", () => {
    expect(wikiFilenameFor("Flag_Wolf")).toBe("Flag_wolf_co.png");
    expect(wikiFilenameFor("Flag_Chernarus")).toBe("Flag_chern_co.png");
  });

  it("⚠️ maps Flag_Sakhal to the flat image, not the folded render", () => {
    // Sakhalflag.PNG (no underscore) is the flat image; Sakhal_flag.PNG (with
    // an underscore) is a different file on the wiki — the folded/hanging
    // render this table replaced. Getting this wrong silently reintroduces
    // the wrong-aspect-ratio image this whole change exists to fix.
    expect(wikiFilenameFor("Flag_Sakhal")).toBe("Sakhalflag.PNG");
  });

  it("throws for a texture with no mapping, rather than inventing one", () => {
    // A miss here means the flag pool and this table have diverged — that
    // must be loud, not a silently-guessed filename that 404s or points at
    // the wrong image.
    expect(() => wikiFilenameFor("Flag_DoesNotExist")).toThrow(/Flag_DoesNotExist/);
  });
});

describe("flagImagePath", () => {
  it("is <texture>.png under flags/, regardless of the wiki's name", () => {
    // ⚠️ Our served filename follows OUR texture, not the wiki's. The bot's
    // resolver builds `${base}/flags/${texture}.png` with no alias table of
    // its own, so the wiki's naming must be absorbed here, at fetch time.
    expect(flagImagePath("Flag_Wolf")).toBe("flags/Flag_Wolf.png");
    expect(flagImagePath("Flag_Sakhal")).toBe("flags/Flag_Sakhal.png");
  });

  it("covers every claimable flag", () => {
    expect(CLAIMABLE_FLAGS.map(flagImagePath)).toHaveLength(33);
  });
});
