import { gridRef } from "./map-projection";

/**
 * Every marker's accessible name. Leaflet copies a marker's `title` onto its
 * icon, and a `keyboard: true` marker is a focusable `role="button"` whose only
 * name is that title. Every marker's SVG is `aria-hidden`, so without these a
 * screen reader tabbing the map hears "button" and nothing more, and a
 * clanmate's age lives only in a popup it has no way to find.
 *
 * ⚠️ The map's one rule applies here as everywhere (map-draw.ts): names, ages,
 * distances and GRID REFS only, never a metre coordinate. A title is text a
 * player can copy straight out of the accessibility tree.
 *
 * Titles are DOM properties, never parsed as HTML, so gamertags go in raw:
 * escaping them would have a screen reader say "ampersand amp".
 */
export const markerTitle = {
  you: (age: string): string => `You, last seen ${age}`,
  base: (x: number, z: number, radiusM: number): string => `Your base, grid ${gridRef(x, z)}, ${radiusM} m watch zone`,
  clanmate: (gamertag: string, age: string): string => `${gamertag}, clanmate, ${age}`,
  intruder: (gamertag: string, distanceM: number, age: string): string => `${gamertag}, intruder, ${Math.round(distanceM)} m from your base, ${age}`,
  bounty: (gamertag: string, age: string): string => `${gamertag}, wanted, ${age}`,
  pin: (label: string, x: number, z: number, age: string): string => `${label} pin, grid ${gridRef(x, z)}, ${age}`,
  publicBase: (x: number, z: number): string => `Public base, grid ${gridRef(x, z)}`,
} as const;
