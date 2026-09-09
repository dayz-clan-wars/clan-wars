import type { Database } from "@factions/db";
import { declarations, factions } from "@factions/db";
import { and, eq, isNull, asc } from "drizzle-orm";
import { generateTravel, type TravelTemplate, type TravelPole } from "./travel.js";
import { syncProjection, TRAVEL_STORE, type ProjectionUploader, type ProjectionDrift } from "./projection-upload.js";

export type TravelTickResult = { poles: number; uploaded: boolean };

/**
 * Mirror this server's active clans' poles into the fast-travel config.
 *
 * A projection like the supply kit (supply-tick.ts): regenerated in full
 * each pass, uploaded on difference. A clan's pole is a travel point while
 * the clan is ACTIVE with its flag up — not reserved (nothing raised yet),
 * not dormant, and not while a raider has its flag down. The moment any of
 * those change, the pole simply stops being in the file; nothing is
 * removed by hand. The game reads the file at restart.
 */
export async function travelTick(db: Database, deps: {
  serverId: number;
  client: ProjectionUploader;
  template: TravelTemplate;
  remoteDir: string;
  fileName: string;
  now: Date;
  onDrift?: (drift: ProjectionDrift) => void;
}): Promise<TravelTickResult> {
  const rows = await db.select({ tag: factions.tag, x: declarations.x, y: declarations.y, z: declarations.z })
    .from(factions)
    // INNER: a travel point needs a pole; a clan with no declaration has none.
    .innerJoin(declarations, eq(declarations.ownerFactionId, factions.id))
    .where(and(
      eq(factions.serverId, deps.serverId),
      // ⚠️ ACTIVE and flying. `reserved` has no flag raised yet, `dormant`
      // is a base nobody visits, and an active clan whose flag is down has
      // been raided — none of those earn a door to the Hub.
      eq(factions.status, "active"),
      isNull(factions.flagDownSince),
    ))
    // Stable order, or the bytes differ between ticks and we upload forever.
    .orderBy(asc(factions.tag));

  // ⚠️ numeric columns arrive as STRINGS from Drizzle.
  const poles: TravelPole[] = rows.map((r) => ({ tag: r.tag, x: Number(r.x), y: Number(r.y), z: Number(r.z) }));
  const content = generateTravel(deps.template, poles);
  const uploaded = await syncProjection(db, {
    serverId: deps.serverId, client: deps.client, remoteDir: deps.remoteDir, fileName: deps.fileName,
    content, now: deps.now, store: TRAVEL_STORE, onDrift: deps.onDrift,
  });
  return { poles: poles.length, uploaded };
}
