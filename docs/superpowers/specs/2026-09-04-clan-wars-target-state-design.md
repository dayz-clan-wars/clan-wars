# Clan Wars — target state, from the field guide — design

**Date:** 2026-09-04
**Covers:** everything the player's field guide promises, mapped onto this codebase: what
already holds, what changes, what is new, and in what order to build it.
**Authority:** `../field-guide/` (published at dayzclanwars.com/guide). Every rule the
product enforces is stated there, for players, in plain language. **If the guide and this
document disagree, the guide wins and this document is wrong.** If this document and any
earlier spec in this directory disagree, this document wins; §2 lists every such point.
**Supersedes:** the parent-level `clan-wars-build-notes.md` (2026-09-04), folded in here and
deleted.
**Builds on:** all fourteen earlier specs. Nothing in them is discarded except where §2 says
so; the code they describe is the starting point, not a reference to copy from.

---

## 1. Purpose and how to read this

The guide was written from scratch with the existing specs as a starting point, not a
constraint. It describes one product: a reputation war between clans on one Livonia server,
where every state change is proved from the server's ADM log, the site is where players
manage, and Discord is where they hear about it.

This document turns the guide into something a plan can be written from. It is organised
so that each section answers one question:

| § | Question |
|---|---|
| 2 | What differs from what the specs and code say today? |
| 3 | Which process owns which responsibility? |
| 4 | What is in the database? |
| 5 | What are the state machines? |
| 6 | Which log line proves which claim? |
| 7 | What runs on a clock, and what does each clock write? |
| 8 | How is the war scored? |
| 9 | What does Discord say, verbatim? |
| 10 | What does the site show and do? |
| 11 | How are player stats derived? |
| 12 | What must be true on the game server? |
| 13 | What tests must exist? |
| 14 | What can go wrong that the code will not tell you about? |
| 15 | In what order is it built? |

Vocabulary: **the guide says "clan"; the code says "faction".** Every player-facing string
— site copy, Discord post, DM, role and channel name — says clan. Table names, package
names and identifiers keep `faction`. Renaming the schema buys nothing and risks the three
scarcity indexes.

Numbers: every timer, cap, radius and cooldown lives in **one** module,
`packages/domain/src/rules.ts`, and nowhere else in code. §13 holds it against the guide's
numbers table.

---

## 2. What changes versus the existing specs and code

Everything not listed here matches the earlier specs and the code as it stands.

| Area | Existing spec / code | Target (guide) |
|---|---|---|
| Vocabulary | "faction" everywhere | **"clan"** in every player-facing string; code keeps `faction` |
| Primary surface | Discord slash commands; site read-only | **The site is the tool.** Roster, vault, map, link, claim, declare, votes, settings — all on the site. Discord is announcements, one text + one voice channel per clan, and DMs. The only slash command left is `/guest` |
| Web write boundary | `packages/roster` exports invite, revokeInvite, kick, promote, demote (frontend rebuild §3) | Same package, same principle, **many more exports** (§10.4). The prohibition is restated precisely: no export sets a clan `active` or `dormant`, writes a raid or a defense, or inserts a declaration without citing evidence the log already holds |
| Link flow | `/link` in Discord, 4 emotes, targeted challenge | **On the site**: gamertag autocomplete over seen-and-unclaimed players → **3** emotes in order → 10 min. Still binds `discord_id → dayz_id`; still targeted; still budgeted |
| Ceremony claim | Discord modal, `claim_drafts` | **On the site** at `/claim/{ceremony}`. Only free flags are offered. Refused within 200 m of another declaration |
| Stake | Identity + supplies; rankings designed, unbuilt | **Reputation is the headline**: raid points, weekly Alphas, season champion. Supplies remain the material stake behind the 24 h flag-down clock |
| Raid → victim | Dormancy is inactivity-only; raid-driven dormancy out of scope | **A non-member lowering the flag starts a 24 h clock.** Re-raise by a member = defense; miss it = dormant. Two entrances to `dormant`, one exit |
| Raid credit | Designed in the master spec (rolling 4 weekends) | **Weekly Alphas** (Mon 00:00 UTC → Mon 00:00 UTC) and a **season** (wipe to wipe). Formula in §8 |
| Raid window | Undefined | **Fri 00:00 UTC → Mon 00:00 UTC**, base damage on. Enforced by the game server config, not by the bot. Non-destructive raids score all week |
| Base declaration | Designed (2026-09-03), publication surface open | **Adopted in full.** Publication = the site map's public-bases layer (login + linked). Plus a new rule: **200 m minimum between declared bases**, with the Fast Travel Hub as a fixed reserved point |
| Reservation and the pole | Pole columns on `factions`, bound at claim | The **reservation inserts the `declarations` row**, so the pole is held for the 24 h and the 200 m check happens at claim time, where the guide says it does |
| Lapsed reservation | Flag returns silently (inbox 36) | **Announced** in `#clan-feed` (`lapsed`). The 3-linked-UID ceremony cost is the spam defence |
| Clan size | No cap (inbox 29) | **10, hard**, leader included. Pending members hold a slot |
| Roster join | Discord-consent | **Pending until seen within 50 m of the pole**, from an invite or a **Request to join** on the directory |
| Leader succession | Designed, unbuilt | **Built as designed**, plus **removal from the guild** transfers at once, plus a **no-confidence vote** |
| Rename / disband and the name | Return to the pool | **Name and tag held until season end** after a rename or a disband. A lapsed reservation returns everything at once — nothing was ever flown under it |
| Roster visibility | Public (deliberate) | Unchanged — and **all player stats public**, friendly fire included |
| Kill parsing | None; bounties and combat-log detection rejected | **Kill, death and session parsing added**, copied from One Life's grammar. Stats only, never points. Bounties still rejected. Combat logging stays a human rule |
| Alliances | Rejected | Still rejected (re-discussed and dropped 2026-09-04) |
| Discord per clan | One text channel + one role | **Text + voice**, in two categories. **Guest pass**: 24 h voice-only per-user overwrite |
| Nicknames | Gamertag sync | Gamertag with a **`[TAG]` prefix** for full members; `@Alpha` role for the weekly top three |
| Feed | One `faction_events` queue to `#🎌-faction-feed` | **Three queues**: `#clan-feed` (identity events, existing table), `#war-log` (raids, defenses, weeks, seasons), and per-clan notices + DMs (§4.7) |
| New surfaces | — | Clan Vault, map pins, intruder layer, build/dismantle alerts, recruiting post + requests, player profiles and boards, Seasons page, travel points layer |
| Fast travel | Exists on the server; undocumented | Guide chapter 11. A static **Travel points** map layer from `fast-travel-points.json`. Position jumps are expected (§14) |
| Fair play | None | A human-enforced chapter. The bot's only role is surfacing dismantle and gate evidence in the clan channel |
| Wipe | Undefined | A **runbook plus an idempotent script**: closes the season, clears every declaration, restarts the launch grace, keeps identities and rosters (§8.5) |

---

## 3. Processes and what each owns

Four processes, all on the single host (`2026-09-03-single-host-deployment-design.md`).
No fifth.

| Process | Owns | Never does |
|---|---|---|
| `apps/ingest-worker` | ADM fetch and parse → `events`; supply file projection and drift detection | Read Discord; write any clan state |
| `apps/bot` | Every clock and every log consumer (§7); every Discord write; the `/guest` command; the guild-member-removed handler | Serve HTTP |
| `apps/web` | Every page; every player-initiated write, through `@factions/roster` only | Import `@factions/db`; set a clan active; write a raid |
| `packages/roster` | The capability package: the reads the site needs and the writes the site is permitted (§10.4) | Export a function that creates a clan without a ceremony, activates one, or binds a pole without evidence |

⚠️ **All new clocks run in the bot.** It is already the single-instance tick host with the
Discord client, and every clock here ends in a Discord write. Splitting clocks across
processes would put two writers on the outbox queues with nothing ordering them. The
worker stays as it is: ingest and supplies.

⚠️ **The bot remains single-instance and nothing enforces it** (inbox 22). Every new tick
inherits the notify-before-mark hazard. Take the advisory lock before adding a second
instance; do not add one before then.

---

## 4. Data model

Column types follow the existing schema: `bigserial` ids, `text` dayz ids and discord ids,
`timestamptz` everywhere, `numeric(12,2)` coordinates. Every table carries `server_id`.
Migrations are generated with drizzle-kit and **read before they go near `factions_live`**.

### 4.1 `declarations` — new; the largest migration in the project

Owns the pole binding. `factions.pole_key`, `x`, `y`, `z` move here (base-declaration §8,
option C).

| Column | Notes |
|---|---|
| `id` | |
| `server_id` | |
| `pole_key` | the `at <…>` coordinate key, as today |
| `x`, `y`, `z` | pole world position |
| `owner_faction_id` | nullable FK `factions.id` |
| `owner_dayz_id` | nullable |
| `evidence_event_id` | nullable FK `events.id` — the raise that justified a solo declaration, a rebind, or a post-wipe rebind |
| `evidence_ceremony_id` | nullable FK `ceremonies.id` — the ceremony behind a reservation |
| `declared_at` | |

Constraints, each of which **is** a rule:

- `check`: exactly one of `owner_faction_id`, `owner_dayz_id` is non-null.
- `check`: exactly one of `evidence_event_id`, `evidence_ceremony_id` is non-null. ⚠️ This is
  how "the site can never bind a pole from nothing" is enforced by the database rather than
  by a code review: there is no way to write the row without citing something the log or
  the ceremony detector already wrote.
- unique `(server_id, pole_key)` — one declared owner per pole; replaces
  `factions_holding_pole_uniq`.
- unique partial `(owner_faction_id) where owner_faction_id is not null` — one base per clan.
- unique partial `(server_id, owner_dayz_id) where owner_dayz_id is not null` — one solo base
  per player (rule 3).

The 200 m rule is **a check inside the inserting transaction, not an index** (it cannot be
one). Every insert: `select … from declarations where server_id = $1 for update` on the
server's rows, compute 2-D distance on `(x, z)` — altitude ignored — against every existing
row **and** against the Hub constant (§4.10), refuse if any is under `MIN_BASE_SPACING_M`.
⚠️ Without the lock two concurrent claims 150 m apart both pass. The lock is per server, which
is coarse and fine: declarations are rare.

`factions` gains no replacement pole columns. Readers that today read `factions.pole_key`
— `LAST_RAISE`, the dormancy store's join, the supply projection, `/faction info` (retired),
the rebind store, ceremony eligibility — join `declarations` on `owner_faction_id`.
⚠️ `events_raise_lookup_idx` must still be the index the dormancy query walks after the
join is rewritten; re-measure with `EXPLAIN ANALYZE` and keep
`dormancy-index-drift.test.ts` green.

### 4.2 `poles` — changed

| Column | Change |
|---|---|
| `grace_until` | **new**, `timestamptz not null`. Set to `first_seen_at + 7 d` when the pole is first seen; reset to `now + 3 d` whenever a declaration on it is released (lapse, disband, rebind away, solo lapse, solo joins a clan, unlink). The launch runbook stamps every existing pole to `launch + 7 d` |

A pole is **public** when `flag_raised`, no `declarations` row exists for it, and
`grace_until < now`. That is a read, not a tick; §10.2's public-bases layer runs it.

⚠️ `poles` is filled by **the bot**, from `events`, through its own consumer
(`pole-tick.ts`, cursor `pole-projector-bot`). `apps/projector`, which used to fill it,
does not run in production and holds zero rows there. The bot's fold writes `poles` only,
never `flag_changes`, and sets `grace_until` on insert alone.
⚠️ A pole that is re-declared during grace and released again gets a fresh 3-day grace.
That is the ping-pong the rebind spec's §2.4 guards against, and the 7-day rebind cooldown
is what stops it; the drift test in the rebind spec's §6 stays.

### 4.3 `factions` — changed

| Column | Change |
|---|---|
| `pole_key`, `x`, `y`, `z` | **dropped** (→ `declarations`) |
| `flag_down_since` | **new**, nullable. Set when a non-member lowers the flag at the declared pole while `active`; cleared by a member's raise (defense) or by the dormancy transition |
| `flag_down_by_dayz_id` | **new**, nullable. Who lowered it, for the notice |
| `dormant_reason` | **new**, nullable, `check in ('raided','inactive')`. Non-null iff `status = 'dormant'` |
| `disband_warned_at` | **new**, nullable. The day-10 warning was sent |
| `next_vote_allowed_at` | **new**, nullable. Set 14 d ahead by a failed vote |
| `recruiting`, `play_window`, `language`, `pitch` | **new**: `boolean not null default false`, three nullable `text`. The recruiting post |
| `discord_role_id`, `discord_text_channel_id`, `discord_voice_channel_id` | **new**, nullable until activation creates them. Today `factions` carries no Discord ids at all; the bot must stop resolving anything by name |

`status` keeps its five values. `HOLDING_STATUSES` (`reserved, active, dormant`) is
untouched, still mirrored by the texture and tag partial indexes and, now, by the
existence of a `declarations` row. `SUPPLIED_STATUSES` is replaced by a predicate:
**supplied iff `status = 'active' and flag_down_since is null`**. The supply projection
reads that predicate; the drift test in `packages/db/test/holding-index-drift.test.ts` is
extended to it.

### 4.4 `identity_holds` — new

Names and tags held until season end after a rename or a disband (guide ch. 8).

| Column | Notes |
|---|---|
| `server_id` | |
| `kind` | `check in ('name','tag')` |
| `value_lower` | `lower()` of the held name or tag |
| `faction_id` | who held it |
| `reason` | `check in ('renamed','disbanded')` |
| `held_until` | the current season's `ends_at`, or the sentinel `'infinity'` until the season is closed — the wipe script rewrites it (§8.5) |

Unique `(server_id, kind, value_lower)`. The name and tag uniqueness check at claim and
rename consults `factions` in a holding status **and** `identity_holds` with `held_until >
now`. ⚠️ A lapsed reservation writes no hold: nothing was ever flown under the name.

### 4.5 Membership — changed and new

**`faction_members`** gains:

| Column | Notes |
|---|---|
| `status` | **new**, `check in ('pending','full') not null` |
| `pending_since` | **new**, nullable; set at accept |
| `seen_at_base_event_id` | **new**, nullable FK `events.id` — the event that promoted them |

`faction_members_server_player_uniq` stays and now also covers pending rows: one clan per
player, pending included. Every existing "is a member" read — `isRosterMember`, the
dormancy attribution, cap counts, vote electorates, vault visibility — means **`status =
'full'`** unless this document says otherwise. The cap counts `full + pending`.

⚠️ The ceremony's three participants are inserted as `full` at activation with
`seen_at_base_event_id` pointing at their own white raise: they were standing at the base.

**`faction_join_requests`** — new: `faction_id, server_id, dayz_id, discord_id, created_at,
expires_at, decided_at, decided_by_discord_id, decision check in ('accepted','declined')`.
Unique partial `(faction_id, dayz_id) where decided_at is null`. Only accepted on a clan
with `recruiting = true`.

**`roster_cooldowns`** unchanged: 3 days on leave or kick, none on disband.

### 4.6 Leadership — new

**`succession_claims`**: `faction_id, claimant_dayz_id, leader_dayz_id, opened_at,
resolves_at (opened_at + 48 h), outcome check in ('succeeded','voided') nullable, closed_at`.
Unique partial `(faction_id) where closed_at is null`.

**`faction_votes`**: `faction_id, nominee_dayz_id, opened_by_dayz_id, leader_dayz_id,
opened_at, closes_at (opened_at + 48 h), electorate_size int, result check in
('passed','failed') nullable, closed_at`. Unique partial `(faction_id) where closed_at is
null` — one open vote per clan.

**`faction_vote_ballots`**: `vote_id, dayz_id, cast_at`. Unique `(vote_id, dayz_id)`. A
ballot is a yes; there is no "no" — a member who does not want the change does not vote.
The electorate is every `full` member except the leader **at open**, stored as
`electorate_size`, and shrinks when a member in it leaves (§5.7).

### 4.7 The three queues — one existing, two new

Every Discord post the bot makes goes through a table first, written **in the same
transaction as the transition it describes**, and is posted by a tick in `id` order. That
is the feed's existing discipline (`2026-09-03-faction-feed-design.md`), applied to
everything.

| Table | Destination | Kinds |
|---|---|---|
| `faction_events` (existing) | `#clan-feed` | `founded, activated, lapsed (new), renamed, rebound, dormant, revived, disbanded` |
| `war_log_events` (new) | `#war-log` | `raid, defense, week_closed, season_closed` |
| `clan_notices` (new) | a clan's text channel, or a DM | every line in §9.3 and §9.4 |

`war_log_events`: `id, server_id, kind, occurred_at, payload, posted_at`. Same shape as
`faction_events` minus `faction_id` (a raid names two clans; both live in the payload).

`clan_notices`: `id, server_id, faction_id nullable, target check in ('channel','dm'),
discord_target_id, kind, occurred_at, payload, posted_at, failed_at, attempts int`.
`discord_target_id` is the channel id or the user id. `faction_id` is null for a solo
declarant's DMs.

Three rules, inherited and extended:

- ⚠️ **`…_no_coordinates`** — the check that rejects `poleKey`, `x`, `y`, `z` keys in
  `payload` — exists on all three tables. A `distance` in metres is allowed (the intruder
  line says "40 m from your base"); a position is not.
- ⚠️ **`faction_events` and `war_log_events` post in `id` order and stop at the first
  failure**, loudly. A blocked public queue is still unalerted (inbox 35) and this design
  does not fix that; it does say so here so nobody assumes it did.
- **`clan_notices` stops per target, not globally.** A deleted clan channel or a user with
  DMs closed must not block every other clan's notices. The poster groups by
  `discord_target_id`, posts each group in `id` order, and marks a row `failed_at` after
  three attempts. DMs to a user who has closed them fail quietly; that is the guide's
  "things that need you" delivered on a best-effort basis, and the site shows the same
  facts.

Lock order (§4.12) puts all three queues last, and they are insert-only, so they never need
to be locked before the roster tables.

### 4.8 Raids and scoring — new

**`seasons`**: `id, server_id, number int, started_at, ended_at nullable,
champion_faction_id nullable`. Unique partial `(server_id) where ended_at is null`.

**`raids`**:

| Column | Notes |
|---|---|
| `season_id`, `server_id` | |
| `victim_faction_id` | |
| `raider_dayz_id` | |
| `raider_faction_id` | nullable — null for a solo raider |
| `first_lower_event_id`, `first_lower_at` | |
| `last_lower_at`, `lower_count` | later lowers inside the window update these and score nothing |
| `points` | recorded at write time, **never recomputed** |
| `victim_rank_at_lower`, `ranked_count_at_lower` | the inputs to `points`, for the war log and audit |
| `week_start` | Monday 00:00 UTC of `first_lower_at` |

Dedup is a query under the victim's `factions` row lock: an open row for the same
`(raider_faction_id, victim_faction_id)` with `first_lower_at > occurred_at − 24 h` absorbs
the lower. For a solo raider (`raider_faction_id is null`) the same rule applies per
`raider_dayz_id`.

**`defenses`**: `faction_id, season_id, raised_by_dayz_id, event_id, flag_down_since,
defended_at, siege_seconds`. One row per flag-down episode that ended in a member's raise.

**`season_standings`**: `season_id, faction_id, points, raids, times_raided, defenses`,
unique `(season_id, faction_id)`. Maintained inside the raid and defense transactions, so a
rank read is one ordered query. ⚠️ It is a projection of `raids` and `defenses`; a rebuild
script exists and the two are held together by a test.

**`alpha_weeks`**: `season_id, week_start, rank (1..3), faction_id, points`. Unique
`(season_id, week_start, rank)` — the idempotency key for week close.

**`season_results`**: `season_id, faction_id, rank, points, raids, times_raided, defenses,
status_at_close`. Written once by the wipe script.

### 4.9 Player projections — new

All rebuilt from `events`; a rebuild script exists for each; none is ever edited by hand.

**`player_sessions`**: `server_id, dayz_id, connected_at, disconnected_at nullable,
close_reason check in ('disconnect','restart') nullable`. An open session is closed at the
next `AdminLog started` boundary with `close_reason = 'restart'`.

**`kills`**: `server_id, event_id, occurred_at, victim_dayz_id, killer_dayz_id nullable,
weapon nullable, distance_m nullable, victim_faction_id nullable, killer_faction_id
nullable, friendly_fire boolean`. `friendly_fire` = both on the same roster as `full`
members at `occurred_at`. Non-player deaths (infected, animals, falls, vehicles) are
recorded as `kills` rows with `killer_dayz_id null` so death counts are honest; PvP counts
filter on a non-null killer.

**`player_positions`**: `server_id, dayz_id, x, z, alt, occurred_at, event_id`. Index
`(server_id, dayz_id, occurred_at desc)`. A reaper keeps **30 days**; the last fix per
player is the newest row, no separate table. ⚠️ Fast travel produces teleports (§14); do
not derive movement from consecutive rows.

**`intruder_sightings`**: `declaration_id, dayz_id, first_seen_at, last_seen_at,
last_alert_at, distance_m`. Unique `(declaration_id, dayz_id)`. Drives the 20-minute alert
cooldown and the 60-minute pin drop-off.

### 4.10 Site-owned tables — new

**`clan_pins`**: `faction_id, dayz_id, x, z, icon check in
('loot','vehicle','enemy','meet','danger','note'), note nullable, created_at, expires_at
(created_at + 7 d)`. Any full member may delete any pin. ⚠️ Pins are the one place a
member-entered coordinate is stored; nothing reads them but the clan's own map.

**`vault_locks`**: `faction_id, name, code char(4), note nullable, min_role check in
('leader','officer','member'), created_by_dayz_id, created_at, rotated_at nullable,
rotated_by_dayz_id nullable, confirmed_at nullable, exposed_at nullable`. `confirmed_at <
rotated_at` (or null) renders "changed in game?". `exposed_at` non-null renders "known to
an ex-member"; set on every lock the leaver's role could see, cleared by rotate.

**`vault_history`**: `lock_id, action check in ('added','edited','rotated','revealed',
'confirmed','deleted'), dayz_id, at`.

**`guest_passes`**: `faction_id, discord_user_id, granted_by_discord_id, granted_at,
expires_at (granted_at + 24 h), revoked_at nullable, converted_at nullable`. Unique partial
`(faction_id, discord_user_id) where revoked_at is null and converted_at is null and
expires_at > now` is not expressible; the grant checks for an open pass under the clan's
row lock instead.

**Hub constant**: `HUB_POSITION = { x: 100, z: 93 }` in `rules.ts`, from
`fast-travel-points.json`. The 200 m check treats it as a declaration that always exists
and is never published.

### 4.11 `verification_challenges` — changed

Sequence length is already **3** (`generateSequence`'s default since targeted linking);
the TTL becomes **10 min** and moves to `rules.ts`. `guild_id` and `channel_id` become
nullable: the site issues challenges, and there is no channel. The emote budget (`MAX_POOL_EMOTES_PER_ATTEMPT`), the safe pool, the
"already linked elsewhere" refusal (inbox 7) and the lockout message naming the unreached
emote (inbox 8) all stay.

### 4.12 Lock order

The existing order is extended, never reordered. Every writer that touches two of these
takes them in this order:

```
factions → declarations → poles → faction_members → faction_invites
  → faction_join_requests
  → faction_votes → faction_vote_ballots → succession_claims
  → season_standings → raids → defenses
  → vault_locks → clan_pins → guest_passes
  → faction_events → war_log_events → clan_notices
```

`declarations` sits immediately after `factions` because activation, rebind and disband
hold the clan row and then touch its declaration. `poles` follows `declarations` because
`releaseTx` takes both, in that order — it deletes the declaration and then stamps the
released pole's grace. The queues are last and insert-only, so
no writer ever needs them locked first. ⚠️ Inbox 19 still stands: nothing enforces this
order but review. Every new writer gets a staged race test (§13).

---

## 5. State machines

### 5.1 Clan

```
                  ceremony detected + claimed on site (declaration inserted, 200 m checked)
  (none) ─────────────────────────────────────────────────────────────────────► RESERVED
                                                                                   │ member raises clan flag at the pole ≤ 24 h
     24 h without activation → LAPSED   (feed: lapsed; declaration released, 3 d grace) │
                                                                                   ▼
        ┌────────────────────────────────────────────────────────────────────── ACTIVE ◄───────────────────┐
        │ non-member lowers flag → flag_down_since set, supplies paused                                  │
        │    member raises ≤ 24 h → DEFENDED  (stays ACTIVE; war-log: defense)                            │ any full member
        │    24 h elapse           → DORMANT (reason: raided)                                            │ raises clan flag
        │ no full-member raise for 7 d → DORMANT (reason: inactive)                                      │ at the pole
        ▼                                                                                                │
     DORMANT ────────────────────────────────────────────────────────────────────────────────────────────┘
        │ 14 d continuous → DISBANDED  (flag to pool; name+tag held; channels deleted; declaration released, 3 d grace)
        │ leader disbands (from ACTIVE or DORMANT) → DISBANDED  (same, no cooldowns)
        │ roster empties (leader removed from guild, nobody left) → DISBANDED
        ▼
    DISBANDED
```

- **Only a full roster member's raise counts** for activation, defense, revive and the
  7-day clock (base-declaration §7, now load-bearing for the raid path too). A non-member's
  raise is a notice (§9.3), never a state change.
- The 7-day inactivity clock measures `max(occurred_at)` of `flag.raised` at the declared
  pole with the clan's texture **by a full member**, coalesced with `activated_at`, the
  season's `started_at`, and `created_at`. It pauses while the server is dark (existing
  liveness guard). It keeps running while `flag_down_since` is set — a raided clan that
  ignores the raid for 24 h is dormant either way.
- `dormant_reason` is a column, not two statuses, so `HOLDING_STATUSES` and its indexes are
  untouched.
- **Dormant clans are not raidable.** A `flag.lowered` at a dormant clan's pole writes no
  raid and no notice beyond the ordinary non-member-at-your-pole intel.
- Revive clears `dormant_since`, `dormant_reason`, `flag_down_since` and
  `disband_warned_at`; supplies resume at the next restart via the projection.
- **Lapse** releases the declaration and writes no `identity_holds`.

### 5.2 Base (a pole)

```
 first flag event at pole ──► UNDECLARED (grace_until = first_seen + 7 d)
   UNDECLARED ──declared (reservation / solo declare / rebind target / post-wipe raise)──► DECLARED
   UNDECLARED ──grace_until passes──► PUBLIC (a read, not a transition)
   DECLARED ──released──► UNDECLARED (grace_until = now + 3 d)
   PUBLIC ──declared──► DECLARED
```

Releases: reservation lapse, disband, rebind away, solo lapse (7 d without the declarant's
raise), solo joins a clan, solo unlinks. Each sets `grace_until` and deletes the row in one
transaction.

**Solo declare** offers only poles where `events` holds a `flag.raised` by the caller's
UID; the chosen event becomes `evidence_event_id`. **Solo lapse** runs in the dormancy
tick: no `flag.raised` by the declarant at that pole for 7 days. Raising again inside the
3-day grace re-declares it from the site with the new raise as evidence; the site shows
"your declaration lapsed — raise and re-declare" rather than doing it silently.

**Ceremony eligibility** (relaxed by one word, base-declaration §4): the pole is unbound,
**or declared to one of the participants**. A pole bound to a clan is never eligible.

### 5.3 Membership

```
 (none) ──invite accepted / request accepted──► PENDING ──any event by the UID within 50 m of the pole──► FULL
 PENDING ──7 d without being seen──► (none)          FULL ──leave / kick──► (none) + 3 d cooldown
 FULL(member) ──promote──► FULL(officer) ──demote──► FULL(member)
 FULL(any) ──transfer / vote passed / succession / leader removed──► LEADER
```

- Cap: refuse an invite or a request acceptance when `full + pending >= 10`.
- One clan per player, pending included (`faction_members_server_player_uniq`).
- Presence: the player tick checks every new event carrying a `pos` for a pending member's
  UID against their clan's declaration; within `JOIN_PRESENCE_RADIUS_M` (50) promotes them,
  writes the role and channel grants, and posts the roster line. ⚠️ `pos` is `<x, z, alt>`;
  `at` is `<x, alt, z>`. Compare `x` with `x` and the pole's `z` with the position's second
  field.
- Leave and kick: 3-day cooldown; every vault lock the leaver could see gets `exposed_at`;
  Discord role and nickname prefix removed; if the leaver was in an open vote's electorate,
  `electorate_size` decrements.
- Joining a clan releases the joiner's solo declaration in the same transaction as the
  promotion to `full` (base-declaration §5.1). ⚠️ Not at accept: a pending member who never
  shows up keeps their solo base.

### 5.4 Leadership

- **Transfer**: leader → any full member, with a confirmation step on the site. Refused
  while a vote is open.
- **Succession by silence**: eligible when the leader's UID has no event in 7 days. An
  officer may claim; any full member if the clan has no officers. Opens a 48 h claim. Any
  later event by the leader's UID voids it (the player tick checks open claims against each
  new event). At `resolves_at` without a leader event, the claimant becomes leader and the
  old leader becomes a member.
- **Leader removed from the guild** (`guildMemberRemove`, ban or leave): remove them from
  the roster at once, no cooldown for anyone. Leadership passes to the longest-tenured
  officer by `joined_at`, else the longest-tenured full member; if nobody is left, disband.
  ⚠️ This is the one roster write that originates from a Discord gateway event rather than
  the log or the site. It goes through `packages/roster`'s internal store, not through an
  export the web can reach.
- **Removal from the guild for anyone else**: remove from the clan (as a leave, with the
  cooldown — they cannot rejoin anyway), delete their identity link, release their solo
  declaration. The guide: "being removed from the Discord removes you from everything".

### 5.5 Link challenge

```
 (none) ──site picks a seen, unclaimed gamertag──► OPEN (3 emotes, 10 min)
 OPEN ──3 matched in order──► COMPLETED (identity_links row; Linked role; nickname)
 OPEN ──10 min──► EXPIRED     OPEN ──budget exceeded──► CANCELED (lockout DM names the emote)
 OPEN ──target UID already linked elsewhere──► REFUSED at issue time (never issued)
```

Copy One Life's page behaviour (autocomplete, ticket per emote, 5 s poll while open). Keep
this project's verifier: the emote consumer in the player tick, the budget, the safe pool
and its caveats (inbox 27). ⚠️ The autocomplete lists `players` rows with no
`identity_links` row — "gamertags the server has seen that nobody has claimed". A player
who has never connected is not offered; the guide tells them to play a session first.

Unlink: refused while a roster row (pending or full) exists; releases a solo declaration;
a later link to a different UID is a new profile.

### 5.6 Guest pass

```
 officer grants (site or /guest) ──► ACTIVE (per-user overwrite: View Channel + Connect on the clan's voice channel)
 ACTIVE ──24 h──► EXPIRED (overwrite removed by the reaper)
 ACTIVE ──user becomes a full member──► CONVERTED (overwrite removed; role carries the access)
```

Do the Discord write before marking the row; tolerate a missing overwrite on reap. ⚠️
Overwrites accumulate if the reaper dies; on startup the bot reconciles every clan voice
channel's overwrites against open passes and removes strays.

### 5.7 No-confidence vote

```
 full member nominates (self allowed) ──► OPEN (48 h; electorate = full members except leader, at open)
 OPEN ──ballots ≥ ceil(2/3 × electorate_size)──► PASSED (nominee leader; ex-leader officer)
 OPEN ──48 h, or threshold unreachable──► FAILED (next_vote_allowed_at = now + 14 d)
```

- While open: `kick` and `transfer` refuse (§10.4 enforces this in the package, where both
  the bot's guild-removal path and the site can see it). Invites still work; arrivals are
  not in the electorate.
- A leaver in the electorate decrements `electorate_size`; the threshold is re-evaluated on
  every ballot and every leave. It never grows.
- `openVote` refuses when `next_vote_allowed_at > now`, when a vote is open, or when the
  nominee is the leader.
- The base declaration does not move: it is the clan's.

### 5.8 Raid and defense (the flag-down clock)

```
 ACTIVE, flag up ──non-member lowers at declared pole──► FLAG DOWN (flag_down_since; supplies paused; raid row; war-log: raid; notices)
 FLAG DOWN ──full member raises ≤ 24 h──► ACTIVE (defenses row; war-log: defense; notice)
 FLAG DOWN ──24 h──► DORMANT (reason raided; notice)
 FLAG DOWN ──non-member lowers again──► FLAG DOWN (the raid row absorbs it if inside its 24 h; a different clan's lower is a new raid row)
```

⚠️ A member's raise during FLAG DOWN is a defense even if the same raider lowers it again a
minute later: the defense counts, and the second lower is the same raid for scoring. Both
`defenses` and the raid row's `lower_count` record the truth.

---

## 6. What the log can and cannot see

All from the ADM grammar in the master spec §13 and One Life's parser. Every regex anchors
on the identity group `(id=[0-9A-F]{40}…)`; **gamertags are attacker-controlled** (inbox 1).

| Guide claim | Evidence line | Notes |
|---|---|---|
| Ceremony | `has raised/lowered Flag_White on TerritoryFlag at <x,alt,z>` ×3 UIDs in 10 min | pole key from `at`; participant UID from `(id=…)`; existing detector |
| Activation / defense / revive / upkeep | `has raised Flag_<Texture> on TerritoryFlag at <…>` | raiser must be a **full** member at `occurred_at`; texture must be the clan's; pole must be its declaration |
| Raid | `has lowered Flag_<Texture> …` by a non-member at a declared clan pole while `active` | the only raid signal that exists |
| Presence at base (join) | any line with `pos=<x, z, alt>` for the UID within 50 m of the declaration | `pos` and `at` have different orders — never mix |
| Intruder | `PlayerList` fix within 100 m of a declaration by a non-full-member | 5-minute cadence; 6–7 min worst-case latency |
| Dismantle / gate | `Dismantled <part> from <structure> with <tool>` / `Built Gate on <structure> …` | ⚠️ verify the exact gate line against the live log before shipping the alert; attribute to the declaration whose 100 m zone contains `pos` |
| Kills, deaths | `Player "V" (DEAD) (id=…) killed by Player "K" (id=…) with <weapon> from <d> meters` / `… (DEAD) (id=…) killed by <Entity>` / bare `(DEAD)` | One Life's `KILL_RE`, `DEATH_RE`, `WEAPON_RE`, entity dictionary; re-anchor on the id group |
| Play time | `is connected` / `has been disconnected`; `AdminLog started` closes open sessions | One Life's `CONNECTED_RE`, `DISCONNECT_RE`, `HEADER_RE` |
| Emotes (link) | `performed Emote<X>` | existing parser and budget |
| Fast travel | `was teleported from: <…> to: <…>. Reason: …` | recorded as an event; **not** an intruder, kill or session signal |
| Flag expiry | **not logged** | silence is the signal; hence the 7-day clock |
| Base damage, loot, breach | **not logged** | hence "the lower is the raid" |

Timestamps are server-local; `servers.clock_offset_ms` applies. The off-map sentinel is
rejected by bounds, not by pattern. Both unchanged.

`EventType` today: `flag.raised`, `flag.lowered`, `flagpole.placed`, `flagpole.folded`,
`flagpole.built`, `flagpole.dismantled`, `player.position`, `emote.performed`. New:
`player.connected`, `player.disconnected`, `player.killed`, `player.died`,
`player.teleported`, `base.built`, `base.dismantled` — the last two for parts of anything
that is not a flagpole, which the existing `flagpole.*` parser deliberately ignores.

---

## 7. Clocks and consumers

Every item runs in `apps/bot` under the existing `guardedRunner` (overlapping runs are
skipped, silently — §14). Log consumers use `consumer_cursors` and are idempotent by event
id; clock ticks are idempotent by the key named.

| Tick | Cadence | Reads | Writes | Idempotency |
|---|---|---|---|---|
| ceremony (existing) | 10 s | `events` flag lines | `ceremonies`, DMs | ceremony row per (pole, window) |
| activation + lapse (existing, changed) | 10 s | `events` raises by full members at reserved declarations | `factions.status`, `faction_members` full, Discord role + text + voice channel, `faction_events` activated / lapsed, `poles.grace_until` on lapse | status transition |
| **raid consumer** (new) | 10 s | `flag.lowered` at a declared active clan pole by a non-full-member | `raids` (or absorb), `season_standings`, `factions.flag_down_*`, `war_log_events` raid, `clan_notices` flag-down (channel + every member DM) | `raids.first_lower_event_id` unique |
| **defense consumer** (new) | 10 s | `flag.raised` by a full member at the declaration while `flag_down_since` set | `defenses`, `season_standings`, clear `flag_down_*`, `war_log_events` defense, `clan_notices` defended | `defenses.event_id` unique |
| dormancy (existing, changed) | 60 s | last full-member raise per clan; `flag_down_since + 24 h`; solo declarants' last raise | `dormant` with reason; solo lapse (release + grace); `faction_events` dormant; notices | status transition |
| **revive** (existing, changed) | 10 s | `flag.raised` by a full member at a dormant clan's declaration | `active`; `faction_events` revived; notice | status transition |
| **disband warning + disband** (existing, changed) | 60 s | `dormant_since + 10 d` (warn), `+ 14 d` (disband) | `disband_warned_at`; `disbanded`, `identity_holds`, release, delete channels, `faction_events` disbanded | columns / status |
| **presence** (new) | 10 s | events with `pos` for pending members' UIDs | `faction_members.status = full`, role, nickname, notice | `seen_at_base_event_id` |
| **intruder** (new) | 10 s | `player.position` (PlayerList) fixes within 100 m of any declaration by a non-full-member (pending and guests included) | `intruder_sightings`, `clan_notices` (first sighting, then one per 20 min per (player, pole)); DM for a solo declarant | sighting row + `last_alert_at` |
| **base alerts** (new) | 10 s | `base.dismantled`, `base.built` (gate) inside a declaration's 100 m zone by a non-full-member | `clan_notices` | event id |
| **non-member raise / colors elsewhere** (existing, changed) | 10 s | `flag.raised` by a non-member at a declaration; the clan's texture raised at a pole that is not its declaration | `clan_notices` (both); a full member's raise elsewhere is instead a **rebind proposal** (existing store) + notice | event id |
| rebind (existing, changed) | 10 s + on confirm | proposal expires 24 h after the raise; confirm on the site | `declarations` moved (200 m checked), old pole `grace_until = now + 3 d`, `rebound_at`, `faction_events` rebound | proposal id |
| **succession** (new) | 60 s | open claims vs. the leader's latest event; `resolves_at` | leader change or `voided`; notices | claim row |
| **votes** (new) | 60 s + on ballot | `closes_at`, threshold | `result`, leader change, `next_vote_allowed_at`; notices | vote row |
| **reapers** (new, one tick) | 5 min | invites, requests, pending members (7 d); pins (7 d); guest passes (24 h); positions (30 d); intruder pins (60 min without a fix) | deletes / expiries; overwrite removals | row state |
| **sessions + kills consumer** (new) | 10 s | connect / disconnect / header / kill / death events | `player_sessions`, `kills` | event id |
| **positions consumer** (new) | 10 s | every `pos`-bearing event | `player_positions` | event id |
| **week close** (new) | 60 s | `now >= week_start + 7 d` and no `alpha_weeks` rows for it | `alpha_weeks`, `@Alpha` role reassignment, `war_log_events` week_closed | `(season_id, week_start)` |
| feed posters (existing + 2 new) | 5 s | the three queues | Discord; `posted_at` | row |
| nickname sync (existing, changed) | on `guildMemberUpdate` + hourly | link + roster | nickname `[TAG] gamertag`, truncated to Discord's 32 chars from the gamertag end | — |
| supplies (existing, worker) | per sweep | supplied predicate (§4.3) + `declarations` coordinates | supply file | hash |

⚠️ **Week close must not double-post or skip across a restart at Monday 00:00 UTC.** The
tick computes the last closed week from `alpha_weeks`, closes every week between it and
now in order (a bot down for two weeks closes two weeks, both posted, both correct), and
inserts under the unique key so a crash after posting cannot post again. Post **after**
the insert commits — the feed's notify-before-mark hazard, inverted on purpose because
here a missed post is recoverable from the table and a double post is not.

⚠️ A week with **no** scoring raids still closes: it writes zero `alpha_weeks` rows and one
`week_closed` event saying so ("no Alphas this week"). Otherwise the idempotency key is
absent and the tick re-examines the week forever.

---

## 8. Scoring

### 8.1 Points

```
ranked        = clans with status = active and season points > 0
N             = count(ranked)
r             = victim's rank among ranked at the moment of the lower (1 = top)

points(victim ranked, N > 1) = 100 × (2 − (r − 1) / (N − 1))     → 200 at #1, 100 at #N
points(victim ranked, N = 1) = 200
points(victim unranked)      = 100                                 → active, no points yet this season
```

Computed and stored on the `raids` row at write time from `season_standings` under the
victim's row lock. Never recomputed from today's ladder. Rounded to the nearest integer.

Rank order: points desc, `times_raided` asc, `activated_at` asc.

### 8.2 Credit

- Raider in a clan: `raider_faction_id` scores `points`; the raider's profile gains a raid
  credit.
- Solo raider: the raid is written and announced, the victim's clock starts, `points = 0`,
  `raider_faction_id null`. The victim's `times_raided` still increments.
- Dedup: one row per `(raider_faction_id, victim_faction_id)` per 24 h from the first lower.
  A different clan lowering it is a different raid.
- No raid: the lowerer is a full member of the victim (upkeep); the pole is undeclared;
  the clan is reserved or dormant; the pole is a solo declaration.

### 8.3 The week

Monday 00:00 UTC to Monday 00:00 UTC. At close, the top three by **points scored that
week** (`sum(raids.points) where week_start = …`, ties by §8.1's order) are the Alphas:
`alpha_weeks` rows, the `@Alpha` role reassigned to their full members, a badge on the
directory, scoreboard and clan page, and the result in `#war-log`. Fewer than three if
fewer scored.

### 8.4 The season

Wipe to wipe. Rank is season points. At close: `season_results` snapshot, `champion` on
the `seasons` row, the Seasons page, each clan's placement on its page, `#war-log`. Points
reset by opening a new season; `season_standings` rows for the new season start empty.

### 8.5 The wipe — runbook plus script

The wipe is the one thing the server owner schedules. `scripts/wipe.ts`, run **after** the
game server's wipe and before the bot restarts, in one transaction, idempotent by the
season it closes:

1. Close the open season: write `season_results` from `season_standings`, set `ended_at`
   and `champion_faction_id`, queue `season_closed`.
2. Rewrite every `identity_holds.held_until = 'infinity'` for this server to `ended_at` —
   holds end with the season.
3. Delete every `declarations` row on the server (clan and solo); do not touch `factions`.
4. Stamp every `poles` row `grace_until = wipe_at + 7 d`; reset `flag_raised = false`.
5. Clear every clan's `flag_down_*`, `disband_warned_at`; delete every `clan_pins` row;
   delete every `intruder_sightings` row.
6. Open the next season with `started_at = wipe_at`.

After the wipe, **a clan with no declaration binds one on the first `flag.raised` of its
texture by a full member at any pole** — the raise consumer handles it: 200 m checked, no
rebind cooldown, no confirmation, evidence = the raise. Solos re-declare on the site. The
7-day inactivity clock runs from `seasons.started_at` (the coalesce in §5.1). Dormant clans
stay dormant and their disband clock keeps running. Rosters, identities, the vault, and
cooldowns are untouched.

---

## 9. Discord

### 9.1 Structure

One guild, configured by env: `DISCORD_GUILD_ID`, `WAR_LOG_CHANNEL_ID`,
`CLAN_FEED_CHANNEL_ID`, `CLAN_TEXT_CATEGORY_ID`, `CLAN_VOICE_CATEGORY_ID`, `LINKED_ROLE_ID`,
`ALPHA_ROLE_ID`. ⚠️ All live in `.env`, not on a command line (the `BOT_FEED_CHANNEL_ID`
lesson). The bot refuses to start with any missing.

Per clan, created at activation and deleted at disband: one role (`@{name}`), one text
channel `#clan-{tag}` in the text category and one voice channel `{TAG}` in the voice
category, both visible only to the role. `discord_*_id` columns on `factions` record them.

Roles: `@Linked` (on link, removed on unlink), one per clan (full members only), `@Alpha`
(reassigned at week close).

Nicknames: the gamertag, prefixed `[TAG] ` for full members. `guildMemberUpdate` reverts a
manual change. Truncate the gamertag, never the prefix, to fit 32 characters.

**Commands.** `/guest @user` (officer+, in a clan channel) grants a guest pass. Every other
existing command (`/link`, `/faction …`, roster and rebind commands) is retired in one
step and, until removed from the application, answers ephemerally with **one line and a
link**: `Manage this on the site: {link}`.

### 9.2 Public channels — verbatim

`#war-log` (`war_log_events`):

| Kind | Text |
|---|---|
| raid (clan) | `⚔️ **{raider_clan}** raided **{victim_clan}** — flag lowered by {gamertag}` |
| raid (solo) | `⚔️ **{victim_clan}** was raided — flag lowered by {gamertag} (no clan)` |
| defense | `🛡️ **{victim_clan}** raised their colors again — {duration} under siege` |
| week_closed | `🏆 Alphas this week: **{1}**, **{2}**, **{3}** — {p1} / {p2} / {p3}` (or `🏆 No Alphas this week — nobody scored.`) |
| season_closed | `🏁 Season {n} is over. Champion: **{clan}** with {points}. Full table: {link}` |

`#clan-feed` (`faction_events`, every embed carrying the flag thumbnail via the existing
`FLAG_IMAGE_BASE_URL` resolver):

| Kind | Text |
|---|---|
| founded | `🏳️ **{name}** [{tag}] has claimed the {flag} flag. 24h to raise it.` |
| activated | `🚩 **{name}** [{tag}] raised the {flag} flag. They're in.` |
| lapsed | `⌛ **{name}** [{tag}] never raised their flag. {flag} is back in the pool.` |
| renamed | `✏️ **{old}** is now **{new}** [{tag}].` |
| rebound | `📦 **{name}** moved house.` |
| dormant | `💤 **{name}** has gone dormant.` |
| revived | `☀️ **{name}** is back.` |
| disbanded | `🪦 **{name}** disbanded. {flag} is back in the pool.` |

⚠️ `dormant` posts publicly for both reasons. The guide lists "dormant" among `#clan-feed`
kinds without qualification, and the directory and scoreboard show the mark anyway. The
build notes' instinct to hide inactivity dormancy is overruled by the guide.

### 9.3 Clan channel — verbatim (`clan_notices`, target `channel`)

| Kind | Text |
|---|---|
| flag_down | `🚨 Your flag is down — lowered by {gamertag}{ of raider_clan}. Re-raise within 24h or go dormant. Supplies paused.` |
| defended | `🛡️ {gamertag} raised the flag. Defended — {duration} under siege. Supplies resume at next restart.` |
| dormant_raided | `💤 24 hours passed. You're dormant. Any member raising the flag brings you back.` |
| dormant_inactive | `💤 No member has raised the flag in 7 days. You're dormant. Supplies stopped.` |
| revived | `☀️ {gamertag} raised the flag. You're active again.` |
| disband_warning | `⚠️ 4 days until this clan is disbanded and the flag returns to the pool.` |
| intruder | `👁 {gamertag} (not a member) was seen {distance} m from your base — {age}` |
| non_member_raise | `⚑ {gamertag} (not a member) raised your flag at your base — {age}` |
| dismantle | `🔧 {gamertag} (not a member) dismantled {part} at your base — {age}` |
| gate_built | `🔧 {gamertag} (not a member) built a gate at your base — {age}` |
| colors_elsewhere | `🏴 Your flag is flying at a pole that isn't yours — raised by {gamertag}` |
| rebind_proposed | `📦 {gamertag} raised our flag at a new pole. Leader: confirm the move within 24h: {link}` |
| rebind_confirmed | `📦 Moved. Supplies follow at the next restart. The old base goes public in 3 days.` |
| leader_removed | `👑 {old} is no longer in the Discord. {new} is now leader.` |
| joined | `➕ {gamertag} joined — pending until seen at the base` |
| became_full | `✅ {gamertag} is now a full member (seen at the base)` |
| left | `➖ {gamertag} left` |
| kicked | `🥾 {gamertag} was kicked by {officer}` |
| promoted / demoted | `⬆️ {gamertag} promoted to officer` / `⬇️ {gamertag} demoted to member` |
| transferred | `👑 {gamertag} is now leader (transferred by {old})` |
| succession_claimed | `⏳ {gamertag} has claimed leadership — {leader} has 48h to show up in game` |
| succession_voided | `⏳ {leader} showed up in game. The claim by {claimant} is void.` |
| succession_done | `👑 {gamertag} is now leader (succession)` |
| vote_opened | `🗳️ Vote opened: replace {leader} with {nominee}. Closes {time}. Vote on the site: {link}` |
| vote_passed | `🗳️ Vote passed ({yes}/{n}). {nominee} is now leader; {old} stays as officer.` |
| vote_failed | `🗳️ Vote failed ({yes}/{n}). Next vote possible {date}.` |
| codes_rotated | `🔐 Codes rotated by {gamertag} — see the vault.` |
| guest | `🎟️ {officer} gave {user} a 24h voice guest pass.` |
| renamed | `✏️ We are now **{new}** [{tag}].` |

`{age}` is relative ("6 min ago"); `{duration}` is `Nh Nm`. Intruder alerts: first sighting
inside 100 m, then at most one per `(player, pole)` per 20 minutes.

### 9.4 DMs — verbatim (`clan_notices`, target `dm`)

| Kind | Text |
|---|---|
| ceremony_detected | `A ceremony was detected at your pole with {n} linked players. Claim it within 24h: {link}` |
| invited | `**{clan}** invited you. Accept or decline: {link}` |
| request_accepted | `**{clan}** accepted your request. Go stand at the base to become a full member.` |
| request_declined | `**{clan}** declined your request.` |
| pending_expired | `Your spot in **{clan}** expired — you were never seen at the base.` |
| flag_down | same text as the channel line, to every full member |
| linked | `Linked. You're **{gamertag}**.` |
| link_refused_elsewhere | `That gamertag is already linked to a different Discord account. If that's you, unlink there first.` |
| link_lockout | `You performed {n} emotes without reaching **{emote}**. Try a new sequence: {link}` |
| kicked | `You were removed from **{clan}**. You can join a clan again on {date}.` |
| codes_rotated | `**{clan}** rotated its codes. See the vault: {link}` |
| solo_intruder / solo_non_member_raise / solo_dismantle / solo_gate | the §9.3 lines, addressed to a solo declarant |
| solo_lapsed | `Your base declaration lapsed — no raise in 7 days. The pole goes public in 3 days unless you raise there and declare again: {link}` |

### 9.5 Never posted anywhere

Any coordinate or position. Any vault code. A pin. A private base. The guide's privacy
rules are enforced by the three `no_coordinates` checks and by the absence of any read in
the bot that returns a position for posting.

---

## 10. The site

### 10.1 Rendering and access

Every page that depends on who is looking renders **from the session at request time**,
after the middleware (frontend rebuild §7). Three access levels:

| Level | Requirement |
|---|---|
| public | none |
| linked | signed in with Discord, in the guild, and holds an `identity_links` row |
| clan | linked, and a `full` roster row; officer and leader gates as noted |

A pending member is **not** a clan-level viewer: no channel, no map, no vault until seen at
the base. The guide is explicit.

### 10.2 Routes

**Public**

| Route | Shows |
|---|---|
| `/` | pitch, Discord CTA, login |
| `/scoreboard` | season table: rank, flag, clan, points, raids, times raided, defenses, active/dormant, Alpha badge |
| `/alphas` | week by week, top three |
| `/seasons` | every closed season's final table and champion |
| `/war-log` | raids and defenses, newest first, from `raids` and `defenses` (not from the Discord queue) |
| `/clans` | directory: recruiting clans first with play window, language, pitch; every clan with flag, tag, status, Alpha badge; the flag pool (33: taken / free) |
| `/clans/{tag}` | flag, armband, founded, status, season placements, Alpha weeks, stats (raids, defenses, longest siege, days held), roster (gamertag, rank, raid credits), recruiting post, **Request to join** (linked, not in a clan, off cooldown) |
| `/players` | boards: raiders, killers, K/D (≥ 10 kills), play time, friendly fire; per season and all-time |
| `/players/{gamertag}` | play time, sessions, last seen, PvP kills and deaths, K/D, killed-by and killed lists (names only), friendly-fire kills and deaths, raid credits, upkeep raises, clan history |
| `/guide` | the field guide, served static |

**Linked**

| Route | Does |
|---|---|
| `/link` | autocomplete → challenge → three emote tickets ticking off → linked. Shows "already linked elsewhere" at pick time |
| `/me` | your link, your clan or solo base, unlink (refused while in a clan), cooldowns, open invites |
| `/map` | §10.3 |
| `/base` | solo: declare (choose from poles you have raised at), release, re-declare after a lapse |
| `/claim/{ceremony}` | name, tag, flag picker (free flags only), roster prune → reserve. Refuses within 200 m with the guide's wording |

**Clan**

| Route | Gate | Does |
|---|---|---|
| `/clan` | full | roster with last seen; pending members; invites out and requests in (officer+ act); leave; open vote / cast ballot; succession claim when eligible |
| `/clan/vault` | full | locks by rank; tap to reveal; rotate one or all; confirm; history (leader); ex-member badges |
| `/clan/board` | full | the player boards filtered to the roster |
| `/clan/settings` | officer+ | recruiting post; guest passes |
| `/clan/settings` | leader | rename; transfer (with confirmation); rebind confirm; disband (with confirmation) |

### 10.3 The map

Leaflet, Livonia, full screen, phone first; the tile pyramid mirrored as One Life does it.
Layers, each a switch:

| Layer | Who | What |
|---|---|---|
| You | linked | your last known fix and its age |
| Your base | clan, or solo declarant | your declaration and its 100 m watch circle |
| Clanmates | clan | every full member's last fix, name, age; dimmed past 24 h |
| Intruders | clan, or solo declarant | `intruder_sightings` with `last_seen_at` within 60 min; moves every fix |
| Public bases | linked | every public pole (§4.2) with its flying texture |
| Pins | clan | `clan_pins`; press-and-hold to drop; anyone in the clan deletes |
| Travel points | linked | the 209 points from `fast-travel-points.json`, one icon |
| Terrain | linked | grid, towns, roads |

Rules the map keeps: every fix shows its age; no trails; no position of anyone outside your
clan except intruders in your own zone; `Cache-Control: no-store, private` on every
position response; ownership as a WHERE predicate, never a post-filter (One Life's four
rules, adopted whole). Dormant clans keep their map.

### 10.4 `packages/roster` — the capability package

`apps/web` imports `@factions/roster` and never `@factions/db`. The package exports:

**Reads**: the viewer's link and clan; a roster; the directory; a clan page; the scoreboard,
alphas, seasons, war log; player profiles and boards; map state scoped to the viewer;
vault state scoped to the viewer's role; open votes, claims, invites, requests.

**Writes**, every one appending its notice or feed row in the same transaction:

| Group | Exports |
|---|---|
| link | `startLink`, `cancelLink`, `unlink` |
| founding | `claimCeremony` (→ `reserved`, inserts the declaration citing the ceremony) |
| base | `declareSolo` (cites a raise by the caller), `releaseSolo` |
| roster | `invite`, `revokeInvite`, `acceptInvite`, `declineInvite`, `requestJoin`, `decideRequest`, `leave`, `kick`, `promote`, `demote`, `transfer`, `disband`, `rename` |
| leadership | `claimSuccession`, `openVote`, `castVote` |
| rebind | `confirmRebind` (moves the declaration citing the proposal's raise) |
| vault | `addLock`, `editLock`, `deleteLock`, `revealLock`, `rotateLocks`, `confirmLock` |
| map | `dropPin`, `deletePin` |
| settings | `setRecruitingPost`, `grantGuestPass` |

It exports **no** function that sets a clan `active` or `dormant`, writes a `raids` or
`defenses` row, inserts a `declarations` row without an `evidence_*` id, or creates a
`factions` row without a `ceremonies` row in `detected` status. `smoke.test.ts` is
rewritten to the capability rule and asserts those absences by name.

⚠️ The vote freeze (§5.7), the cap (§5.3), the cooldowns, the 200 m rule and the
name/tag hold are all enforced **inside the package's writes**, not in the UI, because the
bot's guild-removal path shares the store. A rule that lives in a page component is a rule
the bot does not know.

---

## 11. Player stats

Projections over `events` (§4.9), exposed per season and all-time:

| Stat | Derivation |
|---|---|
| play time, sessions, last seen | `player_sessions`; last seen = newest event for the UID |
| PvP kills / deaths / K/D | `kills` with non-null killer; K/D shown on boards at ≥ 10 kills |
| killed-by / killed lists | `kills` grouped by the other party, names only |
| friendly-fire kills / deaths | `kills.friendly_fire` |
| raid credits | `raids` by `raider_dayz_id` |
| upkeep raises | `flag.raised` by the player at their own clan's declaration with the clan's texture while a full member |
| clan history | `faction_members` history — kept by never deleting rows: `left_at nullable` is added and every "removal" sets it. `faction_members_server_player_uniq` and `faction_members_uniq` become partial on `left_at is null` |

⚠️ That last line is a schema change to an existing table with a unique index the roster
code depends on. It belongs in the membership increment (§15), not the stats one, so the
stats increment never has to touch roster invariants.

Kills are stats, never points. There is no path from `kills` to `season_standings`.

---

## 12. Game-server configuration

| Setting | Value | Owner |
|---|---|---|
| `cfggameplay.json → GeneralData.disableBaseDamage` | `false` Fri 00:00 UTC → Mon 00:00 UTC, `true` otherwise; a restart applies it | **manual, twice weekly, by runbook** `docs/deploy/raid-window.md`. ⚠️ The supplies spec refused to write this file because a bad write breaks the map for everyone. If it is ever automated: write that one key only, round-trip the JSON, schedule the restart at the boundary, keep last-known-good |
| `objectSpawnersArr` → `custom/faction-supplies.json` | as today | one-time manual edit |
| `FlagRefreshMaxDuration` | 7 days | the guide's 7-day clocks assume it; a change here is a guide change |
| central economy | 33 claimable flags at `nominal 0`; `Flag_White` nominal raised | as today |
| fast travel (`pra-teleport-hub.json`) | as deployed | `fast-travel-points.json` is derived from it; regenerate when it changes |
| stale `flag-supplies.json` in `custom/` | delete | known-open item 3 |

---

## 13. Testing and acceptance

**Drift tests** (two statements of one fact):

- `rules.ts` against a vendored copy of the guide's numbers table
  (`docs/guide-numbers.json`, regenerated from `../field-guide/numbers.html` by a script).
  A number changed in one place fails the gate.
- The supplied predicate against the supply projection's SQL.
- `season_standings` against a rebuild from `raids` + `defenses`.
- `events_raise_lookup_idx` still chosen by the planner after the `declarations` join.
- The 33 flag images against `CLAIMABLE_FLAGS` (existing).
- The three `no_coordinates` checks exist on all three queue tables.
- Every `clan_notices` and `war_log_events` kind in §9 has a renderer, and no renderer
  exists for a kind not in §9.

**Rule tests** (pure, no database):

- Points at r = 1, r = N, N = 1, unranked, and the guide's worked example (N = 10, r = 4 →
  167).
- Vote threshold at electorate 9 (needs 6), and after a leaver drops it to 8 (needs 6).
- 200 m with the Hub as a phantom row; 2-D only.
- Grace: first-seen + 7, release + 3, launch stamp.
- Nickname truncation keeps the prefix.

**Store tests** (isolated database, existing harness):

- Staged race tests for every new writer pair on the lock order (inbox 20's caveat stands:
  they cannot fail by reordering alone, so each one also asserts the row outcome).
- Raid dedup inside and outside 24 h; a different clan is a new raid; a member's lower is
  not a raid; a dormant clan's lower is not a raid.
- Defense inside 24 h; dormancy at 24 h; defense then re-lower stays one raid.
- Presence promotion at 49 m and not at 51 m; `pos` order correct.
- Pending member does not count as a member anywhere `isRosterMember` is used.
- Join releases the solo declaration at promotion, not at accept.
- Week close across a restart; two missed weeks; a week with no raids.
- Wipe script twice is once.
- `smoke.test.ts` capability assertions.

**Acceptance**, before any deploy touching `factions_live`: the read-only dormancy check in
`CLAUDE.md`, re-written for the `declarations` join, run before and after; and
`select count(*) from factions` alongside it, because zero rows means two things.

---

## 14. Hazards

Carried forward, still true:

- Exactly one bot instance (§3). Nothing applies migrations in production; stop the bot
  before NOT NULL migrations. Queue rows in the transition's own transaction, always. The
  public queues stop at the first failure and nobody is paged (inbox 35). Every parser
  regex anchors on the identity group. `pos` and `at` differ in order. `flag_changes` holds
  zero rows in production; read `events`. Activation cannot see a flag already flying
  (inbox 12) — the guide tells players to lower first; a reconciliation pass is still the
  real fix. `guardedRunner` skips overlapping runs silently, so a slow tick looks like a
  quiet one.

New with this design:

- **Two entrances to `dormant`, one exit.** The reason is a column. Anything that
  switches on `status` alone is correct; anything that assumes `dormant` means "inactive"
  is wrong.
- **The 200 m check is a query under a lock, not an index.** A writer that skips the lock
  can pass two claims 150 m apart. Every `declarations` insert goes through one function.
- **`evidence_*` is the guard, not the export list.** The export list can grow by
  accident; the NOT NULL pair cannot be satisfied by accident.
- **Pending members are on the roster table but not on the roster.** Every existing
  membership read must add `status = 'full'`. The migration adds the column with a default
  of `full` so existing rows are unaffected; the tests in §13 catch the reads that forget.
- **Vote freeze lives in the package.** Both the bot's guild-removal path and the site
  call `kick` and `transfer`; a UI-only check would let a ban during a vote bypass it —
  though removal from the guild bypasses it *on purpose* (§5.4), which the package
  expresses as a separate internal function, not as a flag on `kick`.
- **Guest-pass overwrites accumulate** if the reaper dies. Reconcile on startup.
- **Public player stats + public bases raise the value of infiltration.** Accepted and
  stated in the guide; do not "fix" it by gating.
- **Fast travel teleports positions.** A relog at a travel point moves a player to the Hub
  (~100, 93) and then to a town door. Do not draw trails, do not flag a > 2 km jump between
  fixes, and never treat the Hub as an intruder zone — the 200 m rule with the Hub as a
  phantom declaration guarantees no base is within 100 m of it. Session tracking sees two
  normal disconnect/connect pairs; that is fine and expected.
- **A town door within 100 m of a declared base makes every arrival an intruder.** The
  guide says so; the alert cooldown is what keeps it from being spam. Do not special-case
  doors.
- **Week and season close are clock ticks with a restart on the boundary as the normal
  case** (the raid window ends at the same instant and the server restarts to flip base
  damage). §7's ordering — insert, commit, then post — is load-bearing.
- **`clan_notices` fails per target.** A clan whose channel was deleted by hand stops
  receiving notices and nothing else stops. The site shows the same facts; a stalled
  target is logged at warn level once per hour, not per row.
- **Deleting a clan's channels at disband deletes its history.** The guide says the channel
  is deleted; nothing is archived. Say so on the disband confirmation.

---

## 15. Build order

Each increment is a plan of its own under `docs/superpowers/plans/`, ships behind the
full gate, and is deployed as a deliberate step with its own runbook. Order is by
dependency, then by what players feel first.

| # | Increment | Plan file | Depends on |
|---|---|---|---|
| 0 | `rules.ts` + guide-numbers drift test; "clan" vocabulary sweep of existing strings | `2026-09-xx-rules-and-vocabulary.md` | — |
| 1 | **Declarations**: the migration (§4.1–4.2), 200 m with the Hub, grace, raise attribution to full members, solo declare/lapse stores, launch-grace runbook. No UI beyond what the bot needs | `2026-09-xx-declarations.md` | 0 |
| 2a | **Site foundation**: Tailwind + `@theme`; prototypes deleted; landing, `/login`, `/join` rebuilt; `packages/roster` (§10.4) with `viewerFor`; `/me` from the database; the deferred sweeps. No new capability for players | `2026-09-05-site-foundation.md` | 1 |
| 2b | **Link and base**: `verification_challenges` nullable guild/channel (migration 0021); `startLink`/`cancelLink`/`unlink`; `/link` with autocomplete, 3 emotes, 10 min, 5 s poll; `/base` over `raisedPolesFor`/`declareSolo`/`releaseSolo`; inbox 7's refusal path; `@factions/declarations` and the challenge store in `@factions/verification` shared by bot and roster | `2026-09-05-site-link-and-base.md` | 2a |
| 2c-a | **Roster package**: migration 0022 (member status, join requests, identity holds, recruiting); the stores in `packages/roster/src/internal` shared with the bot; every membership read `status = 'full'`; cap; presence promotion + pending expiry ticks; the package's roster writes and reads exported | `2026-09-05-roster-package.md` | 2b |
| 2c-b | **The site as the tool**: `/clan`, `/clans`, `/clans/{tag}`, `/claim/{ceremony}`, `/clan/settings`; `/me` shows pending and invites; retire the slash commands in the same deploy; the `/faction` exclusion in `vocabulary.test.ts` and the bot's 1 h rebind window removed with them | `2026-09-05-site-roster.md` | 2c-a |
| 3a | **Raids and notices**: raid and defense consumers, flag-down clock, `dormant_reason`, `war_log_events`, `clan_notices` with the poster, every §9 line that exists by now, `lapsed`, the `/base` lapsed copy | `2026-09-05-raids-and-notices.md` | 2c-b |
| 3b | **Discord structure**: per-clan role, text and voice channel at activation, deleted at disband, reconciled on start; `@Linked` role on link/unlink; nickname clear on a site unlink; the channel target for queued notices | `2026-09-06-discord-structure.md` | 3a |
| 4 | **Scoring**: seasons, standings, points, week close, `@Alpha`, `/scoreboard`, `/alphas`, `/war-log`, `/seasons`, wipe script and runbook | `2026-09-06-scoring-and-seasons.md` | 3a |
| 5 | **The map**: positions consumer, `/map` with every layer, pins, intruders, public bases, travel points, base alerts (after checking the gate line against a live log) | `2026-09-07-map.md` | 2c-b, 3a (notices), 3b (channel delivery) |
| 6 | **Player stats**: sessions and kills consumers, `/players`, profiles, boards, clan board | `2026-09-xx-player-stats.md` | 2c-b |
| 7 | **Leadership and the vault**: succession, votes, guild-removal handler, vault, guest passes + `/guest`, `[TAG]` nicknames | `2026-09-xx-leadership-and-vault.md` | 2c-b |
| 8 | **Launch**: raid-window runbook, stale file cleanup, launch grace stamp, `/guide`, acceptance against `factions_live` | `2026-09-xx-launch.md` | all |

Increments 6 and 7 are independent of each other and of 3a–5 once 2c-b has landed; 5 needs
the notices queue from 3a and channel delivery from 3b.

⚠️ Increment 2c-b is the one that changes what players can do before it changes what the
system knows. The slash commands are retired **in the same deploy** as the pages that
replace them, never before, so no capability is lost between two deploys.

---

## 16. Consequences for `CLAUDE.md`

On merge of each increment: the "surface, never a source of truth" bullet gains the
`evidence_*` rule; the lock order is replaced by §4.12; `SUPPLIED_STATUSES` is replaced by
the predicate; the roster-membership bullet gains "`status = 'full'`"; the "Where things
live" table names this document and `../field-guide/` as the two authorities in that
order.
