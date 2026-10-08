# Bunker online (2026-10-07)

Replaces what an airdrop *is* on Chernarus. Amends `2026-09-20-airdrop-events-design.md`,
which keeps governing everything this spec does not change (decision timing, the
high-water rule, the weekly cap, the 24 h gap, KotH winning the slot, the state machine,
enable attempts and scrubbing). Where they differ, this spec wins.

## 1. Why

The 50-slot server moved from Livonia to Chernarus on 2026-10-07. Airdrops were 16
Livonia locations × 3 container colours, each a spawner file staged by the `livonia`
repo. None of those exist on Chernarus.

The operator wants a different event on Chernarus. There are 11 keycard rooms around
the map (`chernarus/custom/keycard-rooms.json`), each a `Land_Underground_Stairs_Exit`
with no door panel and no loot. When the event fires, one room comes online for one
session with the contents of one of two templates:

- `custom/keycard-bunker-boom.json`: 12 plastic explosives, 6 IEDs, 6 remote detonators;
- `custom/keycard-bunker-guns.json`: rifles, magazines, optics, suppressors, 40 mm rounds.

Each template also carries the door panel and lever, three concrete wall panels and
the crates. Players open the door with a punched card, which they get from the locked
containers on train wrecks (chernarus v1.28.0). This spec does not change that supply.

The event is called **"bunker online"**. "Airdrop" no longer describes it.

## 2. Decisions

- One room per event, online for **one session**: enabled at one restart, unregistered
  at the next. Loot nobody took goes with it.
- **Kind:** `boom` or `guns`. The automatic event picks 50/50. `/bunker place` takes an
  optional `kind:`, and leaving it off picks at random. The kind is never announced.
- **Rules unchanged:** decided `AIRDROP_DECIDE_LEAD_MS` (30 min) before a restart slot;
  fires when the population is at least `max(AIRDROP_MIN_POP, five-day high-water)`; at
  most `AIRDROP_WEEKLY_CAP` a week; `AIRDROP_MIN_GAP_MS` (24 h) between events; KotH wins
  a contested slot; manual placement skips the weekly cap only. Production settings stay
  `AIRDROP_TICK=1`, `AIRDROP_WEEKLY_CAP=3`, `AIRDROP_MIN_POP=6`.
- **Internal names stay "airdrop"** (`airdrop_events`, `AIRDROP_*` env vars, the tick
  and its files), with a comment at each entry point saying the feature is
  player-facing "bunker online" since 2026-10-07. Production's `.env` does not change.
  Every player-facing string says bunker.

## 3. Rooms

- `packages/domain/assets/bunker-rooms.json`: the 11 rooms as
  `{ name, slug, x, y, z, yaw }`, from `chernarus/custom/keycard-rooms.json` after
  these renames (operator, 2026-10-07):

  | Before | After |
  |---|---|
  | Troitskoye Military Base | Kamensk Military |
  | Pavlovo Military Base | Pavlovo Military |
  | Tisy Military Base | Tisy Military |
  | Zelenogorsk Military Base | Zelenogorsk |

  The rest are unchanged: Balota Airfield, VMC, Krasnostav Airfield, NWAF, Green
  Mountain, Bashnya, Prison Island. `slug` is the name lowercased with spaces
  hyphenated (`kamensk-military`, `nwaf`).
- `AIRDROP_LOCATIONS` (the 16 Livonia slugs) moves to a retired list used for display
  names only, so past drops keep printing a place. Nothing can schedule or place one.
- The draw is unchanged: uniform over the 11, less the last `AIRDROP_NO_REPEAT` (5)
  rooms used, falling back to all 11 if that empties the pool.

## 4. Placement

`placeBunker(template, room)` is a pure function in `@factions/domain`:

- **Anchor:** the template's single `Land_Underground_Stairs_Exit`. Zero, or more than
  one, throws.
- **Every other object:** its offset from the anchor (x, y, z) is rotated in the
  horizontal plane by `room.yaw − anchor.yaw`, then added to the room's position. Its
  own yaw turns by the same angle; pitch and roll are kept. `name`, `scale`,
  `enableCEPersistency` and `customString` are copied unchanged.
- **The anchor itself is left out:** `keycard-rooms.json` already spawns the room's
  stairs exit.
- **Rotation convention:** DayZ yaw is degrees clockwise from north (+z). An offset
  `(dx, dz)` turned by `θ` becomes `(dx·cos θ + dz·sin θ, −dx·sin θ + dz·cos θ)`. This is
  the one fact no repo file proves, so §8 verifies it in game before the automatic
  event runs.

## 5. A session on the server

1. **Decision:** unchanged, except the row gets `location` = room slug and `kind`, and
   the announcement says bunker (§7).
2. **Opening restart,** inside `applyGameplay`'s single round trip of `cfggameplay.json`:
   1. Download `custom/keycard-rooms.json` and `custom/keycard-bunker-<kind>.json`. A
      missing or empty file, unparseable JSON, a room whose name is not in the rooms
      file, or a template `placeBunker` refuses all fail this enable attempt, through
      the existing attempt counter and scrub path (`AIRDROP_MAX_ENABLE_ATTEMPTS`).
      Nothing is uploaded or registered on a failure.
   2. Upload `placeBunker(...)` as `custom/bunker-online.json`. **Before** registering
      it, so the spawner never points at a missing or stale file.
   3. Register `./custom/bunker-online.json` in `objectSpawnersArr`.
3. **Next restart:** the entry is removed. The file stays on the server unregistered, so
   nothing spawns from it, and the next opening overwrites it.
4. **The splice** treats an entry containing `/airdrop-` or ending
   `/bunker-online.json` as the feature's, so a leftover Livonia-style entry is removed
   rather than tripping the "registered twice" refusal.

## 6. Data

One migration on `airdrop_events`:

- `colour` becomes nullable; its CHECK still allows only `blue`/`orange`/`yellow`.
- New `kind text` with CHECK `kind IN ('boom','guns')`.
- New CHECK `airdrop_events_colour_xor_kind`: exactly one of `colour` and `kind` is set.

Past rows keep their colour and have no kind; new rows have a kind and no colour.

## 7. What players see

- **Announcement** (decision time):
  `**BUNKER ONLINE: NWAF**` / `Opens at the restart, <countdown>. Bring a punched card.`
- **Scrubbed:** `**BUNKER OFFLINE: NWAF**` / `It did not come online. The next one can come any day.`
- **Restart message:** `Bunker online at NWAF next session.`
- **Command:** `/airdrop place` is replaced by `/bunker place room:` (autocomplete over
  the 11 rooms) `kind:` (optional: Explosives or Guns), admin-only like the command it
  replaces, with the same rules.
- **Weekly show:** the story context and the system prompt say bunkers, and get room
  names (never slugs). Past airdrops print their Livonia names.
- **Guide:** no airdrop chapter exists, and none is added.

## 8. Rollout and verification

1. `chernarus` release: the four renames in `custom/keycard-rooms.json`.
2. `clan-wars` release.
3. **Live check on production.** The bot manages only the production 50-slot server.
   An admin places the first bunker with `/bunker place` at a quiet slot, at a room whose
   yaw differs from the template's anchor (every room's does: the anchor is 0°, and no
   room faces 0°). Right after that restart the admin walks in and confirms the panel,
   the lever, the crates and the loot sit in the room. A misplacement is gone at the
   next restart.
4. Until step 3 passes, the automatic event must not place a bunker. The deploy runbook
   sets `AIRDROP_TICK` off at step 2 and back on after step 3.
5. Until step 2 ships, `AIRDROP_TICK` stays on (operator decision, 2026-10-07). A drop
   decided before then names a Livonia location and spawns nothing.

## 9. Tests

- `placeBunker`: a room at the anchor's yaw reproduces the template's offsets; a room
  turned 90° puts a known offset where the convention says; yaw turns, pitch and roll
  stay; the anchor is left out; zero or two anchors throw.
- Rooms: 11, unique slugs; drift test against the sibling `chernarus` checkout
  (skipped where absent, as for KotH): names, positions and yaws match
  `custom/keycard-rooms.json`; retired Livonia slugs keep their names and are never
  drawn.
- Opening: uploads `custom/bunker-online.json` before registering it; each failure in
  §5.2.1 uploads and registers nothing and counts an enable attempt.
- Splice: a leftover `/airdrop-` entry is removed; the next restart unregisters the
  bunker.
- Migration: inserting both colour and kind, or neither, is refused.
- Texts: the announcement names the room and never the kind; the scrub and restart
  messages.
