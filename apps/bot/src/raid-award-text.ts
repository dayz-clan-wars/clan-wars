// apps/bot/src/raid-award-text.ts
import { RAID_AWARD_DAYS } from "@factions/domain";
import { escapeMarkdown } from "./kill-feed-embed.js";

/**
 * The weekly top-raiding-clan post (spec 2026-11-06-raid-value-scoring §4), to the
 * server events channel. Plain voice. The clan name is player-controlled, so it is
 * escaped here and the poster suppresses mentions.
 */
export function raidAwardText(clanName: string, points: number): string {
  return `**${escapeMarkdown(clanName)}** was the top raiding clan this week, with ${points} points. `
    + `Their leader gets a weapon kit for ${RAID_AWARD_DAYS} days, and can give it to a clanmate on the site.`;
}
