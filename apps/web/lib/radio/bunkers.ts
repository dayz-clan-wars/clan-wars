/**
 * The grid squares (lib/map-projection.ts `gridRefKey`) holding Nasdara's 23
 * bunkers. A decoded grid off this list is a misread, however the vote went.
 *
 * ⚠️ A literal, not a fetch of world.json: /map-data/ is behind sign-in
 * (lib/auth/gate.ts) and /radio is not, so a signed-out player's fetch would
 * land on /login and every card would stay unsettled. Bunkers are fixed map
 * features, not anyone's base, so their squares are fine to publish; the rest
 * of the world file is not. test/radio-bunkers-drift.test.ts holds this list
 * to world.json.
 */
export const BUNKER_GRID_KEYS: readonly string[] = [
  "028100", "038066", "045054", "057074", "065090", "067058", "067124", "072106",
  "073090", "076076", "085115", "087088", "088112", "091044", "096109", "100121",
  "104083", "105102", "107123", "109086", "112067", "114053", "133021",
];

const KEYS = new Set(BUNKER_GRID_KEYS);

export function isBunkerGrid(key: string): boolean {
  return KEYS.has(key);
}
