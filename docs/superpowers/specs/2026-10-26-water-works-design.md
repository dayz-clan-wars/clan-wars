# Water Works and Community Service — design

2026-10-26. Two new achievements for rebuilding the map's ruined water wells, and
the first achievement that pays out an award.

## Why

Players have started rebuilding ruined wells on Nasdara (first seen 2026-10-22). It is
slow, useful, public-spirited work — a working well helps everyone who passes — and
nothing in Clan Wars notices it today. The operator wants it recognised, and wants
the player who finishes a well to get something worth having for it.

## What a well rebuild looks like in the log

A ruined well is rebuilt in three steps, each one ADM `Built … with …` line, parsed today
into a `base.built` event (`payload.part`, `payload.tool`, `payload.pos`, `payload.dayzId`):

| Step | `part` | Tool seen |
|---|---|---|
| 1. Clear the rubble | `rubble_rubble1` | Pickaxe, Shovel |
| 2. Lay the brick | `well_brick` | Brick Trowel |
| 3. Build the roof — the well is now complete | `roof` | Hatchet, Hammer |

⚠️ The ADM line leaves the object name blank (`Built well_brick on  with Brick Trowel`),
so `payload.structure` is null. A step is recognised by its part name and its position,
never by an object name.

⚠️ None of the three part names is unique to wells on its own:

- `rubble_rubble1` (and `rubble_rubble2`/`3`) is also logged when clearing the other
  rebuildable ruins, which is most of the 55 rubble events so far.
- A bare `roof` has only ever appeared on the two wells so far, but other rebuildables log
  `roof1`–`roof3` and watchtowers `level_N_roof`; a future structure could log `roof`.
- `well_brick` is the only well-specific part.

Our mission files do not list where the ruined wells are (`Water_Well_N1` appears only as a
crafted type in `db/types.xml`), so the set of wells cannot be known in advance.

**Therefore a well is a place where a `well_brick` has been laid.** Every other step is
attributed to a well by position: within `WELL_RADIUS_M` (2D) of that well's `well_brick`.
`WELL_RADIUS_M` is the builder's call — the two wells seen so far have their rubble, brick
and roof within ~3 m of each other (8437/11451.8 → 8436.4/11449.9 → 8438.8/11448.9;
4640/5680.6 → 4639/5680.2 → 4640/5683.3), so something around 5 m — and must be small enough
that two wells in one village are never confused.

## The two achievements

Both are `pve`, player-owned, lifetime, earned once, and behave like every existing
achievement (badge wall, Discord post, notification, `achievement_unlocks`).

### Community Service — no reward

Earned by **anyone who works on a well**: clears its rubble, lays its brick, or builds its
roof (the roof added by the operator, 2026-10-26 — so a roof-builder earns both
achievements).

- It is earned **once the well's brick is laid** — that is the moment the spot becomes a
  known well. A player who cleared rubble there earlier earns it then, at the same time as
  the brick-layer (operator's example: A clears the rubble, B lays the brick, both earn
  Community Service when the brick goes in).
- Rubble cleared at a spot that never gets a brick earns nothing — nothing marks it as a well.
- Rubble cleared, or a roof built, at a well after its brick is already laid earns it
  straight away. (A roof always follows the brick, so a roof-builder is credited at the roof.)
- One player doing several steps earns it once.
- No award attached.

### Water Works — with a plate carrier

Earned by **whoever builds the roof on a well**. Only the roof-builder counts; clearing
rubble or laying the brick earns nothing towards it (operator, on the 2026-10-24 group build
where one player laid the brick and another put the roof on).

- A `roof` counts only when it is within `WELL_RADIUS_M` of a laid `well_brick`.

## The plate carrier award

- **Every well a player roofs** earns them one `plate-carrier` award for **7 days** (the
  catalogue's own `durationDays` is already 7). This is per well, not per achievement:
  Water Works is earned once, the plate carriers keep coming.
- **Not the same well twice.** A player who roofs a well they have already been paid for —
  after it decays and is rebuilt, say — gets nothing more for it. Another player roofing the
  same well later is paid for it. The rule is **once per player per well, for good**
  (operator, 2026-10-26).
  ⚠️ So a well's identity must survive decay: a rebuild after decay logs a NEW `well_brick`
  at roughly the same spot, which must resolve to the SAME well — a new brick within
  `WELL_RADIUS_M` of an existing well is that well, never a new one. Keying wells by the
  `well_brick` event id would pay a rebuild twice. "Player" means the in-game character
  (`dayz_id`), the same identity achievements use.
- The award behaves exactly like any other granted award: the player picks and places it on
  `/awards`, it respawns for its duration, and it can be given away.
- **Unlinked players: held, same as bounty prizes.** An award can only go to a linked
  Discord account. A player who roofs a well while unlinked is owed the plate carrier, and it
  is paid the tick after they link. It is never dropped. Model this on `payBountyAwards`
  (`apps/bot/src/bounty-tick.ts`): a durable "owed" record per (player, well), an
  idempotent level-triggered payout that sets the grant id in the same transaction as the
  grant, and a recorded failure (not an endless retry) if `plate-carrier` ever leaves the
  catalogue.
- The grant's reason should name what it was for, e.g. "Rebuilt a well". Never a coordinate
  — well positions are public map objects, but award reasons reach DMs and the site, and the
  house rule is no coordinates in published text.

## Past builds count

When this ships, history is included: the rules read the whole `base.built` log, so the
existing rebuilds are credited on the first run, through the normal achievements backfill.

As of 2026-10-26 that means:

| Well | Rubble | Brick | Roof |
|---|---|---|---|
| Near Bad Asyab | RonaldRaygun552 (Oct 21) | RonaldRaygun552 (Oct 22) | RonaldRaygun552 (Oct 22) |
| Near Bagh-e Mir | CPT Hawkeye3482 (Oct 24) | CPT Hawkeye3482 (Oct 24) | helifighter06 (Oct 24) |

So: Community Service to RonaldRaygun552, CPT Hawkeye3482 and helifighter06; Water Works and one plate
carrier each to RonaldRaygun552 (linked — paid at once) and helifighter06 (not linked — held
until they link).

⚠️ The achievements backfill announces nothing for old unlocks today
(`backfill-achievement-notices.ts` exists for that). Whether these first unlocks post to
Discord is the builder's call; the awards themselves must be granted either way.

## Goals

- Recognise everyone who works on a well, and reward the person who finishes one.
- Pay a plate carrier per finished well, once per player per well, including to players who
  link later.
- Credit the rebuilds that already happened.

## Non-goals

- Tracking wells that never get a brick.
- Any change to how wells work in game, or to the mission files.
- Rewarding any other rebuildable structure.

## Anti-goals

- Paying twice for the same well to the same player, through a replay, a rebuild after decay,
  a crash mid-grant, or a rebuild of `kills`/events.
- Dropping an owed plate carrier because the player was not linked yet.
- Crediting a house's rubble or some other structure's `roof` as well work.
- Putting a coordinate in an achievement's evidence, a notice, a feed row or an award reason.

## Constraints from the codebase

- Achievement definitions live in `packages/domain/src/achievements.ts`. The header says "the
  fifty"; this makes 52 — update that and anything that counts them (the guide chapter, tests).
- Every key needs a rule (`apps/bot/src/achievements/rules.ts`, held by `rules.test.ts`) and
  badge art (`apps/web/public/achievements/{unlocked,locked,svg}/<key>`, then regenerate
  `lib/achievement-glyphs.ts` via the web `prebuild` and commit it).
- `base.built` is already in the achievements tick's `RULE_EVENT_TYPES`, so a new
  `base.built` event already marks its builder as touched. ⚠️ Community Service can be earned
  by a player with **no new event** of their own: A cleared rubble yesterday, B lays the brick
  today, and A earns it from B's event. The touch logic must also mark everyone who cleared
  rubble near a newly laid `well_brick`, or A is only credited when A next builds something.
- Rule evidence must never carry a coordinate (`types.ts`).
- Lock order (CLAUDE.md, spec §4.12): any new table that sits beside `award_grants` must be
  placed in the order and documented there, as bounties were.
- `award_grants.granted_by_discord_id` is required; automatic grants elsewhere pass an
  operator or bot id (see `referral-award.ts`, `koth-score.ts`). The builder picks the source.
- A new feature tick that grants awards has been gated behind an env flag every time so far
  (`BOUNTY_TICK`, `REFERRAL_AWARD_TICK`, `KOTH_TICK`). Expect the same here.
- Add a `CHANGELOG.md` `[Unreleased]` entry (player-facing voice: plain, no jargon).

## Left to the builder

- `WELL_RADIUS_M` and where it lives (`rules.ts` in `packages/domain`, and in the guide if it
  is player-facing).
- How a well is identified in storage (e.g. the `well_brick` event's id or rounded position).
- The badge art and descriptions' exact wording.
- Whether the owed-award work runs inside the achievements tick or as its own tick.
- Whether the backfill posts unlock notices.
