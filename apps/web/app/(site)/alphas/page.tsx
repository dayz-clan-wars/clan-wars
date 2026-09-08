import type { Metadata } from "next";
import { alphas, seasons } from "@factions/roster";
import { flagImagePath } from "@/src/flag-images";
import { when } from "@/lib/format";
import { NO_ALPHAS_WEEK } from "@/lib/scoring-copy";
import { ScoringNav } from "@/app/components/scoring-nav";
import { Page, PageHead, Body, Panel, Rank, linkMono, kickerSm } from "@/app/components/ui";

export const metadata: Metadata = { title: "Clan Wars — alphas" };
/** ⚠️ Public, but LIVE: rendered per request so the build never bakes a roster into a static chunk (spec §10.1). */
export const dynamic = "force-dynamic";

const weekOf = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const span = (a: Date, b: Date) => `${weekOf(a)} – ${weekOf(b)}`;

export default async function AlphasPage() {
  const [{ season, weeks }, closed] = await Promise.all([alphas(), seasons()]);

  return (
    <Page wide>
      <PageHead kicker={season ? <>Alphas · Season {season.number}</> : "Alphas"} title={season ? "Week by week" : "No season"} aside={<ScoringNav current="/alphas" />} />
      <Body className="grid gap-4 lg:grid-cols-3 lg:gap-6">
        {weeks.map((w, i) => (
          <Panel key={w.weekStart.toISOString()} title={`Week of ${weekOf(w.weekStart)}`} tone={i === 0 ? "gold" : "plain"} aside={i === 0 ? <span className={`${kickerSm} !text-gold`}>Latest</span> : undefined}>
            {w.entries.length === 0 ? (
              <p className="px-4 py-4 text-sm text-ink-2 lg:px-5">{NO_ALPHAS_WEEK}</p>
            ) : (
              <ul>
                {w.entries.map((e) => (
                  <li key={e.tag} className="flex min-h-[56px] items-center gap-3 border-t border-rule-2 px-4 first:border-t-0 lg:min-h-[64px] lg:gap-3.5 lg:px-5">
                    <span className="font-display text-[22px] leading-none text-gold lg:text-[26px]">{e.rank}</span>
                    <img src={`/${flagImagePath(e.texture)}`} alt="" width={36} height={36} className="h-7 w-7 object-contain lg:h-9 lg:w-9" />
                    <a href={`/clans/${encodeURIComponent(e.tag)}`} className="min-w-0">
                      <span className="block truncate font-display text-[15px] text-ink lg:text-base">{e.name}</span>
                      <span className="hidden font-mono text-[11px] text-ink-2 lg:inline">[{e.tag}]</span>
                    </a>
                    <span className="ml-auto font-display text-base text-ink lg:text-lg">{e.points} <span className="hidden font-mono text-[11px] text-muted lg:inline">pts</span></span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        ))}
        {season && weeks.length === 0 && <p className="text-ink-2 lg:col-span-3">No week has closed yet.</p>}

        {closed.length > 0 && (
          <Panel className="lg:col-span-3" title={<><span className="mr-3 text-gold">Past seasons</span>Champions are recorded permanently</>} aside={<a className={linkMono} href="/seasons">All seasons →</a>}>
            <div className="grid lg:grid-cols-2">
              {closed.map((s, i) => (
                <div key={s.number} className={`flex items-center gap-4 p-4 lg:gap-5 lg:p-5 ${i % 2 === 0 ? "lg:border-r lg:border-rule-2" : ""} ${i > 0 ? "border-t border-rule-2 lg:border-t-0" : ""}`}>
                  <span className="font-display text-[40px] leading-none text-rule-2 lg:text-[48px]">S{s.number}</span>
                  {s.champion && <img src={`/${flagImagePath(s.champion.texture)}`} alt="" width={48} height={48} className="h-10 w-10 object-contain lg:h-12 lg:w-12" />}
                  <div>
                    <div className={`${kickerSm} !text-gold`}>Champion</div>
                    <div className="font-display text-base text-ink lg:text-xl">{s.champion ? <>{s.champion.name} <span className="font-mono text-xs text-ink-2">[{s.champion.tag}]</span></> : "No champion this season."}</div>
                    <div className="text-xs text-muted lg:text-[13px]">{span(s.startedAt, s.endedAt)}{s.champion && <> · {s.champion.points} pts</>}</div>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        )}
      </Body>
    </Page>
  );
}
