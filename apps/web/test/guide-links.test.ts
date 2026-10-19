import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHAPTERS, CONTENT_DIR, chapterBySlug } from "../lib/guide";
import { GUIDE_INLINE, GUIDE_LINKS, guideLink, guideLinkFor, type GuideRef } from "../lib/guide-links";
import { renderFragment } from "../app/guide/render";

/**
 * Every "In the guide" link on the site is a row in GUIDE_LINKS. A chapter
 * renamed or a heading reworded would otherwise leave a link that lands on
 * the chapter top with no error — this is the only thing that notices.
 */
const headingsOf = (slug: string): string[] => {
  const c = chapterBySlug(slug)!;
  return c.file ? renderFragment(readFileSync(join(CONTENT_DIR, c.file), "utf8")).headings.map((h) => h.id) : [];
};

describe("GUIDE_LINKS", () => {
  const refs: GuideRef[] = [...Object.values(GUIDE_LINKS), ...Object.values(GUIDE_INLINE)];
  it.each(refs.map((r) => [r.heading ? `${r.slug}#${r.heading}` : r.slug || "(chapter 1)", r] as const))("%s points at a real chapter and section", (_, r) => {
    expect(chapterBySlug(r.slug), r.slug).toBeDefined();
    if (r.heading) expect(headingsOf(r.slug), `${r.slug}#${r.heading}`).toContain(r.heading);
  });
  it("labels read as chapter and section", () => {
    expect(guideLinkFor("/base")).toEqual({ href: "/guide/bases", label: "4. Bases" });
    expect(guideLinkFor("/clan/vault")).toEqual({ href: "/guide/running-a-clan#the-vault", label: "8. Running a clan › The vault" });
    expect(guideLinkFor("/me")).toEqual({ href: "/guide", label: "1. What this is" });
  });
  it("covers every page that has a page head", () => {
    for (const route of ["/base", "/link", "/login", "/join", "/me", "/clan", "/clan/settings", "/clan/vault", "/clan/board", "/clan/board/[board]", "/players", "/players/boards/[board]", "/players/[gamertag]", "/clans", "/clans/[tag]", "/claim/[ceremony]", "/scoreboard", "/alphas", "/seasons", "/war-log", "/map"]) {
      expect(GUIDE_LINKS[route], route).toBeDefined();
    }
  });
  it("throws on an unknown chapter", () => {
    expect(() => guideLink({ slug: "nope" })).toThrow();
    expect(CHAPTERS.length).toBe(15);
  });
});
