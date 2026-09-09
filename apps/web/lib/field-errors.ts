import { lookupCopy } from "./copy-lookup";

/**
 * Which form field a result code is about. Every action on the site is a
 * form POST that comes back as one `?result=<action>.<outcome>` code; most
 * outcomes are about the whole action (a cooldown, a cap, authority) and
 * belong in the page's notice. The ones here are about ONE field the player
 * typed or picked — so the page can mark that field invalid, put the
 * sentence under it, and move focus to it, instead of leaving the player to
 * find which of four fields the notice at the top meant.
 *
 * Keys are the codes, values the field's `name` attribute. A null-prototype
 * object, same reasoning as RESULT_COPY: the code is attacker-supplied.
 */
export const FIELD_FOR: Record<string, string> = Object.assign(Object.create(null), {
  "rename.bad-name": "name", "rename.name-taken": "name", "rename.name-held": "name",
  "rename.bad-tag": "tag", "rename.tag-taken": "tag", "rename.tag-held": "tag",
  "claim.bad-name": "name", "claim.name-taken": "name", "claim.name-held": "name",
  "claim.bad-tag": "tag", "claim.tag-taken": "tag", "claim.tag-held": "tag",
  "claim.bad-flag": "texture", "claim.flag-taken": "texture",
  "claim.bad-roster": "member",
  "invite.invitee-not-linked": "gamertag", "invite.ambiguous-gamertag": "gamertag",
  "guest.target-not-linked": "target", "guest.ambiguous-gamertag": "target",
  "add.bad-name": "name", "add.bad-note": "note", "add.bad-code": "code",
});

export type FieldError = { field: string; message: string };

/** The field error a result code carries, if it is about one field and the copy table knows it. */
export function fieldError(result: string | undefined, copy: Record<string, string>): FieldError | null {
  if (!result) return null;
  const field = lookupCopy(FIELD_FOR, result);
  const message = lookupCopy(copy, result);
  return field && message ? { field, message } : null;
}
