import type { Boards, BoardRow, KdRow } from "@factions/roster";
import { BOARD_LABELS, EMPTY_BOARD, KD_NOTE, playTime, scopeLabel } from "@/lib/stats-copy";
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
const NUM: Record<Kind, string> = { raiders: "01", killers: "02", kd: "03", playTime: "04", friendlyFire: "05" };

function formatValue(kind: Kind, value: number): string {
  return kind === "playTime" ? playTime(value) : String(value);
}

function BoardPanel({ kind, rows }: { kind: Kind; rows: BoardRow[] | KdRow[] }) {
  return (
    <Panel num={NUM[kind]} title={BOARD_LABELS[kind]} aside={kind === "kd" ? <span className="text-[10px]">{KD_NOTE}</span> : undefined}>
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
                <span className={`${kind === "kd" ? "w-11 text-right" : "ml-auto"} ${podium ? "font-display text-base text-ink" : "font-mono text-sm text-ink-2"}`}>{formatValue(kind, r.value)}</span>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

/** The five boards (spec §11), in the order `BOARD_LABELS` names them, in a three-column grid on desktop. */
export function StatBoards({ boards, extra }: { boards: Boards; extra?: React.ReactNode }) {
  return (
    <>
      <p className="sr-only">{scopeLabel(boards.scope)}</p>
      <div className="grid gap-4 lg:grid-cols-3 lg:gap-6">
        <BoardPanel kind="raiders" rows={boards.raiders} />
        <BoardPanel kind="killers" rows={boards.killers} />
        <BoardPanel kind="kd" rows={boards.kd} />
        <BoardPanel kind="playTime" rows={boards.playTime} />
        <BoardPanel kind="friendlyFire" rows={boards.friendlyFire} />
        {extra}
      </div>
    </>
  );
}
