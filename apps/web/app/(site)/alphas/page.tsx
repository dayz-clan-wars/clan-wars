import type { Metadata } from "next";
import { alphas } from "@factions/roster";
import { flagImagePath } from "@/src/flag-images";
import { when } from "@/lib/format";
import { NO_ALPHAS_WEEK } from "@/lib/scoring-copy";

export const metadata: Metadata = { title: "Clan Wars — alphas" };
/** ⚠️ Public, but LIVE: rendered per request so the build never bakes a roster into a static chunk (spec §10.1). */
export const dynamic = "force-dynamic";

const label = "font-mono text-xs uppercase tracking-[0.18em] text-muted";

export default async function AlphasPage() {
  const { season, weeks } = await alphas();

  return (
    <main className="mx-auto max-w-[40rem] px-4 py-10">
      <p className={label}>Alphas</p>
      <h1 className="mt-1 font-display text-3xl text-ink">{season ? `Season ${season.number}` : "No season"}</h1>

      <div className="mt-8 flex flex-col gap-6">
        {weeks.map((w) => (
          <section key={w.weekStart.toISOString()} className="rounded-lg border border-rule bg-frame p-4">
            <h2 className={label}>Week of {when(w.weekStart)}</h2>
            {w.entries.length === 0 ? (
              <p className="mt-2 text-sm text-ink-2">{NO_ALPHAS_WEEK}</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-2">
                {w.entries.map((e) => (
                  <li key={e.tag} className="flex items-center gap-2 text-ink">
                    <span className="font-mono text-xs text-muted">{e.rank}</span>
                    <img src={`/${flagImagePath(e.texture)}`} alt="" width={24} height={24} className="h-6 w-6 object-contain" />
                    <span className="font-display">{e.name}</span>
                    <span className="font-mono text-xs text-ink-2">[{e.tag}]</span>
                    <span className="ml-auto font-mono text-sm">{e.points} pts</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
      <p className="mt-8"><a className={`${label} underline-offset-4 hover:underline`} href="/scoreboard">Scoreboard</a></p>
    </main>
  );
}
