# Targeted identity linking — design

**Date:** 2026-09-01
**Covers:** a rework of spec §16 (identity linking): `/link` names its target
character, verification drops to three emotes, and a successful link renames the
player in Discord
**Builds on:** Plan 1 (ADM ingest, event log), Plan 2 (identity linking as built),
live ingest (real events arriving continuously)
**Supersedes:** §16's untargeted challenge model, and the security machinery that
existed only to defend it

---

## 1. Purpose

`/link` is broken in production. It asked a player to perform an **SOS** emote,
which they could not find on the in-game wheel.

The token is real — `EmoteSOS` appears three times in the five-week production
export. That is the defect: the dictionary's rule was *"do not add a token that
has not been observed in a real ADM line"*, which proves a token can be produced
and says nothing about whether a player can find it. Three occurrences in five
weeks across three servers is 0.14% of all emote traffic.

Fixing the dictionary alone would leave a worse problem in place. The current
challenge **names nobody**: any UID that performs the sequence wins it. Every
piece of heavy machinery in the verification path exists to defend that lottery —
a four-emote sequence, an eight-emote budget, and a unique index on the sequence
itself. One-life does not have that problem, because a one-life claim names the
gamertag up front.

This design adopts one-life's shape: **the challenge names its character**. Three
emotes then suffice, and most of the machinery comes out with the risk it was
defending.

### In scope

- A `players` projection: which characters exist, their current gamertag, when
  each was last seen
- `/link <gamertag>` with autocomplete over recently-seen, unlinked players
- Challenges bound to a target UID at issue time
- Three-emote sequences drawn from a corrected safe list
- Setting the Discord server nickname to the gamertag on a successful link, and
  clearing it on `/unlink`
- Removing the machinery the untargeted model required

### Out of scope, deliberately

- **Reconciling nicknames when a gamertag changes in game.** The projection will
  observe the new name; nothing pushes it to Discord. A reconciliation sweep needs
  its own tick and its own decisions about cadence, and every failure mode in §6
  would then recur indefinitely rather than once. Inbox item.
- **Warning a player that someone claimed their character.** Impossible by
  construction: an unlinked player has no Discord account we know of. See §7.
- **Migrating existing links.** There are none — see §4.4.

---

## 2. Decisions, and where they diverge from one-life

### 2.1 Bind the UID; choose by gamertag

One-life stores the **gamertag** as the identity. This design keeps binding the
**UID** and uses the gamertag only to pick it.

§16 chose UID deliberately, and the reasons still hold: ceremony detection
identifies participants by UID, and a roster keyed on display names breaks the
moment a player renames. Adopting one-life's ergonomics does not require
inheriting its rename problem.

Concretely: the autocomplete's *label* is the gamertag, its *value* is the UID.
Same-name collisions resolve for free, and the submit path never re-resolves a
name.

### 2.2 Challenge TTL rises from 10 minutes to 24 hours

One-life's value, and it is now cheap. A 10-minute window assumes the player is
already standing in game when they run `/link`; a targeted challenge cannot be
stolen by anyone else, so the only cost of a longer window is a longer period in
which the *named* player might complete it by accident — which §5.3's budget
bounds independently of time.

### 2.3 Three emotes, from one-life's safe list

Length drops from four to three. The four-emote decision was taken to enlarge the
space an attacker had to cover; with a named target there is no such attacker.

The safe pool becomes one-life's 24 tokens. The five this project added beyond it
— `EmoteSOS`, `EmoteHold`, `EmoteTaunt`, `EmoteTauntKiss`, `EmoteTauntThink` —
remain in the dictionary as `safe: false` so the parser still recognises and
labels them, under a **third** documented exclusion reason:

> **not confirmed selectable from the in-game emote wheel.**

That reason replaces the rule that caused this bug. Observation in an ADM line
proves a token exists; it does not prove a player can find it.

### 2.4 The nickname is a display of the link, never a precondition for it

Discord will refuse some renames permanently (§6). The link commits first and the
rename is attempted after, best-effort. A verified identity binding is never
withheld because Discord would not let us rename someone.

---

## 3. Why three emotes is enough

The whole argument is one sentence: **a challenge can only be advanced by the UID
it names.**

Under the current model, any UID performing a sequence wins whichever challenge
holds it. That is why `verification_challenges_open_sequence_uniq` exists, and its
comment correctly calls it a security boundary — two live challenges sharing a
sequence would let the tick bind the wrong Discord account.

Once a challenge names its target, that entire class of attack is unreachable. An
attacker performing emotes on their own character can only ever advance challenges
naming their own character.

What remains is a narrower, slower risk, addressed in §7.

---

## 4. Data model

### 4.1 `players` — a new projection

| Column | Notes |
|---|---|
| `dayz_id` | Primary key. The identity; survives renames |
| `gamertag` | Latest observed display name |
| `first_seen_at`, `last_seen_at` | Event times, not wall-clock |

Maintained by a new event-log consumer with its own named cursor,
`player-projector`, alongside `pole-projector`, `identity-verifier` and
`ceremony-detector`. Every `player.position` and `emote.performed` payload carries
both `dayzId` and `gamertag`, and position events dominate the log, so last-seen
stays current with no special case.

Keyed on UID, so a rename is a column update rather than a new identity, and two
players who have ever shared a display name remain two rows.

**This table is also Plan 4c's dependency.** §6's leader-succession mechanic needs
exactly this question answered — "has this UID been seen in the last 7 days" — so
it is not scope invented for `/link`.

### 4.2 `verification_challenges.target_dayz_id`

`NOT NULL`. The change the security argument rests on: the challenge names its
character at issue time.

### 4.3 Index changes

**Drop `verification_challenges_open_sequence_uniq`.** It was a real boundary
under the untargeted model and is dead weight under this one — and worse than dead
weight: three emotes over 24 tokens is 12,144 ordered sequences, so live
challenges would begin colliding and rejecting legitimate `/link` calls.

**Keep `verification_challenges_open_account_uniq`** — one open challenge per
Discord account.

**Add a partial unique index on `target_dayz_id`** over open challenges. Two
Discord accounts must not hold live challenges for the same character, or they
race to bind it.

### 4.4 Migration safety, verified

`identity_links` holds **zero** rows in `factions_live`. `verification_challenges`
holds **one** — an abandoned challenge from the broken flow, whose sequence
contains `EmoteSOS` and which therefore can never complete.

So `target_dayz_id` can be `NOT NULL` immediately, provided the deploy first
clears `verification_challenges` and `challenge_attempts`. Nothing is lost: every
pre-change challenge is unwinnable under the new rules regardless, having no
target, and no link has ever been established. This must be an explicit, recorded
step — not a silent assumption that the tables are empty.

---

## 5. The command

### 5.1 `/link gamertag:<autocomplete>`

The autocomplete offers the **50 most recently seen** players **not** already
present in `identity_links` — one-life's `already_verified` rejection, expressed
as a filter so a taken name never appears.

Discord caps an autocomplete response at **25 choices**. Fifty is therefore the
candidate pool, filtered by the typed query and capped at 25 returned — the same
shape as the existing `flagSuggestions`.

Because a user may submit arbitrary text rather than a menu choice, the handler
re-validates on submit: an unknown UID, or one linked since the menu rendered, is
a plain refusal naming the reason.

### 5.2 Issuing

The reply is ephemeral, as today, and names the character being verified so the
player can see they picked the right one. The sequence is three emote labels in
order.

### 5.3 Matching

The tick advances a challenge only when the event's `dayzId` equals the
challenge's `target_dayz_id`.

**The emote budget's role is promoted, and its comment must say so.** Today
`MAX_POOL_EMOTES_PER_ATTEMPT = 8` is defence-in-depth against an attacker
exhausting the sequence space. Under this design that attacker cannot exist, and
the budget becomes the *primary* defence against §7's residual risk. It stays at
8; the comment is rewritten to record that it is now load-bearing.

**A budget-exhausted challenge is cancelled, not left inert.** Today it simply
stops advancing. With a 24-hour TTL that would leave a dead challenge occupying
the player's one open slot for a day. It is cancelled with a message telling the
player to run `/link` again.

**The cancellation message names the emote the player never reached** (added
2026-09-02). `challenge_attempts.progress_index` already records it;
`pendingNotifications` left-joins it so the notifier can say *which* emote
blocked them. A player stuck at index 0 never managed the FIRST emote, which is
a different failure from fumbling the order — it usually means they could not
find it on the wheel, the way `EmoteSOS` could not be found before it was
demoted. No count of emotes performed appears in the message, for the reason
§5.3 gives above: the budget is load-bearing, and a player optimising against a
number has misunderstood the task.

Prompted by a real lockout: Wintershadow394 (2026-09-01) was drawn
`move → clap → taunt elbow`, performed clap and taunt elbow four times each,
never produced `EmoteMove` at all — no such line exists in the raw ADM log — and
spent the whole budget on the two he could do. The old message told him only
that too many emotes were performed.

### 5.4 Re-rolling a sequence, and the draw cap

`/link` takes a `new-sequence` option that draws a different sequence instead of
re-showing the live one. Without it a player who cannot perform one of the three
emotes has no route out except spending the budget and waiting to be locked out.

**Draws are capped at three per (account, character) per 24 hours**, counting
every challenge issued regardless of outcome.

The cap is a security bound, not a courtesy limit, and it closes a hole that
predates the re-roll. §7's 0.46% is a *per-challenge* figure, and every draw is
a new sequence with a fresh budget — so unlimited draws make the per-day
exposure unbounded. Unlimited draws were already reachable: naming a different
character cancels and re-issues, so `/link A → /link B → /link A` handed out a
fresh sequence and a fresh budget for A as often as one liked. The cap is
therefore checked on every path that issues for a character, not only on the
explicit re-roll, and counting only explicit re-rolls would have been
bypassable with one extra command.

Per (account, character) rather than per character: a per-character cap would
let one account spend a stranger's three draws and lock them out of linking.

---

## 6. The nickname

On a completed link, the bot sets the member's server nickname to their gamertag.

**Permission:** `Manage Nicknames`, which the bot does not currently hold and must
be granted. No new *intents*: fetching one member and patching a nickname are
plain REST calls, so the bot keeps its property of requiring no privileged
gateway intents.

**Three failure modes, two of them permanent:**

1. **The server owner cannot be renamed.** Discord's API refuses, always.
2. **Anyone whose top role outranks the bot's cannot be renamed.** Role hierarchy.
3. Ordinary transient API failures.

The first two are permanent for that user and must not be retried. All three are
reported to the player in the completion message — the link succeeded, the
nickname did not, and why — and logged.

**Ordering is load-bearing: the link commits first, the rename follows.** A
verified identity binding is never withheld because Discord would not let us
rename someone.

**On `/unlink`, the nickname is cleared**, best-effort and under the same rules,
so the server stops asserting a link that no longer exists. Note `/unlink` is
already gated on faction membership, so this only fires for players not on a
roster.

---

## 7. Threat model

**The attack this design removes.** Under the untargeted model, anyone could
perform emotes and win whatever live challenge happened to hold that sequence,
binding their own UID to a stranger's Discord account. Gone: a challenge names its
character.

**The risk that remains.** Someone claims an unlinked player's character, then
waits for that player to perform the three emotes accidentally within 24 hours.

Three things bound it:

- Only *unlinked* gamertags are offered, so a linked player is permanently immune
- The 8-emote budget caps accidental completion at C(8,3)=56 of 12,144 ordered
  sequences — **0.46%** per challenge, versus effectively unbounded without it.
  ⚠️ Per *challenge*: §5.4's three-draws-per-day cap is what makes this a bound
  on exposure over time rather than a bound on one row
- The safe list excludes the emotes that occur in natural play: `EmoteSitA` alone
  is 77% of all emote traffic in the production export

**We cannot warn the claimed player.** They are unlinked, so we have no Discord
account for them. This is inherent, and one-life accepts the same exposure.

**Nickname spoofing is not introduced.** The nickname is set only from a completed
link, and a completed link requires the named character to have performed the
sequence.

---

## 8. Testing and acceptance

**Pure unit tests** for sequence generation over the corrected pool, the
autocomplete's filter and 25-cap, and the safe-list change — including an explicit
assertion that no `safe: true` token lies outside one-life's 24.

**Database-backed tests** for the projection's cursor behaviour, the new partial
unique index rejecting a second live challenge for one character, and the tick
refusing to advance on a non-target UID. That last one is the security property:
it must be proven by a test that fails if the `dayzId` comparison is removed.

**Acceptance is different from previous plans, and better: this one can be staged
for real.** The bot and the ingest worker are both running against CW-TEST with
live data. The gate is an actual `/link` performed end to end — autocomplete
offering a real gamertag, three emotes performed in game, the DM arriving, and the
nickname changing — recorded with the real values observed.

That closes the last unproven path in the system, and it is the reason this work
is worth doing before Plans 4b–4d.

---

## 9. Carried forward

- **Nickname reconciliation on gamertag change** (§1) — the projection sees the
  new name; nothing pushes it to Discord.
- **`/link` only works on servers being ingested.** CW-TEST alone today. A player
  on an un-ingested server produces no events, so their gamertag never enters the
  projection and cannot be picked.
- **The `players` projection is Plan 4c's dependency** (§4.1) — build it here,
  consume it there.
