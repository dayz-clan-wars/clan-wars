import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { boardPage } from "@factions/roster";
import { parseSeasonParam } from "@/lib/stat-scope";
import { BOARD_SLUGS, boardKindFromSlug, parsePageParam } from "@/lib/board-page";
import { BOARD_LABELS } from "@/lib/stats-copy";
import { ScopePicker } from "@/app/components/stat-boards";
import { FullBoard } from "@/app/components/full-board";
import { Page, PageHead, Body, BackLine } from "@/app/components/ui";
import { guideLinkFor } from "@/lib/guide-links";

type Params = { params: Promise<{ board: string }>; searchParams: Promise<{ season?: string | string[]; page?: string | string[] }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const kind = boardKindFromSlug((await params).board);
  return { title: kind ? `Clan Wars — ${BOARD_LABELS[kind].toLowerCase()}` : "Clan Wars — players" };
}
/** ⚠️ Public, but LIVE: rendered per request, like /players. */
export const dynamic = "force-dynamic";

/** One public board, every player, 50 a page. The segment is looked up in BOARD_SLUGS, never echoed. */
export default async function PublicBoardPage({ params, searchParams }: Params) {
  const kind = boardKindFromSlug((await params).board);
  if (!kind) notFound();
  const { season, page: rawPage } = await searchParams;
  const parsed = parseSeasonParam(season);
  const page = await boardPage(kind, parsed === "default" ? { kind: "current" } : parsed, parsePageParam(rawPage));
  const basePath = "/players/boards";

  return (
    <Page wide>
      <PageHead guide={guideLinkFor("/players/boards/[board]")} kicker="Players" title={BOARD_LABELS[kind]}
        aside={<ScopePicker seasons={page.seasons} basePath={`${basePath}/${BOARD_SLUGS[kind]}`} current={page.scope} />} />
      <Body className="max-w-[48rem]">
        <FullBoard page={page} basePath={basePath} />
        <BackLine href="/players">Player boards</BackLine>
      </Body>
    </Page>
  );
}
