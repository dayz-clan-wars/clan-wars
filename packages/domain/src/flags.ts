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
