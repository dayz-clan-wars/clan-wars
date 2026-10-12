# Carry bases through the wipe — design

Date: 2026-10-12
Status: approved in conversation, pending spec review

## Intent

While Chernarus waits for its wipe day, players should be able to claim a spot:
a clan from Livonia moves its base by one member raising a flag, and solo
players and new clans work as they always have. After the map wipe, each
clan's supply kit spawns where its flag stood before the wipe, so the clan
starts building there instead of hunting for a pole and re-raising.

What the user said:

- Only bases raised on Chernarus count. Livonia bases are meaningless on this
  map (different coordinates) and are dropped.
- Solo bases and three-player founding work as before. A clan that exists from
  Livonia needs only one member to move its base.
- After the wipe, the clan's new pole is adopted automatically when it is
  raised near the carried-over spot (chosen over spawning the pole, or a
  leader confirmation).

## Production state (read 2026-10-12, `factions_live`)

- Five declarations, all from September (the Livonia era): SKULL (active),
  ADM, VOLK, Z2, WOOKI (dormant). None declared on Chernarus.
- `faction-supplies.json` (uploaded 2026-10-12 17:50 UTC) therefore spawns
  SKULL's full kit and four clans' flags at Livonia coordinates on the
  Chernarus map.
- One raise on Chernarus since the move: a VOLK member, `Flag_White`, at
  11563, 14742, 2026-10-12 17:48 UTC. Ignored, because VOLK still holds its
  Livonia declaration.
- Season 1 open since 2026-09-08, so the wipe's one-week guard does not block.

## 1. Clear the Livonia bases (one-off script)

`pnpm clear-bases --server <id> --before <ISO> [--dry-run]`
(`scripts/clear-bases.ts` calling `clearBasesBeforeTx` in `apps/bot/src/clear-bases.ts`).

- Releases every declaration on the server with `declared_at < --before`
  through the existing `releaseTx` (`packages/declarations`), the same path
  disband and unlink use, so no new writer of `declarations` appears.
  Intruder sightings and zone incidents go with each row (FK cascades; a ban
  keeps its row with `incident_id` set null, per migration 0036).
- For each clan whose declaration was deleted, clears `flag_down_since`,
  `flag_down_by_dayz_id` and `disband_warned_at`, the same fields `wipeTx`
  clears. Roster, status, Discord role and channel are untouched.
- Takes `lockDeclarations` first (lock order §4.12), in one transaction.
- `--before` is required with no default. `--dry-run` prints the rows it would
  delete (owner, declared_at, x/z) and rolls back.
- Refuses a `DATABASE_URL` not ending in `/factions_live` unless
  `--allow-test-db` is passed, the same guard as `wipe` and `launch`.
- Run once against production with `--before 2026-10-08T00:00:00Z`, after the
  user has seen the dry-run output.

Effect: every Livonia clan is in the "no base" state. The existing
`raise-tick` path then binds a clan on one full member's `Flag_White` at a
free pole (reviving a dormant clan). On the next sweep the misplaced kits
leave `faction-supplies.json`. No raise-tick change is needed for this part.

The VOLK raise from 2026-10-12 has already been consumed by `raise-tick`'s
cursor and is not replayed. VOLK re-raises after the cleanup.

## 2. The wipe keeps bases (`wipeTx`, `apps/bot/src/wipe.ts`)

- Migration: `declarations.carried_since timestamptz NULL`. Null means the
  base sits on a pole that exists. Non-null means the base was carried
  through a wipe and its pole has not been re-established.
- `wipeTx` stops deleting declarations. It sets `carried_since = wipe at`
  on every declaration of the server instead, including ones already
  carried (a clan that never adopted keeps its spot through a second wipe).
- Everything else `wipeTx` does is unchanged: weeks and season closed, next
  season opened, identity holds ended, pins and intruder sightings deleted,
  pole grace stamped, `flag_raised` cleared, `flag_down_*` and
  `disband_warned_at` cleared, one-week no-op guard.
- The supply sweep reads coordinates from declarations, so kits spawn at the
  carried spot with no change to `supply-tick` or `supplies.ts`.
- Solo declarations carry over too (same rule, no kit; solo players get no
  kit today).
- This applies to every future wipe on the same map. A map change is handled
  by section 1's script, not by the wipe.
- Docs: update the runbook text in the target-state spec §8.5 note and
  `CLAUDE.md`'s wipe line to say bases are kept and marked carried.

## 3. Adopting the new pole (`apps/bot/src/raise-tick.ts`)

A new branch, checked first among the undeclared-pole branches (before the
`Flag_White` bind and the clan-texture branch):

- The raiser is a full member of a holding clan (active or dormant) whose
  declaration has `carried_since` set.
- The texture is `Flag_White` or the clan's own texture.
- The raised pole is within `CARRIED_ADOPT_RADIUS_M = 100` (new constant in
  `packages/domain/src/rules.ts`) of the declaration's x/z (2D distance, as
  the spacing rule measures).

Then, in the same transaction:

- Lock the clan's `factions` row FOR UPDATE (§4.12: `factions` before
  `declarations`).
- Call a new `adoptCarriedTx` in `packages/declarations`, beside `declareTx`.
  CLAUDE.md holds that `declarations` has one writer module because the 200 m
  rule is a query under a lock, so the adopt write lives there and shares
  that query rather than respelling it. It takes `lockDeclarations`, checks
  `MIN_BASE_SPACING_M` (200 m) against every other declaration on the
  server (ignoring the clan's own), and re-points the row in place:
  `pole_key`, x/y/z, `evidence_event_id` = the raise (`evidence_ceremony_id`
  null), `declared_at` = the raise time, `carried_since` null. An update in
  place, not release-then-declare, so the clan never passes through "no base"
  (which would drop its kit for a sweep and let the white-flag bind race it).
- A refusal (spacing, or the row is no longer carried) is logged with
  `console.info`, as `bindTx` does, and nothing else is written.
- On success, append a `rebound` faction event and revive a dormant clan, as
  `bindTx` does.

Any other raise falls through to today's rules unchanged. A clan flag
further than 100 m away proposes a rebind for leader confirmation (the clan
still holds a declaration). A white flag further away does nothing for the
clan, because the existing white bind requires no declaration.

While a declaration is carried, its old `pole_key` never sees events, so raid
and defense logic have nothing to act on. The watch zone (`zone-tick`, 100 m
around the declaration's x/z) does keep working at the carried spot, which is
intended: the clan's kit is sitting there. A leader-confirmed move goes
through `releaseTx` then `declareTx`, so the new row starts with
`carried_since` null without any change there.

## Out of scope

- Spawning the `TerritoryFlag` pole in the kit.
- Kits for solo players.
- Player-facing guide text and the announcement (follow-up, written to
  `brand/02-verbal-identity.md`).
- Any "waiting for wipe" server state. None is needed: the rules above are
  the same before and after the wipe.

## Testing

- `clearBasesBeforeTx`: deletes only rows before the cutoff, clears the
  owners' `flag_down_*`, leaves rosters and statuses, dry run writes nothing,
  database-name guard.
- `wipeTx`: declarations kept with `carried_since` = wipe at; existing wipe
  assertions still pass apart from the one that expected deletion.
- `raise-tick` adopt branch: white within 100 m adopts; clan texture within
  100 m adopts; 101 m falls through; non-member and pending member do
  nothing; dormant clan revived; spacing conflict refused; declaration not
  carried falls through to existing paths.
- A leader-confirmed move of a carried base leaves `carried_since` null.
- Supply generation for a carried declaration emits at the carried
  coordinates (regression check, no code change expected).
