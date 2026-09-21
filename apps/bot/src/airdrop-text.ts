/** Discord's <t:…:R> counts down by itself, in each reader's own timezone. */
function countdown(d: Date): string {
  return `<t:${Math.floor(d.getTime() / 1000)}:R>`;
}

const place = (location: string) => location.charAt(0).toUpperCase() + location.slice(1);

/**
 * The one player-facing message, posted at decision time (spec §8).
 *
 * ⚠️ The location, never the colour. The colour is the gamble (spec §3.4), and a
 * clan holding the wrong key opening nothing is the intent, not a bug.
 *
 * ⚠️ No em dashes, and nothing that talks anybody out of going for it.
 */
export function airdropText(location: string, slotAt: Date): string {
  return [
    `**Airdrop inbound: ${place(location)}**`,
    `A locked container drops at ${place(location)} when the server comes back up, ${countdown(slotAt)}.`,
    "We are not saying which colour. Bring your keys.",
    "It is gone at the restart after that.",
  ].join("\n");
}

/**
 * Posted when a decided drop could not be placed and has been scrubbed (spec §9).
 * Posted by `airdrop-tick.ts`, which owns the channel; see `scrubStep` for why it
 * is not posted by the tick that marks the row.
 *
 * ⚠️ Plain, and it does not talk anybody out of the next one. Players were told to
 * bring their keys somewhere, so they are owed a straight answer, not an apology.
 * No em dashes, and still no colour.
 */
export function scrubText(location: string): string {
  return [
    `**The ${place(location)} drop is off.**`,
    "We could not get it placed this session. Nothing was spent on it, so the next one can come any day.",
  ].join("\n");
}
