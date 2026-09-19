/**
 * The statuses in which a faction HOLDS its pole, flag and tag.
 *
 * ⚠️ This set means identity and NOTHING ELSE. Flag and tag are mirrored by
 * two partial unique indexes (`factions_holding_texture_uniq`,
 * `factions_holding_tag_uniq`), whose predicates enumerate these same
 * statuses as SQL literals — see
 * `packages/db/test/holding-index-drift.test.ts`, which fails if they
 * diverge.
 *
 * The pole half of HOLDING is different: it is the existence of a
 * `declarations` row, which has no status predicate at all — it is released
 * only by an explicit delete on every transition out of HOLDING, not by the
 * status change itself. `dormant` is here on purpose: being raided, or going
 * quiet, must never cost a faction its identity.
 *
 * For "does this faction receive supplies", use SUPPLIED_PREDICATE.
 */
export const HOLDING_STATUSES = ["reserved", "active", "dormant"] as const;

/** faction_members.status (spec §4.5). A pending member is on the table, not on the roster. */
export const MEMBER_STATUSES = ["pending", "full"] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

/**
 * Supplied iff `status in ('reserved', 'active') and flag_down_since is null`.
 * A predicate, not a status list: a raided clan keeps `active` for the 24 h
 * clock and loses its kit the moment the flag is down.
 *
 * ⚠️ `reserved` is IN, amending spec §4.3 (2026-09-04), which had `active`
 * alone. The kit is the only source of a clan's own flag, and raising that
 * flag is what activates the clan — with `active` alone, no clan could ever
 * activate (COK and NIGHT, 2026-09-08). A reserved clan never has
 * `flag_down_since` set (only an active clan's flag can be "down"), so the
 * second clause is inert for it and harmless. Spelled in SQL by
 * apps/ingest-worker/src/supply-tick.ts; packages/db/test/holding-index-drift.test.ts
 * pins the spelling.
 */
export const SUPPLIED_PREDICATE = "status in ('reserved', 'active') and flag_down_since is null";

/**
 * SUPPLIED_PREDICATE as a function, for a caller that already holds the row.
 *
 * ⚠️ NOT "does this clan appear in the spawner file". Since 2026-09-19 the
 * file covers every HOLDING clan with a declared pole; this decides whether
 * such a clan gets the whole kit or only its flags. Flags are nominal 0 /
 * min 0 in types.xml, so the kit is the only source of a clan's flag on the
 * server, and a raided clan cut from the file entirely could not raise, so
 * could not clear `flag_down_since`, so could not earn the kit back — it ran
 * out the 24 h clock and went dormant with no move available. Losing the
 * crate is the cost of a raid; losing the flag was a dead end.
 *
 * ⚠️ Two statements of one fact with SUPPLIED_PREDICATE above, which the
 * worker no longer spells in SQL. `packages/db/test/holding-index-drift.test.ts`
 * is the only thing holding them together.
 */
export function isSupplied(status: string, flagDownSince: Date | null): boolean {
  return (status === "reserved" || status === "active") && flagDownSince === null;
}
