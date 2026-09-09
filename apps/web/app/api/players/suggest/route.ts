import type { NextRequest } from "next/server";
import { suggestGamertags, type SuggestScope } from "@factions/roster";
import { GAMERTAG_MAX } from "@/lib/clan-limits";
import { json, sessionOr401 } from "@/lib/api";

/**
 * Autocomplete behind every gamertag box (app/components/gamertag-field.tsx).
 * `scope=seen` is public — it feeds the player search on /players, a public
 * page, and names only what /players/{gamertag} already shows anyone.
 * `scope=linked` (invites, guest passes) needs a session like the pages it
 * sits on. Names only; the write behind the form re-resolves and refuses on
 * its own terms.
 */
export async function GET(req: NextRequest) {
  const scope: SuggestScope = req.nextUrl.searchParams.get("scope") === "linked" ? "linked" : "seen";
  if (scope === "linked") {
    const s = await sessionOr401();
    if ("response" in s) return s.response;
  }
  const q = (req.nextUrl.searchParams.get("q") ?? "").slice(0, GAMERTAG_MAX);
  return json({ matches: await suggestGamertags(q, scope) });
}
