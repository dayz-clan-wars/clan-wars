import { EmbedBuilder } from "discord.js";
import type { AlphaWeek, Scoreboard, SeasonSummary, WarLogEntry } from "@factions/roster";
import { when } from "@factions/copy";
import { budget } from "./budget.js";

const GOLD = 0xc8a34a;

/** `/scoreboard` — the open season's table, or a plain sentence before one opens. */
export function scoreboardEmbed(board: Scoreboard, siteBaseUrl: string): EmbedBuilder {
  const title = board.season === null ? "Scoreboard" : `Season ${board.season.number}`;
  const footer = "raids / times raided / defenses";
  const embed = new EmbedBuilder().setColor(GOLD).setTitle(title).setURL(`${siteBaseUrl}/scoreboard`);
  if (board.season === null) return embed.setDescription("No season is open yet.");

  embed.setFooter({ text: footer });
  const b = budget(title.length + footer.length);
  const line = (r: Scoreboard["rows"][number]) =>
    `• **${r.rank ?? "—"}. ${r.name}** [${r.tag}] — ${r.points} pts · ${r.raids}/${r.timesRaided}/${r.defenses}`
    + (r.alpha ? " · Alpha" : "");
  b.list(embed, `Season ${board.season.number}`, board.rows.map(line), (n) => `+${n} more — see the site.`);
  return embed;
}

/** `/alphas` — one field per closed week, top three each. */
export function alphasEmbed(a: { season: { number: number } | null; weeks: AlphaWeek[] }, siteBaseUrl: string): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(GOLD).setTitle("Alphas").setURL(`${siteBaseUrl}/alphas`);
  if (a.weeks.length === 0) return embed.setDescription("No week has closed yet.");

  // ⚠️ b.field, not addFields directly — a long season's worth of weeks
  // could otherwise walk past Discord's 25-field/6000-char caps unchecked.
  const b = budget("Alphas".length);
  for (const w of a.weeks) {
    const lines = w.entries.map((e) => `• ${e.rank}. ${e.name} [${e.tag}] — ${e.points} pts`);
    b.field(embed, when(w.weekStart), lines.join("\n"));
  }
  return embed;
}

/** `/seasons` — every closed season and its champion. */
export function seasonsEmbed(list: SeasonSummary[], siteBaseUrl: string): EmbedBuilder {
  const title = "Seasons";
  const embed = new EmbedBuilder().setColor(GOLD).setTitle(title).setURL(`${siteBaseUrl}/seasons`);
  if (list.length === 0) return embed.setDescription("No season has closed yet.");

  const b = budget(title.length);
  const line = (s: SeasonSummary) =>
    `• **Season ${s.number}** — ${s.champion ? `${s.champion.name} [${s.champion.tag}], ${s.champion.points} pts` : "no champion"} · ended ${when(s.endedAt)}`;
  b.list(embed, title, list.map(line), (n) => `+${n} more — see the site.`);
  return embed;
}

/** `/warlog` — recent raids and defenses, in the order the roster returned them. */
export function warLogEmbed(entries: WarLogEntry[], siteBaseUrl: string): EmbedBuilder {
  const title = "War Log";
  const embed = new EmbedBuilder().setColor(GOLD).setTitle(title).setURL(`${siteBaseUrl}/war-log`);
  if (entries.length === 0) return embed.setDescription("Nothing yet this season.");

  const b = budget(title.length);
  const line = (e: WarLogEntry) =>
    e.kind === "raid"
      ? `• ⚔️ ${when(e.at)} — **${e.raider?.name ?? "no clan"}** raided **${e.victim.name}** (${e.points} pts)`
      : `• 🛡️ ${when(e.at)} — **${e.victim.name}** held, ${Math.round(e.durationSeconds / 60)} min under siege`;
  b.list(embed, title, entries.map(line), (n) => `+${n} more — see the site.`);
  return embed;
}
