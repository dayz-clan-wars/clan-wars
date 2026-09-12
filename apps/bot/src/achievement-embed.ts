import type { APIEmbed } from "discord.js";
import { ACHIEVEMENT_BY_KEY, ACHIEVEMENT_GROUP_COLORS, type AchievementKey } from "@factions/domain";
import type { NoticePayload } from "@factions/roster/internal";

export const ACHIEVEMENT_FOOTER = "Clan Wars · Livonia";

/** `#d4623a` → 0xd4623a, the integer Discord wants. */
export function colourInt(hex: string): number {
  return Number.parseInt(hex.replace(/^#/u, ""), 16);
}

/** The unlocked badge the site serves — `apps/web/public/achievements/unlocked/<key>.png`. */
export function badgeUrl(siteBaseUrl: string, key: string): string {
  return `${siteBaseUrl}/achievements/unlocked/${key}.png`;
}

/** The bare mention the clan channel gets ahead of the card, when the owner is a linked player. */
export function achievementMention(p: NoticePayload): string {
  return p.ownerKind === "player" && /^\d+$/u.test(String(p.ownerName)) ? `<@${p.ownerName}>` : "";
}

/**
 * The unlock card (design hand-off §04): the group's colour, the unlocked
 * badge as thumbnail, one line naming who and what. A team unlock is the
 * clan's — `[TAG]` — and a player's is their gamertag, never the mention
 * (a mention inside an embed does not ping; `achievementMention` carries it
 * in the content instead).
 *
 * ⚠️ No coordinates anywhere in here — the same rule as the wall. The payload
 * carries none, and this reads only the fields it names.
 *
 * ⚠️ The key is trusted as far as `ACHIEVEMENT_BY_KEY` knows it. A payload off
 * a jsonb column with a key that is not defined (a retired achievement, a
 * hand-inserted row) still renders — in the ink colour, with no badge — rather
 * than sticking the target's queue on a throw.
 */
export function achievementEmbed(p: NoticePayload, siteBaseUrl: string): APIEmbed {
  const key = String(p.key);
  const def = ACHIEVEMENT_BY_KEY[key as AchievementKey];
  const group = def?.group;
  const who = p.ownerKind === "clan"
    ? `**[${p.clanTag ?? p.ownerName}]**`
    : `**${p.gamertag ?? (/^\d+$/u.test(String(p.ownerName)) ? "A player" : p.ownerName)}**`;
  return {
    color: colourInt(group ? ACHIEVEMENT_GROUP_COLORS[group] : "#e8e2d4"),
    description: `${who} unlocked **${p.name}** · ${p.description}`,
    ...(def ? { thumbnail: { url: badgeUrl(siteBaseUrl, key) } } : {}),
    footer: { text: ACHIEVEMENT_FOOTER },
  };
}
