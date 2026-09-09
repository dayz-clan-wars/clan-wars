import type { Boards, BoardRow, KdRow, LongestKillRow } from "@factions/roster";
import { BOARD_LABELS, BUILD_NOTE, EMPTY_BOARD, KD_NOTE, STREAK_NOTE, playTime, scopeLabel } from "@/lib/stats-copy";
import { Panel, Rank, SegNav } from "./ui";

/** `?season=` links for every season the roster knows about, plus all-time. No JS: a `<nav>` of plain anchors. */
export function ScopePicker({ seasons, basePath, current }: { seasons: number[]; basePath: string; current?: Boards["scope"] }) {
  return (
    <SegNav label="Scope" items={[
      // ⚠️ `?season=all`, never the bare path: a bare path parses as "default",
      // which is the OPEN season — so the All-time button led straight back to
      // Season 1 for as long as one was open.
      { label: "All-time", href: `${basePath}?season=all`, current: current?.kind === "all" },
      ...seasons.map((n) => ({ label: `Season ${n}`, href: `${basePath}?season=${n}`, current: current?.kind === "season" && current.number === n })),
    ]} />
  );
}

type Kind = keyof Omit<Boards, "scope" | "seasons">;
const NUM: Record<Kind, string> = { raiders: "01", killers: "02", deaths: "03", kd: "04", playTime: "05", friendlyFire: "06", builders: "07", streaks: "08", longestKills: "09" };
const NOTE: Partial<Record<Kind, string>> = { kd: KD_NOTE, builders: BUILD_NOTE, streaks: STREAK_NOTE };

function formatValue(kind: Kind, value: number): string {
  if (kind === "playTime") return playTime(value);
  if (kind === "longestKills") return `${value} m`;
  return String(value);
}

function BoardPanel({ kind, rows }: { kind: Kind; rows: BoardRow[] | KdRow[] | LongestKillRow[] }) {
  return (
    <Panel num={NUM[kind]} title={BOARD_LABELS[kind]} aside={NOTE[kind] ? <span className="text-[11px]">{NOTE[kind]}</span> : undefined}>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-ink-2 lg:px-5">{EMPTY_BOARD}</p>
      ) : (
        <ol>
          {rows.map((r, i) => {
            const podium = i < 3;
            return (
              <li key={r.dayzId} className="flex min-h-[52px] items-center gap-3.5 border-t border-rule-2 px-4 first:border-t-0 lg:px-5">
                <span className="w-5"><Rank n={i + 1} /></span>
                <a className="font-mono text-sm text-ink underline-offset-4 hover:underline" href={`/players/${encodeURIComponent(r.gamertag)}`}>{r.gamertag}</a>
                {kind === "kd" && "kills" in r && <span className="ml-auto font-mono text-xs text-muted">{r.kills} / {r.deaths}</span>}
                {kind === "longestKills" && "weapon" in r && r.weapon && <span className="ml-auto truncate font-mono text-xs text-muted">{r.weapon}</span>}
                <span className={`${kind === "kd" ? "w-11 text-right" : kind === "longestKills" && "weapon" in r && r.weapon ? "w-20 flex-none text-right" : "ml-auto"} ${podium ? "font-display text-base text-ink" : "font-mono text-sm text-ink-2"}`}>{formatValue(kind, r.value)}</span>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

/** The nine boards (spec §11, plus deaths, builders, streaks and range), in the order `BOARD_LABELS` names them, in a three-column grid on desktop. */
export function StatBoards({ boards, extra }: { boards: Boards; extra?: React.ReactNode }) {
  return (
    <>
      <p className="sr-only">{scopeLabel(boards.scope)}</p>
      <div className="grid gap-4 lg:grid-cols-3 lg:gap-6">
        <BoardPanel kind="raiders" rows={boards.raiders} />
        <BoardPanel kind="killers" rows={boards.killers} />
        <BoardPanel kind="deaths" rows={boards.deaths} />
        <BoardPanel kind="kd" rows={boards.kd} />
        <BoardPanel kind="playTime" rows={boards.playTime} />
        <BoardPanel kind="friendlyFire" rows={boards.friendlyFire} />
        <BoardPanel kind="builders" rows={boards.builders} />
        <BoardPanel kind="streaks" rows={boards.streaks} />
        <BoardPanel kind="longestKills" rows={boards.longestKills} />
        {extra}
      </div>
    </>
  );
}
