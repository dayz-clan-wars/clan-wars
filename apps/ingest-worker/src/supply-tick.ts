import { createHash } from "node:crypto";
import type { Database } from "@factions/db";
import { factions, supplyUploads } from "@factions/db";
import { SUPPLIED_STATUSES } from "@factions/domain";
import { and, eq, inArray, asc } from "drizzle-orm";
import { generateSupplies, type SpawnObject, type SupplyFaction } from "./supplies.js";

export type SupplyUploader = {
  uploadFile(remoteDir: string, fileName: string, content: string): Promise<void>;
};

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
}): Promise<SupplyTickResult> {
  const rows = await db.select({
    tag: factions.tag, texture: factions.texture,
    x: factions.x, y: factions.y, z: factions.z,
  }).from(factions)
    .where(and(
      eq(factions.serverId, deps.serverId),
      // ⚠️ SUPPLIED, not HOLDING. A dormant faction still holds its flag, tag
      // and pole — that is what HOLDING means — but it does not get a kit.
      // This one line is the whole supply half of faction dormancy.
      inArray(factions.status, [...SUPPLIED_STATUSES]),
    ))
    // Stable order, or the bytes differ between ticks and we upload forever.
    // Total without a tie-break only because factions_holding_tag_uniq is
    // UNIQUE(serverId, lower(tag)) over exactly these statuses. SUPPLIED is a
    // subset of HOLDING, so that index still makes tag total here. If that
    // index loosens, add a second key or the hash flaps.
    .orderBy(asc(factions.tag));

  // ⚠️ numeric columns arrive as STRINGS from Drizzle. Without Number() the
  // additions in generateSupplies concatenate and every coordinate is junk.
  const list: SupplyFaction[] = rows.map((r) => ({
    tag: r.tag, texture: r.texture,
    x: Number(r.x), y: Number(r.y), z: Number(r.z),
  }));

  const content = generateSupplies(deps.offsets, list);
  const hash = createHash("sha256").update(content).digest("hex");

  const [existing] = await db.select().from(supplyUploads)
    .where(eq(supplyUploads.serverId, deps.serverId));
  if (existing?.contentHash === hash) return { factions: list.length, uploaded: false };

  // The hash is written ONLY after the upload resolves. A throw here leaves
  // the stored hash untouched, so the next tick tries again.
  await deps.client.uploadFile(deps.remoteDir, deps.fileName, content);

  await db.insert(supplyUploads)
    .values({ serverId: deps.serverId, contentHash: hash, uploadedAt: deps.now })
    .onConflictDoUpdate({
      target: supplyUploads.serverId,
      set: { contentHash: hash, uploadedAt: deps.now },
    });

  return { factions: list.length, uploaded: true };
}
