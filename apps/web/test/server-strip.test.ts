import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serverStripCopy, SERVER_STRIP } from "../lib/server-strip";

const now = new Date("2026-09-11T12:00:00Z");
const seen = new Date("2026-09-11T11:56:00Z");

/**
 * The strip under the top bar that names the server: the in-game name as
 * Nitrado last reported it, so a rename shows up on the site without a
 * deploy. Static text, not a marquee — a name is read at a glance and
 * copied into the DayZ browser's search, neither of which scrolling helps.
 */
describe("serverStripCopy", () => {
  it("names each server with its map, and says when the name was last confirmed", () => {
    expect(serverStripCopy([{ hostname: "Clan Wars Livonia | Xbox", map: "livonia", seenAt: seen }], now)).toEqual([
      { hostname: "Clan Wars Livonia | Xbox", map: "Livonia", seen: "confirmed 4 min ago" },
    ]);
  });

  it("capitalises the map without inventing a name for one it does not know", () => {
    const [a, b] = serverStripCopy([
      { hostname: "A", map: "chernarus", seenAt: seen },
      { hostname: "B", map: "namalsk", seenAt: seen },
    ], now);
    expect(a?.map).toBe("Chernarus");
    expect(b?.map).toBe("Namalsk");
  });

  it("has a label, a copy hint and a copied confirmation", () => {
    expect(SERVER_STRIP.label).toBe("Server");
    expect(SERVER_STRIP.copy).toBe("Copy name");
    expect(SERVER_STRIP.copyShort).toBe("Copy");
    expect(SERVER_STRIP.copied).toBe("Copied");
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
