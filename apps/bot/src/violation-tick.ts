import type { Database } from "@factions/db";
import { identityLinks, zoneIncidents, zoneIncidentParticipants, factions, declarations } from "@factions/db";
import { VIOLATION_INCIDENT_GAP_MS, VIOLATION_REPORT_WINDOW_MS } from "@factions/domain";
import { noticeClanTx, noticeUserTx, type NoticePayload } from "@factions/roster/internal";
import { and, eq, isNull, lte } from "drizzle-orm";
import type { Tx } from "./zones.js";

export type ViolationTickResult = { closed: number; warned: number; ownersNotified: number };

/**
 * Closes incidents that have gone quiet, tells the base's owner the
 * incident can now be charged, and warns its participants.
 *
 * ⚠️ The owner notice is the ONLY thing that tells a clan an incident is
 * waiting. Before it existed the incident surfaced on `/base` alone, which a
 * clan has no reason to open, and a real dismantle sat uncharged until the
 * clan filed a ticket asking why they "never got the option". It goes to the
 * clan channel for a clan base and to the declarant's DM for a solo one, in
 * this same transaction as the close, so a closed incident without a notice
 * cannot exist.
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
  const out: ViolationTickResult = { closed: 0, warned: 0, ownersNotified: 0 };

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

      const owner = await ownerFor(tx, incident.declarationId);
      const tag = owner.tag ? `[${owner.tag}]` : "a declared base";

      const everyone = await tx.select({ gamertag: zoneIncidentParticipants.gamertag })
        .from(zoneIncidentParticipants).where(eq(zoneIncidentParticipants.incidentId, incident.id));
      // ⚠️ No coordinates — clan_notices_no_coordinates rejects x/y/z/poleKey;
      // the evidence itself is only ever shown on the site.
      const ready: NoticePayload = {
        // One string because a payload value is a scalar. Newline-separated:
        // a gamertag can hold a comma, never a line break.
        offenders: everyone.map((p) => p.gamertag).join("\n"),
        dismantled: row.partsDismantled, built: row.partsBuilt, stacked: row.stackItems,
        chargeableUntil: new Date(now.getTime() + VIOLATION_REPORT_WINDOW_MS).toISOString(),
      };
      if (owner.factionId !== null) {
        await noticeClanTx(tx, { serverId: incident.serverId, factionId: owner.factionId, kind: "incident_ready", occurredAt: now, payload: ready });
        out.ownersNotified++;
      } else if (owner.dayzId !== null) {
        const [ownerLink] = await tx.select({ discordId: identityLinks.discordId })
          .from(identityLinks).where(eq(identityLinks.dayzId, owner.dayzId));
        // A solo owner with no link (unlinked since declaring) cannot press charges either.
        if (ownerLink) {
          await noticeUserTx(tx, { serverId: incident.serverId, factionId: null, discordId: ownerLink.discordId, kind: "solo_incident_ready", occurredAt: now, payload: ready });
          out.ownersNotified++;
        }
      }

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
 * Who owns the base: the clan (and its tag, for the warning DM), or the solo
 * declarant.
 *
 * ⚠️ The warning DM renders a solo declaration as "a declared base", never
 * as the owner's name. Naming a solo player to a stranger who was just
 * inside their zone hands an attacker the one fact the map is built to
 * withhold.
 */
async function ownerFor(tx: Tx, declarationId: number): Promise<{ factionId: number | null; tag: string | null; dayzId: string | null }> {
  const [row] = await tx.select({ factionId: declarations.ownerFactionId, dayzId: declarations.ownerDayzId, tag: factions.tag })
    .from(declarations)
    .leftJoin(factions, eq(factions.id, declarations.ownerFactionId))
    .where(eq(declarations.id, declarationId));
  return { factionId: row?.factionId ?? null, tag: row?.tag ?? null, dayzId: row?.dayzId ?? null };
}
