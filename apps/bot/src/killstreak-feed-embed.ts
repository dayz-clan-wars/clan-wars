import type { APIEmbed } from "discord.js";
import type { FlagImageResolver } from "./feed-embed.js";
import { flagLabel } from "./feed-embed.js";
import { cappedLines, escapeMarkdown, profileUrl, type KillFeedSide } from "./kill-feed-embed.js";

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

/** "41 minutes", "2 hours", "35 seconds" — from the kill times, never from a clock. */
function elapsed(from: Date, to: Date): string {
  const s = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (s < 60) return plural(s, "second");
  if (s < 3600) return plural(Math.round(s / 60), "minute");
  return plural(Math.round(s / 3600), "hour");
}

/** One streak milestone, one embed. Pure — no client, no I/O, no clock. */
export function killstreakFeedEmbed(i: KillstreakFeedItem, siteBaseUrl: string, flagImage: FlagImageResolver = () => null): APIEmbed {
  const image = i.killer.texture ? flagImage(i.killer.texture) : null;
  const tag = i.killer.tag ? ` [${escapeMarkdown(i.killer.tag)}]` : "";
  // cappedLines already appends "… and N more <noun>" — passing "more" here
  // would render "… and 5 more more".
  const names = cappedLines(i.victims.map(escapeMarkdown), "victims");

  const lines = [
    `🔥 **${i.streak ?? 0} kill streak**`,
    ...(i.victims.length > 0 ? [`last ${i.victims.length}: ${names.join(", ")}`] : []),
    `started ${elapsed(i.startedAt, i.occurredAt)} ago`,
  ];

  return {
    title: `${escapeMarkdown(i.killer.gamertag)}${tag}`,
    url: profileUrl(siteBaseUrl, i.killer.gamertag),
    description: lines.join("\n"),
    color: FLAME,
    // ⚠️ The kill's time, not the post's.
    timestamp: i.occurredAt.toISOString(),
    ...(image ? { thumbnail: { url: image } } : {}),
    ...(i.killer.texture ? { fields: [{ name: "Flag", value: flagLabel(i.killer.texture), inline: true }] } : {}),
  };
}
