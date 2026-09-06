import type { Metadata } from "next";
import { scoreboard } from "@factions/roster";
import { flagImagePath } from "@/src/flag-images";
import { when } from "@/lib/format";
import { EMPTY_SCOREBOARD, ALPHA_BADGE } from "@/lib/scoring-copy";

export const metadata: Metadata = { title: "Clan Wars — scoreboard" };
/** ⚠️ Public, but LIVE: rendered per request so the build never bakes a roster into a static chunk (spec §10.1). */
export const dynamic = "force-dynamic";

const label = "font-mono text-xs uppercase tracking-[0.18em] text-muted";

export default async function ScoreboardPage() {
  const { season, rows } = await scoreboard();

  return (
    <main className="mx-auto max-w-[40rem] px-4 py-10">
      <p className={label}>Scoreboard</p>
      <h1 className="mt-1 font-display text-3xl text-ink">{season ? `Season ${season.number}` : "No season"}</h1>

      {!season ? (
        <p className="mt-6 text-ink-2">{EMPTY_SCOREBOARD}</p>
      ) : (
        <>
          <section className="mt-8 overflow-x-auto rounded-lg border border-rule bg-frame">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead>
                <tr className={label}>
                  <th className="px-3 py-2">Rank</th>
                  <th className="px-3 py-2">Clan</th>
                  <th className="px-3 py-2">Points</th>
                  <th className="px-3 py-2">Raids</th>
                  <th className="px-3 py-2">Raided</th>
                  <th className="px-3 py-2">Defenses</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule-2">
                {rows.map((r) => (
                  <tr key={r.tag} className="text-ink">
                    <td className="px-3 py-2 font-mono">{r.rank ?? "—"}</td>
                    <td className="px-3 py-2">
                      <a className="flex items-center gap-2" href={`/clans/${encodeURIComponent(r.tag)}`}>
                        <img src={`/${flagImagePath(r.texture)}`} alt="" width={24} height={24} className="h-6 w-6 object-contain" />
                        <span className="font-display">{r.name}</span>
                        <span className="font-mono text-xs text-ink-2">[{r.tag}]</span>
                        {r.status === "dormant" && <span className="font-mono text-xs uppercase text-muted">dormant</span>}
                        {r.alpha && <span className="font-mono text-xs uppercase text-gold">{ALPHA_BADGE}</span>}
                      </a>
                    </td>
                    <td className="px-3 py-2 font-mono">{r.points}</td>
                    <td className="px-3 py-2 font-mono">{r.raids}</td>
                    <td className="px-3 py-2 font-mono">{r.timesRaided}</td>
                    <td className="px-3 py-2 font-mono">{r.defenses}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <p className="mt-4 text-xs text-ink-2">
            {season.weekClosedThrough ? `Alphas through the week of ${when(season.weekClosedThrough)}` : "No week has closed yet."}
          </p>
        </>
      )}
      <p className="mt-8"><a className={`${label} underline-offset-4 hover:underline`} href="/clans">All clans</a></p>
    </main>
  );
}
