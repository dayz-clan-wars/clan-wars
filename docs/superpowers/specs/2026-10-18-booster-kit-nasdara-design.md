# Booster kit: Nasdara gear, helmets and vests

**Date:** 2026-10-18
**Status:** approved in chat, awaiting review of this document

## Why

The server moved to Nasdara on 2026-10-17, and the booster kit still offers
only Chernarus-era wearables. Boosters should be able to spawn in the gear
that makes Nasdara look like Nasdara: the desert hunting gear, keffiyehs,
shalwar pants, OBR uniforms, robe vests and so on. The operator also wants
helmets and vests in the kit, plate carriers included, and two of those as
complete sets: the MICH helmet with its night-vision kit, and each plate
carrier with its matching pouches and holster.

## Goals

1. Add every Nasdara-only wearable listed below, in every colour, to the
   booster catalogue.
2. Add a tenth slot, **Vest**, holding the Nasdara vests and all five plate
   carriers.
3. Add helmets to the existing **Headgear** slot (the `hat` key, already
   labelled "Headgear" on the page).
4. Let a catalogue entry bring **extra items** with it, and use that for the
   MICH and the plate carriers.

## Non-goals

- No change to which items exist on the server or how often they spawn
  (`types.xml` is untouched). Plate carriers are rare on the map (deloot
  only, 17 nominal across all colours); offering them to every booster is a
  deliberate choice by the operator.
- No separate helmet slot. Hats and helmets share one head slot in game, so a
  separate picker would let a booster choose two things they cannot wear at
  once.
- No pre-fitted attachments. See "How it arrives".
- No removal of anything already in the catalogue.

## Anti-goals

- A booster choosing something that does not spawn, or spawns as the wrong
  thing. Every class name must be one Nasdara's `types.xml` knows.
- A label that differs from what the game shows. Players search the picker by
  the name they see in their inventory (same rule as the Fishtail Night Ops
  items in 2.1.0).
- Two options in one slot a player cannot tell apart (the catalogue already
  refuses duplicate labels; keep it that way).

## What is added, by slot

Class names are from Nasdara's `db/types.xml` (dayz-one-life/nasdara,
`main`). "Every colour" means every class listed.

**Headgear (`hat`)**
- Pakol hat: `PakolHat_Beige`, `_Black`, `_Brown`, `_Grey`, `_White`
- Turban: `TurbanHat_Beige`, `_Black`, `_Brown`, `_Green`, `_Grey`,
  `_NavyBlue`, `_Pink`, `_Purple`, `_Red`, `_Skyblue`, `_White`, `_Yellow`
- OBR cap: `OBRCap_Beige`, `OBRCap_Olive`
- `MilitaryBeret_TK`
- `GhillieHood_Desert`
- Helmets: `Mich2001Helmet`; `BallisticHelmet_BDU`, `_Black`, `_Desert`,
  `_Green`, `_Navy`, `_UN`, `_Winter`, `_Woodland`; `T56TankerHelmet_Olive`,
  `T56TankerHelmet_Tan`

**Mask (`mask`)**
- Keffiyeh: `Keffiyeh_Black`, `_Blue`, `_Brown`, `_Gray`, `_LightBlue`,
  `_LightBrown`, `_LightRed`, `_Red`

**Eyewear (`eyewear`)**
- `DustGoggles_Black`, `DustGoggles_Transparent`

**Jacket (`jacket`)**
- `HuntingJacket_Desert`
- OBR jacket: `OBRJacket_Beige`, `OBRJacket_Olive`, `OBRJacket_Officer`
- Kameez shirt: `KameezShirt_Beige`, `_Black`, `_BlueFlowers`, `_Brown`,
  `_Grey`, `_NavyBlue`, `_Olive`, `_Orange`, `_Pink`, `_Purple`, `_Red`,
  `_SkyBlue`, `_White`, `_Yellow`
- Short-sleeve shirt: `ShortSleeveShirt_Black`, `_BlueRectangles`,
  `_CreamSquares`, `_Green`, `_Waves`, `_White`, `_Hawaiian_Black`,
  `_Hawaiian_Blue`, `_Hawaiian_White`
- `TacticalShirt_ION_Olive`, `TacticalShirt_ION_Tan`
- `PoliceShortSleeveShirt`
- `GhillieTop_Desert`

**Pants (`pants`)**
- `HunterPants_Desert`
- Men's shalwar: `MensShalwarPants_Beige`, `_Black`, `_Brown`, `_Grey`,
  `_NavyBlue`, `_SkyBlue`, `_White`
- Women's shalwar: `WomensShalwarPants_NavyBlue`, `_Olive`, `_Orange`,
  `_Pink`, `_Purple`, `_Red`

**Boots (`boots`)**
- `SandalsShoes_Black`, `_BlueNavy`, `_Brown`, `_Grey`
- `TraditionalSandalShoes_Black`, `_Brown`, `_LightBrown`, `_NavyBlue`

**Backpack (`backpack`)**
- `AssaultBag_Desert`, `CoyoteBag_Desert`
- `GhillieSuit_Desert`

**Vest (`vest`, new)**
- `HuntingVest_Desert`
- Robe vest: `RobeVest_Beige`, `_Brown`, `_Green`, `_Grey`, `_Navy`
- Linen vest: `LinenVest_Black`, `_Brown`, `_DarkGrey`, `_Green`, `_Grey`,
  `_NavyBlue`
- Chest rig: `ChestRigVest_Khaki`, `_Olive`, `_Tan`
- `HighCapacityVest_ION`
- `UKAssVest_Desert`
- Plate carriers: `PlateCarrierVest`, `_Black`, `_Camo`, `_Green`, `_Winter`

The slot grouping above is the author's reading. **The builder must check
each class's real inventory slot** (game config or the wiki) and move any
item whose slot differs. The likely suspects are the keffiyehs (face or
head?), the ghillie hood, top and suit, and `MilitaryBeret_TK`. An item
whose slot has no kit slot at all is dropped and reported to the operator
in the PR description, not forced in.

Every class name in this document, extras included, was read from Nasdara's
`types.xml` on 2026-10-18. The plan should still re-check the final list
against that file in one step (`git -C ../nasdara show origin/main:db/types.xml`),
because a typo here becomes an item that never spawns.

Deliberately left out: `GhillieAtt_Desert` and `GhillieBushrag_Desert`
(weapon and helmet wraps, not wearables in their own right), the lizard
leather belt, hip pack and knife sheath (nominal 0 on Nasdara), and the
non-wearables (pots, wine bottle, waterskin).

## Bundled extras

| Choice | Also spawns |
|---|---|
| `Mich2001Helmet` | `NVGoggles`, `UniversalLight`, `Battery9V`, `Battery9V` |
| `PlateCarrierVest` | `PlateCarrierPouches`, `PlateCarrierHolster` |
| `PlateCarrierVest_Black` | `PlateCarrierPouches_Black`, `PlateCarrierHolster_Black` |
| `PlateCarrierVest_Camo` | `PlateCarrierPouches_Camo`, `PlateCarrierHolster_Camo` |
| `PlateCarrierVest_Green` | `PlateCarrierPouches_Green`, `PlateCarrierHolster_Green` |
| `PlateCarrierVest_Winter` | `PlateCarrierPouches_Winter`, `PlateCarrierHolster_Winter` |

The two batteries are one for the goggles and one for the light (author's
guess; the user did not object). All of these classes exist in Nasdara's
`types.xml`.

The catalogue gains an optional `extras: string[]` per entry, the same shape
and the same validation as `AwardItem.extras` in
`packages/domain/src/awards.ts` (when present, a non-empty list of non-empty
class names). The award kit already delivers extras this way; follow its
path rather than inventing a second one.

⚠️ The `booster-kit` award has `"slotsFrom": "booster-catalogue"`:
`awardsCatalogue()` builds its slots from this catalogue in `KIT_GRID_ORDER`.
So the new Vest slot, the new items and their extras all reach that award as
well, and every extra needs a label in `apps/web/lib/award-parts.ts` (a test
enforces it). That is intended: the booster-kit award should match the
booster kit.

⚠️ **Vest is optional for the award (author's call).** `picksComplete` in
`awards.ts` requires every slot, and `award-tick.ts` leaves a grant with a
missing pick out of the spawner file entirely. Without an exception, every
live `booster-kit` grant (some run 7 days) would stop spawning the moment
the Vest slot exists, until its winner came back to pick one. So a grant
whose only missing pick is the vest counts as complete, and its kit spawns
without one. That matches the booster kit, where an empty slot simply spawns
nothing.

The picker should say what comes with a choice, so a booster picking a plate
carrier knows the pouches and holster are included. How it says it is left to
the builder; it should follow whatever the award page already does for
extras, if anything.

## How it arrives

The kit is written to the object spawner file
(`apps/ingest-worker/src/booster-kits.ts`) as loose objects at the spot the
booster marked. The spawner cannot place one item inside or onto another, so
the NVGs, light, batteries, pouches and holster arrive **loose in the pile**,
and the player fits them. This matches how the weapon kit's magazines and
optics arrive today. The user has been told and accepted it.

## The Vest slot

- A tenth entry in `KIT_SLOTS`, labelled "Vest", which means a new nullable
  column on `booster_kits` and a migration.
- Kits saved before the change get no vest (null). Nobody is assigned one;
  boosters fill it on their next visit.
- Wherever the code says "nine slots" (comments, the docblock on `KIT_SLOTS`,
  tests, page copy such as `KIT_PIECES`), it becomes ten.
- **Grid placement (author's call):** the page lays slots out in three
  columns, so ten leaves one tile on its own. Put Vest straight after Jacket in
  `KIT_GRID_ORDER`, so the big pieces stay together at the top, and let the
  last small piece sit alone on the fourth row. The builder may pick a
  different arrangement if it reads better at phone and desktop width.

## Labels and images

- Labels are the in-game display names, in the catalogue's existing style
  ("Name (Colour)"). Labels must be unique per slot, and the catalogue stays
  sorted by label.
- Images: fetch with `apps/web/scripts/fetch-item-images.ts` where either wiki
  has art (192 px webp in `apps/web/public/items/`, mapped in
  `apps/web/src/item-images.ts`). Items with no art ship without an `image`
  and render as the "No art" tile; add them to `NO_ART_YET` in
  `packages/domain/test/booster-kit.test.ts`. Extras do not need images.

## Release

A minor bump (new slot, new catalogue feature): 2.2.0, through the usual
release flow with a CHANGELOG entry in player-facing language.

## Left to the builder

- Reading each item's in-game name and real inventory slot.
- How the extras are carried from the saved kit to the spawner file.
- How the picker shows what is included with a choice.
- The exact grid order, within the guidance above.
