import type { Metadata } from "next";
import { directory, scoreboard, warLog } from "@factions/roster";
import { FLAG_POOL_SIZE } from "@factions/domain";
import { flagImagePath } from "@/src/flag-images";
import { ALPHA_BADGE, EMPTY_SCOREBOARD, EMPTY_WAR_LOG } from "@/lib/scoring-copy";
import { WarLogLine, WarLogKicker } from "./war-log/entry";
import { currentSession } from "@/lib/viewer";
import { Page, Panel, Stat, Rank, Footer, btnCta, linkMono, kicker } from "@/app/components/ui";

export const metadata: Metadata = {
  title: "Clan Wars",
  description: "Clans, bases and consequence on a DayZ server.",
};
/** ⚠️ Public, but LIVE since the redesign: the scoreboard, the war log and the flag pool sit on it, so it renders per request like every other board (spec §10.1). */
export const dynamic = "force-dynamic";

const WEEK = 7 * 86_400_000;

export default async function Home() {
  const [{ clans, flags }, board, log, session] = await Promise.all([directory(), scoreboard(), warLog(4), currentSession()]);
  const week = board.season ? Math.floor((Date.now() - board.season.startedAt.getTime()) / WEEK) + 1 : null;
  const raids = board.rows.reduce((n, r) => n + r.raids, 0);
  const alphas = board.rows.filter((r) => r.alpha).length;
  const top = board.rows.slice(0, 5);

  return (
    <Page wide>
      <section className="grid gap-8 border-b-2 border-rule-2 px-5 pb-7 pt-8 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-end lg:gap-12 lg:px-8 lg:pb-10 lg:pt-14">
        <div>
          <div className="inline-flex items-center gap-3 border border-gold px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-gold lg:text-[11px]">
            <span className="inline-block h-2 w-2 bg-gold" />
            {board.season ? `Season ${board.season.number} · Week ${week} · Livonia` : "Livonia · Xbox"}
          </div>
          <h1 className="mt-5 font-display text-[44px] uppercase leading-[.88] tracking-[-0.02em] text-ink lg:mt-6 lg:text-[96px] lg:leading-[.86]">
            Clans, bases<br className="hidden lg:inline" /> and <span className="whitespace-nowrap text-gold">consequence.</span>
          </h1>
          <p className="mt-5 max-w-[560px] text-base leading-relaxed text-ink-2 [text-wrap:pretty] lg:mt-7 lg:text-lg">
            Found a clan at a flagpole with two friends. Declare a base. Raid other clans to climb the scoreboard, and defend your own flag or lose it.
            <span className="hidden lg:inline"> Everything is earned in game and recorded from the server&rsquo;s own log.</span>
          </p>
        </div>
        <div className="flex flex-col gap-2.5 lg:gap-3">
          {session
            ? <a className={btnCta} href="/me">Your page <span className="font-mono text-sm normal-case">→</span></a>
            : <a className={btnCta} href="/api/auth/discord?next=%2Fme">Continue with Discord <span className="font-mono text-sm normal-case">→</span></a>}
          <a className="flex min-h-[52px] items-center justify-between gap-6 border-2 border-rule-2 px-5 font-display text-sm uppercase tracking-[0.04em] text-ink hover:border-muted" href="/guide">
            Read the field guide <span className="font-mono text-sm normal-case text-muted">→</span>
          </a>
          {!session && <p className="mt-1 hidden font-mono text-[11px] leading-relaxed text-muted lg:block">One character per account. You need to be in the Clan Wars Discord — we will offer to add you if you are not.</p>}
        </div>
      </section>

      <section className="grid grid-cols-2 border-b-2 border-rule-2 bg-frame lg:grid-cols-4">
        <div className="border-b border-r border-rule-2 lg:border-b-0"><Stat value={clans.length} label={<>Clans on<br />the server</>} /></div>
        <div className="border-b border-rule-2 lg:border-b-0 lg:border-r"><Stat value={<>{flags.taken.length}<span className="text-[16px] text-dim lg:text-[20px]">/{FLAG_POOL_SIZE}</span></>} label={<>Flags<br />flying</>} /></div>
        <div className="border-r border-rule-2"><Stat value={raids} label={<>Raids<br />this season</>} /></div>
        <div><Stat value={alphas} label={<>Alphas<br />named</>} tone="gold" /></div>
      </section>

      <section className="grid gap-5 px-5 py-5 lg:grid-cols-[7fr_5fr] lg:gap-6 lg:px-8 lg:py-8">
        <Panel num="01" title="Scoreboard" aside={<a className={linkMono} href="/scoreboard">Full board →</a>}>
          {top.length === 0 ? (
            <p className="p-5 text-sm text-ink-2">{board.season ? "Nobody has scored yet." : EMPTY_SCOREBOARD}</p>
          ) : (
            <ul>
              {top.map((r) => (
                <li key={r.tag} className="flex min-h-[56px] items-center gap-3 border-t border-rule-2 px-4 first:border-t-0 lg:min-h-[64px] lg:gap-4 lg:px-5">
                  <span className="w-5 lg:w-7"><Rank n={r.rank} size="lg" /></span>
                  <img src={`/${flagImagePath(r.texture)}`} alt="" width={32} height={32} className={`h-7 w-7 object-contain lg:h-8 lg:w-8 ${r.status === "dormant" ? "opacity-60" : ""}`} />
                  <a href={`/clans/${encodeURIComponent(r.tag)}`} className="min-w-0">
                    <span className={`block truncate font-display text-[15px] lg:text-base ${r.status === "dormant" ? "text-ink-2" : "text-ink"}`}>{r.name}</span>
                    <span className="font-mono text-[10px] text-ink-2 lg:text-[11px]">
                      <span className="hidden lg:inline">[{r.tag}]</span>
                      {r.alpha && <><span className="hidden lg:inline"> · </span><span className="uppercase text-gold">{ALPHA_BADGE}</span></>}
                      {r.status === "dormant" && <><span className="hidden lg:inline"> · </span><span className="uppercase text-muted">dormant</span></>}
                    </span>
                  </a>
                  <span className="ml-auto font-display text-lg text-ink lg:text-xl">{r.points}</span>
                  <span className="hidden w-10 text-right font-mono text-sm text-ink-2 lg:block">{r.raids}</span>
                  <span className="hidden w-10 text-right font-mono text-sm text-ink-2 lg:block">{r.defenses}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <div className="flex flex-col gap-5 lg:gap-6">
          <Panel num="02" title="War log" aside={<a className={linkMono} href="/war-log">All →</a>}>
            {log.length === 0 ? (
              <p className="p-5 text-sm text-ink-2">{EMPTY_WAR_LOG}</p>
            ) : (
              <ul>
                {log.map((e, i) => (
                  <li key={i} className="border-t border-rule-2 px-4 py-3 text-sm leading-relaxed text-ink-2 first:border-t-0 lg:px-5 lg:py-3.5">
                    <div className="mb-1"><WarLogKicker e={e} /></div>
                    <WarLogLine e={e} points />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel num="03" title="Flag pool" aside={<span className={kicker}>{flags.free.length} free</span>} className="hidden lg:block">
            <div className="flex flex-wrap gap-2.5 p-5">
              {flags.free.map((f) => <img key={f} src={`/${flagImagePath(f)}`} alt={f} title={f} width={36} height={36} className="h-9 w-9 object-contain" />)}
              {flags.taken.map((f) => <img key={f} src={`/${flagImagePath(f)}`} alt={`${f} (taken)`} title={`${f} — taken`} width={36} height={36} className="h-9 w-9 object-contain opacity-35" />)}
            </div>
          </Panel>
        </div>
      </section>

      <Footer>
        <a className="text-muted hover:text-ink" href="/alphas">Alphas</a>
        <a className="text-muted hover:text-ink" href="/seasons">Seasons</a>
        <a className="text-muted hover:text-ink" href="https://discord.gg/TJu4XP25nr">Discord</a>
      </Footer>
    </Page>
  );
}
