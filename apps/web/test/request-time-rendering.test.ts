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
const pages = readdirSync(APP, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith("page.tsx"))
  .map((f) => join(APP, f))
  .filter((f) => existsSync(f));

describe("pages that depend on the viewer render at request time", () => {
  const viewerPages = pages.filter((f) => readFileSync(f, "utf8").includes("currentSession("));
  it("finds at least /me", () => {
    expect(viewerPages.some((f) => f.endsWith(`${join("me", "page.tsx")}`))).toBe(true);
  });
  it.each(viewerPages)("%s is force-dynamic", (file) => {
    expect(readFileSync(file, "utf8")).toMatch(/export const dynamic = "force-dynamic"/u);
  });
});
