# Scoring and seasons (increment 4) — deploy runbook

Migration 0024 adds `alpha_weeks`, `season_results` and `seasons.week_closed_through`. Nothing is
dropped. The bot gains the week tick (closes every ended week, in order, at the top of every
interval) and `@Alpha`; the site gains four public pages. `scripts/wipe.ts` is the wipe.

1. **Read the migration.** `packages/db/migrations/0024_seasons_close.sql`.
2. **Apply 0024** with the one-off runner from `docs/deploy/2026-09-02-dormancy.md`. The bot may
   keep running while it applies; restart it after.
3. **Create the `@Alpha` role by hand**, below the bot's role; put its id in the bot `.env` as
   `ALPHA_ROLE_ID`. The bot refuses to start without it. Never assign it by hand — the reconciler
   (`structure-tick.ts`) gives it to the full members of the latest closed week's Alphas and takes
   it from everyone else.
4. **Deploy** bot and web together: `docker compose build web && docker compose up -d web &&
   sudo systemctl restart clan-wars-bot`.
5. **Confirm over the first two ticks** (`journalctl -u clan-wars-bot -f`, tick interval
   `BOT_TICK_INTERVAL_MS`, default 10 s): the first interval tick logs `weeks closed N`, where N
   is the number of Monday boundaries since season 1 opened (each queues a `🏆 Alphas this week: …`
   — or `🏆 No Alphas this week — nobody scored.` — line to `#war-log`, in order; a season opened
   on a Wednesday closes its first, partial week the following Monday). Within that same tick,
   `structure tick: …` still reflects the *previous* `seasons.week_closed_through` — the
   reconciler runs before the week tick in the fire order (presence → structure → raid → raise →
   week → verification → …) — so `alphaAdds K` for the week just closed shows up one tick later,
   on the second `structure tick: …` line. `/scoreboard`, `/alphas`, `/seasons`, `/war-log` render
   without signing in throughout.
6. **The wipe**, when the server owner schedules it: stop the bot; run the game server's wipe;
   then, from the repo root on the host:

       set -a && . ./.env && set +a && pnpm wipe --server 1 --at 2026-10-01T06:00:00Z

   (equivalently `DATABASE_URL=... pnpm wipe --server 1 --at <ISO>`; the CLI refuses to run
   unless `DATABASE_URL` ends in `/factions_live`, add `--allow-test-db` only off production). It
   prints the `WipeResult` as one line of JSON. Running it again with the same `--at` prints
   `"skipped":true` and **exits non-zero on purpose** — that is the guard against a second,
   accidental wipe, not a bug. Then start the bot. `#war-log` gets the `🏁 Season N is over…`
   line; `/seasons` shows the table; every clan's flag is down in the game and its base is
   unbound. The first raise of a holding clan's own texture by one of its full members, at any
   free pole, binds the new base (the normal 200 m rule applies to that raise like any other
   declare); if the raise is refused (too close to another hold, or the pole is already taken),
   nothing is written — no notice, no feed row, just an `info`-level log line — and the member has
   to raise again at a different pole. Solos re-declare on `/base`.
7. **Rebuild standings** only if a hand edit or a bug is suspected:

       DATABASE_URL=... pnpm rebuild:standings --season <id>

   Same `factions_live` guard as the wipe (`--allow-test-db` to override off production). The
   drift test (`apps/bot/test/standings.test.ts`) guarantees this equals what the consumers wrote.
8. **What waits.** `clan_pins` and `intruder_sightings` (wipe step 5) arrive with increment 5;
   `wipe.ts` names them in a comment already, so that step is a known, deliberate gap, not a
   missed one.
