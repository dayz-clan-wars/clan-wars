import type { LiveServer } from "@factions/roster";
import { ago } from "./format";

/**
 * Every word the server strip says. The name itself is Nitrado's, verbatim:
 * it is what players type into the DayZ browser, so nothing here may trim,
 * case or decorate it.
 */
export const SERVER_STRIP = { label: "Server", copy: "Copy name", copyShort: "Copy", copied: "Copied" } as const;

export type ServerStripItem = { hostname: string; map: string; seen: string };

/** `seen` says how fresh the name is: the worker keeps the last good name through a Nitrado outage, so the age is the honest part. */
export function serverStripCopy(servers: readonly LiveServer[], now: Date = new Date()): ServerStripItem[] {
  return servers.map((s) => ({
    hostname: s.hostname,
    map: s.map.charAt(0).toUpperCase() + s.map.slice(1),
    seen: `confirmed ${ago(s.seenAt, now)}`,
  }));
}
