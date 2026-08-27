import {
  pgTable, bigserial, bigint, integer, text, timestamp, jsonb,
  uniqueIndex, index, numeric, boolean, check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { EventType } from "@factions/domain";

export const servers = pgTable("servers", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  map: text("map").notNull(),
  /**
   * DayZ ADM logs record server-local wall-clock time, not UTC. Validation
   * against 69,326 rows of real production data showed three servers running
   * three different clocks (Chernarus UTC+4, Livonia and Sakhal UTC+7). The
   * parser's TimelineCursor therefore takes an explicit clockOffsetMs and
   * applies it as UTC = server-local + clockOffsetMs. This column is where
   * the ingest worker reads that value per server, since it is a property of
   * the server itself.
   *
   * ⚠️ Deliberately NOT `.default(0)`. A wrong clock offset is invisible to
   * every count-based check in this system: every row still lands, every
   * acceptance count still matches, and only the absolute instants are hours
   * wrong. A default would let any caller that forgets this column silently
   * inherit that failure. Every insert must state the offset explicitly.
   */
  clockOffsetMs: integer("clock_offset_ms").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqNameMap: uniqueIndex("servers_name_map_uniq").on(t.name, t.map),
}));

export const admFiles = pgTable("adm_files", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  filename: text("filename").notNull(),
  bootAt: timestamp("boot_at", { withTimezone: true }).notNull(),
  linesIngested: integer("lines_ingested").notNull().default(0),
  complete: boolean("complete").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqFile: uniqueIndex("adm_files_server_filename_uniq").on(t.serverId, t.filename),
}));

/** Lossless capture of every non-empty ADM line, so reprocessing never needs the origin server. */
export const rawLines = pgTable("raw_lines", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  admFileId: bigint("adm_file_id", { mode: "number" }).notNull().references(() => admFiles.id),
  lineIndex: integer("line_index").notNull(),
  content: text("content").notNull(),
}, (t) => ({
  uniqLine: uniqueIndex("raw_lines_file_line_uniq").on(t.admFileId, t.lineIndex),
}));

export const events = pgTable("events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  admFileId: bigint("adm_file_id", { mode: "number" }).notNull().references(() => admFiles.id),
  lineIndex: integer("line_index").notNull(),
  subIndex: integer("sub_index").notNull().default(0),
  type: text("type").$type<EventType>().notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  payload: jsonb("payload").notNull(),
  rawLineId: bigint("raw_line_id", { mode: "number" }).references(() => rawLines.id),
}, (t) => ({
  uniqEvent: uniqueIndex("events_idempotency_uniq").on(t.serverId, t.admFileId, t.lineIndex, t.subIndex),
  byType: index("events_type_idx").on(t.type),
  byServerOccurred: index("events_server_occurred_idx").on(t.serverId, t.occurredAt),
}));

export const consumerCursors = pgTable("consumer_cursors", {
  consumerName: text("consumer_name").primaryKey(),
  lastEventId: bigint("last_event_id", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Projection: every flagpole ever observed.
 * Coordinates are numeric(10,2) — already rounded to the 1cm identity precision.
 * ⚠️ These coordinates must never reach a public read model (spec §11).
 */
export const poles = pgTable("poles", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  map: text("map").notNull(),
  poleKey: text("pole_key").notNull(),
  x: numeric("x", { precision: 10, scale: 2 }).notNull(),
  y: numeric("y", { precision: 10, scale: 2 }).notNull(),
  z: numeric("z", { precision: 10, scale: 2 }).notNull(),
  currentTexture: text("current_texture"),
  flagRaised: boolean("flag_raised").notNull().default(false),
  foldedAt: timestamp("folded_at", { withTimezone: true }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
}, (t) => ({
  uniqPole: uniqueIndex("poles_tenant_key_uniq").on(t.serverId, t.map, t.poleKey),
}));

/** Projection: the ordered history of raises and lowers at each pole. */
export const flagChanges = pgTable("flag_changes", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  eventId: bigint("event_id", { mode: "number" }).notNull().references(() => events.id),
  serverId: integer("server_id").notNull().references(() => servers.id),
  map: text("map").notNull(),
  /**
   * ⚠️ A literal "x:y:z" coordinate string (the 1cm-normalized flagpole
   * identity), exactly as in `poles.pole_key`. It must never reach a public
   * read model — publishing it publishes a base's exact world position
   * (spec §11).
   */
  poleKey: text("pole_key").notNull(),
  dayzId: text("dayz_id").notNull(),
  gamertag: text("gamertag").notNull(),
  action: text("action").notNull(),
  texture: text("texture").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
}, (t) => ({
  uniqChange: uniqueIndex("flag_changes_event_uniq").on(t.eventId),
  byPole: index("flag_changes_pole_idx").on(t.serverId, t.map, t.poleKey, t.occurredAt),
  byActor: index("flag_changes_actor_idx").on(t.dayzId, t.occurredAt),
}));

// ── Identity (spec §16). Discord snowflake ↔ DayZ UID. ──

/**
 * A VERIFIED binding only. There is deliberately no `status` column: an
 * unverified claim is a live row in `verification_challenges`, not a link.
 * Modelling "pending" here would put rows in the identity table that every
 * downstream read has to remember to filter, and the one that forgets grants
 * a faction role to an unproven account.
 *
 * ⚠️ `dayzId` is the identity. `gamertag` is a display label captured at
 * verification time — players rename, and a roster keyed on names breaks the
 * moment they do (spec §16, "Divergence from one-life").
 */
export const identityLinks = pgTable("identity_links", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  discordId: text("discord_id").notNull(),
  dayzId: text("dayz_id").notNull(),
  gamertag: text("gamertag").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqDiscord: uniqueIndex("identity_links_discord_uniq").on(t.discordId),
  uniqDayz: uniqueIndex("identity_links_dayz_uniq").on(t.dayzId),
}));

/** One issued emote sequence for one Discord account. */
export const verificationChallenges = pgTable("verification_challenges", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  discordId: text("discord_id").notNull(),
  guildId: text("guild_id").notNull(),
  /** Where `/link` was run — the fallback reply target when a DM is closed. */
  channelId: text("channel_id").notNull(),
  sequence: text("sequence").array().notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  canceledAt: timestamp("canceled_at", { withTimezone: true }),
  /** Set when the challenge completed; the UID that won it. */
  boundDayzId: text("bound_dayz_id"),
  /** Set once the player has been told. Keeps the notifier idempotent. */
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
}, (t) => ({
  byDiscord: index("verification_challenges_discord_idx").on(t.discordId),
  // Partial index matching the live-challenge query exactly ("not completed,
  // not canceled, not expired"), so it stays useful as completed/canceled
  // rows accumulate instead of degrading into a full expires_at range scan.
  byLive: index("verification_challenges_live_idx")
    .on(t.expiresAt)
    .where(sql`${t.completedAt} IS NULL AND ${t.canceledAt} IS NULL`),
  // A challenge has exactly one outcome. bound_dayz_id is the UID that won
  // it, and notified_at marks that the player was told — neither can exist
  // without a completion, and completion and cancellation are mutually
  // exclusive. These constraints make a half-completed challenge state
  // unrepresentable.
  boundOnlyWhenComplete: check(
    "verification_challenges_bound_requires_complete",
    sql`${t.boundDayzId} IS NULL OR ${t.completedAt} IS NOT NULL`,
  ),
  notifiedOnlyWhenComplete: check(
    "verification_challenges_notified_requires_complete",
    sql`${t.notifiedAt} IS NULL OR ${t.completedAt} IS NOT NULL`,
  ),
  notBothOutcomes: check(
    "verification_challenges_single_outcome",
    sql`NOT (${t.completedAt} IS NOT NULL AND ${t.canceledAt} IS NOT NULL)`,
  ),
}));

/**
 * Per-UID progress through one challenge.
 *
 * ⚠️ Progress is keyed on (challenge, dayz_id), NOT stored on the challenge.
 * Factions does not know the target UID when it issues a sequence — that is
 * the whole point of §16 — so a single progressIndex on the challenge would
 * let three different players each contribute one emote and jointly complete
 * it, binding whichever UID happened to fire last. Any UID may attempt; the
 * first to complete the full ordered sequence wins.
 *
 * `lastMatchedEventId` makes the tick replay-safe: re-reading an event that
 * already advanced this attempt must not advance it twice.
 */
export const challengeAttempts = pgTable("challenge_attempts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  challengeId: bigint("challenge_id", { mode: "number" })
    .notNull()
    .references(() => verificationChallenges.id, { onDelete: "cascade" }),
  dayzId: text("dayz_id").notNull(),
  progressIndex: integer("progress_index").notNull().default(0),
  lastMatchedEventId: bigint("last_matched_event_id", { mode: "number" }).notNull().default(0),
}, (t) => ({
  uniqAttempt: uniqueIndex("challenge_attempts_challenge_dayz_uniq").on(t.challengeId, t.dayzId),
}));
