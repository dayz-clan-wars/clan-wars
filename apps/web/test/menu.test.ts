import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isCurrent, menuFor, signInHref } from "../lib/menu";

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
      ["/clans", "/players", "/scoreboard", "/alphas", "/seasons", "/live", "/war-log", "/radio"],
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

describe("one menu at every width", () => {
  const site = (f: string) => readFileSync(join(import.meta.dirname, "..", "app", "(site)", f), "utf8");

  it("has no separate desktop list: the drawer's list is the only one", async () => {
    const menu = await import("../lib/menu");
    expect("barFor" in menu).toBe(false);
    expect(site("menu-list.tsx")).not.toMatch(/export function BarNav/u);
  });

  it("⚠️ the Menu button is never hidden on desktop", () => {
    // It used to sit in an lg:hidden group beside an inline nav; with the nav
    // gone, hiding it again would leave a desktop visitor with no way around.
    // The div that wraps the Drawer: the last one opened before it, ignoring divs that close on their own line.
    const bar = site("site-bar.tsx").split("\n").filter((l) => !/<div[^>]*>.*<\/div>/u.test(l)).join("\n");
    expect(bar).toMatch(/<Drawer /u);
    const before = bar.slice(0, bar.indexOf("<Drawer "));
    expect(before.slice(before.lastIndexOf("<div"))).not.toMatch(/lg:hidden/u);
  });

  it("the wordmark and the crumb are no longer squeezed out on laptops", () => {
    const bar = site("site-bar.tsx");
    expect(bar).not.toMatch(/lg:max-xl:sr-only/u);
    expect(bar).toMatch(/text-muted lg:inline">\/ \{crumb\}/u);
  });

  it("a signed-out visitor keeps a Sign in button beside Menu", () => {
    expect(site("site-bar.tsx")).toMatch(/\{!signedIn && <SignInButton \/>\}/u);
  });

  it("⚠️ that Sign in is sm and up: at 375px it wrapped itself and the wordmark (phones have it in the drawer)", () => {
    const list = site("menu-list.tsx");
    const button = list.slice(list.indexOf("export function SignInButton"), list.indexOf("export function Drawer"));
    expect(button).toMatch(/className="hidden [^"]*sm:flex/u);
    expect(site("site-bar.tsx")).toMatch(/<span className="whitespace-nowrap">Clan Wars<\/span>/u);
  });

  it("the guide's Contents button stays phone-only (desktop has the sidebar)", () => {
    expect(site("site-bar.tsx")).toMatch(/\{extra && <div className="lg:hidden">\{extra\}<\/div>\}/u);
  });

  it("the drawer has both Live and War log, each its own item", () => {
    const boards = menuFor(false)[0]!;
    expect(boards.map((m) => m.label)).toContain("Live");
    expect(boards.map((m) => m.label)).toContain("War log");
  });

  it("⚠️ Kit is not in the menu", () => {
    // It means nothing to anyone who is not boosting. The way in is the owner's player page instead.
    for (const signedIn of [true, false]) expect(menuFor(signedIn).flat().filter((i) => i.href === "/kit")).toEqual([]);
  });

  it("/clan does not own /clans", () => {
    const clan = menuFor(true)[0]!.find((m) => m.href === "/clan")!;
    expect(isCurrent(clan, "/clan/vault")).toBe(true);
    expect(isCurrent(clan, "/clans")).toBe(false);
    expect(isCurrent(clan, "/clans/WTC")).toBe(false);
  });

  it("the guide is in the menu", () => {
    expect(menuFor(false).flat().some((m) => m.href === "/guide")).toBe(true);
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
