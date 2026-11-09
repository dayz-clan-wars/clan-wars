# No fast travel, no Hub (unreleased after 2.20.0)

The mission (`dayz-one-life/nasdara`) unhooks the shed entrances
(`custom/pra-teleport-hub.json`) and removes the sky Hub and its 31 town doors.
This release is the clan-wars side:

- The ingest worker no longer uploads `pra-teleport-hub.json`, so active clans'
  flagpoles stop being travel points. `travel_uploads` keeps its old rows;
  nothing writes it.
- The bot has no Hub ban tick. `HUB_BAN_TICK` is no longer read.
- Bases may now be declared near where the Hub was (it was a fixed 200 m
  spacing point).
- The site's map has no Travel points layer, and the guide has no Getting
  around chapter (Fair play is now 11, the rules on one page 12, Achievements 13).

King of the Hill is unaffected: its towns and spawns come from
`packages/domain/assets/koth-locations.json` and the mission's
`cfgplayerspawnpoints.xml` `<fresh>` groups, never from the travel data.

## Deploy

1. Ship the mission change first or alongside; order does not matter for
   safety. Until the mission unhooks the file, the old `pra-teleport-hub.json`
   on the server stays as the worker last wrote it.
2. Deploy the bot and the worker as usual.
3. On the prod host, delete `HUB_BAN_TICK` from `/opt/clan-wars/.env` if it is
   set. Leaving it is harmless (nothing reads it), but it misleads.
4. The web deploy runs `guide:publish`, which keys channels on their numbered
   name: it creates `11-fair-play`, `12-rules-on-one-page` and `13-achievements`
   and reports the old `11-getting-around`, `12-fair-play`,
   `13-rules-on-one-page` and `14-achievements` as foreign. Delete those four by
   hand (or run `guide:publish --dry-run --prune` first and check it lists only
   them), and re-apply any hand-made keycap names to the new channels.

## Rollback

Revert the release. Nothing in the database changed.
