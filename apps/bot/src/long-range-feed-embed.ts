import type { APIEmbed } from "discord.js";
import type { FlagImageResolver } from "./feed-embed.js";
import { flagLabel } from "./feed-embed.js";
import { escapeMarkdown, profileUrl, type KillFeedSide } from "./kill-feed-embed.js";

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

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

function who(side: KillFeedSide, siteBaseUrl: string): string {
  const name = `**[${escapeMarkdown(side.gamertag)}](${profileUrl(siteBaseUrl, side.gamertag)})**`;
  return side.tag ? `${name} [${escapeMarkdown(side.tag)}]` : name;
}

/** One long-range kill, one embed. Pure — no client, no I/O, no clock. */
export function longRangeFeedEmbed(i: LongRangeFeedItem, siteBaseUrl: string, flagImage: FlagImageResolver = () => null): APIEmbed {
  const image = i.killer.texture ? flagImage(i.killer.texture) : null;
  const tag = i.killer.tag ? ` [${escapeMarkdown(i.killer.tag)}]` : "";

  const kill = [`killed ${who(i.victim, siteBaseUrl)}`];
  if (i.weapon) kill.push(escapeMarkdown(i.weapon));

  const records: string[] = [];
  if (i.personalBest) records.push(`${escapeMarkdown(i.killer.gamertag)}'s longest yet`);
  if (i.seasonRank !== null) {
    const scope = i.season === null ? "all-time" : "this season";
    records.push(i.seasonRank === 1 ? `longest ${scope}` : `${ordinal(i.seasonRank)} longest ${scope}`);
  }

  const lines = [
    `🎯 **${i.distanceM === null ? "—" : Math.round(i.distanceM)} m**`,
    kill.join(" · "),
    ...(records.length > 0 ? [records.join(" · ")] : []),
  ];

  return {
    title: `${i.friendlyFire ? "Friendly fire — " : ""}${escapeMarkdown(i.killer.gamertag)}${tag}`,
    url: profileUrl(siteBaseUrl, i.killer.gamertag),
    description: lines.join("\n"),
    color: i.friendlyFire ? AMBER : STEEL,
    // ⚠️ The kill's time, not the post's.
    timestamp: i.occurredAt.toISOString(),
    ...(image ? { thumbnail: { url: image } } : {}),
    ...(i.killer.texture ? { fields: [{ name: "Flag", value: flagLabel(i.killer.texture), inline: true }] } : {}),
  };
}
