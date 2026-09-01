export type NicknameOutcome = "ok" | "is-owner" | "outranked" | "no-permission" | "failed";

/** Only what this needs from a guild, so tests need no discord.js client. */
export type GuildLike = {
  ownerId: string;
  members: { fetch(userId: string): Promise<MemberLike> };
  members_me_permissions_has(perm: "ManageNicknames"): boolean;
};
export type MemberLike = {
  manageable: boolean;
  setNickname(nick: string | null): Promise<unknown>;
};

/**
 * Best-effort rename. NEVER call this to decide whether a link may proceed —
 * the identity binding is committed first, elsewhere, and must never be
 * withheld, delayed, or rolled back because Discord would not let us rename
 * someone. This only ever reports how the rename went, after the fact.
 */
export async function applyNickname(
  guild: GuildLike, userId: string, nickname: string | null,
): Promise<NicknameOutcome> {
  // ⚠️ Checked FIRST and without attempting. Discord's API can never rename a
  // guild owner — not with any permission, not ever — so an attempt is a
  // guaranteed error, and treating that error as transient would mean
  // retrying forever on every future link.
  if (guild.ownerId === userId) return "is-owner";
  if (!guild.members_me_permissions_has("ManageNicknames")) return "no-permission";
  try {
    const member = await guild.members.fetch(userId);
    // Discord returns 50013 for BOTH "your role is too low" and "you lack the
    // permission". They need different messages — one is fixed by moving the
    // bot's role, the other by granting a permission — so hierarchy is
    // checked here rather than inferred from the error code.
    if (!member.manageable) return "outranked";
    await member.setNickname(nickname);
    return "ok";
  } catch (err) {
    console.warn(`nickname change failed for ${userId}`, err);
    return "failed";
  }
}
