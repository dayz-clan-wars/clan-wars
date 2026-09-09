import { BOARD_KINDS, type BoardKind, type Boards, type BoardRow, type KdRow, type LongestKillRow } from "@factions/roster";
import { BOARD_LABELS, BUILD_NOTE, EMPTY_BOARD, KD_NOTE, SEE_ALL, STREAK_NOTE, playTime, scopeLabel } from "@/lib/stats-copy";
import { BOARD_SLUGS, seasonQuery } from "@/lib/board-page";
import { Panel, Rank, SegNav, linkMono } from "./ui";

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

type Kind = BoardKind;
const NUM: Record<Kind, string> = { raiders: "01", killers: "02", deaths: "03", kd: "04", playTime: "05", friendlyFire: "06", builders: "07", streaks: "08", longestKills: "09" };
const NOTE: Partial<Record<Kind, string>> = { kd: KD_NOTE, builders: BUILD_NOTE, streaks: STREAK_NOTE };
export { NUM as BOARD_NUM, NOTE as BOARD_NOTE };

function formatValue(kind: Kind, value: number): string {
  if (kind === "playTime") return playTime(value);
  if (kind === "longestKills") return `${value} m`;
  return String(value);
}

/** The rows of one board: rank, name, the number. `first` is the rank of the first row — a later page starts higher. */
export function BoardRows({ kind, rows, first = 1 }: { kind: Kind; rows: BoardRow[] | KdRow[] | LongestKillRow[]; first?: number }) {
  if (rows.length === 0) return <p className="px-4 py-3 text-sm text-ink-2 lg:px-5">{EMPTY_BOARD}</p>;
  return (
    <ol>
      {rows.map((r, i) => {
        const n = first + i;
        const podium = n <= 3;
        return (
          <li key={r.dayzId} className="flex min-h-[52px] items-center gap-3.5 border-t border-rule-2 px-4 first:border-t-0 lg:px-5">
            <span className="w-7"><Rank n={n} /></span>
            <a className="font-mono text-sm text-ink underline-offset-4 hover:underline" href={`/players/${encodeURIComponent(r.gamertag)}`}>{r.gamertag}</a>
            {kind === "kd" && "kills" in r && <span className="ml-auto font-mono text-xs text-muted">{r.kills} / {r.deaths}</span>}
            {kind === "longestKills" && "weapon" in r && r.weapon && <span className="ml-auto truncate font-mono text-xs text-muted">{r.weapon}</span>}
            <span className={`${kind === "kd" ? "w-11 text-right" : kind === "longestKills" && "weapon" in r && r.weapon ? "w-20 flex-none text-right" : "ml-auto"} ${podium ? "font-display text-base text-ink" : "font-mono text-sm text-ink-2"}`}>{formatValue(kind, r.value)}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** A top-N panel. `seeAll` is the board's own page, where every player is listed — a footer row, so the header keeps its note. */
function BoardPanel({ kind, rows, seeAll }: { kind: Kind; rows: BoardRow[] | KdRow[] | LongestKillRow[]; seeAll: string }) {
  return (
    <Panel num={NUM[kind]} title={BOARD_LABELS[kind]} aside={NOTE[kind] ? <span className="text-[11px]">{NOTE[kind]}</span> : undefined} className="flex flex-col">
      <BoardRows kind={kind} rows={rows} />
      <p className="mt-auto border-t border-rule-2 px-4 lg:px-5">
        <a className={`${linkMono} inline-flex min-h-[44px] items-center`} href={seeAll}>{SEE_ALL} &rarr;</a>
      </p>
    </Panel>
  );
}

/**
 * The nine boards (spec §11, plus deaths, builders, streaks and range), in the
 * order `BOARD_LABELS` names them, in a three-column grid on desktop. Each
 * panel links to its full page under `boardsPath` (`/players/boards`,
 * `/clan/board`), keeping the resolved scope.
 */
export function StatBoards({ boards, boardsPath, extra }: { boards: Boards; boardsPath: string; extra?: React.ReactNode }) {
  const seeAll = (kind: Kind) => `${boardsPath}/${BOARD_SLUGS[kind]}?${seasonQuery(boards.scope)}`;
  return (
    <>
      <p className="sr-only">{scopeLabel(boards.scope)}</p>
      <div className="grid gap-4 lg:grid-cols-3 lg:gap-6">
        {BOARD_KINDS.map((kind) => <BoardPanel key={kind} kind={kind} rows={boards[kind]} seeAll={seeAll(kind)} />)}
        {extra}
      </div>
    </>
  );
}
