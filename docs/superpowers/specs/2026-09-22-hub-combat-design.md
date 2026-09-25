# No combat at the Hub — design

**Date:** 2026-09-22
**Status:** designed, not implemented
**Covers:** a new rule: there is no combat at the Fast Travel Hub. A hit, kill or trap
placed there earns an automatic one-hour ban. Every kill already made there, and every
kill made there in future, is discredited: it no longer counts for any stat, streak or
achievement.
**Builds on:** base-zone enforcement (`docs/superpowers/specs/` 2026-09-15, the `bans`
table and `banTick`), the unlinked-PC ban (`pc-ban-tick.ts` is the precedent for a
ban written by a tick with no officer), the friendly-fire rule (`scoringKill` in
`packages/roster/src/stats.ts` is the precedent for "a kill that scores nowhere"),
achievements (`apps/bot/src/achievements/`)

---

## 1. Purpose

The Hub is where every fast-travel trip starts and ends. The guide calls it "shared and
neutral", then says "watch your back". Players have taken that at its word. Production
data from 2026-09-15 to 2026-09-22 records **819 player-on-player hits by 16 people, 62
kills by 11 people, and 5 bear traps placed by 3 people** at the Hub. 2026-09-20 alone
had 562 hits and 51 kills. A player who relogs to travel cannot fight back: they arrive
into whatever is already standing there.

The new rule: no combat at the Hub. Any hit, kill or trap placed there earns a one-hour
ban. Kills made there no longer count for anything.

### In scope

- The Hub zone as a cylinder, with a pure predicate in `@factions/domain`
- Hit and kill payloads carrying the attacker's and victim's positions
- A forward-only ban tick that writes `hub_combat` bans for `banTick` to apply
- `kills.at_hub`, and every scoring read excluding Hub kills
- A retroactive backfill of positions onto past events, a kills rebuild, and a
  revocation pass over kill-derived achievements
- Guide copy: the rule, in the fair-play chapter and the one-page rules

### Out of scope

- Banning anyone for combat before the deploy. Neither bans nor (since the §2.6
  amendment of 2026-09-24) discrediting reach back before the rule.
- Escalating sentences. Every offence is one hour.
- Deleting or editing Discord posts already made about Hub kills (the kill feed,
  `#killstreaks`, achievement cards). Those are records, and Discord keeps them.
- Any notice to a player whose achievement is revoked.

---

## 2. Decisions

### 2.1 The zone is a cylinder, not a circle

The Hub floats in the sky. Its floor is at 997.5 m altitude (`pra-teleport-hub.json`'s
`safePositions3D`) and its 31 town doors are at 998.6 m, all within 22 m of `HUB_POSITION`
(100, 93). The ground directly below is a normal part of the map, and a fight there is
legal. So the zone is:

- horizontal distance from `HUB_POSITION` ≤ `HUB_ZONE_RADIUS_M` = **100 m**, and
- altitude ≥ `HUB_ZONE_MIN_ALTITUDE_M` = **900 m**.

900 m leaves about 100 m below the Hub floor and about 400 m above Livonia's highest
terrain, so neither a player falling off the edge nor a player on the highest hill is
misjudged. 100 m is more than four times the Hub's real extent, and matches the base
watch radius players already know.

⚠️ `pos=<x, z, altitude>` in an ADM identity block puts altitude **last**, not in the
middle as a flagpole's `at <x, alt, z>` does (`packages/adm-parser/src/coords.ts`).
`Vec3.y` is the altitude either way once parsed. The predicate reads `pos.y`, and a
test pins a ground-level point at the Hub's own x/z as **outside** the zone.

### 2.2 Either party inside counts

A hit or kill is at the Hub when **either** the attacker's or the victim's position is
inside the zone. So a shot fired into the Hub from outside counts, and so does a shot
fired from the Hub at someone outside it. A placement is at the Hub when the placer is
inside it.

A position that is missing or out of bounds is never inside, so an event can't be judged
without one. Every real hit and kill line carries both identity blocks with `pos=`
(checked against production on 2026-09-22), so this is a guard, not an expected path.

### 2.3 The first hitter is banned, not the one who fires back

Two minutes (`HUB_RETALIATION_WINDOW_MS`) after player B hits player A at the Hub, A may
hit B at the Hub without offending. That is self-defence. The rule is per pair: A hitting
a third player C is still an offence. A kill is judged like a hit: a kill of someone who
hit you in the last two minutes is not an offence.

"Hit you" means a `player.hit` or `player.killed` event with you as the victim and them
as the attacker. The earlier hit need not itself be at the Hub: a fight that started
outside and drifted in is still self-defence for the player who was attacked first.

### 2.4 Traps are an allowlist, confirmed against production

`HUB_TRAP_CLASSES` = `BearTrap`, `LandMineTrap`, `TripwireTrap`, `ImprovisedExplosive`,
`ClaymoreMine`, `Plastic_Explosive`. The first five were read from `item.placed`
payloads in `factions_live` on 2026-09-22 (7, 5, 2, 33 and 2 placements respectively).
`Plastic_Explosive` has never been placed on this server; it is included because it is
vanilla, and the constant's comment says it is unobserved. Placement has no retaliation
exemption.

### 2.5 One ban per offender at a time, always one hour

A ban reaches Nitrado several minutes after the offence: the worker sweeps each minute,
and `banTick` runs in the bot's 5-minute block. A player in a brawl lands many hits in
that time. While a player has a `hub_combat` ban that is `pending` or `applied`, their
further Hub offences write nothing.

The hour starts when the bot **processes** the offence, not when it happened in game:
`bannedAt = now`, `expiresAt = now + HUB_BAN_MS`. An offence can reach the ADM log long
after it happened, and the worker and bot add their own delay on top. An hour measured
from the event would be partly or wholly used up before the ban ever reached Nitrado.

The remaining cost: `banTick` applies the row up to one 5-minute block after it is
written, so those minutes come out of the hour. That is accepted rather than stamping
expiry at apply time, which would mean a third code path in `banTick`'s expire arm for
one reason.

### 2.6 Bans and discrediting are both forward-only (amended 2026-09-24)

The ban tick's cursor is seeded at the log head at deploy, the same way the `zone-watch`
cursor is (`docs/deploy/2026-09-07-map.md`). Nobody is banned for fighting at the Hub
before the rule existed.

~~Discrediting is the opposite. Every Hub kill in the log, past and future, stops scoring.
A kill made at the Hub on 2026-09-20 was not against the rules at the time, but the
brawl's kills were not real fights either, and a board that still counts 51 of them
misrepresents the server.~~

**Amended 2026-09-24:** discrediting is forward-only too. A Hub kill scores nowhere only
from `HUB_COMBAT_FROM` (`rules.ts`, 2026-09-23T02:17:03Z — the bot's first `HUB_BAN_TICK
on`), decided by `hubKillDiscredited` (`hub.ts`) where `kills-tick.ts` writes `at_hub`.
All 75 Hub kills discredited at deploy predate it and were re-credited: a kill made
before the rule broke no rule, the same reasoning that already kept bans forward-only.
Badges those kills earned were restored silently (`backfill:achievements`, `announce:
false`). Runbook `docs/deploy/2026-09-24-hub-recredit.md`.

### 2.7 A Hub kill scores nowhere, on either side — like friendly fire

A Hub kill is not a kill, not a death, not a streak term and not a K/D term, for either
player. The killer gains nothing and the victim loses nothing. It is still a **record**:
the kill feed, the timeline and encounters still show it, marked as at the Hub, exactly
as they still show friendly fire.

A hit at the Hub cannot earn a credited kill (`finishedBy`, `cause = 'finished'`). Such
a kill is at the Hub because the crediting hit was.

### 2.8 Achievements are recomputed and revoked, silently

A badge earned from Hub kills that no longer holds without them is deleted. The stats and
the badges must agree, and otherwise they disagree permanently. Nobody is notified.

⚠️ Only **kill-derived** rules are re-run. The revocation pass must not evaluate
position- or pin-based rules: `reaper-tick.ts` deletes positions after
`POSITION_RETENTION_MS`, so re-evaluating those rules today would fail on data that no
longer exists and revoke badges that were fairly earned. The pass names its rule keys
explicitly, and a test fails if a key outside `rules-pvp.ts` appears in that list.

---

## 3. Data model

### 3.1 Event payloads

`player.hit` and `player.killed` gain `victimPos: Vec3 | null` and `attackerPos: Vec3 |
null` (`killerPos` on a kill, to match its `killerDayzId`). The parser reads each from
its own identity block, anchored the same way `parsePlayerPos` is.

⚠️ **Never `pos`.** `positions-tick.ts`'s `readFix` treats any payload with a `pos` key
as a map fix. A kill payload with `pos` would pin the victim on their killer's clan map.
A test pins that a hit's payload has no `pos` key.

⚠️ Neither key is added to any payload that is published. `faction_events`,
`war_log_events`, `clan_notices`, `ban_announcements` and `achievement_unlocks` all have
no-coordinates CHECKs. A kill feed or ban announcement row built from these events must
not copy the new keys across. The kill feed's payload builder names its fields
explicitly, and the hit feed's must too.

### 3.2 `kills.at_hub`

`boolean not null default false`. Set by `kills-tick.ts` from the event that decides the
kill: the kill line itself, or the crediting hit for a `finished` kill. Rewritten for the
past by `pnpm rebuild:kills` once the positions backfill has run.

The migration (0047) adds the column with its default and nothing else. It is safe to
apply with the old bot running, because the old code neither selects nor writes it.

### 3.3 `bans.reason`

`BAN_REASONS` gains `"hub_combat"`. `bans.reason` is `text` with a TypeScript type and
no CHECK, so no migration is needed for it. `incident_id` stays null: a Hub ban has no
zone incident, as a PC ban has none.

### 3.4 Consumer cursor

The ban tick keeps a cursor in the existing consumer-cursor table under the name
`hub-watch`.

### 3.5 Lock order

`hubTick` writes only `bans`, one insert per offence, each in its own statement. It
touches no other table, so it is outside the lock order as `pcBanTick` is.
`revoke:achievements` deletes from `achievement_unlocks` and `achievement_progress` in
that order, within one owner's transaction, which follows the order already stated for
the achievements tick.

---

## 4. Flows

### 4.1 Detecting an offence (`apps/bot/src/hub-tick.ts`)

Each tick, in batches, `hubTick` reads events past its cursor of type `player.hit`,
`player.killed` and `item.placed`, in `id` order:

1. **`item.placed`:** if `itemClass` is in `HUB_TRAP_CLASSES` and `atHub(pos)`, the
   placer offends.
2. **`player.hit` / `player.killed` by a player:** if `atHub(attackerPos)` or
   `atHub(victimPos)`, and the attacker is not the victim, then the attacker offends,
   unless the victim hit or killed the attacker in the preceding
   `HUB_RETALIATION_WINDOW_MS`. Non-player attackers (infected, fall, environment) are
   never offences.
3. **An offender with a `hub_combat` ban already `pending` or `applied`** writes nothing.
4. **Otherwise** the tick inserts
   `bans { reason: 'hub_combat', status: 'pending', bannedAt: now, expiresAt: now + HUB_BAN_MS, gamertag }`.

The cursor advances after the batch's writes commit, in the same transaction. A crash
mid-batch re-reads the batch, and step 3 makes that harmless.

⚠️ `bannedAt` is `now`, not the event's time (§2.5). So a late offence still gets its
full hour: after a slow log, a `guardedRunner` skip, or a bot restart.

⚠️ The one staleness guard: the tick skips any event older than
`HUB_OFFENCE_MAX_AGE_MS` = **24 h** (equal to `BAN_APPLY_LOOKBACK_MS`), while still
advancing its cursor. It is not about the length of the sentence. It exists for the
same reason `zone-tick.ts`'s guard does: an unseeded or rewound cursor must not replay
the whole event log and ban everyone who ever fought at the Hub, including the 2026-09-20
brawl from before the rule existed. 24 h is far longer than any log delay seen, and
the runbook's cursor seed at the log head is the primary defence. This is the backstop.

It runs every tick, beside `zone-tick.ts`, gated on `HUB_BAN_TICK`. Like
`UNLINKED_PC_BAN`, it refuses to load without `ENFORCEMENT_TICK`, because without
`banTick` its rows are never applied.

### 4.2 Applying the ban

`banTick` is unchanged apart from wording. It applies, expires and announces a
`hub_combat` row exactly as it does a `zone` row, and it honours `BAN_DRY_RUN`. Its
reference counting already stops a Hub ban's expiry from lifting an account that also
holds another ban.

The offender DM's `reason: "base-zone enforcement"` is hard-coded today. It becomes a
lookup by `row.reason`: `zone` → "base-zone enforcement", `unlinked_pc` → as today,
`hub_combat` → "combat at the Fast Travel Hub". The `#bans` announcement already carries
`row.reason`, and its renderer gains the one new wording.

### 4.3 Discrediting

Every scoring read adds `at_hub = false` beside `friendly_fire = false`:

| Read | Where |
|---|---|
| Boards, profile, K/D | `scoringKill`, `packages/roster/src/stats.ts` |
| Best streaks (SQL) | `bestStreaks`, `packages/roster/src/stats.ts` |
| Achievement streak (pure) | `streakOf`, `packages/domain/src/streaks.ts`: a Hub kill neither extends nor breaks a run |
| `#killstreaks` | `streakable`, `apps/bot/src/killstreak-feed-tick.ts` |
| Long-range feed | `apps/bot/src/long-range-feed-tick.ts`'s qualifying predicate |
| PvP achievements | `pvpBy` and the raw-SQL nemesis query, `apps/bot/src/achievements/rules-pvp.ts` |
| Hit feed bursts | `apps/bot/src/hit-feed-tick.ts`: a Hub hit is not a burst term |

Each read gets a test covering both sides: a Hub kill does not count for the killer, and
does not count against the victim.

The kill feed, timeline and `encountersOf` keep Hub kills, labelled "at the Hub".

⚠️ `rules-pvp.ts`'s friendly-fire achievement (the first teamkill) is a record, not a
score. It does **not** exclude Hub kills.

### 4.4 The retroactive runbook

Run in a quiet hour, bot stopped, after the release deploy has applied 0047:

1. **`pnpm backfill:hub-positions --server <id>`** walks every `player.hit` and
   `player.killed` event, re-parses its `raw_lines.content` with the same
   `parseHit`/death parser the worker uses, and merges `victimPos`/`attackerPos`
   (`killerPos`) into the payload. It is a dry run by default and prints counts;
   `--apply` writes. It has the `factions_live` guard and is idempotent, because a
   payload that already has the keys is skipped.
2. **`pnpm rebuild:kills --server <id>`**, unchanged, refills `kills` with `at_hub` set.
3. **`pnpm revoke:achievements`**, also a dry run by default. It re-runs the kill-derived
   rules for every owner holding one of those unlocks, prints every unlock that would be
   deleted with owner and key, and deletes on `--apply`.
4. Start the bot with `HUB_BAN_TICK=true`. The cursor is seeded at the log head first.

⚠️ **To verify in the plan, not assume:** that `rebuild:kills`, which deletes and
re-inserts `kills` rows with new ids, cannot make the kill feed, long-range feed or
`#killstreaks` repost history. This rebuild has run in production before
(`docs/deploy/2026-09-10-death-causes.md`); the plan confirms how those posters are
guarded rather than relying on that.

---

## 5. Guide

- `12-fair-play.html` gets a new rule block: no hits, kills or traps at the Hub, a
  {{HUB_BAN_MS|duration}} ban, self-defence allowed, and the ground below is not the
  Hub. The numbers are tokens, not literals.
- `13-rules-on-one-page.html`'s Hub line gains the rule.
- `11-getting-around.html`'s "Other survivors can be standing in it when you arrive.
  Watch your back." is replaced. It now contradicts the rule.
- `rules.ts` gains `HUB_ZONE_RADIUS_M`, `HUB_ZONE_MIN_ALTITUDE_M`, `HUB_BAN_MS`,
  `HUB_RETALIATION_WINDOW_MS` and `HUB_OFFENCE_MAX_AGE_MS`. The last one is not
  player-facing and gets no guide row. `guide-numbers.ts` gets the rows the chapters use.

---

## 6. Failure handling

| Failure | Behaviour |
|---|---|
| An event has no position (never seen in production) | Not at the Hub. No ban, and the kill still scores. |
| `hubTick` throws mid-batch | Transaction rolls back and the cursor does not move. The next tick re-reads, and step 3 prevents duplicates. |
| Offence logged late, or bot down for a while | The ban is written when processed and runs a full hour from then. Only events older than 24 h are skipped. |
| Cursor unseeded or rewound | Events older than 24 h are skipped, so history is never replayed into bans. |
| `ENFORCEMENT_TICK` off | Config refuses to load with `HUB_BAN_TICK` set. |
| `BAN_DRY_RUN=true` | Rows are written, and `banTick` marks them applied without calling Nitrado, announcing them, or sending a DM. The same as every other reason. |
| Backfill re-run | Skips payloads that already have positions. |
| Revocation re-run | Finds nothing further to delete. |

---

## 7. Testing

- **Domain:** `atHub`. Each Hub door is inside, (100, 93) at ground level is outside, a
  point 101 m out is outside, and 899 m altitude is outside. The trap list, and the
  retaliation-window rule as a pure function over a hit history.
- **Parser:** a production hit line and a kill line yield both positions, with altitude
  as `y`. No payload gains a `pos` key. ⚠️ A hit line at the Hub's own altitude (997.5)
  parses to a position. `coords.ts`'s `ALT_MAX` (5000) admits it today. If a future edit
  narrowed it below 1000, every Hub position would parse as null, and per §2.2 nothing
  would ever be at the Hub again, silently.
- **`hubTick`:**
  - a first hit bans the attacker, and return fire inside 2 minutes doesn't;
  - return fire after 2 minutes does ban;
  - a hit on a third party bans;
  - a ground-level fight below the Hub doesn't ban;
  - a trap bans, and a tent doesn't;
  - a second offence while a ban is pending writes nothing;
  - an offence processed 3 h after it happened is banned from processing time (`bannedAt = now`, `expiresAt = now + 1h`);
  - an event older than 24 h is skipped, and the cursor still moves;
  - a hit by an infected never bans.
- **Discrediting:** each row of the §4.3 table, both sides.
- **`kills-tick`:** `at_hub` from the kill line, and from the crediting hit on a
  `finished` kill.
- **Backfill:** idempotent, `factions_live` guard, dry run writes nothing.
- **Revocation:** revokes an unlock that depended on Hub kills, keeps one that still
  holds, never evaluates a non-PvP key (the list is pinned), and a dry run writes nothing.
- **`banTick`:** the DM and announcement wording for `hub_combat`.
