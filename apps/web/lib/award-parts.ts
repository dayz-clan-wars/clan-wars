/**
 * Readable names for the parts an award item spawns with (its `extras`).
 *
 * ⚠️ A test requires an entry for every extra in the award catalogue, so a new
 * loadout part fails CI here rather than showing a class name on the page.
 */
export const PART_LABELS: Record<string, string> = {
  M4_OEBttstck: "M4 OE buttstock",
  M4_RISHndgrd_Green: "M4 RIS handguard (green)",
  ACOGOptic_6x: "6x ACOG",
  M4_Suppressor: "M4 suppressor",
  Mag_STANAG_60Rnd: "60-round STANAG mag",
  AK_PlasticBttstck: "AK plastic buttstock",
  AK_PlasticHndgrd: "AK plastic handguard",
  AK_PlasticBttstck_Green: "AK plastic buttstock (green)",
  AK_FoldingBttstck_Green: "AK folding buttstock (green)",
  AK_RailHndgrd_Green: "AK rail handguard (green)",
  KobraOptic: "Kobra sight",
  PSO6Optic: "PSO-6 scope",
  MK4Optic_black: "Mk4 scope",
  Battery9V: "9V battery",
  AK_Suppressor: "AK suppressor",
  Mag_AKM_Drum75Rnd: "75-round AKM drum",
  Mag_AK101_30Rnd: "30-round AK101 mag",
  Mag_AK74_45Rnd: "45-round AK74 mag",
  Fal_OeBttstck: "FAL OE buttstock",
  Mag_FAL_20Rnd: "20-round FAL mag",
  SCAR_PrecisionBttstck: "SCAR precision buttstock",
  Mag_SCARH_20Rnd: "20-round SCAR mag",
  Mag_Vikhr_30Rnd: "30-round Vikhr mag",
  Mag_SVD_10Rnd: "10-round SVD mag",
  Mag_M14_20Rnd: "20-round M14 mag",
  Mag_SV98_10Rnd: "10-round SV98 mag",
};

/** "Kobra sight, 9V battery, 2× 75-round AKM drum": repeats counted, first-seen order. */
export function comesWith(extras: string[]): string {
  const counts = new Map<string, number>();
  for (const c of extras) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts].map(([c, n]) => `${n > 1 ? `${n}× ` : ""}${PART_LABELS[c] ?? c}`).join(", ");
}
