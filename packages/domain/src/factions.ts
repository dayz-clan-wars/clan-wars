/**
 * The statuses in which a faction HOLDS its pole, flag and tag.
 *
 * ⚠️ This set means identity and NOTHING ELSE. It is mirrored by three
 * partial unique indexes (`factions_holding_texture_uniq`,
 * `factions_holding_tag_uniq`, `factions_holding_pole_uniq`), whose
 * predicates enumerate these same three statuses as SQL literals — see
 * `packages/db/test/holding-index-drift.test.ts`, which fails if they
 * diverge. `dormant` is here on purpose: being raided, or going quiet, must
 * never cost a faction its identity.
 *
 * For "does this faction receive supplies", use SUPPLIED_STATUSES.
 */
export const HOLDING_STATUSES = ["reserved", "active", "dormant"] as const;

/**
 * The statuses in which a faction receives a supply kit.
 *
 * `reserved` is included deliberately: the kit is what lets a newly claimed
 * faction raise its flag in the first place (see the supplies design, §2.2).
 *
 * `dormant` is excluded, and that exclusion is the entire mechanism by which
 * a stale flag stops the supplies — the projection reads status and nothing
 * else, so no coordination between the bot and the worker is needed.
 */
export const SUPPLIED_STATUSES = ["reserved", "active"] as const;
