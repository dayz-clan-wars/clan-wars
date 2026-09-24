import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The first-map hint sat in the middle of a phone screen, exactly where
 * "you" lands after Center on me, and its ✕ was 36px.
 */
const view = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "map", "map-view.tsx"), "utf8");
const hint = view.match(/<div role="note"[^>]*>[\s\S]*?<\/div>\s*<p/u)?.[0] ?? "";

describe("the first-map hint", () => {
  it("is found", () => expect(hint).not.toBe(""));

  it("sits above the phone bar, never mid-screen", () => {
    expect(hint).not.toContain("top-[calc(50%-40px)]");
    expect(hint).toContain("bottom-[calc(var(--cw-inset,0px)+12px)]");
  });

  it("has a 44px dismiss", () => {
    expect(hint).toMatch(/onClick=\{dismissHint\} className="[^"]*\bh-11 w-11\b/u);
    expect(hint).not.toContain("h-9 w-9");
  });
});
