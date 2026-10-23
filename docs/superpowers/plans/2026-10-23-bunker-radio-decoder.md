# Bunker Radio Decoder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public `/radio` page that listens through the microphone, decodes Nasdara's bunker Morse broadcast live, and shows three bunkers (grid, key code, map link) with their unsettled digits marked.

**Architecture:** Pure TypeScript does almost all the work, and every piece is unit-tested in node:
- **Detector** (`lib/radio/detector.ts`): turns audio samples into tone runs.
- **Decoder** (`lib/radio/decode.ts`): turns tone runs into groups and digit reads.
- **Tally** (`lib/radio/tally.ts`): votes the reads into three bunker cards.

The browser side is thin. `lib/radio/capture.ts` starts the microphone and an AudioWorklet, and `radio-view.tsx` re-runs the pure pipeline over everything heard so far. There is no server code and nothing is stored.

**Tech Stack:** Next.js app router (`apps/web`), React, Tailwind with the site's `app/components/ui.tsx` kit, Web Audio (`getUserMedia`, AudioWorklet loaded from a Blob URL), vitest (node; render tests use `renderToStaticMarkup`).

**Spec:** `docs/superpowers/specs/2026-10-23-bunker-radio-decoder-design.md`

## Global Constraints

- No audio, digit or code leaves the device. No `fetch`, no API route, no storage (`localStorage`, `sessionStorage` or cookies) anywhere in `lib/radio/` or `app/(site)/radio/`.
- `getUserMedia` constraints are exactly `{ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }`.
- Timing starting values (ms): dot `90`, dash `485`, start-to-start `890` after a dot and `1900` after a dash, character boundary `+400`, group gap `> 4000`, join runs under `300` apart, ignore runs under `50`. Classify by length: under `200` is a dot, over `300` is a dash, otherwise `?`. A gap fit has to be within `300`.
- Tone search runs from 300 to 3000 Hz. Reference bands sit ±140 Hz from the tone, and tone-on requires the tone to be 15 dB above them.
- Clustering rule: at least 4 known digits match and at most 1 disagrees. Settled means every digit has ≥ 2 agreeing reads and 0 against, **and** the grid is in `BUNKER_GRID_KEYS`.
- Grid keys come from the existing `gridRefKey(x, z)` (`lib/map-projection.ts`, `WORLD_SIZE_M` = 16384). Never re-derive the grid formula.
- Copy is player-facing: plain voice, US English, brand punctuation per `brand/02-verbal-identity.md`. The word "faction" may not appear anywhere in web source (`test/copy-vocabulary.test.ts`).
- Comments explain why. Mark silent-failure lines with `⚠️` (house style, CLAUDE.md).
- Full gate before the PR: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force` must report **32/32 tasks**. Locally, if 5434 is taken, use a throwaway `postgres:16` on 5440 (memory: local-test-postgres).

## Review Focus

1. **Listening starts mid-group.** The first group is a tail, and its digits must line up from the right, never be read as a group's first digits. Task 1 test `tail group aligns right`.
2. **A noise burst between groups** (a gunshot inside the 6.8 s silence) must not merge two groups or spawn a fourth card from junk. Tasks 1 and 2: tests `stray blip in the group gap` and `noise reads never make a fourth card`.
3. **A quiet phone held at a TV** (tone 30 dB lower than the recording) must still be detected, which is why the threshold adapts. Task 3 test `detects a quiet tone`.
4. **Microphone refused or missing** must show plain copy and a way forward, never a dead button. Task 4 test `renders the denied state`.
5. **A grid that isn't a bunker** must never show as settled, however many reads agree. Task 2 test `grid off the bunker list never settles`.

---

### Task 1: The decoder (`lib/radio/decode.ts`)

**Files:**
- Create: `apps/web/lib/radio/decode.ts`
- Create: `apps/web/test/radio-decode.test.ts`
- Fixture (already in the worktree, uncommitted): `apps/web/test/fixtures/bunker-radio-runs.json`. It holds `{ source, durationMs, runs: [startMs, lengthMs][] }`: 293 raw runs from the recording, including 5 ms blips that must be dropped.

**Interfaces:**
- Produces:
  ```ts
  export type ToneRun = { start: number; length: number };          // ms since listening began
  export type Sym = "." | "-" | "?";
  export type Group = { start: number; symbols: Sym[]; fromStart: boolean; open: boolean };
  export type Read = { digits: string };                             // always 10 chars, '?' where unknown
  export const TIMING: { dot: 90; dash: 485; pitchDot: 890; pitchDash: 1900; charExtra: 400; groupGap: 4000; joinGap: 300; minRun: 50 };
  export function speedScale(runs: ToneRun[]): number;
  export function spellGroups(runs: ToneRun[], now: number): Group[];
  export function toDigits(symbols: Sym[], from?: "left" | "right"): string;
  export function readsOf(groups: Group[]): Read[];
  ```

**Behavior to implement.** Port `spellGroups` from the prototype (algorithm in the spec, "How it works"):
- Join runs less than `joinGap` apart, then drop runs under `minRun`.
- Split into groups at silences over `groupGap`.
- Classify each element by length. Then use `explain(first, pitch)` on the start-to-start time to the next run: try every 1 to 3 element sequence whose first symbol matches (unless the first is `?`), each with 0 to n boundaries of `charExtra`, keep the smallest error under 300, and push `?` if none fits. The last element of a group is classified by length alone.
- Multiply every timing by `speedScale(runs)`. That's the median start-to-start time of runs whose length is over 300 and whose start-to-start time is under 1.45 × 1900, divided by 1900. Use it only when there are at least 5 such runs; otherwise it's `1`.
- `fromStart`: the first group needs `start >= groupGap`. Any other group is preceded by a silence over `groupGap`, so it's `true`.
- `open`: true for the last group when `now - lastRunEnd <= groupGap`.
- `toDigits` chunks five at a time, from the left or (for `"right"`) from the end. In a chunk with `?`, the digit is known only if exactly one digit fits.
- `readsOf`:
  - drop groups with fewer than 10 symbols;
  - closed, `fromStart` and exactly 50 symbols → full read;
  - not `fromStart` → `toDigits(s, "right")`, right-aligned and padded with `?` on the left;
  - anything else → left-aligned and padded on the right;
  - at most 10 digits each way.

- [ ] **Step 1: Write the failing tests** in `apps/web/test/radio-decode.test.ts`

```ts
const fx = JSON.parse(readFileSync(join(__dirname, "fixtures/bunker-radio-runs.json"), "utf8"));
const runs: ToneRun[] = fx.runs.map(([start, length]: [number, number]) => ({ start, length }));
const digits = (rs: ToneRun[], now = fx.durationMs) => readsOf(spellGroups(rs, now)).map((r) => r.digits);

it("decodes the recording", () => {
  expect(digits(runs)).toEqual(["????002049", "0910442410", "1001219970", expect.stringMatching(/^0281002/)]);
});
it("puts back the dot drowned out at 59 s", () => {          // group 2 is exactly 50 symbols
  const g = spellGroups(runs, fx.durationMs).find((x) => Math.abs(x.start - 59160) < 50)!;
  expect(g.symbols).toHaveLength(50);
});
it("reads a dash chopped by noise as one dash", () => {      // synthetic: [0,200],[230,255] then a dot
  /* build a 5-element "-----" where element 1 is split into two pieces 30 ms apart; expect toDigits === "0" */
});
it("tail group aligns right", () => {                        // runs.filter(r => r.start < 53000), now 53000
  expect(digits(runs.filter((r) => r.start < 53000), 53000)).toEqual(["????002049"]);
});
it("cut-off group aligns left and stays open", () => {       // runs before 270000, now 270500
  const gs = spellGroups(runs.filter((r) => r.start < 270000), 270500);
  expect(gs.at(-1)!.open).toBe(true);
  expect(readsOf(gs).at(-1)!.digits).toMatch(/^0281/);
});
it("stray blip in the group gap", () => {                    // add {start: 55000, length: 120} to runs
  /* expect group 2 still decodes to "0910442410" and no extra read appears */
});
it.each([0.85, 1.15])("decodes at %s× speed", (k) => {
  const scaled = runs.map((r) => ({ start: r.start * k, length: r.length * k }));
  expect(digits(scaled, fx.durationMs * k).slice(1, 3)).toEqual(["0910442410", "1001219970"]);
});
```

Fill in the two synthetic cases by building runs from the spec timings. A `morse(digits: string): ToneRun[]` helper in the test file is the expected shape.

- [ ] **Step 2: Run, and see it fail**

Run: `pnpm --filter @factions/web exec vitest run test/radio-decode.test.ts`
Expected: FAIL, because `lib/radio/decode` can't be resolved.

- [ ] **Step 3: Implement `apps/web/lib/radio/decode.ts`** to the interface and behavior above.

- [ ] **Step 4: Run, and see it pass**

Same command. Expected: all pass. If `decodes the recording` gives a different 4th read, print it and compare with the prototype's `0281002?4`. That trailing noise is real, and the regex only pins the first 7 digits.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/radio/decode.ts apps/web/test/radio-decode.test.ts apps/web/test/fixtures/bunker-radio-runs.json
git commit -m "feat(radio): Morse decoder for the bunker broadcast"
```

---

### Task 2: Bunker list and tally (`lib/radio/bunkers.ts`, `lib/radio/tally.ts`)

**Files:**
- Create: `apps/web/lib/radio/bunkers.ts`, `apps/web/lib/radio/tally.ts`
- Create: `apps/web/test/radio-tally.test.ts`, `apps/web/test/radio-bunkers-drift.test.ts`

**Interfaces:**
- Consumes: `Read` from Task 1.
- Produces:
  ```ts
  // bunkers.ts
  export const BUNKER_GRID_KEYS: readonly string[];   // 23 six-digit keys, sorted
  export function isBunkerGrid(key: string): boolean;
  // tally.ts
  export type DigitState = { value: string | null; agree: number; against: number };
  export type BunkerCard = { grid: string; key: string; digits: DigitState[]; reads: number; isBunker: boolean; settled: boolean };
  export function tally(reads: Read[]): BunkerCard[];   // at most 3, most reads first
  ```

**Behavior.**
- `tally` sorts reads with full reads first, then by fewest `?`.
- A read joins the first cluster whose current vote shares ≥ 4 known digits with it and differs in ≤ 1. Otherwise it starts a new cluster.
- Per position: `value` is the majority of the known digits (null if none). `agree` is that majority's count. `against` counts the other known digits.
- `grid` and `key` are `digits.map(d => d.value ?? "?")` split 6/4. `reads` is the cluster size.
- `isBunker = isBunkerGrid(grid)`. `settled` follows the Global Constraints rule.
- Return the top 3 clusters by `reads`, ties by first heard. ⚠️ The codes are stable all night (spec), so a fourth cluster is always noise. That's why the output is capped and not shown.

- [ ] **Step 1: Write the drift test** `radio-bunkers-drift.test.ts`. Read `public/map-data/nasdara/world.json` the way `test/map-icons.test.ts:74` does. Expect `[...new Set(world.bunkers.map(b => gridRefKey(b.x, b.z)))].sort()` to equal `BUNKER_GRID_KEYS`, and expect `BUNKER_GRID_KEYS` to contain `"091044"`, `"100121"` and `"028100"`.

- [ ] **Step 2: Write the tally tests** `radio-tally.test.ts`

```ts
it("stitches the recording's halves", () => {
  const cards = tally([{ digits: "????002049" }, { digits: "0910442410" }, { digits: "1001219970" }, { digits: "0281002?4?" }]);
  expect(cards.map((c) => c.grid + c.key).sort()).toEqual(["0281002049", "0910442410", "1001219970"]);
  expect(cards.every((c) => !c.settled)).toBe(true);           // one pass each: not settled
});
it("settles after two clean passes on a bunker grid", () => {
  const [c] = tally([{ digits: "0910442410" }, { digits: "0910442410" }]);
  expect(c).toMatchObject({ settled: true, isBunker: true, reads: 2 });
});
it("a disagreeing digit keeps it unsettled", () => {
  const [c] = tally([{ digits: "0910442410" }, { digits: "0910442410" }, { digits: "0910442411" }]);
  expect(c.digits[9]).toEqual({ value: "0", agree: 2, against: 1 });
  expect(c.settled).toBe(false);
});
it("grid off the bunker list never settles", () => {
  expect(tally(Array(5).fill({ digits: "5555552410" }))[0]!.settled).toBe(false);
});
it("noise reads never make a fourth card", () => {
  const reads = ["0910442410", "1001219970", "0281002049", "7777777777"].map((digits) => ({ digits }));
  expect(tally([...reads, ...reads.slice(0, 3)])).toHaveLength(3);
});
```

- [ ] **Step 3: Run both, and see them fail**

Run: `pnpm --filter @factions/web exec vitest run test/radio-tally.test.ts test/radio-bunkers-drift.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement.** Generate the 23 keys once with a throwaway node one-liner over `world.json` and `gridRefKey`, and paste them as a literal. ⚠️ The comment must say that the drift test holds them to `world.json`, and that bunker squares are public map features while `/map-data/` itself is gated (spec).

- [ ] **Step 5: Run, and see them pass.** Same command. Expected: PASS.

- [ ] **Step 6: Commit** with `git commit -m "feat(radio): bunker list and vote tally"`

---

### Task 3: The tone detector (`lib/radio/detector.ts`)

**Files:**
- Create: `apps/web/lib/radio/detector.ts`
- Create: `apps/web/test/radio-detector.test.ts`

**Interfaces:**
- Consumes: `ToneRun` from Task 1.
- Produces:
  ```ts
  export class ToneDetector {
    constructor(sampleRate: number, opts?: { tone?: number });
    push(samples: Float32Array): ToneRun[];   // runs that ended during this push; ms since the first sample
    readonly tone: number | null;             // locked frequency (Hz), null while searching
    readonly level: number;                   // 0..1 for the meter
    readonly toneOn: boolean;
  }
  ```

**Behavior.** Use 5 ms frames (`round(sampleRate × 0.005)` samples) and Goertzel power at `tone`, `tone − 140` and `tone + 140`.
- **Tone on** when the tone band is more than 15 dB above the mean of the two reference bands, **and** the tone level is above (the 95th percentile of the last 60 s of tone levels − 12 dB).
- **Finding the tone (no `opts.tone`):**
  - every 100 ms, a Goertzel bank over a 2048-sample window covers 300 to 3000 Hz in 10 Hz steps;
  - accumulate each bin's peak-to-median ratio;
  - lock once the same bin (±1) has led for 3 s with a ratio over 10;
  - no runs are produced before the lock.
- Runs come out as `{ start, length }` in ms, for `decode.ts`. Joining and dropping are the decoder's job, not this class's.

- [ ] **Step 1: Write the failing tests.** Make a helper `synth(digits, { rate = 48000, tone = 988, gainDb = 0, noise = 0.02, bursts = [] })` that renders Morse at the spec timings. Each element gets a 5 ms ramp, the digits are padded with 5 s of silence front and back, and white noise is added on top. A burst is 200 ms of broadband noise at 10× amplitude. Feed it to `push` in 128-sample blocks, then run the collected runs through Task 1's `spellGroups`/`readsOf`.
  - `locks onto 988 Hz`: `detector.tone` is within 10 of 988.
  - `finds another tone`: with `tone: 1200`, it's within 10 of 1200.
  - `decodes a clean group`: reads equal `["0910442410"]`.
  - `ignores gunshot bursts`: 6 bursts inside the group still give `["0910442410"]`.
  - `detects a quiet tone`: `gainDb: -30` with noise scaled the same still decodes.

- [ ] **Step 2: Run, and see it fail**

Run: `pnpm --filter @factions/web exec vitest run test/radio-detector.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `ToneDetector`.** Keep it allocation-free in `push`'s hot loop, because it runs on the main thread for every block.

- [ ] **Step 4: Run, and see it pass.** Same command. Expected: PASS, in under ~10 s (synthetic audio is about 90 s at 48 kHz).

- [ ] **Step 5: Commit** with `git commit -m "feat(radio): live tone detector"`

---

### Task 4: The page (`/radio`)

**Files:**
- Create: `apps/web/lib/radio/capture.ts`
- Create: `apps/web/app/(site)/radio/page.tsx`, `radio-view.tsx` (client), `bunker-card.tsx`
- Modify: `apps/web/lib/auth/gate.ts:21` (add `"/radio"` to `PUBLIC_PATHS`), `apps/web/test/auth-gate.test.ts:13` (the pinned list, plus `pathIsPublic("/radio") === true` and `pathIsPublic("/radios") === false`)
- Modify: `apps/web/lib/guide-links.ts` (`"/radio": { slug: "the-map", heading: "the-bunker-radio" }`), `apps/web/test/guide-links.test.ts:30` (route list)
- Create: `apps/web/test/radio-render.test.tsx`

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces:
  ```ts
  // capture.ts
  export type CaptureError = "denied" | "no-device" | "unsupported";
  export async function startCapture(onSamples: (block: Float32Array) => void): Promise<{ sampleRate: number; stop(): void }>;
  // bunker-card.tsx
  export function BunkerCardView(props: { n: 1 | 2 | 3; card: BunkerCard | null }): JSX.Element;
  // radio-view.tsx
  export type RadioState = "idle" | "starting" | "listening" | "denied" | "no-device" | "unsupported";
  export function RadioPanel(props: { state: RadioState; level: number; toneOn: boolean; current: string; cards: BunkerCard[]; onListen(): void; onStop(): void; onClear(): void }): JSX.Element;  // pure, rendered by the client component
  ```

**Behavior.**
- **`startCapture`:**
  - calls `getUserMedia` with the exact constraints from Global Constraints, then creates an `AudioContext`;
  - adds a worklet from a **Blob URL** built from an inline source string; the worklet's `process` posts a copy of `inputs[0][0]`;
  - ⚠️ never a file in `public/`: `gate.ts` gates every `public/` path, so a signed-out visitor's worklet fetch would redirect to `/login` and fail silently;
  - maps `NotAllowedError` to `"denied"` and `NotFoundError` to `"no-device"`, and anything without `mediaDevices` or `AudioWorklet` to `"unsupported"`, throwing those as `Error` messages;
  - `stop()` stops the tracks and closes the context.
- **The client component (default export of `radio-view.tsx`):**
  - holds the detector and the list of runs in refs;
  - on every block, calls `detector.push` and appends the runs;
  - about 10 times a second, recomputes `tally(readsOf(spellGroups(runs, now)))` and the open group's digits so far (`current`), then sets state;
  - requests `navigator.wakeLock.request("screen")` while listening and releases it on stop (ignoring failures);
  - **Clear** empties the runs and cards and keeps listening.
- **`page.tsx`:**
  - `metadata.title` is `"Clan Wars — radio"`;
  - `PageHead kicker="Live" title="Radio"`, with `aside` set to the Live nav from Task 5 and `guide={guideLinkFor("/radio")}`;
  - renders the client component;
  - no `force-dynamic`, because it reads nothing.
- **`BunkerCardView`:**
  - grid as `091 044` and key `2410` in the site's mono type;
  - unsettled digits (`agree < 2 || against > 0`) dimmed (`text-muted`), unknown ones as `?`;
  - `Heard N times`;
  - a **Map** link (`linkMono`) to `/map?at=${grid}` only when the grid has no `?`;
  - `Settled` in gold when `card.settled`;
  - when `card` is null: `Bunker n` with `?` placeholders.

**Copy** (exact):
- idle: "Stand by the radio in game, press Listen, and hold your phone or laptop near the speaker. The codes fill in as the beeps come in." Then: "The sound never leaves your device."
- Listen button (`btnPrimary`): "Listen". Stop (`btnSecondary`): "Stop". Clear (`btnQuiet`): "Clear".
- denied: "Your browser blocked the microphone. Allow it for this site in your browser settings, then press Listen again."
- no-device: "No microphone found. Plug one in or use a phone, then press Listen again."
- unsupported: "This browser can't listen. Try Chrome or Safari on a phone."
- listening, before the tone locks: "Listening for the beeps…" After the lock: "Hearing the radio."
- hint while any card is unsettled: "Keep listening. Each code is settled once it's been heard twice the same way."

- [ ] **Step 1: Write the failing tests.** In `radio-render.test.tsx`, use `renderToStaticMarkup` on `RadioPanel` and `BunkerCardView`:
  - `renders the idle state`: contains "Listen" and "never leaves your device".
  - `renders the denied state`: contains the denied copy and a Listen button.
  - `links a full grid to the map`: a card with grid `091044` has `href="/map?at=091044"`.
  - `no map link while the grid has a gap`: grid `09?044` has no `/map?at=`.
  - `marks settled`: `settled: true` shows "Settled", and `settled: false` doesn't.

  Also update `auth-gate.test.ts` and `guide-links.test.ts` as listed under Files.

- [ ] **Step 2: Run, and see them fail**

Run: `pnpm --filter @factions/web exec vitest run test/radio-render.test.tsx test/auth-gate.test.ts test/guide-links.test.ts`
Expected: FAIL. The render modules are missing, and the gate list and guide link don't match yet.

- [ ] **Step 3: Implement** the files above. `guide-links.test.ts` will keep failing on the missing `the-bunker-radio` anchor until Task 6, so add the guide heading there first or run Task 6's guide step now. Either is fine; just commit them together.

- [ ] **Step 4: Run, and see them pass.** Same command. Expected: PASS.

- [ ] **Step 5: Check it by hand.** Run `pnpm --filter @factions/web dev`, open `http://localhost:3000/radio` signed out, press Listen, and play the recording (`twitch.tv/videos/2908002004`) from another device's speaker. Expected: the tone locks near 988 and cards fill in. After one cycle, grid `091 044` and key `2410` appear unsettled.

- [ ] **Step 6: Commit** with `git commit -m "feat(radio): the /radio page"`

---

### Task 5: Navigation

**Files:**
- Modify: `apps/web/lib/menu.ts` (add `{ label: "Radio", href: "/radio" }` to `BOARDS_LONG` after War log; add `"/radio"` to Live's `also` in `BOARDS`)
- Modify: `apps/web/lib/live-items.ts`: add `export function liveNav(current: string): { label: string; href: string; current: boolean }[]`, which is `LIVE_TABS` mapped to `/live/${feed}` plus `{ label: "Radio", href: "/radio" }` last
- Modify: `apps/web/app/(site)/live/[feed]/page.tsx:20` (build `nav` from `liveNav(`/live/${feed}`)`), and use the same helper in `radio/page.tsx`
- Test: `apps/web/test/menu.test.ts`, `apps/web/test/live.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - `menu.test.ts`: update the pinned drawer list (lines 15 and 28) to include `/radio` after `/war-log`.
  - New `Live lights up on /radio`: `isCurrent(live, "/radio") === true`.
  - `live.test.ts`: `liveNav("/radio").at(-1)` equals `{ label: "Radio", href: "/radio", current: true }`, and `liveNav("/live/kills")[0].current === true`.
- [ ] **Step 2: Run, and see them fail**

Run: `pnpm --filter @factions/web exec vitest run test/menu.test.ts test/live.test.ts`
Expected: FAIL.
- [ ] **Step 3: Implement.** ⚠️ Add no new cell to `BOARDS` (the bar overflows at 1024 px; see the comment in `menu.ts`). The desktop drawer is a later project.
- [ ] **Step 4: Run, and see them pass.** Same command. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(radio): Radio in the drawer and the Live tabs"`

---

### Task 6: Guide, changelog, gate, PR

**Files:**
- Modify: `apps/web/content/guide/10-the-map.html`: add `<h2>The bunker radio</h2>` (anchor `the-bunker-radio`) after "Pins". In 2 to 4 sentences, in the player-facing voice, cover:
  - at night a radio broadcasts three bunkers in Morse;
  - each is a six-digit grid and a four-digit key, and the codes hold all night;
  - `/radio` listens and writes them down;
  - its map link opens that square.
- Modify: `CHANGELOG.md` under `## [Unreleased]`: `### Added`, then one line: "A Radio page that listens to the bunker broadcast through your phone's microphone and writes down each bunker's grid and key code, with a link to it on the map."

- [ ] **Step 1: Write the guide section and changelog line.**
- [ ] **Step 2: Run the guide tests.**

Run: `pnpm --filter @factions/web exec vitest run test/guide.test.ts test/guide-links.test.ts test/guide-a11y.test.ts test/copy-vocabulary.test.ts`
Expected: PASS.
- [ ] **Step 3: Run the full gate.** Use the command in Global Constraints. Expected: **32/32 tasks** successful. Check the count, not the exit code.
- [ ] **Step 4: Commit.** `git commit -m "docs(radio): guide section and changelog"`
- [ ] **Step 5: Open the PR** with `keel:finish-work` (base `main`).
