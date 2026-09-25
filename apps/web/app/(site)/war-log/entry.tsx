import type { WarLogEntry } from "@factions/roster";
import { duration } from "@/lib/scoring-copy";
import { when } from "@/lib/format";
import { kickerSm } from "@/app/components/ui";

/** The war log's sentence for one entry, shared by /war-log and the landing page. Copy unchanged from before the redesign. */
function Gamertag({ gamertag }: { gamertag: string | null | undefined }) {
  return gamertag ? (
    <a className="font-mono text-sm text-ink underline-offset-4 hover:underline" href={`/players/${encodeURIComponent(gamertag)}`}>{gamertag}</a>
  ) : (
    <>someone</>
  );
}

export function WarLogLine({ e, points = false }: { e: WarLogEntry; points?: boolean }) {
  if (e.kind === "raid") {
    return e.raider ? (
      <>
        <strong className="font-bold text-ink">{e.raider.name}</strong> raided <strong className="font-bold text-ink">{e.victim.name}</strong> — flag lowered by <Gamertag gamertag={e.gamertag} />{points && <> · {e.points} pts</>}
      </>
    ) : (
      <>
        <strong className="font-bold text-ink">{e.victim.name}</strong> was raided — flag lowered by <Gamertag gamertag={e.gamertag} /> <span className="text-muted">(no clan)</span>
      </>
    );
  }
  return (
    <>
      <strong className="font-bold text-ink">{e.victim.name}</strong> raised their colors again{points && <> — {duration(e.durationSeconds)} under siege</>}
    </>
  );
}

/** "Raid · 7 Sep, 22:14 UTC" in gold, "Defense · …" in olive. ⚠️ `when()`, so the clock says which zone it is in — it shows on the landing page and every clan page, beside nothing else that does (M5). */
export function WarLogKicker({ e }: { e: WarLogEntry }) {
  const stamp = when(e.at);
  return (
    <span className={`font-mono text-[11px] uppercase tracking-[0.12em] ${e.kind === "raid" ? "text-gold" : "text-olive"}`}>
      {e.kind === "raid" ? "Raid" : "Defense"} · {stamp}
    </span>
  );
}

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

/**
 * /war-log's body: one heading per UTC day, that day's entries as a list.
 *
 * ⚠️ A real <h2> and a real <ul> (M4): a screen reader skims a 200-entry log
 * by its heading and list shortcuts, and the styled <div>s this replaced
 * offered neither. The page's h1 is the PageHead; the panel has no title of
 * its own, so the days are the h2s.
 */
export function WarLogDays({ entries }: { entries: WarLogEntry[] }) {
  return (
    <>
      {byDay(entries).map(([day, list]) => (
        <section key={day}>
          <h2 className={`m-0 flex justify-between border-b-2 border-rule-2 px-4 py-2 lg:px-6 lg:py-2.5 ${kickerSm} !text-dim`}><span>{day}</span><span>UTC</span></h2>
          <ul>
            {list.map((e, i) => (
              <li key={i} className="border-b border-rule-2 last:border-b-0">
                {/* Desktop: time | dot | sentence | outcome. */}
                <div className="hidden min-h-[64px] grid-cols-[120px_8px_1fr_auto] items-center gap-x-5 px-6 py-3 text-[15px] text-ink-2 lg:grid">
                  <span className="font-mono text-xs text-muted">{timeOf(e.at)}</span>
                  <span aria-hidden="true" className={`h-2 w-2 ${e.kind === "raid" ? "bg-gold" : "bg-olive"}`} />
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
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
