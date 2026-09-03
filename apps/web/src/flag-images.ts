/**
 * The 33 claimable flag textures are named consistently in game, but the
 * DayZ Fandom wiki's flat "in-game texture" gallery names them after the
 * in-game abbreviation baked into each `_co` texture file, not after our
 * `Flag_X` names. Essentially nothing maps by rule, so this module owns a
 * complete, explicit mapping rather than a rule plus exceptions.
 */

/**
 * The wiki's filename for each claimable texture's flat, in-game render.
 *
 * Built from the wiki gallery's own captions and verified against the
 * MediaWiki API on 2026-09-03: all 33 files exist and are landscape.
 *
 * Some entries look wrong and are not — the wiki names these after in-game
 * abbreviations, not our faction-facing names:
 *   - Flag_Rooster      -> Flag_cock_co.png
 *   - Flag_BabyDeer     -> Flag_fawn_co.png
 *   - Flag_Bohemia      -> Flag_bi_co.png       (Bohemia Interactive)
 *   - Flag_HunterZ      -> Flag_zhunters_co.png (Zombie Hunters)
 *   - Flag_NSahrani     -> Flag_dros_co.png
 *   - Flag_SSahrani     -> Flag_kos_co.png
 *   - Flag_LivoniaArmy  -> Flag_ldf_co.png      (Livonian Defense Force)
 *   - Flag_Cannibals    -> Flag_jolly_c_co.png
 *   - Flag_Pirates      -> Flag_jolly_co.png
 *
 * ⚠️ `Flag_Chedaki` (`Flagchedaki1.jpg`) and `Flag_Sakhal` (`Sakhalflag.PNG`)
 * have no `_co` game texture on the wiki at all — these are the only flat
 * images that exist for them, at lower resolution than the rest (360x234
 * JPEG and 475x249 respectively, vs. every other entry's true 2:1 `_co`
 * texture). Do not "fix" these to invented `_co` names — none exist. And do
 * not "fix" `Flag_Sakhal` to `Sakhal_flag.PNG` (note the underscore) — that
 * is a *different* file on the wiki: the folded/hanging render this table
 * replaced, not the flat one.
 *
 * The failure this table prevents is the quiet one: a texture missing from
 * this map does not surface as a build error, it surfaces as a missing (or,
 * worse, wrong) Discord embed thumbnail weeks later.
 */
export const WIKI_FILENAME: Readonly<Record<string, string>> = {
  Flag_Altis: "Flag_alti_co.png",
  Flag_APA: "Flag_apa_co.png",
  Flag_BabyDeer: "Flag_fawn_co.png",
  Flag_Bear: "Flag_bear_co.png",
  Flag_Bohemia: "Flag_bi_co.png",
  Flag_BrainZ: "Flag_brain_co.png",
  Flag_Cannibals: "Flag_jolly_c_co.png",
  Flag_CDF: "Flag_cdf_co.png",
  Flag_Chedaki: "Flagchedaki1.jpg",
  Flag_CHEL: "Flag_chel_co.png",
  Flag_Chernarus: "Flag_chern_co.png",
  Flag_CMC: "Flag_cmc_co.png",
  Flag_Crook: "Flag_crook_co.png",
  Flag_DayZ: "Flag_dayz_co.png",
  Flag_HunterZ: "Flag_zhunters_co.png",
  Flag_Livonia: "Flag_livo_co.png",
  Flag_LivoniaArmy: "Flag_ldf_co.png",
  Flag_LivoniaPolice: "Flag_police_co.png",
  Flag_NAPA: "Flag_napa_co.png",
  Flag_NSahrani: "Flag_dros_co.png",
  Flag_Pirates: "Flag_jolly_co.png",
  Flag_Refuge: "Flag_refuge_co.png",
  Flag_Rex: "Flag_rex_co.png",
  Flag_Rooster: "Flag_cock_co.png",
  Flag_RSTA: "Flag_rsta_co.png",
  Flag_Sakhal: "Sakhalflag.PNG",
  Flag_Snake: "Flag_snake_co.png",
  Flag_SSahrani: "Flag_kos_co.png",
  Flag_TEC: "Flag_tec_co.png",
  Flag_UEC: "Flag_uec_co.png",
  Flag_Wolf: "Flag_wolf_co.png",
  Flag_Zagorky: "Flag_zagorky_co.png",
  Flag_Zenit: "Flag_zenit_co.png",
};

/**
 * What the wiki calls this texture's image.
 *
 * ⚠️ Throws on a miss rather than inventing `<texture>.png` — a texture not
 * in `WIKI_FILENAME` means the flag pool and this table have diverged, and
 * a silently-wrong guess would fail as a blank thumbnail with no clue why.
 */
export function wikiFilenameFor(texture: string): string {
  const filename = WIKI_FILENAME[texture];
  if (!filename) throw new Error(`no wiki filename mapped for texture ${texture}`);
  return filename;
}

/**
 * Where we serve it, relative to `public/`.
 *
 * ⚠️ Named after OUR texture, never the wiki's. The bot's resolver builds
 * `${base}/flags/${texture}.png` and deliberately carries no alias table of
 * its own, so the wiki's naming has to stop here — at fetch time — rather
 * than travelling into the bot.
 */
export function flagImagePath(texture: string): string {
  return `flags/${texture}.png`;
}
