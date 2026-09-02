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

## 8. ~~Tell the player when they are locked out of their own challenge~~ — DONE 2026-09-02

Same class as item 7. When a UID exhausts `MAX_POOL_EMOTES_PER_ATTEMPT` on a
challenge, the correct sequence stops working and `/link` re-shows the *same*
live challenge with the same text and no hint. Salute, clap and thumbs-up are
ordinary social emotes and all count against the budget, so a sociable player
can spend it without ever attacking anything, then wait out the 10-minute TTL
with no idea why.

`handleLink`'s re-show path should detect an exhausted attempt and say so, or
issuing a fresh challenge should reset it.

**Resolved**, and the original writeup above understates it. A real lockout
(Wintershadow394, 2026-09-01) showed the problem was not only silence: he was
drawn `move → clap → taunt elbow`, never produced `EmoteMove` at all, and spent
the whole budget performing the two emotes he COULD do — steps 2 and 3 of his
own sequence, in order. Two changes, spec §5.3 and §5.4:

- the lockout message now names the emote he never reached, so an unperformable
  token in the safe pool becomes visible instead of reading as player error;
- `/link new-sequence:true` re-rolls, capped at three draws per (account,
  character) per day.

⚠️ The obvious-looking fix — not charging budget for emotes that are IN the
sequence — was considered and rejected. `tick.ts` is explicit that the budget is
the primary defence against the target completing its own sequence by accident,
and the accidental completion is MADE of in-sequence emotes, so exempting them
removes the bound entirely.

The draw cap also closed a pre-existing hole: `/link A → /link B → /link A`
re-issued A with a fresh sequence and a fresh budget without limit, which made
the documented 0.46% a per-challenge figure rather than a per-day one.

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

## 23. ~~`MISSION_CUSTOM_DIR` is process-wide~~ — DONE 2026-09-02

The supply projection uploads to `cfg.missionCustomDir` — one environment value the
sweep hands to **every** server it visits (`apps/ingest-worker/src/sweep.ts`, the
`remoteDir` field of the `supplies` dep). But that path is service-specific: the live
value is `/games/ni11558038_4/ftproot/dayzxb_missions/dayzOffline.enoch/custom`, and
the `ni…_4` segment is the Nitrado service id.

With one active server this is correct, which is why the deployment works. Add a
second and its supply file is uploaded into the **first** service's directory. The
failure mode is the bad one: if that path happens to exist under the second service's
credentials, the upload SUCCEEDS. Nothing errors, `supply_uploads` advances the hash,
and the second server's supplies simply never appear — with no log line, and no retry,
because from the tick's point of view everything worked.

Not fixed on `feat/faction-supplies` because the fix is a schema change: the path
belongs on the `servers` row next to `nitrado_service_id`, not in the process
environment. Load-bearing comments are in place at both sites (`sweep.ts` at the
`remoteDir` call site and `config.ts` beside `missionCustomDir`) so the next person to
register a second server sees it before they hit it.

**Resolved — and NOT the way this item proposed.** The writeup above is wrong on
one point of fact, which is what made a schema change look necessary: the
`ni11558038_4` segment is **not** the Nitrado service id. The service id is
`19831378`. That segment is `gameserver.username`, and `game` and
`settings.config.mission` sit beside it in the same `/gameservers` response the
client already fetches for `listAdmFiles`:

    /games/{username}/ftproot/{game}_missions/{mission}/custom

Verified against the live file server on 2026-09-02 — that exact path lists
`faction-supplies.json`. So the path IS derivable, and `NitradoClient.missionCustomDir()`
now derives it per server each sweep. `MISSION_CUSTOM_DIR` is retired from
`config.ts` and from compose.

No column, deliberately. A path stored at registration goes stale the moment an
operator changes the mission or the map, and a stale path uploads into a directory
the server no longer reads — succeeding silently, which is the exact failure class
this item exists to remove. Deriving it costs one GET per server per sweep and
tracks a mission change on its own.

## 24. ~~Out-of-band changes to the supply file on the server are never detected~~ — DONE 2026-09-02

`supply_uploads.content_hash` is the supply projection's only memory, and it records
what the tick last **sent**, not what the game server currently holds. That makes the
"self-healing" claim narrower than it reads: it heals *upload failures* (the hash does
not advance on a throw, so the next tick retries), and nothing else.

If the file changes on the server side — a mission wipe, an FTP restore from a backup,
an operator editing `custom/faction-supplies.json` by hand, a Nitrado-side rollback —
the stored hash still equals the hash of what the tick would generate. So the tick
short-circuits, no upload is attempted, and the factions' supplies stay gone until
something unrelated changes the roster and shifts the hash. There is no log line,
because from the tick's point of view there was nothing to do.

Not fixed on `feat/faction-supplies` because detection is a design decision about
cadence, not a patch. The candidates:

- **`file_server/list` size/mtime check each tick** — one cheap request per server,
  catches deletion and most edits, but not an edit that preserves size, and mtime
  semantics on that endpoint are unverified.
- **Download and compare** — exact, but a request and a full file transfer per server
  per tick just to learn nothing changed.
- **Periodic unconditional re-upload** (say hourly, or every N ticks) — simplest to
  reason about and needs no new API surface, but writes for no reason and would mask
  rather than report the drift.
- **Store nothing and always upload** — correct and stupid; rejected already in §4.4.

Whichever is chosen should also decide whether drift is *reported* (an operator wants
to know their file was reverted) or merely repaired silently. The spec's §8 carries the
gap; §2.1 and §6 were corrected so they no longer overclaim.

---

# Carried forward from faction dormancy (2026-09-02)

### Resolution

`file_server/list` was probed against the live server before choosing. It returns `size`
in bytes and `modified_at` in whole seconds per entry, and the entry for our file read
`modified_at` 1788307434 — exactly the `uploaded_at` epoch stored in `supply_uploads`.
So the endpoint's mtime semantics, listed above as unverified, are real and precise.
That settled the cadence question: one `list` per server per sweep gets both signals, so
"download and compare" buys nothing.

**The tempting version of this is wrong.** Comparing the remote mtime to our own
`uploaded_at` works today and would break silently: `modified_at` is the GAME SERVER's
filesystem clock, and those run fixed UTC+4/+7 — the same fact the ADM filename hazard in
`listAdmFiles` already works around. Any offset would read as permanent drift and
re-upload every tick, which is the always-upload behaviour §4.4 rejected. So the baseline
is **observed, not computed**: after a successful upload the tick stats the file and
stores what the server itself reported (`remote_size`, `remote_modified_at`, migration
`0017`). Comparison is then observation against observation, immune to clock offset.

Both signals are kept because neither subsumes the other, and a mutation test proved it:
with only mtime compared, the whole suite still passed. Size catches a restore that
preserves timestamps (`rsync -a`, an FTP client issuing MFMT); mtime catches an edit that
preserves length. Each now has a test that fails without the other's check.

Drift is repaired *and* reported (`onSupplyDrift` → `console.error` naming expected vs
found). Whatever rewrote the file — a mission wipe, an FTP restore, a Nitrado rollback —
has almost certainly not stopped at this one file, so silence would hide the larger
event.

Two behaviours worth knowing:

- **A null baseline is adopted, not treated as drift.** Every existing row is null the
  moment this ships, and a row returns to null whenever the stat after an upload fails.
  Writing the baseline only after an upload would leave detection switched off until the
  roster happened to change — on a server with stable factions, forever. Uploading
  instead would be exact, but a Nitrado listing outage would then re-upload every tick.
  The backfill deliberately does not restamp `uploaded_at`: nothing was uploaded.
- **A stat failure on the quiet path propagates.** Being unable to check is not evidence
  the file is intact, and that path was not going to upload anyway, so there is no cost
  to being loud.

Verified on `factions_live`: the first quiet tick after deploy backfilled the baseline
(19767 bytes, the exact byte length the projection generates) without touching
`uploaded_at`. Perturbing the stored baseline produced one drift line naming expected vs
found, one re-upload, a fresh baseline, and then silence — one drift, one upload, no
storm.

## 25. ~~`clocks()` scans the event log once per faction, every ten seconds~~ — DONE 2026-09-02

`apps/bot/src/dormancy-store.ts`'s `LAST_RAISE` is a correlated subquery evaluated once
per examined faction, filtering `events` on `type`, `server_id`, and two `payload->>`
extractions. `events` is indexed on `(type)` and `(server_id, occurred_at)` only —
nothing covers the jsonb keys — so each evaluation degenerates to a scan of every
`flag.raised` row for that server. It runs from the bot's guarded job at
`BOT_TICK_INTERVAL_MS`, default 10 seconds, forever.

This is also the first non-cursor read of `events` in the codebase. Every other consumer
(`ceremony-tick`, the projectors) advances a cursor and touches each row once.

Harmless today: one server, one faction, six `flag.raised` rows. After a year of ingest
that is tens of thousands of rows scanned ~33 times per tick, against the same database
the worker is writing to. The symptom is not an error — `guardedRunner` skips a firing
while the previous one is still running, so the tick quietly stops keeping up.

Deliberately not fixed during the dormancy build: rewriting the query that gates an
irreversible operation, for a performance problem that does not yet bite, trades a
certain risk for a speculative gain. Decide it with real numbers — `EXPLAIN ANALYZE`
against `factions_live` — between a single grouped query (join `events` to `factions` on
`server_id` plus the two payload keys, `GROUP BY factions.id`) and a partial index such
as `CREATE INDEX ON events (server_id, occurred_at) WHERE type = 'flag.raised'`.

### Resolution

Fixed by `events_raise_lookup_idx` (migration `0016`): a partial index on
`(server_id, payload->>'poleKey', payload->>'texture', occurred_at)` where
`type = 'flag.raised'`. The query is unchanged — which was the point, since the
objection above was to rewriting the statement that gates an irreversible operation.

Measured on a throwaway `factions_bench` database at a year of projected ingest — 1M
events, 120k of them `flag.raised`, 45 examined factions:

| variant | per tick |
|---|---|
| current query, no new index | 352 ms |
| grouped rewrite, no new index | 47 ms |
| **current query + `events_raise_lookup_idx`** | **0.41 ms** |
| grouped rewrite + the index | 34 ms |

**The partial index this item proposed — `(server_id, occurred_at) where type =
'flag.raised'` — is a trap, and the numbers are why.** It measured 11.6ms because the
planner walks it backward and stops at the first row matching the payload predicate,
which is fast for a faction that raised recently. Adding five factions that had not
raised in ~300 days took it to 180ms and **595,318 buffers — nine times worse than the
unindexed baseline's 68,282** — because each stale faction scans backward through every
newer raise. The factions it is worst for are precisely the ones dormancy exists to
find. Indexing the payload keys themselves has no such asymmetry: a stale faction costs
the same as a fresh one.

The grouped rewrite works and is 7x, but it aggregates every `flag.raised` row on every
tick regardless of faction count, and it cannot use the index (34ms with it). It was the
wrong axis: the cost was never the N, it was the missing access path.

Write cost is negligible — 20k inserted events went 43ms to 64ms, about 1µs per row,
against a live server ingesting ~280 events/day. The index is 5.6MB per 120k raises.

`apps/bot/test/dormancy-index-drift.test.ts` pins it, and pins it on the property that
matters: asserting the plan merely *names* the index is too weak, because `server_id`
alone keeps it usable and a renamed payload key still yields an index scan. It asserts
both payload keys appear in `Index Cond` and none is left in a `Filter`. Verified by
mutation — renaming `poleKey`, renaming `texture`, and changing the event type each fail
it.

## 26. Three residual gaps in the dormancy liveness guard

Disband refuses on a server whose newest `events` row is older than `dormantAfterMs`, so
an ingest outage cannot mass-disband. Three things that guard does not cover:

- **An outage can poison a `dormant_since` stamped during it.** Ingest down days 0-20,
  recovers on day 20 and backfills. A faction that genuinely raised on day 10 now reads
  11 days stale — not fresh, so no revive — while its `dormant_since` was stamped on day
  7 from evidence that did not exist yet. On day 21 the server is live, the gate opens,
  and it disbands on 11 days of proven silence rather than 14. Narrow (only raises in
  the day 8-13 window are exposed; anything inside the last 7 days revives) and strictly
  better than the mass-disband it replaces, but the fix is to re-stamp `dormant_since`
  when the server was not live for the stamping interval.
- **Suppression is silent.** When the gate blocks a disband, `decide()` returns null and
  the tick counts nothing. No log line, no counter distinguishing "nothing was due" from
  "disbands are being withheld because ingest is down". A `withheld` counter in
  `dormancy-tick.ts` would make the outage visible from the bot's own logs.
- **A genuinely dead game server never releases its flags.** No ADM lines means no
  events means the gate stays shut forever. Correct by design and the safe direction,
  but the scarce-pool reclamation then has no path without manual intervention.

## 27. `emotes.ts` overclaims what the safe pool has been proven to do

`packages/domain/src/emotes.ts`'s docstring says the safe set is "one-life's list, every
member of which has been performed by a real player completing a real `/link` in
production". That is not true. It is one-life's published list; roughly ten of the 24
have ever appeared in live data at all.

The claim is load-bearing because it is what a reader consults when deciding whether a
token is trustworthy — and it shipped a broken `/link` once already (`EmoteSOS`, fixed
in `186cbe6`). It happened again on 2026-09-01: Wintershadow394 was drawn
`move → clap → taunt elbow`, never produced `EmoteMove` at all — no such line exists in
the raw ADM log — and spent his whole emote budget on the two he could do.

`EmoteMove` is not obviously bogus: the historical export has 5 performances by 3
distinct players, more evidence than `EmoteNod` (1 by 1) or `EmoteTimeout` (3 by 1),
which are also in the pool. So the fix is not simply demoting it. Correct the docstring
to say what the set actually is, and let the lockout messages — which now name the emote
a player never reached — accumulate evidence about which tokens really are unperformable.

## 28. Nothing applies migrations in production

`runMigrations` (`packages/db/src/migrate.ts`) is called only from test setup. No app
calls it, and no package defines a `db:migrate` script, so every migration has reached
`factions_live` by hand. Until 2026-09-02 CLAUDE.md claimed the opposite — that they
apply at bot startup — and the dormancy deploy started the bot against a database with
no `dormant_since`, logging a failed dormancy tick every 10s for four minutes. Harmless
that time (the failing statement is a read, and `guardedRunner` swallows it); a NOT NULL
column or a broken write path would have been player-visible.

The docs are corrected and `docs/deploy/2026-09-02-dormancy.md` carries a one-off runner.
That leaves the gap itself: applying a migration is a hand-assembled script written from
a runbook, at the moment of a deploy, against production.

The obvious fix — call `runMigrations` at bot startup, making the docs retroactively
true — is the wrong one. It would run migrations at the least controlled moment, from
whichever process happens to start first, and it directly contradicts the
stop-then-migrate rule that `docs/deploy/2026-09-01-targeted-linking.md` exists to
enforce: a NOT NULL migration must be applied with the bot *down*, and a bot that
migrates itself can never be. What is wanted is a checked-in `db:migrate` script, run as
its own deliberate step, with the `factions_live` guard and the
`__drizzle_migrations`-vs-journal comparison from the runbook built in — the two checks
that made applying `0015` by hand safe rather than lucky.
