import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NotificationsBell } from "../app/components/notifications-bell";
import { POPOVER_GROUP, othersThan, toDismiss } from "../lib/popover";

const APP = join(import.meta.dirname, "..", "app");
const read = (...p: string[]) => readFileSync(join(APP, ...p), "utf8");
const bell = renderToStaticMarkup(createElement(NotificationsBell, { unread: 0, recent: [] }));

/**
 * H1 (2026-09-24, confirmed live at 375px): the bell's panel hung `right-0`
 * off a bell that sits LEFT of Menu, so its first ~55px were off the screen;
 * the guide's Contents did the same. Below lg both now pin to the viewport.
 */
describe("the bar's popovers on a phone", () => {
  it("⚠️ the bell's panel is pinned to the viewport below lg, and anchored to the bell only from lg", () => {
    expect(bell).toMatch(/class="fixed inset-x-3 top-\[calc\(var\(--spacing-bar\)\+8px\)\][^"]*lg:absolute lg:inset-x-auto lg:right-0/u);
    expect(bell).not.toContain("w-[340px]");
  });

  it("offsets from --spacing-bar, never a hand-typed bar height (L3)", () => {
    expect(bell).not.toContain("top-[54px]");
    expect(read("(site)", "menu-list.tsx")).not.toContain("top-[60px]");
    expect(read("(site)", "menu-list.tsx")).toContain("top-[calc(var(--spacing-bar)+8px)]");
  });

  it("the guide's Contents panel is pinned the same way", () => {
    const layout = read("guide", "layout.tsx");
    expect(layout).toContain("fixed inset-x-3 top-[calc(var(--spacing-bar)+8px)]");
    expect(layout).not.toContain("absolute right-0 top-[calc(100%+8px)]");
  });
});

describe("one popover at a time", () => {
  it("⚠️ Menu, the bell and Contents share one exclusive <details> group", () => {
    expect(bell).toContain(`name="${POPOVER_GROUP}"`);
    expect(read("(site)", "menu-list.tsx")).toMatch(/<details[^>]*name=\{POPOVER_GROUP\}/u);
    expect(read("guide", "layout.tsx")).toMatch(/<details[^>]*name=\{POPOVER_GROUP\}/u);
  });

  it("the bar mounts the one dismiss handler", () => {
    expect(read("(site)", "site-bar.tsx")).toMatch(/<PopoverDismiss\s*\/>/u);
  });

  it("opening one closes every other", () => {
    const menu = { id: "menu" }, bellPanel = { id: "bell" }, contents = { id: "contents" };
    expect(othersThan([menu, bellPanel, contents], bellPanel)).toEqual([menu, contents]);
  });

  it("a click closes the open ones that do not contain it, and keeps the one it landed in", () => {
    const inside = { contains: (n: unknown) => n === "target" };
    const outside = { contains: () => false };
    expect(toDismiss([inside, outside], "target")).toEqual([outside]);
  });
});
