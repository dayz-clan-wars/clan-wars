# King of the Hill: automatic trigger and player vote — deploy

Spec: `docs/superpowers/specs/2026-09-24-koth-auto-and-vote-design.md`

## What changes on the server

Nothing in the mission. Migration 0052 is additive: `koth_events.origin`
(defaulted `'admin'`, so the old bot's inserts keep working), two nullable
columns, `scheduled_by_discord_id` made nullable, and the tables `koth_votes`
and `koth_vote_voters`. The release deployer's stop-then-migrate order covers it.

## Order

1. Deploy the release with `KOTH_AUTO_TICK` and `KOTH_VOTE` unset. Check
   `/kothvote` answers "King of the Hill voting is switched off."
2. Set `KOTH_VOTE=true` in `.env`; `sudo systemctl restart clan-wars-bot`. The
   log says `king of the hill voting on`. On a night with 10+ online and 5+
   linked players in game, watch one vote open in `#server-events`, its tally
   move, and its result post 30 minutes before the restart.
3. Set `KOTH_AUTO_TICK=true` (and `KOTH_WEEKLY_CAP` / `KOTH_AUTO_MIN_POP` if not
   2 / 10); restart. The log says `king of the hill automation on (cap 2/week, floor 10)`.

## What to expect

- The first automatic KotH lands on the next record night, and that night's
  airdrop is skipped in its favour: `airdrop: skipped <slot>: koth` in the log.
  Because the record then becomes the airdrop's high-water mark, airdrops may
  not fire again for up to five days. Intended.
- A failed vote for a slot also stops the automatic trigger for that slot.

## Read-only checks

    docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c "
      select id, slot_at, location, state, detail from koth_votes order by id desc limit 5"
    docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c "
      select id, slot_at, origin, state, pop_at_decision, threshold from koth_events order by id desc limit 5"

## Turning it off

Unset either flag and restart. A vote already open is still closed at its
time, as `void` ("voting was switched off"), and its message edited; nothing
new is created.
