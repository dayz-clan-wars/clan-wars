import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BaseDamageWindow } from "@factions/roster";
import { MapTimers } from "../app/(site)/map/map-timers";
import { timerColumns } from "../lib/timer-bar";

const FRI = new Date("2026-09-18T00:00:00.000Z");
const MON = new Date("2026-09-21T00:00:00.000Z");
const LAST_MON = new Date("2026-09-14T00:00:00.000Z");
/** 47:12 short of the 16:00 slot, as in timer-bar-render.test.ts. */
const NOW = new Date("2026-09-20T15:12:48.000Z");

const LIVE: BaseDamageWindow = { status: "live", opensAt: FRI, closesAt: MON, boundaryAt: FRI };
const CLOSED: BaseDamageWindow = { status: "closed", opensAt: FRI, closesAt: MON, boundaryAt: LAST_MON };

const render = (w: BaseDamageWindow | undefined, restarts: boolean, variant: "bar" | "row" = "bar") =>
  renderToStaticMarkup(createElement(MapTimers, { columns: timerColumns(w, restarts, NOW), variant }));

/** The map's compact clocks: the timer bar's two columns, in the map's own bar once the strips stand down. */
describe("the map's clocks", () => {
  it("shows both, from one clock read", () => {
    const html = render(CLOSED, true);
    expect(html).toContain("Starts in");
    expect(html).toContain("Restart");
    expect(html).toContain("47:12");
  });

  it("paints a live window rust, like the bar", () => expect(render(LIVE, true)).toContain("bg-rust-2"));

  it("⚠️ never paints an unconfirmed window live", () => {
    const html = render({ status: "unconfirmed", pending: "open", opensAt: FRI, closesAt: MON, boundaryAt: FRI }, true);
    expect(html).not.toContain("bg-rust-2");
    expect(html).toContain("unconfirmed");
  });

  it("⚠️ shows no restart clock when none is scheduled", () => {
    expect(render(CLOSED, false)).not.toContain("Restart");
  });

  it("renders nothing with nothing to show", () => {
    expect(render(undefined, false)).toBe("");
    expect(render(undefined, false, "row")).toBe("");
  });

  it("is not a live region: the restart clock moves every second", () => {
    expect(render(CLOSED, true, "row")).not.toContain('role="status"');
  });
});
