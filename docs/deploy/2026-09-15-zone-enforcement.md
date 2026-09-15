# Base-zone enforcement (increment 11) — deploy runbook

Migration 0036 adds `zone_incidents`, `zone_incident_participants`, `zone_placements`,
`zone_violations` and `bans`. Nothing is dropped, nothing is altered — every statement is
`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD CONSTRAINT` (foreign keys only) or
`CREATE INDEX IF NOT EXISTS`. **The bot does not need stopping to apply it**: old code
never selects a column that does not exist yet, and the new tables are inert until the
enforcement tick is turned on.

The bot gains three new pieces, all gated so a deploy can land them dark: `zone-tick.ts`
extends the existing map zone consumer to also watch `base.built`, `base.dismantled` and
boost-item `item.placed` events for non-members inside a declared base's watch zone,
opening/extending a `zone_incidents` row and recording each act in `zone_violations`;
`violation-tick.ts` closes an incident once it has gone quiet for
`VIOLATION_INCIDENT_GAP_MS` and DMs every participant a warning; `ban-tick.ts`
reconciles `bans` rows against Nitrado's ban list (apply, expire, lift), gated on
`ENFORCEMENT_TICK` and `BAN_DRY_RUN`. The officer-facing "press charges" read/write lives
in `packages/roster/src/internal/incidents.ts`, reachable from `/base` on the site and
in Discord.

1. **Apply migration 0036.** Tables and constraints only (see above) — the bot may keep
   running while it applies. Use the one-off runner from
   `docs/deploy/2026-09-05-declarations.md` / `pnpm db:migrate` per
   `docs/deploy/2026-09-14-db-migrate.md`. Verify the five tables exist:

       select tablename from pg_tables
       where schemaname = 'public'
         and tablename in ('zone_incidents','zone_incident_participants','zone_placements','zone_violations','bans');

2. **Deploy with `ENFORCEMENT_TICK=1` and `BAN_DRY_RUN` unset (dry-run).** `banDryRun`
   defaults to `true` unless `BAN_DRY_RUN` is the exact, trimmed, lowercased string
   `"false"` — so simply not setting it is the dry-run deploy. `ENFORCEMENT_TICK` also
   requires `NITRADO_TOKEN` to be set (config load refuses to start otherwise, same as
   `RESTART_SCHEDULE`), even though a dry-run tick never calls Nitrado — it is the same
   token the restart schedule and the ingest worker already use. A dry-run ban row is
   still written and still transitions status (`pending` → `applied`/`expired`), so the
   whole audit trail is real from day one; only the Nitrado call is skipped.

3. **Watch for a week.** Two things to check, daily:

   - **`zone_incidents` rows match real events.** Pick a few closed incidents and read
     their `zone_violations` rows against the ADM log for that time and place — confirm
     a genuine dismantle, gate build or boost stack, not a false positive.
   - **`zone_placements` for farms wrongly promoted to stacks.** This is where
     `BOOST_STACK_RADIUS_M` (1.5 m) and `BOOST_STACK_MIN_RISE_M` (0.5 m) in
     `packages/domain/src/rules.ts` get tuned — they are code constants, not env vars, so
     a change here is a small redeploy, not a config flip. Query for incidents whose only
     violations are `kind = 'stack'` and eyeball the placements' spacing and rise:

           select v.incident_id, v.what, v.x, v.y, v.z, v.occurred_at
           from zone_violations v
           where v.kind = 'stack'
           order by v.incident_id, v.occurred_at;

     ⚠️ **A watch item found during implementation, independent of terrain slope:** a
     player's altitude (`y`) can move several metres while placing items only ~1.5 m
     apart horizontally simply by **stepping between a raised floor and the ground inside
     a multi-level base** — walking off a deck onto the ground below moves `y` by the
     deck's height, not by climbing anything. A real observed example from a live ADM
     file: four barrels placed within roughly 1.5 m horizontally with the player's `y`
     moving 224.8 → 228.0 — a 3.2 m rise from floor level changes alone, well past
     `BOOST_STACK_MIN_RISE_M`. Barrels cannot be stood on and are not in
     `BOOST_ITEM_CLASSES`, so this specific case is already excluded, but the same
     floor-to-ground stepping pattern applies to any boost-item placement near a raised
     structure and is the false positive to look for first if `BOOST_STACK_MIN_RISE_M`
     looks too eager on a multi-level base.

4. **Before flipping `BAN_DRY_RUN=false`:**

   - Confirm no `bans` row is `status = 'applied'` yet:

         select count(*) from bans where status = 'applied';

     (Expected: 0, since dry-run never reaches Nitrado — `applied` here just means the
     tick decided it would have banned; confirm none are real by cross-checking
     `dry_run = true` on every row instead if any exist.)

   - Confirm the tick's `since` bound means the dry-run backlog cannot fire. `banTick`'s
     apply arm only considers `pending` rows with `bannedAt >= now - BAN_APPLY_LOOKBACK_MS`
     (24 h); anything older is aged out to `failed` by the arm that runs immediately
     before it, not silently sent. This is what stops the entire week of dry-run bans from
     firing at Nitrado in the first live tick — nothing manual to do here beyond knowing
     it is true before flipping the flag.

5. **Rollback: set `ENFORCEMENT_TICK=0`.** ⚠️ Do **not** roll back by re-enabling
   `BAN_DRY_RUN` while any ban is `status = 'applied'` — the expire arm would then close
   that row without ever calling Nitrado, orphaning its ban-list entry **permanently**. An
   orphaned account hash cannot be shed by renaming. If a real ban needs undoing, set its
   row to `lift_pending` and let the next tick's lift arm remove it from Nitrado properly.

## Verify

Watch `journalctl -u clan-wars-bot -f` for `zone watch: …` / `violation tick: …` / `ban
tick: …` lines each interval. A `/base` officer's "press charges" action should be visible
end to end: a closed, unreported incident inside `VIOLATION_REPORT_WINDOW_MS` (7 days) of
closing shows on `/base`, pressing charges inserts `bans` rows, and (once `BAN_DRY_RUN` is
`false`) a subsequent `ban-tick.ts` run applies them to Nitrado.
