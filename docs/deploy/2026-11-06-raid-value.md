# Raid value scoring — deploy runbook (2026-11-06)

Raids pay the victim's live value (heat up, hits down, ×1.5 online / ×0.75 offline),
old flags count anywhere, the raid window runs Friday 14:00 → Sunday 14:00 UTC, and
season 3 is rescored under the new rules. Spec
`docs/superpowers/specs/2026-11-06-raid-value-scoring-design.md` (§6 is the rescore).

Every command on the host runs from `/opt/clan-wars` with `.env` sourced, in this form:

    cd /opt/clan-wars && (set -a && . ./.env && set +a && /home/acab/.local/bin/pnpm <script> <args>)

⚠️ Steps 2 to 7 run with the bot **stopped**. The rescore rewrites every season 3 raid
row's points. `raid-tick` doesn't lock `seasons`, so a raid that lands during the
apply would be priced against the pre-rescore rows and the standings would drift.

## 1. Release deploy

The release deploy (`clan-wars-deploy.timer` → `deploy/deploy-release.sh`) runs
migration **0073** (`raids.victim_online`/`away`, nullable rank columns,
`raid_award_weeks`) automatically. Wait for it to finish and confirm the new tag is
checked out before going on.

## 2. Stop the bot

    sudo systemctl stop clan-wars-bot
    systemctl status clan-wars-bot     # must read inactive (dead)

## 3. Dry run the rescore

    cd /opt/clan-wars && (set -a && . ./.env && set +a && /home/acab/.local/bin/pnpm rescore:season --season 3)

`--season` takes the `seasons.id`, like `rebuild:standings`. The first line prints
the id, the season **number** and the server. Make sure it says number 3 on the
50-slot server. If it doesn't, find the right id:

    sudo docker compose exec -T postgres psql -U factions -d factions_live -X -c "select id, number, server_id, started_at, ended_at from seasons order by id"

A dry run runs the whole rescore in one transaction and then rolls it back, so what
it prints is exactly what `--apply` would commit. It prints four sections:

- **retro raids**: old-flag raids the live consumer never scored, which `--apply`
  will insert. They post nothing: no war-log line, no clan notice.
- **raid rows**: every season 3 raid in `(first_lower_at, id)` order, with online or
  offline, the new points, and `(was N)` where they changed.
- **season points by clan**: the totals `season_standings` will hold.
- **disagreements**: lowers the replay reads differently from what is on record.
  Nothing is changed for these. They are printed for a human.

## 4. Check the dry run before applying

Don't apply unless all three of these hold:

- **Exactly one retro raid:** Z2→NDF at `2026-11-06T01:32:37Z`, online, **155** pts.
- **Totals:** Z2 **670**, NDF **333**, COCK **300**, VOLK **293**. Any raid that
  landed after `2026-11-06T12:00Z` (the time of the production scan these numbers
  came from) changes these. If they differ, find the extra rows in the **raid rows**
  list and check they explain the difference.
- **Every `disagreements` line is investigated.** The known one is:

      2026-10-30T17:47… XxBE4zyxX lowered Flag_Snake: recorded no raid row, classified VOLK→MMBA at base

  XxBE4zyxX (VOLK, per `membership_history`) lowered MMBA's flag at MMBA's declared
  base, and no raid row exists. The replay accepts any holding clan as a victim,
  because nothing records what MMBA's status was that day. The live consumer only
  accepted `active` clans. Check MMBA's status at that time (its `faction_events`
  activation/dormancy rows) before deciding. A base raid is never inserted
  retroactively. If the owner rules it should count, that's a separate decision.
  Any other line means the rules and the record disagree. Stop and find out why.

## 5. Apply

    cd /opt/clan-wars && (set -a && . ./.env && set +a && /home/acab/.local/bin/pnpm rescore:season --season 3 --apply)

The output must match the dry run. The apply rewrites only `raids.points` and
`raids.victim_online` on existing rows, inserts the retro row(s), and rebuilds
`season_standings`, all in one transaction. It never touches `week_start`,
`alpha_weeks`, `#war-log` lines or notices. Closed weeks are frozen history (owner
decision).

**It is safe to re-run.** A second `--apply` inserts nothing and changes no points.
Run the dry run again afterwards to confirm: it should list 0 retro raids and no
`(was N)`.

## 6. Prove the standings

    cd /opt/clan-wars && (set -a && . ./.env && set +a && /home/acab/.local/bin/pnpm rebuild:standings --season 3)

This rebuilds `season_standings` from the raid rows. It must report **no drift**: the
totals afterwards must equal the totals from step 5. Compare before and after with:

    sudo docker compose exec -T postgres psql -U factions -d factions_live -X -c "select f.tag, s.points, s.raids, s.times_raided, s.defenses from season_standings s join factions f on f.id = s.faction_id where s.season_id = 3 order by s.points desc"

## 7. Start the bot

    sudo systemctl start clan-wars-bot
    journalctl -u clan-wars-bot -f

## 8. Check the raid window

The window was open when this shipped (since Friday 00:00 under the old rule). The
new boundary is Friday 14:00, so the bot treats it as a fresh opening.

- **#server-events gets exactly one fresh "RAID WINDOW OPEN … closes" line**, naming
  the close as **Sunday 2026-11-08 14:00 UTC**. That's wanted: it corrects the
  "closes Monday" that was announced. There should be no "close" post, and base
  damage must not flip off.
- **The site's raid strip must not stay on "OPENING — not yet confirmed" for long.**
  It shows that until the bot records the flip at a restart slot (even UTC hours). If
  it's still there after the next slot, check `journalctl` for a raid-window failure
  and `OPS_CHANNEL_ID` for the alert.

## 9. Post the player announcement

Post the owner's announcement draft from the design conversation. It must say:

- this weekend's window closes **Sunday 14:00 UTC**, not Monday
- season 3 was rescored under the new rules
- one old-flag raid was added retroactively

The changelog's release post covers the rules themselves.
