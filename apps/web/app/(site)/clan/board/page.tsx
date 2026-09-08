import type { Metadata } from "next";
import { clanBoard, type Boards, type ActorRefusal } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { REFUSAL } from "@/lib/clan-copy";
import { parseSeasonParam } from "@/lib/stat-scope";
import { StatBoards, ScopePicker } from "@/app/components/stat-boards";

export const metadata: Metadata = { title: "Clan Wars — clan board", robots: { index: false, follow: false } };
/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

const label = "font-mono text-[11px] uppercase tracking-[0.18em] text-muted";

function isRefusal(v: Boards | ActorRefusal): v is ActorRefusal {
  return typeof v === "string";
}

export default async function ClanBoardPage({ searchParams }: { searchParams: Promise<{ season?: string | string[] }> }) {
  const session = await currentSession();
  if (!session) {
    return <main className="mx-auto max-w-[64rem] px-5 py-7 lg:px-8 lg:py-10"><p className="text-ink-2">Your session could not be read. <a className="text-gold underline-offset-4 hover:underline" href="/login?next=/clan/board">Sign in again</a>.</p></main>;
  }
  const { season } = await searchParams;
  const parsed = parseSeasonParam(season);

  // ⚠️ ONE call on every path, refusal included: `{ kind: "current" }` is
  // resolved inside the roster from its own `seasons` list, so a "default"
  // parse no longer needs an all-time probe first.
  const boards = await clanBoard(session.sub, parsed === "default" ? { kind: "current" } : parsed);
  if (isRefusal(boards)) {
    return (
      <main className="mx-auto max-w-[64rem] px-5 py-7 lg:px-8 lg:py-10">
        <p className={label}>Clan board</p>
        <p className="mt-6 text-ink-2">{REFUSAL[boards]}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-[64rem] px-5 py-7 lg:px-8 lg:py-10">
      <p className={label}>Clan board</p>
      <h1 className="mt-2 font-display text-[40px] uppercase leading-[.9] tracking-[-0.02em] text-ink lg:text-[56px]">Your clan&rsquo;s boards</h1>
      <ScopePicker seasons={boards.seasons} basePath="/clan/board" />
      <StatBoards boards={boards} />
      <p className="mt-8"><a className={`${label} underline-offset-4 hover:underline`} href="/clan">Your clan</a></p>
    </main>
  );
}
