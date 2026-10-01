# Website live feeds

**Date:** 2026-09-30
**Status:** design approved in chat, awaiting spec review

## Goal

Every feed the bot posts to Discord is also readable on the website, so a player
who is not in Discord can follow the server from the site. The nine feeds:
players online, hits, kills, killstreaks, long range kills, clan feed, war log,
achievements, bans.

Each reads like its Discord channel: newest first, older entries a click away,
and new entries appearing while the page is open.

## Decisions

| Question | Decision |
|---|---|
| Layout | One public Live page, one tab per feed, plus an "Online now" panel on the home page |
| Source for hits, kills, killstreaks, long range | Persist each entry at record time in a new `feed_entries` table, plus a backfill |
| Recorder vs poster | Separate recorder ticks with their own cursors; the Discord posters are not changed to read the new table |
| Hit history | Starts at deploy (no backfill) |
| Wording | Sentence logic moves into `packages/copy`, shared by bot and web |
| Discord wording | Unchanged. The brand guide (`brand/02-verbal-identity.md`) keeps em dashes and the middot, so the shared copy reproduces today's Discord text exactly |

## Privacy

The site applies exactly the rules Discord applies, no more and no less:

- No coordinates anywhere. `feed_entries.payload` carries a CHECK that rejects
  position keys, matching `faction_events`, `war_log_events`, `ban_announcements`.
- Hits: PvP only, Hub hits dropped, engagements a kill already covers dropped,
  engagement closes only after the existing window (`hit-bursts.ts`).
- Kills: friendly fire and Hub kills shown and labelled.
- Killstreaks and long range: friendly fire and Hub excluded.
- Clan feed: base moves never say where; flag raises and lowers are not published.
- Bans: the gamertag frozen at ban time, never `dayzId`, no profile link.
- Achievements: only the public channel notices (`clan_notices` with
  `kind = 'achievement'`, `target = 'channel'`, `faction_id IS NULL`,
  `payload->>'public' = 'true'`), which is exactly what Discord posted.
  The roster read nulls `payload.ownerName` when it is all digits (a Discord id)
  so the web can never render one.
- Players online: everyone with an open session, as on Discord.

## Section 1: Data

### `feed_entries` (new migration)

| Column | Type | Notes |
|---|---|---|
| `id` | bigserial PK | Paging key for the website |
| `kind` | text | `kill` \| `hit` \| `killstreak` \| `long_range` (CHECK) |
| `source_event_id` | bigint | The kill event id, or the last hit event id of an engagement |
| `occurred_at` | timestamptz | Log time of the entry |
| `payload` | jsonb | Frozen facts, plain data, no Discord markdown |
| `created_at` | timestamptz | default now() |

- `UNIQUE (kind, source_event_id)`; inserts use `ON CONFLICT DO NOTHING`, so a
  crash between the insert and the cursor write cannot double-write.
- Index `(kind, id DESC)` for the tab reads.
- CHECK that no `payload` key at any depth the recorders write is a position
  (`pos`, `victimPos`, `attackerPos`, `killerPos`, `x`, `y`, `z`), modelled on the
  existing constraints in `packages/db/src/schema.ts`.

### Payloads

Each payload holds the same facts its Discord embed is built from today.
Each side is stored as `{ gamertag, clanTag | null, flagTexture | null }`: the
clan is the one at the time of the kill (`membershipAt`, as the posters do), the
gamertag is the player's name when the entry is recorded (the posters read the
current `players.gamertag` too). Frozen in the row from then on.

The season tally, personal best, season rank and streak run are all counted up
to and including the kill in the existing store queries
(`kill-feed-tick.ts` `tally`, `long-range-feed-tick.ts` `records`,
`killstreak-feed-tick.ts` `runUpTo`), so a replayed entry carries the same
numbers Discord showed. For backfilled entries the clan is correct as of the
kill; only a renamed player's gamertag can differ from the original post.

- **kill:** killer, victim, weapon, distance m, `finished` flag, `friendlyFire`,
  `atHub`, season id and name, killer season kills, victim season deaths, hit
  run (up to 10 lines of damage, body part, distance).
- **hit:** attacker, victim, `friendlyFire`, weapon, hit count, total damage,
  victim HP after, up to 10 hit lines, last hit time.
- **killstreak:** killer, streak length, last N victims, streak start time.
- **long_range:** killer, victim, weapon, distance m, `personalBest` flag,
  season rank (only when top 10).

The payload type for each kind lives in `@factions/domain` so the recorder, the
roster read and the web renderer agree on it.

### Recorder ticks (apps/bot)

One recorder per kind: `kill-feed-recorder`, `hit-feed-recorder`,
`killstreak-feed-recorder`, `long-range-feed-recorder` cursors in
`consumer_cursors`.

- Each reuses its poster's store (`readAfter`) and the facts its render path
  already computes, then inserts a `feed_entries` row instead of posting.
- Runs every tick whether or not the matching Discord channel is configured.
- Runs right after its poster, in the poster order (kills, hits, killstreaks,
  long range), because hits depend on the kills projector cursor.
- **Does not seed at the head.** First run replays history, which is the
  backfill for kills, killstreaks and long range (see Payloads for why the
  replayed numbers match).
- **Hits are the exception:** the hit recorder seeds at the head on first run,
  so hit history starts at deploy.
- Batched (existing `DEFAULT_FEED_BATCH_SIZE`), so the first-run replay spreads
  across ticks instead of one long transaction.
- Errors are logged once per entry like the posters; a failure stops that
  recorder's run so entries stay in order.

The existing Discord posters, their cursors and their first-run seeding are not
changed.

### The other five feeds

No new storage. New read exports in `@factions/roster`:

| Feed | Read |
|---|---|
| Online | Open `player_sessions` joined to players, open membership span, factions (the same shape as `online-tick.ts`) |
| Clan feed | `faction_events` |
| War log | `war_log_events`, all four kinds (raid, defense, week closed, season closed) |
| Achievements | Public achievement channel notices in `clan_notices` (see Privacy) |
| Bans | `ban_announcements` |
| Combat feeds | `feed_entries` by kind |

Every paged read takes `{ before?: id, after?: id, limit }` and returns newest
first. Updates `packages/roster/test/exports.test.ts` and
`apps/web/test/smoke.test.ts`. No web identifier contains "faction".

### Shared wording (packages/copy)

The sentence logic of `kill-feed-embed.ts`, `hit-feed-embed.ts`,
`killstreak-feed-embed.ts`, `long-range-feed-embed.ts`, `feed-embed.ts`
(including `flagLabel`), `war-log-text.ts`, `ban-announce-text.ts` and
`achievement-embed.ts` moves into pure functions in `packages/copy` that return
plain parts (title, lines, link targets). The bot wraps them in markdown and
APIEmbeds; the web wraps them in JSX. `packages/copy` still imports no runtime
value from `@factions/roster`.

The move is wording-neutral: every existing bot embed and text test passes
unchanged, which is the proof that Discord says exactly what it said before.

## Section 2: Website

### Routes

- `/live/[feed]`, `feed` in `online`, `kills`, `hits`, `streaks`, `long-range`,
  `clans`, `war-log`, `achievements`, `bans`. Unknown feed is a 404.
- `/live` redirects to `/live/kills`.
- Tabs via `SegNav`, horizontally scrollable on phones.
- `/live` and the `/live/` prefix are public in `lib/auth/gate.ts`;
  `auth-gate.test.ts` updated.
- Nav: the desktop bar has no room for another cell (`lib/menu.ts`), so "Live"
  replaces "War log" there and also lights up on `/war-log`. The phone drawer
  adds "Live" and keeps "War log".
- `/war-log` stays and links to `/live/war-log`.
- `force-dynamic`, pinned by `request-time-rendering.test.ts`.

### Loading and paging

- The server renders the first 50 entries.
- "Older" loads the next 50 with `?before=<last id>`.
- Online is a single unpaged list.

### Live updates

- A client component polls `GET /api/live/[feed]?after=<newest id>` every 15 s
  through `lib/visible-poll.ts` (paused while the tab is hidden), `NO_STORE`,
  and prepends new entries.
- Online re-fetches the whole list every 15 s.
- The API routes are public, matching the page.

### Entries

- One small renderer per tab, using the shared copy functions, `flagThumbPath`,
  `achievement-badge`, and the `feed-copy` friendly fire and Hub marks.
- Gamertags link to `/players/[gamertag]`, clan tags to `/clans/[tag]`.
  Ban entries show the frozen gamertag with no link.
- Stamps use `when()` (UTC, the site convention pinned by `utc-times.test.ts`)
  rather than relative times, which go stale in a server render.
- Styling only with the existing `globals.css` tokens and `ui.tsx` primitives
  (`theme-tokens.test.ts`, `raw-hex.test.ts`).

### Home page

An "Online now · N" panel with up to 10 names, linking to `/live/online`.

## Testing

- Recorders against the test database: first-run replay, idempotent re-run,
  hit recorder seeding at the head, ordering after a failure, coordinate CHECK
  rejecting a position key.
- Each new roster read: paging with `before` and `after`, newest first,
  achievements limited to public channel notices, a digits-only `ownerName` nulled.
- Copy functions: unit tests pinning the wording. Existing bot embed and text
  tests stay green with no edits.
- Web: route and gate tests, smoke test for the new exports.
- Full gate: `npx turbo run typecheck test --concurrency=1 --force`, expect 32/32.

## Out of scope

- Making the Discord posters read from `feed_entries`.
- A hit history backfill.
- SSE or websockets.
- Per-player opt-outs (none exist on Discord either).
- Changing what any Discord feed publishes.
