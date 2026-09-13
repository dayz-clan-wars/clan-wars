import type { APIEmbed } from "discord.js";
import type { FlagImageResolver } from "./feed-embed.js";
import { flagLabel } from "./feed-embed.js";
import { cappedLines, detailLine, escapeMarkdown, profileUrl, who, type HitDetail, type KillFeedSide } from "./kill-feed-embed.js";

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

/** `once`, `2 times`, `9 times`. "1 times" is not a sentence. */
function times(n: number): string {
  return n === 1 ? "once" : `${n} times`;
}

/**
 * One engagement, one embed. Pure — no client, no I/O, no clock.
 *
 * Attacker-centric, matching the kill feed: the title is the attacker, the
 * thumbnail is their clan flag, both names link to their profiles. Amber and
 * said in the title for friendly fire.
 */
export function hitFeedEmbed(i: HitFeedItem, siteBaseUrl: string, flagImage: FlagImageResolver = () => null): APIEmbed {
  const image = i.attacker.texture ? flagImage(i.attacker.texture) : null;
  const attackerTag = i.attacker.tag ? ` [${escapeMarkdown(i.attacker.tag)}]` : "";

  const head = [`hit ${who(i.victim, siteBaseUrl)} ${times(i.hits.length)}`];
  if (i.weapon) head.push(escapeMarkdown(i.weapon));

  const summary: string[] = [];
  if (i.totalDamage !== null && Number.isFinite(i.totalDamage)) summary.push(`${Math.round(i.totalDamage)} damage`);
  if (i.victimHpAfter !== null && Number.isFinite(i.victimHpAfter)) summary.push(`left them at ${Math.round(i.victimHpAfter)} HP`);

  // The weapon is deliberately not repeated per line: an engagement is keyed
  // on one weapon and the header above already named it.
  const detail = cappedLines(i.hits.map((h) => detailLine(h)).filter((l) => l !== ""), "hits");

  const lines = [head.join(" · "), ...(summary.length > 0 ? [summary.join(" · ")] : []), ...(detail.length > 0 ? ["", ...detail] : [])];

  return {
    // ⚠️ The gamertag is RAW here, unlike everywhere in the description:
    // Discord renders no markdown in an embed title, so an escape is not
    // neutralised there, it is displayed — `x_Dave_x` would read `x\_Dave\_x`.
    // Same rule as `kill-feed-embed.ts`.
    title: `${i.friendlyFire ? "Friendly fire — " : ""}${i.attacker.gamertag}${attackerTag}`,
    url: profileUrl(siteBaseUrl, i.attacker.gamertag),
    description: lines.join("\n"),
    color: i.friendlyFire ? AMBER : EMBER,
    // ⚠️ The last hit's time, not the post's: a delayed post still reads as when it happened.
    timestamp: i.occurredAt.toISOString(),
    ...(image ? { thumbnail: { url: image } } : {}),
    ...(i.attacker.texture ? { fields: [{ name: "Flag", value: flagLabel(i.attacker.texture), inline: true }] } : {}),
  };
}
