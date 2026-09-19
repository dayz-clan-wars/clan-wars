# Notifications on the site — design

**Status:** proposed 2026-09-18, not implemented.

Every notice the bot writes is a Discord message and nothing else. A player
who has muted the server, lost a DM behind Discord's privacy settings, or
simply scrolled past it has no way to get it back. This puts the same notices
on the site: a `/notifications` page, and a bell in the top bar that says how
many are waiting.

The design comes off the canvas at `Notifications.dc.html`. Where this
document and that file disagree, this document is the one that was checked
against the code — see §3, which is the disagreement that matters.

---

## 1. Scope

In scope: one page (`/notifications`), one bell and panel in the site bar, one
new table, a web-side renderer for every `ClanNoticeKind`, and three actions a
player can take from a notice.

Out of scope, deliberately:

- **Changing what the bot writes.** No new notice kinds, no kind that DMs
  where it used to post to a channel, no payload changes. This feature reads
  `clan_notices`; it does not get a vote on what goes in it.
- **Push, email, or web-push.** The bell is a count on a page the player
  already visits.
- **Deleting or archiving a notice.** `clan_notices` is append-only and stays
  that way. Read state is a separate table (§2) precisely so this feature
  never writes to the notice itself.
- **Per-kind mute or preference.** Filters (§6) are a view, not a setting.
  Nothing here decides whether a Discord DM gets sent.

## 2. Read state

Nothing in the database records that a player has seen a notice. `posted_at`
and `failed_at` on `clan_notices` are the Discord poster's bookkeeping and
mean nothing here — a notice can be posted to Discord and unread on the site,
or fail to post and be read on the site, which is much of the point.

Two tables, because "mark all read" and "read one" are different shapes:

    notice_reads
      discord_id  text        not null
      notice_id   bigint      not null references clan_notices(id) on delete cascade
      read_at     timestamptz not null default now()
      primary key (discord_id, notice_id)

    notice_read_marks
      discord_id  text        not null primary key
      through_id  bigint      not null
      marked_at   timestamptz not null default now()

A notice is unread when `id > through_id` **and** no `notice_reads` row exists
for it.

⚠️ **"Mark all read" writes one row, not one per notice.** A clan member who
has never opened the page may have thousands of notices behind them; a
per-notice write would make the button's cost grow without bound, and it would
grow fastest for exactly the player most likely to press it. The watermark is
O(1) forever. `notice_reads` then exists only for the rows a player marks
individually — in practice, the ones an action resolved.

⚠️ **`through_id` is a notice id, not a timestamp.** Ids are monotonic and
assigned inside the writing transaction; `occurred_at` is backdated by several
writers (an achievement is dated to its evidence, not its unlock). Watermarking
on a timestamp would silently mark a notice read that arrived after the button
was pressed.

⚠️ **No foreign key on `notice_read_marks.through_id`.** It points at the
highest id the player had seen, and that row may later be deleted by a season
wipe; the watermark must survive it. `notice_reads` does carry the FK, with
`on delete cascade`, because a read row for a notice that no longer exists is
meaningless rather than merely stale.

There is no row in either table for a player who has never pressed anything,
which is the common case. Absence means everything is unread.

## 3. What the page shows

**The canvas is wrong about this, and it is worth stating plainly.** Its
`FEED` array is commented "one row per `clan_notices` kind the DM target can
carry", but six of its twelve rows are kinds that only ever reach a clan
channel. Walking every call site of `noticeUserTx` and `noticeFullMembersTx`,
the kinds that can actually be a DM are:

    invited, kicked, request_accepted, request_declined, pending_expired,
    codes_rotated, flag_down, achievement, ban_applied, zone_warning,
    solo_lapsed, solo_non_member_raise, solo_intruder, solo_dismantle,
    solo_gate, solo_built

Sixteen of the forty-four. `vote_opened`, `defended`, `promoted`,
`disband_warning`, `rebind_proposed` and the clan (non-`solo_`) `intruder` are
channel-only. `zone-tick.ts`'s `alertOwner` is the sharpest case: a clan-owned
zone posts `intruder` to the channel, and only a solo owner is DMed
`solo_intruder`.

A DM-only page would therefore not contain most of what the canvas draws, and
would be nearly empty for a clan member who is not a solo base owner. So the
page is **both**:

    target = 'dm'      and discord_target_id = :you
    union all
    target = 'channel' and faction_id in (:your factions)
                       and occurred_at >= :your joined_at

⚠️ **Membership means `status = 'full'`.** `faction_members` carries its own ⚠️
saying every "is a member" read means `full`; a pending member is on the table
and not on the roster, and must not read the clan's channel history.

⚠️ **The `joined_at` floor is a privacy rule, not an optimisation.** Without
it, joining a clan hands you every notice it ever received — who was kicked,
who was demoted, every raid it lost. A member sees what arrived while they
were a member.

⚠️ **Leaving a clan removes its notices from the page.** Membership is read
live, so a former member's page loses the clan's channel rows. This is
deliberate and worth knowing before someone reports it as data loss: the rows
are untouched in `clan_notices`, and rejoining restores visibility from the
new `joined_at` forward.

The canvas's subtitle ("Clan-channel notices stay in Discord") is therefore
wrong too, and gets rewritten to match.

Paged at 50, newest first, grouped by UTC day under the day headings the
canvas draws. Grouping is per page, so a day spanning a page boundary gets its
heading on both — the alternative is a pager that cannot say how many pages
there are.

## 4. Copy

`apps/bot/src/notice-text.ts` cannot be reused. It renders one string per
notice for Discord: `<@1234>` mentions, `**markdown**`, a leading emoji, and a
bare URL appended to the sentence. The page needs three fields — a kicker, a
title, and a body — and must not emit any of those four things.

So there is a second table, `apps/web/lib/notice-copy.ts`:

    Record<ClanNoticeKind, {
      group: NoticeGroup;                                   // §6's filters
      render: (p: NoticePayload, ctx) => { kicker, title, body };
    }>

⚠️ **This is two statements of one fact, and the usual remedy does not fully
apply.** An exhaustiveness test (mirroring `apps/bot/test/notice-text.test.ts`)
pins the table to exactly `CLAN_NOTICE_KINDS`, so a new kind cannot ship with
only one renderer. Nothing mechanical can catch the *other* drift — a web
renderer whose wording diverges in meaning from its Discord twin. That risk is
accepted, because the formats genuinely differ and collapsing them into one
string would make both worse. Reviewers should read the pair together when
either changes.

It lives in `apps/web/lib/`, not `packages/copy`. `packages/copy` is for copy
the bot and the site both use; this is web-only, and adding it there would
pull `NoticePayload` toward a package whose `leaf.test.ts` forbids runtime
imports from `@factions/roster`.

⚠️ **A renderer reads only the keys its writer sets, and never invents one.**
`NoticePayload` is `Record<string, …>` and forbids nothing by name; the
`clan_notices_no_coordinates` check constraint is what keeps coordinates and
pole keys out, and the renderers are what keep the rest honest. A missing key
renders as the bot's `person()` does — "someone", never `undefined`.

All 44 are hand-written before this ships. A generic fallback was considered
and rejected: a fallback that renders means an unwritten kind reaches players
as a dull row nobody notices is wrong, and the exhaustiveness test stops being
the thing that forces the decision.

## 5. Actions

Three notices carry actions. None of them takes its identifier from the
payload:

| Kind | Call | Identifier resolved from |
|---|---|---|
| `invited` | `acceptInvite` / `declineInvite` | `myInvites(you)` |
| `vote_opened` | `castVote(you)` | nothing — it takes only the session |
| `rebind_proposed` | `confirmRebind(you, poleKey)` | `clanFor(you)` rebind candidates |

⚠️ **Actions resolve against live state, and this is the design, not a
shortcut.** An invite id frozen into a payload at write time can be revoked,
expired, or superseded before the player opens the page; a button built from
it would fail or, worse, act on something that no longer means what the notice
said. Resolving live means a notice whose action is gone simply renders
without a button. It also means **no payload changes and no migration for
actions** — and it is forced regardless for `rebind_proposed`, whose pole key
`clan_notices_no_coordinates` explicitly forbids from ever being in the
payload.

An action marks its own notice read (a `notice_reads` row) so the row stops
being bold once it has been dealt with.

⚠️ **`formAction`'s redirect target becomes an allowlist, not a free field.**
The existing routes hardcode `back` (`/me`, `/clan`, `/clan/settings`), and
the page needs them to return to `/notifications`. A hidden `back` field that
is used as given is an open redirect. The allowlist is a small set of known
site paths; anything else falls back to the route's own default.

## 6. Bell, panel, filters

The bell is a cell in `site-bar.tsx` with the unread count in the gold badge
the bar already uses. The panel is a `<details>`, like `Drawer` in
`menu-list.tsx`, so it opens without JavaScript and closes on navigation.

⚠️ **The count comes from `attention()`, extended, not from a new read.**
`(site)/layout.tsx` already performs four sequential reads on every request in
the group; a fifth for the bell is the wrong place to spend a round trip when
`attention()` is already asking related questions. `Attention` gains a third
field and `Counts` in `lib/menu.ts` stays as it is — the bell is not a nav
item and must not appear in the drawer's badge arithmetic.

Filters map to the eight groups the canvas names (Roster, Raid, Base,
Leadership, Achievement, Enforcement, Dormancy, Rebind), not to 44 kinds. "All"
is the default rather than a chip. The group of a kind is one more column in
the `notice-copy.ts` table, so a kind cannot exist without a group.

## 7. Surfaces

| What | Where |
|---|---|
| Migration | `packages/db/migrations/0041_*.sql` (0040 is current; drizzle-kit names it), schema in `packages/db/src/schema.ts` |
| Read/write | `packages/roster/src/notifications.ts`; `notificationsFor`, `markAllRead`, `markRead` |
| Exports | `packages/roster/src/{api,index}.ts`, and the four allowlists in §9 |
| Copy | `apps/web/lib/notice-copy.ts` |
| Page | `apps/web/app/(site)/notifications/page.tsx` |
| Bell + panel | `apps/web/app/(site)/site-bar.tsx`, `notifications-bell.tsx` |
| Actions | `apps/web/app/api/notifications/*`, `apps/web/lib/form.ts` (allowlist) |

## 8. Testing

- `notice-copy.test.ts` — exhaustive over `CLAN_NOTICE_KINDS`; every kind has
  a kicker, a title, a group; no renderer emits `<@`, `**`, or a bare URL.
- `notifications.test.ts` (roster) — the union, the `full`-only rule, the
  `joined_at` floor, the watermark, and that a former member loses the clan's
  rows.
- A render test per state, as `timer-bar-render.test.ts` does: unread vs read,
  an actionable notice with and without its live target, an empty page.
- ⚠️ A test that a channel notice from before `joined_at` is **not** returned.
  That is the privacy rule, and it is the one a future query rewrite is most
  likely to lose.

## 9. Risks

- **44 renderers is most of the work**, and most of it is prose. It is also
  the part most likely to be reviewed least carefully.
- **Four export allowlists** must gain the new roster reads together
  (`packages/roster/test/{exports,api}`, `apps/bot/test/parity.test.ts`,
  `apps/web/test/smoke.test.ts`). That is the capability pin working; it is
  listed here so it is not a surprise mid-implementation.
- **Notice volume is unbounded.** A long-lived clan generates channel notices
  indefinitely and nothing prunes them. The pager makes the page survivable;
  it does not make the table smaller. If this becomes a problem the answer is
  retention on `clan_notices`, which is out of scope here and would need its
  own decision about what the war log keeps.
