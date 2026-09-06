import type { WarLogKind } from "@factions/domain";
import type { NoticePayload } from "@factions/roster/internal";
import { duration } from "./notice-text.js";

/**
 * The four #war-log lines that exist (spec §9.2). `week_closed` (increment
 * 4 task 3, week-tick.ts) and `season_closed` (increment 4 task 5,
 * season-close.ts) each now have a writer.
 */
export function warLogText(e: { kind: WarLogKind; payload: NoticePayload }, siteBaseUrl: string): string {
  const p = e.payload;
  switch (e.kind) {
    case "raid":
      return p.solo
        ? `⚔️ **${p.victimClan}** was raided — flag lowered by ${p.gamertag} (no clan)`
        : `⚔️ **${p.raiderClan}** raided **${p.victimClan}** — flag lowered by ${p.gamertag}`;
    case "defense":
      return `🛡️ **${p.victimClan}** raised their colors again — ${duration(Number(p.durationSeconds))} under siege`;
    // `week_closed` (§9.2, ruling for fewer than three): `first === null`
    // means nobody scored; otherwise render only the Alphas actually present
    // (one, two, or three) — a week with fewer than three raiders is not
    // padded with placeholders.
    case "week_closed": {
      if (p.first === null) return "🏆 No Alphas this week — nobody scored.";
      const entries: [unknown, unknown][] = [[p.first, p.p1], [p.second, p.p2], [p.third, p.p3]];
      const present = entries.filter((e): e is [string, number] => e[0] !== null && e[0] !== undefined);
      const names = present.map(([name]) => `**${name}**`).join(", ");
      const points = present.map(([, pts]) => pts).join(" / ");
      return `🏆 Alphas this week: ${names} — ${points}`;
    }
    case "season_closed":
      return p.clan === null
        ? `🏁 Season ${p.number} is over. Nobody scored. Full table: ${siteBaseUrl}/seasons`
        : `🏁 Season ${p.number} is over. Champion: **${p.clan}** with ${p.points}. Full table: ${siteBaseUrl}/seasons`;
  }
}
