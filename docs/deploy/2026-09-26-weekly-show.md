# The weekly show — deploy and operate

The Bloodbag and Painkiller Show now airs a weekly Clan Wars episode: Boris and Pavel
recap the week's raids and standings, an admin approves it in the ops channel, and it
posts to YouTube, the show's forum channel and Facebook. Spec:
`docs/superpowers/specs/2026-09-25-weekly-show-design.md`.

## 1. What this deploys

- Migration 0053 (`show_episodes`, `show_pronunciations`, `show_text_screening`), already
  shipped with plan 1's release. Nothing new to migrate here.
- `deploy/systemd/clan-wars-show.service` and `clan-wars-show.timer`: a oneshot every 10
  minutes, in the same shape as `clan-wars-guide`.
- The new env keys below. The whole feature is off until `SHOW_ENABLED=1` is set.

## 2. Host prerequisites

Check both binaries are on `acab`'s PATH:

    which ffmpeg rhubarb

The deathmatch bot already uses both, so they are likely already installed. If either is
not on PATH, point `FFMPEG_PATH` or `RHUBARB_PATH` at the binary directly instead of
adding it to PATH.

`/var/lib/clan-wars-show` does not need to be created by hand: `StateDirectory=clan-wars-show`
in the unit file creates it, owned by `acab`, the first time the service runs. It is
`SHOW_CACHE_DIR`'s default.

## 3. Mint the YouTube token

The Google Cloud OAuth client is the KOTH show's existing Desktop client. Clan Wars needs
its own refresh token on the same channel, because the KOTH bot's token only has
`youtube.upload` and `youtube.readonly` scopes and this show also needs `youtube` (to
set a video public and add it to a playlist).

    set -a && . ./.env && set +a
    pnpm show:youtube-auth

Approve in a browser signed in to the show's channel, not any other Google account. Put
the resulting value in `/opt/clan-wars/.env`:

    YOUTUBE_REFRESH_TOKEN=<value>

The KOTH bot's own token is untouched by this.

## 4. Create the playlist

In YouTube Studio, on the same channel, create a playlist named "Clan Wars". Copy its id
(the `PL...` segment of its URL) into:

    YOUTUBE_PLAYLIST_ID=<value>

An episode is added to the playlist when it goes public, after an admin approves it, not
at upload time.

## 5. Env keys

The full table is in `apps/show/README.md`. This deploy's specific values:

- `SHOW_FORUM_CHANNEL_ID=1553136654808784986` (`#🩸-the-bloodbag-and-painkiller-show`).
- `SHOW_APPROVER_DISCORD_IDS`: the admins, comma-separated Discord ids.
- The ElevenLabs key and voice ids, and the Facebook page id and token: copy the same
  values already in `/opt/deathmatch-bot/.env`.
- `SHOW_ENABLED` stays unset for now — set it in step 10, after everything else here is
  confirmed working.
- Never paste any of these values into a ticket or a chat message. Set them directly in
  `/opt/clan-wars/.env` on the host.

## 6. Bot permissions

In the ops channel, the bot needs View Channel, Send Messages, Add Reactions and Read
Message History. In the forum channel it needs Create Posts, Send Messages in Threads
and Attach Files. Check both with a manual test post before enabling the timer.

## 7. Backfill pronunciations

    pnpm show:backfill-pronunciations --dry-run

Read the output, then run it for real:

    pnpm show:backfill-pronunciations

## 8. Dry run a past week

    pnpm run show --week 2026-09-21 --dry-run

This is read-only: it prints the story context and the screened script and writes
nothing. Read the script before going further.

## 9. Render one week locally against a snapshot

On a workstation, as in plan 2:

    pnpm run show --week <date> --render <dir>

Watch it run and time it (spec §16). This is the only coverage this render path gets
before the first scheduled run touches production — the real wiring (YouTube, the forum,
Facebook, approval) is covered by typechecking only, so the first real `--week` run on the
host should be watched live:

    journalctl -u clan-wars-show -f

## 10. Install and enable

    sudo ln -s /opt/clan-wars/deploy/systemd/clan-wars-show.{service,timer} /etc/systemd/system/
    sudo systemctl daemon-reload

Set `SHOW_ENABLED=1` in `/opt/clan-wars/.env` (approval stays on by default —
`SHOW_REQUIRE_APPROVAL` defaults to on).

    sudo systemctl enable --now clan-wars-show.timer
    journalctl -u clan-wars-show -f

## 11. Approving an episode

React ✅ or ❌ on the draft posted in the ops channel. Only reactions from
`SHOW_APPROVER_DISCORD_IDS` count; anyone else's reaction does nothing. ❌ wins over ✅
if both are present.

⚠️ An episode waiting for approval holds back every later week (spec §8.1) — a run always
picks the earliest unfinished week first, so an unapproved draft is a queue, not a single
stuck episode.

The plan is to keep approval on for the first four episodes, then set
`SHOW_REQUIRE_APPROVAL=0`.

## 12. When something goes wrong

**A held episode:** the ops channel post never carries the raw blocked text — only counts
and categories. To see the actual reasons, run this in a terminal on the host:

    pnpm show:screening --show <date>

Then write a verdict:

    pnpm show:screening --allow "<text>"
    pnpm show:screening --block "<text>"

And re-run the week:

    pnpm run show --week <date> --force

**A stuck stage:** the ops channel gets one alert at exactly 3 attempts on a stage, not
repeated after. Read the reason with a read-only query:

    select stage, attempts, last_error from show_episodes order by week_start desc limit 3;

**A public episode that needs a redo:** `--force` alone refuses on a week that is already
public. Use both:

    pnpm run show --week <date> --force --repost

The old YouTube video is not deleted automatically; delete it by hand if it should not
stay up.

**A Facebook failure:** it shows up as `last_error` on a row that is otherwise `done`. It
is never retried; Facebook posting is best-effort.

## 13. Turning it off

    sudo systemctl disable --now clan-wars-show.timer

or leave the unit running and unset `SHOW_ENABLED` in `/opt/clan-wars/.env` — the service
exits immediately on the next tick either way.
