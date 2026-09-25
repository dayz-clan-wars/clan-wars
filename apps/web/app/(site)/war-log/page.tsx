import type { Metadata } from "next";
import { warLog } from "@factions/roster";
import { EMPTY_WAR_LOG } from "@/lib/scoring-copy";
import { WarLogDays } from "./entry";
import { Page, PageHead, Body, Panel, SegNav } from "@/app/components/ui";
import { guideLinkFor } from "@/lib/guide-links";

export const metadata: Metadata = { title: "Clan Wars — war log" };
/** ⚠️ Public, but LIVE: rendered per request so the build never bakes a roster into a static chunk (spec §10.1). */
export const dynamic = "force-dynamic";

const TAG_RE = /^[A-Za-z0-9]{1,8}$/u;

export default async function WarLogPage({ searchParams }: { searchParams: Promise<{ clan?: string | string[]; kind?: string | string[] }> }) {
  const sp = await searchParams;
  // ⚠️ Both are attacker-supplied: the tag is matched, never echoed unmatched, and the kind is one of two words or nothing.
  const rawTag = typeof sp.clan === "string" && TAG_RE.test(sp.clan) ? sp.clan.toUpperCase() : undefined;
  const kind = sp.kind === "raid" || sp.kind === "defense" ? sp.kind : undefined;
  const entries = await warLog(200, { clanTag: rawTag, kind });
  const asRaider = entries.find((e) => e.kind === "raid" && e.raider?.tag === rawTag);
  const clanName = rawTag ? (entries.find((e) => e.victim.tag === rawTag)?.victim.name ?? (asRaider?.kind === "raid" ? asRaider.raider?.name : undefined) ?? null) : null;
  const href = (k?: string) => {
    const q = [rawTag && `clan=${encodeURIComponent(rawTag)}`, k && `kind=${k}`].filter(Boolean);
    return `/war-log${q.length ? `?${q.join("&")}` : ""}`;
  };

  return (
    <Page wide>
      <PageHead guide={guideLinkFor("/war-log")} kicker="War log" title="Recent action"
        sub={rawTag ? <>{clanName ?? `[${rawTag}]`} only · <a className="text-gold underline-offset-4 hover:underline" href={href(kind)}>every clan</a></> : undefined}
        aside={<SegNav label="Kind" items={[
          { label: "All", href: href(), current: !kind },
          { label: "Raids", href: href("raid"), current: kind === "raid" },
          { label: "Defenses", href: href("defense"), current: kind === "defense" },
        ]} />} />
      <Body>
        {entries.length === 0 ? (
          <p className="text-ink-2">{EMPTY_WAR_LOG}</p>
        ) : (
          <>
            <Panel>
              <WarLogDays entries={entries} />
            </Panel>
            <p className="mt-4 font-mono text-[11px] text-muted">The last 200 {kind === "raid" ? "raids" : kind === "defense" ? "defenses" : "entries"}{rawTag ? ` involving ${clanName ?? rawTag}` : ""}. Older action lives in the season records.</p>
          </>
        )}
      </Body>
    </Page>
  );
}
