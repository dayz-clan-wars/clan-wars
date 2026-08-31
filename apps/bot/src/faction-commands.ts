import { isClaimableFlag } from "@factions/domain";
import type { Participant } from "./ceremony-store.js";
import type { FactionStore } from "./faction-store.js";

export type ClaimDraftInput = { name: string; tag: string; texture: string };
export type ClaimPrompt = {
  kind: "claim-confirm";
  ceremonyId: number;
  participants: Participant[];
  draft: ClaimDraftInput;
};
export type FactionReply = { content: string; ephemeral: true; prompt?: ClaimPrompt };

export type FactionDeps = {
  store: FactionStore;
  now: () => Date;
  reservationTtlMs: number;
};

const reply = (content: string): FactionReply => ({ content, ephemeral: true });

const TAG_RE = /^[A-Za-z0-9]{2,5}$/u;

export async function handleFactionClaim(
  deps: FactionDeps,
  discordId: string,
  input: ClaimDraftInput,
): Promise<FactionReply> {
  const ceremony = await deps.store.openCeremonyFor(discordId);
  // §5: the claimant's linked UID must be among the participants. Because
  // participants are linked by construction, this is a lookup rather than a
  // trust decision.
  if (!ceremony) return reply("You have no ceremony to claim. Only someone counted in a witnessed ceremony can found a faction.");

  if (!isClaimableFlag(input.texture)) {
    return reply(`\`${input.texture}\` is not a claimable flag. The neutral flag is reserved, and only the 33 pool flags can be held.`);
  }
  if (!TAG_RE.test(input.tag)) {
    return reply("A tag must be 2-5 letters or digits — it becomes part of channel names.");
  }
  if (await deps.store.textureHeld(ceremony.serverId, input.texture)) {
    return reply(`\`${input.texture}\` is already taken on this server. Pick another.`);
  }

  await deps.store.saveDraft(ceremony.id, discordId, input, deps.now());
  return {
    content: `Founding **${input.name}** [${input.tag}] under \`${input.texture}\`. Confirm who belongs on the founding roster — remove anyone who wandered into the ceremony.`,
    ephemeral: true,
    prompt: { kind: "claim-confirm", ceremonyId: ceremony.id, participants: ceremony.participants, draft: input },
  };
}

export async function handleClaimConfirm(
  deps: FactionDeps,
  discordId: string,
  ceremonyId: number,
  keepDayzIds: string[],
): Promise<FactionReply> {
  // ⚠️ Fetched BY ID, not re-derived from the user. The confirm's custom id
  // names the ceremony the draft was written against, and a claimant can be a
  // participant in more than one open ceremony — re-deriving could return the
  // other one and report "already claimed or expired" about a ceremony that is
  // neither, on every retry. The store still checks the caller is on this
  // ceremony's participant list, which is the §5 defense that mattered.
  const ceremony = await deps.store.openCeremonyByIdFor(ceremonyId, discordId);
  if (!ceremony) return reply("That ceremony has already been claimed or has expired.");

  const draft = await deps.store.loadDraft(ceremonyId, discordId);
  if (!draft) return reply("That claim expired. Run `/faction claim` again.");

  const keep = new Set(keepDayzIds);
  const members = ceremony.participants.filter((p) => keep.has(p.dayzId));
  // The leader must be on their own roster, or the faction is created with no
  // one able to act for it.
  if (!members.some((m) => m.discordId === discordId)) {
    return reply("You cannot remove yourself from your own founding roster.");
  }

  const at = deps.now();
  const outcome = await deps.store.reserve({
    ceremonyId, serverId: ceremony.serverId, poleKey: ceremony.poleKey,
    x: ceremony.x, y: ceremony.y, z: ceremony.z,
    name: draft.name, tag: draft.tag, texture: draft.texture,
    leaderDiscordId: discordId,
    members: members.map((m) => ({ dayzId: m.dayzId, discordId: m.discordId })),
    at, reservedUntil: new Date(at.getTime() + deps.reservationTtlMs),
  });

  if (outcome === "ceremony-taken") return reply("That ceremony has already been claimed.");
  if (outcome === "flag-taken") return reply(`\`${draft.texture}\` was just taken by another faction. Run \`/faction claim\` again with a different flag.`);
  if (outcome === "tag-taken") return reply(`The tag \`${draft.tag}\` was just taken. Run \`/faction claim\` again with a different tag.`);
  if (outcome === "pole-taken") return reply("That pole already belongs to a faction. Run `/faction claim` again once it lapses or disbands.");

  return reply([
    `**${draft.name}** [${draft.tag}] is **reserved**.`,
    "",
    `Raise \`${draft.texture}\` at your pole to bring the faction to life. Any member of the roster can do it.`,
    // DayZ logs a raise only on the raise TRANSITION, so a flag left flying
    // produces no event and the faction silently never activates.
    "If a flag is already up on that pole, **lower it first** — only the act of raising is recorded.",
    "If the flag is not up within 24 hours the reservation lapses and the flag returns to the pool.",
  ].join("\n"));
}
