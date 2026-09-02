import { createHash } from "node:crypto";
import type { Database } from "@factions/db";
import { factions, supplyUploads } from "@factions/db";
import { SUPPLIED_STATUSES } from "@factions/domain";
import { and, eq, inArray, asc } from "drizzle-orm";
import { generateSupplies, type SpawnObject, type SupplyFaction } from "./supplies.js";

/** What the game server reports about a file it holds. */
export type RemoteFileStat = { size: number; modifiedAtMs: number };

export type SupplyUploader = {
  uploadFile(remoteDir: string, fileName: string, content: string): Promise<void>;
  /** Null when the file is not there at all. */
  statFile(remoteDir: string, fileName: string): Promise<RemoteFileStat | null>;
};

export type SupplyDrift = {
  serverId: number;
  /** Absent when the file is gone from the server entirely. */
  found: RemoteFileStat | null;
  expected: RemoteFileStat;
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
  /** Called when the file on the server is not the one we last uploaded. */
  onDrift?: (drift: SupplyDrift) => void;
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

  if (existing?.contentHash === hash) {
    // ⚠️ The hash records what we last SENT, not what the server holds. Every
    // path that changes the file behind us — a mission wipe, an FTP restore,
    // an operator edit, a Nitrado rollback — leaves the hash matching, so
    // without this check the tick short-circuits and the factions' supplies
    // stay gone until something unrelated shifts the roster.
    //
    // A throw propagates: the sweep's per-server catch reports it, and since
    // this path was not going to upload anyway, nothing is lost by being loud
    // about being unable to verify. Being unable to check is not evidence the
    // file is intact.
    const found = await deps.client.statFile(deps.remoteDir, deps.fileName);
    const expected = baselineOf(existing);

    // ⚠️ No baseline yet — every row is in this state the moment this feature
    // ships, and a row lands here again whenever the stat after an upload
    // failed. ADOPT what the server reports rather than returning early:
    // a baseline written only after an upload leaves detection switched off
    // until the roster happens to change, which on a stable server is never.
    // Uploading instead would be exact, but then a Nitrado listing outage
    // (statFile throwing, baseline staying null) would re-upload every tick.
    if (!expected) {
      // ⚠️ The observed state only — `uploaded_at` is NOT restamped, because
      // nothing was uploaded. That column answers "when did we last send this
      // file", and an operator reads it to reason about the server.
      if (found) {
        await db.update(supplyUploads)
          .set({ remoteSize: found.size, remoteModifiedAt: new Date(found.modifiedAtMs) })
          .where(eq(supplyUploads.serverId, deps.serverId));
      }
      return { factions: list.length, uploaded: false };
    }

    if (found && found.size === expected.size && found.modifiedAtMs === expected.modifiedAtMs) {
      return { factions: list.length, uploaded: false };
    }
    deps.onDrift?.({ serverId: deps.serverId, found, expected });
  }

  // The hash is written ONLY after the upload resolves. A throw here leaves
  // the stored hash untouched, so the next tick tries again.
  await deps.client.uploadFile(deps.remoteDir, deps.fileName, content);

  // ⚠️ Best-effort, and deliberately AFTER the upload succeeded. A failure to
  // observe the baseline must not undo the upload or block the hash write —
  // that would re-upload the same bytes every tick. A null baseline simply
  // disables drift detection until the next quiet tick captures one.
  let observed: RemoteFileStat | null = null;
  try {
    observed = await deps.client.statFile(deps.remoteDir, deps.fileName);
  } catch {
    observed = null;
  }

  await recordBaseline(db, deps.serverId, hash, deps.now, observed);

  return { factions: list.length, uploaded: true };
}

/** The hash and the observed remote state are written together, always. */
async function recordBaseline(
  db: Database, serverId: number, hash: string, now: Date, observed: RemoteFileStat | null,
): Promise<void> {
  const row = {
    contentHash: hash,
    uploadedAt: now,
    remoteSize: observed?.size ?? null,
    remoteModifiedAt: observed ? new Date(observed.modifiedAtMs) : null,
  };
  await db.insert(supplyUploads)
    .values({ serverId, ...row })
    .onConflictDoUpdate({ target: supplyUploads.serverId, set: row });
}

/**
 * The observed baseline, or null when it was never captured. Both columns are
 * written together, so either being null means there is nothing to compare.
 */
function baselineOf(row: { remoteSize: number | null; remoteModifiedAt: Date | null }): RemoteFileStat | null {
  if (row.remoteSize === null || row.remoteModifiedAt === null) return null;
  return { size: row.remoteSize, modifiedAtMs: row.remoteModifiedAt.getTime() };
}
