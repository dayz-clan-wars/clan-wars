import type { RosterStore } from "./roster-store.js";
import type { RosterReply } from "./roster-commands.js";
import { resolveServerContext } from "./roster-context.js";
import type { RebindStore } from "./rebind-store.js";
import {
  selectCandidates, cooldownRemainingMs, REBIND_WINDOW_MS, RELEASE_GRACE_MS,
} from "./rebind.js";

export type RebindDeps = {
  store: RosterStore;
  rebindStore: RebindStore;
  now: () => Date;
  rebindCooldownMs: number;
};

const reply = (content: string): RosterReply => ({ content, ephemeral: true });

const DAY_MS = 86_400_000;
const days = (ms: number) => Math.round(ms / DAY_MS);

/**
 * What a leader is told when no raise qualifies.
 *
 * ⚠️ Names all three requirements rather than reporting "not found". The most
 * likely mistake is raising `Flag_White` out of habit — the founding ritual
 * asks for it and rebind does not — and that mistake is invisible to the
 * player, because from their side they did raise a flag at a new pole.
 */
const noCandidate = (texture: string): string =>
  `No pole to move to yet. A member of your roster has to raise **${texture}** — ` +
  "your own flag, not the white one — at a flagpole **nobody holds**, and then " +
  "run this within the hour. If they raised it just now, wait for the next log " +
  "sweep and try again.";

export async function handleFactionRebind(
  deps: RebindDeps,
  actorDiscordId: string,
  serverId: number | null,
): Promise<RosterReply> {
  const ctx = resolveServerContext(await deps.store.membershipsFor(actorDiscordId), serverId);
  if (ctx.kind === "no-faction") return reply("You are not in a faction.");
  if (ctx.kind === "not-on-server") return reply("You don't hold a faction on that server.");
  if (ctx.kind === "ambiguous") return reply("You're in a faction on more than one server — say which one.");

  const { membership } = ctx;
  if (membership.role !== "leader") return reply("Only the leader can move the faction's base.");

  const faction = await deps.rebindStore.factionFor(membership.factionId);
  if (!faction) return reply("That faction no longer exists.");

  if (faction.status === "reserved") {
    return reply("Your faction is not active yet — raise your flag at the pole you claimed first.");
  }
  if (faction.status !== "active" && faction.status !== "dormant") {
    return reply("That faction is no longer holding a pole.");
  }

  const now = deps.now();
  const remaining = cooldownRemainingMs(faction.reboundAt, now, deps.rebindCooldownMs);
  if (remaining > 0) {
    const when = new Date(now.getTime() + remaining);
    return reply(
      `Your faction moved too recently. You can move again after <t:${Math.floor(when.getTime() / 1000)}:D>.`,
    );
  }

  const raises = await deps.rebindStore.qualifyingRaises(
    faction, new Date(now.getTime() - REBIND_WINDOW_MS));
  const candidates = selectCandidates(raises, { currentPoleKey: faction.poleKey, now });

  if (candidates.length === 0) return reply(noCandidate(faction.texture));

  if (candidates.length > 1) {
    // ⚠️ No button when the choice is ambiguous. A rebind is irreversible for
    // 7 days and moves a base a rival may already be watching; picking one of
    // several poles on the leader's behalf is not a guess worth making.
    const list = candidates.map((c) => `• \`${c.poleKey}\` — raised by **${c.gamertag}**`).join("\n");
    return reply(
      `Your roster raised **${faction.texture}** at more than one free pole in the last hour:\n${list}\n` +
      "Lower the flags you don't want to move to, then run this again.",
    );
  }

  const only = candidates[0]!;
  return {
    content:
      `Move **${faction.name}** [${faction.tag}] to \`${only.poleKey}\`? ` +
      `Raised by **${only.gamertag}**.\n` +
      `Your old base stays private for **${days(RELEASE_GRACE_MS)} days** after the move, ` +
      `and you won't be able to move again for **${days(deps.rebindCooldownMs)} days**.`,
    ephemeral: true,
    prompt: { kind: "confirm-rebind", factionId: faction.id, poleKey: only.poleKey },
  };
}

/**
 * The confirming button.
 *
 * ⚠️ Re-derives the candidate rather than trusting the custom id. The button
 * carries a pole key from a reply that may be minutes old, and in between the
 * raise can age out of the window or the pole can be claimed by someone else.
 */
export async function handleRebindConfirm(
  deps: RebindDeps,
  actorDiscordId: string,
  factionId: number,
  poleKey: string,
): Promise<RosterReply> {
  const faction = await deps.rebindStore.factionFor(factionId);
  if (!faction) return reply("That faction no longer exists.");

  const now = deps.now();
  const raises = await deps.rebindStore.qualifyingRaises(
    faction, new Date(now.getTime() - REBIND_WINDOW_MS));
  const candidate = selectCandidates(raises, { currentPoleKey: faction.poleKey, now })
    .find((c) => c.poleKey === poleKey);

  if (!candidate) {
    return reply("That pole is no longer available to move to. Raise your flag there again and retry.");
  }

  const moved = await deps.rebindStore.rebind({
    factionId,
    leaderDiscordId: actorDiscordId,
    expectedPoleKey: faction.poleKey,
    poleKey: candidate.poleKey,
    x: candidate.x, y: candidate.y, z: candidate.z,
    at: now,
    notBefore: new Date(now.getTime() - deps.rebindCooldownMs),
  });

  // ⚠️ The store reports whether it actually moved a row, and this must not
  // claim success when it did not — the guard catches a lost race, a
  // concurrent demotion, and the cooldown alike.
  if (!moved) {
    return reply("Your base could not be moved — you may no longer be the leader, or another move just landed.");
  }

  return reply(
    `**${faction.name}** [${faction.tag}] has moved to \`${candidate.poleKey}\`. ` +
    `Your old base stays private for **${days(RELEASE_GRACE_MS)} days** — move your loot.`,
  );
}
