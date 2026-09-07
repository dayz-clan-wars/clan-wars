import {
  ACTIVATION_WINDOW_MS, CLAN_NAME_LENGTH, CLAN_SIZE_CAP, CLAN_TAG_LENGTH, JOIN_PRESENCE_RADIUS_M, MIN_BASE_SPACING_M,
  PENDING_EXPIRY_MS, REBIND_COOLDOWN_MS, RELEASED_POLE_GRACE_MS, RENAME_COOLDOWN_MS, ROSTER_COOLDOWN_MS,
} from "@factions/domain";
import type {
  ActorRefusal, InviteOutcome, AcceptInviteOutcome, RequestJoinOutcome, DecideRequestOutcome, LeaveOutcome, KickOutcome,
  SetRoleOutcome, TransferOutcome, RenameOutcome, ReserveOutcome,
} from "@factions/roster";
import { days } from "./format";

/** Exported so pages that read an `ActorRefusal` directly (e.g. `/clan/board`) render the same wording as every `/api/clan/*` redirect. */
export const REFUSAL: Record<ActorRefusal, string> = {
  "not-linked": "Link your character first — clan actions are taken by the character, not the Discord account.",
  "not-in-clan": "You are not in a clan.",
  "pending": `You are pending: stand within ${JOIN_PRESENCE_RADIUS_M} m of the clan's base in game to become a full member before you can act for the clan.`,
};
const INVITE: Record<InviteOutcome, string> = {
  ...REFUSAL,
  ok: "Invited. They have been told, and the invite lasts " + days(PENDING_EXPIRY_MS) + ".",
  "not-permitted": "Only an officer or the leader can invite.",
  "already-member": "That player is already in a clan.",
  cooldown: `That player left or was removed from a clan recently; they can join again after ${days(ROSTER_COOLDOWN_MS)}.`,
  "not-holding": "Your clan is not active.",
  cap: `Your clan is full — ${CLAN_SIZE_CAP} counting pending members.`,
  "invitee-not-linked": "No linked player has that gamertag. They need to link their character on the site first.",
  "ambiguous-gamertag": "More than one linked player has that gamertag, spelled with different capitals. Type it exactly as they spell it.",
};
const REVOKE: Record<"ok" | "not-permitted" | "gone" | ActorRefusal, string> = {
  ...REFUSAL, ok: "Invite withdrawn.", "not-permitted": "Only an officer or the leader can withdraw an invite.", gone: "That invite had already been answered or had expired.",
};
const ACCEPT: Record<AcceptInviteOutcome | "not-linked", string> = {
  ok: `You are in, pending: stand within ${JOIN_PRESENCE_RADIUS_M} m of the clan's base in game and the log will make you a full member. Unseen for ${days(PENDING_EXPIRY_MS)}, the spot expires.`,
  gone: "That invite had already been answered or had expired.",
  "already-member": "You are already in a clan.",
  cooldown: `You left or were removed from a clan recently; you can join again after ${days(ROSTER_COOLDOWN_MS)}.`,
  "not-holding": "That clan is no longer active.",
  "link-changed": "Your linked character changed since the invite was sent. Ask for a new one.",
  cap: `That clan is full — ${CLAN_SIZE_CAP} counting pending members.`,
  "not-linked": REFUSAL["not-linked"],
};
const DECLINE: Record<"declined" | "gone", string> = { declined: "Declined.", gone: "That invite had already been answered or had expired." };
const REQUEST: Record<RequestJoinOutcome | "not-linked" | "no-such-clan", string> = {
  ok: "Requested. The clan's officers have been told.",
  "not-recruiting": "That clan is not recruiting.",
  "not-holding": "That clan is not active.",
  "already-member": "You are already in a clan.",
  cooldown: `You left or were removed from a clan recently; you can join again after ${days(ROSTER_COOLDOWN_MS)}.`,
  cap: `That clan is full — ${CLAN_SIZE_CAP} counting pending members.`,
  "already-requested": "You already have a request open with that clan.",
  "not-linked": REFUSAL["not-linked"],
  "no-such-clan": "No clan has that tag.",
};
const WITHDRAW: Record<"withdrawn" | "gone", string> = { withdrawn: "Request withdrawn.", gone: "That request had already been decided or had expired." };
const DECIDE: Record<DecideRequestOutcome | ActorRefusal, string> = {
  ...REFUSAL,
  ok: "Done.",
  "not-permitted": "Only an officer or the leader can decide a request.",
  gone: "That request had already been decided or had expired.",
  cap: `Your clan is full — ${CLAN_SIZE_CAP} counting pending members.`,
  cooldown: `That player left or was removed from a clan recently; they can join again after ${days(ROSTER_COOLDOWN_MS)}.`,
  "link-changed": "That player's linked character changed since they asked. They need to ask again.",
  "not-recruiting": "Your clan is not recruiting. Turn recruiting on in settings to accept requests.",
};
const LEAVE: Record<LeaveOutcome | "not-in-clan" | "unconfirmed", string> = {
  ok: `You have left. You can join a clan again after ${days(ROSTER_COOLDOWN_MS)}.`,
  "not-member": "You are not in a clan.",
  "not-in-clan": "You are not in a clan.",
  "leader-must-transfer": "A leader cannot leave. Transfer leadership in settings first, or disband.",
  unconfirmed: "Tick the box to confirm before leaving.",
};
const KICK: Record<KickOutcome | ActorRefusal, string> = {
  ...REFUSAL,
  ok: `Removed. They can join a clan again after ${days(ROSTER_COOLDOWN_MS)}.`,
  "not-permitted": "Only an officer or the leader can remove a member.",
  "target-not-member": "That player is not in your clan.",
  "cannot-kick-self": "Use Leave to leave.",
  "cannot-kick-officer": "Only the leader can remove an officer. Demote them first.",
  "cannot-kick-leader": "The leader cannot be removed.",
};
const ROLE: Record<SetRoleOutcome | ActorRefusal, string> = {
  ...REFUSAL, ok: "Done.", "not-leader": "Only the leader can change ranks.", "target-not-member": "That player is not a full member of your clan.", "cannot-target-leader": "The leader's rank cannot be changed this way — transfer leadership instead.",
};
const TRANSFER: Record<TransferOutcome | ActorRefusal | "unconfirmed", string> = {
  ...REFUSAL, ok: "Leadership transferred. You are now an officer.", "not-leader": "Only the leader can transfer leadership.", "target-not-member": "That player is not a full member of your clan.", unconfirmed: "Tick the box to confirm before transferring leadership.",
};
export const DISBAND_WARNING = "The clan's text and voice channels are deleted, along with their entire history. Nothing is archived.";
const DISBAND: Record<"ok" | "not-leader" | ActorRefusal | "unconfirmed", string> = {
  ...REFUSAL,
  ok: `Disbanded. The flag and the pole are back in the pool; the name and tag are held. The pole stays private for ${days(RELEASED_POLE_GRACE_MS)}, then becomes public if nobody declares it. The clan's channels are gone.`,
  "not-leader": "Only the leader can disband the clan.",
  unconfirmed: "Tick the box to confirm before disbanding.",
};
const RENAME: Record<RenameOutcome | ActorRefusal | "bad-name" | "bad-tag", string> = {
  ...REFUSAL,
  ok: "Renamed.",
  "not-leader": "Only the leader can rename the clan.",
  cooldown: `A clan can be renamed once every ${days(RENAME_COOLDOWN_MS)}.`,
  "name-taken": "Another clan has that name.",
  "tag-taken": "Another clan has that tag.",
  "name-held": "That name belongs to a clan that renamed or disbanded and is held.",
  "tag-held": "That tag belongs to a clan that renamed or disbanded and is held.",
  unchanged: "That is already the clan's name and tag.",
  "bad-name": `A clan name is ${CLAN_NAME_LENGTH.min} to ${CLAN_NAME_LENGTH.max} characters.`,
  "bad-tag": `A tag is ${CLAN_TAG_LENGTH.min} to ${CLAN_TAG_LENGTH.max} letters or digits.`,
};
const RECRUITING: Record<"ok" | "not-permitted" | ActorRefusal, string> = { ...REFUSAL, ok: "Recruiting post saved.", "not-permitted": "Only an officer or the leader can edit the recruiting post." };
const REBIND: Record<"ok" | "refused" | "too-close" | "no-candidate" | "not-leader" | ActorRefusal, string> = {
  ...REFUSAL,
  ok: "Moved. Your base is the new pole; the old one goes public after its grace period.",
  refused: `Your clan moved its base within the last ${days(REBIND_COOLDOWN_MS)}, or has no declared base to move.`,
  "too-close": `Too close to another declared base — no two bases sit within ${MIN_BASE_SPACING_M} m of each other.`,
  "no-candidate": "No member has raised your flag at that pole recently. Raise it again and come back.",
  "not-leader": "Only the leader can confirm a move.",
};
const CLAIM: Record<ReserveOutcome | "not-linked" | "no-such-ceremony" | "bad-name" | "bad-tag" | "bad-flag" | "bad-roster", string> = {
  ok: `Reserved. Raise your flag at the pole within ${days(ACTIVATION_WINDOW_MS)} to activate the clan; until then the name, tag, flag and pole are yours alone.`,
  "ceremony-taken": "Someone at the ceremony already founded the clan.",
  "flag-taken": "That flag was taken while you were choosing. Pick another.",
  "tag-taken": "Another clan has that tag.",
  "pole-taken": "That pole is already declared by someone else.",
  "too-close": `Too close to another declared base. No two declared bases sit within ${MIN_BASE_SPACING_M} m of each other — first declared wins. The map cannot show you private bases, so this refusal is your first warning that one is nearby.`,
  "name-taken": "Another clan has that name.",
  "name-held": "That name belongs to a clan that renamed or disbanded and is held.",
  "tag-held": "That tag belongs to a clan that renamed or disbanded and is held.",
  "not-linked": REFUSAL["not-linked"],
  "no-such-ceremony": "That ceremony is not yours, or it has expired or already been claimed.",
  "bad-name": `A clan name is ${CLAN_NAME_LENGTH.min} to ${CLAN_NAME_LENGTH.max} characters.`,
  "bad-tag": `A tag is ${CLAN_TAG_LENGTH.min} to ${CLAN_TAG_LENGTH.max} letters or digits.`,
  "bad-flag": "Pick one of the free flags.",
  "bad-roster": "The roster must be people who were at the ceremony, and must include you.",
};
const INPUT: Record<"bad-input", string> = { "bad-input": "Something in that form was missing or too long. Try again." };

const TABLES = {
  invite: INVITE, revoke: REVOKE, accept: ACCEPT, decline: DECLINE, request: REQUEST, withdraw: WITHDRAW, decide: DECIDE,
  leave: LEAVE, kick: KICK, role: ROLE, transfer: TRANSFER, disband: DISBAND, rename: RENAME, recruiting: RECRUITING, rebind: REBIND, claim: CLAIM, input: INPUT,
} as const;
export type Action = keyof typeof TABLES;
export function code<A extends Action>(action: A, outcome: keyof (typeof TABLES)[A] & string): string {
  return `${action}.${outcome}`;
}

/** Every code a roster route can redirect with, flattened to "<action>.<outcome>". A null-prototype object so a query-string key cannot reach Object.prototype. */
export const RESULT_COPY: Record<string, string> = Object.assign(Object.create(null), Object.fromEntries(
  Object.entries(TABLES).flatMap(([action, table]) => Object.entries(table).map(([outcome, text]) => [`${action}.${outcome}`, text])),
));
