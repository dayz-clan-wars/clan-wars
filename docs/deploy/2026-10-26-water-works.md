# Water Works — deploy

Spec: `docs/superpowers/specs/2026-10-26-water-works-design.md`.

## What ships

- A migration adding the `well_awards` table (applied automatically on release, after the writers stop, like every other migration).
- Two achievements: Community Service and Water Works.
- `well-award-tick.ts`, which records one owed award per (player, well) roofed and pays it as a 7-day plate carrier to a linked player. Gated by `WELL_AWARD_TICK`.

## Before the release

1. The migration is automatic on release. Nothing manual to do first.
2. ⚠️ The first tick scans every roof in history, with two unindexed scans per roof in 500-roof transactions. Time one run against production before relying on it: first a read-only count of `base.built` roof events, then `EXPLAIN` on the scans. As of 2026-10-26 there are only 2 roof events, so this is cheap today and only matters if that grows.

## After the release

3. In `.env`, set `WELL_AWARD_TICK=true` and restart the bot. No channel is needed. While it is off the bot logs "WELL_AWARD_TICK is off" at startup, and wells still earn the achievements.
4. **Expected first run:** `well awards: 2 recorded, 1 paid`. RonaldRaygun552 is linked, so they are paid. helifighter06 is not linked, so their award is held until they link. There is no backfill step.
5. Past achievement unlocks arrive through the live achievements tick the next time each player is touched (any build or session close), and are announced normally. No backfill run.
6. Read-only check:

   ```sql
   select dayz_id, award_grant_id from well_awards;
   ```

   A null `award_grant_id` is a held award for an unlinked player.

## Things to know

- `well_awards.roof_event_id` is a foreign key to `events` with ON DELETE no action. The "delete the misparsed events first" procedure from other runbooks will be refused for a roof event that already has an award row. Delete or settle the `well_awards` row deliberately first.
- A roof whose brick is ingested after the cursor has passed the roof (only possible on a historical ADM re-ingest) is never recorded. After a re-ingest, rewind the `well-award-consumer` cursor to 0. The unique index on (player, well) makes a rewind safe: no double pay.
