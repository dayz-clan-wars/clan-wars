import { armbandFor } from "@factions/domain";
import type { SpawnObject } from "./supplies.js";

/**
 * One booster's kit, already filtered for eligibility by the tick.
 *
 * `texture` is the clan's flag, or null for a booster in no faction, which is
 * what decides whether an armband is emitted. It is NOT stored on the kit row
 * — it is joined live, so a clan change corrects itself at the next restart.
 *
 * Coordinates are in DATABASE/SPAWNER order: x, altitude, z — the same
 * convention as `declarations.x/y/z` and the spawner JSON's own "pos" slot.
 * All three agree, so nothing is reordered here.
 */
export type BoosterKit = {
  discordId: string;
  gamertag: string;
  texture: string | null;
  x: number; y: number; z: number;
  items: string[];
};

/**
 * The exact bytes of the booster kit spawner file.
 *
 * Returns a string rather than an object because the upload tick hashes what
 * it uploads; hashing a re-serialised object could differ from the bytes sent.
 *
 * Unlike the supplies file there is no template and no offsets: every item of
 * a kit spawns at one identical position, so this builds objects from scratch
 * rather than measuring them from an anchor.
 */
export function generateBoosterKits(kits: BoosterKit[]): string {
  const out: string[] = [];
  for (const k of kits) {
    const names = [...k.items];
    // ⚠️ Derived, never stored. armbandFor maps Flag_X to Armband_X; a
    // booster in no faction (texture null) simply gets no armband.
    if (k.texture) {
      const armband = armbandFor(k.texture);
      if (armband) names.push(armband);
    }
    for (const name of names) {
      const spawn: SpawnObject = {
        name,
        // ⚠️ Already in spawner order — x, altitude, z — see BoosterKit. Do
        // NOT reorder these; a swap silently puts every kit underground or
        // off the map.
        pos: [k.x, k.y, k.z],
        ypr: [0, 0, 0],
        scale: 1,
        // The whole mechanism for "comes back every reboot": the spawner
        // re-places objects at mission start regardless of what happened to
        // the previous ones, and they are not written to the persistence
        // store.
        enableCEPersistency: 0,
        // Ownership, so an operator finding a stray item on the ground can
        // tell whose kit it belongs to.
        customString: k.gamertag,
      };
      out.push(
        `{"name":${JSON.stringify(spawn.name)},` +
        `"pos":[${spawn.pos[0]},${spawn.pos[1]},${spawn.pos[2]}],` +
        `"ypr":[${spawn.ypr[0]},${spawn.ypr[1]},${spawn.ypr[2]}],` +
        `"scale":${spawn.scale},` +
        `"enableCEPersistency":${spawn.enableCEPersistency},` +
        `"customString":${JSON.stringify(spawn.customString)}}`,
      );
    }
  }
  return `{"Objects":[${out.join(",")}]}`;
}
