import { describe, it, expect } from "vitest";
import { refreshAges, escapeHtml, type AgeLabel } from "../app/(site)/map/map-draw";

/**
 * `refreshAges` only ever touches what a label registers — `tooltip` and/or
 * `popup`. A label that binds both (bounties: a permanent "wanted" tooltip
 * plus a popup with the reason) must have BOTH rewritten on the tick, or an
 * open popup keeps its draw-time age forever while the tag updates every
 * 30 s — the map rule that every shown age is refreshed would silently break
 * for exactly the labels that bind more than one surface. `layer` here is a
 * bare mock: `refreshAges` never touches anything on it but
 * `setTooltipContent`/`setPopupContent`, so no Leaflet/DOM is needed.
 */
describe("refreshAges", () => {
  it("rewrites both the tooltip and the popup of a label that registers both", () => {
    const calls: string[] = [];
    const layer = {
      setTooltipContent: (html: string) => calls.push(`tooltip:${html}`),
      setPopupContent: (html: string) => calls.push(`popup:${html}`),
    };
    const at = new Date("2026-09-23T00:00:00Z");
    const reason = "shot up the outpost";
    const label: AgeLabel = {
      at,
      layer: layer as unknown as AgeLabel["layer"],
      tooltip: (age) => `Target · wanted · ${age}`,
      popup: (age) => `Target · wanted · ${age}<br>${escapeHtml(reason)}`,
    };

    refreshAges([label], at.getTime() + 90 * 60 * 1000); // 1h30m later

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^tooltip:Target · wanted · /u);
    expect(calls[1]).toMatch(/^popup:Target · wanted · .*<br>shot up the outpost$/u);
    // Both surfaces carry the SAME age string, never a stale draw-time one.
    const tooltipAge = calls[0]?.split("· wanted · ")[1] ?? "";
    const popupAge = calls[1]?.split("· wanted · ")[1]?.split("<br>")[0] ?? "";
    expect(popupAge).toBe(tooltipAge);
    expect(tooltipAge).not.toBe("");
  });

  it("leaves an unchanged age alone entirely, tooltip and popup both", () => {
    const calls: string[] = [];
    const layer = {
      setTooltipContent: () => calls.push("tooltip"),
      setPopupContent: () => calls.push("popup"),
    };
    const at = new Date("2026-09-23T00:00:00Z");
    const label: AgeLabel = {
      at,
      layer: layer as unknown as AgeLabel["layer"],
      tooltip: (age) => age,
      popup: (age) => age,
      last: "3 h ago",
    };

    // Same instant twice in a row — fixAge would produce the same string both
    // times, so neither surface should be touched the second time.
    refreshAges([label], at.getTime());
    refreshAges([label], at.getTime());

    expect(calls.length).toBeLessThanOrEqual(2);
  });
});

describe("a marker's title follows its age", () => {
  it("rewrites the title on the element AND in the options, so a rebuilt icon keeps it", () => {
    const attrs: Record<string, string> = {};
    const marker = { options: {} as { title?: string }, getElement: () => ({ setAttribute: (k: string, v: string) => { attrs[k] = v; } }) };
    const at = new Date("2026-09-23T00:00:00Z");
    const label: AgeLabel = {
      at,
      layer: { setPopupContent: () => {} } as unknown as AgeLabel["layer"],
      popup: (age) => age,
      title: { marker: marker as unknown as NonNullable<AgeLabel["title"]>["marker"], text: (age) => `Bob, clanmate, ${age}` },
    };

    refreshAges([label], at.getTime() + 3 * 3600_000);

    expect(attrs.title).toBe("Bob, clanmate, 3 h ago");
    expect(marker.options.title).toBe("Bob, clanmate, 3 h ago");
  });
});

/**
 * ⚠️ A pin popup carries TWO clocks: its age and its expiry. The layer is
 * rebuilt only when the pins themselves change, so the tick is the only thing
 * that ever moves either one — an expiry closed over the draw-time `now` read
 * "expires in 6 d" the day before the pin went, beside an age that did move.
 */
describe("a pin popup's expiry follows the clock", () => {
  it("shows the new expiry when the tick runs two days later", async () => {
    const { drawPins } = await import("../app/(site)/map/map-draw");
    const popups: string[] = [];
    const marker = {
      options: {} as { title?: string },
      bindPopup(html: string) { popups.push(html); return marker; },
      setPopupContent(html: string) { popups.push(html); return marker; },
      on() { return marker; },
      addTo() { return marker; },
      getElement: () => undefined,
    };
    const L = { marker: () => marker, divIcon: (o: unknown) => ({ options: o }) } as unknown as typeof import("leaflet");
    const now = new Date("2026-09-23T00:00:00Z").getTime();
    const day = 24 * 3600_000;
    const ages: AgeLabel[] = [];
    const p = { gold: "#d9a03c", ink: "#e8e2d4", ink2: "#b5afa4", rust2: "#d4623a", olive: "#8fa36a", frame: "#0b0b0a", rule2: "#2a2825" };
    drawPins({
      L, group: {} as never, pt: (() => ({})) as never, now, ages, index: new Map(), p,
      data: { pins: [{ id: 1, x: 4321, z: 8765, icon: "loot", note: null, by: "Bob", at: new Date(now), expiresAt: new Date(now + 7 * day) }] } as never,
    });
    expect(popups.at(-1)).toContain("expires in 7 d");

    refreshAges(ages, now + 2 * day);

    expect(popups.at(-1)).toContain("expires in 5 d");
    expect(popups.at(-1)).not.toContain("expires in 7 d");
  });
});
