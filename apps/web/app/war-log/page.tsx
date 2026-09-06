import type { Metadata } from "next";
import { warLog, type WarLogEntry } from "@factions/roster";
import { when } from "@/lib/format";
import { EMPTY_WAR_LOG, duration } from "@/lib/scoring-copy";

export const metadata: Metadata = { title: "Clan Wars — war log" };
/** ⚠️ Public, but LIVE: rendered per request so the build never bakes a roster into a static chunk (spec §10.1). */
export const dynamic = "force-dynamic";

const label = "font-mono text-xs uppercase tracking-[0.18em] text-muted";

function Entry({ e }: { e: WarLogEntry }) {
  const gamertag = e.gamertag ?? "someone";
  if (e.kind === "raid") {
    return e.raider ? (
      <>
        <strong className="text-ink">{e.raider.name}</strong> raided <strong className="text-ink">{e.victim.name}</strong> — flag lowered by {gamertag} · {e.points} pts
      </>
    ) : (
      <>
        <strong className="text-ink">{e.victim.name}</strong> was raided — flag lowered by {gamertag} (no clan)
      </>
    );
  }
  return (
    <>
      <strong className="text-ink">{e.victim.name}</strong> raised their colors again — {duration(e.durationSeconds)} under siege
    </>
  );
}

export default async function WarLogPage() {
  const entries = await warLog(200);

  return (
    <main className="mx-auto max-w-[40rem] px-4 py-10">
      <p className={label}>War log</p>
      <h1 className="mt-1 font-display text-3xl text-ink">Recent action</h1>

      {entries.length === 0 ? (
        <p className="mt-6 text-ink-2">{EMPTY_WAR_LOG}</p>
      ) : (
        <ul className="mt-8 flex flex-col gap-2">
          {entries.map((e, i) => (
            <li key={i} className="rounded-lg border border-rule bg-frame p-3 text-sm text-ink-2">
              <span className="mr-2 font-mono text-xs text-muted">{when(e.at)}</span>
              <Entry e={e} />
            </li>
          ))}
        </ul>
      )}
      <p className="mt-8"><a className={`${label} underline-offset-4 hover:underline`} href="/scoreboard">Scoreboard</a></p>
    </main>
  );
}
