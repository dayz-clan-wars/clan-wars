/**
 * Achievement wording the bot and the site both say (spec 2026-10-20-achievements-150).
 * Here, not in either app, because the summary DM is rendered twice — by
 * apps/bot/src/notice-text.ts for Discord and apps/web/lib/notice-copy.ts for the bell —
 * and a sentence typed in both would drift.
 */

/** The wall's sub-section, and the bot card's field, holding the gun, class and Full Armory tiles. */
export const ARMORY_LABEL = "Armory";

/** "7 of 59": earned armory tiles over the section's size. */
export const armoryCount = (earned: number, of: number): string => `${earned} of ${of}`;

/**
 * The summary DM's sentence. The bot appends the wall link after it; the site links the
 * wall as the notice's call to action, since a page must not print a bare URL.
 * A payload count that is not a number reads "some", never "NaN".
 */
export function achievementSummaryLine(count: number): string {
  return `You already hold ${Number.isFinite(count) ? count : "some"} of the new achievements.`;
}
