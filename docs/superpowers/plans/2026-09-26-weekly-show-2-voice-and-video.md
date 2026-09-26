# Weekly show, plan 2 of 3: voice and video — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pnpm run show --week 2026-09-21 --render ./out` does everything the dry run does, then voices the accepted script with ElevenLabs, lip-syncs it with Rhubarb, and renders the finished 1080p episode (`episode.mp3` and `video.mp4`) into `./out`, still writing nothing to the database.

**Architecture:** The KOTH show's generic engine is ported to TypeScript under `apps/show/src/engine/` (audio, animation, video). The engine takes plain data and returns files; it never imports `@factions/db` or `@factions/roster` (spec §3). Everything Clan Wars specific sits outside it: `src/cards/` turns the saved story context into stat cards, marquee items and the outro board; `src/stores/` implements the pronunciation store over `show_pronunciations`; `src/produce/` wires the engine into two calls, `voiceEpisode` and `renderEpisode`, that plan 3's stages will call unchanged.

**Tech Stack:** TypeScript (ESM, `moduleResolution: Bundler`), vitest 2, `@resvg/resvg-js` 2.6, ffmpeg and Rhubarb as external binaries (spawned, never npm), ElevenLabs and OpenRouter over `fetch`, drizzle-orm over postgres.js for the store.

**Spec:** `docs/superpowers/specs/2026-09-25-weekly-show-design.md` (§3, §4.2, §7.3, §11, §12, §13).

**Port source:** `/Users/steveharmeyer/Development/the-bloodbag-and-painkiller-show/bot` at commit `a5ef8e7`. Run `git -C <that dir> log --oneline -1` before starting a task; if HEAD is not `a5ef8e7`, `git -C <that dir> checkout a5ef8e7 -- src test assets` is NOT allowed (that repo is prod's source); instead read files with `git -C <that dir> show a5ef8e7:bot/src/<path>` if the working tree has moved. Its tests are Jest with hand-rolled fakes injected as parameters (`runImpl`, `fsImpl`, `ResvgImpl`, `fetchImpl`, `rhubarbRunImpl`); no `jest.mock` anywhere, so each test converts to vitest by changing imports only.

**The other plans:** plan 1 (merged, PR #100) built the story context, screening and script. Plan 3 adds `show_episodes` stages, the YouTube and Facebook clients, approval, the Discord forum post, the operator commands, systemd and the runbook. This plan ports no publishing code.

## Global Constraints

- `apps/show/src/engine/**` never imports `@factions/db`, `@factions/roster`, `@factions/domain`, or anything under `apps/show/src/story`, `src/cards`, `src/stores`, `src/produce` (spec §3). Task 12 adds a test that enforces it.
- Behaviour is ported unchanged unless this plan names the change (spec §11.1). When a task says "port", the KOTH file is the requirements: same exported behaviour, same constants, same ffmpeg arguments, typed.
- Dropped, never ported: `openrouterAudio.js` except its `trimSilencePcm` helper; the static title-card render (`videoSegments`, `renderShowVideo`); every `sponsor*` parameter; `show_deck`; `generateRoast` (plan 1's `createChat` replaces it); `buildMarqueeItems`, `screenCards`, `buildLeaderboardSvg`'s crown columns (replaced by `src/cards/`) (spec §11.2).
- `DIALOGUE_SPEED` is 1.0 and is not configurable: viseme timelines are computed against un-sped PCM, and any other value desyncs the lip sync (KOTH `showNotifier.js:31-32`).
- Tuning values carried over verbatim from the KOTH glue (`src/discord/showNotifier.js`, `src/video/renderEpisode.js` at `a5ef8e7`): intro overlap 1000 ms, outro overlap 0 ms; animation fps 12 (upsampled to 30 by the final stitch); motion seed 7; marquee strip height 90, speed 120, y 980; marquee and gamertag font Patrick Hand; ElevenLabs model default `eleven_multilingual_v2`; audio is 24 kHz mono s16le throughout.
- Script cap for speech is 6,000 characters (spec §11.1: KOTH's 2,400 becomes 6,000), matching `MAX_NARRATIVE_CHARS`.
- Redaction (spec §7.3): a context name matching `/^REDACTED_PLAYER_\d+$/` is spoken as "the player whose name we cannot say" when it is the only redacted player, and "player number N whose name we cannot say" when there are several; `/^REDACTED_CLAN_\d+$/` is spoken as "a clan we can't name on this network". Both draw as `[REDACTED]`. A redacted alias is never sent to the pronunciation model and never written to `show_pronunciations`.
- `show_pronunciations` rows are frozen once written: insert with `on conflict do nothing`, never update (spec §4.2; KOTH upserted, this is a named change).
- Every string drawn into an SVG is XML-escaped. Stat-card rows keep the single-font rule from KOTH commit `b954fe3` (spec §12).
- No em dash (U+2014) in any drawn text, marquee item or spoken line this plan adds.
- `--render` writes nothing to any database: the client stays read-only and pronunciations use a read-through store (Postgres read when `show_pronunciations` exists, memory write), the same pattern as plan 1's `ReadThroughScreeningStore`.
- Tests never spawn ffmpeg or Rhubarb and never call a real API; the only real renders in tests are resvg rasterizations (as in KOTH) (spec §11.3).
- Tests: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"` (a BASE url). Never run two test runs at once. Gate from the repo root: `TEST_DATABASE_URL=... npx turbo run typecheck test --concurrency=1 --force`, which must stay 32/32.
- Every PR adds a committed `## [Unreleased]` entry to `CHANGELOG.md`; this plan's is a `### Notes` line (nothing player-facing ships).

## Review Focus

1. A gamertag containing a ligature pair ("fi", "fl") on a stat card or the outro board must still render ink, not a blank row (KOTH `b954fe3`). Pinned by the ported resvg regression test in Task 7, extended to the outro board in Task 8.
2. A gamertag with `<`, `&` or `"` must render escaped on every card, the marquee and the outro board, never break the SVG. Pinned in Task 9.
3. A redacted alias must reach neither the pronunciation model nor the store, and must be spoken and drawn per §7.3, including the numbered form when two players are redacted. Pinned in Tasks 3, 4 and 9.
4. A week with no raids and no kills must still render: the standings card says `NO RAIDS`, empty cards draw a header only, the marquee still has its fixed items, and the outro board draws with zero rows. Pinned in Task 9.
5. A second render of the same week and narrative must reuse the cached mp3, timeline and video instead of calling ElevenLabs or ffmpeg again; a changed narrative must not. Pinned in Task 10.

---

## File Structure

```
apps/show/
  assets/                          copied from KOTH a5ef8e7 (Task 1) + the new intro screen
    rigs/  Background Scene.svg, Boris.svg, Chairs.svg, Desk no chair.svg, Desk.svg, Pavel.svg
    fonts/ Animals are like people.ttf, PatrickHand-Regular.ttf
    intro.mp3, outro.mp3, outro-screen.png, intro-screen.png
  src/
    assets.ts                      absolute paths to every asset
    engine/
      run.ts                       spawnRun(): the one child-process helper every ffmpeg/rhubarb call uses
      llm/formatBanter.ts          ported
      audio/
        parseDialogue.ts           ported
        speakableName.ts           ported
        buildDialogueScript.ts     ported, cap 6,000
        redactedSpeech.ts          NEW: spoken forms for REDACTED_* aliases
        pronounce.ts               ported, uses Chat from engine/llm/openrouter.ts
        pronunciationStore.ts      NEW: the PronunciationStore interface + MemoryPronunciationStore
        pronounceCached.ts         ported over the interface, skips aliases
        pcm.ts                     trimSilencePcm, from openrouterAudio.js
        elevenlabs.ts              ported
        jingle.ts                  ported
        episode.ts                 ported (loadOrBuildSegment)
        encodeMp3.ts               ported
      animation/
        rigManifest.ts, rig.ts, motion.ts, visemes.ts, visemeTimeline.ts, compositor.ts   ported
        screenWall.ts              ported minus screenCards; takes Card[]
        marquee.ts                 ported minus buildMarqueeItems and the KOTH constants
        episodeCache.ts            ported
      video/
        renderShowVideo.ts         renderAnimatedShowVideo + animatedVideoSegments only
        outroBoard.ts              from leaderboardImage.js: one column of clans, "points"
    cards/
      cards.ts                     StoryContext → Card[], marquee items, OutroBoard
    stores/
      pronunciations.ts            PgPronunciationStore, ReadThroughPronunciationStore
    produce/
      names.ts                     every speakable name in a context, aliases split out
      voice.ts                     voiceEpisode()
      render.ts                    renderEpisode()
    config.ts                      + render keys (Task 11)
    cli.ts                         + --render <dir> (Task 11)
  test/                            mirrors src/; engine tests are the ported KOTH tests
```

---

### Task 1: Assets, resvg, and the run helper

**Files:**
- Create: `apps/show/assets/**` (binary copies), `apps/show/src/assets.ts`, `apps/show/src/engine/run.ts`
- Modify: `apps/show/package.json`, `.gitattributes` (create at repo root if absent)
- Test: `apps/show/test/assets.test.ts`, `apps/show/test/engine/run.test.ts`

**Interfaces:**
- Produces: `ASSETS: { rigs: { background, boris, chairs, deskNoChair, desk, pavel }; fonts: { display, gamertag }; introMp3; outroMp3; introScreen; outroScreen }` (absolute paths, resolved from `import.meta.url`); `type Run = (cmd: string, args: string[], opts?: { input?: Buffer }) => Promise<Buffer>` (resolves stdout, rejects with an Error that includes the exit code and the last 2,000 characters of stderr); `spawnRun: Run`.

- [ ] **Step 1:** Copy from the KOTH repo at `a5ef8e7`: `bot/assets/rigs/*.svg` → `apps/show/assets/rigs/`; `bot/assets/Animals are like people.ttf` and `bot/assets/fonts/PatrickHand-Regular.ttf` → `apps/show/assets/fonts/`; `bot/assets/intro.mp3`, `outro.mp3`, `outro-screen.png` → `apps/show/assets/`. Copy `/Users/steveharmeyer/Development/dayz-clan-wars/intro-screen.png` → `apps/show/assets/intro-screen.png` (the new Clan Wars intro, 3840×2160, spec §11.1). Do NOT copy `sponsors/`, `*.af`, `*.webp`, banners or avatars.
- [ ] **Step 2:** Add `*.png binary`, `*.mp3 binary`, `*.ttf binary` to `.gitattributes`.
- [ ] **Step 3: failing test** `test/assets.test.ts`: every path in `ASSETS` exists; `intro-screen.png`'s IHDR width/height (bytes 16-23 of the file, big-endian) are 3840 and 2160; each rig SVG starts with `<svg` or `<?xml`.
- [ ] **Step 4:** Add `"@resvg/resvg-js": "^2.6.2"` to `apps/show` dependencies; `pnpm install`.
- [ ] **Step 5:** Write `src/assets.ts` and `src/engine/run.ts`. `spawnRun` uses `node:child_process.spawn`, collects stdout into a Buffer, writes `opts.input` to stdin when given. KOTH has several private copies of this runner (`jingle.js`, `encodeMp3.js`, `compositor.js`, `visemes.js`); every ported file uses this one instead, keeping its own `runImpl`-style parameter defaulting to `spawnRun`.
- [ ] **Step 6: test** `test/engine/run.test.ts`: `spawnRun("node", ["-e", "process.stdout.write('hi')"])` resolves `hi`; `spawnRun("node", ["-e", "console.error('bad'); process.exit(3)"])` rejects with a message containing `3` and `bad`. (Spawning `node` is allowed; ffmpeg and rhubarb are not.)
- [ ] **Step 7:** Run `cd apps/show && TEST_DATABASE_URL=... npx vitest run test/assets.test.ts test/engine/run.test.ts` and `npx tsc --noEmit`. Commit: `show: engine assets and the run helper`.

### Task 2: Dialogue text (parseDialogue, speakableName, formatBanter, buildDialogueScript)

**Files:**
- Create: `src/engine/audio/parseDialogue.ts`, `src/engine/audio/speakableName.ts`, `src/engine/llm/formatBanter.ts`, `src/engine/audio/buildDialogueScript.ts`
- Test: `test/engine/audio/parseDialogue.test.ts` (3 ported), `speakableName.test.ts` (7), `test/engine/llm/formatBanter.test.ts` (11), `test/engine/audio/buildDialogueScript.test.ts` (6)

**Interfaces:**
- Produces: `type Turn = { speaker: "Boris" | "Pavel"; text: string }`; `parseDialogue(narrative: string): Turn[]`; `speakableName(tag: string): string`; `formatBanter(text: string, gamertags: string[]): string`, `replaceNamesForSpeech(text, names, render)`, `backtickNames`, `boldHostNames`, `replaceNames` (all as KOTH); `type TtsInput = { text: string; voice_id: string }`; `buildDialogueScript(turns: Turn[], o: { gamertags: string[]; pronounce: (tag: string) => string; borisVoiceId: string; pavelVoiceId: string; maxChars?: number }): TtsInput[]` with `maxChars` default **6000**.

- [ ] **Step 1:** Port the four test files to vitest (imports only). In `buildDialogueScript.test`, any assertion that depends on the 2,400 default must be changed to pass `maxChars: 2400` explicitly, and add one test that a 5,900-character narrative is not truncated by default.
- [ ] **Step 2:** Run; confirm they fail (modules missing).
- [ ] **Step 3:** Port the four source files. Drop `borisDirection`/`pavelDirection` from `buildDialogueScript` (they only fed gpt-audio; ElevenLabs reads directions aloud, KOTH `showNotifier.js:253`), and drop any test that covers them.
- [ ] **Step 4:** Run the four files; `tsc`. Commit: `show: port dialogue parsing, speakable names and banter formatting`.

### Task 3: Redacted speech

**Files:**
- Create: `src/engine/audio/redactedSpeech.ts`
- Test: `test/engine/audio/redactedSpeech.test.ts`

**Interfaces:**
- Produces: `REDACTED_PLAYER_RE = /^REDACTED_PLAYER_(\d+)$/`, `REDACTED_CLAN_RE = /^REDACTED_CLAN_(\d+)$/`, `isRedactedAlias(s: string): boolean`; `redactedSpokenForms(aliases: string[]): Record<string, string>` mapping each alias to its spoken form per the Global Constraints (players numbered by their alias number only when two or more distinct player aliases are present; clans always "a clan we can't name on this network").

- [ ] **Step 1: failing tests:** one player alias → `{ REDACTED_PLAYER_1: "the player whose name we cannot say" }`; `REDACTED_PLAYER_1` and `REDACTED_PLAYER_2` → `"player number 1 whose name we cannot say"` / `"player number 2 whose name we cannot say"`; a clan alias → `"a clan we can't name on this network"`; `isRedactedAlias("REDACTED_PLAYER_1x")` false; `isRedactedAlias("xREDACTED_CLAN_1")` false; duplicates in the input do not count as "several".
- [ ] **Step 2:** Implement. Commit: `show: spoken forms for redacted names`.

### Task 4: Pronunciation (pronounce, the store interface, pronounceCached, the Postgres store)

**Files:**
- Create: `src/engine/audio/pronounce.ts`, `src/engine/audio/pronunciationStore.ts`, `src/engine/audio/pronounceCached.ts`, `src/stores/pronunciations.ts`
- Test: `test/engine/audio/pronounce.test.ts` (7 ported), `test/engine/audio/pronounceCached.test.ts` (5 ported + new), `test/stores/pronunciations.test.ts` (new, real test DB)

**Interfaces:**
- Consumes: `Chat` from `src/engine/llm/openrouter.ts` (plan 1: `createChat({ apiKey, fetchImpl?, timeoutMs? })` returns `(req: { model; temperature?; messages }) => Promise<string>`; read the file for the exact type name and use it), `speakableName`, `isRedactedAlias`, `redactedSpokenForms`.
- Produces:
  - `pronounceGamertags(tags: string[], o: { chat: Chat; model: string }): Promise<Record<string, string>>` (KOTH's prompt and parsing verbatim; only the transport changes from raw `fetch` to `chat`)
  - `resolvePronouncer({ overrides, llmMap }): (tag: string) => string` (verbatim)
  - `type PronunciationRow = { text: string; spoken: string; source: "override" | "llm" | "fallback" }`
  - `interface PronunciationStore { get(texts: string[]): Promise<Record<string, string>>; insertMissing(rows: PronunciationRow[]): Promise<void> }`
  - `class MemoryPronunciationStore implements PronunciationStore` (insertMissing keeps the first value for a text)
  - `resolveCachedPronouncer(o: { store: PronunciationStore; names: string[]; overrides: Record<string, string>; chat: Chat; model: string }): Promise<(name: string) => string>`
  - `class PgPronunciationStore implements PronunciationStore` over `show_pronunciations` (`insert ... on conflict (text) do nothing`); `class ReadThroughPronunciationStore implements PronunciationStore` (constructor `(read: PronunciationStore, write: PronunciationStore)`: `get` merges read then write, `insertMissing` goes to write only).

- [ ] **Step 1:** Port `pronounce.test.js` to vitest, replacing the fake `fetchImpl` with a fake `chat` that records its request and returns the same body text the fake fetch returned. Same assertions.
- [ ] **Step 2:** Port `pronounceCached.test.js` over `MemoryPronunciationStore` instead of the fake sqlite `db`. Add: (a) a name in `names` that is a redacted alias is never in the `chat` request and never inserted, and the resolver returns its `redactedSpokenForms` value; (b) a name already in the store is not sent to `chat`; (c) a stored row is never overwritten when `insertMissing` is called again with a different `spoken`; (d) an override wins over a stored row and is inserted with `source: "override"` only if missing; (e) when `chat` throws, names fall back to `speakableName` with `source: "fallback"` and the call does not throw (KOTH behaviour: check the source and keep whatever it does on LLM failure, then pin it).
- [ ] **Step 3:** `test/stores/pronunciations.test.ts` against the test DB (use the existing `apps/show` DB test setup and table reset helpers that plan 1's `test/screening/store.test.ts` uses): `insertMissing` then `get`; a second `insertMissing` for the same text with a different spoken form leaves the first; `get([])` returns `{}` without querying; `ReadThroughPronunciationStore` reads a Pg row and writes only to memory.
- [ ] **Step 4:** Implement the four files. `pronunciationStore.ts` is engine code, so it holds only the interface and the memory store; the Postgres store lives in `src/stores/`.
- [ ] **Step 5:** Run the three files; `tsc`. Commit: `show: port pronunciation with a store over show_pronunciations`.

### Task 5: Audio synthesis and assembly (pcm, elevenlabs, jingle, episode, encodeMp3)

**Files:**
- Create: `src/engine/audio/pcm.ts`, `elevenlabs.ts`, `jingle.ts`, `episode.ts`, `encodeMp3.ts`
- Test: `test/engine/audio/pcm.test.ts` (port the `trimSilencePcm` tests from KOTH `test/audio/openrouterAudio.test.js`, only those), `elevenlabs.test.ts` (3 + the 1 in `elevenTimed.test.js`), `jingle.test.ts` (25), `episode.test.ts` (3), `encodeMp3.test.ts` (2)

**Interfaces:**
- Produces (types as KOTH, made explicit): `trimSilencePcm(pcm: Buffer, o?): Buffer`; `synthesizeElevenPcmTimed({ inputs: TtsInput[]; apiKey; modelId; voiceSettings?; fetchImpl? }): Promise<{ pcm: Buffer; turns: { startSec: number; endSec: number; voiceId: string }[] }>` (plus `elevenTurnPcm`, `synthesizeElevenPcm`); `assembleShowEpisode({ introPcm, segAPcm, outroPcm }, { introOverlapMs, outroOverlapMs, sampleRate? }): { pcm: Buffer; marks: { intro?: Span; segA?: Span; outro?: Span } }` where `type Span = { startSec: number; endSec: number }` (check KOTH for the exact mark shape and use it); `decodeClipPcm`, `clipCacheKey`, `jingleCachePath`, `cachedPcm`, `overlapPcm`, `speedUpPcm` (keep, since `DIALOGUE_SPEED` 1.0 makes it a no-op pass-through in KOTH; check and keep whatever KOTH does at factor 1.0); `loadOrBuildSegment({ srcPath, fsImpl?, key, kind, build }): Promise<Buffer | null>` (the `serverName` parameter is dropped; log prefix becomes `[show]`); `encodeMp3(pcm: Buffer, o?: { runImpl?: Run }): Promise<Buffer>`.

- [ ] **Step 1:** Port the five test files (imports only; fakes unchanged, `runImpl` fakes now match the `Run` type).
- [ ] **Step 2:** Run; confirm failure.
- [ ] **Step 3:** Port the sources. `elevenlabs.ts` imports `trimSilencePcm` from `./pcm.js`. Every default runner is `spawnRun` from `../run.js`.
- [ ] **Step 4:** Run; `tsc`. Commit: `show: port ElevenLabs synthesis, jingles and mp3 encoding`.

### Task 6: Rig, motion and lip sync (rigManifest, rig, motion, visemes, visemeTimeline, compositor)

**Files:**
- Create: `src/engine/animation/rigManifest.ts`, `rig.ts`, `motion.ts`, `visemes.ts`, `visemeTimeline.ts`, `compositor.ts`
- Test: ported `rigManifest.test` (5, reads the real rig SVGs from `ASSETS.rigs`), `rig.test` (9), `motion.test` (5), `visemes.test` (3), `visemeTimeline.test` (1), `compositor.test` (8), `renderSegment.test` (3)

**Interfaces:**
- Produces: `BORIS_RIG`, `PAVEL_RIG`, `allVariantIds`; `poseCharacter(svg, manifest, pose)`; `type FramePose = { mouth: string; eyes: string; brows: string; gaze: string }` (check KOTH); `frameStates({ turns, fps, totalSec, seed? }): { boris: FramePose; pavel: FramePose }[]`; `parseRhubarbCues`, `visemesForTurn`, `defaultRhubarbRun` (rhubarb path from its `rhubarbPath` parameter, which the caller fills from config; the KOTH fallback to `process.env.RHUBARB_PATH` is removed so engine code reads no env); `type TimelineTurn = { speaker: "boris" | "pavel"; startSec: number; endSec: number; visemes: Cue[] }`; `buildSegmentTimeline(deps, { segmentPcm, turns, borisVoiceId, sampleRate?, workDir }): Promise<TimelineTurn[]>`; `rasterizePng`, `poseKey`, `buildSegmentComposeArgs`, `renderSegment(deps, args): Promise<string>`.
- Dropped: `buildComposeArgs` and `renderPoc` (the proof-of-concept path; nothing in the pipeline calls them). Drop their tests.

- [ ] **Step 1:** Port the test files. `rigManifest.test` reads SVGs through `ASSETS.rigs.*`.
- [ ] **Step 2:** Run; confirm failure.
- [ ] **Step 3:** Port the sources with the named drops.
- [ ] **Step 4:** Run; `tsc`. Commit: `show: port the rigs, motion, lip sync and compositor`.

### Task 7: Screen wall, marquee and the episode cache

**Files:**
- Create: `src/engine/animation/screenWall.ts`, `marquee.ts`, `episodeCache.ts`
- Test: ported `screenWall.test` (5, minus any `screenCards` test; keep the b954fe3 resvg ink regression test and point it at `ASSETS.fonts`), `marquee.test` (3, minus `buildMarqueeItems` tests), `episodeCache.test` (6)

**Interfaces:**
- Produces:
  - `type CardRow = { name: string; value: string }`; `type Card = { header: string; title: string; rows: CardRow[] }` (KOTH's card is `{ mapLabel, title, rows }` with rows built from `gamertag` plus a formatted value; rename `mapLabel` → `header`, and check how KOTH formats the row value so `value` is the already formatted string)
  - `buildCardSvg({ header, title, rows, width, height, displayFamily, gamertagFamily }): string`, `buildScreenClipArgs(...)`, `buildScreenClip(deps, { cards: Card[], durSec, fps, outPath, workDir, displayFontPath, gamertagFontPath }): Promise<string>`
  - `cycleText(items: string[]): string`, `buildStripSvg(...)`, `buildMarqueePng(deps, { items: string[]; height; family; fontPath; outPath }): { width: number; height: number }`
  - `episodeCacheKey({ weekStart: string; narrative: string }): string` = `${weekStart}-${sha1(narrative).slice(0,12)}` where `weekStart` is the ISO week start with `:` and `.` replaced by `-` so it is a safe directory name (KOTH used a numeric timestamp; this is a named change); `writeEpisodeCache`, `readEpisodeCache`, `writeEpisodeVideo`, `readEpisodeVideoPath` verbatim.
- [ ] **Step 1:** Port the tests; add a `buildCardSvg` test that a row name `A<b>&"c` appears escaped (`A&lt;b&gt;&amp;&quot;c`) and a `buildStripSvg` test for the same string.
- [ ] **Step 2:** Run; confirm failure. **Step 3:** Port the sources; delete `screenCards`, `buildMarqueeItems`, `COMMUNITY` and the default invite. Add escaping wherever KOTH interpolated text unescaped (check both files).
- [ ] **Step 4:** Run; `tsc`. Commit: `show: port the screen wall, marquee and episode cache`.

### Task 8: Final stitch and the outro board

**Files:**
- Create: `src/engine/video/renderShowVideo.ts`, `src/engine/video/outroBoard.ts`
- Test: ported `renderAnimatedShowVideo.test` (all of it) and the `animatedVideoSegments` tests from `renderShowVideo.test` (drop every `videoSegments`/`renderShowVideo` static-path test); `outroBoard.test.ts` (ported from `leaderboardImage.test`, reshaped)

**Interfaces:**
- Produces: `animatedVideoSegments({ totalSec, segASpan, outroSpan })`; `renderAnimatedShowVideo({ audioPath, introScreenPath, outroBoardPath, segmentClipPath, segASpan, outroSpan, totalSec, outPath, runImpl? }): Promise<string>` (KOTH's `leaderboardImagePath` → `outroBoardPath`, `chernarusClipPath` → `segmentClipPath`, `speed` removed and fixed at 1.0); `type OutroRow = { name: string; points: number; raids: number }`; `type OutroBoard = { headline: string; rows: OutroRow[] }`; `buildOutroBoardSvg({ board, backgroundDataUri, displayFamily, gamertagFamily, width, height, scrim })`; `renderOutroBoardPng({ board, backgroundPath, displayFontPath, gamertagFontPath, width?, height?, scrim? }, deps?): Buffer`.
- The outro board is one column (KOTH drew one column per map): the headline is drawn as given (e.g. `CLAN WARS · SEASON 1 · AFTER WEEK 3`), then up to 5 rows `<rank>. <name>  <points> pts · <raids> raids`, each row in a single font (the b954fe3 rule). `intro-screen.png` is 3840×2160: check whether KOTH's render scales the intro image or assumes 1920×1080, and make the ffmpeg graph scale it to 1920×1080 if it does not already.
- [ ] **Step 1:** Port and reshape the tests; add: a zero-row board renders (headline only); a row named `Fade fishy69` renders ink in its band (copy the ink-count helper from the screenWall test); a name with `<&"` is escaped.
- [ ] **Step 2:** Run; confirm failure. **Step 3:** Implement. **Step 4:** Run; `tsc`. Commit: `show: port the final stitch and a Clan Wars outro board`.

### Task 9: Cards, marquee items and the outro board from the story context

**Files:**
- Create: `src/cards/cards.ts`
- Modify: `src/story/clans.ts`, `src/story/types.ts`, `src/story/context.ts` (season totals as of week end, the week's Alpha)
- Test: `test/cards/cards.test.ts`, `test/story/clans.test.ts` (extend)

**Interfaces:**
- Consumes: `StoryContext` (plan 1, `src/story/types.ts`), `Card`, `OutroBoard` (Tasks 7, 8), `isRedactedAlias`.
- Produces: `buildCards(ctx: StoryContext): Card[]` (exactly 4), `buildMarqueeItems(ctx: StoryContext, o: { discordInvite: string }): string[]`, `buildOutroBoard(ctx: StoryContext): OutroBoard`; `ClanWeek` gains nothing; `seasonPoints`/`seasonRaids` become as-of-week-end; `StoryContext.week` gains `alpha: ClanRef | null`.

Story change first (it is what the outro board reads):
- [ ] **Step 1: failing tests** in `test/story/clans.test.ts`: a raid in a LATER week of the same season does not count toward `seasonPoints`/`seasonRaids`; a raid in an earlier week does. And a context test: `week.alpha` is the rank-1 `alpha_weeks` clan for that season and week, or `null` when no row.
- [ ] **Step 2:** In `clans.ts`, replace the `season_standings` join with `(select coalesce(sum(r.points),0)::int ... from raids r where r.raider_faction_id = f.id and r.season_id = ${seasonId} and r.week_start <= ${w})` and the matching count. `season_standings.points` and `.raids` are only ever incremented by raids (`apps/bot/src/raid-tick.ts`), so the sum matches today's standings for the current week. Read `alpha_weeks` for `week.alpha` in `context.ts` (register the clan name/tag through `texts.clan` like every other clan string).
- [ ] **Step 3:** Run story tests; commit: `show: season totals and the Alpha as of the week`.

Then the cards:
- [ ] **Step 4: failing tests** `test/cards/cards.test.ts` over hand-built `StoryContext` objects (write a small `ctx()` builder in the test with empty arrays and override what each test needs):
  - card headers are all `CLAN WARS · S01E03` for season 1, episode 3; titles in order `WEEK STANDINGS`, `MOST KILLS`, `FRIENDLY FIRE`, `LONGEST SHOT`
  - WEEK STANDINGS lists clans with `weekPoints > 0` by points descending, value `"<n> pts"`, at most 5 rows, name is the clan tag; with no raids it has one row `{ name: "NO RAIDS", value: "" }`
  - MOST KILLS: top 3 `players.topKillers`, value `"<n>"`; FRIENDLY FIRE: top 3 killers by summed `friendlyFire` counts (sum per killer across victims), value `"<n>"`; LONGEST SHOT: top 3 `players.longestShots`, value `"<n>m"` rounded to whole metres
  - any name matching a redacted alias draws `[REDACTED]`
  - marquee items, in order: `DAYZCLANWARS.COM`, the invite, `TOP KILLER: <name> (<n>)`, `LONGEST SHOT: <name> <n>m`, `ALPHA: <tag>`; each of the last three is omitted when its data is empty/null; names use `[REDACTED]` for aliases; items are upper-cased (check KOTH marquee items for case and match it)
  - outro board: headline `CLAN WARS · SEASON <s> · AFTER WEEK <e>`, top 5 `ctx.clans` by `seasonPoints` desc then tag asc, only clans with `seasonPoints > 0`; rows `{ name: tag, points, raids: seasonRaids }`
  - no string produced contains U+2014
- [ ] **Step 5:** Implement `src/cards/cards.ts`. The middle dot is U+00B7; write it as `·` in source.
- [ ] **Step 6:** Run; `tsc`. Commit: `show: stat cards, marquee items and the outro board from the story context`.

### Task 10: voiceEpisode and renderEpisode

**Files:**
- Create: `src/produce/names.ts`, `src/produce/voice.ts`, `src/produce/render.ts`
- Test: `test/produce/names.test.ts`, `test/produce/voice.test.ts`, `test/produce/render.test.ts`

**Reference:** these two functions replace KOTH's `buildShowEpisodeAudio` in `src/discord/showNotifier.js` (the ElevenLabs branch, roughly lines 190-300) and `renderEpisodeVideo` / `renderEpisodeVideoCached` in `src/video/renderEpisode.js` (the animated branch only). Read both at `a5ef8e7` and follow their order of operations; only the data sources change.

**Interfaces:**
- Produces:
  - `collectNames(ctx: StoryContext): { names: string[]; aliases: string[] }`: every gamertag, clan name and clan tag in the context (clans, raids, friendlyFire, clanBeefs, players, bounties, koth, airdrops if they carry names, week.alpha), de-duplicated; redacted aliases go to `aliases`, never `names`
  - `type VoiceDeps = { chat: Chat; pronunciationModel: string; store: PronunciationStore; overrides: Record<string,string>; elevenApiKey: string; elevenModel: string; borisVoiceId: string; pavelVoiceId: string; cacheDir: string; runImpl?: Run; fetchImpl?: typeof fetch; rhubarbRun?: ...; fsImpl?: ... }`
  - `type VoicedEpisode = { key: string; mp3Path: string; totalSec: number; segASpan: Span; outroSpan: Span; timeline: TimelineTurn[] }`
  - `voiceEpisode(deps: VoiceDeps, ep: { weekStart: string; narrative: string; context: StoryContext }): Promise<VoicedEpisode>`: key = `episodeCacheKey`; on a cache hit returns the cached episode without calling ElevenLabs, Rhubarb or the pronunciation model; otherwise: `parseDialogue` → names/aliases → `resolveCachedPronouncer` (aliases resolved to their §7.3 spoken form) → `buildDialogueScript` (gamertags = names ∪ aliases so aliases are replaced in speech too) → `synthesizeElevenPcmTimed` → `buildSegmentTimeline` → intro/outro jingles via `loadOrBuildSegment` → `assembleShowEpisode` (1000/0 ms) → `encodeMp3` → `writeEpisodeCache`
  - `type RenderDeps = { cacheDir: string; discordInvite: string; runImpl?: Run; ResvgImpl?: ...; fsImpl?: ... }`
  - `renderEpisode(deps: RenderDeps, ep: { voiced: VoicedEpisode; context: StoryContext }): Promise<string>` (path to `video.mp4` in the cache dir): cache hit via `readEpisodeVideoPath` returns immediately; otherwise outro board PNG → rig layers → `buildCards` → `buildScreenClip` → `buildMarqueeItems` → `buildMarqueePng` → `frameStates` (fps 12, seed 7) → `renderSegment` → `renderAnimatedShowVideo` → `writeEpisodeVideo`
- [ ] **Step 1: failing tests:**
  - `names.test`: aliases split out; clan tags included; duplicates removed
  - `voice.test` with every external faked (a fake ElevenLabs `fetchImpl` returning a few KB of PCM per turn, a fake `runImpl` that returns fixed bytes for ffmpeg and fixed Rhubarb JSON, an in-memory fs, a fake `chat`): the ElevenLabs request bodies contain the spoken alias text and never the string `REDACTED_`; the chat request never contains `REDACTED_`; a second call with the same week and narrative makes zero fetch, run and chat calls; a changed narrative makes new calls
  - `render.test` with fakes: calls `renderAnimatedShowVideo`'s runner once; the second call with the same key makes zero runner calls; the marquee and cards are built from the context (assert on the SVG text the fake Resvg receives: contains `CLAN WARS · S01E03` and `DAYZCLANWARS.COM`)
- [ ] **Step 2:** Implement. The in-memory fs used in tests only needs the calls the ported code makes; build it from the KOTH tests' `memFs` helpers.
- [ ] **Step 3:** Run; `tsc`. Commit: `show: voiceEpisode and renderEpisode`.

### Task 11: Config and `--render`

**Files:**
- Modify: `src/config.ts`, `src/cli.ts`, `README.md`, `CHANGELOG.md`
- Test: `test/config.test.ts` (extend)

**Interfaces:**
- Produces: `loadRenderConfig(env = process.env): RenderConfig` (separate from `loadConfig` so a dry run needs no ElevenLabs key) with: `elevenApiKey` (`ELEVENLABS_API_KEY`, required), `borisVoiceId` (`ELEVENLABS_BORIS_VOICE_ID`, required), `pavelVoiceId` (`ELEVENLABS_PAVEL_VOICE_ID`, required), `elevenModel` (`ELEVENLABS_MODEL`, default `eleven_multilingual_v2`), `pronunciationModel` (`SHOW_PRONUNCIATION_MODEL`, default the same `DEFAULT_MODEL` as the script), `rhubarbPath` (`RHUBARB_PATH`, default `rhubarb`), `ffmpegPath` (`FFMPEG_PATH`, default `ffmpeg`), `cacheDir` (`SHOW_CACHE_DIR`, default `/var/lib/clan-wars-show`), `discordInvite` (`SHOW_DISCORD_INVITE`, default `discord.gg/TJu4XP25nr`), `pronunciationOverrides` (`PRONUNCIATIONS_PATH`, optional JSON file of `{ "<name>": "<spoken>" }`; missing key → `{}`; unreadable or non-object JSON → throw at start). Use the same helper style as the existing `loadConfig`. `ffmpegPath` must reach every ffmpeg spawn: make the default `runImpl` in `produce/` a wrapper that maps the command name `ffmpeg` to `ffmpegPath`.
- CLI: `--render <dir>` implies `--dry-run` semantics for the database (read-only client, read-through stores). After an accepted script it calls `voiceEpisode` then `renderEpisode` with `cacheDir` from config, then copies `episode.mp3` and `video.mp4` into `<dir>` and prints their paths and the total duration. A held script exits 1 without rendering. Remove the "Only --dry-run exists" guard's wording accordingly: running with neither flag still exits 2 ("the scheduled pipeline arrives with plan 3").
- [ ] **Step 1: failing tests** for `loadRenderConfig`: required keys missing → throws naming the key; defaults; overrides file parsed; bad JSON throws.
- [ ] **Step 2:** Implement config and CLI. README gets a "Rendering an episode locally" section: install ffmpeg and Rhubarb 1.13 (macOS: download `Rhubarb-Lip-Sync-1.13.0-macOS.zip` from the project's GitHub releases and point `RHUBARB_PATH` at the binary), set the ElevenLabs keys, run `pnpm run show --week <date> --render ./out`.
- [ ] **Step 3:** CHANGELOG `### Notes` line under Unreleased: the show can now voice and render an episode locally for review; still nothing is published.
- [ ] **Step 4:** Run the apps/show suite and `tsc`. Commit: `show: --render voices and renders an episode locally`.

### Task 12: Engine boundary check and the gate

**Files:**
- Test: `test/engine/boundary.test.ts`
- Modify: `CLAUDE.md` only if the gate's task count or a command it documents changed (it should not; say so in the report)

- [ ] **Step 1:** `boundary.test.ts` reads every `.ts` file under `src/engine/` and fails if any import specifier starts with `@factions/` or resolves into `src/story`, `src/cards`, `src/stores`, `src/produce`, `src/screening`, `src/prompt` or `src/script`. It also fails if any engine file reads `process.env`.
- [ ] **Step 2:** Run the full gate from the repo root (`TEST_DATABASE_URL=... npx turbo run typecheck test --concurrency=1 --force`): 32/32. Commit: `show: keep the engine free of Clan Wars imports`.

### Task 13 (controller, not a subagent): a real render

Not dispatched. After the final review, the controller renders the week of 2026-09-21 end to end against production read-only (same tunnel pattern as plan 1's dry runs), with Rhubarb installed locally and the ElevenLabs key and voice ids taken from the KOTH bot's env **only after the user approves reusing them**, then shares the video with the user for review. Render time is recorded for spec §16's CPU risk.
