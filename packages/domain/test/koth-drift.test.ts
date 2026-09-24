import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { KOTH_LOCATIONS, KOTH_PRESET_FILES, KOTH_INFECTED_EVENTS, KOTH_AWARD_KEY } from "../src/index.js";
import { awardsCatalogue } from "../src/awards-catalogue.js";

// ⚠️ Two statements of one fact (CLAUDE.md): the livonia repo holds the towns,
// the presets and the zone names; this package vendors them. Skipped where the
// sibling checkout is absent (CI), enforced wherever it is present.
const LIVONIA = join(__dirname, "../../../../livonia");
const present = existsSync(join(LIVONIA, "koth/locations/index.json"));

describe.skipIf(!present)("KotH catalogue vs the livonia repo", () => {
  it("towns match koth/locations/index.json", () => {
    const src = JSON.parse(readFileSync(join(LIVONIA, "koth/locations/index.json"), "utf8"));
    expect(KOTH_LOCATIONS.map((l) => [l.slug, l.centreX, l.centreZ]))
      .toEqual(src.map((t: { slug: string; center_x: number; center_z: number }) => [t.slug, t.center_x, t.center_z]));
  });
  it("presets match custom/koth-*.json", () => {
    const names = readdirSync(join(LIVONIA, "custom")).filter((f) => f.startsWith("koth-") && f.endsWith(".json")).sort();
    expect([...KOTH_PRESET_FILES].sort()).toEqual(names.map((n) => `./custom/${n}`));
  });
  // ⚠️ A zone named for an event the bot never switches on spawns nothing.
  it("every generated zombie zone names an event the bot switches on", () => {
    for (const l of KOTH_LOCATIONS) {
      const xml = readFileSync(join(LIVONIA, "koth/locations", l.slug, "zombie_territories.xml"), "utf8");
      for (const [, name] of xml.matchAll(/zone name="([^"]+)"/g)) expect(KOTH_INFECTED_EVENTS).toContain(name);
    }
  });
});

describe("KotH award", () => {
  it("names an award the catalogue has", () => expect(awardsCatalogue()[KOTH_AWARD_KEY]).toBeDefined());
});
