// apps/bot/src/referral-award-text.ts
import { escapeMarkdown } from "./kill-feed-embed.js";

/** "**a**", "**a** and **b**", "**a**, **b** and **c**". */
function names(list: string[]): string {
  const bold = list.map((n) => `**${escapeMarkdown(n)}**`);
  return bold.length <= 1 ? bold.join("") : `${bold.slice(0, -1).join(", ")} and ${bold[bold.length - 1]}`;
}

/**
 * The weekly winners post (spec 2026-09-27-referral-leaderboard §6), to the server
 * events channel. Plain voice, no em dashes.
 */
export function referralWinnersText(winners: string[], count: number): string {
  const players = `${count} new player${count === 1 ? "" : "s"}`;
  return winners.length === 1
    ? `Top referrer this week: ${names(winners)}, who brought in ${players}. They get a plate carrier for a week.`
    : `Top referrers this week: ${names(winners)}, with ${players} each. They each get a plate carrier for a week.`;
}
