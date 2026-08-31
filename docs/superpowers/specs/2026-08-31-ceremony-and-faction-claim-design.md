# Ceremony detection and faction claim — design

**Date:** 2026-08-31
**Covers:** spec §3 (core model, flag pool, tenancy), §4 (lifecycle), §5 (the ceremony)
**Builds on:** Plan 1 (ADM ingest, flag events, pole projection), Plan 2 (identity linking)

---

## 1. Purpose

Plan 1 turned ADM logs into events. Plan 2 bound a Discord account to a DayZ UID. Neither
produced a *faction*. This design is the first thing that consumes the identity binding, and it
is what four items in `PLAN-3-INBOX.md` are blocked on — they all reduce to "factions do not
exist yet".

The output is a faction that came into being through a physical act in-game, verified from the
log, rather than through a registration form.

### In scope

- The faction record, its flag, its bound pole, and its lifecycle up to ACTIVE
- Ceremony detection from the event log
- `/faction claim`, including roster pruning
- Activation by observing the faction's flag go up

### Out of scope, deliberately

- **§6 roster management** — invites, kicks, promotion, leadership challenge. `faction_members`
  is created here because activation must check it, but no command manages it yet.
- **§7 raid credit and rankings** — the consumer of pole binding, not part of establishing it.
- **Discord roles and channels** (§10) — a faction is a database record here, not a Discord
  structure.
- **Dormancy, rebind, and disband** (§4's later edges) — they need pole-loss handling and the
  projector's unbound-fold question (inbox item 3) settled first.

---

## 2. Decisions, and where they diverge from the spec

Every divergence below was taken deliberately. The spec sections remain the intent; these are
the corrections that survived contact with the actual event shape.

| Decision | Spec said | Rationale |
|---|---|---|
| **Only the raise counts** | "each performing a lower → raise pair" | The raise is the meaningful act and it carries the texture. Dropping the pairing removes ordering ambiguity (three people interleaving at one pole produce raise-before-lower for some UID), and removes any dependence on reconstructing the pole's texture over time — see §3. |
| **The raise must be `Flag_White`** | pole "flying `Flag_White`" | Same requirement, relocated from pole state to event content. This is what makes the predicate self-evidencing. |
| **Only linked UIDs count** | not stated | Participants must already have run `/link`. Makes Plan 2 a hard prerequisite, guarantees every participant is reachable by DM, and means the claimant check is a lookup rather than a trust decision. Cost: near-misses are invisible (§7). |
| **DM the participants; no public post** | "The bot posts the detected ceremony" | A ceremony stays private until claimed, so rivals cannot watch for unclaimed poles. Viable only because of the linked-only rule above. |
| **New `RESERVED` state** | PROVISIONAL → ACTIVE directly | A faction whose flag has never physically gone up is a Discord row, not a faction. Activation by observed raise keeps "physical event before Discord record" true end to end, and reuses machinery already being built. |
| **Key on `server_id`, not `(server_id, map)`** | "carries `(server_id, map)` as a composite key … from day one" | `servers.map` already exists, so `server_id` determines map. Carrying both invites the two disagreeing. The tenancy property §3 wants — factions are per-map — holds through the join. |
| **No `flag_pool` table** | "flag pool" as a structure | The 33 claimable textures are a constant; availability is that constant minus factions currently holding one, enforced by a partial unique index. Disbanding frees a flag with no bookkeeping. |

### The predicate

> **≥3 distinct linked UIDs each raising `Flag_White` at the same unbound pole, within a
> 10-minute window.**

Lowers are ignored entirely.

### Why this still separates cleanly from noise

The spec's anti-noise argument rests on the UID count, not on the pairing. Routine base-persistence
maintenance is a *single* UID — the live log shows exactly one player lowering at `19:55:19` and
re-raising at `19:55:28`, on a weekly cadence. Three distinct UIDs at one pole inside ten minutes
does not happen by accident, and `Flag_White` is by definition the unclaimed flag, so the
population this catches is the population that should be founding factions.

This predicate is strictly easier to trigger than the spec's. That is accepted.

---

## 3. Why the predicate is self-evidencing, and why that matters

Every counted event carries `texture: "Flag_White"` in its own payload. The detector therefore
never reconstructs what a pole was flying at a past instant, and takes no dependency on the
`pole-projector`'s flag-change history.

This matters more than it first appears. Pole texture over time is derived state, rebuilt by
replaying events in order; a detector reading it would be correct only if its cursor and the
projector's cursor were in a known relative position — a coupling with no enforcement and a
silent failure mode. Reading the texture off the event under examination has neither problem.

---

## 4. Data model

### `ceremonies`

| Column | Notes |
|---|---|
| `id` | |
| `server_id` | |
| `pole_key` | The `x:y:z` key Plan 1 already normalizes to ~1cm |
| `window_start`, `window_end` | Event time, not wall clock |
| `status` | `provisional` \| `claimed` \| `expired` |
| `detected_at`, `expires_at` | `expires_at = detected_at + 24h` |

- Partial unique index on `(server_id, pole_key) where status = 'provisional'` — one outstanding
  ceremony per pole. The index is the check.

### `ceremony_participants`

`(ceremony_id, dayz_id, discord_id)`, unique on `(ceremony_id, dayz_id)`. `discord_id` is
denormalized from `identity_links` at detection time so the DM path does not re-resolve it, and
so the participant list is a record of who was linked *then*.

### `factions`

| Column | Notes |
|---|---|
| `id`, `server_id` | Map read through `servers` |
| `name`, `tag` | Player-chosen; tag is used for later channel naming |
| `texture` | One of the 33 claimable flags |
| `pole_key`, `x`, `y`, `z` | Bound at claim, from the ceremony |
| `status` | `reserved` \| `active` \| `dormant` \| `lapsed` \| `disbanded`. `dormant` is carried in the enum and in the holding set now, though nothing in this plan transitions into it — the §4 edges that do are out of scope, and adding a status to a live enum later is worse than carrying one unused |
| `leader_discord_id` | |
| `ceremony_id` | Provenance — which ritual produced this faction |
| `reserved_until`, `activated_at` | |

**Holding statuses** are `reserved`, `active`, and `dormant`. Three partial unique indexes cover
`where status in ('reserved','active','dormant')`:

- `(server_id, texture)` — one faction per flag per server
- `(server_id, lower(tag))` — tags are case-insensitively unique
- `(server_id, pole_key)` — one faction per pole

A `lapsed` or `disbanded` faction releases all three at once, which is the whole reclamation
mechanism §4 asks for.

### `faction_members`

`(faction_id, discord_id, dayz_id, role)` where role is `leader` \| `officer` \| `member`,
unique on `(faction_id, dayz_id)`. Created here only because activation must verify the raiser is
on the roster. No command manages it in this plan.

### `white_raises`

The detector's working projection: `(id, server_id, pole_key, dayz_id, occurred_at, event_id)`,
unique on `event_id`.

One row per qualifying raise. Its purpose is to make the 10-minute look-back an indexed range
scan on `(server_id, pole_key, occurred_at)` rather than a JSON predicate over the whole `events`
table, and the unique `event_id` makes the detector idempotent under replay.

---

## 5. The detector

A new consumer over the event log. Cursor name: **`ceremony-detector`**.

> ⚠️ Distinct from `pole-projector` and `identity-verifier`. Two consumers sharing a cursor name
> each skip the other's events, and the symptom is "detection randomly doesn't work" rather than
> an error. This is the third consumer; the collision is no longer hypothetical.

### Windows settle; they do not fire on the third raise

A window at a pole **opens** on the first qualifying raise and **settles** ten minutes later. The
participant set is everyone counted in the settled window.

**Windows are non-overlapping and anchored at the oldest unconsumed raise.** When a window
settles, every raise inside it is consumed — whether or not it produced a ceremony. The next
window opens at the oldest raise after it, not at a sliding offset. So three raises at minutes
0, 5 and 11 are two windows (0–10 and 11–21), not one, and the minute-11 raise cannot retroactively
join a window that has already closed. A sliding window would instead let a slow trickle of raises
at a busy pole accumulate into a ceremony nobody performed.

**While a provisional ceremony is outstanding at a pole, no new window opens there.** Its raises
are consumed as they arrive. Otherwise a pole would generate a ceremony every ten minutes for as
long as people kept raising White on it, and only the first could ever be inserted — the partial
unique index would reject the rest as errors rather than as the no-ops they are.

Firing the moment a third distinct UID appears is the obvious implementation and it is wrong: a
fourth person raising two minutes later would find the ceremony already created and themselves
off the roster — a founding member silently excluded, which the claim step cannot repair because
it can only prune. The participant set is not knowable until the window closes.

### Settling is judged by the log's clock

A window settles when `window_start + 10min` is older than **the newest ingested event time**,
not `Date.now()`.

> ⚠️ This is the difference between a detector that works and one that quietly loses
> participants. `apps/ingest-worker` is a one-shot batch that nothing in the repo schedules
> (inbox item 9), so ingest lag is real and unbounded. Wall-clock settling closes a window before
> its own events have been ingested, dropping every late participant, and does so silently. Using
> the log's own high-water mark makes backfill and live ingest behave identically — which is also
> what makes the fixtures meaningful, since a fixture replayed in milliseconds must exercise the
> same path as a live ceremony.

### Qualification

A `flag.raised` event counts when all of:

1. `payload.texture === "Flag_White"`
2. The pole is not bound to a faction in a holding status
3. The raiser's `dayz_id` has an `identity_links` row **at processing time**

Point 3 is evaluated when the detector reads the event, not when the flag was raised — so someone
who links shortly after the ceremony still counts. This is the forgiving reading, and it costs
nothing.

### On settling

If a settled window holds ≥3 distinct qualifying UIDs, insert a `ceremonies` row plus its
participants and DM each participant. Fewer than 3: the window closes with no record beyond the
`white_raises` rows.

### Notification

Reuses Plan 2's `notifyCompleted` shape, which already gets the hard part right: a send failure
leaves the row pending so the next pass retries, rather than marking it done and dropping the
message. Notification runs under its own try/catch, separate from detection (inbox item 11).

The DM names the pole, lists the participants, gives the claim instructions, and states **how many
linked UIDs were counted**.

---

## 6. Claim and activation

### `/faction claim <name> <tag> <flag>`

Runs only for a Discord account whose linked UID is among the ceremony's participants — §5's
defense against someone claiming a ceremony they did not attend. A cheap lookup, since
participants are linked by construction.

The reply is ephemeral and carries a participant multi-select (pre-selected) plus a confirm
button. This is the spec's "the claimant prunes before confirming", and it is the only defense
against a stranger who wandered into the ritual landing on the founding roster.

Confirm, in one transaction:

1. Insert the faction as `reserved`, bound to the ceremony's pole, `reserved_until = now + 24h`
2. Insert the pruned roster, claimant as `leader`
3. Mark the ceremony `claimed`

### Races resolve on indexes, not on pre-reads

Two participants claiming one ceremony concurrently, or two ceremonies picking the same flag:
both writes are guarded on the state they assumed and read their own `.returning()`.

> ⚠️ Plan 2 needed this correction twice — a pre-read that a concurrent writer invalidated, once
> reporting a completion with no link row behind it, and once violating a state constraint in a
> way that wedged a batch cursor forever. Do not pre-read and then write.

The loser of a flag race is told "that flag was just taken, pick another".

### Activation

Rides the same detector tick. A `flag.raised` whose texture matches a `reserved` faction's, at
that faction's bound pole, performed by a UID on its confirmed roster, sets `status = 'active'`
and `activated_at`. Everything needed is already in the event the detector is reading.

### Lapse

A reservation lapses when **both** the wall clock and the log's high-water mark have passed
`reserved_until`.

> ⚠️ The log-clock half is not redundant. If ingest stalls for a day, wall-clock-only lapsing
> would retire a faction that *did* raise its flag, because the proof was never ingested. Wall
> clock decides the deadline; the log clock confirms we had the opportunity to observe it.

A lapsed reservation releases flag, tag, and pole, and the pole becomes eligible for a fresh
ceremony. Provisional ceremonies expire on the same two-clock rule.

### Timers

| Timer | Value | Source |
|---|---|---|
| Ceremony window | 10 minutes | §5 |
| Provisional expiry | 24h | §4 |
| Reservation expiry | 24h | This design — matched to provisional expiry; a reserved flag is out of a 33-slot pool and §3 is emphatic that scarcity is doing real work |

---

## 7. Threat model

| Attack | Defense |
|---|---|
| A stranger joins the ceremony and lands on the roster | The claim step lists participants; the claimant prunes before confirming |
| Someone else claims your ceremony | The claimant's linked UID must be among the participants |
| Ceremony at an established faction's pole | Bound poles do not qualify |
| **Fabricated participants via gamertag injection** | The anchored parsers from PR #2. A detector that counts distinct UIDs is a new consumer of that guarantee, and "3 distinct UIDs" is precisely what an injected line would try to manufacture. One adversarial fixture is mandatory (§8) |
| Rival watches for unclaimed poles | Ceremonies are DM'd, never posted publicly |
| Rival activates a faction's reservation | The activating raise must come from a roster UID |
| One person cycling alt accounts | Not solvable here. Now requires 3 *linked* alts, which raises the cost but does not close it; depends on separate alt-prevention work |

### Accepted: near-misses are invisible

Three people perform the ritual, one is not linked, nothing happens — and that person cannot be
told why, because we have no Discord id for them.

Mitigated, not solved: `/link` is a documented precondition, and the DM to the participants who
*were* counted states the count, so a group that came up short can work out who is missing. A
group where nobody is linked gets nothing at all, and that is accepted.

---

## 8. Testing and acceptance

### A pure core

Window settling and participant counting live in a pure module taking qualifying raises plus the
log high-water mark, returning settled windows. No database, no clock — the same shape as
`@factions/verification`. The edge cases belong here: a fourth participant at minute nine, a
window that must not settle while the high-water mark is behind it, an eleventh-minute raise
opening a new window rather than joining the old one.

### Fixtures at the ADM line level

Written as real log lines, so they exercise the parser as well as the detector:

| Fixture | Expected |
|---|---|
| 3 linked UIDs raise White at one pole in 10 min | Ceremony detected, 3 participants |
| A 4th linked UID raises at minute 9 | One ceremony, **4** participants |
| 2 linked UIDs | No ceremony |
| 3 UIDs, one unlinked | No ceremony |
| Maintenance: 1 UID, lower→raise 9s apart | No ceremony, no window |
| 3 UIDs spanning 11 minutes | No ceremony |
| Colored raises | Ignored |
| Raises at a pole already bound | Ignored |
| **Gamertag containing a White-raise clause** | **No fabricated participant** |

### Real-data acceptance, and it is zero

The historical backfill contains **no `Flag_White` events** across 69,326 lines and five weeks.
The detector must therefore find **exactly zero ceremonies** over it.

That is a genuine false-positive check, on real data, at real scale — not a synthetic one. It
goes in the acceptance doc alongside the unchanged flag counts (**14 changes, 10 raises, 4
lowers** at pole `2991.57:447.95:1138.59`), which remain the regression check that the parser and
projector were not disturbed.

### The staged ceremony is a required gate

Fixtures let this plan land. They do not let the detector be trusted in production: every fixture
encodes an assumption about what a real ceremony looks like on the wire, and no human has ever
performed one.

**Before the detector is relied on in production**, three or more linked players must stand at a
White pole and each raise White inside ten minutes, that day's ADM must be ingested, and the
result recorded in `docs/acceptance/`. This is a gate, not a suggestion, and it is the reason
this section exists rather than a verbal promise.

---

## 9. Carried forward

- **§6 roster management** — `faction_members` exists but no command manages it. The `/unlink`
  faction-membership gate (inbox item 2) becomes implementable the moment this lands, and should
  be done with §6 rather than left open.
- **Per-map channel resolution** (inbox item 6) — not forced by this design, since ceremonies are
  DM'd. It returns with §6's public commands.
- **Dormancy, rebind, disband** — needs pole-loss handling, which needs the projector's
  unbound-fold question (inbox item 3) answered first.
- **Ingest cadence** (inbox item 9) — the two-clock rules above make this design *safe* under
  ingest lag, but they do not make the product usable under it. A ceremony is not detected until
  its events are ingested; if that takes a day, the ritual feels broken. Scheduling the ingest
  worker is not optional for this feature to be good.
