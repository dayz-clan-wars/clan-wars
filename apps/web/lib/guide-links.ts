import { CHAPTERS, hrefFor, type Chapter } from "./guide";

/**
 * Where each page points into the guide. One table, so a chapter rename or a
 * heading change fails test/guide-links.test.ts instead of leaving a dead
 * "In the guide" link. `heading` is a section id as render.ts generates it
 * from the h2 text.
 */
export type GuideRef = { slug: string; heading?: string };

export const GUIDE_LINKS: Record<string, GuideRef> = {
  "/base": { slug: "bases" },
  "/link": { slug: "getting-in" },
  "/login": { slug: "getting-in" },
  "/join": { slug: "getting-in" },
  "/me": { slug: "" },
  "/clan": { slug: "running-a-clan" },
  "/clan/settings": { slug: "running-a-clan", heading: "rename" },
  "/clan/vault": { slug: "running-a-clan", heading: "the-vault" },
  "/clan/board": { slug: "the-scoreboard", heading: "player-boards" },
  "/players": { slug: "the-scoreboard", heading: "player-boards" },
  "/players/boards/[board]": { slug: "the-scoreboard", heading: "player-boards" },
  "/clan/board/[board]": { slug: "the-scoreboard", heading: "player-boards" },
  "/players/[gamertag]": { slug: "the-scoreboard", heading: "player-profiles" },
  "/clans": { slug: "running-a-clan", heading: "recruiting-post" },
  "/clans/[tag]": { slug: "running-a-clan", heading: "joining" },
  "/claim/[ceremony]": { slug: "founding-a-clan", heading: "the-claim" },
  "/scoreboard": { slug: "the-scoreboard", heading: "points" },
  "/alphas": { slug: "the-scoreboard", heading: "the-week" },
  "/seasons": { slug: "the-scoreboard", heading: "the-season" },
  "/war-log": { slug: "raiding" },
  "/map": { slug: "the-map" },
};

/** Named anchors used inline in refusals, beside the copy strings (which stay plain). */
export const GUIDE_INLINE = {
  gettingIn: { slug: "getting-in" },
  spacing: { slug: "bases", heading: "spacing" },
} as const satisfies Record<string, GuideRef>;

export type GuideLink = { href: string; label: string };

export function guideLink(ref: GuideRef): GuideLink {
  const c = CHAPTERS.find((x) => x.slug === ref.slug) as Chapter | undefined;
  if (!c) throw new Error(`guide link to unknown chapter "${ref.slug}"`);
  const href = ref.heading ? `${hrefFor(c)}#${ref.heading}` : hrefFor(c);
  const heading = ref.heading ? ref.heading.replace(/-\d+$/u, "").replace(/-/gu, " ") : undefined;
  return { href, label: heading ? `${c.number}. ${c.title} › ${heading[0]!.toUpperCase()}${heading.slice(1)}` : `${c.number}. ${c.title}` };
}

/** The page-head link for a route in GUIDE_LINKS. */
export function guideLinkFor(route: keyof typeof GUIDE_LINKS): GuideLink {
  return guideLink(GUIDE_LINKS[route]!);
}
