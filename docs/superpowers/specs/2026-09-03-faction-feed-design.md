# Faction feed — a public channel of faction lifecycle — design

**Date:** 2026-09-03
**Covers:** master spec §7 "Announcements" (the delivery mechanism, not raid credit) and
§11 "War log" (its first, non-raid half)
**Builds on:** ceremony and faction claim, faction dormancy, faction rebind — the four
places that already transition a faction's state
**Blocks:** nothing yet. §11's public web war log will read the same table.

---

## 1. Purpose

Everything this bot tells a player is private. Every command reply is ephemeral
(`RosterReply.ephemeral` is the literal `true`, so a public one will not compile), and
both notifiers — `notifyCompleted` and `notifyDormancy` — DM. Two of them deliberately
pass an empty `channelId` so that `send`'s channel fallback throws rather than posts.

The result is a server where **nothing that happens to a faction is visible to anyone
outside it.** A faction founded last week, a flag returned to the pool yesterday, a rival
gone dormant this morning — none of it is knowable. The 33-flag pool is designed to be
scarce, and scarcity nobody can observe motivates nobody. Spec §7 says drama needs a
protagonist; today it does not even have an audience.

The faction feed is a Discord channel that carries faction lifecycle transitions as they
happen, and the durable log that feeds it.

### In scope

- An append-only `faction_events` table, written by every existing transition site
- A feed tick that posts unposted rows to one configured channel, in order
- Seven event kinds: founded, activated, renamed, rebound, dormant, revived, disbanded
- A one-off backfill of the factions that already exist

### Out of scope, deliberately

- **Raids and defenses.** Spec §7's headline announcements need raid credit, which does
  not exist, and per inbox item 32 killfeed parsing is a substantial new parser surface
  with its own gamertag-injection hazards. The feed is built so that adding a `raided`
  kind later is a row kind and an embed case, not a redesign.
- **Flag raises and lowers.** The raw ADM events are ingested and could be republished,
  but a lowered flag broadcasts, continuously, which bases are undefended right now.
  Dormancy already discloses that at a 7-day granularity (§4 below); a live feed of it is
  a different decision and is not being made here.
- **Per-faction channels.** Spec §10's disband cleanup discusses them. One channel.
- **The web war log.** §11's public site reads `faction_events` when it exists. This
  design only guarantees the table is shaped so it can.
- **Flag artwork.** See §6.

---

## 2. `faction_events` — the transition log

Migration `0019`. New table, no changes to existing ones.

```sql
CREATE TABLE faction_events (
  id          bigserial   PRIMARY KEY,
  server_id   integer     NOT NULL REFERENCES servers(id),
  faction_id  bigint      NOT NULL REFERENCES factions(id),
  kind        text        NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload     jsonb       NOT NULL,
  posted_at   timestamptz,
  CONSTRAINT faction_events_kind_valid CHECK (kind IN
    ('founded','activated','renamed','rebound','dormant','revived','disbanded')),
  CONSTRAINT faction_events_no_coordinates CHECK (NOT (
    payload ? 'poleKey' OR payload ? 'x' OR payload ? 'y' OR payload ? 'z'))
);

CREATE INDEX faction_events_queue_idx ON faction_events (id) WHERE posted_at IS NULL;
CREATE INDEX faction_events_faction_idx ON faction_events (faction_id, occurred_at);
```

**`occurred_at` is the transition's time, not the row's.** The backfill inserts rows for
things that happened two days ago, and the embed's timestamp comes from this column.

**`posted_at IS NULL` is the queue.** The partial index is over `id` alone because the
tick reads in id order and stops at the first failure — it never needs to search within
the unposted set.

### ⚠️ `payload` is frozen at write time, never a join

The embed reads `name`, `tag`, `texture` and the actor from the row. It must not read
them from `factions`.

Read live, a rename that posts three days late prints today's name — and the rename post
itself degenerates to "X renamed to X", because both halves resolve to the same current
value. A disband post would have to read a row whose identity fields have already been
released to the pool. The same reasoning as `supply_uploads` storing the size and mtime
the game server *observed*, rather than recomputing them: a projection of state that
changes after the fact must capture the state it is describing.

Payload per kind:

| kind | payload |
|---|---|
| `founded` | `name`, `tag`, `texture`, `actor` (the ceremony's initiating gamertag) |
| `activated` | `name`, `tag`, `texture`, `actor` (whoever raised the flag) |
| `renamed` | `name` (new), `previousName`, `tag`, `texture`, `actor` |
| `rebound` | `name`, `tag`, `texture`, `actor` |
| `dormant` | `name`, `tag`, `texture`, `disbandAt` |
| `revived` | `name`, `tag`, `texture`, `actor` |
| `disbanded` | `name`, `tag`, `texture` |

`dormant` and `disbanded` carry no actor. There is no protagonist — a clock did it — and
inventing one would name whoever happened to be leader as the person who let the faction
die.

### ⚠️ The coordinate check constraint

`faction_events_no_coordinates` is not defensive clutter. This is the first table in the
schema whose entire purpose is to be published, and the pole invariant is otherwise held
by every author remembering it at every call site. `poles.pole_key`'s own comment says it
"must never reach a public read model"; here the database enforces that rather than
trusting the reviewer, and the failure it prevents is silent and permanent — once a
coordinate is in a Discord channel it is in screenshots.

`packages/db/test/faction-events-no-coordinates.test.ts` asserts the insert is rejected.

---

## 3. Who writes rows

Each existing transition site appends one row **in the same transaction as the state
change**:

| Site | Kinds |
|---|---|
| `apps/bot/src/ceremony-tick.ts` | `founded`, `activated` |
| `apps/bot/src/dormancy-tick.ts` | `dormant`, `revived`, `disbanded` |
| `apps/bot/src/rebind-store.ts` | `rebound` |
| the `/faction rename` handler | `renamed` |

### ⚠️ Same transaction, without exception

The feed's entire correctness is "a row exists if and only if the transition happened."
A separate write breaks that in one direction and nothing repairs it: a crash between the
state change and the log leaves a transition that will never be announced, and there is
no reconciler anywhere that could notice — the transition's own evidence (`dormant_since`
nulled on revive, a name overwritten by a rename) is exactly what the log exists to
preserve, so it is already gone by the time anyone looks.

The other direction is safe: the transaction rolls back and the row goes with it.

### ⚠️ Lock order gains a fourth entry

**`factions` → `faction_members` → `faction_invites` → `faction_events`.**

`faction_events` goes last, and can safely go last, because it is insert-only and nothing
references it — no writer ever needs it locked before touching the roster tables. The
deadlock this project already built once came from two separately-correct changes taking
two tables in opposite orders; a fourth table written by four call sites is precisely
that shape again, so the ordering is stated rather than left to be inferred.

CLAUDE.md's lock-order invariant is updated with this design.

---

## 4. What the feed discloses, and the decision behind it

**Announcing dormancy publicly tells the server which faction is undefended.** The pole
invariant holds — no coordinates are published, and the check constraint in §2 makes that
structural — but this is the same *shape* of disclosure at a coarser resolution: the feed
broadcasts that a base is decaying and nobody has been home for seven days.

This is accepted deliberately, on 2026-09-03. Dormancy is meant to be consequential, and
a consequence delivered only as a private DM to the person who already knows they have
not logged in is not one. The pressure the mechanic is supposed to create — log in, or
lose the flag to someone who will — only exists if the loss is public.

Recorded here because it is a decision, not a side effect, and because a future reader
finding "dormant" in a public channel should find the reasoning rather than assume an
oversight. It is the same distinction as the roster: **who someone is is public, where
their base is is not.**

`rebound` posts that a faction moved, never where from or to. That is a real disclosure
too — it tells a rival that scouted coordinates are now stale — but it is information the
rival would discover on their next visit anyway, and it is the post that makes the
7-day rebind cooldown legible.

---

## 5. The feed tick

Three new modules, following the shape of the dormancy trio:

- **`apps/bot/src/feed-store.ts`** — `readUnposted(limit)`, `markPosted(id, at)`.
- **`apps/bot/src/feed-embed.ts`** — a pure `(row: FactionEvent) => APIEmbed`. No
  discord.js client, no I/O; a plain object so the tests compare data, not rendering.
- **`apps/bot/src/feed-tick.ts`** — read a batch, post each, mark each.

Wired into the existing `guardedRunner` job in `discord.ts`, in its own try/catch, running
last — nothing else depends on it, exactly as with the dormancy step.

### Post, then mark

At-least-once, matching `notifyCompleted`. A crash in the window between the two
duplicates one post; the alternative loses it permanently, and a public record that
silently gains holes is worse than one that occasionally stutters. The
one-instance rule in CLAUDE.md already governs the duplicate risk.

### ⚠️ Strictly ordered, and a failure stops the batch

Rows are posted in `id` order, one at a time, and the **first failure ends the run** —
the tick does not skip ahead to the next row.

Skipping would let a retried older event appear below newer ones, so a channel read
top-down would show "COK disbanded" above "COK went dormant". A feed whose order cannot
be trusted is not a record of anything. Stopping means one stuck row blocks the queue,
which is the correct trade: the blockage is loud — see the failure log directly below — and the alternative is silent
corruption of the history.

### Retry until it lands, logged once

A failed post leaves `posted_at` null and the next tick tries again — the `/link`
notifier's reasoning: the transition is real, and the announcement should land the moment
it can.

⚠️ The failure is logged **once per row per bot instance**, via the existing
`createNotifyFailureLog` pattern. A deleted channel or a revoked permission is permanent,
and without the once-per-row log it writes an identical error every 10 seconds forever,
which is how a real problem becomes invisible.

---

## 6. Embeds

| kind | color | line |
|---|---|---|
| `founded` | green | founded by `actor` — the ritual completed |
| `activated` | green | colors raised by `actor` — the faction is live |
| `revived` | green | active again, flag raised by `actor` |
| `renamed` | blue | was **previousName** |
| `rebound` | blue | moved its base |
| `dormant` | amber | dormant — supplies cut, disbands `<t:…:R>` |
| `disbanded` | red | disbanded — flag, tag and pole return to the pool |

Title is `Name [TAG]`; the flag is named as a text field (`Wolf`, from the texture with
its `Flag_` prefix stripped). The embed's native `timestamp` is set to `occurred_at`, so
a backfilled row renders as history with no special-casing anywhere in the code.

### ⚠️ No flag artwork in v1

The 33 textures are strings in `packages/domain/src/flags.ts`. No images of them exist
anywhere in this repository, and sourcing, licensing and hosting 34 flag images is its
own piece of work that the feed does not need in order to be useful.

`feed-embed.ts` takes an optional `(texture: string) => string | null` resolver, defaulted
to `() => null`. Adding thumbnails later is that function and nothing else.

---

## 7. Configuration

`BOT_FEED_CHANNEL_ID`, **optional**, defaulting to unset.

Unset means the feed is disabled: rows still accumulate, nothing posts. Two reasons this
is optional rather than `required()`:

- Every existing deployment and test fixture would otherwise need a channel id to start a
  bot at all, for a feature they do not use.
- Development and staging must not post into a live community channel by inheriting a
  `.env`. Silent-by-default is the safe direction.

⚠️ On startup with the channel unset, log the queued row count **once**, at warn level.
Otherwise "the feed isn't posting" is only answerable from a psql session, and a feature
that is off because of a missing env var looks identical to one that is broken.

Enabling the channel later posts the whole accumulated backlog in order. That is the
intended behaviour and it is what makes the backfill in §8 work.

---

## 8. Backfill

A checked-in script, run as **its own deliberate step**, never at startup — the same rule,
and the same reasoning, as `runMigrations`: the least controlled moment to do a bulk
insert into production is the moment a process happens to boot.

It inserts `founded` (from `created_at`) and `activated` (from `activated_at`, where
non-null) rows for factions already in the table, skipping any faction that already has
rows so a second run is a no-op.

⚠️ It can only synthesize what the columns still hold. Renames, rebinds and dormancy
episodes that already happened are unrecoverable — the columns that recorded them are
overwritten or nulled by design. The backfilled history is a founding record, not a
complete one.

Against `factions_live` today this is **two rows**, both for `COK`: founded
2026-09-01 21:30:07Z, activated 2026-09-01 22:54:15Z.

---

## 9. Testing

- **Formatter**, per kind: `feed-embed.ts` is pure, so every kind gets a case asserting
  color, title, line and timestamp. Includes `renamed` with a `previousName` that differs
  from `name` — the case that a live join would break.
- **Ordering**: a batch with a failing middle row posts the rows before it, stops, and
  leaves the rest unposted; the next tick resumes at the failed row.
- **No duplicate on success**; **retry after failure**.
- **Payload drift**: the keys each writer writes and the keys `feed-embed.ts` reads are
  two statements of one fact. A test holds them together, in the manner of
  `packages/db/test/holding-index-drift.test.ts`.
- **Coordinate constraint**: an insert whose payload carries `poleKey` is rejected.
- **Same-transaction**: a transition whose surrounding transaction rolls back leaves no
  `faction_events` row.

---

## 10. Deploy

Order, per the stop-then-migrate rule:

1. Apply `0019` (`packages/db/migrations`), read the generated SQL first.
2. Run the backfill script.
3. Set `BOT_FEED_CHANNEL_ID=1545142533603201184` and restart the bot as a **single**
   instance.

The bot need not be down for step 1 — `0019` adds a table and alters nothing existing, so
old code against the new schema is fine — but new code writes the new table, so the
migration precedes the restart regardless.

⚠️ **Pre-deploy check, not an assumption:** confirm `1545142533603201184` is in
`DISCORD_GUILD_ID`'s guild and that the bot has View Channel, Send Messages and Embed
Links there. Without Embed Links every post fails, and §5's stop-on-failure means the
queue blocks on the first row.

Acceptance is the backfill: two COK posts, in order, timestamped 2026-09-01.
