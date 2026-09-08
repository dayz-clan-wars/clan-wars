import type { Metadata } from "next";
import { scoreboard } from "@factions/roster";
import { flagImagePath } from "@/src/flag-images";
import { when } from "@/lib/format";
import { EMPTY_SCOREBOARD, ALPHA_BADGE } from "@/lib/scoring-copy";
import { ScoringNav } from "@/app/components/scoring-nav";
import { Page, PageHead, Body, Panel, Rank, kickerSm } from "@/app/components/ui";
import { guideLinkFor } from "@/lib/guide-links";

export const metadata: Metadata = { title: "Clan Wars — scoreboard" };
/** ⚠️ Public, but LIVE: rendered per request so the build never bakes a roster into a static chunk (spec §10.1). */
export const dynamic = "force-dynamic";

const th = "border-b-2 border-rule-2 px-6 py-3.5 text-left font-mono text-[10px] font-normal uppercase tracking-[0.18em] text-dim";
const num = "px-6 text-right font-mono text-sm text-ink-2";

export default async function ScoreboardPage() {
  const { season, rows } = await scoreboard();

  return (
    <Page wide>
      <PageHead guide={guideLinkFor("/scoreboard")} kicker="Scoreboard" title={season ? `Season ${season.number}` : "No season"} aside={<ScoringNav current="/scoreboard" />} />
      <Body>
        {!season ? (
          <p className="text-ink-2">{EMPTY_SCOREBOARD}</p>
        ) : (
          <>
            {/* Desktop: the table. */}
            <Panel className="hidden lg:block">
              <table className="w-full border-collapse text-[15px]">
                <thead>
                  <tr>
                    <th className={`${th} w-[72px]`}>Rank</th>
                    <th className={`${th} !px-0`}>Clan</th>
                    <th className={`${th} text-right`}>Points</th>
                    <th className={`${th} text-right`}>Raids</th>
                    <th className={`${th} text-right`}>Raided</th>
                    <th className={`${th} text-right`}>Defenses</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const dormant = r.status === "dormant";
                    return (
                      <tr key={r.tag} className="border-b border-rule-2 last:border-b-0">
                        <td className="px-6"><Rank n={r.rank} size="lg" /></td>
                        <td className="py-4">
                          <a className={`flex items-center gap-3.5 ${dormant ? "text-ink-2" : "text-ink"}`} href={`/clans/${encodeURIComponent(r.tag)}`}>
                            <img src={`/${flagImagePath(r.texture)}`} alt="" width={36} height={36} className={`h-9 w-9 object-contain ${dormant ? "opacity-60" : ""}`} />
                            <span>
                              <span className="block font-display text-lg">{r.name}</span>
                              <span className="font-mono text-[11px] text-ink-2">[{r.tag}]{r.alpha && <> · <span className="uppercase text-gold">{ALPHA_BADGE}</span></>}{dormant && <> · <span className="uppercase text-muted">Dormant{r.rank === null && " · unranked"}</span></>}</span>
                            </span>
                          </a>
                        </td>
                        <td className={`px-6 text-right font-display text-2xl ${dormant ? "text-muted" : "text-ink"}`}>{r.points}</td>
                        <td className={num}>{r.raids}</td>
                        <td className={num}>{r.timesRaided}</td>
                        <td className={num}>{r.defenses}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Panel>
            {/* Phones: the same rows as a grid list, R / Rd / D compressed. */}
            <Panel className="lg:hidden">
              <div className={`grid grid-cols-[32px_1fr_48px_72px] gap-2.5 border-b-2 border-rule-2 px-4 py-2.5 ${kickerSm} !text-dim`}>
                <span>#</span><span>Clan</span><span className="text-right">Pts</span><span className="text-right">R / Rd / D</span>
              </div>
              <ul>
                {rows.map((r) => {
                  const dormant = r.status === "dormant";
                  return (
                    <li key={r.tag} className="grid min-h-[60px] grid-cols-[32px_1fr_48px_72px] items-center gap-2.5 border-t border-rule-2 px-4 py-2 first:border-t-0">
                      <Rank n={r.rank} size="lg" />
                      <a className="flex min-w-0 items-center gap-2.5" href={`/clans/${encodeURIComponent(r.tag)}`}>
                        <img src={`/${flagImagePath(r.texture)}`} alt="" width={28} height={28} className={`h-7 w-7 flex-none object-contain ${dormant ? "opacity-60" : ""}`} />
                        <span className="min-w-0">
                          <span className={`block truncate font-display text-[15px] ${dormant ? "text-ink-2" : "text-ink"}`}>{r.name}</span>
                          {r.alpha && <span className="font-mono text-[10px] uppercase text-gold">{ALPHA_BADGE}</span>}
                          {dormant && <span className="font-mono text-[10px] uppercase text-muted">Dormant</span>}
                        </span>
                      </a>
                      <span className={`text-right font-display text-xl ${dormant ? "text-muted" : "text-ink"}`}>{r.points}</span>
                      <span className="text-right font-mono text-xs text-muted">{r.raids} / {r.timesRaided} / {r.defenses}</span>
                    </li>
                  );
                })}
              </ul>
            </Panel>
            <p className="mt-4 font-mono text-[11px] leading-relaxed text-muted">
              <span className="lg:hidden">R raids · Rd times raided · D defenses. </span>
              {season.weekClosedThrough ? `Alphas through the week of ${when(season.weekClosedThrough)}.` : "No week has closed yet."}
              <span className="hidden lg:inline"> Only raids score; the higher the victim, the more it is worth.</span>
            </p>
          </>
        )}
      </Body>
    </Page>
  );
}
