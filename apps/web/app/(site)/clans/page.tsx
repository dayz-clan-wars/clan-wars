import type { Metadata } from "next";
import { directory } from "@factions/roster";
import { FLAG_POOL_SIZE } from "@factions/domain";
import { flagImagePath } from "@/src/flag-images";
import { ALPHA_BADGE } from "@/lib/scoring-copy";
import { Page, PageHead, Panel, Facts, kicker, kickerSm } from "@/app/components/ui";
import { guideLinkFor } from "@/lib/guide-links";

export const metadata: Metadata = { title: "Clan Wars — clans" };
/** ⚠️ Public, but LIVE: rendered per request so the build never bakes a roster into a static chunk (spec §10.1). */
export const dynamic = "force-dynamic";

export default async function ClansPage() {
  const { clans, flags } = await directory();
  const recruiting = clans.filter((c) => c.recruiting);
  const href = (tag: string) => `/clans/${encodeURIComponent(tag)}`;

  return (
    <Page wide>
      <PageHead guide={guideLinkFor("/clans")}
        kicker="Clans"
        title={`${clans.length} on the server`}
        aside={<div className={`${kicker} lg:pb-2`}>{flags.taken.length} of {FLAG_POOL_SIZE} flags flying · {recruiting.length} recruiting</div>}
      />
      <div className="grid gap-4 px-5 py-5 lg:grid-cols-[5fr_7fr] lg:items-start lg:gap-6 lg:px-8 lg:pb-10 lg:pt-6">
        <div className="flex flex-col gap-4 lg:gap-6">
          {recruiting.length > 0 && (
            <Panel num="01" title="Recruiting" tone="gold">
              <ul>
                {recruiting.map((c) => (
                  <li key={c.tag} className="border-t border-rule-2 px-4 py-3.5 first:border-t-0 lg:px-5 lg:py-4">
                    <a className="flex items-center gap-3 text-ink" href={href(c.tag)}>
                      <img src={`/${flagImagePath(c.texture)}`} alt="" width={40} height={40} className="h-9 w-9 object-contain lg:h-10 lg:w-10" />
                      <span className="font-display text-base lg:text-lg">{c.name}</span>
                      <span className="hidden font-mono text-xs text-ink-2 lg:inline">[{c.tag}]</span>
                      <span className="ml-auto font-mono text-[11px] text-muted">{c.memberCount} members</span>
                    </a>
                    {(c.playWindow || c.language || c.pitch) && (
                      <Facts className="mt-3" items={[
                        ...(c.playWindow ? [["Plays", c.playWindow] as [React.ReactNode, React.ReactNode]] : []),
                        ...(c.language ? [["Speaks", c.language] as [React.ReactNode, React.ReactNode]] : []),
                        ...(c.pitch ? [["Pitch", <span key="p" className="text-ink">{c.pitch}</span>] as [React.ReactNode, React.ReactNode]] : []),
                      ]} />
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel num={recruiting.length > 0 ? "03" : "02"} title="The flag pool" aside={`${flags.free.length} free`} className="order-last lg:order-none">
            <div className="flex flex-wrap gap-2.5 p-4 lg:p-5">
              {flags.free.map((f) => <img key={f} src={`/${flagImagePath(f)}`} alt={f} title={f} width={40} height={40} className="h-9 w-9 object-contain lg:h-10 lg:w-10" />)}
              {flags.taken.map((f) => <img key={f} src={`/${flagImagePath(f)}`} alt={`${f} (taken)`} title={`${f} — taken`} width={40} height={40} className="h-9 w-9 object-contain opacity-30 lg:h-10 lg:w-10" />)}
            </div>
            <p className="px-4 pb-4 text-xs text-muted lg:px-5">Dimmed flags are taken. A flag flies for one clan at a time.</p>
          </Panel>
        </div>

        <Panel num={recruiting.length > 0 ? "02" : "01"} title="Every clan" aside="By members">
          <ul>
            {clans.map((c) => {
              const dormant = c.status === "dormant";
              return (
                <li key={c.tag} className="border-t border-rule-2 first:border-t-0">
                  <a className={`flex min-h-[56px] items-center gap-3 px-4 lg:min-h-[60px] lg:gap-3.5 lg:px-5 ${dormant ? "text-ink-2" : "text-ink"}`} href={href(c.tag)}>
                    <img src={`/${flagImagePath(c.texture)}`} alt="" width={32} height={32} className={`h-7 w-7 object-contain lg:h-8 lg:w-8 ${dormant ? "opacity-60" : ""}`} />
                    <span className="font-display text-[15px] lg:text-base">{c.name}</span>
                    <span className="hidden font-mono text-xs text-ink-2 lg:inline">[{c.tag}]</span>
                    {c.alpha && <span className={`${kickerSm} !text-gold`}>{ALPHA_BADGE}</span>}
                    {dormant && <span className={kickerSm}>dormant</span>}
                    <span className="ml-auto font-mono text-[13px] text-ink-2">{c.memberCount}</span>
                  </a>
                </li>
              );
            })}
            {clans.length === 0 && <li className="px-5 py-4 text-sm text-ink-2">No clan yet. Found one at a flagpole with two friends.</li>}
          </ul>
        </Panel>
      </div>
    </Page>
  );
}
