import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AchievementBadge, SHIELD, clampPct } from "../app/components/achievement-badge";

const render = (props: Partial<Parameters<typeof AchievementBadge>[0]>) =>
  renderToStaticMarkup(createElement(AchievementBadge, { achievementKey: "sniper", group: "pvp", state: "unlocked", ...props }));
const shields = (html: string) => html.split(`d="${SHIELD}"`).length - 1;

describe("AchievementBadge", () => {
  it("draws the shield once when unlocked or locked, and twice — the ring — only in progress", () => {
    expect(shields(render({ state: "unlocked" }))).toBe(1);
    expect(shields(render({ state: "locked" }))).toBe(1);
    expect(shields(render({ state: "progress", pct: 40 }))).toBe(2);
  });
  it("the ring's dash is the percentage over a pathLength of 100", () => {
    expect(render({ state: "progress", pct: 40 })).toMatch(/pathLength="100"[^>]*stroke-dasharray="40 100"/u);
  });
  it("clamps pct to 0–100", () => {
    expect(render({ state: "progress", pct: 250 })).toContain('stroke-dasharray="100 100"');
    expect(render({ state: "progress", pct: -5 })).toContain('stroke-dasharray="0 100"');
    expect(render({ state: "progress" })).toContain('stroke-dasharray="0 100"');
    expect(clampPct(33.4)).toBe(33);
    expect(clampPct(NaN)).toBe(0);
  });
  it("colours by group when unlocked, grey when locked, and never names a coordinate", () => {
    const unlocked = render({ state: "unlocked", group: "pve" });
    expect(unlocked).toContain('stroke="#8fa36a"');
    expect(unlocked).toContain('fill="#8fa36a1f"');
    const locked = render({ state: "locked", group: "pve" });
    expect(locked).not.toContain("#8fa36a");
    expect(locked).toContain('stroke="#4a4640"');
    expect(render({ state: "progress", group: "pve" })).toContain('stroke="#8a857c"');
  });
  it("is hidden from assistive tech — the tile carries the name", () => {
    expect(render({})).toMatch(/^<svg aria-hidden="true"/u);
  });
  it("draws the key's glyph under the hand-off transform", () => {
    expect(render({ achievementKey: "first_blood" })).toContain('<g transform="translate(17 15) scale(1.25)"><path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 3v5M12 16v5M3 12h5M16 12h5"');
  });
});
