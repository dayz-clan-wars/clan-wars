import type { Database } from "@factions/db";
import { playerDevices } from "@factions/db";
import { parseDevices } from "@factions/adm-parser";
import { DEVICE_LOOKUP_LOOKBACK_MS } from "@factions/domain";
import { sql } from "drizzle-orm";

/** Only what this tick calls. A full NitradoClient satisfies it. */
export type DeviceClient = {
  newestRptPath(): Promise<string | null>;
  downloadFile(path: string): Promise<string>;
};

export type DeviceTickResult = { fetched: boolean; upserted: number };

/**
 * Learns which platform an account plays on, ON DEMAND.
 *
 * ⚠️ The device only exists in the .RPT files, which are 20x the size of the
 * .ADM files this worker ingests (2.3 MB against ~100 KB) and are rewritten
 * continuously. Downloading them on the ADM schedule would pull about a
 * gigabyte a day from Nitrado to discover, on a busy day, one player's
 * platform. A device is a stable fact about an account, so it is learned once:
 * this tick fetches ONLY when some account that connected recently has no
 * `player_devices` row at all, and then records every sighting in the file it
 * already has in hand.
 *
 * ⚠️ Fails closed, always. No RPT, an unresolvable dpnid, an unknown device
 * string — every one of them records nothing. Downstream, "no row" means "not
 * PC", so a failure here can never produce a ban.
 */
export async function deviceTick(db: Database, opts: { serverId: number; client: DeviceClient; now?: Date }): Promise<DeviceTickResult> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - DEVICE_LOOKUP_LOOKBACK_MS);

  // Does ANY recently-connected account still have an unknown device? One row
  // is enough to justify the fetch, and the fetch answers it for everyone.
  //
  // ⚠️ The cutoff is interpolated as an ISO string cast to timestamptz:
  // binding a raw JS Date inside a drizzle sql`` template THROWS under
  // postgres.js. The throw lands in `ingestSweep`'s per-concern try/catch, so
  // device learning would simply stop — no row is ever written, every account
  // reads as "not PC", and no ban is ever written again, with nothing failing
  // loudly to say so.
  const unknown = await db.execute(sql`
    select 1
    from events e
    where e.server_id = ${opts.serverId}
      and e.type = 'player.connected'
      and e.occurred_at > ${cutoff.toISOString()}::timestamptz
      and not exists (
        select 1 from player_devices d where d.dayz_id = e.payload->>'dayzId'
      )
    limit 1`);
  if (unknown.length === 0) return { fetched: false, upserted: 0 };

  const path = await opts.client.newestRptPath();
  if (!path) return { fetched: false, upserted: 0 };

  const sightings = parseDevices(await opts.client.downloadFile(path));
  if (sightings.length === 0) return { fetched: true, upserted: 0 };

  await db.insert(playerDevices)
    .values(sightings.map((s) => ({ dayzId: s.dayzId, device: s.device, gamertag: s.gamertag, firstSeenAt: now, lastSeenAt: now })))
    // ⚠️ first_seen_at is deliberately NOT in the update set: it is the one
    // fact here that must not move, and it is what tells an operator how long
    // an account has been playing on PC.
    .onConflictDoUpdate({
      target: [playerDevices.dayzId, playerDevices.device],
      set: { gamertag: sql`excluded.gamertag`, lastSeenAt: now },
    });

  return { fetched: true, upserted: sightings.length };
}
