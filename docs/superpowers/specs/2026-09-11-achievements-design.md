# Achievements — design

**Date:** 2026-09-11
**Status:** approved in conversation, awaiting written review

## 1. What this is

Fifty lifetime achievements, earned by players and by clans, computed from evidence the
log and the derived tables already hold. Each unlock is stored once with the evidence that
earned it, shown on the site (player profile, /me, clan pages, guide) and announced in
Discord (the owner's clan channel, a public achievements channel, and a DM to the player
or to every full member of the clan).

Nothing here scores points. Achievements are a record, like stats, never a currency.

## 2. Decisions taken

| Question | Decision |
|---|---|
| Surfaces | Player profile wall, /me "closest to unlocking", clan pages (own and public), guide chapter, Discord |
| Ownership | Solo, PvE and PvP achievements belong to the player. Team achievements belong to the clan; every full member at `earned_at` shares the record |
| Lifetime | Earned once, kept forever. Backfilled from the existing log at launch. Not reset by seasons |
| Structure | Flat list of 50, all visible with their conditions. No tiers, no secrets |
| Discord | Clan channel for clan and member unlocks; a public `#achievements` channel for every unlock; a DM to the player (player unlock) or to every full member (team unlock) |
| Engine | A bot tick evaluating pure rules over the derived tables for owners touched since the last pass (approach A). Not a raw-event consumer, not computed on page load |

## 3. The fifty

Friendly fire counts for nothing except Blue on Blue, matching the stats rules. Thresholds
are the ones below; they live in one definitions file (§4) and nowhere else.

### Solo (11) — player-owned

| Key | Name | Condition | Evidence |
|---|---|---|---|
| `enlisted` | Enlisted | Link your account | `identity_links` |
| `squad_up` | Squad Up | Become a full member of a clan | `faction_members.status = 'full'` / `membership_history` |
| `founder` | Founder | Take part in a founding ceremony | `ceremony_participants` |
| `loyalist` | Loyalist | 30 days as a full member of one clan | `membership_history` span ≥ 30 d |
| `long_haul` | Long Haul | 24 hours played | Σ `player_sessions` ≥ 86 400 s |
| `veteran` | Veteran | 100 hours played | Σ `player_sessions` ≥ 360 000 s |
| `regular` | Regular | Play on 7 consecutive days | distinct UTC dates of `player_sessions` |
| `wanderer` | Wanderer | 10 fast travels | `events.type = 'player.teleported'` |
| `explorer` | Explorer | Seen in 50 different 1 km grid squares | `player_positions` → per-owner visited-square set (§5) |
| `showman` | Showman | 50 emotes | `events.type = 'emote.performed'` |
| `cartographer` | Cartographer | Drop 10 map pins | `clan_pins` by `dayz_id` (deleted pins still count: use a lifetime counter, §5) |

### PvE (12) — player-owned

| Key | Name | Condition | Evidence |
|---|---|---|---|
| `foundation` | Foundation | First base part built | `events.type = 'base.built'` |
| `builder` | Builder | 100 build points | count of `base.built` |
| `architect` | Architect | 500 build points | count of `base.built` |
| `ironman` | Ironman | 5 hours played without dying | sessions between two deaths (any cause) summing ≥ 18 000 s |
| `wolf_bait` | Wolf Bait | Killed by a wolf | `kills.cause = 'wolf'` |
| `bear_necessities` | Bear Necessities | Killed by a bear | `kills.cause = 'bear'` |
| `brains` | Brains | Killed by infected | `kills.cause = 'infected'` |
| `gravity_check` | Gravity Check | Die to a fall | `kills.cause = 'fall'` |
| `sunday_driver` | Sunday Driver | Killed by a vehicle | `kills.cause = 'vehicle'` |
| `lights_out` | Lights Out | Knocked unconscious 10 times | `events.type = 'player.unconscious'` with `disconnecting = false` |
| `should_have_bandaged` | Should Have Bandaged | Bleed out | `kills.cause = 'bled_out'` |
| `nine_lives` | Nine Lives | Die 9 times, any cause | `kills` as victim |

### PvP (15) — player-owned

| Key | Name | Condition | Evidence |
|---|---|---|---|
| `first_blood` | First Blood | First PvP kill | `kills` as killer, `friendly_fire = false` |
| `ten_down` | Ten Down | 10 PvP kills | same, count ≥ 10 |
| `centurion` | Centurion | 100 PvP kills | same, count ≥ 100 |
| `marksman` | Marksman | A kill from 150 m or more | `kills.distance_m ≥ 150` |
| `sniper` | Sniper | A kill from 300 m or more | `kills.distance_m ≥ 300` |
| `point_blank` | Point Blank | A kill from under 5 m | `kills.distance_m < 5`, not null |
| `arsenal` | Arsenal | Kills with 10 different weapons | distinct `kills.weapon`, non-null |
| `hat_trick` | Hat Trick | 3 PvP kills in one session | kills whose `occurred_at` falls inside one `player_sessions` row of the killer |
| `killing_spree` | Killing Spree | 5 PvP kills without a PvP death | the stats package's streak rule |
| `unstoppable` | Unstoppable | 10 PvP kills without a PvP death | same, 10 |
| `nemesis` | Nemesis | Kill the same player 5 times | `kills` grouped by victim, max ≥ 5 |
| `payback` | Payback | Kill someone within an hour of them killing you | a kill of V at t where V killed you at t′ with 0 < t − t′ ≤ 3 600 s |
| `flag_thief` | Flag Thief | Personally lower an enemy flag in a scored raid | `raids.raider_dayz_id` |
| `home_defender` | Home Defender | Make the raise that ends a siege | `defenses.raised_by_dayz_id` |
| `blue_on_blue` | Blue on Blue | Kill a clanmate | `kills.friendly_fire = true` as killer |

### Team (12) — clan-owned

| Key | Name | Condition | Evidence |
|---|---|---|---|
| `colors_raised` | Colors Raised | Clan founded and activated | `factions.activated_at` |
| `full_strength` | Full Strength | 10 full members at once | `membership_history` overlapping spans, max ≥ 10 |
| `first_raid` | First Raid | The clan's first scored raid | `raids.raider_faction_id` |
| `warpath` | Warpath | 25 raids | same, count ≥ 25 |
| `giant_killer` | Giant Killer | Raid the clan ranked first | `raids.victim_rank_at_lower = 1` |
| `wide_net` | Wide Net | Raid 5 different clans | distinct `raids.victim_faction_id` |
| `fortress` | Fortress | 10 defenses | `defenses.faction_id`, count ≥ 10 |
| `podium` | Podium | Finish a season in the top 3 | `season_results.rank ≤ 3` |
| `alpha` | Alpha | Finish a week in the top 3 | `alpha_weeks` |
| `dynasty` | Dynasty | Alpha 4 weeks running | 4 consecutive `week_start` rows in `alpha_weeks` |
| `untouched` | Untouched | A whole season without being raided | `season_results.times_raided = 0` and `status_at_close` holding for a season the clan was active through |
| `champions` | Champions | Win a season | `seasons.champion_faction_id` |

Ruled out on evidence grounds: anything positional at the instant of a kill (kill events
carry no position; fixes are five minutes apart), and per-session length feats (the server
restarts every two hours). Explosive kills are not reliably credited, so none depends on them.

## 4. Definitions: one file, data not code

`packages/domain/src/achievements.ts` exports `ACHIEVEMENTS`: fifty entries of
`{ key, name, description, group: "solo" | "pve" | "pvp" | "team", owner: "player" | "clan", target: number }`.
One-shot achievements have `target: 1`. The badge wall, the Discord text, the guide
chapter and the evaluator all read this array; a threshold changes in exactly one place.

`packages/domain/test/achievements.test.ts` pins: exactly 50 entries; keys unique and
snake_case; every `team` entry is `clan`-owned and nothing else is; every key has a rule
registered in the evaluator (the bot's test imports both and diffs the key sets).

## 5. Storage

Migration `0031_achievements`:

```
achievement_unlocks
  owner_kind   text  NOT NULL CHECK (owner_kind IN ('player','clan'))
  owner_id     text  NOT NULL      -- dayz_id, or faction id as text
  key          text  NOT NULL
  earned_at    timestamptz NOT NULL -- when the EVIDENCE happened, not when it was noticed
  evidence_id  bigint               -- the kill / raid / event / session row that crossed the line
  evidence     jsonb NOT NULL DEFAULT '{}'  -- the values at that moment (distance, streak, weapons…)
  noticed_at   timestamptz NOT NULL DEFAULT now()
  PRIMARY KEY (owner_kind, owner_id, key)
  CHECK: evidence carries no coordinates (same predicate the notice tables use)

achievement_progress
  owner_kind, owner_id, key   (PK)
  count        integer NOT NULL
  target       integer NOT NULL
  computed_at  timestamptz NOT NULL
  -- a cache; safe to truncate and rebuild by a full pass

achievement_counters
  owner_kind, owner_id, key   (PK)
  value        integer NOT NULL DEFAULT 0
  detail       jsonb NOT NULL DEFAULT '{}'
  -- lifetime counters for facts whose source rows are deleted or expire:
  --   cartographer: pins dropped (clan_pins rows are deleted by players)
  --   explorer: the set of visited 1 km squares (player_positions is retained 30 days).
  --     `detail` holds a compact list of square indices; `value` its size.
  --     ⚠️ Square indices, never x/z — the no-coordinates check applies here too.
```

Unlock rows are never deleted. A player who leaves a clan keeps their player rows; a
disbanded clan keeps its clan rows. Clan rows are keyed on the clan id, so a rename changes
nothing. Team achievements are not copied onto members: a profile shows the team unlocks of
clans the player was a full member of at `earned_at`, resolved through `membership_history`,
so later joins and leaves cannot edit the record.

`earned_at` of a backfilled unlock is the evidence's own time. A player who reached 100 kills
in August is shown earning Centurion in August.

## 6. The evaluator

### 6.1 Rules

`apps/bot/src/achievements/rules.ts` registers one rule per key:

```ts
type Rule = (db, owner: { kind, id }, opts: { now: Date }) =>
  Promise<{ count: number; target: number; evidenceId?: number; evidence?: object; earnedAt?: Date }>
```

Rules are pure reads over the derived tables plus `events`. They never read the raw log for
anything a derived table settles: kills, friendly fire, raid scoring and defenses are taken
exactly as the kill, raid and raise ticks left them. Time-window rules (Regular, Payback,
Ironman, Hat Trick, Loyalist, Dynasty) compute from stored timestamps, never from "now", so
backfill and live give identical answers. Streaks reuse the stats package's streak function.

When a rule reports `count ≥ target` it also reports `earnedAt` (the timestamp of the row
that crossed the line) and the evidence.

### 6.2 The tick

`apps/bot/src/achievements/tick.ts`, run each interval after the kill, session, raid and
raise ticks:

1. **Touched set.** Per source table a watermark (max id or max timestamp) is kept in the
   event-log cursor table under consumer names `achievements:<table>`. The pass collects
   owners with rows past each watermark: killers and victims in `kills`; players with newly
   closed `player_sessions`; players in new `events` of type `base.built`,
   `player.teleported`, `emote.performed`, `player.unconscious`, `player.position`; clans and
   raiders in `raids`; clans and raisers in `defenses`; clans in `alpha_weeks`,
   `season_results`, `factions.activated_at`; players and clans in `membership_history`,
   `ceremony_participants`, `identity_links`, `clan_pins`.
2. **Evaluate.** For each owner, every rule of its kind, in one read transaction; write
   `achievement_progress`; update `achievement_counters` for `cartographer` and `explorer`.
3. **Unlock.** For a rule at target with no unlock row: insert the row and, in the same
   transaction, the announcement rows (§7). `ON CONFLICT DO NOTHING` on the primary key makes
   a retry harmless; an insert that did nothing queues nothing.
4. **Advance the watermarks** only after the batch commits.

Bounds and isolation:

- A pass processes at most `ACHIEVEMENT_BATCH` owners (default 200) and carries the rest;
  a busy weekend or a backfill cannot stall the other ticks.
- A rule that throws skips only itself: the failure is logged with the owner and key, the
  other rules run, the pass continues.
- One owner's failure never blocks another's.

### 6.3 Backfill

`apps/bot/scripts/backfill-achievements.ts`: the same tick with `everyone: true` and
`announce: false`. It walks every player in `identity_links ∪ kills ∪ player_sessions` and
every clan in `factions`, in batches, and sets the watermarks to the current maxima when
done. It is run once by hand, before the tick is enabled, per the launch runbook, so launch
day does not post hundreds of historical unlocks. Idempotent: a second run inserts nothing.

## 7. Discord

Three destinations per unlock, all through the existing `clan_notices` queue and poster,
which already retries three times per target and never lets one target block another.

| Unlock | Clan channel | Public channel | DM |
|---|---|---|---|
| Player | Owner's clan channel, if they have one | Yes | The player |
| Team | The clan's channel | Yes | Every full member at that moment |

One new notice kind, `achievement`, with payload `{ key, ownerKind, ownerName, clanTag? }`.
The renderer reads the name and description from `ACHIEVEMENTS`; text is one line:

- `Ann earned Sniper — a kill from 300 m or more.`
- `[BEAR] Ann earned Sniper — …` in the public channel
- `BEAR earned Fortress — 10 defenses.`

The public channel is `ACHIEVEMENTS_CHANNEL_ID`, optional like `WAR_LOG_CHANNEL_ID`: unset
means no public post and the bot still starts. **Public posts ride `clan_notices`** as a
channel-target row with no clan behind it — `faction_id` null, `target = 'channel'`,
`discord_target_id` = the achievements channel, written in rather than resolved from a faction
row. *(Amended 2026-09-12 per implementation. This paragraph originally routed public posts
through `war_log_events`; that queue targets ONE fixed channel — `WAR_LOG_CHANNEL_ID`, resolved
by the war-log poster itself — so it cannot address a second configured channel at all. The
notice queue already carries an explicit per-row target, retries three times per target, and
never lets one stuck target block another, so all three destinations ride one queue.)*

Adding the kind follows the documented path: the domain kind list, a migration for the
`clan_notices` CHECK constraint, a renderer branch in `notice-text.ts`, and the existing
kind-to-renderer tests. No `war_log_events` kind is added.

Several unlocks in one pass produce one message each, in order. Backfill posts nothing.

## 8. Web

One new roster export, `achievementsFor(subject)`, returning the 50 definitions joined with
unlocks and cached progress for a player (including team unlocks of clans they were full
members of at `earned_at`) or a clan. Added to both export allowlists.

- **`/players/[gamertag]`** — an Achievements panel below PvP and Raiding: a wall of 50
  tiles in the four groups. Earned: full colour, date. Locked: dimmed, description, and for
  counted ones a progress line ("Kills 63 / 100"). Team tiles carry the clan's flag.
- **`/me`** — "Closest to unlocking": the three counted achievements nearest their target,
  with progress bars, linking to the wall.
- **`/clan`** and **`/clans/[tag]`** — a Team achievements row: the 12 team tiles.
- **Guide** — a new chapter, "Achievements", rendered from `ACHIEVEMENTS` through the
  existing `{{KEY|format}}` token mechanism, so the guide can never state a threshold the
  engine does not use. `guide.test.ts`'s hand-typed-number check extends to it.

Rules carried over: every page above already renders per request; no tile ever shows a
coordinate; copy says "clan", never "faction" (the vocabulary test scans the new files).

## 9. Testing

- One seeded test per rule (50): rows one short of target → no unlock; the crossing row →
  unlock with the expected `earned_at` and evidence.
- Tick tests: touched-set collection per source; retry idempotence via the primary key; a
  throwing rule skips only itself; batch carry-over; backfill inserts unlocks and queues
  nothing; a second backfill inserts nothing.
- Notice and war-log renderer tests for the new kinds; the kind-to-renderer bijection tests.
- Domain test: exactly 50, unique keys, owner/group consistency, every key has a rule.
- Web structural tests: request-time rendering, vocabulary, guide numbers, export allowlists.
- The full gate, uncached, remains the gate.

## 10. Rollout

1. Migration `0031` (additive). 2. Deploy the bot with the tick **disabled** by config.
3. Run the backfill. 4. Enable the tick; set `ACHIEVEMENTS_CHANNEL_ID`. 5. Deploy the web
app. A runbook under `docs/deploy/` carries the commands and the acceptance checks.

## 11. Out of scope

Tiers, hidden achievements, per-season resets, achievement points or rewards, positional or
time-of-day feats, explosive-kill feats, and any editing or revoking of unlocks.
