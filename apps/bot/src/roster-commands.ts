import type { RosterStore } from "./roster-store.js";
import { resolveServerContext } from "./roster-context.js";

export type RosterPrompt =
  | { kind: "confirm-transfer"; factionId: number; targetDiscordId: string }
  | { kind: "confirm-disband"; factionId: number };

export type RosterReply = {
  content: string;
  ephemeral: boolean;
  prompt?: RosterPrompt;
  /**
   * A direct message the Discord layer should attempt after replying.
   *
   * ⚠️ The handler cannot send it: handlers are pure over the store and have
   * no client. It also cannot know whether it landed, which the inviter
   * needs to be told — so the Discord layer appends the outcome to the
   * reply. See Task 9, Step 4a.
   */
  dm?: { discordId: string; content: string; onFailure: string };
};

export type RosterDeps = {
  store: RosterStore;
  now: () => Date;
  inviteTtlMs: number;
  cooldownMs: number;
  renameCooldownMs: number;
};

const reply = (content: string): RosterReply => ({ content, ephemeral: true });

const mention = (discordId: string) => `<@${discordId}>`;

/**
 * `resolveServerContext`'s non-"ok" outcomes are shared across every roster
 * command, so the message for each is written once here.
 */
function contextRefusal(ctx: { kind: "no-faction" } | { kind: "not-on-server" } | { kind: "ambiguous"; choices: unknown[] }): RosterReply {
  if (ctx.kind === "no-faction") return reply("You are not in a faction.");
  if (ctx.kind === "not-on-server") return reply("You don't hold a faction on that server.");
  return reply("You're in a faction on more than one server — say which one.");
}

export type InviteInput = { serverId: number | null; inviteeDiscordId: string };

/**
 * Only the leader and officers may invite. The invitee must already have a
 * linked character — an invite is issued against a UID, and there is no UID
 * to issue it against otherwise.
 */
export async function handleFactionInvite(
  deps: RosterDeps,
  actorDiscordId: string,
  input: InviteInput,
): Promise<RosterReply> {
  const ctx = resolveServerContext(await deps.store.membershipsFor(actorDiscordId), input.serverId);
  if (ctx.kind !== "ok") return contextRefusal(ctx);
  const { membership } = ctx;

  if (membership.role === "member") {
    return reply("Only the leader and officers can invite.");
  }

  const link = await deps.store.linkFor(input.inviteeDiscordId);
  if (!link) {
    return reply(`**${mention(input.inviteeDiscordId)}** has not linked a character yet — they need to run \`/link\` first.`);
  }

  const at = deps.now();
  const { outcome } = await deps.store.createInvite({
    factionId: membership.factionId,
    serverId: membership.serverId,
    inviteeDiscordId: input.inviteeDiscordId,
    inviteeDayzId: link.dayzId,
    invitedByDiscordId: actorDiscordId,
    at,
    expiresAt: new Date(at.getTime() + deps.inviteTtlMs),
  });

  if (outcome === "already-member") {
    return reply(`**${mention(input.inviteeDiscordId)}** is already in a faction on **${membership.serverName}**.`);
  }
  if (outcome === "cooldown") {
    return reply(`**${mention(input.inviteeDiscordId)}** is on cooldown and can't join a faction there yet.`);
  }
  if (outcome === "not-holding") {
    return reply("Your faction is no longer active enough to invite anyone.");
  }

  return {
    content: `Invited **${mention(input.inviteeDiscordId)}** to **${membership.factionName}** [${membership.tag}].`,
    ephemeral: true,
    dm: {
      discordId: input.inviteeDiscordId,
      content: `You've been invited to join **${membership.factionName}** [${membership.tag}] on **${membership.serverName}**. Run \`/faction invites\` to accept or decline.`,
      onFailure: "Could not DM them the invite — they'll still see it with `/faction invites`.",
    },
  };
}

/**
 * Lists the caller's own pending invitations. Keyed off their linked UID,
 * not a faction — invitations arrive regardless of what faction, if any,
 * the caller currently holds.
 */
export async function handleFactionInvites(deps: RosterDeps, discordId: string): Promise<RosterReply> {
  const link = await deps.store.linkFor(discordId);
  if (!link) return reply("You need to link a character first. Run `/link`.");

  const invites = await deps.store.pendingInvitesFor(link.dayzId, deps.now());
  if (invites.length === 0) return reply("You have no pending invitations.");

  const lines = invites.map((inv) =>
    `**${inv.factionName}** [${inv.tag}] on **${inv.serverName}** — expires <t:${Math.floor(inv.expiresAt.getTime() / 1000)}:R> (id: ${inv.id})`,
  );
  return reply(["Your pending invitations:", ...lines].join("\n"));
}

/**
 * The invite id here travels in a Discord button custom id, which a user
 * could guess or replay — the security guard is inside `acceptInvite`
 * itself (it checks the invitee matches), not this handler.
 */
export async function handleInviteAccept(deps: RosterDeps, discordId: string, inviteId: number): Promise<RosterReply> {
  const outcome = await deps.store.acceptInvite(inviteId, discordId, deps.now());
  if (outcome === "gone") return reply("That invitation is no longer available.");
  if (outcome === "already-member") return reply("You're already in a faction on that server.");
  if (outcome === "cooldown") return reply("You're on cooldown and can't join a faction there yet.");
  if (outcome === "not-holding") return reply("That faction is no longer active.");
  return reply("You joined the faction.");
}

export async function handleInviteDecline(deps: RosterDeps, discordId: string, inviteId: number): Promise<RosterReply> {
  const ok = await deps.store.declineInvite(inviteId, discordId, deps.now());
  return reply(ok ? "Invitation declined." : "That invitation is no longer available.");
}

export type KickInput = { serverId: number | null; targetDiscordId: string };

/**
 * The store owns every precondition (self-kick, permission, and the two
 * untouchable-target cases) because they're re-checked at write time, not
 * just here — see `PgRosterStore.kick`. This handler only maps outcomes to
 * messages.
 */
export async function handleFactionKick(
  deps: RosterDeps,
  actorDiscordId: string,
  input: KickInput,
): Promise<RosterReply> {
  const ctx = resolveServerContext(await deps.store.membershipsFor(actorDiscordId), input.serverId);
  if (ctx.kind !== "ok") return contextRefusal(ctx);
  const { membership } = ctx;

  const at = deps.now();
  const outcome = await deps.store.kick({
    factionId: membership.factionId,
    actorDiscordId,
    targetDiscordId: input.targetDiscordId,
    at,
    until: new Date(at.getTime() + deps.cooldownMs),
  });

  if (outcome === "not-permitted") return reply("Only the leader and officers can kick.");
  if (outcome === "target-not-member") return reply(`**${mention(input.targetDiscordId)}** is not in **${membership.factionName}**.`);
  if (outcome === "cannot-kick-self") return reply("You can't kick yourself. Use `/faction leave` instead.");
  if (outcome === "cannot-kick-officer") return reply("Officers can't kick other officers.");
  if (outcome === "cannot-kick-leader") return reply("You can't kick the leader.");

  return reply(
    `**${mention(input.targetDiscordId)}** has been kicked from **${membership.factionName}**. `
    + `They cannot join a faction on **${membership.serverName}** for 3 days.`,
  );
}

export async function handleFactionLeave(
  deps: RosterDeps,
  discordId: string,
  serverId: number | null,
): Promise<RosterReply> {
  const ctx = resolveServerContext(await deps.store.membershipsFor(discordId), serverId);
  if (ctx.kind !== "ok") return contextRefusal(ctx);
  const { membership } = ctx;

  const at = deps.now();
  const outcome = await deps.store.leave({
    factionId: membership.factionId,
    discordId,
    at,
    until: new Date(at.getTime() + deps.cooldownMs),
  });

  if (outcome === "not-member") return reply(`You're not in **${membership.factionName}**.`);
  if (outcome === "leader-must-transfer") {
    return reply("You're the leader — transfer leadership before you can leave. Use `/faction transfer`.");
  }

  return reply(`You left **${membership.factionName}**. You cannot join a faction on **${membership.serverName}** for 3 days.`);
}
