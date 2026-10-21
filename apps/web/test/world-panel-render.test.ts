import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorldPanel, type WorldPanelProps } from "../app/(site)/map/world-panel";
import { WORLD_COPY } from "../lib/map-copy";

const pal = { gold: "#d9a03c", ink: "#e8e2d4", ink2: "#b5afa4", rust2: "#d4623a", olive: "#8fa36a", frame: "#0b0b0a", rule2: "#2a2825", military: "#e0457b" };
const base: WorldPanelProps = {
  status: "ready",
  layers: [
    { key: "bunkers", group: "Bunkers", label: "Bunkers", defaultOn: true },
    { key: "event:StaticWaterTruck", group: "Vehicles", label: "Water truck", defaultOn: false },
    { key: "loot:military", group: "Loot buildings", label: "Military", defaultOn: false },
  ],
  counts: { bunkers: 23, "event:StaticWaterTruck": 66, "loot:military": 705 },
  on: { bunkers: true, "event:StaticWaterTruck": false, "loot:military": false },
  onToggle: () => {},
  tiers: [{ name: "Tier1", bit: 1 }, { name: "Tier2", bit: 2 }, { name: "Unique", bit: 16 }],
  tierMask: 1 | 16,
  onTier: () => {},
  pal,
  variant: "panel",
};
const render = (p: Partial<WorldPanelProps>) => renderToStaticMarkup(createElement(WorldPanel, { ...base, ...p }));

describe("WorldPanel", () => {
  it.each(["panel", "sheet"] as const)("%s: group headings, each row with its count, and only the tiers present", (variant) => {
    const html = render({ variant });
    for (const h of [">Bunkers</h3>", ">Vehicles</h3>", ">Loot buildings</h3>"]) expect(html).toContain(h);
    expect(html).not.toContain(">Wrecks</h3>");
    expect(html).toContain("Water truck");
    expect(html).toContain(">66<");
    expect(html).toContain(">705<");
    expect(html).toContain("Tier 1");
    expect(html).toContain("Unique");
    expect(html).not.toContain("Tier 4");
  });

  it("says once that the world layers could not load, and nothing else", () => {
    const html = render({ status: "failed" });
    expect(html).toContain(WORLD_COPY.failed);
    expect(html).not.toContain("<h3");
  });

  it("renders nothing while loading", () => {
    expect(render({ status: "loading" })).toBe("");
  });
});
