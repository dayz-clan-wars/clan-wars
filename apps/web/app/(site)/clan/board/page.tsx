import type { Metadata } from "next";
import { clanBoard, clanFor, type Boards, type ActorRefusal } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { REFUSAL } from "@/lib/clan-copy";
import { parseSeasonParam } from "@/lib/stat-scope";
import { StatBoards, ScopePicker } from "@/app/components/stat-boards";
import { guideLinkFor } from "@/lib/guide-links";
import { Page, PageHead, Body, BackLine, SessionLost, link } from "@/app/components/ui";
import { OwnClanHero } from "@/app/components/own-clan-hero";

export const metadata: Metadata = { title: "Clan Wars — clan board", robots: { index: false, follow: false } };
/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

function isRefusal(v: Boards | ActorRefusal): v is ActorRefusal {
  return typeof v === "string";
}

export default async function ClanBoardPage({ searchParams }: { searchParams: Promise<{ season?: string | string[] }> }) {
  const session = await currentSession();
  if (!session) return <SessionLost next="/clan/board" />;
  const { season } = await searchParams;
  const parsed = parseSeasonParam(season);

  // ⚠️ ONE call on every path, refusal included: `{ kind: "current" }` is
  // resolved inside the roster from its own `seasons` list, so a "default"
  // parse no longer needs an all-time probe first.
  const boards = await clanBoard(session.sub, parsed === "default" ? { kind: "current" } : parsed);
  if (isRefusal(boards)) {
    return (
      <Page>
        <PageHead guide={guideLinkFor("/clan/board")} kicker="Clan board" title="No board yet" />
        <Body className="max-w-[40rem]">
          <p className="text-ink-2">{REFUSAL[boards]} <a className={link} href="/clan">Your clan</a>.</p>
        </Body>
      </Page>
    );
  }

  // The hero's data. A board exists only for a full member, so this is a ClanView on every path that reaches here.
  const view = await clanFor(session.sub);
  return (
    <Page wide>
      {typeof view === "string"
        ? <PageHead guide={guideLinkFor("/clan/board")} kicker="Clan board" title={<>Your clan&rsquo;s boards</>} />
        : <OwnClanHero view={view} current="board" guide={guideLinkFor("/clan/board")} />}
      <Body>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 lg:mb-6">
          <h2 className="font-display text-sm uppercase tracking-[0.06em] text-ink">Your clan&rsquo;s boards</h2>
          <ScopePicker seasons={boards.seasons} basePath="/clan/board" current={boards.scope} />
        </div>
        <StatBoards boards={boards} />
        <BackLine href="/clan">Your clan</BackLine>
      </Body>
    </Page>
  );
}
