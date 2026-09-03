import type { FactionCard, RosterStore } from "./roster-store.js";
import { resolveServerContext } from "./roster-context.js";

export type RosterPrompt =
  | { kind: "confirm-transfer"; factionId: number; targetDiscordId: string }
  | { kind: "confirm-disband"; factionId: number }
  | { kind: "confirm-rebind"; factionId: number; poleKey: string }
  /**
   * §2.5: `/faction invites` carries "the same accept and decline buttons"
   * as the DM. `invites` is capped at `MAX_LISTED_INVITES` so the reply
   * stays inside Discord's five-action-row limit; `hiddenCount` is how many
   * more are not shown, so a long queue is disclosed rather than silently
   * truncated.
   */
  | { kind: "list-invites"; invites: { id: number; tag: string }[]; hiddenCount: number };

export type RosterReply = {
  content: string;
  /**
   * ⚠️ Literal `true`, not `boolean`. `info` and `roster` used to reply
   * publicly, which put a faction's pole coordinates in a channel anyone
   * could read. Typing this as the literal means the compiler refuses a
   * public roster reply, so restoring one is a deliberate type change and
   * not a passing `false`.
   */
  ephemeral: true;
  prompt?: RosterPrompt;
  /**
   * A direct message the Discord layer should attempt after replying.
   *
   * ⚠️ The handler cannot send it: handlers are pure over the store and have
   * no client. It also cannot know whether it landed, which the inviter
   * needs to be told — so the Discord layer appends the outcome to the
   * reply. See Task 9, Step 4a.
   */
  dm?: { discordId: string; content: string; onFailure: string; inviteId: number };
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
  const { outcome, inviteId } = await deps.store.createInvite({
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
  // The store re-checks the actor's role at write time, so this fires when
  // the actor was demoted between the membership read above and the insert.
  if (outcome === "not-permitted") {
    return reply("Only the leader and officers can invite.");
  }

  return {
    content: `Invited **${mention(input.inviteeDiscordId)}** to **${membership.factionName}** [${membership.tag}].`,
    ephemeral: true,
    dm: {
      discordId: input.inviteeDiscordId,
      content: `You've been invited to join **${membership.factionName}** [${membership.tag}] on **${membership.serverName}**. Run \`/faction invites\` to accept or decline.`,
      onFailure: "Could not DM them the invite — they'll still see it with `/faction invites`.",
      // `outcome === "ok"` is the only branch that reaches here, and
      // `createInvite` always returns a real id alongside that outcome.
      inviteId: inviteId!,
    },
  };
}

/**
 * Lists the caller's own pending invitations. Keyed off their linked UID,
 * not a faction — invitations arrive regardless of what faction, if any,
 * the caller currently holds.
 */
/**
 * Discord caps a message at five action rows, and each listed invite takes
 * one row (an accept button beside a decline button) — see §2.5, which
 * requires `/faction invites` to carry "the same accept and decline
 * buttons" as the DM. Five rows is therefore the hard ceiling, not a nicety.
 */
export const MAX_LISTED_INVITES = 5;

export async function handleFactionInvites(deps: RosterDeps, discordId: string): Promise<RosterReply> {
  const link = await deps.store.linkFor(discordId);
  if (!link) return reply("You need to link a character first. Run `/link`.");

  const invites = await deps.store.pendingInvitesFor(link.dayzId, deps.now());
  if (invites.length === 0) return reply("You have no pending invitations.");

  const shown = invites.slice(0, MAX_LISTED_INVITES);
  const hiddenCount = invites.length - shown.length;

  const lines = shown.map((inv) =>
    `**${inv.factionName}** [${inv.tag}] on **${inv.serverName}** — expires <t:${Math.floor(inv.expiresAt.getTime() / 1000)}:R>`,
  );
  if (hiddenCount > 0) {
    // Disclosed, not silently dropped: accepting or declining one of the
    // shown invites is what makes the next one visible.
    lines.push(`...and ${hiddenCount} more not shown. Accept or decline one of these to see the rest.`);
  }

  return {
    content: ["Your pending invitations:", ...lines].join("\n"),
    ephemeral: true,
    prompt: { kind: "list-invites", invites: shown.map((inv) => ({ id: inv.id, tag: inv.tag })), hiddenCount },
  };
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
  if (outcome === "link-changed") {
    return reply("The character you had linked when that invitation was sent is no longer the one you're linked to. Ask for a fresh invite.");
  }
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

export type RoleTargetInput = { serverId: number | null; targetDiscordId: string };

/**
 * The store owns every precondition (permission and the untouchable-leader
 * target) because they're re-checked at write time — see
 * `PgRosterStore.setRole`. This handler only maps outcomes to messages.
 */
export async function handleFactionPromote(
  deps: RosterDeps,
  actorDiscordId: string,
  input: RoleTargetInput,
): Promise<RosterReply> {
  const ctx = resolveServerContext(await deps.store.membershipsFor(actorDiscordId), input.serverId);
  if (ctx.kind !== "ok") return contextRefusal(ctx);
  const { membership } = ctx;

  const outcome = await deps.store.setRole({
    factionId: membership.factionId,
    actorDiscordId,
    targetDiscordId: input.targetDiscordId,
    role: "officer",
  });

  if (outcome === "not-leader") return reply("Only the leader can promote.");
  if (outcome === "target-not-member") return reply(`**${mention(input.targetDiscordId)}** is not in **${membership.factionName}**.`);
  if (outcome === "cannot-target-leader") return reply("The leader doesn't need promoting.");

  return reply(`**${mention(input.targetDiscordId)}** is now an officer in **${membership.factionName}**.`);
}

export async function handleFactionDemote(
  deps: RosterDeps,
  actorDiscordId: string,
  input: RoleTargetInput,
): Promise<RosterReply> {
  const ctx = resolveServerContext(await deps.store.membershipsFor(actorDiscordId), input.serverId);
  if (ctx.kind !== "ok") return contextRefusal(ctx);
  const { membership } = ctx;

  const outcome = await deps.store.setRole({
    factionId: membership.factionId,
    actorDiscordId,
    targetDiscordId: input.targetDiscordId,
    role: "member",
  });

  if (outcome === "not-leader") return reply("Only the leader can demote.");
  if (outcome === "target-not-member") return reply(`**${mention(input.targetDiscordId)}** is not in **${membership.factionName}**.`);
  if (outcome === "cannot-target-leader") return reply("You can't demote the leader. Use `/faction transfer` first.");

  return reply(`**${mention(input.targetDiscordId)}** is now a member in **${membership.factionName}**.`);
}

/**
 * Never calls the store: §6 requires confirmation before leadership
 * actually changes hands, so this only validates the actor is the leader
 * and hands back a `confirm-transfer` prompt. The store call happens on the
 * button, in Task 9's routing.
 */
export async function handleFactionTransfer(
  deps: RosterDeps,
  actorDiscordId: string,
  input: RoleTargetInput,
): Promise<RosterReply> {
  const ctx = resolveServerContext(await deps.store.membershipsFor(actorDiscordId), input.serverId);
  if (ctx.kind !== "ok") return contextRefusal(ctx);
  const { membership } = ctx;

  if (membership.role !== "leader") {
    return reply("Only the leader can transfer leadership.");
  }

  return {
    content: `Transfer leadership of **${membership.factionName}** to **${mention(input.targetDiscordId)}**? This cannot be undone by you alone.`,
    ephemeral: true,
    prompt: { kind: "confirm-transfer", factionId: membership.factionId, targetDiscordId: input.targetDiscordId },
  };
}

/**
 * Never calls the store, for the same reason as `handleFactionTransfer`:
 * disbanding is irreversible, so it needs confirmation before it happens.
 * The store call happens on the button, in Task 9's routing.
 */
export async function handleFactionDisband(
  deps: RosterDeps,
  actorDiscordId: string,
  serverId: number | null,
): Promise<RosterReply> {
  const ctx = resolveServerContext(await deps.store.membershipsFor(actorDiscordId), serverId);
  if (ctx.kind !== "ok") return contextRefusal(ctx);
  const { membership } = ctx;

  if (membership.role !== "leader") {
    return reply("Only the leader can disband the faction.");
  }

  return {
    content: `Disband **${membership.factionName}**? This releases its flag, tag and pole and cannot be undone.`,
    ephemeral: true,
    prompt: { kind: "confirm-disband", factionId: membership.factionId },
  };
}

export type RenameInput = { serverId: number | null; name: string };

/**
 * Control characters (`\p{Cc}` — things like NUL and other non-printables —
 * and `\p{Cf}` — format characters such as zero-width joiners and
 * bidi-override marks that can visually spoof other text) are rejected
 * because §10 derives channel names from the tag or id, never the raw
 * faction name — this validation exists to keep the *displayed* name sane,
 * not to protect a channel name that never touches it.
 */
const CONTROL_CHARS = /[\p{Cc}\p{Cf}]/u;

export async function handleFactionRename(
  deps: RosterDeps,
  actorDiscordId: string,
  input: RenameInput,
): Promise<RosterReply> {
  const ctx = resolveServerContext(await deps.store.membershipsFor(actorDiscordId), input.serverId);
  if (ctx.kind !== "ok") return contextRefusal(ctx);
  const { membership } = ctx;

  const name = input.name.trim();
  if (name.length < 3 || name.length > 64) {
    return reply("Faction names must be 3-64 characters.");
  }
  if (CONTROL_CHARS.test(name)) {
    return reply("Faction names can't contain control characters.");
  }

  const at = deps.now();
  const outcome = await deps.store.rename({
    factionId: membership.factionId,
    discordId: actorDiscordId,
    name,
    at,
    notBefore: new Date(at.getTime() - deps.renameCooldownMs),
  });

  if (outcome === "not-leader") return reply("Only the leader can rename the faction.");
  if (outcome === "cooldown") return reply("Your faction was renamed too recently — try again later.");

  return reply(`Your faction is now named **${name}**.`);
}

/**
 * Shared by `handleFactionInfo` and `handleFactionRoster`: with a name, look
 * that faction up directly (no membership check — either command can be
 * pointed at a faction the caller isn't in). Without one, fall back to the
 * caller's own membership via `resolveServerContext`.
 *
 * ⚠️ The missing membership check is DELIBERATE and was reconfirmed on
 * 2026-09-02. Who flies which flag is public by design — it is what makes an
 * identity worth holding — so anyone may read any faction's roster. The
 * private thing is the POLE, and `handleFactionInfo` gates those coordinates
 * to members separately. Do not "harden" this into a membership check; the
 * asymmetry is the design.
 */
async function findFactionCard(
  deps: RosterDeps,
  discordId: string,
  name: string | null,
  requestedServerId: number | null,
): Promise<{ card: FactionCard } | { error: RosterReply }> {
  if (name !== null) {
    // `requestedServerId` is registered as an option on both `info` and
    // `roster`, so it has to be honoured here too — names are unique per
    // server, and answering with another server's faction is a promise the
    // command visibly breaks.
    const card = await deps.store.factionByName(name, requestedServerId);
    return card ? { card } : { error: reply(`No faction named **${name}**.`) };
  }

  const ctx = resolveServerContext(await deps.store.membershipsFor(discordId), requestedServerId);
  if (ctx.kind === "no-faction") return { error: reply("You are not in a faction. Name one to look it up.") };
  if (ctx.kind === "not-on-server") return { error: reply("You don't hold a faction on that server.") };
  if (ctx.kind === "ambiguous") return { error: reply("You're in a faction on more than one server — name one, or pick a server.") };

  const card = await deps.store.factionById(ctx.membership.factionId);
  return card ? { card } : { error: reply("Your faction could not be found.") };
}

export async function handleFactionInfo(
  deps: RosterDeps,
  discordId: string,
  name: string | null,
  serverId: number | null = null,
): Promise<RosterReply> {
  const found = await findFactionCard(deps, discordId, name, serverId);
  if ("error" in found) return found.error;
  const { card } = found;

  // ⚠️ The pole line is shown to members of THIS faction only. It is the
  // faction's base coordinates — a raid target — and `info` takes a name, so
  // without this check any player could read any faction's coordinates off
  // `/faction info name:<rival>`. Making the reply ephemeral hid that from the
  // channel; it did not stop the caller from asking.
  const isMember = (await deps.store.membershipsFor(discordId)).some((m) => m.factionId === card.id);

  const founded = `<t:${Math.floor(card.createdAt.getTime() / 1000)}:D>`;
  return reply([
    `**${card.name}** [${card.tag}] — ${card.serverName}`,
    `Flag: ${card.texture}`,
    `Status: ${card.status}`,
    `Members: ${card.memberCount}`,
    ...(isMember ? [`Pole: ${card.poleKey}`] : []),
    `Founded: ${founded}`,
  ].join("\n"));
}

const ROLE_LABELS = [["leader", "Leader"], ["officer", "Officers"], ["member", "Members"]] as const;

export async function handleFactionRoster(
  deps: RosterDeps,
  discordId: string,
  name: string | null,
  serverId: number | null = null,
): Promise<RosterReply> {
  const found = await findFactionCard(deps, discordId, name, serverId);
  if ("error" in found) return found.error;
  const { card } = found;

  const roster = await deps.store.rosterOf(card.id);
  const lines = [`**${card.name}** [${card.tag}] roster (${roster.length}):`];
  for (const [role, label] of ROLE_LABELS) {
    const entries = roster.filter((e) => e.role === role);
    if (entries.length === 0) continue;
    lines.push(`**${label}**`);
    for (const entry of entries) {
      // The gamertag is null when a member's identity link was removed
      // (see `PgRosterStore.rosterOf`) — falling back to the mention keeps
      // them visible on their own faction's roster instead of vanishing.
      lines.push(`- ${entry.gamertag ?? mention(entry.discordId)}`);
    }
  }
  return reply(lines.join("\n"));
}
