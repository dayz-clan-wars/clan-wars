/**
 * The fifty achievements — data, not code. The badge wall, the Discord line,
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
export type AchievementOwner = "player" | "clan";
export type AchievementUnit = "count" | "hours" | "days" | "m";

const def = <K extends string>(key: K, name: string, description: string, group: AchievementGroup, target = 1, unit: AchievementUnit = "count") =>
  ({ key, name, description, group, owner: group === "team" ? "clan" : "player", target, unit }) as const;

export const ACHIEVEMENTS = [
  // Solo — presence and progression
  def("enlisted", "Enlisted", "Link your account", "solo"),
  def("squad_up", "Squad Up", "Become a full member of a clan", "solo"),
  def("founder", "Founder", "Take part in a founding ceremony", "solo"),
  def("loyalist", "Loyalist", "Stay a full member of one clan for 30 days", "solo", 30, "days"),
  def("long_haul", "Long Haul", "Play for 24 hours", "solo", 24, "hours"),
  def("veteran", "Veteran", "Play for 100 hours", "solo", 100, "hours"),
  def("regular", "Regular", "Play on 7 consecutive days", "solo", 7, "days"),
  def("wanderer", "Wanderer", "Fast travel 10 times", "solo", 10),
  def("explorer", "Explorer", "Seen in 50 different 1 km grid squares", "solo", 50),
  def("showman", "Showman", "Perform 50 emotes", "solo", 50),
  def("cartographer", "Cartographer", "Drop 10 map pins", "solo", 10),
  // PvE — the map, the builds, and the ways it kills you
  def("foundation", "Foundation", "Build your first base part", "pve"),
  def("builder", "Builder", "Earn 100 build points", "pve", 100),
  def("architect", "Architect", "Earn 500 build points", "pve", 500),
  def("ironman", "Ironman", "Play for 5 hours without dying", "pve", 5, "hours"),
  def("wolf_bait", "Wolf Bait", "Get killed by a wolf", "pve"),
  def("bear_necessities", "Bear Necessities", "Get killed by a bear", "pve"),
  def("brains", "Brains", "Get killed by infected", "pve"),
  def("gravity_check", "Gravity Check", "Die to a fall", "pve"),
  def("sunday_driver", "Sunday Driver", "Get killed by a vehicle", "pve"),
  def("lights_out", "Lights Out", "Get knocked unconscious 10 times", "pve", 10),
  def("should_have_bandaged", "Should Have Bandaged", "Bleed out", "pve"),
  def("nine_lives", "Nine Lives", "Die 9 times, any cause", "pve", 9),
  // PvP — kills, streaks, and flags taken by hand
  def("first_blood", "First Blood", "Your first PvP kill", "pvp"),
  def("ten_down", "Ten Down", "Get 10 PvP kills", "pvp", 10),
  def("centurion", "Centurion", "Get 100 PvP kills", "pvp", 100),
  def("marksman", "Marksman", "A kill from 150 m or more", "pvp", 150, "m"),
  def("sniper", "Sniper", "A kill from 300 m or more", "pvp", 300, "m"),
  def("point_blank", "Point Blank", "A kill from under 5 m", "pvp", 5, "m"),
  def("arsenal", "Arsenal", "Kills with 10 different weapons", "pvp", 10),
  def("hat_trick", "Hat Trick", "Get 3 PvP kills in one session", "pvp", 3),
  def("killing_spree", "Killing Spree", "Get 5 PvP kills without a PvP death", "pvp", 5),
  def("unstoppable", "Unstoppable", "Get 10 PvP kills without a PvP death", "pvp", 10),
  def("nemesis", "Nemesis", "Kill the same player 5 times", "pvp", 5),
  def("payback", "Payback", "Kill someone within an hour of them killing you", "pvp"),
  def("flag_thief", "Flag Thief", "Lower an enemy flag yourself in a scored raid", "pvp"),
  def("home_defender", "Home Defender", "Make the raise that ends a siege", "pvp"),
  def("blue_on_blue", "Blue on Blue", "Kill a clanmate", "pvp"),
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
] as const;

export type Achievement = (typeof ACHIEVEMENTS)[number];
export type AchievementKey = Achievement["key"];
export const ACHIEVEMENT_BY_KEY = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.key, a])) as Record<AchievementKey, Achievement>;
export const ACHIEVEMENT_KEYS = ACHIEVEMENTS.map((a) => a.key) as readonly AchievementKey[];
