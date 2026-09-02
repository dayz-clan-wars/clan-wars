# Faction supply spawns — design

**Date:** 2026-09-01
**Covers:** spawning a base-building supply kit at a faction's flagpole when
they claim it, and removing it when they stop holding it
**Builds on:** Plan 4a (roster core — `factions` rows with a pole and a
texture), live ingest (a running worker with Nitrado credentials)

---

## 1. Purpose

A faction that claims a pole gets nothing. This design gives them a starting
kit — logs, nails, plates, wire, tools, barrels, a fence kit and a watchtower
kit — spawned at their own pole, flying their own flag.

The mechanism is vanilla DayZ's object spawner: `cfggameplay.json`'s
`WorldsData.objectSpawnersArr` names JSON files, each listing objects to place
at mission start. No mod is involved. We maintain one such file, upload it
through the Nitrado API, and the supplies appear at the next server restart.

### In scope

- A committed template describing the kit once, captured at one real pole
- Re-expressing that template at each holding faction's pole
- Substituting the faction's chosen flag for the template's `Flag_White`
- Uploading the generated file to Nitrado, and re-uploading when it changes
- Dropping a faction's kit when they disband or their reservation lapses

### Out of scope, deliberately

- **Editing `cfggameplay.json`.** Adding `./custom/faction-supplies.json` to
  `objectSpawnersArr` is a one-time manual edit. That file is hand-maintained
  and boots the server; a bad automated write breaks the map for everyone, and
  the payoff is one line typed once.
- **Restarting the server to make supplies appear sooner.** Nitrado's API can
  restart, but doing so on a claim kicks every player online for one faction's
  benefit. The claim reply sets the expectation instead.
- **Rotating the kit to the pole's facing.** See §2.3.
- **Terrain-fitting the kit.** See §6.

---

## 2. Decisions

### 2.1 The file is a projection, not a side effect

The obvious design uploads the file from the claim handler. It is wrong for a
reason this project has already been bitten by twice: a Nitrado outage during
the claim would commit the faction and lose the supplies, permanently, with
nothing to retry it and no signal that anything was missed.

So the file is a **projection of the `factions` table**. A tick regenerates it
in full from the current holding factions, hashes the result, and uploads only
when the hash differs from the last successful upload. A failed upload leaves
the stored hash untouched, so the next tick tries again. Removal on disband
and on a lapsed reservation then needs no code of its own — those rows stop
being holding, and the next regeneration simply lacks them.

**The self-healing is narrower than "the file always matches the table."** The
stored hash is the tick's only memory, and it describes what we last *sent*,
not what is on the server now. It heals **upload failures**. It does not detect
**server-side drift**: if the file is deleted, reverted or edited on the server
— a mission wipe, an FTP restore, an operator with a text editor — the stored
hash still equals the hash of what the tick would generate, so no upload is
ever attempted again and the divergence is permanent until a faction changes.
See §8.

This is the same shape as the `players` projection: derive from the table, do
not accumulate edits.

### 2.2 Supplies land on claim, not on activation

A faction is `reserved` when it claims and `active` only once its flag flies.
Supplies arrive at `reserved` — the kit is what lets them raise the flag in the
first place, so gating it behind activation would invert the dependency.

A reservation that lapses after 24 hours removes the faction row, which removes
its kit at the following restart.

### 2.3 The kit keeps the template's orientation

Objects are offset in position only; their `ypr` is copied unchanged. Rotating
the kit to match each pole would look more deliberate, but we do not record a
pole's yaw anywhere — the ADM flag line does not carry it — so there is nothing
to rotate by without first extending ingest. Not worth it for cosmetics.

### 2.4 The kit respawns at every restart

Every template object carries `enableCEPersistency: 0`, and we keep it. The
spawner rebuilds the objects from JSON at each mission start, so nothing
accumulates and a faction gets a fresh kit each restart.

The consequence, accepted deliberately: **anything taken from the kit and left
on the ground disappears at the next restart**, because it was never persisted.
A barrel dragged to a different base will not survive. The kit is a recurring
resupply at the pole, not a permanent grant of items.

---

## 3. The template

`livonia/custom/flag-supplies.json` is committed to this repo unchanged, as
captured in game. It contains **73 objects** around a single `TerritoryFlag` at
`5572.65 / 310.81 / 8811.84`, so **103 are emitted per faction** — the 72
non-anchor objects, with the flag item emitted twice and the wooden logs raised
from 20 to 50. Verified
against the file: exactly one `TerritoryFlag` and exactly one `Flag_White`.

The kit is 50 `WoodenLog` (the template captured 20), 10 `NailBox`, 10 `MetalPlate`, 5 each of
`Whetstone`, `CombinationLock4`, `MetalWire` and `BarbedWire`, one of each
barrel colour, plus `Pickaxe`, `Hatchet`, `HandSaw`, `Pliers`,
`PileOfWoodenPlanks`, `FenceKit` and `WatchtowerKit`.

**The `TerritoryFlag` is the anchor and is never emitted.** Every other
object's position is stored as its offset from that anchor. The faction already
built the pole they claimed; spawning another would stack a second pole on top
of it.

Parsing fails loudly if the anchor is absent or duplicated. A template with no
anchor would otherwise yield absolute coordinates, piling every faction's kit
at one arbitrary spot on the map — a silent, map-wide defect.

### Kit quantities

`KIT_QUANTITIES` in `supplies.ts` overrides the count the template was captured
with, per template name: the flag item is emitted **twice** and `WoodenLog`
**fifty** times. Extra copies stack on the template's own entries rather than
moving anything — which is how the template expresses quantity in the first
place, its five `Whetstone` and twenty `WoodenLog` entries each sharing one
position and differing only in yaw drift from being piled up in game.

Where a name has several template entries, the total is spread round-robin
across them (50 over 20 is ten 3s then ten 2s), so the captured yaw variety
survives instead of one entry being stamped thirty times. The remainder goes to
the earliest entries, so the split is deterministic — the bytes are hashed, and
a total that varied between runs would re-upload every sweep forever.

A `KIT_QUANTITIES` key naming an object the template does not contain throws at
load. Its only other symptom would be the template's own count shipping
unchanged: a kit silently short, with nothing reporting it.

`Flag_White` in the template is the flag item, not the pole. It is emitted with
the faction's chosen texture substituted — a spare, so a raided faction can
re-raise without waiting for the next sweep.

---

## 4. Data model

### 4.1 Generation is pure

```
generateSupplies(template, factions[]) -> Objects[]
```

No database, no HTTP, no clock. Every interesting decision — the offset maths,
the anchor rule, the flag substitution, the ownership stamp — is testable
without a network or a server.

### 4.2 Ownership is stamped in `customString`

Every template object carries an empty `customString`. Each emitted object gets
the owning faction's tag there. It costs nothing, and it makes the file
self-describing: an operator looking at a stray barrel in game can tell whose
kit it belongs to, and a diff of two generated files reads in faction order
rather than as an undifferentiated wall of coordinates.

### 4.3 Which factions appear

Those whose status is in the roster store's existing `HOLDING` set —
`reserved`, `active`, `dormant` — imported from there rather than re-listed, so
the two cannot drift.

### 4.4 New state: the uploaded hash

One row per server: the hash of the last successfully uploaded file, and when.
That is the entire memory this feature needs. Without it the tick would
re-upload an identical file on every pass forever.

The hash covers exactly the bytes uploaded, so any change to the template, to
a faction's pole, texture or tag, or to the set of holding factions, produces a
different hash and therefore an upload.

---

## 5. Upload

Nitrado's upload is two steps, and the second is easy to get wrong:

1. `POST /services/{id}/gameservers/file_server/upload` with a JSON body
   `{ path: <remote dir>, file: <file name> }`, which returns
   `data.token.url` and `data.token.token`.
2. `POST` the bytes to that URL with `Content-Type: application/binary` and the
   token in a bare **`token` header** — not a bearer, not a query parameter.

**Nitrado can return HTTP 200 with a failure payload.** Our existing client
checks only `res.ok`, so it would treat that as success. The upload path must
also require `status === "success"` in the body, and the existing client should
be corrected to match — a silent false success here would record a hash for a
file that was never written, and the projection would then never retry.

---

## 6. Failure handling

**The claim always wins.** Supply generation and upload never run inside a
claim's transaction and can never fail one. A faction claims, the kit follows
when it follows.

**A failed upload is retried by the next tick**, because the hash only advances
on success. No dead-letter, no manual repair.

**That retry covers upload failures only.** The stored hash records what we
last sent, not what the server currently holds, so a file changed or removed
*on the server* is invisible to the tick and never re-uploaded. Carried forward
in §8 rather than solved here — detection needs a cadence decision.

**A failing upload must not stop the ingest sweep.** It gets its own try/catch,
like the ceremony steps in the bot's loop, and logs so a persistent failure is
visible rather than silent.

**Vertical placement is not solved.** Offsets apply in all three axes, so the
kit's height is relative to the pole's Y. On a steep slope, objects flush with
the ground in the template may float or sink at another pole. Recorded here
rather than fixed: it is cosmetic, it needs real terrain data to judge, and the
first claimed poles will show us how bad it actually is.

---

## 7. Testing and acceptance

**Pure unit tests** for the generator: the anchor is excluded, offsets are
correct against known coordinates, a missing or duplicated anchor throws,
`Flag_White` becomes the faction's texture, `customString` carries the tag,
non-holding factions are absent, and an empty faction list produces a valid
empty file rather than malformed JSON.

**A hash test** proving an unchanged faction set produces no second upload, and
that changing one faction's texture does produce one.

**Upload tests against a fake fetch**, including the case that matters: HTTP 200
with `status: "error"` must be treated as a failure and must not advance the
hash.

**Acceptance is live and stageable.** A faction already exists — "The Cocks"
[COK], `Flag_Rooster`, pole `5551.69:311.63:8790.97`. The gate is: the
generated file contains their kit at their pole with their flag, it uploads,
`objectSpawnersArr` names it, and after a restart the supplies are physically
at the pole with a rooster flag. Recorded with the real values observed.

---

## 8. Carried forward

- **Terrain fitting** (§6) — kit height is relative to the pole's Y.
- **Kit rotation** (§2.3) — needs a pole yaw that ingest does not record.
- **`cfggameplay.json` is edited by hand** — if a future feature needs to add
  spawner files dynamically, that decision gets revisited with its own design.
- **Items taken from the kit vanish at restart** (§2.4) — inherent to
  non-persistent spawns, and the reason the kit reads as a resupply.
- **Out-of-band changes to the file on the server are never detected**
  (§2.1, §6). `supply_uploads.content_hash` is the only memory, and it records
  what we last *sent*. If the file is deleted, reverted or hand-edited on the
  server — a mission wipe, an FTP restore, an operator edit — the stored hash
  still matches what the tick would generate, so no upload is ever attempted
  again. The supplies stay gone until something unrelated changes the roster.
  Not solved here because detection needs a design decision about cadence: a
  `file_server/list` size/mtime check every tick is cheap but weak, a full
  download-and-compare is exact but costs a request per server per tick, and a
  periodic unconditional re-upload is simplest but writes for no reason. Pick
  one deliberately rather than bolting one on.
