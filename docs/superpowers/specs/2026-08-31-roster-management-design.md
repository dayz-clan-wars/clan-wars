# Roster management — design

**Date:** 2026-08-31
**Covers:** spec §6 (roster management) in full, plus three dependencies §6 rests on:
inbox item 2 (`/unlink` gate), pole loss / dormancy / rebind (§4, §5 "Pole binding and pole
loss", inbox item 3), and per-faction Discord roles and channels (§10)
**Builds on:** Plan 1 (ADM ingest, flag events, pole projection), Plan 2 (identity linking),
Plan 3 (faction record, ceremony, claim, activation), live ingest (continuous events)

---

## 1. Purpose

Plan 3 produced a faction: a name, a tag, a flag, a bound pole, and a founding roster written
once at claim time. Nothing has managed that roster since. A faction cannot gain a member, lose
one, change hands, or be wound up, and a leader who quits DayZ freezes their faction forever —
which is precisely the outcome the no-admin-intervention goal exists to prevent.

This design makes a faction *governable*.

### In scope

- The role model (leader, officer, member) and the invariants that hold it together
- Invite, accept, decline, kick, promote, demote, transfer, leave, disband, rename
- Public `info` and `roster`
- One player, one faction per server
- The 3-day kick/leave cooldown
- Leader succession: inactivity measurement, the 48-hour challenge, `claim-leadership`
- Pole loss detection, the `dormant` transition, and `/faction rebind`
- Per-faction Discord role and private channel
- The `/unlink` gate (inbox item 2)

### Out of scope, deliberately

- **§7 raid credit and rankings** — the roster's consumer, not part of building it. Noted below
  where it constrains a decision (roster history).
- **§8 supply spawner, §9 proximity ping, §11 public directory** — later sections entirely.
- **Roster history.** Membership rows are deleted when a faction stops holding (see §4). If §7
  later needs "who was on the roster at time T", it needs an append-only membership log, which
  is a change to this design rather than an extension of it. Called out so that decision is
  made deliberately and not discovered.

---

## 2. Decisions, and where they diverge from the spec

Every divergence was taken deliberately. §6 remains the intent; these are the points where
reality or the existing schema forced a choice.

### 2.1 "One player, one faction per **server**", not per map

§6 says per map. The database holds three servers across two maps — `S2` and `S3` are both
`chernarus` — so per-map and per-server are different rules, and §6 was written assuming one
server per map.

Per server is chosen, for the reason §6 itself gives for having the rule at all: the roster's
job is discriminating maintenance from raids **at the faction's own pole**, and poles belong to
a server. A player active on both chernarus servers has two separate bases and no ambiguity
about whose flag they may touch.

It is also the only version enforceable by an index. `faction_members` links to a faction and
factions link to a server, so no index can span the faction→server→map join without
denormalizing the map onto every membership row and keeping it correct on write.

### 2.2 The 48-hour objection window runs on the wall clock; inactivity runs on the log clock

The two-clock rule from Plan 3, applied to succession.

Inactivity is `highWaterMark − lastSeen`, both event times. If ingest stalls, the high-water
mark stops advancing, so **nobody accrues inactivity during an outage**. Measuring inactivity
against the wall clock would make every leader on every server cross the 7-day threshold
simultaneously during a multi-day outage — opening every faction to a coup at the exact moment
the system is least able to see the truth.

The 48-hour objection window is a human Discord deadline: it runs on the wall clock, so it
cannot stall open indefinitely while players wait for a countdown that has frozen.

### 2.3 Roster commands work while a faction is `reserved`, `active` or `dormant`

The three holding statuses. A reserved faction has a real founding roster that can legitimately
grow before the flag goes up; a dormant one has lost its pole but not its people. Once a faction
lapses or disbands it holds nothing, and its roster does not exist to manage.

### 2.4 The rename cooldown is 7 days

§6 asks for a cooldown ("identity should not churn") without naming a number. Seven days matches
the leader-inactivity threshold, so there is one "a week" in the product rather than two
different ones.

### 2.5 `/faction invites` is added to §6's command list

§6 has invitations arriving and being accepted via button, which means a DM. The ceremony
notifier already establishes that DMs fail — a player with DMs closed would hold an invitation
they can neither see nor accept, with no path to discovering it exists.

`/faction invites` lists your pending invitations with the same accept and decline buttons. One
small handler, and it removes an undeliverable dead end. The inviter's reply reports whether the
DM landed, so they know whether to tell their friend to run it.

### 2.6 The founding-roster confirm step stays as Plan 3 built it

Inbox item 15 notes that `/faction claim`'s roster select has no separate confirm button, which
§6 called for. Accepted then because the menu is ephemeral and only the claimant sees it; not
revisited here. Recorded so it is a known accepted divergence rather than an oversight.

---

## 3. Sequencing: one design, four plans

These are four subsystems with four different failure modes. They are specified together
because they share a data model, and built separately because they need separate acceptance.

| Plan | Subsystem | Why here in the order |
|---|---|---|
| **4a** | Roster core | Everything else acts on this model. Pure request/response over the database; testable with no network. |
| **4b** | Pole loss, dormancy, rebind | `dormant` is a *state* the other subsystems must respect. Settling it late means retrofitting status checks into every command. |
| **4c** | Leader succession | Needs 4a's role model and a new player-activity projection. Time-driven, two clocks. |
| **4d** | Discord roles and channels | Purely presentational: the roster is correct without it, and it is the only piece whose breakage costs appearance rather than truth. |

A wrong ruling in 4b silently marks live factions dormant. A half-applied role in 4d leaves a
kicked player still reading a private channel. Neither belongs in the same acceptance gate as
`/faction promote`.

---

## 4. Data model

The governing principle, already used for flag, tag and pole scarcity in Plan 3: **the index is
the check.** Every rule below is a database constraint, not a code path that remembers to look.

### 4.1 `faction_members` gains `server_id`

Denormalized from the faction so the uniqueness rule can be an index:

```
uniqueIndex("faction_members_server_player_uniq").on(serverId, dayzId)
```

Unqualified — no partial predicate — which is only correct if membership rows disappear when a
faction stops holding. They do: **lapsing and disbanding delete the roster.** Membership in a
lapsed faction is not a weaker membership; it is not a membership. The lapse transition already
exists in `ceremonyTick` and is the single place this must happen.

`NOT NULL` immediately. Verified: `faction_members` holds zero rows in both `factions` and
`factions_backfill`, so there is no populated-table dilemma of the kind `servers.nitrado_service_id`
faced.

### 4.2 Exactly one leader

```
uniqueIndex("faction_members_leader_uniq").on(factionId).where(role = 'leader')
```

`/faction transfer` becomes one transaction demoting the old leader to officer and promoting the
target, guarded on the caller still being leader and deciding from `.returning()`. Two
simultaneous transfers cannot both succeed, and neither can a double promotion.

### 4.3 `faction_invites`

| Column | Notes |
|---|---|
| `faction_id`, `server_id` | Server denormalized so the accept guard needs no join |
| `invitee_discord_id`, `invitee_dayz_id` | Both, because the invite is issued to a Discord user but the roster keys on the UID |
| `invited_by_discord_id` | Provenance |
| `created_at`, `expires_at` | 7-day TTL; an invite is an offer, not a standing permission |
| `accepted_at`, `declined_at`, `revoked_at` | Terminal states, all nullable |

```
uniqueIndex("faction_invites_pending_uniq").on(factionId, inviteeDayzId)
  .where(accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL)
```

⚠️ The predicate deliberately does **not** include `expires_at > now()`. A Postgres partial
index predicate must be IMMUTABLE, and `now()` is not — such an index is rejected at creation,
and a predicate that silently changed meaning as time passed would be worse if it were allowed.

Expiry is therefore enforced on the read and accept paths, not by the index. Re-inviting a
player whose earlier offer lapsed refreshes that row (`onConflictDoUpdate` on the pending index,
setting a new `expires_at`) rather than inserting a second one — so the index stays the check
for "one outstanding offer", and expiry stays a property of the row's contents.

Scoped to the faction, not the player: several factions may court the same player, and choosing
between them is the player's to make. Only one *outstanding offer per faction* is allowed.

### 4.4 `roster_cooldowns`

Keyed `(server_id, dayz_id)` with an `until` instant, upserted to the later of the existing and
new value on kick or leave. The **decision** is stored, not the departure event, so the accept
path is a `NOT EXISTS` against one row rather than a "find the newest departure" query.

Three days, wall clock, applied equally to kicks and voluntary departures — §6's reasoning is
that the two collapse under collusion ("just kick me"), so punishing them differently buys
nothing. Disbanding writes no cooldowns: §6 is explicit that it is not betrayal.

### 4.5 `factions.renamed_at`

Nullable timestamp, set by `/faction rename`. Null means never renamed and therefore no cooldown.

### 4.6 Added by later plans in this sequence

- **4b:** whatever pole-loss detection requires, plus the `dormant` transition. The `dormant`
  status and the pole columns already exist from Plan 3.
- **4c:** `player_last_seen (server_id, dayz_id, last_seen_at)`, maintained by a new event-log
  consumer with its own named cursor, alongside `pole-projector`, `identity-verifier` and
  `ceremony-detector`; and `leadership_challenges`, holding the 48-hour window.
- **4d:** `factions.discord_role_id` and `factions.discord_channel_id`, both nullable — a
  faction is valid before Discord has caught up with it.

---

## 5. Command surface

Every handler is a pure function over a store interface, as `handleFactionClaim` already is, so
the guards are testable without Discord. Writes follow the rule this codebase learned the hard
way: **never pre-read then write.** Each guarded transition is one statement carrying the whole
precondition in its `WHERE`, with the outcome decided from `.returning()` — the same shape as
`reserve()`'s `flag-taken` / `tag-taken` / `pole-taken` outcomes.

| Command | Who | Guards |
|---|---|---|
| `/faction invite @user` | Leader, Officer | Invitee has a linked UID; holds no faction on this server; no live cooldown; faction holding |
| `/faction invites` | Anyone | Lists your pending invitations, with accept and decline buttons |
| `/faction kick @user` | Leader, Officer | Officers cannot kick officers or the leader; nobody kicks themselves. Writes a cooldown |
| `/faction promote @user` | Leader | Target is a member of this faction |
| `/faction demote @user` | Leader | Targets officers only, never the leader |
| `/faction transfer @user` | Leader | Target on the roster; confirmation required; one transaction |
| `/faction leave` | Anyone | The leader is refused and told to transfer or disband. Writes a cooldown |
| `/faction disband` | Leader | Confirmation required. Status → `disbanded`, releasing flag, tag and pole through the existing partial indexes; roster deleted; no cooldowns |
| `/faction rename` | Leader | 7-day cooldown; length-bounded, control characters stripped |
| `/faction rebind` | Leader | Plan 4b. Faction is `dormant`; raise White at a new pole |
| `/faction claim-leadership` | Officer | Plan 4c. Leader inactive ≥ 7 days on the log clock |
| `/faction info [name]` | Public | — |
| `/faction roster` | Public | — |

Accepting an invitation is one guarded insert: the invite is still pending, the faction still
holds, the invitee has no membership on that server, and no cooldown is live. Any of those
failing is a reply, not an exception.

### 5.1 Server context

A player holds at most one faction per server but may hold several across servers. Commands
resolve context from the player's own memberships: exactly one, use it; more than one, the
command requires an explicit server, offered by autocomplete over **only that player's**
factions.

This deliberately does not adopt §16's per-map channel resolution, which cannot distinguish `S2`
from `S3`. Per-map channels remain open (inbox item 6) and are not blocked by this choice.

### 5.2 Replies

**Every** reply is ephemeral, `info` and `roster` included.

§6 makes `info` and `roster` public on the reasoning that flags are visible in-game, so roster
membership is not intelligence worth hiding. That reasoning holds for membership and does not
hold for the info card, which carries the faction's **pole coordinates** — a raid target, not
something a rival can read off a flag from across the map. `info` takes a `name` and does no
membership check to find the card, so `/faction info name:<rival>` was a recon command that
posted the answer into the channel.

Two changes, because ephemerality alone does not fix it — it hides the answer from the channel,
not from the caller:

- `RosterReply.ephemeral` is typed as the literal `true`, so a public roster reply no longer
  compiles. This replaces `PUBLIC_ROSTER_SUBCOMMANDS`, which stated the same fact a second time
  in the wiring and had to be kept in agreement by a test.
- The `Pole:` line is emitted **only when the caller is a member of that faction**. Every other
  field of the card stays visible to anyone, so `info` remains a directory.

### 5.3 The `/unlink` gate

`handleUnlink` currently deletes an identity link with no checks, because no rosters existed.
It now refuses for anyone on a roster: a member is told to leave first, a leader to transfer or
disband. Unlinking a leader's identity would otherwise orphan the faction — the exact frozen
state §6's succession mechanic exists to prevent, reachable in one command.

---

## 6. Leader succession (Plan 4c)

The mechanic §6 calls decisive for the no-admin-intervention goal.

**Inactivity** is measured from `player_last_seen`, a projection maintained by a new event-log
consumer: any event carrying a player's UID updates their last-seen instant for that server.
`player.position` dominates in practice. A leader is challengeable when
`highWaterMark − lastSeen ≥ 7 days`, both event times (§2.2).

**The challenge.** Any officer may open one, and **only one may be open per faction at a time** —
a partial unique index on `leadership_challenges(faction_id)` over unresolved rows, so two
officers racing to depose the same leader cannot open competing windows. It runs 48 hours on the
wall clock and is announced
by DM to every faction member, reusing the ceremony notifier's pattern **including its
per-recipient delivery tracking** — one member with closed DMs must not prevent the rest from
hearing, and must not cause the whole faction to be re-DM'd every tick for two days.

Not a public channel: announcing that a faction is leaderless and contested is raid
intelligence.

**Resolution.** If the leader shows any game activity before the window closes, the challenge is
void. Otherwise the challenging officer becomes leader on expiry, through the same guarded
transfer statement §4.2 describes.

---

## 7. Threat model

**Paper-stuffing.** §6 accepts it: the ceremony proves every *founding* member was present, and
Discord invites let a faction found with three real players and grow to thirty. Safe **provided
roster size never confers a mechanical benefit** — a constraint this design does not enforce and
cannot; §7 and §8 must respect it. Recorded here because it is the assumption the whole roster
model rests on.

**Denying raid credit by rostering an enemy.** Blocked by consent: joining requires accepting an
invitation, so nobody is rostered mid-raid without acting.

**Roster-hopping to launder a raid.** Blocked by the 3-day cooldown on joining any faction on
that server (§4.4).

**Coup by manufactured inactivity.** Blocked by measuring inactivity on the log clock (§2.2). An
attacker cannot make a leader look inactive without stopping ingest, and stopping ingest freezes
the measurement rather than advancing it.

**Coup by a single officer against an active leader.** The 48-hour window plus the DM to the
leader is the whole defence. A leader who plays daily but never opens Discord will see the
challenge voided by their own game activity without ever reading the DM — which is the intended
behaviour, and the reason inactivity is measured in-game rather than in Discord.

---

## 8. Testing and acceptance

**Pure handler tests** against a fake store: every guard, every refusal message, no database.

**Database-backed store tests** for the guarded writes. These carry more weight than usual
because the rules *are* the indexes, and a test running two statements sequentially proves
nothing about a constraint whose whole job is deciding a race. The ones that matter run
genuinely concurrently:

- two factions' invitations accepted at the same instant by the same player — exactly one
  membership survives
- two simultaneous promotions to leader — the partial index rejects one
- a kick racing the kicked player's own `/faction leave`
- a rename racing another rename inside the cooldown

**Acceptance** follows Plan 3's pattern: fixtures now, staged later. The fixture gate is
checkable in CI. The staged gate — a real faction founded in a real guild, invited, promoted,
transferred, kicked, disbanded — needs a Discord guild and human hands, and goes in the
acceptance doc **unchecked**, joining the two already open: Plan 3's staged ceremony and the
live Nitrado tick.

---

## 9. Carried forward

- **Roster history** (§1) — deleting membership on lapse and disband forecloses "who was on the
  roster at time T". If §7's raid credit needs it, that is a change to this design.
- **Per-map channel resolution** (inbox item 6) — still open, and now known to be insufficient
  on its own: two servers share `chernarus`.
- **Roster size must never confer a mechanical benefit** (§7) — a standing constraint on §7 and
  §8, not enforced by anything here.
- **The founding-roster confirm button** (inbox item 15, §2.6) — accepted divergence, not fixed.
