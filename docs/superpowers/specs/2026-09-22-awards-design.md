# Event awards — design

**Date:** 2026-09-22
**Status:** designed, not implemented
**Covers:** letting an admin grant a community-event winner an award; the winner
chooses the award's items on the site, places it anywhere on the map by performing
an emote there, and it respawns at that spot every restart for the award's
duration, then stops
**Builds on:** booster kits (`docs/superpowers/specs/2026-09-19-booster-kits-design.md`
— the catalogue loader, the pick sheet, the emote placement challenge, the
object-spawner projection), scheduled restarts (`nextRestartAt()` in
`packages/domain/src/restarts.ts`), the notice queue (`clan_notices`)

---

## 1. Purpose

Community events are coming, and their winners need a prize. An award is a booster
kit with its own definition: a set of slots, the items allowed in each, and a
duration. An admin grants one to a winner from Discord; the winner gets a DM
linking to a page on the site, picks their items, performs an emote sequence in
game to mark where it spawns, and it appears there at every restart until the
duration runs out.

The first award is the **plate carrier**: a vest, pouches and a holster, one
variant of each chosen from the six the server defines (plain, `_Black`, `_Camo`,
`_Desert`, `_Green`, `_Winter`), live for one week.

### In scope

- A committed, validated award catalogue (`awards.json`)
- `/award grant`, `/award revoke`, `/award list` — admin-only Discord commands
- A grant DM, and `/awards` / `/awards/<id>` pages to configure and place
- Generalising the booster placement challenge so it can place either subject
- Generating and uploading `awards.json` (the spawner file) with a per-grant clock
- Item art for the 18 plate carrier pieces

### Out of scope

- Reminder or expiry DMs
- Public announcement of winners
- Any award other than the plate carrier (each later one is an `awards.json`
  entry plus art — no code)
- Editing a grant beyond revoking it

---

## 2. Decisions

### 2.1 Respawn every restart is the prize — accepted, not overlooked

Award objects spawn with `enableCEPersistency: 0`, exactly like booster kits, so
they are restored whole at every restart. With restarts every two hours for seven
days, that is up to 84 plate carrier sets for a winner who camps their spot — and
for anyone else who finds it. This was put to the owner explicitly on 2026-09-22
and chosen: the award is effectively a plate carrier supply point for a week.
Do not "fix" it by switching to a persistent spawn — see §2.2.

### 2.2 Why not spawn once and persist

A persistent object cannot be made to "go away after a week": once picked up it is
ordinary gear, and removing the spawner entry only stops future spawns. It would
also need the entry removed immediately after the first boot to avoid duplicate
spawns. It fails the one requirement that makes an award temporary.

### 2.3 Award types live in code

`packages/domain/assets/awards.json`, reviewed by PR, validated at load. A
misspelled class name spawns nothing and raises no error anywhere, so the place to
catch it is review plus load-time validation — not an admin typing it into a
command. `/award grant` accepts only known keys.

### 2.4 One grant per win

Each grant is its own row with its own picks, position and clock. Winning twice
means two sets, configured and placed separately.

### 2.5 The clock starts at the first restart that spawns it

The week counts from when the award first exists in the world, not from grant or
placement. So that a grant never placed cannot hold the award forever, it must
be placed within `AWARD_PLACE_BY_MS` (7 days) of the grant, or it lapses.

### 2.6 One open placement challenge per account, across both subjects

The booster kit and award placements both read the same `emote.performed` stream.
Two open challenges on one account would each count the same emotes. The existing
partial unique index on open challenges is kept and shared, so the rule lives in
one index, not in two tables kept in step by hand.

---

## 3. Data model

### 3.1 `awards.json`

```json
{
  "plate-carrier": {
    "label": "Plate Carrier",
    "durationDays": 7,
    "slots": {
      "vest":    { "label": "Vest",    "items": [ { "className": "PlateCarrierVest",       "label": "Plain",  "image": "items/PlateCarrierVest.webp" } ] },
      "pouches": { "label": "Pouches", "items": [ { "className": "PlateCarrierPouches",    "label": "Plain",  "image": "items/PlateCarrierPouches.webp" } ] },
      "holster": { "label": "Holster", "items": [ { "className": "PlateCarrierHolster",    "label": "Plain",  "image": "items/PlateCarrierHolster.webp" } ] }
    }
  }
}
```

(Each slot carries all six variants; one shown.) `loadAwards` validates, and throws
on: a duplicate class name or label within a slot, an image path other than
`items/<className>.webp`, a slot with no items, an award with no slots, a
non-positive or non-integer `durationDays`, or an award key that is not lowercase
kebab-case. It is reachable through a subpath (as `@factions/domain/catalogue` is),
so the JSON is not pulled into every domain consumer.

Only the duration differs per award, so it lives in the JSON. Shared numbers go in
`rules.ts`:

- `AWARD_PLACE_BY_MS` = 7 days
- `AWARD_REMOVAL_LEAD_MS` = 15 minutes — how far ahead of the expiry restart the
  file must already have dropped the award (§5.3)

### 3.2 `award_grants`

| column | notes |
|---|---|
| `id` bigserial PK | referenced by the page URL and the placement challenge |
| `award_key` text not null | a key in `awards.json`; code-validated, not an FK |
| `discord_id` text not null | the winner |
| `granted_by_discord_id` text not null | the admin |
| `reason` text not null | e.g. "Winner, Sept king-of-the-hill"; shown in the DM and on the page |
| `picks` jsonb not null default `{}` | `{slotKey: className}`; jsonb because slots vary per award |
| `pos_x`, `pos_y`, `pos_z` numeric(12,2) | same meaning and type as `booster_kits` |
| `placed_at` timestamptz | last placement |
| `granted_at` timestamptz not null | |
| `place_by` timestamptz not null | `granted_at + AWARD_PLACE_BY_MS` |
| `live_from` timestamptz | null until stamped (§5.2) |
| `expires_at` timestamptz | null until stamped; `live_from + durationDays` |
| `revoked_at` timestamptz | `/award revoke` or leaving the guild |
| `updated_at` timestamptz not null | |

Index on `discord_id`.

**No status column.** State is derived by one pure function in `packages/domain`
(`awardState(grant, now)`) from the timestamps:

| state | condition |
|---|---|
| `revoked` | `revoked_at` set |
| `expired` | `expires_at` set and `now >= expires_at` |
| `lapsed` | `placed_at` null and `now >= place_by` |
| `live` | `live_from` set and `now >= live_from` |
| `waiting` | placed, not yet live |
| `unplaced` | otherwise |

Checked in that order. A stored status would be one more thing to fall out of step
with the timestamps it summarises.

### 3.3 `booster_kit_challenges` gains `award_grant_id`

The migration adds
`award_grant_id bigint references award_grants(id) on delete cascade` — null means
the booster kit. The one-open-challenge-per-account partial unique index is
unchanged. ⚠️ It is the only guard against a booster challenge and an award
challenge counting the same emotes (§2.6).

The table keeps its name, though it now places two subjects. Renaming it makes
`drizzle-kit generate` stop at an interactive "renamed or created?" prompt, and no
migration in this repo has ever renamed a table; the name is a smaller cost than a
hand-written rename. The schema comment says what the table now holds.

### 3.4 `award_uploads`

Same columns as `supply_uploads` / `booster_kit_uploads`, so `storeFor()` serves it.
Its own table so this file's hash and drift baseline cannot cross the booster
file's.

### 3.5 Lock order

`award_grants` joins the order immediately before `faction_events`. Every writer
takes it after any roster tables and before `clan_notices`: grant (`award_grants →
clan_notices`), revoke, `removeFromGuildDb`, and the placement tick
(`booster_kit_challenges`, outside the order as today, then `award_grants`).
`award_uploads` is outside the order: written by the worker's single upsert alone.

---

## 4. Flows

### 4.1 Grant

`/award grant user:@winner award:<autocomplete> reason:<text>`, gated on
ManageGuild exactly as `/airdrop place` is, ephemeral reply like every command.
It calls `grantAwardDb` from `@factions/roster/internal`, which in one transaction
inserts the `award_grants` row and appends an `award_granted` DM to `clan_notices`
(`target: "dm"`, `payload: {grantId, awardKey, label, reason, placeBy, awardUrl}`,
and `server_id` the active server's — `clan_notices.server_id` is NOT NULL, and
`/airdrop place` picks its server the same way).

A grant does not require the winner to be linked; placing does. An unknown award
key, or a winner who is not in the guild, is refused.

### 4.2 The DM

New notice kind `award_granted`, declared beside `booster_kit_unchosen` in
`packages/domain/src/feed.ts`. Rendered by both `apps/bot/src/notice-text.ts` and
`apps/web/lib/notice-copy.ts` (⚠️ two renderers; read both when changing either):

> You won **Plate Carrier** — Winner, Sept king-of-the-hill. Choose your gear and
> mark where it spawns by {place_by}.

with a **Configure your award** link button to `/awards/<id>`. The existing poster
handles failure (three attempts, then `failed_at`); the bell and `/awards` show the
grant regardless.

### 4.3 Configure

`/awards` lists the viewer's grants with their derived state. `/awards/<id>` shows
one picker per slot, reusing the booster pick sheet with its slot list generalised
to come from the award definition. Every read carries `discord_id = viewer` as a
`WHERE` predicate — never a post-filter — so another player's grant is a 404,
indistinguishable from a missing one.

Picks save slot by slot (`saveAwardPickDb`), validated against the catalogue, and
are refused once the grant is `expired`, `lapsed` or `revoked`.

### 4.4 Place

**Place in game** is enabled only when every slot is picked and the viewer is
linked. `startAwardPlacementDb` issues a placement challenge with `award_grant_id`
set — three emotes, `KIT_PLACEMENT_TTL_MS`, budget of eight, exactly as the kit —
closing any open challenge on the account, booster or award. Cancel closes it and
keeps any earlier spot.

`kit-placement-tick.ts` becomes the general placement consumer (same cursor, so no
reseed). On completion it writes the position into the challenge's subject:
`booster_kits`, or `award_grants` when `award_grant_id` is set. For an award, it
re-reads the grant `FOR UPDATE` in the same transaction and, if it is no longer
`unplaced`/`waiting`/`live`, closes the challenge and writes nothing.

Moving is placing again. It never touches `live_from` or `expires_at`.

### 4.5 Revoke

`/award revoke grant:<autocomplete>` — options read like "#12 Plate Carrier —
@winner — live until Sep 29" — sets `revoked_at` and closes any open challenge for
that grant. No DM; the admin tells the winner.

`removeFromGuildDb` revokes all of the departing user's grants that are not already
ended, inside its existing transaction.

### 4.6 List

`/award list [user]` shows open grants (not `expired`/`lapsed`/`revoked`) and their
state, so an admin can see what is in the world.

---

## 5. Spawning and the clock

### 5.1 The file

The ingest worker gains `award-tick.ts` beside `booster-kit-tick.ts`, called every
sweep. It writes `./custom/awards.json` in the booster file's shape —
`{"Objects":[{name, pos, ypr, scale, enableCEPersistency: 0, customString: gamertag}]}`,
one object per item, all at the placed position +0.25 m — and uploads through the
shared `syncProjection` against `award_uploads`. With no qualifying grants the file
is `{"Objects": []}`, never absent.

The runbook adds `./custom/awards.json` to `objectSpawnersArr` once, by hand, as for
booster kits. ⚠️ `applyGameplay` stays the only code that writes
`cfggameplay.json`.

A grant is in the file iff it is placed, not revoked, and
`expires_at` is null or `now < expires_at − AWARD_REMOVAL_LEAD_MS`. A lapsed grant
is never placed, so never included. A pick no longer in `awards.json` is dropped
from the file with a warning, as booster kits do.

### 5.2 Stamping the clock — level-triggered

After each sweep's `syncProjection` — whether it uploaded or found the file in
sync — the tick stamps every grant that is in the current file and still has a null
`live_from`:

    live_from  = nextRestartAt(award_uploads.uploaded_at)
    expires_at = live_from + durationDays

Derived from the stored upload time, so a stamp that fails is simply recomputed on
the next sweep, needing no second upload. ⚠️ The stamp must never change the file's
bytes — otherwise stamping re-uploads, and the hash never settles.

⚠️ It must stamp only after the file containing the grant has been uploaded
successfully: the in-sync check is `award_uploads.content_hash` equal to the hash
of the file just rendered. Stamping from a failed upload would start a clock on an
award that is not on the server.

### 5.3 Expiry

Restarts fall on even UTC hours and `durationDays` is a whole number of days, so
`expires_at` is itself a restart slot. The award is live from its first restart
through its last session, and drops out of the file `AWARD_REMOVAL_LEAD_MS` before
the restart at `expires_at` — the restart tick fires within `RESTART_GRACE_MS`
after the slot, so the file is already gone by then.

### 5.4 Accepted edges

- **Upload inside a slot's grace window,** before that restart actually fires: the
  award spawns a session early. Up to two hours extra, never less.
- **Unscheduled restarts, or `RESTART_SCHEDULE` unset:** the clock is still
  `nextRestartAt` arithmetic, the same the site countdown uses; lifetime is a week
  give or take a session.
- **Move / pick change:** changes the file, re-uploads, applies at the next
  restart. The clock is untouched.
- **Revoke:** applies at the next restart after the re-upload, as losing a booster
  kit does.

---

## 6. Surfaces

### 6.1 Site

- An **Awards** panel on the owner's own player page, directly under the booster
  kit panel (the kit's way in lives there too), shown only when the viewer has at
  least one open grant.
- `/awards/<id>`, by derived state:

  | state | shows |
  |---|---|
  | `unplaced` | pickers, **Place in game**, "Place by {place_by}" |
  | `waiting` | "Spawns at the next restart — {nextRestartAt}", Move, pick edits |
  | `live` | "Live until {expires_at}", Move, pick edits |
  | `expired` / `lapsed` / `revoked` | read-only, with the reason |

- The emote sequence card and its 5 s status poll are the `/kit` ones.
- ⚠️ The spot's raw coordinates appear nowhere — no DM, feed row, URL, JSON body
  or page. The page shows the grid square, the nearest town and a map link, built
  on the server exactly as `/kit`'s `kitView` builds them.
- API routes `/api/awards/{pick,place,cancel,status}` mirror `/api/kit/*`.
- `@factions/roster` gains four root exports (award reads, pick, place, cancel);
  `packages/roster/test/exports.test.ts` and `apps/web/test/smoke.test.ts` pin
  them. `parity.test.ts` classifies them the same way it classifies the kit's.
- All copy in `apps/web/lib/award-copy.ts`; `copy-vocabulary.test.ts` applies.

### 6.2 Art

Eighteen `apps/web/public/items/PlateCarrier*.webp`, from the booster item-art
pipeline (`2026-09-19-booster-kit-item-images-design.md`). `loadAwards` fails on
missing art, so the award cannot ship with blank tiles.

### 6.3 Discord

`/award grant`, `/award revoke`, `/award list` — ManageGuild, ephemeral.

---

## 7. Failure handling

| failure | behaviour |
|---|---|
| invalid `awards.json` | `loadAwards` throws; site, bot and worker refuse to start |
| class name not on the server | spawns nothing, silently. `livonia/db/types.xml` is a separate repo CI cannot see, so this is a runbook step: every class name grepped in `types.xml` before deploy |
| upload fails | hash does not advance, nothing stamped, retried next sweep |
| grant ends while a challenge is open | placement tick closes the challenge, writes no position |
| booster + award challenge at once | impossible — shared partial unique index; issuing one closes the other |
| DM undeliverable | existing poster behaviour; bell and page still show the grant |

---

## 8. Testing

- **domain** — `loadAwards` accept/reject cases; `awardState` across every
  timestamp combination and each boundary (`place_by`, `live_from`, `expires_at`).
- **roster** — grant writes the row and the notice in one transaction; picks
  refused outside the catalogue and once ended; placement requires complete picks
  and a link, and closes an open booster challenge; another viewer's grant is a
  404; `removeFromGuildDb` revokes; export allowlists.
- **bot** — placement tick writes to `award_grants` when `award_grant_id` is set and
  to `booster_kits` otherwise, and refuses an ended grant; existing kit placement
  tests pass unchanged after the new column; `/award` subcommands, admin gate, and
  ephemeral replies (`command-registration.test.ts`).
- **ingest-worker** — file shape; inclusion rule including the exact
  `expires_at − lead` boundary; stamp derived from `uploaded_at`, retried after a
  failed stamp, never from a failed upload, and never changing the file hash; empty
  file with no grants.
- **web** — page states render; notice kind present in both renderers; vocabulary.
- **migration** — read the generated SQL (two tables, one column, one FK) before it
  goes near `factions_live`. Applied by `deploy-release.sh`, which stops every
  writer first.
