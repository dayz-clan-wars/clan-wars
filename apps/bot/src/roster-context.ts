import type { Membership } from "./roster-store.js";

export type ServerContext =
  | { kind: "ok"; membership: Membership }
  | { kind: "no-faction" }
  | { kind: "not-on-server" }
  | { kind: "ambiguous"; choices: Membership[] };

/**
 * Decide which faction a roster command acts on.
 *
 * A player holds at most one faction per server but may hold several across
 * servers, so a bare command is ambiguous for them and unambiguous for
 * everyone else. An explicitly named server always wins — including when the
 * player holds exactly one faction, because a stale autocomplete choice must
 * refuse rather than quietly act on a different faction than the one named.
 */
export function resolveServerContext(
  memberships: Membership[],
  requestedServerId: number | null,
): ServerContext {
  if (requestedServerId !== null) {
    const found = memberships.find((m) => m.serverId === requestedServerId);
    return found ? { kind: "ok", membership: found } : { kind: "not-on-server" };
  }
  if (memberships.length === 0) return { kind: "no-faction" };
  if (memberships.length === 1) return { kind: "ok", membership: memberships[0]! };
  return { kind: "ambiguous", choices: memberships };
}
