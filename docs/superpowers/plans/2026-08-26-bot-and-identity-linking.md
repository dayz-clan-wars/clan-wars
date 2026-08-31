# Discord Bot Foundation + Emote-Verified Identity Linking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A player runs `/link` in Discord, performs three emotes in-game, and their Discord account is bound to their DayZ UID — the identity every later faction command depends on.

**Architecture:** Two new packages and one new app on top of the Plan 1 event log. `@factions/adm-parser` gains an emote rule that emits `emote.performed` events carrying the UID the ADM line already contains. `@factions/verification` is a pure sequence/matching library. `@factions/bot` is a discord.js gateway client that issues challenges, and also runs the verification tick as an in-process loop so it can reply to the player directly — no second deploy, no cross-process handoff.

**Tech Stack:** discord.js 14, Drizzle ORM, Postgres 16, vitest, TypeScript strict + `noUncheckedIndexedAccess`, ESM with `.js` specifiers. Same pnpm/turbo workspace as Plan 1.

**Spec:** `docs/superpowers/specs/2026-08-26-factions-design.md` — §16 (Identity linking) is the binding section for this plan; §5 and §6 are the consumers that depend on it.

## Global Constraints

- **Repo:** `/Users/steveharmeyer/Development/dayz-one-life/factions`. Branch off `feat/ingest-and-flag-events` (Plan 1's work, open as PR #1 and not yet on `main`).
- **Postgres on host port 5434.** Ports 5432 and 5433 belong to other projects on this machine — never stop, remove, or repoint their containers. DB suites need `TEST_DATABASE_URL=postgres://factions:factions@localhost:5434/factions`.
- **DB test suites truncate the shared database.** Never run a backfill and a DB suite against the same database and then read the result as acceptance evidence.
- **Bind the UID, not the gamertag** (spec §16). The 40-hex `dayzId` is the identity everywhere. `gamertag` is a display label and is never a key, never a join column, and never trusted for equality.
- **Coordinates must never reach a public read model** (spec §11). Nothing in this plan touches coordinates; do not add them to any bot reply either — an emote's `pos` is a player's live position and is not to be echoed into Discord.
- **`parseLine`'s branch order is load-bearing.** `subIndex` in the event log is the returned array's index; reordering renumbers every historical event and collides with `events_idempotency_uniq`. The emote branch is APPENDED at the end of the chain. Do not reorder existing branches.
- **Never commit** `adm-raw-20260826.log.gz`, any decompressed copy, anything under `.superpowers/`, or a Discord bot token.
- **Never run `git clean -fdx`** — it destroys the git-ignored SDD workspace.
- **Commit after every task.** Conventional commits.
- **ESM specifiers:** every relative import ends in `.js`, even from a `.ts` file.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/domain/src/emotes.ts` | The emote dictionary — token, label, safe flag. Calibrated against the production export. |
| `packages/domain/src/events.ts` | Add `emote.performed` to `EventType`. |
| `packages/adm-parser/src/emote.ts` | One regex, one function: raw line → `{ gamertag, dayzId, emote, item }`. |
| `packages/adm-parser/src/parse-line.ts` | Append the emote branch; map it to `emote.performed`. |
| `packages/adm-parser/src/index.ts` | Re-export. |
| `apps/ingest-worker/src/ingest.ts` | `toPayload` case for emotes. |
| `packages/verification/src/sequence.ts` | `generateSequence`, `isExpired`. Pure. |
| `packages/verification/src/match.ts` | `advance`. Pure. |
| `packages/db/src/schema.ts` | `identity_links`, `verification_challenges`, `challenge_attempts`. |
| `packages/event-log/src/cursor.ts` | `readEventBatch`. |
| `apps/bot/src/config.ts` | Env parsing; refuses to start on a missing token. |
| `apps/bot/src/store.ts` | `PgVerificationStore` — every DB read/write the tick and the commands need. |
| `apps/bot/src/tick.ts` | Consume `emote.performed`, advance attempts, bind on completion. Pure of discord.js. |
| `apps/bot/src/commands.ts` | `/link`, `/unlink`, `/whoami` logic returning reply descriptors. Pure of discord.js. |
| `apps/bot/src/discord.ts` | discord.js glue: client, command registration, interaction routing, tick loop. |
| `apps/bot/src/main.ts` | Entry point. |

### Why the tick lives in the bot, not its own app

`one-life` runs a standalone `verifier` because a web UI polled challenge status out of the database. Factions has no web surface for this (spec §16, "Scope boundary"), so a separate process would complete a challenge and then have no way to tell the player. Hosting the tick inside the bot lets the completion path send the message directly. `@factions/verification` and `apps/bot/src/tick.ts` stay free of discord.js so both remain unit-testable.

### Correctness note: progress is per (challenge, UID)

`one-life` stores a single `progressIndex` on the challenge because it knows the target gamertag when the challenge is issued. Factions does **not** — the whole point of §16 is that the player types nothing. A single global `progressIndex` would let three different players each contribute one emote and jointly complete a challenge, binding whichever UID happened to fire last.

`challenge_attempts` therefore keys progress on `(challenge_id, dayz_id)`. Any UID may attempt; the first to complete the full ordered sequence wins the binding. This is a deliberate divergence from the port, not an oversight.

---

### Task 1: Emote dictionary and the `emote.performed` event type

**Files:**
- Create: `packages/domain/src/emotes.ts`
- Modify: `packages/domain/src/events.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/test/emotes.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `EMOTE_DICTIONARY: EmoteEntry[]`, `emoteToken(label: string): string | undefined`, `emoteLabel(token: string): string | undefined`, `safeVerificationEmotes(): EmoteEntry[]`, `type EmoteEntry = { label: string; token: string; safe: boolean }`. `EventType` gains `"emote.performed"`.

The token list below is not invented — it is the complete census of `performed Emote*` tokens in the 72,885-line production export (35 distinct tokens, 2,093 lines). `safe: false` means the emote occurs in natural play often enough to risk a false match, or carries a gameplay penalty. `EmoteSitA` alone is 1,611 of the 2,093 lines (77%) and must never enter a challenge sequence.

- [ ] **Step 1: Write the failing test**

```ts
// packages/domain/test/emotes.test.ts
import { describe, it, expect } from "vitest";
import { EMOTE_DICTIONARY, emoteToken, emoteLabel, safeVerificationEmotes } from "../src/emotes.js";

describe("emote dictionary", () => {
  it("has a unique token for every entry", () => {
    const tokens = EMOTE_DICTIONARY.map((e) => e.token);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("has a unique label for every entry", () => {
    const labels = EMOTE_DICTIONARY.map((e) => e.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("resolves a label to its token, case-insensitively", () => {
    expect(emoteToken("salute")).toBe("EmoteSalute");
    expect(emoteToken("SALUTE")).toBe("EmoteSalute");
  });

  it("resolves a token back to its label", () => {
    expect(emoteLabel("EmoteSalute")).toBe("salute");
  });

  it("returns undefined for an unknown label or token", () => {
    expect(emoteToken("nonsense")).toBeUndefined();
    expect(emoteLabel("EmoteNonsense")).toBeUndefined();
  });

  it("excludes the emotes that dominate natural play from the safe pool", () => {
    const safe = safeVerificationEmotes().map((e) => e.token);
    // EmoteSitA is 77% of every emote line in the production export.
    expect(safe).not.toContain("EmoteSitA");
    expect(safe).not.toContain("EmoteSitB");
    expect(safe).not.toContain("EmoteCampfireSit");
    expect(safe).not.toContain("EmoteLyingDown");
  });

  it("excludes emotes that carry a gameplay penalty", () => {
    const safe = safeVerificationEmotes().map((e) => e.token);
    expect(safe).not.toContain("EmoteSuicide");
    expect(safe).not.toContain("EmoteVomit");
  });

  it("leaves a pool large enough that a 3-emote sequence is not guessable", () => {
    const n = safeVerificationEmotes().length;
    // n*(n-1)*(n-2) distinct ordered sequences; require at least 10k.
    expect(n * (n - 1) * (n - 2)).toBeGreaterThan(10_000);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @factions/domain test`
Expected: FAIL — `Cannot find module '../src/emotes.js'`

- [ ] **Step 3: Write the implementation**

```ts
// packages/domain/src/emotes.ts
export type EmoteEntry = { label: string; token: string; safe: boolean };

/**
 * Every `performed Emote*` token observed in the production ADM export
 * (2026-08-26: 35 distinct tokens across 2,093 lines).
 *
 * `safe: false` excludes an emote from verification sequences, for one of two
 * reasons:
 *
 *   1. It occurs in natural play. `EmoteSitA` is 1,611 of the 2,093 emote
 *      lines — 77% of all emote traffic. A sequence containing it would
 *      routinely be completed by accident, binding a UID that never ran
 *      `/link`.
 *   2. It carries a gameplay penalty. Asking a player to prove identity by
 *      killing their character is not a verification flow.
 *
 * ⚠️ Do not add a token here that has not been observed in a real ADM line.
 * A guessed token can never be performed, so a sequence containing it can
 * never complete, and the failure looks like a broken parser.
 */
export const EMOTE_DICTIONARY: EmoteEntry[] = [
  { label: "salute", token: "EmoteSalute", safe: true },
  { label: "surrender", token: "EmoteSurrender", safe: true },
  { label: "greeting", token: "EmoteGreeting", safe: true },
  { label: "clap", token: "EmoteClap", safe: true },
  { label: "heart", token: "EmoteHeart", safe: true },
  { label: "point", token: "EmotePoint", safe: true },
  { label: "point at self", token: "EmotePointSelf", safe: true },
  { label: "thumbs up", token: "EmoteThumb", safe: true },
  { label: "thumbs down", token: "EmoteThumbDown", safe: true },
  { label: "nod head", token: "EmoteNod", safe: true },
  { label: "shake head", token: "EmoteShake", safe: true },
  { label: "dance", token: "EmoteDance", safe: true },
  { label: "facepalm", token: "EmoteFacepalm", safe: true },
  { label: "shrug", token: "EmoteShrug", safe: true },
  { label: "timeout", token: "EmoteTimeout", safe: true },
  { label: "look at me", token: "EmoteLookAtMe", safe: true },
  { label: "listen", token: "EmoteListening", safe: true },
  { label: "come", token: "EmoteCome", safe: true },
  { label: "move", token: "EmoteMove", safe: true },
  { label: "silent", token: "EmoteSilent", safe: true },
  { label: "watching", token: "EmoteWatching", safe: true },
  { label: "cut throat", token: "EmoteThroat", safe: true },
  { label: "rock paper scissors", token: "EmoteRPSRandom", safe: true },
  { label: "hold", token: "EmoteHold", safe: true },
  { label: "SOS", token: "EmoteSOS", safe: true },
  // Taunts — observed in the export, absent from one-life's dictionary.
  { label: "taunt", token: "EmoteTaunt", safe: true },
  { label: "taunt elbow", token: "EmoteTauntElbow", safe: true },
  { label: "blow a kiss", token: "EmoteTauntKiss", safe: true },
  { label: "thinking", token: "EmoteTauntThink", safe: true },
  // Unsafe — natural play (postures players hold for minutes at a time).
  { label: "sit", token: "EmoteSitA", safe: false },
  { label: "sit cross-legged", token: "EmoteSitB", safe: false },
  { label: "sit at campfire", token: "EmoteCampfireSit", safe: false },
  { label: "lie down", token: "EmoteLyingDown", safe: false },
  // Unsafe — gameplay penalty.
  { label: "suicide", token: "EmoteSuicide", safe: false },
  { label: "vomit", token: "EmoteVomit", safe: false },
];

const byLabel = new Map(EMOTE_DICTIONARY.map((e) => [e.label.toLowerCase(), e]));
const byToken = new Map(EMOTE_DICTIONARY.map((e) => [e.token, e]));

export function emoteToken(label: string): string | undefined {
  return byLabel.get(label.toLowerCase())?.token;
}

export function emoteLabel(token: string): string | undefined {
  return byToken.get(token)?.label;
}

export function safeVerificationEmotes(): EmoteEntry[] {
  return EMOTE_DICTIONARY.filter((e) => e.safe);
}
```

- [ ] **Step 4: Add `emote.performed` to the event type union**

In `packages/domain/src/events.ts`, append to the union (append only — do not reorder, the strings are persisted in `events.type`):

```ts
export type EventType =
  | "flag.raised"
  | "flag.lowered"
  | "flagpole.placed"
  | "flagpole.folded"
  | "flagpole.built"
  | "flagpole.dismantled"
  | "player.position"
  | "emote.performed";
```

- [ ] **Step 5: Export from the package index**

In `packages/domain/src/index.ts`, add: `export * from "./emotes.js";`

- [ ] **Step 6: Run the tests and typecheck**

Run: `pnpm --filter @factions/domain test && pnpm --filter @factions/domain typecheck`
Expected: PASS — 8 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/domain/src/emotes.ts packages/domain/src/events.ts packages/domain/src/index.ts packages/domain/test/emotes.test.ts
git commit -m "feat(domain): emote dictionary calibrated against the production export"
```

---

### Task 2: ADM emote parser

**Files:**
- Create: `packages/adm-parser/src/emote.ts`
- Modify: `packages/adm-parser/src/parse-line.ts`
- Modify: `packages/adm-parser/src/index.ts`
- Modify: `apps/ingest-worker/src/ingest.ts`
- Test: `packages/adm-parser/test/emote.test.ts`
- Test: `packages/adm-parser/test/parse-line.test.ts` (add cases)

**Interfaces:**
- Consumes: `parseIdentity(raw)` from `./identity.js` — returns `{ gamertag, dayzId } | null`, already handles the `(DEAD)` marker variant.
- Produces: `parseEmote(raw: string): EmotePerformed | null` where `type EmotePerformed = { gamertag: string; dayzId: string; emote: string; item: string | null }`. `ParsedLine` gains `{ kind: "emote"; event: EmotePerformed }`. `eventTypeFor` returns `"emote.performed"` for it.

Real lines from the export, identity redacted:

```
| 15:24:30 | Player "<NAME>" (id=<UID40> pos=<11201.5, 6703.0, 56.4>) performed EmoteCampfireSit
| 18:58:20 | Player "<NAME>" (id=<UID40> pos=<13882.3, 8435.0, 10.8>) performed EmoteSuicide with SteakKnife
```

The UID is present on the line. Do not resolve it from a separate lookup.

**Deliberately NOT captured: position.** The line carries `pos=<…>`, and spec §11 forbids coordinates reaching a public surface. An emote's position is a live player location with no use in this plan, so it is not extracted at all — absent beats "extracted and then not rendered".

- [ ] **Step 1: Write the failing test**

```ts
// packages/adm-parser/test/emote.test.ts
import { describe, it, expect } from "vitest";
import { parseEmote } from "../src/emote.js";

const UID = "A".repeat(40);

describe("parseEmote", () => {
  it("parses a bare emote line", () => {
    const raw = `| 15:24:30 | Player "Steve" (id=${UID} pos=<11201.5, 6703.0, 56.4>) performed EmoteSalute`;
    expect(parseEmote(raw)).toEqual({ gamertag: "Steve", dayzId: UID, emote: "EmoteSalute", item: null });
  });

  it("parses the 'with <item>' variant", () => {
    const raw = `| 18:58:20 | Player "Steve" (id=${UID} pos=<1.0, 2.0, 3.0>) performed EmoteSuicide with SteakKnife`;
    expect(parseEmote(raw)).toEqual({ gamertag: "Steve", dayzId: UID, emote: "EmoteSuicide", item: "SteakKnife" });
  });

  it("handles the (DEAD) identity variant", () => {
    const raw = `| 15:24:30 | Player "Steve" (DEAD) (id=${UID} pos=<1.0, 2.0, 3.0>) performed EmoteClap`;
    expect(parseEmote(raw)?.dayzId).toBe(UID);
  });

  it("handles a gamertag containing spaces and punctuation", () => {
    const raw = `| 15:24:30 | Player "Big Bad (Wolf)" (id=${UID} pos=<1.0, 2.0, 3.0>) performed EmoteDance`;
    const out = parseEmote(raw);
    expect(out?.gamertag).toBe("Big Bad (Wolf)");
    expect(out?.emote).toBe("EmoteDance");
  });

  it("does not capture the player position", () => {
    const raw = `| 15:24:30 | Player "Steve" (id=${UID} pos=<11201.5, 6703.0, 56.4>) performed EmoteSalute`;
    expect(JSON.stringify(parseEmote(raw))).not.toContain("11201");
  });

  it("returns null for a line with no identity", () => {
    expect(parseEmote("| 15:24:30 | performed EmoteSalute")).toBeNull();
  });

  it("returns null for a non-emote line", () => {
    const raw = `| 15:24:30 | Player "Steve" (id=${UID} pos=<1.0, 2.0, 3.0>) has raised Flag_White on TerritoryFlag at <1.0, 2.0, 3.0>`;
    expect(parseEmote(raw)).toBeNull();
  });

  it("returns null for an empty line", () => {
    expect(parseEmote("")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @factions/adm-parser test emote`
Expected: FAIL — `Cannot find module '../src/emote.js'`

- [ ] **Step 3: Write the implementation**

```ts
// packages/adm-parser/src/emote.ts
import { parseIdentity } from "./identity.js";

export type EmotePerformed = {
  gamertag: string;
  dayzId: string;
  emote: string;
  item: string | null;
};

/**
 * `performed EmoteSalute` / `performed EmoteSuicide with SteakKnife`.
 *
 * Anchored at `performed ` rather than reusing the identity prefix, so the
 * `(DEAD)` marker and gamertags containing `)` are handled by parseIdentity
 * — the one place that logic lives.
 */
const EMOTE_RE = /\bperformed (Emote[A-Za-z0-9]+)(?: with (.+?))?\s*$/u;

export function parseEmote(raw: string): EmotePerformed | null {
  const m = EMOTE_RE.exec(raw);
  if (!m) return null;

  const who = parseIdentity(raw);
  // An emote with no identity cannot bind a challenge. Drop it rather than
  // emit an event whose whole purpose is the UID it does not have.
  if (!who) return null;

  return {
    gamertag: who.gamertag,
    dayzId: who.dayzId,
    emote: m[1]!,
    item: m[2] != null ? m[2].trim() : null,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @factions/adm-parser test emote`
Expected: PASS — 8 tests.

- [ ] **Step 5: Wire into `parseLine` — APPEND ONLY**

In `packages/adm-parser/src/parse-line.ts`:

Add the import, beside the others:

```ts
import { parseEmote, type EmotePerformed } from "./emote.js";
```

Add to the `ParsedLine` union (append at the end of the union):

```ts
  | { kind: "emote"; event: EmotePerformed };
```

Add the branch **at the end of `parseLine`'s chain**, immediately before `return []`:

```ts
  const emote = parseEmote(raw);
  if (emote) return [{ kind: "emote", event: emote }];
```

Add the case to `eventTypeFor`'s switch:

```ts
    case "emote":
      return "emote.performed";
```

⚠️ Do not move the existing branches. `subIndex` is the returned array's index and every branch returns a single-element array, so appending keeps every historical event at `subIndex: 0`. Reordering would not.

- [ ] **Step 6: Add parse-line coverage**

Append to `packages/adm-parser/test/parse-line.test.ts`:

```ts
  it("routes an emote line to the emote branch", () => {
    const raw = `| 15:24:30 | Player "Steve" (id=${"A".repeat(40)} pos=<1.0, 2.0, 3.0>) performed EmoteSalute`;
    const out = parseLine(raw);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("emote");
    expect(eventTypeFor(out[0]!)).toBe("emote.performed");
  });

  it("keeps an emote line at subIndex 0", () => {
    const raw = `| 15:24:30 | Player "Steve" (id=${"A".repeat(40)} pos=<1.0, 2.0, 3.0>) performed EmoteClap`;
    // subIndex is the array index; a single-element array pins it at 0.
    expect(parseLine(raw)).toHaveLength(1);
  });

  it("does not let the PlayerList entry matcher claim an emote line", () => {
    const raw = `| 15:24:30 | Player "Steve" (id=${"A".repeat(40)} pos=<1.0, 2.0, 3.0>) performed EmoteClap`;
    expect(parseLine(raw)[0]?.kind).not.toBe("position");
  });
```

(If `eventTypeFor` is not already imported in that file, add it to the existing import from `../src/parse-line.js`.)

- [ ] **Step 7: Export from the package index**

In `packages/adm-parser/src/index.ts`, add `export * from "./emote.js";` — place it after `./identity.js` to keep the file's dependency-order grouping.

- [ ] **Step 8: Add the ingest payload case**

In `apps/ingest-worker/src/ingest.ts`, add a case to `toPayload`'s switch:

```ts
    case "emote":
      return {
        gamertag: line.event.gamertag,
        dayzId: line.event.dayzId,
        emote: line.event.emote,
        item: line.event.item,
      };
```

TypeScript's exhaustiveness check on the union will flag this if it is missed — the switch has no `default`.

- [ ] **Step 9: Run the full parser + ingest suites and typecheck**

Run: `pnpm --filter @factions/adm-parser test && pnpm --filter @factions/adm-parser typecheck && pnpm --filter @factions/ingest-worker typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/adm-parser/src/emote.ts packages/adm-parser/src/parse-line.ts packages/adm-parser/src/index.ts packages/adm-parser/test/emote.test.ts packages/adm-parser/test/parse-line.test.ts apps/ingest-worker/src/ingest.ts
git commit -m "feat(adm-parser): parse performed-emote lines into emote.performed events"
```

---

### Task 3: `@factions/verification` — pure sequence generation and matching

**Files:**
- Create: `packages/verification/package.json`
- Create: `packages/verification/tsconfig.json`
- Create: `packages/verification/src/sequence.ts`
- Create: `packages/verification/src/match.ts`
- Create: `packages/verification/src/index.ts`
- Test: `packages/verification/test/sequence.test.ts`
- Test: `packages/verification/test/match.test.ts`

**Interfaces:**
- Consumes: `safeVerificationEmotes()` from `@factions/domain`.
- Produces: `generateSequence(rng: () => number, length?: number): string[]`, `isExpired(challenge: { expiresAt: Date }, now: Date): boolean`, `advance(sequence: string[], progressIndex: number, emoteToken: string): { index: number; complete: boolean }`.

`rng` is injected so sequence generation is deterministic under test. No database, no Discord, no clock of its own — `now` is always a parameter.

- [ ] **Step 1: Create the package manifest**

```json
{
  "name": "@factions/verification",
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@factions/domain": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

```json
// packages/verification/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": ".", "noEmit": true },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

(Match the exact shape of `packages/domain/tsconfig.json` if it differs — the repo's existing file is the authority.)

- [ ] **Step 2: Write the failing tests**

```ts
// packages/verification/test/sequence.test.ts
import { describe, it, expect } from "vitest";
import { generateSequence, isExpired } from "../src/sequence.js";
import { safeVerificationEmotes } from "@factions/domain";

/** Deterministic rng cycling through fixed values. */
function seeded(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe("generateSequence", () => {
  it("returns the requested length", () => {
    expect(generateSequence(seeded([0, 0, 0]), 3)).toHaveLength(3);
  });

  it("defaults to length 3", () => {
    expect(generateSequence(seeded([0, 0, 0]))).toHaveLength(3);
  });

  it("never repeats an emote within a sequence", () => {
    for (let i = 0; i < 200; i++) {
      const seq = generateSequence(Math.random);
      expect(new Set(seq).size).toBe(seq.length);
    }
  });

  it("draws only from the safe pool", () => {
    const safe = new Set(safeVerificationEmotes().map((e) => e.token));
    for (let i = 0; i < 200; i++) {
      for (const token of generateSequence(Math.random)) expect(safe.has(token)).toBe(true);
    }
  });

  it("is deterministic for a given rng", () => {
    expect(generateSequence(seeded([0, 0, 0]), 3)).toEqual(generateSequence(seeded([0, 0, 0]), 3));
  });

  it("caps at the pool size rather than looping forever", () => {
    const poolSize = safeVerificationEmotes().length;
    expect(generateSequence(Math.random, poolSize + 5)).toHaveLength(poolSize);
  });
});

describe("isExpired", () => {
  it("is false before the expiry instant", () => {
    expect(isExpired({ expiresAt: new Date(1_000) }, new Date(999))).toBe(false);
  });

  it("is false exactly at the expiry instant", () => {
    expect(isExpired({ expiresAt: new Date(1_000) }, new Date(1_000))).toBe(false);
  });

  it("is true after the expiry instant", () => {
    expect(isExpired({ expiresAt: new Date(1_000) }, new Date(1_001))).toBe(true);
  });
});
```

```ts
// packages/verification/test/match.test.ts
import { describe, it, expect } from "vitest";
import { advance } from "../src/match.js";

const SEQ = ["EmoteSalute", "EmoteClap", "EmoteDance"];

describe("advance", () => {
  it("advances on the expected token", () => {
    expect(advance(SEQ, 0, "EmoteSalute")).toEqual({ index: 1, complete: false });
  });

  it("holds on an unexpected token instead of resetting", () => {
    expect(advance(SEQ, 1, "EmoteShrug")).toEqual({ index: 1, complete: false });
  });

  it("holds when the token is a LATER member of the sequence", () => {
    // Order is the proof. Performing step 3 while step 2 is pending must not skip ahead.
    expect(advance(SEQ, 1, "EmoteDance")).toEqual({ index: 1, complete: false });
  });

  it("completes on the final token", () => {
    expect(advance(SEQ, 2, "EmoteDance")).toEqual({ index: 3, complete: true });
  });

  it("stays complete-safe past the end", () => {
    expect(advance(SEQ, 3, "EmoteDance")).toEqual({ index: 3, complete: true });
  });

  it("never completes an empty sequence by accident", () => {
    expect(advance([], 0, "EmoteDance")).toEqual({ index: 0, complete: true });
  });
});
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `pnpm install && pnpm --filter @factions/verification test`
Expected: FAIL — modules not found.

- [ ] **Step 4: Write the implementation**

```ts
// packages/verification/src/sequence.ts
import { safeVerificationEmotes } from "@factions/domain";

/**
 * Draw `length` DISTINCT safe emote tokens in a random order.
 *
 * `rng` is injected rather than calling Math.random directly so a test can pin
 * the sequence. Distinctness matters: a sequence with a repeated token is
 * ambiguous to a player watching their own emote wheel, and shortens the
 * effective search space.
 */
export function generateSequence(rng: () => number, length = 3): string[] {
  const avail = safeVerificationEmotes().map((e) => e.token);
  const chosen: string[] = [];
  for (let i = 0; i < length && avail.length > 0; i++) {
    const j = Math.floor(rng() * avail.length);
    chosen.push(avail.splice(j, 1)[0]!);
  }
  return chosen;
}

/** Strictly after — a challenge is still live at its expiry instant. */
export function isExpired(challenge: { expiresAt: Date }, now: Date): boolean {
  return now.getTime() > challenge.expiresAt.getTime();
}
```

```ts
// packages/verification/src/match.ts
/**
 * One in-order subsequence step.
 *
 * A matching token at the current index advances progress; ANY other token is
 * ignored and progress holds. Holding rather than resetting is deliberate: a
 * player who fat-fingers the emote wheel should not have to start over, and a
 * reset-on-mismatch rule would make the flow nearly impossible in a busy area
 * where the player's own idle animations fire.
 *
 * Order is what the sequence proves, so a token that appears LATER in the
 * sequence does not skip ahead — it is simply not the expected token.
 */
export function advance(
  sequence: string[],
  progressIndex: number,
  emoteToken: string,
): { index: number; complete: boolean } {
  const index =
    progressIndex < sequence.length && sequence[progressIndex] === emoteToken
      ? progressIndex + 1
      : progressIndex;
  return { index, complete: index >= sequence.length };
}
```

```ts
// packages/verification/src/index.ts
export { generateSequence, isExpired } from "./sequence.js";
export { advance } from "./match.js";
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm --filter @factions/verification test && pnpm --filter @factions/verification typecheck`
Expected: PASS — 15 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/verification pnpm-lock.yaml
git commit -m "feat(verification): pure emote-sequence generation and in-order matching"
```

---

### Task 4: Identity schema

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/migrations/0002_*.sql` (generated)
- Test: `packages/db/test/identity.test.ts`

**Interfaces:**
- Produces: Drizzle tables `identityLinks`, `verificationChallenges`, `challengeAttempts` exported from `@factions/db`.

Three tables, and the split matters:

- `identity_links` holds **only verified bindings**. There is no `status` column — a pending link is a live challenge, and modelling "pending" as a link row invites reads that treat unverified rows as identity.
- `verification_challenges` is one issued sequence for one Discord account.
- `challenge_attempts` is per-`(challenge, dayz_id)` progress. See the correctness note at the top of this plan: a single global `progressIndex` lets several players jointly complete one challenge.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/test/identity.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  identityLinks, verificationChallenges, challengeAttempts, type Database,
} from "../src/index.js";
import { sql } from "drizzle-orm";

const URL = requireTestDatabaseUrl();
const UID_A = "A".repeat(40);
const UID_B = "B".repeat(40);

describe("identity schema", () => {
  let db: Database;

  beforeAll(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table challenge_attempts, verification_challenges, identity_links restart identity cascade`);
  });

  it("stores a verified link", async () => {
    const [row] = await db.insert(identityLinks).values({
      discordId: "100", dayzId: UID_A, gamertag: "Steve", verifiedAt: new Date(),
    }).returning();
    expect(row?.id).toBeGreaterThan(0);
  });

  it("allows only one link per Discord account", async () => {
    await expect(db.insert(identityLinks).values({
      discordId: "100", dayzId: UID_B, gamertag: "Other", verifiedAt: new Date(),
    })).rejects.toThrow();
  });

  it("allows only one link per DayZ UID", async () => {
    await expect(db.insert(identityLinks).values({
      discordId: "999", dayzId: UID_A, gamertag: "Steve", verifiedAt: new Date(),
    })).rejects.toThrow();
  });

  it("stores a challenge with its sequence as an array", async () => {
    const [row] = await db.insert(verificationChallenges).values({
      discordId: "200", guildId: "g1", channelId: "c1",
      sequence: ["EmoteSalute", "EmoteClap", "EmoteDance"],
      issuedAt: new Date(), expiresAt: new Date(Date.now() + 600_000),
    }).returning();
    expect(row?.sequence).toEqual(["EmoteSalute", "EmoteClap", "EmoteDance"]);
    expect(row?.completedAt).toBeNull();
  });

  it("tracks progress per (challenge, dayz_id)", async () => {
    const [c] = await db.insert(verificationChallenges).values({
      discordId: "300", guildId: "g1", channelId: "c1",
      sequence: ["EmoteSalute"], issuedAt: new Date(), expiresAt: new Date(Date.now() + 600_000),
    }).returning();

    await db.insert(challengeAttempts).values({ challengeId: c!.id, dayzId: UID_A, progressIndex: 1 });
    // A DIFFERENT UID attempting the same challenge is a separate row, not a conflict.
    const [second] = await db.insert(challengeAttempts)
      .values({ challengeId: c!.id, dayzId: UID_B, progressIndex: 0 }).returning();
    expect(second?.id).toBeGreaterThan(0);

    // The same UID twice on one challenge is a conflict.
    await expect(db.insert(challengeAttempts)
      .values({ challengeId: c!.id, dayzId: UID_A, progressIndex: 0 })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `docker compose up -d postgres && export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm --filter @factions/db test identity`
Expected: FAIL — `identityLinks` is not exported.

- [ ] **Step 3: Add the tables**

Append to `packages/db/src/schema.ts` (the `sql` import is needed for the array default; add `import { sql } from "drizzle-orm";` at the top if absent):

```ts
// ── Identity (spec §16). Discord snowflake ↔ DayZ UID. ──

/**
 * A VERIFIED binding only. There is deliberately no `status` column: an
 * unverified claim is a live row in `verification_challenges`, not a link.
 * Modelling "pending" here would put rows in the identity table that every
 * downstream read has to remember to filter, and the one that forgets grants
 * a faction role to an unproven account.
 *
 * ⚠️ `dayzId` is the identity. `gamertag` is a display label captured at
 * verification time — players rename, and a roster keyed on names breaks the
 * moment they do (spec §16, "Divergence from one-life").
 */
export const identityLinks = pgTable("identity_links", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  discordId: text("discord_id").notNull(),
  dayzId: text("dayz_id").notNull(),
  gamertag: text("gamertag").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqDiscord: uniqueIndex("identity_links_discord_uniq").on(t.discordId),
  uniqDayz: uniqueIndex("identity_links_dayz_uniq").on(t.dayzId),
}));

/** One issued emote sequence for one Discord account. */
export const verificationChallenges = pgTable("verification_challenges", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  discordId: text("discord_id").notNull(),
  guildId: text("guild_id").notNull(),
  /** Where `/link` was run — the fallback reply target when a DM is closed. */
  channelId: text("channel_id").notNull(),
  sequence: text("sequence").array().notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  canceledAt: timestamp("canceled_at", { withTimezone: true }),
  /** Set when the challenge completed; the UID that won it. */
  boundDayzId: text("bound_dayz_id"),
  /** Set once the player has been told. Keeps the notifier idempotent. */
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
}, (t) => ({
  byDiscord: index("verification_challenges_discord_idx").on(t.discordId),
  byLive: index("verification_challenges_live_idx").on(t.expiresAt),
}));

/**
 * Per-UID progress through one challenge.
 *
 * ⚠️ Progress is keyed on (challenge, dayz_id), NOT stored on the challenge.
 * Factions does not know the target UID when it issues a sequence — that is
 * the whole point of §16 — so a single progressIndex on the challenge would
 * let three different players each contribute one emote and jointly complete
 * it, binding whichever UID happened to fire last. Any UID may attempt; the
 * first to complete the full ordered sequence wins.
 *
 * `lastMatchedEventId` makes the tick replay-safe: re-reading an event that
 * already advanced this attempt must not advance it twice.
 */
export const challengeAttempts = pgTable("challenge_attempts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  challengeId: bigint("challenge_id", { mode: "number" }).notNull().references(() => verificationChallenges.id),
  dayzId: text("dayz_id").notNull(),
  progressIndex: integer("progress_index").notNull().default(0),
  lastMatchedEventId: bigint("last_matched_event_id", { mode: "number" }).notNull().default(0),
}, (t) => ({
  uniqAttempt: uniqueIndex("challenge_attempts_challenge_dayz_uniq").on(t.challengeId, t.dayzId),
}));
```

- [ ] **Step 4: Generate and apply the migration**

Run:
```bash
pnpm --filter @factions/db generate
DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/db exec tsx -e "import {createClient,runMigrations} from './src/index.js'; await runMigrations(createClient(process.env.DATABASE_URL!)); process.exit(0)"
```
Expected: a new `migrations/0002_*.sql` creating exactly three tables and their indexes — **no drops or alters of the seven Plan 1 tables.** Read the generated SQL and confirm this before continuing. If it contains a `DROP` or an `ALTER` of an existing table, stop: the schema file has drifted from the applied migrations and that must be resolved first.

- [ ] **Step 5: Run the test**

Run: `pnpm --filter @factions/db test`
Expected: PASS — the existing schema suite plus 5 new tests.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations packages/db/test/identity.test.ts
git commit -m "feat(db): identity links, verification challenges, per-UID attempts"
```

---

### Task 5: `readEventBatch`

**Files:**
- Modify: `packages/event-log/src/cursor.ts`
- Test: `packages/event-log/test/cursor.test.ts` (create if absent)

**Interfaces:**
- Produces: `readEventBatch(db: Database, afterId: number, limit: number): Promise<EventRow[]>` where `EventRow` is the inferred select type of the `events` table.

The projector inlines this query in `apps/projector/src/run.ts`. The bot needs the same thing, and a second inlined copy is where the two consumers drift. Extract it; leave the projector alone in this task (its inlined form is under review in PR #1, and changing it here would widen this plan's diff into Plan 1's).

- [ ] **Step 1: Write the failing test**

```ts
// packages/event-log/test/cursor.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { appendEvent } from "../src/append.js";
import { readEventBatch } from "../src/cursor.js";

const URL = requireTestDatabaseUrl();

describe("readEventBatch", () => {
  let db: Database;
  let serverId = 0;
  let admFileId = 0;

  beforeAll(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: new Date() }).returning();
    admFileId = f!.id;
    for (let i = 0; i < 5; i++) {
      await appendEvent(db, {
        serverId, admFileId, lineIndex: i, subIndex: 0,
        type: "emote.performed", occurredAt: new Date(), payload: { i },
      });
    }
  });

  it("returns events after the cursor in id order", async () => {
    const batch = await readEventBatch(db, 0, 10);
    expect(batch).toHaveLength(5);
    expect(batch.map((r) => r.id)).toEqual([...batch.map((r) => r.id)].sort((a, b) => a - b));
  });

  it("excludes the cursor event itself", async () => {
    const all = await readEventBatch(db, 0, 10);
    const batch = await readEventBatch(db, all[0]!.id, 10);
    expect(batch).toHaveLength(4);
  });

  it("respects the limit", async () => {
    expect(await readEventBatch(db, 0, 2)).toHaveLength(2);
  });

  it("returns an empty array past the end", async () => {
    const all = await readEventBatch(db, 0, 10);
    expect(await readEventBatch(db, all[4]!.id, 10)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @factions/event-log test`
Expected: FAIL — `readEventBatch` is not exported.

- [ ] **Step 3: Write the implementation**

Add to `packages/event-log/src/cursor.ts`:

```ts
import { events } from "@factions/db";
import { asc, gt } from "drizzle-orm";

export type EventRow = typeof events.$inferSelect;

/** Events strictly after `afterId`, in id order. Id order IS causal order here. */
export async function readEventBatch(db: Database, afterId: number, limit: number): Promise<EventRow[]> {
  return db.select().from(events).where(gt(events.id, afterId)).orderBy(asc(events.id)).limit(limit);
}
```

(Merge the imports with the file's existing `import { consumerCursors } from "@factions/db";` and `import { eq } from "drizzle-orm";` rather than adding duplicate import statements.)

- [ ] **Step 4: Add `@factions/db` to the test devDependencies if needed**

`packages/event-log/package.json` already depends on `@factions/db`. Confirm; add nothing if present.

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm --filter @factions/event-log test && pnpm --filter @factions/event-log typecheck`
Expected: PASS — the existing append suite plus 4 new tests.

- [ ] **Step 6: Commit**

```bash
git add packages/event-log/src/cursor.ts packages/event-log/test/cursor.test.ts
git commit -m "feat(event-log): extract readEventBatch for event-log consumers"
```

---

### Task 6: Bot config

**Files:**
- Create: `apps/bot/package.json`
- Create: `apps/bot/tsconfig.json`
- Create: `apps/bot/src/config.ts`
- Test: `apps/bot/test/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): BotConfig`, `type BotConfig = { token: string; applicationId: string; guildId: string; databaseUrl: string; tickIntervalMs: number; challengeTtlMs: number }`.

`loadConfig` takes the environment as an argument rather than reading `process.env` — a config module that reaches for globals cannot be tested for its failure paths, which are the paths that matter.

**It throws on a missing required value.** Plan 1 established why: a config that silently defaults produces a running process that does the wrong thing quietly. A bot with no token cannot connect, and saying so at startup beats an unexplained gateway error.

- [ ] **Step 1: Write the failing test**

```ts
// apps/bot/test/config.test.ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const OK = {
  DISCORD_TOKEN: "t", DISCORD_APPLICATION_ID: "a", DISCORD_GUILD_ID: "g",
  DATABASE_URL: "postgres://x",
};

describe("loadConfig", () => {
  it("reads a complete environment", () => {
    const cfg = loadConfig(OK);
    expect(cfg).toMatchObject({ token: "t", applicationId: "a", guildId: "g", databaseUrl: "postgres://x" });
  });

  it("defaults the tick interval and challenge TTL", () => {
    const cfg = loadConfig(OK);
    expect(cfg.tickIntervalMs).toBe(10_000);
    expect(cfg.challengeTtlMs).toBe(600_000);
  });

  it.each(["DISCORD_TOKEN", "DISCORD_APPLICATION_ID", "DISCORD_GUILD_ID", "DATABASE_URL"])(
    "throws when %s is missing", (key) => {
      const env = { ...OK, [key]: undefined };
      expect(() => loadConfig(env)).toThrow(key);
    },
  );

  it("rejects a non-numeric tick interval instead of silently defaulting", () => {
    expect(() => loadConfig({ ...OK, BOT_TICK_INTERVAL_MS: "soon" })).toThrow(/BOT_TICK_INTERVAL_MS/);
  });

  it("rejects a zero or negative tick interval", () => {
    expect(() => loadConfig({ ...OK, BOT_TICK_INTERVAL_MS: "0" })).toThrow(/BOT_TICK_INTERVAL_MS/);
  });

  it("accepts an overridden challenge TTL", () => {
    expect(loadConfig({ ...OK, BOT_CHALLENGE_TTL_MS: "300000" }).challengeTtlMs).toBe(300_000);
  });
});
```

- [ ] **Step 2: Create the manifests**

```json
// apps/bot/package.json
{
  "name": "@factions/bot",
  "version": "0.0.0",
  "type": "module",
  "main": "src/main.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "start": "tsx src/main.ts"
  },
  "dependencies": {
    "@factions/db": "workspace:*",
    "@factions/domain": "workspace:*",
    "@factions/event-log": "workspace:*",
    "@factions/verification": "workspace:*",
    "discord.js": "^14.16.0",
    "drizzle-orm": "^0.36.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`apps/bot/tsconfig.json` — copy `apps/projector/tsconfig.json` verbatim.

- [ ] **Step 3: Run the test to make sure it fails**

Run: `pnpm install && pnpm --filter @factions/bot test`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the implementation**

```ts
// apps/bot/src/config.ts
export type BotConfig = {
  token: string;
  applicationId: string;
  guildId: string;
  databaseUrl: string;
  tickIntervalMs: number;
  challengeTtlMs: number;
};

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`${key} is not set. The bot cannot start without it.`);
  return v;
}

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  // A silently-defaulted interval is a bot that looks configured and is not.
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${key} must be a positive integer, got ${JSON.stringify(raw)}.`);
  }
  return n;
}

/** Env in, config out. Takes the environment as an argument so failure paths are testable. */
export function loadConfig(env: NodeJS.ProcessEnv): BotConfig {
  return {
    token: required(env, "DISCORD_TOKEN"),
    applicationId: required(env, "DISCORD_APPLICATION_ID"),
    guildId: required(env, "DISCORD_GUILD_ID"),
    databaseUrl: required(env, "DATABASE_URL"),
    tickIntervalMs: positiveInt(env, "BOT_TICK_INTERVAL_MS", 10_000),
    challengeTtlMs: positiveInt(env, "BOT_CHALLENGE_TTL_MS", 600_000),
  };
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm --filter @factions/bot test && pnpm --filter @factions/bot typecheck`
Expected: PASS — 9 tests (the `it.each` expands to 4).

- [ ] **Step 6: Commit**

```bash
git add apps/bot pnpm-lock.yaml
git commit -m "feat(bot): scaffold the bot app with a fail-loud config loader"
```

---

### Task 7: `PgVerificationStore`

**Files:**
- Create: `apps/bot/src/store.ts`
- Test: `apps/bot/test/store.test.ts`

**Interfaces:**
- Consumes: `identityLinks`, `verificationChallenges`, `challengeAttempts` from `@factions/db`.
- Produces:

```ts
export type LiveChallenge = {
  id: number; discordId: string; guildId: string; channelId: string;
  sequence: string[]; expiresAt: Date;
};
export type Attempt = { id: number; progressIndex: number; lastMatchedEventId: number };

export interface VerificationStore {
  findLinkByDiscord(discordId: string): Promise<{ dayzId: string; gamertag: string; verifiedAt: Date } | null>;
  findLinkByDayzId(dayzId: string): Promise<{ discordId: string } | null>;
  deleteLinkByDiscord(discordId: string): Promise<boolean>;
  findLiveChallenge(discordId: string, now: Date): Promise<LiveChallenge | null>;
  liveChallenges(now: Date): Promise<LiveChallenge[]>;
  outstandingSequences(now: Date): Promise<string[][]>;
  createChallenge(input: { discordId: string; guildId: string; channelId: string; sequence: string[]; issuedAt: Date; expiresAt: Date }): Promise<LiveChallenge>;
  getAttempt(challengeId: number, dayzId: string): Promise<Attempt | null>;
  upsertAttempt(challengeId: number, dayzId: string, progressIndex: number, lastMatchedEventId: number): Promise<void>;
  completeChallenge(challengeId: number, dayzId: string, gamertag: string, at: Date): Promise<boolean>;
  pendingNotifications(): Promise<Array<LiveChallenge & { boundDayzId: string }>>;
  markNotified(challengeId: number, at: Date): Promise<void>;
}

export class PgVerificationStore implements VerificationStore { /* … */ }
```

`completeChallenge` returns `false` when the UID is already linked to someone else — the losing side of the race, not an error. It performs the link insert and the challenge update in one transaction so a crash between them cannot leave a challenge marked complete with no link.

- [ ] **Step 1: Write the failing test**

```ts
// apps/bot/test/store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { PgVerificationStore } from "../src/store.js";

const URL = requireTestDatabaseUrl();
const UID_A = "A".repeat(40);
const UID_B = "B".repeat(40);
const SEQ = ["EmoteSalute", "EmoteClap", "EmoteDance"];

describe("PgVerificationStore", () => {
  let db: Database;
  let store: PgVerificationStore;
  const now = new Date("2026-08-26T12:00:00Z");
  const later = new Date("2026-08-26T12:10:00Z");

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table challenge_attempts, verification_challenges, identity_links restart identity cascade`);
    store = new PgVerificationStore(db);
  });

  const issue = (discordId = "100") => store.createChallenge({
    discordId, guildId: "g", channelId: "c", sequence: SEQ, issuedAt: now, expiresAt: later,
  });

  it("finds no link for an unknown Discord account", async () => {
    expect(await store.findLinkByDiscord("nobody")).toBeNull();
  });

  it("creates and finds a live challenge", async () => {
    const c = await issue();
    expect(await store.findLiveChallenge("100", now)).toMatchObject({ id: c.id, sequence: SEQ });
  });

  it("does not return an expired challenge as live", async () => {
    await issue();
    expect(await store.findLiveChallenge("100", new Date("2026-08-26T12:11:00Z"))).toBeNull();
  });

  it("lists outstanding sequences so issuance can avoid collisions", async () => {
    await issue();
    expect(await store.outstandingSequences(now)).toEqual([SEQ]);
  });

  it("upserts per-UID attempt progress", async () => {
    const c = await issue();
    await store.upsertAttempt(c.id, UID_A, 1, 10);
    expect(await store.getAttempt(c.id, UID_A)).toMatchObject({ progressIndex: 1, lastMatchedEventId: 10 });
    await store.upsertAttempt(c.id, UID_A, 2, 11);
    expect(await store.getAttempt(c.id, UID_A)).toMatchObject({ progressIndex: 2, lastMatchedEventId: 11 });
  });

  it("keeps two UIDs' progress on one challenge independent", async () => {
    const c = await issue();
    await store.upsertAttempt(c.id, UID_A, 2, 10);
    await store.upsertAttempt(c.id, UID_B, 0, 11);
    expect((await store.getAttempt(c.id, UID_A))?.progressIndex).toBe(2);
    expect((await store.getAttempt(c.id, UID_B))?.progressIndex).toBe(0);
  });

  it("completes a challenge and writes the link", async () => {
    const c = await issue();
    expect(await store.completeChallenge(c.id, UID_A, "Steve", later)).toBe(true);
    expect(await store.findLinkByDiscord("100")).toMatchObject({ dayzId: UID_A, gamertag: "Steve" });
    expect(await store.findLiveChallenge("100", now)).toBeNull();
  });

  it("refuses to complete when the UID already belongs to someone else", async () => {
    const first = await issue("100");
    await store.completeChallenge(first.id, UID_A, "Steve", later);
    const second = await store.createChallenge({
      discordId: "200", guildId: "g", channelId: "c", sequence: SEQ, issuedAt: now, expiresAt: later,
    });
    expect(await store.completeChallenge(second.id, UID_A, "Steve", later)).toBe(false);
    expect(await store.findLinkByDiscord("200")).toBeNull();
  });

  it("deletes a link and reports whether one existed", async () => {
    const c = await issue();
    await store.completeChallenge(c.id, UID_A, "Steve", later);
    expect(await store.deleteLinkByDiscord("100")).toBe(true);
    expect(await store.deleteLinkByDiscord("100")).toBe(false);
  });

  it("surfaces completed challenges awaiting notification exactly once", async () => {
    const c = await issue();
    await store.completeChallenge(c.id, UID_A, "Steve", later);
    const pending = await store.pendingNotifications();
    expect(pending.map((p) => p.id)).toEqual([c.id]);
    await store.markNotified(c.id, later);
    expect(await store.pendingNotifications()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @factions/bot test store`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/bot/src/store.ts
import type { Database } from "@factions/db";
import { identityLinks, verificationChallenges, challengeAttempts } from "@factions/db";
import { and, eq, gte, isNull, isNotNull, sql } from "drizzle-orm";

export type LiveChallenge = {
  id: number; discordId: string; guildId: string; channelId: string;
  sequence: string[]; expiresAt: Date;
};
export type Attempt = { id: number; progressIndex: number; lastMatchedEventId: number };

export interface VerificationStore {
  findLinkByDiscord(discordId: string): Promise<{ dayzId: string; gamertag: string; verifiedAt: Date } | null>;
  findLinkByDayzId(dayzId: string): Promise<{ discordId: string } | null>;
  deleteLinkByDiscord(discordId: string): Promise<boolean>;
  findLiveChallenge(discordId: string, now: Date): Promise<LiveChallenge | null>;
  liveChallenges(now: Date): Promise<LiveChallenge[]>;
  outstandingSequences(now: Date): Promise<string[][]>;
  createChallenge(input: { discordId: string; guildId: string; channelId: string; sequence: string[]; issuedAt: Date; expiresAt: Date }): Promise<LiveChallenge>;
  getAttempt(challengeId: number, dayzId: string): Promise<Attempt | null>;
  upsertAttempt(challengeId: number, dayzId: string, progressIndex: number, lastMatchedEventId: number): Promise<void>;
  completeChallenge(challengeId: number, dayzId: string, gamertag: string, at: Date): Promise<boolean>;
  pendingNotifications(): Promise<Array<LiveChallenge & { boundDayzId: string }>>;
  markNotified(challengeId: number, at: Date): Promise<void>;
}

/** A challenge is live when it is neither completed nor canceled and has not expired. */
const liveWhere = (now: Date) => and(
  isNull(verificationChallenges.completedAt),
  isNull(verificationChallenges.canceledAt),
  gte(verificationChallenges.expiresAt, now),
);

export class PgVerificationStore implements VerificationStore {
  constructor(private readonly db: Database) {}

  async findLinkByDiscord(discordId: string) {
    const [row] = await this.db.select().from(identityLinks).where(eq(identityLinks.discordId, discordId));
    return row ? { dayzId: row.dayzId, gamertag: row.gamertag, verifiedAt: row.verifiedAt } : null;
  }

  async findLinkByDayzId(dayzId: string) {
    const [row] = await this.db.select().from(identityLinks).where(eq(identityLinks.dayzId, dayzId));
    return row ? { discordId: row.discordId } : null;
  }

  async deleteLinkByDiscord(discordId: string): Promise<boolean> {
    const rows = await this.db.delete(identityLinks).where(eq(identityLinks.discordId, discordId)).returning();
    return rows.length > 0;
  }

  async findLiveChallenge(discordId: string, now: Date): Promise<LiveChallenge | null> {
    const [row] = await this.db.select().from(verificationChallenges)
      .where(and(eq(verificationChallenges.discordId, discordId), liveWhere(now)));
    return row ? toLive(row) : null;
  }

  async liveChallenges(now: Date): Promise<LiveChallenge[]> {
    const rows = await this.db.select().from(verificationChallenges).where(liveWhere(now));
    return rows.map(toLive);
  }

  async outstandingSequences(now: Date): Promise<string[][]> {
    return (await this.liveChallenges(now)).map((c) => c.sequence);
  }

  async createChallenge(input: {
    discordId: string; guildId: string; channelId: string;
    sequence: string[]; issuedAt: Date; expiresAt: Date;
  }): Promise<LiveChallenge> {
    const [row] = await this.db.insert(verificationChallenges).values(input).returning();
    return toLive(row!);
  }

  async getAttempt(challengeId: number, dayzId: string): Promise<Attempt | null> {
    const [row] = await this.db.select().from(challengeAttempts)
      .where(and(eq(challengeAttempts.challengeId, challengeId), eq(challengeAttempts.dayzId, dayzId)));
    return row ? { id: row.id, progressIndex: row.progressIndex, lastMatchedEventId: row.lastMatchedEventId } : null;
  }

  async upsertAttempt(challengeId: number, dayzId: string, progressIndex: number, lastMatchedEventId: number): Promise<void> {
    await this.db.insert(challengeAttempts)
      .values({ challengeId, dayzId, progressIndex, lastMatchedEventId })
      .onConflictDoUpdate({
        target: [challengeAttempts.challengeId, challengeAttempts.dayzId],
        set: { progressIndex, lastMatchedEventId },
      });
  }

  /**
   * Bind the UID and close the challenge, atomically.
   *
   * Returns false when the UID is already linked to a different Discord
   * account — the losing side of a race, not an error. The challenge is
   * canceled in that case so the player is not left waiting on a sequence
   * that can never bind.
   */
  async completeChallenge(challengeId: number, dayzId: string, gamertag: string, at: Date): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [taken] = await tx.select().from(identityLinks).where(eq(identityLinks.dayzId, dayzId));
      const [challenge] = await tx.select().from(verificationChallenges)
        .where(eq(verificationChallenges.id, challengeId));
      if (!challenge) return false;

      if (taken && taken.discordId !== challenge.discordId) {
        await tx.update(verificationChallenges)
          .set({ canceledAt: at })
          .where(eq(verificationChallenges.id, challengeId));
        return false;
      }

      await tx.insert(identityLinks)
        .values({ discordId: challenge.discordId, dayzId, gamertag, verifiedAt: at })
        .onConflictDoNothing();
      await tx.update(verificationChallenges)
        .set({ completedAt: at, boundDayzId: dayzId })
        .where(eq(verificationChallenges.id, challengeId));
      return true;
    });
  }

  async pendingNotifications(): Promise<Array<LiveChallenge & { boundDayzId: string }>> {
    const rows = await this.db.select().from(verificationChallenges).where(and(
      isNotNull(verificationChallenges.completedAt),
      isNull(verificationChallenges.notifiedAt),
    ));
    return rows.filter((r) => r.boundDayzId !== null).map((r) => ({ ...toLive(r), boundDayzId: r.boundDayzId! }));
  }

  async markNotified(challengeId: number, at: Date): Promise<void> {
    await this.db.update(verificationChallenges)
      .set({ notifiedAt: at })
      .where(eq(verificationChallenges.id, challengeId));
  }
}

function toLive(row: typeof verificationChallenges.$inferSelect): LiveChallenge {
  return {
    id: row.id, discordId: row.discordId, guildId: row.guildId,
    channelId: row.channelId, sequence: row.sequence, expiresAt: row.expiresAt,
  };
}
```

(`sql` may be unused — drop it from the import if so; the repo runs `noUnusedLocals` off but an unused import is still noise.)

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm --filter @factions/bot test && pnpm --filter @factions/bot typecheck`
Expected: PASS — 10 store tests plus the 9 config tests.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/store.ts apps/bot/test/store.test.ts
git commit -m "feat(bot): Postgres verification store with atomic challenge completion"
```

---

### Task 8: The verification tick

**Files:**
- Create: `apps/bot/src/tick.ts`
- Test: `apps/bot/test/tick.test.ts`

**Interfaces:**
- Consumes: `readCursor`, `writeCursor`, `readEventBatch` from `@factions/event-log`; `advance` from `@factions/verification`; `VerificationStore` from `./store.js`.
- Produces: `verificationTick(db, store, opts): Promise<TickResult>` where `type TickResult = { scanned: number; advanced: number; verified: number; alreadyLinked: number }`, and `export const CONSUMER = "identity-verifier"`.

The tick is free of discord.js. It reads `emote.performed` events after its own cursor, advances the matching attempt for each live challenge, and completes the first one to finish. Notification is a separate concern (Task 10) driven by `pendingNotifications()`.

**Its own cursor.** `CONSUMER = "identity-verifier"` is distinct from the projector's `"pole-projector"`. Two consumers sharing a cursor name would each skip the other's events.

- [ ] **Step 1: Write the failing test**

```ts
// apps/bot/test/tick.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, type Database } from "@factions/db";
import { appendEvent } from "@factions/event-log";
import { sql } from "drizzle-orm";
import { PgVerificationStore } from "../src/store.js";
import { verificationTick, CONSUMER } from "../src/tick.js";

const URL = requireTestDatabaseUrl();
const UID_A = "A".repeat(40);
const UID_B = "B".repeat(40);
const SEQ = ["EmoteSalute", "EmoteClap", "EmoteDance"];

describe("verificationTick", () => {
  let db: Database;
  let store: PgVerificationStore;
  let serverId = 0;
  let admFileId = 0;
  let line = 0;
  const now = new Date("2026-08-26T12:00:00Z");
  const later = new Date("2026-08-26T12:10:00Z");

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table challenge_attempts, verification_challenges, identity_links, consumer_cursors, events, raw_lines, adm_files, servers restart identity cascade`);
    store = new PgVerificationStore(db);
    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now }).returning();
    admFileId = f!.id;
    line = 0;
  });

  const emote = (dayzId: string, token: string, gamertag = "Steve") => appendEvent(db, {
    serverId, admFileId, lineIndex: line++, subIndex: 0,
    type: "emote.performed", occurredAt: now,
    payload: { gamertag, dayzId, emote: token, item: null },
  });

  const issue = (discordId = "100") => store.createChallenge({
    discordId, guildId: "g", channelId: "c", sequence: SEQ, issuedAt: now, expiresAt: later,
  });

  const tick = () => verificationTick(db, store, { batchSize: 100, now });

  it("does nothing with no events", async () => {
    expect(await tick()).toMatchObject({ scanned: 0, verified: 0 });
  });

  it("verifies a UID that performs the full sequence in order", async () => {
    await issue();
    for (const t of SEQ) await emote(UID_A, t);
    const r = await tick();
    expect(r.verified).toBe(1);
    expect(await store.findLinkByDiscord("100")).toMatchObject({ dayzId: UID_A });
  });

  it("does not verify a partial sequence", async () => {
    await issue();
    await emote(UID_A, SEQ[0]!);
    await emote(UID_A, SEQ[1]!);
    expect((await tick()).verified).toBe(0);
    expect(await store.findLinkByDiscord("100")).toBeNull();
  });

  it("does not verify an out-of-order sequence", async () => {
    await issue();
    await emote(UID_A, SEQ[2]!);
    await emote(UID_A, SEQ[1]!);
    await emote(UID_A, SEQ[0]!);
    expect((await tick()).verified).toBe(0);
  });

  it("tolerates unrelated emotes between the steps", async () => {
    await issue();
    await emote(UID_A, SEQ[0]!);
    await emote(UID_A, "EmoteShrug");
    await emote(UID_A, SEQ[1]!);
    await emote(UID_A, "EmoteSitA");
    await emote(UID_A, SEQ[2]!);
    expect((await tick()).verified).toBe(1);
  });

  it("does NOT let two UIDs jointly complete one challenge", async () => {
    await issue();
    await emote(UID_A, SEQ[0]!);
    await emote(UID_B, SEQ[1]!);
    await emote(UID_A, SEQ[2]!);
    expect((await tick()).verified).toBe(0);
    expect(await store.findLinkByDiscord("100")).toBeNull();
  });

  it("ignores an expired challenge", async () => {
    await store.createChallenge({
      discordId: "100", guildId: "g", channelId: "c", sequence: SEQ,
      issuedAt: new Date("2026-08-26T11:00:00Z"), expiresAt: new Date("2026-08-26T11:10:00Z"),
    });
    for (const t of SEQ) await emote(UID_A, t);
    expect((await tick()).verified).toBe(0);
  });

  it("refuses to bind a UID that is already linked elsewhere", async () => {
    const first = await issue("100");
    await store.completeChallenge(first.id, UID_A, "Steve", now);
    await issue("200");
    for (const t of SEQ) await emote(UID_A, t);
    const r = await tick();
    expect(r.alreadyLinked).toBe(1);
    expect(await store.findLinkByDiscord("200")).toBeNull();
  });

  it("advances its own cursor, not the projector's", async () => {
    await issue();
    await emote(UID_A, SEQ[0]!);
    await tick();
    const [row] = await db.select().from((await import("@factions/db")).consumerCursors);
    expect(row?.consumerName).toBe(CONSUMER);
  });

  it("is idempotent across repeated ticks", async () => {
    await issue();
    for (const t of SEQ) await emote(UID_A, t);
    expect((await tick()).verified).toBe(1);
    expect((await tick()).verified).toBe(0);
  });

  it("ignores non-emote events", async () => {
    await issue();
    await appendEvent(db, {
      serverId, admFileId, lineIndex: line++, subIndex: 0,
      type: "player.position", occurredAt: now, payload: { dayzId: UID_A },
    });
    expect((await tick()).scanned).toBe(0);
  });

  it("skips a malformed emote payload rather than throwing", async () => {
    await issue();
    await appendEvent(db, {
      serverId, admFileId, lineIndex: line++, subIndex: 0,
      type: "emote.performed", occurredAt: now, payload: { nonsense: true },
    });
    await expect(tick()).resolves.toMatchObject({ verified: 0 });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @factions/bot test tick`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/bot/src/tick.ts
import type { Database } from "@factions/db";
import { readCursor, writeCursor, readEventBatch } from "@factions/event-log";
import { advance } from "@factions/verification";
import type { VerificationStore } from "./store.js";

/**
 * ⚠️ Distinct from the projector's "pole-projector". Two consumers sharing a
 * cursor name each skip the other's events, and the symptom is "verification
 * randomly doesn't work" rather than an error.
 */
export const CONSUMER = "identity-verifier";

export type TickOpts = { batchSize?: number; now?: Date };

export type TickResult = {
  /** emote.performed events examined. */
  scanned: number;
  /** attempts that moved forward. */
  advanced: number;
  /** challenges completed and bound. */
  verified: number;
  /**
   * Completions refused because the UID already belongs to another Discord
   * account. Counted rather than swallowed: a non-zero value here is either
   * someone re-linking without unlinking, or two people racing one UID.
   */
  alreadyLinked: number;
};

type EmotePayload = { dayzId: string; gamertag: string; emote: string };

function readEmotePayload(payload: unknown): EmotePayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.dayzId !== "string" || typeof p.emote !== "string") return null;
  return {
    dayzId: p.dayzId,
    gamertag: typeof p.gamertag === "string" ? p.gamertag : "",
    emote: p.emote,
  };
}

/** One pass: advance every live challenge against the unread emote events. */
export async function verificationTick(
  db: Database,
  store: VerificationStore,
  opts: TickOpts = {},
): Promise<TickResult> {
  const batchSize = opts.batchSize ?? 500;
  const now = opts.now ?? new Date();
  let cursor = await readCursor(db, CONSUMER);
  const out: TickResult = { scanned: 0, advanced: 0, verified: 0, alreadyLinked: 0 };

  for (;;) {
    const batch = await readEventBatch(db, cursor, batchSize);
    if (batch.length === 0) break;

    for (const ev of batch) {
      cursor = ev.id;
      if (ev.type !== "emote.performed") continue;
      const payload = readEmotePayload(ev.payload);
      // A malformed payload is a parser bug, not a reason to stall the cursor.
      if (!payload) continue;
      out.scanned++;

      // Re-read live challenges per event: a completion inside this loop must
      // not leave a stale challenge in a cached list.
      for (const challenge of await store.liveChallenges(now)) {
        const attempt = await store.getAttempt(challenge.id, payload.dayzId);
        const progressIndex = attempt?.progressIndex ?? 0;
        const lastMatchedEventId = attempt?.lastMatchedEventId ?? 0;
        // Replay guard: an event that already advanced this attempt must not
        // advance it again on a re-read.
        if (ev.id <= lastMatchedEventId) continue;

        const { index, complete } = advance(challenge.sequence, progressIndex, payload.emote);
        if (index === progressIndex) continue; // no forward progress

        await store.upsertAttempt(challenge.id, payload.dayzId, index, ev.id);
        out.advanced++;
        if (!complete) continue;

        const bound = await store.completeChallenge(challenge.id, payload.dayzId, payload.gamertag, now);
        if (bound) out.verified++;
        else out.alreadyLinked++;
      }
    }
    await writeCursor(db, CONSUMER, cursor);
  }

  return out;
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm --filter @factions/bot test && pnpm --filter @factions/bot typecheck`
Expected: PASS — 12 tick tests.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/tick.ts apps/bot/test/tick.test.ts
git commit -m "feat(bot): verification tick binding a UID to a Discord account"
```

---

### Task 9: Command logic

**Files:**
- Create: `apps/bot/src/commands.ts`
- Test: `apps/bot/test/commands.test.ts`

**Interfaces:**
- Consumes: `VerificationStore`, `generateSequence`, `emoteLabel`.
- Produces:

```ts
export type Reply = { content: string; ephemeral: true };
export type CommandDeps = { store: VerificationStore; rng: () => number; now: () => Date; challengeTtlMs: number };
export type LinkContext = { discordId: string; guildId: string; channelId: string };

export function handleLink(deps: CommandDeps, ctx: LinkContext): Promise<Reply>;
export function handleUnlink(deps: CommandDeps, discordId: string): Promise<Reply>;
export function handleWhoami(deps: CommandDeps, discordId: string): Promise<Reply>;
export function formatSequence(sequence: string[]): string;
```

Pure of discord.js: these take a context object and return a reply descriptor, so every branch is unit-testable without a gateway connection. **Every reply is ephemeral** — a challenge sequence posted publicly is a challenge anyone in the channel can perform.

- [ ] **Step 1: Write the failing test**

```ts
// apps/bot/test/commands.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { PgVerificationStore } from "../src/store.js";
import { handleLink, handleUnlink, handleWhoami, formatSequence, type CommandDeps } from "../src/commands.js";

const URL = requireTestDatabaseUrl();
const UID_A = "A".repeat(40);
const CTX = { discordId: "100", guildId: "g", channelId: "c" };

describe("commands", () => {
  let db: Database;
  let store: PgVerificationStore;
  let deps: CommandDeps;
  const now = new Date("2026-08-26T12:00:00Z");

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table challenge_attempts, verification_challenges, identity_links restart identity cascade`);
    store = new PgVerificationStore(db);
    deps = { store, rng: Math.random, now: () => now, challengeTtlMs: 600_000 };
  });

  describe("formatSequence", () => {
    it("renders human labels, numbered, not raw tokens", () => {
      const out = formatSequence(["EmoteSalute", "EmoteClap"]);
      expect(out).toContain("salute");
      expect(out).toContain("clap");
      expect(out).not.toContain("EmoteSalute");
      expect(out).toContain("1.");
      expect(out).toContain("2.");
    });
  });

  describe("handleLink", () => {
    it("issues a challenge and replies ephemerally", async () => {
      const reply = await handleLink(deps, CTX);
      expect(reply.ephemeral).toBe(true);
      expect(await store.findLiveChallenge("100", now)).not.toBeNull();
    });

    it("shows human-readable emote labels, never raw tokens", async () => {
      const reply = await handleLink(deps, CTX);
      expect(reply.content).not.toMatch(/Emote[A-Z]/);
    });

    it("re-shows the existing challenge instead of issuing a second one", async () => {
      const first = await handleLink(deps, CTX);
      const second = await handleLink(deps, CTX);
      expect(second.content).toBe(first.content);
      expect((await store.liveChallenges(now))).toHaveLength(1);
    });

    it("refuses when the account is already linked", async () => {
      const c = await store.createChallenge({ ...CTX, sequence: ["EmoteSalute"], issuedAt: now, expiresAt: new Date(now.getTime() + 1000) });
      await store.completeChallenge(c.id, UID_A, "Steve", now);
      const reply = await handleLink(deps, CTX);
      expect(reply.content).toMatch(/already linked/i);
    });

    it("does not issue a sequence that is already outstanding", async () => {
      // Pin the rng so the naive implementation would collide.
      const fixed: CommandDeps = { ...deps, rng: () => 0 };
      await handleLink(fixed, CTX);
      await handleLink(fixed, { ...CTX, discordId: "200" });
      const seqs = await store.outstandingSequences(now);
      expect(seqs).toHaveLength(2);
      expect(JSON.stringify(seqs[0])).not.toBe(JSON.stringify(seqs[1]));
    });
  });

  describe("handleUnlink", () => {
    it("reports when there was nothing to unlink", async () => {
      expect((await handleUnlink(deps, "100")).content).toMatch(/not linked/i);
    });

    it("removes an existing link", async () => {
      const c = await store.createChallenge({ ...CTX, sequence: ["EmoteSalute"], issuedAt: now, expiresAt: new Date(now.getTime() + 1000) });
      await store.completeChallenge(c.id, UID_A, "Steve", now);
      expect((await handleUnlink(deps, "100")).content).toMatch(/unlinked/i);
      expect(await store.findLinkByDiscord("100")).toBeNull();
    });
  });

  describe("handleWhoami", () => {
    it("reports an unlinked account", async () => {
      expect((await handleWhoami(deps, "100")).content).toMatch(/not linked/i);
    });

    it("reports the linked gamertag", async () => {
      const c = await store.createChallenge({ ...CTX, sequence: ["EmoteSalute"], issuedAt: now, expiresAt: new Date(now.getTime() + 1000) });
      await store.completeChallenge(c.id, UID_A, "Steve", now);
      expect((await handleWhoami(deps, "100")).content).toContain("Steve");
    });

    it("does not print the full UID", async () => {
      const c = await store.createChallenge({ ...CTX, sequence: ["EmoteSalute"], issuedAt: now, expiresAt: new Date(now.getTime() + 1000) });
      await store.completeChallenge(c.id, UID_A, "Steve", now);
      expect((await handleWhoami(deps, "100")).content).not.toContain(UID_A);
    });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @factions/bot test commands`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/bot/src/commands.ts
import { emoteLabel } from "@factions/domain";
import { generateSequence } from "@factions/verification";
import type { VerificationStore } from "./store.js";

/**
 * ⚠️ Every reply is ephemeral. A challenge sequence posted publicly is a
 * challenge anyone reading the channel can perform, which would let a bystander
 * bind their own UID to someone else's Discord account.
 */
export type Reply = { content: string; ephemeral: true };

export type CommandDeps = {
  store: VerificationStore;
  rng: () => number;
  now: () => Date;
  challengeTtlMs: number;
};

export type LinkContext = { discordId: string; guildId: string; channelId: string };

const ephemeral = (content: string): Reply => ({ content, ephemeral: true });

/** Human labels, numbered. Players read an emote wheel, not a token list. */
export function formatSequence(sequence: string[]): string {
  return sequence.map((token, i) => `${i + 1}. **${emoteLabel(token) ?? token}**`).join("\n");
}

function challengeMessage(sequence: string[], expiresAt: Date): string {
  return [
    "**Link your account**",
    "",
    "In game, open the emote wheel and perform these, in this order:",
    "",
    formatSequence(sequence),
    "",
    "Other emotes in between are fine — only the order of these three matters.",
    `Expires <t:${Math.floor(expiresAt.getTime() / 1000)}:R>. Run ` + "`/link`" + ` again to see this message.`,
  ].join("\n");
}

const sameSequence = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

export async function handleLink(deps: CommandDeps, ctx: LinkContext): Promise<Reply> {
  const now = deps.now();

  const existing = await deps.store.findLinkByDiscord(ctx.discordId);
  if (existing) {
    return ephemeral(
      `You are already linked to **${existing.gamertag}**. ` +
      "Run `/unlink` first if you need to bind a different character.",
    );
  }

  // Re-show rather than re-issue: a player who lost the ephemeral reply should
  // not have their in-progress sequence invalidated.
  const live = await deps.store.findLiveChallenge(ctx.discordId, now);
  if (live) return ephemeral(challengeMessage(live.sequence, live.expiresAt));

  // ⚠️ Two live challenges sharing a sequence would both complete on the same
  // emotes, binding the wrong UID to one of them. Redraw on collision.
  const outstanding = await deps.store.outstandingSequences(now);
  let sequence = generateSequence(deps.rng);
  for (let attempt = 0; attempt < 20 && outstanding.some((s) => sameSequence(s, sequence)); attempt++) {
    sequence = generateSequence(Math.random);
  }
  if (outstanding.some((s) => sameSequence(s, sequence))) {
    return ephemeral("Could not issue a unique sequence right now. Try again in a moment.");
  }

  const expiresAt = new Date(now.getTime() + deps.challengeTtlMs);
  const challenge = await deps.store.createChallenge({
    discordId: ctx.discordId, guildId: ctx.guildId, channelId: ctx.channelId,
    sequence, issuedAt: now, expiresAt,
  });
  return ephemeral(challengeMessage(challenge.sequence, challenge.expiresAt));
}

export async function handleUnlink(deps: CommandDeps, discordId: string): Promise<Reply> {
  const removed = await deps.store.deleteLinkByDiscord(discordId);
  return ephemeral(
    removed
      ? "Unlinked. Run `/link` to bind a character again."
      : "You are not linked to a character.",
  );
}

export async function handleWhoami(deps: CommandDeps, discordId: string): Promise<Reply> {
  const link = await deps.store.findLinkByDiscord(discordId);
  if (!link) return ephemeral("You are not linked to a character. Run `/link` to start.");
  return ephemeral(
    `Linked to **${link.gamertag}** ` +
    `(verified <t:${Math.floor(link.verifiedAt.getTime() / 1000)}:D>).`,
  );
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm --filter @factions/bot test && pnpm --filter @factions/bot typecheck`
Expected: PASS — 11 command tests.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/commands.ts apps/bot/test/commands.test.ts
git commit -m "feat(bot): /link, /unlink, /whoami command logic"
```

---

### Task 10: Discord wiring and the notification loop

**Files:**
- Create: `apps/bot/src/discord.ts`
- Create: `apps/bot/src/main.ts`
- Create: `apps/bot/README.md`
- Test: `apps/bot/test/discord.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `buildCommands(): RESTPostAPIApplicationCommandsJSONBody[]`, `routeInteraction(deps, interaction): Promise<Reply | null>`, `notifyCompleted(deps, send): Promise<number>`, `start(cfg): Promise<void>`.

`routeInteraction` takes a minimal structural type, not a discord.js `Interaction`, so it can be tested with a plain object. The discord.js client is confined to `start()`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/bot/test/discord.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { PgVerificationStore } from "../src/store.js";
import { buildCommands, routeInteraction, notifyCompleted } from "../src/discord.js";
import type { CommandDeps } from "../src/commands.js";

const URL = requireTestDatabaseUrl();
const UID_A = "A".repeat(40);

describe("discord wiring", () => {
  let db: Database;
  let store: PgVerificationStore;
  let deps: CommandDeps;
  const now = new Date("2026-08-26T12:00:00Z");

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table challenge_attempts, verification_challenges, identity_links restart identity cascade`);
    store = new PgVerificationStore(db);
    deps = { store, rng: Math.random, now: () => now, challengeTtlMs: 600_000 };
  });

  describe("buildCommands", () => {
    it("declares link, unlink and whoami", () => {
      expect(buildCommands().map((c) => c.name).sort()).toEqual(["link", "unlink", "whoami"]);
    });

    it("gives every command a description", () => {
      for (const c of buildCommands()) expect(c.description?.length).toBeGreaterThan(0);
    });
  });

  describe("routeInteraction", () => {
    const base = { userId: "100", guildId: "g", channelId: "c" };

    it("routes /link", async () => {
      const r = await routeInteraction(deps, { ...base, commandName: "link" });
      expect(r?.ephemeral).toBe(true);
      expect(await store.findLiveChallenge("100", now)).not.toBeNull();
    });

    it("routes /whoami", async () => {
      const r = await routeInteraction(deps, { ...base, commandName: "whoami" });
      expect(r?.content).toMatch(/not linked/i);
    });

    it("routes /unlink", async () => {
      const r = await routeInteraction(deps, { ...base, commandName: "unlink" });
      expect(r?.content).toMatch(/not linked/i);
    });

    it("returns null for an unknown command", async () => {
      expect(await routeInteraction(deps, { ...base, commandName: "nope" })).toBeNull();
    });

    it("refuses a command run outside a guild", async () => {
      const r = await routeInteraction(deps, { ...base, guildId: null, commandName: "link" });
      expect(r?.content).toMatch(/server/i);
      expect(await store.findLiveChallenge("100", now)).toBeNull();
    });
  });

  describe("notifyCompleted", () => {
    const complete = async (discordId: string, uid: string) => {
      const c = await store.createChallenge({
        discordId, guildId: "g", channelId: "c",
        sequence: ["EmoteSalute"], issuedAt: now, expiresAt: new Date(now.getTime() + 1000),
      });
      await store.completeChallenge(c.id, uid, "Steve", now);
    };

    it("sends one message per newly completed challenge", async () => {
      await complete("100", UID_A);
      const send = vi.fn().mockResolvedValue(undefined);
      expect(await notifyCompleted(deps, send)).toBe(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0]).toMatchObject({ discordId: "100" });
    });

    it("does not send twice for the same challenge", async () => {
      await complete("100", UID_A);
      const send = vi.fn().mockResolvedValue(undefined);
      await notifyCompleted(deps, send);
      expect(await notifyCompleted(deps, send)).toBe(0);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("leaves the challenge unnotified when sending throws", async () => {
      await complete("100", UID_A);
      const send = vi.fn().mockRejectedValue(new Error("DMs closed"));
      expect(await notifyCompleted(deps, send)).toBe(0);
      // Still pending, so a later tick retries rather than losing the message.
      const retry = vi.fn().mockResolvedValue(undefined);
      expect(await notifyCompleted(deps, retry)).toBe(1);
    });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @factions/bot test discord`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/bot/src/discord.ts
import {
  Client, GatewayIntentBits, REST, Routes, MessageFlags,
  SlashCommandBuilder, type RESTPostAPIApplicationCommandsJSONBody,
} from "discord.js";
import { createClient } from "@factions/db";
import { handleLink, handleUnlink, handleWhoami, type CommandDeps, type Reply } from "./commands.js";
import { PgVerificationStore } from "./store.js";
import { verificationTick } from "./tick.js";
import type { BotConfig } from "./config.js";

export function buildCommands(): RESTPostAPIApplicationCommandsJSONBody[] {
  return [
    new SlashCommandBuilder().setName("link")
      .setDescription("Bind your Discord account to your in-game character"),
    new SlashCommandBuilder().setName("unlink")
      .setDescription("Remove the binding between your Discord account and your character"),
    new SlashCommandBuilder().setName("whoami")
      .setDescription("Show which character your Discord account is linked to"),
  ].map((c) => c.toJSON());
}

/** The subset of a discord.js interaction the router needs. Kept structural so tests need no client. */
export type InteractionLike = {
  commandName: string;
  userId: string;
  guildId: string | null;
  channelId: string;
};

export async function routeInteraction(deps: CommandDeps, i: InteractionLike): Promise<Reply | null> {
  const known = i.commandName === "link" || i.commandName === "unlink" || i.commandName === "whoami";
  if (!known) return null;

  // Identity is guild-scoped in practice (spec §16) and a DM has no guild to
  // record on the challenge, so refuse rather than write a null guild id.
  if (i.guildId === null) {
    return { content: "Run this in the server, not in a DM.", ephemeral: true };
  }

  const ctx = { discordId: i.userId, guildId: i.guildId, channelId: i.channelId };
  if (i.commandName === "link") return handleLink(deps, ctx);
  if (i.commandName === "unlink") return handleUnlink(deps, i.userId);
  return handleWhoami(deps, i.userId);
}

export type Notification = { discordId: string; channelId: string; content: string };
export type Sender = (n: Notification) => Promise<void>;

/**
 * Tell each newly verified player, exactly once.
 *
 * `markNotified` runs only after `send` resolves. A send that throws — closed
 * DMs, a deleted channel, a rate limit — leaves the row pending so the next
 * pass retries, rather than marking it done and dropping the message.
 */
export async function notifyCompleted(deps: CommandDeps, send: Sender): Promise<number> {
  let sent = 0;
  for (const c of await deps.store.pendingNotifications()) {
    try {
      await send({
        discordId: c.discordId,
        channelId: c.channelId,
        content: "Verified — your Discord account is now linked to your character.",
      });
      await deps.store.markNotified(c.id, deps.now());
      sent++;
    } catch (err) {
      console.error(`notify failed for challenge ${c.id}`, err);
    }
  }
  return sent;
}

export async function start(cfg: BotConfig): Promise<void> {
  const db = createClient(cfg.databaseUrl);
  const store = new PgVerificationStore(db);
  const deps: CommandDeps = {
    store, rng: Math.random, now: () => new Date(), challengeTtlMs: cfg.challengeTtlMs,
  };

  await new REST().setToken(cfg.token).put(
    Routes.applicationGuildCommands(cfg.applicationId, cfg.guildId),
    { body: buildCommands() },
  );

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const reply = await routeInteraction(deps, {
      commandName: interaction.commandName,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
    });
    if (!reply) return;
    await interaction.reply({ content: reply.content, flags: MessageFlags.Ephemeral });
  });

  const send: Sender = async (n) => {
    // DM first; fall back to the channel /link was run in, because a player
    // with closed DMs would otherwise never learn they succeeded.
    try {
      const user = await client.users.fetch(n.discordId);
      await user.send(n.content);
    } catch {
      const channel = await client.channels.fetch(n.channelId);
      if (channel?.isSendable()) await channel.send(`<@${n.discordId}> ${n.content}`);
      else throw new Error(`no reachable surface for ${n.discordId}`);
    }
  };

  client.once("clientReady", () => {
    console.log(`bot ready as ${client.user?.tag}`);
    setInterval(() => {
      void (async () => {
        try {
          const r = await verificationTick(db, store);
          if (r.verified > 0 || r.alreadyLinked > 0) {
            console.log(`verified ${r.verified}, refused ${r.alreadyLinked} (already linked)`);
          }
          await notifyCompleted(deps, send);
        } catch (err) {
          // A thrown tick must not kill the interval and silently stop all verification.
          console.error("tick failed", err);
        }
      })();
    }, cfg.tickIntervalMs);
  });

  await client.login(cfg.token);
}
```

```ts
// apps/bot/src/main.ts
import { loadConfig } from "./config.js";
import { start } from "./discord.js";

await start(loadConfig(process.env));
```

- [ ] **Step 4: Write the README**

`apps/bot/README.md` — cover: the four required env vars, how to create the Discord application and invite the bot with the `applications.commands` and `bot` scopes, that commands are registered per-guild (instant, unlike global registration's propagation delay), and the run command `pnpm --filter @factions/bot start`.

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm --filter @factions/bot test && pnpm --filter @factions/bot typecheck`
Expected: PASS — 10 discord tests.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/discord.ts apps/bot/src/main.ts apps/bot/README.md apps/bot/test/discord.test.ts
git commit -m "feat(bot): discord.js wiring, command registration, tick and notify loop"
```

---

### Task 11: Acceptance against the production export

**Files:**
- Modify: `apps/ingest-worker/src/replay-export.ts` (only if the emote count is not already reported)
- Create: `docs/acceptance/2026-08-26-emote-ingest.md`

**Interfaces:** none — this task produces evidence, not code.

Plan 1's acceptance proved flag events land. This proves emote events do, against the same 69,326-line export, and it is the only check that the Task 2 parser works on real data rather than on test fixtures.

**⚠️ Use a database the test suites do not truncate.** The DB suites truncate the shared database; a backfill followed by a test run reads as a regression when it is only a truncation.

- [ ] **Step 1: Create a dedicated backfill database**

```bash
docker compose up -d postgres
docker compose exec -T postgres psql -U factions -d postgres -c "CREATE DATABASE factions_backfill;" || true
```

- [ ] **Step 2: Migrate and replay the export into it**

```bash
export BACKFILL_URL="postgres://factions:factions@localhost:5434/factions_backfill"
DATABASE_URL="$BACKFILL_URL" pnpm --filter @factions/db exec tsx -e "import {createClient,runMigrations} from './src/index.js'; await runMigrations(createClient(process.env.DATABASE_URL!)); process.exit(0)"
```

Then run the Plan 1 replay entry point against `$BACKFILL_URL` exactly as Plan 1's acceptance did (`apps/ingest-worker/src/replay-main.ts`, with `CLOCK_OFFSET_MS` set as that plan requires — it has no default and the worker refuses to start without it).

- [ ] **Step 3: Verify the counts**

```bash
docker compose exec -T postgres psql -U factions -d factions_backfill -c "select type, count(*) from events group by type order by 2 desc;"
docker compose exec -T postgres psql -U factions -d factions_backfill -c "select payload->>'emote' as emote, count(*) from events where type='emote.performed' group by 1 order by 2 desc;"
```

Expected, and these are the acceptance criteria:

| Check | Expected |
|---|---|
| `emote.performed` events | **2,093** |
| Distinct emote tokens | **35** |
| `EmoteSitA` count | **1,611** |
| Events with a null or missing `dayzId` | **0** |
| Flag event counts | **unchanged from Plan 1** — 14 flag changes, 10 raises, 4 lowers |

The last row is the regression check that matters: Task 2 appended a branch to `parseLine`, and any change to the flag counts means the branch order moved.

- [ ] **Step 4: Verify no token is missing from the dictionary**

```bash
docker compose exec -T postgres psql -U factions -d factions_backfill -t -c "select distinct payload->>'emote' from events where type='emote.performed' order by 1;"
```

Compare against `EMOTE_DICTIONARY`. Every observed token must be present. A token in the log but not the dictionary is a gap: it can never be chosen for a sequence, but more importantly its absence means the census the dictionary was built from is stale.

- [ ] **Step 5: Record the results**

Write `docs/acceptance/2026-08-26-emote-ingest.md` with the actual observed numbers (not the expected ones), the command used, and the date. If any number differs from the table above, record the actual value and investigate before continuing — a lower emote count is a parser false negative, and §16's whole flow rests on this parser.

- [ ] **Step 6: Run the full suite**

```bash
export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"
pnpm run ci
```
Expected: every task passes, 0 skipped. Confirm the reported test count grew by the 95 tests this plan adds — Plan 1 found that turbo can report success while silently skipping DB suites, so check the number, not just the exit code.

- [ ] **Step 7: Commit**

```bash
git add docs/acceptance/2026-08-26-emote-ingest.md
git commit -m "docs: emote ingest acceptance against the production export"
```

---

## Self-Review

**Spec coverage (§16):**

| §16 requirement | Task |
|---|---|
| Emote-sequence verification, Discord-only | 3, 6–10 |
| Bound to the UID, not the gamertag | 2 (parser captures UID), 4 (unique on `dayz_id`), 7 |
| Sequence length 3, distinct, ordered | 3 |
| Challenge expiry 10 minutes | 6 (`challengeTtlMs` default 600_000), 7 (`liveWhere`) |
| Reject a sequence already outstanding | 9 (`handleLink` redraw loop) |
| In-order subsequence; non-matching ignored | 3 (`advance`) |
| One UID, one Discord account, enforced by index | 4 |
| Re-link requires unlinking first | 9 (`handleLink` refuses when linked) |
| Unsafe emotes excluded | 1 |
| Verification prerequisite for faction commands | Deferred to Plan 3 — no faction commands exist yet. `findLinkByDiscord` is the gate they will call. |
| No Better Auth / web / user tables | Nothing in this plan adds them |
| One guild, per-map channels | 4 (`guild_id` on challenges), 10 (guild-scoped registration). Per-map channel resolution belongs to Plan 3, which introduces the first map-scoped command. |

**Type consistency:** `VerificationStore` is defined once in Task 7 and consumed unchanged by Tasks 8–10. `CommandDeps` is defined in Task 9 and consumed by Task 10. `EmotePerformed` is defined in Task 2 and consumed by `parseLine` and `toPayload`. `LiveChallenge` is returned by five store methods with one shape, built by the single `toLive` helper.

**Placeholders:** none. Every code step carries the code; every acceptance number is a measured value from the export, not a guess.

**Known deferrals, stated rather than hidden:**
- Expired challenges are never garbage-collected. They stop being live via `liveWhere` and are harmless; a cleanup job is Plan 3 work or later.
- `/unlink` does not check faction membership, because factions do not exist yet. Plan 3 must add that gate — unlinking a faction leader's identity would orphan the roster.
- The per-map channel mapping is not built here. Task 4 records `guild_id` so it is available; the first command that needs a map is in Plan 3.
