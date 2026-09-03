/**
 * The faction lifecycle transitions the public feed carries.
 *
 * ⚠️ Mirrored by the `faction_events_kind_valid` check constraint in SQL.
 * They are two statements of one fact and
 * `packages/db/test/faction-events-schema.test.ts` is what holds them
 * together — drift means a writer's insert is rejected inside the
 * transition's own transaction, rolling the transition back with it.
 */
export const FACTION_EVENT_KINDS = [
  "founded", "activated", "renamed", "rebound", "dormant", "revived", "disbanded",
] as const;

export type FactionEventKind = (typeof FACTION_EVENT_KINDS)[number];
