# Base-zone enforcement — design

**Date:** 2026-09-15
**Status:** approved, not yet planned
**Supersedes:** the manual "report through a ticket, staff read the log" path in
`apps/web/content/guide/12-fair-play.html` for build/dismantle/boost violations only.
Every other fair-play rule keeps its ticket path.

A non-member who builds, dismantles, or stacks boost items inside a declared base's
100 m watch zone commits a violation. The bot detects it from the ADM log, warns the
offender, and does nothing further until the base's owner presses charges. On a
report, the sentence is computed from the evidence and applied as a timed in-game ban
with no human in the loop.

---

## 1. Why this is safe to automate

The bot only ever sentences incidents **it witnessed itself**. A report carries no
free text and cannot describe an act the log did not record — it is a prosecution
toggle on an existing, evidenced incident. The owner chooses *whether* to press
charges; they never choose *what* the charge is.

That is the whole reason a player's click can trigger a ban without a staff
adjudicator standing between them. Any future change that lets a report assert
something the log did not witness breaks this property and re-introduces the need
for human review.

---

## 2. The rule

Inside `WATCH_ZONE_RADIUS_M` (100 m) of a declaration, by anyone who is neither the
solo owner nor a **full** member of the owning clan (`isMemberOf` in
`apps/bot/src/zones.ts` — pending members and guests are non-members):

| Act | Damage class | Evidence |
|---|---|---|
| Dismantling any part | **loss** | `base.dismantled` (exists) |
| Building any part | **breach** | `base.built` (exists) |
| Converting a fence to a gate | **breach + gate** | `base.built` where `isGate()` (exists) |
| A boost stack of fireplaces / garden plots | **breach** | new — §4 |

### 2.1 It applies 24/7

The rule holds inside and outside the raid window. **The enforcement path never reads
`RAID_WINDOW`.** Raids go through walls with explosives and tools; dismantling an
enemy base part is never part of raiding.

This is a deliberate rules change. `12-fair-play.html` currently says "Inside the
window, dismantling from within a base you are raiding is part of raiding. Outside it,
it never is." That carve-out is deleted — see §10.

### 2.2 Building is breach, not obstruction

A structure built inside someone else's zone is not clutter; it is a way in or out.
A watchtower clears the wall. A fence converted to a gate leaves the base
**permanently open** and is the single worst act on the list, which is why
`zone-tick.ts` already singles out gates with `isGate()`.

### 2.3 A lone fireplace is not a violation

A player can legitimately place a fireplace to cook, or a garden plot to farm,
near a base without knowing the base is there. The exploit is **stacking** them to
climb a wall. A single placement is therefore **recorded but never actionable**: it
is persisted so a later placement can form a stack with it, and it never warns and
never becomes reportable on its own.

### 2.4 There is no helper permit

A base owner who wants help building does not pre-authorise anyone. The helper is a
non-member, so the bot records the acts and sends the warning DM — but nothing
happens, because the owner simply does not report someone they invited **for that
person specifically**.

**Consequence for copy:** invited helpers *will* receive a warning DM. Its wording
carries the entire burden of not alarming them, and must read as a heads-up rather
than an accusation. See §6.1.

This was chosen over a `/base permit` command specifically to avoid new machinery. If
a permit is ever added, it must be evaluated **at event time and frozen onto the
violation row** — otherwise an owner grants a permit, gets their base rebuilt,
revokes it, and reports the helper retroactively. Same pattern as `membershipAt` in
the kills consumer.

**Amended (fix wave 2): charging is per participant, not per incident.** A report
does not cover a whole incident as an indivisible unit — it covers the incident's
DAMAGE (§7), applied to a CHOSEN SUBSET of the participants the log recorded on it.
This matters because an incident is a time-boxed bundle: `zone-tick.ts` folds every
non-member act at one base within `VIOLATION_INCIDENT_GAP_MS` into a single incident
with a single participant set. A raider stripping twenty parts and, twenty minutes
later, an invited helper placing one wall — called in for exactly the reason a raid
is happening — land in the SAME incident. Before this amendment, the owner's only
choice was whether to report that incident at all, which meant charging the raider
required also banning the helper on the raider's damage. The escape hatch this
section promises ("the owner simply does not report someone they invited") failed
in precisely the scenario it exists to cover.

The fix: `reportIncidentDb` takes an explicit set of `dayzId`s to charge, validated
against that incident's own `zone_incident_participants` rows — an id the log did
not witness on THIS incident is a refusal, never a silent skip (see §1: a report
must never describe anything the log did not witness, and accepting an
unwitnessed id would break that property as surely as free text would). An empty
selection is refused too. Liability stays JOINT **per charged person** — see §7's
amendment — so this changes only WHO can be named, not what they are sentenced on.

---

## 3. Detection: build and dismantle

`zone-tick.ts` already performs every step this needs: it reads `base.built` and
`base.dismantled` from the event log, resolves the containing zone with
`zoneContaining()`, and rejects members with `isMemberOf()`. It gains a second job
beside its existing owner alert — writing `zone_violations` rows and opening or
extending the incident.

Detection lives in `zone-tick.ts` rather than a new consumer because a second
consumer would need its own copy of the zone lookup and its own cursor, and two
consumers reading the same events is how cursors drift apart.

**Amended (fix wave 1): the incident WRITES are gated on `ENFORCEMENT_TICK`; the
owner ALERTS are not.** `zoneTick` takes a required `enforcementEnabled`. With the
flag off — the default — no incident, violation or placement row is written, while
the intruder/dismantle/gate alerts that predate this feature keep firing unchanged.

Without this gate the feature was dangerous while switched OFF: `zoneTick` ran
unconditionally, so `zone_incidents_one_open` held a single open incident per
declaration quietly absorbing months of acts and participants. The day an operator
enabled the flag, `violationTick` would close it at `now`, DM every accumulated
participant at once, and make all of them reportable on one sentence. That is the
same backlog hazard `BAN_APPLY_LOOKBACK_MS` guards for bans, one layer up.

⚠️ `zone-tick.ts`'s existing `INTRUDER_PIN_TTL_MS` staleness guard — documented there
as "the belt to the runbook's braces" — must cover the new writes too. An unseeded or
hand-rewound cursor must not be able to replay the historical log into a mass
warning, or worse, into a backlog of reportable incidents.

---

## 4. Detection: boost stacks

### 4.1 New parser and event type

`packages/adm-parser/src/placement.ts` generalises `flagpole.ts`'s `PLACED_KIT_RE`
to `placed (.+?)<(\w+)>`, yielding a new `item.placed` event type carrying the class
name and the player position.

It must be tried **after** `parseFlagPole` in `parseLine`, so that
`placed Flag Pole Kit<TerritoryFlagKit>` keeps yielding `flagpole.placed`. Appending
the branch to the end of `parseLine`'s chain is safe: each branch returns a
single-element array, so `subIndex` stays 0 and no historical event is renumbered.

The regex must be anchored on the identity block's own closing paren, exactly as
`structure.ts`'s `BUILT_RE` is and for the same reason — the gamertag is
attacker-controlled and sits earlier on the line.

**Resolved 2026-09-15.** `BOOST_ITEM_CLASSES` was inferred; it has since been checked
against 12 live ADM files. Observed verbatim:

    placed Fireplace<Fireplace>
    placed Nameless Object<GardenPlot>

⚠️ A garden plot's DISPLAY NAME is "Nameless Object". Detection therefore keys on the
classname inside the angle brackets and must never match on the display name.
Classnames also carry underscores (`Barrel_Blue` is real), which is why the capture is
`(\w+)`. `FireplaceIndoor` remains in the list unobserved: an extra classname that
never matches costs nothing, while omitting a real variant is a silently unenforced
exploit.

⚠️ **Log visibility is not the reason other items are excluded.** Barrels, crates,
tents and fire barrels all log `placed X<Class>` with a position — an earlier draft of
this spec claimed the bot could not see them, and that was false. They are out of
scope because this design covers fireplaces and garden plots. Separately and more
importantly: **a barrel cannot be stood on in DayZ**, so a barrel cluster is not a
boost at all. Which deployables bear a player's weight is a game fact the log cannot
tell you — log evidence can prove an item family is visible, never that it is
climbable. Confirm any future addition in game, not from a log sample.

### 4.2 The stack rule

Every boost-item placement inside a zone by a non-member is persisted to
`zone_placements` with `x`, `y`, `z`. A stack fires when, within
`BOOST_STACK_WINDOW_MS`, there are at least `BOOST_STACK_MIN_ITEMS` placements whose
horizontal separation is ≤ `BOOST_STACK_RADIUS_M` **and** across which the player's
altitude rises by ≥ `BOOST_STACK_MIN_RISE_M`. Mixed types count — a fireplace on a
garden plot is the same exploit.

**Both signals must agree**, and each rules out a different false positive:

- **Horizontal tightness** separates stacking from farming. A garden plot has a
  ~2.5 m footprint, so two side-by-side farm plots are physically at least that far
  apart centre to centre. Two placements within ~1.5 m can essentially only mean one
  is on top of the other.
- **Altitude rise** separates stacking from a cluster of ground-level placements. To
  put the second item on top of the first you must stand on the first, so the
  player's own `y` climbs between placements. `coords.ts` gives `y` as validated
  altitude on every `pos=` line.

Requiring tightness alone would flag a fireplace dropped and replaced in the same
spot. Requiring rise alone would flag two cook-fires on a hillside. Together they
are high-confidence.

### 4.3 Attribution

Every non-member who contributed a placement to the stack is a participant. A stack
may be built by one player or by several; the model carries 1..N participants either
way.

---

## 5. Data model

Four new tables. Migration number to be assigned when the plan is written.

### `zone_incidents`
One row per `(declaration, rolling window)`. Opens on the first violating act,
extends on each subsequent one, and closes after `VIOLATION_INCIDENT_GAP_MS` of
quiet. Carries the computed damage totals (`parts_dismantled`, `parts_built`,
`stack_items`, `has_breach`, `has_gate`), the report (`reported_at`,
`reported_by_discord_id`), and the resulting sentence.

### `zone_violations`
One row per act: `incident_id`, `event_id`, damage class, part or item class name,
position, `dayz_id`, `occurred_at`. `event_id` is unique — it is what makes a
replayed event unable to double-count damage.

### `zone_incident_participants`
`incident_id`, `dayz_id`, the gamertag **frozen at event time**, and `warned_at`.

### `bans`
`dayz_id` **and** gamertag, both frozen at ban creation; `incident_id`; `banned_at`;
`expires_at` (null = permanent); `status`; `dry_run`; `applied_at`; `last_error`;
`attempts`. Durable — never rebuilt, never deleted.

The lock order in `CLAUDE.md` §4.12 must be extended to cover all four.

---

## 6. Warning, then report

### 6.1 The warning

On incident close, each participant with an `identity_links` row receives exactly one
DM. It must read as a heads-up, not a charge — invited helpers get this message too
(§2.4). Shape:

> The log recorded you dismantling 3 parts inside **[TAG]**'s declared base zone. If
> they asked you to help, ignore this. If not, an officer of that clan can report it,
> and the penalty scales with the damage.

An unlinked offender receives no DM but remains reportable and bannable — the ban is
placed against `dayzId`, which does not require a Discord link.

### 6.2 The owner's alert

The existing `dismantle` / `gate_built` / `solo_*` notices fire from `zone-tick.ts`
as they do today, gaining a pointer to `/base`.

**Amended (fix wave 2): the owner is alerted on ANY non-member build, not only a
gate.** New `built` / `solo_built` kinds name the part, so an owner can tell a
watchtower from a fence. Before this, building a watchtower inside someone else's
zone was recorded as a breach violation but produced no alert at all — it surfaced
only if the owner happened to open `/base`. That was the silent half of a wider gap:
the guide never stated the general no-building rule either, so the code was enforcing
something the rules did not say (§10).

⚠️ These alerts have **no cooldown**, unlike `intruder` (`INTRUDER_ALERT_COOLDOWN_MS`).
A raid that erects several parts inside the zone emits one notice per part. This
matches the pre-existing `dismantle` alert's behaviour rather than introducing a new
pattern, but it multiplies the volume during a real raid. A per-(declaration, dayzId)
cooldown on build and dismantle alerts is the obvious follow-up if clan channels get
noisy.

⚠️ `clan_notices` carries a `clan_notices_no_coordinates` CHECK
(`packages/db/src/schema.ts:1057`) forbidding `x`, `y`, `z` and `poleKey` in any
payload. Evidence with coordinates therefore **cannot** live in a Discord post. This
is what puts the report surface on the website rather than on a Discord button.

### 6.3 Pressing charges

On the owner-gated `/base` page, which may show full evidence including coordinates
(it already gates pole coordinates to the viewer's own base). Authority: an officer or
above via `actorFor` — the same gate `grantGuestPassDbFor` and `revokeGuestPassDbFor`
already use — or the solo declarant for a solo base. Window:
`VIOLATION_REPORT_WINDOW_MS` (7 days), so a clan that was offline for a weekend can
still act, and raids happen at weekends.

---

## 7. The sentence

A pure function in `packages/domain`, computed from the closed incident row:

```
  24h  base
+ 48h  if the incident contains any breach
+ 24h  if any breach was a fence→gate conversion
+ 12h  per part dismantled
———
  cap 7d on a first offence
  ×2 on the second upheld report in the season
  permanent on the third in the season
```

"Offence count" means upheld reports against that `dayz_id` within the current
season, counted from the `bans` table. It resets at the season boundary; a permanent
ban does not.

**Breach is flat; loss is scaled.** These are different crimes. Breaching is binary —
one watchtower is the whole act, and five stacked fireplaces are not 66% worse than
three. Loss is genuinely cumulative — twenty walls really is twice ten, and it is the
only class that costs the owner materials to undo.

**Liability is joint on the incident.** Each participant is sentenced on the
incident's full damage total, not only on their own acts. This removes the incentive
to spread dismantling across accounts so that nobody crosses a threshold.

**Amended (fix wave 2): joint liability is per CHARGED person, not per incident
participant.** §2.4 found that binding a report to the whole incident — every
participant or nobody — broke the "an invited helper simply isn't reported" escape
hatch exactly when a raid was in progress: a raider and a helper folded into the
same incident could not be charged separately. The owner now chooses WHICH
participants to charge (§2.4); this section's rule is unchanged for each of them —
**every charged person is still sentenced on the incident's full damage total**,
never only their own share of it. Joint liability was never about punishing
everyone who was present; it is about denying an attacker any benefit from
spreading the SAME raid's damage across several accounts, and that deterrent is
identical whether one, some, or all of the incident's participants end up charged.
What changed is only the selection of defendants, never the arithmetic of the
sentence.

Boost stacks are folded into this ladder rather than sentenced as exploits. That is a
deliberate softening of the written rule and requires the guide change in §10.

---

## 8. Applying the ban

Port One Life's ban methods into `@factions/nitrado`: `getBans` / `setBans` /
`addBans` / `removeBans` against `settings.general.bans` on the Nitrado settings
endpoint (see `~/Development/dayz-one-life/one-life/packages/nitrado/src/client.ts:39-96`).
This is a **live settings write** — bans take effect immediately, with no server
restart and no `ban.txt`.

A new `ban-tick.ts` runs apply and expire arms.

### 8.1 Inherited constraints

- **Ban against `dayzId` and the gamertag, both frozen at ban creation.** Never
  resolve the gamertag through a join later. One Life's architecture doc records an
  audit finding two accounts using five gamertags between them and 22 connections
  under a different name during an active ban window.
- **Batched `addBans`/`removeBans`, never looped singles.** Every mutation is a
  whole-field read-modify-write of one `\r\n`-joined string, so N singles is N round
  trips with a lost-update window between each.

### 8.2 Failure modes to design against

Each of these is a real incident from One Life's `CODE-REVIEW-2026-08-04.md`:

- **`BAN_DRY_RUN` defaults to `true`.** Audit rows are always written; Nitrado writes
  require explicitly opting in. Non-negotiable for a feature that bans on a player's
  click.
- **Time-bound the apply query.** Their unbounded detect query meant that flipping
  dry-run off applied the entire historical backlog in one tick.
- **Reference-count list entries.** Two simultaneously-active bans for one account
  share a single Nitrado entry, so the earlier expiry frees the later ban. Remove an
  entry only when no other active ban still needs it.
- **A real `failed` status with bounded attempts.** In their system a Nitrado error
  left `status='pending'`, which rendered as a permanent un-liftable ban that no
  query ever revisited.
- **Never short-circuit to `lifted`.** Always write `lift_pending` and let the tick
  confirm the removal.
- **Never enable dry-run while a ban is `applied`.** The expire arm then closes the
  row without calling Nitrado, orphaning the list entry permanently — and an orphaned
  account hash cannot be shed by renaming.

---

## 9. Numbers

All of these go in `packages/domain/src/rules.ts`. No other module may state one as a
literal; the player-facing ones flow into `guide-numbers.ts` so the guide cannot
disagree with the code.

| Constant | Value |
|---|---|
| `VIOLATION_REPORT_WINDOW_MS` | 7 days |
| `VIOLATION_INCIDENT_GAP_MS` | 30 min |
| `BOOST_STACK_MIN_ITEMS` | 2 |
| `BOOST_STACK_RADIUS_M` | 1.5 |
| `BOOST_STACK_MIN_RISE_M` | 0.5 |
| `BOOST_STACK_WINDOW_MS` | 30 min |
| `BAN_BASE_MS` | 24 h |
| `BAN_BREACH_MS` | 48 h |
| `BAN_GATE_MS` | 24 h |
| `BAN_PER_DISMANTLE_MS` | 12 h |
| `BAN_FIRST_OFFENCE_CAP_MS` | 7 days |
| `BAN_REPEAT_MULTIPLIER` | 2 |
| `BAN_PERMANENT_AT_OFFENCE` | 3 |
| `BOOST_ITEM_CLASSES` | pending log verification (§4.1) |

`BOOST_STACK_RADIUS_M` and `BOOST_STACK_MIN_RISE_M` are the two tuning knobs most
likely to need adjustment after live observation. They are the only numbers here
derived from physical reasoning rather than a policy choice.

---

## 10. Rules and copy changes

`apps/web/content/guide/12-fair-play.html`:

1. **Delete the in-window dismantle carve-out.** "Inside the window, dismantling from
   within a base you are raiding is part of raiding. Outside it, it never is." is now
   false — it is a violation 24/7 (§2.1).
2. **Move fireplaces and garden plots out of "Exploits — permanent ban"** into the
   base rules with the proportional ladder. Left where they are, the guide promises a
   permanent ban that the bot will not deliver (§7).
3. **Replace the manual enforcement path** for these violations. "A member of the
   victim clan reports it; staff read the log" becomes the automated report-and-sentence
   flow. The ticket path stays for every other fair-play rule.
4. State the ladder and the 7-day report window.

`apps/web/content/guide/13-rules-on-one-page.html` needs the same rule restated.

`CLAUDE.md` needs the §4.12 lock order extended and a note on the new consumers.

---

## 11. Testing

- **The sentence function** against a table of incidents: no breach, breach only,
  breach plus gate, loss only, the first-offence cap, the repeat multiplier, and the
  permanent threshold.
- **The stack detector** against three hand-built cases that must *not* fire — three
  garden plots side by side (a farm), two fireplaces on a hillside (slope-driven rise
  with no tightness), a fireplace dropped and replaced in one spot (tightness with no
  rise) — and one that must: a real 3-high stack.
- **`addBans` / `removeBans`** no-op write suppression, and dedup within input.
- **Reference-counted expiry** with two overlapping bans on one account: the earlier
  expiry must not free the later ban.
- **A replayed event** must not double-count damage (the `event_id` uniqueness).
- **A rewound cursor** must not mass-warn, per the `INTRUDER_PIN_TTL_MS` guard (§3).
- **`item.placed`** parser: a flag pole kit still yields `flagpole.placed`; a gamertag
  carrying literal `placed X<Y>` text cannot forge an event.

---

## 12. Out of scope

- Any change to intruder alerting, the map, or position retention.
- A `/base permit` command (§2.4).
- Appeals, self-unban tokens, or any ban-reduction economy.
- Enforcement of the other fair-play rules, which keep their ticket path.
- The `FlagRefreshMaxDuration` 7→14 day copy fix, which is separate bounded work
  tracked outside this spec.
