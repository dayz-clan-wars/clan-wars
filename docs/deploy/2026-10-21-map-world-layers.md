# Map world layers, search and item cards: deploy runbook

The map's world layers, search, item cards, ruler and readout read three generated files under
`apps/web/public/map-data/nasdara/`, plus the item pictures in `apps/web/public/items`:

- `world.json`: events, bunkers, wrecks, buildings, spawns, contaminated areas, from the Nasdara mission.
- `items.json`: the item index (types.xml, spawn gear, events, area flags), from the Nasdara mission.
- `item-cards.json`: name, description, weight, size and what fits each item, from the DayZ game files.

The web never reads the mission or the game at run time. The files are committed and ship with
the web build.

## Deploy

A normal web deploy. The files ride in the build, so there is no migration, no env change and no
bot restart.

## Rebuilding after a mission change

Run from the repo root. Use a scratch clone of the mission, never a checkout somebody else is
using.

1. `git clone <path to the nasdara mission repo> <scratch>/nasdara`, then check out the commit to
   build from (normally `origin/main`).
2. `pnpm --filter @factions/web map:world --mission <scratch>/nasdara`
3. `pnpm --filter @factions/web map:items --mission <scratch>/nasdara`
4. If the item list changed (the class names, not just nominal and min), rebuild the cards, see below.
5. `npx turbo run typecheck test --concurrency=1` (needs Postgres, see CLAUDE.md), then commit the three JSON files.

Both builds record the mission commit in `source.commit`.

## Rebuilding after a DayZ update (item cards)

The game is installed on the Ubuntu PC `rraygun@192.168.1.103`, so the cards are built in two halves.

1. Copy `apps/web/scripts/item-cards/extract.sh` to the PC and run `bash extract.sh` there. It
   derapifies every `config.bin` and pulls the English stringtable into `~/clan-wars-item-cards/out`,
   read-only against the Steam install.
2. Here: `pnpm --filter @factions/web map:cards`. It copies `out` back with `scp` and builds
   `item-cards.json`. `--host user@pc` picks another machine; `--from <dir>` reuses a copy already
   on this machine.
3. When only `items.json` changed, step 1 can be skipped while `~/clan-wars-item-cards/out` is still on the PC.

DayZ ships no item pictures, so cards use the wiki pictures in `apps/web/public/items`; an item
without one shows no picture. Add one and re-run `map:cards`.

## In-game spot check

Do this once after the first deploy. It confirms the grid orientation matches the game.

1. Join Nasdara and stand next to a bunker entrance.
2. Open the in-game GPS and write down the reading (three digits across, three up).
3. On the map, search that reading in the form `072 087`, and search the bunker by name.
4. The result and the bunker should land on the same spot.

Outcome (date, bunker, GPS read, result):

