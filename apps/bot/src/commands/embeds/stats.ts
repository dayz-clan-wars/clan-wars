import { EmbedBuilder } from "discord.js";
import type { AchievementWall, BoardPage, PlayerProfile, ResolvedScope } from "@factions/roster";
import { ACHIEVEMENT_CLOSEST, BOARD_LABELS, EMPTY_BOARD, playTime } from "@factions/copy";
import { budget } from "./budget.js";

const GOLD = 0xc8a34a;

/**
 * "All time" or "Season N" — the RESOLVED scope a read actually used, never
 * `"current"`. R7's whole safety story is that this is printed on every
 * scoped card: a scope the player fumbled is visible, not silent.
 */
const scopeLabel = (scope: ResolvedScope): string => (scope.kind === "all" ? "All time" : `Season ${scope.number}`);

/**
 * `/player` — one player's card: headline numbers only.
 *
 * ⚠️ `PlayerProfile` also carries `clanHistory` and full kill lists
 * (`killed`/`killedBy`/`encounters`) — none of that belongs on a card, only
 * on the site's own page, which is what the title's URL points at.
 */
export function playerEmbed(p: PlayerProfile, siteBaseUrl: string): EmbedBuilder {
  const title = p.gamertag;
  const description = scopeLabel(p.scope);
  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(title)
    .setURL(`${siteBaseUrl}/players/${encodeURIComponent(p.gamertag)}`)
    .setDescription(description);

  const b = budget(title.length + description.length);
  b.field(embed, "Kills", String(p.pvpKills), true);
  b.field(embed, "Deaths", String(p.pvpDeaths), true);
  b.field(embed, "K/D", p.kd === null ? "—" : String(p.kd), true);
  b.field(embed, "Play time", playTime(p.playTimeSeconds), true);
  b.field(embed, "Sessions", String(p.sessions), true);
  b.field(embed, "Raid credits", String(p.raidCredits), true);
  b.field(embed, "Build points", String(p.buildPoints), true);
  b.field(embed, "Best streak", String(p.bestStreak), true);
  b.field(
    embed,
    "Longest kill",
    p.longestKill ? `${p.longestKill.distanceM} m${p.longestKill.weapon ? ` (${p.longestKill.weapon})` : ""}` : "None yet",
    true,
  );
  if (p.clan) b.field(embed, "Clan", `${p.clan.name} [${p.clan.tag}]`, true);
  return embed;
}

/**
 * `/board` — one page of one board, numbered from where this page starts.
 *
 * ⚠️ R7: prints `page.scope` — the RESOLVED scope, not whatever the player
 * typed — so a mistyped or unrecognised `scope:` shows up as the wrong
 * season on the card instead of silently returning different numbers.
 */
export function boardEmbed(page: BoardPage, siteBaseUrl: string): EmbedBuilder {
  const title = `${BOARD_LABELS[page.kind]} — page ${page.page}`;
  const description = scopeLabel(page.scope);
  const footerText = page.hasNext ? "More on the site." : "That is the whole board.";
  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(title)
    .setURL(`${siteBaseUrl}/players/boards/${page.kind}`)
    .setDescription(description)
    .setFooter({ text: footerText });
  if (page.rows.length === 0) return embed.setDescription(`${description} — ${EMPTY_BOARD}`);

  const start = (page.page - 1) * page.perPage + 1;
  const lines = page.rows.map((r, i) => {
    const clan = page.clans[r.dayzId];
    return `• ${start + i}. ${r.gamertag}${clan ? ` [${clan.tag}]` : ""} — ${r.value}`;
  });
  const b = budget(title.length + description.length + footerText.length);
  b.list(embed, BOARD_LABELS[page.kind], lines, (n) => `+${n} more — see the site.`);
  return embed;
}

/**
 * `/achievements` — a player's or a clan's wall: earned tiles, and the
 * closest a player is to their next one (a clan's wall has none — see
 * `achievementsForDb`'s `wallFor`, which only computes `closest` for a
 * player owner).
 *
 * ⚠️ "Nothing earned yet" is not a domain outcome the way `EMPTY_BOARD` is —
 * the site never shows this sentence because it always renders the full
 * fifty-tile grid (mostly locked); a compact chat card is the only surface
 * that needs a stand-in for an empty earned list, so it is written here
 * rather than forked into `@factions/copy` for a sentence the site has no use for.
 */
const NOTHING_EARNED = "Nothing earned yet — see the site for the full wall.";

/**
 * `url` is a finished link, not a base — a wall's subject is a player OR a
 * clan tag, and the two live at different site paths (`/players/…`,
 * `/clans/…`), so only the caller (which already branched on subject) can
 * build the right one.
 */
export function achievementsEmbed(wall: AchievementWall, subject: string, url: string): EmbedBuilder {
  const title = `${subject} — ${wall.earned} earned`;
  const embed = new EmbedBuilder().setColor(GOLD).setTitle(title).setURL(url);
  const b = budget(title.length);

  const earned = wall.tiles.filter((t) => t.earnedAt !== null).map((t) => `• ${t.name}`);
  if (earned.length > 0) b.list(embed, "Earned", earned, (n) => `+${n} more — see the site.`);
  else embed.setDescription(NOTHING_EARNED);

  if (wall.closest.length > 0) {
    const lines = wall.closest.map((t) => `• ${t.name} — ${t.count}/${t.target} ${t.unit}`).join("\n");
    b.field(embed, ACHIEVEMENT_CLOSEST, lines);
  }
  return embed;
}
