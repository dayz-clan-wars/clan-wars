import type { ScoreboardRow } from "@factions/roster";
import { flagThumbPath } from "@/src/flag-images";
import { ALPHA_BADGE } from "@/lib/scoring-copy";
import { Rank, kickerSm } from "./ui";

/** "1 raid" / "2 raids". */
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * /scoreboard on a phone: rank | clan | points, with the clan's tag and its
 * raids, times raided and defenses on a second line under the name.
 *
 * ⚠️ The counts used to be a fourth column ("R / Rd / D"), which squeezed the
 * name to six characters and wrapped the header onto two lines at 375px (S1).
 * Under the name they cost no width. The name itself may take two lines and
 * breaks anywhere: a clan name can be CLAN_NAME_LENGTH.max characters with no
 * space, wider than the column in Archivo Black.
 */
export function PhoneRows({ rows }: { rows: ScoreboardRow[] }) {
  const cols = "grid grid-cols-[32px_minmax(0,1fr)_auto] gap-2.5";
  return (
    <>
      {/* Visual only: every value below says what it is to a screen reader. */}
      <div aria-hidden="true" className={`${cols} whitespace-nowrap border-b-2 border-rule-2 px-4 py-2.5 ${kickerSm} !text-dim`}>
        <span>#</span><span>Clan</span><span className="text-right">Pts</span>
      </div>
      <ul>
        {rows.map((r) => {
          const dormant = r.status === "dormant";
          return (
            <li key={r.tag} className={`${cols} min-h-[60px] items-center border-t border-rule-2 px-4 py-2 first:border-t-0`}>
              <Rank n={r.rank} size="lg" />
              <a className="flex min-w-0 items-center gap-2.5" href={`/clans/${encodeURIComponent(r.tag)}`}>
                <img src={`/${flagThumbPath(r.texture)}`} alt="" loading="lazy" width={28} height={28} className={`h-7 w-7 flex-none object-contain ${dormant ? "opacity-60" : ""}`} />
                <span className="min-w-0">
                  <span className={`line-clamp-2 [overflow-wrap:anywhere] font-display text-[15px] leading-tight ${dormant ? "text-ink-2" : "text-ink"}`}>{r.name}</span>
                  <span className="mt-0.5 flex flex-wrap gap-x-2 font-mono text-[11px] tabular-nums text-muted">
                    <span className="text-ink-2">[{r.tag}]</span>
                    <span>{count(r.raids, "raid", "raids")}</span>
                    <span>raided {r.timesRaided}×</span>
                    <span>{count(r.defenses, "defense", "defenses")}</span>
                    {r.alpha && <span className="uppercase text-gold">{ALPHA_BADGE}</span>}
                    {dormant && <span className="uppercase">Dormant</span>}
                  </span>
                </span>
              </a>
              <span className={`text-right font-display text-xl tabular-nums ${dormant ? "text-muted" : "text-ink"}`}>{r.points}<span className="sr-only"> points</span></span>
            </li>
          );
        })}
      </ul>
    </>
  );
}
