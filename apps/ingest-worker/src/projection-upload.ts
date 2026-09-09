import { createHash } from "node:crypto";
import type { Database } from "@factions/db";
import { supplyUploads, travelUploads } from "@factions/db";
import { eq } from "drizzle-orm";

/** What the game server reports about a file it holds. */
export type RemoteFileStat = { size: number; modifiedAtMs: number };

export type ProjectionUploader = {
  uploadFile(remoteDir: string, fileName: string, content: string): Promise<void>;
  /** Null when the file is not there at all. */
  statFile(remoteDir: string, fileName: string): Promise<RemoteFileStat | null>;
};

export type ProjectionDrift = {
  serverId: number;
  /** Absent when the file is gone from the server entirely. */
  found: RemoteFileStat | null;
  expected: RemoteFileStat;
};

type UploadRow = { contentHash: string; remoteSize: number | null; remoteModifiedAt: Date | null };

/**
 * Where one projected file remembers what it last sent: `supply_uploads`
 * for the kit, `travel_uploads` for the fast-travel config. Same columns,
 * one table each, so the two files' hashes and baselines cannot cross.
 */
export type UploadStore = {
  read(db: Database, serverId: number): Promise<UploadRow | undefined>;
  write(db: Database, serverId: number, row: { contentHash: string; uploadedAt: Date; remoteSize: number | null; remoteModifiedAt: Date | null }): Promise<void>;
  observe(db: Database, serverId: number, found: RemoteFileStat): Promise<void>;
};

const storeFor = (table: typeof supplyUploads | typeof travelUploads): UploadStore => ({
  async read(db, serverId) {
    const [row] = await db.select().from(table).where(eq(table.serverId, serverId));
    return row;
  },
  async write(db, serverId, row) {
    await db.insert(table).values({ serverId, ...row }).onConflictDoUpdate({ target: table.serverId, set: row });
  },
  async observe(db, serverId, found) {
    await db.update(table).set({ remoteSize: found.size, remoteModifiedAt: new Date(found.modifiedAtMs) }).where(eq(table.serverId, serverId));
  },
});
export const SUPPLY_STORE: UploadStore = storeFor(supplyUploads);
export const TRAVEL_STORE: UploadStore = storeFor(travelUploads);

/**
 * Put one projected file on the game server, if it is not already there.
 *
 * ⚠️ A PROJECTION, not a side effect of anything. The caller regenerates the
 * whole file every pass; this hashes it and uploads only when the hash
 * differs from the last successful upload. That is what makes a failed
 * upload self-healing (the hash does not advance, so the next tick retries)
 * and what makes disband, lapse and a flag going down need no code of their
 * own — those rows simply stop being in the file.
 *
 * Returns whether an upload happened.
 */
export async function syncProjection(db: Database, deps: {
  serverId: number;
  client: ProjectionUploader;
  remoteDir: string;
  fileName: string;
  content: string;
  now: Date;
  store: UploadStore;
  /** Called when the file on the server is not the one we last uploaded. */
  onDrift?: (drift: ProjectionDrift) => void;
}): Promise<boolean> {
  const hash = createHash("sha256").update(deps.content).digest("hex");
  const existing = await deps.store.read(db, deps.serverId);

  if (existing?.contentHash === hash) {
    // ⚠️ The hash records what we last SENT, not what the server holds. Every
    // path that changes the file behind us — a mission wipe, an FTP restore,
    // an operator edit, a Nitrado rollback — leaves the hash matching, so
    // without this check the tick short-circuits and the file stays wrong
    // until something unrelated shifts the data.
    //
    // A throw propagates: the sweep's per-server catch reports it, and since
    // this path was not going to upload anyway, nothing is lost by being loud
    // about being unable to verify. Being unable to check is not evidence the
    // file is intact.
    const found = await deps.client.statFile(deps.remoteDir, deps.fileName);
    const expected = baselineOf(existing);

    // ⚠️ No baseline yet — every row is in this state the moment a projection
    // ships, and a row lands here again whenever the stat after an upload
    // failed. ADOPT what the server reports rather than returning early:
    // a baseline written only after an upload leaves detection switched off
    // until the data happens to change, which on a stable server is never.
    // Uploading instead would be exact, but then a Nitrado listing outage
    // (statFile throwing, baseline staying null) would re-upload every tick.
    if (!expected) {
      // ⚠️ The observed state only — `uploaded_at` is NOT restamped, because
      // nothing was uploaded. That column answers "when did we last send this
      // file", and an operator reads it to reason about the server.
      if (found) await deps.store.observe(db, deps.serverId, found);
      return false;
    }

    if (found && found.size === expected.size && found.modifiedAtMs === expected.modifiedAtMs) return false;
    deps.onDrift?.({ serverId: deps.serverId, found, expected });
  }

  // The hash is written ONLY after the upload resolves. A throw here leaves
  // the stored hash untouched, so the next tick tries again.
  await deps.client.uploadFile(deps.remoteDir, deps.fileName, deps.content);

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

  // The hash and the observed remote state are written together, always.
  await deps.store.write(db, deps.serverId, {
    contentHash: hash,
    uploadedAt: deps.now,
    remoteSize: observed?.size ?? null,
    remoteModifiedAt: observed ? new Date(observed.modifiedAtMs) : null,
  });
  return true;
}

/**
 * The observed baseline, or null when it was never captured. Both columns are
 * written together, so either being null means there is nothing to compare.
 */
function baselineOf(row: { remoteSize: number | null; remoteModifiedAt: Date | null }): RemoteFileStat | null {
  if (row.remoteSize === null || row.remoteModifiedAt === null) return null;
  return { size: row.remoteSize, modifiedAtMs: row.remoteModifiedAt.getTime() };
}
