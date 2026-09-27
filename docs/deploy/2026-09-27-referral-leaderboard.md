# Referral leaderboards and the weekly plate carrier: deploy

Spec `docs/superpowers/specs/2026-09-27-referral-leaderboard-design.md`.

1. **Migrate.** `packages/db/migrations/0056_goofy_sphinx.sql` only adds tables, and
   `0057_aberrant_william_stryker.sql` only adds the nullable
   `referral_qualifications.referred_dayz_id` and its partial unique index (one
   character backs at most one qualification); nothing running selects a dropped
   column, so the bot may stay up. Apply it the usual way (`docs/deploy/2026-09-10-launch.md`).
2. **Deploy web and bot.** The leaderboards channel sees two boards it has no message
   for and rebuilds itself once, to twelve messages. Expected; nothing to do.
3. **Boards fill.** Qualification runs every `REFERRAL_AWARD_TICK_INTERVAL_MS`
   (default 5 min) with or without the payout switched on. Existing referrals whose
   player already has 2 hours qualify on the first pass, at their referral time.
4. **Crowns (optional).** Create two roles and set `CROWN_REFERRERS_ROLE_ID`,
   `CROWN_REFERRERS_WEEK_ROLE_ID`. Each must differ from every other crown role.
5. **Switch on the prize** with `REFERRAL_AWARD_TICK=1` (requires
   `SERVER_EVENTS_CHANNEL_ID`). ⚠️ The week already ended when you switch it on is
   recorded unpaid; the first paid week is the one in progress. The first close
   the tick makes (no `referral_weeks` row exists yet) writes that ended week with
   `top_count 0` and `detail.failure` "payout was not enabled during this week",
   grants nothing and posts nothing, not even an ops note. Every later week pays
   normally. A week closes once three conditions are all met: `now >= end + 30 min`
   (`REFERRAL_CLOSE_GRACE_MS`), ingest has queued an event with `occurred_at > end`,
   and the `sessions-projector` consumer's cursor has reached every event before
   `end`. Check the cursor with
   `select last_event_id from consumer_cursors where consumer_name = 'sessions-projector'`
   vs. `select max(id) from events where occurred_at < '<boundary>'`.
   ⚠️ Older weeks are never paid.

**Checking a week:** `select * from referral_weeks order by week_start desc;` and
`referral_week_winners`. A week row means that week is paid; deleting one would pay
it again on the next tick, so never delete one on `factions_live`.

**A missing prize** (`plate-carrier` removed from `awards.json`): the week closes with
no grant and an ops alert naming the winners; grant by hand with `/award grant`.
