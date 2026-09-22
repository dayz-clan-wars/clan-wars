import type { BoosterKitView } from "@factions/roster";
import type { KitSlot } from "@factions/domain";
import { gridRef, gridRefKey } from "./map-projection";
import { nearestPlace } from "./map-places";

/** Livonia, metres. The same constants /base uses to speak in grid squares. */
const WORLD = { map: "enoch", size: 12800 } as const;

export type KitSpotView = { grid: string; near: string | null; href: string };
export type KitStepView = { token: string; label: string; confirmed: boolean };
export type KitChallengeView = { id: number; steps: KitStepView[]; confirmed: number; expiresAt: string };

/**
 * Everything the kit page renders, already in the shape it renders it.
 *
 * ⚠️ Built on the server, for the first paint AND for every poll, because two
 * of its fields cannot be built anywhere else. `nearestPlace` walks
 * lib/map-places.json and `gridRef` is the same projection /base and /map
 * speak in; shipping either to the client would put a second copy of the
 * world's geometry in the bundle of a page that needs one town name.
 *
 * ⚠️ Carries the grid ref and the map link, never the raw x/y/z. The page has
 * no use for metres, and a coordinate in a JSON body is a coordinate in the
 * browser's network log.
 *
 * ⚠️ Every Date is already a string here. The page is a client component fed
 * by `fetch`, so a `Date` would survive the first render and become a string
 * on the first poll, and the countdown would start throwing an hour in.
 */
export type KitView = {
  boosting: boolean;
  /** The linked character's name, or null when the account has no link yet. */
  gamertag: string | null;
  slots: Record<KitSlot, string | null>;
  spot: KitSpotView | null;
  challenge: KitChallengeView | null;
};

/** A marked spot as the page shows it: grid ref, nearest town, map link. Never metres. */
export function kitSpotView(spot: { x: number; z: number }): KitSpotView {
  const near = nearestPlace(WORLD.map, spot.x, spot.z, WORLD.size);
  return { grid: gridRef(spot.x, spot.z), near: near?.name ?? null, href: `/map?at=${gridRefKey(spot.x, spot.z)}` };
}

export function kitView(view: BoosterKitView): KitView {
  return {
    boosting: view.boosting,
    gamertag: view.linked?.gamertag ?? null,
    slots: view.slots,
    spot: view.spot ? kitSpotView(view.spot) : null,
    challenge: view.challenge
      ? {
          id: view.challenge.id,
          steps: view.challenge.steps,
          confirmed: view.challenge.confirmed,
          expiresAt: view.challenge.expiresAt.toISOString(),
        }
      : null,
  };
}
