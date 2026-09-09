import type { Database } from "@factions/db";
import { factionMembers, factionVoteBallots, factions, identityLinks } from "@factions/db";
import { HOLDING_STATUSES } from "@factions/domain";
import { PgVerificationStore } from "@factions/verification";
import { and, asc, eq, inArray } from "drizzle-orm";
import { PgFactionStore, PgRosterStore, openRequestsFor, openVoteFor } from "./internal";

/**
 * What is waiting on the viewer, as two counts for the site bar (App Review
 * §01): `you` is the number of things /me's next-step strip could show —
 * a ceremony waiting to be founded, an open link challenge, each open
 * invite; `clan` is what /clan wants from an officer or a voter — open join
 * requests (officer+), and a no-confidence vote the viewer can still cast
 * in. Standing states (not linked, no clan) are not "waiting" and count 0.
 *
 * Read on EVERY page under the site layout, so it is five cheap lookups at
 * most and nothing joins the roster. Not linked: one query and out.
 */
export type Attention = { you: number; clan: number };

export async function attentionDb(db: Database, discordId: string, now: Date): Promise<Attention> {
  const [link] = await db.select({ dayzId: identityLinks.dayzId }).from(identityLinks).where(eq(identityLinks.discordId, discordId));
  const verification = new PgVerificationStore(db);
  const [ceremony, challenge] = await Promise.all([
    new PgFactionStore(db).openCeremonyFor(discordId),
    link ? Promise.resolve(null) : verification.findLiveChallenge(discordId, now),
  ]);
  let you = (ceremony ? 1 : 0) + (challenge ? 1 : 0);
  let clan = 0;
  if (!link) return { you, clan };

  const [m] = await db.select({ factionId: factionMembers.factionId, role: factionMembers.role, status: factionMembers.status })
    .from(factionMembers).innerJoin(factions, eq(factions.id, factionMembers.factionId))
    .where(and(eq(factionMembers.discordId, discordId), inArray(factions.status, [...HOLDING_STATUSES])))
    .orderBy(asc(factions.id)).limit(1);

  if (!m) {
    const invites = await new PgRosterStore(db).pendingInvitesFor(link.dayzId, now);
    you += invites.length;
    return { you, clan };
  }
  if (m.status !== "full") return { you, clan };

  const officerPlus = m.role === "leader" || m.role === "officer";
  const [requests, vote] = await Promise.all([
    officerPlus ? openRequestsFor(db, m.factionId, now) : Promise.resolve([]),
    openVoteFor(db, m.factionId),
  ]);
  clan += requests.length;
  if (vote && vote.electorateDayzIds.includes(link.dayzId)) {
    const [ballot] = await db.select({ id: factionVoteBallots.id }).from(factionVoteBallots)
      .where(and(eq(factionVoteBallots.voteId, vote.id), eq(factionVoteBallots.dayzId, link.dayzId))).limit(1);
    if (!ballot) clan += 1;
  }
  return { you, clan };
}
