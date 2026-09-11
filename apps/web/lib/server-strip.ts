import type { LiveServer } from "@factions/roster";

/**
 * Every word the server strip says. The name itself is Nitrado's, verbatim:
 * it is what players type into the DayZ browser, so nothing here may trim,
 * case or decorate it.
 */
export const SERVER_STRIP = { label: "Server name:" } as const;

export type ServerStripLine = string;

/** One marquee line per live server. */
export function serverStripLines(servers: readonly LiveServer[]): ServerStripLine[] {
  return servers.map((s) => `${SERVER_STRIP.label} ${s.hostname}`);
}

/** The line split for styling: the label in muted, the name in gold. */
export function splitLine(line: ServerStripLine): { label: string; name: string } {
  const label = SERVER_STRIP.label;
  return line.startsWith(label) ? { label, name: line.slice(label.length).trim() } : { label: "", name: line };
}

/**
 * How long one pass of the marquee takes: proportional to the line's length
 * so a long name and a short one cross the screen at the same reading
 * speed, with a floor so a short one does not whip past.
 */
export function marqueeSeconds(line: string): number {
  return Math.max(12, Math.round(line.length * 0.25));
}
