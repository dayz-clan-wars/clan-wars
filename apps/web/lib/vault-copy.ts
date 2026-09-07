import { VAULT_CODE_DIGITS } from "@factions/domain";
import { VAULT_NAME_MAX, VAULT_NOTE_MAX, type ActorRefusal } from "@factions/roster";
import { REFUSAL } from "./clan-copy";

/**
 * Vault copy (spec §4.9/§10.2), built the same way `leadership-copy.ts`
 * builds `LEADERSHIP_RESULT_COPY` — one `Record<Outcome, string>` table per
 * action, `REFUSAL` spread in, flattened to `<action>.<outcome>` keys.
 *
 * `VAULT_NAME_MAX`/`VAULT_NOTE_MAX`/`VAULT_CODE_DIGITS` are read as plain
 * numbers here — they come from the package/domain, not re-declared — so a
 * limit change updates this copy without a second edit.
 */

/** Read once by /clan/vault above the lock list. */
export const VAULT_INTRO =
  "You see only the locks your rank unlocks. Codes are hidden behind a tap so they are not on screen in a stream. Rotating a code here does not change the lock in the game.";

const NOT_PERMITTED = "Only an officer or the leader can change the vault.";
const NOT_VISIBLE = "That lock is above your rank.";
const BAD_NAME = `A lock name is 1 to ${VAULT_NAME_MAX} characters.`;
const BAD_NOTE = `A note is up to ${VAULT_NOTE_MAX} characters.`;
const BAD_CODE = `A code is exactly ${VAULT_CODE_DIGITS} digits.`;
const GONE = "That lock no longer exists.";

const ADD: Record<"ok" | "not-permitted" | "bad-name" | "bad-note" | "bad-code" | ActorRefusal, string> = {
  ...REFUSAL,
  ok: "Lock added.",
  "not-permitted": NOT_PERMITTED,
  "bad-name": BAD_NAME,
  "bad-note": BAD_NOTE,
  "bad-code": BAD_CODE,
};
const EDIT: Record<"ok" | "not-permitted" | "gone" | "bad-name" | "bad-note" | ActorRefusal, string> = {
  ...REFUSAL,
  ok: "Saved.",
  "not-permitted": NOT_PERMITTED,
  gone: GONE,
  "bad-name": BAD_NAME,
  "bad-note": BAD_NOTE,
};
const DELETE: Record<"ok" | "not-permitted" | "gone" | "unconfirmed" | ActorRefusal, string> = {
  ...REFUSAL,
  ok: "Deleted.",
  "not-permitted": NOT_PERMITTED,
  gone: GONE,
  unconfirmed: "Tick the box to confirm before deleting.",
};
const ROTATE: Record<"ok" | "not-permitted" | "gone" | "unconfirmed" | ActorRefusal, string> = {
  ...REFUSAL,
  ok: "Rotated. Nothing changed in the game until someone goes and sets the new code on the lock — confirm it here when they have. Every member has been told to look here.",
  "not-permitted": NOT_PERMITTED,
  gone: GONE,
  unconfirmed: "Tick the box to confirm before rotating.",
};
const CONFIRM: Record<"ok" | "not-visible" | "gone" | ActorRefusal, string> = {
  ...REFUSAL,
  ok: "Confirmed. The vault no longer flags this lock as changed in game.",
  "not-visible": NOT_VISIBLE,
  gone: GONE,
};
/** `ok` is never shown — `/api/vault/reveal` sends the code itself on `ok`, never this string. Kept only so the table stays exhaustive. */
const REVEAL: Record<"ok" | "not-visible" | "gone" | ActorRefusal, string> = {
  ...REFUSAL,
  ok: "Revealed.",
  "not-visible": NOT_VISIBLE,
  gone: GONE,
};
const INPUT: Record<"bad-input", string> = { "bad-input": "Something in that form was missing or too long. Try again." };

const TABLES = { add: ADD, edit: EDIT, delete: DELETE, rotate: ROTATE, confirm: CONFIRM, reveal: REVEAL, input: INPUT } as const;
export type VaultAction = keyof typeof TABLES;
export function vaultCode<A extends VaultAction>(action: A, outcome: keyof (typeof TABLES)[A] & string): string {
  return `${action}.${outcome}`;
}

/** Every code a vault route can redirect (or, for `reveal`, respond) with, flattened to "<action>.<outcome>". A null-prototype object, same reasoning as `RESULT_COPY`. */
export const VAULT_RESULT_COPY: Record<string, string> = Object.assign(Object.create(null), Object.fromEntries(
  Object.entries(TABLES).flatMap(([action, table]) => Object.entries(table).map(([outcome, text]) => [`${action}.${outcome}`, text])),
));
