import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import config from "../next.config";
import { CHAPTERS, CONTENT_DIR, chapterBySlug, hrefFor, neighbours } from "../lib/guide";
import { renderFragment } from "../app/guide/render";

/**
 * The guide is the authority over every rule (CLAUDE.md, "Where things
 * live"), and since 2026-09-07 it is served from this app, not redirected to
 * its old host. The manifest is the one statement of chapter order; the
 * fragments are hand-written HTML. ⚠️ A fragment that still links to a
 * `.html` page is a link to the old, dead host.
 */
describe("the guide manifest", () => {
  it("has 14 chapters, unique slugs, chapter 1 at /guide, the numbers appendix last", () => {
    expect(CHAPTERS).toHaveLength(14);
    expect(new Set(CHAPTERS.map((c) => c.slug)).size).toBe(14);
    expect(CHAPTERS[0]!.slug).toBe("");
    expect(hrefFor(CHAPTERS[0]!)).toBe("/guide");
    expect(CHAPTERS[13]!.slug).toBe("numbers");
    expect(hrefFor(CHAPTERS[13]!)).toBe("/guide/numbers");
    expect(CHAPTERS.slice(0, 13).map((c) => c.number)).toEqual(Array.from({ length: 13 }, (_, i) => String(i + 1)));
    expect(CHAPTERS[13]!.number).toBe("A");
  });

  it("looks chapters up by slug and walks neighbours", () => {
    expect(chapterBySlug("")).toBe(CHAPTERS[0]);
    expect(chapterBySlug("bases")?.title).toBe("Bases");
    expect(chapterBySlug("nope")).toBeUndefined();
    expect(neighbours(CHAPTERS[0]!)).toEqual({ prev: undefined, next: CHAPTERS[1] });
    expect(neighbours(CHAPTERS[13]!)).toEqual({ prev: CHAPTERS[12], next: undefined });
  });
});

describe("the fragments", () => {
  it.each(CHAPTERS.map((c) => [c.file, c] as const))("%s exists and links only inside the site", (file) => {
    const path = join(CONTENT_DIR, file);
    expect(existsSync(path)).toBe(true);
    const html = readFileSync(path, "utf8");
    expect(html).not.toMatch(/href="[^"]*\.html/u);
    expect(html).not.toMatch(/<script/iu);
    // The shell renders these; a fragment carrying its own is a double.
    expect(html).not.toMatch(/class="(opener|pager|topbar|rail)"/u);
  });

  it("keeps the numbers table in the shape scripts/guide-numbers.ts parses", () => {
    const html = readFileSync(join(CONTENT_DIR, "numbers.html"), "utf8");
    const rows = html.match(/<tr><td>[^<]*<\/td><td class="v">[^<]*<\/td><\/tr>/gu) ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(40);
  });
});

describe("guide.css rides on @theme", () => {
  const dir = join(import.meta.dirname, "..", "app");
  const css = readFileSync(join(dir, "guide", "guide.css"), "utf8");
  const theme = readFileSync(join(dir, "globals.css"), "utf8").match(/@theme\s*\{([\s\S]*?)\n\}/u)?.[1] ?? "";
  const declared = (s: string) => new Set([...s.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gmu)].map((m) => m[1]!));

  it("⚠️ declares no colour or face of its own — the palette is stated once, in globals.css", () => {
    for (const name of declared(css)) expect(name).not.toMatch(/^--(color|font)-/u);
  });

  it("references only tokens @theme or it declares", () => {
    const known = new Set([...declared(theme), ...declared(css)]);
    for (const m of css.matchAll(/var\((--[a-z0-9-]+)\)/gu)) expect(known.has(m[1]!), m[1]).toBe(true);
  });

  it("scopes every element selector under .guide", () => {
    // Tailwind's preflight and the rest of the site must not pick these up.
    const bare = [...css.matchAll(/^(h1|h2|h3|p|ul|ol|li|a|table|th|td|strong|em|hr|code|kbd|main|body|html)\b[^{]*\{/gmu)];
    expect(bare.map((m) => m[0])).toEqual([]);
  });
});

describe("the site serves the guide itself", () => {
  it("has no redirects — /guide used to hand off to fieldguide.dayzclanwars.com", () => {
    expect(config.redirects).toBeUndefined();
  });
});

describe("renderFragment", () => {
  it("substitutes tokens from rules.ts", () => {
    expect(renderFragment("<p>re-raise within {{FLAG_DOWN_MS|hours}}</p>").html).toBe("<p>re-raise within 24 hours</p>");
    expect(renderFragment("<p>{{ MIN_BASE_SPACING_M }}</p>").html).toBe("<p>200 m</p>");
  });
  it("⚠️ throws on an unknown key or format, so a typo never ships as braces", () => {
    expect(() => renderFragment("{{NOPE}}")).toThrow();
    expect(() => renderFragment("{{FLAG_DOWN_MS|fortnights}}")).toThrow();
    expect(() => renderFragment("{{WATCH_ZONE_RADIUS_M|days}}")).toThrow();
  });
  it("gives every h2 an id and an anchor, de-duplicating within the fragment", () => {
    const { html, headings } = renderFragment("<h2>The claim</h2><p>x</p><h2>The claim</h2><h2>Exploits — permanent ban</h2>");
    expect(headings).toEqual([{ id: "the-claim", text: "The claim" }, { id: "the-claim-2", text: "The claim" }, { id: "exploits-permanent-ban", text: "Exploits — permanent ban" }]);
    expect(html).toContain('<h2 id="the-claim">The claim<a class="anchor" href="#the-claim" aria-label="Link to this section">#</a></h2>');
  });
});
