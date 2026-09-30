# Award transfers — design

**Date:** 2026-09-30
**Status:** designed, not implemented
**Covers:** letting an award's owner give it to another linked player from the
site, with the award's clock paused while it changes hands
**Builds on:** event awards (`docs/superpowers/specs/2026-09-22-awards-design.md`
— `award_grants`, `awardState`, `awardClock`, placement, the spawner projection,
the notice queue)

---

## 1. Purpose

An award belongs to the Discord account it was granted to. Players want to move
them: a winner gifts a prize they don't need, a clan passes a member's win to
whoever needs it, and two players trade. All three are served by one action:
**the owner gives the award to another linked player.** A trade is two gives, on
trust, the way players already trade gear in game.

### In scope

- A "Give to another player" action on `/awards/<id>`, instant after one confirm
- Pausing a placed or live award's clock across the transfer, resuming it when
  the new owner's placement first spawns
- A transfer history (`award_transfers`), shown to admins in `/award list`
- A DM to the recipient and a receipt DM to the giver

### Out of scope

- A Discord command for players. Award actions are site-only (`parity.test.ts`
  `PENDING`); `/awards give` is the shape if it is ever wanted
- A two-sided swap where nothing moves until both players confirm
- Offers the recipient must accept
- Undoing a transfer (an admin can revoke and re-grant)

## 2. Rules

- **Who:** the current owner (`award_grants.discord_id`), signed in on the site.
  The owner need not be linked.
- **To whom:** any linked player (`identity_links`) other than the owner. Linked
  is required because placement is an emote sequence performed by the owner's
  character. The recipient may already hold other awards, of any kind.
- **When:** while `awardState` is `unplaced`, `waiting` or `live`. `lapsed`,
  `expired` and `revoked` awards cannot be given.
- **How often:** any number of times. Each transfer gives the new owner a fresh
  `AWARD_PLACE_BY_MS` (one week) to place it.
  - Accepted consequence: two players can pass an award back and forth to keep
    its clock paused. It spawns nothing while paused, so the only gain is
    choosing when to use it. Chosen by the owner on 2026-09-30.
- **Picks** carry over; the new owner can change them before placing.
- **An open placement challenge** for the grant is closed by the transfer.

## 3. The paused clock

At transfer, in one transaction:

- `discord_id` becomes the recipient; `place_by` becomes `now + AWARD_PLACE_BY_MS`.
- The spot is cleared (`pos_x/y/z`, `placed_at` null), so `inAwardFile` is false
  and the grant leaves the spawner file on the worker's next sweep. It stops
  spawning from the next restart.
- `remaining_ms` is set to the time left:
  - clock started (`expires_at` set): `expires_at − max(now, live_from)`, never
    below zero
  - otherwise: the existing `remaining_ms` if set, else `duration_days × 1 day`
- `live_from` and `expires_at` are cleared.

When the new owner places it, the worker stamps the clock as today, from the
first upload that carries the grant, except that the length is
`remaining_ms ?? duration_days × 1 day`. `awardClock` gains a milliseconds form;
`live_from` is still the next restart after the upload.

⚠️ `remaining_ms` is written only by a transfer and read only by the worker's
stamp. A null means "never transferred with a running clock" and is the only
state existing grants are in.

Known gap: objects already spawned at the old spot stay in the world until the
next restart, exactly as after an admin revoke.

Because the award's state is derived from timestamps, a transferred award reads
as `unplaced` again with no new state: `placed_at` null and `place_by` in the
future.

## 4. Data

- `award_grants.remaining_ms` — `bigint`, nullable (migration).
- `award_transfers` — `id`, `award_grant_id` (FK), `from_discord_id`,
  `to_discord_id`, `transferred_at`, `remaining_ms` (the value written). Insert-only; read only by `/award list`.
- Lock order: `award_grants` → `booster_kit_challenges` (the existing rule for
  any transaction touching both) → `award_transfers` → `clan_notices`.
  `award_transfers` sits immediately after `award_grants` in the CLAUDE.md order
  and is written by this transaction alone.

## 5. Notices

Two new `clan_notices` kinds, DMs, rendered by both `apps/bot/src/notice-text.ts`
and `apps/web/lib/notice-copy.ts`:

- `award_received` (to the recipient): "🎁 Ron gave you a **Weapon Kit**. Choose
  your gear and mark where it spawns by <deadline>. It has 2 days 5 hours left,
  and the clock starts once it spawns." (A transfer always sets `remaining_ms`.)
  Action link: the award page.
- `award_given` (to the giver): "You gave your **Weapon Kit** to Ron."

The giver's name is the giver's gamertag when linked, else "Another player"
(the roster stores no Discord display names).

## 6. Page

- `/awards/<id>` shows "Give to another player" while the award is open. It
  opens a search over linked gamertags (not the owner), then a confirm: "Give
  your Weapon Kit to Ron? You can't undo this."
- After the transfer the giver is sent to `/awards`; the old id now answers
  not-found for them, as any award that isn't theirs does.
- When `remaining_ms` is set (every transferred award), the length line reads "It has 2 days 5 hours left
  once it spawns." instead of "It runs for 3 days once it spawns."
- Refusals get copy in `award-copy.ts`: not yours, recipient not linked,
  recipient is you, award has ended.

## 7. Testing

- Domain: the time-left function for each state (unplaced, waiting unstamped,
  waiting stamped before `live_from`, live, previously transferred).
- Roster: each refusal; a successful transfer's row, spot, clock and deadline;
  the placement challenge closed; the history row; both notices; two transfers
  in a row.
- Worker: a grant with `remaining_ms` is stamped `live_from + remaining_ms`; a
  grant without it is unchanged.
- Web: the give flow renders; the length line uses the time left.
- Bot: both notice texts; `parity.test.ts` lists the new write under `PENDING`.
