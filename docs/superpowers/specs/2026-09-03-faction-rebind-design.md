# Faction rebind — moving a base — design

**Date:** 2026-09-03
**Covers:** master spec §5 "Pole binding and pole loss" (`/faction rebind`), plus the
voluntary move that section does not describe
**Builds on:** roster core (`factions` rows with a pole and a leader), faction dormancy
(the status this transitions out of), live ingest (a running worker writing `flag.raised`)
**Blocks:** `2026-09-03-base-declaration-design.md` — one base with no way to move is a trap

---

## 1. Purpose

A faction's pole is four NOT NULL columns on its row (`pole_key`, `x`, `y`, `z`), written
once at claim time and never changed since. **There is no way to move a base.** `/faction
rebind` has been in the specs since 2026-08-26 and scoped as "Plan 4b" since 2026-08-31;
no command, handler or store method exists.

That is survivable today because nothing forces a faction to stay put. It stops being
survivable the moment base declaration ships: under one-declaration-per-player, a faction
raided at a pole whose coordinates rivals already have is stuck there, and the only exit
is disbanding and losing its flag to the pool. A mechanic that traps people at a
compromised base is worse than no mechanic.

### In scope

- Moving a faction's pole binding to a new pole, keeping flag, tag, roster and history
- Both entry paths: **pole loss** (raided to nothing) and **voluntary relocation**
- What the old pole becomes
- The cooldown that stops rebind being used to dodge raids in progress

### Out of scope, deliberately

- **Pole-loss *detection*.** `flagpole.folded` events exist and the projector counts folds
  it cannot bind to a pole (inbox item 3, still undecided). This design does not settle
  what an unbound fold means; it works from the faction's own claim that it lost its pole,
  verified against the log at rebind time rather than detected proactively. Detection can
  be added later and would only change how the faction *learns* it should rebind.
- **Multiple bases.** Inbox item 34. Rebind moves one binding; it does not add a second.
- **Rebuilding what was lost.** Rebind restores identity, not materials. The supply kit
  follows from status via the existing projection and needs no code here.

---

## 2. Decisions

### 2.1 One command, two situations

The master spec frames rebind as a consequence of pole loss: "on loss the faction goes
dormant and the leader gets `/faction rebind`". That covers being raided and nothing else.
A faction that simply wants a better position — closer to loot, further from a rival, off
a spot that turned out to be indefensible — has no path, and inventing a second command
for it would mean two ways to write the same four columns.

**One command, available from `active` and `dormant` alike.** The situations differ only
in what the faction has lost before running it, which is not something the command needs
to know.

### 2.2 Rebind is lighter than founding, and lighter than the master spec suggests

The master spec says "raise White at a new pole, confirm, keep the flag and roster", and
gives the reason: "losing a pole already means the faction was raided to nothing;
requiring five people to re-convene punishes them twice."

That reasoning is right and applies to the voluntary case too — a faction that wants to
move is not proving anything new about itself. So:

> **One roster member raises `Flag_White` at an unbound pole, and the leader confirms.**

Not a ceremony. One participant, and the ordinary `MIN_PARTICIPANTS` rule does not apply.

⚠️ The raiser must be **on the roster**, checked the way activation already checks it
(`isRosterMember`), not merely linked. A rebind moves a faction's identity to coordinates
of someone's choosing; letting a non-member's raise supply that target would let anyone
relocate any faction to a pole they control.

### 2.3 The new pole must be unbound, and White

Both conditions come free from existing machinery and both are load-bearing.

**Unbound** — `factions_holding_pole_uniq` already refuses two holding factions at one
pole. Rebinding onto an occupied pole would either violate that index or evict its owner;
the former is an error surfaced to a player who did nothing wrong, the latter is a base
takeover by Discord command.

**White** — the pole must be flying `Flag_White`, i.e. nobody has claimed it. This is the
same self-evidencing predicate the ceremony uses, and it is what makes "unbound" true in
the world rather than only in our table.

### 2.4 The old pole is released and becomes ordinary ground

On a successful rebind the faction's `pole_key`, `x`, `y`, `z` become the new pole's. The
old pole is not remembered.

Under base declaration this has a consequence worth stating: the old pole stops being
anyone's declaration and becomes public like any other undeclared base. That is correct.
A faction that has moved out has no claim on the ground it left, and pretending otherwise
would let a faction accumulate a trail of protected former bases — the exact hoarding the
declaration rules exist to prevent.

### 2.5 A cooldown, and what it is actually for

**7 days**, matching the rename cooldown and the flag cycle.

The risk is not rebinding too often for its own sake; it is rebinding *mid-raid*. Without
a cooldown a faction under attack could relocate its identity the moment its walls come
down, so a raid never converts into a lasting loss. That would make raiding pointless,
and raiding is the product.

⚠️ The cooldown alone does not fully close that, and this design does not pretend it does:
a faction raided for the first time in a month still has its rebind available. What the
cooldown guarantees is that the *escape is not repeatable* — a faction that keeps being
found keeps losing. Making rebind unavailable during an active raid needs a notion of
"under raid" that this system does not have (there is no base-damage event in ADM; the
flag-lower is the only raid signal at all). Recorded as a limitation, not solved.

### 2.6 Rebind revives a dormant faction, and must re-stamp `activated_at`

A dormant faction that rebinds becomes `active`, with `dormant_since` cleared — the same
write `revive` already performs.

The justification is the same as revive's: dormancy means "this faction's flag has not
flown for 7 days", and a member standing at a new pole raising a flag is exactly the
evidence that is no longer true. Requiring them to *also* raise at the new pole a second
time to trigger the ordinary revive path would be a second ritual for one act.

⚠️ **It must also set `activated_at` to the rebind instant, or the faction goes dormant
again on the very next tick.** This is not obvious and it took a spec review to catch.

The dormancy clock reads
`coalesce(LAST_RAISE, activated_at, created_at)`, where `LAST_RAISE` is the newest raise of
*this faction's texture* at *this faction's pole*. After a rebind the pole is new and the
only raise there was `Flag_White`, not the faction's texture — so `LAST_RAISE` is null and
the coalesce falls through to `activated_at`, which still holds the original activation,
possibly months old. The faction reads as infinitely stale and is made dormant immediately.

Re-stamping `activated_at` is exactly what that fallback exists for: the schema comment
describes it as covering "a faction whose activating raise predates the ingested window",
and a freshly rebound pole is that case precisely. It gives the faction a full 7 days at
the new pole to fly its own flag, which is the same grace a newly activated faction gets.

⚠️ Rebind does **not** revive a `disbanded` or `lapsed` faction. Those are terminal, their
flag and tag are back in the pool, and re-entering through rebind would let a faction
reclaim an identity another faction may already hold.

---

## 3. Flow

1. A roster member raises `Flag_White` at an unbound pole. This is an ordinary
   `flag.raised` event; no new parsing.
2. The leader runs `/faction rebind` (ephemeral, like every reply here).
3. The command looks for a qualifying raise: `Flag_White`, at a pole bound to no holding
   faction, by a current roster member, within the **rebind window**.
4. If exactly one candidate, the leader confirms it with a button. If several, they pick.
   If none, the reply says what is missing.
5. On confirm: pole columns move, status becomes `active`, `dormant_since` clears,
   `rebound_at` stamps the cooldown.

### 3.1 The rebind window

Candidate raises are considered for **1 hour** before the command runs.

Short enough that a raise from a previous session cannot be reused as a surprise
relocation target; long enough that the member who raised it can walk somewhere safe and
message their leader before confirming. It is not a security boundary — §2.2's
roster-membership check is — so it does not need to be tight.

⚠️ Read from `events` directly, not from `poles` or `flag_changes`. `flag_changes` holds
zero rows in `factions_live` because its projector does not run there; `ceremony-tick` and
the dormancy clock already read the event log for this reason.

### 3.2 Two clocks, again

The window is measured against **`occurred_at`**, not ingest time, and the command must
tolerate a raise that has not been ingested yet — the answer to "I raised it and the bot
says no" is "wait for the sweep", which the reply should say in as many words rather than
reporting a flat failure.

---

## 4. Data model

One new column:

```
factions.rebound_at  timestamptz NULL   -- null means never rebound, so no cooldown
```

Plus a write to the existing `activated_at` on every rebind — see §2.6.

Mirrors `renamed_at` exactly, including the nullable-means-no-cooldown convention.

⚠️ **Nullable, with no default and no backfill.** Every existing faction has never
rebound, and a `DEFAULT now()` would put every live faction on cooldown the moment the
migration applies. This migration adds a nullable column and touches nothing else, so it
does not require stopping the bot — unlike the NOT NULL case
`docs/deploy/2026-09-01-targeted-linking.md` exists to warn about.

No new table, no index. The three scarcity indexes are unaffected: rebind changes
`pole_key`, which `factions_holding_pole_uniq` covers, and the update either satisfies it
or fails loudly.

---

## 5. Failure handling

| Situation | Behaviour |
|---|---|
| No qualifying raise in the window | Reply naming all three requirements (White, unbound pole, roster member) rather than a bare "not found" |
| Raise found, but the pole was claimed between raise and confirm | Refuse; the unique index is the authority and the reply says the pole was taken |
| Faction is `reserved` | Refuse — it has never activated; its 24h reservation lapse is the right path |
| Faction is `disbanded` / `lapsed` | Refuse; terminal, see §2.6 |
| Actor is not the leader | Refuse. `faction_members.role = 'leader'` is the single authority, checked in the write statement, not read-then-write |
| Within the cooldown | Refuse, naming the date it expires |

⚠️ The pole write is guarded on the faction's expected status and its current `pole_key`,
and reports whether it moved a row — the same at-most-once pattern the dormancy
transitions use. Two leaders confirming two different candidates concurrently must
produce one move and one refusal, not two writes.

---

## 6. Testing

- `decide`-style pure tests for candidate selection: window boundaries, White-only,
  unbound-only, roster-member-only.
- Store tests against the real database for the guarded update, including the
  concurrent-confirm race and the `factions_holding_pole_uniq` collision.
- A test that rebind clears `dormant_since` and sets `status = 'active'`.
- ⚠️ **Two tests for the `activated_at` interaction in §2.6**, which is the non-obvious
  part of this design and the one most likely to be got wrong:
  1. A faction that rebinds is **not** dormant on the next tick. Without the re-stamp it
     is, because `LAST_RAISE` at the new pole is null and the coalesce falls through to a
     months-old `activated_at`.
  2. A faction that rebinds and then **never** raises its own texture at the new pole
     still goes dormant 7 days later. The re-stamp restarts the clock; it must not
     disable it.
- Cooldown boundary, matching the rename cooldown's existing convention.

---

## 7. Carried forward

- **Pole-loss detection** (inbox item 3) would let the bot tell a faction "your pole is
  gone, you may rebind" instead of waiting for them to work it out. It needs the unbound
  fold question settled first.
- **"Under raid" state.** §2.5's limitation. Needs a raid signal richer than the
  flag-lower, which ADM does not currently provide.
- **Multiple bases** (inbox item 34) would turn rebind from "move the binding" into "move
  *one* binding", which is a different command signature.
- ⚠️ **The base-declaration design moves the pole binding off `factions` entirely** (its
  §8). This spec is written against today's schema deliberately, so rebind can ship first
  as a small self-contained change; when declarations land, rebind updates a declaration
  row instead of four columns on `factions`. The command's behaviour and every rule above
  are unaffected — only the write target moves.
