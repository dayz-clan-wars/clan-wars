import type { Database } from "@factions/db";
import { identityLinks, players } from "@factions/db";
import { desc, ilike, sql } from "drizzle-orm";

/**
 * Autocomplete for every box a gamertag is typed into. Two scopes, because
 * the boxes resolve differently:
 *
 * - `seen`: every character the server log has recorded (`players`), newest
 *   sighting first — the public "find a player" box, whose target page
 *   exists for linked and unlinked characters alike.
 * - `linked`: characters bound to a Discord account (`identity_links`), the
 *   name AS LINKED — the invite and guest-pass boxes, which `writes.ts`
 *   resolves against `identity_links.gamertag`, so offering the name from
 *   `players` (which follows renames) could suggest a name the write then
 *   refuses.
 *
 * Names only: a UID never leaves the package through here. One row per
 * name — `players` is keyed by character UID and two characters can carry
 * the same gamertag, which is one suggestion, not two.
 */
export type SuggestScope = "seen" | "linked";
export const SUGGEST_SCOPES = ["seen", "linked"] as const satisfies readonly SuggestScope[];
export const SUGGEST_LIMIT = 8;

export async function suggestGamertagsDb(db: Database, prefix: string, scope: SuggestScope): Promise<string[]> {
  const q = prefix.trim();
  if (q.length === 0) return [];
  // ⚠️ Escape LIKE's metacharacters so a typed "%" or "_" matches itself (backslash is Postgres's default escape).
  const pattern = `${q.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;
  const rows = scope === "linked"
    ? await db.select({ gamertag: identityLinks.gamertag, seen: sql<Date>`max(${identityLinks.verifiedAt})` }).from(identityLinks)
      .where(ilike(identityLinks.gamertag, pattern)).groupBy(identityLinks.gamertag).orderBy(desc(sql`max(${identityLinks.verifiedAt})`), desc(identityLinks.gamertag)).limit(SUGGEST_LIMIT)
    : await db.select({ gamertag: players.gamertag, seen: sql<Date>`max(${players.lastSeenAt})` }).from(players)
      .where(ilike(players.gamertag, pattern)).groupBy(players.gamertag).orderBy(desc(sql`max(${players.lastSeenAt})`), desc(players.gamertag)).limit(SUGGEST_LIMIT);
  return rows.map((r) => r.gamertag);
}
