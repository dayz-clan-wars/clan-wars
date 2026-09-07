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

1. **Read and apply migration 0026** with the one-off runner from
   `docs/deploy/2026-09-02-dormancy.md`. The bot may keep running while it applies; restart
   it after.

2. **DO NOT seed either consumer cursor** — unlike the map consumers, `sessions-projector`
   and `kills-projector` are deliberately left unseeded (cursor 0) so the first tick replays
   the whole event log into `player_sessions` and `kills` (nothing posts to Discord from
   either). Expect backfill to take several ticks — one 500-event batch per round trip; the
   cursor commits per batch. `guardedRunner` skips overlapping ticks meanwhile, so the bot
   posts nothing new until the backfill completes.

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

4. **Confirm over the first ticks** (`journalctl -u clan-wars-bot -f`, tick interval
   `BOT_TICK_INTERVAL_MS`, default 10 s): `membership: N opened` on the first tick (one per
   current full member), then `sessions: M opened, N closed` and `kills: K written` lines as
   the backfill progresses. The first tick will show membership opens only if there are
   current members; sessions and kills will backfill over several ticks until the cursor
   catches up to the head of the log.

5. **Verify the projection** — Open `/players` as a logged-in user and check that it renders
   with backfilled numbers for known players. Check a player profile at `/players/{gamertag}`
   and a clan board at `/clan/board`. Player stats include play time (from `player_sessions`),
   sessions count, last seen (from `players.last_seen_at` updated by `positions-tick.ts`),
   PvP kills and deaths (at ≥ 10 kills for K/D calculation), killed-by and killed names, and
   friendly fire (public). Clan boards show the same stats aggregated per clan.

6. **Rebuild scripts** — For each active server (single-server only; `factions_live` guard):

       pnpm rebuild:sessions --server 1
       pnpm rebuild:kills --server 1

   These rebuild the consumer cursors from the log head, clearing all `player_sessions` and
   `kills` rows and backfilling from the beginning. Use these after a migration or to wipe
   stats; they are idempotent and safe to run again. Never run against a test database unless
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
