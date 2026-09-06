import { emoteLabel } from "@factions/domain";
import type { VerificationStore } from "@factions/verification";

/**
 * ⚠️ Every reply is ephemeral. A challenge sequence posted publicly is a
 * challenge anyone reading the channel can perform, which would let a bystander
 * bind their own UID to someone else's Discord account.
 */
export type Reply = { content: string; ephemeral: true };

export type CommandDeps = {
  store: VerificationStore;
  now: () => Date;
};

/** Human labels, numbered. Players read an emote wheel, not a token list. */
export function formatSequence(sequence: string[]): string {
  return sequence.map((token, i) => `${i + 1}. **${emoteLabel(token) ?? token}**`).join("\n");
}
