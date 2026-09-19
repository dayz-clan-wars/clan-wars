# Booster kit item images — design

**Date:** 2026-09-19
**Covers:** giving every catalogue item a thumbnail, serving those thumbnails
from `public/items/`, referencing them from the catalogue data, replacing the
`/kit` slot selects with a visual carousel picker, moving the way in to `/kit`
off the nav and onto the player's own page, and prompting a booster who has
not chosen a kit yet
**Builds on:** booster clothing kits (`2026-09-19-booster-kits-design.md`), the
flag image pipeline (`apps/web/scripts/fetch-flags.ts`,
`apps/web/src/flag-images.ts`)

---

## 1. Purpose

The booster kit picker shipped with labels only. `/kit` asks a booster to choose
nine pieces of clothing from 200 options by reading class-derived names out of a
`<select>`, which is the wrong interface for a decision that is entirely about
appearance. "Balaclava (Blackskull)" tells a player nothing about what they will
be wearing.

This design gives each catalogue item a thumbnail, ships those thumbnails as
ordinary static assets, and rebuilds the picker around them.

The images come from the DayZ community wikis, normalised and committed to this
repository, as a placeholder until we render our own. They are not hotlinked:
the original plan noted the wiki's images "are not ours to hotlink", and that
remains true of hotlinking specifically. Committing normalised copies under
CC BY-SA with attribution is a different act, and the one taken here.

### In scope

- A resolver that proposes a wiki filename for each of the 200 class names
- A human review pass that confirms the proposals before any of them ship
- A committed class-name-to-wiki-filename mapping table
- A hand-run fetch script writing `public/items/<className>.webp`
- An optional `image` field on each catalogue entry
- Correcting 23 catalogue labels that name the wrong item (2.12), and a
  duplicate-label guard in `loadCatalogue` (2.13)
- A carousel picker on `/kit`, one horizontally scrolling strip per slot
- Removing Kit from the site nav, and putting the way in on the owner's own
  player page instead
- A one-time prompt, in Discord and in the bell, for a booster with no kit

### Out of scope, deliberately

- Rendering our own item art. This is the placeholder that buys time for it.
- Images in the bot's Discord embeds. The catalogue field makes this possible
  later; nothing here depends on it.
- Any change to what a booster may pick, to kit generation, or to placement.
- Reminding a booster about anything other than never having chosen a kit. No
  nagging about an unplaced kit, and no repeat of this prompt.

---

## 2. Decisions

### 2.1 wiki.gg first, Fandom second

`fetch-flags.ts` uses `dayz.fandom.com`. For items that is the wrong primary
source: Fandom is the stale fork the DayZ community migrated away from, and
`dayz.wiki.gg` is the maintained wiki. Measured across all 200 catalogue items
on 2026-09-19:

| Source | Resolved by exact class name |
|---|---|
| `dayz.wiki.gg` | 110 |
| `dayz.fandom.com` | 119 |
| Union, exact + variant-safe prefix | **186** |

Fandom scores higher alone yet contributes almost nothing to the union: of the
186, wiki.gg supplies 183 and Fandom supplies 3. The two fail on different
items, so Fandom stays as a fallback rather than being dropped.

wiki.gg matters most exactly where Fandom is most dangerous. It names files
after class names (`PaydayMask_Chains.png`, `LeafCrown_Spring.png`) and carries
one file per variant (8 `CarnivalMask_*`, 5 `Bandana*Pattern`), where Fandom
resolves every Carnival Mask variant to the same red image.

Both are MediaWiki, so one resolver serves both with a different base URL.

### 2.2 Never accept a fuzzy match

An early probe resolved the unmatched items through MediaWiki's search API. It
"worked" for 70 of 81 and was wrong in ways no test would catch:

    SportGlasses_Blue  ->  Athletic Shoes Blue.png
    EyeMask_Blue       ->  Blue-coloured Berries Baked.png
    PaydayMask_Wolf    ->  Flag Wolf.png

This is the failure `flag-images.ts` already warns about, one step worse: a
wrong image is not a blank tile, it is a picker that lies about what a booster
is choosing. Search is therefore not a resolution tier at all. It may suggest
candidates for a human to judge, never populate the table.

The same reasoning rules out the page-image fallback, which returns the right
item at the wrong variant: one bandana image for all five patterns.

### 2.3 Resolution is page-first

Candidates for an item come from, in this order:

1. **The item's own wiki page** (`generator=images` on the page that declares
   the class). This is the primary source, not a fallback.
2. **A file named exactly for the class** (`<className>.png|jpg`).
3. **Wiki-wide prefix search**, only when the two above yield nothing, and only
   for candidates sharing a word with the item's name.

⚠️ The order matters and was learned the expensive way. An earlier version made
prefix search primary and tried to filter the junk afterwards. A wiki-wide
search for an item whose name contains a colour reaches everything else that
colour, and no filter written in terms of class names reliably separates them:
that pass proposed `Blue_Boat.png` for a blue ski mask, `BlackCow.jpg` and
`RedCaviar.png` for carnival masks, and a 1920x1080 screenshot for another.

The page is the authority. Images on the Ski Mask page ARE ski masks, which is
a property no scoring heuristic has to establish.

⚠️ A slot-vocabulary guard was tried and made things WORSE, and should not be
reintroduced. Rejecting a candidate whose filename names a garment from another
slot assumes each slot's vocabulary covers its own items, and it does not:
`EyeMask_*` lives in the `eyewear` slot, so a guard listing eyewear as
glasses/goggles/visor rejected `CarnivalMask_Black.png` — the correct image —
while `BlackCow.jpg`, containing no garment word at all, passed untouched. A
guard that discards right answers and admits wrong ones is worse than none.

⚠️ The garment guard belongs to the ITEM'S OWN NAME, not to its slot. Reject a
candidate whose filename names a garment the item's name does not: "Tactical
Shirt" must not take `TacticalGloves_Black.png`, "BDU Pants" must not take
`BDUJacket.png`, "Combat Backpack" must not take `Combat_Boots.png` — all three
of which the last-resort search tier proposed, and the first two scoring ABOVE 8
because the variant token matched perfectly. Deriving the guard from a slot
vocabulary instead is the version that rejected correct images; deriving it from
the item's own name is the version that works, because "Ski Mask" and "Carnival
Mask" both carry `mask` while `gloves` and `boots` are plainly foreign.

⚠️ The last-resort search tier is where every remaining wrong answer came from.
An item with no wiki page (`TortillaBag_Desert`, `BDUPants`, the bandana
patterns) has nothing but this tier, and a name like "Combat Backpack" reaches
"Combat Boots". Treat a search-sourced pick as unreviewed by default.

⚠️ Two scoring inputs are load-bearing and easy to lose:

- **Sibling-variant penalty.** A candidate naming another variant from the same
  family (`BDU` when the item is `Blackskull`) is the single most common wrong
  answer, because it is otherwise a perfect match.
- **Aspect ratio.** An image wider than about 1.9:1 is a screenshot, not an
  item render, and a resolution bonus alone actively prefers it.

⚠️ Tokenisation must handle ALL-CAPS runs. A regex of
`[A-Z][a-z]+|[a-z]+|[0-9]+` produces NO tokens for `BDU`, `TTSKO`, `USMC` or
`ALICE`, which silently disables the sibling-variant penalty for every item
carrying such a variant. It surfaced as `Ski Mask (Blackskull)` showing the BDU
mask, with nothing in the output suggesting a tokeniser fault.

### 2.4 The whole mapping is reviewed by a human, not just the leftovers

Tier 2 is a heuristic. It carries 78 of the 186 and is gated on variant tokens,
which makes it likely right rather than known right, and "likely right" is what
puts a camo bandana on the red bandana tile.

So the review artifact covers all 200: the proposals as a contact sheet to scan
and reject from, the unresolved ones as explicit pick-one rows. Reviewing a
couple of hundred correct thumbnails is a few minutes of scrolling; the
alternative is discovering a wrong one after a booster picks it.

This earned its place on the first pass. The review rejected 8 of 186
proposals, every one a tier-2 match that shared a stem and a variant token with
the right item but named the wrong GARMENT — `HunterJacket_Autumn.png` offered
for `HunterPants_Autumn`, `TacticalGloves_Black.png` for `TacticalShirt_Black`,
`Athletic_Shoes_Blue.png` for `SportGlasses_Blue`. Tier 2 now also rejects a
candidate naming a garment belonging to another slot, but the review is what
caught it, and a later variant of the same mistake is exactly what it is for.

No image reaches `public/items/` before its mapping is confirmed.

### 2.5 The table is committed, like the flags table

`apps/web/src/item-images.ts` mirrors `flag-images.ts`: an explicit
`WIKI_FILENAME` record, the confirmed output of the review, with the source wiki
recorded per entry for attribution and for re-fetching.

One deliberate difference from the flags module, to be documented in place:

    flag-images.ts  wikiFilenameFor() THROWS on an unmapped texture
    item-images.ts  wikiFilenameFor() RETURNS UNDEFINED on an unmapped class

For flags, a miss means the flag pool and the table have diverged, which is a
bug. For items, "no art yet" is a legitimate state that the picker renders as a
placeholder tile. Throwing would turn an expected gap into an outage.

### 2.6 The catalogue carries the reference

`CatalogueEntry` gains an optional `image?: string`, holding a path relative to
`public/` (`items/BalaclavaMask_Black.webp`).

This differs from the flags precedent, where the bot derives
`${base}/flags/${texture}.png` by rule and deliberately carries no alias table.
The rule works for flags because every texture has art. Items have coverage
gaps, so a derived path cannot tell "no image" from "image missing", and a
consumer would have to probe for a 404 to find out. Putting it in the data makes
coverage explicit and legible to the bot later without a second table.

`loadCatalogue` validates the field when present: a non-empty string matching
`items/<className>.webp`. It stays optional, so an unreviewed item is
representable rather than blocking.

The fetch script writes the field back into `booster-catalogue.json` for every
file it actually wrote, which keeps the data and the directory in step by
construction.

### 2.7 192px webp

Tiles render near 96px, so 192 covers a 2x display with nothing to spare and
nothing wasted. At webp quality 80 the 200 files land near 1MB, against 1.7MB
for the 33 flag PNGs today. `public/` is copied wholesale into the web image
(`apps/web/Dockerfile:32`), so the assets ship with no Dockerfile change.

### 2.8 The fetch script is hand-run

For the reasons `fetch-flags.ts` already documents: a build that reaches a
third-party wiki fails when that wiki blocks it, and its output can change with
nothing in this repository changing. Both new scripts are hand-run and their
output is committed.

### 2.9 The way in moves to the owner's player page

Kit leaves both nav lists. It is in `MINE` as a `quiet` item and in
`MINE_LONG` as "Booster kit" (`apps/web/lib/menu.ts`), and the comment on the
`quiet` flag already records the bar being full at 1024px. A nav cell that is
meaningless to everyone who is not boosting is the wrong thing to spend that
width on.

"You" is a forward rather than a page (`app/(site)/me/route.ts`), landing a
linked member on their own player page, so "reached via the You page" means the
player page's owner block, which already exists for owner-only controls
(`isOwnPage`, the `owner` value in `players/[gamertag]/page.tsx`).

The entry point renders only when the viewer owns the page AND is currently
boosting, read from `discord_boosters`. A non-booster sees nothing, because an
entry point to a page that will turn them away is worse than no entry point.

`/kit` itself keeps its own access check. This is navigation, not
authorisation, and nothing here changes who may load the page.

### 2.10 The prompt is emitted by the booster tick, once

`boosterTick` already recomputes the whole booster set every run and is the
only place that learns someone started boosting, so it is where the prompt
belongs. A booster present in `discord_boosters` with no row in `booster_kits`
has never chosen a kit.

That condition stays true until they choose, and the tick is level-triggered by
design, so emitting on the condition alone would DM them on every run forever.
`discord_boosters` gains a nullable `kit_prompted_at`, set when the prompt is
emitted and checked before emitting.

The column lives on `discord_boosters` rather than in a table of its own so
that it is deleted with the row when someone stops boosting. Boosting again
later is a new booster relationship and earns a new prompt, which is correct:
they may well have never seen the first one.

⚠️ Ordering: the prompt is emitted only after the tick's writes and deletes
have succeeded. The tick's existing ⚠️ about a Discord outage resolving to an
empty member list applies here too, one step worse, since a prompt cannot be
unsent.

### 2.11 One notice, two surfaces, one button

The prompt is a `clan_notices` row with `target = 'dm'`, which the bell and
`/notifications` already read (`packages/roster/src/notifications.ts`) and the
bot already delivers as a Discord DM (`discord.ts`). One write, both surfaces,
no new delivery path.

It needs a new kind, `booster_kit_unchosen`, added to `CLAN_NOTICE_KINDS` with
a renderer, which `apps/bot/test/notice-text.test.ts` pins.

The button is the one genuinely new piece: `discord.ts` builds messages from
`content` and `embeds` and never sends `components`. It gains an optional
link-style button (`style: 5`, a URL button, which needs no interaction
handler and so adds no state to the bot). The URL is `WEB_BASE_URL` + `/kit`.

Discord silently drops a `components` array on a DM only when the bot cannot
send one, which is not the case here; a link button is valid in a DM.

⚠️ A URL button carries no `custom_id` and must never be routed. The existing
component handler in `discord.ts` should continue to ignore it, which it does
by construction, but the renderer must not be tempted into a `style: 2` button
that would need one.

Copy follows the project's player-facing voice: plain, no em dashes.

### 2.12 Twenty-three catalogue labels name the wrong item, and are corrected here

Each was checked against the `classname` field of the wiki page that declares
it, not against a search hit. The full list is
`2026-09-19-booster-kit-label-fixes.json` beside this spec.

| Class family | Catalogue says | The item actually is |
|---|---|---|
| `BalaclavaMask_*` (10) | Balaclava | Ski Mask |
| `CombatBoots_*` (5) | Combat Boots | Hunter Boots |
| `ChristmasHeadband_*` (3) | Christmas Headband | Festive Headband |
| `TraditionalBoots_*` (2) | Traditional Boots | Fur Boots |
| `TortillaBag`, `_Winter`, `_Desert` | Assault Backpack | Combat Backpack |
| `PaydayMask_Chains` | Chains's Mask (Chains) | Chains Mask |

This is a picker defect older than this work, found only because a wrong label
sent the art search to the wrong wiki page. Two cases are worse than cosmetic:

⚠️ **`Balaclava (White)` is currently the label of TWO different mask entries**,
`Balaclava3Holes_White` and `BalaclavaMask_White`. A booster sees the same text
twice and cannot tell the options apart. `Balaclava3Holes_White` is the one
that is RIGHT — the wiki's Balaclava page declares the `Balaclava3Holes_*`
family — so the duplicate is resolved by correcting the other to "Ski Mask
(White)", never by renaming this one.

⚠️ **`CombatBoots_*` is labelled with a name that belongs to a different real
class.** The wiki's Combat Boots page declares `TTSKOBoots`. So "Combat Boots"
in the picker today is not merely an inaccurate name for `CombatBoots_*`, it is
the correct name of something else, and anyone reasoning from the label to a
class name lands on the wrong item.

⚠️ The class names are all CORRECT. All 200 exist in `livonia/db/types.xml`
(checked 2026-09-19), so nothing in the picker is unspawnable and no kit
generation changes. Only display text moves.

⚠️ `TortillaBag_Desert` is the one item with no art on either wiki. It is real
and spawnable, but no page on either wiki names that class, so it takes the
placeholder tile of 2.6 rather than a picture of a different variant.

### 2.13 `loadCatalogue` gains a duplicate-label check

The validator already refuses a slot that lists one class name twice, and its
own comment gives the reason: two identical options "a player cannot tell
apart". A duplicate LABEL produces exactly that outcome while every class name
stays unique, which is how `Balaclava (White)` survived to production.

`loadCatalogue` therefore refuses a slot carrying the same label twice, on the
same footing as a duplicate class name. Both guards protect one property; only
one of them was written down.


---

## 3. Components

### 3.1 `apps/web/scripts/resolve-item-images.ts`

Hand-run. Reads the catalogue, applies the two tiers of 2.3 across both wikis,
writes a proposal file to the scratchpad. Reports counts per tier and per
source. Never writes the mapping table or any image.

### 3.2 The review artifact

A published Artifact with the `db` capability, generated from the proposal file:

- **Contact sheet:** all 186 proposals, each tile showing the thumbnail, the
  class name, the label, and its source wiki. Clicking a tile flags it as wrong
  and moves it to the pick-one list.
- **Pick-one rows:** the 14 unresolved plus anything rejected above, each
  offering the candidate images that the prefix listing turned up for that
  item's stems, plus "none of these".

Picks are stored in the artifact's database and read back with `ArtifactData`.
Deciding by eye is the entire point, so the artifact shows images rather than
filenames.

### 3.3 `apps/web/src/item-images.ts`

The committed result. `WIKI_FILENAME`, `wikiFilenameFor()` (undefined on a
miss, per 2.5), and `itemImagePath(className)` returning
`items/<className>.webp`. Named after OUR class name, never the wiki's, so the
wiki's naming stops here exactly as it does for flags.

### 3.4 `apps/web/scripts/fetch-item-images.ts`

Hand-run, modelled on `fetch-flags.ts` and inheriting its lessons: the
MediaWiki API rather than HTML, an explicit `User-Agent` because the CDN rejects
requests without one, and the retry wrapper for `static.wikia.nocookie.net`
dropping connections after roughly two dozen sequential downloads. That last one
is a footnote at 33 files and a certainty at 200.

Downloads, resizes to 192px long edge, writes webp to `public/items/`, then
writes each `image` field back into `booster-catalogue.json`. Fails loudly on a
mapped class whose file has vanished from the wiki.

### 3.5 `ItemCarousel`

A client component, one per slot, replacing the `<select>` in `SlotPicker`.

- A horizontally scrolling strip of tiles, CSS `scroll-snap`, native overflow
  scroll, no carousel library.
- Each tile is a radio input in a `radiogroup`, so arrow keys work and the form
  posts `className` exactly as today.
- "Nothing in this slot" is the first tile, preserving the current empty option.
- The selected tile is outlined, and the strip scrolls it into view on mount so
  a saved pick is visible without hunting.
- An item with no `image` renders a neutral tile carrying its label, so a
  coverage gap reads as deliberate rather than broken.
- Save stays per slot.

Jacket has 58 entries, which is a long strip. Accepted for now, with a row-wrap
variant as the fallback if it reads badly once it exists.

### 3.6 Attribution

One line on `/kit` crediting the DayZ wikis under CC BY-SA, linking both.
Per the project's copy rules this is plain and free of em dashes.

### 3.7 Navigation change

`menu.ts` loses the Kit entry from `MINE` and `MINE_LONG`. `test/menu.test.ts`
pins the nav, so it moves with them.

The player page's owner block gains the entry point, gated per 2.9. It states
what it is for, since a booster arriving from a Discord DM may never have seen
`/kit` before.

### 3.8 The prompt

- `discord_boosters` gains `kit_prompted_at timestamptz null`, one migration.
- `boosterTick` gains a dependency for emitting the notice, in the same shape
  as its existing `BoosterSource`, so a test hands it a fake and asserts on
  what it was asked to send.
- A renderer for `booster_kit_unchosen` in the bot's notice text, plus the
  link button of 2.11.

---

## 4. Testing

- `loadCatalogue` accepts an entry with a well-formed `image`, accepts one
  without, and rejects a non-string, an empty string, and a path that does not
  match `items/<className>.webp`.
- `loadCatalogue` rejects a slot listing one label twice, beside the existing
  duplicate-class-name case (2.13).
- A test pins that no two entries in a slot share a label, so the 2.12
  corrections cannot regress silently.
- A repository test asserts every `image` in the catalogue resolves to a real
  file in `public/items/`, and that no file there is unreferenced. This closes
  the class of gap inbox note 41 describes, where a missing asset was invisible
  until production.
- `kit.test.ts` covers the carousel: selecting a tile submits its class name,
  the empty tile submits an empty value, and a slot renders its saved pick as
  selected.
- A component test asserts an item without `image` still renders a selectable
  tile.
- `boosterTick` emits the prompt for a booster with no kit, does not emit for a
  booster who has one, and does not emit twice for the same booster across two
  runs. A booster who stops and starts again is prompted again.
- The prompt is not emitted when the booster fetch throws, pinning the ordering
  of 2.10.
- `menu.test.ts` pins Kit's absence from both nav lists.
- The owner block renders the kit entry point for a boosting owner, and not for
  a non-boosting owner, a non-owner, or a signed-out visitor.
- `notice-text.test.ts` covers the new kind, as it does every other, and pins
  that its button is a URL button carrying no `custom_id`.
- No test touches the network. Both scripts are hand-run, and their output is
  committed.

---

## 5. Risks

**The prefix tier is a heuristic.** Mitigated by 2.4, which is the reason the
review covers all 200 rather than only the unresolved ones. Its known failure
mode is matching the wrong garment; the slot guard closes the cases seen so far,
not the category.

**A resolver miss reads as "no art exists".** Both failures on the first pass
had this shape, and neither surfaced as an error: tier 2 offering a confident
wrong garment, and tiers 1 and 2 together reporting eleven items as having no
art when tier 3 found all of them. Treat a "no art" result as a statement about
the resolver until a human has looked at the item's wiki page.

**58 jackets in one strip.** May need the row-wrap variant. Cheap to change,
since the tile is the same component either way.

**Wiki drift.** A renamed file breaks a re-fetch, not the site, because the
images are committed. The script fails loudly rather than writing a zero-byte
file, which is the failure `fetch-flags.ts` hit and guarded.

**Licence.** CC BY-SA is satisfied by the attribution line. The real exit is
our own art, which this is explicitly a placeholder for.

**A prompt cannot be unsent.** The dedupe column and the ordering rule in 2.10
are the whole of the protection. This is the part of the change worth reviewing
most carefully, because its failure mode is DMing every booster on the server
repeatedly.
