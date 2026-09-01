/**
 * The statuses in which a faction HOLDS its pole, flag and tag.
 *
 * ⚠️ Shared deliberately. The roster store gates every membership write on
 * this set, and the supply projection spawns a kit for exactly these
 * factions. Two copies would drift, and the symptom would be a disbanded
 * faction's supplies respawning at every restart forever.
 */
export const HOLDING_STATUSES = ["reserved", "active", "dormant"] as const;
