# Faction dormancy — design

**Date:** 2026-09-02
**Covers:** detecting that a faction's flag has stopped flying, cutting its
supplies, and eventually releasing its flag, tag and pole
**Builds on:** faction supplies (the projection this gates), roster core
(`factions` rows with a pole, a texture and a status), live ingest (a running
worker writing `flag.raised` events)
**Amended:** 2026-09-02 — §3 gains a `pause` transition; see §3.3

---

## 1. Purpose

The server runs `FlagRefreshMaxDuration = 7 days`: a territory flag must be
re-raised weekly or the base it protects begins to decay. Nothing in the ADM
log marks that expiry. A flag that a player lowers is logged; a flag that
simply runs out is not.

So a faction that stops playing never emits an event, never changes status, and
keeps receiving a supply kit at a decaying base forever. Supplies are the
scarce thing this game economy hands out, and today the only way to stop them
is to disband — a deliberate act by a leader who has, by definition, left.

This design makes absence itself the signal.

### In scope

- A per-faction staleness clock, reset by that faction raising its own flag
- `active -> dormant` at 7 days, which cuts supplies
- `dormant -> active` on any qualifying raise, which restores them
- `dormant -> disbanded` at 14 further days, releasing flag, tag and pole
- A DM to the leader on going dormant and on reviving

### Out of scope, deliberately

- **Raid-driven dormancy.** The master spec's `ACTIVE -> DORMANT` transition is
  triggered by "capital flag down past grace window" — a `flag.lowered` event
  plus a 24h grace. That is a different trigger with a different meaning
  (someone did this to you, versus nobody did anything at all) and it needs its
  own design. This one fires on silence.
- **Reading `FlagRefreshMaxDuration` off the server.** See §7.
- **Public announcements.** Telling a channel that a faction has gone quiet is
  telling everyone whose base is undefended. The leader is DMed; nobody else is
  told.
- **Reserved factions.** A `reserved` faction has not raised its flag yet by
  definition, and already has its own 24h reservation lapse.

---

## 2. Decisions

### 2.1 `HOLDING_STATUSES` is split, not narrowed

The obvious implementation — take `dormant` out of `HOLDING_STATUSES` so the
supply projection stops seeing it — is wrong, and would break three things.

`dormant` is written into three partial unique indexes in the schema:

```sql
factions_holding_texture_uniq  WHERE status IN ('reserved','active','dormant')
factions_holding_tag_uniq      WHERE status IN ('reserved','active','dormant')
factions_holding_pole_uniq     WHERE status IN ('reserved','active','dormant')
```

Those indexes are what stop a dormant faction losing its identity, which the
master spec is explicit about: getting raided "can never cost it its identity".
The TypeScript constant and those SQL predicates are two statements of one
fact. Removing `dormant` from the constant would silently diverge them — the
precise drift the constant's own comment warns about — and would also refuse
roster writes for dormant factions (so nobody could invite help to revive one)
and hide them from `store.ts`'s membership lookup (so members would be told
they are not in a faction).

`HOLDING_STATUSES` therefore keeps its exact current value and gains a sharper
name in its docstring: **it means "holds flag, tag and pole", nothing else.**

Supply eligibility becomes its own set:

```ts
export const SUPPLIED_STATUSES = ["reserved", "active"] as const;
```

`reserved` is in it deliberately — per the supplies design, the kit is what
lets a new faction raise its flag in the first place. `dormant` is not. The
supply projection's status filter swaps `HOLDING` for `SUPPLIED`, and that one
line is what actually stops the kit.

⚠️ Two similar-looking sets now exist, and the scarcity indexes are still SQL
literals. §6 adds a test that reads `pg_indexes` and asserts the predicates
still match `HOLDING_STATUSES`, so the drift is caught by a failing test rather
than by a faction losing its tag.

### 2.2 The signal is `events`, not `flag_changes`

`flag_changes` is the projector's read model and holds **zero rows** in
`factions_live` — the projector does not run against live. The usable source is
the event log itself, which `ceremony-tick` already reads the same way:

```
type = 'flag.raised'
  AND server_id = faction.server_id
  AND payload->>'poleKey'  = faction.pole_key
  AND payload->>'texture'  = faction.texture
```

`max(occurred_at)` over that is the faction's last refresh.

**Texture is part of the match.** A raid that ends with a rival's flag over your
pole, or a white flag raised by a passer-by, must not keep your supplies alive.
DayZ's own decay timer is less discriminating — the game refreshes on any
raise — so this is deliberately stricter than the server's rule, in the
direction of cutting supplies sooner rather than later.

**Falling back when there is no raise at all.** `COALESCE(max(raise),
activated_at, created_at)`. Activation is itself triggered by the faction's flag
going up, so a raise normally exists; the fallback covers a faction whose
activating raise predates the ingested window.

### 2.3 `dormant_since` is stored, not derived

The whole lifecycle can be derived from the last raise: dormant at
`lastRaise + 7d`, disbanded at `lastRaise + 21d`, no new column. That is
rejected.

Derived timing means the disband clock runs during periods when nothing was
watching. If the bot is down for three weeks, or a faction's last raise predates
ingestion, the first tick after deploy disbands factions that were never given a
chance to refresh — releasing a flag, a tag and a pole with no human in the
loop and no way back.

`factions.dormant_since` (nullable timestamptz) makes "14 days dormant" mean
fourteen days *observed*. The clock starts when the system starts watching.
Disband is the only transition here that destroys identity, so it is the one
that should be conservative.

The column is NULL for every status but `dormant`, cleared on revival, and
stamped by the same guarded UPDATE that sets the status.

### 2.4 The tick lives in the bot

The bot already owns faction-state writes (`ceremony-store` sets `lapsed`) and
is the only process with a Discord client for the DMs. The worker owns
supplies but has neither.

So the bot writes status; the worker's next sweep reads it and regenerates the
file. The two never coordinate — supplies are a projection of the factions
table, which is exactly how disband and reservation-lapse already work.

`dormancyTick` joins the existing guarded job in `startBot` alongside
`runPlayerProjection`, `verificationTick` and `ceremonyTick`, with its own
try/catch, for the reason the ceremony steps already have theirs: a throw here
must not stop verification or ceremony DMs.

### 2.5 Revive is evaluated before disband

Within one tick: revive, then go dormant, then disband.

A faction that raises its flag on day 20 of dormancy must be rescued by that
tick, not disbanded by it. Evaluating disband first would make the outcome
depend on tick timing, and the loss is irreversible.

---

## 3. Transitions

| From | Condition | To | Side effects |
|---|---|---|---|
| `dormant` | last raise within 7 days | `active` | `dormant_since` cleared, leader DMed |
| `active` | no raise for 7 days | `dormant` | `dormant_since` stamped, leader DMed, supplies stop next sweep |
| `dormant` | `dormant_since` older than 14 days, **and the server is live** | `disbanded` | flag, tag and pole released; roster cleared, invites revoked — see §3.2 |
| `dormant` | the server has produced no event for 7 days | `dormant` | `dormant_since` re-stamped to now — the countdown restarts; no DM. See §3.3 |

`reserved` and `disbanded` factions are never examined.

**Windows are configuration, with the defaults above:** `BOT_DORMANT_AFTER_MS`
(604_800_000) and `BOT_DISBAND_AFTER_DORMANT_MS` (1_209_600_000), read through
the existing `positiveInt` helper so a malformed value throws at startup rather
than silently defaulting.

### 3.1 Decision is a pure function

```ts
type FactionClock = { status: string; lastRaiseAt: Date | null; dormantSince: Date | null };
type Transition = "revive" | "dormant" | "disband" | null;
decide(clock: FactionClock, now: Date, windows: Windows): Transition
```

Every boundary is unit-testable with no database: exactly-at-7-days, one
millisecond either side, a dormant faction with a fresh raise, a dormant faction
with no `dormant_since` (which must never disband — see §5).

The store applies the decision; it does not make it.

---

### 3.2 Auto-disband must do everything `disband` does

`PgRosterStore.disband` is not a status write. It is a transaction that also
deletes every `faction_members` row and revokes every outstanding
`faction_invites` offer, and both matter:

- membership rows left behind point at a disbanded faction. `store.ts`'s
  membership lookup filters on `HOLDING_STATUSES`, so the members would
  silently vanish from their own faction while their rows survived — and would
  then collide with `faction_members_server_player_uniq` if they joined
  another faction on the same server.
- a live invite to a faction that no longer exists is acceptable to every
  guard on the accept path except the `HOLDING` filter, which turns it into a
  confusing refusal rather than a clean one.

So the dormancy tick's disband shares that transaction body, with the leader
check replaced by the dormancy condition — not a second implementation of it.

⚠️ It must also take its locks in the same order as `disband`
(`factions`, then `faction_members`, then `faction_invites`). Inbox item 19
records that this convention is a comment with no enforcement, and that a
deadlock was already built once out of two separately-correct changes taking
two tables in opposite orders. This is a third writer to the same three tables.

### 3.3 The disband countdown measures OBSERVED silence (added 2026-09-02)

The original design withheld a disband while the faction's server looked dark,
which is necessary and was not sufficient. The countdown kept running through
the blind window, so a `dormant_since` stamped during an ingest outage aged on
evidence nobody had, and the first tick after recovery disbanded a faction that
had been *watched* for less than the full 14 days. The inbox item 26 replay is
concrete: ingest down days 0-20, a genuine raise on day 10 that nothing could
see until the backfill, and a disband on day 21 backed by 11 days of anything
observed.

A dark server therefore now **re-stamps** `dormant_since` rather than merely
refusing. The countdown restarts from the moment observation resumed, which is
the only interval the 14-day window can honestly claim.

Ordering inside `decide()` is load-bearing and tested at each boundary:

1. `revive` — evidence beats the absence of evidence, exactly as it beats disband.
2. `stamp` — a dormant row with no timestamp; guarded on `IS NULL` in the store.
3. `pause` — server dark; guarded on `IS NOT NULL`, the complement of `stamp`.
4. `disband` — due, on a live server.

`pause` sits **ahead** of the due check, not after it. Behind it, the clock
would still accrue on every tick that was not yet due, which is the whole
defect.

Going `active -> dormant` is deliberately still ungated: it is reversible, it
only cuts supplies, and gating it would leave a faction fed at a decaying base
for the length of an outage. The consequence — every faction on a dark server
goes dormant together and loses supplies — is unchanged from the original
design and is accepted for the same reason.

**What this does not fix:** a genuinely dead game server still never releases
its flags, because the pause is indefinite by construction. That remains inbox
item 26's third bullet, and the pause at least makes it *loud*: the tick counts
`paused` and the bot logs it at error level, so the state is visible from the
bot's own logs rather than being indistinguishable from a quiet week.

## 4. Notifications

Two DMs, both to the leader only.

**Going dormant** names the faction, says the flag has not flown in seven days,
says supplies have stopped and will return on the next restart after the flag
goes back up, and says how long remains before the flag returns to the pool.
This is the only signal a player gets — the game itself says nothing when a flag
expires.

**Reviving** confirms the flag is counted and supplies resume at the next
restart, so the fix is visibly connected to the action.

**No pole coordinates in either.** The leader is entitled to them, but a DM is
screenshottable and the message does not need them.

⚠️ **At-most-once, not at-least-once.** The status UPDATE is guarded
(`WHERE status = 'active'` … `RETURNING`), so only the tick that actually
performed the transition sends. A DM that then fails is logged and not retried:
the alternative is re-deriving "should have been told" from state, which would
re-DM every dormant faction on every tick after any transient Discord failure.
This is the opposite trade-off from `notifyCompleted`, which sends before
marking, and the reason differs — a missed completion DM strands a player who
did everything right, while a missed dormancy DM costs a leader a warning about
a state they can see and reverse at any time.

---

## 5. Failure handling

- **No `flag.raised` events at all for a server** (fresh ingest, or the worker
  down): every faction looks stale simultaneously. The `activated_at` fallback
  in §2.2 covers the normal case; the `dormant_since` design in §2.3 is what
  stops the pathological one becoming mass disbandment, since nothing can
  disband until it has been *observed* dormant for 14 days.
- **A `dormant` row with NULL `dormant_since`** — possible only if something
  outside this tick set the status. It is never disbanded; the tick stamps
  `dormant_since = now` and lets the clock start. Losing a flag to a missing
  timestamp is not acceptable; waiting an extra 14 days is.
- **The tick throws** — its own try/catch, no effect on the other jobs.
- **The DM fails** — logged once, per §4.
- **Supplies do not stop instantly.** The spawner file is read at mission start,
  so a dormant faction's kit persists until the next restart. The master spec
  already calls this "hours, not instantly, which is the right feel".

---

## 6. Testing and acceptance

- `decide()` at every boundary, including the NULL-`dormant_since` case
- Store-level, against the real database: each of the three transitions
- **Revive beats disband** — a dormant faction 20 days in with a raise
  yesterday comes back `active`, and is not disbanded by the same tick
- **Texture discrimination** — a raise of a *different* texture at the same
  pole does not reset the clock
- **Supplies** — a dormant faction is omitted from the generated file, and the
  file's hash changes accordingly
- **Auto-disband clears the roster and revokes invites**, not just the status
  (§3.2) — asserted on the tables, not on the return value
- **Index drift** — read `pg_indexes` and assert the three
  `factions_holding_*_uniq` predicates still enumerate exactly
  `HOLDING_STATUSES` (§2.1)
- **`SUPPLIED_STATUSES` is a subset of `HOLDING_STATUSES`** — a supplied
  faction that does not hold its pole is incoherent

Acceptance on live: with one active faction (COK, last raise 2026-09-01), the
first tick after deploy must transition nothing. That is the check that the
clock is reading real data and not defaulting.

---

## 7. Carried forward

**`FlagRefreshMaxDuration` is copied by hand.** `BOT_DORMANT_AFTER_MS` defaults
to seven days because the server is currently set to seven days. Change one and
not the other and they diverge silently, in the direction of either cutting
supplies at a base that is still fine or feeding one that has already decayed.

The server's own value is readable: `cfggameplay.json` sits in the mission
directory and the Nitrado client can download it — this was verified on
2026-09-02 while checking `objectSpawnersArr`. Deriving the window from it would
keep the two in lockstep. Not built here because the file is worker-side and
this tick is bot-side, so it needs a path between them that does not exist yet.

**Raid-driven dormancy** (`flag.lowered` plus a 24h grace) remains unbuilt, per
§1. When it lands it shares this design's state column and transitions, and the
two triggers will need a documented precedence.
