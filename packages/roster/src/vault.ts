import type { Database } from "@factions/db";
import {
  addLockDb, editLockDb, deleteLockDb, revealLockDb, rotateLocksDb, confirmLockDb, vaultStateDb,
  VAULT_NAME_MAX, VAULT_NOTE_MAX,
  type AddLockOutcome, type EditLockOutcome, type DeleteLockOutcome, type RevealLockOutcome, type RotateLocksOutcome, type ConfirmLockOutcome,
  type VaultState, type VaultLockView, type VaultHistoryRow, type VaultActor, type Role,
} from "./internal";
import { actorFor, isRefusal, type Actor, type ActorRefusal } from "./actor";

export { VAULT_NAME_MAX, VAULT_NOTE_MAX };
export type { VaultState, VaultLockView, VaultHistoryRow };

/**
 * `VaultActor` built from the `Actor` `actorFor` resolves — same field
 * names. Trusted for nothing but `factionId`/`discordId`: `addLockDb` and
 * its siblings re-derive `role`/`dayzId` fresh, inside their own
 * transaction, from `faction_members` (see `vault-store.ts`'s note).
 */
const vaultActorFrom = (a: Actor): VaultActor => ({ factionId: a.factionId, serverId: a.serverId, dayzId: a.dayzId, discordId: a.discordId, role: a.role });

/** Your clan's vault: locks your rank may see, and — leader only — its history. Never a code. */
export async function vaultForDb(db: Database, actorDiscordId: string): Promise<VaultState | ActorRefusal> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  return vaultStateDb(db, vaultActorFrom(a));
}

/** Add a vault lock. Officer+ only. */
export async function addLockDbFor(
  db: Database, now: Date, actorDiscordId: string, r: { name: string; note: string | null; minRole: Role; code?: string },
): Promise<{ outcome: AddLockOutcome | ActorRefusal; lockId: number | null }> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return { outcome: a, lockId: null };
  return addLockDb(db, vaultActorFrom(a), { ...r, at: now });
}

/** Rename/re-describe/re-gate a lock. Officer+ only; the code is untouched. */
export async function editLockDbFor(
  db: Database, now: Date, actorDiscordId: string, r: { lockId: number; name: string; note: string | null; minRole: Role },
): Promise<EditLockOutcome | ActorRefusal> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  return editLockDb(db, vaultActorFrom(a), { ...r, at: now });
}

/** Delete a lock. Officer+ only. */
export async function deleteLockDbFor(db: Database, now: Date, actorDiscordId: string, lockId: number): Promise<DeleteLockOutcome | ActorRefusal> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  return deleteLockDb(db, vaultActorFrom(a), { lockId, at: now });
}

/** Reveal a lock's code. Any rank meeting the lock's `min_role`. */
export async function revealLockDbFor(
  db: Database, now: Date, actorDiscordId: string, lockId: number,
): Promise<{ outcome: RevealLockOutcome | ActorRefusal; code: string | null }> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return { outcome: a, code: null };
  return revealLockDb(db, vaultActorFrom(a), { lockId, at: now });
}

/** Rotate one lock's code, or every lock (`lockId: "all"`). Officer+ only. */
export async function rotateLocksDbFor(
  db: Database, now: Date, actorDiscordId: string, lockId: number | "all",
): Promise<{ outcome: RotateLocksOutcome | ActorRefusal; rotated: number }> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return { outcome: a, rotated: 0 };
  return rotateLocksDb(db, vaultActorFrom(a), { lockId, at: now });
}

/** Confirm a lock's code was changed in-game. Any rank meeting the lock's `min_role`. */
export async function confirmLockDbFor(db: Database, now: Date, actorDiscordId: string, lockId: number): Promise<ConfirmLockOutcome | ActorRefusal> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return a;
  return confirmLockDb(db, vaultActorFrom(a), { lockId, at: now });
}
