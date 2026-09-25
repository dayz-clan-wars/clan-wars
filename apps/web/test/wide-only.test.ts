import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WideOnly } from "../app/components/wide-only";

const WEB = join(import.meta.dirname, "..");

/**
 * H5: the landing page's Flag pool was `hidden lg:block`, and a browser still
 * fetches every <img> inside a CSS-hidden panel — a phone downloaded the whole
 * pool and never showed it. Not rendering it is the only fix a phone obeys.
 */
describe("WideOnly", () => {
  it("⚠️ renders nothing on the server, so a phone never receives the <img> tags", () => {
    const html = renderToStaticMarkup(createElement(WideOnly, { children: createElement("img", { src: "/flags/thumb/Flag_Wolf.webp", alt: "" }) }));
    expect(html).toBe("");
  });

  it("⚠️ asks for Tailwind's lg exactly, in rem so it never drifts from a non-16px root font", () => {
    expect(readFileSync(join(WEB, "app", "components", "wide-only.tsx"), "utf8")).toContain('"(min-width: 64rem)"');
  });

  it("wraps the landing page's flag pool, which no longer needs a CSS hide", () => {
    const page = readFileSync(join(WEB, "app", "(site)", "page.tsx"), "utf8");
    expect(page).toMatch(/<WideOnly>\s*<Panel num="03" title="Flag pool"/u);
    expect(page).not.toMatch(/title="Flag pool"[^>]*hidden lg:block/u);
  });
});
