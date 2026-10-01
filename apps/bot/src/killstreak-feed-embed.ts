import type { APIEmbed } from "discord.js";
import type { FlagImageResolver } from "./feed-embed.js";
import { flagLabel } from "./feed-embed.js";
import { streakCard } from "@factions/copy";
import type { KillFeedSide } from "./kill-feed-embed.js";
import { toLiveStreak } from "./live-payload.js";
import { lineMarkdown } from "./site-links.js";

/**
 * One kill, with the streak it belongs to. `streak` is null when the kill
 * cannot carry one — friendly fire — and the render declines it.
 */
export type KillstreakFeedItem = {
  /** The milestone kill's `events.id`: the feed's cursor. */
  eventId: number;
  occurredAt: Date;
  /** The streak's FIRST kill. */
  startedAt: Date;
  killer: KillFeedSide;
  streak: number | null;
  /** The streak's victims, oldest first. */
  victims: string[];
};

const FLAME = 0xd35400;

/** One streak milestone, one embed. Pure — no client, no I/O, no clock. */
export function killstreakFeedEmbed(i: KillstreakFeedItem, siteBaseUrl: string, flagImage: FlagImageResolver = () => null): APIEmbed {
  const image = i.killer.texture ? flagImage(i.killer.texture) : null;
  const card = streakCard(toLiveStreak(i));

  return {
    // The card's title carries the gamertag as `raw`: Discord renders no markdown in an embed title.
    title: lineMarkdown(card.title, siteBaseUrl),
    url: `${siteBaseUrl}${card.href}`,
    description: card.lines.map((l) => lineMarkdown(l, siteBaseUrl)).join("\n"),
    color: FLAME,
    // ⚠️ The kill's time, not the post's.
    timestamp: i.occurredAt.toISOString(),
    ...(image ? { thumbnail: { url: image } } : {}),
    ...(i.killer.texture ? { fields: [{ name: "Flag", value: flagLabel(i.killer.texture), inline: true }] } : {}),
  };
}
