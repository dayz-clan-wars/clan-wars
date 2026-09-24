# King of the Hill — design

**Date:** 2026-09-23
**Status:** designed, not implemented
**Covers:** an admin schedules a one-session King of the Hill event at one of the
Livonia KotH towns; for that session every fresh spawn lands at the hill in a
pre-built KotH loadout, infected spawn only at the hill, and wolf and bear
territories move there; kills whose victim was within 500 m of the hill are scored,
and the top linked player is granted the Plate Carrier award
**Builds on:** scheduled restarts (`apps/bot/src/restart-tick.ts`,
`docs/deploy/2026-09-12-scheduled-restarts.md`), the single-round-trip
`cfggameplay.json` edit (`applyGameplay`), the truck wipe's `events.xml` splice
(`apps/bot/src/events-xml.ts`), airdrops (`docs/superpowers/specs/2026-09-20-airdrop-events-design.md`
— the admin placement, the announce-before-enable rule, `live` only after the
restart POST), event awards (`docs/superpowers/specs/2026-09-22-awards-design.md`),
kills and `scoringKill` (`packages/roster/src/stats.ts`), and the KotH town set
already committed to the `livonia` repo under `koth/` (commit 3f3495b), which came
from the deathmatch servers' generator (`the-bloodbag-and-painkiller-show/generator`)

---

## 1. Purpose

A recurring set-piece event. For one two-hour session, the clan-wars server becomes
a King of the Hill arena at a named town. Everyone who spawns fresh lands on the
hill with a fighting kit. The infected and the predators converge there too. Whoever
racks up the most kills on the hill wins a week of the Plate Carrier award.

### In scope

- `/koth schedule`, `/koth cancel` and `/koth status`, admin-only Discord commands
- A `koth_events` table and the restart-tick convergence that opens and closes the
  session
- The mission-side changes in the `livonia` repo: flat `custom/koth-*.json` presets,
  a generator that emits a hill-only `zombie_territories.xml` and rejects spawn
  points in water, and the `koth/default/` copy made at deploy time
- Scoring, the Plate Carrier grant, and scheduled, reminder, live and results posts
  in the server events channel

### Out of scope

- A calendar or automatic scheduling (admin-scheduled only; a calendar can follow)
- A map layer, a live board on the site, or a KotH leaderboard
- Moving characters that are already alive. DayZ applies spawn points and loadouts
  to new characters only; a living player logs in where they are and may travel
  to the hill
- Swapping `cfgeventspawns.xml` (§2.6)

---

## 2. Decisions

### 2.1 One session, admin-scheduled, never late

An admin picks a town and a restart slot. The event exists for exactly the session
that the slot's restart opens and ends at the next slot's restart.

If the bot misses the opening slot (it was down, or the slot's grace passed), the
event is marked `failed` and a cancellation is posted. It is **not** run at the next
slot. This is the opposite of the raid window, which opens late rather than not at
all: a two-hour event that starts at an unannounced time is not the event players
were told about.

### 2.2 Level-triggered, like every other restart-slot edit

Every slot computes what the mission should look like for the session it opens,
either KotH at town *T* or the default, and converges the files to it. An edge-triggered
open/close would leave the whole server in KotH mode forever if the closing restart
were missed. Level-triggering also repairs a lost write, a bot that was down across
the close, and a `livonia` FTP deploy that overwrites a file mid-event.

### 2.3 What changes for the session

| What | File | How |
|---|---|---|
| Loadouts | `cfggameplay.json` → `PlayerData.spawnGearPresetFiles` | Splice: replaced by every `./custom/koth-*.json` (44 presets, equal weight) |
| Player spawns | `cfgplayerspawnpoints.xml` (mission root) | Whole-file copy from `koth/locations/<slug>/` |
| Wolves | `env/wolf_territories.xml` | Whole-file copy |
| Bears | `env/bear_territories.xml` | Whole-file copy |
| Infected territory | `env/zombie_territories.xml` | Whole-file copy (new generator output, §2.7) |
| Infected on | `db/events.xml` → each `Infected*` event's `<active>` | Splice: set to `1` |

⚠️ **Loadout presets must live flat in `./custom/`.** The game will not load a
`spawnGearPresetFiles` entry from outside that folder, or from a subfolder such as
`./custom/koth/`. The 44 files move from `livonia/koth/custom/<name>.json` to
`livonia/custom/koth-<name>.json`. They stay there permanently and do nothing unless
`cfggameplay.json` names them. The `koth-` prefix is what the restore arm recognises
(§5.3), so no other preset may ever use it.

### 2.4 Defaults come from the repo, copied at deploy time

The restore needs a pristine copy of each of the four whole-file targets. The
`livonia` deploy workflow copies `cfgplayerspawnpoints.xml` and
`env/{wolf,bear,zombie}_territories.xml` into `koth/default/` immediately before the
FTP step. That directory is **never committed** (it is `.gitignore`d).

Committing a mirror would need a drift check, and an edit made to the real file but
not the mirror would be reverted by the next restore. Generating it at deploy time
means a normal edit to the real file just works. A deploy that lands mid-event puts
the default back on disk, but the bot converges again before the next boot, so the
session is unaffected.

⚠️ **This makes the bot the owner of those four files on the server.** Every slot
compares each against `koth/default/` and uploads the default if they differ, so a
hand-edit made directly on the server (not through the repo) is reverted within one
slot. Both `CLAUDE.md` files say so.

### 2.5 Splices snapshot what they replace

The two splices do not restore a hard-coded value. The value they replace is written
to the event row before the first edit (§5.2):

- `spawnGearPresetFiles` → `koth_events.loadout_snapshot`
- each `Infected*` event's `<active>` → `koth_events.infected_snapshot`

A snapshot is taken only if it contains no KotH state (no `koth-` entry in the list;
for infected, only on the first open attempt). That way a retried open can never
record the KotH state as the default.

The restore touches the loadout list only while it contains a `koth-` entry, and
touches `events.xml` only until the event's `restored_at` is stamped. After that the
bot never edits either for KotH again, so a later change to the default loadout list,
or turning `InfectedCity` on for normal play, just works.

### 2.6 `cfgeventspawns.xml` is not swapped

The committed `koth/locations/<slug>/cfgeventspawns.xml` files were generated from
the deathmatch mission. Compared with this server's file they lack every vehicle
spawn (`VehicleCivilianSedan`, `VehicleTruck01`, the admin vehicles and more), trains,
the contaminated area and the animal herds. Swapping one in would strip all of that
for the session, to gain only heli crashes near the town. The generator stops
emitting the file, and the committed copies are deleted.

### 2.7 The generator: hill-only infected, dry spawn points

The vendored generator (`livonia/koth/locations/generator/`, a copy, not a submodule)
gains two things:

1. **`zombie_territories.xml` per town.** One `Herd` territory made of zones inside
   the hill's 500 m zone, in the same format as the live `env/zombie_territories.xml`.
   The whole map's infected territory is replaced by it for the session, so infected
   spawn only at the hill.
2. **Water rejection for spawn points.** Candidates are tested against a Livonia
   land/water mask. The generator keeps sampling until it has the town's
   `spawn_points` dry points, and fails loudly if it cannot.

The mask is built from the terrain tiles the site already mirrors (DZMap's zoom-6
pyramid): a pixel is water if its colour falls inside a calibrated water band.
Before the mask is trusted, a one-off review page plots every town's current spawn
ring on those tiles with the flagged points in red. An admin confirms the flags, and
the band is adjusted until the flags match what the admin sees. The mask then goes
into the generator, and every town is regenerated.

### 2.8 What scores

A kill counts if **all** of these hold:

- it is in the `kills` table
- `scoringKill` holds for it (player-on-player, not friendly fire, not at the Hub),
  imported and never re-spelled
- `kills.occurred_at` is inside the window (§2.9)
- the **victim's** position (`victimPos` on the source event's payload) is within
  `KOTH_ZONE_RADIUS_M` (500 m, 2-D) of the town's centre

Only the victim's position matters. A shooter outside the zone who drops people on
the hill still scores.

A kill with no `victimPos` does not count, because nothing shows it happened on the
hill. The results post reports how many kills were dropped for that reason.

### 2.9 The window

It runs from the opening restart to the closing restart, taken from the `issued_at`
of the two `server_restarts` rows. If the closing row does not exist, it falls back to
`slot_at + RESTART_PERIOD_MS`.

### 2.10 The winner

Players are ranked by counting kills. On a tie, the player who reached that count
first ranks higher.

The prize goes to the **highest-ranked linked player** (one with an `identity_links`
row). If the top killer is unlinked, the prize passes down the list, and the results
post still names the real top killer and says the prize passed down. If nobody has
a counting kill, or nobody on the list is linked, the result is `no_winner` and
nothing is granted.

### 2.11 KotH kills count everywhere

KotH kills are ordinary PvP. They feed the boards, streaks, achievements and crowns
like any other kill. There is no `at_koth` flag and no change to `scoringKill`. This
was chosen deliberately: the event is part of the season.

### 2.12 Clashes

- One KotH event `scheduled` or `live` at a time.
- A KotH session and an airdrop never share a slot. `/koth schedule` refuses a slot
  with an `announced` or `live` airdrop, and `/airdrop place` (and the automatic
  airdrop trigger) refuses the slot of a `scheduled` KotH event.
- A raid window may overlap. The two do not interact.

---

## 3. Data

`koth_events` (new migration):

| Column | Type | Notes |
|---|---|---|
| `id` | bigserial PK | |
| `server_id` | int → `servers` | |
| `slot_at` | timestamptz | The restart slot that opens the session |
| `location` | text | Town slug from `koth-locations.json` |
| `centre_x`, `centre_z` | numeric | Frozen from the catalogue at schedule time |
| `state` | text | `scheduled`, `live`, `awarded`, `no_winner`, `cancelled` or `failed` (CHECK) |
| `scheduled_by_discord_id` | text | Also the `granted_by` on the award |
| `announced_at` | timestamptz | ⚠️ A session is never opened without it (§5.1) |
| `reminded_at`, `live_posted_at`, `results_posted_at`, `cancel_posted_at` | timestamptz | Each stamped only after its post succeeds |
| `loadout_snapshot` | jsonb | The replaced `spawnGearPresetFiles` array |
| `infected_snapshot` | jsonb | `{ eventName: active }` |
| `opened_at` | timestamptz | The restart POST that made it `live` |
| `restored_at` | timestamptz | The slot at which both splices were confirmed back |
| `results` | jsonb | Frozen top 5 plus the dropped-kill count; gamertags frozen here |
| `winner_dayz_id` | text | |
| `award_grant_id` | bigint → `award_grants` | `ON DELETE set null` |
| `detail` | jsonb | Failure reasons, attempt counts |

Constraints:

- a partial unique index gives one `scheduled`/`live` row per server
- `(server_id, slot_at)` is unique among `scheduled`/`live`/`awarded`/`no_winner` rows
  (partial, migration 0050) — a `cancelled` or `failed` row does not hold its slot, or
  a `/koth cancel` or a never-announced schedule would bar that slot forever
- `koth_events_awarded_has_grant` CHECKs `state <> 'awarded' OR award_grant_id IS NOT NULL`
  — **one direction only**: awarded implies a grant, never the reverse. A `no_winner`
  or `cancelled` row is free to carry a null `award_grant_id`, which every other state
  does too; the CHECK only has to stop the one impossible case, an `awarded` row with
  nothing granted. `award_grant_id`'s FK is `ON DELETE set null` (§3 table above), so
  the CHECK deliberately does not also require the reverse — a revoked award elsewhere
  nulling this column must not retroactively make an already-`awarded` row invalid

**Lock order:** `koth_events` goes immediately before `award_grants`. The award
transaction is `koth_events` → `award_grants` → `clan_notices`.

`packages/domain/assets/koth-locations.json`: a vendored copy of
`livonia/koth/locations/index.json` (name, slug, centre, spawn radius) — **31 towns**.
The catalogue is the count, not a remembered round number; this spec said 32 in an
earlier draft. A drift test
compares it with `../livonia/koth/locations/index.json` when that path exists and
skips otherwise, the same pattern as the other cross-repo assets.

---

## 4. Rules — `packages/domain/src/koth.ts`, `rules.ts`

- `KOTH_ZONE_RADIUS_M = 500`
- `KOTH_REMINDER_LEAD_MS = 30 min`
- `KOTH_SCORE_SETTLE_MS = 10 min`
- `KOTH_PRESET_PREFIX = "koth-"`
- `KOTH_AWARD_KEY = "plate-carrier"` (checked against the award catalogue by a test)
- `kothWanted(slot, rows)` returns the event this slot opens, or null. The row must
  have `slot_at == slot`, `state = 'scheduled'` and `announced_at` set.
- `inKothZone(pos, centre)` is `distance2d(pos, centre) <= KOTH_ZONE_RADIUS_M`.
- `kothStandings(kills)` returns the ordered `{ dayzId, gamertag, kills, reachedAt }[]`.
- `kothWinner(standings, isLinked)` returns the first linked entry, or null.

There is no guide section. Airdrops have none either (`docs/superpowers/specs/2026-09-20-airdrop-events-design.md`)
— the Discord posts (§8) carry the numbers straight from these constants, and that is
the only place a player needs them. `guide-numbers.ts` stays untouched by this feature.

---

## 5. The restart tick

### 5.1 Opening (`kothWanted(slot)` returns a row)

The opening is all-or-nothing, and is verified before anything is written.

1. Confirm the 44 `koth-*.json` presets are on the server with **one** `listFiles` of
   `custom/`, checked against `KOTH_PRESET_FILES` — not 44 individual downloads.
   Then download the four town files from `koth/locations/<slug>/` **and** the four
   defaults from `koth/default/`. If any preset is missing, or any of those eight
   files is missing or empty, nothing is touched:
   - the row goes to `failed` with the reason in `detail`
   - a line goes to `OPS_CHANNEL_ID` (or an error log line if that is unset)
   - a cancellation is queued
   - the restart goes ahead as a normal restart

   ⚠️ A session that could not be reversed is worse than one that never started.
   That is why the defaults are checked at open, not at close.
2. Write the snapshots (§2.5) to the row, in their own statement, before any upload.
3. Edits:
   - the loadout splice, inside `applyGameplay` (the one `cfggameplay.json` round trip)
   - the `Infected*` splice, inside `applyEvents` (§5.4)
   - the four whole-file uploads
4. The restart POST. The row goes to `live` and `opened_at` is stamped only after the
   POST succeeds.

If any edit fails in step 3, the restart still happens and the row goes to `failed`.
The next slot's restore arm puts everything back. Players may get a partial KotH
session for two hours; the ops alert says which part failed.

### 5.2 Missed opening

If a row is `scheduled` with `slot_at` earlier than the current slot (the bot missed
it, or the slot's restart was `missed`/`skipped`), it goes to `failed` and a
cancellation is posted. It never opens late (§2.1).

### 5.3 Restoring (every slot where `kothWanted` is null)

- **Loadouts:** if `spawnGearPresetFiles` contains any `koth-` entry, it is replaced
  with the most recent event's `loadout_snapshot`. If there is no snapshot, it is
  replaced with the list minus the `koth-` entries, and if that leaves the list
  empty, an ops alert is sent and the file is left alone. A list with no `koth-`
  entry is never touched.
- **Infected:** only for the most recent event that has `opened_at` or
  `infected_snapshot` set and no `restored_at`. Each snapshotted event is set back
  to its value, and `restored_at` is stamped after the upload succeeds.
- **Whole files:** each of the four is compared with `koth/default/<file>` and
  uploaded if it differs. If a default is missing, that file is skipped and an ops
  alert is sent. Nothing is ever replaced with an empty file.

⚠️ This arm runs **whether or not `KOTH_TICK` is set**, whenever any KotH row has ever
existed. Otherwise switching the feature off mid-event would leave the server in KotH
mode.

### 5.4 `applyTruckWipe` becomes `applyEvents`

`events.xml` is already downloaded and uploaded once per slot by the truck wipe. KotH's
infected splice joins that same round trip, in its own try/catch, returning its
outcome rather than throwing, exactly as `applyGameplay` does for the raid window and
the airdrop.

⚠️ A second, independent download/upload of `events.xml` would silently discard
whichever edit uploaded first.

### 5.5 The restart message

It names the town, for example "King of the Hill at Lembork this session", the same
way an airdrop's restart message names its location.

---

## 6. Scoring and award — `apps/bot/src/koth-tick.ts`

Scoring runs for a `live` row once **both** of these hold:

- the closing restart (the window's end, §2.9 — `server_restarts.issued_at`, never
  `restarted_at`; the column holds the restart POST's timestamp) is at least
  `KOTH_SCORE_SETTLE_MS` in the past
- the kills consumer's cursor (`KILLS_CONSUMER`) has passed every event with
  `occurred_at` up to the window's end

⚠️ A bot that is catching up must not score a half-ingested window.

The query joins `kills` to `events` on `event_id`, filters with `scoringKill` and the
window, and reads `victimPos`. The zone test and ranking run in the domain functions.

The award runs in **one transaction**:

1. `SELECT … FOR UPDATE` the row. Return if it is no longer `live`.
2. Pick the winner (§2.10).
3. Call `grantAwardTx(tx, …)`, split out of `grantAwardDb` so both share one body.
   The reason is "King of the Hill — <Town>, <date>"; `grantedBy` is
   `scheduled_by_discord_id`.
4. Write `results`, `winner_dayz_id` and `award_grant_id`, and set `state` to
   `awarded` (or `no_winner`).

That transaction is the idempotency guard: a crash and retry can never grant two
Plate Carriers. The grant's DM goes out through the existing `clan_notices` path.

The results are frozen when written. Nothing re-scores an awarded event, including
`rebuild:kills`, which renumbers `kills`.

---

## 7. Commands — `apps/bot/src/commands/koth.ts`

These are ManageGuild commands with ephemeral replies. `parity.test.ts` needs no
entry.

- `/koth schedule location:<town> at:<slot>`
  - `location` autocompletes from the catalogue.
  - `at` autocompletes the restart slots of the next 7 days.
  - It refuses if the slot is less than `KOTH_REMINDER_LEAD_MS` away, and on any
    clash (§2.12).
  - It inserts a `scheduled` row, posts the "scheduled" announcement, then stamps
    `announced_at`. If the post throws, the row goes to `failed`.
- `/koth cancel` cancels the `scheduled` event and posts a cancellation. It refuses
  while the event is `live`; the next slot ends it anyway.
- `/koth status` shows the upcoming or current event and its state. While the event
  is `live`, it also shows the standings so far, from the same query as §6.

---

## 8. Announcements — `koth-tick.ts` + `koth-text.ts`

All posts go to `SERVER_EVENTS_CHANNEL_ID`. Each is rendered by a pure function,
posted by the tick, and stamped only after it succeeds. Every post uses
`allowedMentions: { parse: [] }`, because gamertags are player-controlled text.

| Post | When | Says |
|---|---|---|
| Scheduled | `/koth schedule` | Town, date and time, the rules in one line, the prize |
| Reminder | `slot_at − KOTH_REMINDER_LEAD_MS` | The same, "in 30 minutes" |
| Live | After `opened_at` | "Now live at <Town>", with the rules |
| Results | After the award | Top 5 with counts; the winner; "prize passed to …" if the top killer was unlinked; the dropped-kill count if not zero |
| Cancelled | On cancel or failure | The town and time, and that it will not run |

Numbers come from `rules.ts` constants, never literals.

---

## 9. Config

`KOTH_TICK` (boolean). It requires `RESTART_SCHEDULE` and `SERVER_EVENTS_CHANNEL_ID`,
and config load fails without them, the same as `AIRDROP_TICK`. `OPS_CHANNEL_ID` is
used if set. The restore arm is not gated (§5.3).

---

## 10. The `livonia` repo

1. Move `koth/custom/*.json` to `custom/koth-*.json`.
2. Generator:
   - emit `zombie_territories.xml`
   - add water rejection (§2.7)
   - stop emitting `cfgeventspawns.xml`
   - regenerate every town and delete the committed `cfgeventspawns.xml` copies
3. Deploy workflow: a step before FTP that copies the four default files into
   `koth/default/`, and `.gitignore` for `koth/default/`.
4. A check in the workflow's validation step that `cfggameplay.json` in the repo
   names no `koth-` file. The repo must always carry the default.
5. `livonia/CLAUDE.md`:
   - the bot owns the four files on the server (§2.4)
   - the preset prefix
   - `koth/default/` is generated

The review page (§2.7) is a throwaway tool built once, before step 2. It is not
committed to either repo.

---

## 11. Failure behaviour

| Failure | Result |
|---|---|
| Sources or defaults missing at open | Nothing touched; `failed`; ops alert; cancellation posted; normal restart |
| An edit fails at open | Restart proceeds; `failed`; ops alert; next slot restores |
| Bot down across the opening slot | `failed`; cancellation posted; never runs late |
| Bot down across the closing slot | The next slot the bot sees restores |
| A default missing at restore | That file is skipped; ops alert; the others are restored |
| `livonia` deploy mid-event | Puts defaults on disk; the bot re-converges before the next boot |
| Scoring not yet safe | It waits (settle time and the kills cursor) |
| Grant transaction fails | Rolls back; retried next tick |
| Any post fails | Not stamped; retried next tick |

---

## 12. Testing

**Domain:**
- `kothWanted` (slot matching, state, `announced_at` required)
- `inKothZone` at 499, 500 and 501 m
- `kothStandings` tie-break by `reachedAt`
- `kothWinner` passing over unlinked players, and returning null for an empty list
  or no linked player
- the guide-numbers rows

**Bot, against a fake `RestartTarget`:**
- open converges all six targets
- open refuses and touches nothing when any source or default is missing
- a snapshot is never taken from a `koth-` list
- a user's edit to the default loadout list survives a restore
- infected values are restored to the snapshot, not to `0`
- `restored_at` stops further `events.xml` edits
- `applyEvents` does exactly one download and one upload with both the truck wipe
  and KotH active
- the restore arm runs with `KOTH_TICK` off
- a missed opening slot goes to `failed`, never opens late

**Scoring:**
- the window bounds
- a victim-in-zone kill by an out-of-zone killer counts
- friendly fire and Hub kills do not count (through `scoringKill`)
- a missing `victimPos` is dropped and counted
- scoring waits for the kills cursor

**Award:**
- two concurrent scoring runs grant exactly one award
- `no_winner` grants nothing

**Text:** every post renders; mentions are suppressed.

**Drift:**
- `koth-locations.json` against the `livonia` index
- `KOTH_AWARD_KEY` exists in `awards.json`

**`livonia`:**
- generator tests for water rejection (a synthetic mask) and the zombie territory
  output
- the workflow check that no `koth-` preset is named in the repo's `cfggameplay.json`

---

## 13. Deploy order

Runbook `docs/deploy/<date>-king-of-the-hill.md`:

1. `livonia` Release: presets, regenerated towns, and the `koth/default/` step.
   Verify on the server that `koth/default/` holds four non-empty files.
2. The migration, through `deploy-release.sh`.
3. The bot with `KOTH_TICK=true`.
4. A rehearsal on a quiet slot. Check after the opening restart:
   - the spawns, loadout, infected and animals are at the hill
   - all six targets are back at the default after the closing restart
   - the results post and the award DM arrive
