# Discord message consistency — design

**Date:** 2026-09-21
**Audit:** `docs/superpowers/specs/2026-09-21-discord-message-audit.md` (per-message table)

Four changes to every message the bot sends:

1. Time references become Discord `<t:…>` tokens, so they stay correct without a repost.
2. Clan names and gamertags link to the site.
3. The raid window and weekly vehicle wipe notices move to `#server-events`.
4. Voice is brought in line with `brand/02-verbal-identity.md`.

Shipped as two increments. Increment 1 changes what messages *say*; increment 2 changes
what some of them *are*. Increment 1 stands alone and is worth shipping without 2.

---

## §1. Decisions taken

| | Decision |
|---|---|
| Scope | Everything the bot says, slash-command replies included |
| Em dashes | Stay. `brand/02-verbal-identity.md` is the authority; the contradicting copy-voice note was amended |
| Link form | `[text](<url>)` — angle brackets suppress the OpenGraph unfurl. Verified live |
| Timestamps | Tokens everywhere. "UTC" leaves player-facing copy, with two exceptions (§4.3) |
| Channel | Raid window **and** vehicle wipe move to `SERVER_EVENTS_CHANNEL_ID` |
| Embeds | Feed-shaped surfaces only, increment 2. Clan notices and DMs keep their shape |
| Emoji | Out of anything that becomes an embed; kept on plain-text notices |
| Hardcoded durations | Fixed in this pass |

### §1.1 Why `[text](<url>)` and not `flags: 4`

Both suppress the preview card; both were tested live in `#server-events`.
`SUPPRESS_EMBEDS` suppresses **every** embed on a message, including ones we send, so it
is incompatible with increment 2. The angle-bracket form composes with embeds and is
per-link.

---

## §2. New and moved modules

### §2.1 `packages/copy/src/discord-time.ts` (new)

```ts
export function at(d: Date): string | null     // <t:…:F>
export function rel(d: Date): string | null    // <t:…:R>
export function atRel(d: Date): string | null  // <t:…:F> (<t:…:R>)
```

All three carry the `Number.isFinite` guard that today exists only in `feed-embed.ts`,
whose comment explains the stake: a malformed payload posts a literal `<t:NaN:R>` into a
public channel permanently, because nothing reposts. **Returning `null` rather than
throwing or emitting a fallback string is the point** — each caller already has a degrade
it chose deliberately (`feed-embed.ts` drops to a sentence with no deadline clause), and a
shared helper must not overrule it.

Replaces the six hand-rolled copies in `raid-window-text.ts`, `airdrop-text.ts`,
`online-embed.ts`, `ceremony-notify.ts`, `dormancy-notify.ts` and `feed-embed.ts`.

**Lives in `@factions/copy`, not the bot**, because `apps/web` will eventually want to
render the same instants and because the A2 split (§2.3) has one foot in each surface.
Nothing in the shared *tables* may emit a token — see §2.3.

### §2.2 `apps/bot/src/site-links.ts` (new; moves code out of `kill-feed-embed.ts`)

```ts
export function profileUrl(siteBaseUrl: string, gamertag: string): string  // bare
export function clanUrl(siteBaseUrl: string, tag: string): string          // bare, NEW
export function playerLink(siteBaseUrl: string, gamertag: string): string  // [name](<url>)
export function clanLink(siteBaseUrl: string, tag: string, name?: string): string
//   name given → `**[Name](<url>)** [TAG]`  (war log, feeds, /me)
//   name omitted → `[TAG](<url>)`          (the bare tag beside a linked gamertag)
export function who(side: KillFeedSide, siteBaseUrl: string): string       // moved
```

⚠️ **The bare/rendered split is load-bearing.** `profileUrl` has two kinds of caller with
opposite needs: the feeds pass it to `embed.setURL()`, which requires a bare URL and
rejects `<https://…>`; inline text needs the angle brackets. Keeping the URL builders bare
and putting `<>` in the *renderers* means no call site can get it wrong, and the existing
`setURL()` callers need no change at all.

`clanUrl` is new. There is no clan-link helper today, which is why every `[TAG]` in the
bot is plain text even in feeds where the gamertag beside it is already a link.

`kill-feed-embed.ts` re-exports `profileUrl` and `who` so the five importing modules do
not all have to change in the same commit.

### §2.3 The `@factions/copy` shared-surface split

`@factions/copy` is read by `apps/web` **and** the bot. A `<t:…>` token in a shared table
renders as literal angle-bracket noise on the website.

Almost nothing is affected: nearly every time reference in the shared tables is a
**duration** (`days(ROSTER_COOLDOWN_MS)`, `hours(GUEST_PASS_MS)`), which brand principle 2
requires to stay a literal interpolated number. Exactly two shared strings interpolate an
instant:

| Location | Today | After |
|---|---|---|
| `copy/src/base.ts` → `lapsedCopy(at)` | `when(at)` | takes a pre-formatted string |
| `copy/src/link.ts` → `at()` for `held-by-other` | private `toLocaleTimeString` | takes a pre-formatted string |

The bot passes `rel(d)`, the site passes `when(d)`. Two call sites; no new mechanism, and
in particular **not** an extension of `DISCORD_OVERRIDES`, which is keyed on outcome names
and has no hook for a value interpolated at call time.

---

## §3. Increment 1 — time, links, channel, voice

### §3.1 Timestamps

Per-message styles are in Part B of the audit. The rules they follow:

- A **deadline a player acts on** gets `atRel()` — the date to plan around, the countdown
  to feel.
- A **countdown inside an open window** gets `rel()`.
- A **duration** (`24h`, `7 days`, `3h 15m` under siege) stays a literal number.
- **Ops-facing** output keeps ISO. Row 5's comment is right: whoever reads that alert at
  02:00 needs an unambiguous machine timestamp.

**Two deletions this enables, which are the real prize:**

`announce-text.ts` loses `whenPhrase()`, `utcDayStart()` and its `HOUR_MS` arithmetic.
Those exist to compute "tomorrow" vs "today, in about N hours", and the function's own
comment documents the bug they carry: the posting window includes Monday 00:00–07:00 UTC,
so a bot recovering late says "tomorrow" a couple of hours before the wipe. `atRel()`
cannot have that bug.

`notice-text.ts` loses `relativeAge()`, and with it the `now` parameter threaded through
`noticeText(n, now)` and `noticeMessage(row, now, siteBaseUrl)` in `notice-tick.ts`.

### §3.2 Links

- Every gamertag → `playerLink()`, except `#bans` (§3.5).
- Every clan name and `[TAG]` → `clanLink()`.
- Every bare URL in a notice (`p.link`, `/seasons`, `/claim/<id>`) → masked.
- Feed embeds that title a clan gain `setURL(clanUrl(...))`.

### §3.3 Channel move

`serverEventsPoster` already exists in `discord.ts:605` as a single shared instance, so
the three features simply use it — there is no new poster and no ordering hazard between
them beyond what the tick already has.

1. `config.ts` — `announcementsChannelId` is removed. The fatal gates for
   `RAID_WINDOW_TICK` and `WEEKLY_VEHICLE_WIPE` re-point at `SERVER_EVENTS_CHANNEL_ID`.
2. ⚠️ The gate becomes **"any of raid window, vehicle wipe or airdrops enabled requires
   `SERVER_EVENTS_CHANNEL_ID`"**, not three independent checks. `AIRDROP_TICK`'s current
   error says the announcement is *"the only way a drop is ever found"* — true of airdrops
   and false of the other two, so each gate names its own feature.
3. `discord.ts` — `announcePoster` is deleted; `raidWindowTick` and `announceTick` take
   `serverEventsPoster`. The comments at 1573/1584 asserting non-nullness from the
   `ANNOUNCEMENTS_CHANNEL_ID` gate are rewritten.
4. `discord.ts:1653` — the `"wipes happen without notice"` warning goes. It is about the
   *vehicle* wipe, not a season wipe; no season-wipe notice exists on that channel.
5. ⚠️ **`ANNOUNCEMENTS_CHANNEL_ID` stays in `/opt/clan-wars/.env`.** It is what the manual
   announcement workflow from the prod host reads. Removing it from `config.ts` must not
   become removing it from the deployed env file.
6. `ctxNow` gates `serverEvents` on `cfg.airdrop.enabled` for the `/airdrop place`
   command. That stays as it is — it is the command's gate, not the channel's.

### §3.4 Voice

- Restate `brand/02-verbal-identity.md`'s **Dates are UTC** mechanic (§4.3).
- Fix the five notices that hardcode `24 hours` / `7 days` instead of interpolating from
  `@factions/domain` (`dormant_raided`, `dormant_inactive`, `flag_down`,
  `rebind_proposed`, `zone_warning`). A genuine principle-2 violation: the words and the
  rules must not be able to disagree.
- Everything else already holds: no exclamation marks, no "faction" in player-facing copy,
  no coordinates, sentence case, bold for actors.

### §3.5 What deliberately does not change

- **`#bans` gamertags stay unlinked.** The tag is frozen player-controlled text, may not
  resolve to a page, and `ban-announce-text.ts` carries two warnings about not adding a
  second escaper or trusting that input. Linking it means interpolating hostile text into
  a URL in a public channel for no real gain.
- **Row 5's ops alert keeps ISO.**
- **`/link`'s `formatRemaining`** stays: it is a live countdown inside a card that is
  re-rendered on interaction, which is a different thing from a static instant.
- **`/alphas`' `when(weekStart)`** stays *if* §4.1 confirms a token cannot render in an
  embed field name. If it can, row 47 is reconsidered. This is the one item in this
  section that is conditional rather than decided.

---

## §4. Risks and unknowns

### §4.1 ⚠️ UNVERIFIED: `<t:…>` in embed field names

Rows 47 and 58 assume Discord renders a token in a field **value** but not in a field
**name**. Field values are near-certain; field names are the doubt.

**Verify by test before touching rows 47 and 58**, the same way the masked-link question
was settled, since guessing wrong puts a literal `<t:1234:F>` on the `/alphas` card. If
field names do not render, `/alphas` keeps `when()` and only `/found` (row 58, a field
value) changes.

### §4.2 `noticeText`'s signature change

Dropping `relativeAge` removes `now` from `noticeText` and `noticeMessage`. Touches
`notice-tick.ts` and every notice test. Mechanical, but it is the widest blast radius in
increment 1, so it gets its own step rather than riding along with a copy change.

### §4.3 The brand guide has to be amended, not contradicted

`brand/02-verbal-identity.md` currently says: *"Dates are UTC, formatted `9 Sep`
(`en-GB`, day + short month). The server's timezone must not change what a player
reads."* Discord's tokens do the opposite deliberately. The mechanic is rewritten to:

> **Dates.** In Discord, an instant is a `<t:…>` token, so every reader sees it in their
> own timezone; a duration is a literal number interpolated from `@factions/domain`. On
> the website, and in the two Discord surfaces where a token cannot render (an ops alert,
> an embed field name), dates are UTC, formatted `9 Sep` (`en-GB`, day + short month).

The emoji mechanic also gains the explicit embed/plain-text split it is currently read as
implying.

### §4.4 Deploy ordering

The config gates are fatal on unset. `SERVER_EVENTS_CHANNEL_ID` is already set in prod, so
the ordering hazard is mild — but `docs/deploy/raid-window.md`,
`docs/deploy/2026-09-17-raid-window.md` and
`docs/deploy/2026-09-12-weekly-vehicle-rotation.md` all name the old channel and are
wrong the moment this ships. They are part of the change, not follow-up.

### §4.5 Repo hazard

Per `CLAUDE.md`: two concurrent `turbo run test` / `vitest` invocations share
`factions_test_<package>` and produce failures that look exactly like real regressions.
The gate runs once, alone.

---

## §5. Increment 2 — embeds for the feed-shaped surfaces

`#war-log`, raid window, vehicle wipe, airdrops and `#bans` become embeds. Colour signals
kind, so the emoji come out of those and out of `commands/embeds/scoring.ts`.

Colours follow the existing house palette (`feed-embed.ts`'s `GREEN`/`BLUE`/`AMBER`/`RED`,
`commands/embeds/*`'s `GOLD`) rather than a new one.

### §5.1 ⚠️ Why clan notices and DMs are excluded

`notice-text.ts`'s `person()` renders an unrecognised gamertag as `<@id>` — a real ping.
`achievement-embed.ts` already documents the constraint: *"a mention inside an embed does
not ping; `achievementMention` carries it in the content instead."* Converting the 40
notice renderers to embeds without that pattern would silently stop pinging exactly the
members the system could not name.

It is solvable, with the achievement pattern and a `notice-tick.ts` refactor. It is not
solvable as a copy change, so it is not in this spec. If wanted, it is increment 3.

### §5.2 `announce-text.ts`'s "no embed" comment

It reads: *"Plain content, no embed — it is one short sentence of fact, and the other
plain-text poster (#war-log) is the house precedent for that."* Increment 2 moves the
precedent: `#war-log` becomes an embed, so the reason no longer holds. **Update that
comment rather than leaving it asserting a precedent that has been reversed.**

---

## §6. Testing

Every text module already has a pure vitest suite — `announce-text.test.ts`,
`notice-text.test.ts`, `war-log-text.test.ts`, `ban-announce-text.test.ts`,
`release-text.test.ts`, `overrides.test.ts`. TDD applies throughout.

New coverage:

| Target | Test |
|---|---|
| `discord-time.ts` | `:F`/`:R`/`:F (:R)` shapes; `null` on an invalid date; epoch is floored seconds |
| `site-links.ts` | `profileUrl`/`clanUrl` bare; `playerLink`/`clanLink` wrapped in `<>`; gamertag URL-encoded; markdown-escaped in the label |
| Shared-copy boundary | **No string reachable from `@factions/copy`'s tables contains `<t:`.** A regression test for §2.3, in the same spirit as `overrides.test.ts` |
| `config.ts` | Each feature flag fatal without `SERVER_EVENTS_CHANNEL_ID`; `ANNOUNCEMENTS_CHANNEL_ID` no longer read |
| `announce-text.ts` | The "tomorrow" cases the deleted `whenPhrase` covered now render a token |
| Notice renderers | Durations interpolated from `@factions/domain`, not literals |

`notice-text.test.ts`'s exhaustiveness check pins the renderer table to exactly
`CLAN_NOTICE_KINDS`, so a missed renderer fails the build rather than rendering nothing.
That check stays as it is.

---

## §7. Order of work

1. Verify §4.1 (token in an embed field name) — it is cheap and it decides rows 47/58.
2. `discord-time.ts` + tests.
3. `site-links.ts` + tests, `kill-feed-embed.ts` re-exports.
4. The `@factions/copy` split (§2.3) + the no-`<t:` regression test.
5. `noticeText` signature change (§4.2), alone.
6. Apply Part B rows: broadcast → war-log → bans → feeds → notices → commands.
7. The hardcoded-duration fix (§3.4).
8. Channel move (§3.3) + deploy docs + a deploy note.
9. Brand guide amendment (§4.3).
10. **Ship increment 1.**
11. Increment 2: embeds, emoji removal, the §5.2 comment.
