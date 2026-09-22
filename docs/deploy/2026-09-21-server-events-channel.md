# All scheduled server events move to #server-events — deploy

2026-09-21. Design: `docs/superpowers/specs/2026-09-21-discord-message-consistency-design.md`
§3.3. Code change: task 11 of that plan — `apps/bot/src/config.ts`,
`apps/bot/src/discord.ts`.

Airdrops already posted to `SERVER_EVENTS_CHANNEL_ID`. This deploy moves the raid-window
advance/open/close notices and the weekly vehicle-wipe notice there too, so every
scheduled server event shares one channel, and removes the bot's read of
`ANNOUNCEMENTS_CHANNEL_ID` entirely. `cfg.announcementsChannelId` no longer exists.

## 1. Check `SERVER_EVENTS_CHANNEL_ID` before restarting

⚠️ **This is the one real hazard in this deploy.** Before this change, only
`AIRDROP_TICK` required `SERVER_EVENTS_CHANNEL_ID` — `RESTART_SCHEDULE` alone does not
imply `AIRDROP_TICK` is on, so a host running `RAID_WINDOW_TICK` or
`WEEKLY_VEHICLE_WIPE` with airdrops off could legitimately have no
`SERVER_EVENTS_CHANNEL_ID` set. After this change, both of those features require it
too, and **the bot will refuse to boot without it**:

    RAID_WINDOW_TICK is on but SERVER_EVENTS_CHANNEL_ID is unset — …
    WEEKLY_VEHICLE_WIPE is on but SERVER_EVENTS_CHANNEL_ID is unset — …

Check before restarting:

    grep SERVER_EVENTS_CHANNEL_ID /opt/clan-wars/.env

If it is absent, **set it before restarting**, or the bot will not start. If it is
present, nothing further is needed for this variable.

**Verified present on 2026-09-21**: `/opt/clan-wars/.env` already carries
`SERVER_EVENTS_CHANNEL_ID`, checked directly against the production host, not inferred
from which features are on. This particular deploy is safe on that basis. Do not
extend that conclusion to any other host or to a future deploy without checking again.

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
- Two boot-refusal combinations exist now that did not before this deploy — config load
  refuses to start with a feature-specific error in either case:

  - `WEEKLY_VEHICLE_WIPE=1` with `SERVER_EVENTS_CHANNEL_ID` unset:

        WEEKLY_VEHICLE_WIPE is on but SERVER_EVENTS_CHANNEL_ID is unset — the Sunday
        notice is the only warning a player gets before their vehicle is cleared.

  - `RAID_WINDOW_TICK=1` with `ANNOUNCEMENTS_CHANNEL_ID` set but `SERVER_EVENTS_CHANNEL_ID`
    unset (having the old variable set does **not** satisfy the new gate):

        RAID_WINDOW_TICK is on but SERVER_EVENTS_CHANNEL_ID is unset — the feature posts
        player-facing advance/open/close notices, and with no channel to post them to it
        is misconfigured, not merely degraded.

  Step 1's check (`grep SERVER_EVENTS_CHANNEL_ID /opt/clan-wars/.env`, verified present
  on this host on 2026-09-21) is what rules these out for *this* deploy — that
  verification, not an inference from which features are on, is why they are not
  expected to fire here. There is no new "boots but posts nothing" case — the fatal
  gate replaces the old silent no-op (an unannounced wipe, or a raid window with no
  advance notice), which is a real improvement even though the boot-time failure mode
  above is new.

## 5. Verifying

- The next raid-window boundary's advance/open/close notice lands in `#server-events`,
  not `#announcements`.
- The next Sunday's vehicle-wipe notice lands in `#server-events`, not `#announcements`.
- `#announcements` receives nothing from the bot going forward.
- `docs/deploy/raid-window.md`, `docs/deploy/2026-09-17-raid-window.md` and
  `docs/deploy/2026-09-12-weekly-vehicle-rotation.md` now name `SERVER_EVENTS_CHANNEL_ID`
  and `#server-events`, not `ANNOUNCEMENTS_CHANNEL_ID` and `#announcements`.
