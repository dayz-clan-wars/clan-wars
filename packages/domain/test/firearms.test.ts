import { describe, it, expect, vi } from "vitest";
import { FIREARMS, FIREARM_CLASSES, firearmOf, createFirearmLookup, OFF_CATALOGUE_FIREARM_NAMES } from "../src/firearms";

describe("firearm catalogue", () => {
  it("52 firearms, 6 counted classes, every one with a display name", () => {
    expect(FIREARMS).toHaveLength(52);
    expect(FIREARMS.every((f) => f.displayNames.length > 0)).toBe(true);
    const count = (c: string) => FIREARMS.filter((f) => f.class === c).length;
    expect(count("pistol")).toBe(12);
    expect(count("smg")).toBe(7);
    expect(count("shotgun")).toBe(5);
    expect(count("assault_rifle")).toBe(13);
    expect(count("rifle")).toBe(11);
    expect(count("sniper")).toBe(2);
    expect(count("other")).toBe(2);
    expect(FIREARM_CLASSES).toEqual(["pistol", "smg", "shotgun", "assault_rifle", "rifle", "sniper"]);
  });

  it("keys are unique and match the spec's 52", () => {
    const keys = FIREARMS.map((f) => f.key);
    expect(new Set(keys).size).toBe(52);
    expect([...keys].sort()).toEqual("ak101 ak74 akm aks74u asval aug aug_short b95 cz527 cz550 cz61 cz75 colt1911 crossbow deagle derringer fal famas fnx45 glock19 izh18 izh18_shotgun izh43 lee_enfield longhorn luger m16a2 m4a1 m79 mkii mp18 mp5k magnum makarov mosin mp133 p1 pm73 pp19 r12 repeater ruger1022 scarh scarl sks ssg82 svd saiga ump45 vss vikhr winchester70".split(" ").sort());
  });

  it("no display name maps to two firearms, and no classname is in two firearms", () => {
    const all = FIREARMS.flatMap((f) => f.displayNames);
    expect(new Set(all).size).toBe(all.length);
    const cls = FIREARMS.flatMap((f) => f.classnames);
    expect(new Set(cls).size).toBe(cls.length);
  });

  it.each([
    ["KA-M", "akm"], ["AUR AX", "aug"], ["M4-A1", "m4a1"], ["SCR 17", "scarh"], ["SCR 16", "scarl"], ["LAR", "fal"],
    ["M16-A2", "m16a2"], ["VSD", "svd"], ["KA-101", "ak101"], ["KA-74", "ak74"], ["KAS-74U", "aks74u"], ["Vikhr", "vikhr"],
    ["SVAL", "asval"], ["CR-550 Savanna", "cz550"], ["CR-527", "cz527"], ["VSS", "vss"], ["Mlock-91", "glock19"],
    ["M70 Tundra", "winchester70"], ["R12", "r12"], ["Sporter 22", "ruger1022"], ["SK 59/66", "sks"], ["BK-133", "mp133"],
    ["SG5-K", "mp5k"], ["M79", "m79"], ["SSG 82", "ssg82"], ["Mosin 91/30", "mosin"], ["LE-MAS", "famas"], ["Bizon", "pp19"],
    ["USG-45", "ump45"], ["Blaze", "b95"], ["BK-43", "izh43"], ["Engraved Kolt 1911", "colt1911"], ["Kolt 1911", "colt1911"],
    ["Derringer", "derringer"], ["Deagle", "deagle"], ["CR-75", "cz75"], ["BK-12", "izh18_shotgun"], ["Lee Enfield", "lee_enfield"],
    ["Luger", "luger"], ["CR-61 Skorpion", "cz61"], ["FX-45", "fnx45"], ["Vaiga", "saiga"], ["Longhorn", "longhorn"], ["IJ-70", "makarov"],
  ])("production name %s → %s", (n, k) => expect(firearmOf(n)).toBe(k));

  it("matches trimmed, but exactly otherwise (no neighbouring gun is credited)", () => {
    expect(firearmOf("  KA-M ")).toBe("akm");
    expect(firearmOf("ka-m")).toBeNull();
    expect(firearmOf("KA-M2")).toBeNull();
    expect(firearmOf("SCR")).toBeNull();
  });

  it("unknown, non-Nasdara and melee strings map to nothing", () => {
    for (const w of ["DMR", "VS-89", "Pioneer", "Hunting Knife", "(MeleeFist)", "TransportHit (Motorbike_02_Red)", null, ""]) expect(firearmOf(w)).toBeNull();
    for (const w of OFF_CATALOGUE_FIREARM_NAMES) expect(firearmOf(w)).toBeNull();
  });

  it("sawed-off variants count toward their parent", () => {
    const parent = (c: string) => FIREARMS.find((f) => f.classnames.includes(c))?.key;
    expect(parent("SawedoffIzh18")).toBe("izh18");
    expect(parent("SawedoffIzh18Shotgun")).toBe("izh18_shotgun");
    expect(parent("SawedoffIzh43Shotgun")).toBe("izh43");
    expect(parent("SawedoffMosin9130")).toBe("mosin");
    expect(parent("SawedoffB95")).toBe("b95");
    expect(parent("SawedoffFAMAS")).toBe("famas");
    expect(parent("SawedoffMagnum")).toBe("magnum");
    expect(firearmOf("Sawed-off BK-43")).toBe("izh43");
  });

  it("every Nasdara firearm classname (types.xml, nominal > 0, weapons) is some firearm's classname", () => {
    const NASDARA = ["AK101","AK101_Black","AK101_Green","AK74","AK74_Black","AK74_Green","AKM","AKM_Gold","AKS74U","AKS74U_Black","AKS74U_Green","ASVAL","Aug","AugShort","B95","CZ527","CZ527_Desert","CZ550","CZ61","CZ75","Colt1911","Crossbow_Black","Crossbow_Wood","Deagle","Deagle_Gold","Derringer_Grey","Engraved1911","FAL","FAMAS","FNX45","Glock19_Tan","Izh18","Izh18Shotgun","Izh43Shotgun","LeeEnfield","Longhorn","Luger","M16A2","M4A1","M4A1_Black","M4A1_Green","M79","MKII","MP18","MP5K","Magnum","Magnum_Gold","MakarovIJ70","Mosin9130","Mosin9130_Black","Mp133Shotgun","P1","PM73Rak","PP19","R12","Repeater","Ruger1022","SCARH","SCARH_Black","SCARL","SCARL_Black","SKS","SKS_Desert","SSG82","SVD","SVD_Wooden","Saiga","UMP45","VSS","Vikhr","Winchester70"];
    const known = new Set(FIREARMS.flatMap((f) => f.classnames));
    expect(NASDARA.filter((c) => !known.has(c))).toEqual([]);
  });
});

describe("createFirearmLookup (review focus 1: an unmapped gun name)", () => {
  it("counts for nothing, never throws, and warns once per name", () => {
    const warn = vi.fn();
    const lookup = createFirearmLookup(warn);
    expect(() => lookup("Sawed-off KA-M")).not.toThrow();
    expect(lookup("Sawed-off KA-M")).toBeNull();
    expect(lookup(" Sawed-off KA-M ")).toBeNull();
    expect(lookup("KA-M9")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toContain("Sawed-off KA-M");
  });
  it("a mapped name does not warn; null and empty do not warn", () => {
    const warn = vi.fn();
    const lookup = createFirearmLookup(warn);
    expect(lookup("KA-M")).toBe("akm");
    expect(lookup(null)).toBeNull();
    expect(lookup("")).toBeNull();
    // Known guns that deliberately have no tile are not news.
    expect(lookup("DMR")).toBeNull();
    expect(lookup("VS-89")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
