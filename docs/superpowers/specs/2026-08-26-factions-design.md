# DayZ Faction System — Design

**Date:** 2026-08-26
**Status:** Approved design. Plan 1 (ingest + flag events) implemented; §16 added 2026-08-26.
**Project:** `factions` — standalone private repository at `submtd/factions`

---

## 1. Purpose

A Discord bot and supporting services that let players create and run factions on a boosted
DayZ PvP server **without admin intervention**. Faction identity is bound to a physical
in-game object — a territory flagpole — so that membership, territory, and raid outcomes are
established by things players actually do in the world rather than by forms they fill out.

### Goals

- Faction creation, roster management, and dissolution are fully self-service
- Faction identity (name, flag, armband) is unique and mechanically enforced
- Getting raided is detectable, announced, and consequential
- Zero admin tickets in the normal lifecycle

### Non-goals for v1

Explicitly rejected during design, and rejected on purpose:

- Territory polygons, contested zones, provinces, or any area-control geometry
- Nations, alliances, or any faction-of-factions meta-layer
- Taxes, stock markets, bonds, treasuries
- Losing your flag as a consequence of being raided

The reference implementations for most of the above are DayZ Legions, whose system is well
designed and drowning its staff in the manual work of running it. This design deliberately
picks the smallest mechanic — one faction, one flag, one pole — that still produces PvP stakes.

---

## 2. Prior art

Two servers were surveyed in detail.

**ARMX (10x boosted, Livonia)** — ~23 factions. Identity is a unique vanilla flag texture plus
matching armband, drawn from a fixed pool; the pool size is the faction cap. "Alpha Factions"
are the top 3 by raid count, re-ranked every raid weekend. Everything is manual: the founder
maintains the faction list by hand, recruitment is an untooled Discord forum, and "do not fly
another faction's colors" is enforced by ticket.

**DayZ Legions (2x PvE/PvP)** — a three-tier political economy: factions → nations → alliances,
with territory polygons, purchasable 1000×1000m provinces, a base module allowance, a currency
tax ladder, pay-per-kill scaling, stocks, and bonds. Registration is a free-text Discord form,
inconsistently filled in and unvalidated; territory claims live on a shared iZurvive link; every
state change routes through a ticket and a human.

**The gap this project fills:** nobody has automated any of it. The good ideas — unique flag
identity, raid-count ranking, activity decay — all exist, and all are maintained by hand.

---

## 3. Core model

A **faction** is:

| Field | Notes |
|---|---|
| Name | Display name, player-chosen |
| Tag | Short abbreviation; used for channel names and IDs |
| Flag | One of 33 claimable textures, unique per (server, map) |
| Armband | Derived automatically — `Flag_X` → `Armband_X` |
| Capital pole | `(server, map, x, y, z)` — the faction's primary key |
| Roster | Leader (1), Officers (n), Members (n) |
| State | One of the lifecycle states in §4 |

### The flag pool

`types.xml` defines **34 flags and 41 armbands**, identical across chernarus, livonia, and
sakhal. All 34 flag names have an exactly matching armband name — a perfect 1:1 mapping, so
claiming a flag grants the armband with a string substitution and no curation table.

`Flag_White` is **reserved** as the neutral/unclaimed flag. That leaves **33 claimable
identities per (server, map)**.

Full list (excluding White): Altis, APA, BabyDeer, Bear, Bohemia, BrainZ, Cannibals, CDF,
Chedaki, CHEL, Chernarus, CMC, Crook, DayZ, HunterZ, Livonia, LivoniaArmy, LivoniaPolice,
NAPA, NSahrani, Pirates, Refuge, Rex, Rooster, RSTA, Sakhal, Snake, SSahrani, TEC, UEC, Wolf,
Zagorky, Zenit.

**Central economy change:** set `nominal` and `min` to 0 for all 33 claimable flags, and raise
`Flag_White`'s nominal so players can reliably find one. All flags currently share identical
CE config (`nominal 2`, `min 1`, `lifetime 14400`, usage Office/School), so this is a
mechanical edit.

**Scarcity is a feature.** 33 is a real ceiling. ARMX runs 23 factions against a 28-flag cap
and that pressure is doing useful work for them. Do not expand the pool to relieve it.

### Tenancy

Factions are **per-map**. The data model carries `(server_id, map)` as a composite key on
`factions` and `flag_pool` from day one, even though only one server is live at launch.
Retrofitting a tenancy key onto a live schema is miserable; carrying an unused one costs
nothing.

---

## 4. Lifecycle

```
                    ┌─────────────┐
                    │  UNCLAIMED  │  flag sits in the 33-slot pool
                    └──────┬──────┘
                           │  ceremony detected at a white-flag pole
                           ▼
                    ┌─────────────┐
                    │ PROVISIONAL │  claim window open, no faction yet
                    └──────┬──────┘
                           │  /faction claim — name, flag, roster
                           ▼
   flag re-raised   ┌─────────────┐
      ┌────────────►│   ACTIVE    │  supplies flowing, ranked, listed
      │             └──────┬──────┘
      │                    │  capital flag down past grace window
      │             ┌──────▼──────┐
      └─────────────┤   DORMANT   │  supplies cut, delisted, unranked
                    └──────┬──────┘
                           │  no re-raise for 14 days
                           ▼
                    ┌─────────────┐
                    │  DISBANDED  │  flag returns to the pool
                    └─────────────┘
```

### Timers

| Timer | Value | Rationale |
|---|---|---|
| Provisional expiry | 24h | Prevents ceremony-spam squatting the detection queue |
| Dormancy grace | 24h | A raid at 3am shouldn't cut supplies before the faction wakes up |
| Dormant → disbanded | 14 days | Pool hygiene; see below |
| Leader inactivity | 7 days | Faction gets rescued before it dies |
| Leadership challenge window | 48h | |
| Kick/leave cooldown | 3 days | |

### Why dormancy must expire

A 33-slot pool with no reclamation path starves. Three factions quit in month one and three
flags are gone permanently; by month six new players are choosing from scraps.

**This is not "raid someone and take their flag."** Getting raided makes a faction dormant and
can never cost it its identity. Only *abandonment* — 14 days with nobody on the roster walking
out to raise the flag — releases a flag back to the pool. Legions solves the same problem with
14-day territory decay.

---

## 5. The ceremony

The founding ritual, and the property that makes this system better than a registration form.

### Detection

At a flagpole that is **flying `Flag_White`** and **not already bound to a faction**, watch for:

> **≥3 distinct player UIDs**, each performing a **lower → raise** pair, **within a 10-minute
> window.**

### Why it separates cleanly from noise

Routine maintenance — raising a flag to refresh base persistence — is a *single* UID performing
lower→raise. The live log shows exactly this: one player lowering at `19:55:19` and re-raising
at `19:55:28`, nine seconds apart, on a weekly cadence. Three or more distinct UIDs at one pole
inside ten minutes does not happen by accident.

### What it proves

The participants were **simultaneously alive, in-game, and standing at the same pole**. The
roster is a physical event before it is ever a Discord record. This is a liveness property that
no form-based registration can offer, and it is the core reason to build the system this way.

### Claim

The bot posts the detected ceremony with its participant list. A participant runs
`/faction claim` and supplies a name, a tag, and an available flag, then confirms the roster.

### Threat model

| Attack | Defense |
|---|---|
| A stranger joins the ceremony and lands on the roster | The claim step lists detected UIDs; the claimant prunes before confirming |
| Someone else claims your ceremony | The claimant's linked UID must be among the participants |
| Ceremony run at an established faction's pole | Bound poles are ineligible — ceremonies register only on unbound White poles |
| One person cycling alt accounts | Not fully solvable here; depends on separate alt-prevention work |

The White-flag requirement does double duty: it is the enforcement hook, and it makes every
ceremony legible. Everyone starts neutral and earns their colors.

### Pole binding and pole loss

On claim, `(server, map, pole coordinates)` becomes the faction's primary key. Observed
coordinates are byte-identical across five weeks of events, so exact match works — but
**normalize to ~1cm precision** rather than trusting float formatting indefinitely.

`folded Flag Pole` and `Dismantled Base from Flag Pole` are both logged, so pole loss is
detectable. On loss the faction goes **dormant** and the leader gets `/faction rebind`: raise
White at a new pole, confirm, keep the flag and roster.

Re-bind is deliberately lighter than the original ceremony. Losing a pole already means the
faction was raided to nothing; requiring five people to re-convene punishes them twice.

---

## 6. Roster management

### The tension, and why Discord-only is acceptable

The ceremony proves every *founding* member was real and present. Discord-side invites let a
faction found with 3 real players and then paper-stuff to 30.

This is safe **provided roster size never confers a mechanical benefit.** The roster's real job
is discriminating maintenance from raids at the faction's own pole, and paper members do not
walk to poles. Adding a member requires their consent, so an enemy cannot be unilaterally
rostered mid-raid to deny them credit.

*Deferred option:* an invited member stays **pending until seen at the capital pole** (any ADM
event at those coordinates). One visit to your own base, which a real member makes anyway.
Preserves the presence guarantee at near-zero friction. Not in v1.

### Roles

| Role | Capabilities |
|---|---|
| **Leader** (exactly 1) | Everything: disband, rename, transfer, rebind, manage officers |
| **Officer** (n) | Invite, kick members. Cannot kick officers |
| **Member** | Roster membership |

### Commands

| Command | Who | Notes |
|---|---|---|
| `/faction claim` | Ceremony participant | Name, tag, flag, roster confirmation |
| `/faction invite @user` | Leader, Officer | Invitee must have a linked gamertag; accepts via button |
| `/faction kick @user` | Leader, Officer | Officers cannot kick officers |
| `/faction promote @user` | Leader | |
| `/faction demote @user` | Leader | |
| `/faction transfer @user` | Leader | Confirmation required |
| `/faction leave` | Anyone | Leader must transfer first |
| `/faction disband` | Leader | Flag returns to pool immediately |
| `/faction rebind` | Leader | After pole loss |
| `/faction rename` | Leader | Cooldown — identity should not churn |
| `/faction claim-leadership` | Officer | Only when leader inactive ≥7 days |
| `/faction info [name]` | Public | Faction card |
| `/faction roster` | Public | |

### Invariants enforced in the model, not the rulebook

**One player, one faction per map.** Without it, rosters overlap and maintenance-vs-raid
discrimination becomes ambiguous — whose flag is this person permitted to touch? Enforced at
invite time.

**Leader succession without an admin.** If the leader has no game activity for 7 days, any
officer may run `/faction claim-leadership`. This opens a 48-hour challenge window announced to
the whole faction. If the leader logs in and objects, it is void; otherwise the officer takes
over. This is the single mechanic that determines whether the no-admin-intervention goal is
actually met — leaders quit DayZ constantly, and a frozen faction is a guaranteed ticket.

**Kick/leave cooldown: 3 days, applied equally.** Punishing voluntary departure more harshly
than being kicked buys nothing, because the two collapse under collusion ("just kick me").
Disbanding exempts all members — that is not betrayal.

---

## 7. Raid credit and rankings

### The credit event

A `lowered` event at a **bound capital pole**, by a UID **not on that faction's roster as of
that moment**. Roster-at-time-of-event, which the event log provides directly.

**Deduplication:** one credit per `(raiding faction → victim faction)` per **24 hours**. A
single raid produces multiple lowers as raiders lower, defenders re-raise, and raiders lower
again; without collapsing these the leaderboard becomes a clicking contest.

**Unaffiliated raiders** still generate the announcement and still start the victim's dormancy
clock. They have no faction to credit.

### Accepted property: lowering a flag is not raiding

No base damage is required to lower a flag — only physical access to the pole. A lone player
who slips through an open gate earns full credit without firing a shot, including outside the
raid window.

**This is accepted deliberately, not patched.** It makes pole placement a genuine strategic
decision: bury the flag deep in the compound or lose it to one player with good timing. It also
legitimizes infiltration as an alternative to explosives, which on a boosted server where
everyone has C4 is the more interesting fight. Gating credit to the raid window would not
prevent the sneak, only leave it unrewarded.

### Rank weighting

Flat raid counts are farmable: two friendly factions trade flag-lowers every weekend and both
climb. Rate-limiting handles the grind but not the arrangement.

Weighting by victim rank kills it structurally. For a victim at rank `r` of `N` ranked factions:

```
points = BASE × (2 − (r − 1) / (N − 1))     for N > 1
points = BASE × 2                            for N = 1
```

- Raiding the #1 faction is worth `BASE × 2`
- Raiding the bottom-ranked faction is worth `BASE × 1`
- An unranked victim (new or dormant) is worth `BASE × 1`

The `N = 1` case is not hypothetical — it is the state of the server on launch day, when the
first faction to register is simultaneously rank 1 and the entire ladder. The general formula
divides by zero there.

Farming a weak partner yields the floor, and the ladder generates its own pressure toward the
top — "everyone wants to hit the alpha" is the tension a domination server runs on.

### Rankings

Rolling window of the **last 4 raid weekends**, recomputed at the close of each weekend. The
board reflects who is dangerous *now*. Top 3 receive a public alpha designation — ARMX's best
social mechanic, and free.

**"Raid weekend" is a configured window, not a derived one.** The ranking cadence depends on it
and it is currently undefined for this server. It needs a concrete definition — a weekday, a
start time, an end time, and a timezone — before rankings can be computed at all. For reference,
ARMX runs Friday 9PM → Sunday 9PM CET; Legions runs Friday 8PM → Monday 12AM EST.

Note that raid credit itself is **not** gated to this window (see the accepted property above);
the window governs only how ranking periods are bucketed.

### Announcements

On credit, post publicly:

> ⚔️ **Wolf Tang Clan** raided **The Nest** — flag lowered by `SubatomicRacer`

Name the individual; drama needs a protagonist.

**Never post coordinates.** Publishing base locations would turn the bot into a griefing tool.
Name the victim, never the place.

On successful defense — the flag re-raised inside the grace window:

> 🛡️ **The Nest** raised their colors again — 4h under siege

Separately, the victim faction receives a **notification: flag down, supplies suspended, 24h to
re-raise.** This doubles as the dormancy grace notice.

---

## 8. Supply spawner

The only path where the bot writes *into* the game, and therefore the one with the most
guardrails.

### Coordinate ordering

The ADM flag event's `at <2991.569092, 447.946503, 1138.587646>` is `<x, altitude, z>` — which
is **exactly the ordering DayZ's object spawner expects** for `pos`. The pole coordinate drops
into a spawner entry with no transform.

Note that the *player* `pos=<...>` field in the same line uses a **different** ordering,
`<x, z, altitude>`. Compare `pos=<2993.0, 1139.0, 448.3>` against
`at <2991.5, 447.9, 1138.5>` in the same event. Getting this backwards silently corrupts every
pole key.

### Contract

The mechanism is deliberately abstracted:

> **Given a pole coordinate and a package definition, materialize supplies at that pole.**

Two candidate implementations, to be decided by in-game testing:

| | Object spawner JSON | Barrel + `cfgspawnabletypes` + CE events |
|---|---|---|
| Placement | Exact, guaranteed | Event distribution must be verified to guarantee per-pole coverage |
| Refill | Server restart only | CE timer, independent of restarts |
| Package definition | Individual items listed out | One cargo preset stocks a whole barrel |
| Files generated | One | `events.xml` + `cfgeventspawns.xml`, both core files |

Neither choice affects anything else in this design.

**Placement approach:** supplies are positioned **relative to the flagpole structure itself**,
authored in DayZ Editor. This eliminates terrain-slope problems entirely — no risk of crates
spawning buried or floating on uneven ground.

**Persistency:** `enableCEPersistency: 0`. Confirmed in testing — an item spawned via JSON that
a player picks up becomes persistent in the world normally, while untouched items are recreated
at restart rather than accumulating.

### Pipeline

```
faction projection changes
        ↓
generate factions.json  (active factions only)
        ↓
validate + diff against last-known-good
        ↓
upload to game server
        ↓
applied at next scheduled restart
```

**One generated file**, referenced once in `cfgeconomycore.xml`. Not one file per faction —
that would mean editing the economy XML on every claim and disband, and churning that file on a
live server risks a server that will not boot.

**Dormancy falls out for free:** a dormant faction is simply omitted from the next generation,
so supplies stop within one restart cycle. Hours, not instantly, which is the right feel.

### Guardrails

- **Dry-run by default**
- **Schema validation before upload** — never ship malformed JSON to a server that parses it at boot
- **Last-known-good retained**, roll back on a failed restart
- **Only ever writes the generated file** — no other path is writable

### Rejected: rank-scaled supply packages

Rewarding the alphas compounds the top of the ladder until nobody can reach it. On a 33-slot
server that produces one faction and thirty-two ghosts. Packages are flat for every faction. If
a lever is ever wanted, scale it *inversely* as rubber-banding for the bottom half.

---

## 9. Proximity ping

### What the log supports

ADM emits a periodic position dump for every online player:

```
13:00:07 | ##### PlayerList log: 2 players
13:00:07 | Player "LowerMarrow774" (id=13D36C...FAD7 pos=<9958.4, 7440.6, 176.4>)
13:00:07 | Player "YrJustBad"      (id=C87349...1F0A pos=<9959.3, 7441.3, 176.3>)
13:00:07 | #####
```

**Interval: exactly 5 minutes** (`21:14:08, 21:19:08, 21:24:08, …`).

### What this can and cannot detect

At jogging speed a player crosses a 100m-diameter circle in roughly twenty seconds, so
5-minute sampling misses transient passers-by almost every time. What it reliably catches is
anyone who **stays** — five minutes near a pole guarantees appearing in at least one dump.

This is the better alarm. A notification for every fresh spawn jogging past would be noise; the
sampling interval provides free filtering. But the feature must be described accurately to
players: it detects loitering, not perimeter crossing.

**Second channel:** the ~45k event lines carry positions too — shots, hits, building, emotes,
connects. Any *action* within 50m is timestamped at the instant it occurred.

- **Presence** — 5-minute sampling, catches loitering
- **Activity** — event-driven, catches anyone who does something

### Latency

Up to 5 minutes of sampling plus the ingest poll interval: **6–7 minutes worst case.** Useful
for a raid that runs half an hour; too slow for a two-minute flag snatch. This limitation
should be documented for players rather than discovered by them.

`serverDZ.cfg` contains a setting governing the dump interval (300s is evidently the default).
Tightening it to 60s would sharpen the ping substantially. **The exact key name must be
verified before relying on it.**

### Design

- Fires only for UIDs **not** on that faction's roster
- **Cooldown per (player, pole): ~20 minutes.** Without it a pole near a town becomes a firehose
  and players mute the channel
- **Names the intruder** — intel is the point
- Delivered to the faction's private channel, not a DM, so the whole roster sees it

---

## 10. Discord surface

**The bot requires its own guild.** Creating and destroying roles and channels programmatically
inside an established community server risks destroying someone's structure on a single
permissions mistake.

Per faction, the bot manages **one role** and **one private channel** visible only to that role.
Role granted on join, revoked on kick/leave, both destroyed on disband.

### Capacity

Discord allows 500 roles and 500 channels per guild. One map is 33 of each; three maps is 99 —
comfortable. The **50-channels-per-category** limit means one category per map, which is the
desired organization anyway.

### Three failure modes to plan for

**Role hierarchy.** The bot's own role must sit above every faction role or assignment fails
silently. This is a documented setup step, not folklore.

**Name sanitization.** Faction names will contain emoji, unicode, and characters Discord mangles
into collisions — the Legions registry contains names like `ᑲᥣxgһ𝗍` and `(([LC]))`. Channel
names derive from the **tag or faction ID**, never the raw display name.

**Disband cleanup.** Delete the channel rather than archive it. Archiving consumes channel slots
permanently against a pool that recycles, and the flag is returning to the pool regardless.

---

## 11. Public directory

A public web presence covering:

- **Faction directory** — name, tag, flag, armband, member count, state, motto
- **Leaderboard** — rolling 4-weekend rankings with points
- **War log** — the public feed of raids and defenses
- **Flag pool status** — which of the 33 are claimed and which are available
- **Per-faction pages** — roster, raid record, defenses, founding date

The flag-pool page doubles as a recruiting funnel: showing which identities remain unclaimed
drives faction creation, and a per-faction "recruiting" flag replaces ARMX's manually curated
forum.

### Security boundary

**The public site reads from its own projection.** Pole coordinates, proximity pings, and player
positions must be **absent from the read model the web application can access** — not merely
omitted at render time. One careless join would otherwise publish every base location on the
server.

This is the same rule as the raid announcements: name the faction, never the place.

---

## 12. Architecture

### Relationship to `one-life`

**Separate repository, separate deployment.** No shared packages.

**Copy the ADM parser rather than extracting it.** Sharing it couples two independent deploys
for a few hundred lines of regex over a log format that changes roughly once a year. Let the two
copies drift, and revisit only if the same fix is ever applied twice.

What carries over is the *shape*, not the code: **log ingest → event log → projections.**

### Why event-sourced

**Raid credit needs the roster as it was at the moment of the lower.** Event sourcing provides
point-in-time membership directly; the alternative is temporal tables and remembering to query
them correctly at every call site.

**Every rule here is a dial** — rank weighting, dormancy windows, cooldown lengths — and each
will be tuned after watching real players. Replaying the event log to re-derive the leaderboard
under new rules beats migrating a mutated table.

### Projections

| Projection | Contents |
|---|---|
| `flag_pool` | 33 flags per (server, map): unclaimed / held / cooling down |
| `factions` | Identity, state, capital pole coordinates, leader |
| `faction_members` | UID, Discord ID, role, joined timestamp |
| `ceremonies` | Detected ceremonies awaiting claim, with expiry |
| `raid_credits` | Raider → victim, timestamp, weighted points |
| `rankings` | Rolling 4-weekend board |
| `member_cooldowns` | UID → eligible-again timestamp |
| `public_directory` | Coordinate-free read model for the web app |

### Processes

| Process | Responsibility |
|---|---|
| Ingest worker | ADM logs → events |
| Projector | Events → projections |
| Discord bot | Commands, roles, channels, announcements, pings |
| Spawner sync | Regenerate and upload the supply file |
| Web | Public directory |

All against one Postgres instance.

---

## 13. ADM log reference

The grammar this system depends on. All confirmed present in a 72,885-line production export
spanning 2026-07-11 to 2026-08-26.

```
Player "NAME" (id=<40-hex UID> pos=<x, z, altitude>) has raised Flag_<Texture> on TerritoryFlag at <x, altitude, z>
Player "NAME" (id=<40-hex UID> pos=<x, z, altitude>) has lowered Flag_<Texture> on TerritoryFlag at <x, altitude, z>
Player "NAME" (id=<40-hex UID> pos=<...>) placed Flag Pole Kit<TerritoryFlagKit>
Player "NAME" (id=<40-hex UID> pos=<...>) folded Flag Pole
Player "NAME" (id=<40-hex UID> pos=<...>) Built <part> on Flag Pole with <tool>
Player "NAME" (id=<40-hex UID> pos=<...>) Dismantled <part> from Flag Pole with <tool>

##### PlayerList log: N players
Player "NAME" (id=<40-hex UID> pos=<x, z, altitude>)
#####
```

Each flag event supplies **who** (stable UID), **what** (raised/lowered), **which texture**, and
**which pole**. The `at <...>` coordinate is the flagpole's own world position and was
byte-identical across all 14 observed events spanning five weeks and six different players —
which is what makes it usable as a durable primary key.

### Timestamps are server-local, not UTC

**ADM records server-local wall-clock time.** The line prefix `HH:MM:SS` and the
`AdminLog started on YYYY-MM-DD at HH:MM:SS` boot header are both in whatever timezone the
host machine is set to — there is no timezone marker anywhere in the file, and DayZ never
writes UTC.

Measured against the production export's own authoritative ISO timestamps, the three servers
run **three different clocks**:

| Map | Observed offset | Milliseconds to add to local time to get UTC |
|---|---|---|
| Chernarus | UTC+4 | `14400000` |
| Livonia | UTC+7 | `25200000` |
| Sakhal | UTC+7 | `25200000` |

Consequences for everything downstream:

- Any absolute timestamp requires a **per-server clock offset**. It is stored on
  `servers.clock_offset_ms` and applied as `UTC = server-local + clockOffsetMs`.
- That column deliberately has **no default**. A wrong or missing offset is invisible to every
  count-based check: every row still lands, every count still matches, and only the instants
  are hours wrong. Both ingest entry points require the offset explicitly and refuse to start
  without it.
- Cross-server comparisons — raid timelines, rankings, ceremony windows, announcement ordering
  — are only meaningful *after* the offset is applied. Never compare raw ADM times across maps.
- The offsets above are measurements of these particular hosts, not properties of DayZ. A host
  move or a server-side timezone change silently invalidates them, and only a ground-truth
  re-check (see `scripts/backfill.md`) will catch it.

### The off-map sentinel

DayZ writes an unresolved position as a very large negative float, in **full decimal
expansion**:

```
pos=<-340282346638528859811704183484516925440.0, -340282346638528859811704183484516925440.0, 0.0>
```

Not `-3.4e38`, not any other `e`-notation form — 134 such lines appear in the production
export and every one is spelled out in full.

⚠️ There is **no pattern match for the sentinel anywhere in this system.** It is rejected
solely because the value falls far below the coordinate parser's lower bound
(`inMapBounds`, `packages/adm-parser/src/coords.ts`). Anyone adding a sentinel check from a
half-remembered `e`-notation form would write a regex that never matches a single real line,
and anyone widening or removing the lower bound would silently admit sentinel coordinates as
real world positions.

### Known limitation: no destruction events

**ADM logs no base destruction whatsoever.** Zero lines match `destroy` across the full export,
despite 2,223 explosive-related lines. A raid's breach, its loot, and its outcome are all
invisible.

This is why the flag-lower is not merely a scoring convenience — it is **the only raid signal
available.** The design treats it as a first-class event accordingly.

---

## 14. Open decisions

Deliberately unresolved, none blocking:

1. **Supply mechanism** — object spawner JSON vs. barrel + `cfgspawnabletypes` + CE events.
   Pending in-game testing. Sits behind the §8 contract.
2. **Supply package contents** — to be authored in DayZ Editor. Configurable list.
3. **`serverDZ.cfg` PlayerList interval** — verify the key name and whether 60s is achievable.
4. **Raid weekend definition** — day, start, end, timezone. Blocks ranking computation.
5. **`BASE` point value** — arbitrary until there is a reason to prefer a number.
6. **Repository name.** — RESOLVED: `factions`, private, at `submtd/factions`.

## 15. Deferred to v2

Designed against, and additive when wanted:

- **Outposts** — additional registered poles beyond the capital. A new table and a new event
  type, not a rewrite. Deliberately excluded from v1 because a faction with four supply-bearing
  poles shrugs off losing its capital, which inverts the intended stakes.
- **Pending-until-seen membership** — invited members confirmed by presence at the capital pole.
- **Inverse rank scaling on supply packages** — rubber-banding for the bottom half.

---

## 16. Identity linking

Added 2026-08-26, after §§5–6 were found to assume a Discord↔player binding that no section
defined. §5's claim rule ("the claimant's linked UID must be among the participants") and §6's
invite rule ("invitee must have a linked gamertag") both rest on this section.

### Decision

**Emote-sequence verification, Discord-only, bound to the UID.**

A player runs `/link`. The bot privately shows a random ordered sequence of three emotes. The
player performs them in-game, in order. A consumer reading the event log watches for a UID that
completes a live sequence, and binds that UID to the Discord account the challenge was issued to.

### Why emotes

The mechanism is ported from `one-life`, where it is in production. Three properties matter:

1. **It proves control of the character, not knowledge of a name.** Anyone can type someone
   else's gamertag into a form; only the person at the keyboard can make that character salute.
2. **It costs no new pipeline.** ADM logs emotes — verified against the production export:
   2,093 emote lines covering 24 of the 27 tokens in `one-life`'s dictionary. Factions already
   ingests ADM, so this is a parser rule and a consumer, not an integration.
3. **The emote line carries the UID.** `Player "<name>" (id=<40 hex> pos=<…>) performed
   EmoteSalute` — the same identity shape §13 documents for flag lines.

### Divergence from one-life: bind the UID, not the gamertag

`one-life` keys `gamertag_links` on the display name and resolves races with
first-verify-wins on `lower(gamertag)`. Factions must not copy this. Ceremony detection (§5)
identifies participants by **UID**, and a faction roster that keys on names breaks the moment a
player renames. Since the emote line already carries the UID, factions binds
`discord_id → dayz_id` directly.

This removes the name-collision race rather than resolving it, and it removes the gamertag
argument from `/link` — there is nothing for the player to type and nothing for the bot to
trust. The gamertag is still captured, as a display label only.

### Rules

| Rule | Value | Rationale |
|---|---|---|
| Sequence length | 3 emotes, distinct, ordered | 24 safe tokens → 12,144 ordered sequences |
| Challenge expiry | 10 minutes | Long enough to find the emote wheel, short enough to bound guessing |
| Concurrent-sequence collision | Reject issuance of a sequence already outstanding | Two live challenges sharing a sequence would bind the wrong UID |
| Matching | In-order subsequence; non-matching emotes are ignored | A player mis-clicking should not have to restart |
| One UID | One Discord account, and vice versa | Enforced by unique index, not by convention |
| Re-link | Requires unlinking first | Prevents silently moving a roster identity |
| Unsafe emotes | Excluded from the pool | `EmoteSitA` is 77% of all emote lines in the export; `EmoteSuicide` carries a gameplay penalty |

**Verification is a prerequisite for every faction command.** An unlinked Discord account cannot
claim, be invited, or hold a role. This is what makes §6's roster a roster of real players.

### Scope boundary

No Better Auth, no web login, no `user`/`session`/`account` tables. The Discord snowflake is the
identity. The public directory (§11) is read-only and needs no login. Should a members-only web
surface ever be wanted, it arrives as its own decision, not as a dependency carried in advance.

### Guild topology

**One Discord guild, per-map channels.** Commands resolve their map from the channel they are
run in. Every faction-scoped query is therefore keyed by `(guild, map)`, matching the
`(server_id, map)` tenancy §3 already establishes for poles. Identity linking itself is
guild-wide, not per-map: a player's UID is the same on every map.
