import type { VerificationStore } from "@factions/verification";

/**
 * ⚠️ Every reply is ephemeral. A challenge sequence posted publicly is a
 * challenge anyone reading the channel can perform, which would let a bystander
 * bind their own UID to someone else's Discord account.
 */
export type { Reply } from "./commands/types.js";

export type CommandDeps = {
  store: VerificationStore;
  now: () => Date;
};
