# Map: everything players open iZurvive for

**Date:** 2026-10-21
**Status:** draft

## Purpose

Clan Wars players keep iZurvive open next to our map to answer "what's near me?"
questions: where can a water truck or a truck spawn near me, where is the nearest
military loot, and where is the bunker the Morse code just gave me. The goal is that
nobody on the server ever needs iZurvive again. Everything the map answers comes from
**our own Nasdara mission files**, so it shows what our server actually spawns,
custom changes included. iZurvive shows vanilla data and can be wrong for us. For
example, our `types.xml` makes the M4A1 a Unique item that only spawns in contaminated
areas.

The map already has the clan layers (you, base, clanmates, intruders, bounties,
public bases, pins, travel, places, terrain). This adds the world layers, a much
smarter search, and a ruler.

## Decisions (made in brainstorming)

1. **Feature target is iZurvive's Nasdara map**, as reviewed on 2026-10-21: every
   filter group, the search box (Locations / Items / Models), the cursor coordinate
   readout and the ruler.
2. **"Near me" means icons only.** No nearest-list and no distance rings. Players turn
   a layer on and look around their dot.
3. **The search box takes any of these:**
   - a place name;
   - **GPS**: two 3-digit numbers (`072 087`, `072/087`, `072,087`), the numbers the
     in-game GPS shows, in 100 m units. The second number counts **down from the top
     (north) edge**, as the in-game GPS does. iZurvive confirms this: its readout
     for game z=87 is GPS Y 163 on the 16384 m map;
   - **game metres**: two 4–5 digit numbers (`7216 5706`), x then z, to the metre.
   - Searching a coordinate pans there and drops a temporary marker only the searcher
     sees. **Builder's call (made by Claude, not the user):** the marker has a
     "Pin it" action that opens the existing pin sheet at that spot, so sharing with
     the clan goes through pins. No new sharing system.
   - iZurvive gets this wrong: it reads `072 087` as metres and lands in the map
     corner. Our search must not.
4. **Bunkers are a layer**, from `cfgbunkerbroadcast.json` `proxies[].position`. That is
   23 entrances; 3 are active at once, and the map cannot know which three.
5. **Item search is in v1.** Type an item name; the map hides the other loot icons and
   shows only the buildings and areas where that item can spawn on our server.
6. **The item card is in v1** (picture, description, weight, size, attachments,
   magazines, ammo). Its data is **extracted from the DayZ game files ourselves**, not
   scraped from iZurvive (their compiled work; ToS). See *Item card data*.
7. **Drawing tools: ruler only.** No lines, shapes or circles. Pins already cover
   marking.
8. **The "truck" players ask for is the `VehicleTruck01` event** (covered M3S trucks,
   27 positions). There is no separate build-truck event on Nasdara.

9. **The site's grid reference switches to in-game GPS numbering, everywhere** (user,
   2026-10-21). Until now `gridRef` (`apps/web/lib/map-projection.ts`) counted the
   second number up from the bottom, so "Grid 067 023" on the site and the in-game GPS
   disagreed. From this change every grid ref on the site (bottom bar, pin/base/roster
   labels, kit and award pages, `/map?at=` keys) is the GPS's. The 1 km grid lines are
   drawn from the top edge too, so a GPS cell is a drawn cell. Old `/map?at=` links and
   grid numbers already posted in Discord will point somewhere else; that is
   accepted.

## Layers

All new layers go in the existing gear-button layers panel as grouped sections under
the current "yours" layers. They use the same `layerGroup` and localStorage toggle
mechanism, and are visible to every viewer (add them to `ALWAYS`). Group names follow
iZurvive's so players moving over find things where they expect.

**Default state (Claude's call):** every new layer starts **off** except Bunkers.
iZurvive with everything on is a wall of dots. Toggle state persists per viewer as
today.

| Group | Toggles | Source |
|---|---|---|
| **Bunkers** | Bunker entrances (23) | `cfgbunkerbroadcast.json` |
| **Vehicles** | Water truck (66), Truck (27), each car model (Hatchback02, Sedan02, OffroadHatchback, Offroad02), Motorbike (102) | `cfgeventspawns.xml`, active events in `db/events.xml` |
| **Crash sites** | Heli crash (53), Chinook crash (33), Military convoy (23), Police car (69) | same |
| **Loot buildings** | Military, Medical, Police, Fire station, Industrial, Town, Village, Farm, Hunting, Coast, School, Office, Prison (one toggle per `usage` flag present) | `mapgrouppos.xml` × `mapgroupproto.xml` group `<usage>` |
| **Loot tiers** | Tier 1 / 2 / 3 / 4 / Unique filter on the loot buildings, plus an optional tier overlay that shades the map | `areaflags.map` |
| **Wrecks** | Abandoned vehicle wrecks (static props) | `mapgrouppos.xml` names `Land_wreck_*` / `Land_Wreck_*` |
| **World** | Player spawns, contaminated areas (circles with radius), fig trees, animal territories, infected territories (if the mission ships them; see *Open items*), and wells / water sources where identifiable from `mapgrouppos.xml` | `cfgplayerspawnpoints.xml`, `cfgEffectArea.json`, `TrajectoryFig` / `Ambient*` in `cfgeventspawns.xml`, `env/*.xml` |

Rules:

- **Every event with spawn positions gets a toggle, whatever its `active` flag.**
  The bot changes `active` on the live server (the daily truck wipe and
  `WEEKLY_WIPE_VEHICLES`), so a build-time snapshot of either the repo or the live
  file would make layers come and go. A layer answers "where can this spawn",
  which doesn't change. An event with no positions (StaticBonfire, StaticTrain and so
  on) gets no toggle. That brings in VehicleCivilianSedan (47), ItemBricks (122,
  under World) and StaticContainerLocked (28, under Crash sites as "Locked
  container"). **Claude's call.**
- **Rotated vehicles say so.** A vehicle switched off right now by the truck wipe or
  the weekly rotation keeps its toggle, labelled "off this week" or "off until the
  next restart". The label is worked out in the browser from `truckWipeActive()` /
  `weeklyWipeVehicle()` in `packages/domain/src/restarts.ts`, the same functions
  the bot uses, so the map and the server can't disagree. **Claude's call.**
- **Military stands out:** it gets its own distinct marker colour. Everything else
  follows the existing chip style in `lib/map-icons.ts` (near-black chip with the
  colour inside, from `Map Markers.dc.html`). New glyphs extend that file.
- **Marker popup:** a click or tap shows the name (building or event, player-facing
  English), GPS and game coordinates, and, for loot buildings, its tier and loot
  usage.
- **Performance:** there are about 13.7k building positions. Draw icons only once
  zoomed in past a threshold, or cluster or canvas-render below it. Turning on every
  layer must stay smooth on a phone. How is the builder's call; the requirement is
  no jank on a mid-range phone with everything on.

## Search

One box, top-left of the map, on desktop and mobile. Results are grouped into
tabs or sections like iZurvive: **Locations**, **Items**, **Models**.

- **Locations:** place names (`lib/map-places.json`) plus bunkers ("Bunker 7").
- **Coordinates:** parsed before any name lookup, per Decision 3. Anything else that
  looks like two numbers but fits neither form shows a one-line hint ("Use GPS like
  072 087, or metres like 7216 5706"). A coordinate outside the map is rejected
  the same way.
- **Items:** match `types.xml` type names and the extracted display names ("M4-A1"
  and "M4A1" both work). Picking one:
  - filters the map to the places it can spawn (see *Where an item spawns*);
  - opens the item card;
  - shows its server economy facts: nominal / min, tier(s), usage, and whether it is
    event-only (heli crash, convoy, …).
  - **Every way the item reaches players is listed, not just loot.** Besides
    world loot and event loot, the card lists: comes attached to or inside another
    item (`cfgspawnabletypes.xml`), spawn gear (`cfggameplay.json` presets), and Clan
    Wars sources (supply kit, booster kit, awards catalogue, KotH loadouts, read from
    this repo's own catalogues). "Does not spawn on this server" appears only when
    every one of those is empty. Flags are the case that proves it: `nominal` 0, yet
    every clan gets theirs from the kit. **Claude's call.**
- **Models:** building and object class names and their friendly names from
  `mapgrouppos.xml`. Picking one highlights every instance.

## Where an item spawns

An item spawns where the Central Economy would put it on our server. Claude's
reading of the CE rules; the builder should verify it against Bohemia's CE docs and
spot-check in game:

1. An item `type` has a category, tags, usage flags and value (tier) flags in
   `types.xml`.
2. A building's loot points are in `mapgroupproto.xml`: group → container → points.
   Each container accepts certain categories and tags. A building has a usage either
   from its group `<usage>` or from the **area flags at its position**.
3. Tiers come from `areaflags.map` at the building's position. It is 84 MB with a
   24-byte header, the values 4096 and 4096 then 16384 and 16384, then
   4096×4096×5-byte cells. The exact layout is the builder's to confirm.
4. The item can spawn at a point if the container accepts its category/tag, the
   building's usage matches one of the item's usages, and the position's tier matches
   one of the item's values. An item with no value flags spawns in any tier. Event
   items (crash sites, convoys) come from `cfgeventgroups.xml` / event loot, shown
   as those event layers.

This is computed at build time, not in the browser.

## Item card data

Pulled from the DayZ game install on the user's Ubuntu PC (`rraygun@192.168.1.103`,
SSH pubkey). DayZ is installed under the snap Steam path,
`~/snap/steam/common/.local/share/Steam/steamapps/common/DayZ/Addons` (236 PBOs,
20 GB). DayZ Tools and DayZServer are installed too.

- Unpack the PBOs and derapify `config.bin` with open-source Linux tools. HEMTT is
  suggested and the choice is the builder's. Per item, take `displayName`,
  `descriptionShort`, `weight`, `itemSize`, `attachments` / `inventorySlot`,
  `magazines`, `chamberableFrom`, and resolve `$STR_` keys through the stringtables
  (English).
- Images: the item's inventory preview `.paa` converted to small WebP. The output is
  checked into the repo, or served beside the tiles if it is too large (builder's call
  on where; a few thousand small images).
- The extraction is **one script run over SSH on that PC**. Its output (JSON plus
  images) is copied back and committed. It is rerun by hand after DayZ updates. The
  script must be safe to rerun and must not change anything in the Steam install.
- Only items in our `types.xml` (2412 types) need cards.
- Bohemia allows using game data for community tools; this stays a non-commercial
  fan tool.

## Cursor readout and ruler

- **Readout:** a small bar like iZurvive's showing GPS (`072 / 087`) and game metres
  under the cursor. On touch it shows the map centre (there is already a centre
  cross for "Pin here"). Tapping it copies the value.
- **Ruler:** tap or click points to measure a path. It shows the total in metres or
  km and the bearing of the last leg. It is local only, not saved or shared, and is
  cleared with one button.

## Data pipeline

Like `scripts/refresh-map-places.mjs`: a build-time script reads the Nasdara mission
checkout (`dayz-one-life/nasdara`, local at `../nasdara`) and writes compact JSON into
`apps/web/lib` (or `public/` if too big to import; builder's call). Nothing reads
mission files at runtime, and the bot and ingest worker are untouched. When the
mission repo changes (new types, moved events), the script is rerun and the output
committed. The output records the mission repo commit it was built from.

The coordinate math goes through `lib/map-projection.ts` only. GPS ↔ metres
conversion is added there, next to `worldToLatLng`, with unit tests:
GPS x = floor(x/100), GPS y = floor((size − z)/100).

## Non-goals

- Line, shape and circle drawing; marker groups; anything shared beyond today's pins.
- "Nearest X" lists, distance rings, routing.
- Live state: which 3 bunkers are active, where vehicles actually are now, live loot.
- Other maps. Clan Wars is Nasdara-only.
- Satellite imagery, unless tiles already exist for Nasdara on the One Life mirror.
  If they do, a Topographic / Satellite switch is in scope (see *Open items*).
- Scraping or embedding anything from iZurvive.

## Anti-goals

- A map that looks right but is wrong: wrong GPS orientation, or loot shown where
  our server doesn't spawn it. Being right for **our** server is the whole point
  over iZurvive.
- A wall of dots by default, or a map that stutters on a phone.
- Copy that discourages raiding. Player-facing words follow
  `brand/02-verbal-identity.md`.

## Open items for the builder

- Confirm the `areaflags.map` layout and the tier and usage bit meanings. A sanity
  check is that the big military bases read as Tier 3/4.
- Check whether Nasdara satellite tiles exist on the mirror.
- Check whether the mission ships animal and infected territory files (`env/`).
  Show them if present, skip them silently if not.
- Spot-check GPS orientation in game once: stand at a bunker and compare the
  in-game GPS reading with the search result.
