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

> **One roster member raises the faction's OWN flag at an unbound pole, and the leader
> confirms.**

Not a ceremony. One participant, and the ordinary `MIN_PARTICIPANTS` rule does not apply —
the leader's confirmation is the second pair of hands, and a faction ground down to two
active players must still be able to move.

⚠️ Confirmation is a safety catch, not ceremony. Without it, a member raising a spare
faction flag at some pole they happened to build would silently relocate the whole
faction's base.

⚠️ The raiser must be **on the roster**, checked the way activation already checks it
(`isRosterMember`), not merely linked. A rebind moves a faction's identity to coordinates
of someone's choosing; letting a non-member's raise supply that target would let anyone
relocate any faction to a pole they control.

### 2.3 The new pole must be unbound — and the flag raised there is the faction's own

**Unbound** — `factions_holding_pole_uniq` already refuses two holding factions at one
pole. Rebinding onto an occupied pole would either violate that index or evict its owner;
the former is an error surfaced to a player who did nothing wrong, the latter is a base
takeover by Discord command.

**Not `Flag_White`.** An earlier draft of this design required the rebind raise to be White,
mirroring the ceremony. That was wrong on both counts.

It was unnecessary: White's job in the ceremony is to make "nobody owns this pole"
*self-evidencing*, but rebind already checks that against our own table, so the flag added
nothing a query was not already doing.

And it was actively harmful — see §2.6. Because the qualifying raise was White rather than
the faction's texture, the dormancy clock could not see it, and the design needed a
compensating write to avoid marking the faction dormant on the very next tick. Raising the
faction's own colours removes the special case rather than patching it.

It is also simply truer to what is happening. A faction moving house is not founding
anything and is not proving anything new about itself; it is planting its own flag
somewhere new.

⚠️ **Interim limitation, closed by base declaration.** Until declarations ship, "unbound"
can only mean "no *faction* holds this pole" — so a rebind could in principle target a pole
belonging to an unlinked or solo player. In practice the pole must be physically reachable
to raise a flag on it, so an occupied base has to be broken into first, and "took an
undefended pole" is fair play here. When declarations land, "unbound" tightens to "declared
to nobody" and covers solo holdings in the same check.

### 2.4 The old pole is released and becomes ordinary ground

On a successful rebind the faction's `pole_key`, `x`, `y`, `z` become the new pole's. The
old pole is not remembered.

The old pole stops being the faction's declaration immediately — they hold one
declaration, and it has moved.

⚠️ **But it does not become public immediately. It gets a 3-day release grace.**
A faction cannot teleport its loot: the whole point of moving is to carry everything from
the old base to the new one, and publishing the old coordinates the instant the binding
moves would hand rivals a map to a still-full base during precisely the days it is most
vulnerable and least defended. Three days is two or three play sessions — enough to haul
out, not enough to sit on.

This generalises the grace rule rather than adding one. In the declaration design a pole is
private for 7 days from when it is *first seen*; the underlying rule is better stated as:

> **A pole enters a grace window whenever it becomes undeclared: 7 days if nobody has ever
> declared it, 3 days if its declaration was released.**

A newly built pole becomes undeclared the moment we first see it. A moved-out pole becomes
undeclared at the rebind, as does one released by a lapse or a disband. Two numbers, and
the asymmetry has a reason: seven days to *establish* a base you have not declared yet,
three to *clear out* of one you have given up.

After the grace the old pole is public like any other undeclared base, and the faction has
no further claim on ground it left — pretending otherwise would let a faction accumulate a
trail of protected former bases, which is the exact hoarding the declaration rules exist to
prevent.

⚠️ **The release grace MUST stay strictly shorter than the rebind cooldown, and that is
the whole reason it is 3 and not 7.** At equal values a diligent faction could alternate
between two poles and keep both permanently private, rebinding the moment the cooldown
expired — one extra base for the price of a correctly-timed weekly ritual. At 3 against 7,
each pole is publicly listed for four days of every cycle and the alternation buys nothing.

This is a constant mirrored across two subsystems that the compiler cannot relate, which in
this codebase means it needs a test that fails when they disagree — see §6 and
`packages/db/test/holding-index-drift.test.ts` for the house pattern. Anyone raising the
release grace, or lowering the rebind cooldown, must trip it.

### 2.5 A cooldown, and what it is actually for

**7 days**, matching the rename cooldown and the flag cycle.

⚠️ It must also stay strictly longer than the 3-day release grace (§2.4). Lowering this
number is not a free knob — at 3 days it would reopen the ping-pong exploit.

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

### 2.6 Rebind revives a dormant faction, and the clock takes care of itself

A dormant faction that rebinds becomes `active`, with `dormant_since` cleared — the same
write `revive` already performs.

The justification is the same as revive's: dormancy means "this faction's flag has not
flown for 7 days", and a member standing at a new pole raising a flag is exactly the
evidence that is no longer true. Requiring them to *also* raise at the new pole a second
time to trigger the ordinary revive path would be a second ritual for one act.

✅ **And the dormancy clock needs no help.** This is worth spelling out, because an
earlier draft of this design got it wrong in a way that would have shipped.

The clock reads `coalesce(LAST_RAISE, activated_at, created_at)`, where `LAST_RAISE` is the
newest raise of *this faction's texture* at *this faction's pole*. After a rebind the pole
is the new one — and the raise that qualified the rebind was the faction's own texture at
exactly that pole. So `LAST_RAISE` finds it, and the clock is fresh with no extra write.

When the rebind raise was `Flag_White` (the earlier draft, §2.3), `LAST_RAISE` found nothing
at the new pole, the coalesce fell through to an `activated_at` that could be months old,
the faction read as infinitely stale, and it was made dormant on the very next tick. The
fix at the time was a compensating write to `activated_at`. Raising the faction's own
colours makes that whole class of problem not exist.

The ordinary consequence still holds: a faction that rebinds and then never raises its flag
at the new pole goes dormant 7 days later, on the normal schedule, counted from the rebind
raise.

⚠️ Rebind does **not** revive a `disbanded` or `lapsed` faction. Those are terminal, their
flag and tag are back in the pool, and re-entering through rebind would let a faction
reclaim an identity another faction may already hold.

---

## 3. Flow

1. A roster member erects a flagpole at the new site and raises **the faction's own flag**
   on it. This is an ordinary `flag.raised` event; no new parsing. Nothing has changed in
   the database yet — the faction is still bound to its old pole, and the new pole is
   inside its own 7-day grace, so the move stays private while it happens.
2. The leader runs `/faction rebind` (ephemeral, like every reply here).
3. The command looks for a qualifying raise: **the faction's own texture**, at a pole that
   is neither its current pole nor bound to any holding faction, by a current roster
   member, within the **rebind window**.
4. If exactly one candidate, the leader confirms it with a button. If several, they pick.
   If none, the reply says what is missing.
5. On confirm, one guarded write: pole columns move, status becomes `active`,
   `dormant_since` clears, `rebound_at` stamps the cooldown.
6. The old pole is released and gets a **3-day** release grace (§2.4), giving the faction
   time to move its loot before the coordinates become public. Note the asymmetry with
   step 1: the *new* pole is newly built, so it carries the 7-day new-build grace.

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

No write to `activated_at` is needed — see §2.6.

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
| No qualifying raise in the window | Reply naming all three requirements (the faction's own flag, a pole nobody holds, raised by a roster member) rather than a bare "not found" |
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
- ⚠️ **Two tests for the dormancy interaction in §2.6.** The clock is correct by
  construction now rather than by a compensating write, and these are what keep it that
  way — a future change that reverts the rebind raise to `Flag_White` must fail here:
  1. A faction that rebinds is **not** dormant on the next tick, because `LAST_RAISE`
     finds the rebind raise at the new pole.
  2. A faction that rebinds and then **never** raises again still goes dormant 7 days
     later, counted from the rebind raise. Reviving must not disable the clock.
- The old pole's release grace: it is **not** published immediately after a rebind, and it
  **is** published once its 3 days elapse (§2.4).
- ⚠️ **A drift test asserting `RELEASE_GRACE_MS < REBIND_COOLDOWN_MS`.** These are two
  statements of one fact that the compiler cannot relate, and if they ever meet the
  ping-pong exploit in §2.4 reopens silently — no error, no failing behaviour, just a
  faction quietly holding two private bases. This is the same class as
  `holding-index-drift.test.ts` and `dormancy-index-drift.test.ts`, and it is the single
  most important test in this design.
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
