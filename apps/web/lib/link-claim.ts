export type Match = { dayzId: string; gamertag: string };
export type Resolved = { kind: "found"; dayzId: string } | { kind: "unseen" } | { kind: "failed" };

/**
 * Which character the typed gamertag names (H5, UX review 2026-09-24).
 *
 * ⚠️ The list on screen answers only for the text it was fetched for. It is
 * refreshed 200 ms after each keystroke, so a player who types a whole
 * gamertag and taps "Claim it" at once used to be told "the server has not
 * seen that character" about a character it had seen. When the list is for
 * older text, this searches for the exact text first and decides on that.
 * A failed search is `failed`, never `unseen`: an outage is not a verdict.
 */
export async function resolveTyped(typed: string, shown: { q: string; matches: Match[] }, search: (q: string) => Promise<Match[] | null>): Promise<Resolved> {
  const q = typed.trim();
  const pick = (list: Match[]): Resolved => {
    const found = list.find((m) => m.gamertag.toLowerCase() === q.toLowerCase());
    return found ? { kind: "found", dayzId: found.dayzId } : { kind: "unseen" };
  };
  if (shown.q.trim() === q) return pick(shown.matches);
  const fresh = await search(q);
  return fresh === null ? { kind: "failed" } : pick(fresh);
}

/**
 * A JSON answer, or null when there is none to read (M1).
 *
 * ⚠️ Null for a dead fetch, a non-2xx, and a 200 that is not JSON. A lapsed
 * session follows the middleware's redirect to the login page's HTML with a
 * 200, so parsing — not the status — is what fails, and a bare `res.json()`
 * threw out of the handler and left the player looking at nothing.
 */
export async function readJson<T>(res: Response | null): Promise<T | null> {
  if (!res || !res.ok) return null;
  try { return (await res.json()) as T; } catch { return null; }
}
