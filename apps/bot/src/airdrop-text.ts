import { rel } from "@factions/copy";

/**
 * The one player-facing message, posted at decision time (spec §8).
 *
 * ⚠️ The location, never the colour. The colour is the gamble (spec §3.4), and a
 * clan holding the wrong key opening nothing is the intent, not a bug. The message
 * does not mention the colour AND does not mention that it is being withheld:
 * naming the omission is still talking about it.
 *
 * ⚠️ Military-comms register, two lines, no more. Earlier drafts explained the
 * restart ("a locked container drops when the server comes back up") and read as
 * if the server were down at posting time — it is not, this posts 30 minutes
 * BEFORE the restart. The countdown token carries the timing on its own.
 */
export function airdropText(location: string, slotAt: Date): string {
  return [
    `**AIRDROP INBOUND: ${location.toUpperCase()}**`,
    `ETA ${rel(slotAt) ?? "the next restart"}. Bring keys.`,
  ].join("\n");
}

/**
 * Posted when a decided drop could not be placed and has been scrubbed (spec §9).
 * Posted by `airdrop-tick.ts`, which owns the channel; see `scrubStep` for why it
 * is not posted by the tick that marks the row.
 *
 * ⚠️ Plain, and it does not talk anybody out of the next one. Players were told to
 * bring their keys somewhere, so they are owed a straight answer, not an apology.
 * Still no colour.
 */
export function scrubText(location: string): string {
  return [
    `**AIRDROP SCRUBBED: ${location.toUpperCase()}**`,
    "Cargo did not deploy. Next one can come any day.",
  ].join("\n");
}
