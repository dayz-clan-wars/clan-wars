import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  /**
   * F8 (2026-09-24 review): /link's "Linked on …" date is a client component
   * formatting a server-sent instant — a browser in another zone rendered a
   * different string than the server did with no `timeZone`, a hydration
   * mismatch as well as a UTC-rule break. Source test: `Verified` isn't
   * exported (LinkFlow is the module's one export, and reaching it needs a
   * "verified" status this test has no fixture for), so this pins the call
   * site directly rather than fabricate one.
   */
  it("⚠️ /link's Verified date is UTC, explicitly — a client component may render in any browser zone", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "link", "link-flow.tsx"), "utf8");
    expect(src).toMatch(/toLocaleDateString\("en-GB",\s*\{[^}]*timeZone:\s*"UTC"[^}]*\}\)\s*\}\s*UTC\./u);
  });
});
