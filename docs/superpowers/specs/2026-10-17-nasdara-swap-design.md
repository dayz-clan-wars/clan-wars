# Swap Clan Wars from Chernarus to Nasdara

**Date:** 2026-10-17
**Status:** draft
**Supersedes:** `2026-10-16-multi-server-nasdara-design.md` (two servers at once; dropped)

## Purpose

Clan Wars moves its one server, the 50-slot Clan Wars server (Nitrado 19831378,
`servers` row 1), from Chernarus to Nasdara, permanently. After one restart the
bot only knows Nasdara. This is a single-map swap, not multi-map: nothing needs to
tell maps apart, and no per-server map settings are added.

At the same time two features go away: the **airdrop** (which on Chernarus is
Bunker Online, the keycard-room event; the code still calls it airdrop) and
**fast travel** (the Hub, teleports and travel points). King of the Hill stays and
moves to Nasdara's towns.

## Decisions (made in brainstorming)

1. **One clean cut.** One restart; Chernarus goes away for good.
2. **It is a wipe of placements.** Clan bases (declarations), booster kit and award
   positions, pins and zone placements are cleared. Clans and their members carry
   over; every clan re-raises a flag on Nasdara.
3. **Airdrop / Bunker Online is removed.**
4. **Fast travel is removed.**
5. **King of the Hill stays**, on Nasdara's 66 towns.
6. **Everything else works exactly as on Chernarus**: clan flags only through the
   supply kit (by design, so only an established clan gets its flag), the supply
   kit at the pole, booster kits, awards, raid window, wipes, restarts, bans,
   bounties.
7. **Flag refresh is 14 days.** Nasdara's mission changes `FlagRefreshMaxDuration`
   from 7 days back to 14, matching the bot's `PUBLIC_BASE_DESPAWN_MS`.
8. **The season carries over.** The swap is not a season wipe: standings, Alphas
   and season achievements keep running across the map change. So the bot gives
   every clan a dormancy grace at the cutover (section H).
9. **The operator switches the mission in Nitrado by hand** at a restart, following
   a checklist this work produces. No bot script performs the cutover.

## Non-goals

- Running Chernarus and Nasdara side by side, or any per-server map setting.
- Fast travel, a hub or teleports on Nasdara.
- Replacing the bunker with a Nasdara equivalent.
- Changing how flags, supply kits, booster kits, awards or KOTH behave.

## Anti-goals (would be a failure even if it technically works)

- A clan that qualifies cannot get its supply kit (and so its flag) on Nasdara.
- Anything Chernarus-shaped shows up to players on Nasdara: Chernarus place names,
  outhouse travel points on the map, Hub wording, "Chernarus" in copy.
- KOTH picks a town Nasdara has no spawn group for, or fails to restore spawns.
- History breaks: old KOTH results, achievements or show episodes that reference
  Chernarus stop rendering.

## Context

- **Nasdara mission repo:** `dayz-one-life/nasdara`
  (`/Users/steveharmeyer/Development/dayz-clan-wars/nasdara`). Released as v1.0.0
  and deployed by `.github/workflows/deploy.yml` to the Clan Wars server's
  `/dayzxb_missions/dayzOffline.nasdara/` on every published release. The deploy
  stages `koth/default/{cfgplayerspawnpoints.xml,globals.xml}` exactly as the
  chernarus repo does.
- **Nasdara map:** 16384 m terrain, xam.nu key `nasdara`, place data version
  `1.30-6`. World coords from xam.nu: `x = lng * 64`, `z = 16384 + lat * 64`.
- **Nasdara's KOTH inputs already exist** in the mission repo:
  - 44 `custom/koth-*.json` kits with the same file names as Chernarus's
    (`packages/domain/assets/koth-presets.json` needs no change).
  - 66 fresh-spawn groups in `cfgplayerspawnpoints.xml`, one per town (capital,
    cities, villages), each a single `<pos>` at the town centre. Group name is the
    town name with only letters and digits kept (`Dar-e Ardis` → `DareArdis`).
    Source list: `scripts/spawn-points/towns.json` (`{name, category, x, z}`).
- **Nitrado mission dir** is re-read from `settings.config.mission` on every call
  (`packages/nitrado/src/client.ts`), so the bot follows the switch with no config.

## What changes

### A. Mission (nasdara repo), released before switch day

1. `db/globals.xml`: `FlagRefreshMaxDuration` 604800 → 1209600.
2. `cfggameplay.json` `WorldsData.objectSpawnersArr`: add
   `./custom/faction-supplies.json`, `./custom/booster-kits.json`,
   `./custom/awards.json` (today it is `[]`, so none of them would load and no
   clan could get a flag). The worker generates and uploads these files; the
   mission only has to list them. Check the chernarus repo's `cfggameplay.json`
   for the exact entries and order; do not copy its keycard, teleport or bunker
   entries.
3. Ship as a new release (v1.0.1 or as the operator picks), which deploys.

### B. Map identity (bot)

- `packages/domain/src/rules.ts`: `WORLD_SIZE_M` 15360 → 16384,
  `WORLD_MAP` `"chernarusplus"` → `"nasdara"`. These drive tiles, place names,
  pin bounds, grid refs and `/map` limits; check every consumer still reads them
  rather than a literal (`apps/bot/src/commands/map.ts`, `packages/roster/src/map.ts`,
  `apps/web/app/(site)/base/page.tsx`, `apps/web/lib/kit-view.ts`,
  `apps/web/app/(site)/map/map-view.tsx`).
- **Place names:** add `nasdara` to `apps/web/scripts/refresh-map-places.mjs`
  `MAPS`, with its own xam.nu version (`1.30-6`; the script currently uses one
  `VERSION` for every map), regenerate `apps/web/lib/map-places.json`. Dropping
  the `chernarusplus`/`enoch` keys is the builder's call.
- **Tiles:** mirror Nasdara topographic tiles to `/var/www/tiles/nasdara/topographic/`
  on the web host (One Life's `deploy/mirror-tiles.sh` and `deploy/dzmap.yaml` hold
  the URL and pyramid). The web map reads `/tiles/${WORLD_MAP}/…`.
- `packages/adm-parser/src/coords.ts` `MAP_MAX = 16384` already fits. No change.

### C. King of the Hill (bot)

- `packages/domain/assets/koth-locations.json`: replace the 31 Chernarus towns with
  Nasdara's 66 from the mission's `towns.json`: `name`, `slug`, `spawnGroup`
  (letters and digits of the name), `centreX`/`centreZ` (the town's x/z, which is
  also the group's single `<pos>`).
- Move the 31 Chernarus entries into `koth-locations-retired.json` so past
  `koth_events` keep their town names.
- Slugs: "OKB-754" contains digits and the slug test only allows letters
  (`packages/domain/test/koth.test.ts`). Builder picks: a letters-only slug for it,
  or loosen the rule. Slugs must stay unique across live and retired lists.
- `packages/domain/test/koth-drift.test.ts`: read `../nasdara` instead of
  `../chernarus`; count check 31 → 66.
- Comments that tie KOTH to the chernarus repo (`packages/domain/src/koth.ts`,
  `apps/bot/src/spawn-points.ts`): update.
- KOTH behaviour, radius (500 m), kits and the restore are unchanged.

### D. Remove the airdrop (Bunker Online)

How it works today: `AIRDROP_TICK` gates `apps/bot/src/airdrop-tick.ts`, which at
the 30-minute mark before a slot may insert an `airdrop_events` row and post
"BUNKER ONLINE". At the restart, `restart-tick.ts`'s `applyGameplay` reads the
rows, `bunker-stage.ts` reads `custom/keycard-*.json` and uploads
`custom/bunker-online.json`, and `cfggameplay.ts` `setAirdropSpawner` adds it to
`objectSpawnersArr`. `/bunker place` does it by hand.

Remove: the tick and its wiring in `discord.ts`, `/bunker` and its registration,
`airdrop-text.ts`, `bunker-stage.ts`, the airdrop branch of `applyGameplay` and
`setAirdropSpawner`, the bunker line in `restartMessage`, `AIRDROP_*` config and
rules, `packages/domain/src/airdrops.ts`, `bunker.ts`, `assets/bunker-rooms.json`,
`Ctx.serverEvents` if nothing else uses it, and their tests (including the
`bunker-drift` test that reads the chernarus repo).

Keep, or move first:
- **KOTH auto-decide borrows from `airdrops.ts`**: `decisionInstantFor`,
  `highWater`, `isoWeekStart`, `AIRDROP_DECIDE_LEAD_MS`
  (`apps/bot/src/koth-decide-tick.ts`). Move them into KOTH or a shared module
  (rename the lead constant) before deleting the file.
- **KOTH's slot-taken checks read `airdrop_events`** (`koth-vote-store.ts`,
  `commands/koth.ts`, `commands/kothvote.ts`, `koth-vote-tick.ts`). Remove the
  airdrop branch; KOTH only clashes with KOTH now.
- **`applyGameplay`** is shared with the raid window and the KOTH preset swap; keep
  `setBaseDamageDisabled`, `setSpawnGearPresets`, `readSpawnGearPresets` and the
  `uploaded` bookkeeping.
- **`population.ts`** is shared with KOTH. Keep.
- **`airdrop_events` table and its rows: keep** (no migration). The weekly show
  reads them for past episodes (`apps/show/src/story/events.ts`, `context.ts`);
  `bunkerRoomName` must keep resolving old room slugs, so keep whatever lookup that
  needs (or inline the names) even after `bunker-rooms.json` goes. Whether the show
  keeps reading new (nonexistent) airdrops is the builder's call; it must not break.
- Docs: update CLAUDE.md's airdrop/bunker sections; leave old specs and deploy
  notes as history.

### E. Remove fast travel

- `packages/domain/src/fast-travel-points.json`, `travel.ts`, the Hub
  (`HUB_POSITION`, Hub zone, `TRAVEL_POINTS`, `HUB_DESTINATIONS` in `rules.ts`,
  `hub.ts`), the `travel` layer on the web map (`packages/roster/src/map.ts`,
  `map-view.tsx`), `hub-tick.ts` and `HUB_BAN_TICK`, the "no base within 200 m of
  the Hub" spacing rule (`spacing.ts`).
- Ingest worker: remove the travel projection (`apps/ingest-worker/src/main.ts`,
  `assets/travel/*`, `travelTemplateFor`), which otherwise errors every sweep on
  `dayzOffline.nasdara`. `travel_uploads` rows can stay.
- ⚠️ **Hub kills:** `apps/bot/src/kills-tick.ts` excludes kills at the Hub from
  scoring. Live Nasdara kills will never be at Chernarus's Hub spot, but a
  `rebuild:kills` over history would start scoring old Chernarus Hub kills if the
  check is deleted outright. Keep the exclusion for kills before the cutover (by
  date), or keep `atHub` as a historical rule. Builder's call which.
- **"Wanderer" achievement** (fast travel 10 times): retire it so it can no longer
  be earned but holders keep it and it still renders. Follow however the
  achievements code already retires one, if it does; otherwise builder's call.
- Copy: guide chapter `11-getting-around.html` (whole chapter is fast travel),
  `04-bases.html` (pole as travel point), `12-fair-play.html` and
  `13-rules-on-one-page.html` (Hub), `packages/domain/src/guide-numbers.ts`
  (travel and Hub numbers), `apps/web/lib/map-copy.ts` ("Travel points"), Hub
  wording in `apps/web/lib/feed-copy.ts`, `packages/copy/src/live-feed.ts`,
  `apps/bot/src/bounty-text.ts`.

### F. Player-facing copy that names Chernarus

Replace with Nasdara (plain voice, punctuation per `brand/02-verbal-identity.md`):
`apps/bot/src/achievement-embed.ts` footer, `apps/web/app/api/og/achievement/[key]/route.tsx`,
`apps/web/app/(site)/page.tsx` header, `apps/web/app/guide/layout.tsx`,
`apps/web/lib/map-copy.ts` `MAP_REGION_LABEL`, `apps/web/lib/guide.ts`, guide
`01-what-this-is.html` and `10-the-map.html`, and the weekly show's prompt and
fact-check (`apps/show/src/prompt/system.ts`, `apps/show/src/script/fact-check.ts`),
which hard-code "the map is Chernarus".

### H. Dormancy grace at the cutover

Clearing every base removes each clan's raise history from the dormancy clock
(`clockQuery`, `apps/bot/src/dormancy-store.ts`): its last raise is keyed on
`declarations.pole_key`, so with no declaration it falls back to
`max(activated_at, created_at, open season's started_at)`. With a season older
than 7 days, every established clan would go dormant on the first tick after the
switch (DM, feed post, supply kit lost, 14-day disband countdown), exactly while
everyone is re-raising.

Fix: the clock also takes the GREATEST against the cutover instant, the same way
it already does against the open season's `started_at`. Every holding clan then
gets a full `DORMANCY` window (7 days) from the cutover to raise its flag on
Nasdara, and a clan that raises resets its clock as normal.

- The cutover instant is only known on switch day, so it is set by the checklist,
  not hard-coded at build time. Where it lives (a nullable column on `servers`, or
  a small one-row table, set by a `pnpm` script with the usual `factions_live`
  guard) is the builder's call; it must be per-server like `seasons`, and absent
  means no grace.
- Check the other clocks that key on a declaration or pole for the same cliff:
  the reservation lapse (`lapseReservations`, 24 h to activate), the disband clock
  for a clan already dormant at the cutover, and anything reading `poles` or
  `grace_until`. A clan already dormant before the cutover stays dormant (no
  amnesty), but its disband countdown must not jump because its base vanished.
- Test it the way `clockQuery`'s season clamp is tested.

### G. Tests and fixtures

Update tests that assume Chernarus towns, slugs, `WORLD_SIZE_M`, travel points or
the Hub (KOTH command/converge/vote, spawn-points, web map-places and kit-view,
domain koth/travel, roster map, show story events, ingest-worker travel). Fixtures
that insert `servers.map: "livonia"`/`"chernarus"` as free text are harmless.

## Switch-day checklist

Written as `docs/deploy/2026-10-xx-nasdara-swap.md`, in the style of
`docs/deploy/2026-10-12-carry-bases.md`, with exact commands and SQL. Order:

**Before switch day**
1. Release the nasdara mission with section A; confirm the deploy uploaded it
   (including `koth/default/`).
2. Mirror Nasdara tiles to the web host.
3. Ship the Nasdara-ready bot (B–H). `AIRDROP_TICK` and `HUB_BAN_TICK` are gone or
   off.

**At the switch restart**
4. Cancel open `koth_events` (scheduled/announced) and open `koth_votes`; close any
   `announced`/`live` `airdrop_events` rows.
5. Clear placements:
   - `pnpm clear-bases --server 1 --before <cutover> --dry-run`, review, then for
     real (releases every declaration; rosters untouched).
   - Null booster kit and award positions so owners re-place them on Nasdara.
     Award clocks are not reset by a move (by design); confirm unplacing a live
     award behaves (`awardState()`).
   - Clear `clan_pins` and active `zone_placements` (or let them expire; builder
     confirms which actually matter on the new map).
6. `UPDATE servers SET map = 'nasdara' WHERE id = 1`, and set the dormancy
   cutover instant (section H) to the switch time.
7. **Operator:** switch the mission to `dayzOffline.nasdara` in Nitrado and restart.

**After**
8. Clock: `servers.clock_offset_ms` stays at 25200000. The offset belongs to the
   Nitrado box, not the map (the One Life box logged the same offset running
   Chernarus before 2026-10-15 and Nasdara after; this server kept 25200000 from
   Livonia to Chernarus), so no reset is planned. Confirm the worker does not log
   an offset change and new events' `occurred_at` track wall-clock time.
9. RPT: mission folder is `dayzOffline.nasdara`, no new load complaints beyond
   Bohemia's known ones, the three object spawner files load.
10. Bot: restart tick ran clean; KOTH restore found `koth/default/`; worker uploaded
   `faction-supplies.json`, `booster-kits.json`, `awards.json` with no errors.
11. Site: map shows Nasdara tiles and place names, no travel layer; KOTH town list
    shows Nasdara towns.
12. Clans: none went dormant at the first ticks after the cutover.
13. Announce to players (separate, not part of this work's code).

## Left to the builder

- Slug for "OKB-754" (or loosening the slug rule).
- Whether to drop the `chernarusplus`/`enoch` place-name keys.
- How to keep Hub kills out of a history rebuild.
- How to retire "Wanderer".
- Whether the show still queries `airdrop_events` for new weeks.
- Exact wording of replaced copy and the rewritten guide chapters.
- Whether pins and zone placements need clearing or can expire.
- Where the dormancy cutover instant is stored and how it is set (section H).

## Open questions

None.
