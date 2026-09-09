/**
 * A linked member's home is their public player page: /me forwards there
 * (app/(site)/me/route.ts), and the player page shows its owner's controls.
 * Pure, so test/own-page.test.ts pins it without a database.
 */

type Query = Record<string, string | undefined>;

function withQuery(path: string, query: Query): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) q.set(k, v);
  const s = q.toString();
  return `${path}${s ? `?${s}` : ""}`;
}

/** `/players/<gamertag>`, with the notice codes an action route appended (`?unlink=`, `?result=`) carried along. */
export function ownPagePath(gamertag: string, query: Query = {}): string {
  return withQuery(`/players/${encodeURIComponent(gamertag)}`, query);
}

/**
 * Where /me sends a member: their own player page once a character is
 * linked, the link flow before. Nothing else waits on an unlinked member —
 * invites and requests both need a link, and a ceremony's participants are
 * linked by definition — so /link IS the whole of their "you".
 */
export function homePath(linkGamertag: string | null | undefined, query: Query = {}): string {
  return linkGamertag != null ? ownPagePath(linkGamertag, query) : withQuery("/link", query);
}

/**
 * Whether the page's gamertag is the viewer's own link. Case-insensitive,
 * the way `playerProfile` looks the gamertag up (`lower(...) = lower(...)`),
 * so a link typed in one case still owns the page the roster found.
 */
export function isOwnPage(linkGamertag: string | null | undefined, pageGamertag: string): boolean {
  return linkGamertag != null && linkGamertag.toLowerCase() === pageGamertag.toLowerCase();
}
