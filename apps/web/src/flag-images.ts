/**
 * The 33 claimable flag textures are named consistently in game and almost
 * consistently on the DayZ Fandom wiki. This module owns that "almost".
 */

/**
 * Textures whose wiki filename does not follow `<texture>.png`.
 *
 * ⚠️ Exactly one entry, and it is a table rather than a cleverer rule on
 * purpose. `Flag_Sakhal` is `Sakhal_flag.PNG` on the wiki — different word
 * order, different capitalisation, uppercase extension. Any transform general
 * enough to derive that would also mangle names that are currently correct.
 *
 * The failure this prevents is the quiet one: 32 working thumbnails and one
 * faction whose feed embeds are subtly broken, discovered weeks later by
 * whoever happens to hold Sakhal.
 *
 * Verified against the MediaWiki API on 2026-09-03.
 */
export const WIKI_FILENAME_ALIASES: Readonly<Record<string, string>> = {
  Flag_Sakhal: "Sakhal_flag.PNG",
};

/** What the wiki calls this texture's image. */
export function wikiFilenameFor(texture: string): string {
  return WIKI_FILENAME_ALIASES[texture] ?? `${texture}.png`;
}

/**
 * Where we serve it, relative to `public/`.
 *
 * ⚠️ Named after OUR texture, never the wiki's. The bot's resolver builds
 * `${base}/flags/${texture}.png` and deliberately carries no alias table, so
 * the wiki's naming inconsistency has to stop here — at fetch time — rather
 * than travelling into the bot.
 */
export function flagImagePath(texture: string): string {
  return `flags/${texture}.png`;
}
