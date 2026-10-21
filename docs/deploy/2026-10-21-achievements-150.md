# 150 achievements — deploy runbook

Part B of the 150-achievements work (spec `docs/superpowers/specs/2026-10-20-achievements-150-design.md`),
released as v2.7.0: 103 new achievements (150 earnable; Wanderer, Wolf Bait and Bear
Necessities retired, holders keep them), the Armory section on the wall, the
`achievement_summary` DM, and `pnpm announce:achievement-summary`.

- **Migration 0071** adds three indexes on `events` (`events_hit_victim_idx`,
  `events_hit_attacker_idx`, `events_type_player_idx`), all `IF NOT EXISTS`, no column or
  constraint. The release deploy applies it; nothing to do by hand.
- **`achievement_summary` needs no migration.** `clan_notices.kind` is plain text with no
  CHECK on it; the bot's `notice-text.ts` and the site's `notice-copy.ts` both render it.
- **Part A's runbook (`docs/deploy/2026-10-21-ingest-nasdara-fixes.md`) has already run** on
  production (2026-10-21, 02:4x UTC: repayload, reparse, rebuild:kills). Do not repeat it.
  Step 4 checks it.

⚠️ **The live tick MUST be off from before the tag lands until the backfill has exited 0.**
The live tick and `pnpm backfill:achievements` share the `achievements:*` watermarks and the
resume marker (`apps/bot/src/achievements/touched.ts`); that is the only interlock, there is no
lock. Worse than racing: a live tick running the new rules over a stale watermark would find
history (every player's 103 new tiles) and announce it one card at a time, to `#achievements`,
clan channels and DMs. The backfill credits it silently, and step 7 sends each linked player
ONE DM instead.

`ACHIEVEMENTS_TICK` is read once at startup (`apps/bot/src/config.ts`: on for `1` or `true`,
any case; anything else, or unset, is off) and lives in `/opt/clan-wars/.env`, which the unit
reads through `EnvironmentFile=`. A change takes effect on restart, and the deployer's own
restart keeps whatever `.env` says.

All commands run on the bot host, in `/opt/clan-wars`. Every SQL statement below is shown inside
its psql call; on this host `pnpm` is `/home/acab/.local/bin/pnpm`, and every script runs in a
subshell that loads `.env`.

**A helper for every restart below.** Paste it into the shell you run this runbook from (again
if you reconnect). Given the instant just before a restart, it waits up to 3 minutes for THAT
boot's `bot ready as`, then prints that boot's achievements line and the flag as the running
process actually has it. ⚠️ `--since`, never `-n 80`: a tail can show the PREVIOUS boot's
lines, and they say whatever the old `.env` said. The `/proc` read is the authority (the
unit's main process is pnpm, and the bot inherits its environment); the log line is the
cross-check.

    bootcheck() {
      timeout 180 sh -c 'until sudo -n journalctl -u clan-wars-bot --since "$1" --no-pager | grep -q "bot ready as"; do sleep 3; done' _ "$1" \
        || { echo "NO 'bot ready as' since $1: stop and read sudo -n journalctl -u clan-wars-bot --since \"$1\""; return 1; }
      sudo -n journalctl -u clan-wars-bot --since "$1" --no-pager | grep -E 'bot ready as|ACHIEVEMENTS_TICK is off|achievements tick on'
      pid="$(systemctl show -p MainPID --value clan-wars-bot)"
      if envs="$(sudo -n cat "/proc/$pid/environ" 2>/dev/null | tr '\0' '\n'; exit "${PIPESTATUS[0]}")"; then
        printf '%s\n' "$envs" | grep '^ACHIEVEMENTS_TICK' || echo 'ACHIEVEMENTS_TICK unset'
      else
        echo "could not read /proc/$pid/environ (MainPID $pid): the flag is UNKNOWN, treat it as on"
      fi
    }

⚠️ **The helper contains single quotes, so it cannot be wrapped in `ssh acab@regime.fi '…'`.**
Run it in a shell ON the host, or, from a workstation, send the definition, the `R` capture,
the restart and the `bootcheck` call in ONE invocation through a quoted heredoc (a function
defined in one `ssh` call does not exist in the next). For step 2, say:

    ssh acab@regime.fi 'bash -s' <<'EOF'
    bootcheck() { …the whole definition above… }
    cd /opt/clan-wars
    R="$(date -u '+%Y-%m-%d %H:%M:%S') UTC"; sudo -n systemctl restart clan-wars-bot; bootcheck "$R"
    EOF

1. **Take a `pg_dump` of `factions_live`.**

       cd /opt/clan-wars && sudo -n docker compose exec -T postgres pg_dump -U factions -Fc factions_live > ~/factions_live-pre-achievements-150.dump

2. **Turn the tick off, BEFORE the tag lands.** Back `.env` up, set the flag off (the one
   command works whether or not the key is already there), restart, check:

       cd /opt/clan-wars && cp -p .env .env.bak-$(date -u +%Y%m%dT%H%MZ)-achievements-off
       cd /opt/clan-wars && { grep -q '^ACHIEVEMENTS_TICK=' .env && sed -i 's/^ACHIEVEMENTS_TICK=.*/ACHIEVEMENTS_TICK=0/' .env || printf '\nACHIEVEMENTS_TICK=0\n' >> .env; } && grep -n 'ACHIEVEMENTS_TICK' .env
       R="$(date -u '+%Y-%m-%d %H:%M:%S') UTC"; sudo -n systemctl restart clan-wars-bot; bootcheck "$R"

   `grep` must print exactly one line, `ACHIEVEMENTS_TICK=0`. `bootcheck` must show
   `bot ready as …` and `ACHIEVEMENTS_TICK=0`. The bot running now is still v2.6.0, which logs
   nothing about this flag at startup (the `ACHIEVEMENTS_TICK is off` line arrives with this
   release), so here only the `/proc` line speaks to it.

   ⚠️ **If the `/proc` line is anything other than exactly `ACHIEVEMENTS_TICK=0`, STOP. Do not
   push the tag.** That includes `ACHIEVEMENTS_TICK=1` or `true`, `ACHIEVEMENTS_TICK unset`
   (off as far as the bot is concerned, but it means the edit never reached the process) and `could not read
   /proc …`. Something in `.env` the edit did not catch (an `export ACHIEVEMENTS_TICK=1`, a
   second line, a stray space), or a bot that did not come back, is the usual cause; fix it by
   hand and repeat this step.

3. **Deploy.** This is the release deploy: once the tag lands, `clan-wars-deploy.timer` runs
   `deploy/deploy-release.sh`, which stops the writers, dumps, applies 0071, and restarts the
   web app, the worker and the bot. Do not rebuild by hand. Write down the UTC time you push
   the tag (`date -u '+%Y-%m-%d %H:%M:%S'` just before `git push origin v2.7.0`) as `R`; it is
   after step 2's restart and before the deployer's. Watch the run finish:

       R='YYYY-MM-DD HH:MM:SS UTC'
       sudo -n journalctl -u clan-wars-deploy.service --since "$R" --no-pager -o short-iso --utc
       cat /var/lib/clan-wars/deployed-tag

   `deployed-tag` must read `v2.7.0`. The deployer restarted the bot itself, so there was no
   "just before" to capture; `R`, the time the tag was pushed, stands in for it (⚠️ not the
   run's finish time: the run starts the bot partway through, so its finish can fall after the
   bot's `bot ready as` and miss it). With `R` set as above:

       bootcheck "$R"

   Expect `bot ready as …`, `ACHIEVEMENTS_TICK is off: no achievements are being evaluated or
   announced.` (the line this release adds), and `ACHIEVEMENTS_TICK=0`. If you see
   `achievements tick on` or `ACHIEVEMENTS_TICK=1`, stop the bot now
   (`sudo -n systemctl stop clan-wars-bot`), fix `.env`, start it again and `bootcheck` before
   going on.

   And the migration:

       cd /opt/clan-wars && sudo -n docker compose exec -T postgres psql -U factions -d factions_live -X -c "
         select count(*) as migrations from drizzle.__drizzle_migrations;
         select indexname from pg_indexes where tablename = 'events' and indexname in ('events_hit_victim_idx','events_hit_attacker_idx','events_type_player_idx') order by 1;"

   72 migrations, three index names.

4. **Check Part A is done** (precondition, already satisfied on 2026-10-21; this only proves it).
   Hipster and Snagged read a hit's `cause`, and Pack Up and Comeback read the two
   event types Part A's reparse added:

       cd /opt/clan-wars && sudo -n docker compose exec -T postgres psql -U factions -d factions_live -X -c "
         select count(*) as hits_without_cause from events where type='player.hit' and not payload ? 'cause';
         select type, count(*) from events where type in ('player.conscious','item.packed') group by 1 order by 1;"

   `hits_without_cause` must be **0** and both types must be present with a non-zero count. If
   not, stop here and run Part A's runbook first: a backfill over hits without `cause` misses
   Hipster and Snagged, and since the backfill heads the watermarks, nothing goes back for them.

5. **Note the notice head `N0`**, before the backfill:

       cd /opt/clan-wars && sudo -n docker compose exec -T postgres psql -U factions -d factions_live -X -c "select coalesce(max(id), 0) as n0 from clan_notices;"

   Write it down. `N0` is how steps 6 and 9 find the notices queued from here on: ⚠️ an
   achievement notice's `occurred_at` is the unlock's `earned_at`, so a history unlock
   announced by mistake carries a PAST date, and a check on `occurred_at` would miss exactly
   the failure it is looking for. `clan_notices` has no created-at column; its id is the order
   of creation.

6. **Backfill, silently, then note `T`.** Evaluates every owner against all 150 rules with
   `announce: false`, then walks the clans a second time (Every Class Covered reads the
   members' class tiles, which the first walk had not written yet), and ends by heading every
   watermark, including B8's `achievements:classUnlocks`, so the live tick starts from there.
   It runs for minutes, so run it in `tmux` (installed on the host), detached, so a dropped
   ssh does not kill it; the log gets its exit status and the instant it exited, which is `T`:

       rm -f ~/backfill-achievements-150.log
       cd /opt/clan-wars && tmux new-session -d -s backfill150 'cd /opt/clan-wars && (set -a && . ./.env && set +a && /home/acab/.local/bin/pnpm -s backfill:achievements) > ~/backfill-achievements-150.log 2>&1; echo "EXIT=$?" >> ~/backfill-achievements-150.log; date -u +%Y-%m-%dT%H:%M:%SZ >> ~/backfill-achievements-150.log'

   (Without tmux, the same command line after `nohup sh -c '…' &` does the same.) Wait for it,
   then read the end of the log:

       until grep -q '^EXIT=' ~/backfill-achievements-150.log; do sleep 10; done; tail -n 5 ~/backfill-achievements-150.log

   Expect minutes, not seconds: every player is read against the `player.hit` history, which
   0071's indexes are for. The last three lines must be
   `backfill: N owners evaluated, N unlocks inserted, 0 rule failures, in Nms`, `EXIT=0`, and
   a timestamp. Write that timestamp down as `T`, the release instant; it is only `T` when the
   line above it is `EXIT=0`. Any `rule … failed for …` line, or any other `EXIT=`, stops the
   runbook: the tick
   stays off, read the error, fix, and run it again (it is idempotent by the unlock primary
   key). The root form resolves cleanly (`@factions/db` and `drizzle-orm` both resolve from
   the workspace root; it is `rebuild:kills` that does not), so no package-local form is needed.

   ⚠️ `T` is the backfill's EXIT, not its start. The backfill walks the owners one at a time,
   and heads the watermarks where they stood when it STARTED. A tile earned while it ran, by
   an owner it had not reached yet, is credited silently and dated before `T`, so the summary
   counts it; it is never announced live (the unlock already exists when the tick comes back),
   so a `T` taken at the start would lose it from both. A tile earned while it ran by an owner
   it had ALREADY evaluated is not written by the backfill: the first live tick after step 8
   re-reads the rows logged during the run, finds it and announces it like any other unlock.
   The summary does not count it (it did not exist at step 7), so nothing is counted twice.
   Likewise nothing earned between `T` and step 8 is announced twice.

   Check nothing was queued:

       cd /opt/clan-wars && sudo -n docker compose exec -T postgres psql -U factions -d factions_live -X -c "select count(*) as achievement_notices_since_n0 from clan_notices where kind = 'achievement' and id > <N0>;"

   Must be **0**.

7. **Queue the summary DMs.** One DM per linked player who holds any of the 103 new tiles from
   before `T`, counting their own tiles (not their clan's). Dry run first and read the count;
   put `T` from step 6 in for `<T>`:

       cd /opt/clan-wars && (set -a && . ./.env && set +a && /home/acab/.local/bin/pnpm -s announce:achievement-summary --before <T> --dry-run)
       cd /opt/clan-wars && (set -a && . ./.env && set +a && /home/acab/.local/bin/pnpm -s announce:achievement-summary --before <T>)

   The dry run prints `dry run: N would be queued, 0 already sent, …, links to
   https://dayzclanwars.com`; the real run `summary: N DMs queued, 0 already sent, …` with the
   same `N`. Check the link host in that line: the payload freezes it. Running it again queues
   nothing (`0 DMs queued, N already sent`). It only QUEUES `clan_notices` rows; the bot's
   notice poster sends them (step 9).

   ⚠️ Never run `pnpm backfill:achievement-notices` for this release: it announces every
   unlock one by one.

8. **Turn the tick back on.** Back `.env` up again, set the flag, restart, check:

       cd /opt/clan-wars && cp -p .env .env.bak-$(date -u +%Y%m%dT%H%MZ)-achievements-on
       cd /opt/clan-wars && { grep -q '^ACHIEVEMENTS_TICK=' .env && sed -i 's/^ACHIEVEMENTS_TICK=.*/ACHIEVEMENTS_TICK=1/' .env || printf '\nACHIEVEMENTS_TICK=1\n' >> .env; } && grep -n 'ACHIEVEMENTS_TICK' .env
       R="$(date -u '+%Y-%m-%d %H:%M:%S') UTC"; sudo -n systemctl restart clan-wars-bot; bootcheck "$R"

   `grep` must print exactly one line, `ACHIEVEMENTS_TICK=1`. `bootcheck` must show
   `bot ready as …`, `achievements tick on` and `ACHIEVEMENTS_TICK=1`.

9. **Verify.** Put `T` in for `<T>` and `N0` for `<N0>`:

       cd /opt/clan-wars && sudo -n docker compose exec -T postgres psql -U factions -d factions_live -X -c "
         select owner_kind, count(*) as new_key_unlocks from achievement_unlocks
           where key = any(string_to_array('lifer,devoted,globetrotter,performer,mime,full_repertoire,rps_champ,master_builder,comeback,sleeps_with_fishes,hundred_lives,burned,hipster,dog_food,bad_dog,chew_toy,road_rash,wipeout,squatter,rubble_rouser,renovator,fixer_upper,snapped,tripped,snagged,minesweeper,frag_out,barrel_hoarder,pack_up,sea_legs,minefield,warlord,long_shot,headhunter,knife_work,bare_knuckles,sledge,melee_mix,hit_and_run,roadkill,gun_cz75,gun_colt1911,gun_deagle,gun_derringer,gun_fnx45,gun_glock19,gun_luger,gun_mkii,gun_magnum,gun_makarov,gun_p1,gun_longhorn,gun_cz61,gun_mp5k,gun_ump45,gun_pp19,gun_mp18,gun_pm73,gun_vikhr,gun_izh18_shotgun,gun_izh43,gun_mp133,gun_saiga,gun_r12,gun_ak101,gun_ak74,gun_akm,gun_aks74u,gun_asval,gun_aug,gun_aug_short,gun_fal,gun_famas,gun_m16a2,gun_m4a1,gun_scarh,gun_scarl,gun_b95,gun_cz527,gun_cz550,gun_izh18,gun_lee_enfield,gun_mosin,gun_repeater,gun_ruger1022,gun_sks,gun_ssg82,gun_winchester70,gun_svd,gun_vss,gun_crossbow,gun_m79,class_pistols,class_smgs,class_shotguns,class_assault_rifles,class_rifles,class_snipers,full_armory,clan_armory,clan_renovators,clan_warband,clan_arsenal', ','))
           group by 1 order by 1;
         select count(*) as summary_dms, sum((payload->>'count')::int) as tiles_counted,
                count(*) filter (where posted_at is not null) as posted, count(*) filter (where failed_at is not null) as failed
           from clan_notices where kind = 'achievement_summary';
         select count(distinct u.owner_id) as linked_players_with_new_tiles from achievement_unlocks u
           join identity_links l on l.dayz_id = u.owner_id
           where u.owner_kind = 'player' and u.earned_at < '<T>' and u.key = any(string_to_array('lifer,devoted,globetrotter,performer,mime,full_repertoire,rps_champ,master_builder,comeback,sleeps_with_fishes,hundred_lives,burned,hipster,dog_food,bad_dog,chew_toy,road_rash,wipeout,squatter,rubble_rouser,renovator,fixer_upper,snapped,tripped,snagged,minesweeper,frag_out,barrel_hoarder,pack_up,sea_legs,minefield,warlord,long_shot,headhunter,knife_work,bare_knuckles,sledge,melee_mix,hit_and_run,roadkill,gun_cz75,gun_colt1911,gun_deagle,gun_derringer,gun_fnx45,gun_glock19,gun_luger,gun_mkii,gun_magnum,gun_makarov,gun_p1,gun_longhorn,gun_cz61,gun_mp5k,gun_ump45,gun_pp19,gun_mp18,gun_pm73,gun_vikhr,gun_izh18_shotgun,gun_izh43,gun_mp133,gun_saiga,gun_r12,gun_ak101,gun_ak74,gun_akm,gun_aks74u,gun_asval,gun_aug,gun_aug_short,gun_fal,gun_famas,gun_m16a2,gun_m4a1,gun_scarh,gun_scarl,gun_b95,gun_cz527,gun_cz550,gun_izh18,gun_lee_enfield,gun_mosin,gun_repeater,gun_ruger1022,gun_sks,gun_ssg82,gun_winchester70,gun_svd,gun_vss,gun_crossbow,gun_m79,class_pistols,class_smgs,class_shotguns,class_assault_rifles,class_rifles,class_snipers,full_armory,clan_armory,clan_renovators,clan_warband,clan_arsenal', ','));
         select count(*) as achievement_notices_since_n0, min(occurred_at) as earliest_earned from clan_notices where kind = 'achievement' and id > <N0>;"

   (The key list is `ACHIEVEMENTS_2026_10` in `packages/domain/src/achievements.ts`, all 103.)

   | Query | Expect |
   |---|---|
   | `new_key_unlocks` | non-zero for `player`; `clan` rows if any clan has a member with a class tile, kills, or ruin repairs |
   | `summary_dms` | **= `linked_players_with_new_tiles`** = step 7's `N`. The second can drift by one or two if someone links or unlinks between steps 7 and 9; the summary was counted at step 7 |
   | `posted` | climbs to `summary_dms` within a few minutes (the notice poster sends 50 per tick, every 10 s); `failed` is a player who has DMs closed |
   | `achievement_notices_since_n0` | **≈ 0** right after step 8: only tiles earned live since `T` (a Bad Dog window that closed since, say). Each notice is one row per target (public wall, clan channel, DM), so one unlock can be up to three. `earliest_earned` well before `T` means history is being announced: turn the tick off (Rolling back) and find out why |

   Re-run the last two a few minutes later: `posted` filling in, `achievement_notices_since_n0`
   still small. Then on the site: a profile's wall shows the new tiles dated in the past, and
   the Armory section under Combat opens with its own count.

## Notes

- **Globetrotter for a player already past 150 squares** is dated at their next position fix,
  not at the 150th square: the counter row that held their squares never recorded when it
  crossed 150 (`globetrotterAt` is new), and the crossing time cannot be recovered from
  history. A player who never moves again before `T` gets no Globetrotter from the backfill
  and no summary count for it; the live tick awards and announces it at their next fix.
- **Bad Dog announces late for a player who logs off inside its 10-minute window.** It is
  earned only once `BAD_DOG_SURVIVE_MS` has passed since the bite with no death, and the live
  tick only re-evaluates an owner when a new row touches them. A player who logs off at minute
  5 is looked at again only when they next appear; the card posts then, dated at the end of the
  window.
- **The `player.hit` backlog is read once, by the backfill.** `player.hit` is new among the
  tick's rule event types, and the backfill reads every hit and then heads the `events`
  watermark at the head it took when it STARTED. The first live tick after step 8 reads only the
  hits (and other rows) logged during the backfill, once, bounded by the tick's batch (1,000
  rows per source per pass). ⚠️ If the tick were turned on without the backfill, its first
  passes would walk the whole hit history in those 1,000-row steps and announce everything they
  found.
- **Hipster and Snagged depend on the hit's `cause`** (`EnviroDmg` for hot food,
  `BarbedWireHit` for wire), present on every hit since Part A's repayload. Step 4 is the check.
- **A gun nobody mapped** (a display name not in `firearms.ts`) counts toward no gun, class or
  Full Armory tile and logs a warning once per name per process; Arsenal still counts it. A
  warning in `journalctl -u clan-wars-bot` names the gun to add.

## Rolling back

Set `ACHIEVEMENTS_TICK=0` in `.env` (back it up first) and restart the bot. That stops all new
announcing. The unlocks the backfill wrote are permanent by design (unlocks are never revoked
by this work); to take the summary DMs back before they post, mark the unposted ones failed:

    cd /opt/clan-wars && sudo -n docker compose exec -T postgres psql -U factions -d factions_live -X -c "update clan_notices set failed_at = now() where kind = 'achievement_summary' and posted_at is null and failed_at is null;"

⚠️ Do not delete those rows: each one is the record that its player's summary was sent, and
deleting it makes the next `announce:achievement-summary` run queue it again. Migration 0071's
indexes are harmless to leave; the release's own rollback path is `deploy-release.sh`'s.
