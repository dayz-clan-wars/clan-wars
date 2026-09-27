import type { ReactNode } from "react";
import type { ReferralsView } from "@factions/roster";
import { link } from "@/app/components/ui";

/**
 * "N players: A, B" for the ones still linked, "and K players no longer
 * linked" appended for the ones a referral outlived (spec: referrals are
 * keyed by Discord id and survive unlink — an unlinked player is counted,
 * never named, because a gamertag with no current link cannot be pointed
 * at).
 */
export function broughtLine(brought: ReferralsView["brought"]): string {
  const named = brought.filter((b): b is { gamertag: string } => b.gamertag !== null).map((b) => b.gamertag);
  const unnamed = brought.length - named.length;
  const parts = [
    ...(named.length > 0 ? [named.join(", ")] : []),
    ...(unnamed > 0 ? [`${unnamed} ${unnamed === 1 ? "player" : "players"} no longer linked`] : []),
  ];
  const detail = parts.length > 0 ? `: ${parts.join(" and ")}` : "";
  return `Brought in ${brought.length} ${brought.length === 1 ? "player" : "players"}${detail}`;
}

/**
 * The public profile's referral rows for an existing Facts panel — "Referred
 * by" and "Brought in", each only when there is something to show. `view`
 * is null for an unlinked profile or a failed read (the page's own
 * `.catch(() => null)`, same discipline as `achievementsFor`): either way
 * this renders nothing, never a placeholder.
 */
export function referralFactRows(view: ReferralsView | null): [ReactNode, ReactNode][] {
  if (!view) return [];
  const rows: [ReactNode, ReactNode][] = [];
  if (view.referredBy) {
    rows.push(["Referred by", <a key="referred-by" className={link} href={`/players/${encodeURIComponent(view.referredBy.gamertag)}`}>{view.referredBy.gamertag}</a>]);
  }
  if (view.brought.length > 0) {
    rows.push(["Brought in", broughtLine(view.brought)]);
  }
  return rows;
}
