import type { Database } from "@factions/db";
import { identityLinks, intruderSightings, zoneIncidents, zoneIncidentParticipants, zonePlacements, zoneViolations } from "@factions/db";
import { readCursor, writeCursor, readEventBatch } from "@factions/event-log";
import {
  INTRUDER_ALERT_COOLDOWN_MS, INTRUDER_PIN_TTL_MS, BOOST_ITEM_CLASSES, BOOST_STACK_WINDOW_MS,
  boostStackFor, type BoostPlacement, type ClanNoticeKind, type ViolationKind, type Vec3,
} from "@factions/domain";
import { noticeClanTx, noticeUserTx, type NoticePayload } from "@factions/roster/internal";
import { and, eq, gte, isNull, ne, sql } from "drizzle-orm";
import { readFix } from "./positions-tick.js";
import { isMemberOf, zoneContaining, zonesFor, type Tx, type Zone } from "./zones.js";

/** ⚠️ Distinct from every other consumer name; two consumers sharing a cursor skip each other's events. */
export const ZONE_CONSUMER = "zone-watch";

export type ZoneTickResult = { scanned: number; sightings: number; alerts: number; violations: number };

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
function readItemClass(payload: unknown): string {
  const c = (payload as Record<string, unknown>).itemClass;
  return typeof c === "string" && c !== "" ? c : "unknown";
}

const toBoostPlacement = (r: { dayzId: string; eventId: number; x: string; y: string; z: string; occurredAt: Date }): BoostPlacement =>
  ({ dayzId: r.dayzId, eventId: r.eventId, x: Number(r.x), y: Number(r.y), z: Number(r.z), occurredAt: r.occurredAt });

/**
 * The open incident for this zone, extended to `occurredAt`, or a new one.
 *
 * ⚠️ `zone_incidents_one_open` (partial unique on declaration_id WHERE
 * closed_at IS NULL) is what makes two acts in the same batch share one row
 * rather than race into two.
 */
async function openIncident(tx: Tx, zone: Zone, serverId: number, occurredAt: Date): Promise<number> {
  const [open] = await tx.select({ id: zoneIncidents.id, lastActAt: zoneIncidents.lastActAt })
    .from(zoneIncidents)
    .where(and(eq(zoneIncidents.declarationId, zone.declarationId), isNull(zoneIncidents.closedAt)));
  if (open) {
    if (occurredAt > open.lastActAt) {
      await tx.update(zoneIncidents).set({ lastActAt: occurredAt }).where(eq(zoneIncidents.id, open.id));
    }
    return open.id;
  }
  const [fresh] = await tx.insert(zoneIncidents)
    .values({ serverId, declarationId: zone.declarationId, openedAt: occurredAt, lastActAt: occurredAt })
    .returning({ id: zoneIncidents.id });
  return fresh!.id;
}

/**
 * Record one violating act and fold it into the incident's totals.
 *
 * Returns false when the event was already recorded — the `zone_violations_event_uq`
 * conflict. ⚠️ The totals are updated ONLY on a fresh insert, which is what
 * makes a replayed event unable to double-count damage.
 */
async function recordViolation(
  tx: Tx, incidentId: number, eventId: number, kind: ViolationKind,
  dayzId: string, gamertag: string, what: string, pos: Vec3, occurredAt: Date,
): Promise<boolean> {
  const [row] = await tx.insert(zoneViolations).values({
    incidentId, eventId, kind, dayzId, what,
    x: pos.x.toFixed(2), y: pos.y.toFixed(2), z: pos.z.toFixed(2), occurredAt,
  }).onConflictDoNothing({ target: zoneViolations.eventId }).returning({ id: zoneViolations.id });
  if (!row) return false;

  const bump = kind === "dismantle" ? { partsDismantled: sql`${zoneIncidents.partsDismantled} + 1` }
    : kind === "stack" ? { stackItems: sql`${zoneIncidents.stackItems} + 1`, hasBreach: true }
    : { partsBuilt: sql`${zoneIncidents.partsBuilt} + 1`, hasBreach: true };
  await tx.update(zoneIncidents)
    .set({ ...bump, ...(kind === "gate" ? { hasGate: true, hasBreach: true } : {}) })
    .where(eq(zoneIncidents.id, incidentId));

  await tx.insert(zoneIncidentParticipants)
    .values({ incidentId, dayzId, gamertag })
    .onConflictDoNothing();
  return true;
}

/**
 * Alert the zone's owner: the clan channel for a clan base, a DM for a solo
 * declarant (spec §9.3/§9.4). The solo kind is the clan kind with `solo_`
 * prefixed; the payload is identical and never carries a coordinate (§9.5).
 * A solo owner with no link (unlinked since declaring) gets nothing.
 */
async function alertOwner(tx: Tx, zone: Zone, serverId: number, kind: "intruder" | "dismantle" | "gate_built" | "built", occurredAt: Date, payload: NoticePayload): Promise<boolean> {
  if (zone.ownerFactionId !== null) {
    await noticeClanTx(tx, { serverId, factionId: zone.ownerFactionId, kind, occurredAt, payload });
    return true;
  }
  const [link] = await tx.select({ discordId: identityLinks.discordId }).from(identityLinks).where(eq(identityLinks.dayzId, zone.ownerDayzId!));
  if (!link) return false;
  // ⚠️ `gate_built` maps to the solo kind "gate" (not "gate_built") and
  // "built" maps to itself — solo_${kind} for every OTHER kind is already
  // the right name (solo_intruder, solo_dismantle), so this ternary only
  // needs the one exception the naming convention breaks.
  const soloKind = kind === "gate_built" ? "gate" : kind;
  await noticeUserTx(tx, { serverId, factionId: null, discordId: link.discordId, kind: `solo_${soloKind}` as ClanNoticeKind, occurredAt, payload });
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
 *
 * ⚠️ Any fix whose `occurredAt` is older than `INTRUDER_PIN_TTL_MS` before
 * `now` is skipped entirely — no sighting, no notice — while the cursor still
 * advances past it. It is a stale fix: the pin it would draw has already
 * expired, and the reaper would delete the row on its next pass. **This guard
 * is what makes an unseeded or hand-rewound cursor unable to flood every clan
 * channel and solo DM with historical intruder/dismantle/gate alerts.** The
 * runbook still seeds this consumer at the log head before the deploy; the
 * guard is the belt to the runbook's braces, and turns a missed seed from
 * catastrophic into noisy-but-bounded.
 */
export async function zoneTick(
  db: Database,
  opts: { batchSize?: number; now?: Date; enforcementEnabled: boolean },
): Promise<ZoneTickResult> {
  const batchSize = opts.batchSize ?? 500;
  const now = opts.now ?? new Date();
  const oldest = now.getTime() - INTRUDER_PIN_TTL_MS;
  const out: ZoneTickResult = { scanned: 0, sightings: 0, alerts: 0, violations: 0 };
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
      const isPlacement = ev.type === "item.placed"
        && (BOOST_ITEM_CLASSES as readonly string[]).includes(readItemClass(ev.payload));
      if (!isPosition && !isBuild && !isPlacement) continue;
      if (ev.occurredAt.getTime() < oldest) continue;   // stale fix: the pin would have expired anyway
      out.scanned++;
      let zones = zonesByServer.get(ev.serverId);
      if (!zones) { zones = await zonesFor(db, ev.serverId); zonesByServer.set(ev.serverId, zones); }
      const hit = zoneContaining(zones, fix);
      if (!hit || isMemberOf(hit.zone, fix.dayzId)) continue;
      const gamertag = readGamertag(ev.payload);
      await db.transaction(async (tx) => {
        const done = async () => { await writeCursor(tx, ZONE_CONSUMER, ev.id); };
        if (isBuild) {
          const part = readPart(ev.payload);
          const pos: Vec3 = { x: fix.x, y: fix.alt, z: fix.z };
          // ⚠️ IMPORTANT 4: the intruder/dismantle/gate ALERTS below predate
          // this branch and are unconditional, always. The incident WRITE
          // (openIncident/recordViolation) is this feature's own, and is
          // gated on `enforcementEnabled` — with it off (the default),
          // `zone_incidents_one_open` would otherwise keep exactly ONE open
          // row per declaration absorbing months of acts and participants,
          // then fire a mass warning DM to everyone accumulated the moment
          // an operator flips the flag on. Nothing must accumulate while the
          // feature is off.
          if (ev.type === "base.dismantled") {
            if (opts.enforcementEnabled) {
              const incidentId = await openIncident(tx, hit.zone, ev.serverId, ev.occurredAt);
              if (await recordViolation(tx, incidentId, ev.id, "dismantle", fix.dayzId, gamertag, part, pos, ev.occurredAt)) out.violations++;
            }
            if (await alertOwner(tx, hit.zone, ev.serverId, "dismantle", ev.occurredAt, { gamertag, part })) out.alerts++;
          } else {
            const kind: ViolationKind = isGate(ev.payload) ? "gate" : "build";
            if (opts.enforcementEnabled) {
              const incidentId = await openIncident(tx, hit.zone, ev.serverId, ev.occurredAt);
              if (await recordViolation(tx, incidentId, ev.id, kind, fix.dayzId, gamertag, part, pos, ev.occurredAt)) out.violations++;
            }
            // ⚠️ Alerts on EVERY non-member build now, not only a gate — a
            // watchtower is already sentenced as a breach (isGate() aside),
            // so silently recording it while alerting only on a gate meant
            // the owner learned about the one act that can never be undone
            // (a permanently-open wall) but not about a tower that clears
            // it. `gate_built`'s copy stays gate-specific and correct; an
            // ordinary build gets the new "built" kind, naming the part.
            if (kind === "gate") {
              if (await alertOwner(tx, hit.zone, ev.serverId, "gate_built", ev.occurredAt, { gamertag })) out.alerts++;
            } else {
              if (await alertOwner(tx, hit.zone, ev.serverId, "built", ev.occurredAt, { gamertag, part })) out.alerts++;
            }
          }
          return done();
        }
        if (isPlacement) {
          // ⚠️ IMPORTANT 4: the whole boost-stack detector — recording a
          // placement and folding it into an incident — is this feature's
          // own (there is no pre-existing alert here to preserve), so it is
          // gated entirely on `enforcementEnabled`; with it off, nothing
          // about a placement is written at all.
          if (!opts.enforcementEnabled) return done();
          // ⚠️ A LONE placement is recorded and is NOT a violation (spec §2.3):
          // a player may legitimately cook or farm near a base they cannot see.
          // It becomes one only when a LATER placement stacks on it.
          const [row] = await tx.insert(zonePlacements).values({
            serverId: ev.serverId, declarationId: hit.zone.declarationId, eventId: ev.id,
            dayzId: fix.dayzId, gamertag, itemClass: readItemClass(ev.payload),
            x: fix.x.toFixed(2), y: fix.alt.toFixed(2), z: fix.z.toFixed(2), occurredAt: ev.occurredAt,
          }).onConflictDoNothing({ target: zonePlacements.eventId })
            .returning({ id: zonePlacements.id });
          if (!row) return done();   // replay

          const recent = await tx.select({
            dayzId: zonePlacements.dayzId, eventId: zonePlacements.eventId, gamertag: zonePlacements.gamertag,
            itemClass: zonePlacements.itemClass, x: zonePlacements.x, y: zonePlacements.y,
            z: zonePlacements.z, occurredAt: zonePlacements.occurredAt, id: zonePlacements.id,
          }).from(zonePlacements).where(and(
            eq(zonePlacements.declarationId, hit.zone.declarationId),
            gte(zonePlacements.occurredAt, new Date(ev.occurredAt.getTime() - BOOST_STACK_WINDOW_MS)),
            ne(zonePlacements.id, row.id),
          ));
          const byEventId = new Map(recent.map((r) => [r.eventId, r]));
          const latest: BoostPlacement = { dayzId: fix.dayzId, eventId: ev.id, x: fix.x, y: fix.alt, z: fix.z, occurredAt: ev.occurredAt };
          const stack = boostStackFor(recent.map(toBoostPlacement), latest);
          if (!stack) return done();

          const incidentId = await openIncident(tx, hit.zone, ev.serverId, ev.occurredAt);
          // ⚠️ One violation row PER CLUSTER MEMBER, keyed on that member's own
          // event id — `zone_violations_event_uq` then dedups for free: a
          // member already recorded by an earlier completing placement is a
          // no-op here, so `stackItems` lands on exactly the cluster size at
          // every stack height, and a replay of the whole cluster re-inserts
          // nothing. Recording a flat "+1 per completing event" instead would
          // re-count every earlier member each time the cluster grows.
          for (const member of stack) {
            const isLatest = member.eventId === ev.id;
            const memberGamertag = isLatest ? gamertag : byEventId.get(member.eventId)!.gamertag;
            const memberItem = isLatest ? readItemClass(ev.payload) : byEventId.get(member.eventId)!.itemClass;
            const pos: Vec3 = { x: member.x, y: member.y, z: member.z };
            if (await recordViolation(tx, incidentId, member.eventId, "stack", member.dayzId, memberGamertag, memberItem, pos, member.occurredAt)) out.violations++;
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
