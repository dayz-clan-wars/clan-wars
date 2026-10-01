import type { LiveRow } from "@factions/roster";
import { LIVE_FEEDS, type LiveFeed, type LiveKill, type LiveHitRun, type LiveStreak, type LiveLongRange } from "@factions/domain";
import { killCard, hitCard, streakCard, longRangeCard, clanFeedCard, warLogLine, banLine, achievementLine, type Line, type LiveCard } from "@factions/copy";

// Pure shaping, no roster value import: a client component may import this file.
export type LiveItem = {
  id: number; at: string; title: Line | null; href: string | null; lines: Line[]; detail: Line[];
  flag: string | null; badge: { key: string } | null; tone: "plain" | "warn";
};

const LABELS: Record<LiveFeed, string> = {
  online: "Online", kills: "Kills", hits: "Hits", streaks: "Streaks", "long-range": "Long range",
  clans: "Clans", "war-log": "War log", achievements: "Achievements", bans: "Bans",
};
export const LIVE_TABS: { feed: LiveFeed; label: string }[] = LIVE_FEEDS.map((feed) => ({ feed, label: LABELS[feed] }));

/** Attacker-supplied. A positive safe integer, or nothing: never reaches SQL as anything else. */
export function parseCursor(v: string | string[] | null | undefined): number | undefined {
  if (typeof v !== "string" || !/^[1-9][0-9]{0,15}$/u.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : undefined;
}

type Stamp = { id: number; occurredAt: Date };

const card = (c: LiveCard, row: Stamp, extra: Partial<LiveItem>): LiveItem => ({
  id: row.id, at: row.occurredAt.toISOString(), title: c.title, href: c.href, lines: c.lines, detail: c.detail,
  flag: null, badge: null, tone: "plain", ...extra,
});
const line = (l: Line, row: Stamp, extra: Partial<LiveItem> = {}): LiveItem => ({
  id: row.id, at: row.occurredAt.toISOString(), title: null, href: null, lines: [l], detail: [],
  flag: null, badge: null, tone: "plain", ...extra,
});

export function toLiveItem(row: LiveRow): LiveItem {
  switch (row.feed) {
    case "kills": { const k = row.payload as LiveKill; return card(killCard(k), row, { flag: k.killer.texture, tone: k.friendlyFire || k.atHub ? "warn" : "plain" }); }
    case "hits": { const h = row.payload as LiveHitRun; return card(hitCard(h), row, { flag: h.attacker.texture, tone: h.friendlyFire ? "warn" : "plain" }); }
    case "streaks": { const s = row.payload as LiveStreak; return card(streakCard(s), row, { flag: s.killer.texture }); }
    case "long-range": { const l = row.payload as LiveLongRange; return card(longRangeCard(l), row, { flag: l.killer.texture, tone: l.friendlyFire ? "warn" : "plain" }); }
    case "clans": return card(clanFeedCard(row.kind, row.payload), row, { flag: row.payload.texture });
    case "war-log": return line(warLogLine(row.kind, row.payload, row.occurredAt.toISOString()), row);
    case "achievements": return line(achievementLine(row.payload), row, { badge: { key: row.payload.key } });
    case "bans": return line(banLine({ kind: row.kind, ...row.payload }), row);
  }
}
