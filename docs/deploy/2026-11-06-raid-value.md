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

### 1b. Re-record any future raid-window skip

The window now opens Friday **14:00**, not 00:00. A skip recorded against the old
Friday 00:00 open no longer matches, so the weekend would open anyway. Before
applying anything:

    sudo docker compose exec -T postgres psql -U factions -d factions_live -X -c "select * from raid_window_skips where opens_at > now();"

Any row keyed at Friday 00:00 must be re-recorded with `pnpm raid:skip` at the Friday
14:00 instant (see `docs/deploy/raid-window.md`). Zero rows needs nothing.

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

First, the achievements side of the one retro row. The achievements tick watches
`raids.id`, so the inserted Z2→NDF row (raider chaandlr) will be read as a new raid
and could post a back-dated unlock. The team thresholds in
`packages/domain/src/achievements.ts` are `first_raid` (the clan's first scored raid),
`warpath` (25 raids) and `wide_net` (5 different clans); `flag_thief` is the raider's
own first scored raid lowering. Get Z2's and chaandlr's current counts:

    sudo docker compose exec -T postgres psql -U factions -d factions_live -X -c "select f.tag, count(*) as raids, count(distinct r.victim_faction_id) as distinct_victims from raids r join factions f on f.id = r.raider_faction_id where f.tag = 'Z2' group by f.tag"
    sudo docker compose exec -T postgres psql -U factions -d factions_live -X -c "select r.raider_dayz_id, count(*) as raids from raids r where r.raider_dayz_id in (select distinct payload->>'dayzId' from events where type = 'flag.lowered' and payload->>'gamertag' = 'chaandlr') group by r.raider_dayz_id"

Adding one raid crosses a threshold if Z2 has 0 raids (`first_raid`), 24 raids
(`warpath`), 4 distinct victims with NDF new (`wide_net`), or chaandlr has 0 scored
raids (`flag_thief`). If any applies, decide before applying whether that back-dated
unlock may post (or hold the achievements tick off, `ACHIEVEMENTS_TICK`, until
reviewed). No crossing needs nothing.

Then the dry-run output itself.

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

## 7. Switch the weekly award on, then start the bot

Do this **before** the bot starts, or the first week closes unpaid. `SERVER_EVENTS_CHANNEL_ID`
must already be set in `.env` (config refuses `RAID_AWARD_TICK` without it).

    cd /opt/clan-wars && cp -p .env .env.bak-$(date -u +%Y%m%dT%H%M%SZ)-raid-award
    grep -n '^SERVER_EVENTS_CHANNEL_ID=' .env      # must print a line
    echo 'RAID_AWARD_TICK=1' >> .env                # or edit an existing RAID_AWARD_TICK line to 1

Then start:

    sudo systemctl start clan-wars-bot
    journalctl -u clan-wars-bot -f

⚠️ Confirm the raid award is on: the startup output must contain
`raid award on: the top raiding clan's weekly weapon kit is granted and announced`, and
must **not** contain `RAID_AWARD_TICK is off`. If the off line is there, stop the bot,
fix `.env`, and start again. (The first paid week later logs `raid awards paid N`.)

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

Post the owner-approved text below (from the design conversation). It says the
weekend window closes **Sunday 14:00 UTC**, not Monday, and that standings were
recalculated. The changelog's release post covers the rules themselves.

**⚔️ Raiding is changing**

Every clan now has a **price**. A raid pays the price of the clan you hit.

- Every clan starts at **100**.
- 🔥 Each raid you land adds **+50** to your price, fading over 14 days.
- 🩹 Each time you're raided, your price **halves**, recovering over 7 days.
- 🐣 Clans under a week old are worth **0**. Raiding one still raises *your* price.
- 🟢 Hit a clan while someone from it is online: **×1.5**. Nobody home: **×0.75**.

Points are yours to keep. Getting raided never takes points away.

**Forgotten flags count.** If your clan raised its flag, anyone outside your clan who lowers it scores a raid on you, base or not.

**🏆 Weekly weapon kit** goes to the top-scoring clan's leader every week.

**New raid window:** Friday 14:00 → Sunday 14:00 UTC. This weekend's window closes Sunday 14:00 UTC, not Monday.

**#scoreboard** shows what every clan is worth right now. This season's standings have been recalculated under the new rules.

## 10. After the week closes (after 2026-11-08 14:00 UTC)

The bridging week (2026-11-02 Monday 00:00 → Sunday 14:00) closes at
`2026-11-08T14:00Z`. Once the bot's next interval has passed:

    sudo docker compose exec -T postgres psql -U factions -d factions_live -X -c "select r.season_id, r.week_start, f.tag, r.leader_discord_id, r.award_grant_id from raid_award_weeks r join factions f on f.id = r.faction_id where r.week_start = '2026-11-02T00:00:00Z'"

Exactly **one** row. Then confirm that row's `award_grant_id` is a single `weapon-kit` grant to that
leader's `leader_discord_id`:

    sudo docker compose exec -T postgres psql -U factions -d factions_live -X -c "select g.id, g.award_key, g.discord_id, g.granted_at from award_grants g join raid_award_weeks r on r.award_grant_id = g.id where r.week_start = '2026-11-02T00:00:00Z'"

Zero rows or no grant: check `journalctl -u clan-wars-bot` for `raid award:` lines. Two
rows is impossible (the insert is the idempotency guard); if seen, stop and investigate.
