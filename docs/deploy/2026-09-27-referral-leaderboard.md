# Referral leaderboards and the weekly plate carrier: deploy

Spec `docs/superpowers/specs/2026-09-27-referral-leaderboard-design.md`.

1. **Migrate.** `0056` only adds tables; nothing running selects a dropped column, so
   the bot may stay up. Apply it the usual way (`docs/deploy/2026-09-10-launch.md`).
2. **Deploy web and bot.** The leaderboards channel sees two boards it has no message
   for and rebuilds itself once, to twelve messages. Expected; nothing to do.
3. **Boards fill.** Qualification runs every `REFERRAL_AWARD_TICK_INTERVAL_MS`
   (default 5 min) with or without the payout switched on. Existing referrals whose
   player already has 2 hours qualify on the first pass, at their referral time.
4. **Crowns (optional).** Create two roles and set `CROWN_REFERRERS_ROLE_ID`,
   `CROWN_REFERRERS_WEEK_ROLE_ID`. Each must differ from every other crown role.
5. **Switch on the prize** with `REFERRAL_AWARD_TICK=1` (requires
   `SERVER_EVENTS_CHANNEL_ID`). The first payout is the first week that ends after
   this: Monday 10:00 UTC plus 30 minutes and ingest caught up. ⚠️ Older weeks are
   never paid.

**Checking a week:** `select * from referral_weeks order by week_start desc;` and
`referral_week_winners`. A week row means that week is paid; deleting one would pay
it again on the next tick, so never delete one on `factions_live`.

**A missing prize** (`plate-carrier` removed from `awards.json`): the week closes with
no grant and an ops alert naming the winners; grant by hand with `/award grant`.
