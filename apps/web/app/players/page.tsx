import type { Metadata } from "next";
import { playerBoards } from "@factions/roster";
import { parseSeasonParam } from "@/lib/stat-scope";
import { StatBoards, ScopePicker } from "@/app/components/stat-boards";

export const metadata: Metadata = { title: "Clan Wars — players" };
/** ⚠️ Public, but LIVE: rendered per request so the build never bakes a roster into a static chunk (spec §10.1). */
export const dynamic = "force-dynamic";

const label = "font-mono text-xs uppercase tracking-[0.18em] text-muted";

export default async function PlayersPage({ searchParams }: { searchParams: Promise<{ season?: string | string[] }> }) {
  const { season } = await searchParams;
  const parsed = parseSeasonParam(season);

  // ⚠️ ?season= is looked up, never echoed: an unparseable value falls back
  // to the default scope (the open season when one exists, else all-time),
  // which needs the roster's own `seasons` list — so a "default" parse
  // fetches all-time first to learn it, then re-fetches the actual scope.
  const boards = parsed === "default"
    ? await (async () => {
        const probe = await playerBoards({ kind: "all" });
        return probe.seasons[0] !== undefined ? playerBoards({ kind: "season", number: probe.seasons[0] }) : probe;
      })()
    : await playerBoards(parsed);

  return (
    <main className="mx-auto max-w-[40rem] px-4 py-10">
      <p className={label}>Players</p>
      <h1 className="mt-1 font-display text-3xl text-ink">Player boards</h1>
      <ScopePicker seasons={boards.seasons} basePath="/players" />
      <StatBoards boards={boards} />
      <p className="mt-8"><a className={`${label} underline-offset-4 hover:underline`} href="/scoreboard">Scoreboard</a></p>
    </main>
  );
}
