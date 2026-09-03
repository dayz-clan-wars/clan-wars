# Direction: dayzclanwars.com, and the faction map

**Date:** 2026-09-02
**Status:** ⚠️ DIRECTION, not a design. Nothing here is approved, scoped or scheduled.
It is written down so the decisions it implies get made deliberately instead of being
discovered halfway through a plan. A spec in `docs/superpowers/specs/` supersedes this
the moment one exists.

---

## The intent

Long term, **Discord becomes announcements only**, and every player-facing tool lives on
a website at `dayzclanwars.com`. The model already exists and is proven: the One Life
servers run a mobile site carrying all the player controls plus a map where players share
their position.

The centrepiece is a **faction map** that always shows:

- the last known location of every member of your faction
- where your base is
- where you are

That is the feature this direction exists for. Everything else — command parity with the
bot, roster management, the public directory — follows the same move off Discord and is
easier once the shell exists.

## Why this is more reachable than it looks

**The position data is already being collected, and always has been.** `player.position`
events come from the ADM playerlist header, which this system has parsed and stored since
Plan 1. Measured against `factions_live` on 2026-09-02:

| | |
|---|---|
| Position fixes stored | 201, over two days of a small test server |
| Median gap between fixes, per player | **300 seconds, exactly** |
| p90 gap | 300 seconds |
| Gaps ≤ 400s | 178 of 197 (the rest are session boundaries) |

So the ADM log emits **one fix per online player every 5 minutes, on the dot**. The
faction map is a read model over data already in `events`, not a new ingest problem.

Two consequences worth stating up front:

- **5 minutes is the resolution ceiling, and it is a feature.** This is a strategic map —
  "where was my squad recently" — not live tracking. Nobody can use it to call shots on a
  fight in progress. If a future decision wants finer resolution it needs a different
  source, not a faster tick.
- **"Last known" is honest.** A player who logged off an hour ago has an hour-old fix,
  and the map must say so rather than implying presence.

**Identity is already solved.** `/link` binds a Discord account to a DayZ UID, verified by
a physical act in game. Discord OAuth on the website therefore lands on an identity this
system already trusts — the web app needs no account system of its own, and no second
verification ritual. This is the single biggest reason the shell is cheaper than it looks.

## What it collides with

**The pole-coordinates invariant, directly.** Today: pole coordinates are a raid target,
gated to faction members in `/faction info`, kept out of DMs, and every Discord reply is
ephemeral — `RosterReply.ephemeral` is the literal `true` so a public one will not
compile. The map shows base location by design.

That is not necessarily a contradiction — members already know where their own base is,
so showing it to them leaks nothing — but the invariant is currently written in terms of
*transport* ("ephemeral Discord replies"), and a web app has no such thing. It has to be
restated in terms of **authorization**: coordinates are visible to authenticated members
of the faction that owns them, and the compiler can no longer be the thing enforcing it.
Whatever replaces that type-level guarantee should be at least as hard to get wrong,
because the failure mode is a rival reading your base location off a URL.

This also resolves the tension noted while surveying Hulk's Killfeed, whose faction system
has a "where are you" command showing all online members on the map. Rejected for Discord —
it would put positions in a channel — but that objection is about the surface, not the
idea. Authenticated and faction-scoped, it is the same feature done safely.

**A faction map is an intelligence tool, and infiltration is a real play.** A spy who
joins a faction gets base location and member movements handed to them. In DayZ that is
arguably working as intended — infiltration is legitimate play, and the roster commands
already let a leader kick — but it should be an accepted consequence rather than a
surprise. The 5-minute resolution limits the damage.

**Session security becomes a real surface for the first time.** Everything today is
ephemeral Discord replies and DMs. A logged-in web session that shows base coordinates is
a new class of thing to get wrong, and it is worth deciding early whether sessions expire
aggressively, whether the map is behind a re-auth, and what happens on `/unlink`.

## Open questions, none of which need answering yet

- Does the site read the same Postgres directly, or does the bot grow an API? Note that
  the bot and worker currently share *no* interface but `factions.status` — adding a third
  reader is a change to that arrangement.
- Do players opt in to being visible to their own faction, or is roster membership the
  consent? One Life's model is sharing; ours has been "prove it in game" throughout.
- What happens to a dormant faction's map? Supplies stop at 7 days; the map presumably
  should not, since reviving means going back to the pole.
- Does the map show non-members ever — a raid feed, a heatmap, last known position of
  someone who killed you? Every one of those is a separate decision with a different
  threat model.
- Is `/faction info`'s coordinate gating retired, or kept as the Discord-side answer?

## What this does not change

The core thesis is unaffected: state changes are driven by things players do in the world,
proved from the server's own logs. A website is a **surface over that**, not a second
source of truth. Nothing on the site should be able to make a faction exist, hold a pole,
or lose one — those remain earned in game. The map renders history; it does not write it.
