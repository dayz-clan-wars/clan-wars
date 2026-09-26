# Referrals — design

**Status:** approved in conversation 2026-09-26; this document is the written spec.

## 1. Goal

A player can name the linked player who brought them to Clan Wars. The record is permanent and shown on both players' profiles, and the referrer is told by DM. This first step only records referrals; rewards, points and leaderboards are out of scope and will build on this data later.

## 2. Rules

1. **One referrer per player, forever.** Once recorded, a referral can never be changed or removed, by the player, the site, the bot or an ordinary code path.
2. **The referrer must be a linked player** at the moment the referral is recorded. They are chosen by gamertag, from linked players only.
3. **No self-referral.**
4. **No loops.** A referral that would make the referrer, directly or through a chain, referred by the player naming them is refused (A names B, then B cannot name A; A→B→C, then C cannot name A).
5. **Only linked players have referrals.** A referral is recorded for a player only once they are linked; naming a referrer during linking takes effect when the link completes.
6. **The referral belongs to the person, not the link.** It survives `/link unlink`, the site's unlink button, leaving and rejoining the guild, and relinking to a different character.

## 3. Data

New table `referrals`:

| column | type | notes |
|---|---|---|
| `referred_discord_id` | text, primary key | the player who named a referrer; one row each, ever |
| `referrer_discord_id` | text, not null | the referrer's Discord account |
| `referrer_dayz_id` | text, not null | the referrer's character when named (for display) |
| `source` | text, not null | `link_bot`, `link_site`, `later_bot` or `later_site`; CHECK-constrained |
| `created_at` | timestamptz, not null, default now() | |

- CHECK `referred_discord_id <> referrer_discord_id`.
- Index on `referrer_discord_id` (profile counts, the loop check).
- **Permanence is enforced in the database:** a trigger raises on any `UPDATE` or `DELETE` of `referrals`. The application has no update or delete path either. (A deliberate operator correction would need the trigger dropped by hand in a migration; that is the point.)
- Keyed by Discord id, not `identity_links.id` and no foreign key to `identity_links`, because link rows are deleted on unlink and guild removal (§2 rule 6).

`verification_challenges` gains a nullable `referrer_discord_id`: the referrer named at `/link start` or on the site's link page, carried until the challenge completes.

## 4. Recording a referral

One package function in `@factions/roster` does every write:

`recordReferral(tx, { referredDiscordId, referrerDiscordId, source, at })` returns one of `recorded`, `already-referred`, `self`, `referrer-not-linked`, `loop`, `not-linked`.

In one transaction it:
1. requires `referredDiscordId` to have an `identity_links` row (`not-linked` otherwise);
2. refuses `self`;
3. looks up the referrer's `identity_links` row (`referrer-not-linked` if none) and takes `referrer_dayz_id` from it;
4. refuses `loop` with a recursive walk up the referrer's own chain of referrers;
5. inserts with `ON CONFLICT (referred_discord_id) DO NOTHING`; zero rows inserted means `already-referred`;
6. on `recorded`, queues the referrer's DM notice in the same transaction.

Concurrent attempts for the same player resolve on the primary key: exactly one wins.

### 4.1 While linking

- **Bot:** `/link start` gains an optional `referrer` string option with autocomplete over linked players (the same source as `/roster invite`'s gamertag option); the value is the referrer's Discord id resolved from their link.
- **Site:** the link page's choose-character step gains an optional "Who referred you?" field using the existing `gamertag-field` component, restricted to linked players; `/api/link/start` accepts it.
- At start, the referrer is pre-checked (`self`, `referrer-not-linked`, `loop`) so the player hears about a bad choice before doing the emotes; a failed pre-check refuses the start with a clear message rather than silently dropping the referrer.
- The referrer is saved on the challenge. When the bot's verification tick completes the challenge (`completeChallenge`), it calls `recordReferral` inside the same transaction that inserts the `identity_links` row.
- If `recordReferral` refuses at completion (the referrer unlinked in the meantime, or a loop formed), the link still completes and the "you're verified" DM says the referrer could not be recorded and why, and that they can add one with `/link referrer` or on their profile.
- `/link start redraw` and a re-issued challenge keep the referrer named on the original start unless a new one is given.

### 4.2 Later, when already linked

- **Bot:** new subcommand `/link referrer gamertag:<name>` (autocomplete over linked players). Replies ephemerally: success names the referrer and says it is permanent; each refusal has its own message (`already-referred` names the existing referrer).
- **Site:** the "Your account" panel on the player's own profile shows "Referred by X" when set; otherwise a "Who referred you?" form using `gamertag-field`, with the warning "This can't be changed later." Posts to a new `/api/referral` route (session-authenticated, same checks).

## 5. Showing it

- **`/link status`** includes "Referred by X" when set.
- **Player profile** (`/players/<gamertag>`, public): "Referred by X" linking to X's profile, when the player has a referral. "Brought in N players" with the list of referred players' current gamertags, when N > 0. Referred players who are currently unlinked are counted but listed without a gamertag link ("and 2 players no longer linked").
- **Referrer DM:** on `recorded`, the referrer gets "<gamertag> named you as the player who brought them to Clan Wars." via the existing user-notice queue (`noticeUserTx` / clan notices with a user target), rendered in `apps/bot/src/notice-text.ts`. Copy follows the player-facing voice rules: no em dashes, plain voice.

## 6. Out of scope

Rewards, points, badges, leaderboards, referral codes, Discord invite-link tracking, and any admin UI to edit referrals.

## 7. Testing

- **Database:** the trigger rejects UPDATE and DELETE; the CHECK rejects self; the primary key keeps one referrer per player.
- **`recordReferral`:** every outcome, including a 3-step loop, a concurrent double-record (one wins), and the DM notice queued only on `recorded`.
- **Linking:** a referrer named at start is recorded when the challenge completes; a referrer who unlinks before completion yields a completed link, no referral and the explanatory DM; a bad referrer is refused at start.
- **Survival:** unlink, then relink (same or different character), keeps the referral; guild removal keeps it.
- **Bot:** `/link referrer` success and each refusal; `/link status` shows the referrer; autocomplete offers linked players only.
- **Site:** `/api/referral` auth, success and refusals; `/api/link/start` with a referrer; the own-profile panel's two states; the public profile's "Referred by" and "Brought in N".
