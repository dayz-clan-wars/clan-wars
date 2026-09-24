# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- The map works without a mouse. Every marker can be reached with Tab and opened
  with Enter, and each one is named with its age. A new "On the map" list under
  Layers names you, your base, intruders, bounties, clanmates and pins by grid
  square, and jumps to each one.
- "Pin here" drops a pin at the centre of the map, so you no longer need a
  right-click or a long-press. Move the map and the pin follows the cross until
  you drop it. After you drop or delete a pin, the map opens back on that pin's
  grid square instead of the whole world.
- The map no longer closes an open popup every five minutes. A pin note, or a
  half-confirmed Delete, now stays open through a refresh unless that pin itself
  changed.
- The map says "Loading the map…" while it loads. If the first load fails, it
  says so, offers Try again, and retries within 15 seconds instead of five
  minutes. It stops polling while the tab is in the background and refreshes as
  soon as you come back.
- The zoom buttons are 44 px and stay dark on hover and when disabled, and a
  popup's close button is 44 px. Notices no longer cover the zoom buttons, can
  be dismissed, and do not come back when you reload.
- The raid and restart timers now show above the map instead of being hidden
  under it.
- Intruder, bounty and danger markers are drawn in a brighter rust that stands
  out from the terrain. Popups stay clear of the layers panel and the desktop
  bar. The pin form takes keyboard focus, closes on Escape, and labels its note.
  Leaflet's animations stop when your device asks for reduced motion.
- The map's empty and no-fix lines wait for the map to be ready before showing,
  and popups skip their auto-pan when the device asks for reduced motion.

## [1.38.0] - 2026-09-24

### Changed

- King of the Hill: `/koth schedule` now takes a required `prize` — any award in the
  catalogue, or "No prize". Every post names the event's prize. With no prize the top
  killer on the hill wins outright, linked on Discord or not, and nothing is granted.

## [1.37.0] - 2026-09-23

### Added

- King of the Hill: `/koth schedule` turns one restart window into a KotH session at a
  Livonia town — hill spawns, KotH loadouts, infected and predators on the hill — and
  grants the Plate Carrier to the top linked killer within 500 m.

## [1.36.1] - 2026-09-23

### Changed

- CI checks on pull requests finish faster: the packages' tests now run side by side,
  and CI's throwaway test database no longer waits on the disk after every write.
- Test runs no longer print tens of thousands of database notices, so a real failure
  is easy to find in the CI log.
- The test that guards how quickly the bot checks for dormant clans now tests realistic
  data. It had been passing only because its table was empty, so a slowdown could have
  shipped unnoticed. Production was checked at the same time and is using the fast path.

### Fixed

- When a timed ban ends, `#bans` now says the player was unbanned. It used to repost
  the original "banned until" line, so a served ban looked like a second ban.

## [1.36.0] - 2026-09-23

### Added

- Pitching a tent inside a watch zone that isn't yours is now caught like building
  there. The base's owner is told, the player who pitched it is warned, and if the
  owner presses charges it is sentenced as a breach. One tent is enough, because a
  tent is tall enough to climb a wall on its own.

## [1.35.1] - 2026-09-23

### Fixed

- `/bounty place` now finds every player the server has seen. Players who had linked
  their Discord account were missing from the autocomplete, and typing their name out
  in full said the server had never seen them.

## [1.35.0] - 2026-09-23

### Added

- Bounties: admins can put a bounty on a player with `/bounty place`. It is announced in
  the server events channel, DM'd to the player, and shows their last known position on
  everyone's map while they are online, until another player kills them (friendly fire
  and Hub kills don't count) or they have served their online time. A new board, Most
  bounty kills, counts who collects them. Off until `BOUNTY_TICK` is set.

## [1.34.0] - 2026-09-22

### Added

- No combat at the Fast Travel Hub: a hit, a kill or a trap placed there is an automatic
  one-hour ban (`HUB_BAN_TICK`). Firing back within two minutes of being hit is
  self-defence. The ground below the Hub is not the Hub.

### Changed

- A kill at the Hub counts for nothing — boards, K/D, streaks, achievements and the
  Discord feeds — including every Hub kill already on record. Achievements that only Hub
  kills earned are revoked. The kill feed and the player timeline still show Hub kills,
  marked.
- The ban DM names the real reason for every ban (it said "base-zone enforcement" for
  all of them, PC bans included).

## [1.33.0] - 2026-09-22

### Added

- Event awards. An admin hands an event winner an award with `/award grant`. The winner
  gets a DM linking to `/awards/<id>`, chooses their gear there, and marks a spot in game
  with an emote sequence. The award respawns at that spot every restart for its
  duration. The first award is a plate carrier (vest, pouches and holster, each in any of
  six colours) for one week. `/award revoke` and `/award list` manage open awards.

## [1.32.0] - 2026-09-22

### Changed

- The airdrop, raid-window and vehicle-wipe notices in #server-events are rewritten
  short, in a military-comms register: an all-caps headline naming the place, then one
  line of facts. The airdrop notice no longer explains the restart (it posts while the
  server is up, and the old wording read as though it were down) and no longer mentions
  the container's color at all.
- An airdrop now needs the server to be at or above its own five-day high point, rather
  than above a fourteen-day 90th percentile. The old bar sat below the server's recent
  peaks by construction, so a merely-average evening cleared it and drops landed on dead
  sessions. Replayed against three weeks of real history the new rule fires about as
  often but only at genuine peaks. Expect longer, lumpier gaps between drops: one busy
  night sets the bar for the next five days, and a quiet week correctly gets nothing.
- Friendly fire no longer counts anywhere except the friendly-fire board. Shooting a
  clanmate earns no kill, no killstreak, no K/D and no place on the killers board, and
  it costs the victim nothing either: it is not a death, so it cannot dent their deaths
  board or their ratio. Previously a teamkill counted as a kill for the shooter on the
  killers board and as a death against the victim everywhere.
  ⚠️ This recomputes from existing records, so published numbers move the moment it
  ships. Anyone who has teamkilled will see their kills fall; anyone who has been
  teamkilled will see their deaths fall and their K/D rise.
- A friendly-fire death no longer breaks the victim's killstreak, so a clanmate can no
  longer end your run by shooting you. Your profile, the #killstreaks channel and the
  streak achievements each used a different rule for this and could report three
  different numbers for the same run; they now agree.
- The recommended `AIRDROP_MIN_POP` in the airdrop runbook moves from 5 to 6, on the
  evidence of the same replay. The code default is unchanged.

## [1.31.0] - 2026-09-22

### Changed

- Every Discord message states time with live `<t:…>` timestamps instead of a baked
  clock, so a posted notice stays correct without an edit.
- Clan names and gamertags across Discord link to their pages on the site.
- The raid window and weekly vehicle wipe notices post to `#server-events` beside the
  airdrops; `#announcements` is now human-only.

## [1.30.0] - 2026-09-21

### Added

- Airdrop events: when the server is genuinely busy, the bot picks one of 16 Livonia
  locations and one of three container colours, announces the location before a
  restart, places the drop for exactly one session, and takes it away again. At most
  `AIRDROP_WEEKLY_CAP` a week, never within 24 hours of the last one, and never on a
  week with no good moment in it.
- `/airdrop place` for admins: put a drop at the next restart by hand. It announces
  and expires like any other, and does not count against the weekly cap.
- A drop that could not be placed is now called off in the same channel it was
  announced in, once, so nobody is left waiting at a location with their keys.

## [1.29.1] - 2026-09-20

### Changed

- The Bear flag's clan colour is now red, and the BrainZ flag takes the olive
  green Bear had. Clan roles in Discord recolour themselves on the next tick.

## [1.29.0] - 2026-09-19

### Changed

- The booster kit page is rebuilt. Your nine pieces are a grid you can see at a
  glance, and tapping one opens a searchable picker grouped by item family.
- Picks save on their own. The Save button is gone, and a bar at the bottom of
  the screen confirms each save with an Undo beside it.
- A bar under the top bar always says where your kit lands: the grid square,
  the nearest town and a link to the map, or that you have no spot yet.
- The placement sequence now shows which emotes the server has already seen,
  ticking down its own clock, the same card you met when you linked.
- The kit page needs JavaScript now, in exchange for saving as you pick.
- A pick that does not save now says so at the bottom of the screen, where the
  saves are confirmed, instead of in a line at the top you would have to scroll
  up to find.

### Added

- Cancel an open placement sequence without drawing another one. Your current
  spot is left exactly where it is.

### Removed

- The kit page no longer mentions the clan armband. It is still added to your
  kit as a tenth piece, derived from your clan's flag.

## [1.28.2] - 2026-09-19

### Fixed

- Booster kits spawn just above the spot you marked instead of level with it.
  Some gear was ending up stuck in the floor where you could not pick it up.

## [1.28.1] - 2026-09-19

### Fixed

- Picking an item near the end of a strip no longer throws the whole kit page
  sideways into empty space.

### Changed

- The kit picker has one Save button at the bottom of the page instead of a
  separate one on every row. Pick all nine, then save once.
- Your booster kit now sits directly under "Your account" on your player page
  instead of further down the page.

### Added

- The kit page warns you if you try to leave with picks you have not saved.
- The site notice about choosing a kit now has a button that opens the picker.

## [1.28.0] - 2026-09-19

### Added

- Booster kits show what you are choosing. Every item in the picker now has a
  picture, and each slot is a strip of tiles instead of a dropdown.
- A booster who has not chosen a kit gets one Discord message about it, with a
  button that opens the picker.

### Changed

- The kit is reached from your own player page instead of the top menu.
- 27 items were named wrong in the picker and are corrected. The Ski Masks were
  labelled Balaclavas, the Hunter Boots were labelled Combat Boots, and the
  Combat Backpack was labelled an Assault Backpack.

### Fixed

- Two different masks were both labelled "Balaclava (White)", so they could not
  be told apart.

## [1.27.0] - 2026-09-19

### Added

- Server boosters can now pick a nine piece outfit on the site at `/kit` and place it
  in game with a short emote sequence. Once placed, your kit spawns back at that same
  spot every time the server restarts. It is a pile of clothing on the ground and it is
  loot like any other loot. Stop boosting and the kit stops spawning at the next restart.

## [1.26.1] - 2026-09-19

### Fixed

- A raided clan can always re-raise. Your flag keeps spawning at your pole
  while your flag is down, and while you are dormant. Before this, losing
  your flag also stopped the spawn that was the only place your flag came
  from, so a clan that lost the spares on the ground had no way to raise
  and ran out the 24 hour clock with nothing it could do. The supply crate
  still stops when your flag comes down. That part is the cost of a raid.

## [1.26.0] - 2026-09-19

### Added

- Every notice the bot sends you now has a home on the site. There is a
  bell at the top of the page with a count on it, and a notifications
  page behind it with everything the bot has told you, plus everything
  it posted to your clan channel since you joined. Miss a DM and you can
  still read it.
- You can act straight from a notification. An invite can be accepted or
  declined, a no-confidence vote cast, and a proposed pole move reviewed,
  without going looking for the right page.

## [1.25.0] - 2026-09-18

### Added

- The top of the site now counts down to the next server restart, in
  minutes and seconds, beside the raid timer. It turns gold for the last
  ten minutes so you get the warning while there is still time to stash
  your loot and find cover. The countdown only appears when the server is
  actually on a restart schedule.

### Changed

- The raid line at the top of the site is now two timers side by side.
  The left one is the raid window, with a rule along the bottom that fills
  as the window runs down, and the whole panel goes rust while raiding is
  open so you can tell at a glance without reading it. Both timers stay
  side by side on a phone.

## [1.24.1] - 2026-09-18

### Fixed

- The field guide channels can now be renamed to add icons without the
  bot undoing it or posting a second copy of the guide beside them. It
  recognises a channel by its chapter rather than its exact name, so
  what the channels are called is yours to decide.

## [1.24.0] - 2026-09-18

### Added

- Every clan now has its own colour in Discord. Your name shows in your
  clan's colour everywhere you appear, so you can read a member list or a
  channel and see who runs with who. Each of the 33 flags has its own
  colour and no two clans ever share one, so the colour is yours for as
  long as you hold the flag. Claim a different flag and you take that
  flag's colour with it.

## [1.23.0] - 2026-09-18

### Added

- The nine leaderboards now live in Discord as well as on the site, one
  message each in the leaderboards channel, in the same order and showing
  the same top ten. They update themselves in place, so the channel stays
  nine messages and never fills with reposts. The numbers are the current
  season, the same as the site and the same as the nine crown roles, so
  what you see on the board is who is wearing the role.

## [1.22.0] - 2026-09-18

### Added

- Nine new roles, one for each leaderboard, worn by whoever is #1 on it:
  Top Raider, Top Killer, Best K/D, Best Killstreak, Longest Kill, Top
  Builder, Most Play Time, Most PVP Deaths and Most Friendly Fire. They
  move on their own within a few minutes of the kill, raid or build that
  moves them, so taking the top spot on the board takes the role off
  whoever had it. If two players are dead even at the top, both wear it.
  The boards are scored on the current season, so every season the nine
  crowns are up for grabs again from scratch. Link your account with
  `/link` if you have not: an unlinked #1 leaves the role sitting empty
  rather than handing it to second place.

## [1.21.0] - 2026-09-18

### Added

- Enforced bans and unbans on the server now post to a public `#bans`
  channel — banned, unbanned because the ban was served, and unbanned
  because a linked account was found. Nothing about a dry-run test ever
  posts here, only real ones.

## [1.20.0] - 2026-09-18

### Added

- **Notice, ahead of it being switched on:** this is an Xbox server, and
  playing it from a PC is going to require a linked account. Once it is on, a
  PC player who has not linked is banned — including one who has a link in
  progress, because otherwise a half-finished link could be restarted forever
  as a way of never linking at all. Starting a link then lifts that ban once,
  so they can get back in and perform the three emotes linking asks for. It
  lifts it once only, ever. Console players are unaffected, and so is any PC
  player who has already linked. If you play on PC, link before this is
  enabled and nothing changes for you.

## [1.19.0] - 2026-09-18

### Changed

- Public bases on the map are now a small marker like every other layer,
  instead of the clan flag that last flew there. They were the one marker
  drawn at a different size and the one carrying an image, so a pole nobody
  holds stood out more than your own base. It is now the same flag-on-a-pole
  shape as your base, hollow and muted rather than gold: claimed against
  unclaimed, at a glance. Which clan's flag once flew at an abandoned pole is
  no longer shown, or sent to the page at all.

- Corrected the release-announcements runbook and design notes after the real
  v1.18.0 deploy showed the deployer hook can't fire on the deploy that ships
  it: `deploy-release.sh` re-execs from a private copy of itself before moving
  the tree to the new tag, so the deployer that ships tag N is always tag
  N-1's — a change to that script never takes effect on its own release. The
  first backfill of `release_announcements` had to be run by hand for that
  reason, and it was a one-time step: v1.18.1 was the first release whose
  notes the deployer queued on its own, confirmed in the deploy journal.
  Also fixed a miscount that would have recurred: a release announces itself,
  since `release:sync` reads the checkout at the new tag, whose changelog
  already carries that release's own section — the queued count is every
  dated, non-`[WITHDRAWN]` changelog section at that moment, not a fixed
  number (24 at v1.18.0, not the 23 originally documented).

## [1.18.1] - 2026-09-18

### Fixed

- The map's abandoned-bases layer no longer lists a flagpole that stands
  inside a clan's declared base. A pole left standing from an earlier season
  can sit metres from a base someone has since declared, and it was only ever
  matched against the one pole a clan had declared on. Any leftover pole
  within 100 m of a declared base is now left off the layer.

## [1.18.0] - 2026-09-18

### Added

- Every release announces itself in Discord. `CHANGELOG.md` is the source:
  `deploy-release.sh` queues a row after a **verified** deploy (not on the tag
  push — a deploy can roll back), and the bot posts one release per tick,
  oldest first, stopping at the first failure so the channel stays a history.
  `pnpm release:sync` is the backfill, the per-deploy hook and the repair tool,
  all one idempotent call. Migration 0038 adds `release_announcements`, CREATE
  only. Off until `RELEASE_CHANNEL_ID` is set — ⚠️ and everything queued posts
  at once when it is. Runbook:
  `docs/deploy/2026-09-17-release-announcements.md`.
- `CHANGELOG.md` now records every release back to v1.0.0. The v1.1.0–v1.15.0
  entries are reconstructed from the release tags' annotations and the commits
  behind them; v1.0.0 is written from the increment specs, since its tag carries
  only a subject line.

## [1.17.0] - 2026-09-17

### Added

- An acceptance record for the automatic deployment system,
  `docs/acceptance/2026-09-17-auto-deploy.md`: what the three rehearsals proved,
  the six-minute outage the second one caused and why, the measured downtime of
  a real rollback, and an explicit list of what the acceptance does **not**
  establish.
- The raid weekend opens and closes itself. Base damage is flipped on the
  Friday and Monday boundaries by the bot, on the restart slots that already
  apply it, and repaired within two hours if a write is lost or reverted.
- The site's top bar states whether raiding is live, with a countdown — read
  from confirmed flips, so a failed flip shows "not yet confirmed" rather than
  telling players base damage is on when it is not.
- Discord announces the weekend a day ahead, at its open and at its close, and
  alerts ops once per boundary if a flip is refused.
- `pnpm raid:skip` records a weekend deliberately not opened, with its reason;
  the site and the Thursday notice both explain the skip.
- `docs/deploy/2026-09-17-raid-window.md`, the deploy runbook for the automatic
  raid window: the `.env` additions and the two config-load refusals they carry,
  what the site says before the first boundary, and what to check at it.

### Fixed

- A raid-window boundary whose `cfggameplay.json` already held the wanted value
  recorded nothing, and the site and Discord both read a missing record as "the
  flip did not happen". The site warned indefinitely on day one, on the Monday
  after a skipped weekend, and after an operator's own manual flip. Every
  boundary now records itself, whether or not the file needed changing.
- An unconfirmed Monday close showed "OPENING" on the site, though base damage
  was still on. It now says "CLOSING".
- The raid-window failure alert scanned every failed flip ever recorded on every
  tick, and could post its first alert about a weekend long past.
- The raid-window countdown seeded itself from the clock during render, which
  could differ between the server's markup and the browser's first paint.
- `docs/deploy/raid-window.md` said the window decides whether "walls, gates and
  containers" take damage. Container damage has never been windowed on this
  server. No player-facing promise was affected — the guide says only that walls
  do not take damage.

## [1.16.6] - 2026-09-17

### Fixed

- The release deployer can no longer be rewritten out from under itself. It
  moves the tree to the new tag, which replaces `deploy-release.sh` while bash
  is executing it, and bash reads a script lazily by byte offset rather than
  loading it whole — so a replacement of a different length makes the
  interpreter resume at a stale offset in new bytes. Reproduced: the victim
  script silently stopped running at the rewrite and **exited 0**, which in a
  deploy means all three writers stopped, a failure marker written, and a
  success reported. The deployer now re-execs from a private copy, so its own
  text cannot change mid-run.
- A deploy can no longer report success while production runs the previous
  release's image. `docker compose up -d` was observed starting the stopped
  containers again rather than recreating them on the newly built image; web
  and ingest-worker are build-only services whose definitions name no image, so
  an unchanged definition can look up to date. No health check could catch it —
  the old image is perfectly healthy. The deployer now passes
  `--force-recreate`, which costs nothing because those containers have already
  been stopped.

## [1.16.5] - 2026-09-17

### Changed

- Rehearsal 2, re-run: a deliberately unhealthy release, used once to prove the
  deployer's automatic rollback restores code, images, host config and database
  after the image-retag fix in 1.16.3. Reverted here. The rollback passed: 1
  minute 57 seconds of downtime, including a full drop-and-restore of
  `factions_live`, with no human involved.

## [1.16.4] - 2026-09-17 [WITHDRAWN]

Not a release. This tag is rehearsal 2's re-run — a deliberately unhealthy
build, cut to prove the automatic rollback after the image-retag fix in 1.16.3.
It is recorded rather than deleted for the same reason as 1.16.2: a tag the
deploy history names should not be a mystery.

The rollback passed in full this time. **Never deploy this tag.**

## [1.16.3] - 2026-09-17

### Fixed

- The deployer's rollback no longer retags the **postgres** image when
  restoring the previous release. It resolved the target with
  `docker compose config --images <service>`, which also lists the service's
  dependencies, so the first line was `postgres:16-alpine` — pointing the
  database's image tag at an application image and putting postgres into a
  restart loop. Found by rehearsal 2 on 2026-09-17, which took production down
  for about six minutes; no data was lost.

### Changed

- Rehearsal 2's deliberately unhealthy release is reverted.

## [1.16.2] - 2026-09-17 [WITHDRAWN]

Not a release. This tag is rehearsal 2 — a deliberately unhealthy build, cut to
prove the deployer's automatic rollback works against real production data. It
is recorded here rather than deleted because the production host's failure
marker names it, and a tag a runbook points at should not be a mystery.

The rollback restored the tree, the host config and `factions_live` correctly,
and refused to retry. It failed at one step, fixed in 1.16.3. **Never deploy
this tag.**

## [1.16.1] - 2026-09-17

### Fixed

- The release deployer no longer dies at its first step: `pnpm` prints a
  lifecycle banner to stdout before a script's own output, and the deployer
  fed that banner to a JSON parser. Every deploy would have failed.
- `/backups/` is ignored, so hand-made dumps kept on the production host no
  longer leave the working tree dirty — which would otherwise make the release
  deployer refuse every deploy.

## [1.16.0] - 2026-09-16

### Added

- Releases deploy themselves: a new `vX.Y.Z` tag on `main` is deployed to
  production within two minutes, applying migrations and rolling back code,
  image, host config and database together if any phase fails.
- Repository lifecycle, CI, hygiene, secret-scanning and dependency-update
  configuration via the shipyard plugins: `.keel.json`, `.rigging.json`,
  `.stow.json`, `.hull.json` and `.bosun.json`, with the GitHub Actions
  workflows, PR/issue templates, CODEOWNERS and changelog gate they render.
- CI (`.github/workflows/ci.yml`) runs `pnpm run ci` — the typecheck and test
  gate — on node 20 against a Postgres 16 service container, with
  `TEST_DATABASE_URL` pointed at it as the base URL each package derives its
  own `factions_test_<package>` from.
- Secret scanning (`.github/workflows/security.yml`) runs trufflehog rather
  than gitleaks: this repo is organization-owned, and the gitleaks action
  exits 1 without a licence key before scanning anything.
- `CLAUDE.md` documents the CI gate, the `main`-is-protected PR workflow, the
  committed-changelog requirement, and the secret-scanning boundary — including
  that the history was swept clean once at adoption.
- Design for automatic deployment on release (`docs/superpowers/specs/2026-09-16-auto-deploy-design.md`),
  approved but not implemented: a host-side timer deploys each new tag, applies
  migrations, and rolls back both code and database automatically on failure,
  with the implementation plan in `docs/superpowers/plans/2026-09-16-auto-deploy.md`.

## [1.15.0] - 2026-09-15

### Added

- Automated base-zone enforcement. A non-member who builds, dismantles, or
  stacks fireplaces and garden plots inside a declared base's 100 m watch zone
  is recorded and warned. Nothing happens until the base's owner presses
  charges from `/base` — and then the ban is automatic, scaled to the damage,
  with no staff step. The bot only ever sentences incidents it witnessed
  itself: a report carries no free text and cannot describe an act the log
  did not record. The owner chooses whether to charge and which participants
  to charge; they never choose what the charge is.
- The sentence: 24h base, +48h for any breach, +24h for a fence-to-gate, +12h
  per part dismantled, capped at 7 days on a first offence, doubled on the
  second, permanent on the third in a season.
- Migration 0036 adds `zone_incidents`, `zone_violations`, `zone_placements`,
  `zone_incident_participants` and `bans`. CREATE only — the bot does not
  need stopping to apply it.
- Runbook: `docs/deploy/2026-09-15-zone-enforcement.md`.

### Changed

- Dismantling a base that is not yours is a violation 24/7. The "inside the
  window, dismantling while raiding is part of raiding" carve-out is deleted.
- Building anything inside someone else's watch zone is a breach — watchtower,
  fence, anything.
- Stacked fireplaces and garden plots move off the permanent-ban exploit list
  onto the proportional ladder.
- These three skip the ticket queue. Every other fair-play rule still needs
  one. (`apps/web/content/guide/12-fair-play.html`)

### Notes

- ⚠️ Shipped dark: detection and audit rows from day one, automatic bans off by
  default, to be enabled deliberately once the boost-stack thresholds had been
  tuned against real data.
- ⚠️ `parity.test.ts`'s `PENDING` list is no longer empty. `reportIncident` is
  deferred deliberately: the evidence an officer needs to judge a report
  cannot appear in Discord under `clan_notices_no_coordinates`, so the
  decision surface is the owner-gated `/base` page.

## [1.14.0] - 2026-09-14

### Fixed

- A typo'd `BOT_TICK_INTERVAL_MS` was a database hammer, not a slow loop.
  `tickIntervalMs` goes straight into `setInterval`, which stores its delay in
  a signed 32-bit int: past 2,147,483,647 Node warns and uses 1 ms, so an
  extra-digit typo in `.env` fired the tick loop a thousand times a second
  while the value on the page read like a longer interval than intended.
  ⚠️ Operationally new: the bot now refuses to start on an out-of-range
  `BOT_TICK_INTERVAL_MS`, naming the limit, rather than clamping it — clamping
  would silently run an interval the config does not say. The cap is on this
  key alone; the dormancy windows stay uncapped.
- A thrown tick no longer takes the notifier down with it. `verificationTick`
  and `notifyCompleted` shared one `try`, so a persistently throwing tick
  meant players who had already completed their sequence were never told —
  indefinitely, with nothing saying the notifier had stopped too. Every other
  pair in that pass already had its own catch.
- `liveChallenges` is read once per batch instead of once per emote event —
  one query per batch plus a lookup per event × challenge, instead of one
  query per event (2,093 on the historical backfill). ⚠️ The per-event re-read
  was load-bearing, not merely wasteful: the cache is dropped on every write,
  or safe-pool emotes arriving after a completion in the same batch would
  re-enter the finished challenge and fail its `stillOpen` guard, surfacing as
  `alreadyLinked` — a code that means "this UID belongs to someone else."

### Notes

- Bot only. No migration, no web change, no player-facing behaviour change.

## [1.13.0] - 2026-09-14

### Added

- ⚠️ Carries a migration (0035): a unique index on `faction_members
  (server_id, discord_id)`, the mirror of the one that has always existed on
  `(server_id, dayz_id)`. One person, one membership per server, whichever of
  their two ids identifies them. First migration applied with `pnpm
  db:migrate` (shipped in v1.11.0) instead of a hand-assembled runner.

### Notes

- No player-facing behaviour change — nothing a player could do before is
  refused now. The index forbids only rows that four separate write paths
  already refuse to write; it is defence in depth, not a fix for a live bug.
  What was open is that none of those paths was backed by a constraint, so a
  fifth one getting it wrong would have raised a raw Postgres error at a
  player instead of degrading gracefully.
- ⚠️ The index caught three test fixtures on its first run, each seeding one
  Discord account as leader of two clans on one server — always illegal, but
  only the dayz-keyed index had been watching for it.
- Runbook: `docs/deploy/2026-09-14-membership-uniqueness.md`.

## [1.12.0] - 2026-09-14

### Fixed

- A map pin dropped within half a card's width of the world's edge opened a
  popup that was simply cut off — the note and the Delete button off the
  page, with no gesture that could bring them back. Leaflet's only answer to
  an overrunning popup is to pan the map, and this map cannot pan: the world
  is the max bounds with viscosity 1 and the zoom floor already fits all of
  it, so there is no headroom to pan into. The card now moves instead of the
  map (`apps/web/lib/map-popup-fit.ts`, pure and unit-tested) — the tip stays
  where Leaflet put it, still pointing at the pin, and hides past the point
  where it would slide off the card's own corner. A card that overruns the
  top flips below its pin instead of sliding down onto it.

### Notes

- Web only. No migration, no bot change, no operational change.

## [1.11.0] - 2026-09-14

### Added

- `pnpm db:migrate` (`scripts/migrate.ts`): applying a migration to
  `factions_live` is now a checked step instead of a script hand-assembled at
  deploy time. Dry run by default — prints the target, the journal, what is
  applied, and the exact tags it would apply, then exits without writing.
  `--apply` writes. After applying, it re-reads the migrations table and
  checks the result against the plan, because the migrator itself reports
  neither what it applied nor that it applied anything.
- Root scripts are typechecked (`scripts/tsconfig.json`, `pnpm
  typecheck:scripts`, run by both `typecheck` and CI). Its first run found a
  live bug: `rebuild-kills.ts` and `rebuild-sessions.ts` import `drizzle-orm`,
  which was not a root dependency and does not resolve from the repo root
  under pnpm's strict layout — both scripts would have failed at startup with
  `ERR_MODULE_NOT_FOUND`. Fixed by adding the dependency.

### Notes

- ⚠️ The production guard runs both ways, unlike `pnpm wipe` / `pnpm launch`:
  `--production` is required to apply to `factions_live` and refused against
  any other database, so the flag cannot be carried by muscle memory onto a
  database it did not mean.
- ⚠️ It refuses outright when `drizzle.__drizzle_migrations` disagrees with
  the journal. The postgres-js migrator applies every entry whose `when` is
  newer than the newest `created_at` — comparing timestamps, not names — so a
  table ever filled in by hand replays old migrations against live data,
  silently. That case is now a unit test instead of a runbook paragraph.
- No player-facing change, no runtime change to the bot or the site, and no
  migration of its own — nothing needs deploying to use this release.
- Runbook: `docs/deploy/2026-09-14-db-migrate.md`.

## [1.10.0] - 2026-09-13

### Added

- Single-instance enforcement: the bot takes a Postgres session-scoped
  advisory lock before it opens a pool, logs in, or registers commands. A
  second process prints one line and exits 0 — deliberate, so
  `Restart=on-failure` leaves it exited instead of restart-looping every
  interval. Session-scoped, so a SIGKILLed or power-lost bot releases the
  lock on connection death: no TTL, no stale holder to clear by hand.
  Two things already depended on this invariant without enforcing it: the
  notifier is at-least-once across processes — a verified player was DM'd
  twice on 2026-09-01 after a `pkill` pattern missed a stale process — and
  `/found` keeps its draft in memory, because ten 17-character participant
  ids do not fit in a 100-character `custom_id`, so two processes could lose
  a player's founding choices between their select menu and their modal.

### Changed

- Crash logs no longer print request bodies. `unhandledRejection` and
  `uncaughtException` now log through `safeErrorInfo` — Node prints an
  error's own enumerable properties by default, and both drivers attach
  payloads: `@discordjs/rest` carries `requestBody.json` (for `/vault
  reveal`, a clan's lock code) and `url` (an interaction token); postgres.js
  carries `.query` and `.parameters`, and `/vault add` submits a code as a
  bound parameter. The diagnosis still reaches the journal.

### Fixed

- `idOf` no longer coerces. `Number("9e2")` is `900` and passed
  `Number.isInteger`, so it was a valid row id on all sixteen call sites that
  bridge a slash option to a roster row — every `lock:`, `pin:`, `invite:`,
  `request:` and `pass:`. Now matches `DECIMAL_RE`, the house rule it broke.
  No privilege escalation: the roster re-derives permission and answers
  "gone" for a row that isn't yours.

### Notes

- ⚠️ Operationally new: hand-starting a second bot no longer works. That is
  the feature. To hand a running bot's job to a new one, stop the old one
  first — `systemctl restart` is unaffected, since systemd waits for the stop
  and the lock releases after `client.destroy()`.
- ⚠️ The process still exits on a crash. Sanitising the log does not make the
  bot survive states it previously died in.
- No new player-facing behaviour; no migration.
- Runbook: `docs/deploy/2026-09-14-single-instance-lock.md`.

## [1.9.0] - 2026-09-13

### Added

- Discord command parity is complete: everything a player can do on the site,
  they can now do in Discord. `/vault list|add|edit|reveal|confirm|delete|
  rotate`, `/map pins|pin|unpin|view`, and the read-only group `/scoreboard
  /alphas /seasons /warlog /player /board /achievements`.
- A shared embed budget that counts the "+N more" line against Discord's
  6000-character cap, closing the gap plan 2 left open. A router that can
  open a modal from a slash command, and update a select menu in place
  instead of stacking a new card per interaction.
- Scoring, stats and achievement wording moved from `apps/web/lib` into
  `@factions/copy`, byte-identical, with the web files re-exporting — the
  site renders exactly what it rendered before; no web redeploy needed.

### Fixed

- A lock code could reach an operator log: `@discordjs/rest` attaches the
  failed request body to the errors it throws, and the router's `editReply`
  sat outside its own try/catch, so a rate limit on a `/vault reveal` reply
  could carry the code into `console.error`. Sanitised at both logging sites.
- `/alphas` failed outright on a week nobody scored — Discord rejects an
  empty embed field and the roster emits every closed week, empty ones
  included.
- `/board` never printed the season it resolved to, so a fumbled scope could
  silently return a different season's numbers.

### Notes

- ⚠️ `/unlink`, `/whoami` and `/faction` are gone the instant the bot
  restarts. Registration is one PUT that replaces the whole command list, so
  there is no transition period — the stubs stop existing at the same moment
  the nine new commands appear.
- `apps/bot/test/parity.test.ts`'s `PENDING` list is empty, and the suite
  re-checks that on every run — a new write in `@factions/roster` with no
  command now fails the build.
- No migration. `apps/bot` only in effect — do not run `deploy-web.sh`.
- Runbook: `docs/deploy/2026-09-13-discord-commands-3.md`.

## [1.8.0] - 2026-09-13

### Added

- Discord clan commands: plan 2 of the command-parity work. Every clan-side
  write the website supports can now be made from Discord, over the same
  `@factions/roster` layer, with every player-facing sentence coming from
  `@factions/copy` so an outcome cannot be covered on one surface and missing
  on the other. New commands: `/me` (show, accept, decline, withdraw),
  `/roster` (invite, revoke, decide, kick, promote, demote, transfer), `/clan`
  (info, leave, rename, recruiting, rebind, disband), `/clans` (list, show,
  join), `/lead` (claim, vote, ballot), `/found` (flag select, crew
  multi-select, name/tag modal), `/guest` (grant, revoke).
- Confirm buttons and modal submits route through a shared handler. The press
  IS the write for disband, transfer, claim-succession and open-vote — the
  slash handler never touches the roster. The router re-checks the presser
  against the actor named in the custom id, and every write re-derives
  eligibility from `@factions/roster` under its own row lock regardless: a
  button is never a permission.

### Fixed

- `/clan info` would have shown a clan's exact base coordinate to a PENDING
  member. `clanForDb` computes `base` for every rank while gating everything
  else, and the website renders no coordinate on that page at all, so nothing
  had needed the gate before. Found by the whole-branch review; now gated on
  full membership.

### Notes

- ⚠️ Behaviour changes for players: `/guest` changes shape, from `/guest
  user:` to `/guest grant user:`, plus a new `/guest revoke pass:`.
  Registration is one PUT, so the change is instant and total — tell officers
  before deploying. `/guest` also no longer has to be run in the clan's
  channel; the clan is derived from the actor's own membership.
- The retired stubs `/unlink`, `/whoami` and `/faction` stay registered and
  still answer with a site pointer; they are removed in plan 3, along with
  `/vault` and `/map`.
- No migration. `apps/bot` only — do not run `deploy-web.sh`.
- Runbook: `docs/deploy/2026-09-13-discord-commands-2.md`.

## [1.7.1] - 2026-09-13

### Fixed

- v1.7.0 shipped a broken web image. `packages/copy/src/vault.ts` imported
  `VAULT_NAME_MAX` and `VAULT_NOTE_MAX` as runtime values from
  `@factions/roster`, and because `src/index.ts` is a barrel, that pulled
  roster's pooled postgres client into the browser bundle of every page
  importing any copy table — `apps/web/lib/link-copy.ts` is imported by
  `link-flow.tsx`, a client component, so Turbopack failed to resolve `fs`,
  `net`, `tls` and `perf_hooks`. The gate went 28/28 green on v1.7.0 and could
  not have caught it: `tsc --noEmit` and vitest both resolve modules the Node
  way, and neither runs a bundler. The failure surfaced inside the web image
  on the production host, mid-deploy; the bot was unaffected, being Node
  rather than a browser bundle, and shipped fine.
- The two constants move to `@factions/domain`, beside `PIN_NOTE_MAX`, where a
  player-facing limit belonged anyway. `vault-store.ts` re-exports them, so
  `@factions/roster`'s pinned export list is unchanged. `@factions/roster`
  becomes a devDependency of `@factions/copy`, every remaining use being
  `import type`.

### Notes

- ⚠️ Do not deploy v1.7.0. `packages/copy/test/leaf.test.ts` is the standing
  guard: it fails on any runtime import of `@factions/roster` from that
  package and names the offending specifiers.
- Deployed: web image rebuilt, bot restarted on the same commit.

## [1.7.0] - 2026-09-13

### Added

- The slash commands come back, as a second front door beside the site: an
  earlier spec had retired every Discord command in favour of
  `dayzclanwars.com`. `/link status|start|cancel|unlink` and `/base
  show|declare|release` return, without giving the bot its own copy of a
  single rule — `@factions/roster`'s 61 capability wrappers move behind
  `makeRoster(getDb, getNow)`, so the bot binds them to its own handle and
  runs the identical code the site runs. `interaction.user.id` is the same
  Discord snowflake the site's session holds, so there is no new credential
  and no impersonation path.
- The six outcome-copy tables move to `@factions/copy`. One table per action,
  read by both surfaces, so an outcome cannot be worded on the site and blank
  in Discord. Autocomplete runs over live rows: characters the log has seen,
  and — for `/base declare` — only poles the actor themselves raised at,
  because a pole coordinate is a raid target and the scoping is a query
  filter, not a post-hoc trim.

### Notes

- ⚠️ Every reply is ephemeral, by construction: the flag is set once at
  `deferReply` and `command-registration.test.ts` asserts it structurally. A
  challenge sequence in a public message is a challenge any reader can
  perform, binding their own UID to someone else's Discord account.
- Three standing guards: `parity.test.ts` accounts for all 70 roster exports
  and fails on a new one nobody classified; the registry bijection forbids a
  command with no handler or a handler no command reaches; and the vocabulary
  scan now walks `packages/copy/src`, with a non-vacuity assertion so it
  cannot silently stop walking.
- The retired stubs for `unlink`, `whoami` and `faction` stay registered and
  still answer with a link — they go when parity is complete, not before.
- ⚠️ This release's web image does not build — see v1.7.1. Do not deploy this
  tag; deploy v1.7.1 instead.
- No migration. Runbook: `docs/deploy/2026-09-13-discord-commands.md`.

## [1.6.0] - 2026-09-12

### Added

- Three combat feeds share one cursor loop. The hit feed groups PvP hits into
  engagements and posts once per burst with a detail line per hit; an
  engagement that ends in a kill is suppressed and its hits are appended to
  the `#kill-feed` embed instead, so a fight never splits across two
  channels. Closing is guarded three ways: the quiet window, a 120s settle
  floor (`RECENT_HIT_WINDOW_S`, so a late "finished" death cannot claim an
  already-posted burst), and the kills-projector cursor as the frontier
  rather than the wall clock. The killstreak feed posts every
  `KILLSTREAK_EVERY` kills on a hot hand; friendly fire neither advances nor
  breaks a streak, PvE deaths do not reset one, and streaks are not
  season-scoped. The long-range feed posts a season rank capped at 10th; a
  null distance is skipped, never read as zero. `cursor-feed.ts` holds the
  post-then-advance loop all four feeds share, with a render that may decline
  an item and still advance the cursor; `kill-feed-tick.ts` folded onto it
  with its tests unedited.
- Daily truck wipe: event-spawned trucks are cleared once a day, riding the
  restart slots that already exist rather than a new tick. ⚠️
  Level-triggered, not edge-triggered — every slot recomputes the state the
  server should boot into, so a lost write self-heals at the next restart
  instead of leaving the trucks gone for a full day.
- Weekly vehicle rotation: a Monday 08:00Z wipe of one of five vehicles,
  rotating weekly and derived from the calendar rather than a stored
  pointer, announced to Discord 24h ahead (`vehicle_wipe_announcements`,
  migration 0033).

### Notes

- ⚠️ The cursor watermark took four fix rounds. Emitting an engagement whose
  `lastEventId` sits above another's `firstEventId` buries that one's early
  hits below the cursor forever. The rule is a fixed point — emit the largest
  safe prefix, with the batch limit applied inside the loop and a liveness
  fallback that deliberately exceeds the limit rather than stall, since
  nested spans admit no smaller safe set. Verified against an exhaustive
  subset search over 200k configurations.
- ⚠️ Migration 0034 is additive but must be applied by hand; nothing here
  migrates at startup. It creates two indexes on `events` NOT concurrently,
  briefly locking writes on the largest table. Skipping it fails silently — a
  seq scan per tick with nothing logged.
- ⚠️ Known gap: the hit feed's frontier is global, not per-server. Latent
  with one registered server; close it before a second is added.
- Runbook: `docs/deploy/2026-09-12-combat-feeds.md`.

## [1.5.0] - 2026-09-12

### Added

- Achievement badges on every surface: the design hand-off's 150 PNGs and 50
  glyphs wired into the wall, the owner's unlock toasts, the Discord unlock
  card and a 1200x630 share card. `ACHIEVEMENT_GROUP_COLORS` in
  `@factions/domain` is the one statement of the four group colours. The 104
  historical unlocks were announced to `#achievements` in earned order by
  `scripts/backfill-achievement-notices.ts`.
- Scheduled restarts: the bot restarts the server at the top of every even
  UTC hour through Nitrado, behind `RESTART_SCHEDULE`, recording one
  `server_restarts` row per server per slot. `messages.xml` keeps its own
  countdown. Migration 0032 is additive.

### Notes

- Runbook: `docs/deploy/2026-09-12-scheduled-restarts.md`.

## [1.4.0] - 2026-09-12

### Added

- Achievements: fifty lifetime achievements for players and clans — eleven
  solo, twelve PvE, fifteen PvP and twelve team rules, defined as data in
  `@factions/domain`. A tick scans touched owners each pass and writes
  unlocks with evidence, posting a notice for each; a backfill script drains
  the whole history and is resumable, feeding the lifetime counters
  (explorer, cartographer) before it starts so the tick can't double-count
  against them. The badge wall shows on profiles and clan pages — a locked
  tile says "Locked", not only dim — with the closest-to-unlocking rules
  surfaced for the owner. Guide chapter 14, Achievements, renders from the
  same definitions.
- Server-name strip: the in-game hostname from Nitrado, shown under the top
  bar as a marquee, no Copy button — read live, never configured or
  hard-coded.

### Fixed

- The first raid weekend is delayed one week: the 2026-09-11 and
  2026-09-14 flips are skipped so a freshly launched season doesn't open
  raiding before clans have had time to build.
- Map pin popups were a white card on phones — the Delete button unreadable.

### Notes

- Runbook (achievements backfill): included in the achievements commits;
  see `pnpm backfill:achievements`.

## [1.3.0] - 2026-09-09

### Fixed

- Credited kills, mutual kills and grenades: an audit of every kill-shaped
  line in the live log against `kills` found three gaps. The kill and hit
  regexes missed the killer's own `(DEAD)` marker on a mutual kill, filing
  two real PvP kills as "environment" and three player hits as environment
  hits. A grenade death named no thrower and read as the environment; it is
  now `explosion`. And a player shot to `FINISH_HP_MAX` (25) or below, or
  knocked out after the shot, who then died with nothing but a player having
  hurt them since, was never credited — the game writes "died." when the
  last damage tick is bleeding. `finishedBy` now credits that kill (killer,
  weapon and range from the hit line, cause `finished`); the site says
  "Finished by", the Discord feed "finished". Hits in the same second are
  tie-broken on lowest HP, since a burst logs several at one timestamp. Four
  such deaths were sitting in the live log; 27 PvP kills became 31.

### Notes

- ⚠️ A reparse never corrects a misparsed line, so the wrong events must be
  deleted before a rebuild picks up the fix.
- Runbook: `docs/deploy/2026-09-10-credited-kills.md`.

## [1.2.0] - 2026-09-09

### Added

- Death causes: the feed now says what a player died of, not just that they
  died. The ADM parser keeps two line shapes it used to drop — `hit by`
  (`player.hit`: attacker, HP after) and `is unconscious`
  (`player.unconscious`) — and reads the `Stats>` tail off a bare `died.`.
  The kills consumer hands a bare `died` to `@factions/domain`'s
  `classifyDeath` (lifted from One Life) with the victim's hits and
  knockouts from the two minutes before, and writes the verdict — `mauled`,
  `starvation`, `dehydration`, `fall`, `bled_out` — into `kills.cause`.
  Named killers gain `wolf` and `bear`.

### Notes

- Evidence is matched by `occurred_at` and victim id, never by event id, so a
  reparse followed by a rebuild attributes history too.
- Runbook: `docs/deploy/2026-09-10-death-causes.md`.

## [1.1.0] - 2026-09-09

### Added

- Player pages: a linked member's `/me` now forwards to their own profile
  page, which carries the owner's controls. The hero wears the clan's flag
  colours, with hero copy that never runs under the flag itself and player
  names sized as one word. The page gets its own feed, with expandable
  Killed / Killed by rows, and the feed's death causes cover the parser's
  full vocabulary.
- New boards: Most PvP deaths (friendly fire earns nothing toward K/D), best
  killstreak, longest kill, and build points — a seventh board, public and
  per clan, with a matching profile number. Boards are reordered into a
  logical sequence (raiding, offensive PvP, building, play time, the
  shameful two), each shows a full paged page with the top 10, board rows
  carry the player's clan flag, and a find-a-player row sits above all of
  them.
- The site redesign: new shell primitives, a top bar with a drawer on every
  page but the landing page and the guide, a live landing page ("Your clan.
  Your war." over a still of the live map), and redesigned you/your-clan/
  clans/clan-detail, scoreboard/players/war-log/alphas/seasons, and the map
  overlays and guide shell.
- The field guide moves into `apps/web` (chapter fragments and manifest,
  rendered at `/guide`, replacing the redirect to its old host) and is
  integrated: numbers render from `guide-numbers.ts` (computed from
  `rules.ts`, not vendored JSON), the guide's own search matches section
  bodies, and it carries the site's shared chrome and cross-links. It is
  also mirrored into Discord, kept in sync with the site.
- The map gains its marker set (from `Map Markers.dc.html`), place names as
  their own layer above travel points (the Hub marker goes), a zoom floor,
  a Centre-on-me button, and its layers behind a settings sprocket. An
  active clan's declared flagpole becomes a fast-travel point.
- Discord gains `#kill-feed` (every PvP kill as an embed with a running
  tally) and `#players-online` (one message kept edited to the open
  sessions, names linking to profiles on the site).
- App icons, favicons, a manifest, and a home-screen install strip on
  phones. A share image for links ("Your clan. Your war." on every page).
- The ingest worker can reparse stored raw lines, so a parser's new line
  shapes reach the event log without waiting for fresh log data.

### Fixed

- Reserved clans receive the supply kit, since the kit is where their flag
  comes from — previously only active clans did.
- Home's "Raids this season" counted only faction raids; it now counts
  victims, so solo raids show too.
- The All-time scope button links `?season=all` rather than the bare path.
- The kill-feed tally counts in the season the kill belongs to.
- A gamertag with a space in it now finds its profile.
- Clanmate names on the map stack by recency, the most recently seen on top.
- Several rounds of UX review: contrast, focus, overflow, text floors and
  touch targets; confirms and announced notices unified to one page shape;
  field-level form errors (the refused field marked, explained under it,
  and focused); notice focus waits a frame past hydration; the vault lock
  date renders once instead of drifting.

### Notes

- This release covers everything that shipped between the v1.0.0 launch tag
  (2026-09-07) and this one (2026-09-09) — the first stretch of rapid,
  unversioned feature work after launch, which is why it is dense.

## [1.0.0] - 2026-09-07

The target-state build order complete: increments 0 through 8, the point at
which the game the field guide describes was actually playable end to end —
found a clan at a flagpole, hold it, raid another, and see the war reflected
back on the site and in Discord. Everything below shipped as one consolidated
deploy against a fresh `factions_live` (migrations 0020–0028 together, zero
clans in the database beforehand); the acceptance record is
`docs/acceptance/2026-09-08-launch.md`.

### Added

- Base declarations: the 200 m minimum between declared bases, `declareTx` as
  the one writer of the `declarations` table, and the solo lapse clock that
  releases an inactive player's claim.
- Site foundation: Tailwind, `packages/roster`, and `/me` reading from the
  database — the site's first real page.
- Identity linking and solo basing as site flows: gamertag autocomplete over
  seen-and-unclaimed players, three emotes in order, budgeted, and unlink on
  `/me`; solo declare and release for a base.
- The roster store: pending and full membership with presence promotion, the
  10-member cap, join requests, identity holds, and the recruiting post —
  then, in the same increment, roster administration itself moves off Discord
  and onto the site.
- Raids, defenses and dormancy revival: a non-member lowering a clan's flag
  starts a 24h clock; a member's re-raise inside it records a defense, a miss
  makes the clan dormant. The notice and war-log queues carry the results.
- Discord structure: one role, text channel and voice channel per clan,
  reconciled every tick against the roster rather than written once and left
  to drift — the `@Linked` role included.
- Scoring and seasons: weekly Alphas and a season champion, computed from
  raid and defense points, with `#war-log` posting each week's and season's
  close.
- The map: player positions and intruder sightings projected from the log,
  rendered with the guide's four rules — every fix shows its age, no trails,
  no position outside your own clan except an intruder in your own zone, and
  a dormant clan keeps its map.
- Sessions, kills and membership history: connect/disconnect and PvP/PvE
  kills projected from the ADM log into player stats, with membership
  resolved at the instant each kill happened rather than at query time.
- Leadership and the vault: succession claims against a silent leader,
  no-confidence votes, and the clan vault (door/safe codes behind a
  per-lock role, never DM'd or posted) with 24h guest passes onto a clan's
  voice channel.
- Launch: `/guide` redirects to the field guide's own host, `pnpm launch`
  stamps every pole's 7-day grace from the real launch instant so nothing
  appears on the public-bases layer before it, and the raid window (base
  damage Friday 00:00 UTC to Monday 00:00 UTC) is enforced on the game
  server, not the bot.
- The faction feed (`#🎌-faction-feed`), faction dormancy (7 days unraised
  loses the supply kit, 14 further days disbands), faction rebind (move an
  established base to an unheld pole, one raise and a leader confirmation,
  7-day cooldown), and the supply-spawner projection (the worker regenerates
  and hashes `faction-supplies.json` from `factions` every sweep, uploading
  only on a change) were all already in place by this build.

### Notes

- ⚠️ Only `founded` and `activated` feed events had ever posted to a real
  channel anywhere at this point — both from a backfill against a database
  that no longer exists. The other five kinds were tested but unexercised in
  production.
- The database this build deployed to holds one registered server and zero
  clans: nothing in this entry had yet been exercised against real player
  data on this deployment.

