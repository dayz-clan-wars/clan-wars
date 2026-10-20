/**
 * The firearm catalogue behind the gun tiles (spec 2026-10-20-achievements-150 §2.2).
 *
 * One entry per firearm that spawns on Nasdara (types.xml, category weapons,
 * nominal > 0), with colour and finish variants merged into one firearm and
 * player-made sawed-off variants counted toward their parent.
 *
 * ⚠️ A PvP kill line names the gun by its in-game DISPLAY name, not its
 * classname ("killed by Player … with KA-M from 42 meters"). `displayNames` is
 * what `firearmOf` matches, so it is the load-bearing column. `classnames` is
 * documentation plus the test that every Nasdara weapon is covered; nothing
 * matches a kill on it.
 *
 * A display name marked `// unverified` has not been printed by any production
 * kill or hit line yet; it is the game's English stringtable name as best known.
 * If one is wrong, kills with that gun count for nothing and `createFirearmLookup`
 * logs the real string once, which is the cue to correct the row here. Rows
 * without the mark were read from `raw_lines` (kill lines, or hit lines' `with …`).
 */

export type FirearmClass = "pistol" | "smg" | "shotgun" | "assault_rifle" | "rifle" | "sniper" | "other";

/** The classes that have a tile, in display order. "other" (Crossbow, M79) has none. */
export const FIREARM_CLASSES = ["pistol", "smg", "shotgun", "assault_rifle", "rifle", "sniper"] as const satisfies readonly Exclude<FirearmClass, "other">[];

type Row<K extends string> = { key: K; name: string; class: FirearmClass; classnames: readonly string[]; displayNames: readonly string[] };
const row = <const K extends string>(r: Row<K>): Row<K> => r;

export const FIREARMS = [
  // ── Pistols (12) ────────────────────────────────────────────────────────────
  row({ key: "cz75", name: "CR-75", class: "pistol", classnames: ["CZ75"], displayNames: ["CR-75"] }),
  // Engraved1911 is a finish variant: same gun, its own display name.
  row({ key: "colt1911", name: "Kolt 1911", class: "pistol", classnames: ["Colt1911", "Engraved1911"], displayNames: ["Kolt 1911", "Engraved Kolt 1911"] }),
  row({ key: "deagle", name: "Deagle", class: "pistol", classnames: ["Deagle", "Deagle_Gold"], displayNames: ["Deagle"] }),
  row({ key: "derringer", name: "Derringer", class: "pistol", classnames: ["Derringer_Black", "Derringer_Grey", "Derringer_Pink"], displayNames: ["Derringer"] }),
  row({ key: "fnx45", name: "FX-45", class: "pistol", classnames: ["FNX45"], displayNames: ["FX-45"] }),
  row({ key: "glock19", name: "Mlock-91", class: "pistol", classnames: ["Glock19", "Glock19_Tan"], displayNames: ["Mlock-91"] }),
  row({ key: "luger", name: "Luger", class: "pistol", classnames: ["Luger"], displayNames: ["Luger"] }),
  row({ key: "mkii", name: "MK II", class: "pistol", classnames: ["MKII"], displayNames: ["MK II"] }), // unverified: not yet seen in a log
  row({ key: "magnum", name: "Magnum", class: "pistol", classnames: ["Magnum", "Magnum_Gold", "SawedoffMagnum", "SawedoffMagnum_Gold"],
    displayNames: ["Magnum", "Sawed-off Magnum"] }), // unverified: not yet seen in a log
  row({ key: "makarov", name: "IJ-70", class: "pistol", classnames: ["MakarovIJ70"], displayNames: ["IJ-70"] }),
  row({ key: "p1", name: "P1", class: "pistol", classnames: ["P1"], displayNames: ["P1"] }), // unverified: not yet seen in a log
  row({ key: "longhorn", name: "Longhorn", class: "pistol", classnames: ["Longhorn"], displayNames: ["Longhorn"] }),

  // ── SMGs (7) ────────────────────────────────────────────────────────────────
  row({ key: "cz61", name: "CR-61 Skorpion", class: "smg", classnames: ["CZ61"], displayNames: ["CR-61 Skorpion"] }),
  row({ key: "mp5k", name: "SG5-K", class: "smg", classnames: ["MP5K"], displayNames: ["SG5-K"] }),
  row({ key: "ump45", name: "USG-45", class: "smg", classnames: ["UMP45"], displayNames: ["USG-45"] }),
  row({ key: "pp19", name: "Bizon", class: "smg", classnames: ["PP19"], displayNames: ["Bizon"] }),
  // Two spellings because neither has been confirmed; they cannot collide with any other gun.
  row({ key: "mp18", name: "MP-18", class: "smg", classnames: ["MP18"], displayNames: ["MP-18", "MP18"] }), // unverified: not yet seen in a log
  row({ key: "pm73", name: "PM73 RAK", class: "smg", classnames: ["PM73Rak"], displayNames: ["PM73 RAK"] }), // unverified: not yet seen in a log
  // Vikhr: a compact assault rifle in life; the owner-approved table files it as an SMG (spec §2.2).
  row({ key: "vikhr", name: "Vikhr", class: "smg", classnames: ["Vikhr"], displayNames: ["Vikhr"] }),

  // ── Shotguns (5) ────────────────────────────────────────────────────────────
  row({ key: "izh18_shotgun", name: "BK-12", class: "shotgun", classnames: ["Izh18Shotgun", "SawedoffIzh18Shotgun"],
    displayNames: ["BK-12", "Sawed-off BK-12"] }), // "Sawed-off BK-12" unverified: not yet seen in a log
  row({ key: "izh43", name: "BK-43", class: "shotgun", classnames: ["Izh43Shotgun", "SawedoffIzh43Shotgun"],
    displayNames: ["BK-43", "Sawed-off BK-43"] }), // "Sawed-off BK-43" unverified: not yet seen in a log
  row({ key: "mp133", name: "BK-133", class: "shotgun", classnames: ["Mp133Shotgun"], displayNames: ["BK-133"] }),
  row({ key: "saiga", name: "Vaiga", class: "shotgun", classnames: ["Saiga"], displayNames: ["Vaiga"] }),
  row({ key: "r12", name: "R12", class: "shotgun", classnames: ["R12"], displayNames: ["R12"] }),

  // ── Assault rifles (13) ─────────────────────────────────────────────────────
  row({ key: "ak101", name: "KA-101", class: "assault_rifle", classnames: ["AK101", "AK101_Black", "AK101_Green"], displayNames: ["KA-101"] }),
  row({ key: "ak74", name: "KA-74", class: "assault_rifle", classnames: ["AK74", "AK74_Black", "AK74_Green"], displayNames: ["KA-74"] }),
  row({ key: "akm", name: "KA-M", class: "assault_rifle", classnames: ["AKM", "AKM_Gold"], displayNames: ["KA-M"] }),
  row({ key: "aks74u", name: "KAS-74U", class: "assault_rifle", classnames: ["AKS74U", "AKS74U_Black", "AKS74U_Green"], displayNames: ["KAS-74U"] }),
  row({ key: "asval", name: "SVAL", class: "assault_rifle", classnames: ["ASVAL"], displayNames: ["SVAL"] }),
  row({ key: "aug", name: "AUR AX", class: "assault_rifle", classnames: ["Aug"], displayNames: ["AUR AX"] }),
  // ⚠️ Distinct from the AUR AX (spec §2.2: Aug vs AugShort stay two tiles).
  row({ key: "aug_short", name: "AUR A1", class: "assault_rifle", classnames: ["AugShort"], displayNames: ["AUR A1"] }), // unverified: not yet seen in a log
  row({ key: "fal", name: "LAR", class: "assault_rifle", classnames: ["FAL"], displayNames: ["LAR"] }),
  row({ key: "famas", name: "LE-MAS", class: "assault_rifle", classnames: ["FAMAS", "SawedoffFAMAS"],
    displayNames: ["LE-MAS", "Sawed-off LE-MAS"] }), // "Sawed-off LE-MAS" unverified: not yet seen in a log
  row({ key: "m16a2", name: "M16-A2", class: "assault_rifle", classnames: ["M16A2"], displayNames: ["M16-A2"] }),
  row({ key: "m4a1", name: "M4-A1", class: "assault_rifle", classnames: ["M4A1", "M4A1_Black", "M4A1_Green"], displayNames: ["M4-A1"] }),
  row({ key: "scarh", name: "SCR 17", class: "assault_rifle", classnames: ["SCARH", "SCARH_Black"], displayNames: ["SCR 17"] }),
  row({ key: "scarl", name: "SCR 16", class: "assault_rifle", classnames: ["SCARL", "SCARL_Black"], displayNames: ["SCR 16"] }),

  // ── Rifles (11) ─────────────────────────────────────────────────────────────
  row({ key: "b95", name: "Blaze", class: "rifle", classnames: ["B95", "SawedoffB95"],
    displayNames: ["Blaze", "Sawed-off Blaze"] }), // "Sawed-off Blaze" unverified: not yet seen in a log
  row({ key: "cz527", name: "CR-527", class: "rifle", classnames: ["CZ527", "CZ527_Black", "CZ527_Camo", "CZ527_Desert"], displayNames: ["CR-527"] }),
  row({ key: "cz550", name: "CR-550 Savanna", class: "rifle", classnames: ["CZ550"], displayNames: ["CR-550 Savanna"] }),
  // ⚠️ The BK-18 rifle and the BK-12 shotgun are two firearms (spec §2.2); only BK-12 has been seen.
  row({ key: "izh18", name: "BK-18", class: "rifle", classnames: ["Izh18", "SawedoffIzh18"],
    displayNames: ["BK-18", "Sawed-off BK-18"] }), // unverified: not yet seen in a log
  row({ key: "lee_enfield", name: "Lee Enfield", class: "rifle", classnames: ["LeeEnfield"], displayNames: ["Lee Enfield"] }),
  row({ key: "mosin", name: "Mosin 91/30", class: "rifle", classnames: ["Mosin9130", "Mosin9130_Black", "Mosin9130_Camo", "Mosin9130_Green", "SawedoffMosin9130", "SawedoffMosin9130_Black", "SawedoffMosin9130_Camo", "SawedoffMosin9130_Green"],
    displayNames: ["Mosin 91/30", "Sawed-off Mosin", "Sawed-off Mosin 91/30"] }), // both sawed-off spellings unverified: not yet seen in a log
  row({ key: "repeater", name: "Repeater Carbine", class: "rifle", classnames: ["Repeater"], displayNames: ["Repeater Carbine", "Repeater"] }), // unverified: not yet seen in a log
  row({ key: "ruger1022", name: "Sporter 22", class: "rifle", classnames: ["Ruger1022"], displayNames: ["Sporter 22"] }),
  // SKS: semi-automatic carbine; filed as a rifle, as the owner-approved table has it.
  row({ key: "sks", name: "SK 59/66", class: "rifle", classnames: ["SKS", "SKS_Black", "SKS_Green", "SKS_Desert"], displayNames: ["SK 59/66"] }),
  row({ key: "ssg82", name: "SSG 82", class: "rifle", classnames: ["SSG82"], displayNames: ["SSG 82"] }),
  row({ key: "winchester70", name: "M70 Tundra", class: "rifle", classnames: ["Winchester70", "Winchester70_Black", "Winchester70_Green"], displayNames: ["M70 Tundra"] }),

  // ── Snipers (2) ─────────────────────────────────────────────────────────────
  row({ key: "svd", name: "VSD", class: "sniper", classnames: ["SVD", "SVD_Wooden"], displayNames: ["VSD"] }),
  row({ key: "vss", name: "VSS", class: "sniper", classnames: ["VSS"], displayNames: ["VSS"] }),

  // ── Other (2): count for Full Armory, no class tile ─────────────────────────
  row({ key: "crossbow", name: "Crossbow", class: "other", classnames: ["Crossbow", "Crossbow_Autumn", "Crossbow_Black", "Crossbow_Summer", "Crossbow_Wood"], displayNames: ["Crossbow"] }), // unverified: not yet seen in a log
  row({ key: "m79", name: "M79", class: "other", classnames: ["M79"], displayNames: ["M79"] }),
] as const;

export type FirearmKey = (typeof FIREARMS)[number]["key"];

/**
 * Guns the production log has printed that are NOT in the catalogue: earlier
 * maps' or award kits' weapons that do not spawn on Nasdara. They count for
 * Arsenal (which counts raw strings) and for no gun tile. Listed so that
 * `meleeWeaponOf` does not mistake them for melee, and so the lookup does not
 * warn about names that are known and deliberately unmapped.
 */
export const OFF_CATALOGUE_FIREARM_NAMES: readonly string[] = ["DMR", "VS-89", "Pioneer"];

// Built once. ⚠️ Exact match after trim: a near-miss must never credit a neighbouring gun.
const BY_DISPLAY_NAME: ReadonlyMap<string, FirearmKey> = new Map(FIREARMS.flatMap((f) => f.displayNames.map((n) => [n, f.key] as const)));
const OFF_CATALOGUE = new Set(OFF_CATALOGUE_FIREARM_NAMES);

/** The firearm a kill line's weapon display name names, or null (unknown, melee, vehicle, empty). Pure; never logs. */
export function firearmOf(weapon: string | null): FirearmKey | null {
  if (weapon == null) return null;
  return BY_DISPLAY_NAME.get(weapon.trim()) ?? null;
}

/** True for a display name of a gun that exists but is outside the catalogue (DMR, VS-89, Pioneer). */
export function isOffCatalogueFirearm(weapon: string | null): boolean {
  return weapon != null && OFF_CATALOGUE.has(weapon.trim());
}

/**
 * `firearmOf` that reports each unmapped name ONCE per lookup (one lookup per
 * process is the intent). Call it only for a weapon you already believe is a gun
 * (a kill with `from N meters`): it cannot tell an unknown gun from a melee item.
 *
 * ⚠️ Spec §2.2: an unmapped display name counts toward nothing and must be logged,
 * or a misspelled row silently makes a tile unearnable. It never throws.
 * The known off-catalogue guns are not reported: they are deliberately unmapped.
 */
export function createFirearmLookup(warn: (message: string) => void): (weapon: string | null) => FirearmKey | null {
  const reported = new Set<string>();
  return (weapon) => {
    const key = firearmOf(weapon);
    if (key) return key;
    const name = weapon?.trim() ?? "";
    if (name && !OFF_CATALOGUE.has(name) && !reported.has(name)) {
      reported.add(name);
      warn(`achievements: weapon display name ${JSON.stringify(name)} is not in the firearm table (packages/domain/src/firearms.ts); it counts toward no gun tile`);
    }
    return null;
  };
}
