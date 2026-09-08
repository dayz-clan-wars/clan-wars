import type { Metadata } from "next";
import { seasons } from "@factions/roster";
import { flagImagePath } from "@/src/flag-images";
import { when } from "@/lib/format";
import { NO_SEASONS } from "@/lib/scoring-copy";
import { ScoringNav } from "@/app/components/scoring-nav";
import { Page, PageHead, Body, Panel, Rank, kickerSm } from "@/app/components/ui";

export const metadata: Metadata = { title: "Clan Wars — seasons" };
/** ⚠️ Public, but LIVE: rendered per request so the build never bakes a roster into a static chunk (spec §10.1). */
export const dynamic = "force-dynamic";

const th = "border-b-2 border-rule-2 px-4 py-3 text-left font-mono text-[10px] font-normal uppercase tracking-[0.18em] text-dim lg:px-6";
const num = "px-4 text-right font-mono text-sm text-ink-2 lg:px-6";

export default async function SeasonsPage() {
  const closed = await seasons();

  return (
    <Page wide>
      <PageHead kicker="Seasons" title="Past seasons" aside={<ScoringNav current="/seasons" />} />
      <Body className="flex flex-col gap-4 lg:gap-6">
        {closed.length === 0 ? (
          <p className="text-ink-2">{NO_SEASONS}</p>
        ) : closed.map((s) => (
          <Panel key={s.number} title={`Season ${s.number}`} aside={<>{when(s.startedAt)} – {when(s.endedAt)}</>}>
            <div className="flex items-center gap-4 border-b border-rule-2 p-4 lg:gap-5 lg:p-5">
              <span className="font-display text-[40px] leading-none text-rule-2 lg:text-[48px]">S{s.number}</span>
              {s.champion && <img src={`/${flagImagePath(s.champion.texture)}`} alt="" width={48} height={48} className="h-10 w-10 object-contain lg:h-12 lg:w-12" />}
              <div>
                <div className={`${kickerSm} !text-gold`}>Champion</div>
                <div className="font-display text-base text-ink lg:text-xl">{s.champion ? <>{s.champion.name} <span className="font-mono text-xs text-ink-2">[{s.champion.tag}]</span></> : "No champion this season."}</div>
                {s.champion && <div className="text-xs text-muted lg:text-[13px]">{s.champion.points} pts</div>}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem] border-collapse text-sm">
                <thead>
                  <tr>
                    <th className={`${th} w-16`}>Rank</th>
                    <th className={`${th} !px-0`}>Clan</th>
                    <th className={`${th} text-right`}>Points</th>
                    <th className={`${th} text-right`}>Raids</th>
                    <th className={`${th} text-right`}>Raided</th>
                    <th className={`${th} text-right`}>Defenses</th>
                  </tr>
                </thead>
                <tbody>
                  {s.rows.map((r) => (
                    <tr key={r.tag} className="border-b border-rule-2 last:border-b-0">
                      <td className="px-4 lg:px-6"><Rank n={r.rank} /></td>
                      <td className="py-3">
                        <a className="flex items-center gap-3 text-ink" href={`/clans/${encodeURIComponent(r.tag)}`}>
                          <img src={`/${flagImagePath(r.texture)}`} alt="" width={28} height={28} className="h-7 w-7 object-contain" />
                          <span className="font-display">{r.name}</span>
                          <span className="font-mono text-xs text-ink-2">[{r.tag}]</span>
                        </a>
                      </td>
                      <td className="px-4 text-right font-display text-lg text-ink lg:px-6">{r.points}</td>
                      <td className={num}>{r.raids}</td>
                      <td className={num}>{r.timesRaided}</td>
                      <td className={num}>{r.defenses}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        ))}
      </Body>
    </Page>
  );
}
