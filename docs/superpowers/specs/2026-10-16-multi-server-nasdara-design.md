# Multi-server: Nasdara as a second Clan Wars map

**Date:** 2026-10-16
**Status:** superseded by `2026-10-17-nasdara-swap-design.md` (single-map swap, not two servers)

## Purpose

Clan Wars runs on one server today: the 50-slot Chernarus server (Nitrado 19831378,
`servers` row 1). This adds a second Clan Wars server on a different map, Nasdara,
by converting the existing **Nasdara 10x** server (Nitrado 18196786, mission
`dayzOffline.nasdara`, local mission copy in `../nasdara-10x/`). Nasdara is wiped and
reconfigured for Clan Wars; nothing on it carries over.

The point is one Clan Wars community playing two maps, not two separate communities.
A clan is one clan on both maps.

## Decisions (made in brainstorming)

1. **Different map.** Nasdara, not a second Chernarus.
2. **Clans span servers.** A clan has one name, tag, flag, roster, leader and Discord
   clan channel across both maps, and holds a base on Chernarus, on Nasdara, or on both.
   At most one base per clan per server.
3. **A player is in one clan, full stop.** Not one clan per map.
4. **Founding happens once**, with the existing flagpole ritual, on whichever server the
   founders are on. Taking a base on the other map is claiming a second pole for an
   existing clan, not founding again.
5. **A clan only goes dormant or lapses once it has lost every base.** Losing the
   Nasdara base while holding Chernarus is not dormancy.
6. **Seasons, leaderboards and alphas are per server.** A clan can top the Chernarus
   board and be mid-table on Nasdara. **Referrals stay global.**
7. **A set of Discord channels per server**, in a category per map: kill feed, hit feed,
   killstreaks, long-range kills, server events, war log, leaderboards, players online,
   bans. **Shared:** ops, release notes, bot feed, achievements, and every clan's private
   channel.
8. **Nasdara wipes and starts fresh** as its own season 1 the day it flips over. No data
   import.
9. **Nasdara's launch-day features:** King of the Hill (with its vote), raid window,
   base-zone bans, restart schedule, Sunday vehicle wipe, live map on the site.
   **Not at launch:** bunker/keycard rooms, airdrops, fast travel. These stay
   Chernarus-only; the code must be able to turn a feature on per server.
10. **Choosing a server in commands.** `/scoreboard`, `/map`, `/koth`, `/kothvote`,
    `/alphas`, `/seasons`, `/warlog`, `/base` get a server option. When it is blank:
    the server whose channel category the command was typed in; otherwise the server
    the player was last online on. *(Fallback when neither applies, e.g. a player never
    seen online: the lowest server id — builder's call, noted here so it is visible.)*
11. **The site gets a Chernarus / Nasdara switch** at the top, remembering the viewer's
    last choice.

## Goals

- Both servers run Clan Wars at the same time from one bot, one ingest worker, one
  projector, one database and one site.
- A clan's identity, roster and private channel are the same on both maps; its bases,
  raids, incidents, bans, seasons and standings are per map.
- Every per-map feed lands in that map's channels and nowhere else.
- Adding a third server later is registering a row and its config, not another project.

## Non-goals

- Bunker, airdrops and fast travel on Nasdara (later, each its own change).
- Cross-map scoring, a combined leaderboard, or season results that add the two maps.
- Moving players, gear or bases between maps.
- Importing any Nasdara 10x history.

## Anti-goals (would be a failure even if it works)

- **A fight, kill or ban on one map showing up in the other map's channels**, or a
  feed double-posting because the two servers' logs run at different speeds.
- **A clan losing its Chernarus base and being told it is dormant/lapsed** while it
  still holds Nasdara (or the reverse).
- **A Nitrado call aimed at the wrong server** — a ban, restart, events.xml or
  cfggameplay write on Nasdara made with Chernarus's coordinates or files, or vice versa.
- **Any change in behaviour on Chernarus** for players who never touch Nasdara, beyond
  the new server option and site switch.
- Turning on Nasdara's `servers` row before the per-server work is in: every tick that
  loops over active servers (restarts, bans, KOTH, solo-lapse) would pick it up at once.

## Current state (what exists)

**Already per server:** 40 of 85 tables carry `server_id`, including `declarations`,
`poles`, `seasons`, `events`, `kills`, `player_sessions`, `player_positions`,
`flag_holds`, `bans`. The ingest sweep (`apps/ingest-worker/src/sweep.ts`), projector,
restart, ban, KOTH, airdrop and solo-lapse ticks already loop over active servers with
a Nitrado client per service. Rebuild scripts take `--server <id>`.

**Single-server shortcuts to remove:**

- `packages/roster/src/server.ts` `activeServerId()` — "the" server for the site and
  roster reads; used by `base`, `reads`, `live`, `map`, `stats`, `scoring`,
  `bounty-admin`, `incidents`, `viewer`.
- `.limit(1)` "first active server" picks: `apps/bot/src/commands/koth.ts:43`,
  `kothvote.ts:29`, `bunker.ts:36`, `referral-award.ts:91`, `roster/src/awards.ts:188`,
  `achievements/tick.ts:67`, booster prompt in `discord.ts:1158`.
- **`apps/bot/src/hit-feed-tick.ts` `frontier()` is global across servers** (its own
  comment, lines ~105–130): a server whose logs are ahead closes fights early on the
  lagging one and double-posts into #hit-feed/#kill-feed. The comment is explicit that
  this needs a per-server read — a rewrite of that class, not a narrower query.
  `consumer_cursors` is shared across servers for the same reason.
- Single-valued config: all 13 `*_CHANNEL_ID`s, `restartSchedule`, `truckWipe`,
  `raidWindow`, `koth`, `airdrop` in `apps/bot/src/config.ts`.
- Map constants: `WORLD_MAP = "chernarusplus"` in `packages/domain/src/rules.ts:162`;
  Chernarus KOTH spawn points (`apps/bot/src/spawn-points.ts`, `koth-converge.ts`),
  bunker rooms (`packages/domain/src/bunker.ts`), map projection/tiles
  (`apps/web/lib/map-projection.ts`).
- Copy that names Chernarus or "one Xbox server": site header
  (`apps/web/app/(site)/page.tsx:48`), guide (`apps/web/app/guide/layout.tsx:63`,
  `apps/web/lib/guide.ts`), OG image (`apps/web/app/api/og/achievement/...`),
  `ACHIEVEMENT_FOOTER`, `MAP_REGION_LABEL`.
- Weekly/announcement tables with no server: `alpha_weeks`,
  `raid_window_announcements`, `vehicle_wipe_announcements`. (`referral_weeks` and its
  winners stay global by decision 6; `release_announcements` is shared by decision 7.)

**Clan tables bound to one server** (the biggest piece):

- `factions.server_id`, with flag and tag uniqueness per server
  (`factions_holding_texture_uniq`, `factions_holding_tag_uniq`).
- `faction_members.server_id`, with one-membership-per-player and per-Discord-user
  **per server** (`faction_members_server_player_uniq`, `..._server_discord_uniq`).
- `declarations_faction_uniq` on `owner_faction_id` alone — one base per clan in the
  whole database.
- Base state stored on the clan: `factions.flag_down_since`, `flag_down_by_dayz_id`,
  `dormant_since`, `dormant_reason`, `disband_warned_at`. With two bases these describe
  one base, not the clan.
- `faction_members.seen_at_base_event_id` — a pending member becomes full when seen at
  "the" base.

## The design

### 1. Clans become global

- `factions` drops its `server_id`; tag uniqueness becomes global. Flag uniqueness
  becomes global too, because a clan's flag is the same on both maps (see Open
  question A).
- `faction_members` drops its `server_id`; one membership per player and per Discord
  user, globally.
- `declarations_faction_uniq` becomes `(server_id, owner_faction_id)`: one base per
  clan per server. Solo bases (`owner_dayz_id`) stay one per player per server, as now.
- **Per-base state moves onto the base.** Flag-down time, raid/defense tracking and
  anything else that describes one pole lives with the `declarations` row (or a per-base
  table), not on `factions`. Clan-level dormancy is derived: a clan is dormant/lapsed
  only when **every** base it holds is down/inactive, and the warning and timers follow
  from that. Flag-down time is usually offline downtime, not a siege — copy must not
  say otherwise.
- Pending → full membership: seen at **any** of the clan's bases.
- Claiming a second base: an existing clan's full member raises the clan's flag at a
  free pole on the other server. This uses the existing "free pole proposes a base move"
  path, generalised from "move" to "move on this server, or add on a server where the
  clan has no base". A clan with a base on that server still moves it, as today.
- Clan-level history stays clan-level (name/tag/flag changes, leadership,
  membership history). `faction_events` already has `server_id`; keep it, since events
  like raids belong to a base on a map.
- Name/tag holds (`identity_holds`) become global with the tags. *(My call: a hold
  lasts until every server's season that was open when the hold began has closed — the
  conservative reading, so a tag never frees mid-season on either map.)*
- Existing Chernarus rows: the migration moves every clan to the new shape with its one
  Chernarus base unchanged. No behaviour change for a clan that only plays Chernarus.

### 2. Per-server config

Per-server settings move from process env to per-server data, so a third server is a
row, not a deploy:

- the Discord channel set (decision 7's per-server channels),
- feature switches: KOTH (+ auto/vote), raid window, restart schedule, truck wipe,
  airdrop, bunker, bans on/off, with their numbers (weekly caps, min pop, wipe hours),
- map identity: map key, terrain size, tile set, display name.

Process-wide switches stay as master switches (e.g. `KOTH_TICK` off still means off
everywhere). The existing load-time checks (e.g. "KOTH on but no server-events channel")
become per-server checks. *(Builder's call: columns on `servers` or a
`server_settings` table; and whether channel ids are seeded by an ops script or a
`/admin` command.)* `BAN_DRY_RUN` stays process-wide; its two hazards in CLAUDE.md apply
to Nasdara from its first ban.

### 3. Feeds and the hit-feed rewrite

- Every per-server feed tick (kill, hit, killstreak, long-range, server events, war
  log, leaderboards, players online, bans) posts to the channel set of the server the
  item came from.
- `hit-feed-tick.ts` is rewritten to read and close engagements per server, each with
  its own frontier. `consumer_cursors` gets a per-server key for the feeds that need
  one. This lands **before** Nasdara's row is activated.
- Shared channels (achievements, bot feed, release, ops) name the map when the item is
  map-specific.
- Clan private-channel notices (raids, flag down, incidents) name which map's base.

### 4. Seasons, leaderboards, alphas

- Already per-server tables (`seasons`, standings via seasons) keep working; season
  open/close runs per server. Nasdara opens season 1 at its flip.
- `alpha_weeks` gets `server_id`; alphas are decided per server.
- Raid-window and vehicle-wipe announcement tables get `server_id`.
- Referrals, award grants/transfers, vault, achievements, booster kits stay global
  (player- or clan-level).

### 5. Map-specific features on Nasdara

- **KOTH:** a Nasdara hill site, spawn points and restore files, structured like the
  Chernarus ones (`koth-chernarus` spec), held per server instead of as constants.
  Choosing the hill site is a launch prerequisite (Open question B).
- **Raid window:** same hours as Chernarus at launch, set separately.
- **Restart schedule:** same even-hour UTC slots; KOTH depends on them on Nasdara as
  on Chernarus.
- **Vehicle wipe:** per server, edited into Nasdara's own events.xml.
- **Bans:** per server already; enable for Nasdara.
- **Live map:** Nasdara tiles and projection; map choice follows the site switch.
- `packages/adm-parser/src/coords.ts` bounds must accept Nasdara's terrain. Verify
  Nasdara's size from its mission/ADM output before relying on `MAP_MAX = 16384`.
- Supply kits / projector: already per server; confirm the Nasdara mission's custom
  dir and the kit template work on Nasdara.

### 6. Commands and site

- Server option and fallback as in decision 10, on the listed commands. Clan commands
  (`/clan`, `/clans`, `/roster`, `/lead`, `/found`, `/guest`, `/vault`, `/me`, `/link`)
  stay server-free; where they show a base they show each map's base.
- `/found` needs no server option: the ceremony at the pole says which server.
- Site: `activeServerId()` is replaced by an explicit server parameter through roster
  reads; a switch in the header; the choice remembered per viewer (browser storage is
  fine — it is a convenience). URLs should carry the server so a shared link opens the
  right map *(builder's call on shape)*.
- Copy: "Chernarus"/"one Xbox server" strings become map-aware or neutral. Player-facing
  copy follows `brand/02-verbal-identity.md`.

### 7. Launch sequence

1. Ship the code with Nasdara's `servers` row absent or inactive. Chernarus behaves
   exactly as before.
2. Create the Nasdara Discord category and channels; set Nasdara's per-server config.
3. Wipe and reconfigure Nasdara 10x for Clan Wars (mission changes deployed per the
   `nasdara-10x` flow: direct Nitrado upload, user restarts).
4. Register/activate the Nasdara row; open its season 1.
5. Watch the first restart cycle, first KOTH, first ban (dry-run first) before
   announcing.

## Open questions

- **A. Flag pool.** Today each server has its own pool of 33 flags. With global clans
  and one flag per clan, the 33 are shared across both maps — at most 33 holding clans
  in total.
- **B. KOTH hill site on Nasdara** — who picks it.
- **C. Getting the clan flag onto the second map.** Flags are `nominal 0` in the
  mission's `types.xml`; the supply kit at a declared pole is the only source of a
  clan's flag in game (CLAUDE.md, `HOLDING_STATUSES` invariant). A clan with no Nasdara
  base has no Nasdara kit, so it has no flag to raise at a free Nasdara pole — the
  "raise your own flag at a free pole" path in §1 cannot start. Something has to put the
  flag in their hands first.

## Left to the builder

Table and column layout for global clans and per-base state; per-server config storage;
URL shape for the site's server; migration ordering (including stopping the bot if a
migration drops columns it selects, as with 0020); test strategy; how to phase the work
into PRs, provided the hit-feed rewrite and the clan migration land before Nasdara is
activated.
