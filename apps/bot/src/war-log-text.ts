import type { WarLogKind } from "@factions/domain";
import type { NoticePayload } from "@factions/roster/internal";
import { at } from "@factions/copy";
import { duration } from "./notice-text.js";
import { clanLink, playerLink } from "./site-links.js";

/** A clan links only when its tag was frozen into the payload; older rows have none. */
function clan(site: string, name: unknown, tag: unknown): string {
  return typeof tag === "string" && tag !== "" ? clanLink(site, tag, String(name)) : `**${String(name)}**`;
}

/**
 * The four #war-log lines that exist (spec §9.2). `week_closed` (increment
 * 4 task 3, week-tick.ts) and `season_closed` (increment 4 task 5,
 * season-close.ts) each now have a writer.
 */
export function warLogText(e: { kind: WarLogKind; occurredAt?: Date; payload: NoticePayload }, siteBaseUrl: string): string {
  const p = e.payload;
  switch (e.kind) {
    case "raid":
      return p.solo
        ? `⚔️ ${clan(siteBaseUrl, p.victimClan, p.victimTag)} was raided — flag lowered by ${playerLink(siteBaseUrl, String(p.gamertag))} (no clan)`
        : `⚔️ ${clan(siteBaseUrl, p.raiderClan, p.raiderTag)} raided ${clan(siteBaseUrl, p.victimClan, p.victimTag)} — flag lowered by ${playerLink(siteBaseUrl, String(p.gamertag))}`;
    case "defense":
      return `🛡️ ${clan(siteBaseUrl, p.victimClan, p.victimTag)} raised their colors again — ${duration(Number(p.durationSeconds))} under siege`;
    // `week_closed` (§9.2, ruling for fewer than three): `first === null`
    // means nobody scored; otherwise render only the Alphas actually present
    // (one, two, or three) — a week with fewer than three raiders is not
    // padded with placeholders.
    case "week_closed": {
      if (p.first === null) return "🏆 No Alphas this week — nobody scored.";
      const entries: [unknown, unknown, unknown][] = [[p.first, p.t1, p.p1], [p.second, p.t2, p.p2], [p.third, p.t3, p.p3]];
      const present = entries.filter((e): e is [string, unknown, number] => e[0] !== null && e[0] !== undefined);
      const names = present.map(([name, tag]) => clan(siteBaseUrl, name, tag)).join(", ");
      const points = present.map(([, , pts]) => pts).join(" / ");
      return `🏆 Alphas this week: ${names} — ${points}`;
    }
    case "season_closed": {
      // Masked, per the brief: `/seasons` is a table, not a clan page, so it
      // links through plain text rather than clan()/clanUrl.
      const link = `Full table: [seasons](<${siteBaseUrl}/seasons>)`;
      // ⚠️ `at()` degrades to null on an unrepresentable instant (copy's
      // contract); the caller — here — owns the fallback, which is simply
      // to drop the clause rather than post a literal `<t:NaN:F>`.
      const when = e.occurredAt && at(e.occurredAt);
      const closed = when ? `Season ${p.number} is over ${when}.` : `Season ${p.number} is over.`;
      return p.clan === null
        ? `🏁 ${closed} Nobody scored. ${link}`
        : `🏁 ${closed} Champion: ${clan(siteBaseUrl, p.clan, p.tag)} with ${p.points}. ${link}`;
    }
  }
}
