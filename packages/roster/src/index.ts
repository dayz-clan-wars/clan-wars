/**
 * @factions/roster — what the site is allowed to do (target spec §10.4).
 *
 * `apps/web` imports this and never @factions/db. The export list below IS
 * the permission list; test/exports.test.ts pins it by name and so does
 * apps/web/test/smoke.test.ts. Nothing here may ever set a clan active or
 * dormant, write a raid or a defense, insert a declaration without citing
 * evidence the log already holds, or create a faction without a ceremony.
 *
 * Lock order for the writes that land in increments 2b and 2c (spec §4.12):
 * factions → declarations → poles → faction_members → faction_invites →
 * faction_join_requests → … → faction_events. Every write appends its feed
 * or notice row in the transition's own transaction.
 */
import { db } from "./client";
import { viewerForDb, type Viewer, type Role } from "./viewer";

export type { Viewer, Role };

/** Who is looking: their link and their clan, or null for either. */
export function viewerFor(discordId: string): Promise<Viewer> {
  return viewerForDb(db(), discordId);
}
