# Raid value scoring, the weekly raid award, and the new raid window

Date: 2026-11-06. Status: design agreed in conversation; builder-check questions answered 2026-11-06. Ships 2026-11-06.

## Why

Today a raid pays 100–200 points by the victim's season rank (`pointsFor`,
`packages/domain/src/scoring.ts`). Three things about that are wrong for the
game the owner wants:

- **Who you raid barely matters.** A clan that has just been hit by three other
  clans still pays full price to the fourth. A brand-new clan pays the same 100
  as an established one. Raiding the clan that is out raiding everyone pays no
  more than raiding anyone else in its rank band.
- **Alphas carry no weight in the points.** The owner wants a clan's worth to
  rise *as it raids*, calculated on the fly, not only when a week closes.
- **A clan that moves base and leaves its old flag flying is safe.** Lowering
  a flag at an undeclared pole scores nothing today.

The aim: **make who you raid a strategic choice.** Big, active raiding clans
should be the attractive target; new clans and clans that were just hit should
not.

### Options considered and rejected

Both of these were modelled on production data during the design conversation:

- **A pure bounty, where the bounty *is* the score** (a raid moves half the
  victim's score onto the raider). It worked strategically, but one lowered flag
  could erase half a clan's season (NDF's raid on Z2 moved 241 of Z2's 482). The
  owner did not find that too brutal, but rejected the follow-up.
- **The same with decay toward 100.** Decay fixed coasting, but a score that
  drains away cannot crown a season champion. Rejected because it breaks
  season champions.

The design below separates **points** (banked, never lost) from **value** (the
price tag, which moves freely).

## Goals

1. A raid pays the victim's **value** at the moment of the lower, ×1.5 if
   anyone from the victim clan is online then and ×0.75 if nobody is.
2. Value rises with the clan's own recent raiding, falls with recent hits taken,
   and is 0 for a clan under a week old.
3. Points are banked. Being raided never removes points.
4. The season scoreboard is recalculated under the new rules from the
   2026-10-17 wipe (season 3).
5. The clan with the most points each scoring week wins a weapon kit, granted
   to its leader.
6. A flag raised by a clan member, lowered by a non-member, is a raid on that
   clan **wherever the pole is**, not only at the declared base.
7. The raid window runs Friday 14:00 UTC to Sunday 14:00 UTC. The scoring week
   ends at the same instant.
8. `#scoreboard` (and the site's `/scoreboard`) show what a raid on every clan
   pays right now, and why.

## Non-goals

- No change to defenses, the 24 h flag-down clock at the declared base,
  dormancy, disband, or supply kits.
- Kills stay stats, never points.
- Solo raids still score nothing (they remain real, announced raids).
- No cap on value (the owner chose this explicitly).
- No retroactive *detection* of old-flag raids from before this ships (see
  §Recalculation).

## Anti-goals (would make this a failure even if it works)

- A single raid that erases a clan's season standing.
- A rule under which raiding a brand-new clan *earns* anything directly.
- A way to farm points with a stolen flag (see §Old flags).
- A scoreboard whose price disagrees with what the next raid actually pays.
- Player copy that discourages raiding. Voice per `brand/02-verbal-identity.md`
  (em dashes allowed) and the project's plain-voice rule.

## 1. Value — the decided rules

All numbers go in `packages/domain/src/rules.ts`, reach the guide through
`guide-numbers.ts`, and are never hand-typed in a chapter (house rule).

| Constant (suggested name) | Value | Meaning |
|---|---|---|
| `RAID_VALUE_BASE` | 100 | Starting value of an established clan |
| `RAID_HEAT` | 50 | Value added by each raid the clan lands |
| `RAID_HEAT_FADE_MS` | 14 days | Heat from one raid fades linearly to 0 over this |
| `RAID_HIT_FADE_MS` | 7 days | A hit's halving fades linearly back to ×1 over this |
| `NEW_CLAN_WORTHLESS_MS` | 7 days | A clan is worth 0 for this long after activation |
| `RAID_DEDUP_MS` | 24 h (unchanged) | Repeat lowers by the same raider clan on the same victim are one raid |
| `RAID_ONLINE_MULT` | 1.5 | Points multiplier when a victim clan member is online at the lower |
| `RAID_OFFLINE_MULT` | 0.75 | Points multiplier when none is |

Retire `POINTS_TOP`, `POINTS_BOTTOM`, `POINTS_UNRANKED` and `pointsFor`.

The value of clan V at instant t, as a **pure function** in
`packages/domain` over the season's raid rows:

```
if t < V.activated_at + NEW_CLAN_WORTHLESS_MS:      value = 0
else:
  heat  = Σ over raids R with R.raider_faction = V, in this season, 0 ≤ t − R.at < HEAT_FADE:
            RAID_HEAT × (1 − (t − R.at) / HEAT_FADE)
  mult  = Π over raids H with H.victim = V, H.raider_faction not null, in this season, 0 ≤ t − H.at < HIT_FADE:
            0.5 + 0.5 × (t − H.at) / HIT_FADE
  value = (RAID_VALUE_BASE + heat) × mult
online = some full member of V (per membership_history at t) has an open
         player_sessions row on this server at t
points for a raid = round(value of victim immediately BEFORE this raid is recorded
                          × (online ? RAID_ONLINE_MULT : RAID_OFFLINE_MULT))
```

### Online and offline raids (owner decisions)

- **"Online" means anyone from the victim clan is logged in to the server** at
  the instant of the raid's first lower, anywhere on the map. Being near the
  base doesn't matter.
- Membership is as of that instant (`membership_history`, as the kills
  consumer attributes kills), and full members only.
- **The multiplier scales only the points paid.** Value, heat and hits are
  unaffected.
- Store the online flag on the raid row (new column), so the recalculation and
  the war log can show it and nobody has to re-derive it later from sessions.
- On season 3 data, 5 of 18 clan raids were online. Offline is the norm, so
  most raids pay ×0.75. That's intended.
- Known and accepted: a defender who logs off as raiders arrive cuts the
  payout to ×0.75, at the cost of any chance to defend. No guard.

Decided in conversation:

- **"Calculated on the fly."** Value is derived from raid rows whenever it is
  needed. It is not a stored running figure. The points a raid paid are
  still stored on the raid row at write time, as today.
- **Heat counts every raid the clan landed, including 0-point raids on new
  clans.** That's what makes bullying a new clan raise your own value
  without paying you anything.
- **Season-scoped.** Only raids in the open season count, so heat and hits
  start fresh at a wipe. (Replay basis, approved.)
- Raids are the existing deduplicated `raids` rows. An absorbed repeat lower adds
  no heat and no hit.

Calls I made (the owner hasn't ruled on these):

- **"A week old" is measured from `factions.activated_at`.** The replay used this.
- **Solo raids don't count as hits.** No clan scored, so they don't cheapen
  the victim for clans. (The replay used this.)
- **Simultaneity.** Raids ordered by `(first_lower_at, first_lower_event_id)`. A
  raid's own row is excluded from its own price.
- **Dormant and reserved clans stay unraidable for points,** as today (the
  victim must be `active`).

### Worked check (the acceptance fixture)

Season 3 holds 19 raid rows (ids 18–36), of which 18 have a raider clan.
Replaying those 18 with these rules, online multiplier included, as of
2026-11-06 12:00 UTC gives season points **Z2 515, COCK 300, NDF 296, VOLK
293**, everyone else 0.

- **Values at that instant:** VOLK 144, SKULL 83, COCK 113, Z2 172, WOOKI 100,
  MMBA 74, OUT 45, NDF 143. Values don't depend on online status.
- **Online raids** (a victim member was in session, checked against
  production `player_sessions` × `membership_history`): ids 19, 22, 27, 29
  and 34. The other 13 were offline.
- **Notable rows:**
  - VOLK→COCK, 11-04 18:44, online: value 196, paid **293**.
  - NDF→Z2, 11-06 03:10, offline: value 338, paid **253**.
  - Z2→OUT, 11-01 18:44, offline: value 38, paid **29**.
- **The bridging week** (Mon 2026-11-02 00:00 to Sun 2026-11-08 14:00 UTC; the
  closed weeks before it are frozen and not re-crowned), as of the replay
  instant: **VOLK 293** (→COCK, online), **NDF 253** (→Z2), **Z2 55** (→OUT).
  NDF's 43 against MMBA on Sun 11-01 22:01 falls in the frozen old week, not
  this one.

The replay scripts (`value2.py`, `value3.py`) were session scratch and aren't
committed. Turn these inputs and outputs into a domain unit test, so real data
pins the formula.

## 2. Raids away from the declared base (old flags)

**The rule (the owner's words):** *if a clan member raised the flag, any
non-clan member lowering it counts as a raid, whether it's on the declared pole
or not.*

- Every `flag.lowered` payload carries `texture` (144 of 144 on production
  checked 2026-11-06) and `poleKey`.
- **Declared base, lowered by a non-member:** unchanged. Any `flag.lowered` at
  an active clan Y's declared pole by someone who is not a full member of Y
  is a raid on Y, exactly as `raid-tick.ts` does today, whatever flag was on it.
- **Declared base, lowered by its own member (new; owner decision,
  2026-11-06):** if the lowered flag was raised by a full member of another
  active clan X (the same raise lookup as below), it's a raid **on X, by Y.**
  The owner's words: *"if X is dumb enough to raise their own flag on Y's pole,
  it should count as a raid when Y lowers it."* Y lowering its own flag, a
  white flag, or a flag no clan member raised is upkeep, as today.
- **Call I made: one lowering is never two raids.** If a third clan Z lowers
  X's flag on Y's base, the base rule applies: a raid on Y, by Z, and nothing
  on X. At a declared pole the base rule always wins for a non-member of Y.
  The new rule only fires when the lowerer is Y's own member.
- **A pole that is no one's declared base (new):** find the most recent `flag.raised` on that
  `server_id` + `poleKey` before the lower, with the **same texture** as the
  lowered flag. If its raiser was a **full member of clan X at the raise
  instant**, and X is `active`, and the lowerer is not a full member of X, it
  is a raid on X. It scores, dedups, adds heat and counts as a hit exactly
  like a base raid.
  - `events_raise_lookup_idx` already indexes `flag.raised` by
    `(server_id, poleKey, texture, occurred_at)`. Use it (and keep the drift
    test happy).
  - Membership at the raise instant comes from `membership_history`
    (`membershipAt`, as the kills consumer uses), not from the current roster.
    A member who has since left still counts as having raised it for X.
  - Attribute to the **raiser's clan**, not to whoever owns the texture today.
    After a rebrand the texture can belong to someone else.
- **Why "raised by a member" matters.** A lowered flag can be carried off. A
  raider could raise a rival's flag on their own pole and have a friendly clan
  lower it for points. Requiring a member raise blocks that farm.
- **No collusion guard (owner decision, 2026-11-06).** Two friendly clans could
  raise their own flags on throwaway poles and take turns lowering them: full
  value once per 24 h per pair, uncapped heat, nothing at stake. The owner
  accepted this risk explicitly. Don't add a guard. Away-from-base raids
  follow the ordinary `RAID_DEDUP_MS` rule and nothing more.

Calls I made:

- **A raid on X that isn't at X's own declared base (an away pole, or X's flag on Y's base) doesn't set X's `flag_down_since`** and doesn't cost X the crate.
  It isn't the clan's base, so it mustn't drive dormancy. It does go
  to `#war-log` like any raid (no coordinates, as always). It queues a clan
  notice saying a flag of theirs away from base was lowered. Builder: add a
  notice kind, no position in the payload.
- **The war-log line doesn't say whether it was the base or a stray flag.**
  Saying so would hint at base locations.

## 3. Raid window and the scoring week

- `RAID_WINDOW` becomes Friday **14:00 UTC** to Sunday **14:00 UTC** (48 h,
  half-open as today). `raidWindowAt` (`packages/domain/src/raid-window.ts`)
  currently works in whole days from midnight. It needs an hour.
- **14:00 UTC is fixed year-round on purpose.** Restarts run on even UTC
  hours, and the base-damage flip only lands at a restart. In LA time that's
  6 AM in winter and 7 AM in summer. (Owner decision.)
- Update the raid-window announcements, `docs/deploy/raid-window.md` (held to
  `RAID_WINDOW` by `raid-window-runbook.test.ts`), the guide, and every copy
  string that says "Friday 00:00 UTC to Monday 00:00 UTC".
- **The scoring week ends when the window closes: Sunday 14:00 UTC.** It
  replaces Monday 00:00 UTC for `raids.week_start`, `alpha_weeks`,
  `seasons.week_closed_through`, the week close, and the weekly award.

Call I made: `weekStartOf` is shared with `apps/show/src/weeks.ts` and
`packages/roster/src/scoring.ts`. Add a separate scoring-week function and leave
the weekly show on its own Monday calendar unless the builder finds the
show reads Alpha weeks directly. If it does, move it with scoring and say so in
the plan.

## 4. The weekly raid award

- At each scoring-week close, the clan ranked #1 for that week (the existing
  `weekTopThree` order: most points that week, then its tie-breaks) wins the
  catalogue's `weapon-kit` award for 7 days (new constant, same length as
  `REFERRAL_AWARD_DAYS`).
- **Granted to the clan's leader at the moment of the close** (owner decision).
  The leader can give it to a clanmate through the existing award transfer
  (`giveAwardDb`). Nothing new is needed for that.
- No clan scored that week → no award.
- Model it on the referral payout (`apps/bot/src/referral-award.ts`,
  `grantAwardTx`): a payment-record row whose insert is the idempotency guard,
  an announcement, and gating on an env flag, off by default.

Calls I made:

- **The payout runs in or right after the week close.** The winner is the
  same `alpha_weeks` rank 1 row, so the Alpha badge and the award can never
  disagree.
- **If the leader is unlinked, the grant is held.** The bounty-prize pattern
  pays it when they link. Builder: confirm a leader can actually be unlinked
  today. If not, drop the held path.
- **The announcement posts to `SERVER_EVENTS_CHANNEL_ID`,** where the referral
  award posts, plus the leader's DM via the grant.

## 5. `#scoreboard` and `/scoreboard`

Approved mockup (the "B + C" combination):

- **First embed: "💰 What a raid pays right now."** One row per active clan,
  sorted by current value. Each row shows tag, price, and reasons:
  - 🔥 *N recent raids* (raids landed in the last `RAID_HEAT_FADE_MS`)
  - 🩹 *hit N times this week* (hits taken in the last `RAID_HIT_FADE_MS`)
  - 🐣 *new, counts from <date>* for a clan under a week old (price 0)
- Then one line naming dormant clans: "can't be raided".
- Footer: "A raid pays the price at the moment the flag comes down. 🔥 raids in
  the last 14 days push it up; 🩹 hits in the last 7 days pull it down."
  (Numbers from `rules.ts`, not literals.)
- **Standing cards below** keep their current shape plus a short "💰 172" beside
  the points. The price list takes one of Discord's 10 embed slots, so
  `MAX_CARDS` for clan cards drops to 9.
- The site's `/scoreboard` shows the same price list. The post's comment says
  the two match, so keep it true.

Calls I made:

- **The price shown is what a raid would pay right now, multiplier included.**
  A 🟢 beside the row means someone from that clan is online (×1.5).
  Otherwise the row shows the ×0.75 offline price. The footer gains one line
  explaining the 🟢. Who is online is already public (the online board and the
  Live page), so this reveals nothing new, and it keeps the anti-goal: the
  shown price is the paid price. As a result the post is edited when a clan's
  online state flips, which the 5-minute reconcile absorbs.
- **Reasons are counts, never relative times like "9h ago".** The post is
  edited only when `scoreboardKey` changes. A relative time would force an edit
  every pass, or go stale.
- **The key includes each clan's rounded price and reason counts.** Prices
  drift as heat and hits fade, so the post re-edits whenever a rounded price
  changes, roughly every few hours per clan. That's acceptable on the
  existing 5-minute reconcile.

## 6. Recalculating season 3

The owner wants this season's scoreboard recalculated under the new rules.

- Replay season 3's `raids` rows in order. Recompute and rewrite
  `raids.points` (plus the online flag) and the `season_standings.points`
  projection. `raids.week_start` is NOT rewritten (see the cutover below: the
  bridging week starts Monday 2026-11-02, so its rows are already right). Then let
  `scripts/rebuild-standings.ts` (or an extension of it) prove the projection
  matches. A one-off script with the same `factions_live` guard and
  `--dry-run`, plus a runbook in `docs/deploy/`.
- `victim_rank_at_lower` / `ranked_count_at_lower` no longer mean anything for
  new rows. Either store null going forward or replace them with the value
  inputs. The builder decides, with a migration.

**Closed weeks are frozen as history** (owner decision, 2026-11-06). Weeks
closed before launch keep their `alpha_weeks` rows, `week_closed` war-log lines,
`@Alpha` history and weekly-show episodes exactly as they are. Their raid rows
keep their old `week_start`. Only `points` (and the new online flag) are
rewritten. No weapon kit is paid for a week that closed before launch.

**The cutover (ships 2026-11-06).** The week open at launch, Monday
2026-11-02 00:00 UTC, becomes the **bridging week**, closing at **Sunday
2026-11-08 14:00 UTC** (6 days 14 h). From then on, weeks run Sunday 14:00 to
Sunday 14:00 UTC. The bridging week is the first one crowned under the new
rules, and the first to pay the weapon kit, since it closes after launch.
The weekly show follows the same cutover. It reads `alpha_weeks` and
`raids.week_start` (`apps/show/src/story/context.ts`, `apps/show/src/weeks.ts`,
which today refuses a non-Monday week start), so it has to accept the bridging
week and Sunday-14:00 starts afterwards. Its existing episodes keep their
Monday keys.

Calls I made:

- **Only existing raid rows are rescored.** Old-flag lowerings from before the
  ship date aren't detected retroactively.
- **Old `#war-log` lines aren't edited.** They're a record of what was posted.

## What's left to the builder

- Table and column names, migrations, and where the pure value function lives
  in `packages/domain`.
- Whether `raid-tick` reads the season's recent raid rows per lower (small data:
  19 rows in season 3) or keeps a cache. Correctness first: the price shown and
  the price paid come from the same function.
- Lock order: the old-flag path reads `events` and `membership_history` (no
  locks) before locking the victim's `factions` row, the same shape as today.
  Any new table goes into spec §4.12's order in CLAUDE.md.
- The guide rewrite: chapters 05 (raiding), 07 (scoreboard) and 13 (rules on
  one page), via `guide-numbers.ts` tokens. Also the ⚠️ notes in CLAUDE.md for
  the new rules.
- The changelog entry, and the player announcement. A draft exists from the
  design conversation.
