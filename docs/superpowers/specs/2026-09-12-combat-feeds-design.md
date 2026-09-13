# Combat feeds — design

Three new Discord feeds over the same combat data, plus a shared poster the existing kill
feed folds into: **#hit-feed** (every PvP hit, grouped into engagements), **#killstreaks**
(every third consecutive kill) and **#long-range** (kills at 100 m or more).

The three are **highlight channels**: they duplicate the kill feed rather than diverting
from it. One 340 m kill that is also a 6-streak posts in all three plus #kill-feed. Each
channel is a complete record of its own thing, and #kill-feed's running tallies stay whole
— which routing kills exclusively to "the most interesting channel" would have broken.

---

# Part 1 — Hit feed

Every PvP hit reaches Discord. Hits belonging to one engagement become one post, not one
post each. An engagement that ends in a kill is not posted to the hit feed at all — its
hit detail is appended to the kill feed's existing embed instead, so a fight is never
split across two channels.

Builds on `docs/deploy/2026-09-08-kill-feed.md` (the poster shape this copies) and
`packages/adm-parser/src/hit.ts` (the parse, already complete).

## What already exists

`parseHit` reads a `hit by` line into attacker type, attacker id and gamertag, weapon,
distance, damage, body part, and the victim's HP *after* the hit. Every one of those lands
in `events` as a `player.hit` row. Nothing consumes them today except `kills-tick.ts`,
which reads them backwards from a death line to attribute it.

So the feed needs no parser work and no new column. It needs a grouping rule, a consumer,
and an embed.

## The engagement

An **engagement** is a run of hits sharing `(attackerDayzId, victimDayzId, weapon)` where
the attacker is a player. It **closes** when no further hit joins it within
`HIT_BURST_WINDOW_S` (default 60).

Only PvP: `attackerType === "player"`. Infected bites, fall damage, fences, animals and
vehicles are ignored entirely. A self-inflicted hit — `attackerDayzId === victimDayzId` —
is not PvP either, and is dropped by the same rule the roster uses everywhere else.

`weapon` is part of the key, so a mid-fight switch from a KA-74 to a Mosin reads as two
engagements. A null weapon is its own key value, distinct from any named weapon; it does
not merge with the next weapon the log happens to name.

## Suppression: the kill wins

A closed engagement is **suppressed** — never posted to the hit feed — if a `kills` row
exists with that engagement's `attackerDayzId` as `killer_dayz_id` and its
`victimDayzId` as `victim_dayz_id`, dated in
`[firstHit.occurredAt, lastHit.occurredAt + RECENT_HIT_WINDOW_S]`.

⚠️ **The suppression key ignores weapon, though the grouping key does not.** If Steve works
Dave over with a KA-74 and then switches to a Mosin for the kill, weapon-keyed suppression
would send the Mosin half to the kill feed and orphan the KA-74 half in the hit feed —
the same fight, two channels, reading as two unrelated events. Ignoring weapon here pulls
the whole run after the kill. Weapon therefore splits posts only in encounters nobody died
in, which is the only place the distinction is legible anyway.

Hits by a *different* attacker on the same victim are unaffected: if Rob also shot Dave but
Steve got the kill, Rob's engagement is not suppressed and posts to the hit feed. Rob's
encounter did not end in a kill.

## Two timing hazards

Both are about deciding "this engagement is over" — the only hard problem here.

### A kill can arrive after the burst looks quiet

`kills-tick`'s `verdictOf` credits a *finished* death — victim shot to `FINISH_HP_MAX`
(25) or below and nothing else touched them — by looking back `RECENT_HIT_WINDOW_S` (120
seconds) from the death line. A burst that has been quiet for 60 seconds can still be
claimed by a death 90 seconds after its last hit.

If the hit feed posted at the 60-second mark, that fight appears in both channels.

**Guard:** an engagement is eligible to post only when its last hit is *both*
`HIT_BURST_WINDOW_S` quiet *and* at least `RECENT_HIT_WINDOW_S` behind the ingest frontier.
Both tests read the frontier, never the wall clock — see the next hazard. The eligibility delay
is therefore `max(HIT_BURST_WINDOW_S, RECENT_HIT_WINDOW_S)` — two minutes at the defaults.
A non-fatal encounter surfaces about two minutes after it ends. That latency is the price
of never double-posting a fight, and it is worth paying.

⚠️ The two constants are independent and must stay so. Raising `HIT_BURST_WINDOW_S` past
120 widens the burst *and* the delay; lowering it below 120 widens neither, because the
120-second floor binds. Do not "simplify" them into one value.

### Ingest is batched, so wall-clock quiet is a lie

The ADM poller ingests in file-sized chunks. If it is ten minutes behind, every open
engagement looks quiet against `Date.now()` and the feed closes fights that are still
being fought — then posts a second embed when the rest of the burst arrives.

**Guard:** the closing test's notion of "now" is the **ingest frontier** —
`max(events.occurred_at)` across the whole log — not the wall clock. An engagement is quiet
when `frontier - lastHit.occurredAt >= HIT_BURST_WINDOW_S`. With ingest caught up, the
frontier tracks real time and behaviour is unchanged; with ingest behind, nothing closes
early.

⚠️ **The frontier is global, not per server, and that is a live trap the day a second
server is registered.** `PgHitFeedStore.frontier()` has two branches and both span every
server: `min(occurred_at)` over events the kills projector has not reached (conservative,
and therefore safe), and — on most ticks, once the projector is caught up — an unqualified
`max(events.occurred_at)`, with no `server_id` term. With two servers, the one whose ADM poller
is *ahead* sets the frontier for both, so a fight still being fought on the lagging server
looks quiet, closes, and is posted to #hit-feed — and then again to #kill-feed when the
death finally lands. That is exactly the double-post this guard exists to prevent, and
nothing logs when it happens. It is global on purpose: `readAfter` reads all servers' hits
in one id-ordered pass against a single scalar frontier, and both the truncation guard and the
cursor-ordering fixed point are built on that single pass. Narrowing only the `max` query
would not be enough — the read itself has to become per server. One server is registered
today; do this work **before** a second goes live, not after.

### And a third: the kills projector could be wedged

Suppression is only as good as the `kills` table. The 120-second eligibility delay gives
`kills-tick` twelve passes at the default 10s tick to project a death, which is ample —
but a wedged kills projector would leak fatal encounters into the hit feed, and the kill
feed would announce them again later.

**Guard:** the hit feed refuses to close an engagement whose last hit is newer than the
position of the `kills-projector` cursor. If kills stops advancing, the hit feed stops too,
and resumes where it left off. A stalled feed is recoverable; a channel full of
double-posted fights is not.

## Consumer shape

The shared `cursorFeedTick` of Part 4, for the reasons `kill-feed-tick.ts` documents:

- Cursor consumer named **`hit-feed-poster`** in `consumer_cursors`. ⚠️ Distinct from every
  other consumer name — two consumers sharing a cursor skip each other's events.
- **The first run seeds the cursor at the head and posts nothing.** `events` holds the
  server's whole history of hits; a poster that replays it announces last month to a public
  channel.
- Post, then advance. The first failure ends the run, so the channel stays chronological.
- At-least-once: a crash between the post and the cursor write re-posts that engagement on
  the next start. Same trade as the kill feed and `notice-tick`.

**Cursor advance.** Within a batch, an engagement is safe to post only if doing so cannot
bury another, not-yet-posted engagement's earlier hits below the new cursor.

An open-only rule — "safe if its last event id is below the smallest first event id among
still-OPEN engagements" — is not sufficient. A CLOSED engagement that is itself withheld by
that same rule (because something else blocks it) is just as much an obstacle as an open
one: its early hits are equally unposted, and stepping the cursor past them buries them the
same way. The obstacle set is therefore every engagement that ends up NOT posted this batch,
open or withheld-closed alike — which is exactly what makes computing it a fixed point
rather than one sorted pass: a withheld closed engagement's own first event id can
retroactively disqualify a different, earlier-last-event-id candidate that looked safe
against a barrier computed before that withholding was known (two fully closed engagements
whose event-id spans nest, with neither open, is enough to trigger this).

Compute it as: start with the open engagements as the obstacle set. Repeatedly move any
not-yet-decided closed engagement whose last event id is not below the current minimum
obstacle first-event-id into the obstacle set too, recomputing the minimum each pass, until
a pass changes nothing. What remains is the safe set; post it in ascending last-event-id
order, and the cursor advances to each posted engagement's own last event id in turn. With
nothing open and nothing withheld, the whole batch is safe and posts in one pass. A fight in
progress — open, or closed-but-blocked — holds the line rather than being stepped over,
which is what makes an engagement straddling a batch boundary arrive whole once it finally
clears.

**The batch limit is part of that fixed point, not a slice after it.** An engagement dropped
by a trailing slice is neither posted nor an obstacle, so nothing was ever checked against
it — which reopens the same hole. The dropped tail joins the obstacle set and the passes run
again, until neither the disqualification pass nor the limit changes the set.

**Liveness beats the limit.** Every safe set is a prefix of the closed engagements in
last-event-id order (if an un-posted engagement's last event id were below the largest
posted one, its first event id would be below it too, and the post was never safe), so when
the safe set's spans nest, a prefix shorter than the whole thing can be unsafe. If that whole
thing is longer than the batch limit, no admissible set of at most `limit` engagements
exists, and posting nothing would stall the feed permanently — the same rows, the same
answer, every tick, with no open engagement that will ever close to break it. In that case
the batch overshoots the limit and posts the smallest non-empty safe prefix instead. The
limit is a batch-size hint, bounded by the rows already read; the cursor invariant is not.

**What this guarantees, and what it deliberately does not.** The guarantee is about the batch
as a whole: for every posted engagement `e`, `e`'s last event id is below the first event id
of every engagement NOT posted this batch. It is *not* prefix-safe. Posted spans may nest —
A (first 1, last 10) and B (first 2, last 3) both post, ordered [B, A] — and the loop advances
the cursor per item and stops at the first post failure, so if B posts and A's post then
fails, A's hits at ids 1-2 are below the cursor and A re-posts later as a fragment. That is
accepted, not overlooked. The only rule that is prefix-safe is a single sorted pass with
stop-at-first-failure, and it deadlocks forever on two fully closed engagements whose spans
nest with neither open — an ordinary shape, not an edge case. These feeds are at-least-once
by design; one duplicated fragment after a Discord outage is the price of a feed that cannot
wedge.

Suppressed engagements advance the cursor exactly as posted ones do. They are decided, not
pending.

## The posts

### Hit feed

One embed per posted engagement. Attacker-centric, matching the kill feed's framing: title
is the attacker, thumbnail is the attacker's clan flag, both names link to their profiles.
Colour is a duller rust than the kill feed's, so the two channels are distinguishable at a
glance. Timestamp is the **last hit's** time, not the post's — a delayed post still reads as
when it happened.

```
Steve [WOLF]                                    (flag thumbnail)
hit Dave [BEAR] 4 times · KA-74
152 damage · left them at 12 HP

  38 dmg · Torso · 41 m
  38 dmg · Torso · 40 m
  38 dmg · Torso · 42 m
  38 dmg · Head  · 39 m
```

Friendly fire — both sides in the same non-null faction at the time of the hits — is said
in the title and coloured amber, exactly as the kill feed does it.

### Kill feed

The existing embed, unchanged, with the run that killed them appended as detail lines.
These carry the weapon per line, because a kill run may span a weapon switch:

```
Steve [WOLF]
finished Dave [BEAR]
KA-74 · 41 m
12 kills for Steve · 3 deaths for Dave this season

  38 dmg · Torso · KA-74 · 41 m
  38 dmg · Torso · KA-74 · 40 m
  22 dmg · Torso · Mosin · 112 m
```

A kill with no hits behind it — the log sometimes gives `player.killed` with nothing
before it — renders exactly as it does today. The detail block is omitted, not left empty.

### Detail lines, in both feeds

`damage · bodyPart · distance`, each part dropped when the log did not give it; a line the
log gave nothing for is omitted rather than rendered as separators. Damage rounds to whole
numbers, distance to whole metres — the same rounding `howLine` already uses.

⚠️ **Capped at 10 lines**, then `… and 6 more`. Discord's description limit is 4096
characters, but a sustained firefight stops being readable long before it stops being
legal. The cap is one constant in `kill-feed-embed.ts`, shared by every feed that lists
repeated items — the hit lines here, and the killstreak victim list in Part 2.

Gamertags pass through `escapeMarkdown` everywhere markdown actually renders: the embed
**description** (every detail line, every `who()` link, the killstreak victim list) and
every clan tag. A name is text, never markup.

⚠️ **Embed titles are the exception, in every feed, deliberately.** Discord renders no
markdown in an embed title, so an escape there is not neutralised — it is *displayed*. A
gamertag of the ordinary Xbox shape `x_Dave_x` would read `x\_Dave\_x` to every player in
the channel. The title therefore carries the **raw** gamertag, which is what the deployed
#kill-feed has always done (`kill-feed-embed.ts`). This is not an oversight to be "fixed"
by adding the escape back: the two contexts have opposite rules, and only the description
is markup.

# Part 2 — Killstreaks

A **streak** is a player's consecutive PvP kills since the last time **another player**
killed them. Post on every `KILLSTREAK_EVERY`-th kill of the streak: the 3rd, 6th, 9th and
so on, unbounded.

## What counts, and what breaks it

Only a death **at another player's hand** resets a streak to zero: a `kills` row whose
`victim_dayz_id` is the streaking player and whose `killer_dayz_id` is set and different.
Zombies, fall damage, starvation, fences and self-inflicted deaths leave the streak
running.

⚠️ **Friendly fire does not advance a streak — but being killed by a clanmate still ends
one.** The two directions differ on purpose, and the asymmetry is the whole rule:

- As the **killer**: a kill where `kills.friendly_fire` is true does not count toward the
  streak. Without that, the cheapest 9-streak on the server is three clanmates standing
  still, and the feed stops meaning anything.
- As the **victim**: it counts, exactly as the normative rule above says. A streak ends
  when *another player* kills you, and a clanmate is a player. No exception is carved out
  for the killer's clan — the death lookup in `killstreak-feed-tick.ts` is keyed on `pvp`,
  not on `streakable`, and that is intended, not an oversight.

So the rule protects the *feed* from being farmed by a friendly firing squad; it does not
protect the person who gets shot. Dying is dying.

⚠️ **Streaks are not season-scoped**, unlike the kill feed's tally. Only death ends one, so
a streak running across a season boundary keeps counting. The two are different questions:
a tally asks "how well is this season going", a streak asks "how long since you died".
Scoping a streak to a season would silently reset live streaks at midnight on the rollover.

Logging out does not break a streak. A player who disconnects on 8 and returns two days
later resumes at 8.

## The count

    streak(killer, at) = count of kills where
        killer_dayz_id = killer
        AND victim_dayz_id <> killer_dayz_id
        AND friendly_fire = false
        AND occurred_at <= at
        AND occurred_at > lastPlayerDeath(killer, at)

`lastPlayerDeath(killer, at)` is the newest `occurred_at` among kills with
`victim_dayz_id = killer`, `killer_dayz_id` set and different, at or before `at`; null if
they have never been killed by a player, in which case the streak counts all of their
kills.

Computed at post time from `kills`, not stored. ⚠️ Deriving it means the answer is the same
however late the post lands and however many times the projector is rebuilt — a stored
counter would have to be rebuilt in lockstep with `kills` and would drift the first time it
was not.

The post fires when `streak % KILLSTREAK_EVERY === 0`. `KILLSTREAK_EVERY` defaults to 3.

## The post

```
Steve [WOLF]                                    (flag thumbnail)
🔥 6 kill streak
last 6: Dave, Rob, Amy, Jen, Kai, Mo
started 41 minutes ago
```

Victim names are the streak's kills in order, oldest first, capped at 10 with `… and 4
more` past that — the same cap constant the hit detail lines use. "Started" is the elapsed
time from the streak's first kill to this one, rendered from the kill times, never from the
clock at post time.

No tier names. The number carries it.

---

# Part 3 — Long-range kills

Any PvP kill whose `kills.distance_m` is at least `LONG_RANGE_MIN_M` (default 100).

⚠️ A kill with a **null** distance is skipped, never treated as zero. The log omits the
`from … meters` tail for some weapons and every melee kill; a null means "the log did not
say", and silently reading it as 0 m would be a lie in the one direction this feed cares
about.

Friendly fire is included here — a 400 m shot is remarkable regardless of who it hit — and
is said in the title and coloured amber, as everywhere else.

## The post

```
Steve [WOLF]                                    (flag thumbnail)
🎯 340 m
killed Dave [BEAR] · Mosin
Steve's longest yet · 2nd longest this season
```

The two record lines come from queries over `kills` **up to and including this kill**, so
the line reads the same however late the post lands — the same rule the kill feed's tally
follows:

- *"longest yet"* — no earlier kill by this killer has a greater distance.
- *"Nth longest this season"* — one plus the count of kills in this kill's season window
  with a greater distance. Omitted past 10th; "17th longest this season" is not a
  highlight. A kill before any season counts all-time and says so, exactly as the kill
  feed's tally does.

Either line is omitted when it does not apply; both omitted leaves the distance and the
kill line alone.

---

# Part 4 — The shared poster

Four feeds now share one loop: seed at head, read after cursor, post, advance, stop at the
first failure. `killFeedTick` already implements it and is deployed.

Extract the loop into `apps/bot/src/cursor-feed.ts` as one generic `cursorFeedTick`. Each
feed then supplies only a **store** (seeded / head / cursor / readAfter / markPosted) and a
**render** function to an embed. `kill-feed-tick.ts` keeps `PgKillFeedStore` and loses its
loop.

⚠️ This refactors working, deployed code. It is justified because the alternative is three
near-identical copies of an at-least-once cursor loop, and the next bug found in it would
have to be fixed in four places — the exact failure the `notice-tick` / `war-log-tick` /
`kill-feed-tick` family already flirts with. The constraint that makes it safe: **the
existing `kill-feed-tick.test.ts` must pass unchanged**, with no edits to its assertions.
If the extraction requires changing what those tests expect, the extraction is wrong.

`KillFeedTickResult` — `{ posted, blockedAt, seeded }` — becomes the shared result type and
keeps its name and shape, so `discord.ts`'s existing logging keeps working.

---

# Configuration

Every channel id is optional and the feed is **off** when unset — matching
`KILL_FEED_CHANNEL_ID` and `BOT_FEED_CHANNEL_ID`, and validated at config load rather than
at first post, so a malformed id fails loudly instead of looking like an off feed.

| Env | Default | Meaning |
|---|---|---|
| `HIT_FEED_CHANNEL_ID` | unset — off | `1548401025038426334` |
| `KILLSTREAK_FEED_CHANNEL_ID` | unset — off | `1548459035936821358` |
| `LONG_RANGE_FEED_CHANNEL_ID` | unset — off | `1548459101116178513` |
| `HIT_BURST_WINDOW_S` | `60` | Quiet gap that closes an engagement |
| `KILLSTREAK_EVERY` | `3` | Post on every Nth kill of a streak |
| `LONG_RANGE_MIN_M` | `100` | Minimum distance for #long-range |

Consumer cursor names, each ⚠️ distinct from every other — two consumers sharing a cursor
skip each other's events: `hit-feed-poster`, `killstreak-feed-poster`,
`long-range-feed-poster`.

All three seed at head on their first run and post nothing historical, for the reason
`kill-feed-tick.ts` documents: `kills` and `events` hold the server's whole history, and a
poster that replays it announces last month to a public channel.

---

## Files

One migration, `0034`, and it is index-only: `events` already carries every hit payload,
`kills` already carries distance and friendly fire, and the cursors live in the existing
`consumer_cursors` table. `0034` adds `events_hit_id_idx` (partial, `id` where
`type = 'player.hit'`) and `events_occurred_idx` (plain, on `occurred_at`), both needed by
the hit feed's `readAfter`/`frontier` queries — see `hit-feed-tick.ts`.

| File | Change |
|---|---|
| `apps/bot/src/cursor-feed.ts` | **new** — the shared loop (Part 4). `cursorFeedTick`, `CursorFeedStore<T>`, `CursorFeedResult`. |
| `packages/domain/src/hit-bursts.ts` | **new** — pure. Hits + frontier + window → engagements, each flagged open or closed. No I/O, no clock, no database. |
| `apps/bot/src/hit-feed-embed.ts` | **new** — pure. One engagement → one `APIEmbed`. |
| `apps/bot/src/hit-feed-tick.ts` | **new** — `HIT_FEED_CONSUMER`, `PgHitFeedStore`. |
| `apps/bot/src/killstreak-feed-embed.ts` | **new** — pure. One streak milestone → one `APIEmbed`. |
| `apps/bot/src/killstreak-feed-tick.ts` | **new** — `KILLSTREAK_FEED_CONSUMER`, `PgKillstreakFeedStore`, the streak count and its reset rule. |
| `apps/bot/src/long-range-feed-embed.ts` | **new** — pure. One long-range kill → one `APIEmbed`. |
| `apps/bot/src/long-range-feed-tick.ts` | **new** — `LONG_RANGE_FEED_CONSUMER`, `PgLongRangeFeedStore`, the two record queries. |
| `apps/bot/src/kill-feed-tick.ts` | `PgKillFeedStore.readAfter` also loads the killer's hits on the victim in the `RECENT_HIT_WINDOW_S` before the kill; the loop moves to `cursor-feed.ts`. |
| `apps/bot/src/kill-feed-embed.ts` | `KillFeedItem` gains `hits`; the embed renders the detail lines. The 10-line cap constant lives here and is shared. |
| `apps/bot/src/config.ts` | The six new env vars in the Configuration table below. |
| `apps/bot/src/discord.ts` | Three posters + three ticks, wired after `killFeedTick`, each with the same per-event error dedupe and permission hint. |
| `.env`, `.env.production` | The three channel ids. |
| `docs/deploy/2026-09-12-combat-feeds.md` | **new** — runbook and env table. |

Grouping lives in `@factions/domain` rather than in the bot because it is a rule, not a
mechanism: it is the piece most worth testing exhaustively, and it must be testable without
a database, a Discord client or a clock. The streak rule stays in its tick instead, because
it is a query over `kills` rather than a computation over values in hand.

---

## Testing

Pure modules carry the weight, because they hold the rules. Every embed module and
`hit-bursts` is pure — no database, no client, no clock.

**`packages/domain/test/hit-bursts.test.ts`** — grouping by the three-part key; a weapon
switch splits; a null weapon is its own key; PvE and self-hits dropped; the quiet window;
the frontier guard (a burst does not close when ingest is behind); the open/closed flag at
a batch boundary.

**`apps/bot/test/cursor-feed.test.ts`** — the shared loop: seeding at head posts nothing,
post-then-advance, first failure ends the run and leaves the cursor on the last success,
batch size honoured.

⚠️ **`apps/bot/test/kill-feed-tick.test.ts` must pass with its assertions unchanged** after
the loop is extracted. It is the regression gate on the refactor; if it needs editing, the
extraction is wrong.

**`apps/bot/test/hit-feed-store.test.ts`** — the suppression query, including the
weapon-switch case the suppression key exists for, and the kills-cursor guard.

**`apps/bot/test/hit-feed-embed.test.ts`** — line rendering, missing fields, the 10-line
cap, friendly fire, markdown escaping.

**`apps/bot/test/killstreak-feed-store.test.ts`** — the streak count and its reset rule: a
player death resets, a zombie death does not, friendly fire neither advances nor breaks,
a streak spanning a season boundary keeps counting, a player never killed counts all their
kills, and only every Nth kill is returned.

**`apps/bot/test/killstreak-feed-embed.test.ts`** — the victim list and its cap, the
elapsed-time line, markdown escaping.

**`apps/bot/test/long-range-feed-store.test.ts`** — the threshold is inclusive, a null
distance is skipped rather than read as zero, "longest yet" and the season rank including
the past-10th omission and the no-season all-time case.

**`apps/bot/test/long-range-feed-embed.test.ts`** — both record lines, each omitted
independently, friendly fire.

**`apps/bot/test/kill-feed-embed.test.ts`** — extended: detail lines present, and a kill
with no hits rendering exactly as before.

The gate is unchanged and always with `--force`:

    TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
      npx turbo run typecheck test --concurrency=1 --force

Expect **26/26 tasks** still — no new package, so the count does not move. A cached pass
proves nothing here either; check that the suites named above actually ran.

---

## Deliberately not built

- **No `engagements` table.** The grouping is derivable from `events` on every pass, and a
  projected table would need its own rebuild script, its own cursor and its own wipe path
  to earn nothing the cursor does not already give.
- **No message editing.** Considered and rejected: posting the first hit immediately and
  editing as the burst grows makes the feed live, but it requires storing a Discord message
  id per engagement, handling edit failures, and coping with a deleted message breaking the
  group. Waiting for the burst to close is one write per engagement and no stored state.
- **No PvE hits.** Zombie bites and fall damage would be thousands of posts a day and would
  bury the fights this channel exists to show.
- **No coordinates, ever.** Hit payloads carry none, and none are derived. Same invariant as
  `faction_events`, `war_log_events` and `clan_notices`.
- **No stored streak counter.** Derived from `kills` at post time; see Part 2.
- **No exclusive routing.** Considered and rejected: sending each kill to only its most
  interesting channel would put holes in #kill-feed's running tallies and make every
  channel an incomplete record.
- **No killstreak tier names.** The number is the fact; "Godlike" is decoration that would
  need a table and a bikeshed.
