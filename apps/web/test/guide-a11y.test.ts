import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ChapterPage from "../app/guide/chapter";
import { Anchors, ANCHOR_COPIED } from "../app/guide/anchors";
import { GuideSearch, resultsLine, escapeAction } from "../app/guide/search";
import { CHAPTERS } from "../lib/guide";

describe("section anchors (L4)", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "app", "guide", "guide.css"), "utf8");

  it("⚠️ are always at full strength: a touch screen has no hover to reveal them, and a fade fails contrast", () => {
    const rule = css.match(/\.prose-guide h2 \.anchor\s*\{([^}]*)\}/u)?.[1] ?? "";
    expect(rule).toContain("color: var(--color-dim)");
    expect(css).not.toMatch(/\.anchor[^{]*\{[^}]*opacity/u);
  });

  it("⚠️ announce the copy, instead of copying silently", () => {
    expect(ANCHOR_COPIED).toBe("Link copied");
    expect(renderToStaticMarkup(createElement(Anchors))).toMatch(/<p role="status" aria-live="polite" class="sr-only"><\/p>/u);
  });
});

describe("the chapter pager (L7)", () => {
  it("says Previous, not Back, for the previous chapter", () => {
    const html = renderToStaticMarkup(createElement(ChapterPage, { chapter: CHAPTERS[1]! }));
    // `&larr;` in JSX is the character itself by the time it is markup.
    expect(html).toContain("← Previous");
    expect(html).not.toContain("← Back<");
  });
});

describe("guide search (L7)", () => {
  it("⚠️ announces how many results appeared", () => {
    expect(resultsLine("a", 0)).toBe("");
    expect(resultsLine("raid", 0)).toBe("No results");
    expect(resultsLine("raid", 1)).toBe("1 result");
    expect(resultsLine("raid", 7)).toBe("7 results");
    expect(renderToStaticMarkup(createElement(GuideSearch, { index: [] }))).toMatch(/role="status" aria-live="polite" class="sr-only"/u);
  });

  it("⚠️ Escape clears a non-empty query before it is let close the enclosing Contents popover", () => {
    expect(escapeAction("raid")).toBe("clear");
    expect(escapeAction("  raid  ")).toBe("clear");
    // The second press, once the query is already empty, bubbles to PopoverDismiss.
    expect(escapeAction("")).toBe("bubble");
    expect(escapeAction("   ")).toBe("bubble");
  });
});
