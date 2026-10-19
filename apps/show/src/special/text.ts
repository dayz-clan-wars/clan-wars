import { cutHash } from "../engine/animation/episodeCache.js";
import type { OutMessage } from "../engine/publish/discord.js";
import { noDashes, publicCopy, publicText } from "../stages/text.js";

const CONTENT_MAX = 2000;

/**
 * ⚠️ Its own namespace, keyed on the cut: the weekly stage looks for `show:YYYY-MM-DD:<hash>`, so a
 * special's draft can never be adopted as a week's draft (whose ✅ would then publish it), and a
 * re-cut special never adopts the old cut's draft.
 */
export const specialMarker = (slug: string, narrative: string) => `show:special:${slug}:${cutHash(narrative)}`;

/** The ops-channel draft (spec 2026-10-19-nasdara-promo-episode-design.md §5.2), modelled on the weekly one. */
export function specialDraftMessage(o: { subtitle: string; youtubeVideoId: string; narrative: string; marker: string }): OutMessage {
  const content = [
    `**Clan Wars Special · ${publicText(o.subtitle)}** is ready for review (unlisted): https://youtu.be/${o.youtubeVideoId}`,
    "React ✅ to publish or ❌ to reject. Only approvers count.",
    "Hand-written special episode, not a weekly recap.",
    `-# ${o.marker}`,
  ].join("\n");
  return {
    content: content.slice(0, CONTENT_MAX),
    files: [{ name: "transcript.txt", data: Buffer.from(noDashes(publicText(o.narrative)), "utf8"), contentType: "text/plain; charset=utf-8" }],
  };
}

/** The weekly caption says "This week in Clan Wars: the raids..."; a special carries its own lines. */
export function specialFacebookCaption(o: { subtitle: string; lines: string[]; youtubeVideoId: string; discordInvite: string }): string {
  return [
    `\u{1F399}\u{FE0F} The Bloodbag and Painkiller Show: Clan Wars Special · ${publicCopy(o.subtitle)}`,
    ...o.lines.map(publicCopy),
    `\u{25B6}\u{FE0F} Full episode on YouTube: https://youtu.be/${o.youtubeVideoId}`,
    `\u{1F4AC} Join the war: https://${o.discordInvite}`,
  ].join("\n\n");
}
