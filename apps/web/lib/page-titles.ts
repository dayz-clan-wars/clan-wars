/**
 * <title>s for pages about one thing. The site's form is "Clan Wars — <thing>"
 * (test/kit.test.ts pins it for /kit); for a clan or a player the thing is its
 * NAME, so two open tabs can be told apart (M6). Built from the record the
 * page read, never from the URL: a path segment is attacker-supplied.
 */
export const clanTitle = (c: { name: string; tag: string }) => `Clan Wars — ${c.name} [${c.tag}]`;
export const playerTitle = (gamertag: string) => `Clan Wars — ${gamertag}`;
export const NOT_FOUND_TITLE = "Clan Wars — not found";
