/**
 * The small tables the non-gun achievement rules read (spec 2026-10-20-achievements-150
 * §2.4–§2.10): which weapon strings are knives or fists, which death entities are
 * grenades or mines, which packed objects are tents, every emote, and how a ruin
 * repair's part name classifies. Every string here is as the ADM log or the parsed
 * payload carries it, never a classname the log does not print.
 */
import { classifyEntityLabel } from "./death-verdict";
import { firearmOf, isOffCatalogueFirearm } from "./firearms";

// ── Melee (§2.4) ──────────────────────────────────────────────────────────────

/**
 * Kill lines print a melee weapon's DISPLAY name. Blades you would call a knife;
 * machetes, sickles, cleavers and axes are not. Hunting Knife, Combat Knife and
 * Kukri are seen in production; the rest are unverified: not yet seen in a log.
 */
export const KNIVES: readonly string[] = ["Hunting Knife", "Combat Knife", "Kukri", "Kitchen Knife", "Steak Knife", "Stone Knife", "Bone Knife"];
const KNIFE_SET = new Set(KNIVES);

/** A fist kill prints the hit's ammo type in brackets; all three spellings occur. */
const FIST_RE = /^\(MeleeFist(?:_?Heavy)?\)$/u;

/** One stable name for every fist spelling, so "5 different melee weapons" cannot count fists three times. */
export const FISTS = "Fists";

export const isKnife = (w: string | null): boolean => w != null && KNIFE_SET.has(w.trim());
export const isFist = (w: string | null): boolean => w != null && FIST_RE.test(w.trim());
export const isSledgehammer = (w: string | null): boolean => w?.trim() === "Sledgehammer";

/**
 * A stable name for a melee kill's weapon, or null when the weapon is a gun (in
 * the catalogue or a known off-catalogue one), a vehicle, or missing.
 *
 * ⚠️ It cannot recognise a gun the tables have never heard of: callers must also
 * require a kill with no `from N meters` (spec §2.4), which every gun kill carries.
 */
export function meleeWeaponOf(weapon: string | null): string | null {
  const w = weapon?.trim() ?? "";
  if (!w) return null;
  if (firearmOf(w) || isOffCatalogueFirearm(w) || w.startsWith("TransportHit")) return null;
  return FIST_RE.test(w) ? FISTS : w;
}

// ── Dogs and motorbikes (§2.5, §2.6) ──────────────────────────────────────────

/** One statement of "is a dog": the verdict's own label rules, so the two cannot drift. */
export const isDogLabel = (label: string | null): boolean => classifyEntityLabel(label) === "dog";

export const isMotorbikeClass = (s: string | null): boolean => s != null && /^Motorbike_/u.test(s);

const MOTORBIKE_WEAPON_RE = /^TransportHit \((Motorbike_[^)]+)\)$/u;
/** `TransportHit (Motorbike_02_Red)` → `Motorbike_02_Red`; any other weapon → null. */
export function motorbikeOfWeapon(w: string | null): string | null {
  return w == null ? null : MOTORBIKE_WEAPON_RE.exec(w.trim())?.[1] ?? null;
}

// ── Traps and explosives (§2.8) ───────────────────────────────────────────────

/**
 * The `entity` a grenade death stores. adm-parser's ENTITY_RE captures only
 * `[A-Za-z0-9_]+` after "killed by", so the display name is cut at its first
 * hyphen or space:
 *   "killed by 6-M7 Frag Grenade" → "6"   ⚠️ yes, the bare digit: that is what is stored
 *   "killed by EGD-5 Frag Grenade" → "EGD", "killed by RGD-5 …" → "RGD"
 *   "killed by M67Grenade", "killed by MNGrenade" → the classname whole
 * Not "Plastic" (Plastic Explosive), "LandMineTrap" or "Claymore": those are not
 * grenades, and the mine tile owns the latter two. Anchored so "60" or a vehicle
 * class can never pass. An M79 death with no killer prints "killed by  with 40mm
 * Explosive Grenade" and stores a null entity, so it is not a grenade kill here.
 */
export const GRENADE_ENTITY_RE = /^(?:6|EGD|RGD|[A-Za-z0-9_]*Grenade[A-Za-z0-9_]*)$/u;

export const MINE_ENTITIES = ["LandMineTrap", "Claymore"] as const;

/** `hit by ChickenBreastMeat with …`: thrown meat is the hitter's classname. */
export const THROWN_MEAT_RE = /Meat$/u;

// ── Camp (§2.9) ───────────────────────────────────────────────────────────────

/**
 * Display names in `packed <Tent> with Hands`. Large, Car and Medium Tent and
 * Improvised Shelter are in `factions_live.raw_lines`; Canopy Tent, Tarp Shelter
 * and Party Tent come from the plan's production notes (other servers' logs).
 */
export const TENTS: readonly string[] = ["Large Tent", "Car Tent", "Medium Tent", "Canopy Tent", "Improvised Shelter", "Tarp Shelter", "Party Tent"];

// ── Emotes (§2.10) ────────────────────────────────────────────────────────────

/**
 * Every emote a console player can perform, in `payload.emote` form (the parser
 * keeps the "Emote" prefix: `performed EmoteSalute` → "EmoteSalute"). These are
 * the 36 distinct tokens production has logged, which is the whole console wheel
 * plus the sit/lie poses and Suicide.
 *
 * ⚠️ "Full Repertoire" needs every one of these, so a token nobody can perform
 * makes the tile unearnable. Add one only after a production line shows it.
 */
export const EMOTES = [
  "EmoteSitA", "EmoteSitB", "EmoteCampfireSit", "EmoteLyingDown", "EmoteSuicide", "EmoteGreeting", "EmoteShrug",
  "EmoteSurrender", "EmoteDance", "EmoteTaunt", "EmoteTauntElbow", "EmoteTauntKiss", "EmoteTauntThink", "EmoteRPSRandom",
  "EmoteSalute", "EmoteClap", "EmotePoint", "EmotePointSelf", "EmoteThumb", "EmoteThumbDown", "EmoteVomit", "EmoteShake",
  "EmoteNod", "EmoteThroat", "EmoteLookAtMe", "EmoteHeart", "EmoteFacepalm", "EmoteTimeout", "EmoteSilent", "EmoteSOS",
  "EmoteMove", "EmoteListening", "EmoteWatching", "EmoteCome", "EmoteHold", "EmoteGetDown",
] as const;

// ── Ruins (§2.7) ──────────────────────────────────────────────────────────────

export const RUIN_RUBBLE_RE = /^rubble_/u;

export type RuinKind = "door" | "window" | "roof" | "wall" | "rubble" | "ladder";

/**
 * The kind of a ruin repair's part: `door1_metal` → door, `window4_metal` → window,
 * `roof1` → roof, `rubble_rubble1` → rubble, `ladder_rebuild` → ladder. A wall
 * section with a window or door in it (`wall2_window_wood`) is a wall: it is the
 * wall that was rebuilt. The prefix must be followed by a digit or "_" so
 * `doorframe` or `roofing` never count.
 */
export function RUIN_KIND(part: string): RuinKind | null {
  return (/^(door|window|roof|wall|rubble|ladder)(?=\d|_|$)/u.exec(part)?.[1] as RuinKind | undefined) ?? null;
}
