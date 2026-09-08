import type { WarLogEntry } from "@factions/roster";
import { duration } from "@/lib/scoring-copy";

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

/** "Raid · 7 Sep 22:14" in gold, "Defense · …" in olive. */
export function WarLogKicker({ e, time }: { e: WarLogEntry; time?: string }) {
  const stamp = time ?? e.at.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return (
    <span className={`font-mono text-[11px] uppercase tracking-[0.12em] ${e.kind === "raid" ? "text-gold" : "text-olive"}`}>
      {e.kind === "raid" ? "Raid" : "Defense"} · {stamp}
    </span>
  );
}
