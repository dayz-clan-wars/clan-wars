# Bunker radio decoder — design

2026-10-23. Status: design, approved for planning once Steve signs off.

## Why

At night Nasdara broadcasts a slow Morse signal over the in-game radio: three
groups of ten digits, about 6.8 s apart, repeating all night. Each group is
one bunker. The first six digits are its map grid reference and the last four
are its key code. Copying that down by ear takes a long time and goes wrong
easily. Steve wants a page on the Clan Wars site that listens to the
broadcast live and writes the codes down for the player.

## What it is

A public page at **`/radio`** (Claude's call on the name and path). No sign-in.

A player stands next to the in-game radio, presses **Listen**, and holds a
phone or laptop up to the TV or headset. The servers are Xbox-only, so the
microphone is the only way the sound reaches the page. As beeps come in, the
page fills in the three bunkers. For each one it shows:

- the grid reference (`091 044`) and the key code (`2410`) as text
- a **Map** link to `/map?at=<six digits>`
- which digits are still unknown or unsure, so the player knows whether to
  keep listening

The map is behind sign-in and a linked character. That stays as it is
(Steve's decision): a signed-out visitor who taps Map goes through the sign-in
flow the map already has. The decoder page draws no map of its own.

## Goals

- Decode the broadcast live from the microphone, in the player's browser.
- Get the codes right, even with gunfire, voice chat and room noise. Use the
  repeats: every pass that's heard is put to a vote per digit.
- Make it obvious when a digit isn't settled yet.
- Be reachable from the menu.

## Non-goals

- Twitch links, uploaded files, or any processing on the server.
- A map on this page (see above).
- Saving, sharing or sending codes anywhere: no database, no Discord post.
- Moving the desktop menu into a drawer. That's its own project and comes
  after this one (see "Menu").

## Anti-goals

- **Audio leaving the device.** No upload, no API call carrying audio or
  decoded digits.
- **A wrong code shown as certain.** A misread key wastes a raid trip. An
  unsettled digit has to look unsettled.

## The signal

Measured from a recording of the One Life Nasdara stream
(twitch.tv/videos/2908002004, 8 min), decoded by hand and with the prototype
script, and cross-checked against the map:

- a single steady tone, **988 Hz** in that recording
- dot ≈ 90 ms of tone, dash ≈ 485 ms
- silence after an element, inside a digit: ≈ 800 ms after a dot and
  ≈ 1415 ms after a dash. A digit boundary *usually* adds ≈ 400 ms, but not
  always, so it can't be relied on.
- **start-to-start time** (the steadiest measure): ≈ 890 ms after a dot,
  ≈ 1900 ms after a dash, +400 ms at most digit boundaries
- ≈ 6.8 s of silence between groups; one full group lasts about 80 s, so one
  cycle of all three takes about 4.5 min
- every Morse digit is exactly five elements, so a group is exactly 50
  elements and splits into digits by counting, without needing boundary gaps

The recording decoded to `0910442410`, `1001219970` and `0281002049`. The
grid references are the site's own six-digit grid (100 m squares counted
from the top-left of the 16 384 m map, the same key `/map?at=` takes,
`lib/map-projection.ts` `gridRefKey`). All three fall in the square holding a
bunker from `public/map-data/nasdara/world.json`:

| Group | Grid | Bunker in world.json |
|---|---|---|
| 0910442410 | 091 044 | (9168, 11946) |
| 1001219970 | 100 121 | (10087, 4239) |
| 0281002049 | 028 100 | (2863, 6381) |

## How it works

The decoding is split into two parts so most of it can be tested without
audio.

**1. Tone detector** (browser only). `getUserMedia` with `echoCancellation`,
`noiseSuppression` and `autoGainControl` all **off**: phone voice processing
treats a steady tone as noise and removes it. Measure the tone level every
5 ms (Goertzel or a narrow band filter, an AudioWorklet or similar), compare
it with neighbouring bands about ±140 Hz away so broadband noise like
gunshots doesn't count as tone, and output tone-on runs as (start ms,
length ms). Find the tone frequency automatically: the strongest steady peak
between 300 and 3000 Hz, which should settle near 988 Hz. The threshold
adapts to the level, because a phone held at a TV is much quieter than a
headset.

**2. Decoder** (a pure TypeScript module with no browser APIs), ported from
the prototype script:

- Join runs that are less than 300 ms apart. A noise burst can chop a dash
  into pieces.
- Classify by length (under 200 ms is a dot, over 300 ms is a dash, anything
  between is unknown), then read each element and any drowned-out ones from
  the **start-to-start** time to the next element. Try 1 to 3 elements with
  up to that many +400 ms boundaries and take the best fit within 300 ms; if
  nothing fits, record an unknown element.
- A silence longer than 4 s ends a group. Split each group into digits five
  elements at a time. A chunk with one unknown element becomes a digit only
  if exactly one digit fits.
- A group heard from its start has to have been preceded by a silence of at
  least 4 s. A group already under way when listening began is a *tail*, so
  its digits line up from the right. A group cut off when listening stops
  lines up from the left.
- Sort the reads into three bunkers by agreement: at least 4 known digits
  match and at most 1 disagrees. Vote each digit across the reads.

The prototype reads the recording correctly, including putting back a dot
that was drowned out at 59 s and stitching the group that was cut in half.
It's at
`/private/tmp/claude-501/-Users-steveharmeyer-Development-dayz-clan-wars/ea1edae4-a7f6-47ae-b867-000ea1cb2a9a/scratchpad/bunker-morse/bunker_morse.py`,
for reference only; it doesn't ship. The timings above go in the TypeScript
as named constants.

**Bunker check (Claude's call).** Grid references that hold a bunker get
marked as confirmed. One that doesn't is a likely misread and stays unsettled
however the vote went. ⚠️ `world.json` is **not** public: `lib/auth/gate.ts`
gates everything under `public/`, `/map-data/` included, so a signed-out
visitor fetching it gets sent to `/login`. Don't open `/map-data/` up, because
that would publish the whole world file (loot, props, events). Instead, ship
the 23 bunker grid keys with the page as a small constant, plus a drift test
that recomputes them from `world.json` with `gridRefKey` and fails if they
disagree. Bunkers are fixed map features, not player bases, so their grid
squares aren't sensitive.

**Codes are stable all night (Steve).** The bunkers and key codes don't change
at the even-hour restarts, so every read in a session can be voted together
and there are always three bunker cards. No aging out or replacing of reads
is needed. Claude's assumption: the Clan Wars server plays the same
broadcast as One Life Nasdara.

**Speed (Claude's call).** The timings above are starting values. The
decoder should adjust them to the dash start-to-start time it actually
hears (a running median), so a slightly faster or slower broadcast still
decodes. A test plays the recording's runs scaled to ±15% speed.

**Public access.** `/radio` goes in `PUBLIC_PATHS` in `lib/auth/gate.ts`
(and `auth-gate.test.ts`). The Map link keeps `?at=` through sign-in,
because the middleware puts the whole path and query into `next`.

## What the page shows (Claude's calls; final look is the builder's)

- **Before listening:** one line on what to do (stand by the radio, press
  Listen, hold the device near the speaker), and a note that the audio stays
  on the device.
- **While listening:** a level meter and a tone indicator so the player can
  tell the beeps are getting through; the digits of the group in progress
  appearing as they arrive; the three bunker cards filling in.
- **Each bunker card:** grid and key in the site's mono type, unsettled
  digits shown dimmed or as `?`, a "heard N times" count, and the Map link.
  It's settled once every digit has at least two agreeing reads with none
  against, and the grid holds a bunker.
- **Stop** and **Clear**. Keep the screen awake while listening (Wake Lock
  API, where the browser has it).
- **Microphone refused or missing:** say so plainly, with what to do next.
- Copy follows the player-facing voice (plain, US English, brand punctuation
  per `brand/02-verbal-identity.md`).

Nothing is stored. Leaving the page drops everything.

## Menu (Steve's decision, with Claude's placement)

- Phone drawer: add **Radio** for everyone, signed in or not
  (`lib/menu.ts`, both `menuFor` shapes; update `test/menu.test.ts`).
- Desktop bar: no new cell, because the bar overflows at 1024 px. Reach it
  from Live: add a Radio item to Live's tab nav, and put `/radio` in Live's
  `also` so the bar lights Live up. When the desktop menu moves into a drawer
  (the next project), Radio becomes an ordinary item there.

## Guide

Add a short section to the map chapter
(`apps/web/content/guide/10-the-map.html`) on what the broadcast is and how
to use the page. Builder's call on where in the chapter.

## Testing

- **The decoder, from recorded timings.** Commit the recording's tone runs
  as a fixture (a JSON list of start/length pairs, about 180 entries, no
  audio). It must decode to the three groups above. Add edge cases: a
  drowned dot, a chopped dash, a tail group, a cut-off group, a run of noise.
- **The detector, on synthetic audio.** Generate a 988 Hz Morse sequence
  with noise and gunshot-like bursts, then check the runs it returns.
- **Manual.** Play the recording through a speaker to a phone on the
  deployed site.

## Left to the builder

- Goertzel versus a filter bank, and AudioWorklet versus AnalyserNode
- component structure and the exact visuals, within the site's existing
  design system
- where the guide section goes in the chapter
