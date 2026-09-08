import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import config from "../next.config";
import { CHAPTERS, CONTENT_DIR, chapterBySlug, hrefFor, neighbours } from "../lib/guide";
import { renderFragment } from "../app/guide/render";
import { buildIndex } from "../app/guide/index";
import { GUIDE_NUMBER_KEYS, guideNumber } from "@factions/domain";

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
  const withFile = CHAPTERS.filter((c): c is typeof c & { file: string } => c.file !== null);
  it("only the appendix has no fragment — it renders from GUIDE_NUMBERS", () => {
    expect(CHAPTERS.filter((c) => c.file === null).map((c) => c.slug)).toEqual(["numbers"]);
  });
  it.each(withFile.map((c) => [c.file, c] as const))("%s exists and links only inside the site", (file) => {
    const path = join(CONTENT_DIR, file);
    expect(existsSync(path)).toBe(true);
    const html = readFileSync(path, "utf8");
    expect(html).not.toMatch(/href="[^"]*\.html/u);
    expect(html).not.toMatch(/<script/iu);
    // The shell renders these; a fragment carrying its own is a double.
    expect(html).not.toMatch(/class="(opener|pager|topbar|rail)"/u);
  });

  /**
   * ⚠️ The drift guard that replaced docs/guide-numbers.json and its test.
   * Every rule number in a chapter is a token; a raw literal equal to any
   * tokenizable value in any unit spelling is a number typed by hand again,
   * one that rules.ts can change without the guide noticing.
   */
  it("carries no hand-typed rule number — every one is a token", () => {
    const literals = new Set<string>();
    for (const key of GUIDE_NUMBER_KEYS) {
      for (const f of ["days", "hours", "minutes", "h", "min", "m"] as const) {
        try { literals.add(guideNumber(key, f)); } catch { /* wrong unit for this key */ }
      }
    }
    // The guard is only as good as its literal set and its regex: prove both on known cases.
    expect(literals).toContain("24 hours");
    expect(literals).toContain("200 m");
    expect(literals).toContain("48 h");
    const probe = (lit: string, s: string) => new RegExp(`(?<![\\w.])${lit.replace(/\s/gu, "\\s")}(?![\\w])`, "u").test(s);
    expect(probe("24 hours", "re-raise within 24 hours or")).toBe(true);
    expect(probe("24 hours", "re-raise within 124 hours")).toBe(false);
    expect(probe("3 days", "a 3-day grace")).toBe(false);
    const offenders: string[] = [];
    for (const c of withFile) {
      const html = readFileSync(join(CONTENT_DIR, c.file), "utf8").replace(/\{\{[^}]*\}\}/gu, "");
      for (const lit of literals) {
        const re = new RegExp(`(?<![\\w.])${lit.replace(/\s/gu, "\\s")}(?![\\w])`, "gu");
        if (re.test(html)) offenders.push(`${c.file}: "${lit}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every token in every fragment resolves", () => {
    for (const c of withFile) expect(() => renderFragment(readFileSync(join(CONTENT_DIR, c.file), "utf8"))).not.toThrow();
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

  it("scopes every element selector under .prose-guide", () => {
    // Tailwind's preflight and the rest of the site must not pick these up.
    const bare = [...css.matchAll(/^(h1|h2|h3|p|ul|ol|li|a|table|th|td|strong|em|hr|code|kbd|main|body|html)\b[^{]*\{/gmu)];
    expect(bare.map((m) => m[0])).toEqual([]);
  });

  it("⚠️ is prose only — no layout, rail, opener, pager or menu selectors (those are React now)", () => {
    for (const sel of [".rail", ".pager", ".opener", ".toc", ".menu", ".shell", ".topbar", ".site-link"]) expect(css).not.toContain(sel);
    expect(css.split("\n").filter((l) => /^\S/u.test(l) && l.includes("{")).every((l) => l.startsWith(".prose-guide") || l.startsWith("@") || l.startsWith("/*"))).toBe(true);
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

describe("the search index", () => {
  const index = buildIndex();
  const withFile = CHAPTERS.filter((c): c is typeof c & { file: string } => c.file !== null);
  it("has one entry per chapter and one per section", () => {
    const sections = withFile.reduce((n, c) => n + renderFragment(readFileSync(join(CONTENT_DIR, c.file), "utf8")).headings.length, 0);
    expect(index.filter((e) => !e.heading)).toHaveLength(CHAPTERS.length);
    expect(index.filter((e) => e.heading)).toHaveLength(sections);
    expect(sections).toBeGreaterThan(70);
  });
  it("ids are unique within a chapter and every href is a real chapter", () => {
    const seen = new Set<string>();
    for (const e of index) {
      expect(seen.has(e.href), e.href).toBe(false);
      seen.add(e.href);
      const slug = e.href.replace(/^\/guide\/?/u, "").replace(/#.*$/u, "");
      expect(chapterBySlug(slug), e.href).toBeDefined();
    }
  });
  it("gives every section a hint sentence", () => {
    for (const e of index.filter((e) => e.heading)) expect(e.text.length, e.href).toBeGreaterThan(0);
  });
});
