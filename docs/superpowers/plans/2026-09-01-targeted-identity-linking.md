# Targeted identity linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/link` name the character it verifies, so three findable emotes are enough — and show the result as the player's Discord nickname.

**Architecture:** A new `players` projection records every UID the event log has seen, with its latest gamertag. `/link` takes a gamertag chosen from autocomplete over recently-seen, unlinked players, resolves it to that character's UID, and stores it on the challenge. The verification tick then advances a challenge only for events carrying that UID, which is what makes a three-emote sequence sufficient and retires the machinery that defended an untargeted challenge.

**Tech Stack:** TypeScript, pnpm workspaces, turbo, tsx (no build step), vitest, Drizzle ORM on Postgres 16, discord.js.

**Spec:** `docs/superpowers/specs/2026-09-01-targeted-identity-linking-design.md`

## Global Constraints

- **ESM/NodeNext.** Every local import ends in `.js`, including from `.ts` files.
- **Migrations are generated, never hand-written.** `pnpm -F @factions/db generate`; commit what drizzle-kit emits, unedited and unrenamed.
- **Tests need a database.** `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"`. **Port 5434 only** — 5432 and 5433 belong to unrelated projects and must never be stopped, removed or repointed.
- **`factions` is the TEST database; `factions_live` holds real data.** Eleven test files truncate `servers`, `events` and `raw_lines` in `factions`. Never point a test at `factions_live`, and never point the bot or worker at `factions`.
- **Never pre-read then write.** A state transition's precondition belongs in the same statement that performs it; decide from `.returning()`.
- **The index is the check.** Where a rule can be a unique index, it is one.
- **Every reply from `/link`, `/unlink` and `/whoami` is ephemeral.**
- **The bot and ingest worker are RUNNING against live data.** The worker is a container (`docker compose ps`); the bot is a background process. Restart them only where a task says to.

### Exact values

| Constant | Value | Where |
|---|---|---|
| Sequence length | **3** | `generateSequence(rng, length = 3)` |
| Safe emote pool | **24 tokens** (one-life's list) | `EMOTE_DICTIONARY` |
| Challenge TTL | 24h = `86_400_000` ms | `BOT_CHALLENGE_TTL_MS` default |
| Emote budget | **8**, unchanged | `MAX_POOL_EMOTES_PER_ATTEMPT` |
| Autocomplete candidate pool | **50** most recently seen unlinked | `recentUnlinkedPlayers` |
| Autocomplete choices returned | **25** (Discord's hard cap) | the autocomplete handler |
| Projection cursor name | `"player-projector"` | `PLAYER_CONSUMER` |

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/domain/src/emotes.ts` (modify) | The safe pool becomes one-life's 24; five tokens move to `safe: false` |
| `packages/verification/src/sequence.ts` (modify) | Default length 3 |
| `packages/db/src/schema.ts` (modify) | `players`; `verification_challenges.target_dayz_id`; index swap |
| `apps/bot/src/player-tick.ts` (create) | The `players` projection consumer |
| `apps/bot/src/store.ts` (modify) | `recentUnlinkedPlayers`, `playerByDayzId`, targeted `createChallenge` |
| `apps/bot/src/commands.ts` (modify) | `/link` takes a gamertag; `/unlink` clears the nickname |
| `apps/bot/src/tick.ts` (modify) | Advance only on the target UID; cancel on budget exhaustion |
| `apps/bot/src/nickname.ts` (create) | Setting and clearing a member's nickname, with its failure taxonomy |
| `apps/bot/src/discord.ts` (modify) | The gamertag option, its autocomplete, and the nickname calls |

---

### Task 1: Correct the emote dictionary and shorten the sequence

**Files:**
- Modify: `packages/domain/src/emotes.ts`
- Modify: `packages/verification/src/sequence.ts`
- Test: `packages/domain/test/emotes.test.ts`, `packages/verification/test/sequence.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `safeVerificationEmotes()` returning exactly 24 entries; `generateSequence(rng, length = 3)`

This is the bug that started the rework: `/link` asked a player to perform **SOS**, which they could not find on the emote wheel. `EmoteSOS` is real — it appears 3 times in the five-week production export — which is exactly why the old rule failed. Observation proves a token can be produced; it does not prove a player can find it.

- [ ] **Step 1: Write the failing tests**

In `packages/domain/test/emotes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { EMOTE_DICTIONARY, safeVerificationEmotes, emoteLabel } from "../src/emotes.js";

// one-life's list, which is the empirically-working set: every token here has
// been performed by a real player completing a real /link in production.
const ONE_LIFE_SAFE = [
  "EmoteSalute", "EmoteSurrender", "EmoteGreeting", "EmoteClap", "EmoteHeart",
  "EmotePoint", "EmotePointSelf", "EmoteThumb", "EmoteThumbDown", "EmoteNod",
  "EmoteShake", "EmoteDance", "EmoteFacepalm", "EmoteShrug", "EmoteTimeout",
  "EmoteLookAtMe", "EmoteListening", "EmoteCome", "EmoteMove", "EmoteSilent",
  "EmoteWatching", "EmoteThroat", "EmoteRPSRandom", "EmoteTauntElbow",
];

describe("emote dictionary", () => {
  it("offers exactly one-life's safe set", () => {
    expect(safeVerificationEmotes().map((e) => e.token).sort())
      .toEqual([...ONE_LIFE_SAFE].sort());
  });

  it("never offers an emote that is not confirmed on the wheel", () => {
    // The five this project added beyond one-life. EmoteSOS is the one that
    // reached a player and could not be performed.
    for (const token of ["EmoteSOS", "EmoteHold", "EmoteTaunt", "EmoteTauntKiss", "EmoteTauntThink"]) {
      expect(safeVerificationEmotes().map((e) => e.token)).not.toContain(token);
    }
  });

  it("still LABELS the excluded tokens, so the parser can name them", () => {
    // They stay in the dictionary; only the safe flag changes. Dropping them
    // entirely would make real emote lines unlabelable.
    expect(emoteLabel("EmoteSOS")).toBe("SOS");
    expect(EMOTE_DICTIONARY.find((e) => e.token === "EmoteSOS")?.safe).toBe(false);
  });
});
```

In `packages/verification/test/sequence.test.ts`, add:

```ts
  it("draws three tokens by default", () => {
    expect(generateSequence(() => 0)).toHaveLength(3);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm -F @factions/domain test && pnpm -F @factions/verification test`
Expected: FAIL — the safe set currently has 29 entries and the default length is 4.

- [ ] **Step 3: Move the five tokens to `safe: false`**

In `packages/domain/src/emotes.ts`, change the doc comment's rule and regroup. Replace the `⚠️ Do not add a token here...` paragraph with:

```ts
 * `safe: false` excludes an emote from verification sequences, for one of THREE
 * reasons:
 *
 *   1. It occurs in natural play. `EmoteSitA` is 1,611 of the 2,093 emote
 *      lines — 77% of all emote traffic. A sequence containing it would
 *      routinely be completed by accident.
 *   2. It carries a gameplay penalty. Asking a player to prove identity by
 *      killing their character is not a verification flow.
 *   3. ⚠️ It is not confirmed selectable from the in-game emote wheel.
 *
 * Reason 3 replaced the rule this file used to carry — "do not add a token that
 * has not been observed in a real ADM line". That rule was not enough, and it
 * shipped a broken /link: `EmoteSOS` IS observed (3 times in the five-week
 * production export, 0.14% of emote traffic) and a player still could not find
 * it on the wheel. Observation proves a token can be produced; it does not
 * prove a player can perform it on request. The safe set is therefore one-life's
 * list, every member of which has been performed by a real player completing a
 * real /link in production.
```

Then move `EmoteSOS`, `EmoteHold`, `EmoteTaunt`, `EmoteTauntKiss` and `EmoteTauntThink` to `safe: false`, grouped under a comment naming reason 3. Leave every other entry untouched — `EmoteTauntElbow` stays `safe: true`, because one-life ships it.

- [ ] **Step 4: Default the sequence to three**

In `packages/verification/src/sequence.ts`, change the signature to `length = 3` and rewrite the `⚠️ Length is a SECURITY parameter` comment:

```ts
/**
 * ⚠️ Length is a security parameter, but NOT the one it used to be.
 *
 * Before targeted challenges, a challenge named nobody: any UID performing the
 * sequence won it, so length had to make the space too large to sweep. Four was
 * chosen for that reason.
 *
 * A challenge now names its target UID and can only be advanced by that
 * character (see the design's §3), so that attack is unreachable and three
 * suffices. What length still bounds is the residual risk: someone claims an
 * unlinked player's character and waits for them to perform the sequence by
 * accident. Three over 24 tokens is 12,144 ordered sequences, and
 * MAX_POOL_EMOTES_PER_ATTEMPT caps one challenge's exposure at C(8,3) = 56 of
 * them — 0.46%. Shorten it further only alongside a cut to that budget.
 */
```

- [ ] **Step 5: Run the tests**

Run: `pnpm -F @factions/domain test && pnpm -F @factions/verification test && pnpm -F @factions/bot test`
Expected: PASS. If a bot test asserts a 4-token sequence, update it — the length change is deliberate.

- [ ] **Step 6: Commit**

```bash
git add packages/domain packages/verification apps/bot
git commit -m "fix(domain): offer only emotes players can find on the wheel"
```

---

### Task 2: Schema — the players table and the targeted challenge

**Files:**
- Modify: `packages/db/src/schema.ts`
- Test: `packages/db/test/identity.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `players` table (`dayzId`, `gamertag`, `firstSeenAt`, `lastSeenAt`); `verificationChallenges.targetDayzId`

- [ ] **Step 1: Write the failing test**

Add to `packages/db/test/identity.test.ts`, following its existing setup:

```ts
  it("refuses two live challenges for the same character", async () => {
    // Two Discord accounts must not race to bind one character.
    const base = {
      guildId: "g", channelId: "c", sequence: ["EmoteSalute"],
      issuedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000),
      targetDayzId: TARGET,
    };
    await db.insert(verificationChallenges).values({ ...base, discordId: "d1" });
    await expect(db.insert(verificationChallenges).values({ ...base, discordId: "d2" }))
      .rejects.toThrow(/verification_challenges_open_target_uniq/);
  });

  it("allows two live challenges to share a sequence", async () => {
    // The old open-sequence index is GONE. With 3 emotes over 24 tokens there
    // are only 12,144 sequences, so collisions are ordinary and must not
    // reject a legitimate /link. Safe because a challenge names its target.
    const seq = ["EmoteSalute", "EmoteClap", "EmoteNod"];
    const base = { guildId: "g", channelId: "c", sequence: seq,
      issuedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) };
    await db.insert(verificationChallenges).values({ ...base, discordId: "d1", targetDayzId: A });
    await db.insert(verificationChallenges).values({ ...base, discordId: "d2", targetDayzId: B });
    expect(await db.select().from(verificationChallenges)).toHaveLength(2);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/db test identity`
Expected: FAIL — `targetDayzId` is not a column.

- [ ] **Step 3: Add the `players` table**

In `packages/db/src/schema.ts`, after `identityLinks`:

```ts
/**
 * Every character the event log has ever seen.
 *
 * Keyed on the UID, not the display name: a rename is then a column update
 * rather than a new identity, and two players who have ever shared a gamertag
 * remain two rows. `/link`'s autocomplete reads this, and spec §6's
 * leader-inactivity mechanic (Plan 4c) will read `last_seen_at`.
 *
 * ⚠️ Both timestamps are EVENT times, not wall-clock. A backfill of old logs
 * must not make a long-absent player look recently active.
 */
export const players = pgTable("players", {
  dayzId: text("dayz_id").primaryKey(),
  gamertag: text("gamertag").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
}, (t) => ({
  byLastSeen: index("players_last_seen_idx").on(t.lastSeenAt),
}));
```

- [ ] **Step 4: Add the target and swap the indexes**

Add to `verificationChallenges`'s columns:

```ts
  /**
   * The character this challenge verifies, chosen by the player at /link time.
   *
   * ⚠️ This column is the security model. The tick advances a challenge ONLY
   * for events carrying this UID, so a challenge can only be won by the
   * character it names — which is what makes a three-emote sequence sufficient
   * and what retired the open-sequence unique index below.
   */
  targetDayzId: text("target_dayz_id").notNull(),
```

**Delete `uniqOpenSequence` entirely**, and put a tombstone comment where it was so nobody reinstates it:

```ts
  // `verification_challenges_open_sequence_uniq` was REMOVED here. It was a
  // real security boundary while a challenge named nobody — two live
  // challenges sharing a sequence let the tick bind the wrong account. A
  // challenge now names its target UID, so that race cannot occur, and
  // reinstating the index would actively break /link: three emotes over 24
  // tokens is 12,144 sequences, so live challenges collide routinely.
```

Keep `uniqOpenPerAccount` unchanged, and add:

```ts
  // One live challenge per CHARACTER. Without it, two Discord accounts can
  // both hold open challenges for one UID and race to bind it.
  uniqOpenTarget: uniqueIndex("verification_challenges_open_target_uniq")
    .on(t.targetDayzId)
    .where(sql`${t.completedAt} IS NULL AND ${t.canceledAt} IS NULL`),
```

- [ ] **Step 5: Generate the migration**

Run: `pnpm -F @factions/db generate`

Read the emitted SQL. It must create `players`, add `target_dayz_id NOT NULL`, drop `verification_challenges_open_sequence_uniq`, and create `verification_challenges_open_target_uniq`. **The `DROP INDEX` is expected here** — unlike every previous migration in this repo — because the index is deliberately retired.

- [ ] **Step 6: Record the deploy step this migration needs**

`ADD COLUMN ... NOT NULL` with no default fails against existing rows. `factions_live` holds **one** `verification_challenges` row — an abandoned challenge from the broken flow whose sequence contains `EmoteSOS`, which can never complete. `identity_links` is empty, so nothing of value exists.

Create `docs/deploy/2026-09-01-targeted-linking.md`:

```markdown
# Deploy step — targeted identity linking

Run BEFORE applying migration 0012 to any database holding rows.

    delete from challenge_attempts;
    delete from verification_challenges;

Every pre-change challenge is unwinnable under the new rules: it has no target
UID, and the tick now requires one. `identity_links` is untouched and must not
be cleared — a completed link stays valid.

Verified 2026-09-01: `factions_live` held 1 challenge, 0 attempts, 0 links.
```

- [ ] **Step 7: Run the tests and commit**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/db test
git add packages/db docs/deploy
git commit -m "feat(db): players projection and targeted challenges"
```

---

### Task 3: The players projection

**Files:**
- Create: `apps/bot/src/player-tick.ts`
- Test: `apps/bot/test/player-tick.test.ts`

**Interfaces:**
- Consumes: `players` from `@factions/db`
- Produces: `PLAYER_CONSUMER = "player-projector"`, `runPlayerProjection(db, opts?): Promise<PlayerProjectionResult>` where `PlayerProjectionResult = { scanned: number; upserted: number }`

**Placement ruling:** this lives in the bot, not `apps/projector`. The projector app is a one-shot CLI; the bot already runs a tick loop and is the projection's only consumer, so putting it here keeps the autocomplete fresh without a new deployable. Its cursor name is distinct from every other consumer — sharing one would make each skip the other's events, and the symptom is "autocomplete is randomly stale" rather than an error.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, players, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { runPlayerProjection, PLAYER_CONSUMER } from "../src/player-tick.js";
import { readCursor } from "@factions/event-log";

const A = "A".repeat(40);

describe("runPlayerProjection", () => {
  let db: Database;
  let serverId = 0;

  beforeEach(async () => {
    db = createClient(requireTestDatabaseUrl());
    await runMigrations(db);
    await db.execute(sql`truncate table events, raw_lines, adm_files, players, servers, consumer_cursors restart identity cascade`);
    // seed one server; see apps/bot/test/tick.test.ts for the fixture shape
  });

  it("records a player from a position event", async () => {
    await seedEvent({ type: "player.position", occurredAt: new Date("2026-09-01T10:00:00Z"),
      payload: { dayzId: A, gamertag: "Ronald", pos: { x: 1, y: 2, z: 3 } } });
    const r = await runPlayerProjection(db);
    expect(r.upserted).toBe(1);
    const [row] = await db.select().from(players).where(eq(players.dayzId, A));
    expect(row!.gamertag).toBe("Ronald");
    expect(row!.firstSeenAt.toISOString()).toBe("2026-09-01T10:00:00.000Z");
    expect(row!.lastSeenAt.toISOString()).toBe("2026-09-01T10:00:00.000Z");
  });

  it("advances last_seen and adopts a rename, keeping first_seen", async () => {
    await seedEvent({ type: "player.position", occurredAt: new Date("2026-09-01T10:00:00Z"),
      payload: { dayzId: A, gamertag: "Ronald", pos: { x: 1, y: 2, z: 3 } } });
    await runPlayerProjection(db);
    await seedEvent({ type: "emote.performed", occurredAt: new Date("2026-09-02T10:00:00Z"),
      payload: { dayzId: A, gamertag: "Renamed", emote: "EmoteClap", item: null } });
    await runPlayerProjection(db);
    const [row] = await db.select().from(players).where(eq(players.dayzId, A));
    expect(row!.gamertag).toBe("Renamed");
    expect(row!.firstSeenAt.toISOString()).toBe("2026-09-01T10:00:00.000Z");
    expect(row!.lastSeenAt.toISOString()).toBe("2026-09-02T10:00:00.000Z");
  });

  it("never moves last_seen backwards when events arrive out of order", async () => {
    // ⚠️ A backfill of old logs must not make a long-absent player look
    // recently active, and must not un-advance a player who IS active.
    await seedEvent({ type: "player.position", occurredAt: new Date("2026-09-05T10:00:00Z"),
      payload: { dayzId: A, gamertag: "Ronald", pos: { x: 1, y: 2, z: 3 } } });
    await runPlayerProjection(db);
    await seedEvent({ type: "player.position", occurredAt: new Date("2026-09-01T10:00:00Z"),
      payload: { dayzId: A, gamertag: "Older", pos: { x: 1, y: 2, z: 3 } } });
    await runPlayerProjection(db);
    const [row] = await db.select().from(players).where(eq(players.dayzId, A));
    expect(row!.lastSeenAt.toISOString()).toBe("2026-09-05T10:00:00.000Z");
    expect(row!.firstSeenAt.toISOString()).toBe("2026-09-01T10:00:00.000Z");
    // The gamertag follows the NEWEST event, so an older line must not rename them.
    expect(row!.gamertag).toBe("Ronald");
  });

  it("resumes from its own cursor and does not reprocess", async () => {
    await seedEvent({ type: "player.position", occurredAt: new Date("2026-09-01T10:00:00Z"),
      payload: { dayzId: A, gamertag: "Ronald", pos: { x: 1, y: 2, z: 3 } } });
    await runPlayerProjection(db);
    const second = await runPlayerProjection(db);
    expect(second.scanned).toBe(0);
    expect(await readCursor(db, PLAYER_CONSUMER)).toBeGreaterThan(0);
  });
});
```

Write a `seedEvent` helper in the file that inserts an `adm_files` row and an `events` row; copy the fixture shape from `apps/bot/test/tick.test.ts`.

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/bot test player-tick`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Follow `apps/projector/src/run.ts` for the batching-and-cursor shape and `apps/bot/src/tick.ts` for the event-log imports. The upsert must guard `last_seen_at` and `gamertag` against going backwards **inside the statement**:

```ts
    await db.insert(players)
      .values({ dayzId, gamertag, firstSeenAt: ev.occurredAt, lastSeenAt: ev.occurredAt })
      .onConflictDoUpdate({
        target: players.dayzId,
        // ⚠️ Guarded in SQL, not by a prior read. Events are replayed in id
        // order, but a backfill can carry OLDER occurredAt values than rows
        // already written, and `first_seen` must survive that while
        // `last_seen` and the display name must not regress.
        set: {
          lastSeenAt: sql`greatest(${players.lastSeenAt}, excluded.last_seen_at)`,
          firstSeenAt: sql`least(${players.firstSeenAt}, excluded.first_seen_at)`,
          gamertag: sql`case when excluded.last_seen_at >= ${players.lastSeenAt}
                        then excluded.gamertag else ${players.gamertag} end`,
        },
      });
```

Only `player.position` and `emote.performed` carry `dayzId` and `gamertag`; skip every other type without counting it as upserted.

- [ ] **Step 4: Run the tests and commit**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/bot test
git add apps/bot/src/player-tick.ts apps/bot/test/player-tick.test.ts
git commit -m "feat(bot): project observed players from the event log"
```

---

### Task 4: Store and tick — target the challenge

**Files:**
- Modify: `apps/bot/src/store.ts`, `apps/bot/src/tick.ts`
- Test: `apps/bot/test/store.test.ts`, `apps/bot/test/tick.test.ts`

**Interfaces:**
- Consumes: `players`, `verificationChallenges.targetDayzId`
- Produces, on `VerificationStore`:

```ts
  /** The `limit` most recently seen players with no identity link, newest first. */
  recentUnlinkedPlayers(limit: number): Promise<{ dayzId: string; gamertag: string }[]>;
  /** One player by UID, or null if the event log has never seen them. */
  playerByDayzId(dayzId: string): Promise<{ dayzId: string; gamertag: string } | null>;
```

`createChallenge`'s input gains `targetDayzId: string`. `LiveChallenge` gains `targetDayzId: string`.

- [ ] **Step 1: Write the failing tests**

In `apps/bot/test/tick.test.ts` — this is the security test, and it must fail if the UID comparison is removed:

```ts
  it("does not advance a challenge for a DIFFERENT character's emotes", async () => {
    // ⚠️ THE security property. A challenge names its target; only that
    // character can advance it. Delete the dayzId comparison in tick.ts and
    // this test must go red — it is the whole reason three emotes is enough.
    const challenge = await seedChallenge({ discordId: "d1", targetDayzId: TARGET,
      sequence: ["EmoteSalute", "EmoteClap", "EmoteNod"] });
    for (const emote of ["EmoteSalute", "EmoteClap", "EmoteNod"]) {
      await seedEmote({ dayzId: IMPOSTOR, gamertag: "Impostor", emote });
    }
    const r = await verificationTick(db, store, { now: new Date() });
    expect(r.verified).toBe(0);
    expect(r.advanced).toBe(0);
    const [row] = await db.select().from(verificationChallenges)
      .where(eq(verificationChallenges.id, challenge.id));
    expect(row!.completedAt).toBeNull();
    expect(row!.boundDayzId).toBeNull();
  });

  it("completes when the NAMED character performs the sequence", async () => {
    const challenge = await seedChallenge({ discordId: "d1", targetDayzId: TARGET,
      sequence: ["EmoteSalute", "EmoteClap", "EmoteNod"] });
    for (const emote of ["EmoteSalute", "EmoteClap", "EmoteNod"]) {
      await seedEmote({ dayzId: TARGET, gamertag: "Ronald", emote });
    }
    const r = await verificationTick(db, store, { now: new Date() });
    expect(r.verified).toBe(1);
    const [link] = await db.select().from(identityLinks);
    expect(link!.dayzId).toBe(TARGET);
    expect(link!.discordId).toBe("d1");
  });

  it("cancels a challenge whose budget is exhausted", async () => {
    // With a 24h TTL, an inert budget-exhausted challenge would hold the
    // player's one open slot for a day. Cancelled, they can /link again.
    const challenge = await seedChallenge({ discordId: "d1", targetDayzId: TARGET,
      sequence: ["EmoteSalute", "EmoteClap", "EmoteNod"] });
    // Nine safe emotes that never match the sequence.
    for (const emote of ["EmoteHeart", "EmoteDance", "EmoteShrug", "EmoteMove", "EmoteCome",
                         "EmoteSilent", "EmoteWatching", "EmoteThroat", "EmotePoint"]) {
      await seedEmote({ dayzId: TARGET, gamertag: "Ronald", emote });
    }
    await verificationTick(db, store, { now: new Date() });
    const [row] = await db.select().from(verificationChallenges)
      .where(eq(verificationChallenges.id, challenge.id));
    expect(row!.canceledAt).not.toBeNull();
  });
```

In `apps/bot/test/store.test.ts`:

```ts
  it("offers recently seen players, newest first, excluding the linked", async () => {
    await seedPlayer({ dayzId: A, gamertag: "Older", lastSeenAt: new Date("2026-09-01T00:00:00Z") });
    await seedPlayer({ dayzId: B, gamertag: "Newer", lastSeenAt: new Date("2026-09-02T00:00:00Z") });
    await seedPlayer({ dayzId: C, gamertag: "Taken", lastSeenAt: new Date("2026-09-03T00:00:00Z") });
    await db.insert(identityLinks).values({ discordId: "d9", dayzId: C, gamertag: "Taken", verifiedAt: new Date() });
    expect(await store.recentUnlinkedPlayers(50)).toEqual([
      { dayzId: B, gamertag: "Newer" },
      { dayzId: A, gamertag: "Older" },
    ]);
  });

  it("honours the limit", async () => {
    // The autocomplete's pool is 50; Discord returns at most 25 of them.
    for (let i = 0; i < 60; i++) {
      await seedPlayer({ dayzId: `${i}`.padStart(40, "0"), gamertag: `P${i}`,
        lastSeenAt: new Date(Date.UTC(2026, 8, 1, 0, i)) });
    }
    expect(await store.recentUnlinkedPlayers(50)).toHaveLength(50);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/bot test`
Expected: FAIL — `recentUnlinkedPlayers` is not a function; `targetDayzId` unknown.

- [ ] **Step 3: Implement the store methods**

```ts
  /**
   * ⚠️ LEFT join with an IS NULL filter, not `notInArray(subquery)`. The
   * exclusion must be evaluated by the database against the same snapshot as
   * the ordering; pulling the linked ids into memory first would let a link
   * committed between the two queries leak a taken character into the menu.
   */
  async recentUnlinkedPlayers(limit: number) {
    const rows = await this.db
      .select({ dayzId: players.dayzId, gamertag: players.gamertag })
      .from(players)
      .leftJoin(identityLinks, eq(identityLinks.dayzId, players.dayzId))
      .where(isNull(identityLinks.id))
      .orderBy(desc(players.lastSeenAt))
      .limit(limit);
    return rows;
  }

  async playerByDayzId(dayzId: string) {
    const [row] = await this.db
      .select({ dayzId: players.dayzId, gamertag: players.gamertag })
      .from(players).where(eq(players.dayzId, dayzId));
    return row ?? null;
  }
```

Add `players`, `desc` and `isNull` to the imports if absent. Both methods go on the `VerificationStore` interface as well as `PgVerificationStore`.

- [ ] **Step 4: Target the tick**

In `apps/bot/src/tick.ts`, add the UID comparison before any matching work, with the reasoning:

```ts
        // ⚠️ THE security boundary. A challenge names the character it
        // verifies, so only that character's emotes may advance it. This one
        // comparison is why a three-emote sequence is sufficient and why the
        // open-sequence unique index could be retired. Removing it silently
        // restores the old lottery: any UID would win any live challenge.
        if (payload.dayzId !== challenge.targetDayzId) continue;
```

Rewrite `MAX_POOL_EMOTES_PER_ATTEMPT`'s comment: it is no longer defence-in-depth against a sweep, it is the **primary** defence against a named victim completing the sequence accidentally over 24 hours. Keep the value at 8.

On exhaustion, cancel the challenge rather than only counting `lockedOut`, using the existing guarded cancel path.

- [ ] **Step 5: Run and commit**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/bot test
git add apps/bot
git commit -m "feat(bot): advance a challenge only for the character it names"
```

---

### Task 5: `/link` takes a gamertag

**Files:**
- Modify: `apps/bot/src/commands.ts`
- Test: `apps/bot/test/commands.test.ts`

**Interfaces:**
- Consumes: `recentUnlinkedPlayers`, `playerByDayzId`, targeted `createChallenge`
- Produces: `handleLink(deps, ctx)` where `LinkContext` gains `targetDayzId: string` (the autocomplete choice's value)

- [ ] **Step 1: Write the failing tests**

```ts
  it("refuses a UID the event log has never seen", async () => {
    const r = await handleLink(deps, { ...ctx, targetDayzId: UNKNOWN });
    expect(r.content).toMatch(/have not seen/i);
    expect(store.created).toBe(false);
  });

  it("refuses a character somebody has already linked", async () => {
    // The autocomplete filters these out, but the menu can be stale and a
    // user can type anything into an autocomplete field.
    store.linkedDayzIds.add(TARGET);
    const r = await handleLink(deps, { ...ctx, targetDayzId: TARGET });
    expect(r.content).toMatch(/already linked/i);
    expect(store.created).toBe(false);
  });

  it("names the character in the challenge message", async () => {
    const r = await handleLink(deps, { ...ctx, targetDayzId: TARGET });
    // The player must be able to see they picked the right character before
    // walking into game to perform three emotes.
    expect(r.content).toContain("Ronald");
    expect(r.content).toMatch(/1\./);
    expect(r.content).toMatch(/3\./);
  });

  it("re-shows an existing challenge rather than reissuing", async () => {
    await handleLink(deps, { ...ctx, targetDayzId: TARGET });
    const again = await handleLink(deps, { ...ctx, targetDayzId: TARGET });
    expect(again.content).toContain("Ronald");
    expect(store.createCount).toBe(1);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -F @factions/bot test commands`
Expected: FAIL — `handleLink` takes no target.

- [ ] **Step 3: Implement**

`handleLink` now: refuses if the caller is already linked (unchanged); resolves `targetDayzId` via `playerByDayzId` and refuses an unknown UID; refuses a UID already in `identity_links` via `findLinkByDayzId`; re-shows a live challenge; then creates one carrying `targetDayzId`.

**Delete the twenty-attempt redraw loop.** It existed solely to dodge collisions on the open-sequence unique index, which Task 2 removed. Replace it with a single `createChallenge` call, and keep the existing "a concurrent /link beat us" fallback that re-reads the live challenge — that path is still reachable through `uniqOpenPerAccount`.

Update `challengeMessage` to name the character and to say the sequence expires in 24 hours.

- [ ] **Step 4: Change the TTL default**

In `apps/bot/src/config.ts`, `BOT_CHALLENGE_TTL_MS` default becomes `86_400_000` with a comment: 24 hours, matching one-life; safe because a challenge names its target and cannot be stolen. Update `apps/bot/README.md`'s table and example.

- [ ] **Step 5: Run and commit**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/bot test
git add apps/bot
git commit -m "feat(bot): /link verifies a named character"
```

---

### Task 6: The gamertag option and its autocomplete

**Files:**
- Modify: `apps/bot/src/discord.ts`
- Test: `apps/bot/test/discord.test.ts`

**Interfaces:**
- Consumes: `recentUnlinkedPlayers`
- Produces: `playerSuggestions(players, query): { name: string; value: string }[]`

- [ ] **Step 1: Write the failing tests**

```ts
  it("returns at most Discord's 25 choices", () => {
    // ⚠️ Discord rejects an autocomplete response with more than 25 choices,
    // and the field then shows nothing at all. The candidate POOL is 50.
    const many = Array.from({ length: 50 }, (_, i) => ({ dayzId: `${i}`, gamertag: `P${i}` }));
    expect(playerSuggestions(many, "")).toHaveLength(25);
  });

  it("filters case-insensitively on the typed query", () => {
    const ps = [{ dayzId: "1", gamertag: "RonaldRaygun552" }, { dayzId: "2", gamertag: "Someone" }];
    expect(playerSuggestions(ps, "ronald")).toEqual([{ name: "RonaldRaygun552", value: "1" }]);
  });

  it("carries the UID as the value, not the gamertag", () => {
    // Two characters can share a display name; the UID disambiguates and
    // means the submit path never re-resolves a name.
    const ps = [{ dayzId: "abc", gamertag: "Twin" }, { dayzId: "def", gamertag: "Twin" }];
    expect(playerSuggestions(ps, "twin").map((c) => c.value)).toEqual(["abc", "def"]);
  });

  it("registers /link with a required autocompleting gamertag option", () => {
    const link = buildCommands().find((c) => c.name === "link")!;
    const opt = (link.options ?? [])[0] as any;
    expect(opt.name).toBe("gamertag");
    expect(opt.required).toBe(true);
    expect(opt.autocomplete).toBe(true);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -F @factions/bot test discord`
Expected: FAIL — `playerSuggestions` is not exported.

- [ ] **Step 3: Implement**

Add the option to `/link` in `buildCommands()`. Write `playerSuggestions` beside `flagSuggestions`, following its shape. Wire the autocomplete branch in `start()` to call `store.recentUnlinkedPlayers(50)` then `playerSuggestions(...)`, and pass the chosen value through as `targetDayzId`.

Wrap the autocomplete in try/catch and log on failure, as the flag autocomplete already does — the response window is short and a dropped response must not crash the handler.

- [ ] **Step 4: Run and commit**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/bot test
git add apps/bot
git commit -m "feat(bot): autocomplete recently seen unlinked characters"
```

---

### Task 7: Set the Discord nickname

**Files:**
- Create: `apps/bot/src/nickname.ts`
- Modify: `apps/bot/src/discord.ts`, `apps/bot/src/commands.ts`
- Test: `apps/bot/test/nickname.test.ts`

**Interfaces:**
- Produces:

```ts
export type NicknameOutcome = "ok" | "is-owner" | "outranked" | "no-permission" | "failed";
export async function applyNickname(
  guild: GuildLike, userId: string, nickname: string | null,
): Promise<NicknameOutcome>;
```

`GuildLike` is a structural type carrying just what this needs, so tests need no discord.js client.

- [ ] **Step 1: Write the failing tests**

```ts
  it("sets the nickname to the gamertag", async () => {
    const guild = fakeGuild();
    expect(await applyNickname(guild, "u1", "Ronald")).toBe("ok");
    expect(guild.calls).toEqual([["u1", "Ronald"]]);
  });

  it("clears the nickname when given null", async () => {
    const guild = fakeGuild();
    expect(await applyNickname(guild, "u1", null)).toBe("ok");
    expect(guild.calls).toEqual([["u1", null]]);
  });

  it("reports the owner as a PERMANENT refusal", async () => {
    // ⚠️ Discord's API cannot rename a guild owner, ever. Retrying is futile,
    // and treating it as transient would mean retrying forever.
    const guild = fakeGuild({ ownerId: "u1" });
    expect(await applyNickname(guild, "u1", "Ronald")).toBe("is-owner");
    expect(guild.calls).toEqual([]);   // never even attempted
  });

  it("distinguishes a hierarchy refusal from a missing permission", async () => {
    // 50013 covers both "your role is too low" and "you lack Manage
    // Nicknames". They need different messages: one is fixable by the admin
    // moving the bot's role, the other by granting a permission.
    expect(await applyNickname(fakeGuild({ manageable: false }), "u1", "R")).toBe("outranked");
    expect(await applyNickname(fakeGuild({ hasPermission: false }), "u1", "R")).toBe("no-permission");
  });

  it("reports an unexpected API error as failed without throwing", async () => {
    // A link must never be lost because a rename failed.
    expect(await applyNickname(fakeGuild({ throws: new Error("boom") }), "u1", "R")).toBe("failed");
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -F @factions/bot test nickname`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/** Only what this needs from a guild, so tests need no discord.js client. */
export type GuildLike = {
  ownerId: string;
  members: { fetch(userId: string): Promise<MemberLike> };
  members_me_permissions_has(perm: "ManageNicknames"): boolean;
};
export type MemberLike = {
  manageable: boolean;
  setNickname(nick: string | null): Promise<unknown>;
};

export async function applyNickname(
  guild: GuildLike, userId: string, nickname: string | null,
): Promise<NicknameOutcome> {
  // ⚠️ Checked FIRST and without attempting. Discord's API can never rename a
  // guild owner — not with any permission, not ever — so an attempt is a
  // guaranteed error, and treating that error as transient would mean
  // retrying forever on every future link.
  if (guild.ownerId === userId) return "is-owner";
  if (!guild.members_me_permissions_has("ManageNicknames")) return "no-permission";
  try {
    const member = await guild.members.fetch(userId);
    // Discord returns 50013 for BOTH "your role is too low" and "you lack the
    // permission". They need different messages — one is fixed by moving the
    // bot's role, the other by granting a permission — so hierarchy is
    // checked here rather than inferred from the error code.
    if (!member.manageable) return "outranked";
    await member.setNickname(nickname);
    return "ok";
  } catch (err) {
    console.warn(`nickname change failed for ${userId}`, err);
    return "failed";
  }
}
```

Adapt `GuildLike` to discord.js's real shape at the call site in `discord.ts` (`guild.members.me?.permissions.has(PermissionFlagsBits.ManageNicknames)`); keep the structural type in `nickname.ts` so the tests stay client-free.

- [ ] **Step 4: Call it from the completion notifier and `/unlink`**

The notifier already DMs on completion; set the nickname there, **after** the link is committed. Append the outcome to the message: on `"ok"` say the nickname was set; on anything else say the link succeeded but the nickname could not be changed, and give the reason in plain words (the owner cannot be renamed by a bot; the bot's role is below theirs; the bot lacks Manage Nicknames).

In `handleUnlink`, clear the nickname after the link is deleted, best-effort and silent on failure — an unlink that worked must not report an error.

- [ ] **Step 5: Document the permission**

Add **Manage Nicknames** to `apps/bot/README.md`'s invite steps, noting it is not needed for linking itself, only for renaming, and that renames of the server owner will always fail.

- [ ] **Step 6: Run and commit**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/bot test
git add apps/bot
git commit -m "feat(bot): show a verified link as the player's nickname"
```

---

### Task 8: Live acceptance

**Files:**
- Create: `docs/acceptance/2026-09-01-targeted-linking.md`

Unlike every previous plan in this repo, this one can be staged for real: the bot and the ingest worker are both running against CW-TEST with live data.

- [ ] **Step 1: Full suite**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`
Record the totals.

- [ ] **Step 2: Apply the deploy step and migrate `factions_live`**

Follow `docs/deploy/2026-09-01-targeted-linking.md` exactly: clear `challenge_attempts` and `verification_challenges` in `factions_live` **first**, then apply migrations. Record the row counts before and after.

- [ ] **Step 3: Restart both services**

The bot must re-register `/link` with its new option, and both must pick up the new code.

```bash
docker compose restart ingest-worker
# restart the bot process
```

- [ ] **Step 4: Stage a real link and record what happened**

In Discord: run `/link`, and record what the autocomplete offered. Pick your character. Record the three emotes shown. Perform them in game on CW-TEST. Record the DM, the elapsed time, and whether the nickname changed.

Then record the database state: the `players` row, the challenge row with its `target_dayz_id`, `completed_at` and `bound_dayz_id`, and the `identity_links` row.

- [ ] **Step 5: Prove the security property against live data**

Query the challenge's `target_dayz_id` and confirm it equals the `dayz_id` on the resulting link. State plainly whether any part of the flow was NOT exercised — for instance the owner/hierarchy nickname refusals, if the tester is not the server owner.

- [ ] **Step 6: Commit**

```bash
git add docs/acceptance/2026-09-01-targeted-linking.md
git commit -m "docs(acceptance): targeted linking staged end to end"
```
