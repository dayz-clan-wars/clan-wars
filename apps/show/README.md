# apps/show: The Bloodbag and Painkiller Show, Clan Wars edition

Weekly animated recap. Design: `docs/superpowers/specs/2026-09-25-weekly-show-design.md`.
Plan 1 (this state of the app) writes and screens the script. Voicing, rendering and
publishing arrive with plans 2 and 3.

## Dry run

Reads one week, screens every player-written string, and prints the context and a
screened script. Writes nothing: the connection is read-only and screening verdicts are
kept in memory, so operator overrides are not applied in a dry run.

    set -a && . ./.env && set +a
    pnpm show --week 2026-09-21 --dry-run
    pnpm show --week 2026-09-21 --dry-run --print-prompt

`--week` takes any date and uses that week's Monday; without it, the last ended week.
Exit code 1 means the script was held by the output screen; the reasons are printed.

Against production, from this machine: open a tunnel to the host's Postgres
(`ssh -N -L 5435:127.0.0.1:5434 acab@regime.fi`) and point `DATABASE_URL` at
`127.0.0.1:5435`, database `factions_live`, with the credentials from `/opt/clan-wars/.env`.
The dry run's read-only connection is what makes that safe.

## Environment

| Key | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | |
| `OPENROUTER_API_KEY` | yes | |
| `SHOW_SCRIPT_MODEL` | | default `anthropic/claude-sonnet-4.6` |
| `SHOW_MODERATION_MODEL` | | default `anthropic/claude-sonnet-4.6` |
| `SHOW_STAFF_CLAN_TAGS` | | comma list, default `ADM` |
