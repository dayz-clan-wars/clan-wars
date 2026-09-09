import type { Metadata } from "next";
import { warLog, type WarLogEntry } from "@factions/roster";
import { EMPTY_WAR_LOG, duration } from "@/lib/scoring-copy";
import { WarLogLine } from "./entry";
import { Page, PageHead, Body, Panel, SegNav, kickerSm } from "@/app/components/ui";
import { guideLinkFor } from "@/lib/guide-links";

export const metadata: Metadata = { title: "Clan Wars — war log" };
/** ⚠️ Public, but LIVE: rendered per request so the build never bakes a roster into a static chunk (spec §10.1). */
export const dynamic = "force-dynamic";

const dayOf = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
const timeOf = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

/** Entries grouped by UTC day, newest first — the roster already sorts them. */
function byDay(entries: WarLogEntry[]): [string, WarLogEntry[]][] {
  const out: [string, WarLogEntry[]][] = [];
  for (const e of entries) {
    const day = dayOf(e.at);
    const last = out[out.length - 1];
    if (last && last[0] === day) last[1].push(e); else out.push([day, [e]]);
  }
  return out;
}

function Outcome({ e }: { e: WarLogEntry }) {
  if (e.kind === "defense") return <span className={`${kickerSm} !text-olive`}>Defended</span>;
  if (!e.raider) return <span className="font-mono text-[11px] text-muted">—</span>;
  return <span className="font-display text-lg text-ink">{e.points} <span className="font-mono text-[11px] text-muted">pts</span></span>;
}

const TAG_RE = /^[A-Za-z0-9]{1,8}$/u;

export default async function WarLogPage({ searchParams }: { searchParams: Promise<{ clan?: string | string[]; kind?: string | string[] }> }) {
  const sp = await searchParams;
  // ⚠️ Both are attacker-supplied: the tag is matched, never echoed unmatched, and the kind is one of two words or nothing.
  const rawTag = typeof sp.clan === "string" && TAG_RE.test(sp.clan) ? sp.clan.toUpperCase() : undefined;
  const kind = sp.kind === "raid" || sp.kind === "defense" ? sp.kind : undefined;
  const entries = await warLog(200, { clanTag: rawTag, kind });
  const asRaider = entries.find((e) => e.kind === "raid" && e.raider?.tag === rawTag);
  const clanName = rawTag ? (entries.find((e) => e.victim.tag === rawTag)?.victim.name ?? (asRaider?.kind === "raid" ? asRaider.raider?.name : undefined) ?? null) : null;
  const href = (k?: string) => {
    const q = [rawTag && `clan=${encodeURIComponent(rawTag)}`, k && `kind=${k}`].filter(Boolean);
    return `/war-log${q.length ? `?${q.join("&")}` : ""}`;
  };

  return (
    <Page wide>
      <PageHead guide={guideLinkFor("/war-log")} kicker="War log" title="Recent action"
        sub={rawTag ? <>{clanName ?? `[${rawTag}]`} only · <a className="text-gold underline-offset-4 hover:underline" href={href(kind)}>every clan</a></> : undefined}
        aside={<SegNav label="Kind" items={[
          { label: "All", href: href(), current: !kind },
          { label: "Raids", href: href("raid"), current: kind === "raid" },
          { label: "Defenses", href: href("defense"), current: kind === "defense" },
        ]} />} />
      <Body>
        {entries.length === 0 ? (
          <p className="text-ink-2">{EMPTY_WAR_LOG}</p>
        ) : (
          <>
            <Panel>
              {byDay(entries).map(([day, list]) => (
                <div key={day}>
                  <div className={`flex justify-between border-b-2 border-rule-2 px-4 py-2 lg:px-6 lg:py-2.5 ${kickerSm} !text-dim`}><span>{day}</span><span>UTC</span></div>
                  {list.map((e, i) => (
                    <div key={i} className="border-b border-rule-2 last:border-b-0">
                      {/* Desktop: time | dot | sentence | outcome. */}
                      <div className="hidden min-h-[64px] grid-cols-[120px_8px_1fr_auto] items-center gap-x-5 px-6 py-3 text-[15px] text-ink-2 lg:grid">
                        <span className="font-mono text-xs text-muted">{timeOf(e.at)}</span>
                        <span className={`h-2 w-2 ${e.kind === "raid" ? "bg-gold" : "bg-olive"}`} />
                        <span><WarLogLine e={e} />{e.kind === "defense" && <> — {duration(e.durationSeconds)} under siege</>}</span>
                        <Outcome e={e} />
                      </div>
                      {/* Phones: a kicker line, then the sentence. */}
                      <div className="px-4 py-3.5 text-sm leading-relaxed text-ink-2 lg:hidden">
                        <div className="mb-1.5 flex justify-between font-mono text-[11px] uppercase tracking-[0.12em]">
                          <span className={e.kind === "raid" ? "text-gold" : "text-olive"}>{e.kind === "raid" ? "Raid" : "Defense"} · {timeOf(e.at)}</span>
                          <span className={e.kind === "defense" ? "text-olive" : e.raider ? "text-ink" : "text-muted"}>
                            {e.kind === "defense" ? duration(e.durationSeconds) : e.raider ? `${e.points} pts` : "no clan"}
                          </span>
                        </div>
                        <WarLogLine e={e} />
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </Panel>
            <p className="mt-4 font-mono text-[11px] text-muted">The last 200 {kind === "raid" ? "raids" : kind === "defense" ? "defenses" : "entries"}{rawTag ? ` involving ${clanName ?? rawTag}` : ""}. Older action lives in the season records.</p>
          </>
        )}
      </Body>
    </Page>
  );
}
