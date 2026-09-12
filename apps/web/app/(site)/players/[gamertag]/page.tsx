import type { Metadata } from "next";
import { decodeParam } from "@/lib/route-param";
import { notFound } from "next/navigation";
import { playerProfile, playerFeed, viewerFor, achievementsFor, type PlayerProfile } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { isOwnPage } from "@/lib/own-page";
import { UNLINK_COPY } from "@/lib/link-copy";
import { RESULT_COPY } from "@/lib/clan-copy";
import { lookupCopy } from "@/lib/copy-lookup";
import { loadOwner, OwnerStrip, OwnerPanels, AccountPanel, SignOut } from "@/app/components/owner";
import { parsePageParam } from "@/lib/board-page";
import { PlayerFeedPanel, OpponentRows } from "@/app/components/player-feed";
import { AchievementWall } from "@/app/components/achievement-wall";
import { parseSeasonParam } from "@/lib/stat-scope";
import { EMPTY_BOARD, playTime, scopeLabel } from "@/lib/stats-copy";
import { ScopePicker } from "@/app/components/stat-boards";
import { ago } from "@/lib/format";
import { guideLinkFor } from "@/lib/guide-links";
import { Page, PageHead, Body, Panel, PanelBody, Facts, BackLine, Footer, kickerSm, kicker, link } from "@/app/components/ui";
import { ClanHero, Lit } from "@/app/components/clan-hero";
import { flagImagePath } from "@/src/flag-images";

export const metadata: Metadata = { title: "Clan Wars — player" };
/**
 * ⚠️ Public, but LIVE: rendered per request so the build never bakes a roster
 * into a static chunk (spec §10.1). Also the signed-in owner's home: when the
 * viewer's linked gamertag is this page's (lib/own-page.ts), their controls
 * render here too — the next step, invites, requests, unlink, sign out.
 * Anyone else sees the plain profile. The middleware does not gate this
 * path, so the session is read here; every control posts to a route that
 * checks it again.
 */
export const dynamic = "force-dynamic";

/** Killed-by / killed lists are uncapped in the package; render at most this many, "and N more" for the rest. */
const LIST_LIMIT = 10;

function OpponentList({ items, encounters, me, side }: {
  items: { gamertag: string; count: number }[]; encounters: PlayerProfile["encounters"]; me: string; side: "killed" | "killedBy";
}) {
  if (items.length === 0) return <p className="text-sm text-ink-2">{EMPTY_BOARD}</p>;
  const shown = items.slice(0, LIST_LIMIT);
  const rest = items.length - shown.length;
  return (
    <>
      <OpponentRows items={shown} encounters={encounters} me={me} side={side} />
      {rest > 0 && <p className="mt-2 text-xs text-ink-2">and {rest} more</p>}
    </>
  );
}

export default async function PlayerProfilePage({
  params, searchParams,
}: {
  params: Promise<{ gamertag: string }>;
  searchParams: Promise<{ season?: string | string[]; page?: string | string[]; unlink?: string; result?: string }>;
}) {
  // ⚠️ Decoded: a gamertag with a space arrives as `IGC%20slide`, and the raw value finds nobody.
  const gamertag = decodeParam((await params).gamertag);
  const { season, page: rawPage, unlink: unlinkCode, result } = await searchParams;
  const parsed = parseSeasonParam(season);
  const scope = parsed === "default" ? { kind: "current" as const } : parsed;

  // ⚠️ Same as /players: `{ kind: "current" }` is resolved inside the roster.
  // The profile and its feed page are the two reads, side by side.
  // ⚠️ The wall is lifetime, never scoped, and `.catch(() => null)` on purpose:
  // an achievement read that fails must cost the page its wall, never the profile.
  const [profile, feed, session, wall] = await Promise.all([playerProfile(gamertag, scope), playerFeed(gamertag, scope, parsePageParam(rawPage)), currentSession(), achievementsFor({ gamertag }).catch(() => null)]);

  if (!profile || !feed) notFound();
  // The viewer's link decides ownership; the rest of the owner's state is only read once it does.
  const viewer = session ? await viewerFor(session.sub) : null;
  const owner = session && viewer && isOwnPage(viewer.link?.gamertag, profile.gamertag) ? await loadOwner(session, viewer) : null;
  // ⚠️ Looked up, never echoed: ?unlink= and ?result= are attacker-supplied (see lib/copy-lookup.ts). Only the owner's notices, on the owner's page.
  const notices = owner ? [unlinkCode ? lookupCopy(UNLINK_COPY, unlinkCode) : undefined, result ? lookupCopy(RESULT_COPY, result) : undefined] : [];
  const basePath = `/players/${encodeURIComponent(profile.gamertag)}`;

  const guide = guideLinkFor("/players/[gamertag]");
  const picker = <ScopePicker seasons={profile.seasons} basePath={basePath} current={profile.scope} />;
  const notLinked = !profile.linked && " · not linked";
  const who = owner ? "You" : "Player";
  // The mono line under the name, on both heads: the scope's headline numbers.
  const facts = [
    <><Lit>{playTime(profile.playTimeSeconds)}</Lit> played</>,
    <><Lit>{profile.pvpKills}</Lit> kills</>,
    <><Lit>{profile.pvpDeaths}</Lit> deaths</>,
    ...(profile.lastSeenAt ? [<>Seen <Lit>{ago(profile.lastSeenAt)}</Lit></>] : []),
  ];

  return (
    <Page wide>
      {profile.clan ? (
        // A member: their clan's colours, the way the clan pages wear them, with the clan named and linked in the kicker.
        <ClanHero compact flagSrc={`/${flagImagePath(profile.clan.texture)}`} guide={guide} title={profile.gamertag} facts={facts} aside={picker}
          kicker={<>{who} · [{profile.clan.tag}] <a className={link} href={`/clans/${encodeURIComponent(profile.clan.tag)}`}>{profile.clan.name}</a>{notLinked}</>} />
      ) : (
        <PageHead guide={guide} kicker={<>{who} · no clan{notLinked}</>} title={profile.gamertag} aside={picker}
          sub={<div className={`${kicker} flex flex-wrap gap-x-5 gap-y-2`}>{facts.map((f, i) => <span key={i}>{f}</span>)}</div>} />
      )}
      <Body>
        <p className="sr-only">{scopeLabel(profile.scope)}</p>
        {owner && <div className="mb-4 empty:hidden lg:mb-6"><OwnerStrip owner={owner} notices={notices} /></div>}
        <div className="grid gap-4 lg:grid-cols-2 lg:gap-6">
          <div className="flex flex-col gap-4 lg:gap-6">
            {owner && <AccountPanel owner={owner} />}
            <Panel title="Activity"><PanelBody>
              <Facts items={[["Play time", playTime(profile.playTimeSeconds)], ["Sessions", profile.sessions], ["Last seen", profile.lastSeenAt ? ago(profile.lastSeenAt) : "—"]]} />
            </PanelBody></Panel>
            <Panel title="PvP"><PanelBody>
              <Facts items={[["Kills", profile.pvpKills], ["Deaths", profile.pvpDeaths], ["K/D", profile.kd ?? "—"], ["Best streak", profile.bestStreak], ["Longest kill", profile.longestKill ? <>{profile.longestKill.distanceM} m{profile.longestKill.weapon && <span className="text-muted"> · {profile.longestKill.weapon}</span>}</> : "—"]]} />
            </PanelBody></Panel>
            <Panel title="Friendly fire"><PanelBody>
              <Facts items={[["Kills", profile.friendlyFireKills], ["Deaths", profile.friendlyFireDeaths]]} />
            </PanelBody></Panel>
            <Panel title="Raiding"><PanelBody>
              <Facts items={[["Raid credits", profile.raidCredits], ["Upkeep raises", profile.upkeepRaises]]} />
            </PanelBody></Panel>
            <Panel title="Building"><PanelBody>
              <Facts items={[["Build points", profile.buildPoints]]} />
            </PanelBody></Panel>
          </div>
          <div className="flex flex-col gap-4 lg:gap-6">
            {owner && <OwnerPanels owner={owner} wall={wall} />}
            <Panel title="Killed by"><PanelBody><OpponentList items={profile.killedBy} encounters={profile.encounters} me={profile.gamertag} side="killedBy" /></PanelBody></Panel>
            <Panel title="Killed"><PanelBody><OpponentList items={profile.killed} encounters={profile.encounters} me={profile.gamertag} side="killed" /></PanelBody></Panel>
            <Panel title="Clan history"><PanelBody>
              {profile.clanHistory.length === 0 ? (
                <p className="text-sm text-ink-2">{EMPTY_BOARD}</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {profile.clanHistory.map((c, i) => (
                    <li key={`${c.tag}-${i}`} className="text-sm text-ink">
                      <span className="font-mono text-ink-2">[{c.tag}]</span> {c.name} <span className={`${kickerSm} ml-1`}>joined {ago(c.joinedAt)} · {c.leftAt ? `left ${ago(c.leftAt)}` : "still a member"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </PanelBody></Panel>
          </div>
          {wall && <AchievementWall wall={wall} className="lg:col-span-2" />}
        </div>
        <div className="mt-4 lg:mt-6">
          <PlayerFeedPanel feed={feed} basePath={basePath} />
        </div>
        <BackLine href="/players">Player boards</BackLine>
      </Body>
      {owner && <Footer><SignOut /></Footer>}
    </Page>
  );
}
