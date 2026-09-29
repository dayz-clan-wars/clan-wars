# Phantom credited kills — deploy runbook

**The bug.** A bare `died.` is credited to a player when the victim's hits in the
`RECENT_HIT_WINDOW_S` (2 min) before it show them shot to `FINISH_HP_MAX` (25) HP or below
(`2026-09-10-credited-kills.md`). The window did not stop at the victim's *previous* death. A
player killed, respawned, and dead again inside two minutes — typically a fresh spawn killing
itself to respawn elsewhere — had the previous life's hits read as the new death's, so the same
killer was credited a second time. Reported from #kills on 2026-09-29: YrJustBad `killed`
RonaldRaygun552 at 19:52:00 and `finished` him at 19:53:18, a fresh spawn (water/energy 566.4, no
bleed) that had respawned at 19:52:11.

**Scale on 2026-09-29.** 71 `finished` kills since 2026-09-01; 65 had another death of the same
victim inside the window. Each is +1 kill for the killer and +1 death for the victim on every
board, K/D, streak, crown and the KotH standings. No bounty was claimed by one. Three finished
KotH sessions (ids 2, 3, 5) overlap them, with at most 2 per player per session against winning
margins of 34+ — no result changes, and KotH results are frozen, so nothing to amend.

**The fix.** `verdictOf` (`apps/bot/src/kills-tick.ts`) reads hits and knockouts only after the
victim's latest other death inside the window; a death in the same second is the same death
logged twice and leaves no evidence. Test: `apps/bot/test/kills-tick.test.ts` 3d.

No migration. Nothing reposts to Discord: the rebuild recreates rows with their original
`event_id`s, all below the feed cursors. The #kills posts already made stay.

1. **Take a `pg_dump` of `factions_live`.**

2. **Deploy the release** (the auto-deployer, or `sudo systemctl restart clan-wars-bot` after a
   manual checkout). From here new deaths are judged correctly.

3. **Count before** (expect ~65 on the 2026-09-29 data):

       select count(*) from kills k where k.cause = 'finished' and exists (
         select 1 from events e where e.server_id = k.server_id and e.type in ('player.killed','player.died')
           and e.payload->>'victimDayzId' = k.victim_dayz_id and e.id <> k.event_id
           and e.occurred_at between k.occurred_at - interval '120 seconds' and k.occurred_at);

4. **Rebuild kills** — the bot-package form (`pnpm rebuild:kills` fails from the workspace root):

       set -a; . ./.env; set +a
       cd apps/bot && npx tsx --eval '
         import { createClient } from "@factions/db"; import { rebuildKills } from "./src/kills-tick.js";
         const db = createClient(process.env.DATABASE_URL); console.log(await rebuildKills(db, 1)); await db.$client.end();'

5. **Verify:** re-run step 3's query — it must return **0**. `select cause, count(*) from kills
   group by 1` should show `finished` down by roughly that many and `died` up by most of them
   (a few become a different player's credited kill, judged on the new life's hits).

6. **Achievements.** Dry run first, read the list, then apply:

       pnpm --filter @factions/bot exec tsx ../../scripts/revoke-achievements.ts
       pnpm --filter @factions/bot exec tsx ../../scripts/revoke-achievements.ts --apply

   It re-runs the kill-derived rules (`REVOCABLE_KEYS`) against the rebuilt `kills`; a
   `would revoke` line is a badge only phantom kills earned.
