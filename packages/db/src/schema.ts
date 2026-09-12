import {
  pgTable, bigserial, bigint, integer, text, timestamp, jsonb,
  uniqueIndex, index, numeric, boolean, check, char, primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { EventType, FactionEventKind, WarLogKind, ClanNoticeKind, NoticeTarget, DormantReason } from "@factions/domain";

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
  /**
   * The in-game server name (Nitrado `settings.config.hostname`), the string
   * players search for in the DayZ server browser. NOT `name`, which is the
   * operator's label at registration. Written by the ingest sweep from
   * Nitrado, since the worker is the only thing holding a token; read by the
   * site. Nullable: unset until the first sweep, and never set for the
   * replay rows with no service behind them. The sweep keeps the last good
   * value on a failed read, so `hostnameSeenAt` says how fresh it is.
   */
  hostname: text("hostname"),
  hostnameSeenAt: timestamp("hostname_seen_at", { withTimezone: true }),
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
  // ⚠️ The stats package's upkeep-raise count (`packages/roster/src/stats.ts`)
  // asks "which flag.raised rows did THIS player write". `events_type_idx`
  // narrows to flag.raised but then every one of them (measured: 120k at 1M
  // events) is heap-fetched and filtered on the payload key. Partial, on the
  // payload key alone, because the predicate is an equality on one player and
  // the route that runs it (`/players/{gamertag}`) is public.
  byRaisePlayer: index("events_raise_by_player_idx")
    .on(sql`(${t.payload}->>'dayzId')`)
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
  /**
   * When this pole becomes public if still undeclared (spec §4.2). Set to
   * first sighting + NEW_POLE_GRACE_MS by the bot's pole projection, reset to
   * release + RELEASED_POLE_GRACE_MS whenever a declaration on it is
   * released, and stamped to launch + 7 d by the deploy runbook.
   *
   * ⚠️ Publication is a READ over this column, not a transition: a pole is
   * public iff flag_raised, no declarations row, and grace_until < now.
   */
  graceUntil: timestamp("grace_until", { withTimezone: true }).notNull(),
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
  // ⚠️ Functional, on `lower(gamertag)`: `resolvePlayer` (stats.ts) matches a
  // URL-supplied name case-insensitively, so a plain `gamertag` index cannot
  // serve it. NOT unique — two links may have carried the same name.
  byGamertagLower: index("identity_links_gamertag_lower_idx").on(sql`lower(${t.gamertag})`),
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
  // ⚠️ Same reason as `identity_links_gamertag_lower_idx`: the public
  // `/players/{gamertag}` lookup is `lower(gamertag) = lower($1)`.
  byGamertagLower: index("players_gamertag_lower_idx").on(sql`lower(${t.gamertag})`),
}));

/** One issued emote sequence for one Discord account. */
export const verificationChallenges = pgTable("verification_challenges", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  discordId: text("discord_id").notNull(),
  /**
   * The guild `/link` was run in. NULL when the SITE issued the challenge
   * (increment 2b): there is no interaction to answer, so the notifier falls
   * back to the configured guild for the nickname and DMs only.
   */
  guildId: text("guild_id"),
  /** Where `/link` was run — the fallback reply target when a DM is closed. NULL for a site-issued challenge. */
  channelId: text("channel_id"),
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
  /**
   * When this faction last moved its pole. Null means never rebound, so no
   * cooldown applies — the same convention as `renamed_at` directly above.
   *
   * ⚠️ Nullable, with no default and no backfill. A `DEFAULT now()` would put
   * every faction already in `factions_live` on a 7-day rebind cooldown the
   * instant the migration applied, and nothing anywhere would report it — the
   * only symptom is leaders being told "your faction moved too recently" about
   * a move that never happened.
   */
  reboundAt: timestamp("rebound_at", { withTimezone: true }),
  /**
   * The recruiting post (spec §4.3; guide ch. 8). `recruiting` turns on the
   * directory's "Request to join" and is the only gate `requestJoin` checks.
   */
  recruiting: boolean("recruiting").notNull().default(false),
  playWindow: text("play_window"),
  language: text("language"),
  pitch: text("pitch"),
  /** Spec §5.8: set by a non-member's lower at the declared pole while active; cleared by a member's raise (defense) or the dormancy transition. */
  flagDownSince: timestamp("flag_down_since", { withTimezone: true }),
  flagDownByDayzId: text("flag_down_by_dayz_id"),
  /** Non-null iff dormant, by convention; the runbook stamps 'inactive' on any dormant row from before this column. */
  dormantReason: text("dormant_reason").$type<DormantReason>(),
  /** The day-10 warning was queued. Cleared by revive. */
  disbandWarnedAt: timestamp("disband_warned_at", { withTimezone: true }),
  /** Set FAILED_VOTE_COOLDOWN_MS ahead by a failed no-confidence vote (spec §4.3, §5.7). Null = no cooldown. */
  nextVoteAllowedAt: timestamp("next_vote_allowed_at", { withTimezone: true }),
  /** Filled by increment 3b at activation; null until then. clan_notices with target 'channel' post only once this is set. */
  discordRoleId: text("discord_role_id"),
  discordTextChannelId: text("discord_text_channel_id"),
  discordVoiceChannelId: text("discord_voice_channel_id"),
}, (t) => ({
  statusValid: check("factions_status_valid",
    sql`${t.status} IN ('reserved','active','dormant','lapsed','disbanded')`),
  // A reservation with no deadline is a permanent hole in a 33-slot pool.
  reservedHasDeadline: check("factions_reserved_has_deadline",
    sql`${t.status} <> 'reserved' OR ${t.reservedUntil} IS NOT NULL`),
  dormantReasonValid: check("factions_dormant_reason_valid",
    sql`${t.dormantReason} IS NULL OR ${t.dormantReason} IN ('raided','inactive')`),
  // Two of the three scarcity rules. Both partial over the HOLDING statuses,
  // so a lapsed or disbanded faction releases flag and tag on the status
  // transition alone.
  //
  // ⚠️ The pole is NOT released this way. The pole binding lives in
  // `declarations`, and `declarations_faction_uniq` has no status predicate —
  // a disbanded faction's declarations row keeps holding its pole until
  // something explicitly deletes it (a later task's releaseTx). Every
  // transition out of HOLDING must release the pole itself, or it stays held
  // silently.
  uniqTexture: uniqueIndex("factions_holding_texture_uniq")
    .on(t.serverId, t.texture)
    .where(sql`${t.status} IN ('reserved','active','dormant')`),
  uniqTag: uniqueIndex("factions_holding_tag_uniq")
    .on(t.serverId, sql`lower(${t.tag})`)
    .where(sql`${t.status} IN ('reserved','active','dormant')`),
}));

/**
 * The pole binding, for clans and solos alike (spec §4.1; base-declaration
 * design §8 option C). One row per declared pole.
 *
 * ⚠️ The two CHECKs are the guard, not the export list. `declarations_one_owner`
 * is rule 3 made structural; `declarations_one_evidence` is what makes it
 * impossible for anything — the site included — to bind a pole without
 * citing a ceremony the detector wrote or a raise the log holds.
 */
export const declarations = pgTable("declarations", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  poleKey: text("pole_key").notNull(),
  x: numeric("x", { precision: 12, scale: 2 }).notNull(),
  y: numeric("y", { precision: 12, scale: 2 }).notNull(),
  z: numeric("z", { precision: 12, scale: 2 }).notNull(),
  ownerFactionId: bigint("owner_faction_id", { mode: "number" }).references(() => factions.id),
  ownerDayzId: text("owner_dayz_id"),
  evidenceEventId: bigint("evidence_event_id", { mode: "number" }).references(() => events.id),
  evidenceCeremonyId: bigint("evidence_ceremony_id", { mode: "number" }).references(() => ceremonies.id),
  declaredAt: timestamp("declared_at", { withTimezone: true }).notNull(),
}, (t) => ({
  oneOwner: check("declarations_one_owner",
    sql`(${t.ownerFactionId} IS NULL) <> (${t.ownerDayzId} IS NULL)`),
  oneEvidence: check("declarations_one_evidence",
    sql`(${t.evidenceEventId} IS NULL) <> (${t.evidenceCeremonyId} IS NULL)`),
  uniqPole: uniqueIndex("declarations_pole_uniq").on(t.serverId, t.poleKey),
  uniqFaction: uniqueIndex("declarations_faction_uniq").on(t.ownerFactionId)
    .where(sql`${t.ownerFactionId} IS NOT NULL`),
  uniqPlayer: uniqueIndex("declarations_player_uniq").on(t.serverId, t.ownerDayzId)
    .where(sql`${t.ownerDayzId} IS NOT NULL`),
}));

/**
 * Every faction lifecycle transition, append-only, in the order they happened.
 *
 * The public feed's queue and, later, spec §11's web war log. Nothing updates
 * a row here but `posted_at`; nothing deletes.
 */
export const factionEvents = pgTable("faction_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  factionId: bigint("faction_id", { mode: "number" }).notNull().references(() => factions.id),
  kind: text("kind").$type<FactionEventKind>().notNull(),
  /**
   * When the transition happened — NOT when the row was written.
   *
   * ⚠️ The embed's timestamp comes from this column, and the backfill inserts
   * rows for foundings days in the past. Defaulting it to now() would date
   * every backfilled post to the moment of the deploy.
   */
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  /**
   * The display fields, FROZEN at write time.
   *
   * ⚠️ Never re-read from `factions` at post time. A rename that posts late
   * would print today's name on both halves — "X renamed to X" — and a
   * disband post would have to read a row whose identity has already been
   * released to the pool. Same reasoning as `supply_uploads` storing the
   * baseline the game server OBSERVED rather than recomputing it.
   */
  payload: jsonb("payload").notNull(),
  /** Null means still queued. The feed tick's whole state. */
  postedAt: timestamp("posted_at", { withTimezone: true }),
}, (t) => ({
  kindValid: check("faction_events_kind_valid",
    sql`${t.kind} IN ('founded','activated','lapsed','renamed','rebound','dormant','revived','disbanded')`),
  // ⚠️ The pole invariant, enforced by the database rather than by every
  // author remembering it. This is the first table whose entire purpose is
  // to be published; `poles.pole_key`'s own comment says a coordinate "must
  // never reach a public read model", and once one is in a Discord channel
  // it is in screenshots and cannot be recalled.
  noCoordinates: check("faction_events_no_coordinates",
    sql`NOT (${t.payload} ? 'poleKey' OR ${t.payload} ? 'x' OR ${t.payload} ? 'y' OR ${t.payload} ? 'z')`),
  // The feed's queue. Over `id` alone because the tick reads in id order and
  // stops at the first failure — it never searches within the unposted set.
  queue: index("faction_events_queue_idx").on(t.id).where(sql`${t.postedAt} IS NULL`),
  // Per-faction history, for spec §11's web war log.
  byFaction: index("faction_events_faction_idx").on(t.factionId, t.occurredAt),
}));

/** One season per server, wipe to wipe. At most one open (endedAt null) at a time. */
export const seasons = pgTable("seasons", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  number: integer("number").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  championFactionId: bigint("champion_faction_id", { mode: "number" }).references(() => factions.id),
  /**
   * The week-close high-water mark (spec §7 vs §4.8 ruling, increment 4 task
   * 1 brief): null means no week has been closed yet. Advanced in the same
   * transaction as that week's `alpha_weeks` rows (compare-and-set on the
   * previous value), including a scoreless week that writes zero rows —
   * without this column the tick would re-examine that week forever.
   */
  weekClosedThrough: timestamp("week_closed_through", { withTimezone: true }),
}, (t) => ({
  oneOpen: uniqueIndex("seasons_open_uniq").on(t.serverId).where(sql`${t.endedAt} IS NULL`),
  uniqNumber: uniqueIndex("seasons_number_uniq").on(t.serverId, t.number),
}));

/** A raid: the first lower of a raiding streak against a victim, scored once and never recomputed (spec §8.1). */
export const raids = pgTable("raids", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  seasonId: bigint("season_id", { mode: "number" }).notNull().references(() => seasons.id),
  serverId: integer("server_id").notNull().references(() => servers.id),
  victimFactionId: bigint("victim_faction_id", { mode: "number" }).notNull().references(() => factions.id),
  raiderDayzId: text("raider_dayz_id").notNull(),
  raiderFactionId: bigint("raider_faction_id", { mode: "number" }).references(() => factions.id),
  firstLowerEventId: bigint("first_lower_event_id", { mode: "number" }).notNull().references(() => events.id),
  firstLowerAt: timestamp("first_lower_at", { withTimezone: true }).notNull(),
  lastLowerAt: timestamp("last_lower_at", { withTimezone: true }).notNull(),
  /**
   * The id of the highest `flag.lowered` event folded into this raid so far.
   * ⚠️ This, not `last_lower_at`, is the absorb path's true idempotency
   * guard: a replayed event (any at-least-once redelivery, not only a crash)
   * carries an id no greater than this column, so the raid consumer treats
   * `ev.id <= lastLowerEventId` as already-applied and skips the update
   * rather than double-counting `lower_count`.
   */
  lastLowerEventId: bigint("last_lower_event_id", { mode: "number" }).notNull().references(() => events.id),
  lowerCount: integer("lower_count").notNull().default(1),
  /** Spec §8.1: recorded at write time, never recomputed. */
  points: integer("points").notNull(),
  victimRankAtLower: integer("victim_rank_at_lower"),
  rankedCountAtLower: integer("ranked_count_at_lower").notNull(),
  weekStart: timestamp("week_start", { withTimezone: true }).notNull(),
}, (t) => ({
  uniqFirstLower: uniqueIndex("raids_first_lower_uniq").on(t.firstLowerEventId),
  byVictimOpen: index("raids_victim_recent_idx").on(t.victimFactionId, t.firstLowerAt),
  byWeek: index("raids_week_idx").on(t.seasonId, t.weekStart),
}));

/** A successful defense: a member's raise that ends a flag-down clock (spec §5.8). */
export const defenses = pgTable("defenses", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  factionId: bigint("faction_id", { mode: "number" }).notNull().references(() => factions.id),
  seasonId: bigint("season_id", { mode: "number" }).notNull().references(() => seasons.id),
  raisedByDayzId: text("raised_by_dayz_id").notNull(),
  eventId: bigint("event_id", { mode: "number" }).notNull().references(() => events.id),
  flagDownSince: timestamp("flag_down_since", { withTimezone: true }).notNull(),
  defendedAt: timestamp("defended_at", { withTimezone: true }).notNull(),
  siegeSeconds: integer("siege_seconds").notNull(),
}, (t) => ({ uniqEvent: uniqueIndex("defenses_event_uniq").on(t.eventId) }));

/** Season scoreboard row, one per faction per season (spec §8). */
export const seasonStandings = pgTable("season_standings", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  seasonId: bigint("season_id", { mode: "number" }).notNull().references(() => seasons.id),
  factionId: bigint("faction_id", { mode: "number" }).notNull().references(() => factions.id),
  points: integer("points").notNull().default(0),
  raids: integer("raids").notNull().default(0),
  timesRaided: integer("times_raided").notNull().default(0),
  defenses: integer("defenses").notNull().default(0),
}, (t) => ({ uniq: uniqueIndex("season_standings_uniq").on(t.seasonId, t.factionId) }));

/** One faction's rank in the weekly @Alpha top 3 (spec §4.8, §7). Silence writes no row. */
export const alphaWeeks = pgTable("alpha_weeks", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  seasonId: bigint("season_id", { mode: "number" }).notNull().references(() => seasons.id),
  weekStart: timestamp("week_start", { withTimezone: true }).notNull(),
  rank: integer("rank").notNull(),
  factionId: bigint("faction_id", { mode: "number" }).notNull().references(() => factions.id),
  points: integer("points").notNull(),
}, (t) => ({
  uniq: uniqueIndex("alpha_weeks_uniq").on(t.seasonId, t.weekStart, t.rank),
  rankValid: check("alpha_weeks_rank_valid", sql`${t.rank} between 1 and 3`),
}));

/** A faction's final standing for a closed season (spec §8, §7). One row per faction per season. */
export const seasonResults = pgTable("season_results", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  seasonId: bigint("season_id", { mode: "number" }).notNull().references(() => seasons.id),
  factionId: bigint("faction_id", { mode: "number" }).notNull().references(() => factions.id),
  rank: integer("rank").notNull(),
  points: integer("points").notNull(),
  raids: integer("raids").notNull(),
  timesRaided: integer("times_raided").notNull(),
  defenses: integer("defenses").notNull(),
  statusAtClose: text("status_at_close").notNull(),
}, (t) => ({
  uniq: uniqueIndex("season_results_uniq").on(t.seasonId, t.factionId),
  statusValid: check("season_results_status_valid",
    sql`${t.statusAtClose} in ('active','dormant','disbanded','lapsed','reserved')`),
}));

/**
 * Every `pos`-bearing event, projected (spec §4.9). The last fix per player
 * is the newest row; a reaper keeps POSITION_RETENTION_MS. ⚠️ Never derive
 * movement from consecutive rows — fast travel teleports (§14).
 */
export const playerPositions = pgTable("player_positions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  dayzId: text("dayz_id").notNull(),
  x: numeric("x", { precision: 12, scale: 2 }).notNull(),
  z: numeric("z", { precision: 12, scale: 2 }).notNull(),
  alt: numeric("alt", { precision: 12, scale: 2 }).notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  eventId: bigint("event_id", { mode: "number" }).notNull().references(() => events.id),
}, (t) => ({
  uniqEvent: uniqueIndex("player_positions_event_uniq").on(t.eventId),
  byPlayer: index("player_positions_player_idx").on(t.serverId, t.dayzId, sql`${t.occurredAt} desc`),
  byOccurred: index("player_positions_occurred_idx").on(t.occurredAt),
}));

/**
 * A non-member seen inside a declaration's WATCH_ZONE_RADIUS_M (spec §4.9).
 * One row per (declaration, player); `last_alert_at` drives the 20-minute
 * cooldown, `last_seen_at` the 60-minute drop-off, and `last_x/last_z` is
 * the last fix INSIDE the zone — the only position of a non-member the map
 * may ever show (§10.3 rule three).
 */
export const intruderSightings = pgTable("intruder_sightings", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  declarationId: bigint("declaration_id", { mode: "number" }).notNull().references(() => declarations.id, { onDelete: "cascade" }),
  dayzId: text("dayz_id").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  lastAlertAt: timestamp("last_alert_at", { withTimezone: true }).notNull(),
  distanceM: integer("distance_m").notNull(),
  lastX: numeric("last_x", { precision: 12, scale: 2 }).notNull(),
  lastZ: numeric("last_z", { precision: 12, scale: 2 }).notNull(),
}, (t) => ({
  uniqSighting: uniqueIndex("intruder_sightings_uniq").on(t.declarationId, t.dayzId),
  byLastSeen: index("intruder_sightings_last_seen_idx").on(t.lastSeenAt),
}));

/** Clan pins (spec §4.10): the one member-entered coordinate; read by nothing but the clan's own map. */
export const clanPins = pgTable("clan_pins", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  factionId: bigint("faction_id", { mode: "number" }).notNull().references(() => factions.id, { onDelete: "cascade" }),
  dayzId: text("dayz_id").notNull(),
  x: numeric("x", { precision: 12, scale: 2 }).notNull(),
  z: numeric("z", { precision: 12, scale: 2 }).notNull(),
  icon: text("icon").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => ({
  iconValid: check("clan_pins_icon_valid", sql`${t.icon} IN ('loot','vehicle','enemy','meet','danger','note')`),
  byFaction: index("clan_pins_faction_idx").on(t.factionId, t.expiresAt),
}));

/** Succession by silence (spec §4.6, §5.4). One open claim per clan. */
export const successionClaims = pgTable("succession_claims", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  factionId: bigint("faction_id", { mode: "number" }).notNull().references(() => factions.id, { onDelete: "cascade" }),
  serverId: integer("server_id").notNull().references(() => servers.id),
  claimantDayzId: text("claimant_dayz_id").notNull(),
  claimantDiscordId: text("claimant_discord_id").notNull(),
  leaderDayzId: text("leader_dayz_id").notNull(),
  leaderDiscordId: text("leader_discord_id").notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
  resolvesAt: timestamp("resolves_at", { withTimezone: true }).notNull(),
  outcome: text("outcome"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}, (t) => ({
  outcomeValid: check("succession_claims_outcome_valid", sql`${t.outcome} IS NULL OR ${t.outcome} IN ('succeeded','voided')`),
  closedIffOutcome: check("succession_claims_closed_iff_outcome", sql`(${t.closedAt} IS NULL) = (${t.outcome} IS NULL)`),
  oneOpen: uniqueIndex("succession_claims_open_uniq").on(t.factionId).where(sql`${t.closedAt} IS NULL`),
}));

/**
 * A no-confidence vote (spec §4.6, §5.7). `electorate_dayz_ids` freezes who
 * may vote at open (full members except the leader); `electorate_size` is
 * what the threshold reads and shrinks when one of them leaves. A ballot is
 * a yes; there is no "no".
 */
export const factionVotes = pgTable("faction_votes", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  factionId: bigint("faction_id", { mode: "number" }).notNull().references(() => factions.id, { onDelete: "cascade" }),
  serverId: integer("server_id").notNull().references(() => servers.id),
  nomineeDayzId: text("nominee_dayz_id").notNull(),
  nomineeDiscordId: text("nominee_discord_id").notNull(),
  openedByDayzId: text("opened_by_dayz_id").notNull(),
  leaderDayzId: text("leader_dayz_id").notNull(),
  leaderDiscordId: text("leader_discord_id").notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
  closesAt: timestamp("closes_at", { withTimezone: true }).notNull(),
  electorateDayzIds: text("electorate_dayz_ids").array().notNull(),
  electorateSize: integer("electorate_size").notNull(),
  result: text("result"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}, (t) => ({
  resultValid: check("faction_votes_result_valid", sql`${t.result} IS NULL OR ${t.result} IN ('passed','failed')`),
  closedIffResult: check("faction_votes_closed_iff_result", sql`(${t.closedAt} IS NULL) = (${t.result} IS NULL)`),
  sizeNonNegative: check("faction_votes_size_non_negative", sql`${t.electorateSize} >= 0`),
  oneOpen: uniqueIndex("faction_votes_open_uniq").on(t.factionId).where(sql`${t.closedAt} IS NULL`),
}));

export const factionVoteBallots = pgTable("faction_vote_ballots", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  voteId: bigint("vote_id", { mode: "number" }).notNull().references(() => factionVotes.id, { onDelete: "cascade" }),
  dayzId: text("dayz_id").notNull(),
  castAt: timestamp("cast_at", { withTimezone: true }).notNull(),
}, (t) => ({
  uniq: uniqueIndex("faction_vote_ballots_uniq").on(t.voteId, t.dayzId),
}));

/**
 * The vault (spec §4.10; guide ch. 8). `confirmed_at < rotated_at` (or null
 * after a rotation) renders "changed in game?"; `exposed_at` non-null renders
 * "known to an ex-member" — set on every lock a leaver could see, cleared by
 * rotate. ⚠️ `code` never leaves the package except through `revealLock`.
 */
export const vaultLocks = pgTable("vault_locks", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  factionId: bigint("faction_id", { mode: "number" }).notNull().references(() => factions.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  code: char("code", { length: 4 }).notNull(),
  note: text("note"),
  minRole: text("min_role").notNull(),
  createdByDayzId: text("created_by_dayz_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  rotatedByDayzId: text("rotated_by_dayz_id"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  exposedAt: timestamp("exposed_at", { withTimezone: true }),
}, (t) => ({
  minRoleValid: check("vault_locks_min_role_valid", sql`${t.minRole} IN ('leader','officer','member')`),
  codeDigits: check("vault_locks_code_digits", sql`${t.code} ~ '^[0-9]{4}$'`),
  byFaction: index("vault_locks_faction_idx").on(t.factionId),
}));

/** Who did what to which lock (spec §4.10). Outlives the lock: `lock_id` nulls on delete, `lock_name` is frozen at write. */
export const vaultHistory = pgTable("vault_history", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  factionId: bigint("faction_id", { mode: "number" }).notNull().references(() => factions.id, { onDelete: "cascade" }),
  lockId: bigint("lock_id", { mode: "number" }).references(() => vaultLocks.id, { onDelete: "set null" }),
  lockName: text("lock_name").notNull(),
  action: text("action").notNull(),
  dayzId: text("dayz_id").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull(),
}, (t) => ({
  actionValid: check("vault_history_action_valid", sql`${t.action} IN ('added','edited','rotated','revealed','confirmed','deleted')`),
  byFaction: index("vault_history_faction_idx").on(t.factionId, t.at),
}));

/** A 24 h voice guest pass (spec §4.10, §5.6). Open = revoked_at, converted_at null and expires_at > now; the grant checks that under the clan's row lock. */
export const guestPasses = pgTable("guest_passes", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  factionId: bigint("faction_id", { mode: "number" }).notNull().references(() => factions.id, { onDelete: "cascade" }),
  discordUserId: text("discord_user_id").notNull(),
  grantedByDiscordId: text("granted_by_discord_id").notNull(),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  convertedAt: timestamp("converted_at", { withTimezone: true }),
}, (t) => ({
  byUser: index("guest_passes_user_idx").on(t.factionId, t.discordUserId),
}));

/** Connect → disconnect, or → the next ADM boundary (`restart`). Spec §4.9. */
export const playerSessions = pgTable("player_sessions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  dayzId: text("dayz_id").notNull(),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull(),
  connectEventId: bigint("connect_event_id", { mode: "number" }).notNull().references(() => events.id),
  disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
  closeReason: text("close_reason"),
}, (t) => ({
  reasonValid: check("player_sessions_reason_valid", sql`${t.closeReason} IS NULL OR ${t.closeReason} IN ('disconnect','restart')`),
  closedIffReason: check("player_sessions_closed_iff_reason", sql`(${t.disconnectedAt} IS NULL) = (${t.closeReason} IS NULL)`),
  uniqConnect: uniqueIndex("player_sessions_connect_uniq").on(t.connectEventId),
  openByPlayer: uniqueIndex("player_sessions_open_uniq").on(t.serverId, t.dayzId).where(sql`${t.disconnectedAt} IS NULL`),
  byPlayer: index("player_sessions_player_idx").on(t.serverId, t.dayzId, t.connectedAt),
}));

/**
 * Every death (spec §4.9). `killer_dayz_id` null = not a player (infected,
 * fall, vehicle, bled out…); PvP reads filter on it being set. Faction ids
 * and `friendly_fire` are resolved AT `occurred_at` from membership_history.
 * ⚠️ Stats, never points: nothing reads this into season_standings (§11).
 */
export const kills = pgTable("kills", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  eventId: bigint("event_id", { mode: "number" }).notNull().references(() => events.id),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  victimDayzId: text("victim_dayz_id").notNull(),
  killerDayzId: text("killer_dayz_id"),
  weapon: text("weapon"),
  distanceM: numeric("distance_m", { precision: 8, scale: 1 }),
  /**
   * ⚠️ DESCRIPTIVE ONLY — no read anywhere derives behaviour from it. It holds
   * `DeathCause ∪ {'pvp'}`: `kills-tick.ts` writes the literal `'pvp'` for a
   * player kill, which is NOT a member of `DeathCause`. PvP is decided by
   * `killer_dayz_id` being set and different from `victim_dayz_id`, never by
   * this column — `cause = 'pvp'` would wrongly count self-kills.
   */
  cause: text("cause").notNull(),
  victimFactionId: bigint("victim_faction_id", { mode: "number" }).references(() => factions.id),
  killerFactionId: bigint("killer_faction_id", { mode: "number" }).references(() => factions.id),
  friendlyFire: boolean("friendly_fire").notNull().default(false),
}, (t) => ({
  uniqEvent: uniqueIndex("kills_event_uniq").on(t.eventId),
  byVictim: index("kills_victim_idx").on(t.serverId, t.victimDayzId, t.occurredAt),
  byKiller: index("kills_killer_idx").on(t.serverId, t.killerDayzId, t.occurredAt),
  // ⚠️ Bare-column, in addition to the two composites above. `resolvePlayer`'s
  // fallback EXISTS (stats.ts) has no `server_id` to lead with, so neither
  // composite's leading column is usable and the check degrades to a
  // sequential scan of `kills` — on a public, unauthenticated route.
  byVictimDayz: index("kills_victim_dayz_idx").on(t.victimDayzId),
  byKillerDayz: index("kills_killer_dayz_idx").on(t.killerDayzId),
}));

/**
 * Full-membership spans, one row per (clan, player, span), written only by
 * the bot's membership reconciler (spec §11: the stats increment never
 * touches roster invariants). `left_at` null = still a full member.
 */
export const membershipHistory = pgTable("membership_history", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  factionId: bigint("faction_id", { mode: "number" }).notNull().references(() => factions.id),
  dayzId: text("dayz_id").notNull(),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull(),
  leftAt: timestamp("left_at", { withTimezone: true }),
}, (t) => ({
  openUniq: uniqueIndex("membership_history_open_uniq").on(t.factionId, t.dayzId).where(sql`${t.leftAt} IS NULL`),
  byPlayer: index("membership_history_player_idx").on(t.serverId, t.dayzId, t.joinedAt),
}));

/**
 * The #war-log queue (spec §4.7, §9.2). Same no-coordinates invariant as
 * `faction_events`, for the same reason: this table's whole purpose is to be
 * published.
 */
export const warLogEvents = pgTable("war_log_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  kind: text("kind").$type<WarLogKind>().notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  payload: jsonb("payload").notNull(),
  postedAt: timestamp("posted_at", { withTimezone: true }),
}, (t) => ({
  kindValid: check("war_log_events_kind_valid", sql`${t.kind} IN ('raid','defense','week_closed','season_closed')`),
  noCoordinates: check("war_log_events_no_coordinates", sql`NOT (${t.payload} ? 'poleKey' OR ${t.payload} ? 'x' OR ${t.payload} ? 'y' OR ${t.payload} ? 'z')`),
  queue: index("war_log_events_queue_idx").on(t.id).where(sql`${t.postedAt} IS NULL`),
}));

/**
 * The clan notices queue (spec §9.3, §9.4): a channel post or a DM, per
 * faction or per player. Same no-coordinates invariant as `faction_events`
 * and `war_log_events`.
 */
export const clanNotices = pgTable("clan_notices", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  factionId: bigint("faction_id", { mode: "number" }).references(() => factions.id),
  target: text("target").$type<NoticeTarget>().notNull(),
  /**
   * The user id for a DM. For a channel notice: the clan's text channel id,
   * or NULL when the clan has none yet — increment 3b creates channels; until
   * it does, channel rows wait here (posted_at null, never failed) and the
   * poster resolves the id from factions.discord_text_channel_id at post time.
   */
  discordTargetId: text("discord_target_id"),
  kind: text("kind").$type<ClanNoticeKind>().notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  payload: jsonb("payload").notNull(),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  failedAt: timestamp("failed_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
}, (t) => ({
  targetValid: check("clan_notices_target_valid", sql`${t.target} IN ('channel','dm')`),
  dmHasTarget: check("clan_notices_dm_has_target", sql`${t.target} <> 'dm' OR ${t.discordTargetId} IS NOT NULL`),
  noCoordinates: check("clan_notices_no_coordinates", sql`NOT (${t.payload} ? 'poleKey' OR ${t.payload} ? 'x' OR ${t.payload} ? 'y' OR ${t.payload} ? 'z')`),
  queue: index("clan_notices_queue_idx").on(t.discordTargetId, t.id).where(sql`${t.postedAt} IS NULL AND ${t.failedAt} IS NULL`),
}));

/**
 * Achievements (spec 2026-09-11 §5). One row per unlock, never deleted; the
 * primary key is what makes a rule firing twice harmless. `earnedAt` is when
 * the EVIDENCE happened — a backfilled Centurion is dated to the 100th kill,
 * not to the backfill. `ownerId` is a dayz_id for a player or the faction id
 * as text for a clan; clan rows survive renames and disbands unchanged.
 */
export const achievementUnlocks = pgTable("achievement_unlocks", {
  ownerKind: text("owner_kind").$type<"player" | "clan">().notNull(),
  ownerId: text("owner_id").notNull(),
  key: text("key").notNull(),
  earnedAt: timestamp("earned_at", { withTimezone: true }).notNull(),
  /** The kill / raid / event / session / defense row that crossed the line, when there is one. */
  evidenceId: bigint("evidence_id", { mode: "number" }),
  evidence: jsonb("evidence").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
  noticedAt: timestamp("noticed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.ownerKind, t.ownerId, t.key] }),
  ownerKindValid: check("achievement_unlocks_owner_kind_valid", sql`${t.ownerKind} IN ('player','clan')`),
  // ⚠️ Same predicate as clan_notices: evidence is rendered on the site and in Discord.
  noCoordinates: check("achievement_unlocks_no_coordinates", sql`NOT (${t.evidence} ? 'poleKey' OR ${t.evidence} ? 'x' OR ${t.evidence} ? 'y' OR ${t.evidence} ? 'z')`),
  byKey: index("achievement_unlocks_key_idx").on(t.key, t.earnedAt),
}));

/** A cache of the last computed count per owner and key — the profile reads one row per achievement. Safe to truncate; a full pass rebuilds it. */
export const achievementProgress = pgTable("achievement_progress", {
  ownerKind: text("owner_kind").$type<"player" | "clan">().notNull(),
  ownerId: text("owner_id").notNull(),
  key: text("key").notNull(),
  count: integer("count").notNull(),
  target: integer("target").notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.ownerKind, t.ownerId, t.key] }) }));

/**
 * Lifetime counters for facts whose source rows vanish: pins are deleted by
 * players (cartographer), positions are retained 30 days (explorer). `detail`
 * holds what the counter needs to stay exact — for explorer the visited
 * 1 km square INDICES (never x/z), plus `crossedAt` once the target was met.
 */
export const achievementCounters = pgTable("achievement_counters", {
  ownerKind: text("owner_kind").$type<"player" | "clan">().notNull(),
  ownerId: text("owner_id").notNull(),
  key: text("key").notNull(),
  value: integer("value").notNull().default(0),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.ownerKind, t.ownerId, t.key] }),
  noCoordinates: check("achievement_counters_no_coordinates", sql`NOT (${t.detail} ? 'x' OR ${t.detail} ? 'z' OR ${t.detail} ? 'poleKey')`),
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
 * The same shape as `supply_uploads`, for the second projected file: the
 * fast-travel config (`pra-teleport-hub.json`), which carries every ACTIVE
 * clan's declared pole as a travel point on top of the 209 fixed ones. One
 * row per server; same hash-then-baseline contract, same hazards — see
 * `supply_uploads` above and apps/ingest-worker/src/projection-upload.ts.
 */
export const travelUploads = pgTable("travel_uploads", {
  serverId: integer("server_id").primaryKey().references(() => servers.id),
  contentHash: text("content_hash").notNull(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull(),
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
  /**
   * `pending` from accept until the log sees the player within
   * JOIN_PRESENCE_RADIUS_M of the clan's declaration; `full` after (spec
   * §5.3). ⚠️ Every "is a member" read means `status = 'full'` (spec §4.5,
   * §14) — a pending member is on this table and NOT on the roster. The cap
   * counts both. Default `full` so every row that predates the column is a
   * member exactly as it was.
   */
  status: text("status").notNull().default("full"),
  /** Set at accept; the 7-day no-show clock runs from here. */
  pendingSince: timestamp("pending_since", { withTimezone: true }),
  /** The event that promoted them — evidence they stood at the base. */
  seenAtBaseEventId: bigint("seen_at_base_event_id", { mode: "number" }).references(() => events.id),
}, (t) => ({
  roleValid: check("faction_members_role_valid",
    sql`${t.role} IN ('leader','officer','member')`),
  statusValid: check("faction_members_status_valid", sql`${t.status} IN ('pending','full')`),
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
 * Names and tags held until season end after a rename or a disband (spec
 * §4.4; guide ch. 8). The uniqueness check at claim and rename consults
 * holding factions AND rows here with `held_until > now()`.
 *
 * ⚠️ `held_until` is the sentinel `'infinity'` until the season closes; the
 * wipe script (spec §8.5) rewrites it to the season's `ended_at`. Compare it
 * in SQL, never in JS — postgres.js hands `infinity` back as an invalid Date.
 * ⚠️ A lapsed reservation writes no hold: nothing was ever flown under it.
 */
export const identityHolds = pgTable("identity_holds", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  serverId: integer("server_id").notNull().references(() => servers.id),
  kind: text("kind").notNull(),
  valueLower: text("value_lower").notNull(),
  factionId: bigint("faction_id", { mode: "number" }).notNull().references(() => factions.id),
  reason: text("reason").notNull(),
  heldUntil: timestamp("held_until", { withTimezone: true }).notNull(),
}, (t) => ({
  kindValid: check("identity_holds_kind_valid", sql`${t.kind} IN ('name','tag')`),
  reasonValid: check("identity_holds_reason_valid", sql`${t.reason} IN ('renamed','disbanded')`),
  // One live hold per value; a later hold on the same value upserts.
  uniqValue: uniqueIndex("identity_holds_uniq").on(t.serverId, t.kind, t.valueLower),
}));

/**
 * The second door onto a roster (spec §4.5; guide ch. 8): a linked player asks
 * a recruiting clan; an officer decides. Accepting inserts a PENDING member,
 * exactly like an invite.
 */
export const factionJoinRequests = pgTable("faction_join_requests", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  factionId: bigint("faction_id", { mode: "number" }).notNull().references(() => factions.id, { onDelete: "cascade" }),
  serverId: integer("server_id").notNull().references(() => servers.id),
  dayzId: text("dayz_id").notNull(),
  discordId: text("discord_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decidedByDiscordId: text("decided_by_discord_id"),
  decision: text("decision"),
}, (t) => ({
  decisionValid: check("faction_join_requests_decision_valid", sql`${t.decision} IS NULL OR ${t.decision} IN ('accepted','declined')`),
  decisionWithDecided: check("faction_join_requests_decision_requires_decided", sql`(${t.decision} IS NULL) = (${t.decidedAt} IS NULL)`),
  uniqOpen: uniqueIndex("faction_join_requests_open_uniq").on(t.factionId, t.dayzId).where(sql`${t.decidedAt} IS NULL`),
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

/**
 * One row per server per two-hour restart slot (spec 2026-09-12 §5): the
 * bot's proof that the schedule ran, and its idempotency guard — a row for
 * (server, slot) means the slot is handled, whatever the outcome.
 *
 * ⚠️ Written by restart-tick.ts alone, with a single statement that touches
 * no other table; it needs no place in the §4.12 lock order.
 */
export const serverRestarts = pgTable("server_restarts", {
  serverId: integer("server_id").notNull().references(() => servers.id),
  /** The slot start — an even UTC hour. */
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
  /** restarted = Nitrado accepted the POST; skipped = server was not `started`; missed = the grace window closed with nothing fired. */
  outcome: text("outcome").$type<"restarted" | "skipped" | "missed">().notNull(),
  detail: jsonb("detail").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
}, (t) => ({
  pk: primaryKey({ columns: [t.serverId, t.scheduledFor] }),
  outcomeValid: check("server_restarts_outcome_valid", sql`${t.outcome} IN ('restarted','skipped','missed')`),
}));

/**
 * One row per weekly vehicle wipe, written when its announcement is resolved.
 *
 * ⚠️ Keyed on `wipe_at` ALONE — no `server_id`, unlike `server_restarts` which this
 * otherwise copies. The rotation is a property of the calendar, not of a server: every
 * server wipes the same vehicle in the same week, and the announcement is one message to
 * one channel. A per-server key would post one identical message per active server.
 *
 * ⚠️ `event_name` is stored even though it is derivable from `wipe_at`. The row records
 * WHAT WAS ANNOUNCED; recomputing it later against an edited rotation list would make
 * the record lie. Same reason the faction feed freezes its payload at write time.
 */
export const vehicleWipeAnnouncements = pgTable("vehicle_wipe_announcements", {
  /** The Monday wipe slot this announces — an even UTC hour. */
  wipeAt: timestamp("wipe_at", { withTimezone: true }).primaryKey(),
  announcedAt: timestamp("announced_at", { withTimezone: true }).notNull(),
  eventName: text("event_name").notNull(),
  /** posted = the message went out; missed = the cutoff passed with nothing sent. */
  outcome: text("outcome").$type<"posted" | "missed">().notNull(),
}, (t) => ({
  outcomeValid: check("vehicle_wipe_announcements_outcome_valid", sql`${t.outcome} IN ('posted','missed')`),
}));
