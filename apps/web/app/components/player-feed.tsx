import type { Encounter, FeedEntry, PlayerFeed } from "@factions/roster";
import { EMPTY_FEED, FEED_KIND, FEED_TITLE, FRIENDLY_FIRE_MARK, deathCause, shot, steps } from "@/lib/feed-copy";
import { PAGER } from "@/lib/stats-copy";
import { seasonQuery } from "@/lib/board-page";
import { Panel, Pager } from "./ui";

const stamp = (d: Date) => d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

function Name({ gamertag }: { gamertag: string }) {
  return <a className="font-mono text-ink underline-offset-4 hover:underline" href={`/players/${encodeURIComponent(gamertag)}`}>{gamertag}</a>;
}
const Detail = ({ children }: { children: React.ReactNode }) => <span className="font-mono text-xs text-muted"> · {children}</span>;
const FF = () => <Detail><span className="text-rust-2">{FRIENDLY_FIRE_MARK}</span></Detail>;

/** The sentence for one feed line. */
function FeedLine({ e }: { e: FeedEntry }) {
  switch (e.kind) {
    case "kill": {
      const s = shot(e.distanceM, e.weapon);
      return <>Killed <Name gamertag={e.other} />{s && <Detail>{s}</Detail>}{e.friendlyFire && <FF />}</>;
    }
    case "death": {
      const s = shot(e.distanceM, e.weapon);
      if (e.other === null) { const c = deathCause(e.cause); return <>Died{c && ` ${c}`}</>; }
      return <>Killed by <Name gamertag={e.other} />{s && <Detail>{s}</Detail>}{e.friendlyFire && <FF />}</>;
    }
    case "raid": return <>Lowered <strong className="font-bold text-ink">{e.victim.name}</strong>&rsquo;s flag</>;
    case "raised": return <>Raised the colours</>;
    case "built": return <>{steps(e.steps, "built")}</>;
    case "dismantled": return <>{steps(e.steps, "dismantled")}</>;
  }
}

/** One row: kicker with the kind and time, then the sentence. Works on a phone as a stack, on desktop as a line. */
function FeedRow({ kind, at, children }: { kind: FeedEntry["kind"]; at: Date; children: React.ReactNode }) {
  const k = FEED_KIND[kind];
  return (
    <li className="flex flex-col gap-1 border-t border-rule-2 px-4 py-3 text-sm text-ink-2 first:border-t-0 lg:min-h-[52px] lg:flex-row lg:items-center lg:gap-5 lg:px-5 lg:py-2">
      <span className={`flex gap-2 font-mono text-[11px] uppercase tracking-[0.12em] lg:w-[190px] lg:flex-none ${k.tone}`}>
        <span className="w-[74px] flex-none">{k.label}</span><span className="text-muted">{stamp(at)}</span>
      </span>
      <span className="min-w-0"><span className="text-ink">{children}</span></span>
    </li>
  );
}

/** The player's feed panel: a page of lines and the pager, links keeping the scope. */
export function PlayerFeedPanel({ feed, basePath }: { feed: PlayerFeed; basePath: string }) {
  const href = (n: number) => `${basePath}?${seasonQuery(feed.scope)}&page=${n}#feed`;
  return (
    <Panel title={<span id="feed">{FEED_TITLE}</span>}>
      {feed.entries.length === 0 ? (
        <p className="px-4 py-3 text-sm text-ink-2 lg:px-5">{EMPTY_FEED}</p>
      ) : (
        <ol>{feed.entries.map((e, i) => <FeedRow key={i} kind={e.kind} at={e.at}><FeedLine e={e} /></FeedRow>)}</ol>
      )}
      {(feed.page > 1 || feed.hasNext) && (
        <Pager page={feed.page} prevHref={feed.page > 1 ? href(feed.page - 1) : null} nextHref={feed.hasNext ? href(feed.page + 1) : null} labels={PAGER} />
      )}
    </Panel>
  );
}

/**
 * Killed / Killed by: one expandable row per opponent — a <details>, so it
 * works without JavaScript — opening on every kill between the two in the
 * scope, newest first, in the feed's line style.
 */
export function OpponentRows({ items, encounters, me, side }: {
  items: { gamertag: string; count: number }[];
  encounters: Encounter[];
  me: string;
  /** "killed": the rows are people `me` killed; "killedBy": people who killed `me`. */
  side: "killed" | "killedBy";
  }) {
  return (
    <ul className="flex flex-col">
      {items.map((o) => {
        const mine = encounters.filter((e) => side === "killed" ? e.killer === me && e.victim === o.gamertag : e.victim === me && e.killer === o.gamertag);
        return (
          <li key={o.gamertag} className="border-t border-rule-2 first:border-t-0">
            <details className="group">
              <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-3 text-sm text-ink [&::-webkit-details-marker]:hidden">
                <span aria-hidden="true" className="w-3 flex-none font-mono text-xs text-muted group-open:text-gold">{"▸"}</span>
                <span className="grow">{o.gamertag}</span>
                <span className="font-mono text-ink-2">{o.count}</span>
              </summary>
              <ol className="mb-2 ml-6 border-l border-rule-3 pl-3">
                {mine.map((e, i) => {
                  const s = shot(e.distanceM, e.weapon);
                  return (
                    <li key={i} className="flex min-h-[32px] flex-wrap items-center gap-x-3 text-xs">
                      <span className="font-mono text-muted">{stamp(e.at)}</span>
                      <span className="text-ink-2">{s || "—"}{e.friendlyFire && <FF />}</span>
                    </li>
                  );
                })}
              </ol>
            </details>
          </li>
        );
      })}
    </ul>
  );
}
