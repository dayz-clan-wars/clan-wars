# Plan 3 inbox — items carried forward, to fold into the plan when it is written

## 1. Harden `FLAG_CHANGE_RE` against gamertag injection (SECURITY, first task)

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
