import { EmbedBuilder } from "discord.js";
import type { AlphaWeek, Scoreboard, SeasonSummary, WarLogEntry } from "@factions/roster";
import { when, EMPTY_SCOREBOARD, NO_ALPHAS_WEEK, NO_SEASONS, EMPTY_WAR_LOG, ALPHA_BADGE } from "@factions/copy";
import { budget, MAX_FIELDS } from "./budget.js";

const GOLD = 0xc8a34a;

/** `/scoreboard` — the open season's table, or a plain sentence before one opens. */
export function scoreboardEmbed(board: Scoreboard, siteBaseUrl: string): EmbedBuilder {
  const title = board.season === null ? "Scoreboard" : `Season ${board.season.number}`;
  const footer = "raids / times raided / defenses";
  const embed = new EmbedBuilder().setColor(GOLD).setTitle(title).setURL(`${siteBaseUrl}/scoreboard`);
  if (board.season === null) return embed.setDescription(EMPTY_SCOREBOARD);

  embed.setFooter({ text: footer });
  const b = budget(title.length + footer.length);
  const line = (r: Scoreboard["rows"][number]) =>
    `• **${r.rank ?? "—"}. ${r.name}** [${r.tag}] — ${r.points} pts · ${r.raids}/${r.timesRaided}/${r.defenses}`
    + (r.alpha ? ` · ${ALPHA_BADGE}` : "");
  b.list(embed, `Season ${board.season.number}`, board.rows.map(line), (n) => `+${n} more — see the site.`);
  return embed;
}

/** `/alphas` — one field per closed week, top three each. */
export function alphasEmbed(a: { season: { number: number } | null; weeks: AlphaWeek[] }, siteBaseUrl: string): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(GOLD).setTitle("Alphas").setURL(`${siteBaseUrl}/alphas`);
  // ⚠️ Two distinct empty states, same as `/scoreboard` — collapsing them
  // was the exact class of bug this branch spent two tasks fixing. No
  // season open at all is `EMPTY_SCOREBOARD` (the site's own between-seasons
  // sentence, reused rather than forked); a season open with no week closed
  // yet is "No week has closed yet.", which has no shared constant — the
  // site spells it inline in both scoreboard/page.tsx and alphas/page.tsx
  // rather than exporting it.
  if (a.season === null) return embed.setDescription(EMPTY_SCOREBOARD);
  if (a.weeks.length === 0) return embed.setDescription("No week has closed yet.");

  // ⚠️ b.field, not addFields directly — a long season's worth of weeks
  // could otherwise walk past Discord's 25-field/6000-char caps unchecked.
  // `b.list`'s per-line overflow notice does not apply here (each week is
  // its own field, not a line), so a season running past 25 closed weeks is
  // handled the same way any other overflow on this branch is: a trailing
  // "+N more" field naming what got dropped, rather than silently under-
  // filling the card.
  //
  // ⚠️ A week with zero entries (nobody scored) is real and common — the
  // very first week of a fresh season is exactly this. `lines.join("\n")`
  // would be `""`, and Discord's API refuses an embed carrying a field with
  // an empty value, failing the WHOLE reply with `HANDLER_FAILED`. Render
  // the site's own sentence instead of an empty value.
  const b = budget("Alphas".length);
  // Leave room for the overflow notice's own field when there might be one —
  // otherwise a season that fills exactly `MAX_FIELDS` weeks leaves no slot
  // for the "+N more" field and the overflow goes unreported.
  const cap = a.weeks.length > MAX_FIELDS ? MAX_FIELDS - 1 : a.weeks.length;
  let shown = 0;
  for (const w of a.weeks.slice(0, cap)) {
    const lines = w.entries.map((e) => `• ${e.rank}. ${e.name} [${e.tag}] — ${e.points} pts`);
    const added = b.field(embed, when(w.weekStart), lines.length > 0 ? lines.join("\n") : NO_ALPHAS_WEEK);
    if (!added) break;
    shown += 1;
  }
  if (shown < a.weeks.length) b.field(embed, "…", `+${a.weeks.length - shown} more — see the site.`);
  return embed;
}

/** `/seasons` — every closed season and its champion. */
export function seasonsEmbed(list: SeasonSummary[], siteBaseUrl: string): EmbedBuilder {
  const title = "Seasons";
  const embed = new EmbedBuilder().setColor(GOLD).setTitle(title).setURL(`${siteBaseUrl}/seasons`);
  if (list.length === 0) return embed.setDescription(NO_SEASONS);

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
  if (entries.length === 0) return embed.setDescription(EMPTY_WAR_LOG);

  const b = budget(title.length);
  const line = (e: WarLogEntry) =>
    e.kind === "raid"
      ? `• ⚔️ ${when(e.at)} — **${e.raider?.name ?? "no clan"}** raided **${e.victim.name}** (${e.points} pts)`
      : `• 🛡️ ${when(e.at)} — **${e.victim.name}** held, ${Math.round(e.durationSeconds / 60)} min under siege`;
  b.list(embed, title, entries.map(line), (n) => `+${n} more — see the site.`);
  return embed;
}
