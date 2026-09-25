# King of the Hill: automatic trigger and player vote — design

**Date:** 2026-09-24
**Status:** designed, not implemented
**Covers:** two new ways for a King of the Hill event to come about, beside the
admin's `/koth schedule`: an automatic trigger on the airdrop model (population at
or above a trailing high-water mark, 24 h since the last KotH, under a weekly cap),
and `/kothvote`, a public vote any linked, in-game player can open, which passes on
a two-thirds majority of a frozen electorate with a turnout floor
**Builds on:** King of the Hill (`docs/superpowers/specs/2026-09-23-king-of-the-hill-design.md`
— every opening, scoring, award and restore path is reused unchanged), airdrop
events (`docs/superpowers/specs/2026-09-20-airdrop-events-design.md`, §3.1 as
amended 2026-09-21 — the high-water rule, the decision instant, row-first-then-post),
and the no-confidence vote's frozen electorate (`faction_votes`)

---

## 1. Purpose

KotH today happens only when an admin remembers to schedule one. This makes it
happen on its own on the server's best nights, and lets the players who are on the
server ask for one when they want it.

### In scope

- `koth-decide-tick.ts`, the automatic decision, gated on `KOTH_AUTO_TICK`
- `/kothvote`, its public vote message and buttons, and `koth-vote-tick.ts`, which
  keeps the tally current and closes the vote, gated on `KOTH_VOTE`
- `koth_events.origin` and two new tables, `koth_votes` and `koth_vote_voters`
- Moving the population reads out of `airdrop-tick.ts` so both ticks share them

### Out of scope

- A prize for automatic or voted events (both are prize-less, §2.3)
- A player choosing the town (§2.4)
- A vote to cancel an event, and any vote UI on the website
- A guide chapter on server events. The guide has none today for airdrops or KotH;
  when one is written, the constants in §4 are ready for `guide-numbers.ts`

---

## 2. Decisions

### 2.1 Three origins, one row

An admin event, an automatic event and a voted event are all one `koth_events` row
in state `scheduled`, distinguished only by `origin`. Nothing downstream of that
row — `kothWanted`, the restart tick's opening and restoring, scoring, results,
cancellation, ops alerts — reads `origin` or changes.

### 2.2 The shared limits

| Limit | admin | auto | vote |
|---|---|---|---|
| One KotH `scheduled` or `live` at a time | ✔ | ✔ | ✔ |
| 24 h since the last KotH's slot (`KOTH_MIN_GAP_MS`) | ✔ | ✔ | ✔ |
| Never shares a slot with an airdrop | ✔ | ✔ | ✔ |
| Weekly cap (`KOTH_WEEKLY_CAP`) | — | ✔ | — |
| Population rule | — | high-water (§3) | ≥ `KOTH_VOTE_MIN_POP` at open |

This is the airdrop precedent: a hand-placed drop is outside the weekly cap and
inside everything else. The cap exists to bound how often the automatic trigger
turns the server into an arena, not to stop players asking.

The gap is measured slot to slot — this slot against the `slot_at` of the last
KotH that is not `cancelled` or `failed` — because for KotH the session is the
event, not the moment it was decided.

⚠️ `/koth schedule` does not yet check the 24 h gap. It gains that check here, so
the three paths agree.

### 2.3 No prize

Automatic and voted rows carry `award_key = null`. The column and every scoring
path already support it (`finished`, no grant). The event is the reward.

### 2.4 The town is drawn, not chosen

`chooseKothTown(recent, rng)` draws uniformly from the 31 KotH towns less the last
`KOTH_NO_REPEAT` = 5 used (any origin, any state), falling back to the full list if
the pool is empty — the same shape and the same reason as `chooseAirdrop`. A vote
draws its town when it opens, so the message names exactly what is being voted on.

### 2.5 KotH wins the slot over the automatic airdrop

Both decisions happen at the same instant (`slot − 30 min`) against the same pop
history, so on a record night both want the slot. KotH takes it: `koth-vote-tick`
and `koth-decide-tick` run before `airdropTick` in `discord.ts`, and `airdropTick`
already skips any slot with a `scheduled` KotH row (spec 2026-09-23 §2.12). It now
also logs `airdrop: skipped <slot>: koth`.

KotH never displaces a human's `/airdrop place`: an `announced` or `live` airdrop
for the slot makes both new paths refuse it.

⚠️ The losing airdrop may then not fire again for up to `AIRDROP_HISTORY_MS`: the
record night is now the high-water mark it must match. That is intended, and the
runbook says so.

---

## 3. The automatic decision — `apps/bot/src/koth-decide-tick.ts`

Runs every tick, for each active server. For `slot = nextRestartAt(now)`, nothing
happens until `now >= decisionInstantFor(slot)` (30 min before). Then the pure rule
`shouldFireKoth` (`packages/domain/src/koth.ts`) refuses, in order:

1. **Slot taken** — any `koth_events` row for the slot (the partial unique index's
   states), or an `announced`/`live` airdrop for it.
2. **A vote for this slot** that is still `open` or has `failed`. Players asked
   about this session and said no, or have not finished saying; the trigger does
   not overrule them. (A `passed` vote is already caught by 1.)
3. **One open** — a `scheduled` or `live` KotH exists.
4. **Weekly cap** — `origin = 'auto'` rows, not `cancelled`/`failed`, whose
   `slot_at` falls in `isoWeekStart(slot)`'s week, `>= KOTH_WEEKLY_CAP`. A failed
   event refunds its budget.
5. **Gap** — `slot − lastSlotAt < KOTH_MIN_GAP_MS`.
6. **Population** — fires only if
   `pop >= max(KOTH_AUTO_MIN_POP, highWater(pops over KOTH_HISTORY_MS))`, the
   history taken on the slot grid strictly before this decision instant, exactly as
   `airdrop-tick.ts` does it (and for the reason its comment gives: a window that
   contains the current sample fires on every new record, including a record of 1).

`popsAt` and the history-instant loop move from `airdrop-tick.ts` into
`apps/bot/src/population.ts`; both ticks import them. One statement of "players
online at an instant".

**Writing it — row first, post second** (the airdrop order, for its reason):

1. Insert `koth_events`: `origin 'auto'`, `state 'scheduled'`, the drawn town,
   `scheduled_by_discord_id` null, `award_key` null, `pop_at_decision`,
   `threshold`, `announced_at` null — `onConflictDoNothing`, and counted as decided
   only if it returned a row.
2. Post the announcement to `SERVER_EVENTS_CHANNEL_ID`.
3. Stamp `announced_at` **and `reminded_at`** to now.

⚠️ `reminded_at` is stamped with `announced_at` because the decision is made at
`slot − KOTH_REMINDER_LEAD_MS`: the announcement is the reminder. Without it
`koth-tick.ts`'s reminder step posts a second message seconds after the first.

If the post fails, later ticks retry it while the slot is ahead (the row is found by
`origin = 'auto' and state = 'scheduled' and announced_at is null`). If the slot
arrives unannounced, `kothWanted` refuses to open it and `koth-tick.ts`'s existing
missed-opening step marks it `failed`; no cancellation posts, because
`announced_at` is null. Nothing new is needed for that path — only a test.

---

## 4. Rules and config

`packages/domain/src/rules.ts`:

| Constant | Value |
|---|---|
| `KOTH_MIN_GAP_MS` | 24 h |
| `KOTH_HISTORY_MS` | 5 days |
| `KOTH_NO_REPEAT` | 5 |
| `KOTH_VOTE_MIN_POP` | 10 |
| `KOTH_VOTE_TURNOUT_MIN` | 5 |
| `KOTH_VOTE_PASS_NUM` / `_DEN` | 2 / 3 |
| `KOTH_VOTE_MIN_OPEN_MS` | 10 min |

Env (`apps/bot/src/config.ts`):

| Var | Default | Refuses to load |
|---|---|---|
| `KOTH_AUTO_TICK` | off | without `KOTH_TICK` |
| `KOTH_WEEKLY_CAP` | 2 | — |
| `KOTH_AUTO_MIN_POP` | 10 | — |
| `KOTH_VOTE` | off | without `KOTH_TICK` |

Both new flags require `KOTH_TICK` because a row they create would otherwise be
decided and never opened.

Pure helpers beside `shouldFireKoth` in `koth.ts`: `turnoutFloor(n) =
max(KOTH_VOTE_TURNOUT_MIN, ceil(n / 2))`; `voteOutcome({ cast, yes, floor })`
→ `passed` iff `cast >= floor && yes * 3 >= cast * 2` (integer arithmetic, no
float 2/3); `voteTargetSlot(now)` → the first restart slot `s` with
`s − KOTH_REMINDER_LEAD_MS − now >= KOTH_VOTE_MIN_OPEN_MS`.

---

## 5. Data (one migration)

### 5.1 `koth_events`

| Column | Change |
|---|---|
| `origin` | new, text not null, CHECK in `('admin','auto','vote')`; existing rows backfilled `'admin'` |
| `pop_at_decision` | new, integer, null except on `auto` |
| `threshold` | new, numeric, null except on `auto` |
| `scheduled_by_discord_id` | becomes nullable; CHECK `(origin = 'auto') = (scheduled_by_discord_id IS NULL)` |

On a `vote` row, `scheduled_by_discord_id` is the starter.

### 5.2 `koth_votes`

| Column | Type |
|---|---|
| `id` | bigserial PK |
| `server_id` | integer → `servers` |
| `slot_at` | timestamptz not null |
| `location` | text not null (a KotH slug) |
| `started_by_discord_id` | text not null |
| `opened_at` | timestamptz not null |
| `closes_at` | timestamptz not null (`slot_at − KOTH_REMINDER_LEAD_MS`) |
| `electorate_size` | integer not null, CHECK `>= KOTH_VOTE_TURNOUT_MIN` |
| `turnout_floor` | integer not null |
| `channel_id`, `message_id` | text, null until posted |
| `tally_text` | text — the last rendered tally, so the tick edits only on change |
| `state` | text not null, CHECK in `('open','passed','failed','void')` |
| `closed_at` | timestamptz, CHECK `(state = 'open') = (closed_at IS NULL)` |
| `result_posted_at` | timestamptz |
| `koth_event_id` | bigint → `koth_events`, `ON DELETE set null`; CHECK `state <> 'passed' OR koth_event_id IS NOT NULL` |
| `detail` | jsonb not null default `{}` (void reason, final counts) |

- `koth_votes_one_open` — unique `(server_id)` where `state = 'open'`
- `koth_votes_slot_uq` — unique `(server_id, slot_at)`, **unconditional**: one vote
  per slot, ever. A failed or void vote is not re-run for the same session.

⚠️ `electorate_size`'s CHECK is `>= 5` as a literal in SQL. That is a second
statement of `KOTH_VOTE_TURNOUT_MIN`; a drift test holds them together
(`holding-index-drift.test.ts`'s pattern).

### 5.3 `koth_vote_voters`

The frozen electorate and the ballots, one table.

| Column | Type |
|---|---|
| `vote_id` | bigint → `koth_votes`, `ON DELETE cascade` |
| `discord_id` | text not null |
| `dayz_id` | text not null |
| `ballot` | boolean, null until cast |
| `cast_at` | timestamptz, CHECK `(ballot IS NULL) = (cast_at IS NULL)` |

PK `(vote_id, discord_id)`. Having a row is being eligible.

### 5.4 Lock order

`koth_votes` → `koth_vote_voters` go immediately before `koth_events`:
`… achievement_counters → koth_votes → koth_vote_voters → koth_events →
award_grants → …`. The pass transaction takes them in that order.
`removeFromGuildDb` deletes the departed user's `koth_vote_voters` rows between
its `guest_passes` and `award_grants` writes, which is consistent with it.
CLAUDE.md's lock-order line is updated with the table names.

---

## 6. The vote

### 6.1 The command — `apps/bot/src/commands/kothvote.ts`

`/kothvote`, a top-level command with no options and no default member
permissions. Not a `/koth` subcommand: Discord sets permissions per command, and
`/koth` keeps `ManageGuild` so its admin subcommands stay out of players' lists.

The reply is ephemeral (house rule, `command-registration.test.ts`); the vote
itself is a separate post by the bot. Refusals, each its own sentence, in order:

1. `KOTH_VOTE` is off.
2. The caller is not linked, or has no open `player_sessions` row on the active
   server ("You need to be in game to start a vote").
3. Pop < `KOTH_VOTE_MIN_POP`.
4. A vote is open.
5. For `slot = voteTargetSlot(now)`: a vote has already been held for it; a KotH
   row holds it; an `announced`/`live` airdrop holds it.
6. A KotH is `scheduled` or `live`, or `slot − lastSlotAt < KOTH_MIN_GAP_MS`.
7. The electorate — every linked player with an open session on the server, the
   caller included — is smaller than `KOTH_VOTE_TURNOUT_MIN`. Refused up front
   ("Not enough linked players online"), because a floor of 5 could never be met.

Then, in one transaction: insert `koth_votes` (with `turnoutFloor(n)`), one
`koth_vote_voters` row per elector, the caller's with `ballot = true`. A unique
violation on either index becomes the matching refusal (the `/koth schedule`
pattern). Then post the message and store `channel_id`/`message_id`. ⚠️ If the post
fails, the vote goes `void` ("never posted") and the caller is told: a vote nobody
can see is not a vote, and leaving it `open` would block every other vote and the
automatic trigger for that slot.

### 6.2 The message

> **King of the Hill vote.** Should the **16:00 UTC** restart be King of the Hill at
> **Borek**? Linked players who were in game when this opened can vote until
> **15:30 UTC**. It needs **5** votes and two-thirds Yes. No prize, just the hill.
>
> Yes 1 · No 0 · 1 of 5 votes cast

Buttons **Yes** / **No**. `allowedMentions: { parse: [] }` — the starter's
gamertag is player-controlled. Rendered by a pure `voteText` in `koth-text.ts`.

### 6.3 The buttons

Custom id `cw:v:koth:<voteId>:yes|no`, a new kind in `confirm.ts`'s namespace. The
existing `cw:c:` ids carry one actor, which a public button cannot. A press:

1. Looks up `(vote_id, discord_id)`. No row → ephemeral "Only linked players who
   were in game when this vote opened can vote on it."
2. Vote not `open`, or `now >= closes_at` → ephemeral "This vote has closed."
3. Otherwise updates `ballot`, `cast_at` (a changed mind is allowed until close)
   and replies ephemerally.

The handler never edits the public message.

### 6.4 The tick — `apps/bot/src/koth-vote-tick.ts`

Gated on `KOTH_VOTE` **for opening only**; it runs whenever any `open` vote exists.
Per server, for the open vote:

- **Tally.** Render the tally; if it differs from `tally_text`, edit the message,
  then store it. An edit failure (message deleted by hand) is a warn and nothing
  else — the close still happens.
- **Close**, at or after `closes_at`:
  - `now >= slot_at` (the bot was down through the close) → `void`, "expired". The
    never-late rule.
  - `KOTH_VOTE` is off → `void`, "voting was switched off". Switching a feature off
    finishes what it started and never creates anything new.
  - Otherwise `voteOutcome`. **Passed**: one transaction, locking vote → voters →
    `koth_events`, re-checks slot free, nothing open, and the gap (an admin may
    have scheduled in the meantime); inserts the `koth_events` row (`origin
    'vote'`, starter, drawn town, no prize, `announced_at` null) and marks the vote
    `passed` with its id. A failed re-check marks it `void` with what took the
    slot. **Failed**: `failed`, with the counts and which threshold was missed.
  - Counts go into `detail` in every case.
- **Post**, after the commit: the result, and on a pass the announcement, then
  stamp `koth_events.announced_at` and `reminded_at` (the vote closes at the
  reminder instant, same reasoning as §3) and `result_posted_at`; edit the vote
  message to its final tally with the buttons removed. A failed post retries next
  tick; a passed event still unannounced when its slot arrives is failed by
  `koth-tick.ts` exactly as in §3.

### 6.5 Order in `discord.ts`

`kothVoteTick` → `kothDecideTick` → `airdropTick`, in the same block, each in its
own try/catch. A vote closing at `slot − 30 min` inserts its row before the
automatic decision for that slot looks, and both before the airdrop. Pinned by a
test on the tick order.

---

## 7. Failure behaviour

| Failure | Result |
|---|---|
| `koth-decide-tick` throws | No row; the airdrop decides as normal |
| Decision announcement fails | Retried until the slot; then `failed`, no cancellation, budget refunded |
| Vote message fails to post | Vote `void`, starter told |
| Vote message deleted by hand | Tally edits warn; close still posts as a new message |
| Bot down through a vote's close | `void`, "expired" |
| `KOTH_VOTE` switched off mid-vote | Closed as `void` at its close time |
| Admin schedules during a vote | Vote `void` at close, post names what took the slot |
| Elector leaves the Discord | `removeFromGuildDb` deletes their voter row; the frozen `electorate_size` and `turnout_floor` do not change |

---

## 8. Testing

**Domain, pure:** `shouldFireKoth` — each refusal alone and the fire case;
`chooseKothTown` no-repeat and fallback; `turnoutFloor` (4 → 5, 10 → 5, 11 → 6);
`voteOutcome` at exactly 2/3, one Yes short, one voter short of the floor;
`voteTargetSlot` either side of the 10-minute boundary.

**Bot, DB-backed:**
- decide tick: fires and posts with `reminded_at` stamped; retries a failed post;
  an unannounced row at its slot is failed by `koth-tick` with no cancellation;
  skips a slot with an open or failed vote; respects the cap (auto only), the gap
  (any origin), a manual airdrop
- airdrop tick: skips and logs a slot KotH took; still decides when the KotH tick
  threw
- `/kothvote`: every refusal in §6.1; the electorate frozen at open; the caller's
  Yes; the unique indexes turned into refusals; `void` on a failed post
- buttons: a non-elector refused; a closed vote refused; a ballot changed
- vote tick: tally edited only on change; pass inserts the row; fail; pass-time
  re-check → `void`; late → `void`; flag off → `void`
- guild removal deletes the voter row
- `/koth schedule` refuses a slot inside the 24 h gap

**Wiring:** tick order; config refusals for both flags without `KOTH_TICK`;
`/kothvote` registered ephemeral with no default permissions; the
`electorate_size` CHECK against `KOTH_VOTE_TURNOUT_MIN`.

---

## 9. Deploy

One migration, additive: `origin` with its backfill, the two nullable columns,
`scheduled_by_discord_id` made nullable with its CHECK, and the two tables. The
running bot selects nothing dropped and inserts nothing newly required (`origin`
has a default of `'admin'` for the old code's inserts). The release deployer's
stop-then-migrate order covers it.

Runbook `docs/deploy/2026-09-24-koth-auto-and-vote.md`:

1. Deploy with both flags off; `/kothvote` answers that voting is off.
2. Set `KOTH_VOTE`, restart, and watch one vote open, tally and close.
3. Set `KOTH_AUTO_TICK` (and `KOTH_WEEKLY_CAP`/`KOTH_AUTO_MIN_POP` if not the
   defaults), restart. Expect the first automatic KotH on the next record night,
   and that night's airdrop to be skipped in its favour.
