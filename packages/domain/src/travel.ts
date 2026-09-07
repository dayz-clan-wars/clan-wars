import data from "./fast-travel-points.json";

export type TravelPoint = { x: number; z: number };
/** The 209 fast-travel points (guide ch. 11), x/z world metres. The Hub is separate: HUB_POSITION in rules.ts. */
export const FAST_TRAVEL_POINTS: readonly TravelPoint[] = data.points;
export const FAST_TRAVEL_HUB: TravelPoint = data.hub;
