# Booster clothing kits — design

**Date:** 2026-09-19
**Covers:** letting a Discord server booster choose a clothing kit on the site,
place it anywhere on the map by performing an emote there, and have it respawn
at that spot every reboot for as long as they keep boosting
**Builds on:** faction supplies (the object-spawner projection, `supplies.ts` /
`supply-tick.ts`), account linking (`packages/verification`), Discord login on
the web app, `armbandFor()` in `packages/domain/src/flags.ts`

---

## 1. Purpose

Boosting the Discord server currently earns nothing here. This design gives a
booster a personal clothing kit: ten pieces, nine of their own choosing, lying at a
spot on the map they picked themselves, restored whole at every server restart
for as long as they keep boosting.

The mechanism is the same vanilla DayZ object spawner faction supplies already
use: `cfggameplay.json`'s `WorldsData.objectSpawnersArr` names JSON files listing
objects to place at mission start. No mod is involved, which matters because this
is a console server. We maintain one such file, upload it through the Nitrado
API, and the kits appear at the next restart.

### The ten pieces

Nine are chosen by the booster: mask, eyewear, hat, jacket, pants, boots,
gloves, hip pack, backpack. The tenth is their clan's armband, derived rather
than chosen.

Mask, eyewear and hat occupy three separate character slots in DayZ, so a
booster can wear all three at once.

### In scope

- A curated, committed catalogue of allowed class names per slot
- A web picker for the nine chosen slots
- An emote challenge that both proves identity and captures the spot
- Generating and uploading `booster-kits.json` from current state
- Dropping a kit when its owner stops boosting, unlinks, or loses eligibility

### Out of scope, deliberately

- **Editing `cfggameplay.json`.** Adding `./custom/booster-kits.json` to
  `objectSpawnersArr` is a one-time manual edit, for the reason the supplies
  design already gives: that file boots the server, a bad automated write breaks
  the map for everyone, and the payoff is one line typed once.
- **Restarting the server so a kit appears sooner.** The site sets the
  expectation instead: it lands at the next restart.
- **Weapons, ammunition, or anything carried inside the containers.** The hip
  pack and backpack spawn empty. This perk is cosmetic and must stay that way, or
  it becomes a gear faucet rather than a thank-you.
- **Per-booster boost counts.** See §2.5.
- **A Discord command for any of this.** The site is the picker. If boosters ask
  for `/kit` later it is a small addition on top of the same table.

---

## 2. Decisions

### 2.1 The file is a projection, not a side effect

Identical reasoning to faction supplies, and the same shape. A tick regenerates
`booster-kits.json` in full from current eligible boosters, hashes the result,
and uploads only when the hash differs from the last successful upload. A failed
upload leaves the stored hash untouched, so the next tick retries.

This is what makes revocation free. Nothing deletes a kit. A booster who stops
boosting stops appearing in the generated file, and the kit is gone at the next
restart.

The supplies design records a limitation here that **no longer applies**:
that the stored hash describes what we last sent, so server-side drift goes
undetected forever. `projection-upload.ts` has since grown drift detection. It
stores the remote file's size and modified time as a baseline, re-stats the
file on every tick whose hash already matches, and calls `onDrift` and
re-uploads when the server's copy is not the one we sent. Booster kits get
that for free by using `syncProjection`, and the tick passes an `onDrift`
handler like its neighbours do.

### 2.2 The armband is derived, never stored

`armbandFor()` maps `Flag_X` to `Armband_X`, and all 34 flags have an exact
armband match. Storing the armband would mean a booster who changes clan, or a
clan that rebinds its flag, keeps a stale armband until someone notices.

Deriving it at generation time means a clan change fixes itself at the next
restart with no extra code and no migration. A booster in no faction gets nine
pieces and no armband.

### 2.3 The final emote of the sequence sets the spot

The challenge is three emotes. Only the last one's position is used.

Using the first would punish a player who opens the site, starts the sequence,
then walks to where they actually want it. Requiring all three within a radius
adds a failure mode ("you moved") for no gain. The last emote is the one the
player is thinking about the spot during, and one log line carries both the
proof and the coordinates.

Both reads are anchored inside the `(id=...)` parenthetical — `parseEmote` for
the token and `parsePlayerPos` for the position — so a gamertag crafted to
contain `performed EmoteSalute` or a fake `pos=<...>` cannot move someone's kit.
That anchoring already exists and is the reason it exists.

### 2.4 Placement is unconstrained

A booster may put their kit anywhere the emote is witnessed. No territory check,
no minimum distance from other kits, no exclusion near other factions' poles.

The consequence is accepted rather than overlooked: a kit at a fixed spot,
restored every reboot, is farmable by anyone who finds it. That is fine. The kit
is clothing, it is the booster's to place badly, and a spot that turns out to be
busy can be moved with a new emote.

### 2.5 One spot per booster, because the API forces it

Discord exposes `Guild.premiumSubscriptionCount` for the server and
`GuildMember.premiumSince` for a member. There is no per-member boost count
anywhere in the REST API or the gateway. Someone who applied two boosts is
indistinguishable from someone who applied one.

So tiering the perk by boost count is not implementable, and one spot per booster
is the only rule that can be enforced. Tiering by boost *duration* is possible
later from `premiumSince` if it is ever wanted.

### 2.6 Kit edits apply in place; moving needs a new emote

Changing gear is a site-only action and takes effect at the next restart at the
existing spot. Moving the kit issues a fresh challenge.

The emote proves a location, so only a location change needs to re-prove one.
Making someone re-emote to swap their boots is ceremony without a reason.

### 2.7 No template asset

Faction supplies needed `flag-supplies.template.json` and `loadTemplate()`
because the kit is a spatial arrangement captured at a real pole and the offsets
had to survive being moved to another pole.

A booster kit has no arrangement: all ten items spawn at the identical
position. The generator emits those objects directly from the row, so this
feature adds no template file and no template loader.

---

## 3. Data model

### 3.1 `booster_kits`

One row per booster, keyed by Discord user id.

| column | type | notes |
|---|---|---|
| `discord_user_id` | text, PK | |
| `pos_x`, `pos_y`, `pos_z` | double, nullable | null until the first emote lands |
| `mask` | text, nullable | class name, validated against the catalogue |
| `eyewear` | text, nullable | |
| `hat` | text, nullable | |
| `jacket` | text, nullable | |
| `pants` | text, nullable | |
| `boots` | text, nullable | |
| `gloves` | text, nullable | |
| `hip_pack` | text, nullable | |
| `backpack` | text, nullable | |
| `placed_at` | timestamptz, nullable | when the current spot was set |
| `updated_at` | timestamptz | |

Nine columns rather than a JSON blob: the slots are a fixed, known set, and
columns let the catalogue check live in one place with the database enforcing
nothing it cannot.

**No `dayz_id` column.** The character is joined from `identity_links` on
`discord_id`, which is unique there. Copying it here would duplicate an identity
that can change: a player who unlinks and links a different character would keep
a kit bound to a character they no longer own, and something would have to
remember to rewrite it. Joining means unlinking removes the kit by itself, with
no cascade and no cleanup step, and the challenge binds to whatever character the
link names at the moment it is issued.

The kit follows the Discord account rather than the character, which is correct:
the boost is a property of the Discord account.

The row survives loss of eligibility. Someone who stops boosting and later boosts
again gets their kit back at the next restart with no re-emote and no re-picking.

### 3.2 `discord_boosters`

A projection of Discord's member list, written by the bot and read by the ingest
worker.

| column | type | notes |
|---|---|---|
| `discord_user_id` | text, PK | |
| `premium_since` | timestamptz | when they started boosting |
| `observed_at` | timestamptz | when the tick last confirmed it |

The ingest worker has no Discord client and should not grow one. The bot has the
`GuildMembers` privileged intent already (`apps/bot/src/discord.ts:593`), which
is what makes `premiumSince` readable at all.

A new bot tick fetches the guild's members, upserts a row per booster, and
deletes rows for anyone no longer boosting. Level-triggered and idempotent, the
same shape as `restart-tick`: every run recomputes wanted state in full, so a
missed gateway event or a skipped run heals itself on the next tick rather than
leaving a phantom booster.

---

## 4. The emote flow

1. The booster signs in on the site with Discord (existing login) and must
   already be linked to a character (existing `packages/verification` flow). Not
   linked means the picker explains that and links to the existing flow.
2. They choose their nine pieces. This saves immediately, with no emote. A kit
   with no position is configured but not placed, and generates nothing.
3. To set or move the spot, the site issues a challenge: three distinct emotes
   from `safeVerificationEmotes()`, bound to their `dayz_id`, with an expiry.
4. They stand where they want the kit and perform the sequence.
5. The ingest worker parses each emote and calls `advance()` against the live
   challenge. On the final emote, the position from that same log line is written
   to `pos_x/y/z` and `placed_at`.
6. The next regeneration includes them; the kit is there at the next restart.

An expired or abandoned challenge leaves the existing spot untouched. Moving a
kit is never destructive until the new spot is actually witnessed.

---

## 5. Generation

For each eligible booster, emit up to ten objects, all at the stored position:

```json
{
  "name": "<class name>",
  "pos": [x, altitude, z],
  "ypr": [0.0, 0.0, 0.0],
  "scale": 1.0,
  "enableCEPersistency": 0,
  "customString": "<the booster's gamertag>"
}
```

`customString` carries the owner's gamertag rather than being blank. Faction
supplies already use it this way (`customString: f.tag`) so that an operator
finding a stray object can tell whose kit it belongs to. Ten unexplained
clothing items on the ground are exactly the case that needs it.

`enableCEPersistency: 0` is the whole mechanism for "every reboot": the spawner
re-places the objects at mission start regardless of what happened to the
previous ones, and they are not written to the persistence store.

**No coordinate conversion is needed, and adding one is the bug.** The ADM
line reads `pos=<x, z, altitude>`, but `parsePlayerPos` returns a `Vec3` —
`{ x, y, z }` with `y` ALWAYS altitude — so the value is already normalised
before it is stored. `declarations` uses the same convention and the spawner's
middle slot is altitude, so all three agree and nothing is reordered anywhere.

A slot holding a class name that is no longer in the catalogue is skipped, and
the rest of the kit still spawns. A catalogue edit must never be able to stop a
kit generating.

**Eligible** means all of: currently boosting (a `discord_boosters` row), linked
(an `identity_links` row to join), placed (a position), and at least one slot
filled. Anything else
is absent from the file, which is how every removal in §6 works.

---

## 6. Losing the kit

Every one of these works by the row failing the eligibility test, so none of
them needs code of its own:

| what happened | how the kit goes away |
|---|---|
| stopped boosting | no `discord_boosters` row at the next regeneration |
| unlinked their character | no `identity_links` row to join |
| cleared every slot on the site | nothing to spawn |
| left the Discord server | member fetch no longer returns them |

The gap between the act and the effect is bounded by the booster tick interval
plus the time to the next restart. A few hours at worst. That was chosen over a
grace period: the perk is for people who are boosting, and an honest, immediate
rule is easier to state than an expiry nobody can see.

---

## 7. The catalogue

A committed data file, maintained by hand, listing allowed class names per slot
with the display name the site shows.

Hip packs have no wiki category of their own and come straight from
`types.xml`: `HipPack_Black`, `HipPack_Green`, `HipPack_Medical`,
`HipPack_Party`.

Hand-maintained rather than derived from `types.xml`, because `types.xml` carries
no slot metadata (so a classification pass is needed either way), includes
variants nobody wants, and would let a DayZ update silently add something to the
picker that should not be there.

The same file is the validator: the site rejects a pick that is not in it, and
generation skips one that has since left it.

---

## 8. Testing

Generation is pure functions in the style of `supplies.ts`, unit tested:

- a row plus a faction becomes ten objects at one position (nine chosen slots
  plus the derived armband)
- coordinate order: ADM `pos=<x, z, alt>` becomes JSON `[x, alt, z]`
- armband derivation, including the no-faction case producing nine objects
- the eligibility filter, one case per row of §6's table
- a slot holding a class name absent from the catalogue is skipped, not fatal

Emote capture gets ADM fixtures, including the hostile-gamertag cases that
`parseEmote` and `parsePlayerPos` are anchored against: a name containing
`performed EmoteSalute`, and a name containing a `pos=<...>` block.

The tick gets tests with a fake Nitrado client, covering the two behaviours the
projection depends on: an upload failure leaves the stored hash untouched so the
next tick retries, and an unchanged file is not re-uploaded.

---

## 9. Deployment

One manual step, once: add `./custom/booster-kits.json` to
`WorldsData.objectSpawnersArr` in `cfggameplay.json`, alongside the supplies
file. `docs/deploy/raid-window.md` already warns against touching other keys in
that file; the same care applies.

Until that edit is made the tick uploads a file the server ignores, which is a
safe state to deploy into and a safe state to roll back to.

---

## 10. Player-facing copy

The picker, the emote instructions, and the "it lands at the next restart" line
still need writing. Plain voice, no em dashes, and nothing that frames the kit as
protected or off-limits: it is loot like anything else once it is on the ground.
