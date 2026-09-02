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
  /**
   * Nitrado service this server's ADM files are fetched from.
   *
   * Nullable: rows created by the historical-export replay predate Nitrado
   * ingestion entirely and have no service behind them. Inventing an id for
   * them would be fabricated data, not a missing value.
   */
  nitradoServiceId: integer("nitrado_service_id"),
  /**
   * Whether the ingest sweep should pull this server.
   *
   * The database is the source of truth for which servers are swept, so a
   * server is retired by clearing this rather than by deleting rows or
   * editing worker config. Defaults true: registering a server should start
   * ingesting it, not require a second step.
   *
   * ⚠️ This column was added `NOT NULL DEFAULT true` onto an existing table,
   * so the migration backfilled every pre-existing row — including rows
   * created by the historical-export replay from local disk — to true. Those
   * rows have no Nitrado service behind them (see nitradoServiceId), so the
   * sweep's WHERE clause also requires nitradoServiceId IS NOT NULL; `active`
   * alone is not a safe filter for which servers to pull.
   */
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqNameMap: uniqueIndex("servers_name_map_uniq").on(t.name, t.map),
}));

export const admFiles = pgTable("adm_files", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  filename: text("filename").notNull(),
  /**
   * Nitrado's download path for this file.
   *
   * `filename` remains the identity — the unique index is
   * (server_id, filename) and every row written since Plan 1 uses it. `path`
   * is only how the bytes are fetched. Nullable: rows written by the
   * historical replay have no Nitrado path, and backfilling one for them
   * would be inventing data.
   */
  path: text("path"),
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
  // ⚠️ The dormancy clock's per-faction "when did this faction last raise its
  // own flag at its own pole" lookup, and the only index covering the payload
  // keys. Without it that subquery filters every flag.raised row on the server
  // once per faction per tick: measured at 1M events / 120k raises / 45
  // factions, 352ms per tick versus 0.4ms with it. The columns must stay in
  // this order — the three equalities first, occurred_at last — or `max()`
  // cannot be answered by walking the index. `events_raise_lookup_idx` is
  // pinned by apps/bot/test/dormancy-index-drift.test.ts, which fails if the
  // planner stops choosing it.
  byRaiseLookup: index("events_raise_lookup_idx")
    .on(t.serverId, sql`(${t.payload}->>'poleKey')`, sql`(${t.payload}->>'texture')`, t.occurredAt)
    .where(sql`${t.type} = 'flag.raised'`),
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

/**
 * Every character the event log has ever seen.
 *
 * Keyed on the UID, not the display name: a rename is then a column update
 * rather than a new identity, and two players who have ever shared a gamertag
 * remain two rows. `/link`'s autocomplete reads this, and spec §6's
 * leader-inactivity mechanic (Plan 4c) will read `last_seen_at`.
 *
 * ⚠️ Both timestamps are EVENT times, not wall-clock. A backfill of old logs
 * must not make a long-absent player look recently active.
 */
export const players = pgTable("players", {
  dayzId: text("dayz_id").primaryKey(),
  gamertag: text("gamertag").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
}, (t) => ({
  byLastSeen: index("players_last_seen_idx").on(t.lastSeenAt),
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
  /**
   * The character this challenge verifies, chosen by the player at /link time.
   *
   * ⚠️ This column is the security model. The tick advances a challenge ONLY
   * for events carrying this UID, so a challenge can only be won by the
   * character it names — which is what makes a three-emote sequence sufficient
   * and what retired the open-sequence unique index below.
   */
  targetDayzId: text("target_dayz_id").notNull(),
  /**
   * Why the challenge was canceled, when the player needs to be told.
   *
   * ⚠️ NULL is not "unknown", it is "say nothing". Only cancels the player
   * must hear about set this, and `pendingNotifications` keys on the reason
   * rather than on `canceled_at`. That is deliberate: keying on `canceled_at`
   * would make every historical expiry and every switch-cancel — rows that
   * predate this column and rows whose player was already told inline by
   * `/link` — pending on the first tick after deploy, and the bot would DM a
   * backlog of long-dead challenges. A new column is NULL everywhere it was
   * not explicitly written, so nothing already in the table can flood.
   */
  cancelReason: text("cancel_reason"),
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
  // notified_at once required a completion. A budget-exhausted challenge is
  // now told to its player too (spec §5.3), and that message is made
  // exactly-once by the same notified_at discipline — so what notified_at
  // requires is an OUTCOME, not specifically a completion. It still cannot be
  // set on a live challenge.
  notifiedOnlyWhenSettled: check(
    "verification_challenges_notified_requires_outcome",
    sql`${t.notifiedAt} IS NULL OR ${t.completedAt} IS NOT NULL OR ${t.canceledAt} IS NOT NULL`,
  ),
  // A reason is a property of a cancellation; it must not exist without one.
  reasonOnlyWhenCanceled: check(
    "verification_challenges_reason_requires_cancel",
    sql`${t.cancelReason} IS NULL OR ${t.canceledAt} IS NOT NULL`,
  ),
  notBothOutcomes: check(
    "verification_challenges_single_outcome",
    sql`NOT (${t.completedAt} IS NOT NULL AND ${t.canceledAt} IS NOT NULL)`,
  ),
  // `verification_challenges_open_sequence_uniq` was REMOVED here. It was a
  // real security boundary while a challenge named nobody — two live
  // challenges sharing a sequence let the tick bind the wrong account. A
  // challenge now names its target UID, so that race cannot occur, and
  // reinstating the index would actively break /link: three emotes over 24
  // tokens is 12,144 sequences, so live challenges collide routinely.
  // One open challenge per account. Without it, two concurrent /link calls
  // both miss findLiveChallenge and create two live challenges, each holding a
  // sequence, and the re-show path then returns an arbitrary one — so the
  // player can be shown a different sequence than the one they are working on.
  uniqOpenPerAccount: uniqueIndex("verification_challenges_open_account_uniq")
    .on(t.discordId)
    .where(sql`${t.completedAt} IS NULL AND ${t.canceledAt} IS NULL`),
  // One live challenge per CHARACTER. Without it, two Discord accounts can
  // both hold open challenges for one UID and race to bind it.
  uniqOpenTarget: uniqueIndex("verification_challenges_open_target_uniq")
    .on(t.targetDayzId)
    .where(sql`${t.completedAt} IS NULL AND ${t.canceledAt} IS NULL`),
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
  /**
   * Safe-pool emotes this UID has spent on this challenge.
   *
   * ⚠️ This is what stops a brute-force sweep. `advance` deliberately holds
   * progress on a mismatch, so performing the whole safe pool in order three
   * times contains every possible ordered triple and completes ANY live
   * challenge without ever seeing its sequence (verified: 2000/2000). Secrecy
   * of the issued sequence is not a defence against a search the matcher
   * permits — a budget is.
   */
  seenCount: integer("seen_count").notNull().default(0),
}, (t) => ({
  uniqAttempt: uniqueIndex("challenge_attempts_challenge_dayz_uniq").on(t.challengeId, t.dayzId),
}));

/**
 * Qualifying neutral-flag raises, as the detector sees them.
 *
 * ⚠️ This table is why recording and settling are separate phases. The
 * detector's cursor advances when a raise is RECORDED; settling happens
 * afterwards from these rows. If settling throws, nothing is lost — the raises
 * are durable and the next pass settles them. Merging the phases would mean a
 * settle failure silently discards events the cursor has already passed.
 */
export const whiteRaises = pgTable("white_raises", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  poleKey: text("pole_key").notNull(),
  dayzId: text("dayz_id").notNull(),
  gamertag: text("gamertag").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  eventId: bigint("event_id", { mode: "number" }).notNull().references(() => events.id),
  /** Null until the window holding this raise has settled. */
  settledAt: timestamp("settled_at", { withTimezone: true }),
}, (t) => ({
  // Replay safety: the detector re-reads events after a crash, and recording
  // one raise twice would let a single player count as two participants.
  uniqEvent: uniqueIndex("white_raises_event_uniq").on(t.eventId),
  // The settling query: unconsumed raises for one pole, in time order.
  byPolePending: index("white_raises_pending_idx")
    .on(t.serverId, t.poleKey, t.occurredAt)
    .where(sql`${t.settledAt} IS NULL`),
}));

/** A detected founding ritual, awaiting a claim. */
export const ceremonies = pgTable("ceremonies", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  poleKey: text("pole_key").notNull(),
  x: numeric("x", { precision: 12, scale: 2 }).notNull(),
  y: numeric("y", { precision: 12, scale: 2 }).notNull(),
  z: numeric("z", { precision: 12, scale: 2 }).notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
  status: text("status").notNull(),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  /** Set once every participant has been DM'd. Keeps the notifier idempotent. */
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
}, (t) => ({
  statusValid: check("ceremonies_status_valid",
    sql`${t.status} IN ('provisional','claimed','expired')`),
  // One outstanding ceremony per pole. Partial, because a claimed or expired
  // ceremony no longer holds its pole. Without this, a pole under sustained
  // White raises would produce a ceremony every window and only the first
  // could ever insert — the rest would surface as errors rather than no-ops.
  uniqOpenPole: uniqueIndex("ceremonies_open_pole_uniq")
    .on(t.serverId, t.poleKey)
    .where(sql`${t.status} = 'provisional'`),
  byOpen: index("ceremonies_open_idx").on(t.expiresAt).where(sql`${t.status} = 'provisional'`),
}));

/**
 * Who was counted. `discord_id` and `gamertag` are denormalized at detection
 * time deliberately: the DM path must not re-resolve them, and the row is a
 * record of who was linked THEN, not who is linked now.
 */
export const ceremonyParticipants = pgTable("ceremony_participants", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ceremonyId: bigint("ceremony_id", { mode: "number" })
    .notNull().references(() => ceremonies.id, { onDelete: "cascade" }),
  dayzId: text("dayz_id").notNull(),
  discordId: text("discord_id").notNull(),
  gamertag: text("gamertag").notNull(),
  /**
   * When THIS participant's DM landed.
   *
   * ⚠️ Delivery is tracked per participant, not per ceremony, because the two
   * failure modes are not the same. A ceremony DM has no originating channel
   * (a ceremony must never be posted publicly), so `send` THROWS for anyone
   * with DMs closed — there is no channel fallback. With one `notified_at` on
   * the ceremony, a single unreachable participant means the ceremony is never
   * marked, so every tick re-DMs everyone reachable (~8,600 duplicates each
   * over the 24h TTL) and everyone after the failure in the loop never hears
   * at all. Marking the ceremony done instead would silently drop that player
   * from their own founding group, which this project refuses to do (see
   * `notifyCompleted`: a real binding retries until it lands). Per participant,
   * each retry targets exactly the person still owed a message.
   */
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
}, (t) => ({
  uniqParticipant: uniqueIndex("ceremony_participants_uniq").on(t.ceremonyId, t.dayzId),
}));

/**
 * A faction.
 *
 * ⚠️ Keyed on `server_id` alone, NOT `(server_id, map)`. `servers.map` already
 * exists, so `server_id` determines the map; carrying both invites the two
 * disagreeing. Per-map tenancy holds through the join.
 *
 * There is no `flag_pool` table. The 33 claimable textures are a constant in
 * `@factions/domain`, and availability is that constant minus the rows here in
 * a holding status — so the claim IS the allocation, and disbanding frees the
 * flag with no bookkeeping.
 */
export const factions = pgTable("factions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  name: text("name").notNull(),
  tag: text("tag").notNull(),
  texture: text("texture").notNull(),
  poleKey: text("pole_key").notNull(),
  x: numeric("x", { precision: 12, scale: 2 }).notNull(),
  y: numeric("y", { precision: 12, scale: 2 }).notNull(),
  z: numeric("z", { precision: 12, scale: 2 }).notNull(),
  status: text("status").notNull(),
  leaderDiscordId: text("leader_discord_id").notNull(),
  /** Provenance: which ritual produced this faction. */
  ceremonyId: bigint("ceremony_id", { mode: "number" }).references(() => ceremonies.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  reservedUntil: timestamp("reserved_until", { withTimezone: true }),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  /**
   * When this faction was OBSERVED to go dormant. Null for every other status.
   *
   * ⚠️ Stored rather than derived from the last flag raise, and the reason is
   * the disband clock this feeds. A derived rule runs during periods when
   * nothing was watching: after a three-week bot outage, or for a faction
   * whose activating raise predates the ingested window, the first tick would
   * disband factions that were never given a chance to refresh — releasing a
   * flag, tag and pole with no human in the loop. This column makes "14 days
   * dormant" mean fourteen days actually observed.
   */
  dormantSince: timestamp("dormant_since", { withTimezone: true }),
  /** Null means never renamed, so no cooldown applies. Set by `/faction rename`. */
  renamedAt: timestamp("renamed_at", { withTimezone: true }),
}, (t) => ({
  statusValid: check("factions_status_valid",
    sql`${t.status} IN ('reserved','active','dormant','lapsed','disbanded')`),
  // A reservation with no deadline is a permanent hole in a 33-slot pool.
  reservedHasDeadline: check("factions_reserved_has_deadline",
    sql`${t.status} <> 'reserved' OR ${t.reservedUntil} IS NOT NULL`),
  // The three scarcity rules. All partial over the HOLDING statuses, so a
  // lapsed or disbanded faction releases flag, tag and pole in one transition.
  uniqTexture: uniqueIndex("factions_holding_texture_uniq")
    .on(t.serverId, t.texture)
    .where(sql`${t.status} IN ('reserved','active','dormant')`),
  uniqTag: uniqueIndex("factions_holding_tag_uniq")
    .on(t.serverId, sql`lower(${t.tag})`)
    .where(sql`${t.status} IN ('reserved','active','dormant')`),
  uniqPole: uniqueIndex("factions_holding_pole_uniq")
    .on(t.serverId, t.poleKey)
    .where(sql`${t.status} IN ('reserved','active','dormant')`),
}));

/**
 * The hash of the supply spawner file last successfully uploaded per server.
 *
 * ⚠️ This is the whole memory of the supply projection. The tick regenerates
 * the file every pass and uploads only when the hash differs, so without this
 * row it would re-upload an identical file forever. The hash advances ONLY on
 * a successful upload, which is what makes a failed upload retry on the next
 * tick instead of being lost.
 */
export const supplyUploads = pgTable("supply_uploads", {
  serverId: integer("server_id").primaryKey().references(() => servers.id),
  contentHash: text("content_hash").notNull(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull(),
  /**
   * What the game server reported for the file immediately AFTER our upload —
   * its own size and mtime, not ours.
   *
   * ⚠️ Observed, never computed. The obvious alternative is to compare the
   * remote mtime against `uploadedAt`, which happens to match today. It is a
   * trap: `modified_at` comes from the GAME SERVER's filesystem clock, and
   * those run fixed UTC+4/+7 (see the ADM filename hazard in
   * NitradoClient.listAdmFiles). Any clock offset would make every tick see
   * drift and re-upload forever — the "always upload" behaviour spec §4.4
   * rejected. Comparing observation to observation is immune to that.
   *
   * ⚠️ Null means the baseline was never captured — the stat after an upload
   * failed. Drift detection is SKIPPED for a null baseline rather than
   * treating it as a mismatch, because the alternative re-uploads on every
   * tick until the stat succeeds. The next quiet tick backfills it.
   */
  remoteSize: integer("remote_size"),
  remoteModifiedAt: timestamp("remote_modified_at", { withTimezone: true }),
});

/**
 * The confirmed roster.
 *
 * Created in this plan only because activation must verify that the UID which
 * raised the faction's flag is on it. No command manages membership yet — that
 * is spec §6.
 */
export const factionMembers = pgTable("faction_members", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  factionId: bigint("faction_id", { mode: "number" })
    .notNull().references(() => factions.id, { onDelete: "cascade" }),
  /**
   * Denormalized from the faction so "one player, one faction per server" can
   * be an INDEX rather than a code path that remembers to look.
   *
   * ⚠️ The index below carries no partial predicate, which is only correct
   * because a membership row does not outlive its faction's hold: lapsing and
   * disbanding DELETE the roster. Membership in a lapsed faction is not a
   * weaker membership — it is not a membership.
   */
  serverId: integer("server_id").notNull().references(() => servers.id),
  dayzId: text("dayz_id").notNull(),
  discordId: text("discord_id").notNull(),
  role: text("role").notNull(),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull(),
}, (t) => ({
  roleValid: check("faction_members_role_valid",
    sql`${t.role} IN ('leader','officer','member')`),
  uniqMember: uniqueIndex("faction_members_uniq").on(t.factionId, t.dayzId),
  uniqServerPlayer: uniqueIndex("faction_members_server_player_uniq").on(t.serverId, t.dayzId),
  // Exactly one leader. Transfer is one transaction demoting and promoting;
  // this is what makes two simultaneous transfers impossible rather than
  // merely unlikely.
  uniqLeader: uniqueIndex("faction_members_leader_uniq")
    .on(t.factionId).where(sql`${t.role} = 'leader'`),
}));

/**
 * An outstanding invitation. An offer, not a standing permission — hence the TTL.
 */
export const factionInvites = pgTable("faction_invites", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  factionId: bigint("faction_id", { mode: "number" })
    .notNull().references(() => factions.id, { onDelete: "cascade" }),
  /** Denormalized so the accept guard needs no join. */
  serverId: integer("server_id").notNull().references(() => servers.id),
  inviteeDiscordId: text("invitee_discord_id").notNull(),
  /** The roster keys on the UID; the invite is issued to a Discord user. Both are needed. */
  inviteeDayzId: text("invitee_dayz_id").notNull(),
  invitedByDiscordId: text("invited_by_discord_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  declinedAt: timestamp("declined_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => ({
  /**
   * One outstanding offer per faction per player.
   *
   * ⚠️ The predicate deliberately excludes `expires_at > now()`. A Postgres
   * partial index predicate must be IMMUTABLE and `now()` is not, so such an
   * index is rejected outright at creation. Expiry is enforced on the read and
   * accept paths instead; re-inviting someone whose offer lapsed REFRESHES
   * this row rather than inserting a second one.
   *
   * Scoped to the faction, not the player: several factions may court the same
   * player, and choosing between them is the player's to make.
   */
  uniqPending: uniqueIndex("faction_invites_pending_uniq")
    .on(t.factionId, t.inviteeDayzId)
    .where(sql`${t.acceptedAt} IS NULL AND ${t.declinedAt} IS NULL AND ${t.revokedAt} IS NULL`),
}));

/**
 * How long a player is barred from joining any faction on this server.
 *
 * Stores the DECISION, not the departure event, so the accept path is a
 * NOT EXISTS against one row rather than a "find the newest departure" query.
 * Kicks and voluntary departures are treated identically: §6's reasoning is
 * that the two collapse under collusion ("just kick me"), so punishing them
 * differently buys nothing. Disbanding writes nothing at all.
 */
export const rosterCooldowns = pgTable("roster_cooldowns", {
  serverId: integer("server_id").notNull().references(() => servers.id),
  dayzId: text("dayz_id").notNull(),
  until: timestamp("until", { withTimezone: true }).notNull(),
}, (t) => ({
  pk: uniqueIndex("roster_cooldowns_pk").on(t.serverId, t.dayzId),
}));

/**
 * A claim in progress: name, tag and flag chosen, roster not yet confirmed.
 * One draft per (ceremony, player) — a ceremony seats several participants
 * and any of them may run the claim command, so each needs their own draft
 * rather than colliding on the first one to insert.
 *
 * ⚠️ Needed because the pruning step is a second interaction. Discord custom
 * ids cap at 100 characters, so a player-chosen faction name cannot ride along
 * in one — the draft has to be durable. Deleted on confirm.
 */
export const claimDrafts = pgTable("claim_drafts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ceremonyId: bigint("ceremony_id", { mode: "number" })
    .notNull().references(() => ceremonies.id, { onDelete: "cascade" }),
  discordId: text("discord_id").notNull(),
  name: text("name").notNull(),
  tag: text("tag").notNull(),
  texture: text("texture").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => ({
  uniqDraft: uniqueIndex("claim_drafts_ceremony_discord_uniq").on(t.ceremonyId, t.discordId),
}));
