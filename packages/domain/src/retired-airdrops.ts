/**
 * Display names for every location a past airdrop or bunker row can carry, so
 * those rows keep printing a place after bunker.ts (the rooms' coordinates and
 * placement) is deleted. Names only: nothing here can be drawn again.
 *
 * ⚠️ The room names mirror assets/bunker-rooms.json and the slugs mirror the
 * retired Livonia list in bunker.ts. Both are literals on purpose, so this module
 * outlives those files, and nothing compares them afterwards: a room renamed in
 * the JSON must be renamed here by hand.
 */
const ROOM_NAMES: Readonly<Record<string, string>> = {
  "balota-airfield": "Balota Airfield",
  "vmc": "VMC",
  "krasnostav-airfield": "Krasnostav Airfield",
  "pavlovo-military": "Pavlovo Military",
  "tisy-military": "Tisy Military",
  "zelenogorsk": "Zelenogorsk",
  "nwaf": "NWAF",
  "kamensk-military": "Kamensk Military",
  "green-mountain": "Green Mountain",
  "bashnya": "Bashnya",
  "prison-island": "Prison Island",
};

/** The 16 Livonia airdrop locations, retired 2026-10-07. */
const RETIRED_LIVONIA_SLUGS: readonly string[] = [
  "airfield", "bielawa", "brena", "dolnik", "gieraltow", "gliniska", "grabin", "lukow",
  "nadbor", "polana", "sarnowek", "sitnik", "sobotka", "tarnow", "topolin", "zalesie",
];

/** A display name for any event's location, past or present; the slug itself if unknown. */
export function bunkerRoomName(slug: string): string {
  const named = ROOM_NAMES[slug];
  if (named !== undefined) return named;
  if (RETIRED_LIVONIA_SLUGS.includes(slug)) return slug.charAt(0).toUpperCase() + slug.slice(1);
  return slug;
}
