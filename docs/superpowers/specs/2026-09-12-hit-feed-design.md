# Hit feed — design

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
`max(events.occurred_at)` for the server — not the wall clock. An engagement is quiet when
`frontier - lastHit.occurredAt >= HIT_BURST_WINDOW_S`. With ingest caught up, the frontier
tracks real time and behaviour is unchanged; with ingest behind, nothing closes early.

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

Identical to `kill-feed-tick.ts`, for the same reasons documented there:

- Cursor consumer named **`hit-feed-poster`** in `consumer_cursors`. ⚠️ Distinct from every
  other consumer name — two consumers sharing a cursor skip each other's events.
- **The first run seeds the cursor at the head and posts nothing.** `events` holds the
  server's whole history of hits; a poster that replays it announces last month to a public
  channel.
- Post, then advance. The first failure ends the run, so the channel stays chronological.
- At-least-once: a crash between the post and the cursor write re-posts that engagement on
  the next start. Same trade as the kill feed and `notice-tick`.

**Cursor advance.** Within a batch, let `barrier` be the smallest event id belonging to a
still-open engagement. Engagements whose last event id is below `barrier` are posted, in
order of their first event id; the cursor then advances to `barrier - 1`. With no open
engagement it advances to the batch's highest event id. A fight in progress holds the line
rather than being stepped over — which is what makes an engagement straddling a batch
boundary arrive whole.

Suppressed engagements advance the cursor exactly as posted ones do. They are decided, not
pending.

## Files

No migration. `events` already carries the payload, and the cursor lives in the existing
`consumer_cursors` table.

| File | Change |
|---|---|
| `packages/domain/src/hit-bursts.ts` | **new** — pure. Hits + frontier + window → engagements, each flagged open or closed. No I/O, no clock, no database. |
| `apps/bot/src/hit-feed-embed.ts` | **new** — pure. One engagement → one `APIEmbed`. |
| `apps/bot/src/hit-feed-tick.ts` | **new** — `HIT_FEED_CONSUMER`, `HitFeedStore` / `PgHitFeedStore`, `hitFeedTick`. |
| `apps/bot/src/kill-feed-tick.ts` | `PgKillFeedStore.readAfter` also loads the killer's hits on the victim in the `RECENT_HIT_WINDOW_S` before the kill. |
| `apps/bot/src/kill-feed-embed.ts` | `KillFeedItem` gains `hits`; the embed renders the detail lines. |
| `apps/bot/src/config.ts` | `hitFeedChannelId` from `HIT_FEED_CHANNEL_ID` (optional snowflake), `hitBurstWindowS` from `HIT_BURST_WINDOW_S` (positive int, default 60). |
| `apps/bot/src/discord.ts` | poster + tick, wired after `killFeedTick`, with the same per-event error dedupe and permission hint. |
| `.env`, `.env.production` | `HIT_FEED_CHANNEL_ID=1548401025038426334` |
| `docs/deploy/2026-09-12-hit-feed.md` | **new** — runbook and env table. |

`HIT_FEED_CHANNEL_ID` unset means the feed is **off** and nothing posts — matching
`KILL_FEED_CHANNEL_ID` and `BOT_FEED_CHANNEL_ID`, and validated at config load rather than
at first post, so a malformed id fails loudly instead of looking like an off feed.

Grouping lives in `@factions/domain` rather than in the bot because it is a rule, not a
mechanism: it is the piece most worth testing exhaustively, and it must be testable without
a database, a Discord client or a clock.

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
legal. The cap is a constant in the embed module, shared by both feeds.

Gamertags pass through `escapeMarkdown` on every path. A name is text, never markup.

## Testing

Pure modules get the weight, because they hold the rules:

- `packages/domain/test/hit-bursts.test.ts` — grouping by the three-part key; weapon switch
  splits; null weapon is its own key; PvE and self-hits dropped; the quiet window; the
  frontier guard (a burst does not close when ingest is behind); the open/closed flag at a
  batch boundary.
- `apps/bot/test/hit-feed-embed.test.ts` — line rendering, missing fields, the 10-line cap,
  friendly fire, markdown escaping.
- `apps/bot/test/hit-feed-store.test.ts` — the suppression query, including the
  weapon-switch case the suppression key exists for, and the kills-cursor guard.
- `apps/bot/test/hit-feed-tick.test.ts` — seeding at head, post-then-advance, the barrier
  advance with an open engagement in the batch, first-failure-ends-the-run.
- `apps/bot/test/kill-feed-embed.test.ts` — extended: detail lines present, and a kill with
  no hits rendering as before.

The gate is unchanged and always with `--force`:

    TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
      npx turbo run typecheck test --concurrency=1 --force

Expect **26/26 tasks** still — no new package, so the count does not move. A cached pass
proves nothing here either; check that the suites named above actually ran.

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
