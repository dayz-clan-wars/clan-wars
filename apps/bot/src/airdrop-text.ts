import { rel } from "@factions/copy";

/**
 * The one player-facing message, posted at decision time (spec §8).
 *
 * ⚠️ The room, never the kind (bunker spec §2): what is inside is the gamble. The
 * message does not mention the kind AND does not mention that it is being
 * withheld: naming the omission is still talking about it.
 *
 * ⚠️ Military-comms register, two lines, no more. Earlier drafts explained the
 * restart ("a locked container drops when the server comes back up") and read as
 * if the server were down at posting time — it is not, this posts 30 minutes
 * BEFORE the restart. The countdown token carries the timing on its own.
 */
export function airdropText(roomName: string, slotAt: Date): string {
  const when = rel(slotAt);
  return [
    `**BUNKER ONLINE: ${roomName.toUpperCase()}**`,
    `${when ? `Opens at the restart, ${when}.` : "Opens at the next restart."} Bring a punched card.`,
  ].join("\n");
}

/**
 * Posted when a decided drop could not be placed and has been scrubbed (spec §9).
 * Posted by `airdrop-tick.ts`, which owns the channel; see `scrubStep` for why it
 * is not posted by the tick that marks the row.
 *
 * ⚠️ Plain, and it does not talk anybody out of the next one. Players were told to
 * bring their keys somewhere, so they are owed a straight answer, not an apology.
 * Still no kind.
 */
export function scrubText(roomName: string): string {
  return [
    `**BUNKER OFFLINE: ${roomName.toUpperCase()}**`,
    "It did not come online. The next one can come any day.",
  ].join("\n");
}
