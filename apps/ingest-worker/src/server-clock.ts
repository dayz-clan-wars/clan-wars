import { isValidTimeZone, type ServerClock } from "@factions/adm-parser";

/**
 * The clock one `servers` row declares: its zone when it has one, else its
 * fixed offset. The zone wins because it is the truth all year; the offset is
 * right only while the server's clock is not observing a different DST state
 * from when it was measured.
 *
 * ⚠️ Throws on a zone `Intl` cannot convert in, naming the server, rather than
 * falling back to the offset. A hand-typed typo in `servers.time_zone` must
 * stop that server's ingest loudly (the sweep logs it every tick) instead of
 * quietly reverting to the very number the zone was set to replace.
 */
export function clockFor(server: { id: number; clockOffsetMs: number; timeZone: string | null }): ServerClock {
  if (server.timeZone === null) return { kind: "offset", offsetMs: server.clockOffsetMs };
  if (!isValidTimeZone(server.timeZone)) {
    throw new Error(`server ${server.id}: servers.time_zone ${JSON.stringify(server.timeZone)} is not a time zone`);
  }
  return { kind: "zone", timeZone: server.timeZone };
}
