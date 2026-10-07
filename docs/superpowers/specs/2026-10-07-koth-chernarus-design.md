# King of the Hill on Chernarus (2026-10-07)

Amends `2026-09-23-king-of-the-hill-design.md` and keeps
`2026-09-24-koth-auto-and-vote-design.md` as it is. Where they differ, this spec wins.

## 1. Why

The 50-slot server moved from Livonia to Chernarus on 2026-10-07, and season 2 starts
with a wipe on 2026-10-15. KotH is built on Livonia: 31 Livonia towns, four whole files
per town staged by the `livonia` repo (`koth/locations/<town>/`), and wolves, bears and
infected converging on the hill. The operator wants it simpler on Chernarus:

- **No predators or infected.** The bot stops touching `env/wolf_territories.xml`,
  `env/bear_territories.xml`, `env/zombie_territories.xml` and the infected events in
  `db/events.xml`.
- **Hill spawns come from the existing spawn groups.** Chernarus `cfgplayerspawnpoints.xml`
  already has 31 named `<fresh>` groups, one per fast-travel town, each holding exactly that
  town's 10 teleport arrival spots (310 in all, checked against
  `custom/pra-teleport-<town>.json`). A session keeps only the chosen town's group.
- **Same loadouts as Livonia:** the `custom/koth-*.json` presets, copied unchanged.
- **Faster cleanup, and one new value:** `CleanupLifetimeDeadPlayer` 30 and
  `CleanupLifetimeDeadInfected` 10 as before, plus **`CleanupAvoidance` 5** (normally 100).

Unchanged: any of the 31 towns can host; all three start methods (`/koth schedule`, the
automatic picker, `/kothvote`) and their rules (24 h gap, `KOTH_NO_REPEAT`, vote
thresholds); scoring (victim within `KOTH_ZONE_RADIUS_M` = 500 m of the centre, teamkills
count via `scoringKillAnyTeam`); prizes; the restore arm running whether or not
`KOTH_TICK` is set.

## 2. Towns and data

- `packages/domain/assets/koth-locations.json` becomes the 31 Chernarus towns, generated
  from the Chernarus `cfgplayerspawnpoints.xml`. Each entry is
  `{ name, slug, spawnGroup, centreX, centreZ }`:
  - `name`: display name, e.g. `Novaya Petrovka`;
  - `slug`: lowercase, hyphenated, e.g. `novaya-petrovka` (stored in `koth_events.location`);
  - `spawnGroup`: the `<group name>` in `<fresh>`, e.g. `NovayaPetrovka`;
  - `centreX`/`centreZ`: the mean of the group's 10 spawn positions, rounded to the metre.
- The Livonia list moves to `packages/domain/assets/koth-locations-retired.json`.
  `kothLocation(slug)` looks up both, so the six past sessions (all Livonia slugs) keep
  their names in `/koth status`, posts and the site. `KOTH_LOCATIONS`, the list that
  `/koth schedule` autocomplete, `chooseKothTown` and `/kothvote` offer, is Chernarus only.
  No Chernarus slug matches a Livonia slug, and a test enforces that.

## 3. A session on the server

### 3.1 Opening

Nothing is written until every check passes. Any failure marks the row `failed`, records
the reason in `detail` and leaves the server alone, the same as today (§5.1 of the original).

1. **Checks:**
   - every `KOTH_PRESET_FILES` entry exists in `custom/`;
   - `koth/default/cfgplayerspawnpoints.xml` is readable and not empty, and its `<fresh>`
     has a `<group name>` equal to the location's `spawnGroup` with at least one `<pos>`;
   - `koth/default/globals.xml` is readable and has every `KOTH_GLOBALS` var.
2. **Spawns:** the bot builds the session spawn file from
   `koth/default/cfgplayerspawnpoints.xml` by removing every `<group>` inside
   `<fresh><generator_posbubbles>` except the chosen one. Every other byte stays the same,
   including the `<fresh>` parameters and any other section. The result is uploaded as the
   mission root's `cfgplayerspawnpoints.xml` (the existing `differing` and
   `convergeKothFiles` path).
3. **Loadouts:** unchanged. The `koth-*` presets go in through `applyGameplay`, with the
   live list snapshotted first.
4. **Cleanup:** `db/globals.xml` is spliced with
   `KOTH_GLOBALS = { CleanupLifetimeDeadPlayer: 30, CleanupLifetimeDeadInfected: 10, CleanupAvoidance: 5 }`.

### 3.2 Every other slot (restore)

Unchanged in shape, smaller in scope: the spawn file converges to
`koth/default/cfgplayerspawnpoints.xml`, the preset list to the snapshot, and the three
globals to `koth/default/globals.xml`'s values. Anything unreadable is skipped and
reported (`restoreError`), never blanked.

### 3.3 Removed

- The three `env/` territory files leave `KOTH_WHOLE_FILES`, which becomes the spawn
  file alone, now built by narrowing (3.1 step 2) rather than copied from
  `koth/locations/<town>/`.
- `KOTH_INFECTED_EVENTS`, the infected snapshot and restore, and `infected` /
  `infectedRestoreRowId` in `KothPlan` are deleted. `koth_events.infected_snapshot` stays
  in the schema, unused; no migration. Checked on `factions_live` on 2026-10-07: no row
  has an infected snapshot waiting for a restore.
- The `KOTH_INFECTED_EVENTS` comment's pointer to the Livonia generator's
  `ZOMBIE_ZONE_NAMES` (and a `koth-drift.test.ts` that does not exist) goes with it.
  Drift is covered by 5 instead.

## 4. The `chernarus` mission repo

- `.github/workflows/` deploy: before the FTP step, copy `cfgplayerspawnpoints.xml` and
  `db/globals.xml` into `koth/default/`, the same pattern as Livonia's staging step. The
  defaults are always the release's own files, never a committed copy.
- Copy `custom/koth-*.json` from `livonia` unchanged.
- No `koth/locations/` directory.

## 5. Tests

- **Narrowing** (pure function, bot): it keeps exactly the chosen group; everything
  outside the removed groups is byte-identical; an unknown group throws; a file with no
  `<fresh>` throws.
- **planKoth:** the opening uploads the narrowed spawn file and the three globals; a
  missing group, a missing default or a missing preset refuses the opening with nothing
  uploaded; the restore converges the spawn file and the three globals; `events.xml`
  and `env/` are never downloaded or uploaded (the fake throws on those paths).
- **Locations** (domain): 31 Chernarus towns; slugs unique and disjoint from the retired
  Livonia slugs; centres inside `WORLD_SIZE_M`; `kothLocation("adamow")` still returns
  Adamów; `KOTH_LOCATIONS` never contains a retired slug.
- **Spawn-group drift:** a fixture copy of Chernarus `cfgplayerspawnpoints.xml` in the
  domain tests. Every location's `spawnGroup` is a `<fresh>` group there, and each
  centre is the mean of that group's spawn positions. The live server is covered by the
  opening check (3.1).

## 6. Player copy

No wording changes. The guide has no KotH chapter, and the bot's posts (`koth-text.ts`)
never mention predators or infected: "Fresh spawns start on the hill with a KotH kit"
stays true. Town names come from the location data.

## 7. Rollout

1. `chernarus` release: the staging step and the `koth-*.json` presets.
2. `clan-wars` release: this spec's bot and domain changes.
3. If 2 ships before 1, every opening is refused cleanly ("koth/default/… could not be
   read"), and the restore arm reports the missing defaults without writing anything.

`KOTH_TICK`, `KOTH_AUTO_TICK` and `KOTH_VOTE` stay on throughout (operator decision,
2026-10-07). Until step 2 ships, an automatic or voted session can still pick a Livonia
town. Its opening is then refused as in step 3, and a cancellation posts.
