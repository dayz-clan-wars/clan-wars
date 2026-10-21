import { EMOTES } from "./achievement-evidence";
import { FIREARMS, FIREARM_CLASSES } from "./firearms";

/**
 * The achievements — data, not code. A `retired` one (Wanderer, fast travel;
 * Wolf Bait and Bear Necessities, no wolves or bears: all gone with the Nasdara
 * swap) stays in the list so its holders keep it, its badge and its share card. The badge wall, the Discord line,
 * the guide chapter and the bot's rules all read THIS array; a threshold
 * changes here and nowhere else (spec 2026-09-11 §4).
 *
 * `target` is in `unit`: a count, hours, days, or metres. One-shot
 * achievements are `target: 1, unit: "count"`. The rule for each key lives in
 * apps/bot/src/achievements/rules.ts; apps/bot/test/achievements/rules.test.ts
 * fails if a key here has no rule or a rule has no key here.
 */
export const ACHIEVEMENT_GROUPS = ["solo", "pve", "pvp", "team"] as const;
export type AchievementGroup = (typeof ACHIEVEMENT_GROUPS)[number];
/**
 * The colour each group's badge is drawn in (design hand-off 2026-09-12):
 * solo is the ink, pve the olive, pvp the rust-as-text, team the gold. Stated
 * ONCE here because both the site (the badge, the tile, the toast, the share
 * card) and the bot (the Discord embed's colour) draw from it; the site's
 * Tailwind tokens restate the hex values and `apps/web/test/theme-tokens.test.ts`
 * holds them to these.
 */
export const ACHIEVEMENT_GROUP_COLORS: Record<AchievementGroup, `#${string}`> = { solo: "#e8e2d4", pve: "#8fa36a", pvp: "#d4623a", team: "#d9a03c" };
export type AchievementOwner = "player" | "clan";
export type AchievementUnit = "count" | "hours" | "days" | "m";

/**
 * `section` groups tiles on the wall (spec 2026-10-20-achievements-150): "armory" marks the
 * 59 gun, class and Full Armory tiles. Optional, like `retired`, so the other tiles' types are unchanged.
 */
type DefOpts = { retired?: true; section?: "armory" };
const def = <K extends string, O extends DefOpts = {}>(key: K, name: string, description: string, group: AchievementGroup, target = 1, unit: AchievementUnit = "count", opts: O = {} as O) =>
  ({ key, name, description, group, owner: group === "team" ? "clan" : "player", target, unit, ...opts }) as const;

const ARMORY = { section: "armory" } as const;
/** The class sizes come from the catalogue, never a typed number: a gun added to a class moves its target. */
const classSize = (c: (typeof FIREARM_CLASSES)[number]): number => FIREARMS.filter((f) => f.class === c).length;
const classTile = <K extends string>(key: K, name: string, description: string, c: (typeof FIREARM_CLASSES)[number]) =>
  def(key, name, description, "pvp", classSize(c), "count", ARMORY);

export const ACHIEVEMENTS = [
  // Solo — presence and progression
  def("enlisted", "Enlisted", "Link your account", "solo"),
  def("squad_up", "Squad Up", "Become a full member of a clan", "solo"),
  def("founder", "Founder", "Take part in a founding ceremony", "solo"),
  def("loyalist", "Loyalist", "Stay a full member of one clan for 30 days", "solo", 30, "days"),
  def("long_haul", "Long Haul", "Play for 24 hours", "solo", 24, "hours"),
  def("veteran", "Veteran", "Play for 100 hours", "solo", 100, "hours"),
  def("lifer", "Lifer", "Play for 500 hours", "solo", 500, "hours"),
  def("regular", "Regular", "Play on 7 consecutive days", "solo", 7, "days"),
  def("devoted", "Devoted", "Play on 30 consecutive days", "solo", 30, "days"),
  // ⚠️ Retired: Nasdara has no fast travel. Never delete it — the unlock rows that cite
  // this key are records, and the wall still shows it to the players who hold it.
  def("wanderer", "Wanderer", "Fast travel 10 times", "solo", 10, "count", { retired: true }),
  def("explorer", "Explorer", "Seen in 50 different 1 km grid squares", "solo", 50),
  def("globetrotter", "Globetrotter", "Seen in 150 different 1 km grid squares", "solo", 150),
  def("showman", "Showman", "Perform 50 emotes", "solo", 50),
  def("performer", "Performer", "Perform 500 emotes", "solo", 500),
  def("mime", "Mime", "Perform 10 different emotes", "solo", 10),
  // The target is the list's length, never a typed number: an emote added to EMOTES moves it.
  def("full_repertoire", "Full Repertoire", "Perform every emote", "solo", EMOTES.length),
  def("rps_champ", "Best of Ten", "Play rock-paper-scissors 10 times", "solo", 10),
  def("cartographer", "Cartographer", "Drop 10 map pins", "solo", 10),
  // PvE — the map, the builds, and the ways it kills you
  def("foundation", "Foundation", "Build your first base part", "pve"),
  def("builder", "Builder", "Earn 100 build points", "pve", 100),
  def("architect", "Architect", "Earn 500 build points", "pve", 500),
  def("master_builder", "Master Builder", "Earn 2,000 build points", "pve", 2000),
  def("ironman", "Ironman", "Play for 5 hours without dying", "pve", 5, "hours"),
  // ⚠️ Retired: Nasdara has no wolves or bears. Kept, like Wanderer, for their holders.
  def("wolf_bait", "Wolf Bait", "Get killed by a wolf", "pve", 1, "count", { retired: true }),
  def("bear_necessities", "Bear Necessities", "Get killed by a bear", "pve", 1, "count", { retired: true }),
  def("brains", "Brains", "Get killed by infected", "pve"),
  def("gravity_check", "Gravity Check", "Die to a fall", "pve"),
  def("sunday_driver", "Sunday Driver", "Get killed by a vehicle", "pve"),
  def("lights_out", "Lights Out", "Get knocked unconscious 10 times", "pve", 10),
  def("comeback", "Comeback", "Come round after being knocked out 10 times", "pve", 10),
  def("should_have_bandaged", "Should Have Bandaged", "Bleed out", "pve"),
  def("sleeps_with_fishes", "Sleeps With the Fishes", "Drown", "pve"),
  def("nine_lives", "Nine Lives", "Die 9 times, any cause", "pve", 9),
  def("hundred_lives", "Hundred Lives", "Die 100 times, any cause", "pve", 100),
  // PvE — oddities (§2.10)
  def("burned", "Burned", "Get burned by a fire", "pve"),
  def("hipster", "Hipster", "Eat your food before it was cool", "pve"),
  // PvE — dogs and motorbikes (spec 2026-10-20-achievements-150 §2.5, §2.6)
  def("dog_food", "Dog Food", "Get killed by a dog", "pve"),
  def("bad_dog", "Bad Dog", "Survive a dog attack", "pve"),
  def("chew_toy", "Chew Toy", "Take 10 dog bites", "pve", 10),
  def("road_rash", "Road Rash", "Get hurt by a motorbike", "pve"),
  def("wipeout", "Wipeout", "Get killed by a motorbike", "pve"),
  // PvE — ruins (§2.7): repairs of Nasdara's ruined buildings, never build points
  def("squatter", "Squatter", "Repair a ruined building", "pve"),
  def("rubble_rouser", "Rubble Rouser", "Clear 10 rubble piles", "pve", 10),
  def("renovator", "Renovator", "Make 25 ruin repairs", "pve", 25),
  def("fixer_upper", "Fixer-Upper", "Repair a door, a window and a roof", "pve"),
  // PvE — traps and explosives (§2.8)
  def("snapped", "Snapped", "Step in a bear trap", "pve"),
  def("tripped", "Tripped", "Set off a tripwire", "pve"),
  def("snagged", "Snagged", "Get caught in barbed wire", "pve"),
  def("minesweeper", "Minesweeper", "Get killed by a mine or claymore", "pve"),
  def("frag_out", "Frag Out", "Get killed by a grenade", "pve"),
  // PvE — camp (§2.9)
  def("barrel_hoarder", "Hoarder", "Place 10 barrels", "pve", 10),
  def("pack_up", "Pack Up", "Pack 10 tents", "pve", 10),
  def("sea_legs", "Sea Legs", "Place a sea chest", "pve"),
  def("minefield", "Minefield", "Place a land mine", "pve"),
  // PvP — kills, streaks, and flags taken by hand
  def("first_blood", "First Blood", "Your first PvP kill", "pvp"),
  def("ten_down", "Ten Down", "Get 10 PvP kills", "pvp", 10),
  def("centurion", "Centurion", "Get 100 PvP kills", "pvp", 100),
  def("warlord", "Warlord", "Get 250 PvP kills", "pvp", 250),
  def("marksman", "Marksman", "A kill from 150 m or more", "pvp", 150, "m"),
  def("sniper", "Sniper", "A kill from 300 m or more", "pvp", 300, "m"),
  def("long_shot", "Long Shot", "A kill from 500 m or more", "pvp", 500, "m"),
  def("point_blank", "Point Blank", "A kill from under 5 m", "pvp", 5, "m"),
  def("arsenal", "Arsenal", "Kills with 10 different weapons", "pvp", 10),
  def("hat_trick", "Hat Trick", "Get 3 PvP kills in one session", "pvp", 3),
  def("killing_spree", "Killing Spree", "Get 5 PvP kills without a PvP death", "pvp", 5),
  def("unstoppable", "Unstoppable", "Get 10 PvP kills without a PvP death", "pvp", 10),
  def("nemesis", "Nemesis", "Kill the same player 5 times", "pvp", 5),
  def("headhunter", "Headhunter", "Kill 25 different players", "pvp", 25),
  def("payback", "Payback", "Kill someone within an hour of them killing you", "pvp"),
  def("flag_thief", "Flag Thief", "Lower an enemy flag yourself in a scored raid", "pvp"),
  def("home_defender", "Home Defender", "Make the raise that ends a siege", "pvp"),
  def("blue_on_blue", "Blue on Blue", "Kill a clanmate", "pvp"),
  // PvP — up close: melee and motorbikes (spec §2.4, §2.6)
  def("knife_work", "Knife Work", "A PvP kill with a knife", "pvp"),
  def("bare_knuckles", "Bare Knuckles", "A PvP kill with your fists", "pvp"),
  def("sledge", "Sledge", "A PvP kill with a sledgehammer", "pvp"),
  def("melee_mix", "Hands On", "PvP kills with 5 different melee weapons", "pvp", 5),
  def("hit_and_run", "Hit and Run", "Hit a player with a motorbike", "pvp"),
  def("roadkill", "Roadkill", "A PvP kill with a motorbike", "pvp"),
  // PvP — the armory: one tile per firearm, generated from the catalogue IN ITS ORDER, so a
  // gun added to firearms.ts gets its tile (and the rules-test diff demands its rule) at once.
  // ⚠️ A key is `gun_<firearm key>` and stable forever once shipped: never rename a firearm key.
  ...FIREARMS.map((f) => def(`gun_${f.key}` as `gun_${typeof f.key}`, f.name, `A PvP kill with the ${f.name}`, "pvp", 1, "count", ARMORY)),
  classTile("class_pistols", "Sidearms", "A PvP kill with every pistol", "pistol"),
  classTile("class_smgs", "Spray and Pray", "A PvP kill with every SMG", "smg"),
  classTile("class_shotguns", "Buckshot", "A PvP kill with every shotgun", "shotgun"),
  classTile("class_assault_rifles", "Rifleman", "A PvP kill with every assault rifle", "assault_rifle"),
  classTile("class_rifles", "Hunter", "A PvP kill with every rifle", "rifle"),
  classTile("class_snipers", "Overwatch", "A PvP kill with every sniper rifle", "sniper"),
  def("full_armory", "Full Armory", "A PvP kill with every firearm on Nasdara", "pvp", FIREARMS.length, "count", ARMORY),
  // Team — the clan's record
  def("colors_raised", "Colors Raised", "Found the clan and get it activated", "team"),
  def("full_strength", "Full Strength", "Have 10 full members at once", "team", 10),
  def("first_raid", "First Raid", "The clan's first scored raid", "team"),
  def("warpath", "Warpath", "Complete 25 raids", "team", 25),
  def("giant_killer", "Giant Killer", "Raid the clan ranked first", "team"),
  def("wide_net", "Wide Net", "Raid 5 different clans", "team", 5),
  def("fortress", "Fortress", "Complete 10 defenses", "team", 10),
  def("podium", "Podium", "Finish a season in the top 3", "team"),
  def("alpha", "Alpha", "Finish a week in the top 3", "team"),
  def("dynasty", "Dynasty", "Alpha 4 weeks running", "team", 4),
  def("untouched", "Untouched", "A whole season without being raided", "team"),
  def("champions", "Champions", "Win a season", "team"),
  // Team — the clan's members together (spec 2026-10-20-achievements-150, Task B8)
  def("clan_armory", "Armory", "Members get PvP kills with 25 different firearms", "team", 25),
  def("clan_renovators", "Renovators", "Make 50 ruin repairs as a clan", "team", 50),
  def("clan_warband", "Warband", "Get 250 PvP kills as a clan", "team", 250),
  // One per gun class, from the catalogue's class list, never a typed 6: a class added there moves it.
  def("clan_arsenal", "Every Class Covered", "Members earn every gun-class tile", "team", FIREARM_CLASSES.length),
] as const;

export type Achievement = (typeof ACHIEVEMENTS)[number];
export type AchievementKey = Achievement["key"];
export const ACHIEVEMENT_BY_KEY = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.key, a])) as Record<AchievementKey, Achievement>;
export const ACHIEVEMENT_KEYS = ACHIEVEMENTS.map((a) => a.key) as readonly AchievementKey[];

/** The six gun-class tiles, which Every Class Covered reads from the members' unlocks. */
export const CLASS_TILE_KEYS = ACHIEVEMENT_KEYS.filter((k): k is Extract<AchievementKey, `class_${string}`> => k.startsWith("class_"));

export const isRetired = (a: Achievement): boolean => "retired" in a && a.retired === true;
export type EarnableAchievement = Exclude<Achievement, { retired: true }>;
export type EarnableKey = EarnableAchievement["key"];
/**
 * What the tick evaluates and the guide lists. ⚠️ Retiring a key means filtering it HERE,
 * never removing it from ACHIEVEMENTS: the glyphs, share PNGs and existing unlocks are keyed
 * on the full list, and a holder's wall would lose the tile.
 */
export const EARNABLE_ACHIEVEMENTS = ACHIEVEMENTS.filter((a): a is EarnableAchievement => !isRetired(a));

/** A tile in the wall's Armory section: the 59 gun, class and Full Armory tiles. */
export const isArmory = (a: Achievement): boolean => "section" in a && a.section === "armory";
export const ARMORY_KEYS = ACHIEVEMENTS.filter(isArmory).map((a) => a.key) as readonly AchievementKey[];

/**
 * The fifty keys the launch shipped (2026-09-12), as they were then. A literal on
 * purpose: it is a record of what existed, not something to derive, and the October
 * release is defined against it.
 */
const LAUNCH_KEYS: ReadonlySet<string> = new Set([
  "enlisted", "squad_up", "founder", "loyalist", "long_haul", "veteran", "regular", "wanderer", "explorer", "showman",
  "cartographer", "foundation", "builder", "architect", "ironman", "wolf_bait", "bear_necessities", "brains", "gravity_check", "sunday_driver",
  "lights_out", "should_have_bandaged", "nine_lives", "first_blood", "ten_down", "centurion", "marksman", "sniper", "point_blank", "arsenal",
  "hat_trick", "killing_spree", "unstoppable", "nemesis", "payback", "flag_thief", "home_defender", "blue_on_blue", "colors_raised", "full_strength",
  "first_raid", "warpath", "giant_killer", "wide_net", "fortress", "podium", "alpha", "dynasty", "untouched", "champions",
]);

/**
 * The 103 tiles the October 2026 release added (spec 2026-10-20-achievements-150): every
 * earnable key the launch did not have. The summary DM counts a player's unlocks among
 * these. ⚠️ Derived, not listed, so it cannot miss a tile — but that also means a tile
 * added AFTER this release would join it; freeze it into a literal before the next
 * release adds any (the test pins its length at 103 to catch exactly that).
 */
export const ACHIEVEMENTS_2026_10: readonly AchievementKey[] = EARNABLE_ACHIEVEMENTS.map((a) => a.key).filter((k) => !LAUNCH_KEYS.has(k));
