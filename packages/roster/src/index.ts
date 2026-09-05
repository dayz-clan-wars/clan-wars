/**
 * @factions/roster — what the site is allowed to do (target spec §10.4).
 *
 * `apps/web` imports this and never @factions/db. The export list below IS
 * the permission list; test/exports.test.ts pins it by name and so does
 * apps/web/test/smoke.test.ts. It holds the link flow (`startLink`,
 * `cancelLink`, `unlink`, `linkStatus`, `searchGamertags`) as its first
 * writes. Nothing here may ever set a clan active or dormant, write a raid
 * or a defense, insert a declaration without citing evidence the log
 * already holds, or create a faction without a ceremony.
 *
 * Lock order for the writes that land in increments 2b and 2c (spec §4.12):
 * factions → declarations → poles → faction_members → faction_invites →
 * faction_join_requests → … → faction_events. Every write appends its feed
 * or notice row in the transition's own transaction.
 */
import { db } from "./client";
import { viewerForDb, type Viewer, type Role } from "./viewer";
import {
  linkStatusDb, startLinkDb, cancelLinkDb, unlinkDb, searchGamertagsDb,
  type LinkStatus, type LinkStep, type UnlinkOutcome,
} from "./link";
import type { IssueOutcome, IssueOutcomeKind } from "@factions/verification";
export { ISSUE_OUTCOME_KINDS } from "@factions/verification";

export type { Viewer, Role };
export type { LinkStatus, LinkStep, UnlinkOutcome, IssueOutcome, IssueOutcomeKind };

/** Who is looking: their link and their clan, or null for either. */
export function viewerFor(discordId: string): Promise<Viewer> {
  return viewerForDb(db(), discordId);
}

/** /link's one read: your link, your open challenge, how the last one ended. */
export function linkStatus(discordId: string): Promise<LinkStatus> {
  return linkStatusDb(db(), discordId, new Date());
}
/** Issue (or re-show) a link challenge for a character the log has seen. */
export function startLink(discordId: string, targetDayzId: string, opts: { newSequence?: boolean } = {}): Promise<IssueOutcome> {
  return startLinkDb(db(), { discordId, targetDayzId, newSequence: opts.newSequence, now: new Date(), rng: Math.random });
}
export function cancelLink(discordId: string): Promise<{ canceled: boolean }> {
  return cancelLinkDb(db(), discordId, new Date());
}
/** Refused while in a clan; releases a solo base. */
export function unlink(discordId: string): Promise<UnlinkOutcome> {
  return unlinkDb(db(), discordId, new Date());
}
export function searchGamertags(prefix: string): Promise<{ dayzId: string; gamertag: string }[]> {
  return searchGamertagsDb(db(), prefix);
}
