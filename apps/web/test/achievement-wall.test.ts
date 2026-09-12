import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AchievementTile } from "@factions/roster";
import { Tile } from "../app/components/achievement-wall";
import { AchievementToast } from "../app/components/achievement-toast";

const tile = (o: Partial<AchievementTile>): AchievementTile =>
  ({ key: "ten_down", name: "Ten Down", description: "Get 10 PvP kills", group: "pvp", owner: "player", target: 10, unit: "count", earnedAt: null, count: 3, clanTag: null, ...o });
const render = (t: AchievementTile) => renderToStaticMarkup(createElement(Tile, { t }));

/**
 * The three tile states, pinned as snapshots (design hand-off §02): earned in
 * the group colour, in progress with the badge's ring and no separate bar,
 * locked one-shot in grey with "Locked" said in words.
 */
describe("the wall tile", () => {
  it("earned", () => {
    expect(render(tile({ earnedAt: new Date("2026-09-10T12:00:00Z"), count: 10 }))).toMatchSnapshot();
  });
  it("in progress", () => {
    expect(render(tile({}))).toMatchSnapshot();
  });
  it("locked one-shot", () => {
    expect(render(tile({ key: "first_blood", name: "First Blood", description: "Your first PvP kill", target: 1, count: 0 }))).toMatchSnapshot();
  });

  it("an earned tile is framed and named in its group's colour, never dimmed", () => {
    const html = render(tile({ group: "pve", key: "ironman", name: "Ironman", earnedAt: new Date("2026-09-10T12:00:00Z"), count: 5, target: 5 }));
    expect(html).toContain("border-achievement-pve");
    expect(html).toContain("bg-achievement-pve/6");
    expect(html).toMatch(/class="font-display[^"]*text-achievement-pve"[^>]*>Ironman</u);
    expect(html).not.toContain("opacity-70");
  });
  it("progress is the badge's ring, not a bar", () => {
    const html = render(tile({ count: 4 }));
    expect(html).toContain('stroke-dasharray="40 100"');
    expect(html).not.toMatch(/style="width:/u);
    expect(html).toContain("3 / 10".replace("3", "4"));
  });
  it("a locked one-shot says Locked and draws the grey badge", () => {
    const html = render(tile({ key: "first_blood", target: 1, count: 0 }));
    expect(html).toContain(">Locked<");
    expect(html).toContain('stroke="#4a4640"');
    expect(html).not.toContain("opacity-70");
  });
  it("keeps the accessible name with the state in it", () => {
    expect(render(tile({}))).toContain('aria-label="Ten Down: 3 / 10"');
    expect(render(tile({ key: "first_blood", target: 1, count: 0 }))).toContain('aria-label="Ten Down: Locked"');
    expect(render(tile({ earnedAt: new Date("2026-09-10T12:00:00Z"), count: 10 }))).toContain('aria-label="Ten Down: Earned 10 Sept"');
  });
});

describe("the unlock toast", () => {
  it("is a status line with the unlocked badge, the group kicker in colour, the name and the description", () => {
    const html = renderToStaticMarkup(createElement(AchievementToast, { t: { ...tile({}), earnedAt: new Date("2026-09-10T12:00:00Z"), count: 10 } }));
    expect(html).toMatch(/^<div role="status" class="[^"]*border-2 bg-frame[^"]*border-achievement-pvp"/u);
    expect(html).toMatch(/text-achievement-pvp"[^>]*>Achievement unlocked · Combat</u);
    expect(html).toMatch(/font-display text-\[18px\] uppercase[^"]*"[^>]*>Ten Down</u);
    expect(html).toContain(">Get 10 PvP kills<");
    expect(html).toContain('stroke="#d4623a"');
  });
});
