import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serverStripLines, SERVER_STRIP, marqueeSeconds } from "../lib/server-strip";

/**
 * The strip under the top bar that names the server: one line, "SERVER
 * NAME: <name>", scrolling as a marquee. The name is the in-game one as
 * Nitrado last reported it, so a rename shows up without a deploy. Under
 * prefers-reduced-motion the same line sits still.
 */
describe("serverStripLines", () => {
  it("makes one 'Server name: …' line per live server, the name verbatim", () => {
    expect(serverStripLines([
      { hostname: ".::CLAN WARS::. - custom bot", map: "livonia", seenAt: new Date() },
      { hostname: "Second | Xbox", map: "chernarus", seenAt: new Date() },
    ])).toEqual(["Server name: .::CLAN WARS::. - custom bot", "Server name: Second | Xbox"]);
    expect(SERVER_STRIP.label).toBe("Server name:");
  });

  it("scrolls slower for a longer line, never faster than a reader can follow", () => {
    expect(marqueeSeconds("Server name: Short")).toBe(12);
    expect(marqueeSeconds("Server name: " + "x".repeat(80))).toBeGreaterThan(marqueeSeconds("Server name: " + "x".repeat(40)));
  });
});

describe("the strip component", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "app", "components", "server-strip.tsx"), "utf8");
  it("is a server component with no button — nothing to click, nothing to hydrate", () => {
    expect(src).not.toContain('"use client"');
    expect(src).not.toMatch(/<button/u);
  });
  it("rests under prefers-reduced-motion", () => {
    const css = readFileSync(join(import.meta.dirname, "..", "app", "globals.css"), "utf8");
    expect(src).toContain("cw-marquee");
    expect(css).toMatch(/@keyframes cw-marquee/u);
    expect(css).toMatch(/prefers-reduced-motion: reduce\)[^}]*\.cw-marquee[^}]*animation: none/u);
  });
});

describe("the strip is in both shells", () => {
  const app = join(import.meta.dirname, "..", "app");
  it.each([join("(site)", "layout.tsx"), join("guide", "layout.tsx")])("%s renders ServerStrip under the bar", (rel) => {
    const text = readFileSync(join(app, rel), "utf8");
    expect(text).toMatch(/<ServerStrip\b/u);
    expect(text).toContain("liveServers()");
    // Never a reason to fail the page: the strip is a convenience.
    expect(text).toMatch(/liveServers\(\)\.catch\(/u);
    expect(text.indexOf("<SiteBar")).toBeLessThan(text.indexOf("<ServerStrip"));
  });
});

/**
 * M1, WCAG 2.2.2: moving text lasting over five seconds needs a way to pause
 * it. `:hover` alone is no way at all on a phone or a keyboard.
 */
describe("the marquee can be stopped", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "app", "globals.css"), "utf8");
  const src = readFileSync(join(import.meta.dirname, "..", "app", "components", "server-strip.tsx"), "utf8");

  it("⚠️ runs two passes and stops, never infinite", () => {
    expect(css).toMatch(/\.cw-marquee\s*\{\s*animation:\s*cw-marquee\s+\d+s\s+linear\s+2;/u);
    expect(css).not.toMatch(/cw-marquee[^;]*infinite/u);
  });

  it("⚠️ pauses on focus as well as hover, and the strip is focusable by Tab or tap", () => {
    expect(css).toMatch(/\.cw-marquee-host:focus \.cw-marquee/u);
    expect(css).toMatch(/\.cw-marquee-host:hover \.cw-marquee/u);
    expect(src).toContain("tabIndex={0}");
    expect(src).toContain("cw-marquee-host");
  });
});
