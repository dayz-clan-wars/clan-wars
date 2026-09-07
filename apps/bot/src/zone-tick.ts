import type { Database } from "@factions/db";
import { identityLinks, intruderSightings } from "@factions/db";
import { readCursor, writeCursor, readEventBatch } from "@factions/event-log";
import { INTRUDER_ALERT_COOLDOWN_MS, type ClanNoticeKind } from "@factions/domain";
import { noticeClanTx, noticeUserTx, type NoticePayload } from "@factions/roster/internal";
import { eq, sql } from "drizzle-orm";
import { readFix } from "./positions-tick.js";
import { isMemberOf, zoneContaining, zonesFor, type Tx, type Zone } from "./zones.js";

/** ⚠️ Distinct from every other consumer name; two consumers sharing a cursor skip each other's events. */
export const ZONE_CONSUMER = "zone-watch";

export type ZoneTickResult = { scanned: number; sightings: number; alerts: number };

const GATE_RE = /gate/iu;

function readGamertag(payload: unknown): string {
  const g = (payload as Record<string, unknown>).gamertag;
  return typeof g === "string" && g !== "" ? g : "someone";
}
function readPart(payload: unknown): string {
  const p = (payload as Record<string, unknown>).part;
  return typeof p === "string" ? p : "a part";
}
function isGate(payload: unknown): boolean {
  const p = payload as Record<string, unknown>;
  return GATE_RE.test(String(p.part ?? "")) || GATE_RE.test(String(p.structure ?? ""));
}

/**
 * Alert the zone's owner: the clan channel for a clan base, a DM for a solo
 * declarant (spec §9.3/§9.4). The solo kind is the clan kind with `solo_`
 * prefixed; the payload is identical and never carries a coordinate (§9.5).
 * A solo owner with no link (unlinked since declaring) gets nothing.
 */
async function alertOwner(tx: Tx, zone: Zone, serverId: number, kind: "intruder" | "dismantle" | "gate_built", occurredAt: Date, payload: NoticePayload): Promise<boolean> {
  if (zone.ownerFactionId !== null) {
    await noticeClanTx(tx, { serverId, factionId: zone.ownerFactionId, kind, occurredAt, payload });
    return true;
  }
  const [link] = await tx.select({ discordId: identityLinks.discordId }).from(identityLinks).where(eq(identityLinks.dayzId, zone.ownerDayzId!));
  if (!link) return false;
  await noticeUserTx(tx, { serverId, factionId: null, discordId: link.discordId, kind: `solo_${kind === "gate_built" ? "gate" : kind}` as ClanNoticeKind, occurredAt, payload });
  return true;
}

/**
 * The zone consumer (spec §7 "intruder" + "base alerts", §5.6 by omission —
 * guests are non-members). Per pos-bearing event: the zone containing the
 * fix → a non-member → one transaction: upsert the sighting (moving the
 * pin), alert on first sighting or after INTRUDER_ALERT_COOLDOWN_MS, and
 * commit the cursor with it. `base.built` (a gate) and `base.dismantled`
 * alert without a sighting. Lock order §4.12: no `factions` lock is taken —
 * the writes are `intruder_sightings` then `clan_notices`.
 */
export async function zoneTick(db: Database, opts: { batchSize?: number } = {}): Promise<ZoneTickResult> {
  const batchSize = opts.batchSize ?? 500;
  const out: ZoneTickResult = { scanned: 0, sightings: 0, alerts: 0 };
  let cursor = await readCursor(db, ZONE_CONSUMER);
  for (;;) {
    const batch = await readEventBatch(db, cursor, batchSize);
    if (batch.length === 0) break;
    const zonesByServer = new Map<number, Zone[]>();
    for (const ev of batch) {
      cursor = ev.id;
      const fix = readFix(ev.payload);
      if (!fix) continue;
      const isPosition = ev.type === "player.position";
      const isBuild = ev.type === "base.built" || ev.type === "base.dismantled";
      if (!isPosition && !isBuild) continue;
      out.scanned++;
      let zones = zonesByServer.get(ev.serverId);
      if (!zones) { zones = await zonesFor(db, ev.serverId); zonesByServer.set(ev.serverId, zones); }
      const hit = zoneContaining(zones, fix);
      if (!hit || isMemberOf(hit.zone, fix.dayzId)) continue;
      const gamertag = readGamertag(ev.payload);
      await db.transaction(async (tx) => {
        const done = async () => { await writeCursor(tx, ZONE_CONSUMER, ev.id); };
        if (isBuild) {
          if (ev.type === "base.dismantled") {
            if (await alertOwner(tx, hit.zone, ev.serverId, "dismantle", ev.occurredAt, { gamertag, part: readPart(ev.payload) })) out.alerts++;
          } else if (isGate(ev.payload)) {
            if (await alertOwner(tx, hit.zone, ev.serverId, "gate_built", ev.occurredAt, { gamertag })) out.alerts++;
          }
          return done();
        }
        // A position: upsert the sighting. The `lastSeenAt < excluded` guard
        // makes a replayed (older or equal) fix a no-op, which is what keeps
        // the alert below from firing twice for one event.
        const [row] = await tx.insert(intruderSightings).values({
          declarationId: hit.zone.declarationId, dayzId: fix.dayzId, firstSeenAt: ev.occurredAt, lastSeenAt: ev.occurredAt,
          lastAlertAt: ev.occurredAt, distanceM: hit.distanceM, lastX: fix.x.toFixed(2), lastZ: fix.z.toFixed(2),
        }).onConflictDoUpdate({
          target: [intruderSightings.declarationId, intruderSightings.dayzId],
          set: { lastSeenAt: ev.occurredAt, distanceM: hit.distanceM, lastX: fix.x.toFixed(2), lastZ: fix.z.toFixed(2) },
          setWhere: sql`${intruderSightings.lastSeenAt} < excluded.last_seen_at`,
        }).returning({ id: intruderSightings.id, firstSeenAt: intruderSightings.firstSeenAt, lastAlertAt: intruderSightings.lastAlertAt });
        if (!row) return done();   // replay: nothing changed
        out.sightings++;
        const fresh = row.firstSeenAt.getTime() === ev.occurredAt.getTime();
        const due = ev.occurredAt.getTime() - row.lastAlertAt.getTime() >= INTRUDER_ALERT_COOLDOWN_MS;
        if (fresh || due) {
          if (!fresh) await tx.update(intruderSightings).set({ lastAlertAt: ev.occurredAt }).where(eq(intruderSightings.id, row.id));
          if (await alertOwner(tx, hit.zone, ev.serverId, "intruder", ev.occurredAt, { gamertag, distance: hit.distanceM })) out.alerts++;
        }
        return done();
      });
    }
    await writeCursor(db, ZONE_CONSUMER, cursor);
  }
  return out;
}
