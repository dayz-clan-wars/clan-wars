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

/** Posted when a decided drop could not be placed and has been scrubbed (spec §9). */
export function scrubText(location: string): string {
  return [
    `**The ${place(location)} drop is off.**`,
    "We could not get it placed this session. The next one still counts against nothing, so it can come any day now.",
  ].join("\n");
}
