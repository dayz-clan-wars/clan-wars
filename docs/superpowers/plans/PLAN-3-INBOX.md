# Plan 3 inbox — items carried forward, to fold into the plan when it is written

## 1. ~~Harden `FLAG_CHANGE_RE` against gamertag injection~~ — DONE 2026-08-31 (`c58601e`)

Fixed on `feat/bot-and-identity-linking`, and widened: `PLAYER_POS_RE` had the
same defect, which matters because the projector binds a fold to its nearest
pole by player position. Acceptance in
`docs/acceptance/2026-08-31-flag-injection-fix.md`. Original writeup below, kept
for the reasoning.

### Original writeup

**Where:** `packages/adm-parser/src/flag.ts:16` and `packages/adm-parser/src/coords.ts:7`
(both merged to `main` via PR #1).

**The defect.** `FLAG_CHANGE_RE = /has (raised|lowered) (\S+) on TerritoryFlag/u`
is unanchored, so it matches anywhere on the line — including inside the
gamertag, which is attacker-controlled and appears earlier. This is the same
class as the Critical found in Task 2's emote parser during Plan 2.

**Demonstrated by execution, not inspection:**
- A gamertag of `has raised Flag_Zenit on TerritoryFlag at <1.0, 2.0, 3.0>`
  turns a plain `has been disconnected` line into a FABRICATED `flag.raised`
  event at attacker-chosen coordinates. Needs 57 characters — longest real name
  in the export is 15, Steam caps at 32, so the full fabrication is likely
  infeasible.
- **The variant that does fit:** a 30-character name,
  `has lowered X on TerritoryFlag`, worn on the attacker's OWN genuine
  flag-raise line. `FLAG_CHANGE_RE` matches the name's earlier occurrence and
  reports `lowered`; `POLE_AT_RE` still reads the real coordinates off the tail.
  Result: a fabricated raid signal on your own pole, within the platform limit.
- **Second, narrower issue:** `parsePoleAt` takes the LEFTMOST
  `on TerritoryFlag at <...>` match, so a crafted name can substitute fake pole
  coordinates on an otherwise genuine line — wrong pole identity, and therefore
  the wrong faction credited.

**Why it matters here specifically.** ADM logs contain zero base-destruction
events, so the flag-lower is the ONLY raid signal this product will ever have.
Plan 3 is where raid credit starts consuming it; until then nothing reads these
events for scoring, which is why the fix was deferred rather than rushed.

**The fix, following the pattern already proven in Task 2** — anchor to the
identity parenthetical, which a gamertag cannot forge without embedding a
literal 40-hex id group:

```ts
const FLAG_CHANGE_RE =
  /\(id=[0-9A-F]{40}[^)]*\)\s*has (raised|lowered) (\S+) on TerritoryFlag/u;
```

`parsePoleAt` needs its own treatment — searching only the substring after the
identity block, rather than the whole line.

**Acceptance:** the export must still yield exactly **14 flag changes, 10
raises, 4 lowers** at pole key `2991.57:447.95:1138.59`. Add adversarial
gamertag tests mirroring the five added to `packages/adm-parser/test/emote.test.ts`.

**Not affected:** `flagpole.ts` — `BUILT_RE` and `DISMANTLED_RE` already anchor
with `\)\s*`.

## 2. Gate `/unlink` on faction membership

`apps/bot/src/commands.ts` `handleUnlink` deletes an identity link with no
checks, because no factions exist yet. Unlinking a faction leader's identity
would orphan the roster. Plan 3 must add that gate when rosters exist.

## 3. Decide what the projector's unbound folds mean

The Plan 1 projector reports folds it cannot bind to a pole (3 in the historical
backfill). Dormancy and rebind logic (spec §5, "Pole binding and pole loss")
has to decide whether those are pole losses, parser gaps, or noise.

## 4. Reap canceled and completed verification challenges

Cancellation of expired challenges already shipped: `cancelExpired` runs, and
`handleLink` calls it before drawing. It is load-bearing, not optional —
`verification_challenges_open_sequence_uniq` and
`verification_challenges_open_account_uniq` are both partial indexes over
"not completed, not canceled", so an expired challenge that was never
canceled would sit there forever holding its sequence and its account slot
hostage. This item was previously written as if that gap still existed; it
does not.

What remains for Plan 3 is retention only: canceled and completed rows are
never deleted, so `verification_challenges` and `challenge_attempts` grow
without bound. Add a reaper that deletes rows past some retention window
(e.g. completed/canceled more than N days ago) — a cleanup job, not a
correctness fix.

## 5. `EmotePerformed.item` must be validated before any consumer trusts it

`item` (the "with <item>" suffix on an emote line) is parsed and persisted in
`events.payload` but read by nothing today. Before any future consumer reads
it, it must be validated rather than trusted: it is free text taken from a
log line whose earlier fields (gamertag) are already known to be
attacker-influenced, so nothing about `item` should be assumed safe or
well-formed.

## 6. Per-map channel resolution

Plan 2 records `guild_id` on challenges but builds no map scoping, because no
command needs a map yet. Spec §16 fixes the topology: one guild, per-map
channels, commands resolve their map from the channel they are run in.

## 7. Tell the player when their UID belongs to another Discord account

`PgVerificationStore.completeChallenge` (`apps/bot/src/store.ts`) cancels the
challenge and returns false when the UID is already linked to a *different*
Discord account. Nothing reaches the player: `pendingNotifications()` selects
only `completed_at IS NOT NULL`, so the refusal exists solely as the tick's
`alreadyLinked` counter in the server log.

The player's experience is silence. They perform the sequence correctly, see
nothing, run `/link` again (permitted — the old challenge is now canceled), and
loop forever with no way to learn that their character is bound elsewhere. This
is the exact case a player who changed Discord accounts hits.

Needs a notification path for refusals, not just completions — which means a
reason column or a second pending query, since "canceled" alone cannot
distinguish this from an ordinary expiry.

## 8. Tell the player when they are locked out of their own challenge

Same class as item 7. When a UID exhausts `MAX_POOL_EMOTES_PER_ATTEMPT` on a
challenge, the correct sequence stops working and `/link` re-shows the *same*
live challenge with the same text and no hint. Salute, clap and thumbs-up are
ordinary social emotes and all count against the budget, so a sociable player
can spend it without ever attacking anything, then wait out the 10-minute TTL
with no idea why.

`handleLink`'s re-show path should detect an exhausted attempt and say so, or
issuing a fresh challenge should reset it.

## 9. Document the ingest cadence the challenge TTL assumes

`challengeTtlMs` defaults to 600_000, which assumes emotes reach `events`
within ten minutes. But `apps/ingest-worker` is a one-shot batch over a
directory of `.ADM` files and nothing in the repo schedules or tails it. If the
real cadence exceeds the TTL, every challenge is canceled before its emotes
arrive and no `/link` can ever succeed — silently, showing only
`verified: 0, alreadyLinked: 0`.

Plan 3 should state the required cadence in the bot README and set the TTL
default above it.

## 10. Defer the `/link` reply

`apps/bot/src/discord.ts` calls `interaction.reply` without a prior
`deferReply`, but `handleLink` does four or more round trips (link lookup,
live-challenge lookup, a table-wide `cancelExpired` UPDATE, up to 20 inserts on
sequence collision). Discord's initial-response window is 3 seconds. On a cold
pool the reply throws "Unknown interaction" and the player sees "The
application did not respond" — after the challenge row was already created.
Recovery works, but the first attempt reads as a hard failure.
`deferReply({ flags: Ephemeral })` then `editReply` removes the class.

## 11. Two smaller items in the bot loop

- `verificationTick` and `notifyCompleted` share one `try` in `start()`. A tick
  that throws persistently means players already bound are never told,
  indefinitely. Give `notifyCompleted` its own catch.
- `positiveInt` accepts up to `MAX_SAFE_INTEGER`, but `setInterval` truncates
  past 2^31-1 to a **1 ms** delay. An extra-digits typo in
  `BOT_TICK_INTERVAL_MS` produces exactly the "hammers the database while
  looking correctly configured" failure the comment above it warns about. Cap
  `tickIntervalMs` at 2_147_483_647.
- `verificationTick` re-queries `store.liveChallenges(now)` for every emote
  event — one query per event (2,093 on the historical backfill) plus a
  `getAttempt` per (event x live challenge). Hoist per batch, invalidate on
  completion. Performance only; the invariant is currently correct.

---

# Carried forward from Plan 3's own build (2026-08-31)

Plan 3 (ceremony detection and faction claim) is implemented. These were found
during its review and consciously deferred rather than fixed.

## 12. Activation cannot see a flag that is already flying

`ceremonyTick` evaluates activation inline on the forward scan, and DayZ emits
`flag.raised` only on the raise TRANSITION. A founder whose faction flag was
already up at the pole — or who raises it in the gap between the detector
consuming that event and the claim committing — can never activate, and nothing
tells them why. The reservation lapses at 24h and the flag returns to the pool,
so the 33-slot pool is safe; the cost is that the founding group loses its claim
to a condition it cannot observe.

Mitigated for now by copy only: the reservation reply tells founders to lower the
flag first if it is already flying. A real fix needs either a bounded cursor
rewind on activation or a reconciliation pass, and neither is worth building
before a staged ceremony shows whether players actually hit this.

## 13. A poisoned pole key logs forever

If a `white_raises` row ever holds a pole key `parsePoleKey` rejects, phase 2
logs and skips it on every tick — every 10 seconds, indefinitely. The wedge is
gone (phase 3 still runs, so expiry and lapsing are unaffected), and the altitude
bounds added to `parsePoleAt` mean no new such row can be created, so this is
currently unreachable: `white_raises` holds zero rows in both the live and
backfill databases. If it ever becomes reachable, apply the same once-per-key log
discipline the ceremony notifier uses.

## 14. `highWaterMark` is an event time, not an ingest time

It is `max(occurred_at)`, so a single future-dated event pins the high-water mark
ahead of the wall clock permanently — which silently collapses the two-clock rule
to wall-clock-only, with no signal. Every settling and retirement decision rests
on this value. Worth either clamping it to now, or tracking ingest time
separately.

## 15. Smaller items

- `flagSuggestions` has no server context, so `/faction claim` autocomplete
  offers all 33 flags including ones already held. Caught correctly downstream,
  but it makes "already taken" the common path late in a server's life.
- `white_raises.settled_at` is written from the wall clock or the window end
  depending on whether the window qualified. Nothing reads it today; it is a
  trap for the first query that does.
- The roster-confirm select has no separate confirm button, so choosing in the
  menu founds the faction. The spec (§6) called for a confirm step. Accepted
  because the menu is ephemeral and only the claimant sees it.
- `hasOpenCeremony`/`isPoleBound` before `settle`'s insert is a read-then-write,
  safe only because `guardedRunner` serializes within one process. The README
  already defers multi-instance operation to a Postgres advisory lock; that is
  where this becomes real.


## 16. Two custom-id parsers still coerce with `Number()`

`parseTransferCustomId` and `parseClaimCustomId` in `apps/bot/src/discord.ts` carry
the coercion bug that `parseIdSuffix` was fixed for in Plan 4a: `Number("9e2")` is
900 and `Number("0x10")` is 16. Not exploitable — component interactions are only
delivered for components the bot itself sent, and both consumers re-authorise
against the acting user, so the worst outcome of a coerced id is a no-op reply. But
`config.ts` establishes `DECIMAL_RE = /^\d+$/u` as the house rule and `parsePoleKey`
was fixed for the same class in Plan 3, so this now reads as an inconsistency. Four
lines.

## 17. A relink lets one Discord account hold two roster rows on one server

Plan 4a closed the stale-UID variant: `acceptInvite` re-derives the accepter's UID
from `identity_links` at accept time. The re-invite variant is still open. A member
of faction F who unlinks and relinks a NEW uid can be invited again and accept —
`createInvite`'s already-member check keys on `dayz_id`, and
`faction_members_server_player_uniq` is on `(server_id, dayz_id)`, so neither guard
fires and F ends up with two membership rows for one Discord id.

`resolveServerContext` would then silently take the first. Worse, `leaderIs()` and
`kick()` use scalar subqueries over `(faction_id, discord_id)`, which would raise
"more than one row returned by a subquery" — a raw Postgres error reaching a player.
There is no unique index on `(faction_id, discord_id)`; adding one is probably the
fix, but it needs a check against what `/unlink` and re-linking are meant to permit.

## 18. Three `apologiseForFailure` call sites are untested

`interactionCreate` is a closure inside `startBot`, so deleting any of the three
`await apologiseForFailure(interaction)` lines in `discord.ts` leaves the suite
green. The routers are proven to throw post-defer and the helper is proven to
answer, but nothing pins them together. Testing it needs the catch body extracted
into an exported wrapper. Failure mode is a hung "thinking" indicator, not data loss.

## 19. The lock-order convention has no enforcement

Plan 4a's fix wave built a deadlock out of two separately-correct changes:
`acceptInvite` took `faction_invites` before `factions` while `disband` took them in
the opposite order. The fix established `factions` → `faction_invites` →
`faction_members` as the acquisition order, but that is a comment, not a constraint,
and only the one pair is covered by a race test. The next multi-table write is where
this bites.

## 20. Staged race tests cannot fail by reordering

Races 5 and 6 in `roster-races.test.ts` construct their interleaving with real lock
waits. Reordering statements inside `acceptInvite` or `disband` would not fail them —
it would silently stop them staging anything, so they would pass while proving
nothing. Each test says so in a comment. Worth knowing before trusting them as
regression guards for the statement order they depend on.

## 21. Apps contend on the single shared test database

`pnpm -r test` fails in `apps/projector` and `apps/ingest-worker` while both pass in
isolation: every app points at the one `factions` test database and truncates shared
tables underneath its neighbours. Confirmed pre-existing during the targeted-linking
plan — stashing all branch work made the projector failures *worse*, not better.

Two consequences beyond the noise. A recursive run cannot be trusted as a gate, so
per-package runs are doing the real work. And the failure set moves with vitest's
file ordering (it orders by size), so an unrelated edit that changes a file's byte
count can surface or hide a failure — which is exactly how a latent isolation bug in
`discord.test.ts` surfaced during Task 5 of that plan.

The fix is isolation, not more truncation: a database or schema per package, named
from the package, so no two suites share a namespace.

## 22. The bot is single-instance-only, and nothing enforces it

`notifyCompleted` sends the DM BEFORE calling `markNotified` (`apps/bot/src/discord.ts`).
That order is deliberate and right for one process — marking first would drop the DM
entirely if the send then failed — but it makes the notifier at-least-once across
processes: two instances both read `pendingNotifications()`, both send, then both mark.

Observed for real on 2026-09-01, during the targeted-linking live gate: a stale bot
process survived a `pkill` whose pattern did not match the expanded tsx command line,
a second was started alongside it, and the verified player received the completion DM
twice. The verification itself was unaffected — `completeChallenge` is guarded and only
one link row exists — so the blast radius is duplicate notifications, not duplicate
bindings.

Two things worth doing before anyone runs a second instance for availability: take an
advisory lock (or a row lease) around the notify step so only one process notifies, and
give the bot a startup guard that refuses to run when another holds the lock. The same
argument applies to the ceremony notifier and the players projection, which share the
loop.
