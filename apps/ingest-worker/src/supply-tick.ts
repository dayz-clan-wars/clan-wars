import type { Database } from "@factions/db";
import { declarations, factions } from "@factions/db";
import { and, eq, inArray, isNull, asc } from "drizzle-orm";
import { generateSupplies, type SpawnObject, type SupplyFaction } from "./supplies.js";
import { syncProjection, SUPPLY_STORE, type ProjectionUploader, type ProjectionDrift, type RemoteFileStat } from "./projection-upload.js";

/** The names the sweep and the tests were written against; the machinery is projection-upload.ts's now. */
export type { RemoteFileStat };
export type SupplyUploader = ProjectionUploader;
export type SupplyDrift = ProjectionDrift;

export type SupplyTickResult = { factions: number; uploaded: boolean };

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
    x: declarations.x, y: declarations.y, z: declarations.z,
  }).from(factions)
    // ⚠️ INNER on purpose. The kit spawns at the clan's declared pole, so a
    // supplied clan with no declaration — after a wipe, or between release and
    // re-claim — has nowhere for its kit to land. It drops out of the file
    // rather than having a place invented for it; a LEFT join would put every
    // such clan's crate at (0, 0, 0).
    .innerJoin(declarations, eq(declarations.ownerFactionId, factions.id))
    .where(and(
      eq(factions.serverId, deps.serverId),
      // ⚠️ SUPPLIED, not HOLDING: the predicate is "status in ('reserved',
      // 'active') and flag_down_since is null" (@factions/domain's
      // SUPPLIED_PREDICATE). A dormant faction still holds its flag, tag and
      // pole — that is what HOLDING means — but it does not get a kit. A
      // raided faction stays 'active' for its 24 h clock and drops out the
      // moment its flag goes down. This is the whole supply half of both
      // mechanisms.
      //
      // ⚠️ `reserved` must stay in. The kit is the only place a clan's own
      // flag comes from (generateSupplies swaps the template's white flag for
      // the clan's texture), and raising that flag is the activation. Narrow
      // this to `active` and every new clan sits reserved with nothing to
      // raise until it lapses — silently, since an empty file uploads fine.
      inArray(factions.status, ["reserved", "active"]),
      isNull(factions.flagDownSince),
    ))
    // Stable order, or the bytes differ between ticks and we upload forever.
    // Total without a tie-break only because factions_holding_tag_uniq is
    // UNIQUE(serverId, lower(tag)) over the holding statuses, and SUPPLIED
    // (active with no flag down) is a subset of HOLDING, so that index still
    // makes tag total here. If that index loosens, add a second key or the
    // hash flaps.
    .orderBy(asc(factions.tag));

  // ⚠️ numeric columns arrive as STRINGS from Drizzle. Without Number() the
  // additions in generateSupplies concatenate and every coordinate is junk.
  const list: SupplyFaction[] = rows.map((r) => ({
    tag: r.tag, texture: r.texture,
    x: Number(r.x), y: Number(r.y), z: Number(r.z),
  }));

  const content = generateSupplies(deps.offsets, list);
  const uploaded = await syncProjection(db, {
    serverId: deps.serverId, client: deps.client, remoteDir: deps.remoteDir, fileName: deps.fileName,
    content, now: deps.now, store: SUPPLY_STORE, onDrift: deps.onDrift,
  });
  return { factions: list.length, uploaded };
}
