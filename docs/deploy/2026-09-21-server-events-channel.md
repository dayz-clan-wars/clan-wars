# All scheduled server events move to #server-events — deploy

2026-09-21. Design: `docs/superpowers/specs/2026-09-21-discord-message-consistency-design.md`
§3.3. Code change: task 11 of that plan — `apps/bot/src/config.ts`,
`apps/bot/src/discord.ts`.

Airdrops already posted to `SERVER_EVENTS_CHANNEL_ID`. This deploy moves the raid-window
advance/open/close notices and the weekly vehicle-wipe notice there too, so every
scheduled server event shares one channel, and removes the bot's read of
`ANNOUNCEMENTS_CHANNEL_ID` entirely. `cfg.announcementsChannelId` no longer exists.

## 1. The `.env` change — there isn't one, before the restart

`SERVER_EVENTS_CHANNEL_ID` is **already set in production** — it has been, since the
airdrop feature shipped. `RAID_WINDOW_TICK` and `WEEKLY_VEHICLE_WIPE` already ride on
the same restart-schedule requirement the airdrop tick does, so if the bot is running
today with those features on, it already has the one variable this change needs. No
`.env` edit is required before restarting the bot for this deploy.

## 2. ⚠️ `ANNOUNCEMENTS_CHANNEL_ID` STAYS in `/opt/clan-wars/.env`

**Do not remove `ANNOUNCEMENTS_CHANNEL_ID` from `.env` or `.env.production`.** The bot
no longer reads it — `cfg.announcementsChannelId` is gone from `config.ts`, and nothing
in `apps/bot/src` or `scripts/` reads the env var after this deploy — but a human still
posts announcements to `#announcements` from the production host, outside the bot
entirely, using that same variable name as a channel id in whatever tool or script
drives that manual workflow. Removing the config field from the bot is not a licence to
remove the env var from the deployed environment. If a future change makes the manual
workflow itself stop needing it, that is a separate, deliberate decision — not a
side effect of this one.

## 3. Restart

    cd /opt/clan-wars && git pull --ff-only && sudo systemctl restart clan-wars-bot
    systemctl status clan-wars-bot

⚠️ `active (running)` says only that one process is running. Confirm the data path
separately — `docker compose ps` shows `postgres` healthy, and `events` is still
growing.

## 4. What changes after the restart

- **`#server-events` carries all three scheduled notices**: an airdrop's location, the
  raid window's advance/open/close notices, and the weekly vehicle-wipe notice. This was
  already true for airdrops; it is now true for the other two as well.
- **`#announcements` is human-only.** The bot posts nothing there anymore. Anything
  appearing in `#announcements` from here on was posted by a person, not the bot.
- If `RAID_WINDOW_TICK` or `WEEKLY_VEHICLE_WIPE` is on and `SERVER_EVENTS_CHANNEL_ID` is
  somehow unset, config load now refuses to start with a feature-specific error:

      RAID_WINDOW_TICK is on but SERVER_EVENTS_CHANNEL_ID is unset — the feature posts
      player-facing advance/open/close notices, and with no channel to post them to it
      is misconfigured, not merely degraded.

      WEEKLY_VEHICLE_WIPE is on but SERVER_EVENTS_CHANNEL_ID is unset — the Sunday
      notice is the only warning a player gets before their vehicle is cleared.

  Given step 1, this should not happen on this deploy — it is the failure mode to
  recognize if it somehow does.

## 5. Verifying

- The next raid-window boundary's advance/open/close notice lands in `#server-events`,
  not `#announcements`.
- The next Sunday's vehicle-wipe notice lands in `#server-events`, not `#announcements`.
- `#announcements` receives nothing from the bot going forward.
- `docs/deploy/raid-window.md`, `docs/deploy/2026-09-17-raid-window.md` and
  `docs/deploy/2026-09-12-weekly-vehicle-rotation.md` now name `SERVER_EVENTS_CHANNEL_ID`
  and `#server-events`, not `ANNOUNCEMENTS_CHANNEL_ID` and `#announcements`.
