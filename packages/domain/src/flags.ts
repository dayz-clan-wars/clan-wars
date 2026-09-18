/**
 * The unclaimed flag. Reserved: every pole starts here, and the ceremony is
 * defined as three linked UIDs raising THIS texture. A faction holding it
 * would make its own pole indistinguishable from an unclaimed one.
 */
export const NEUTRAL_FLAG = "Flag_White";

/**
 * The 33 claimable identities, from types.xml (34 flags, minus the neutral).
 *
 * ⚠️ Do not extend this list to relieve scarcity. A hard ceiling is a designed
 * feature (spec §3): 33 is what makes an identity worth having, and the
 * dormancy/disband path exists precisely so the pool can recycle rather than
 * grow.
 */
export const CLAIMABLE_FLAGS: readonly string[] = [
  "Flag_Altis", "Flag_APA", "Flag_BabyDeer", "Flag_Bear", "Flag_Bohemia",
  "Flag_BrainZ", "Flag_Cannibals", "Flag_CDF", "Flag_Chedaki", "Flag_CHEL",
  "Flag_Chernarus", "Flag_CMC", "Flag_Crook", "Flag_DayZ", "Flag_HunterZ",
  "Flag_Livonia", "Flag_LivoniaArmy", "Flag_LivoniaPolice", "Flag_NAPA",
  "Flag_NSahrani", "Flag_Pirates", "Flag_Refuge", "Flag_Rex", "Flag_Rooster",
  "Flag_RSTA", "Flag_Sakhal", "Flag_Snake", "Flag_SSahrani", "Flag_TEC",
  "Flag_UEC", "Flag_Wolf", "Flag_Zagorky", "Flag_Zenit",
] as const;

const CLAIMABLE = new Set(CLAIMABLE_FLAGS);

export function isClaimableFlag(texture: string): boolean {
  return CLAIMABLE.has(texture);
}

/**
 * `Flag_X` → `Armband_X`. All 34 flags have an exactly matching armband, so
 * this is a substitution rather than a curation table — but only for textures
 * actually in the pool, since inventing an armband name for an unknown flag
 * would name an item that does not exist.
 */
export function armbandFor(texture: string): string | null {
  if (!CLAIMABLE.has(texture)) return null;
  return texture.replace(/^Flag_/u, "Armband_");
}

/**
 * Every clan's Discord role colour, one per claimable flag.
 *
 * ⚠️ These have NOTHING to do with what the flag looks like, deliberately. The
 * flags' own art samples mostly dark (24 of 33 below 32% lightness), four are
 * near-black, and the hues pile up — nine olives and nine navies — so a
 * palette taken from the art would be unreadable on Discord and would make a
 * third of the clans indistinguishable. The flag is used only as a stable,
 * already-unique KEY: a flag is unique among holding clans, so no two clans
 * can ever be handed the same colour.
 *
 * ⚠️ Written out as a literal table rather than derived from a
 * `CLAIMABLE_FLAGS` index, because a derived one would silently reassign every
 * existing clan's colour the day somebody reorders that list. A clan's colour
 * must not move once it has one.
 *
 * Every value clears WCAG 3.0 against BOTH Discord backgrounds — dark
 * (#313338) and light (#FFFFFF) — which is the bar for the bold text Discord
 * renders a name in. `packages/domain/test/flag-colors.test.ts` holds that,
 * the uniqueness and the coverage.
 */
export const FLAG_COLORS: Record<string, `#${string}`> = {
  "Flag_Altis": "#BD635B",
  "Flag_APA": "#22A85E",
  "Flag_BabyDeer": "#CF00FF",
  "Flag_Bear": "#839E00",
  "Flag_Bohemia": "#0076FF",
  "Flag_BrainZ": "#FF002C",
  "Flag_Cannibals": "#4C9961",
  "Flag_CDF": "#B863EB",
  "Flag_Chedaki": "#99983D",
  "Flag_CHEL": "#0083CC",
  "Flag_Chernarus": "#F50057",
  "Flag_CMC": "#00AD00",
  "Flag_Crook": "#9466CC",
  "Flag_DayZ": "#B29100",
  "Flag_HunterZ": "#00A0C2",
  "Flag_Livonia": "#BD5E8A",
  "Flag_LivoniaArmy": "#4AA840",
  "Flag_LivoniaPolice": "#875CFF",
  "Flag_NAPA": "#9E814F",
  "Flag_NSahrani": "#00A88E",
  "Flag_Pirates": "#FF00A4",
  "Flag_Refuge": "#2C9E00",
  "Flag_Rex": "#786EE6",
  "Flag_Rooster": "#D17E3B",
  "Flag_RSTA": "#4C9E8F",
  "Flag_Sakhal": "#C74CB1",
  "Flag_Snake": "#639438",
  "Flag_SSahrani": "#6179C2",
  "Flag_TEC": "#DB4A16",
  "Flag_UEC": "#1EA875",
  "Flag_Wolf": "#D527D6",
  "Flag_Zagorky": "#69A300",
  "Flag_Zenit": "#5E86EB",
};

/**
 * The role colour for a flag as the integer Discord wants, or null for a
 * texture with no colour (the neutral flag, or anything not in the pool).
 *
 * ⚠️ Null means "leave the role's colour alone", never "set it to default" —
 * an unknown texture is a bug or a hand-edited row, and silently stripping a
 * clan's colour would be a worse answer than leaving what is there.
 */
export function flagColor(texture: string): number | null {
  const hex = FLAG_COLORS[texture];
  return hex === undefined ? null : Number.parseInt(hex.slice(1), 16);
}
