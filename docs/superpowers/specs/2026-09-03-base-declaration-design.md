# Base declaration — design

**Date:** 2026-09-03
**Covers:** who may keep a base secret, and what happens to every base that nobody has
claimed
**Builds on:** roster core, faction dormancy (the upkeep clock this reuses),
ceremony detection (the ritual this relaxes by one word), live ingest
**Requires:** `2026-09-03-faction-rebind-design.md` — one declaration with no way to move
it is a trap, and rebind must ship first

---

## 1. Purpose

Today, claiming a pole gets you supplies, a flag and a directory entry, while your
coordinates stay gated to your members. **Not** claiming gets you complete invisibility.
The incentives run backwards: a faction can hold one declared pole and eight secret
stashes, and the flag-and-territory mechanic has nothing to say about the eight.

This design inverts that. Secrecy stops being the default and becomes the thing you earn
by declaring.

The intent is that the server is **explicitly clan-only** — the pressure toward banding
together is the feature, not a side effect. A solo is not excluded, but a solo gets only
the floor.

### In scope

- The declaration: one per player, and what it binds to
- What happens to every undeclared base
- A grace window for newly built bases
- The path from a solo holding to a faction, reusing the founding ritual unchanged
- Raise attribution: whose raise counts, and who gets told when someone touches your flag

### Out of scope, deliberately

- **Where publication happens.** §6. It interacts with `docs/direction/2026-09-02-web-app-and-faction-map.md`
  and is the one open decision this design deliberately does not close.
- **Multiple bases per faction** (inbox item 34). This design answers the question that
  item was asking — hoarding — from the other end, and supersedes it unless the pool of
  legitimate bases is later found to be too small.
- **General base-building detection.** The parser handles flagpole construction only
  (`Built X on Flag Pole`). Nothing here needs walls or fences, for the reason in §2.2.
- **Alliances.** The master spec rejects a faction-of-factions layer, and §5.3 shows the
  cooperation case resolves without one.

---

## 2. The rules

The whole design is three rules plus upkeep. Everything after this section is consequence,
not addition.

> **1. A flagpole is a base. Every base is either declared or it isn't.**
>
> **2. A declared base is private. Every other base is public.**
>
> **3. You get one declaration.**
>
> **4. Keep the flag raised, or the declaration lapses.**

### 2.1 What rule 2 does not ask

Rule 2 is **texture-agnostic**. It never asks what flag is flying, only whether the base
was declared.

⚠️ This is what makes the rules immune to the obvious workaround: an established faction
carrying one of its own flags to a new site and raising it there, so the satellite does not
look like an unclaimed white-flag pole. That base is still undeclared, so it is still
public. No detection rule, no attribution machinery, no escalation ladder — the base rule
already covers it.

An earlier draft of this design had all three of those. They existed only because rule 2
was not yet texture-agnostic.

### 2.2 Why flagpoles are a sufficient definition of "base"

DayZ runs `FlagRefreshMaxDuration = 7 days`: a territory flag must be re-raised weekly or
the base it protects begins to decay. So **every base anyone actually cares about announces
itself** — at exact coordinates, with the raiser's UID attached, at least weekly, through
the `flag.raised` events this system has ingested since Plan 1.

A base that never raises is already rotting on its own and needs no rule.

This is why no new parsing is required, and why "base" can mean "flagpole" without the
definition leaking.

### 2.3 Benefits scale with what you earned

There is one concept, not two. A solo holding is a faction that never earned a flag.

| | Declared base | Flag + tag | Supplies | Directory |
|---|---|---|---|---|
| **Solo** | yes | no | no | no |
| **Faction** (ceremony performed) | yes | yes | yes | yes |

**The ceremony gets you a flag, not a base.** Declaring is cheap — you built it, you are
standing at it. Taking one of the 33 flags is what requires the ritual, because the flag is
the scarce thing, not the ground.

This is why the ceremony's `MIN_PARTICIPANTS` stays at **3**. An earlier draft lowered it
to 2 to give solos a route in; they have one now, so the alt-account risk of a 2-UID
founding ritual is not worth taking. Three distinct linked UIDs remains what makes a
ceremony expensive to fake.

---

## 3. The grace window

> **A pole enters a 7-day grace whenever it becomes undeclared. Declare it in that window,
> or it becomes public.**

There are three entrances to that state, and one rule covers all of them:

| How a pole becomes undeclared | Grace runs from |
|---|---|
| Newly built — we see it for the first time | the first `flag.raised` or flagpole event at that pole key, already stored |
| Its faction **moved out** (`/faction rebind`) | the rebind |
| Its faction **lapsed or disbanded** | the status transition |

⚠️ The moved-out case is not a courtesy, it is load-bearing. A faction cannot teleport its
loot, so publishing the old coordinates the instant the binding moves would hand rivals a
map to a still-full base during exactly the days it is most vulnerable and least defended —
which would make moving so dangerous that nobody would, and rebind exists precisely so they
can. See the rebind design's §2.4, including the ping-pong equilibrium this creates and why
it is accepted.

**7 days, reusing the existing constant.** It is DayZ's own `FlagRefreshMaxDuration` and
our dormancy window, and it lands neatly: a base must be raised inside 7 days anyway or it
decays, so the raise that saves the base is the same act that declares it. One cycle, one
deadline, one number to explain to a player.

### 3.1 Two things the grace window needs

**A launch grace.** Every base standing when this ships is undeclared, so without a one-off
window at rollout the feature's first act is publishing the entire server. This is a deploy
step with its own runbook, not a rule.

**Rebuild cycling is possible, and accepted.** A determined hoarder can plant a fresh pole
every 7 days and live in permanent grace. Moving the loot is the real cost, not the pole,
so this is judged a poor trade rather than an exploit. If it is abused, the response is to
shorten the grace — 48h blunts it at the price of being harsher on genuine new builds.
Start at 7.

---

## 4. Solo holding → faction

A solo's base flies `Flag_White` necessarily: they have no flag from the 33 to fly.

The ceremony predicate is *"≥3 distinct linked UIDs each raising `Flag_White` at the same
pole within 10 minutes"*. It therefore already works at a solo's base, unchanged, except
for one word — the pole must currently be **unbound**. Relax it to:

> **unbound, or declared to one of the participants.**

That is the entire change. The solo and two others stand at the homestead, raise the white
flag together, and it becomes a faction base: same ritual, same evidence, same code path,
and the base and its contents carry over. No upgrade command, no migration, no second
concept.

It is also thematically exact. White means *unclaimed identity*, which is precisely what a
solo holder has, and three people raising it together is the moment that stops being true.

⚠️ **"Declared to a participant" is a security clause, not a convenience.** Because the
pole must be declared to someone actually taking part, three strangers cannot perform the
ritual at an absent player's base and take it from under them. Without that word it is a
hostile takeover by ceremony.

---

## 5. Rule 3, and the ways round it

Rule 3 — one declaration per player — is doing most of the work, so its edges matter.

### 5.1 Joining a faction releases your personal declaration

> Your declaration is your faction's base if you are in one, your solo holding if you are
> not. **Joining converts it.**

⚠️ Without this clause rule 3 is defeated by timesharing: a member leaves the faction,
declares the satellite as a solo holding so it becomes private, and rejoins after the
3-day cooldown. The clause makes the satellite go undeclared and public the moment they
rejoin.

It costs the returning member their holding. That is the correct and consistent outcome.

### 5.2 The residual equilibrium, which is accepted

A faction can keep one member permanently outside the roster to hold one extra base. The
price is a member who cannot be in the faction and repeated 3-day cooldowns; the benefit
is one base. That is a real cost for a small gain, and it is a trade factions may make.

### 5.3 Cooperation resolves without an alliance concept

A member of faction A raising faction B's flag at B's declared pole hides nothing — both
bases are declared and known. Rule 2 has nothing to say about it.

What it does today is reset B's dormancy clock, because `LAST_RAISE` filters on
`(server_id, pole_key, texture)` and **never checks who raised it**. §7 fixes that, and
once it is fixed helping an ally is mechanically pointless, so it stops without a rule
forbidding it.

---

## 6. Publication — the open decision

Rule 2 says undeclared bases are public. **This design does not settle where.**

It is the first deliberate breach of an invariant currently enforced at the type level:
pole coordinates are a raid target, gated to members in `/faction info`, kept out of DMs,
with `RosterReply.ephemeral` typed as the literal `true` so a public reply will not
compile. Publication is that rule being spent on purpose, and it deserves its own decision
rather than a default.

**The published entry should carry the flag flying there, not just coordinates.** That one
detail buys two properties with no extra mechanism:

- A faction that takes **its own** flag to a satellite signs the crime — the entry names
  the texture, and everyone knows whose it is.
- A faction flying **someone else's** flag becomes visibly an impersonator, which is
  ARMX's "do not fly another faction's colours" rule enforced by publication instead of by
  ticket.

The incentive this creates is the right one in both branches: a faction that thinks it
through flies white instead, which makes its satellite indistinguishable from any other
undeclared base. Public either way.

Two candidate surfaces, to be decided before implementation:

- **A public map on dayzclanwars.com.** The better home, and it gives the site a reason to
  exist beyond bot parity. See the direction note. Cost: this design then waits on a web
  app that does not exist.
- **A Discord channel.** Available today, no new surface. Cost: a permanent scrolling
  ledger of coordinates, harder to age out as bases are declared or destroyed.

---

## 7. Raise attribution

Independent of everything above, worth shipping on its own, and a prerequisite for §5.3.

**`LAST_RAISE` must require the raiser to be on the faction's roster**, matching what
activation already requires through `isRosterMember`. Today activation checks membership
and the dormancy clock does not: the same physical act, two different rules, only one of
them decided on purpose.

Two things follow:

- **It closes a griefing vector against the scarce pool.** Anyone — including an enemy —
  can currently keep a dead faction's clock alive indefinitely by raising its texture at
  its pole, so its flag, tag and pole never return to the 33.
- **It becomes intel.** A non-member raise at your pole means someone was at your base;
  DM the faction. Same event, different comparison.

And its sibling, from the same event with the pole test inverted: **tell a faction when
their texture is raised anywhere that is not their declared base.** Someone is flying your
colours.

⚠️ This changes live behaviour for the one active faction on `factions_live`, so the
read-only dormancy acceptance check in CLAUDE.md must be run before and after.

---

## 8. Data model

Declaration binds a **pole** to an **owner**, where the owner is a faction or a player.

Three shapes were considered. The decision is the third.

**A. A `factions` row with a null texture.** Reuses roster, dormancy, rebind and status
whole, and Postgres's treatment of NULLs as distinct in unique indexes happens to do the
right thing — many solo holdings coexist under `factions_holding_texture_uniq` without
collision. Rejected because `texture`, `name` and `tag` would all become nullable on the
table carrying the three scarcity indexes and their drift test, and every reader of
`factions.texture` would have to learn that a faction might not have one. A wide blast
radius on the most load-bearing table in the schema, to model something that is not really
a faction.

**B. A separate `holdings` table.** Keeps `factions` intact, but a pole must be unique
across *both* tables — a pole cannot be one faction's base and one player's holding at the
same time — and cross-table uniqueness is not expressible as an index. Rejected: it makes
the system's most important constraint unenforceable by the database, which contradicts
the convention below.

**C. A `declarations` table that owns the pole binding.** ✅ One row per declared pole:
server, pole key, coordinates, owner, and when it was declared. The owner is a faction or a
player, exactly one of the two. `factions` references its declaration instead of carrying
pole columns.

C is chosen because it makes both rules that matter into indexes:

- **One declared owner per pole** — unique on `(server_id, pole_key)`, replacing
  `factions_holding_pole_uniq` and covering solo holdings in the same constraint.
- **Rule 3, one declaration per player** — unique on the owner. This is the whole point:
  rule 3 is doing most of the work in this design, and it must be enforced by the database
  rather than by a check in a handler.

That follows the governing principle already used for flag, tag and pole scarcity — **the
index is the rule**.

⚠️ **The cost is real and should not be discovered during implementation.** This moves
`pole_key`, `x`, `y`, `z` off `factions`, which means a migration that relocates live data,
rewriting `factions_holding_pole_uniq`, updating `LAST_RAISE` and the dormancy store's
join, `holding-index-drift.test.ts`, the supply projection's coordinate read, and
`/faction info`. It is the largest schema change this project has made. It is also the same
move inbox item 34 would need, so it is not work spent twice.

**Sequencing with rebind.** `2026-09-03-faction-rebind-design.md` is written against
today's schema on purpose, so it can ship first as a small self-contained change. When
declarations land, rebind updates a declaration row instead of four columns on `factions`;
its behaviour and every rule in it are unchanged. That ordering is deliberate — it gets a
way to move a base into players' hands before the migration that makes moving essential.

---

## 9. Testing and acceptance

- Pure tests for the grace window boundary, and for a base first seen before the rule
  existed (the launch grace).
- Ceremony tests at a pole declared to a participant, and the refusal when it is declared
  to someone absent — §4's security clause.
- Rule 3 tests: the leave-declare-rejoin sequence in §5.1 must leave the satellite public.
- Attribution tests: a non-member raise does not reset the clock, and does produce a
  notice.
- ⚠️ A test that an undeclared base flying a *claimed* texture is still published. That is
  §2.1, the scenario this design was rewritten to handle, and the one a future
  "optimisation" is most likely to break by adding a texture check to the publication
  query.
- Acceptance against `factions_live` before and after, per §7.

---

## 10. Carried forward

- **Publication surface (§6) is the one open decision**, and it gates implementation: the
  rules are complete without it, but nothing can ship until "public" has somewhere to mean.
- **Declaring a base someone else built.** During the grace window a rival who finds your
  half-built base could in principle declare it first. Realistically they would raid it,
  and "took an undefended base" is fair play here — but the plan should state what stops it
  or that nothing does.
- Inbox item 34 (multiple bases) is superseded unless one base per faction proves too
  tight in play.
