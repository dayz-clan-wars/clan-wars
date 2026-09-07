import type { Metadata } from "next";
import { clanBoard, type Boards, type ActorRefusal } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { REFUSAL } from "@/lib/clan-copy";
import { parseSeasonParam } from "@/lib/stat-scope";
import { StatBoards, ScopePicker } from "@/app/components/stat-boards";

export const metadata: Metadata = { title: "Clan Wars — clan board", robots: { index: false, follow: false } };
/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

const label = "font-mono text-xs uppercase tracking-[0.18em] text-muted";

function isRefusal(v: Boards | ActorRefusal): v is ActorRefusal {
  return typeof v === "string";
}

export default async function ClanBoardPage({ searchParams }: { searchParams: Promise<{ season?: string | string[] }> }) {
  const session = await currentSession();
  if (!session) {
    return <main className="mx-auto max-w-[40rem] px-4 py-10"><p className="text-ink-2">Your session could not be read. <a className="text-gold underline-offset-4 hover:underline" href="/login?next=/clan/board">Sign in again</a>.</p></main>;
  }
  const { season } = await searchParams;
  const parsed = parseSeasonParam(season);

  // ⚠️ Same two-step default as /players: a "default" parse needs the
  // roster's own `seasons` list before it can pick the open season. The
  // probe also doubles as the refusal check — a refusal short-circuits
  // before any second call.
  const probe = await clanBoard(session.sub, { kind: "all" });
  if (isRefusal(probe)) {
    return (
      <main className="mx-auto max-w-[40rem] px-4 py-10">
        <p className={label}>Clan board</p>
        <p className="mt-6 text-ink-2">{REFUSAL[probe]}</p>
      </main>
    );
  }

  const boards = parsed === "default"
    ? (probe.seasons[0] !== undefined ? await clanBoard(session.sub, { kind: "season", number: probe.seasons[0] }) : probe)
    : await clanBoard(session.sub, parsed);

  if (isRefusal(boards)) {
    return (
      <main className="mx-auto max-w-[40rem] px-4 py-10">
        <p className={label}>Clan board</p>
        <p className="mt-6 text-ink-2">{REFUSAL[boards]}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-[40rem] px-4 py-10">
      <p className={label}>Clan board</p>
      <h1 className="mt-1 font-display text-3xl text-ink">Your clan&rsquo;s boards</h1>
      <ScopePicker seasons={boards.seasons} basePath="/clan/board" />
      <StatBoards boards={boards} />
      <p className="mt-8"><a className={`${label} underline-offset-4 hover:underline`} href="/clan">Your clan</a></p>
    </main>
  );
}
