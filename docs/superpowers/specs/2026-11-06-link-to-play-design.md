# Link to play — design

Date: 2026-11-06. Status: owner's answers folded in; awaiting approval.

## Why

A few toxic players have been banned recently, from the Discord and on Nitrado. The owner wants to
stop them, and anyone like them, coming straight back on an alt account. Linking already ties one
gamertag to one Discord account in the guild; making a link the price of playing means an alt also
needs a second Discord account in the guild. The owner judged that hurdle enough on its own: no
Discord account-age check, no device matching.

A side effect the owner wants: a Discord ban becomes enough. Leaving or being removed from the guild
already drops a player's link (`removeFromGuildDb`), and losing a link is an immediate ban, so
their gamertag is banned in game on the bot's next pass. A Nitrado ban by hand stays available when someone must be gone at once.

## The rule (decided by the owner)

1. **Every gamertag that plays must be linked.** Console and PC alike. No exemptions: not admins,
   not test accounts, not invited guests.
2. **An unlinked gamertag gets 1 hour of total play time**, summed across sessions, not one hour
   from first sight. When it is used up, the bot bans that gamertag on the server.
3. **Everyone starts at zero on launch day.** Play before the launch instant never counts. A
   Discord announcement goes out about a day before launch.
4. **Starting to link lifts the ban for 1 hour**, from either front door (`/link start` or the
   site's link page), so the player can get in and perform the emotes. The lift ends early when
   they finish linking or cancel.
5. **Losing a link is an immediate ban.** No fresh hour: a gamertag whose link ends (the player
   left or was removed from the Discord, or unlinked) is banned straight away.
6. **Linking ends the ban for good.** A lift that ends without a link (the hour is up, or the
   attempt is cancelled or expires) puts the ban back.
7. **Only this ban is ever lifted.** Base-zone (`zone`), Hub-combat (`hub_combat`) and moderation
   (`conduct`) bans are never touched, and neither is any ban the owner made by hand on Nitrado
   (see §5).
8. **New players learn the rule from `messages.xml`.** The Nasdara mission's "NEW HERE? Link your
   gamertag at https://dayzclanwars.com" line is reworded to state the rule and is also shown on
   connect. This is a change in the mission repo (`nasdara`), not in this one.

## Design

### 1. A new ban reason, `unlinked`

Add `unlinked` to `BAN_REASONS` with `BAN_REASON_TEXT.unlinked = "playing without a linked account"`.
Keep `unlinked_pc` in the list: 18 old rows carry it. Bans are written as `pending` rows with
`expires_at = null` and `reason = 'unlinked'`. `banTick` already applies them to Nitrado, reference
counts against overlapping bans, and handles lifts. The new tick never calls Nitrado.

### 2. The play-time clock

An unlinked gamertag's used time is the sum, over its `player_sessions` rows on that server, of the
overlap of `[connected_at, disconnected_at ?? now]` with `[clockStart, now]`, where:

- `clockStart = LINK_TO_PLAY_FROM`, a fixed instant in `rules.ts`, set at launch.
- **Losing a link is an immediate ban (decided by the owner).** A gamertag that was linked and no
  longer is (its player left or was removed from the Discord, or unlinked) gets no hour: it is
  banned on the next pass, whatever its play time. This is what makes a Discord ban carry into the
  game at once. It applies to links lost after `LINK_TO_PLAY_FROM` only. The guild-removal and
  unlink paths both delete the `identity_links` row and nothing records that a gamertag was once
  linked, so the builder adds that record (for example a `link_ended_at` per dayz id, written in
  the same transaction as the delete). A player who unlinks to switch gamertags is banned on the
  old one, and can still get back on it through the lift (§4) by linking it again.
- Time spent playing during a lift (§4) does not reset or extend anything. The hour is already used,
  so when a lift ends without a link the ban returns at once.

`LINK_TO_PLAY_GRACE_MS = 60 min` and `LINK_TO_PLAY_LIFT_MS = 60 min` go in `rules.ts`, and both are
player-facing numbers, so each gets a row in `guide-numbers.ts` and a token in the guide.

### 3. The tick: `link-gate-tick.ts`

It is level-triggered like the old `pc-ban-tick.ts` (recovered from `a9b0feab^`, a good starting
point), and runs in the same 5-minute block, before `banTick`, so a ban it writes is applied on the
same pass. It is gated on a new `LINK_TO_PLAY` env flag with a startup log line either way.

For every gamertag with a session on the server since `clockStart` that has no `identity_links` row:

- **No active `unlinked` ban, used time ≥ the grace → write a ban.**
- **No active `unlinked` ban, and its link ended after `LINK_TO_PLAY_FROM` → write a ban**, whatever
  its play time and whether or not it has played since.
- **An `applied` `unlinked` ban and a live link attempt on that gamertag with no lift yet → lift it**
  (`lift_pending`). The lift's hour runs from when `banTick` actually removes the entry, not from
  when the attempt opened.
- **A lifted `unlinked` ban whose lift has ended (hour up, attempt cancelled or expired), still
  unlinked → write a new ban.**

Linked gamertags are skipped, and an active `unlinked` ban on a gamertag that has since linked is
closed (lifted for good).

Banned and lifted gamertags are posted to `OPS_CHANNEL_ID`, one isolated post each, falling back to
the error log, as the old tick did.

### 4. One lift per gamertag per day (decided by the owner)

A banned gamertag gets at most ONE lift in any 24 hours, whoever opens the link attempt. A second
attempt inside that 24 h (a re-roll, a switch, or another guild member opening one) does not lift
it again and does not restart the hour. Cancelling or re-rolling during a lift ends that lift
(rule 6). Count it from the ban history (`unlinked` rows that reached `lift_pending`/`lifted` with a
lift start inside the last 24 h), as the old gate derived "lift spent" from history rather than a
column. *Builder's call* on the exact shape. Why: the draw cap is 3 attempts per Discord account,
per gamertag, per 24 h (`packages/verification/src/issue.ts`), and any guild member may open an
attempt against any public gamertag, so a lift per attempt would be hours of free play a day.

### 5. Never remove an entry the owner made by hand

Nitrado's ban list is one shared field, and an entry is keyed on the identifier string. `banTick`
sends both the dayz id and the gamertag. If the owner has already banned the same gamertag or id
by hand on Nitrado, lifting our `unlinked` ban would delete their entry and free the player.

Rule: an `unlinked` ban must never remove an identifier that was on the list before we added it.
The builder records, when applying an `unlinked` ban, which of the two identifiers were already
present (`addBans` is already a read-modify-write of the whole field, so the read is there), and a
lift or close removes only the identifiers this ban added. *Builder's call* on the exact shape (a
column on `bans` is fine), with a test that a pre-existing entry survives a lift.

### 6. #bans and DMs

Unlinked players have no Discord, so there is no ban DM. **`unlinked` bans post in #bans (decided
by the owner)**, through the existing `ban_announcements` path with no reason filter: a ban posts
as applied, and a lift or a link that ends one posts as lifted, with the wording from
`BAN_REASON_TEXT.unlinked`. *Builder's call:* whether a temporary lift's #bans line should say it is
temporary, so nobody reads it as the player being cleared.

### 7. The site and the commands

- The link page and `/link start` say so when the gamertag is banned for being unlinked, and
  ⚠️ only when `unlinked` is its ONLY active ban: an overlapping `zone`/`conduct`/`hub_combat` ban
  keeps the Nitrado entry through `stillBanned`'s reference count, so a lift frees nobody and the
  promise would be false (builder's call, from the check): "Starting
  will let you back on the server for 1 hour to finish linking." Wording is plain voice
  (`brand/02-verbal-identity.md`) and never discourages playing.
- The guide gets a short section (the chapter that covers linking) stating the rule with the two
  numbers as tokens.

### 8. When a ban bites

A ban-list write takes effect without a restart (zone-enforcement spec §8), and sessions close at
disconnect, restart and duplicate connect, so `disconnected_at ?? now` never runs on. **The owner
states that a ban removes a player who is actively playing** (their experience banning on
Nitrado). The repo had this as not established (hub-combat runbook §9), so the launch runbook
watches the first real ban to confirm it, and the hub-combat runbook's known-limit note is updated
once it is. Player-facing wording may therefore say a ban lands within minutes (the 5-minute ban
block), not "at your next connect".

### 9. Catching Discord removals the bot missed (decided by the owner)

Guild removal runs only from the live `guildMemberRemove` event, and ruling 10 deliberately had no
catch-up sweep, so a player removed while the bot is down keeps their link and is never banned in
game. **This reverses ruling 10:** a reconciler finds linked Discord ids that are not guild members
and runs the same `removeFromGuildDb` the event handler runs, so a missed removal behaves exactly
like a seen one (and then the link-lost ban in §3 follows).

- ⚠️ It must act only on a member list known to be complete: run it off `structure-tick.ts`'s full
  member fetch, and skip the whole pass when that fetch has not succeeded. A blind or partial cache
  would read as "everyone left" and unlink the guild. Pin that with a test.
- ⚠️ Cap it per pass (*builder's call* on the number) and post what it did to ops, so a bad read
  that slips past the guard removes a handful of players, not hundreds.
- Its lock order is `removeFromGuildDb`'s own. Update the CLAUDE.md ruling-10 notes that say there
  is no sweep.

## Launch (runbook `docs/deploy/2026-11-XX-link-to-play.md`)

1. Ship with `LINK_TO_PLAY` unset. Merge the `messages.xml` rewording in `nasdara` and deploy it.
2. Post the Discord announcement about a day ahead (the owner posts it; we draft it).
3. Set `LINK_TO_PLAY_FROM` to the launch instant (a release), then turn on `LINK_TO_PLAY` with
   `BAN_DRY_RUN` behaviour available. *Builder's call:* a dry-run first pass that only posts "would
   ban" to ops for a few hours, if it can be done without flipping the global `BAN_DRY_RUN` (which
   has its own hazards, see CLAUDE.md).
4. Watch ops for the first bans and the first lift.

## Not in scope

- Discord account-age or device checks (owner: the second-account hurdle is enough).
- Who owns a link attempt: anyone may still open one against any public gamertag. Here that can
  lift an `unlinked` ban at most once a day (§4), never a `conduct`, `zone`, `hub_combat` or
  manual one.
- Banning across servers: bans stay per server, as today.

## Calls the designer made (for the owner to check)

- §5: an `unlinked` ban never removes a Nitrado entry that was there before it was added.
- §7: the site promises "back on for 1 hour" only when `unlinked` is the only active ban.
- §9: the removal sweep runs only off a complete member fetch, is capped per pass, and reports to
  ops.
- Launch: a "would ban" dry pass first, if it can be done without the global `BAN_DRY_RUN`.
- Reading "one link per day" (owner, Q1) as one lift per gamertag per 24 hours.
