import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { clanBoardPage, clanFor } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { REFUSAL } from "@/lib/clan-copy";
import { parseSeasonParam } from "@/lib/stat-scope";
import { BOARD_SLUGS, boardKindFromSlug, parsePageParam } from "@/lib/board-page";
import { BOARD_LABELS } from "@/lib/stats-copy";
import { ScopePicker } from "@/app/components/stat-boards";
import { FullBoard } from "@/app/components/full-board";
import { guideLinkFor } from "@/lib/guide-links";
import { Page, PageHead, Body, BackLine, SessionLost, link } from "@/app/components/ui";
import { OwnClanHero } from "@/app/components/own-clan-hero";

type Params = { params: Promise<{ board: string }>; searchParams: Promise<{ season?: string | string[]; page?: string | string[] }> };

export const metadata: Metadata = { title: "Clan Wars — clan board", robots: { index: false, follow: false } };
/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

/** One of your clan's boards, every member, 50 a page. Hero and tabs stay, with Board lit. */
export default async function ClanFullBoardPage({ params, searchParams }: Params) {
  const kind = boardKindFromSlug((await params).board);
  if (!kind) notFound();
  const basePath = "/clan/board";
  const session = await currentSession();
  if (!session) return <SessionLost next={`${basePath}/${BOARD_SLUGS[kind]}`} />;
  const { season, page: rawPage } = await searchParams;
  const parsed = parseSeasonParam(season);

  const page = await clanBoardPage(session.sub, kind, parsed === "default" ? { kind: "current" } : parsed, parsePageParam(rawPage));
  if (typeof page === "string") {
    return (
      <Page>
        <PageHead guide={guideLinkFor("/clan/board/[board]")} kicker="Clan board" title="No board yet" />
        <Body className="max-w-[40rem]">
          <p className="text-ink-2">{REFUSAL[page]} <a className={link} href="/clan">Your clan</a>.</p>
        </Body>
      </Page>
    );
  }

  const view = await clanFor(session.sub);
  return (
    <Page wide>
      {typeof view === "string"
        ? <PageHead guide={guideLinkFor("/clan/board/[board]")} kicker="Clan board" title={BOARD_LABELS[kind]} />
        : <OwnClanHero view={view} current="board" guide={guideLinkFor("/clan/board/[board]")} />}
      <Body>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 lg:mb-6">
          <h2 className="font-display text-sm uppercase tracking-[0.06em] text-ink">{BOARD_LABELS[kind]}</h2>
          <ScopePicker seasons={page.seasons} basePath={`${basePath}/${BOARD_SLUGS[kind]}`} current={page.scope} />
        </div>
        <div className="max-w-[48rem]">
          <FullBoard page={page} basePath={basePath} />
        </div>
        <BackLine href="/clan/board">Your clan&rsquo;s boards</BackLine>
      </Body>
    </Page>
  );
}
