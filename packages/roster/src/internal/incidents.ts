import type { Database } from "@factions/db";
import {
  bans, declarations, factionMembers, identityLinks, seasons, zoneIncidentParticipants, zoneIncidents, zoneViolations,
} from "@factions/db";
import type { Tx } from "@factions/declarations";
import { sentenceMsFor, VIOLATION_REPORT_WINDOW_MS, type IncidentDamage, type ViolationKind } from "@factions/domain";
import { and, asc, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import { activeServerId } from "../server";

export type ReportableIncident = {
  id: number;
  openedAt: Date;
  closedAt: Date;
  partsDismantled: number;
  partsBuilt: number;
  stackItems: number;
  hasBreach: boolean;
  hasGate: boolean;
  participants: { gamertag: string }[];
  acts: { kind: ViolationKind; what: string; x: number; z: number; at: Date }[];
};

export const REPORT_REASONS = ["not-linked", "not-owner", "not-officer", "no-incident", "window-closed", "already-reported"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export type ReportOutcome = { ok: true; banned: number } | { ok: false; reason: ReportReason };

/**
 * The open season's `started_at` for the server, or `now` when no season is
 * open. Package-local twin of `scoring.ts`'s `openSeasonFor`.
 *
 * ⚠️ The fallback is `now`, NOT the epoch. The prior-offence query below is
 * `bannedAt >= seasonStart`, so an epoch fallback would match every ban ever
 * written on the server — and between a season closing at a wipe and the
 * next season's row being inserted, that turns a player's FIRST offence of
 * the new season into their third, which `sentenceMsFor` makes permanent
 * with no expire arm able to ever lift it. Falling back to `now` instead
 * costs one first-offence player a slightly-short term in that gap, which is
 * recoverable; the epoch fallback cost a player their account.
 */
async function seasonStartFor(db: Database | Tx, serverId: number, now: Date): Promise<Date> {
  const [s] = await db.select({ startedAt: seasons.startedAt }).from(seasons)
    .where(and(eq(seasons.serverId, serverId), isNull(seasons.endedAt)));
  return s?.startedAt ?? now;
}

/**
 * The incidents at the caller's own base that are ready to be reported:
 * CLOSED, not yet reported, inside `VIOLATION_REPORT_WINDOW_MS` of closing.
 * Every participant and every act the log recorded is included — this is
 * the ONLY place the evidence a report is based on is shown (CLAUDE.md: no
 * coordinates in any Discord notice, so this can only ever be a site read).
 *
 * A SOLO base surfaces to its declarant; a clan base surfaces to every full
 * member (the officer gate is on the WRITE, `reportIncidentDb`, not here —
 * a member who cannot press charges can still see why an officer might).
 */
export async function reportableIncidentsDb(db: Database, now: Date, discordId: string): Promise<ReportableIncident[]> {
  const [link] = await db.select({ dayzId: identityLinks.dayzId }).from(identityLinks)
    .where(eq(identityLinks.discordId, discordId));
  if (!link) return [];

  const serverId = await activeServerId(db);
  const [member] = await db.select({ factionId: factionMembers.factionId }).from(factionMembers)
    .where(and(
      eq(factionMembers.serverId, serverId),
      eq(factionMembers.dayzId, link.dayzId),
      eq(factionMembers.status, "full"),
    ));

  const declRows = member
    ? await db.select({ id: declarations.id }).from(declarations)
      .where(and(eq(declarations.serverId, serverId), eq(declarations.ownerFactionId, member.factionId)))
    : await db.select({ id: declarations.id }).from(declarations)
      .where(and(eq(declarations.serverId, serverId), eq(declarations.ownerDayzId, link.dayzId)));
  if (declRows.length === 0) return [];
  const declIds = declRows.map((d) => d.id);

  const incidents = await db.select().from(zoneIncidents)
    .where(and(
      inArray(zoneIncidents.declarationId, declIds),
      // ⚠️ isNotNull(closedAt) is asserted below rather than in the query —
      // drizzle's generated type still says `Date | null` either way, and
      // the filter is cheap at this table's size.
    ));

  const reportable = incidents.filter((i) =>
    i.closedAt !== null && i.reportedAt === null &&
    now.getTime() - i.closedAt.getTime() <= VIOLATION_REPORT_WINDOW_MS,
  );
  if (reportable.length === 0) return [];

  const out: ReportableIncident[] = [];
  for (const i of reportable) {
    const participants = await db.select({ gamertag: zoneIncidentParticipants.gamertag })
      .from(zoneIncidentParticipants).where(eq(zoneIncidentParticipants.incidentId, i.id));
    const violations = await db.select().from(zoneViolations)
      .where(eq(zoneViolations.incidentId, i.id)).orderBy(asc(zoneViolations.occurredAt));
    out.push({
      id: i.id, openedAt: i.openedAt, closedAt: i.closedAt!,
      partsDismantled: i.partsDismantled, partsBuilt: i.partsBuilt, stackItems: i.stackItems,
      hasBreach: i.hasBreach, hasGate: i.hasGate,
      participants,
      acts: violations.map((v) => ({
        kind: v.kind, what: v.what, x: Number(v.x), z: Number(v.z), at: v.occurredAt,
      })),
    });
  }
  return out;
}

/**
 * Press charges on a bot-witnessed incident.
 *
 * ⚠️ This is a PROSECUTION TOGGLE, not a report form. It carries no free
 * text and cannot describe an act the log did not witness — the reporter
 * chooses only WHETHER to charge, never WHAT the charge is. That property is
 * the whole reason a player's click may trigger a ban with no staff
 * adjudicator in the loop (spec §1). Do not add a caller-supplied field to
 * it.
 *
 * Liability is JOINT (spec §7): every participant is sentenced on the
 * incident's full damage total, which removes the incentive to spread
 * dismantling across accounts to stay under a threshold.
 */
export async function reportIncidentDb(
  db: Database, now: Date, discordId: string, incidentId: number,
): Promise<ReportOutcome> {
  return db.transaction(async (tx) => {
    const [link] = await tx.select({ dayzId: identityLinks.dayzId })
      .from(identityLinks).where(eq(identityLinks.discordId, discordId));
    if (!link) return { ok: false as const, reason: "not-linked" as const };

    // Lock order (CLAUDE.md §4.12): zone_incidents is locked here; the
    // declarations and faction_members reads right after are PLAIN reads
    // (no FOR UPDATE), so no conflicting lock order is created — see the
    // note in CLAUDE.md.
    const [incident] = await tx.select().from(zoneIncidents)
      .where(eq(zoneIncidents.id, incidentId)).for("update");
    if (!incident || incident.closedAt === null) return { ok: false as const, reason: "no-incident" as const };
    if (incident.reportedAt !== null) return { ok: false as const, reason: "already-reported" as const };
    if (now.getTime() - incident.closedAt.getTime() > VIOLATION_REPORT_WINDOW_MS) {
      return { ok: false as const, reason: "window-closed" as const };
    }

    const [decl] = await tx.select({
      ownerFactionId: declarations.ownerFactionId, ownerDayzId: declarations.ownerDayzId,
    }).from(declarations).where(eq(declarations.id, incident.declarationId));
    if (!decl) return { ok: false as const, reason: "no-incident" as const };

    if (decl.ownerFactionId === null) {
      // A solo base: only the declarant may press charges.
      if (decl.ownerDayzId !== link.dayzId) return { ok: false as const, reason: "not-owner" as const };
    } else {
      // A clan base: officer+, the same gate grantGuestPassDbFor uses.
      const [member] = await tx.select({ role: factionMembers.role }).from(factionMembers)
        .where(and(
          eq(factionMembers.factionId, decl.ownerFactionId),
          eq(factionMembers.dayzId, link.dayzId),
          eq(factionMembers.status, "full"),
        ));
      if (!member) return { ok: false as const, reason: "not-owner" as const };
      if (member.role !== "leader" && member.role !== "officer") {
        return { ok: false as const, reason: "not-officer" as const };
      }
    }

    await tx.update(zoneIncidents)
      .set({ reportedAt: now, reportedByDiscordId: discordId })
      .where(eq(zoneIncidents.id, incidentId));

    const damage: IncidentDamage = {
      partsDismantled: incident.partsDismantled, partsBuilt: incident.partsBuilt,
      stackItems: incident.stackItems, hasBreach: incident.hasBreach, hasGate: incident.hasGate,
    };
    const seasonStart = await seasonStartFor(tx, incident.serverId, now);
    const participants = await tx.select({
      dayzId: zoneIncidentParticipants.dayzId, gamertag: zoneIncidentParticipants.gamertag,
    }).from(zoneIncidentParticipants).where(eq(zoneIncidentParticipants.incidentId, incidentId));

    let banned = 0;
    for (const p of participants) {
      // Prior offences THIS SERVER, this season, that still stand. `lifted`
      // is excluded — a ban lifted on appeal is the one status that means
      // the offence did NOT hold up, not merely that enforcement stopped.
      // `failed`/`expired` still count: the offence stood, only the
      // mechanical enforcement did not (or ran its course).
      const prior = await tx.select({ id: bans.id }).from(bans).where(and(
        eq(bans.dayzId, p.dayzId), eq(bans.serverId, incident.serverId),
        gte(bans.bannedAt, seasonStart), ne(bans.status, "lifted"),
      ));
      const ms = sentenceMsFor(damage, prior.length);
      await tx.insert(bans).values({
        serverId: incident.serverId, incidentId, dayzId: p.dayzId,
        // ⚠️ Frozen here, both of them. Never re-resolved at apply time.
        gamertag: p.gamertag,
        bannedAt: now,
        // ⚠️ null means PERMANENT, not unknown.
        expiresAt: ms === null ? null : new Date(now.getTime() + ms),
        // `dry_run` is left at the column default and STAMPED BY ban-tick at
        // apply time with the mode that actually ran. The web app must not
        // need to know the bot's BAN_DRY_RUN setting.
        status: "pending",
      }).onConflictDoNothing();
      banned++;
    }
    return { ok: true as const, banned };
  });
}
