import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlayerFeed, WarLogEntry } from "@factions/roster";
import { WarLogKicker } from "../app/(site)/war-log/entry";
import { PlayerFeedPanel } from "../app/components/player-feed";
import { when } from "../lib/format";

const AT = new Date("2026-09-07T22:14:00Z");

/** M5: `when()` says UTC; the war-log kicker (landing, clan pages) and the player feed printed the same UTC clock without saying so. */
describe("every stamp says UTC", () => {
  it("the war-log kicker", () => {
    const e: WarLogEntry = { kind: "raid", at: AT, raider: null, victim: { tag: "BBB", name: "Bravo", texture: "Flag_Wolf" }, gamertag: null, points: 0, lowers: 1 };
    const html = renderToStaticMarkup(createElement(WarLogKicker, { e }));
    expect(html).toContain(when(AT));
    expect(html).toMatch(/UTC/u);
  });

  it("the player feed", () => {
    const feed: PlayerFeed = { gamertag: "Ron", scope: { kind: "all" }, seasons: [], page: 1, perPage: 25, entries: [{ kind: "raised", at: AT }], hasNext: false };
    const html = renderToStaticMarkup(createElement(PlayerFeedPanel, { feed, basePath: "/players/Ron" }));
    expect(html).toContain(when(AT));
  });
});
