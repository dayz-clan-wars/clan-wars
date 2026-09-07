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
