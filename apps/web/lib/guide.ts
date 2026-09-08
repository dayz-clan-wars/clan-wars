/**
 * Where the field guide lives. `../field-guide/` is its own repo, published
 * by GitHub Pages at this host (its `CNAME`). The site's `/guide` route is a
 * permanent redirect here (next.config.ts) — the guide is the authority over
 * every rule (CLAUDE.md, "Where things live"), so it has exactly one copy.
 *
 * No trailing slash: next.config.ts appends the path.
 */
export const GUIDE_URL = "https://fieldguide.dayzclanwars.com";
