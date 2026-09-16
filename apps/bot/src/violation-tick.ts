import type { Database } from "@factions/db";
import { identityLinks, zoneIncidents, zoneIncidentParticipants, factions, declarations } from "@factions/db";
import { VIOLATION_INCIDENT_GAP_MS } from "@factions/domain";
import { noticeUserTx } from "@factions/roster/internal";
import { and, eq, isNull, lte } from "drizzle-orm";
import type { Tx } from "./zones.js";

export type ViolationTickResult = { closed: number; warned: number };

/**
 * Closes incidents that have gone quiet and warns their participants.
 *
 * ⚠️ The warning is a HEADS-UP, not a charge. There is no helper permit
 * (spec §2.4), so a player the base owner invited to help WILL receive this
 * message. Its wording is the only thing standing between an invited friend
 * and a support ticket — see notice-text.ts.
 *
 * `warned_at` on the participant row is what makes the DM exactly-once.
 */
export async function violationTick(db: Database, opts: { now?: Date } = {}): Promise<ViolationTickResult> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - VIOLATION_INCIDENT_GAP_MS);
  const out: ViolationTickResult = { closed: 0, warned: 0 };

  const due = await db.select({ id: zoneIncidents.id, serverId: zoneIncidents.serverId, declarationId: zoneIncidents.declarationId })
    .from(zoneIncidents)
    .where(and(isNull(zoneIncidents.closedAt), lte(zoneIncidents.lastActAt, cutoff)));

  for (const incident of due) {
    await db.transaction(async (tx) => {
      // ⚠️ Guarded by closedAt IS NULL again inside the transaction — this is
      // what stops two overlapping ticks both closing and both warning; the
      // loser here sees no row back and does nothing further.
      const [row] = await tx.update(zoneIncidents).set({ closedAt: now })
        .where(and(eq(zoneIncidents.id, incident.id), isNull(zoneIncidents.closedAt)))
        .returning({
          id: zoneIncidents.id, partsDismantled: zoneIncidents.partsDismantled,
          partsBuilt: zoneIncidents.partsBuilt, stackItems: zoneIncidents.stackItems,
        });
      if (!row) return;   // another tick closed it
      out.closed++;

      const tag = await ownerTagFor(tx, incident.declarationId);
      const participants = await tx.select({ dayzId: zoneIncidentParticipants.dayzId })
        .from(zoneIncidentParticipants)
        .where(and(eq(zoneIncidentParticipants.incidentId, incident.id), isNull(zoneIncidentParticipants.warnedAt)));

      for (const p of participants) {
        const [link] = await tx.select({ discordId: identityLinks.discordId })
          .from(identityLinks).where(eq(identityLinks.dayzId, p.dayzId));
        // Mark warned either way: an unlinked offender is not owed a second
        // attempt if they link later, and the ban does not need the link.
        await tx.update(zoneIncidentParticipants).set({ warnedAt: now })
          .where(and(eq(zoneIncidentParticipants.incidentId, incident.id), eq(zoneIncidentParticipants.dayzId, p.dayzId)));
        if (!link) continue;
        await noticeUserTx(tx, {
          serverId: incident.serverId, factionId: null, discordId: link.discordId,
          kind: "zone_warning", occurredAt: now,
          // ⚠️ No coordinates — clan_notices_no_coordinates rejects x/y/z/poleKey.
          payload: { tag, dismantled: row.partsDismantled, built: row.partsBuilt, stacked: row.stackItems },
        });
        out.warned++;
      }
    });
  }
  return out;
}

/**
 * How the warning DM names the base's owner.
 *
 * ⚠️ A solo declaration renders as "a declared base", never as the owner's
 * name. Naming a solo player to a stranger who was just inside their zone
 * hands an attacker the one fact the map is built to withhold.
 */
async function ownerTagFor(tx: Tx, declarationId: number): Promise<string> {
  const [row] = await tx.select({ tag: factions.tag })
    .from(declarations)
    .leftJoin(factions, eq(factions.id, declarations.ownerFactionId))
    .where(eq(declarations.id, declarationId));
  return row?.tag ? `[${row.tag}]` : "a declared base";
}
