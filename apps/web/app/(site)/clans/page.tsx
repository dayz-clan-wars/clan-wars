import type { Metadata } from "next";
import { directory } from "@factions/roster";
import { FLAG_POOL_SIZE } from "@factions/domain";
import { flagThumbPath } from "@/src/flag-images";
import { Page, PageHead, Panel, kicker } from "@/app/components/ui";
import { guideLinkFor } from "@/lib/guide-links";
import { ClanRow, RecruitingRow } from "./rows";

export const metadata: Metadata = { title: "Clan Wars — clans" };
/** ⚠️ Public, but LIVE: rendered per request so the build never bakes a roster into a static chunk (spec §10.1). */
export const dynamic = "force-dynamic";

export default async function ClansPage() {
  const { clans, flags } = await directory();
  const recruiting = clans.filter((c) => c.recruiting);
  // A reserved clan holds its flag before it is on the server, so the pool count can exceed the roster; say so rather than contradict the title.
  const reserved = flags.taken.length - clans.length;

  return (
    <Page wide>
      <PageHead guide={guideLinkFor("/clans")}
        kicker="Clans"
        title={`${clans.length} on the server`}
        aside={<div className={`${kicker} lg:pb-2`}>{flags.taken.length} of {FLAG_POOL_SIZE} flags held{reserved > 0 && <> · {reserved} reserved</>} · {recruiting.length} recruiting</div>}
      />
      <div className="grid gap-4 px-5 py-5 lg:grid-cols-[5fr_7fr] lg:items-start lg:gap-6 lg:px-8 lg:pb-10 lg:pt-6">
        <div className="flex flex-col gap-4 lg:gap-6">
          {recruiting.length > 0 && (
            <Panel title="Recruiting" tone="gold">
              <ul>
                {recruiting.map((c) => <RecruitingRow key={c.tag} c={c} />)}
              </ul>
            </Panel>
          )}

          <Panel title="The flag pool" aside={`${flags.free.length} free`} className="order-last lg:order-none">
            <div className="flex flex-wrap gap-2.5 p-4 lg:p-5">
              {flags.free.map((f) => <img key={f} src={`/${flagThumbPath(f)}`} alt={f} loading="lazy" title={f} width={40} height={40} className="h-9 w-9 object-contain lg:h-10 lg:w-10" />)}
              {flags.taken.map((f) => <img key={f} src={`/${flagThumbPath(f)}`} alt={`${f} (taken)`} loading="lazy" title={`${f} — taken`} width={40} height={40} className="h-9 w-9 object-contain opacity-30 lg:h-10 lg:w-10" />)}
            </div>
            <p className="px-4 pb-4 text-xs text-muted lg:px-5">Dimmed flags are taken. A flag flies for one clan at a time.</p>
          </Panel>
        </div>

        <Panel title="Every clan" aside="By members">
          <ul>
            {clans.map((c) => <ClanRow key={c.tag} c={c} />)}
            {clans.length === 0 && <li className="px-5 py-4 text-sm text-ink-2">No clan yet. Found one at a flagpole with two friends.</li>}
          </ul>
        </Panel>
      </div>
    </Page>
  );
}
