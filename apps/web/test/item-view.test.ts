import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseLimits } from "../lib/area-flags";
import { parseTypes, type ItemIndexEntry } from "../lib/item-index";
import { ITEM_COPY } from "../lib/map-copy";
import type { WorldSwitches } from "../lib/world-layers";
import { clearItem, itemPanel, pickItem, toggleWorldLayer, toggleWorldTier, type WorldState } from "../lib/item-view";
import { ItemPanel } from "../app/(site)/map/item-panel";

const limits = parseLimits(readFileSync(join(__dirname, "fixtures/mission/cfglimitsdefinition.xml"), "utf8"));
const entries = parseTypes(readFileSync(join(__dirname, "fixtures/items/types.xml"), "utf8"), limits);
const entry = (n: string): ItemIndexEntry => ({ ...entries.find((i) => i.className === n)! });
const pt = (x: number) => ({ x, z: x, title: "Loot building" });

const before: WorldSwitches = { on: { bunkers: true, "loot:military": true, "event:StaticHeliCrash": false, wrecks: true }, tiers: 0b10110 };
const start: WorldState = { sw: before, view: null };

describe("the item view's switches", () => {
  it("hides every world layer on a pick and keeps the tiers", () => {
    const s = pickItem(start, { className: "M4A1", label: "M4A1" });
    expect(Object.values(s.sw.on).every((v) => v === false)).toBe(true);
    expect(Object.keys(s.sw.on)).toEqual(Object.keys(before.on));
    expect(s.view).toMatchObject({ className: "M4A1", label: "M4A1" });
  });

  it("⚠️ Clear restores every switch exactly as it was before the pick", () => {
    const s = clearItem(pickItem(start, { className: "M4A1", label: "M4A1" }));
    expect(s).toEqual(start);
    expect(s.sw).toBe(before);
  });

  it("⚠️ a second pick while one is shown keeps the ORIGINAL switches for Clear, not the all-off ones", () => {
    const one = pickItem(start, { className: "M4A1", label: "M4A1" });
    const two = pickItem(one, { className: "Rag", label: "Rag" });
    expect(two.view?.className).toBe("Rag");
    expect(clearItem(two)).toEqual(start);
  });

  it("does nothing on Clear with no item shown", () => {
    expect(clearItem(start)).toBe(start);
  });

  it("a switch flipped while an item is shown ends the item view, from the switches as they were", () => {
    const shown = pickItem(start, { className: "M4A1", label: "M4A1" });
    const s = toggleWorldLayer(shown, "event:StaticHeliCrash");
    expect(s.view).toBeNull();
    expect(s.sw.on).toEqual({ ...before.on, "event:StaticHeliCrash": true });
    const t = toggleWorldTier(shown, 0b10);
    expect(t.view).toBeNull();
    expect(t.sw).toEqual({ on: before.on, tiers: 0b10100 });
  });
});

const text = (m: ReturnType<typeof itemPanel>) => m.lines.map((l) => `${l.label}: ${l.text}`);

describe("itemPanel", () => {
  it("names the item in the chip", () => {
    expect(itemPanel(entry("M4A1"), "M4A1", [pt(1)], limits).chip).toBe("Showing where M4A1 spawns");
  });

  it("explains M4A1: spots, how many, where and which tier", () => {
    const lines = text(itemPanel(entry("M4A1"), "M4A1", [pt(1), pt(2)], limits));
    expect(lines).toEqual([
      "On the map: 2 spots.",
      "How many: Up to 4 on the server at once. More spawn when fewer than 3 are left.",
      "Found in: Contaminated area",
      "Tiers: Unique",
    ]);
  });

  it("says when there are too many spots to show zoomed out", () => {
    const many = Array.from({ length: 300 }, (_, i) => pt(i));
    expect(itemPanel(entry("TunaCan"), "TunaCan", many, limits).lines[0]!.text).toBe("300 spots. Zoom in to see them.");
    expect(itemPanel(entry("TunaCan"), "TunaCan", many, limits).lines.find((l) => l.label === ITEM_COPY.tiers)?.text).toBe(ITEM_COPY.anyTier);
  });

  it("⚠️ never says \"does not spawn\" for an item that spawns with no spot to show (a soda can, a flashlight)", () => {
    const m = itemPanel(entry("Flashlight"), "Flashlight", [], limits);
    const all = text(m).join("\n");
    expect(all).not.toContain(ITEM_COPY.none);
    expect(m.lines[0]!.text).toBe(ITEM_COPY.noSpot);
    expect(all).not.toContain("Found in");
  });

  it("says \"does not spawn\" only when nothing at all places the item", () => {
    expect(itemPanel(entry("Orphan_Item"), "Orphan_Item", [], limits).lines).toEqual([{ label: ITEM_COPY.where, text: ITEM_COPY.none }]);
  });

  it("lists the parents an attachment comes on, capped", () => {
    const sup = entry("M4_Suppressor");
    sup.attachedTo = ["M4A1"];
    expect(text(itemPanel(sup, "M4_Suppressor", [], limits))).toContain("Comes on: M4A1");
    sup.attachedTo = Array.from({ length: 10 }, (_, i) => `Gun${i}`);
    expect(text(itemPanel(sup, "M4_Suppressor", [], limits))).toContain("Comes on: Gun0, Gun1, Gun2, Gun3, Gun4, Gun5 and 4 more");
  });

  it("names crash sites for deloot, the events, fixed spots, spawn gear and each Clan Wars source", () => {
    const i = { ...entry("GhillieSuit_Desert"), events: ["VehicleOffroadHatchback", "InfectedArmy"], proxy: true, spawnGear: true,
      clanWars: ["supply kit", "award"] as ItemIndexEntry["clanWars"] };
    const lines = text(itemPanel(i, "GhillieSuit_Desert", [pt(1)], limits));
    expect(lines).toContain(`Crash sites: ${ITEM_COPY.crash}`);
    expect(lines).toContain("Events: Ada, Infected Army");
    expect(lines).toContain(`Fixed spots: ${ITEM_COPY.proxy}`);
    expect(lines).toContain(`Spawn gear: ${ITEM_COPY.spawnGear}`);
    expect(lines).toContain(`Clan Wars: ${ITEM_COPY.clanWars["supply kit"]}`);
    expect(lines).toContain(`Clan Wars: ${ITEM_COPY.clanWars.award}`);
    // deloot: never building loot, so no "Found in".
    expect(lines.some((l) => l.startsWith("Found in"))).toBe(false);
  });

  it("explains a clan flag: no spot, but the supply kit", () => {
    const flag = { ...entry("Orphan_Item"), className: "Flag_Wolf", clanWars: ["supply kit"] as ItemIndexEntry["clanWars"] };
    expect(text(itemPanel(flag, "Flag_Wolf", [], limits))).toEqual([`Where: ${ITEM_COPY.noSpot}`, `Clan Wars: ${ITEM_COPY.clanWars["supply kit"]}`]);
  });

  it("without the world file, skips the spots line rather than guessing", () => {
    expect(itemPanel(entry("M4A1"), "M4A1", null, limits).lines[0]!.label).toBe(ITEM_COPY.howMany);
  });
});

describe("ItemPanel", () => {
  const model = itemPanel(entry("M4A1"), "M4A1", [pt(1)], limits);
  const render = (card?: string) =>
    renderToStaticMarkup(createElement(ItemPanel, { model, onClear: () => {}, variant: "panel", card: card ? createElement("p", null, card) : undefined }));

  it("shows the chip with Clear, and the lines", () => {
    const html = render();
    expect(html).toContain("Showing where M4A1 spawns");
    expect(html).toContain(">Clear<");
    expect(html).toContain("Contaminated area");
  });

  it("has a slot for the item card", () => {
    expect(render("CARD")).toContain("<p>CARD</p>");
  });
});
