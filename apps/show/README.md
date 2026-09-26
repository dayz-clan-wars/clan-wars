# apps/show: The Bloodbag and Painkiller Show, Clan Wars edition

Weekly animated recap. Design: `docs/superpowers/specs/2026-09-25-weekly-show-design.md`.
Plan 1 writes and screens the script. Plan 2 (this state of the app) can voice and
render an episode locally for review. Publishing arrives with plan 3.

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
