# Link to Play Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ban every gamertag that plays unlinked for more than 1 hour (or loses its link), lift that ban for 1 hour once a day when someone starts to link it, and catch Discord removals the bot missed.

**Architecture:** A pure rule in `packages/domain` decides ban / lift / close per gamertag from facts. A new bot tick (`link-gate-tick.ts`) gathers those facts and writes `bans` rows with `reason = 'unlinked'`; the existing `banTick` stays the only thing that talks to Nitrado. A delete trigger on `identity_links` records every lost link. A capped sweep reuses `removeFromGuildDb` for linked users missing from a fully fetched member list.

**Tech Stack:** TypeScript, vitest, drizzle-orm/postgres.js, discord.js, Next.js (site copy only).

**Spec:** `docs/superpowers/specs/2026-11-06-link-to-play-design.md`

## Global Constraints

- New ban reason is exactly `unlinked`; `BAN_REASON_TEXT.unlinked = "playing without a linked account"`. `unlinked_pc` stays in `BAN_REASONS`.
- `LINK_TO_PLAY_GRACE_MS = 60 * MINUTE`, `LINK_TO_PLAY_LIFT_MS = 60 * MINUTE`, `LINK_TO_PLAY_LIFT_WINDOW_MS = 24 * HOUR`, `LINK_SWEEP_MAX_PER_PASS = 5`, all in `packages/domain/src/rules.ts`. The first two get `guide-numbers.ts` rows and guide tokens.
- `LINK_TO_PLAY_FROM` is a fixed `Date` in `rules.ts`. Ship it as `new Date("2026-11-10T14:00:00Z")` with a ⚠️ comment that the runbook sets the real launch instant by release; play before it never counts and links lost before it never ban.
- The link-gate tick NEVER calls Nitrado. It only writes `bans` rows and sets `lift_pending`.
- Only `reason = 'unlinked'` rows are ever written, lifted or closed by this feature.
- No exemptions of any kind.
- `unlinked` bans post in #bans through the existing `ban_announcements` path, no reason filter.
- Env flag `LINK_TO_PLAY` takes `off` (default) | `dry` | `on`; anything else fails config load. `dry` and `on` require `ENFORCEMENT_TICK` (config load fails otherwise, as `HUB_BAN_TICK` does). Startup logs one line either way.
- Player copy: plain voice per `brand/02-verbal-identity.md`, never discourages playing. Never a coordinate.
- House style: comments say WHY; `⚠️` marks load-bearing lines. Every PR adds a committed `## [Unreleased]` CHANGELOG entry.
- Tests: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5440/factions"` against a throwaway `postgres:16` on 5440 (5434 is not ours on this machine). The gate is `npx turbo run typecheck test --concurrency=1 --force`.

## Review Focus

1. A session that started before `LINK_TO_PLAY_FROM` and is still open → only the part after `FROM` counts, up to now (Task 1 test `counts only the overlap with [from, now]`).
2. A player lifted, then linking inside the hour → no re-ban, and their applied ban (if any remains) is closed, not left standing (Task 1 `linked with an applied ban → close`; Task 4 `lift then link writes no new ban`).
3. Two guild members opening attempts on the same banned gamertag the same day → exactly one lift; a re-roll during a lift does not restart the hour (Task 1 `second attempt inside 24h → none`; `re-roll during lift keeps the original hour`).
4. The owner's own manual Nitrado entry for the same gamertag survives our lift and expiry (Task 3 `a pre-existing entry survives a lift`).
5. A cold or failed member fetch → the sweep removes nobody; a bad read is capped at 5 (Task 5 `never runs before a full fetch`, `stops at the cap`).

---

### Task 1: The rule (domain)

**Files:**
- Create: `packages/domain/src/link-gate.ts`, `packages/domain/test/link-gate.test.ts`
- Modify: `packages/domain/src/enforcement.ts` (reason + text), `packages/domain/src/rules.ts` (constants), `packages/domain/src/guide-numbers.ts` (two rows), `packages/domain/src/index.ts` (export)

**Interfaces:**
- Produces:
  ```ts
  export type Interval = { from: Date; to: Date | null };           // to null = still open
  export function unlinkedPlayMs(sessions: Interval[], from: Date, now: Date): number;
  export type LinkGateFacts = {
    linked: boolean;
    playedMs: number;                    // unlinkedPlayMs since LINK_TO_PLAY_FROM
    linkEndedSinceFrom: boolean;         // an identity_link_ends row after LINK_TO_PLAY_FROM
    bannedSinceFrom: boolean;            // any unlinked ban row with banned_at >= FROM (hour already spent)
    activeBan: "pending" | "applied" | "lift_pending" | null;   // unlinked rows only
    lastLiftAt: Date | null;             // latest unlinked lifted_at
    liftsInWindow: number;               // unlinked rows lifted (or lift_pending) inside the last LINK_TO_PLAY_LIFT_WINDOW_MS
    attemptOpen: boolean;                // a live verification challenge targets this dayz id
    now: Date;
  };
  export type LinkGateAction = "none" | "ban" | "lift" | "close";
  export function linkGateAction(f: LinkGateFacts): LinkGateAction;
  ```

- [ ] **Step 1: Write the failing tests** in `link-gate.test.ts`, one `it` per rule:
  - `counts only the overlap with [from, now]`: sessions `[from−30m, from+10m]`, `[from+20m, null]`, now = from+50m → `40 * MINUTE`.
  - `unlinked, 59m played → none`; `60m played → ban` (grace boundary is `>=`).
  - `lost a link since launch → ban at 0m played`.
  - `banned before since launch, no lift running → ban` (hour already spent).
  - `applied ban, attempt open, no lift in window → lift`; `liftsInWindow 1 → none` (`second attempt inside 24h → none`).
  - `inside a lift (lastLiftAt + 60m > now) with an attempt open → none`; `re-roll during lift keeps the original hour`: lastLiftAt = now−61m, attempt open, bannedSinceFrom → `ban`.
  - `lift running but attempt cancelled → ban`.
  - `linked with an applied or pending ban → close`; `linked with a lift_pending ban → none`; `linked, no ban → none`.
  - `pending or lift_pending ban, unlinked → none`.
- [ ] **Step 2: Run** `pnpm --filter @factions/domain exec vitest run test/link-gate.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `link-gate.ts` plus the constants and reason. Decision order: linked → (`applied` or `pending` ? `close` : `none`); activeBan `applied` → (`attemptOpen && liftsInWindow === 0` ? `lift` : `none`); activeBan pending/lift_pending → `none`; in a lift (`lastLiftAt` within `LINK_TO_PLAY_LIFT_MS` and `attemptOpen`) → `none`; owes a ban (`playedMs >= GRACE || linkEndedSinceFrom || bannedSinceFrom`) → `ban`; else `none`. Header comment: level-triggered, why one lift per window (spec §4), why losing a link is immediate (spec rule 5). Add guide-number rows for GRACE and LIFT in the same style as their neighbours.
- [ ] **Step 4: Run** the domain package's tests → PASS (the guide-number tests included).
- [ ] **Step 5: Commit** `feat(domain): link-to-play rule and constants`.

### Task 2: Schema — lost links and what we added to Nitrado

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/migrations/0074_*.sql` (generated, then the trigger added by hand) + its meta snapshot
- Test: `packages/db/test/identity-link-ends.test.ts`

**Interfaces:**
- Produces: table `identityLinkEnds` (`id` bigserial, `dayz_id` text not null, `discord_id` text not null, `ended_at` timestamptz not null default now(), index on `(dayz_id, ended_at)`); column `bans.nitradoAdded: text[] | null` (`nitrado_added`).
- ⚠️ The row is written by an `AFTER DELETE ON identity_links FOR EACH ROW` trigger (`identity_link_ends_record`), not by application code: three paths delete links today (`unlinkDb`, `removeFromGuildDb`, `PgVerificationStore.deleteLinkByDiscord`) and a hand delete must count too. Precedent for hand-added triggers: migration 0054's `referrals_permanent`.

- [ ] **Step 1: Write the failing test**: insert an `identity_links` row, delete it → exactly one `identity_link_ends` row with its `dayz_id` and `discord_id`; delete by `discord_id` path too; `bans.nitrado_added` round-trips `['A','B']` and null.
- [ ] **Step 2: Run** `pnpm --filter @factions/db exec vitest run test/identity-link-ends.test.ts` → FAIL.
- [ ] **Step 3:** Add both to `schema.ts` with comments (null `nitrado_added` = a row applied before this column, removal falls back to both identifiers). `cd packages/db && npx drizzle-kit generate`, append the trigger function + trigger to the generated SQL, read the SQL. Note in the schema comment that `identity_link_ends` is outside the lock order (insert-only, written only by the trigger inside the deleting statement).
- [ ] **Step 4: Run** the db package tests → PASS.
- [ ] **Step 5: Commit** `feat(db): record lost links; remember what a ban added to Nitrado`.

### Task 3: Never remove an entry we did not add

**Files:**
- Modify: `packages/nitrado/src/client.ts` (`addBans` returns the names it added), `apps/bot/src/ban-tick.ts` (`BanTarget.addBans(): Promise<string[]>`; apply arm stores per-row `nitradoAdded`; expire, lift and failed-cleanup arms remove only `row.nitradoAdded ?? [row.dayzId, row.gamertag]`)
- Test: `packages/nitrado/test/*` (the existing client test file), `apps/bot/test/ban-tick.test.ts`

**Interfaces:**
- Consumes: `bans.nitradoAdded` (Task 2).
- Produces: `addBans(names: string[]): Promise<string[]>`. Per row, `nitradoAdded = [row.dayzId, row.gamertag].filter(n => added.includes(n))`; a dry-run row stores `[]`.

- [ ] **Step 1: Write the failing tests**: client — `addBans` on a list already holding `X` with input `[X, Y]` returns `[Y]`; ban-tick — `a pre-existing entry survives a lift` (fake target whose list starts with the gamertag; apply, lift → `removeBans` called with the dayz id only), the same for the expire arm, and `a null nitrado_added still removes both` (legacy row).
- [ ] **Step 2: Run** them → FAIL.
- [ ] **Step 3: Implement.** ⚠️ comment at the removal sites: the owner bans by hand on Nitrado and an entry is keyed on the string, so removing what we did not add frees their ban (spec §5). Update every `BanTarget` fake in bot tests to return `[]` or the added names.
- [ ] **Step 4: Run** nitrado and bot tests → PASS.
- [ ] **Step 5: Commit** `fix(bans): never remove a ban-list entry the bot did not add`.

### Task 4: The link-gate tick

**Files:**
- Create: `apps/bot/src/link-gate-tick.ts`, `apps/bot/test/link-gate-tick.test.ts`
- Modify: `apps/bot/src/config.ts` (+ `test/config.test.ts`), `apps/bot/src/discord.ts` (wiring), `apps/bot/src/ban-announce-text.ts` (+ test)

**Interfaces:**
- Consumes: `linkGateAction`, `unlinkedPlayMs`, constants (Task 1); `identityLinkEnds` (Task 2).
- Produces:
  ```ts
  export type LinkGateResult = { banned: Who[]; lifted: Who[]; closed: Who[] };  // Who = { dayzId: string; gamertag: string }
  export async function linkGateTick(db: Database, opts: { serverId: number; now: Date; write: boolean }): Promise<LinkGateResult>;
  ```
  Config: `linkToPlay: "off" | "dry" | "on"`.

- [ ] **Step 1: Write the failing tests** (DB-backed, the style of the removed `pc-ban-tick.test.ts`, recoverable with `git show a9b0feab^:apps/bot/test/pc-ban-tick.test.ts`):
  - unlinked with 61m of sessions since FROM → one `pending` `unlinked` row, `expires_at` null, gamertag from `players`.
  - 59m → no row; sessions before FROM do not count.
  - link deleted after FROM, no sessions → banned.
  - applied ban + live challenge on that dayz id → `lift_pending`; a second challenge from another Discord account the same day after the lift → no second lift.
  - `lift then link writes no new ban`: lifted row, then an `identity_links` row → nothing written; an applied ban on a linked dayz id → `lift_pending` (`closed`); a pending ban on a linked dayz id → `lift_pending` with `nitrado_added = []`.
  - lifted 61m ago, still unlinked → new `pending` row.
  - a `zone`, `conduct` or `hub_combat` row is never touched.
  - `write: false` returns the same result and writes nothing.
  - config: `LINK_TO_PLAY=dry` without `ENFORCEMENT_TICK` fails; `bogus` fails; unset → `off`.
  - ban-announce text: `lifted` + `unlinked` reads "**X** can rejoin to finish linking their account."; `applied` + `unlinked` uses `BAN_REASON_TEXT.unlinked`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Candidates per server: dayz ids with a `player_sessions` row overlapping `[FROM, now]` ∪ dayz ids in `identity_link_ends` after FROM ∪ dayz ids with an active `unlinked` ban on the server. A live challenge is matched as the old tick did (`target_dayz_id`, not completed/cancelled, `expires_at > now`). Writes, when `write`: `ban` inserts a `pending` row; `lift` and `close` set `lift_pending` on the row (guarded on its current status). ⚠️ Closing a `pending` row (it never reached Nitrado) also sets `nitrado_added = []`, so the lift arm removes nothing — with null it would fall back to removing both identifiers and could free a manual entry. Wire in `discord.ts` inside the `cfg.enforcementTick` block, per server, **before** `banTick` (so a new ban applies the same pass), each server in its own try/catch; `on` → `write: true`, `dry` → `write: false`. Post each ban/lift/close to ops (isolated posts, error-log fallback, the removed tick's shape); in `dry`, prefix "Would" and report each dayz id once per process (an in-memory set) so ops is not spammed every 5 minutes.
- [ ] **Step 4: Run** the bot tests → PASS.
- [ ] **Step 5: Commit** `feat(bot): link to play — ban unlinked play, lift once a day to link`.

### Task 5: Catch missed Discord removals

**Files:**
- Create: `apps/bot/src/guild-sweep.ts`, `apps/bot/test/guild-sweep.test.ts`
- Modify: `apps/bot/src/discord.ts` (run after `runStructure("tick")` when `membersFetched`)

**Interfaces:**
- Consumes: `removeFromGuildDb` via `handleGuildMemberRemove`'s `RemoveFromGuild` type; `LINK_SWEEP_MAX_PER_PASS`.
- Produces: `export async function sweepMissedRemovals(db: Database, opts: { ready: boolean; isMember: (id: string) => boolean; now: Date; max: number; remove?: RemoveFromGuild }): Promise<{ removed: string[]; capped: boolean }>`

- [ ] **Step 1: Write the failing tests**: `never runs before a full fetch` (`ready: false` → no reads of consequence, `removed: []`); linked ids all members → nothing; two linked non-members → both removed through `remove`, links gone; `stops at the cap` (8 non-members, `max: 5` → 5 removed, `capped: true`); one `remove` throwing does not stop the rest.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Oldest link first, so repeated passes converge. In `discord.ts`, pass `ready: membersFetched`, the gateway's `isMember`; post a summary to ops when anything was removed, and an error-level line when `capped` (a large miss is more likely a bad read than a real exodus). ⚠️ comments: this reverses ruling 10 (spec §9); a cold cache reads as "everyone left".
- [ ] **Step 4: Run** the bot tests → PASS.
- [ ] **Step 5: Commit** `feat(bot): sweep linked users who left the Discord while the bot was down`.

### Task 6: Tell the player (site, bot, guide)

**Files:**
- Modify: `packages/roster/src/link.ts` (`LinkStatus.challenge.gate`), the `/link` start/status replies in `apps/bot/src/commands/link.ts`, `apps/web/app/(site)/link/page.tsx` (and its copy file, if the page keeps copy in `apps/web/lib/`), the guide chapter that covers linking under `apps/web/content/guide/`
- Test: the existing roster link tests, `apps/bot/test/` link command tests, `apps/web/test/guide.test.ts` (tokens)

**Interfaces:**
- Produces: `challenge.gate: { kind: "lifted"; until: Date } | { kind: "lift-used"; nextAt: Date } | null`, non-null only when the target's ONLY active ban is `unlinked` (spec §7). `lifted` when an `unlinked` row's `lifted_at` is within `LINK_TO_PLAY_LIFT_MS`; `lift-used` when banned and the window's lift is spent; `nextAt` = that lift's `lifted_at` + `LINK_TO_PLAY_LIFT_WINDOW_MS`.

- [ ] **Step 1: Write the failing tests**: status for a target with an applied `unlinked` ban lifted 10m ago → `{ kind: "lifted", until: lifted_at + 60m }`; with an extra `zone` ban → `null`; site and bot render "You're let back on the server until {time} to finish linking." for `lifted`, and "You've had your hour back on the server for today. Start linking again after {nextAt} to get back on." for `lift-used`; the guide states the rule with `{{LINK_TO_PLAY_GRACE_MS|…}}` and `{{LINK_TO_PLAY_LIFT_MS|…}}` tokens (format as neighbouring duration tokens do).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Guide text, plain voice: every gamertag must be linked to play; 1 hour of play to link; losing your link (leaving the Discord, unlinking) locks the gamertag out; starting to link lets you back on for 1 hour, once a day.
- [ ] **Step 4: Run** roster, bot, web tests → PASS.
- [ ] **Step 5: Commit** `feat(link): tell a locked-out player they can get back on to link`.

### Task 7: Docs, runbook, mission message

**Files:**
- Create: `docs/deploy/2026-11-10-link-to-play.md`
- Modify: `CLAUDE.md` (a "Where things live" row; the ruling-10 sentences in the bot paragraph and the `removeFromGuildDb` invariant now name the sweep; `identity_link_ends` outside the lock order), `apps/bot/README.md` (env table: `LINK_TO_PLAY`), `docs/deploy/2026-09-22-hub-combat.md` §9 (a pointer that the link-to-play launch checks whether a ban removes a connected player), `CHANGELOG.md` (Unreleased, player-facing)
- Separate repo: `/Users/steveharmeyer/Development/dayz-clan-wars/nasdara/db/messages.xml` on its own branch and PR

- [ ] **Step 1:** Runbook, in order: (1) release with `LINK_TO_PLAY` unset; merge and deploy the `nasdara` messages change; (2) owner posts the Discord announcement a day ahead (draft it in the runbook, using Discord `<t:…:F>` timestamps for the launch instant); (3) release setting `LINK_TO_PLAY_FROM` to the launch instant; (4) set `LINK_TO_PLAY=dry`, restart the bot, read the "Would ban" posts in ops for a few hours; (5) set `on`, restart; watch the first ban — confirm it removed a connected player (spec §8) and record the result in the hub-combat runbook; watch the first lift; (6) rollback: set `off`, restart, then lift open `unlinked` bans by setting them `lift_pending` (never `lifted` directly). Read-only checks inside `begin read only`.
- [ ] **Step 2:** `messages.xml`: replace the first message's text with `Link your gamertag at dayzclanwars.com within 1 hour of play, or you'll be locked out until you do.` and add `<onConnect>1</onConnect>` to that message (keep `<repeat>5</repeat>`).
- [ ] **Step 3:** CLAUDE.md, README, CHANGELOG edits as listed.
- [ ] **Step 4: Run** the full gate (`TEST_DATABASE_URL=… npx turbo run typecheck test --concurrency=1 --force`) → all tasks pass; check the count, not the exit code.
- [ ] **Step 5: Commit** `docs: link to play runbook, notes and changelog`.
