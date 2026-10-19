import data from "./fast-travel-points.json";

export type TravelPoint = { x: number; z: number };
/** Nasdara's 519 fast-travel sheds (the guide's Getting around), x/z world metres. The Hub is separate: HUB_POSITION in rules.ts. */
export const FAST_TRAVEL_POINTS: readonly TravelPoint[] = data.points;
export const FAST_TRAVEL_HUB: TravelPoint = data.hub;
