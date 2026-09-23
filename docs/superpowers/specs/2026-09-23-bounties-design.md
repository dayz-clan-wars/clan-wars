# Bounties — design

**Date:** 2026-09-23
**Status:** designed, not implemented
**Covers:** an admin places a bounty on a player as a punishment; it is announced in
the server events channel and DM'd to the target; every linked viewer sees the
target's last known position on the map; a scoring kill of the target claims it, or
it expires; a tenth leaderboard, **Bounty kills**
**Builds on:** event awards (`docs/superpowers/specs/2026-09-22-awards-design.md` —
the admin command shape, the DM through `clan_notices`), the map (target-state spec
§10.3, `packages/roster/src/map.ts`), kills and `scoringKill`
(`packages/roster/src/stats.ts`), `player_sessions`, the leaderboards and crowns
(`docs/deploy/2026-09-18-leaderboards-in-discord.md`,
`docs/deploy/2026-09-18-leaderboard-crowns.md`)

---

## 1. Purpose

Admins need a punishment that the community carries out. A bounty marks one player
as wanted: the whole server is told, the target is told, and the target's last known
position appears on everyone's map until somebody kills them or they have served
their time online. Whoever collects it gets credit on a new board.

### In scope

- `/bounty place`, `/bounty revoke`, `/bounty list` — admin-only Discord commands
- The `bounties` table and a `bounty-tick` that claims and expires bounties
- Server-events posts on place, claim, expiry and revoke; DMs to a linked target on
  place, expiry and revoke
- A **Bounties** map layer, visible to every linked viewer
- A tenth board, `bountyKills`, on the site, in `#leaderboards`, in `/board`, with an
  optional crown
- A short **Bounties** section in the guide, rendered from `rules.ts`

### Out of scope

- Player-placed bounties, stakes or rewards of any kind beyond the board
- More than one open bounty per player
- Editing a bounty after it is placed (revoke and place again)
- A Discord rendering of the map (the map stays site-only, as today)

---

## 2. Decisions

### 2.1 An admin punishment, not an economy

Only an admin (ManageGuild) places, revokes or lists bounties. There is nothing to
collect but the claim itself and its place on the board.

### 2.2 Any player the server has seen — linked or not

The target is picked by gamertag autocomplete over `players`, returning a `dayz_id`
(the `/link` pattern, `commands/link.ts`), and the bounty is keyed on `dayz_id`.
Players who most need punishing are often the ones who never linked. Positions,
sessions and kills all exist for unlinked players; only the DM needs a link, so an
unlinked target gets no DM and the channel post is their only notice.

### 2.3 The map exception to §10.3 — deliberate and bounded

Target-state §10.3: *no position of anyone outside your clan except intruders in
your own zone.* A bounty is a second, deliberate exception: **while an admin-placed
bounty on a player is open**, every linked viewer sees that player's exact last
known fix. Chosen on 2026-09-23 over a delayed or coarsened pin — the owner wants
the hunt to be real. The rest of §10.3 is unchanged and applies to this layer:

- one marker per target, no trails;
- every fix shows its age;
- `Cache-Control: no-store, private` (the layer rides the existing
  `/api/map/state` response);
- the open-bounty condition is a WHERE predicate in `mapStateDb`, never a
  post-filter. A claimed, expired or revoked bounty stops exposing the target on the
  next poll.

The target sees their own pin, on purpose: they know they are wanted.

**Only while the target is online** (owner decision, 2026-09-23, after the final
review). The pin shows only while the target has an open `player_sessions` row on
that server; the moment they disconnect it disappears. Without this, a target who
logs off inside their clan's base and stays away leaves a pin on that base for up
to `BOUNTY_DEADLINE_MS` — publishing a base location, which no page may carry
(CLAUDE.md, "Pole coordinates are a raid target"), and exposing clanmates who did
nothing. It also matches §2.4: only online time counts, so the hunt happens while
they play. The open-session condition is in the same WHERE clause as `status = 'open'`.

### 2.4 The sentence is served online, with a ceiling

A bounty carries an **online budget**: `BOUNTY_DEFAULT_MS` (72 h) unless the admin
passes `hours:` (1 to `BOUNTY_MAX_MS`, 168 h). The constants are `_MS` because
`guide-numbers.ts` infers a number's unit from its suffix. Only time the target spends
connected counts down, summed from `player_sessions` overlapping
`[placed_at, now]`, an open session counted up to `now`. Logging off to wait it out
does not work.

A bounty on a player who stops playing would otherwise stay open forever, so every
bounty also has a hard `deadline_at = placed_at + BOUNTY_DEADLINE_MS` (30 days),
after which it expires regardless.

### 2.5 What claims a bounty

The earliest kill of the target, at or after `placed_at`, that satisfies the same
rule as `scoringKill`: `killer_dayz_id is not null and killer_dayz_id <>
victim_dayz_id and friendly_fire = false and at_hub = false`. So:

- friendly fire does **not** claim it (the owner's rule);
- a Hub kill does not — Hub kills score nowhere, and a bounty must not become a
  reason to fight at the Hub;
- a suicide, fall, starvation or animal death does not;
- a credited finish (`cause = 'finished'`) does — it counts as a kill everywhere.

`scoringKill` is not exported today. It is exported from `stats.ts` and re-exported
through `@factions/roster/internal` only (never the root), so the bounty query uses
the same predicate object rather than respelling it — see CLAUDE.md,
"Friendly fire scores NOWHERE but the friendly-fire board": it had drifted three
ways before.

### 2.6 No cursor over `kills`

`pnpm rebuild:kills` deletes and reinserts every kill with new ids. A cursor over
`kills.id` would stall or re-claim after a rebuild. The tick instead asks, per open
bounty, "is there a scoring kill of this target at or after `placed_at`?" There are
only ever a handful of open bounties; the query uses
`kills (server_id, victim_dayz_id, occurred_at)`.

### 2.7 A claim is a record, frozen when written

The claim stores the killer and the kill's `event_id`. A later `rebuild:kills` that
reclassifies that kill does not reopen or reassign the bounty — the same "record,
not stat" rule the kill feed follows. The board counts claims, so it moves only
when a bounty is claimed.

### 2.8 Claim before expiry

When one tick finds both a qualifying kill and an exhausted budget, the claim wins
if the kill's `occurred_at` is before the instant the budget ran out (or the
deadline). Log lag must not rob a hunter of a kill made in time. A kill after the
budget ran out does not claim.

The same lag cuts the other way: the budget can run out at T while a kill at T − 1
is still in a log file the worker has not ingested. So a bounty is only **expired**
once `now >= end + BOUNTY_EXPIRY_SETTLE_MS` (15 min, a housekeeping constant, not
in the guide) — until then it stays open, on the map, and claimable by any kill
made before `end`.

---

## 3. Data

Migration **0048**, one table.

```
bounties
  id                     serial pk
  server_id              int not null → servers
  target_dayz_id         text not null
  reason                 text not null            -- ≤ BOUNTY_REASON_MAX (200)
  placed_by_discord_id   text not null
  placed_at              timestamptz not null default now()
  online_budget_ms       bigint not null          -- check > 0
  deadline_at            timestamptz not null
  status                 text not null default 'open'
                         -- check in ('open','claimed','expired','revoked')
  closed_at              timestamptz
  claimed_by_dayz_id     text
  claim_event_id         bigint                   -- kills.event_id of the claiming kill
  claimed_at             timestamptz              -- that kill's occurred_at
  revoked_by_discord_id  text
  placed_announced_at    timestamptz
  closed_announced_at    timestamptz

  check: (status = 'open') = (closed_at is null)
  check: (status = 'claimed') = (claimed_by_dayz_id is not null)   -- and claim_event_id, claimed_at
  check: (status = 'revoked') = (revoked_by_discord_id is not null)
  unique (server_id, target_dayz_id) where status = 'open'          -- one open bounty
  index (server_id, status)
  index (server_id, claimed_by_dayz_id, claimed_at) where status = 'claimed'  -- the board
```

No foreign key to `kills`: `rebuild:kills` deletes those rows (§2.7).

`bounties` is written by `bounty-admin.ts` (place, revoke) and `bounty-tick.ts`
(claim, expire), each in its own transaction, together with `clan_notices` for the
DM. Lock order: `bounties` sits **immediately before `clan_notices`**, after
`war_log_events`; no transaction touches it with any roster table.

---

## 4. Components

### 4.1 Rules — `packages/domain/src/rules.ts`, `guide-numbers.ts`

`BOUNTY_DEFAULT_MS = 72 * HOUR`, `BOUNTY_MAX_MS = 7 * DAY`, `BOUNTY_EXPIRY_SETTLE_MS = 15 min`,
`BOUNTY_DEADLINE_MS = 30 * DAY`, `BOUNTY_REASON_MAX = 200`, each with a
`guide-numbers.ts` row. Plus a pure `bountyOutcome(bounty, onlineMs, firstKill, now)`
in `packages/domain/src/bounties.ts` returning `open | claimed | expired` per §2.4 and
§2.8, and `budgetRunOutAt` — the instant the online budget was exhausted, derived from
the session spans — so the ordering rule is unit-tested without a database.

### 4.2 Store — `packages/roster/src/internal/bounty-admin.ts`

- `placeBountyDb(db, { serverId, targetDayzId, reason, hours, adminDiscordId })` —
  refuses `already-open` (the unique index, caught), `unknown-player` (no `players`
  row), `bad-hours`. Inserts the row and, when `identity_links` has the target, a
  `clan_notices` DM `bounty_placed`.
- `revokeBountyDb(db, { bountyId, adminDiscordId })` — open → revoked, DM
  `bounty_revoked` if linked.
- `openBountiesDb(db, serverId)` — for `list` and revoke's autocomplete, with online
  time remaining.

Internal only — not a `@factions/roster` root export, so `parity.test.ts` does not
list it (the `/award` precedent).

### 4.3 Command — `apps/bot/src/commands/bounty.ts`

`setDefaultMemberPermissions(ManageGuild)` and the in-handler `isAdmin` check, as
`/award`. Replies ephemeral.

- `place player:<autocomplete: searchGamertags> reason:<string ≤ 200> hours:<int, optional>`
- `revoke bounty:<autocomplete: open bounties>`
- `list`

When `BOUNTY_TICK` is off, `place` answers "Bounties are off." and writes nothing —
an unannounced bounty on a hidden layer would be a punishment nobody knows about.

### 4.4 Tick — `apps/bot/src/bounty-tick.ts`

Every tick, after `kills-tick.ts` and `sessions-tick.ts`, gated on `BOUNTY_TICK`. For
each open bounty: read the first qualifying kill (§2.5) and the online spans since
`placed_at`; `bountyOutcome` decides; a close is one transaction that sets status,
`closed_at` and the claim columns, and appends the DM (`bounty_expired`) where the
target is linked. A claim DMs nobody — the channel post is the notice.

### 4.5 Poster — `apps/bot/src/bounty-announce-tick.ts` + `bounty-text.ts`

Level-triggered, posts to `SERVER_EVENTS_CHANNEL_ID`, oldest first, stops at the
first failure: a row with `placed_announced_at` null gets the "wanted" post; a closed
row with `closed_announced_at` null gets the claimed / expired / revoked post. The
column is stamped only after the send succeeds. `bounty-text.ts` is pure: gamertag,
reason, the online hours, and for a claim the killer and weapon. **No coordinates in
any post** — the map is where the position lives. `allowedMentions: { parse: [] }`,
since gamertags and the reason are free text in a public channel (the `#bans`
precedent). Runs with the other server-events posters, after the restart tick.

### 4.6 Notices

Three new `CLAN_NOTICE_KINDS`: `bounty_placed`, `bounty_expired`, `bounty_revoked`,
each with a renderer in `apps/bot/src/notice-text.ts` and copy in
`apps/web/lib/notice-copy.ts` (the two renderers — read both). Payload: reason,
hours; never a position (`clan_notices_no_coordinates`).

### 4.7 Map — `map.ts`, `map-draw.ts`, `map-view.tsx`, `map-copy.ts`

`MapState` gains `bounties: { gamertag, reason, fix: MapFix }[]` (the clanmates shape) for every linked
viewer: the latest `player_positions` fix (`lastFixes()`) of each open bounty's
target on the viewer's server, joined on `bounties.status = 'open'`. A target with
no fix inside `POSITION_RETENTION_MS` is omitted from the pins. `drawBounties` draws
a distinct marker with the same age label as every other fix; the layer is a switch
labelled **Bounties**, on by default. `map-copy.test.ts`'s layer count goes 9 → 10.

### 4.8 Board — `bountyKills`

A tenth `BoardKind`: `count(*)` of `bounties` where `status = 'claimed'`, grouped by
`claimed_by_dayz_id`, scoped by `claimed_at` (the kill's time) to the board's
season scope. Touches the
`Record<BoardKind, …>` tables in `packages/copy/src/stats.ts` (label, slug, value),
`boardRows`/`boardsFor` in `packages/roster/src/stats.ts`, `leaderboard-embed.ts`'s
line format, `/board`'s choices, and the tests that say nine. The Discord channel
purges and reposts once on first run with ten boards — the existing "any missing"
rule, expected. `CROWN_BOUNTY_KILLS_ROLE_ID` is optional; unset, no role is touched.

### 4.9 Config

`BOUNTY_TICK` (boolean). When on, `SERVER_EVENTS_CHANNEL_ID` is required — fatal at
load, as for the weekly vehicle wipe, because an unannounced bounty defeats the point.

### 4.10 Guide

A **Bounties** section in `12-fair-play.html` (punishment) — what a bounty is, that
it shows on the map, `{{BOUNTY_DEFAULT_MS|hours}}` online, the
`{{BOUNTY_DEADLINE_MS|days}}` ceiling, what claims it (no friendly fire, no Hub kills),
and the board. `10-the-map.html` gains the layer in its table.

---

## 5. Failure behaviour

| Failure | Behaviour |
|---|---|
| Discord post fails | column stays null; retried next tick; later posts wait behind it |
| DM fails | `notice-tick`'s three attempts, then `failed_at` — as every DM |
| Tick crashes mid-run | each close is its own transaction; the rest retry next tick |
| Bot down for a day | on return, the tick closes with §2.8's ordering — a kill made in time still claims |
| Target never seen at a position | listed, no pin |
| `rebuild:kills` | open bounties re-evaluate against the rebuilt rows; closed ones are frozen (§2.7) |
| `BOUNTY_TICK` turned off with bounties open | they stay open, visible on the map, unclaimed and unexpired until it is turned back on; `list` still shows them, `revoke` still works |

---

## 6. Testing

- `bountyOutcome`: claim before budget run-out wins; kill after run-out does not;
  deadline; online spans with an open session and a `restart`-closed one.
- Store: one open bounty per target (index); unknown player refused; DM only when
  linked; revoke closes and DMs.
- Tick (against `factions_test_bot`): friendly-fire kill, Hub kill, self-kill and
  environmental death leave it open; a credited finish claims; claim freezes killer
  and event id.
- Poster: stamps only after a successful send; stops at the first failure; no
  coordinates in any rendered text; mentions suppressed.
- Map: pins only for open bounties, only the latest fix, no pin without a fix,
  present for a linked viewer in no clan.
- Board: counts claims per killer within scope; crown untouched when the env var is
  unset.
- Guide: the new tokens resolve; no hand-typed number.
