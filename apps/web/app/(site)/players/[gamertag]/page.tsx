import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { playerProfile } from "@factions/roster";
import { parseSeasonParam } from "@/lib/stat-scope";
import { EMPTY_BOARD, playTime, scopeLabel } from "@/lib/stats-copy";
import { ScopePicker } from "@/app/components/stat-boards";
import { when } from "@/lib/format";
import { guideLinkFor } from "@/lib/guide-links";
import { Page, PageHead, Body, Panel, PanelBody, Facts, BackLine, kickerSm } from "@/app/components/ui";

export const metadata: Metadata = { title: "Clan Wars — player" };
/** ⚠️ Public, but LIVE: rendered per request so the build never bakes a roster into a static chunk (spec §10.1). */
export const dynamic = "force-dynamic";

/** Killed-by / killed lists are uncapped in the package; render at most this many, "and N more" for the rest. */
const LIST_LIMIT = 10;

function OpponentList({ items }: { items: { gamertag: string; count: number }[] }) {
  if (items.length === 0) return <p className="text-sm text-ink-2">{EMPTY_BOARD}</p>;
  const shown = items.slice(0, LIST_LIMIT);
  const rest = items.length - shown.length;
  return (
    <ul className="flex flex-col">
      {shown.map((o) => (
        <li key={o.gamertag} className="flex min-h-[40px] items-center justify-between border-t border-rule-2 text-sm text-ink first:border-t-0">
          <a className="underline-offset-4 hover:underline" href={`/players/${encodeURIComponent(o.gamertag)}`}>{o.gamertag}</a>
          <span className="font-mono text-ink-2">{o.count}</span>
        </li>
      ))}
      {rest > 0 && <li className="text-xs text-ink-2">and {rest} more</li>}
    </ul>
  );
}

export default async function PlayerProfilePage({
  params, searchParams,
}: {
  params: Promise<{ gamertag: string }>;
  searchParams: Promise<{ season?: string | string[] }>;
}) {
  const { gamertag } = await params;
  const { season } = await searchParams;
  const parsed = parseSeasonParam(season);

  // ⚠️ Same as /players: `{ kind: "current" }` is resolved inside the roster,
  // so this is ONE call on every path — `resolvePlayer` runs once, not twice.
  const profile = await playerProfile(gamertag, parsed === "default" ? { kind: "current" } : parsed);

  if (!profile) notFound();

  return (
    <Page wide>
      <PageHead guide={guideLinkFor("/players/[gamertag]")} kicker={<>Player{!profile.linked && " · not linked"}</>} title={profile.gamertag}
        aside={<ScopePicker seasons={profile.seasons} basePath={`/players/${encodeURIComponent(profile.gamertag)}`} current={profile.scope} />} />
      <Body>
        <p className="sr-only">{scopeLabel(profile.scope)}</p>
        <div className="grid gap-4 lg:grid-cols-2 lg:gap-6">
          <div className="flex flex-col gap-4 lg:gap-6">
            <Panel num="01" title="Activity"><PanelBody>
              <Facts items={[["Play time", playTime(profile.playTimeSeconds)], ["Sessions", profile.sessions], ["Last seen", profile.lastSeenAt ? when(profile.lastSeenAt) : "—"]]} />
            </PanelBody></Panel>
            <Panel num="02" title="PvP"><PanelBody>
              <Facts items={[["Kills", profile.pvpKills], ["Deaths", profile.pvpDeaths], ["K/D", profile.kd ?? "—"]]} />
            </PanelBody></Panel>
            <Panel num="03" title="Friendly fire"><PanelBody>
              <Facts items={[["Kills", profile.friendlyFireKills], ["Deaths", profile.friendlyFireDeaths]]} />
            </PanelBody></Panel>
            <Panel num="04" title="Raiding"><PanelBody>
              <Facts items={[["Raid credits", profile.raidCredits], ["Upkeep raises", profile.upkeepRaises]]} />
            </PanelBody></Panel>
          </div>
          <div className="flex flex-col gap-4 lg:gap-6">
            <Panel num="05" title="Killed by"><PanelBody><OpponentList items={profile.killedBy} /></PanelBody></Panel>
            <Panel num="06" title="Killed"><PanelBody><OpponentList items={profile.killed} /></PanelBody></Panel>
            <Panel num="07" title="Clan history"><PanelBody>
              {profile.clanHistory.length === 0 ? (
                <p className="text-sm text-ink-2">{EMPTY_BOARD}</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {profile.clanHistory.map((c, i) => (
                    <li key={`${c.tag}-${i}`} className="text-sm text-ink">
                      <span className="font-mono text-ink-2">[{c.tag}]</span> {c.name} <span className={`${kickerSm} ml-1`}>joined {when(c.joinedAt)} · {c.leftAt ? `left ${when(c.leftAt)}` : "still a member"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </PanelBody></Panel>
          </div>
        </div>
        <BackLine href="/players">Player boards</BackLine>
      </Body>
    </Page>
  );
}
