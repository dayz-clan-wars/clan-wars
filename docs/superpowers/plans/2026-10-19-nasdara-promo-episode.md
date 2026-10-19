# Special Episode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `apps/show` render a one-off special episode from a hand-written script and
publish it through the weekly show's channels, using the same ✅ approval gate.

**Architecture:** A special is a directory: `script.txt`, `meta.json`, `intro.png` and
`outro.png`. Two new CLI modes are added:

- `--special <dir> --render <out>` runs locally. It reuses `voiceEpisode` and
  `renderEpisode` with overrides in place of the weekly StoryContext.
- `--special <dir> --publish <out>` runs on prod. It is a small resumable state machine
  that keeps its state in `<out>/publish-state.json`. It reuses the weekly YouTube,
  Discord and Facebook ops, and the approval decision extracted from `stages/run.ts`.

No `show_episodes` row is ever written.

**Tech Stack:** TypeScript, vitest, tsx, existing `apps/show` engine (ElevenLabs, Rhubarb, ffmpeg, resvg).

**Spec:** `docs/superpowers/specs/2026-10-19-nasdara-promo-episode-design.md`

## Global Constraints

- **No change to weekly behavior.** Every existing `apps/show` test passes unmodified,
  except the mechanical signature updates Task 2 names.
- **The special never reads or writes `show_episodes`,** and never touches the weekly
  draft marker namespace. Weekly markers are `show:YYYY-MM-DD:<hash>`; the special's are
  `show:special:<slug>:<hash>`.
- **Published copy goes through `publicCopy`** (`stages/text.ts`), which removes em and
  en dashes.
- **Fail closed on the script screen:** if `screenScript` returns any reason, there is no
  render.
- **Nothing goes public without an approver's ✅** on the special's ops draft. A ❌ wins,
  and the bot's own reaction never counts.
- **Constants:**
  - code `Special`
  - YouTube title `The Bloodbag and Painkiller Show: Clan Wars Special · New to Clan Wars? Start here`, via `videoTitle`
  - forum thread `Clan Wars Special · New to Clan Wars? Start here`, via `forumThreadName`
- **The command is `pnpm run show ...`, never `pnpm show`.**
- **Tests:** use the throwaway Postgres on 5440 for any DB-backed suite (5434 is taken
  locally). The final gate is the repo's turbo gate with `--force`.

## Review Focus

1. **The script is edited after the render, or the publish is pointed at another cut.**
   The state file's `cut` must not match, so the publish refuses (exit 2) instead of
   approving one cut and publishing another. Test in Task 5.
2. **A crash between a post and the state write:**
   - A re-run adopts the existing YouTube upload, found by exact title and description.
   - It adopts the forum thread only if the thread's starter is this video's link.
   - It resumes the transcript at the right message.
   - Nothing double-posts.

   Test in Task 5.
3. **A ✅ from a non-approver, or the bot's own ✅,** does not publish. Covered by the
   weekly tests through the shared `decideDraft` (Task 4), plus one special test (Task 5).
4. **Facebook fails.** The publish still finishes `done` and records `facebookError`.
   Test in Task 5.
5. **A malformed special dir** (a non-dialogue line, a dash, a missing PNG, bad meta) fails
   at load, before any paid call. Test in Task 1.

---

### Task 1: Special directory and loader

**Files:**
- Create: `apps/show/specials/2026-10-nasdara/meta.json`
- Create: `apps/show/specials/2026-10-nasdara/intro.png` and `outro.png`, copied from
  `/Users/steveharmeyer/Development/dayz-clan-wars/special-intro.png` and `special-outro.png`.
  `script.txt` already exists.
- Create: `apps/show/src/special/load.ts`
- Test: `apps/show/test/special/load.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SpecialMeta = {
    slug: string;                 // "2026-10-nasdara"
    code: "Special";
    subtitle: string;             // "New to Clan Wars? Start here"
    descriptionLead: string;      // YouTube description head, before the transcript
    facebookLines: string[];      // caption lines before the YouTube link and invite
    cards: Card[];                // screen-wall cards (Card from engine/animation/screenWall.ts)
    marquee: string[];            // marquee items
    pronounce: string[];          // words sent through the pronouncer (may be [])
  };
  export type Special = SpecialMeta & { dir: string; narrative: string; introPath: string; outroPath: string };
  export function loadSpecial(dir: string, fsImpl?: { readFileSync; existsSync }): Special;
  export const SPECIAL_SCRIPT_MAX = 3300;
  ```

`meta.json` content:
- **Copy and lists:**
  - `subtitle`: `New to Clan Wars? Start here`
  - `descriptionLead`: three lines, joined with `\n`:
    - `Clan Wars moved to Nasdara. Boris and Pavel explain the server.`
    - `Join the Discord: https://discord.gg/TJu4XP25nr`
    - `Link your gamertag: https://dayzclanwars.com`
  - `facebookLines`: `["Clan Wars moved to Nasdara. Boris and Pavel explain the server in two minutes."]`
  - `marquee`: `[".::CLAN WARS::. on Xbox", "dayzclanwars.com", "discord.gg/TJu4XP25nr", "Raid weekend Fri to Mon UTC", "Fast travel from any shed"]`
  - `pronounce`: `["Nasdara", "Bustanshahr", "pakol", "kameez"]`
- **`cards`**, five of them:
  - `{header:"CLAN WARS", title:"FOUND A CLAN", rows:[{name:"Players",value:"3"},{name:"Flags",value:"33"}]}`
  - `{header:"CLAN WARS", title:"RAID WEEKEND", rows:[{name:"Opens",value:"Fri 00:00"},{name:"Closes",value:"Mon 00:00"}]}`
  - `{header:"CLAN WARS", title:"WATCH ZONE", rows:[{name:"Radius",value:"100 m"}]}`
  - `{header:"NASDARA", title:"LOOT", rows:[{name:"Guns",value:"x2.5"},{name:"Loot",value:"Pristine"}]}`
  - `{header:"NASDARA", title:"FAST TRAVEL", rows:[{name:"From",value:"Any shed"},{name:"Hub",value:"No combat"}]}`

  Keep row names and values short. `screenWall` clips names at 14 characters.

- [ ] **Step 1: Write the failing tests** in `load.test.ts`:
  - `loads the real special`: `loadSpecial(<repo>/apps/show/specials/2026-10-nasdara)`
    gives `code === "Special"` and `narrative.length <= SPECIAL_SCRIPT_MAX`.
    `parseDialogue(narrative).length` equals the number of non-empty lines, and both
    `introPath` and `outroPath` exist.
  - `rejects a line that is not Boris:/Pavel:` (in a temp dir fixture): throws
    `/not a dialogue line/`.
  - `rejects an em or en dash in the script`: throws `/dash/`.
  - `rejects a script over SPECIAL_SCRIPT_MAX`: throws `/characters/`.
  - `rejects a missing intro.png`: throws `/intro.png/`.
  - `rejects meta with a code other than "Special" or an empty subtitle`.
- [ ] **Step 2: Run** `pnpm --filter @factions/show exec vitest run test/special/load.test.ts`.
  Expected: FAIL, because the module is missing.
- [ ] **Step 3: Implement `loadSpecial`.** It reads `script.txt` and trims the trailing
  newline. Each non-empty line must match `^(Boris|Pavel): `. `meta.json` is validated by
  hand; there is no zod in this package unless it is already a dependency.
- [ ] **Step 4: Copy the PNGs, write `meta.json`, and run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat(show): special episode directory and loader`.

### Task 2: Overrides in voice and render

**Files:**
- Modify: `apps/show/src/produce/voice.ts`. `voiceEpisode`'s `ep` changes from `{ weekStart, narrative, context }` to
  `{ weekStart: string; narrative: string } & ({ context: StoryContext } | { names: { names: string[]; aliases: string[] } })`
- Modify: `apps/show/src/produce/render.ts`. `renderEpisode`'s `ep` changes to
  `{ voiced: VoicedEpisode } & ({ context: StoryContext } | { special: SpecialVisuals })`
- Test: `apps/show/test/produce/voice.test.ts`, `apps/show/test/produce/render.test.ts`

**Interfaces:**
- Produces, from `render.ts`:
  `export type SpecialVisuals = { introScreenPath: string; outroStillPath: string; cards: Card[]; marqueeItems: string[] }`
- Call sites in `service.ts`, `dry-run.ts` and `stages/run.ts` keep passing `{ context }`.
  No change is needed there; the union accepts them.

- [ ] **Step 1: Write the failing tests.**
  - `voice.test.ts`, `uses the given names when no context is passed`: with the
    existing fakes and `ep = { weekStart: "special:x", narrative, names: { names: ["Nasdara"], aliases: [] } }`,
    the pronouncer is asked for exactly `["Nasdara"]`.
  - `render.test.ts`, `a special uses its own stills, cards and marquee`:
    - The intro path passed to `renderAnimatedShowVideo` is `introScreenPath`.
    - The outro path passed to it is `outroStillPath`, verbatim. No board PNG is written.
    - `buildScreenClip` receives `special.cards`.
    - The marquee receives `special.marqueeItems`.

    Use whichever seam the existing render tests use: the fake `runImpl` args or the fake fs.
- [ ] **Step 2: Run** both files. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - In `voiceEpisode`: `const { names, aliases } = "context" in ep ? collectNames(ep.context) : ep.names`.
  - In `renderEpisode`: branch on `"special" in ep` for the board path, the intro path, the
    cards and the marquee items. The weekly branch stays byte-for-byte the same.
- [ ] **Step 4: Run** `pnpm --filter @factions/show exec vitest run test/produce` and
  `pnpm --filter @factions/show typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(show): voice and render accept special overrides`.

### Task 3: `--special <dir> --render <out>`

**Files:**
- Modify: `apps/show/src/dispatch.ts`, `apps/show/src/cli.ts`
- Create: `apps/show/src/special/render-cli.ts`
- Test: `apps/show/test/dispatch.test.ts`, `apps/show/test/special/render-cli.test.ts`

**Interfaces:**
- Consumes: `loadSpecial`, `SpecialVisuals`, and the `voiceEpisode` and `renderEpisode`
  overrides from Tasks 1 and 2. Also `screenScript` from `script/write-script.ts`.
- Produces:
  - `dispatch(values & { special?: string; publish?: string })` returns
    `{ kind: "special-render" } | { kind: "special-publish" }`.
  - `export async function runSpecialRender(o: { dir: string; out: string }, io?: SpecialRenderIo): Promise<number>`
  - `export const specialCacheKeyWeek = (slug: string) => \`special:${slug}\``

- [ ] **Step 1: Write the failing dispatch tests.**
  - `--special d --render o` gives `special-render`.
  - `--special d --publish o` gives `special-publish`.
  - These are usage errors:
    - `--special` alone
    - `--special` with both `--render` and `--publish`
    - `--special` with `--week`, `--dry-run`, `--force` or `--repost`
    - `--publish` without `--special`
- [ ] **Step 2: Write the failing `render-cli.test.ts` tests**, with an injected `io`
  (fake screen, voice and render):
  - `screen reasons hold the render`: the screen returns `["blocklist: x"]`, so the exit
    code is 1 and voice is never called.
  - `renders and copies episode.mp3 and video.mp4 into out`: the exit code is 0, both files
    exist in `out`, and voice got `weekStart: "special:2026-10-nasdara"`.
- [ ] **Step 3: Implement.**
  - `runSpecialRender` needs `OPENROUTER_API_KEY` (for moderation and the pronouncer) plus
    `loadRenderConfig()`. **It must not require `DATABASE_URL` and must not open a DB.**
  - It uses `MemoryPronunciationStore`.
  - It calls `preflightRender` first.
  - It runs `screenScript(narrative, [], moderate)`.
  - It voices with `names: { names: special.pronounce, aliases: [] }`.
  - It renders with `special: { introScreenPath: introPath, outroStillPath: outroPath, cards, marqueeItems: marquee }`.
  - It copies `episode.mp3` and `video.mp4` into `out` and prints the duration.
  - It uses `renderCacheDir(renderCfg, out)`, the same as `--render`.
  - Add `special` and `publish` string options in `cli.ts`, and route the two new kinds
    (publish goes to Task 5's `runSpecialPublish`; until then it is a usage error).
- [ ] **Step 4: Run** `pnpm --filter @factions/show exec vitest run test/dispatch.test.ts test/special`.
  Expected: PASS.
- [ ] **Step 5: Commit** with `feat(show): render a special locally`.

### Task 4: Extract the approval decision

**Files:**
- Create: `apps/show/src/stages/approval.ts`
- Modify: `apps/show/src/stages/run.ts`. The `approved` step calls the extracted function.
- Test: `apps/show/test/stages/run.test.ts` (existing, unchanged) and
  `apps/show/test/stages/approval.test.ts`

**Interfaces:**
- Produces:
  `export async function decideDraft(d: { discord: Discord; approverIds: string[] }, channelId: string, draftId: string): Promise<{ decision: "approved" | "rejected"; by: string } | null>`.
  `APPROVE` and `REJECT` move here and are re-exported from `run.ts`.

- [ ] **Step 1: Write the failing `approval.test.ts`** with a fake `Discord`:
  - A ✅ from an approver gives `approved`.
  - A ❌ from an approver beats a ✅, giving `rejected`.
  - The bot's own ✅ gives `null`, even with the bot's id in `approverIds`.
  - A non-approver's ✅ gives `null`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Move the logic** out of `approved` into `decideDraft`, keeping the ⚠️
  comments. `approved` keeps its draft and ops-channel checks and maps the result to
  `advance(...)`.
- [ ] **Step 4: Run** `pnpm --filter @factions/show exec vitest run test/stages`. Expected:
  PASS, with `run.test.ts` unmodified.
- [ ] **Step 5: Commit** with `refactor(show): extract the draft approval decision`.

### Task 5: `--special <dir> --publish <out>`

**Files:**
- Create: `apps/show/src/special/publish.ts` (the state machine, pure apart from its deps)
- Create: `apps/show/src/special/text.ts` (the draft message, the marker and the Facebook caption)
- Create: `apps/show/src/special/publish-cli.ts` (wiring)
- Modify: `apps/show/src/cli.ts`
- Test: `apps/show/test/special/publish.test.ts`, `apps/show/test/special/text.test.ts`

**Interfaces:**
- Consumes:
  - `loadSpecial` (Task 1)
  - `decideDraft`, `APPROVE`, `REJECT` (Task 4)
  - the `YouTubeOps`, `FacebookOps` and `StageDeps["cfg"]` types, and `realDeps`
    (`service.ts`)
  - `buildVideoMeta`, `forumThreadName`, `transcriptMessages`, `publicCopy`, `cutHash`,
    `writeFileAtomic`
- Produces:
  ```ts
  export type SpecialState = {
    cut: string; youtubeVideoId?: string; draftMessageId?: string;
    approvedBy?: string; approvedAt?: string; rejectedBy?: string; rejectedAt?: string;
    publicAt?: string; forumThreadId?: string; postedAt?: string;
    facebookVideoId?: string; facebookError?: string; doneAt?: string;
  };
  export type SpecialPublishDeps = Pick<StageDeps, "youtube" | "discord" | "facebook" | "cfg" | "now" | "log" | "readFile">;
  export type SpecialOutcome = "done" | "waiting" | "rejected" | "cut-mismatch";
  export async function publishSpecial(deps: SpecialPublishDeps, s: Special, out: { videoPath: string; mp3Path: string; statePath: string }): Promise<SpecialOutcome>;
  export const specialMarker = (slug: string, narrative: string) => `show:special:${slug}:${cutHash(narrative)}`;
  export function specialDraftMessage(o: { subtitle: string; youtubeVideoId: string; narrative: string; marker: string }): OutMessage;
  export function specialFacebookCaption(o: { subtitle: string; lines: string[]; youtubeVideoId: string; discordInvite: string }): string;
  export async function runSpecialPublish(o: { dir: string; out: string }): Promise<number>;
  ```

**Steps** (resumable; state is written atomically after each one):

1. **Upload.** Build the metadata with
   `buildVideoMeta({ code: "Special", subtitle: publicCopy(subtitle), transcript: publicCopy(descriptionLead + "\n\n" + narrative) })`.
   Use `state.youtubeVideoId`, or else `youtube.findUpload(title, description)`, or else
   `youtube.upload` the video (unlisted).
2. **Draft.**
   - If `cfg.opsChannelId` is unset, fail.
   - Use `state.draftMessageId`. Otherwise look for a bot message among the ops channel's
     last 50 whose content contains `specialMarker`.
   - If there is none, post `specialDraftMessage`, then react ✅ and ❌ (best-effort).
3. **Decide.** Call `decideDraft`.
   - `null`: log `waiting for ✅ on the ops draft` and return `waiting`.
   - `rejected`: record it and return `rejected`. Later runs return `rejected` at once.
4. **Public.** `youtube.setPublic`, then `youtube.ensureInPlaylist`.
5. **Posted.**
   - Wait for YouTube processing (`waitProcessed`).
   - Thread name: `forumThreadName("Special", subtitle)`.
   - Adopt a thread only if its starter is exactly `https://youtu.be/<id>`.
   - Otherwise create one.
   - Post `transcriptMessages({ narrative, names: [], mp3 })`, resuming at
     `mine.length - 1`, exactly as the weekly `posted` step does.
6. **Facebook.** This step is best-effort.
   - Find by link, or upload with `specialFacebookCaption`.
   - Any error is stored in `facebookError`.
   - Then set `doneAt` and return `done`.

**Rules:**
- If the state file exists and `state.cut !== cutHash(narrative)`, return `cut-mismatch`
  without calling anything. The CLI exits 2 with:
  `the script changed since this cut was published; use a new --publish dir`.
- `runSpecialPublish` loads `loadServiceConfig()`, which must be enabled. It takes the
  `SHOW_LOCK_KEY` advisory lock, so it never overlaps the timer. It opens the DB only for
  that lock and for `realDeps(db, cfg)`. It takes from those deps only the fields in
  `SpecialPublishDeps`. Exit codes:
  - 0 for `done`, `waiting` and `rejected`
  - 2 for `cut-mismatch`
  - 1 when a step fails, after printing the error

- [ ] **Step 1: Write the failing `text.test.ts` tests.**
  - The `specialMarker` starts `show:special:2026-10-nasdara:`.
  - The `specialMarker` does not match the weekly marker regex `/^show:\d{4}-\d{2}-\d{2}:/`.
  - The draft content includes the youtu.be link and `React ✅ to publish or ❌ to reject`.
  - The Facebook caption contains no `—`, starts with
    `🎙️ The Bloodbag and Painkiller Show: Clan Wars Special · New to Clan Wars? Start here`,
    and includes `https://youtu.be/<id>` and `https://discord.gg/TJu4XP25nr`.
- [ ] **Step 2: Write the failing `publish.test.ts` tests**, with in-memory fakes for
  youtube, discord and facebook and a temp state path:
  - `waits at approval, then finishes after an approver ✅`:
    - **Run 1:** returns `waiting`. There is one upload, and it is unlisted. There is one
      draft. `setPublic` is not called.
    - The approver then adds a ✅.
    - **Run 2:** returns `done`, with `setPublic` and `ensureInPlaylist` called once each.
      One thread is created with the name `Clan Wars Special · New to Clan Wars? Start here`.
      The transcript is posted, and Facebook is uploaded once.
  - `a non-approver ✅ keeps it waiting`.
  - `❌ ends it rejected and nothing goes public`.
  - `a crash after upload adopts the existing upload`: the state has no youtube id and
    `findUpload` returns `"vid1"`, so `upload` is never called.
  - `an existing thread whose starter is this link is adopted, not recreated`.
  - `a facebook failure still finishes done with facebookError set`.
  - `a changed script returns cut-mismatch and calls nothing`.
- [ ] **Step 3: Run them.** Expected: FAIL.
- [ ] **Step 4: Implement** `text.ts`, `publish.ts` and `publish-cli.ts`, and route
  `special-publish` in `cli.ts`.
- [ ] **Step 5: Run** `pnpm --filter @factions/show exec vitest run test/special test/stages`
  and `pnpm --filter @factions/show typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** with `feat(show): publish a special through the approval gate`.

### Task 6: Docs, changelog, gate, PR

**Files:**
- Modify: `apps/show/README.md`. Add a "Special episodes" section covering both commands,
  the special dir layout, and the state file.
- Create: `docs/deploy/2026-10-19-special-episode.md`. The runbook steps:
  1. Render locally with `pnpm run show --special apps/show/specials/2026-10-nasdara --render ~/show-special`.
     The ElevenLabs env comes from `/opt/deathmatch-bot/.env`, which is the approved reuse.
  2. The user watches `video.mp4`.
  3. Release and deploy as usual.
  4. `scp` `episode.mp3` and `video.mp4` to
     `/var/lib/clan-wars-show/specials/2026-10-nasdara/` on the host.
  5. Run `sudo -u acab bash -c 'cd /opt/clan-wars && set -a && . ./.env && set +a && pnpm run show --special apps/show/specials/2026-10-nasdara --publish /var/lib/clan-wars-show/specials/2026-10-nasdara'`.
  6. ✅ the ops draft.
  7. Re-run the same command.
- Modify: `CHANGELOG.md`. Add under `## [Unreleased]`:
  `- The show can now publish a one-off special episode from a hand-written script, through the same ops approval as a weekly episode.`
  Keep the wording neutral and spoiler-free, because `release:sync` posts it publicly.

- [ ] **Step 1: Write the README section, the runbook and the changelog entry.**
- [ ] **Step 2: Run the full gate.**
  `TEST_DATABASE_URL="postgres://factions:factions@localhost:5440/factions" npx turbo run typecheck test --concurrency=1 --force`.
  Expected: **32/32 tasks**. Count them; don't trust the exit code.
- [ ] **Step 3: Commit** with `docs(show): special episode runbook and changelog`.
- [ ] **Step 4: Open the PR** via `keel:finish-work` (base `main`).
