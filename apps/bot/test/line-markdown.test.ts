import { describe, it, expect } from "vitest";
import { lineMarkdown } from "../src/site-links.js";

const site = "https://dayzclanwars.com";

describe("lineMarkdown", () => {
  it("escapes text, leaves raw bare, links players and clans", () => {
    expect(lineMarkdown(["a ", { text: "x_y" }, " ", { raw: "x_y" }], site)).toBe("a x\\_y x_y");
    expect(lineMarkdown([{ bold: [{ player: "Al_pha" }] }], site)).toBe("**[Al\\_pha](<https://dayzclanwars.com/players/Al_pha>)**");
    expect(lineMarkdown([{ clan: "WLF" }], site)).toBe("[WLF](<https://dayzclanwars.com/clans/WLF>)");
    expect(lineMarkdown([{ clan: "WLF", name: "Wolves" }], site)).toBe("**[Wolves](<https://dayzclanwars.com/clans/WLF>)** [WLF]");
    expect(lineMarkdown([{ page: "/seasons", label: "seasons" }], site)).toBe("[seasons](<https://dayzclanwars.com/seasons>)");
  });
  it("renders time as Discord tokens", () => {
    expect(lineMarkdown([{ time: "2026-09-08T00:00:00.000Z", style: "at" }], site)).toBe("<t:1788825600:F>");
    expect(lineMarkdown([{ time: "2026-09-08T00:00:00.000Z", style: "rel" }], site)).toBe("<t:1788825600:R>");
  });
});
