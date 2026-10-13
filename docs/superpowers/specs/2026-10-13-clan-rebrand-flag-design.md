# Clan rebrand: changing a clan's flag

**Date:** 2026-10-13
**Status:** design approved in chat; spec awaiting review

## Purpose

Clans that want to rebrand can today change their name and tag (`/clan rename`,
`/clan/settings`), but their flag (`factions.texture`) is locked from activation until
the clan disbands. This adds the flag to rename, turning it into one **Rebrand**
action.

The flag is not a label like the name. Three systems key on it:

- **Detection** — `apps/bot/src/raise-tick.ts` counts a full member's raise at home
  as a defense, revive or upkeep only if it is the clan's own texture; at a free pole,
  the clan's texture is what proposes a base move.
- **History** — `packages/roster/src/stats.ts` (`upkeepRaiseCount`) attributes past
  raises by matching `factions.texture`, the *current* flag.
- **Kits** — the supply kit substitutes the clan's texture for the template's white
  flag; it is the only source of a clan flag in game.

A flag change that ignored these would leave a clan unable to defend between the
change and the next restart, and would silently erase members' raise stats.

## Decisions (made in brainstorming)

1. **One Rebrand action**: name, tag and flag in one form, sharing the existing
   30-day `RENAME_COOLDOWN_MS`. Not a separate flag action with its own cooldown.
2. **Pending until raised** (not an instant swap). The new flag becomes the clan's
   only when a full member raises it at the home pole, as activation does.
3. **Texture history** so past raises keep counting.
4. **The old flag is held for 3 days**, not for the season. The pool is only 33 flags.

## 1. Lifecycle

**Start.** The leader of an **active** clan submits Rebrand with a new flag from the
free pool. The flag field is optional, like tag. Name and tag still apply instantly,
exactly as rename does today. The flag change becomes **pending**:

- the new flag is held for this clan immediately (nobody else can claim it);
- the next restart's kit delivers two of the new flag;
- the old flag remains the clan's flag.

**While pending** — `FLAG_CHANGE_WINDOW_MS = 24h`, the same length as
`ACTIVATION_WINDOW_MS` and for the same reason: a restart must fall inside it.

- A full member raising **either** flag at the home pole counts (defense, revive,
  upkeep).
- Raids are unaffected; raid-tick keys on the pole and membership, not texture.
- One pending change per clan at a time.
- The leader can **cancel**, which frees the new flag immediately.

**Complete.** A full member raises the pending flag at the home pole, at an event time
before the deadline:

- `factions.texture` becomes the new flag;
- a `faction_textures` row closes the old flag and opens the new one;
- the feed announces it;
- the old flag is held for `OLD_FLAG_HOLD_MS = 3 days` (equal to
  `RELEASED_POLE_GRACE_MS`), so nobody claims it while it is likely still flying at the
  base, then returns to the pool.

**Lapse.** No qualifying raise within 24h: the new flag returns to the pool, the clan
keeps its old flag, the leader gets a DM, and the clan channel is told.

**Cooldown.**

- A Rebrand that changes **name or tag** stamps `renamed_at` at submission, as today,
  whether or not it also changes the flag.
- A **flag-only** Rebrand stamps `renamed_at` on **completion**. A cancelled or
  lapsed flag-only change costs nothing. The one-pending-change rule stops anyone
  from hoarding flags through repeated requests.
- While a flag change is pending, a new Rebrand is refused (cancel first).

**Who.** Leader only (as rename). Active clans only: a reserved clan has not flown its
flag yet, and a dormant clan revives first. A clan that goes dormant while a change is
pending keeps the pending change. A pending-flag raise at home completes the change
and revives it, through the existing dormant branch.

## 2. Data model (migration 0066)

### `flag_holds`

| column | type | notes |
|---|---|---|
| `id` | bigserial PK | |
| `server_id` | integer FK `servers.id` | |
| `texture` | text | |
| `faction_id` | bigint FK `factions.id`, `ON DELETE cascade` | the clan holding it |
| `kind` | text, CHECK in `('pending','released')` | |
| `until` | timestamptz not null | lapse time (`pending`) or release time (`released`) |
| `created_at` | timestamptz not null | |

- `flag_holds_texture_uniq` UNIQUE `(server_id, texture)`, **unconditional**: a row
  exists only while its hold is live, and the sweep deletes expired rows.
- `flag_holds_one_pending` UNIQUE `(faction_id) WHERE kind = 'pending'`.

### `faction_textures`

| column | type | notes |
|---|---|---|
| `faction_id` | bigint FK `factions.id`, `ON DELETE cascade` | |
| `texture` | text | |
| `from_at` | timestamptz not null | |
| `to_at` | timestamptz null | null = the current flag |

- PK `(faction_id, from_at)`; partial UNIQUE `(faction_id) WHERE to_at IS NULL`.
- **Backfill** in the migration: one row per existing `factions` row (every status),
  `(id, texture, created_at, null)`.
- Founding (`reserve`) inserts the first row in the same transaction as the
  `factions` insert.

### One clan per flag across both tables

`factions_holding_texture_uniq` guards `factions` alone. Every write that **takes** a
flag first takes **`lockIdentity(tx, serverId)`** (`packages/roster/src/internal/holds.ts`).
Those writes are `reserve` (founding) and starting a rebrand. The
lock already serialises names and tags in `reserve` and `rename`, so the flag check runs
under it rather than under a new lock. The write then checks both `factions` (holding
statuses) and live `flag_holds`, and only then inserts. The two unique indexes remain as
backstops. `reserve`'s existing `flag-taken` refusal covers a texture found in
`flag_holds`.

Completion in raise-tick takes no new flag: it promotes a texture this clan already
holds in `flag_holds`. It therefore needs only the clan's `factions` row FOR UPDATE,
which it already holds.

`identity_holds` is deliberately not reused. Its holds last the season and have no
expiry or pending state. Folding flags into it would change the meaning of a table the
name and tag rules depend on.

**Lock order (§4.12):** `flag_holds` and `faction_textures` go immediately after
`factions`, in that order, and the CLAUDE.md list gains both. `packages/db/test/holding-index-drift.test.ts`
gains a case pinning the free-pool read's holding-status predicate to
`factions_holding_texture_uniq`.

### Free pool

Claim form and Rebrand picker share one rule: the 33-flag constant, minus textures of
holding clans, minus `flag_holds` rows with `until > now`. Because reads filter on the
time, a hold ends on time whether or not the sweep has run.

### Sweep

A new bot-tick step:

- an expired `pending` row: delete it, queue the lapse DM and channel notice;
- an expired `released` row: delete it silently.

⚠️ The sweep must not lapse a change that a raise not yet folded would have completed.
This mirrors the backlog concern documented for `FLAG_DOWN_MS`. A `pending` row
therefore lapses only when raise-tick's cursor event has `occurred_at >= until`. At that
point every raise that could have completed the change has already been folded. A
backstop handles a server whose log has stopped entirely: the row also lapses at
`until + FLAG_CHANGE_WINDOW_MS`, so a flag is never stranded.

## 3. Detection

### `raise-tick.ts`, declared home pole, full member

The single texture check (`p.texture !== clan.texture` → ignore) becomes:

- **current flag** → unchanged (defense / revive / upkeep);
- **pending flag, `ev.occurredAt < until`** → complete the change in the same
  transaction, under the `factions` row already held FOR UPDATE: update
  `factions.texture`, close/open `faction_textures` at `ev.occurredAt`, convert the
  `pending` hold into a `released` hold on the old texture, queue the feed entry and
  clan notice. Then **continue through the existing defense / revive / upkeep logic**,
  so a rebrand raised during a siege is also the defense;
- **anything else** (including a pending flag past `until`) → ignored, as today.

Lock order (§4.12): `flag_holds` and then `faction_textures` are written after
`factions` and before the standings, defense and notice writes. The order is extended,
never reordered.

### `raise-tick.ts`, undeclared pole

A pending flag raised by a member at another pole does nothing: no rebind proposal,
no colors-elsewhere. Neither `factions.texture` nor any holding clan matches it, so
the existing lookup already returns no owner. A test pins this behaviour.

### Dormancy clock

`dormancy-store.ts` reads the last raise of `factions.texture`. No change is needed:
the completing raise is the first raise of the new texture, so the clock stays fresh
across the switch.

### Stats

`upkeepRaiseCount` (`stats.ts`) joins `faction_textures` on
`from_at <= occurredAt < coalesce(to_at, infinity)` and `texture = payload.texture`,
instead of `factions.texture`.

Season, alpha and scoreboard pages keep showing the **current** flag, consistent with
names after a rename.

## 4. Kits

`supply-tick.ts` (and booster kits, wherever they place the clan's flag) deliver the
pending texture when one exists, else `factions.texture`. Without this, there is
nothing to raise.

## 5. Surfaces and copy

- **`/clan/settings`**: the rename form becomes **Rebrand**, with a flag picker (the
  claim form's picker, limited to the free pool) and the current flag preselected. When
  a change is pending, the form shows the pending flag, a countdown to the deadline,
  and a **Cancel** button.
- **`/api/clan/rename`** accepts an optional `texture`; **`/api/clan/rebrand/cancel`**
  is new. Refusal codes follow the existing `code("rename", …)` pattern: `bad-flag`,
  `flag-taken`, `change-pending`, `cooldown`, `not-active`.
- **Discord**: `/clan rename` gains an optional `flag` option (with autocomplete over
  the free pool) and a `/clan rebrand-cancel` subcommand, per the command-parity spec.
  `apps/bot/test/parity.test.ts` maps the new cancel write to it.
- **Notice kinds** (`flag_change_started`, `flag_changed`, `flag_change_lapsed`) need
  wording in **both** renderers: `apps/bot/src/notice-text.ts` and
  `apps/web/lib/notice-copy.ts`. The feed kind `flag_changed` carries old and new
  texture in its frozen payload (no coordinates).
- **Web vocabulary**: `apps/web` sees `clanTextures`-style names that `packages/roster`
  maps at its boundary. `copy-vocabulary.test.ts` bans "faction" in web identifiers.
- **Copy** (plain voice; `brand/02-verbal-identity.md`):
  - feed, on completion: "**[TAG] Name** fly new colors.", old flag shown next to new;
  - clan channel, on start: "New flag reserved. It's in your kit at the next restart.
    Raise it at your pole within 24h.";
  - clan channel, on completion and on lapse; leader DM on lapse;
  - guide ch. 8: "Rename" becomes "Rebrand", with a paragraph on the flag change.
    Numbers come through `guide-numbers.ts` (`FLAG_CHANGE_WINDOW_MS`, `OLD_FLAG_HOLD_MS`).

## 6. Testing

- **roster store**: start; cancel; one pending per clan; refused while pending;
  cooldown stamping (name+flag at submit, flag-only at completion, none on lapse or
  cancel); a founder and a rebrand racing for the same texture (one wins, one gets
  `flag-taken`); the free pool excludes pending and released holds and includes an
  expired hold before the sweep runs.
- **raise-tick**: the old flag defends while a change is pending; the pending flag
  completes the change; the pending flag completes it *and* defends during a siege;
  the pending flag revives a clan that went dormant meanwhile; a raise after `until`
  does nothing; a pending flag at another pole does nothing; replaying the completing
  event is idempotent.
- **sweep**: lapses an expired pending change (DM and notice queued); does not lapse a
  change whose completing raise is still unfolded; removes expired released holds.
- **stats**: a member's upkeep raises from before a rebrand still count after it.
- **supply kit**: delivers the pending flag.
- **migration**: backfill creates exactly one open `faction_textures` row per faction.
- **Gate**: `npx turbo run typecheck test --concurrency=1 --force`, expecting 32/32.

## Out of scope

- Changing the flag of a reserved or dormant clan.
- Showing a clan's historical flags on past season pages.
- Holding an old flag for the rest of the season.
