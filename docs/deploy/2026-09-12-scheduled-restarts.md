# Scheduled restarts from the bot — runbook

Spec `docs/superpowers/specs/2026-09-12-scheduled-restarts-design.md`. The bot restarts every
active server with a `nitrado_service_id` at the top of every even UTC hour (00:00, 02:00 …
22:00), through Nitrado's API, and writes one `server_restarts` row per server per slot.
Migration 0032 adds that table, additively. `messages.xml` is NOT touched by any of this.

⚠️ If `messages.xml` still carries its own shutdown entry, both schedules fire. The bot skips a
slot when the server is not `started` (so a shutdown already in flight is not followed by a
second restart), but two independent schedules is still two sets of restarts. Trim the
shutdown from `messages.xml` by hand when you are happy the bot's are landing.

## Steps

1. Apply migration 0032 with the one-off runner from `docs/deploy/2026-09-02-dormancy.md`,
   after confirming `__drizzle_migrations` holds 32 rows and the journal 33.
2. Deploy the bot with `RESTART_SCHEDULE` unset: `cd /opt/clan-wars && git pull --ff-only &&
   pnpm install --frozen-lockfile && sudo systemctl restart clan-wars-bot`. The journal shows
   `RESTART_SCHEDULE is off` at startup.
3. Pick a moment more than ten minutes past an even hour (so the first slot the bot sees is a
   clean, future one), put `RESTART_SCHEDULE=1` in `.env` (`NITRADO_TOKEN` is already there for
   the worker), and `sudo systemctl restart clan-wars-bot`. The journal shows
   `scheduled restarts on: every even UTC hour`.
4. At the next even hour: `select * from server_restarts order by scheduled_for desc limit 3;`
   shows a `restarted` row within seconds of the hour, the journal shows
   `restart: server 1 restarted for …`, and Nitrado's panel shows the restart. A fresh ADM
   file appears in `adm_files` once the server is back.

## Checking it is working

    select scheduled_for, outcome, detail from server_restarts order by scheduled_for desc limit 12;

Twelve rows a day, all `restarted`. A `skipped` row names the status the server was in; a
`missed` row means the bot was down or Nitrado kept failing for the whole ten-minute window —
`detail` says which. ⚠️ `systemctl status clan-wars-bot` says nothing about any of this.

## Rolling back

Unset `RESTART_SCHEDULE`, restart the bot. The table can stay; nothing else reads it.
