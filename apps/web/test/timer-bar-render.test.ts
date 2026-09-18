import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BaseDamageWindow } from "@factions/roster";
import { TimerBar } from "../app/components/timer-bar";

const FRI = new Date("2026-09-18T00:00:00.000Z");
const MON = new Date("2026-09-21T00:00:00.000Z");
const LAST_MON = new Date("2026-09-14T00:00:00.000Z");

/** Mid-window, and 47:12 short of the 16:00 slot, so both clocks read something specific. */
const NOW = new Date("2026-09-20T15:12:48.000Z");

const render = (window: BaseDamageWindow | undefined, restartsScheduled = true, now = NOW) =>
  renderToStaticMarkup(createElement(TimerBar, { window, restartsScheduled, now }));

const LIVE: BaseDamageWindow = { status: "live", opensAt: FRI, closesAt: MON, boundaryAt: FRI };
const CLOSED: BaseDamageWindow = { status: "closed", opensAt: FRI, closesAt: MON, boundaryAt: LAST_MON };

/**
 * The bar's first paint — what the server sends and what the client must hydrate
 * against. Snapshots, so a styling change is a diff to read rather than a
 * re-render nobody looked at; the ⚠️ cases below assert on the markup directly,
 * because "it changed" is not good enough for those.
 */
describe("the timer bar", () => {
  it("live", () => expect(render(LIVE)).toMatchSnapshot());
  it("closed", () => expect(render(CLOSED)).toMatchSnapshot());
  it("skipped", () => expect(render({ status: "skipped", opensAt: FRI, closesAt: MON, boundaryAt: FRI, skipReason: "launch weekend" })).toMatchSnapshot());
  it("unconfirmed", () => expect(render({ status: "unconfirmed", pending: "open", opensAt: FRI, closesAt: MON, boundaryAt: FRI })).toMatchSnapshot());

  /**
   * ⚠️ The whole point of the `unconfirmed` state. `bg-rust-2` is the fill that
   * says raiding is open; painting it when no flip was confirmed tells a player
   * to go raid and lets them find out otherwise by swinging at a wall.
   */
  it("⚠️ an unconfirmed window is never painted with the live fill", () => {
    const html = render({ status: "unconfirmed", pending: "open", opensAt: FRI, closesAt: MON, boundaryAt: FRI });
    expect(html).not.toContain("bg-rust-2");
    expect(html).toContain("Opening");
    expect(html).toContain("unconfirmed");
    expect(render(LIVE)).toContain("bg-rust-2");
  });

  /**
   * ⚠️ A live region would have a screen reader read every tick of the restart
   * clock, once a second, for as long as the page is open.
   */
  it("⚠️ is a labelled region, not a live one", () => {
    const html = render(LIVE);
    expect(html).toContain('role="region"');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain("aria-live");
  });

  it("seeds both clocks from the render's own instant", () => {
    const html = render(LIVE);
    expect(html).toContain("47:12"); // 15:12:48 -> the 16:00 restart slot
    expect(html).toContain(">8h<");  // Sunday 15:12 -> the Monday 00:00 close, coarse
  });

  it("gives the raid column the full width when no restart is scheduled", () => {
    const html = render(LIVE, false);
    expect(html).toContain("grid-cols-1");
    expect(html).not.toContain("Server restart");
  });

  it("keeps the restart column when the raid read failed", () => {
    const html = render(undefined, true);
    expect(html).toContain("Server restart");
    expect(html).toContain("grid-cols-1");
    expect(html).not.toContain(">Raid<");
  });

  // Nothing to show renders nothing, as the strips above it do.
  it("renders nothing at all when neither column has anything to say", () => {
    expect(render(undefined, false)).toBe("");
  });
});
