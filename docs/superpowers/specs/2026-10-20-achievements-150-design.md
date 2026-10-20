# Achievements to 150 — design

Date: 2026-10-20. Status: draft for approval. Reviewed by a builder check; owner answered its two open questions (§6).

## Why

The catalogue has 50 achievements, 49 earnable: Wanderer is already
`retired` (fast travel changed with the Nasdara swap; holders keep it,
nobody can earn it, `EARNABLE_ACHIEVEMENTS` drops it). Two more (Wolf Bait,
Bear Necessities) can no longer be earned: Clan Wars runs on Nasdara since 2026-10-17, and
Nasdara has no wolves or bears. Nasdara does have dogs, motorbikes and ruined
buildings players can repair, and the 1.30 logs show things nothing on the
wall rewards yet. The owner wants **150 earnable** achievements: a reason to try every
gun, and more of the small, funny moments DayZ produces.

Success: 150 tiles, each earned from something the ADM actually logs, with
existing unlocks untouched (apart from the two removals below), and history
backfilled so long-time players open the new wall with progress already on
it.

## Goals, non-goals, anti-goals

- **Goal:** retire `wolf_bait` and `bear_necessities` (the Wanderer
  precedent, commit ebf6911); add 103 so `EARNABLE_ACHIEVEMENTS.length` is
  exactly 150 (153 defined, 3 retired).
- **Goal:** fix the three ingest gaps found while researching this (§3). Fix
  them first; several new achievements depend on them, and Sunday Driver is
  already wrong without the first.
- **Non-goal:** anything the ADM cannot see. No line says who is riding a
  vehicle, so nothing like "ride 10 km". The ADM has no chat line.
- **Non-goal:** new group colours or a redesign of the tile or badge.
- **Anti-goal:** an achievement that discourages raiding or PvP, or that
  rewards being raided (house voice: [[player-facing-copy-voice]], i.e.
  `brand/02-verbal-identity.md`).
- **Anti-goal:** a rule that silently never fires because its log shape is
  guessed. Every rule below cites a shape seen in production logs; the ones
  not yet seen are marked.

## 1. Evidence base

Researched 2026-10-20 over every raw line in `factions_live.raw_lines`
(102,925 lines, 607 files, 2026-08-31 → today, Livonia, Chernarus and
Nasdara) plus the 113 ADM files Nitrado still holds for 19831378,
19315235 and 18196786. Shape counts below are from that corpus.

PvP kill display names seen (count): DMR 211, AUR AX 194, M4-A1 171, SCR 17 139,
LAR 130, M16-A2 119, VSD 102, KA-M 91, KA-101 80, VS-89 77, KA-74 76, Vikhr 63,
SVAL 63, CR-550 Savanna 58, VSS 44, Mlock-91 34, M70 Tundra 15, R12 14,
Sporter 22 9, SK 59/66 8, BK-133 6, SG5-K 5, M79 5, KAS-74U 5, SCR 16 4,
CR-527 4, SSG 82 3, Mosin 91/30 3, LE-MAS 3, Bizon 3, USG-45 2, Pioneer 2,
Blaze 2, BK-43 2, Engraved Kolt 1911 1, Derringer 1, Deagle 1, CR-75 1, BK-12 1.
(Some, e.g. DMR, VS-89, are guns from earlier maps or award kits that do not
spawn on Nasdara; they count toward nothing in §2.2 but still count for
Arsenal.)

## 2. The catalogue

Keys are the builder's to finalise (snake_case, stable forever once shipped).
Names and descriptions are drafts in the house voice. The builder may polish
the copy, but any change of meaning goes back to the owner. Groups use the
existing four (`solo`, `pve`, `pvp`, `team`).

### 2.1 Retired (2)

`wolf_bait`, `bear_necessities` get `{ retired: true }`, exactly as Wanderer
did: the 3 Bear Necessities holders and 1 Wolf Bait holder keep theirs; the
tiles vanish from every other wall, the guide and the tick. (Builder's call
from precedent; the owner said "remove".)

### 2.2 Guns: one per firearm (52, pvp)

One tile per firearm that spawns on Nasdara (`nasdara/db/types.xml`,
category `weapons`, `nominal > 0`), with **colour and finish variants merged**
(AK74/_Black/_Green → one; AKM/AKM_Gold → one; Deagle/_Gold; Magnum/_Gold;
Colt1911/Engraved1911; Mosin9130/_Black; SCARL/_Black; SKS/_Desert; and so on).
Earned by **one PvP kill with it** (`scoringKill`, so friendly fire and
Hub-discredited kills do not count, the same as every PvP achievement).
Distinct guns stay distinct even when similar (Aug vs AugShort, SCARL vs
SCARH, SVD vs VSS, Izh18 rifle vs Izh18Shotgun). *My call:* if two catalogue
guns turn out to print the **same** display name, merge them into one tile and
add one replacement milestone so the earnable total stays 150; say so in the
PR. *My call:* **sawed-off** variants (player-made, not in types.xml) count
toward their parent gun.

The 52, by class (the class is used by §2.3):

| Class | Firearms (classnames) |
|---|---|
| Pistols (12) | CZ75, Colt1911 (+Engraved1911), Deagle, Derringer, FNX45, Glock19, Luger, MKII, Magnum, MakarovIJ70, P1, Longhorn |
| SMGs (7) | CZ61, MP5K, UMP45, PP19, MP18, PM73Rak, Vikhr |
| Shotguns (5) | Izh18Shotgun, Izh43Shotgun, Mp133Shotgun, Saiga, R12 |
| Assault rifles (13) | AK101, AK74, AKM, AKS74U, ASVAL, Aug, AugShort, FAL, FAMAS, M16A2, M4A1, SCARH, SCARL |
| Rifles (11) | B95, CZ527, CZ550, Izh18, LeeEnfield, Mosin9130, Repeater, Ruger1022, SKS, SSG82, Winchester70 |
| Snipers (2) | SVD, VSS |
| Other (2) | Crossbow, M79 |

⚠️ **The kill line names the gun by its in-game display name, not its
classname** (`with KA-M from 42 meters`, `AUR AX`, `M70 Tundra`, `Mlock-91`).
The rule needs a hand-built **display name → firearm** table in
`packages/domain`, one row per display name the log can print, mapping every
variant to its firearm. Most variants share a display name already; gold and
engraved ones may not. Build it from production kill/hit lines (39 display
names seen so far, listed in §1's corpus) plus the game's config for guns not
yet seen. A test should fail if a firearm in the catalogue has no display name
mapped. **A display name the table does not know must not count toward any
tile and must be logged**; otherwise a misspelled table silently makes a tile
unearnable.

The class assignment above is the owner-approved intent. Where a gun's class
is arguable (Vikhr, ASVAL, Saiga, SKS), the builder may move it, and must
say so in the PR.

Tile names: the builder proposes one per gun; a plain "<Gun name>" pattern is
acceptable. Badge art: see §5.

### 2.3 Gun classes and Full Armory (6, pvp)

- Six class tiles: a PvP kill with **every** gun in a class: pistols, SMGs,
  shotguns, assault rifles, rifles, snipers. (Snipers is small at 2; that is
  fine.) "Other" has no class tile.
- **Full Armory:** a PvP kill with every one of the 52.

Progress shows as "n of N". Earned at the kill that completes the set.

(Six class tiles plus one; chat said five classes. The total is balanced in
§2.11.)

### 2.4 Melee (4, pvp)

From PvP kill lines with no `from N meters` (seen: Hunting Knife 40,
`(MeleeFist)` 16, Sledgehammer 13, Pickaxe, Hatchet, Kukri, Farming Hoe,
Duct Tape, Barbed Wire).

- Knife kill (any knife-class melee: Hunting Knife, Kukri, Combat Knife,
  Kitchen Knife, Steak Knife, … — a list in domain).
- Fist kill (`MeleeFist`, `MeleeFist_Heavy`, `MeleeFistHeavy`).
- Sledgehammer kill.
- Kills with 5 different melee weapons.

### 2.5 Dogs (3, pve)

Hit lines: `hit by Doberman into Head(0) for 5.5 damage (MeleeWolf)` and
`hit by German Shepherd into …`. Seven attacks so far; no dog kill seen yet.

- **Killed by a dog.** Either a stated `killed by Animal_CanisFamiliaris…`
  (not yet seen, so accept any `Animal_` killer whose name is a dog), or a bare
  `died.` with a dog hit in the verdict window (§3.2). ⚠️ Not yet observed in
  any log; the inferred path is the likely one.
- **Survive a dog attack:** took a dog hit, then 10 minutes passed with no death.
- **Dog chew toy:** 10 dog hits (lines, not attacks).

### 2.6 Motorbikes (4, pve and pvp)

Shapes seen: `hit by NO DRIVER with TransportHit (Motorbike_02_Yellow)` (≈200
lines, bursts of 20–40 in one second at a fixed spot, read as a rider hurt by
their own bike: *assumption*); `killed by NO DRIVER (Motorbike_02_Yellow)` (9
deaths); `hit by Player "X" (…) with TransportHit (Motorbike_02_Red)` (rare).
Classes: `Motorbike_01_*`, `Motorbike_02_*`.

- **Road Rash (pve):** hurt by a motorbike with no driver. Count one per
  burst, not per line; a burst is one second.
- **Killed by a motorbike (pve):** death with cause `vehicle` and a
  `Motorbike_` entity, with no killer (§3.1). Like Sunday Driver, a credited
  kill is not this.
- **Hit and run (pvp):** you hit another player with a motorbike (you are the
  attacker on a `TransportHit (Motorbike_…)` hit).
- **Roadkill (pvp):** a scoring PvP kill whose weapon is a motorbike
  TransportHit (usually a credited `finished` kill).

### 2.7 Ruins, new on Nasdara (4, pve)

Nasdara lets players repair ruined buildings. The log prints them with the
object name empty: `Built door1_metal on  with Hammer`, `Built rubble_rubble1
on  with Shovel`. 153 since 2026-10-17. Parts seen: `door{N}_{wood,metal,barricade}`,
`window{N}_{wood,metal}`, `wall{N}_wood`, `wall{N}_window_wood`,
`wall{N}_door_wood`, `roof{N}`, `rubble_rubble{N}`, `ladder_rebuild`.

- **First repair** on a ruin.
- **Clear 10 rubble piles** (`rubble_*`).
- **25 repairs.**
- **Fixer-Upper:** repair a door, a window and a roof (any buildings). The log
  gives no building identity, so "on one building" (as discussed in chat)
  would need position clustering. The builder's call, but the simple form is
  the default.

### 2.8 Traps and explosives (5, pve)

From hit labels and death entities in production:

- Step in a bear trap (`hit by BearTrap`, 15).
- Set off a tripwire (`hit by TripwireTrap`, 15).
- Caught in barbed wire (`hit by Fence|Watchtower|Gate with BarbedWireHit`, 600+).
- Killed by a mine or claymore (`killed by LandMineTrap` / `Claymore`, no killer).
- Killed by a grenade (entity is a grenade: `6-M7…`, `EGD…`, `M67Grenade`,
  `MNGrenade`, …, no killer).

### 2.9 Camp (4, pve)

From `item.placed` and a new packing shape (§3.4):

- Place 10 barrels.
- Pack 10 tents (`packed Large Tent|Car Tent|Medium Tent|… with Hands`).
- Place a sea chest.
- Place a land mine.

### 2.10 Emotes and oddities (7, solo/pve)

- 10 different emotes (`emote.performed`, distinct emote).
- Every emote: a fixed list of emotes in domain (36 seen in production; the
  builder confirms the list against the game, and a tile no one can earn is
  worse than a list missing one).
- 10 rock-paper-scissors (`EmoteRPSRandom`).
- Burned by a fire (`hit by Fireplace`).
- Hit by thrown meat (`hit by …Meat with`, e.g. `ChickenBreastMeat`,
  `HumanSteakMeat`).
- Come round 10 times (`regained consciousness`, §3.4).
- Drown (cause `drowned`).

### 2.11 Milestones (9)

Bigger versions of existing tiles. Proposed, builder may retune thresholds
against production distributions so each is reachable by the server's most
active players:

- 250 PvP kills (pvp).
- 500 hours played (solo).
- 30 consecutive days played (solo).
- A kill from 500 m (pvp).
- Seen in 150 grid squares (solo).
- Kill 25 different players (pvp).
- Perform 500 emotes (solo).
- 2,000 build points (pve).
- Die 100 times (pve).

### 2.12 Clan (4, team)

- The clan's members get PvP kills with 25 different firearms (while full
  members, the same membership rule as other team tiles).
- The clan makes 50 ruin repairs.
- The clan gets 250 PvP kills.
- Every one of the 6 gun-class tiles earned by a member of the clan.
  *My call:* each class tile must have been earned **while** that player was
  a full member (the existing team-tile membership rule), and the clan tile is
  earned at the unlock that completes the set. "25 different firearms" means
  the 52 catalogue guns, not raw weapon strings.

### Count

| | |
|---|---|
| Kept, earnable | 47 (+3 retired) |
| Guns, per firearm | 52 |
| Classes + Full Armory | 7 |
| Melee | 4 |
| Dogs | 3 |
| Motorbikes | 4 |
| Ruins | 4 |
| Traps/explosives | 5 |
| Camp | 4 |
| Emotes/oddities | 7 |
| Milestones | 9 |
| Clan | 4 |
| **Earnable total** | **150** |

A test pins `EARNABLE_ACHIEVEMENTS.length === 150`.

## 3. Ingest fixes (do first)

### 3.1 Motorbike and "NO DRIVER" vehicle deaths file as environment

`killed by NO DRIVER (Motorbike_02_Yellow)`: `ENTITY_RE` in
`packages/adm-parser/src/death.ts` reads the entity as `NO`, so the cause is
`environment`, and `ENTITY_CAUSES` has no `Motorbike_` prefix anyway. Sunday
Driver has missed every one. Production holds 3 events with entity `NO`.
Fix: read the parenthesised class after `NO DRIVER`, add `Motorbike_` to the
vehicle prefixes. Then rebuild kills (`rebuild:kills`, existing runbook) so
history re-classifies.

### 3.2 Dog deaths are not recognised

`classifyDeath` (`packages/domain/src/death-verdict.ts`) only treats
*infected* hits as hunting evidence ("mauled"); a bare `died` after dog bites
comes out `died` or `bled_out`. Add a dog cause (inferred, like `mauled`): a
dog hit in the window plus the same corroborations. Also `parseHit` takes the
label with `/^([A-Za-z0-9_]+)/`, so `German Shepherd` is stored as `German`.
Fix: label up to ` into ` / ` with ` / ` (`. The builder decides whether
"Brown Bear" and "Wolf" hit labels need the same treatment (they do; harmless).
`classifyEntityLabel` should learn the dog labels.

### 3.3 Ruin repairs are misparsed as base building

`structure.ts`'s `BUILT_RE` (`Built (\S+) on (.+?)(?: with (.+?))?`) reads
`Built door1_metal on  with Hammer` as structure `" with Hammer"`, tool null.
These are currently stored as `base.built` and count as build points.
Fix: a ruin shape (empty object) becomes its own event type (e.g.
`building.repaired`, payload: part, tool, pos, player). *My call:* ruin repairs **stop** counting as build points, for the
achievements and the builders board (`packages/roster/src/stats.ts`), since
they are not base building; no revocation of any `foundation`/`builder`/
`architect` already earned. ⚠️ But base-zone enforcement **must keep
treating them as it does today**: `zone-tick.ts` flags a non-member's
`base.built` inside a zone as a breach and alerts the owner, and on Nasdara
clans may base inside repaired ruins. Feed `building.repaired` into
`zone-tick.ts` with the same handling, so enforcement does not weaken. Zone
violations reference the misparsed event ids: the delete-then-reparse must
re-point or re-record them, never drop them.
⚠️ A reparse never corrects a misparsed line (idempotency is on file + line),
so the runbook must delete the misparsed `base.built` events first, the same
discipline as `docs/deploy/2026-09-10-credited-kills.md`. Watch the FKs into
`events` (kills, feed_entries, positions…) when deleting.

### 3.4 New shapes to parse

- `regained consciousness` (102 lines in three days of Nasdara logs).
- `packed <Tent> with Hands`.

Both are new event types. Because `raw_lines` holds every line since
2026-08-31, history can be backfilled into them (new events for lines that
previously yielded none do not collide with the idempotency index; check
`subIndex` ordering rules in `parse-line.ts` before adding a ParsedLine kind).

## 4. Rules and the tick

Rules live in `apps/bot/src/achievements/` beside the existing ones and follow
their contracts (`RuleResult`, `oneShot`, `nth`, earned-at the crossing row,
never "now", never a coordinate in evidence).

⚠️ Performance: the tick evaluates every rule for every touched owner. 52
per-gun rules must **not** be 52 queries. One read of the owner's scoring
kills, mapped through the display-name table, should feed every per-gun,
class, Full Armory and Arsenal result. The builder measures tick time against
`factions_live`-sized data before and after.

Arsenal (10 different weapons) keeps counting raw weapon strings as today.
Do not change its meaning.

## 5. Surfaces

- The wall (`apps/web/app/components/achievement-wall.tsx`) groups by the four
  groups. With 52 gun tiles the pvp group dominates. The builder may add a
  visual sub-section ("Armory") within pvp, collapsed by default, but no new
  group colour. The earned count and "closest" panel keep working over all 150.
- Clan wall: 12 → 16 team tiles. The wall copy that says "fifty tiles" etc.
- **Badge art.** Every key needs `apps/web/public/achievements/{svg,unlocked,
  locked}/<key>` and a regenerated `lib/achievement-glyphs.ts`. For the 52
  per-gun tiles use **one shared gun-badge frame with the gun's silhouette**,
  not 52 bespoke designs (owner agreed). The other 50 get bespoke glyphs in the
  existing style.
- The guide chapter `apps/web/content/guide/14-achievements.html`, the Discord
  `/achievements` command, the embed, the share card and the CLAUDE.md
  "Achievements (50, lifetime)" row all say 50 or list tiles; update them.
  Numbers go through `rules.ts`/`guide-numbers.ts` per house rule.

## 6. Rollout

1. Ship §3's parser fixes, run the delete-then-reparse and `rebuild:kills`.
2. Ship the catalogue, rules, art, and surfaces.
3. Backfill (`pnpm backfill:achievements`). Lifetime, any map: a gun kill on
   Livonia or Chernarus counts toward that gun's tile.
4. Wolf/bear: retired, holders keep them (§2.1). No revocation.
5. Notices (owner, 2026-10-20): the backfill sends **one summary per
   player**, never one notice per unlock. `scripts/backfill-achievements.ts`
   already inserts silently (`announce: false`); ⚠️ do **not** run
   `apps/bot/src/achievements/backfill-notices.ts` for this backfill, since
   it queues a separate DM, clan-channel post and `#achievements` post for
   every unannounced unlock, which here would be thousands. Build a new
   summary notice kind (a DM to the linked player naming how many new tiles
   they already hold, with the wall link; no public post), queued once per
   player by the backfill, through the existing notice queue, and rendered
   in both `apps/bot/src/notice-text.ts` and `apps/web/lib/notice-copy.ts`.
   Unlinked players get no DM; their tiles are simply on the wall.
6. After launch, gun, class and Full Armory tiles **announce exactly like
   every other achievement** (owner, 2026-10-20). No per-tile announce flag.

## 7. Left to the builder

Keys, final copy within the house voice, per-gun tile names, melee and emote
lists, milestone thresholds (within "reachable by the most active players"),
the Armory sub-section's look, and the building-identity question in §2.7.
