import type { RosterStore } from "./roster-store.js";
import type { RosterReply } from "./roster-commands.js";
import { resolveServerContext } from "./roster-context.js";
import type { RebindStore } from "./rebind-store.js";
import {
  selectCandidates, cooldownRemainingMs, REBIND_WINDOW_MS, RELEASE_GRACE_MS,
} from "./rebind.js";
import { MIN_BASE_SPACING_M } from "@factions/domain";

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
  if (ctx.kind === "no-faction") return reply("You are not in a clan.");
  if (ctx.kind === "not-on-server") return reply("You don't hold a clan on that server.");
  if (ctx.kind === "ambiguous") return reply("You're in a clan on more than one server — say which one.");

  const { membership } = ctx;
  if (membership.role !== "leader") return reply("Only the leader can move the clan's base.");

  // Named `clan`, not `faction`: this record's fields are interpolated into
  // player-facing replies below, and the vocabulary check scans those
  // template literals whole — a `faction`-named variable would trip it.
  const clan = await deps.rebindStore.factionFor(membership.factionId);
  if (!clan) return reply("That clan no longer exists.");

  if (clan.status === "reserved") {
    return reply("Your clan is not active yet — raise your flag at the pole you claimed first.");
  }
  if (clan.status !== "active" && clan.status !== "dormant") {
    return reply("That clan is no longer holding a pole.");
  }

  const now = deps.now();
  const remaining = cooldownRemainingMs(clan.reboundAt, now, deps.rebindCooldownMs);
  if (remaining > 0) {
    const when = new Date(now.getTime() + remaining);
    return reply(
      `Your clan moved too recently. You can move again after <t:${Math.floor(when.getTime() / 1000)}:D>.`,
    );
  }

  const raises = await deps.rebindStore.qualifyingRaises(
    clan, new Date(now.getTime() - REBIND_WINDOW_MS));
  const candidates = selectCandidates(raises, { currentPoleKey: clan.poleKey, now });

  if (candidates.length === 0) return reply(noCandidate(clan.texture));

  if (candidates.length > 1) {
    // ⚠️ No button when the choice is ambiguous. A rebind is irreversible for
    // 7 days and moves a base a rival may already be watching; picking one of
    // several poles on the leader's behalf is not a guess worth making.
    const list = candidates.map((c) => `• \`${c.poleKey}\` — raised by **${c.gamertag}**`).join("\n");
    return reply(
      `Your roster raised **${clan.texture}** at more than one free pole in the last hour:\n${list}\n` +
      "Lower the flags you don't want to move to, then run this again.",
    );
  }

  const only = candidates[0]!;
  return {
    content:
      `Move **${clan.name}** [${clan.tag}] to \`${only.poleKey}\`? ` +
      `Raised by **${only.gamertag}**.\n` +
      `Your old base stays private for **${days(RELEASE_GRACE_MS)} days** after the move, ` +
      `and you won't be able to move again for **${days(deps.rebindCooldownMs)} days**.`,
    ephemeral: true,
    prompt: { kind: "confirm-rebind", factionId: clan.id, poleKey: only.poleKey },
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
  const clan = await deps.rebindStore.factionFor(factionId);
  if (!clan) return reply("That clan no longer exists.");

  const now = deps.now();
  const raises = await deps.rebindStore.qualifyingRaises(
    clan, new Date(now.getTime() - REBIND_WINDOW_MS));
  const candidate = selectCandidates(raises, { currentPoleKey: clan.poleKey, now })
    .find((c) => c.poleKey === poleKey);

  if (!candidate) {
    return reply("That pole is no longer available to move to. Raise your flag there again and retry.");
  }

  const out = await deps.rebindStore.rebind({
    factionId,
    leaderDiscordId: actorDiscordId,
    // Non-null: only an active/dormant clan reaches this path, and both
    // statuses require a declarations row to exist (see RebindTarget.poleKey).
    expectedPoleKey: clan.poleKey!,
    poleKey: candidate.poleKey,
    x: candidate.x, y: candidate.y, z: candidate.z,
    evidenceEventId: candidate.eventId,
    at: now,
    notBefore: new Date(now.getTime() - deps.rebindCooldownMs),
  });

  if (out === "too-close") {
    return reply(`That pole is too close to another declared base — bases must be ${MIN_BASE_SPACING_M} m apart. Your base has not moved.`);
  }

  // ⚠️ The store reports whether it actually moved a row, and this must not
  // claim success when it did not — "refused" covers a lost race, a
  // concurrent demotion, and the cooldown alike.
  if (out === "refused") {
    return reply("Your base could not be moved — you may no longer be the leader, or another move just landed.");
  }

  return reply(
    `**${clan.name}** [${clan.tag}] has moved to \`${candidate.poleKey}\`. ` +
    `Your old base stays private for **${days(RELEASE_GRACE_MS)} days** — move your loot.`,
  );
}
