# Discord message audit — 2026-09-21

Every message the bot sends, audited on four axes:

1. **Time** — does a time reference use Discord's `<t:…>` tokens so it stays live?
2. **Links** — does a clan name or gamertag link back to the site?
3. **Channel** — is it posted where it belongs?
4. **Voice** — does it match `brand/02-verbal-identity.md`?

**This file is the markup surface.** Mark up the `Proposal` cells, then the spec and the
implementation plan get written from what survives. Nothing is implemented yet.

Decisions already taken (2026-09-21):

- Scope is **everything the bot says**, slash-command replies included.
- **Em dashes stay.** The brand guide is the authority; the contradicting copy-voice note
  has been amended to say so.
- Raid window **and** the weekly vehicle wipe move to `SERVER_EVENTS_CHANNEL_ID`.
- Timestamp style is decided **per message**, in this file.
- Links use **`[text](<url>)`** — angle brackets inside the masked link, verified live.
- **Tokens everywhere**, no UTC clock in player-facing copy (D2).
- Embeds for the **feed-shaped surfaces only**, as increment 2 (D4).
- The hardcoded durations get **fixed in this pass** (D5).

---

## Part A — cross-cutting findings

### A1. Six hand-rolled `<t:…>` helpers, no shared one

`<t:…>` is already in use, but every file that wants one builds its own:

| File | Helper | Style |
|---|---|---|
| `apps/bot/src/raid-window-text.ts` | `stamp()` | `:F` |
| `apps/bot/src/airdrop-text.ts` | `countdown()` | `:R` |
| `apps/bot/src/online-embed.ts` | inline | `:R` |
| `apps/bot/src/ceremony-notify.ts` | inline | `:R` |
| `apps/bot/src/dormancy-notify.ts` | inline | `:R` |
| `apps/bot/src/feed-embed.ts` | inline, with a `Number.isFinite` guard | `:R` |

Only `feed-embed.ts` guards against `NaN`, and its comment explains exactly why that
matters: a malformed payload posts a literal `<t:NaN:R>` into a public channel, forever,
because nothing reposts. The other five would post the garbage.

**Proposal:** one `packages/copy/src/discord-time.ts` exporting `at(d)` → `<t:…:F>`,
`rel(d)` → `<t:…:R>`, and `atRel(d)` → `<t:…:F> (<t:…:R>)`, all three carrying
`feed-embed.ts`'s finite check and returning `null` on a bad input so each caller
degrades the way it already chooses to. Delete the six local copies.

### A2. `packages/copy` is shared with the website, so it cannot emit `<t:…>`

`@factions/copy` is read by `apps/web` **and** the bot. A `<t:…>` token in a shared table
renders as literal angle-bracket noise on the site. The existing `DISCORD_OVERRIDES`
mechanism covers wording only; it has no hook for a value interpolated at call time.

Good news: almost every time reference in the shared tables is a **duration**, not an
instant — `days(ROSTER_COOLDOWN_MS)`, `hours(GUEST_PASS_MS)`. Those are exactly what
brand principle 2 ("say the number") demands and they stay literal. Only two shared
strings interpolate an actual instant:

- `packages/copy/src/base.ts` → `lapsedCopy(at)` uses `when(at)`
- `packages/copy/src/link.ts` → private `at(d)` for `held-by-other`

**Proposal:** turn those two into functions taking a pre-formatted string, so the bot
passes `rel(d)` and the site passes `when(d)`. Two call sites, no new mechanism.

### A3. `profileUrl` exists; there is no clan equivalent

`profileUrl(siteBaseUrl, gamertag)` lives in `apps/bot/src/kill-feed-embed.ts` and is
imported by five other modules — an odd home for something that general. There is **no**
`clanUrl`, so every `[TAG]` in the bot is plain text even where the site has a page for it
at `/clans/[tag]`.

**Proposal:** new `apps/bot/src/site-links.ts` holding `profileUrl`, `clanUrl`, and the
two rendering helpers `who()` (already in kill-feed-embed) and a new `clanLink()`.
Re-export from the old path if that keeps the diff small.

### A4. Masked links in plain message content — needs verifying before we rely on it

The feeds and embeds already use `[name](url)` and it renders. But `#war-log`,
`#server-events`, the raid window notices, the airdrop notices and every clan-channel
notice are **plain `content` strings, not embeds**. Masked-link support in plain bot
content is a separate Discord behaviour from embed descriptions.

**RESOLVED 2026-09-21, tested live in `#server-events`.** Masked links render fine in
plain content. The problem is the side effect: Discord also unfurls the URL into an
OpenGraph preview card under the message, which would put a site card under every war-log
line.

Two suppressions were tested and both work:

| | Form | Verdict |
|---|---|---|
| **A** | `[text](<url>)` — angle brackets inside the link | **Chosen** |
| **B** | `flags: 4` (`SUPPRESS_EMBEDS`) on the message | Rejected |

B is rejected because `SUPPRESS_EMBEDS` suppresses **every** embed on a message,
including ones we send ourselves — it would blank the embeds that increment 2 adds.

⚠️ **The angle brackets belong inside the rendering helpers, not at the call sites.**
`profileUrl`/`clanUrl` return a bare URL (`leaderboard-embed.ts` and the feeds already use
them to build `setURL()` values, where angle brackets would be invalid); the *rendering*
helpers `who()` and `clanLink()` are what wrap in `<>`. Put it in one place and no call
site can forget it.

### A5. Emoji — the guide and the code disagree, and the code disagrees with itself

`brand/02-verbal-identity.md`: *"No emoji in site copy. Discord embeds use colour and
thumbnails, not emoji, to signal kind."*

The rule is scoped to **embeds**, and the embeds mostly obey it — except
`commands/embeds/scoring.ts`, where the war-log lines carry ⚔️ and 🛡️ inside an embed
that already has a colour. Meanwhile the plain-text surfaces are dense with them:
`notice-text.ts` alone uses 🚨 🛡️ 💤 ☀️ ⚠️ ⚑ 🏴 📦 ➕ ✅ ➖ 🥾 ⬆️ ⬇️ 👑 ✏️ 👁 🔧 🗳️ 🔐 🎟️ 🏆 ⛔.

**RESOLVED 2026-09-21.** The feed-shaped surfaces become embeds in increment 2, which
makes the guide's existing rule apply to them unchanged: colour signals kind, so the
emoji come out of `#war-log`, the raid window, the vehicle wipe, the airdrops, `#bans`
and `commands/embeds/scoring.ts`.

Clan notices and DMs stay plain content (the ping constraint — see C2), so they **keep
their glyphs**. That is the guide's rule as written, not an exception to it: the rule is
scoped to embeds, and those messages are not embeds.

### A6. Clean on the rest of the brand rules

No exclamation marks anywhere. No "faction" leaking into player-facing copy (it stays an
internal code word, as the guide requires). No coordinates in any public surface — that
one is defended by comments in at least five files. Sentence case holds. Bold is used for
actors and object names, as specified.

---

## Part B — the audit, message by message

Style key: **`:R`** relative ("in 3 hours"), **`:F`** full date and time, **`:F (:R)`**
both, **`dur`** literal duration that should stay a plain number.

### B1. Broadcast channels

| # | Message | File | Time today | Proposal | Links today | Proposal |
|---|---|---|---|---|---|---|
| 1 | Raid weekend opens tomorrow | `raid-window-text.ts` `advanceText` | `:F` ×2 | **`:F (:R)`** on open, `:F` on close | none | none needed |
| 2 | No raid weekend this week | `raid-window-text.ts` `advanceText` | none | none | none | none needed |
| 3 | Raid weekend is live | `raid-window-text.ts` `openText` | `:F` | **`:R`** — "closes in 41 hours" is the useful fact mid-window | none | none needed |
| 4 | Raid weekend is over | `raid-window-text.ts` `closeText` | `:F` | **`:F (:R)`** — next opening is far out, so the date matters | none | none needed |
| 5 | Raid window flip failed | `raid-window-text.ts` `failureText` | `.toISOString()` | **leave as ISO.** Ops-facing at 02:00; an unambiguous machine timestamp beats a friendly one | none | none |
| 6 | Weekly vehicle wipe | `announce-text.ts` | hand-built `hh:mm UTC` + `whenPhrase()` computing "tomorrow" / "today, in about N hours" | **`:F (:R)`** — this deletes `whenPhrase`, `utcDayStart` and the `HOUR_MS` arithmetic outright, and with them the bug class the comment describes (a late post saying "tomorrow" when the wipe is hours away) | none | none needed |
| 7 | Airdrop inbound | `airdrop-text.ts` `airdropText` | `:R` ✅ | keep | none | none needed |
| 8 | The <place> drop is off | `airdrop-text.ts` `scrubText` | none | none | none | none needed |

### B2. `#war-log` (plain text)

| # | Message | Time today | Proposal | Links today | Proposal |
|---|---|---|---|---|---|
| 9 | Raid — clan raided clan | none | none | clan names bold, unlinked; gamertag plain | **link both clans + the gamertag** |
| 10 | Defense — raised colors again | `duration()` "3h 15m" | **`dur`, keep** — it is a length, not an instant | clan bold, unlinked | **link the clan** |
| 11 | Alphas this week | none | none | up to 3 clans bold, unlinked | **link all three** |
| 12 | Season over / champion | none | **add `:F` for the close time** | bare `…/seasons` URL | **mask it**: `[Full table](…)`; link the champion clan |

### B3. `#bans` (plain text)

| # | Message | Time today | Proposal | Links today | Proposal |
|---|---|---|---|---|---|
| 13 | banned until <date> | `formatDate()` "8 Sep 2026" | **`:F`** | gamertag bold, escaped, unlinked | **leave unlinked.** The tag is frozen player-controlled text and may not resolve to a page; the escaping comment warns against touching this renderer |
| 14 | banned permanently | none | none | as above | as above |
| 15 | unbanned (served / lifted) | none | none | as above | as above |

### B4. Feeds

| # | Message | Time today | Proposal | Links today | Proposal |
|---|---|---|---|---|---|
| 16 | Faction feed — dormant | `:R` ✅ with `NaN` guard | keep; move the guard into the shared helper | title `Name [TAG]`, no URL | **`setURL(clanUrl(tag))`** |
| 17 | Faction feed — all other kinds | embed `timestamp` | keep — Discord renders it live already | as above | as above |
| 18 | Kill feed | embed `timestamp` | keep | killer + victim **already linked** ✅ | clan tag beside each name is still plain — **link it** |
| 19 | Hit / killstreak / long-range feeds | embed `timestamp` | keep | names linked ✅ | same: link the `[TAG]` |
| 20 | Players online | `:R` ✅, names linked ✅ | keep | ✅ | **link the `[TAG]`** |
| 21 | Leaderboards | none | none | gamertags linked ✅ | **link the `[TAG]`** |
| 22 | Achievement card | none | none | owner bold, unlinked; clan tag plain | **link owner → profile or clan page** |
| 23 | Release notes | embed `timestamp` | keep | n/a | n/a |

### B5. Clan-channel notices and DMs (`notice-text.ts` — 40 renderers, plain text)

The densest surface and the one with the most to gain. `relativeAge()` produces
"6 min ago" / "2 h ago" / "3 d ago" by hand for six renderers, and `person()` renders a
gamertag as plain text everywhere it appears.

| # | Renderer(s) | Time today | Proposal | Links today | Proposal |
|---|---|---|---|---|---|
| 24 | `non_member_raise`, `solo_non_member_raise`, `intruder`, `solo_intruder`, `dismantle`, `solo_dismantle`, `gate_built`, `solo_gate`, `built`, `solo_built` | `ctx.age` from `relativeAge()` | **`:R`** — deletes `relativeAge` and the `now` argument threaded through `noticeText`. ⚠️ check the DM path: these also go to a leader's DM | gamertag plain | **link the gamertag** |
| 25 | `flag_down` | "Re-raise within 24h" | **`dur`, keep** — it is a window, and the deadline instant is not in the payload | raider + raider clan plain | **link both** |
| 26 | `defended` | `duration()` | `dur`, keep | gamertag plain | **link it** |
| 27 | `disband_warning` | "N days until" | **`:R`** if the payload carries the instant; otherwise `dur` | none | none |
| 28 | `rebind_proposed` | "within 24h" | `dur`, keep | bare `p.link` URL | **mask it** |
| 29 | `rebind_confirmed`, `solo_lapsed` | "in N days" | `dur`, keep | `solo_lapsed` has a bare URL | **mask it** |
| 30 | `kicked` (DM arm) | `formatDate()` | **`:F`** | clan bold, unlinked | **link the clan** |
| 31 | `succession_claimed` | `hours(SUCCESSION_WINDOW_MS)` | **`:R`** on the deadline if available, else `dur` | two gamertags plain | **link both** |
| 32 | `vote_opened` | `formatDateTime()` "8 Sep 2026 14:00 UTC" | **`:F (:R)`** | two gamertags plain, bare URL | **link both + mask the URL** |
| 33 | `vote_failed` | `formatDate()` | **`:F`** | gamertags plain | **link them** |
| 34 | `ban_applied` | `p.until` raw | **`:F`** | none | none |
| 35 | `invited`, `request_accepted`, `request_declined`, `pending_expired`, `codes_rotated` (DM arm) | none | none | clan bold, unlinked; bare URLs | **link the clan, mask the URLs** |
| 36 | `joined`, `became_full`, `left`, `promoted`, `demoted`, `transferred`, `leader_removed`, `succession_done`, `succession_voided`, `guest`, `revived`, `codes_rotated` (channel arm) | none | none | gamertags plain | **link them all** |
| 37 | `achievement` | none | none | owner bold, unlinked | **link owner** |
| 38 | `zone_warning`, `dormant_raided`, `dormant_inactive`, `renamed`, `colors_elsewhere`, `booster_kit_unchosen` | "24 hours" / "7 days" literals | **⚠️ brand violation, separate from this audit:** these are typed into the string, not interpolated from `@factions/domain`. Principle 2 says the words and the rules must not be able to disagree. Recommend fixing in the same pass | clan/flag names plain | link where a page exists |

### B6. DMs outside `notice-text.ts`

| # | Message | Time today | Proposal | Links today | Proposal |
|---|---|---|---|---|---|
| 39 | Ceremony witnessed | `:R` ✅ | keep | participants bold, unlinked; bare `/claim/<id>` URL | **link participants, mask the URL** |
| 40 | Dormancy — gone dormant | `:R` ✅ + `formatDuration()` for the window | keep both | clan `Name [TAG]` plain | **link the clan** |
| 41 | Dormancy — active again | none | none | as above | **link the clan** |

### B7. Slash-command replies and embeds

| # | Command | Time today | Proposal | Links today | Proposal |
|---|---|---|---|---|---|
| 42 | `/clan info` — rebind candidates | `when()` | **`:F (:R)`** | title links `/clan` ✅; roster gamertags plain | **link every roster gamertag** |
| 43 | `/clan info` — succession / vote fields | none | none | gamertags plain | **link them** |
| 44 | `/clans list` | none | none | title links `/clans` ✅; per-row `Name [TAG]` plain | **link each row to `/clans/<tag>`** |
| 45 | `/clans show` | none | none | title links ✅; roster plain | **link roster gamertags** |
| 46 | `/scoreboard` | none | none | title links ✅; rows plain | **link each clan** |
| 47 | `/alphas` | `when(weekStart)` as the **field name** | **⚠️ cannot use `<t:…>`** — Discord does not render it in a field name. Keep `when()` here, or move the week into the field value. Recommend keeping `when()` | rows plain | **link each clan** |
| 48 | `/seasons` | `when(endedAt)` | **`:F`** | champion plain | **link the champion** |
| 49 | `/warlog` | `when(e.at)` | **`:R`** | clans bold, unlinked | **link them**; also strip the in-embed ⚔️/🛡️ per A5 |
| 50 | `/player` | none | none | title links ✅; clan field plain | **link the clan** |
| 51 | `/board` | none | none | title links ✅; rows plain | **link gamertag and `[TAG]`** |
| 52 | `/achievements` | none | none | title links ✅ | fine |
| 53 | `/me show` | none | none | title links ✅; clan/invite/request rows plain | **link every clan named** |
| 54 | `/base show` | `lapsedCopy(at)` via shared copy → `when()` | **`:R`**, through the A2 split | own base only | none needed |
| 55 | `/link` | `formatRemaining()` "23 h 59 min"; `held-by-other` uses `at()` | **`formatRemaining` stays** (it is a countdown inside a card that is re-rendered); **`held-by-other` → `:R`** via the A2 split | none | none needed |
| 56 | `/map` | `when(expiresAt)` | **`:R`** | pin author plain | **link the author** |
| 57 | `/vault` | `when(h.at)` history lines | **`:R`** | actor plain | **link the actor** |
| 58 | `/found` | `when(ceremony.expiresAt)` as a field **value** | **`:F (:R)`** — a field value renders `<t:…>` fine | participants plain | **link them** |
| 59 | Clan/vault/leadership outcome strings | durations only | `dur`, keep — no change | n/a | n/a |

---

## Part C — the channel move

Today, gated fatally at boot in `config.ts`:

- `ANNOUNCEMENTS_CHANNEL_ID` — raid window advance/open/close, weekly vehicle wipe, wipes
- `SERVER_EVENTS_CHANNEL_ID` — airdrops
- `OPS_CHANNEL_ID` — the raid window failure alert

**The move:** raid window notices and the weekly vehicle wipe notice both post to
`SERVER_EVENTS_CHANNEL_ID`. The failure alert stays on `OPS_CHANNEL_ID` — it is ops-facing
and nothing about that changes.

Five things have to move with them, and each one is a place this can go wrong:

1. `config.ts:531` — the fatal check tying `RAID_WINDOW_TICK` to `ANNOUNCEMENTS_CHANNEL_ID`
   re-points at `SERVER_EVENTS_CHANNEL_ID`, and its error message is rewritten. Same for
   the `WEEKLY_VEHICLE_WIPE` gate.
2. `config.ts:544` — `AIRDROP_TICK`'s message says the announcement is *"the only way a
   drop is ever found"*. With three features sharing the variable, that sentence needs to
   name which feature is missing its channel.
3. `discord.ts:1573-1595` — `announcePoster` and `serverEventsPoster` are built
   separately and the comments assert which is non-null from which gate. Those assertions
   change. ⚠️ If raid window, vehicle wipe and airdrops now share one channel they should
   share **one poster**, or three posters race on the same channel.
4. `discord.ts:1653` — `"ANNOUNCEMENTS_CHANNEL_ID is unset: wipes happen without notice."`
5. `ANNOUNCEMENTS_CHANNEL_ID` leaves the bot's config entirely. **Resolved 2026-09-21,
   and it turned out cleaner than expected:** `announcePoster` has exactly two callers,
   `raidWindowTick` (`discord.ts:1585`) and `announceTick` (`discord.ts:1611`). Both are
   moving. Nothing else in the bot or in `scripts/` reads the variable, so after this
   change the bot never posts to that channel at all.

   The startup warning at `discord.ts:1653` — `"ANNOUNCEMENTS_CHANNEL_ID is unset: wipes
   happen without notice."` — is about the *vehicle* wipe, not a season wipe. It goes
   away with the rest.

   ⚠️ **The env var itself stays in `/opt/clan-wars/.env`.** It is what the manual
   announcement workflow from the prod host reads (see the `discord-post-mechanics`
   note). Removing `announcementsChannelId` from `apps/bot/src/config.ts` must not turn
   into removing the line from the deployed `.env` — those are two different things and
   only the first one is wanted.

`docs/deploy/raid-window.md` and `docs/deploy/2026-09-12-weekly-vehicle-rotation.md` both
name the old channel and need updating, and this needs a deploy note: the env change has
to land **before** the bot restarts, or a fatal gate stops it from booting.

---

## Part D — open questions

**All resolved 2026-09-21.** Kept here as the record of what was decided and why.

**D1. ~~Does a masked link render in plain message content?~~** Yes, but it unfurls an
OpenGraph card. Suppressed with `[text](<url>)`. See A4.

**D2. ~~Does `<t:…>` dropping "UTC" matter?~~** No. Tokens everywhere; "UTC" leaves
player-facing copy entirely. Two surfaces technically cannot use a token and keep a
literal clock: the ops failure alert (row 5, stays ISO) and the `/alphas` field *name*
(row 47, Discord does not render tokens in a field name). `brand/02-verbal-identity.md`'s
"Dates are UTC" rule is rewritten to cover this: tokens for anything a player reads in
Discord, `en-GB` `9 Sep` UTC for the website and for the two exceptions.

**D3. ~~Does `ANNOUNCEMENTS_CHANNEL_ID` survive?~~** The channel does, as a human
channel. The bot's use of it does not. See Part C item 5.

**D4. ~~Emoji?~~** Feed-shaped surfaces become embeds and lose their emoji to colour;
clan notices and DMs stay plain content and keep theirs. See A5.

**D5. ~~The hardcoded "24 hours" / "7 days" literals?~~** Fixed in this pass, interpolated
from `@factions/domain` like every other number in the copy.
