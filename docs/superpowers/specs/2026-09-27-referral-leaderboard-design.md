# Referral leaderboards and the weekly plate carrier — design

**Status:** approved in conversation 2026-09-27; this document is the written spec.
**Builds on:** referrals (`2026-09-26-referrals-design.md`), the player boards and
their Discord channel and crowns (`2026-09-18-*`), event awards
(`2026-09-22-awards-design.md`, `grantAwardTx`), and King of the Hill's automatic
grant (`2026-09-23-king-of-the-hill-design.md`).

## 1. Goal

Reward players for bringing new people to Clan Wars. Two new leaderboards rank
referrers, one all-time (season-scoped like every board) and one for the current
week. At the end of each week, the player who referred the most players that week
is granted the existing `plate-carrier` award (seven days), exactly as if an admin
had run `/award grant`.

### In scope

- A permanent record of when each referral *qualified* (§2)
- Two new board kinds, `referrers` and `referrersWeek`, on the site, in `/board`,
  in the Discord leaderboards channel, and with optional crowns
- A weekly payout tick that grants `plate-carrier` to the week's top referrer(s),
  once per week, and announces it
- Tests for the rules, the boundary and the payout's idempotency

### Out of scope

- Any prize other than `plate-carrier`, or a per-week prize choice
- Retroactive payouts for weeks before the tick is enabled
- Changing how referrals are recorded (1.48.0 is unchanged)
- Referral points, tiers or any running score beyond the two counts

## 2. What counts

1. **A referral counts only once it qualifies.** A referral qualifies when the
   referred player has **at least 2 hours** of total play time on the server
   (`REFERRAL_QUALIFY_MS` in `packages/domain/src/rules.ts`). Play before the
   referral was recorded counts; a player who was already a regular qualifies the
   moment they are named.
2. **`qualified_at`** is the later of `referrals.created_at` and the instant the
   referred player's cumulative play time reached 2 hours. It is recorded once and
   never changes.
3. **Play time** is summed from `player_sessions` for the referred player's linked
   character(s). A session still open counts up to `now`. Only the referred
   player's *current* link is consulted when qualifying; once recorded, a
   qualification survives an unlink, like the referral itself.
4. **Both boards count only qualified referrals.** An unqualified referral still
   shows on profiles as it does today.

## 3. The week

- A referral week runs from **Monday 10:00 UTC to the next Monday 10:00 UTC**
  (`REFERRAL_WEEK_START_HOUR_UTC = 10` in `rules.ts`), derived from the calendar
  with `mondayMidnightUtc`, never stored. It deliberately matches the weekly
  vehicle rotation's default hour but is its own constant, so changing the wipe's
  `offHour` does not move the contest.
- `referralWeekFor(now)` returns `{ start, end }` for the week containing `now`;
  `start` inclusive, `end` exclusive.
- A referral belongs to the week containing its `qualified_at`.

## 4. Data

New table `referral_qualifications` (all three tables in this section ship in one
migration):

| column | type | notes |
|---|---|---|
| `referred_discord_id` | text, primary key | FK → `referrals.referred_discord_id` |
| `referrer_discord_id` | text, not null | copied from `referrals`, for the ranking index |
| `qualified_at` | timestamptz, not null | §2.2 |
| `created_at` | timestamptz, not null, default now() | when the tick wrote it |

- Index on `(qualified_at, referrer_discord_id)` for the weekly board and payout.
- Permanent like `referrals`: a trigger rejects every UPDATE, DELETE and TRUNCATE.
  `clearReferrals` (`packages/db/src/clear-referrals.ts`) is extended to clear it
  first, as the one sanctioned clearing path (season wipe / tests).
- Why a table and not a derived query: `referrals` rejects updates, so the flag
  cannot live there; and a live derivation would silently drop a referral whose
  referred player later unlinks.

New table `referral_weeks`:

| column | type | notes |
|---|---|---|
| `week_start` | timestamptz, primary key | the week's Monday 10:00 UTC |
| `closed_at` | timestamptz, not null | when the payout ran |
| `top_count` | integer, not null | the winning count; 0 for a week with no winner |
| `announced_at` | timestamptz | set once the public post succeeds |

New table `referral_week_winners`:

| column | type | notes |
|---|---|---|
| `week_start` | timestamptz, not null | FK → `referral_weeks` |
| `discord_id` | text, not null | the winner |
| `dayz_id` | text, not null | their character at payout, for the announcement |
| `award_grant_id` | integer, not null | FK → `award_grants.id` |
| | | primary key `(week_start, discord_id)` |

## 5. The boards

- `BOARD_KINDS` gains `referrers` and `referrersWeek` (twelve kinds). Labels
  "Top referrers" and "Top referrers this week"; slugs `referrers` and
  `referrers-week`. Value is the count of qualified referrals.
- **Rows are referrers**, identified by `referrer_dayz_id` from the referral (the
  character they were linked to when named), shown through the same unlinked
  rules as the profile: a current link's gamertag when linked, else the snapshotted
  character's gamertag, never a Discord id.
- `referrers` respects the board scope: `all` counts every qualification; `season`
  counts qualifications whose `qualified_at` falls in that season.
- `referrersWeek` ignores the scope picker and always counts the current week
  (§3). Its page says so under the title.
- Ties are ordered by the earliest `qualified_at` that reached the count, then by
  gamertag, for a stable display only. **Display order does not decide the prize**
  (§6).
- Both boards join the Discord leaderboards channel. The ten-to-twelve change makes
  the reconciler see missing boards and rebuild the channel once; that is its
  documented behaviour and is expected at deploy.
- Crowns: optional `CROWN_REFERRERS_ROLE_ID` and `CROWN_REFERRERS_WEEK_ROLE_ID`,
  handled by the existing crown reconciler. Unset means untouched, as today.
- ⚠️ `packages/copy` still imports no runtime value from `@factions/roster`; the new
  labels and slugs are written in `stats.ts` as literals, like the existing ten.

## 6. The weekly payout

`apps/bot/src/referral-award-tick.ts`, run in `discord.ts` beside the KotH and
airdrop ticks on its own throttle (`REFERRAL_AWARD_TICK_INTERVAL_MS`, default
5 min). The payout (step 2) is gated on `REFERRAL_AWARD_TICK`, which requires
`SERVER_EVENTS_CHANNEL_ID` (fatal at startup if the tick is on and the channel is
not).

Each run, in order:

1. **Qualify.** For every `referrals` row with no `referral_qualifications` row,
   compute play time (§2.3); if it has reached 2 hours, insert the qualification
   with `qualified_at` per §2.2 (`ON CONFLICT DO NOTHING`). ⚠️ This step is NOT
   gated on `REFERRAL_AWARD_TICK`: it always runs, so the boards fill before the
   prize is switched on. Only step 2 is gated.
2. **Close the week that just ended**, only once `now >= end + 30 min`
   (`REFERRAL_CLOSE_GRACE_MS`), giving ingest time to deliver the last sessions.
   Only the most recently ended week is ever considered: **never a backlog.**
   Enabling the tick, or a bot down for two weeks, pays at most the latest
   completed week.

Closing a week is one transaction, in lock order
`referral_weeks` → `award_grants` → `clan_notices`:

1. `INSERT INTO referral_weeks … ON CONFLICT DO NOTHING RETURNING`. No row
   returned means the week is already closed: stop. This is what makes a retry, a
   restart or two bots unable to pay twice.
2. Count qualified referrals per referrer with `qualified_at` in `[start, end)`.
3. **Eligibility:** a referrer must be linked *now* (they need a character to
   place the award). Ineligible referrers are dropped before ranking, so the next
   linked referrer with the highest count wins. Each drop posts an ops note.
4. **Winners:** every eligible referrer with the highest count, if that count is
   at least 1. A tie gives each of them their own grant.
5. For each winner, `grantAwardTx({ awardKey: "plate-carrier", reason:
   "Top referrer, week of <date>", grantedByDiscordId: <bot user id>, … })`, which
   writes the grant and the existing `award_granted` DM; then the
   `referral_week_winners` row.
6. Set `top_count` (0 if no winner).

If `plate-carrier` has left the catalogue, `grantAwardTx` returns `unknown-award`:
the week closes with no winners and an ops alert, never a throw, mirroring KotH,
because a throwing close would retry forever.

**Announcement.** After commit, if the week has winners and `announced_at` is null,
post to `SERVER_EVENTS_CHANNEL_ID`, then set `announced_at`. A failed post is
retried on the next run. Copy (in `packages/copy`, no em dashes):

- One winner: "Top referrer this week: **{gamertag}**, who brought in {n} new
  player(s). They get a plate carrier for a week."
- A tie: "Top referrers this week: **{a}** and **{b}**, with {n} new player(s)
  each. They each get a plate carrier for a week."

No post for a week with no winner.

## 7. Error handling

- A failed board read writes nothing (the existing crown and leaderboard rule).
- A failed qualification query skips that run; nothing half-written, since each
  qualification is its own insert.
- The close transaction either commits the week row, every grant, every DM and
  every winner row, or none of them.

## 8. Testing

Pure (`packages/domain`): `referralWeekFor` at and around the Monday 10:00
boundary and across a DST change (UTC, so none should apply); `qualifiedAt`
from a session list, including an open session and pre-referral play.

DB (`apps/bot` and `packages/roster`, against `factions_test_<package>`):

- Qualification is written once, is permanent (trigger), and survives an unlink
- Both boards count only qualified referrals; `referrers` respects season scope;
  `referrersWeek` ignores it
- Closing the same week twice grants once
- A tie grants each tied referrer
- An unlinked top referrer is skipped and the next eligible referrer wins
- A referral qualifying one second before `end` counts; one at `end` counts next week
- A week with no qualified referrals closes with no grant and no post
- Only the latest ended week is ever closed (no backlog)
- A failed announcement is retried and posts once

The full gate becomes more than 32 tasks only if a package is added; none is, so it
stays **32/32**.

## 9. Rollout

Runbook `docs/deploy/2026-09-27-referral-leaderboard.md`:

1. Apply the migration (no running query selects a dropped column; the bot may stay
   up).
2. Deploy web and bot. The leaderboards channel rebuilds once to twelve boards.
3. Optionally create the two crown roles and set their env vars.
4. Set `REFERRAL_AWARD_TICK=1` when ready. The first payout is the first week that
   ends after that.
5. `CHANGELOG.md` entry (player-facing, plain voice).
