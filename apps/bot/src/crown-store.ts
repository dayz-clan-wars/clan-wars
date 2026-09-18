import { inArray } from "drizzle-orm";
import { identityLinks, type Database } from "@factions/db";
import { BOARD_KINDS, type BoardKind } from "@factions/roster";
import { playerBoardsDb } from "@factions/roster/internal";
import type { CrownHolders, CrownStore } from "./crown-tick.js";

/**
 * How far down each board the tie scan reads.
 *
 * ⚠️ Boards come back ordered by value descending, so everyone tied at #1 sits
 * in the first rows and ten is plenty for any realistic tie. An eleven-way tie
 * at the top would silently drop the rest — accepted, because the alternative
 * is a second per-board query for the top value and these boards are already
 * nine reads on a five-minute clock.
 */
const TIE_LIMIT = 10;

/**
 * Who holds each crown, read from the leaderboards themselves.
 *
 * The scope is `"current"`, which resolves to the newest season (or all-time
 * on a server with no seasons). That means a season rollover empties every
 * board and strips all nine crowns until the new season's first kills, raids
 * and builds land — intended: each season is its own race.
 */
export class PgCrownStore implements CrownStore {
  constructor(private readonly db: Database, private readonly now: () => Date = () => new Date()) {}

  async topHolders(): Promise<CrownHolders> {
    const boards = await playerBoardsDb(this.db, { kind: "current" }, TIE_LIMIT, this.now());

    // Everyone tied at the top of each board, still keyed by DayZ id.
    const topByKind = new Map<BoardKind, string[]>();
    for (const kind of BOARD_KINDS) {
      const rows = boards[kind];
      const top = rows[0];
      // ⚠️ `value > 0` too: a board can hand back a zero-valued row (nobody has
      // any friendly fire yet, say), and nobody should wear a crown for zero.
      if (top === undefined || top.value <= 0) continue;
      topByKind.set(kind, rows.filter((r) => r.value === top.value).map((r) => r.dayzId));
    }

    const dayzIds = [...new Set([...topByKind.values()].flat())];
    if (dayzIds.length === 0) return new Map();

    const links = await this.db
      .select({ dayzId: identityLinks.dayzId, discordId: identityLinks.discordId })
      .from(identityLinks)
      .where(inArray(identityLinks.dayzId, dayzIds));
    const discordOf = new Map(links.map((l) => [l.dayzId, l.discordId]));

    const out: CrownHolders = new Map();
    for (const [kind, ids] of topByKind) {
      // A #1 who never linked their Discord account drops out here, and the
      // crown goes unheld rather than down to #2 — #2 is not the best player.
      const discordIds = new Set(ids.map((id) => discordOf.get(id)).filter((id): id is string => id !== undefined));
      if (discordIds.size > 0) out.set(kind, discordIds);
    }
    return out;
  }
}
