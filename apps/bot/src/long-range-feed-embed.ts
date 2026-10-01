import type { APIEmbed } from "discord.js";
import type { FlagImageResolver } from "./feed-embed.js";
import { flagLabel } from "./feed-embed.js";
import { longRangeCard } from "@factions/copy";
import type { KillFeedSide } from "./kill-feed-embed.js";
import { toLiveLongRange } from "./live-payload.js";
import { lineMarkdown } from "./site-links.js";

/** One long-range kill, ready to render. `distanceM` null means the log did not say — the render declines it. */
export type LongRangeFeedItem = {
  eventId: number;
  occurredAt: Date;
  killer: KillFeedSide;
  victim: KillFeedSide;
  weapon: string | null;
  distanceM: number | null;
  friendlyFire: boolean;
  /** Whether this kill clears the distance threshold. The render declines it when false. */
  qualifies: boolean;
  /** No earlier kill by this killer went further. */
  personalBest: boolean;
  /** 1-based rank within this kill's season window, or null past the cap. */
  seasonRank: number | null;
  /** The season the rank counts in; null means all-time. */
  season: number | null;
};

const STEEL = 0x4a708b;
const AMBER = 0xe67e22;

/** One long-range kill, one embed. Pure — no client, no I/O, no clock. */
export function longRangeFeedEmbed(i: LongRangeFeedItem, siteBaseUrl: string, flagImage: FlagImageResolver = () => null): APIEmbed {
  const image = i.killer.texture ? flagImage(i.killer.texture) : null;
  const card = longRangeCard(toLiveLongRange(i));

  return {
    // The card's title carries the gamertag as `raw`: Discord renders no markdown in an embed title.
    title: lineMarkdown(card.title, siteBaseUrl),
    url: `${siteBaseUrl}${card.href}`,
    description: card.lines.map((l) => lineMarkdown(l, siteBaseUrl)).join("\n"),
    color: i.friendlyFire ? AMBER : STEEL,
    // ⚠️ The kill's time, not the post's.
    timestamp: i.occurredAt.toISOString(),
    ...(image ? { thumbnail: { url: image } } : {}),
    ...(i.killer.texture ? { fields: [{ name: "Flag", value: flagLabel(i.killer.texture), inline: true }] } : {}),
  };
}
