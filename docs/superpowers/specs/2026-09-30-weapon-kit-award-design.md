# Weapon kit award — design

**Date:** 2026-09-30
**Status:** designed, not implemented
**Covers:** a new event award, `weapon-kit`, where the winner picks one of twelve
guns and it spawns with a fixed, fully kitted set of parts
**Builds on:** event awards (`docs/superpowers/specs/2026-09-22-awards-design.md`
— the catalogue, the pick page, placement, the spawner projection and its
respawn-every-restart rule)

---

## 1. Purpose

Event winners should be able to take a gun as a prize. A bare gun is not much of a
prize, and most guns need parts to be usable: a magazine at minimum, and an optic,
stock and handguard to be good. The award catalogue today is one class name per
pick, with no way to say "this mag goes with this gun".

The weapon kit keeps the player's choice to one pick, the gun, and has each gun
carry a fixed list of parts that spawn beside it.

### In scope

- An optional `extras` list on a catalogue item, validated by `loadAwards`
- The `weapon-kit` award with the twelve loadouts in §3
- The award tick expanding a pick into the gun plus its extras
- Showing the parts on the award pages
- Item art for the twelve guns, from the DayZ wiki via `fetch-item-images.ts`.
  No wiki has a green AK74, so `AK74_Green` shows the plain AK74, and
  `M4A1_Green` uses an older green M4 render

### Out of scope

- Letting the player choose attachments (considered, see §5)
- Loose ammunition: every gun in §3 is magazine-fed, and object-spawner mags
  spawn full (confirmed by the owner from the bunker enhancements on Livonia)

## 2. Behaviour

- The award has one slot, `weapon` ("Weapon"), listing the twelve guns.
- `durationDays` is **3**. Awards respawn whole at every restart for the whole
  grant (awards spec §2.1), so a gun award is a supply point of up to 36 kitted
  guns; 3 days keeps that shorter than the 7-day awards. `/award grant days:` still
  overrides it per grant.
- The stored pick is the gun's class name, so `award_grants.picks`, `isAwardPick`,
  `isComplete` and placement are unchanged.
- The spawner file places the gun and each extra as separate loose objects at the
  placed spot, the same way award and booster kit items already spawn, and like
  the loose guns, mags, optics and suppressors in
  `livonia/custom/bunker-enhancements.json`. Parts are not attached to the gun; the
  player fits them.
- Every part comes from the options `livonia/cfgspawnabletypes.xml` lists for that
  gun (directly or through `cfgrandompresets.xml`), so each is known to fit.
- An optic that takes a battery (`ReflexOptic`, `KobraOptic`, `M68Optic`,
  `M4_T3NRDSOptic`, the PSO scopes) gets a `Battery9V` in the extras. The ACOGs and
  the MK4 do not take one.

## 3. Loadouts

Two magazines each. Extras are listed in spawn order.

| Gun | Label | Extras |
|---|---|---|
| `M4A1_Green` | M4A1 (Green) | `M4_OEBttstck`, `M4_RISHndgrd_Green`, `ACOGOptic_6x`, `M4_Suppressor`, 2× `Mag_STANAG_60Rnd` |
| `M16A2` | M16A2 | `M4_Suppressor`, 2× `Mag_STANAG_60Rnd` |
| `AKM` | AKM | `AK_PlasticBttstck`, `AK_PlasticHndgrd`, `KobraOptic`, `Battery9V`, `AK_Suppressor`, 2× `Mag_AKM_Drum75Rnd` |
| `AK101_Green` | AK101 (Green) | `AK_FoldingBttstck_Green`, `AK_RailHndgrd_Green`, `KobraOptic`, `Battery9V`, `AK_Suppressor`, 2× `Mag_AK101_30Rnd` |
| `AK74_Green` | AK74 (Green) | `AK_PlasticBttstck_Green`, `AK_RailHndgrd_Green`, `KobraOptic`, `Battery9V`, `AK_Suppressor`, 2× `Mag_AK74_45Rnd` |
| `FAL` | FAL | `Fal_OeBttstck`, `ACOGOptic_6x`, 2× `Mag_FAL_20Rnd` |
| `SCARH` | SCAR-H | `SCAR_PrecisionBttstck`, `ACOGOptic_6x`, 2× `Mag_SCARH_20Rnd` |
| `Aug` | AUG | `ACOGOptic_6x`, `M4_Suppressor`, 2× `Mag_STANAG_60Rnd` |
| `ASVAL` | AS VAL | `ACOGOptic_6x`, 2× `Mag_Vikhr_30Rnd` |
| `SVD` | SVD | `PSO6Optic`, `Battery9V`, `AK_Suppressor`, 2× `Mag_SVD_10Rnd` |
| `M14` | M14 | `MK4Optic_black`, 2× `Mag_M14_20Rnd` |
| `SV98` | SV98 | `MK4Optic_black`, 2× `Mag_SV98_10Rnd` |

The M16A2 has a fixed stock and a carry handle, so it takes no stock, handguard or
optic. The FAL, SCAR-H, M14 and SV98 have no suppressor in the file. The AS VAL's
suppressor is built in.

## 4. Changes

### 4.1 Catalogue type and loader (`packages/domain/src/awards.ts`)

`AwardItem` becomes `{ className: string; label: string; image?: string; extras?: string[] }`.
`loadAwards` rejects an `extras` that is not an array of non-empty strings, and an
empty array (leave the field out instead). Repeats are allowed: they are how a
loadout gets two magazines. The duplicate-className check still applies to
`className` only, not to extras.

### 4.2 Catalogue (`packages/domain/assets/awards.json`)

A `weapon-kit` entry with `label` "Weapon Kit", `durationDays` 3 and the `weapon`
slot from §3.

### 4.3 Award tick (`apps/ingest-worker/src/award-tick.ts`)

Where `items` is built from the picks, each pick expands to
`[className, ...(item.extras ?? [])]`, looked up from the catalogue item for that
slot. Awards without extras produce the same file as before, byte for byte.

⚠️ `generateBoosterKits` spawns every item of a kit at one identical position,
as booster kits and the plate carrier already do. A weapon kit stacks up to eight
objects there (the gun, stock, handguard, optic, battery, suppressor, two mags);
check on the test server (§6) that all of them are there and can be picked up
from the pile, and change the generator only if they cannot.

### 4.4 Award pages (`apps/web`)

On `/awards/<id>`, once a gun is picked, a "Comes with" line under the tiles
lists its extras, with repeats collapsed ("2× 60-round STANAG mag"). The shared
pick sheet (`kit/pick-sheet.tsx`, also the booster kit page's) is not changed.
Part labels come from a map of class name to readable label in
`apps/web/lib/award-parts.ts`; a test requires a label for every extra in the
catalogue, so there is no fallback. A picked tile with no art shows no "+" (the "+" means empty).

## 5. Alternatives considered

- **Choosing attachments per gun.** A second step where the player picks optic,
  stock and suppressor from the gun's compatible parts. Needs slots that depend
  on another slot's pick, across the catalogue, the pick page and the tick.
  Rejected as more change than the prize needs.
- **Bare gun, let the game roll attachments.** Depends on whether the object
  spawner applies `cfgspawnabletypes` to what it spawns, which is unconfirmed, and
  would re-roll the kit every restart. Rejected.
- **Every gun in the file.** Considered, but the owner chose a hand-picked twelve.

## 6. Testing

- Loader: `extras` accepted; a non-array, a non-string entry, an empty string and
  an empty array are each rejected; repeats accepted.
- Catalogue: the shipped `awards.json` loads, and `weapon-kit` has the twelve guns.
- Award tick: a `weapon-kit` grant produces the gun plus every extra, in order,
  with repeats; the plate carrier's output is unchanged.
- Web: the "Comes with" line renders and collapses repeats.
- On the Livonia test server: grant, pick and place one kit; after the restart,
  check every part is there and can be picked up from the pile, the mags are full, each
  part fits its gun, and the battery powers the red dot.
