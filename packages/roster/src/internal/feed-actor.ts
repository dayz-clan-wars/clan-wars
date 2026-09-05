import type { Database } from "@factions/db";
import { identityLinks, players } from "@factions/db";
import { eq } from "drizzle-orm";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * The gamertag to name as the protagonist of a command-driven transition.
 *
 * The three command kinds (`founded`, `renamed`, `rebound`) only ever know a
 * Discord id; `activated` takes its actor straight from the `flag.raised`
 * event and does not come through here.
 *
 * ⚠️ Reads `players.gamertag`, not `identity_links.gamertag`. The link's copy
 * is a display label frozen at verification, and that table's own comment
 * warns that players rename — printing it names somebody who no longer
 * exists. The link's copy is the fallback only, for a linked account the
 * player projection has not caught up with.
 *
 * ⚠️ Returns undefined rather than a placeholder. The embed omits the clause;
 * a string like "unknown" would read as a player's name.
 */
export async function actorGamertagTx(tx: Tx, discordId: string): Promise<string | undefined> {
  const [row] = await tx.select({
    current: players.gamertag,
    atVerification: identityLinks.gamertag,
  })
    .from(identityLinks)
    .leftJoin(players, eq(players.dayzId, identityLinks.dayzId))
    .where(eq(identityLinks.discordId, discordId));

  return row?.current ?? row?.atVerification ?? undefined;
}
