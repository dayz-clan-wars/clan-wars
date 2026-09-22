/**
 * @factions/roster/internal — the roster's store, for the BOT.
 *
 * Spec §5.4: writes that originate from a Discord gateway event, the log or
 * a clock (activation, lapse, dormancy disband, rebind proposals, the
 * guild-removal path in increment 7) go through this store, "not through an
 * export the web can reach". apps/web/test/smoke.test.ts forbids
 * `@factions/roster/internal` under apps/web; the root index.ts exposes only
 * the capability list. Both sides share one copy of every rule.
 */
export * from "./roster-store";
export * from "./faction-store";
export * from "./rebind-store";
export * from "./rebind";
export * from "./feed-store";
export * from "./feed-actor";
export * from "./holds";
export * from "./requests";
export * from "./notices";
export * from "./site-url";
export * from "./leadership-store";
export * from "./vault-store";
export * from "./guest-store";
export * from "./removal-store";
export * from "./incidents";
// The booster kit placement challenge. Lives here, not in apps/bot, because
// the SITE issues it (the kit page) and the BOT consumes it (kitPlacementTick)
// — two copies of a challenge rule is exactly what this package exists to stop.
export * from "./kit-placement-issue";

// The leaderboards themselves, for the bot's crown reconciler (apps/bot/src/crown-store.ts).
// Read-only, and the same query the public /players boards run — the bot must
// never compute a second, drifting idea of who is #1.
export { playerBoardsDb } from "../stats";
export type { Boards, BoardKind, BoardRow, StatScope } from "../stats";
// Event awards: the admin side (grant, revoke, list) and the guild-removal revoke.
export {
  grantAwardDb, revokeAwardDb, listAwardsDb, revokeAwardsForTx,
  type GrantAwardOutcome, type RevokeAwardOutcome, type AwardListRow,
} from "./award-admin";