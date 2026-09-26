# apps/show: The Bloodbag and Painkiller Show, Clan Wars edition

Weekly animated recap, hosted by Boris "Bloodbag" Volkov and Pavel "Painkiller" Sidorov.
Design: `docs/superpowers/specs/2026-09-25-weekly-show-design.md`. Plan 1 writes and
screens the script. Plan 2 can voice and render an episode locally for review. Plan 3
(this state of the app) publishes it: a scheduled service picks a week, renders it,
posts a draft to the ops channel, and, once an admin approves it, publishes to YouTube,
the show's Discord forum channel and Facebook. Deploy runbook:
`docs/deploy/2026-09-26-weekly-show.md`.

⚠️ The command is always `pnpm run show`, never `pnpm show` — the latter is pnpm's own
`view` command.

## Dry run

Reads one week, screens every player-written string, and prints the context and a
screened script. Writes nothing: the connection is read-only and screening verdicts are
kept in memory, so operator overrides are not applied in a dry run.

    set -a && . ./.env && set +a
    pnpm run show --week 2026-09-21 --dry-run
    pnpm run show --week 2026-09-21 --dry-run --print-prompt

`--week` takes any date and uses that week's Monday; without it, the last ended week.
Exit code 1 means the script was held by the output screen; the reasons are printed.

Against production, from this machine: open a tunnel to the host's Postgres
(`ssh -N -L 5435:127.0.0.1:5434 acab@regime.fi`) and point `DATABASE_URL` at
`127.0.0.1:5435`, database `factions_live`, with the credentials from `/opt/clan-wars/.env`.
The dry run's read-only connection is what makes that safe.

## Rendering an episode locally

`--render <dir>` does everything a dry run does, then (if the script is not held)
voices it with ElevenLabs, lip-syncs it with Rhubarb, and renders the finished 1080p
episode into `<dir>` as `episode.mp3` and `video.mp4`. Like the dry run, it writes
nothing to the database: the connection stays read-only and pronunciations use the
same read-through store as screening.

You need two external tools on your PATH (or pointed at by env, see below):

- **ffmpeg**: install however you normally would (e.g. `brew install ffmpeg` on macOS).
- **Rhubarb Lip Sync 1.13**: on macOS, download `Rhubarb-Lip-Sync-1.13.0-macOS.zip`
  from the project's GitHub releases, unzip it, and point `RHUBARB_PATH` at the
  `rhubarb` binary inside it.

Set the ElevenLabs keys below, then:

    set -a && . ./.env && set +a
    pnpm run show --week 2026-09-21 --render ./out

Unless `SHOW_CACHE_DIR` is set, `--render` caches under `<dir>/.cache`, so a local
render never needs the production path and never shares (or prunes) the scheduled
pipeline's cache. Before any LLM call it creates the cache directory and checks that
`ffmpeg -version` and `rhubarb --version` run, and stops with a message naming the
missing binary if either does not. The CLI creates `<dir>` if it does not exist.

## Running the scheduled service

`pnpm run show` with no flags is one run: the same thing the timer does every 10 minutes
(`deploy/systemd/clan-wars-show.timer`). It takes a Postgres advisory lock
(`SHOW_LOCK_KEY`) so a manual run and a timer run can never overlap, picks the earliest
week that needs work, and does nothing if `SHOW_ENABLED` is not set.

## Operator commands

| Command | Does |
|---|---|
| `pnpm run show` | one run, exactly what the timer does |
| `pnpm run show --week 2026-09-21 --dry-run` | context, screening verdicts and script to stdout; no audio, no files, no posts, no row |
| `pnpm run show --week <date> --render <dir>` | renders the episode locally into `<dir>`, as above |
| `pnpm run show --week <date> --force` | clears that week's narrative and every later stage, then runs |
| `pnpm run show --week <date> --force --repost` | required instead of plain `--force` when that week is already public |
| `pnpm show:backfill-pronunciations [--dry-run]` | pre-generates spoken forms for every known gamertag and clan |
| `pnpm show:screening --show <YYYY-MM-DD>` | prints a held episode's raw blocked reasons, in the terminal only — the ops channel post never carries them |
| `pnpm show:screening --allow "<text>"` \| `--block "<text>"` | writes an operator verdict |
| `pnpm show:youtube-auth` | mints the Clan Wars YouTube refresh token |

`--print-prompt` must be paired with `--dry-run` or `--render <dir>`; on its own it is a
usage error. `--force` and `--repost` only make sense on a service run, so they refuse to
combine with `--dry-run` or `--render`.

## Environment

| Key | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | |
| `OPENROUTER_API_KEY` | yes | |
| `SHOW_SCRIPT_MODEL` | | default `anthropic/claude-sonnet-4.6` |
| `SHOW_MODERATION_MODEL` | | default `anthropic/claude-sonnet-4.6` |
| `SHOW_STAFF_CLAN_TAGS` | | comma list, default `ADM` |

`--render` also needs:

| Key | Required | Notes |
|---|---|---|
| `ELEVENLABS_API_KEY` | yes | |
| `ELEVENLABS_BORIS_VOICE_ID` | yes | |
| `ELEVENLABS_PAVEL_VOICE_ID` | yes | |
| `ELEVENLABS_MODEL` | | default `eleven_multilingual_v2` |
| `SHOW_PRONUNCIATION_MODEL` | | default `anthropic/claude-sonnet-4.6` |
| `RHUBARB_PATH` | | default `rhubarb` (must be on PATH) |
| `FFMPEG_PATH` | | default `ffmpeg` (must be on PATH) |
| `SHOW_CACHE_DIR` | | `--render` default `<dir>/.cache`; the service default is `/var/lib/clan-wars-show` |
| `SHOW_DISCORD_INVITE` | | default `discord.gg/TJu4XP25nr` |
| `PRONUNCIATIONS_PATH` | | optional JSON file of `{"<name>": "<spoken>"}` overrides |

The scheduled service (`pnpm run show` with no `--dry-run`/`--render`, i.e. the timer)
additionally needs:

| Key | Required | Notes |
|---|---|---|
| `SHOW_ENABLED` | | `1`/`true` to run; default off, and everything below is unread until it is set |
| `DISCORD_TOKEN` | yes | the existing bot token |
| `DISCORD_GUILD_ID` | yes | used to find the ops-channel forum thread again after a crash, not to post — the bot already knows the guild from its channel ids |
| `OPS_CHANNEL_ID` | when approval is on | the existing ops channel; config load fails without it while `SHOW_REQUIRE_APPROVAL` is on |
| `SHOW_FORUM_CHANNEL_ID` | yes | the show's Discord forum channel |
| `SHOW_REQUIRE_APPROVAL` | | default on |
| `SHOW_APPROVER_DISCORD_IDS` | when approval is on | comma-separated Discord ids |
| `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`, `YOUTUBE_PLAYLIST_ID` | yes | the Clan Wars token, minted by `pnpm show:youtube-auth` — never the KOTH bot's token |
| `FACEBOOK_PAGE_ID`, `FACEBOOK_PAGE_ACCESS_TOKEN` | | both or neither; neither skips Facebook, which is always best-effort |

See the runbook (`docs/deploy/2026-09-26-weekly-show.md`) for how to obtain each of
these and the order to set them in.
