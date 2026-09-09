import type { BoardPage } from "@factions/roster";
import { BOARD_LABELS, PAGER } from "@/lib/stats-copy";
import { BOARD_SLUGS, seasonQuery } from "@/lib/board-page";
import { BoardRows, BOARD_NOTE, BOARD_NUM } from "./stat-boards";
import { Panel, Pager } from "./ui";

/**
 * One board, every player, paged. `basePath` is the boards root
 * (`/players/boards`, `/clan/board`); page links keep the resolved scope.
 */
export function FullBoard({ page, basePath }: { page: BoardPage; basePath: string }) {
  const href = (n: number) => `${basePath}/${BOARD_SLUGS[page.kind]}?${seasonQuery(page.scope)}&page=${n}`;
  const note = BOARD_NOTE[page.kind];
  return (
    <Panel num={BOARD_NUM[page.kind]} title={BOARD_LABELS[page.kind]} aside={note ? <span className="text-[11px]">{note}</span> : undefined}>
      <BoardRows kind={page.kind} rows={page.rows} first={(page.page - 1) * page.perPage + 1} />
      {(page.page > 1 || page.hasNext) && (
        <Pager page={page.page} prevHref={page.page > 1 ? href(page.page - 1) : null} nextHref={page.hasNext ? href(page.page + 1) : null} labels={PAGER} />
      )}
    </Panel>
  );
}
