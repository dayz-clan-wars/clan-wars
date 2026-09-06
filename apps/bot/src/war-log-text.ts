import type { WarLogKind } from "@factions/domain";
import type { NoticePayload } from "@factions/roster/internal";
import { duration } from "./notice-text.js";

/**
 * The four #war-log lines that exist (spec §9.2). `week_closed` and
 * `season_closed` render from their payloads even though nothing on this
 * branch writes them yet — increment 4 will.
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
    // ⚠️ `week_closed` and `season_closed` have NO writer on this branch:
    // increment 4's weekly/season close job is the other half of this
    // contract. Until it lands, the payload shapes below (first/second/third +
    // p1/p2/p3; number/clan/points) are pinned only by war-log-text.test.ts's
    // hand-built payloads — that writer must match them or change both.
    case "week_closed":
      return p.first === null
        ? "🏆 No Alphas this week — nobody scored."
        : `🏆 Alphas this week: **${p.first}**, **${p.second}**, **${p.third}** — ${p.p1} / ${p.p2} / ${p.p3}`;
    case "season_closed":
      return `🏁 Season ${p.number} is over. Champion: **${p.clan}** with ${p.points}. Full table: ${siteBaseUrl}/seasons`;
  }
}
