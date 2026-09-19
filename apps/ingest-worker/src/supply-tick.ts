import type { Database } from "@factions/db";
import { declarations, factions } from "@factions/db";
import { HOLDING_STATUSES, isSupplied } from "@factions/domain";
import { and, eq, inArray, asc } from "drizzle-orm";
import { generateSupplies, type SpawnObject, type SupplyFaction } from "./supplies.js";
import { syncProjection, SUPPLY_STORE, type ProjectionUploader, type ProjectionDrift, type RemoteFileStat } from "./projection-upload.js";

/** The names the sweep and the tests were written against; the machinery is projection-upload.ts's now. */
export type { RemoteFileStat };
export type SupplyUploader = ProjectionUploader;
export type SupplyDrift = ProjectionDrift;

/** `factions` is the clans getting a whole kit; `flagsOnly` the ones getting just flags. */
export type SupplyTickResult = { factions: number; flagsOnly: number; uploaded: boolean };

/**
 * Mirror this server's holding factions into the spawner file.
 *
 * ⚠️ A PROJECTION, not a side effect of claiming. The file is regenerated in
 * full every pass and uploaded only when it differs from the last successful
 * upload. That is what makes a failed upload self-healing (the hash does not
 * advance, so the next tick retries) and what makes disband and lapse need no
 * code of their own — those rows simply stop being holding.
 */
export async function supplyTick(db: Database, deps: {
  serverId: number;
  client: SupplyUploader;
  offsets: SpawnObject[];
  remoteDir: string;
  fileName: string;
  now: Date;
  /** Called when the file on the server is not the one we last uploaded. */
  onDrift?: (drift: SupplyDrift) => void;
}): Promise<SupplyTickResult> {
  const rows = await db.select({
    tag: factions.tag, texture: factions.texture,
    status: factions.status, flagDownSince: factions.flagDownSince,
    x: declarations.x, y: declarations.y, z: declarations.z,
  }).from(factions)
    // ⚠️ INNER on purpose, and it governs the flags as much as the kit: both
    // spawn AT the clan's declared pole, so a clan with no declaration —
    // after a wipe, or between release and re-claim — has nowhere to put
    // either. It drops out of the file rather than having a place invented
    // for it; a LEFT join would put every such clan's crate, or its two
    // flags, at (0, 0, 0).
    .innerJoin(declarations, eq(declarations.ownerFactionId, factions.id))
    .where(and(
      eq(factions.serverId, deps.serverId),
      // ⚠️ HOLDING, not SUPPLIED. Every clan that holds a flag, tag and pole
      // is in the file; `isSupplied` below decides whether it gets the whole
      // kit or only its flags. Cutting an unsupplied clan out entirely is
      // what this query used to do, and it was a dead end — see
      // `isSupplied`'s note in @factions/domain and SupplyFaction's in
      // supplies.ts.
      //
      // ⚠️ `reserved` must stay in HOLDING for this. The kit is the only
      // place a clan's own flag comes from (generateSupplies swaps the
      // template's white flag for the clan's texture), and raising that flag
      // is the activation. A new clan with nothing to raise sits reserved
      // until it lapses — silently, since an empty file uploads fine.
      inArray(factions.status, [...HOLDING_STATUSES]),
    ))
    // Stable order, or the bytes differ between ticks and we upload forever.
    // Total without a tie-break because factions_holding_tag_uniq is
    // UNIQUE(serverId, lower(tag)) over exactly these statuses. If that index
    // loosens, add a second key or the hash flaps.
    .orderBy(asc(factions.tag));

  // ⚠️ numeric columns arrive as STRINGS from Drizzle. Without Number() the
  // additions in generateSupplies concatenate and every coordinate is junk.
  const list: SupplyFaction[] = rows.map((r) => ({
    tag: r.tag, texture: r.texture,
    x: Number(r.x), y: Number(r.y), z: Number(r.z),
    supplied: isSupplied(r.status, r.flagDownSince),
  }));

  const content = generateSupplies(deps.offsets, list);
  const uploaded = await syncProjection(db, {
    serverId: deps.serverId, client: deps.client, remoteDir: deps.remoteDir, fileName: deps.fileName,
    content, now: deps.now, store: SUPPLY_STORE, onDrift: deps.onDrift,
  });
  return {
    factions: list.filter((f) => f.supplied).length,
    flagsOnly: list.filter((f) => !f.supplied).length,
    uploaded,
  };
}
