import type { Boards, BoardRow, KdRow } from "@factions/roster";
import { BOARD_LABELS, EMPTY_BOARD, KD_NOTE, playTime, scopeLabel } from "@/lib/stats-copy";

const label = "font-mono text-xs uppercase tracking-[0.18em] text-muted";

/** `?season=` links for every season the roster knows about, plus all-time. No JS: a `<nav>` of plain anchors. */
export function ScopePicker({ seasons, basePath }: { seasons: number[]; basePath: string }) {
  return (
    <nav className="mt-4 flex flex-wrap gap-3">
      <a className={`${label} underline-offset-4 hover:underline`} href={basePath}>All-time</a>
      {seasons.map((n) => (
        <a key={n} className={`${label} underline-offset-4 hover:underline`} href={`${basePath}?season=${n}`}>
          Season {n}
        </a>
      ))}
    </nav>
  );
}

function formatValue(kind: keyof Omit<Boards, "scope" | "seasons">, value: number): string {
  return kind === "playTime" ? playTime(value) : String(value);
}

function BoardTable({ kind, rows }: { kind: keyof Omit<Boards, "scope" | "seasons">; rows: BoardRow[] | KdRow[] }) {
  return (
    <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
      <h2 className={label}>{BOARD_LABELS[kind]}</h2>
      {kind === "kd" && <p className="mt-1 text-xs text-ink-2">{KD_NOTE}</p>}
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-ink-2">{EMPTY_BOARD}</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[24rem] text-left text-sm">
            <thead>
              <tr className={label}>
                <th className="px-2 py-1">Rank</th>
                <th className="px-2 py-1">Player</th>
                {kind === "kd" && (
                  <>
                    <th className="px-2 py-1">Kills</th>
                    <th className="px-2 py-1">Deaths</th>
                  </>
                )}
                <th className="px-2 py-1">{BOARD_LABELS[kind]}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule-2">
              {rows.map((r, i) => (
                <tr key={r.dayzId} className="text-ink">
                  <td className="px-2 py-1 font-mono">{i + 1}</td>
                  <td className="px-2 py-1">
                    <a className="underline-offset-4 hover:underline" href={`/players/${encodeURIComponent(r.gamertag)}`}>{r.gamertag}</a>
                  </td>
                  {kind === "kd" && "kills" in r && (
                    <>
                      <td className="px-2 py-1 font-mono">{r.kills}</td>
                      <td className="px-2 py-1 font-mono">{r.deaths}</td>
                    </>
                  )}
                  <td className="px-2 py-1 font-mono">{formatValue(kind, r.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The five boards (spec §11), in the order `BOARD_LABELS` names them. */
export function StatBoards({ boards }: { boards: Boards }) {
  return (
    <>
      <p className="mt-4 text-sm text-ink-2">{scopeLabel(boards.scope)}</p>
      <BoardTable kind="raiders" rows={boards.raiders} />
      <BoardTable kind="killers" rows={boards.killers} />
      <BoardTable kind="kd" rows={boards.kd} />
      <BoardTable kind="playTime" rows={boards.playTime} />
      <BoardTable kind="friendlyFire" rows={boards.friendlyFire} />
    </>
  );
}
