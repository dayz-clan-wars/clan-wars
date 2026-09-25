import type { Metadata } from "next";
import { scoreboard } from "@factions/roster";
import { flagThumbPath } from "@/src/flag-images";
import { when } from "@/lib/format";
import { EMPTY_SCOREBOARD, ALPHA_BADGE } from "@/lib/scoring-copy";
import { ScoringNav } from "@/app/components/scoring-nav";
import { Page, PageHead, Body, Panel, Rank } from "@/app/components/ui";
import { PhoneRows } from "@/app/components/score-rows";
import { guideLinkFor } from "@/lib/guide-links";

export const metadata: Metadata = { title: "Clan Wars — scoreboard" };
/** ⚠️ Public, but LIVE: rendered per request so the build never bakes a roster into a static chunk (spec §10.1). */
export const dynamic = "force-dynamic";

const th = "border-b-2 border-rule-2 px-6 py-3.5 text-left font-mono text-xs font-normal uppercase tracking-[0.18em] text-muted";
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
                {/* The panel has no title, so the caption is the table's only name (M3). */}
                <caption className="sr-only">Season {season.number} standings</caption>
                <thead>
                  <tr>
                    <th scope="col" className={`${th} w-[72px]`}>Rank</th>
                    <th scope="col" className={`${th} !px-0`}>Clan</th>
                    <th scope="col" className={`${th} text-right`}>Points</th>
                    <th scope="col" className={`${th} text-right`}>Raids</th>
                    <th scope="col" className={`${th} text-right`}>Raided</th>
                    <th scope="col" className={`${th} text-right`}>Defenses</th>
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
                            <img src={`/${flagThumbPath(r.texture)}`} alt="" loading="lazy" width={36} height={36} className={`h-9 w-9 object-contain ${dormant ? "opacity-60" : ""}`} />
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
            {/* Phones: one row per clan, the counts under the name (S1). */}
            <Panel className="lg:hidden">
              <PhoneRows rows={rows} />
            </Panel>
            <p className="mt-4 font-mono text-[11px] leading-relaxed text-muted">
              {season.weekClosedThrough ? `Alphas through the week of ${when(season.weekClosedThrough)}.` : "No week has closed yet."}
              <span className="hidden lg:inline"> Only raids score; the higher the victim, the more it is worth.</span>
            </p>
          </>
        )}
      </Body>
    </Page>
  );
}
