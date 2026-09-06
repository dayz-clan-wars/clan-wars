# Raids and notices (increment 3a) — deploy runbook

Migration 0023 adds seven nullable columns to `factions` and six tables. Nothing is dropped;
the bot may keep running while it applies, but restart it straight after: the raid and
raise consumers start at cursor 0 and fold every `flag.lowered`/`flag.raised` the log
already holds, which is exactly right (a raid last week is a raid) — but only once season 1
exists, so open the season BEFORE the restart.

1. **Read the migration.** `packages/db/migrations/0023_raids_and_queues.sql`.
2. **Apply 0023** with the one-off runner from `docs/deploy/2026-09-02-dormancy.md`.
3. **Stamp any pre-existing dormant clan's reason** (there are none on this deployment):
       update factions set dormant_reason = 'inactive' where status = 'dormant' and dormant_reason is null;
4. **Open season 1** — the raid consumer skips (and logs once per server) until this exists:
       insert into seasons (server_id, number, started_at) select id, 1, now() from servers where active;
5. **Env.** Bot `.env`: `WAR_LOG_CHANNEL_ID=<#war-log channel id>` (optional; without it raids
   queue and post in order once set). Web container (`docker-compose.yml`): `SITE_BASE_URL`
   alongside `WEB_BASE_URL`, same value — the invite DM's link is built inside the package.
6. **Deploy** bot and web together: `docker compose build web && docker compose up -d web &&
   sudo systemctl restart clan-wars-bot`.
7. **Confirm:** `journalctl -u clan-wars-bot -f` — no `raid tick failed` / `raise tick failed` /
   `notice tick failed`; `select count(*) from clan_notices where posted_at is null and
   failed_at is null and target = 'channel'` is the number of channel notices waiting for
   increment 3b's channels (expected: everything channel-bound, none failed).
8. **Acceptance.** A non-member lowers a test clan's flag: within a tick `raids` has a row,
   `factions.flag_down_since` is set, `#war-log` shows the raid line, every full member has a
   flag_down DM. A member raises: `defenses` row, `#war-log` defense line, `flag_down_since`
   null. Then the dormancy check from `docs/deploy/2026-09-05-declarations.md` step 9.
9. **What did not change / what waits.** No clan channel or role exists yet (3b); channel
   notices queue unfailed. `dormant` still DMs the leader as before AND queues the channel
   line. The verification DMs (`linked`, lockouts) still ride `notifyCompleted`, not the queue.
