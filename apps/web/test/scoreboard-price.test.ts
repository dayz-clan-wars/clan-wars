import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ScoreboardRow } from "@factions/roster";
import { RaidPrices } from "../app/components/raid-prices";

const row = (o: Partial<ScoreboardRow> = {}): ScoreboardRow => ({
  rank: 1, tag: "Z2", name: "Zone 2", texture: "Flag_Bear", status: "active", points: 400, raids: 2, timesRaided: 1, defenses: 1, alpha: false,
  price: { payout: 148, online: false, recentRaids: 9, hitsThisWeek: 1, newUntil: null }, ...o,
});

describe("/scoreboard's raid-price list", () => {
  const html = renderToStaticMarkup(createElement(RaidPrices, { rows: [
    row({ tag: "LOW", price: { payout: 50, online: false, recentRaids: 0, hitsThisWeek: 0, newUntil: null } }),
    row(),
    row({ tag: "NDF", price: { payout: 296, online: true, recentRaids: 0, hitsThisWeek: 0, newUntil: null } }),
    row({ tag: "SLEEP", status: "dormant", price: null }),
  ] }));

  it("shows the same title, rows and order as the #scoreboard post", () => {
    expect(html).toContain("What a raid pays right now");
    expect(html.indexOf("NDF · 296")).toBeLessThan(html.indexOf("Z2 · 148 · 🔥 9 recent raids · 🩹 raided 1 time this week"));
    expect(html.indexOf("Z2 · 148")).toBeLessThan(html.indexOf("LOW · 50"));
  });
  it("names dormant clans and explains the symbols", () => {
    expect(html).toContain("Can&#x27;t be raided: SLEEP");
    expect(html).toContain("🔥 raids in the last 14 days push it up");
  });
});
