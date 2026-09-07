# Leadership and the Vault (increment 7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A clan is never left without a leader and never has to trust an ex-member: succession by silence, no-confidence votes, the guild-removal handler, the vault, 24 h voice guest passes with `/guest`, and `[TAG] gamertag` nicknames.

**Architecture:** One migration (0028) adds `succession_claims`, `faction_votes` (+ `faction_vote_ballots`), `vault_locks` (+ `vault_history`), `guest_passes` and `factions.next_vote_allowed_at`. Every rule lives in `packages/roster/src/internal` stores shared by the bot and the site: the vote freeze and the electorate decrement ride inside the existing `kick`/`leave`/`transfer`, vault exposure rides inside `kick`/`leave`, and the guild-removal path is an internal-only function the web cannot reach. The bot gains a leadership tick (claims resolve, votes close), a `guildMemberRemove` handler, a `/guest` command, and two new steps in the structure reconciler (guest-pass voice overwrites diffed against open passes; nicknames diffed against `[TAG] gamertag`). The site gains `/clan/vault`, the claim/vote sections on `/clan`, and guest passes on `/clan/settings`, all through twelve new `@factions/roster` exports. Leader silence and claim voiding read `players.last_seen_at`, the projection the player tick already keeps.

**Tech Stack:** drizzle-orm 0.36 (migration 0028), postgres.js, discord.js 14 (permission overwrites, `guildMemberRemove`, a slash command with a user option), vitest, Next 16 pages.

**Spec:** `docs/superpowers/specs/2026-09-04-clan-wars-target-state-design.md` — §4.3 (`next_vote_allowed_at`), §4.6 (leadership tables), §4.10 (`vault_locks`, `vault_history`, `guest_passes`), §4.12 (lock order), §5.3 (leave/kick side effects), §5.4 (leadership), §5.6 (guest pass), §5.7 (no-confidence vote), §7 (succession, votes, reapers, nickname sync), §9.1 (`/guest`, nicknames), §9.3/§9.4 (the lines), §10.2 (`/clan`, `/clan/vault`, `/clan/settings`), §10.4 (exports), §13 (rule and store tests), §14 (vote freeze in the package; overwrites accumulate), §15 row 7. The guide: `../field-guide/08-running-a-clan.html` ("The Leader", "No-confidence vote", "The Vault"), `09-discord.html` ("Roles and nicknames", "Guest pass").

## Global Constraints

- **Every rule is enforced inside the package's writes, never in a page** (§10.4 ⚠️, §14): the vote freeze on `kick` and `transfer`, the electorate decrement on leave/kick, vault exposure on leave/kick, the guest-pass duplicate check under the clan's row lock, officer/leader gates. The bot's guild-removal path and the site share one store.
- **Lock order (§4.12), taken in this order by every writer that touches two:** `factions → declarations → poles → faction_members → faction_invites → faction_join_requests → faction_votes → faction_vote_ballots → succession_claims → season_standings → raids → defenses → vault_locks → clan_pins → guest_passes → faction_events → war_log_events → clan_notices`. Every new writer pair gets a staged race test that also asserts the row outcome (§13).
- **Every transition appends its notice in the same transaction** (`noticeClanTx` / `noticeUserTx` / `noticeFullMembersTx`, last). Payloads are names and numbers; never a coordinate, **never a vault code** (§9.5). The `codes_rotated` DM says "see the vault", nothing else.
- **`status = 'full'` is every membership read** (§4.5): electorates, vault visibility, successor choice, guest conversion, nickname prefix. A pending member votes in nothing, sees no vault, gets no prefix.
- **Leader authority is `faction_members.role = 'leader'`** (roster-store's `leaderIs`); `factions.leader_discord_id` is display provenance and is kept current by every leader change here (succession, vote, guild removal), the way `transfer` does.
- **Leader change order is demote-then-promote** in one transaction (`faction_members_leader_uniq`), copied from `transfer`.
- **Numbers come from `rules.ts` only:** `LEADER_SILENT_MS` (7 d), `SUCCESSION_WINDOW_MS` (48 h), `VOTE_LENGTH_MS` (48 h), `VOTE_THRESHOLD` (2/3), `FAILED_VOTE_COOLDOWN_MS` (14 d), `VAULT_CODE_DIGITS` (4), `GUEST_PASS_MS` (24 h), `ROSTER_COOLDOWN_MS` (3 d). No new guide number; `docs/guide-numbers.json` is untouched.
- **The guild-removal path is internal** (`@factions/roster/internal`), never exported from the package root; `smoke.test.ts` and `exports.test.ts` both pin the allowlist, which grows by exactly: `addLock`, `castVote`, `claimSuccession`, `confirmLock`, `deleteLock`, `editLock`, `grantGuestPass`, `openVote`, `revealLock`, `revokeGuestPass`, `rotateLocks`, `vaultFor`. The forbidden-substring test (`activate`, `dormant`, `raid`, `defense`, `declaration`, `reserve`, `createfaction`, `insert`) stays green.
- **Discord writes are reconciled, not fire-and-forget** (3b's pattern, §14 "overwrites accumulate"): guest-pass overwrites and nicknames are diffed by `structureTick` every pass against the database; strays are removed; nothing REST-writes when the cache already matches.
- **Nickname: `[TAG] gamertag` for full members of a holding clan, bare gamertag for every other linked user; truncate the gamertag, never the prefix, to 32 characters** (§9.1). Owner/outranked/no-permission users go in the existing `nicknameNoRetry` set and are logged once.
- `apps/web` imports only `@factions/roster` and `@factions/domain`; every page reading the viewer is `force-dynamic`; every write is a form POST (`api-routes.test.ts`); `/api/vault/reveal` is the one new POST that returns JSON (`Cache-Control: no-store, private`) instead of a redirect, because a code must never appear in a URL. Player-facing text says "clan", never "faction" (`copy-vocabulary.test.ts`). `/clan/vault` sits under `/clan` and is gated by the existing prefix rule; `PUBLIC_PATHS`/`PUBLIC_PREFIXES` are unchanged.
- Full gate before every commit: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force` → **26 successful, 26 total**. Never touch `factions_live`. Nothing here applies a migration anywhere but a test database.
- Commit trailers: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01Svc2Dv7g1XwWi8CSuY4h5e`.

---

## Rulings made while planning (carry into the ledger)

1. **Leader silence and claim voiding read `players.last_seen_at`**, not the event stream. The player projection stamps it from every `player.position`/`emote.performed` event, PlayerList fixes every ~5 min while online, and §7 puts succession on a 60 s clock anyway. Eligible iff `last_seen_at < now − LEADER_SILENT_MS` or no `players` row; voided iff `last_seen_at > opened_at`. Cost if wrong: a leader whose only activity in 48 h was a flag raise without a position fix in between (impossible in practice — the PlayerList fires first) would be voided one fix late.
2. **`faction_votes.electorate_dayz_ids text[]`** freezes who may vote. §4.6 stores only `electorate_size`, but "shrinks when a member in it leaves" and "arrivals are not in the electorate" cannot be evaluated without the list (a member accepted before the open and promoted to full after it is the ambiguous case). `electorate_size` stays and is what the threshold reads. Cost if wrong: one array column.
3. **Opening a vote casts the opener's ballot.** The guide: "Any full member nominates a replacement — themselves included — and that opens a vote"; a nomination is a yes. The threshold is evaluated at open, so a two-person electorate can pass on open. Cost if wrong: one ballot the opener would have cast anyway.
4. **The leader cannot open a vote** (they have `transfer`); `openVote` returns `is-leader`.
5. **A leaver's ballot is deleted with their electorate slot**; "threshold unreachable" therefore means `electorate_size = 0`, which fails the vote on the spot. The vote tick fails anything past `closes_at` that has not passed.
6. **`vault_history` outlives its lock**: `lock_id` is `on delete set null` and the row also carries `faction_id` and a frozen `lock_name`, or the `deleted` action the spec lists could never be read back.
7. **Vault permissions**: add/edit/delete/rotate are officer+ (guide ch. 8: "Officer — manage the vault"); reveal and confirm are for anyone whose rank meets the lock's `min_role`; history is leader-only (§10.2). Rank order `leader > officer > member`; a lock with `min_role = 'member'` is visible to all three.
8. **Guest passes are granted by Discord user id or by a linked gamertag** on `/clan/settings` (the site has no user picker); `/guest @user` passes the id. `revokeGuestPass` is exported alongside `grantGuestPass` because §4.10 has `revoked_at` and nothing else could set it.
9. **Guest-pass conversion is the reconciler's**: an open pass whose user is now a full member of that clan gets `converted_at` stamped and its overwrite removed (the role carries the access). Expiry needs no column; the reaper deletes rows past `expires_at`, and the reconciler removes the overwrite of any pass it no longer sees as open. Both orders are safe: a removed row makes the overwrite a stray, and strays are removed.
10. **No reconciliation of guild removals that happened while the bot was down.** A pass over "linked users not in the member cache" would mass-unlink on a cold cache (the exact failure `membersFetched` guards). Gateway event only; the runbook says so. Cost if wrong: a departed user keeps a roster row until an officer kicks them; the web's guild check still signs them out and the structure tick still strips their roles.
11. **A leader removed from the guild loses their link and solo declaration too** ("being removed from the Discord removes you from everything"), and an open claim or vote in that clan is closed silently (`voided` / `failed` with no cooldown and no notice) — its subject no longer holds the seat.
12. **Nickname reverts ride the structure tick, not a `guildMemberUpdate` handler.** With the `GuildMembers` intent the member cache carries the current nickname, so the reconciler's diff catches a manual change within one tick interval (10 s) at zero REST cost when nothing changed. Cost if wrong: a 10 s window versus an event.
13. **The leadership tick runs every bot tick** (10 s) rather than on its own 60 s throttle: two small indexed reads of open rows. §7's 60 s is a ceiling.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/db/migrations/0028_leadership_and_vault.sql`, `packages/db/src/schema.ts`, `packages/db/test/leadership-schema.test.ts` | the six tables/columns |
| `packages/domain/src/feed.ts`, `packages/domain/src/leadership.ts` (create), `packages/domain/test/leadership.test.ts` (create) | nine notice kinds; `voteThreshold`, `nicknameFor`, `canSeeLock`, `ROLE_RANK`, `randomVaultCode` |
| `apps/bot/src/notice-text.ts`, `apps/bot/test/notice-text.test.ts` | the nine renderers |
| `packages/roster/src/internal/leadership-store.ts` (create), `internal/roster-store.ts` (kick/leave/transfer), `internal/index.ts`, `packages/roster/test/leadership.test.ts` (create) | claims, votes, freeze, electorate |
| `packages/roster/src/internal/vault-store.ts` (create), `packages/roster/test/vault.test.ts` (create) | locks, history, exposure |
| `packages/roster/src/internal/guest-store.ts` (create), `packages/roster/test/guest.test.ts` (create) | passes |
| `packages/roster/src/internal/removal-store.ts` (create), `packages/roster/test/removal.test.ts` (create) | the guild-removal path |
| `apps/bot/src/leadership-tick.ts`, `apps/bot/src/guild-removal.ts`, `apps/bot/src/guest-command.ts` (create) + tests | the ticks, the handler, `/guest` |
| `apps/bot/src/guild.ts`, `apps/bot/src/structure-store.ts`, `apps/bot/src/structure-tick.ts`, `apps/bot/src/reaper-tick.ts`, `apps/bot/test/fake-guild.ts`, `apps/bot/src/discord.ts`, `apps/bot/README.md` | overwrites, nicknames, reaping, wiring |
| `packages/roster/src/leadership.ts`, `src/vault.ts`, `src/guest.ts` (create), `src/reads.ts`, `src/index.ts`, `test/exports.test.ts`, `apps/web/test/smoke.test.ts` | the twelve exports and `ClanView.leadership` / `.guestPasses` |
| `apps/web/app/clan/page.tsx`, `app/clan/vault/page.tsx`, `app/clan/vault/reveal-button.tsx`, `app/clan/settings/page.tsx`, `app/api/clan/{claim-succession,open-vote,cast-vote,guest,revoke-guest}/route.ts`, `app/api/vault/{add,edit,delete,rotate,confirm,reveal}/route.ts`, `lib/leadership-copy.ts`, `lib/vault-copy.ts`, tests | the pages |
| `docs/deploy/2026-09-09-leadership-and-vault.md`, `CLAUDE.md`, spec §15 | operations |

---

### Task 1: Migration 0028 — leadership, vault and guest tables

**Files:**
- Create: `packages/db/migrations/0028_leadership_and_vault.sql` (generated, renamed, journal tag fixed), `packages/db/test/leadership-schema.test.ts`
- Modify: `packages/db/src/schema.ts` (`factions` gains one column; new tables after `clanPins`)

**Interfaces:**
- Produces (schema exports): `successionClaims`, `factionVotes`, `factionVoteBallots`, `vaultLocks`, `vaultHistory`, `guestPasses`; `factions.nextVoteAllowedAt`.

- [ ] **Step 1: Schema.** In `factions`, after `disbandWarnedAt`:

```ts
  /** Set FAILED_VOTE_COOLDOWN_MS ahead by a failed no-confidence vote (spec §4.3, §5.7). Null = no cooldown. */
  nextVoteAllowedAt: timestamp("next_vote_allowed_at", { withTimezone: true }),
```

After `clanPins`:

```ts
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
```

Import `char` from `drizzle-orm/pg-core` alongside the existing imports.

- [ ] **Step 2: Generate, rename, fix the journal** (`pnpm --filter @factions/db generate`, rename to `0028_leadership_and_vault.sql`, tag `0028_leadership_and_vault`). Read the SQL: one `ALTER TABLE factions ADD COLUMN`, six `CREATE TABLE`, the checks, the two partial unique indexes, `ON DELETE SET NULL` on `vault_history.lock_id`, nothing dropped.
- [ ] **Step 3: Test** `packages/db/test/leadership-schema.test.ts` (shape of `map-schema.test.ts`: one faction seeded directly, `beforeAll`): (a) a second open `succession_claims` row for the faction is rejected by `succession_claims_open_uniq`, and one with `closed_at` set but `outcome` null by `succession_claims_closed_iff_outcome`; (b) a second open `faction_votes` row is rejected by `faction_votes_open_uniq`; a duplicate `(vote_id, dayz_id)` ballot by `faction_vote_ballots_uniq`; (c) `vault_locks` rejects `code = 'ab12'` (`vault_locks_code_digits`) and `min_role = 'guest'`; (d) deleting a lock nulls `vault_history.lock_id` and keeps the row; (e) deleting the faction cascades every one of the six tables.
- [ ] **Step 4: Run** the test, then the full gate → 26/26. **Commit** — `feat(db): migration 0028 — succession, votes, vault, guest passes`.

---

### Task 2: Domain rules and the nine notice renderers

**Files:**
- Create: `packages/domain/src/leadership.ts`, `packages/domain/test/leadership.test.ts`
- Modify: `packages/domain/src/feed.ts` (`CLAN_NOTICE_KINDS`), `packages/domain/src/index.ts` (`export * from "./leadership"`), `apps/bot/src/notice-text.ts`, `apps/bot/test/notice-text.test.ts`

**Interfaces:**
- Produces: `voteThreshold(electorateSize: number): number` (= `ceil(num/den × size)`, `VOTE_THRESHOLD` from rules); `ROLE_RANK = { leader: 3, officer: 2, member: 1 } as const`; `canSeeLock(role: Role, minRole: Role): boolean` (`ROLE_RANK[role] >= ROLE_RANK[minRole]`); `NICKNAME_MAX = 32`; `nicknameFor(gamertag: string, tag: string | null): string` (`[TAG] ` prefix, gamertag sliced so the whole fits 32); `randomVaultCode(rng: () => number = Math.random): string` (`VAULT_CODE_DIGITS` digits, zero-padded); `VaultAction`, `VAULT_ACTIONS`; the nine kinds appended to `CLAN_NOTICE_KINDS`: `leader_removed, succession_claimed, succession_voided, succession_done, vote_opened, vote_passed, vote_failed, codes_rotated, guest`.

- [ ] **Step 1: Rule tests** (pure): `voteThreshold(9) === 6`, `voteThreshold(8) === 6`, `voteThreshold(1) === 1`, `voteThreshold(0) === 0` (§13); `nicknameFor("A".repeat(40), "BEAR")` is exactly 32 chars and starts with `"[BEAR] "`; `nicknameFor("Wolfie", null) === "Wolfie"`; `nicknameFor("Wolfie", "bear") === "[BEAR] Wolfie"` (tag upper-cased); `canSeeLock("member", "officer") === false`, `canSeeLock("officer", "member") === true`; `randomVaultCode(() => 0)` is `"0000"`, `randomVaultCode(() => 0.9999)` is `"9999"`, and 200 draws all match `/^\d{4}$/`.
- [ ] **Step 2: Implement** `leadership.ts`; append the kinds to `feed.ts`.
- [ ] **Step 3: Renderers** in `notice-text.ts`, verbatim from §9.3/§9.4 (payload keys named here are the contract every writer in Tasks 3–6 uses):
  - `leader_removed` `{old, new}` → `👑 {old} is no longer in the Discord. {new} is now leader.`
  - `succession_claimed` `{gamertag, leader}` → `⏳ {gamertag} has claimed leadership — {leader} has 48h to show up in game` (48 from `SUCCESSION_WINDOW_MS` via the file's `hours()` helper — add one if absent)
  - `succession_voided` `{leader, claimant}` → `⏳ {leader} showed up in game. The claim by {claimant} is void.`
  - `succession_done` `{gamertag}` → `👑 {gamertag} is now leader (succession)`
  - `vote_opened` `{leader, nominee, closesAt (ISO), link}` → `🗳️ Vote opened: replace {leader} with {nominee}. Closes {time}. Vote on the site: {link}` where `{time}` is the existing date formatter used by `kicked`'s `until`, extended with the hour (`8 Sep 2026 14:00 UTC`)
  - `vote_passed` `{yes, n, nominee, old}` → `🗳️ Vote passed ({yes}/{n}). {nominee} is now leader; {old} stays as officer.`
  - `vote_failed` `{yes, n, date (ISO)}` → `🗳️ Vote failed ({yes}/{n}). Next vote possible {date}.`
  - `codes_rotated` channel `{gamertag}` → `🔐 Codes rotated by {gamertag} — see the vault.`; dm `{clan, link}` → `**{clan}** rotated its codes. See the vault: {link}` (branch on `target`, the way `kicked` does)
  - `guest` `{officer, user}` → `🎟️ {officer} gave {user} a 24h voice guest pass.` where `user` is a Discord id rendered as `<@id>` by the existing `person()` helper.
- [ ] **Step 4: Renderer tests**: the existing "exactly one renderer per kind" test now covers 39 kinds; add one verbatim assertion per new kind (both `codes_rotated` targets), and assert `vote_opened`/`codes_rotated` output never contains a 4-digit run when the payload smuggles `code: "1234"` (the type forbids it; the renderer ignores unknown keys).
- [ ] **Step 5: Run** both suites; full gate → 26/26. **Commit** — `feat(domain,bot): leadership rules and the nine notice renderers`.

---

### Task 3: Leadership store — succession claims, votes, freeze, electorate

**Files:**
- Create: `packages/roster/src/internal/leadership-store.ts`, `packages/roster/test/leadership.test.ts`
- Modify: `packages/roster/src/internal/roster-store.ts` (`kick`, `leave`, `transfer`), `packages/roster/src/internal/index.ts` (`export * from "./leadership-store"`)

**Interfaces:**
- Consumes: `voteThreshold`, `leaderIs`, `gamertagOrId`, `noticeClanTx`, `siteBaseUrl`, `players.lastSeenAt`.
- Produces (all in `leadership-store.ts`, `Tx` = the transaction type used in `notices.ts`):
  - `claimSuccessionDb(db, a: { factionId: number; claimantDiscordId: string; at: Date }): Promise<ClaimOutcome>` with `ClaimOutcome = "ok" | "not-member" | "is-leader" | "not-eligible" | "leader-active" | "claim-open"`.
  - `openVoteDb(db, a: { factionId: number; openerDiscordId: string; nomineeDiscordId: string; at: Date; siteBaseUrl: string }): Promise<{ outcome: OpenVoteOutcome; voteId: number | null }>` with `OpenVoteOutcome = "ok" | "passed" | "not-member" | "is-leader" | "nominee-not-member" | "nominee-is-leader" | "vote-open" | "cooldown"`.
  - `castVoteDb(db, a: { factionId: number; voterDiscordId: string; at: Date }): Promise<CastOutcome>` with `CastOutcome = "ok" | "passed" | "no-vote" | "not-in-electorate" | "already-voted"`.
  - `resolveSuccessionClaims(db, now: Date): Promise<{ succeeded: number; voided: number }>`; `closeExpiredVotes(db, now: Date): Promise<{ passed: number; failed: number }>`.
  - `openVoteFor(db, factionId): Promise<OpenVote | null>` and `openClaimFor(db, factionId): Promise<OpenClaim | null>` reads, where `OpenVote = { id, nomineeDayzId, nomineeGamertag, leaderGamertag, openedAt, closesAt, electorateSize, ballots: number, threshold: number, electorateDayzIds: string[] }` and `OpenClaim = { id, claimantGamertag, leaderGamertag, openedAt, resolvesAt }`.
  - `successionEligibility(db, factionId, dayzId, now): Promise<"eligible" | "is-leader" | "not-eligible" | "leader-active" | "claim-open">` (the read the page uses to show the button; the write re-checks under the lock).
  - Internal helpers used by roster-store: `applyElectorateLeaveTx(tx, a: { factionId; dayzId; at }): Promise<void>` (if an open vote lists `dayzId` in `electorate_dayz_ids`: `electorate_size − 1`, delete their ballot, then `evaluateVoteTx`), `voteIsOpenTx(tx, factionId): Promise<boolean>`, `evaluateVoteTx(tx, voteId, at): Promise<"open" | "passed" | "failed">`, `closeLeadershipSilentlyTx(tx, factionId, at)` (Task 6 uses it: open claim → `voided`, open vote → `failed`, no cooldown, no notice).
- `KickOutcome` gains `"vote-open"`; `TransferOutcome` gains `"vote-open"`.

- [ ] **Step 1: Failing tests** (fixture: server, clan BEAR seeded via `seedFaction`, five full members L (leader), O1 (officer), M1, M2, M3, one pending P; `identity_links` and `players` rows for each; `players.last_seen_at` set per case):
  1. **Claim**: L seen 8 d ago → O1 claims → `ok`, one open claim, `resolves_at = at + SUCCESSION_WINDOW_MS`, notice `succession_claimed {gamertag: O1, leader: L}`. M1 claims while O1 exists as officer → `not-eligible`; with no officers on the roster M1 → `ok`. L seen 1 d ago → `leader-active`. Second claim while one is open → `claim-open`. L → `is-leader`; P → `not-member`.
  2. **Resolve**: open claim; L's `last_seen_at` bumped to after `opened_at` → `resolveSuccessionClaims` closes it `voided`, notice `succession_voided`, roles unchanged. Open claim, no leader activity, `now = resolves_at` → `succeeded`: O1 is leader, L is `member`, `factions.leader_discord_id` = O1's id, notice `succession_done`. Claim whose claimant has since left → `voided`, no leader change.
  3. **Open vote**: M1 nominates M2 → `ok`, `electorate_dayz_ids = [O1, M1, M2, M3]` (not L, not P), `electorate_size 4`, `closes_at = at + VOTE_LENGTH_MS`, one ballot (M1's), notice `vote_opened {leader, nominee, closesAt, link}` with `link = siteBaseUrl + "/clan"`. L → `is-leader`; nominee L → `nominee-is-leader`; nominee P → `nominee-not-member`; second open → `vote-open`; `next_vote_allowed_at` in the future → `cooldown`. Two-member clan (L + M1), M1 nominates self → `passed` at open.
  4. **Cast**: threshold at size 4 is 3. M2 casts → `ok` (2 ballots); M3 casts → `passed`: M2 leader, L officer, `leader_discord_id` = M2, notice `vote_passed {yes: 3, n: 4, nominee, old}`. P casts → `not-in-electorate`; L → `not-in-electorate`; M1 again → `already-voted`; a member accepted after the open (insert a full member with `joined_at > opened_at`) → `not-in-electorate`.
  5. **Leave shrinks**: size 4, ballots 2 (M1, M2); M3 leaves → size 3, threshold 2, ballots 2 → `passed` inside `leave`'s transaction. Size 4, ballots 1; M2 (who voted) leaves → size 3, ballots 0 (their ballot deleted).
  6. **Freeze**: with a vote open, `kick(M1)` → `"vote-open"` and M1 still on the roster; `transfer(L→M1)` → `"vote-open"`; `promote(M1)` and `invite` still work.
  7. **Expiry**: `closeExpiredVotes` at `closes_at` with ballots below threshold → `failed`, `next_vote_allowed_at = now + FAILED_VOTE_COOLDOWN_MS`, notice `vote_failed {yes, n, date}`; a second call closes nothing.
  8. **Race** (§13, the pattern in `roster-races.test.ts`): `castVoteDb` (M3, the deciding ballot) and `leaveDb` (M2) started concurrently on two connections; both complete without deadlock; afterwards exactly one of `{passed with M2's ballot deleted or not}` holds and the row outcome is consistent: `result = 'passed'` iff ballots ≥ `voteThreshold(electorate_size)` at close.
- [ ] **Step 2: Implement.** Every write opens with `select id from factions where id = $1 for update` (lock order: `factions` first), then reads `faction_members` (`status = 'full'`), then touches `faction_votes` → `faction_vote_ballots` → `succession_claims`, then notices. `claimSuccessionDb`: leader row via `role = 'leader'`; silence from `players.last_seen_at` (`leftJoin players` — no row = silent); officers exist ⇒ claimant must be officer; insert; notice. `resolveSuccessionClaims`: read open claims (no lock), then per claim one transaction: lock `factions`, re-read the claim `for update`, re-check claimant is full and leader is still leader; leader's `last_seen_at > opened_at` → void + notice; else `now >= resolves_at` → demote leader to `member`, promote claimant to `leader`, update `factions.leaderDiscordId`, close `succeeded` + notice. `openVoteDb`: cooldown check on `factions.nextVoteAllowedAt`; electorate = full members except leader; insert vote with `electorateDayzIds`, size; insert opener's ballot; `evaluateVoteTx`; notice `vote_opened` (only if still open — a vote that passed at open posts `vote_passed` instead). `castVoteDb`: `onConflictDoNothing` on the ballot, `returning` decides `already-voted`; `evaluateVoteTx`. `evaluateVoteTx`: count ballots; `passed` when `ballots >= voteThreshold(size)` — demote/promote/`leaderDiscordId`/close/`vote_passed`; `failed` when `size = 0` or (called from the tick) `now >= closes_at` — close, `nextVoteAllowedAt`, `vote_failed`. `closeExpiredVotes`: open votes with `closes_at <= now`, per vote one transaction (lock, evaluate with `expired: true`).
- [ ] **Step 3: roster-store.** `kick`: before the delete, inside the transaction, take `factions` `for update` (it does not today — add it, per `transfer`'s comment) and `if (await voteIsOpenTx(tx, a.factionId)) return "vote-open"`; after the cooldown insert call `applyElectorateLeaveTx(tx, { factionId, dayzId: row.dayzId, at: a.at })`. `leave`: same `applyElectorateLeaveTx` after the cooldown insert (a leaver is never refused by the freeze — §5.7 freezes kick and transfer only). `transfer`: after the `for update`, `if (await voteIsOpenTx(...)) return "vote-open"`. Extend the two outcome unions.
- [ ] **Step 4: Run** → PASS; full gate → 26/26 (the existing `roster-departures`/`roster-roles` bot tests still pass — `kick` now locks `factions` first, which is the documented order). **Commit** — `feat(roster): succession claims, no-confidence votes, the vote freeze`.

---

### Task 4: Vault store

**Files:**
- Create: `packages/roster/src/internal/vault-store.ts`, `packages/roster/test/vault.test.ts`
- Modify: `packages/roster/src/internal/roster-store.ts` (`kick`, `leave` expose), `internal/index.ts`

**Interfaces:**
- Consumes: `canSeeLock`, `ROLE_RANK`, `randomVaultCode`, `noticeClanTx`, `noticeFullMembersTx`, `gamertagOrId`, `siteBaseUrl`.
- Produces: `type VaultActor = { factionId: number; serverId: number; dayzId: string; discordId: string; role: Role }`;
  - `addLockDb(db, actor, a: { name: string; note: string | null; minRole: Role; code?: string; at: Date; rng?: () => number }): Promise<{ outcome: "ok" | "not-permitted" | "bad-name" | "bad-note" | "bad-code"; lockId: number | null }>` (officer+; name 1–40 chars, note ≤ 140, code 4 digits if given else generated) — history `added`.
  - `editLockDb(db, actor, a: { lockId: number; name: string; note: string | null; minRole: Role; at: Date }): Promise<"ok" | "not-permitted" | "gone" | "bad-name" | "bad-note">` — history `edited`.
  - `deleteLockDb(db, actor, a: { lockId: number; at: Date }): Promise<"ok" | "not-permitted" | "gone">` — history `deleted` (lock_name frozen), then delete.
  - `revealLockDb(db, actor, a: { lockId: number; at: Date }): Promise<{ outcome: "ok" | "not-visible" | "gone"; code: string | null }>` — any rank meeting `min_role`; history `revealed`.
  - `rotateLocksDb(db, actor, a: { lockId: number | "all"; at: Date; rng?: () => number }): Promise<{ outcome: "ok" | "not-permitted" | "gone"; rotated: number }>` (officer+): new code, `rotated_at`, `rotated_by_dayz_id`, `confirmed_at = null`, `exposed_at = null`, history `rotated` per lock; then ONE channel notice `codes_rotated {gamertag}` and a `codes_rotated` DM to every full member `{clan, link: siteBaseUrl + "/clan/vault"}`.
  - `confirmLockDb(db, actor, a: { lockId: number; at: Date }): Promise<"ok" | "not-visible" | "gone">` — rank meeting `min_role`; `confirmed_at = at`; history `confirmed`.
  - `vaultStateDb(db, actor): Promise<VaultState>` with `VaultState = { locks: VaultLockView[]; history: VaultHistoryRow[] | null }`, `VaultLockView = { id, name, note, minRole, createdAt, createdBy: string, rotatedAt, rotatedBy: string | null, confirmedAt, changedInGame: boolean, exposed: boolean }` (**no `code`**), history (last 100, `{ at, action, lockName, by: gamertag }`) only when `actor.role === "leader"`, else `null`. Gamertags via `players` left-joined on dayz id, falling back to the id.
  - `exposeLocksTx(tx, a: { factionId: number; leaverRole: Role; at: Date }): Promise<number>` — `exposed_at = at` on every lock with `ROLE_RANK[min_role] <= ROLE_RANK[leaverRole]` where `exposed_at is null`.

- [ ] **Step 1: Failing tests** (fixture: BEAR with L, O1, M1; `players` rows): (1) O1 adds "Front gate" min `member` with rng `() => 0.5` → code `"5000"`, history `added`; M1 add → `not-permitted`; name 41 chars → `bad-name`; explicit `code: "12a4"` → `bad-code`. (2) `vaultStateDb` for M1 lists a `member` lock and not an `officer` lock; for O1 both; never a `code` key (`expect(view.locks[0]).not.toHaveProperty("code")`); history is `null` for O1 and an array for L. (3) `revealLockDb` M1 on the officer lock → `not-visible`; on the member lock → `ok` with the 4-digit code; history `revealed`. (4) `rotateLocksDb("all")` by O1 → both codes changed, `confirmed_at` null, `changedInGame` true, exactly one channel `codes_rotated` notice and one DM per full member (3) with `link` ending `/clan/vault` and no digit-run of 4 in any payload; `confirmLockDb` by M1 on the member lock → `changedInGame` false. (5) `deleteLockDb` → lock gone, history row with `lock_id null` and `lock_name` "Front gate". (6) **Exposure**: M1 leaves → the `member` lock has `exposed_at` set, the `officer` lock does not; O1 is kicked by L → both set; `rotateLocksDb` clears them. (7) `exposed` shows in `vaultStateDb` as `true`.
- [ ] **Step 2: Implement.** Writes lock `factions` `for update` first, then `vault_locks` (`for update` on the targeted rows), then history, then notices. Reads use plain selects. Validation constants `VAULT_NAME_MAX = 40`, `VAULT_NOTE_MAX = 140` exported from this file (the site reuses them).
- [ ] **Step 3: roster-store.** In `kick` and `leave`, after the cooldown insert and the electorate update (Task 3), `await exposeLocksTx(tx, { factionId, leaverRole: <the deleted row's role>, at })` — extend the `.returning()` to include `role`. Lock order: `faction_members` → `faction_votes`/ballots → `vault_locks` → notices — already in order.
- [ ] **Step 4: Run** → PASS; full gate → 26/26. **Commit** — `feat(roster): the vault`.

---

### Task 5: Guest-pass store

**Files:**
- Create: `packages/roster/src/internal/guest-store.ts`, `packages/roster/test/guest.test.ts`
- Modify: `packages/roster/src/internal/index.ts`

**Interfaces:**
- Produces: `grantGuestPassDb(db, a: { factionId: number; actorDiscordId: string; userDiscordId: string; at: Date }): Promise<{ outcome: "ok" | "not-permitted" | "already-active" | "is-member" | "self"; passId: number | null }>` — actor officer+ (correlated subquery like `kick`'s), user not a full member of this clan, no open pass; insert with `expires_at = at + GUEST_PASS_MS`; channel notice `guest {officer: gamertag, user: userDiscordId}`.
  - `revokeGuestPassDb(db, a: { factionId; actorDiscordId; passId; at }): Promise<"ok" | "not-permitted" | "gone">`.
  - `openGuestPassesDb(db, factionId, now): Promise<{ id: number; userDiscordId: string; grantedBy: string; expiresAt: Date }[]>` (for the settings page).
  - For the bot: `openPassesByVoiceChannel(db, now): Promise<Map<string /*voiceChannelId*/, Set<string /*userId*/>>>` (joins `factions.discord_voice_channel_id`, open passes only); `convertPassesForFullMembersDb(db, now): Promise<number>` (open passes whose user is a full member of that clan → `converted_at = now`).

- [ ] **Step 1: Failing tests**: O1 grants `u9` → `ok`, `expires_at = at + GUEST_PASS_MS`, notice `guest {officer: "One", user: "u9"}`; again → `already-active`; after `revokeGuestPassDb` → a new grant is `ok`; grant to M1 (full member) → `is-member`; grant by M1 → `not-permitted`; grant to self → `self`; `openPassesByVoiceChannel` maps the clan's voice channel id (set on the faction row) to `{u9}` and omits an expired pass; `convertPassesForFullMembersDb` stamps `converted_at` once `u9` has a full roster row, and the pass no longer appears open.
- [ ] **Step 2: Implement.** The grant takes `factions` `for update`, then reads `faction_members`, then `guest_passes`, then the notice (§4.10: "the grant checks for an open pass under the clan's row lock").
- [ ] **Step 3: Run** → PASS; full gate → 26/26. **Commit** — `feat(roster): guest passes`.

---

### Task 6: The guild-removal path

**Files:**
- Create: `packages/roster/src/internal/removal-store.ts`, `packages/roster/test/removal.test.ts`
- Modify: `packages/roster/src/internal/index.ts`

**Interfaces:**
- Consumes: `disbandFactionTx`, `releaseTx`, `lockDeclarations` (`@factions/declarations`), `applyElectorateLeaveTx`, `closeLeadershipSilentlyTx`, `exposeLocksTx`, `noticeClanTx`, `gamertagOrId`.
- Produces: `removeFromGuildDb(db, a: { discordId: string; at: Date }): Promise<RemovalResult>` with `RemovalResult = { linked: boolean; roster: "none" | "member-left" | "leader-succeeded" | "leader-disbanded"; successorDiscordId: string | null; releasedSoloBase: boolean }`. **Not** re-exported from the package root; only from `./internal`.

- [ ] **Step 1: Failing tests** (fixture: BEAR with L (joined t0), O1 (joined t0+2d), O2 (joined t0+1d), M1 (joined t0+3d); a solo declarant S with a link and a declaration; a linked user with no clan U):
  1. **Leader removed, officers exist** → L's row deleted with **no cooldown** (`roster_cooldowns` has no row for L), O2 (the longest-tenured officer by `joined_at`) is leader, `factions.leader_discord_id` = O2, notice `leader_removed {old: L, new: O2}`, L's `identity_links` row deleted; `roster: "leader-succeeded"`.
  2. **Leader removed, no officers** → longest-tenured full member leads. **Leader removed, alone** → `disbandFactionTx` ran (`status = 'disbanded'`, `identity_holds` written, declaration released), `roster: "leader-disbanded"`.
  3. **Officer/member removed** → row deleted, cooldown written (`until = at + ROSTER_COOLDOWN_MS`), vault locks they could see exposed, their electorate slot removed (open vote's size decremented, ballot deleted), notice `left {gamertag}`, link deleted; `roster: "member-left"`. A **pending** member removed → same minus the vault/electorate effects.
  4. **Leader removed during an open vote / claim** → the vote is closed `failed` with `next_vote_allowed_at` still null and no `vote_failed` notice; the claim `voided` with no notice.
  5. **Solo declarant removed** → declaration released (pole `grace_until` stamped), link deleted, `releasedSoloBase: true`, `roster: "none"`. **Unlinked user** → `{ linked: false, roster: "none" }` and nothing written. **A user who is not in any holding clan but has a link** → link deleted only.
  6. A second call for the same id is a no-op (`linked: false`).
- [ ] **Step 2: Implement** in one transaction, lock order: find the link (`select … for update` on `identity_links`, the way `unlinkDb` does); find the roster row in a holding faction; if any: `factions` `for update`; `lockDeclarations(tx, serverId)` then `releaseTx(tx, { dayzId, serverId }, at)` (the solo base — a pending member may still hold one); then the roster branch: leader → delete row, pick successor (`role = 'officer'` ordered `joined_at asc`, else `status = 'full'` ordered `joined_at asc`), promote (`role = 'leader'`), `leaderDiscordId`, `closeLeadershipSilentlyTx`, notice `leader_removed`; or nobody → `disbandFactionTx(tx, factionId, sql\`true\`)`; non-leader → delete row, cooldown (kick's upsert), `applyElectorateLeaveTx`, `exposeLocksTx`, notice `left`. In every branch: revoke the user's open guest passes on any clan (`revoked_at = at`), then delete the identity link. No-clan branch: `lockDeclarations` → `releaseTx` → delete link.
- [ ] **Step 3: Run** → PASS; full gate → 26/26. **Commit** — `feat(roster): the guild-removal path (internal)`.

---

### Task 7: Bot — leadership tick, guild-removal handler, `/guest`

**Files:**
- Create: `apps/bot/src/leadership-tick.ts`, `apps/bot/src/guild-removal.ts`, `apps/bot/src/guest-command.ts`, `apps/bot/test/leadership-tick.test.ts`, `apps/bot/test/guild-removal.test.ts`, `apps/bot/test/guest-command.test.ts`
- Modify: `apps/bot/src/discord.ts` (wiring), `apps/bot/test/retired-commands.test.ts` (its `buildCommands` assertion becomes `[...RETIRED_COMMANDS, "guest"].sort()`; `RETIRED_COMMANDS` itself is unchanged — `guest` is live, not retired), `apps/bot/README.md`

**Interfaces:**
- Consumes: `resolveSuccessionClaims`, `closeExpiredVotes`, `removeFromGuildDb`, `grantGuestPassDb`, `actorFor`-equivalent lookups via `identityLinks`/`factionMembers`.
- Produces: `leadershipTick(db, now): Promise<{ succeeded: number; voided: number; passed: number; failed: number }>`; `handleGuildMemberRemove(db, a: { guildId: string; expectedGuildId: string; userId: string; now: Date }): Promise<RemovalResult | "other-guild">`; `handleGuestCommand(db, a: { channelId: string; actorDiscordId: string; targetUserId: string; now: Date }): Promise<Reply>` (ephemeral text: `Guest pass given: <@id> can see and join the voice channel for 24h.` / `Run this in your clan's channel.` / `Only an officer or the leader can give a guest pass.` / `They already have an active pass.` / `They are a full member already — no pass needed.`); `buildCommands()` now also returns the `guest` command (`SlashCommandBuilder().setName("guest").setDescription("Give someone a 24h voice guest pass").addUserOption(o => o.setName("user").setDescription("Who").setRequired(true))`).

- [ ] **Step 1: Tests.** `leadership-tick`: an open claim past `resolves_at` succeeds and a vote past `closes_at` fails in one call, counts reported. `guild-removal`: `other-guild` for a mismatched guild id and nothing written; otherwise delegates and returns the store's result (one integration case: a member's row disappears). `guest-command`: channel id not a clan's text channel → "Run this in your clan's channel."; actor a member → the officer line; officer → the success line and one `guest_passes` row; existing pass → the "already" line.
- [ ] **Step 2: Implement.** `guest-command.ts` resolves the clan from `factions.discord_text_channel_id = channelId` (holding statuses), the actor from `identity_links` → `faction_members` (`status = 'full'`, that clan), then `grantGuestPassDb`. `discord.ts`: in `interactionCreate`, before the retired fallthrough: `if (interaction.isChatInputCommand() && interaction.commandName === "guest") { const reply = await handleGuestCommand(db, { channelId: interaction.channelId, actorDiscordId: interaction.user.id, targetUserId: interaction.options.getUser("user", true).id, now: new Date() }); await interaction.reply({ content: reply.content, flags: MessageFlags.Ephemeral }); return; }`. Register `client.on("guildMemberRemove", (m) => void handleGuildMemberRemove(db, { guildId: m.guild.id, expectedGuildId: cfg.guildId, userId: m.id, now: new Date() }).then((r) => { if (r !== "other-guild" && r.linked) console.log(`guild removal: ${m.id} ${r.roster}${r.successorDiscordId ? ` → ${r.successorDiscordId}` : ""}`); }).catch((err) => console.error("guild removal failed", err)))`. In the runner, right after the presence tick and before positions: `leadershipTick(db, new Date())` in its own try/catch, logging only non-zero counts. README: the three additions, and "`/guest` is the one live command".
- [ ] **Step 3: Run** → PASS; full gate → 26/26. **Commit** — `feat(bot): leadership tick, guild-removal handler, /guest`.

---

### Task 8: Bot — guest overwrites, nicknames, reaping

**Files:**
- Modify: `apps/bot/src/guild.ts` (`GuildGateway` + adapter), `apps/bot/src/structure-store.ts`, `apps/bot/src/structure-tick.ts`, `apps/bot/src/reaper-tick.ts`, `apps/bot/test/fake-guild.ts`, `apps/bot/test/structure-tick.test.ts`, `apps/bot/test/structure-store.test.ts`, `apps/bot/test/reaper-tick.test.ts`, `apps/bot/src/discord.ts` (reaper log line)

**Interfaces:**
- `GuildGateway` gains: `memberOverwrites(channelId: string): Set<string>` (cache: user-type overwrite ids on the channel; empty for unknown), `grantVoiceAccess(channelId: string, userId: string): Promise<void>` (`permissionOverwrites.edit(userId, { ViewChannel: true, Connect: true })`), `revokeVoiceAccess(channelId: string, userId: string): Promise<void>` (`permissionOverwrites.delete(userId)`, tolerating 10003/10011 and an already-missing overwrite), `memberNickname(userId: string): string | null | undefined` (cache: `undefined` when the member is not cached, else their nickname or `null`).
- `StructureStore` gains: `openGuestPassesByVoiceChannel(now): Promise<Map<string, Set<string>>>` (delegates to `openPassesByVoiceChannel`), `convertGuestPasses(now): Promise<number>`, `desiredNicknames(): Promise<Map<string /*discordId*/, string>>` (every linked user → `nicknameFor(players.gamertag ?? identity_links.gamertag, tag)` where `tag` is the holding clan's tag if they are a `full` member, else null).
- `StructureTickResult` gains `guestGrants`, `guestRevokes`, `guestConverted`, `nicknamesSet`.
- `reaperTick` result gains `guestPasses` (rows with `expires_at <= now` deleted, plus rows revoked or converted more than `GUEST_PASS_MS` ago).

- [ ] **Step 1: Tests** (`structure-tick.test.ts`, extend the BEAR fixture with a voice channel id on the faction): (a) an open pass for `u9` → one `grantVoiceAccess(voice, u9)`; a second pass → no REST call (cache matches); a stray overwrite for `u8` with no pass → `revokeVoiceAccess`; an expired pass → revoked; (b) `u9` becomes a full member → `guestConverted 1`, overwrite revoked (the role carries the access), and the pass has `converted_at`; (c) **nicknames**: d1 (full member of BEAR, gamertag "One") with cached nickname `"One"` → `setNickname d1 [BEAR] One`; d4 (linked, no clan) with nickname `"[BEAR] Four"` → `setNickname d4 Four`; a user already correct → no call; a user in `nicknameNoRetry` → no call; d3 (pending) → bare gamertag; a 40-char gamertag → nickname exactly 32 chars starting `[BEAR] `. (d) `reaper-tick`: an expired pass is deleted, an open one is not.
- [ ] **Step 2: Implement** as steps 7 (guest passes: `convertGuestPasses` first, then per clan with a voice channel diff desired vs `memberOverwrites`) and 8 (nicknames: for each `desiredNicknames` entry where `guild.isMember(id)` and `memberNickname(id) !== undefined` and differs and not in `nicknameNoRetry` → `setNickname`, with the same NO_RETRY handling as step 5) of `structureTick`. ⚠️ Step 5's "clear on unlink" is unchanged; step 8 only touches linked users, so the two never fight. `FakeGuild` gains `overwrites = new Map<string, Set<string>>()` and per-member `nickname`. `reaperTick` adds the `guest_passes` delete; `discord.ts` logs it when non-zero.
- [ ] **Step 3: Run** → PASS; full gate → 26/26. **Commit** — `feat(bot): guest-pass overwrites and [TAG] nicknames reconciled; guest passes reaped`.

---

### Task 9: `@factions/roster` — the twelve exports and the clan view

**Files:**
- Create: `packages/roster/src/leadership.ts`, `packages/roster/src/vault.ts`, `packages/roster/src/guest.ts`
- Modify: `packages/roster/src/reads.ts` (`ClanView`), `packages/roster/src/index.ts`, `packages/roster/test/exports.test.ts`, `apps/web/test/smoke.test.ts`, `packages/roster/test/reads.test.ts`, `packages/roster/test/writes.test.ts` (one case per export through `actorFor`)

**Interfaces:**
- `ClanView` gains `leadership: { openClaim: OpenClaim | null; openVote: (OpenVote & { myBallot: boolean; inElectorate: boolean }) | null; canClaim: "eligible" | "is-leader" | "not-eligible" | "leader-active" | "claim-open"; nextVoteAllowedAt: Date | null; leaderLastSeenAt: Date | null }` and `guestPasses: { id; userDiscordId; grantedBy; expiresAt }[]` (officer+ only, else `[]`).
- Root exports (each resolves the actor with `actorFor` and maps `ActorRefusal` in, the way `kickDb` does): `claimSuccession(discordId)`, `openVote(discordId, nomineeDiscordId)`, `castVote(discordId)`, `vaultFor(discordId): Promise<VaultState | ActorRefusal>`, `addLock(discordId, { name, note, minRole, code? })`, `editLock(discordId, { lockId, name, note, minRole })`, `deleteLock(discordId, lockId)`, `revealLock(discordId, lockId)`, `rotateLocks(discordId, lockId | "all")`, `confirmLock(discordId, lockId)`, `grantGuestPass(discordId, target: { discordId: string } | { gamertag: string })` (gamertag resolved through `identity_links` exactly as `inviteDb` does, including `ambiguous-gamertag`), `revokeGuestPass(discordId, passId)`. Types exported: `ClaimOutcome`, `OpenVoteOutcome`, `CastOutcome`, `VaultState`, `VaultLockView`, `VaultHistoryRow`, `OpenVote`, `OpenClaim`, `GuestGrantOutcome`, `VAULT_NAME_MAX`, `VAULT_NOTE_MAX` (constants count as exports — add both allowlists).

- [ ] **Step 1: Tests.** Allowlist tests updated (sorted, both files). `reads.test.ts`: `clanFor` for a member shows `openVote` with `inElectorate true` and `myBallot false`; for the leader `canClaim = "is-leader"`; `guestPasses` empty for a member and populated for an officer. `writes.test.ts`: one happy path per export and one refusal (`"pending"` for a pending actor on `addLock`; `"not-linked"` on `castVote`).
- [ ] **Step 2: Implement**; `index.ts` docblock lists the new groups (leadership, vault, settings/guest).
- [ ] **Step 3: Run**; full gate → 26/26. **Commit** — `feat(roster): leadership, vault and guest-pass exports`.

---

### Task 10: Site — `/clan` leadership sections and the routes

**Files:**
- Create: `apps/web/lib/leadership-copy.ts`, `apps/web/test/leadership-copy.test.ts`, `apps/web/app/api/clan/claim-succession/route.ts`, `app/api/clan/open-vote/route.ts`, `app/api/clan/cast-vote/route.ts`
- Modify: `apps/web/app/clan/page.tsx`, `apps/web/lib/clan-copy.ts` (`KICK`/`TRANSFER` gain `"vote-open"`)

- [ ] **Step 1: Copy** (`leadership-copy.ts`, `Record<Outcome, string>` tables + `code()` like `clan-copy.ts`, every number via `days()`/`hours()` from rules): CLAIM (`ok`: "Claimed. The leader has {48 h} to be seen in game; if they are, the claim is void. The clan channel has been told."; `not-eligible`: "Only an officer can claim while the clan has officers."; `leader-active`: "The leader has been seen in game within the last {7 days}."; `claim-open`: "A claim is already open."; `is-leader`: "You are the leader."), OPEN_VOTE (`ok`, `passed` ("Passed on the spot — the electorate was small enough. {nominee} leads."), `cooldown` "A vote failed recently; the next is possible after {14 days} from then.", `vote-open`, `nominee-is-leader`, `nominee-not-member`, `is-leader` "The leader hands over leadership in settings instead of voting."), CAST (`ok`, `passed`, `already-voted`, `not-in-electorate` "You are not in this vote's electorate — it was fixed when the vote opened, without the leader.", `no-vote`). `clan-copy.ts`: `"vote-open"`: "A no-confidence vote is open. Kicks and transfers wait until it closes." Vocabulary test: no "faction".
- [ ] **Step 2: Routes** (form POSTs via `formAction`, back to `/clan`): `claim-succession` (checkbox `confirm`), `open-vote` (`target` digits, `confirm`), `cast-vote` (`confirm`).
- [ ] **Step 3: Page.** New sections on `/clan` for full members, in this order after the roster: **Leadership** — leader's last seen (`when(leaderLastSeenAt)`); open claim card (claimant, resolves `when(resolvesAt)`); claim form when `canClaim === "eligible"` ("Claim leadership — the leader has been silent for {7 days}"), else the refusal reason in one muted line for `not-eligible`/`leader-active` (nothing for the leader); **No-confidence vote** — open vote card: "Replace {leader} with {nominee}", `{ballots} of {threshold} needed (electorate {size})`, closes `when(closesAt)`, a **Vote yes** form when `inElectorate && !myBallot`, "You voted." when `myBallot`, "Members who joined after the vote opened do not vote in it." when `!inElectorate` and not leader, the guide's line for the leader ("You can make your case in the clan channel."); no open vote: a nominate form (select of full members except the leader and the pending; self allowed) for non-leaders, with `nextVoteAllowedAt` shown when in the future and the form disabled. The leader sees no nominate form.
- [ ] **Step 4: Tests**: `leadership-copy.test.ts` (every outcome has copy; none says "faction"); `request-time-rendering.test.ts` keeps passing (page already `force-dynamic`); `api-routes.test.ts` finds the three routes as POSTs.
- [ ] **Step 5: Run**; full gate → 26/26. **Commit** — `feat(web): succession claims and no-confidence votes on /clan`.

---

### Task 11: Site — `/clan/vault` and guest passes on `/clan/settings`

**Files:**
- Create: `apps/web/app/clan/vault/page.tsx`, `apps/web/app/clan/vault/reveal-button.tsx` (client component), `apps/web/lib/vault-copy.ts`, `apps/web/test/vault-copy.test.ts`, `apps/web/app/api/vault/{add,edit,delete,rotate,confirm,reveal}/route.ts`, `apps/web/app/api/clan/guest/route.ts`, `apps/web/app/api/clan/revoke-guest/route.ts`
- Modify: `apps/web/app/clan/settings/page.tsx`, `apps/web/app/clan/page.tsx` (a "Vault" link beside Map/Board), `apps/web/test/api-routes.test.ts` (`GET_ALLOWED` unchanged; `/api/vault/reveal` is a POST that returns JSON — add a second assertion that it sends `NO_STORE`), `apps/web/lib/clan-copy.ts` (GUEST table)

- [ ] **Step 1: Copy** `vault-copy.ts`: ADD/EDIT/DELETE/ROTATE/CONFIRM/REVEAL tables (`not-permitted`: "Only an officer or the leader can change the vault."; `not-visible`: "That lock is above your rank."; `bad-name`: "A lock name is 1 to {VAULT_NAME_MAX} characters."; `bad-note`; `bad-code`: "A code is exactly {VAULT_CODE_DIGITS} digits."; `rotate.ok`: "Rotated. Nothing changed in the game until someone goes and sets the new code on the lock — confirm it here when they have. Every member has been told to look here."; `gone`), plus `VAULT_INTRO`: "You see only the locks your rank unlocks. Codes are hidden behind a tap so they are not on screen in a stream. Rotating a code here does not change the lock in the game." GUEST table in `clan-copy.ts` (`ok`: "Guest pass given: they can see and join the voice channel for {24 h}. The clan channel has been told."; `already-active`; `is-member`; `self`; `not-permitted`; `invitee-not-linked`/`ambiguous-gamertag` reused; `bad-input`).
- [ ] **Step 2: Routes.** `add`/`edit`/`delete`/`rotate`/`confirm` are `formAction` POSTs back to `/clan/vault` (`lockId` via `id()`, `name` via `text(…, VAULT_NAME_MAX)`, `note` via `optionalText(…, VAULT_NOTE_MAX)`, `minRole` validated against `["leader","officer","member"]`, optional `code` matched `/^\d{4}$/`; `rotate` accepts `lockId` or `all=yes` and requires `confirm`). `reveal`: `POST` JSON `{ lockId }` → `sessionOr401()` → `revealLock` → `json({ code })` or `json({ error }, 403)`; response headers `NO_STORE`. `clan/guest`: `target` (digits → `{ discordId }`, else `{ gamertag }`), back to `/clan/settings`; `clan/revoke-guest`: `passId`.
- [ ] **Step 3: Pages.** `/clan/vault` (`force-dynamic`; `vaultFor(session.sub)`; `ActorRefusal` → the `REFUSAL` copy with a link to `/clan`): intro; one card per lock — name, rank badge, note, `changed in game?` badge when `changedInGame`, `known to an ex-member` badge when `exposed`, "rotated {when} by {who}", a `RevealButton lockId` (client: POST `/api/vault/reveal`, shows the code in a `font-mono` span for 30 s then hides; reloads on 401), **Confirm** form (visible when `changedInGame`), and for officers **Rotate** / **Edit** (inline form: name, note, min rank) / **Delete** (with `confirm`); officers get an **Add lock** form (name, note, min rank, optional code — "leave blank to generate") and **Rotate all** (with `confirm`); the leader gets **History** (table: when, who, action, lock). `/clan/settings`: an officer section **Guest passes** — form (`target`: "Discord user id or gamertag"), the open passes list with expiry and a **Revoke** form; a line: "A pass shows the voice channel only, for {24 h}; joining the clan makes it the real role." `/clan`: a **Vault** link in the header link stack.
- [ ] **Step 4: Tests**: `vault-copy.test.ts` (every outcome; no "faction"; no copy contains a 4-digit run); `api-routes.test.ts` passes; `request-time-rendering.test.ts` covers the new page; `copy-vocabulary.test.ts` green. Typecheck the client component under Next's rules (`"use client"` at the top, no server imports).
- [ ] **Step 5: Run**; full gate → 26/26. **Commit** — `feat(web): /clan/vault and guest passes`.

---

### Task 12: Runbook and notes

**Files:**
- Create: `docs/deploy/2026-09-09-leadership-and-vault.md`
- Modify: `CLAUDE.md`, `docs/superpowers/specs/2026-09-04-clan-wars-target-state-design.md` (§15 row 7 plan file → `2026-09-09-leadership-and-vault.md`), `apps/bot/README.md` (if Task 7/8 left anything out)

- [ ] **Step 1: Runbook** (shape of `2026-09-08-player-stats.md`): (1) apply 0028 with the one-off runner — additive, six tables and one nullable column, no backfill, the bot may keep running, restart after; (2) **bot permissions**: the bot's role needs **Manage Roles** on the voice category (permission-overwrite edits) in addition to what 3b required; the `GuildMembers` intent (already on) is what delivers `guildMemberRemove`; (3) `/guest` registers itself on start (the existing `Routes.applicationGuildCommands` put) — verify it appears in the clan channel; (4) first structure pass after restart: expect `nicknamesSet N` for every full member (they gain `[TAG] `) — a large guild is N REST calls once, then zero; (5) ⚠️ ruling 10 verbatim: removals during downtime are not reconciled; how to spot one (a roster row whose Discord id is not in the guild) and the fix (an officer kicks them on `/clan`); (6) verification: open a vote in a test clan and watch `vote_opened` post; rotate a lock and confirm the DM says nothing but "see the vault"; (7) acceptance queries from §13 (dormancy read-only check, `count(*) from factions`).
- [ ] **Step 2: CLAUDE.md**: the "Invariants" list gains four bullets — the vote freeze and electorate decrement live in `kick`/`leave`/`transfer`; vault exposure lives in `kick`/`leave`; `removeFromGuildDb` is internal-only and the one roster writer that starts from a gateway event; nicknames and guest overwrites are reconciled by `structureTick` (never fire-and-forget). "Current state" gains an increment-7 paragraph. The tick list in "Running things" adds `leadershipTick` and the two structure steps.
- [ ] **Step 3:** full gate → 26/26. **Commit** — `docs: increment 7 runbook and notes`.

---

## Self-review

**Spec coverage.** §4.3 `next_vote_allowed_at` → T1. §4.6 three tables (+ the ruled `electorate_dayz_ids`) → T1, T3. §4.10 `vault_locks`, `vault_history`, `guest_passes` → T1, T4, T5. §4.12 order → every store task names its order; race test in T3. §5.3 leave/kick side effects (vault exposure, electorate decrement, role/nickname removal via reconciler) → T3, T4, T8. §5.4 transfer refused during a vote → T3; succession by silence → T3, T7; leader removed from guild → T6, T7; removal of anyone else → T6. §5.6 guest pass lifecycle, reconcile on start (every pass, in fact) → T5, T8. §5.7 every bullet → T3. §7 succession, votes, reapers (guest passes), nickname sync → T7, T8. §9.1 `/guest` (officer+, in a clan channel), nicknames → T7, T8. §9.3/§9.4 nine lines → T2, writers in T3–T6. §10.2 `/clan` (open vote / ballot / claim), `/clan/vault`, `/clan/settings` guest passes → T10, T11. §10.4 exports → T9; internal-only removal → T6. §13 rule tests (threshold 9→6, 8→6; nickname truncation), store tests (races; pending counts nowhere) → T2, T3; `smoke.test.ts` → T9. §14 vote freeze in the package; overwrites reconciled → T3, T8.

**Placeholder scan.** No TBD/TODO; every outcome union, payload key and route is named; copy strings are given or derived from a named rule.

**Type consistency.** `ClaimOutcome`/`OpenVoteOutcome`/`CastOutcome` (T3) are what T9 exports and T10's copy tables key on; `VaultActor`/`VaultState`/`VaultLockView` (T4) → T9 → T11; `RemovalResult` (T6) → T7; `openPassesByVoiceChannel`/`convertPassesForFullMembersDb` (T5) → T8's `StructureStore` methods; `nicknameFor`/`canSeeLock`/`voteThreshold` (T2) → T3, T4, T8; notice payload keys (T2) → T3–T6 writers.
