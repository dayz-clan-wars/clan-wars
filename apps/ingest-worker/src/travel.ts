/**
 * The fast-travel config (`pra-teleport-hub.json`) as a projection: the
 * 209 fixed points from the template, then one box per ACTIVE clan's
 * declared pole, so a clan can relog at its own flag and arrive at the Hub.
 *
 * The file is the mod's own format, kept verbatim: `areaName`, `PRABoxes`
 * (each `[[w, h, d], [pitch, yaw, roll], [x, y, z]]`) and `safePositions3D`
 * (the Hub's arrival spots). Only `PRABoxes` grows.
 */
export type TravelBox = [[number, number, number], [number, number, number], [number, number, number]];
export type TravelTemplate = { areaName: string; PRABoxes: TravelBox[]; safePositions3D: [number, number, number][] };
export type TravelPole = { tag: string; x: number; y: number; z: number };

/**
 * The box around a pole. The template's boxes are 2 × 1.5 × 2, an outhouse's
 * inside; a player stands BESIDE a flagpole, not in it, so the pole's box is
 * wider — anywhere within two metres of it counts.
 */
export const POLE_BOX: [number, number, number] = [4, 3, 4];

export function loadTravelTemplate(json: unknown): TravelTemplate {
  const t = json as Partial<TravelTemplate> | null;
  if (!t || typeof t.areaName !== "string" || !Array.isArray(t.PRABoxes) || !Array.isArray(t.safePositions3D)) {
    throw new Error("travel template: expected areaName, PRABoxes and safePositions3D");
  }
  if (t.PRABoxes.length === 0) throw new Error("travel template: no PRABoxes — refusing to project a map with no travel points");
  return { areaName: t.areaName, PRABoxes: t.PRABoxes, safePositions3D: t.safePositions3D };
}

/**
 * The file's exact bytes: the template's boxes first, in their order, then
 * one box per pole in the order given. The caller sorts the poles by tag,
 * because these bytes are hashed and a wandering order would re-upload
 * forever. Pretty-printed like the hand-made original, so a diff against it
 * reads as an append.
 */
export function generateTravel(template: TravelTemplate, poles: TravelPole[]): string {
  const boxes: TravelBox[] = [
    ...template.PRABoxes,
    ...poles.map((p): TravelBox => [POLE_BOX, [0, 0, 0], [p.x, p.y, p.z]]),
  ];
  return JSON.stringify({ areaName: template.areaName, PRABoxes: boxes, safePositions3D: template.safePositions3D }, null, 2) + "\n";
}
