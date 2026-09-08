import type { Metadata } from "next";
import { seasons } from "@factions/roster";
import { flagImagePath } from "@/src/flag-images";
import { when } from "@/lib/format";
import { NO_SEASONS } from "@/lib/scoring-copy";

export const metadata: Metadata = { title: "Clan Wars — seasons" };
/** ⚠️ Public, but LIVE: rendered per request so the build never bakes a roster into a static chunk (spec §10.1). */
export const dynamic = "force-dynamic";

const label = "font-mono text-xs uppercase tracking-[0.18em] text-muted";

export default async function SeasonsPage() {
  const closed = await seasons();

  return (
    <main className="mx-auto max-w-[40rem] px-4 py-10">
      <p className={label}>Seasons</p>
      <h1 className="mt-1 font-display text-3xl text-ink">Past seasons</h1>

      {closed.length === 0 ? (
        <p className="mt-6 text-ink-2">{NO_SEASONS}</p>
      ) : (
        <div className="mt-8 flex flex-col gap-6">
          {closed.map((s) => (
            <section key={s.number} className="rounded-lg border border-rule bg-frame p-4">
              <h2 className={label}>Season {s.number} — {when(s.startedAt)} to {when(s.endedAt)}</h2>
              <p className="mt-2 text-sm text-ink-2">
                {s.champion
                  ? <>Champion: <span className="font-display text-ink">{s.champion.name}</span> <span className="font-mono text-xs">[{s.champion.tag}]</span> · {s.champion.points} pts</>
                  : "No champion this season."}
              </p>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[32rem] text-left text-sm">
                  <thead>
                    <tr className={label}>
                      <th className="px-2 py-1">Rank</th>
                      <th className="px-2 py-1">Clan</th>
                      <th className="px-2 py-1">Points</th>
                      <th className="px-2 py-1">Raids</th>
                      <th className="px-2 py-1">Raided</th>
                      <th className="px-2 py-1">Defenses</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-rule-2">
                    {s.rows.map((r) => (
                      <tr key={r.tag} className="text-ink">
                        <td className="px-2 py-1 font-mono">{r.rank}</td>
                        <td className="px-2 py-1">
                          <a className="flex items-center gap-2" href={`/clans/${encodeURIComponent(r.tag)}`}>
                            <img src={`/${flagImagePath(r.texture)}`} alt="" width={20} height={20} className="h-5 w-5 object-contain" />
                            <span className="font-display">{r.name}</span>
                            <span className="font-mono text-xs text-ink-2">[{r.tag}]</span>
                          </a>
                        </td>
                        <td className="px-2 py-1 font-mono">{r.points}</td>
                        <td className="px-2 py-1 font-mono">{r.raids}</td>
                        <td className="px-2 py-1 font-mono">{r.timesRaided}</td>
                        <td className="px-2 py-1 font-mono">{r.defenses}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}
      <p className="mt-8"><a className={`${label} underline-offset-4 hover:underline`} href="/scoreboard">Scoreboard</a></p>
    </main>
  );
}
