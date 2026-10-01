import type { APIEmbed } from "discord.js";
import type { FlagImageResolver } from "./feed-embed.js";
import { flagLabel } from "./feed-embed.js";
import { hitCard } from "@factions/copy";
import type { HitDetail, KillFeedSide } from "./kill-feed-embed.js";
import { toLiveHitRun } from "./live-payload.js";
import { lineMarkdown } from "./site-links.js";

/**
 * One engagement, ready to render. Built by `PgHitFeedStore`; never carries a
 * position. `suppressed` means a kill claimed this run and it belongs to
 * #kill-feed instead — the render declines it, the cursor still advances.
 */
export type HitFeedItem = {
  /** The engagement's LAST event id: the feed's cursor value. */
  eventId: number;
  /** The last hit's time. */
  occurredAt: Date;
  /** The first hit's time. */
  startedAt: Date;
  attacker: KillFeedSide;
  victim: KillFeedSide;
  weapon: string | null;
  friendlyFire: boolean;
  suppressed: boolean;
  /** Oldest first. */
  hits: HitDetail[];
  totalDamage: number | null;
  /** The victim's HP after the last hit. */
  victimHpAfter: number | null;
};

/** Duller than the kill feed's rust, so the two channels are distinguishable at a glance. */
const EMBER = 0x8c5a3c;
const AMBER = 0xe67e22;

/**
 * One engagement, one embed. Pure — no client, no I/O, no clock.
 *
 * Attacker-centric, matching the kill feed: the title is the attacker, the
 * thumbnail is their clan flag, both names link to their profiles. Amber and
 * said in the title for friendly fire.
 */
export function hitFeedEmbed(i: HitFeedItem, siteBaseUrl: string, flagImage: FlagImageResolver = () => null): APIEmbed {
  const image = i.attacker.texture ? flagImage(i.attacker.texture) : null;
  const card = hitCard(toLiveHitRun(i));
  const lines = card.lines.map((l) => lineMarkdown(l, siteBaseUrl));
  if (card.detail.length > 0) lines.push("", ...card.detail.map((l) => lineMarkdown(l, siteBaseUrl)));

  return {
    // The card's title carries the gamertag as `raw`: Discord renders no markdown in an embed title.
    title: lineMarkdown(card.title, siteBaseUrl),
    url: `${siteBaseUrl}${card.href}`,
    description: lines.join("\n"),
    color: i.friendlyFire ? AMBER : EMBER,
    // ⚠️ The last hit's time, not the post's: a delayed post still reads as when it happened.
    timestamp: i.occurredAt.toISOString(),
    ...(image ? { thumbnail: { url: image } } : {}),
    ...(i.attacker.texture ? { fields: [{ name: "Flag", value: flagLabel(i.attacker.texture), inline: true }] } : {}),
  };
}
