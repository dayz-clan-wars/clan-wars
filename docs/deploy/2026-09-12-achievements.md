# Achievements — runbook

Fifty lifetime achievements (spec `docs/superpowers/specs/2026-09-11-achievements-design.md`).
Migration 0031 adds three tables, all additive; nothing needs stopping for it. The bot tick is
OFF until `ACHIEVEMENTS_TICK=1`, which is the last step — the backfill must run first, or launch
day posts every historical unlock into Discord.

⚠️ **The live tick MUST be off (`ACHIEVEMENTS_TICK` unset) for the whole time the backfill
runs.** `achievementsTick`'s live pass and its backfill pass (`{ everyone: true }`) share the
same watermarks and resume marker — that is the *only* interlock between them, there is no
lock. Two passes racing would each think the other's progress belongs to it and skip owners,
which the unlock table's primary key makes harmless (never a duplicate row) but not complete
(a missed owner just never gets evaluated that pass). Keep `ACHIEVEMENTS_TICK` unset until
after the backfill's summary line and exit 0 in step 3.

## Steps

1. Apply migration 0031 with the one-off runner from `docs/deploy/2026-09-02-dormancy.md`, after
   confirming `__drizzle_migrations` holds 31 rows and the journal 32 (only 0031 applies).
2. Deploy the bot (git pull, `sudo systemctl restart clan-wars-bot`) with `ACHIEVEMENTS_TICK`
   unset. Confirm `systemctl status clan-wars-bot` and that `events` keeps growing.
3. Backfill: `cd /opt/clan-wars && set -a && . ./.env && set +a && pnpm backfill:achievements`.
   Expect a summary line (`backfill: N owners evaluated, N unlocks inserted, 0 rule failures,
   in Nms`) and exit 0.

   ⚠️ Unlike `pnpm rebuild:kills`, the root form of this script resolved cleanly in testing —
   `@factions/db` and `drizzle-orm` both resolved from the workspace root without the
   `drizzle-orm` failure CLAUDE.md warns about for the rebuild scripts. If it fails to resolve
   here anyway, run it from the bot package instead:

       pnpm --filter @factions/bot exec tsx ../../scripts/backfill-achievements.ts

   Check: `select owner_kind, count(*) from achievement_unlocks group by 1;` and
   `select count(*) from clan_notices where kind = 'achievement';` — the second MUST be 0.
4. Create `#achievements` in Discord, give the bot **Send Messages** permission there (it
   posts nothing if the permission is missing — no error, just silence), put its id in `.env`
   as `ACHIEVEMENTS_CHANNEL_ID`, set `ACHIEVEMENTS_TICK=1`, restart the bot.
5. Deploy the web app: `/opt/clan-wars/deploy/deploy-web.sh`.
6. Acceptance: a player profile shows the wall with earned tiles dated in the past; the guide has
   chapter 14; the next real kill by a player one short of Ten Down posts three notices.

## Verification against the test database (before touching `factions_live`)

    DATABASE_URL="postgres://factions:factions@localhost:5434/factions_test_bot" \
      pnpm backfill:achievements --allow-test-db

Run 2026-09-12 against the bot suite's test database (left over from Task 9's test run, no
seeded owners): `backfill: 0 owners evaluated, 0 unlocks inserted, 0 rule failures, in 56ms`,
exit 0. A database that happens to carry leftover rows from an earlier test run may report a
nonzero summary instead — that is fine; the check is exit 0 and a printed summary line, not any
particular count.

## Badge art (2026-09-12, after the first deploy)

The badges (design hand-off `achievements.zip`) live in `apps/web/public/achievements/` —
`unlocked/<key>.png`, `locked/<key>.png`, `svg/<key>.svg`, one per key in
`packages/domain/src/achievements.ts` (`apps/web/test/achievement-share.test.ts` and
`achievement-glyphs.test.ts` hold the three sets and the keys together). The site draws
badges inline from `apps/web/lib/achievement-glyphs.ts`, which `pnpm build` regenerates
from the SVGs first (`prebuild`); after replacing an SVG, rerun
`pnpm --filter @factions/web exec tsx scripts/build-achievement-glyphs.ts` and commit the
module, or the glyph test fails.

- **Web deploy** as usual (`/opt/clan-wars/deploy/deploy-web.sh`). The wall, the owner's
  "Achievement unlocked" toasts (player-scoped unlocks from the last 7 days), and the share
  card `/api/og/achievement/<key>?gamertag=&tag=&earned=` ship with it. `/achievements/` and
  `/api/og/` are public paths (`lib/auth/gate.ts`) — Discord's crawler fetches them with no
  session, and gated they would 303 to `/login` and every embed would post without its badge.
- **Bot** (git pull, `sudo systemctl restart clan-wars-bot`): unlock notices now post as an
  embed (group colour, `unlocked/<key>.png` thumbnail from `SITE_BASE_URL`, `Clan Wars ·
  Livonia` footer). The clan channel still gets the player's mention, in the message content
  ahead of the card; the DM and `#achievements` get the card alone. Nothing to migrate.
- Acceptance: paste `https://dayzclanwars.com/api/og/achievement/champions?gamertag=X&tag=Y`
  into Discord — it must unfurl as the card (not a login page); the next real unlock posts
  a coloured card with a badge thumbnail.

## Rolling back

Unset `ACHIEVEMENTS_TICK`, restart the bot. The tables can stay; nothing else reads them.
