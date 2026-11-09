import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MapTimers } from "../app/(site)/map/map-timers";
import { timerColumns } from "../lib/timer-bar";

/** 47:12 short of the 16:00 slot, as in timer-bar-render.test.ts. */
const NOW = new Date("2026-09-20T15:12:48.000Z");

const render = (restarts: boolean, variant: "bar" | "row" = "bar") =>
  renderToStaticMarkup(createElement(MapTimers, { columns: timerColumns(restarts, NOW), variant }));

/** The map's compact clock: the timer bar's restart column, in the map's own bar once the strips stand down. */
describe("the map's clock", () => {
  it("shows the restart clock from one clock read", () => {
    const html = render(true);
    expect(html).toContain("Restart");
    expect(html).toContain("47:12");
    expect(html).not.toContain(">Raid<");
  });

  it("⚠️ renders nothing when no restart is scheduled", () => {
    expect(render(false)).toBe("");
    expect(render(false, "row")).toBe("");
  });

  it("is not a live region: the restart clock moves every second", () => {
    expect(render(true, "row")).not.toContain('role="status"');
  });
});
