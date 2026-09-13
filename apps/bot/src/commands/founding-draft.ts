/**
 * `/found`'s in-progress choices (R4).
 *
 * A Discord `custom_id` caps at 100 characters and ten 17-character
 * participant ids do not fit, so the flag and crew live here between the
 * select menus and the modal.
 *
 * ⚠️ This is process memory, and it is safe ONLY because exactly one bot
 * instance may run — a project invariant, not an assumption. Nothing is
 * written from a draft alone: `claimCeremony` re-reads the ceremony, re-checks
 * that the actor is on it, and re-checks the flag is still free. A lost draft
 * (restart, TTL) costs the player one re-run of `/found` and nothing else.
 */
export type Draft = { ceremonyId: number; texture: string | null; memberDayzIds: string[] };

export const DRAFT_TTL_MS = 15 * 60_000;

const drafts = new Map<string, { draft: Draft; at: Date }>();

export function putDraft(actorDiscordId: string, draft: Draft, now: Date): void {
  drafts.set(actorDiscordId, { draft, at: now });
}

export function getDraft(actorDiscordId: string, now: Date): Draft | null {
  const held = drafts.get(actorDiscordId);
  if (!held) return null;
  if (now.getTime() - held.at.getTime() > DRAFT_TTL_MS) { drafts.delete(actorDiscordId); return null; }
  return held.draft;
}

export function clearDraft(actorDiscordId: string): void {
  drafts.delete(actorDiscordId);
}
