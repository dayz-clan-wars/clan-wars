# Site link and base (increment 2b) — deploy runbook

Migration 0021 makes `verification_challenges.guild_id` and `channel_id` nullable. It is
additive and reversible: no data moves, and the running bot keeps inserting both columns.
The order matters only in one direction — the web build that issues challenges with no
channel must not run against the old schema, or its first `/link` fails with a NOT NULL
violation.

1. **Read the migration.** `packages/db/migrations/0021_site_challenges.sql` — two
   `DROP NOT NULL` statements and nothing else. Nothing applies migrations in production.
2. **Apply 0021** with the one-off runner from `docs/deploy/2026-09-02-dormancy.md`. The bot
   may keep running: it neither reads a null there nor writes one until step 4.
3. **Confirm:**

       select is_nullable from information_schema.columns
        where table_name = 'verification_challenges' and column_name in ('guild_id','channel_id');

   Both rows `YES`.
4. **Deploy the bot and the web image together** (`docker compose build web && docker compose
   up -d web`; `sudo systemctl restart clan-wars-bot`). The bot's new code handles a
   null-channel notification (DM only, no channel fallback) and falls back to
   `DISCORD_GUILD_ID` for the nickname on a site-issued link. No new environment variables.
5. **Acceptance, as a linked player.** On the site: `/link` lists unclaimed gamertags the
   server has seen; a challenge shows three emotes and a 24-hour clock (ten minutes until 2026-09-08); performing them
   in game ticks the tickets within a minute (the bot's tick) and the DM arrives; `/me`
   shows the link; `/base` lists the poles you have raised at; Declare, then Release, with
   the `?result=` copy each time. Then in the database:

       select id, discord_id, guild_id, channel_id, completed_at, cancel_reason
         from verification_challenges order by id desc limit 5;

   Site-issued rows have null `guild_id`/`channel_id`. And the dormancy check from
   `docs/deploy/2026-09-05-declarations.md` step 9, together with `select count(*) from
   factions`, before and after.
6. **What did not change.** Discord's `/link` still issues 24-hour challenges
   (`DISCORD_LINK_TTL_MS`); it is retired in increment 2c with the rest of the commands. The
   `@Linked` role does not exist yet (increment 3).
