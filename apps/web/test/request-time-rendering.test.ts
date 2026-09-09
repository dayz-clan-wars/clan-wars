import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Frontend rebuild §7, the static-rendering trap: middleware.ts gates routes,
 * not content. A gated page that is built statically bakes its data into a
 * chunk under /_next/static that anyone can fetch. ⚠️ There is no error, log
 * line or runtime signal for this — so it is pinned structurally: every page
 * that reads the viewer must opt out of static rendering.
 */
const APP = join(import.meta.dirname, "..", "app");
// ⚠️ layout.tsx too, not just page.tsx: a layout that reads the viewer needs
// to opt out of static rendering exactly as much as a page does — Next
// composes them, and a statically-rendered layout bakes its data into the
// same shared chunk.
const pages = readdirSync(APP, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith("page.tsx") || f.endsWith("layout.tsx"))
  .map((f) => join(APP, f))
  .filter((f) => existsSync(f));

describe("pages that depend on the viewer render at request time", () => {
  // ⚠️ viewerFor( too: `currentSession(` reads the auth cookie, but a page
  // can go straight to `@factions/roster`'s `viewerFor` for clan/link data
  // without ever calling `currentSession` itself — either one makes the
  // page viewer-dependent.
  const viewerPages = pages.filter((f) => {
    const text = readFileSync(f, "utf8");
    return text.includes("currentSession(") || text.includes("viewerFor(") || text.includes('from "@factions/roster"');
  });
  it("finds at least /players/[gamertag]", () => {
    expect(viewerPages.some((f) => f.endsWith(`${join("[gamertag]", "page.tsx")}`))).toBe(true);
  });
  it.each(viewerPages)("%s is force-dynamic", (file) => {
    expect(readFileSync(file, "utf8")).toMatch(/export const dynamic = "force-dynamic"/u);
  });
});
