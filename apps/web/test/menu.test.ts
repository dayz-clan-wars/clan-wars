import { describe, it, expect } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { barFor, isCurrent, menuFor, signInHref } from "../lib/menu";

/**
 * The site's navigation (app/(site)/site-bar.tsx, menu-list.tsx) is the
 * only way around once signed in; before it, every page was a dead end.
 * Its contents are a function of signed-in state, pinned here so a route
 * cannot quietly fall out of it — nobody reports a link that is merely
 * missing.
 */
describe("menuFor (the phone drawer)", () => {
  it("signed in: your places first, then the boards, then the guide", () => {
    expect(menuFor(true).map((g) => g.map((m) => m.href))).toEqual([
      ["/me", "/map", "/clan", "/notifications"],
      ["/clans", "/players", "/scoreboard", "/alphas", "/seasons", "/war-log"],
      ["/guide"],
    ]);
  });

  it("has Notifications, unlike the bar — the bar already has the bell", () => {
    const [mine] = menuFor(true);
    expect(mine!.some((m) => m.href === "/notifications")).toBe(true);
  });

  it("anonymous: the boards and the guide — nothing gated", () => {
    expect(menuFor(false)).toEqual(menuFor(true).slice(1));
  });
});

describe("barFor (the desktop bar)", () => {
  it("is the short form: Alphas and Seasons live in the scoreboard's own nav", () => {
    expect(barFor(true).map((g) => g.map((m) => m.href))).toEqual([
      ["/me", "/map", "/clan"],
      ["/clans", "/players", "/scoreboard", "/war-log", "/guide"],
    ]);
    expect(barFor(false)).toEqual(barFor(true).slice(1));
  });

  it("⚠️ Kit is in neither nav list", () => {
    // It means nothing to anyone who is not boosting, and the bar is already
    // full at 1024px (see the `quiet` flag's own comment in menu.ts). The way
    // in is the owner's player page instead.
    for (const signedIn of [true, false]) {
      const all = [...menuFor(signedIn).flat(), ...barFor(signedIn).flat()];
      expect(all.filter((i) => i.href === "/kit")).toEqual([]);
    }
  });

  it("does NOT have Notifications — the bell (site-bar.tsx) already covers it, and there is no room for a tenth cell", () => {
    const [mine] = barFor(true);
    expect(mine!.some((m) => m.href === "/notifications")).toBe(false);
  });

  it("Scoreboard owns /alphas and /seasons; /clan does not own /clans", () => {
    const [mine, boards] = barFor(true);
    const scoreboard = boards!.find((m) => m.href === "/scoreboard")!;
    expect(isCurrent(scoreboard, "/alphas")).toBe(true);
    expect(isCurrent(scoreboard, "/seasons")).toBe(true);
    expect(isCurrent(scoreboard, "/scoreboard")).toBe(true);
    const clan = mine!.find((m) => m.href === "/clan")!;
    expect(isCurrent(clan, "/clan/vault")).toBe(true);
    expect(isCurrent(clan, "/clans")).toBe(false);
    expect(isCurrent(clan, "/clans/WTC")).toBe(false);
  });
});

describe("signInHref", () => {
  it("carries the current path back", () => {
    expect(signInHref("/clans/WTC")).toBe("/login?next=%2Fclans%2FWTC");
    expect(signInHref("/scoreboard?x=1")).toBe("/login?next=%2Fscoreboard%3Fx%3D1");
  });
});

/**
 * ⚠️ The (site) layout reads the session, which makes everything under it
 * request-time rendered. Since the redesign the landing page is live too
 * (scoreboard, war log and flag pool on it), so it lives in the group; the
 * guide reads the session for its bar as well, but keeps its own layout.
 * What must not happen is a second, session-less copy of the bar appearing
 * somewhere — so the root holds nothing but the group, the guide and api.
 */
describe("the route tree", () => {
  const app = join(import.meta.dirname, "..", "app");
  it("puts every page under (site) except the guide", () => {
    const top = readdirSync(app, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    expect(top).toEqual(["(site)", "api", "components", "guide"]);
    expect(existsSync(join(app, "page.tsx"))).toBe(false);
    expect(existsSync(join(app, "(site)", "page.tsx"))).toBe(true);
    expect(existsSync(join(app, "(site)", "layout.tsx"))).toBe(true);
  });
});
