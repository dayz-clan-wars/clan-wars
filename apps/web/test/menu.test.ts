import { describe, it, expect } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { menuFor, signInHref } from "../lib/menu";

/**
 * The site menu (app/(site)/site-bar.tsx) is the only navigation a signed-in
 * player has; before it, every page was a dead end. Its contents are one
 * function of signed-in state, pinned here so a route cannot quietly fall
 * out of it — nobody reports a link that is merely missing.
 */
describe("menuFor", () => {
  it("signed in: your places first, then the public boards, the guide, then sign out", () => {
    expect(menuFor(true)).toEqual([
      [
        { label: "You", href: "/me" },
        { label: "Map", href: "/map" },
        { label: "Your clan", href: "/clan" },
      ],
      [
        { label: "Clans", href: "/clans" },
        { label: "Players", href: "/players" },
        { label: "Scoreboard", href: "/scoreboard" },
        { label: "Alphas", href: "/alphas" },
        { label: "Seasons", href: "/seasons" },
        { label: "War log", href: "/war-log" },
      ],
      [{ label: "Field guide", href: "/guide" }],
    ]);
  });

  it("anonymous: the public boards and the guide — nothing gated", () => {
    const groups = menuFor(false);
    expect(groups).toEqual(menuFor(true).slice(1));
    for (const item of groups.flat()) expect(["/me", "/map", "/clan"]).not.toContain(item.href);
  });

  it("the sign-in link carries the current path back", () => {
    expect(signInHref("/clans/WTC")).toBe("/login?next=%2Fclans%2FWTC");
    expect(signInHref("/scoreboard?x=1")).toBe("/login?next=%2Fscoreboard%3Fx%3D1");
  });
});

/**
 * ⚠️ The (site) layout reads the session, which makes everything under it
 * request-time rendered. The landing page and the guide are static on
 * purpose (nothing on them depends on the viewer), so they must stay OUTSIDE
 * the group — moving them in would cost nothing visible and make every
 * guide chapter a per-request render.
 */
describe("the (site) route group", () => {
  const app = join(import.meta.dirname, "..", "app");
  it("holds every page except the landing page and the guide", () => {
    const top = readdirSync(app, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    expect(top).toEqual(["(site)", "api", "components", "guide"]);
    expect(existsSync(join(app, "page.tsx"))).toBe(true);
    expect(existsSync(join(app, "(site)", "layout.tsx"))).toBe(true);
    expect(existsSync(join(app, "(site)", "page.tsx"))).toBe(false);
  });
});
