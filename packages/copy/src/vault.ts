import { VAULT_CODE_DIGITS, VAULT_NAME_MAX, VAULT_NOTE_MAX } from "@factions/domain";
import type { ActorRefusal } from "@factions/roster";
import { REFUSAL, INPUT } from "./clan";

/**
 * Vault copy (spec §4.9/§10.2), built the same way `leadership.ts` builds
 * `LEADERSHIP_TABLES` — one `Record<Outcome, string>` table per action,
 * `REFUSAL` spread in.
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
export const VAULT_TABLES = { add: ADD, edit: EDIT, delete: DELETE, rotate: ROTATE, confirm: CONFIRM, reveal: REVEAL, input: INPUT } as const;
export type VaultAction = keyof typeof VAULT_TABLES;

/**
 * What `/vault reveal` answers with on `ok`. The site's reveal button gets
 * the raw code as JSON and paints it behind a tap; Discord has no tap, so
 * the sentence carries the warning instead.
 *
 * ⚠️ A code appears in exactly two places in this codebase: the
 * `vault_locks` row, and the string this function returns. Do not log it, do
 * not put it in a custom id, do not interpolate it into an embed.
 */
export const revealedCopy = (lockName: string, code: string) =>
  `**${lockName}** — \`${code}\`. Only you can see this message; do not paste it anywhere else.`;

/**
 * What a rotate answers with once it has landed. The count is the part the
 * `ROTATE.ok` table string cannot carry, and it is the part that tells a
 * leader whether "all" did what they meant.
 */
export const rotatedCopy = (n: number) =>
  `${n} lock${n === 1 ? "" : "s"} rotated. ${ROTATE.ok}`;
