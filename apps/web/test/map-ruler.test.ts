import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bearing, formatBearing, formatDistance, pathLength, rulerSummary, rulerTakesClick } from "../lib/map-ruler";
import { MapRuler, type MapRulerProps } from "../app/(site)/map/map-ruler";
import { drawRuler } from "../app/(site)/map/map-draw";

describe("pathLength", () => {
  it("adds the legs in metres", () => {
    expect(pathLength([{ x: 0, z: 0 }, { x: 300, z: 400 }])).toBe(500);
    expect(pathLength([{ x: 0, z: 0 }, { x: 300, z: 400 }, { x: 300, z: 0 }])).toBe(900);
  });
  it("is zero for one point or none", () => {
    expect(pathLength([])).toBe(0);
    expect(pathLength([{ x: 5, z: 5 }])).toBe(0);
  });
});

describe("bearing", () => {
  it("is 0 to the north (+z) and 90 to the east, clockwise", () => {
    expect(bearing({ x: 0, z: 0 }, { x: 0, z: 100 })).toBe(0);
    expect(bearing({ x: 0, z: 0 }, { x: 100, z: 0 })).toBe(90);
    expect(bearing({ x: 0, z: 0 }, { x: 0, z: -100 })).toBe(180);
    expect(bearing({ x: 0, z: 0 }, { x: -100, z: 0 })).toBe(270);
  });
});

describe("formatDistance", () => {
  it("says metres under a kilometre and kilometres to one place above", () => {
    expect(formatDistance(740)).toBe("740 m");
    expect(formatDistance(2300)).toBe("2.3 km");
    expect(formatDistance(999.6)).toBe("1.0 km");
    expect(formatDistance(0)).toBe("0 m");
  });
});

describe("formatBearing", () => {
  it("is three digits and a degree sign, like a compass", () => {
    expect(formatBearing(45.4)).toBe("045°");
    expect(formatBearing(359.7)).toBe("000°");
  });
});

describe("rulerSummary", () => {
  it("asks for points until there is a leg, then gives the total and the last leg's bearing", () => {
    expect(rulerSummary([])).toBe("Click or tap the map to start measuring.");
    expect(rulerSummary([{ x: 0, z: 0 }])).toBe("Click or tap to add the next point.");
    expect(rulerSummary([{ x: 0, z: 0 }, { x: 300, z: 400 }, { x: 1300, z: 400 }])).toBe("1.5 km · last leg 090°");
  });
});

describe("drawRuler", () => {
  it("draws the line, a dot per point and the summary at the last point", () => {
    const made: { kind: string; arg: unknown; opts?: Record<string, unknown> }[] = [];
    const layer = (kind: string) => (arg: unknown, opts?: Record<string, unknown>) => {
      const l = { kind, arg, opts, bindTooltip: (t: string) => { made.push({ kind: "tooltip", arg: t }); return l; }, addTo: () => l };
      made.push({ kind, arg, opts });
      return l;
    };
    const L = { polyline: layer("polyline"), circleMarker: layer("circleMarker") };
    let cleared = 0;
    const group = { clearLayers: () => { cleared++; } };
    drawRuler(L as never, group as never, (x, z) => ({ x, z }) as never, [{ x: 0, z: 0 }, { x: 0, z: 740 }], "#d");
    expect(cleared).toBe(1);
    expect(made.filter((m) => m.kind === "polyline")).toHaveLength(1);
    expect(made.filter((m) => m.kind === "circleMarker")).toHaveLength(2);
    expect(made.find((m) => m.kind === "tooltip")?.arg).toBe("740 m · last leg 000°");
  });

  it("draws nothing for no points", () => {
    const made: string[] = [];
    const L = { polyline: () => { made.push("p"); }, circleMarker: () => { made.push("c"); } };
    drawRuler(L as never, { clearLayers: () => {} } as never, (x, z) => ({ x, z }) as never, [], "#d");
    expect(made).toEqual([]);
  });
});

const base: MapRulerProps = { on: false, points: [], onToggle: () => {}, onClear: () => {}, variant: "panel" };
const render = (p: Partial<MapRulerProps>) => renderToStaticMarkup(createElement(MapRuler, { ...base, ...p }));

describe("MapRuler", () => {
  it("is a toggle named Ruler, with no Clear while off", () => {
    const html = render({});
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("Ruler");
    expect(html).not.toContain(">Clear<");
  });
  it("shows the summary and Clear while on", () => {
    const html = render({ on: true, points: [{ x: 0, z: 0 }, { x: 0, z: 740 }] });
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("740 m · last leg 000°");
    expect(html).toContain(">Clear<");
  });
});

describe("rulerTakesClick", () => {
  it("adds a point only with the ruler on and the pin sheet closed", () => {
    expect(rulerTakesClick(true, false)).toBe(true);
    expect(rulerTakesClick(true, true)).toBe(false);
    expect(rulerTakesClick(false, false)).toBe(false);
  });
  it("is what the map's click handler asks", () => {
    const view = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "map", "map-view.tsx"), "utf8");
    expect(view).toContain("if (!rulerTakesClick(rulerOnRef.current, pinSheetRef.current)) return;");
  });
});
