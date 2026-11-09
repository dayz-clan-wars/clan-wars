import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TimerBar } from "../app/components/timer-bar";

/** 47:12 short of the 16:00 slot, so the clock reads something specific. */
const NOW = new Date("2026-09-20T15:12:48.000Z");

const render = (restartsScheduled = true, now = NOW) =>
  renderToStaticMarkup(createElement(TimerBar, { restartsScheduled, now }));

/**
 * The bar's first paint — what the server sends and what the client must hydrate
 * against. A snapshot, so a styling change is a diff to read rather than a
 * re-render nobody looked at.
 */
describe("the timer bar", () => {
  it("restart", () => expect(render()).toMatchSnapshot());

  /**
   * ⚠️ A live region would have a screen reader read every tick of the restart
   * clock, once a second, for as long as the page is open.
   */
  it("⚠️ is a labelled region, not a live one", () => {
    const html = render();
    expect(html).toContain('role="region"');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain("aria-live");
  });

  it("seeds the clock from the render's own instant", () => {
    expect(render()).toContain("47:12"); // 15:12:48 -> the 16:00 restart slot
  });

  // Raiding is 24/7: there is no raid window to count down any more.
  it("carries no raid column", () => {
    expect(render()).not.toContain(">Raid<");
  });

  // Nothing to show renders nothing, as the strips above it do.
  it("renders nothing at all when no restart is scheduled", () => {
    expect(render(false)).toBe("");
  });
});
