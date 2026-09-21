import { describe, it, expect } from "vitest";
import { profileUrl, clanUrl, playerLink, clanLink } from "../src/site-links.js";

const SITE = "https://dayzclanwars.com";

describe("site-links", () => {
  /**
   * ⚠️ The bare/rendered split is the point of this module. embed.setURL()
   * rejects `<https://…>`, and inline text needs the angle brackets or
   * Discord unfurls an OpenGraph card under every line. Builders bare,
   * renderers wrapped, so no call site can get it wrong.
   */
  it("builds bare URLs", () => {
    expect(profileUrl(SITE, "SomePlayer")).toBe("https://dayzclanwars.com/players/SomePlayer");
    expect(clanUrl(SITE, "NOMAD")).toBe("https://dayzclanwars.com/clans/NOMAD");
  });

  it("URL-encodes a gamertag with a space", () => {
    expect(profileUrl(SITE, "Some Player")).toBe("https://dayzclanwars.com/players/Some%20Player");
  });

  it("wraps rendered links in angle brackets to suppress the unfurl", () => {
    expect(playerLink(SITE, "SomePlayer"))
      .toBe("[SomePlayer](<https://dayzclanwars.com/players/SomePlayer>)");
  });

  it("escapes markdown in the label but not in the URL", () => {
    // A gamertag is player-controlled text; markdown in it would restyle the line.
    expect(playerLink(SITE, "a_b*c"))
      .toBe("[a\\_b\\*c](<https://dayzclanwars.com/players/a_b*c>)");
  });

  it("renders a clan with a name as bold name plus plain tag", () => {
    expect(clanLink(SITE, "NOMAD", "Nomads"))
      .toBe("**[Nomads](<https://dayzclanwars.com/clans/NOMAD>)** [NOMAD]");
  });

  it("renders a clan without a name as the linked tag alone", () => {
    expect(clanLink(SITE, "NOMAD")).toBe("[NOMAD](<https://dayzclanwars.com/clans/NOMAD>)");
  });
});
