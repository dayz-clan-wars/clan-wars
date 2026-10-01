import type { OnlinePlayerRow } from "@factions/roster";
import { ONLINE_EMPTY } from "@factions/copy";
import { Panel, linkMono } from "@/app/components/ui";

export const HOME_ONLINE_CAP = 10;

/** The landing page's "Online now" panel: a count and the first ten names, longest on first. */
export function OnlineNow({ players }: { players: OnlinePlayerRow[] }) {
  const shown = players.slice(0, HOME_ONLINE_CAP);
  return (
    <Panel num="03" title={`Online now · ${players.length}`} aside={<a className={`${linkMono} inline-flex min-h-[44px] items-center`} href="/live/online">All<span className="sr-only"> players online</span> <span aria-hidden="true">→</span></a>}>
      {shown.length === 0 ? <p className="p-5 text-sm text-ink-2">{ONLINE_EMPTY}</p> : (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-2 text-sm lg:px-5">
          {shown.map((p) => (
            <li key={`${p.gamertag}@${p.connectedAt.toISOString()}`} className="flex items-center">
              <a className="inline-flex min-h-[44px] items-center text-ink hover:text-gold" href={`/players/${encodeURIComponent(p.gamertag)}`}>{p.gamertag}</a>
              {p.tag && <span className="text-muted">&nbsp;[{p.tag}]</span>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
