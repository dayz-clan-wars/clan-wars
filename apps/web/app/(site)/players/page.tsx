import type { Metadata } from "next";
import { playerBoards } from "@factions/roster";
import { parseSeasonParam } from "@/lib/stat-scope";
import { StatBoards, ScopePicker } from "@/app/components/stat-boards";
import { FindPlayer } from "@/app/components/find-player";
import { Page, PageHead, Body } from "@/app/components/ui";
import { guideLinkFor } from "@/lib/guide-links";

export const metadata: Metadata = { title: "Clan Wars — players" };
/** ⚠️ Public, but LIVE: rendered per request so the build never bakes a roster into a static chunk (spec §10.1). */
export const dynamic = "force-dynamic";

export default async function PlayersPage({ searchParams }: { searchParams: Promise<{ season?: string | string[] }> }) {
  const { season } = await searchParams;
  const parsed = parseSeasonParam(season);

  // ⚠️ ?season= is looked up, never echoed. A "default" parse becomes
  // `{ kind: "current" }`, which the roster resolves against its own `seasons`
  // list — ONE call on every path, never a probe fetch and a real one.
  // `boards.scope` comes back resolved, so the page never renders "current".
  const boards = await playerBoards(parsed === "default" ? { kind: "current" } : parsed);

  return (
    <Page wide>
      <PageHead guide={guideLinkFor("/players")} kicker="Players" title="Player boards" aside={<ScopePicker seasons={boards.seasons} basePath="/players" current={boards.scope} />} />
      <Body className="flex flex-col gap-4 lg:gap-6">
        <FindPlayer />
        <StatBoards boards={boards} />
      </Body>
    </Page>
  );
}
