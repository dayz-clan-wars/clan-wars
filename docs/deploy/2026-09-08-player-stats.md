# Player stats (increment 6) — deploy runbook

Migration 0026 adds `player_sessions`, `kills`, and `membership_history`. Nothing is
dropped. The bot gains the membership tick (reconciles the roster against `membership_history`,
opening and closing spans as members join and leave), the sessions tick (projects
`player.connected` and `player.disconnected` events into `player_sessions` rows), and the
kills tick (projects `player.killed` and `player.died` events into `kills` rows, resolving
victim and killer faction membership at the instant each event occurred). The site gains
`/players` (the leaderboard), `/players/{gamertag}` (individual profile), and `/clan/board`
(clan statistics). All stats are public, including friendly fire.

⚠️ Self-kills are never friendly fire and never PvP kills. Kills before the first membership
reconciler run have null faction ids and `friendly_fire = false` unless the seeded span
(from `joined_at`) covers them — the reconciler's first run seeds spans from `joined_at`, so
kills after each member's `joined_at` do resolve.

1. **Read and apply migrations 0026 and 0027** with the one-off runner from
   `docs/deploy/2026-09-02-dormancy.md`. The bot may keep running while they apply; restart
   it after. 0027 is additive and index-only — five indexes behind the public `/players`
   routes: `players_gamertag_lower_idx` and `identity_links_gamertag_lower_idx` (functional,
   on `lower(gamertag)`, for the case-insensitive name lookup), `kills_victim_dayz_idx` and
   `kills_killer_dayz_idx` (bare-column, for the "has the log ever seen this character"
   check, which cannot use the `server_id`-leading composites), and
   `events_raise_by_player_idx` (partial, on `payload->>'dayzId'` where `type =
   'flag.raised'`, for the upkeep-raise count). Building them on a large `kills` / `events`
   locks each table against writes for the duration; apply 0027 in the same quiet window as
   the restart in step 2.

2. **DO NOT seed either consumer cursor** — unlike the map consumers, `sessions-projector`
   and `kills-projector` are deliberately left unseeded (cursor 0) so the first tick replays
   the whole event log into `player_sessions` and `kills` (nothing posts to Discord from
   either).

   ⚠️ **The backfill is ONE long first tick per consumer, not "several ticks".** Both
   `sessionsTick` and `killsTick` loop internally until `readEventBatch` comes back empty,
   so each one drains the whole event log inside a single call. That means:

   - **No progress output.** Each consumer prints exactly one log line, at the very end,
     with the totals for the whole run. Silence is not a hang.
   - **Every other tick step is skipped for the duration.** `guardedRunner` is one runner
     for the whole bot, so while the backfill runs, presence, positions, zone, raids,
     defenses, dormancy, the notice queue and the war-log poster all skip. A flag-down DM
     can be that late.
   - **It is safe to restart the bot mid-backfill.** The cursor commits after every batch,
     so a restart resumes from the last committed batch rather than starting over.
   - **Sizing it is arithmetic, not a guess.** Run `select count(*) from events` first.
     Each consumer walks the whole table at roughly one 500-row batch per round trip — so
     count/500 round trips each, and the two consumers pay that separately, plus two to
     three statements per connect/disconnect and three per kill. At the schema's own
     measured scale (~1M events) that is ~2000 batches per consumer and a plausible ten to
     thirty minutes with the bot otherwise idle.

   Verify that neither consumer row exists:

       select consumer_name, last_event_id from consumer_cursors
       where consumer_name in ('sessions-projector', 'kills-projector');

   You should get zero rows. If either row exists, delete it:

       delete from consumer_cursors
       where consumer_name in ('sessions-projector', 'kills-projector');

   **Schedule the restart in a quiet hour** — the bot backfills the whole event log. Plan for a
   burst of database activity and silence in Discord while the projection runs to completion.

3. **Deploy bot and web together**: `docker compose build web && docker compose up -d web &&
   sudo systemctl restart clan-wars-bot`.

4. **Confirm on the first tick** (`journalctl -u clan-wars-bot -f`, tick interval
   `BOT_TICK_INTERVAL_MS`, default 10 s). Expect, in this order and each printed ONCE:

       membership: N opened, M closed
       sessions: N opened, M closed, R restarted
       kills: K written

   `membership:` lands immediately (one open per current full member; nothing to close on a
   first run). `sessions:` and `kills:` do not appear until their backfill has drained the
   whole log — that is the long tick from step 2, and the numbers on those two lines are the
   totals for the entire replay, not for one batch. `R restarted` counts sessions closed at
   an ADM file boundary or by a duplicate connect; a large number on a first backfill is
   expected, because every historical server restart strands its open sessions. Each line is
   printed only when at least one of its figures is non-zero.

5. **Verify the projection** — Open `/players` (public — no sign-in, that is the point of
   the gate change; `/clan/board` is the gated one) and check that it renders
   with backfilled numbers for known players. Check a player profile at `/players/{gamertag}`
   and a clan board at `/clan/board`. Player stats include play time (from `player_sessions`),
   sessions count, last seen (from `players.last_seen_at` updated by `positions-tick.ts`),
   PvP kills and deaths (at ≥ 10 kills for K/D calculation), killed-by and killed names, and
   friendly fire (public). Clan boards show the same stats aggregated per clan.

6. **Rebuild scripts** — single-server only; both refuse to run when more than one active
   server exists, and both carry the `factions_live` guard:

       pnpm rebuild:sessions --server 1
       pnpm rebuild:kills --server 1

   Each **deletes only the named server's** `player_sessions` / `kills` rows, **resets that
   consumer's cursor to 0** (not to the log head), and replays the whole log. ⚠️ The cursor
   is global while the delete is per server, so the replay re-derives every server's rows —
   harmless, since every predicate is scoped by `server_id` and every write is idempotent,
   and it is exactly why the scripts refuse a multi-server database. A rebuild costs the same
   one long drain as step 2's backfill. Use these after a migration or to wipe stats; they
   are idempotent and safe to run again. Never run against a test database unless
   `--allow-test-db` is passed.

7. **History before this deploy** has no `membership_history`, so kills from before the
   membership reconciler's first run do not resolve faction membership: `victim_faction_id`,
   `killer_faction_id`, and `friendly_fire` are all null or false for those kills. The
   reconciler's first run seeds membership spans from each member's `joined_at`; kills that
   occurred at or after each member's `joined_at` will resolve correctly on their next
   backfill or rebuild run. Say this plainly to players if old stats look incomplete — it is
   expected and correct.

⚠️ **Nothing is ever posted to Discord from these consumers.** Sessions and kills are stats
only, never points or notices. `kills are stats, never points` (global constraint; spec §11,
§16).
