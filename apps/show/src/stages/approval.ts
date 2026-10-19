import type { Discord } from "../engine/publish/discord.js";

export const APPROVE = "✅";
export const REJECT = "❌";

/**
 * Read an ops-channel draft's reactions: the one approval rule, shared by the weekly stages and a
 * special's publish (spec 2026-10-19-nasdara-promo-episode-design.md §5.2), so the two can never
 * disagree about what counts as a ✅. `null` means no approver has decided yet.
 */
export async function decideDraft(
  d: { discord: Discord; approverIds: string[] },
  channelId: string,
  draftId: string,
): Promise<{ decision: "approved" | "rejected"; by: string } | null> {
  const me = await d.discord.me();
  const approvers = new Set(d.approverIds);
  // ⚠️ The bot's own reaction (added as a convenience so an approver can click rather than hunt
  // for the emoji) is never a vote, even if the bot's id somehow ends up in approverIds.
  const by = async (emoji: string) => (await d.discord.reactionUserIds(channelId, draftId, emoji)).filter((u) => u !== me).find((u) => approvers.has(u)) ?? null;
  // ⚠️ ❌ is read first and wins: when two approvers disagree, nothing goes public.
  const rejecter = await by(REJECT);
  if (rejecter) return { decision: "rejected", by: rejecter };
  const approver = await by(APPROVE);
  if (approver) return { decision: "approved", by: approver };
  return null;
}
