# Referrals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A player can name the linked player who referred them, while linking (bot or site) or any time after; the record is permanent, shown on both profiles, and the referrer is DMed.

**Architecture:** A new insert-only `referrals` table keyed by the referred player's Discord id, protected by a trigger. The single write path, `recordReferralTx`, lives in `@factions/verification` (the package that owns `identity_links` writes and `completeChallenge`), is called from `completeChallenge` for referrers named at link time, and from a roster wrapper for later adds. The referrer's DM rides the bot's existing verification notifier loop, driven by a `referrer_notified_at` column.

**Tech Stack:** TypeScript ESM (`.js` imports in apps, extensionless in packages — match the file you edit), drizzle over postgres.js, vitest, discord.js, Next.js (apps/web).

**Spec:** `docs/superpowers/specs/2026-09-26-referrals-design.md`

## Rulings against the spec

- **Where the write lives.** The spec says `recordReferral` is in `@factions/roster`. `@factions/roster` depends on `@factions/verification`, and `completeChallenge` (verification) must call the write inside its transaction, so the write lives in `packages/verification/src/referral.ts`; roster wraps it. Cost if wrong: a file move.
- **How the DM is queued.** The spec says "via the existing user-notice queue (`noticeUserTx`)". That queue is roster-internal and server-scoped (`serverId` required), neither of which fits a verification-level, server-less write. The DM instead uses a `referrer_notified_at` column on `referrals` and a step in the bot's existing `notifyCompleted` pass, the same retry-until-sent discipline as the "Verified" DM. The permanence trigger allows exactly that one column to go from NULL to a timestamp. Cost if wrong: moving one notifier.

## Global Constraints

- A referral is never changed or removed by any code path; the database trigger rejects `DELETE` and any `UPDATE` other than setting `referrer_notified_at` from NULL.
- One referrer per player (`referred_discord_id` primary key). No self-referral (CHECK). No loops, direct or through a chain.
- The referrer must have an `identity_links` row when the referral is recorded. The referred player must have one too (link-time referrals are recorded inside the completing transaction, after the link insert).
- Referrals are keyed by Discord id and have no foreign key to `identity_links`: they survive unlink, guild removal and relinking.
- Player-facing copy: no em dashes, plain voice. Copy that both the bot and the site show lives in `@factions/copy`.
- Gate before every commit: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force` reads 32/32.
- Commits end with the trailers `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01UMMc6i6sQfSTu9NxB3HFoe`.

## Review Focus

1. Two players naming each other at the same moment (A→B and B→A in flight together): exactly one succeeds, the other gets `loop`. Pinned by the concurrency test in Task 2 (advisory lock).
2. A player who was referred, unlinked, and relinks naming someone else: refused `already-referred` at start, and the original referral stands. Pinned in Task 2 (`checkReferral`) and Task 3.
3. A gamertag that matches two linked players case-insensitively: refused as ambiguous, never guessed. Pinned in Task 3 (`resolveReferrer`).
4. A player naming a referrer on `/link start`, then re-showing the challenge with a different referrer, then redrawing without one: the latest named referrer is recorded. Pinned in Task 2 (`issueChallenge`).
5. The referrer DM when the referred player has since unlinked: still sent, naming them "A player". Pinned in Task 4.

---

### Task 1: Schema, migration and the permanence trigger

**Files:**
- Modify: `packages/db/src/schema.ts` (add `referrals`; add two columns to `verificationChallenges`)
- Create: `packages/db/migrations/0054_<generated>.sql` (via `pnpm --filter @factions/db generate`, then append the trigger SQL)
- Test: `packages/db/test/referrals.test.ts` (follow the setup of an existing DB-backed test in `packages/db/test/`)

**Interfaces:**
- Produces: `referrals` table export with columns `referredDiscordId`, `referrerDiscordId`, `referrerDayzId`, `source`, `createdAt`, `referrerNotifiedAt`; `verificationChallenges.referrerDiscordId` (text, nullable) and `verificationChallenges.referralRefused` (text, nullable); `REFERRAL_SOURCES = ["link_bot", "link_site", "later_bot", "later_site"] as const` and `type ReferralSource`.

- [ ] **Step 1: Add the schema**

In `packages/db/src/schema.ts`, next to `identityLinks`:

```ts
export const REFERRAL_SOURCES = ["link_bot", "link_site", "later_bot", "later_site"] as const;
export type ReferralSource = (typeof REFERRAL_SOURCES)[number];

/**
 * Who referred whom. One row per referred player, forever (spec 2026-09-26).
 *
 * ⚠️ Keyed by Discord id with NO foreign key to identity_links: link rows are
 * deleted on unlink and guild removal, and a referral must outlive both.
 * ⚠️ Permanent: a trigger (migration 0054) rejects DELETE and every UPDATE
 * except setting referrer_notified_at from NULL. There is no code path that
 * edits a referral; a deliberate operator correction drops the trigger by hand.
 */
export const referrals = pgTable("referrals", {
  referredDiscordId: text("referred_discord_id").primaryKey(),
  referrerDiscordId: text("referrer_discord_id").notNull(),
  /** The referrer's character when named, for display after they unlink. */
  referrerDayzId: text("referrer_dayz_id").notNull(),
  source: text("source").$type<ReferralSource>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Set once the referrer has been DMed; the only column that may ever change. */
  referrerNotifiedAt: timestamp("referrer_notified_at", { withTimezone: true }),
}, (t) => ({
  byReferrer: index("referrals_referrer_idx").on(t.referrerDiscordId),
  notSelf: check("referrals_not_self", sql`${t.referredDiscordId} <> ${t.referrerDiscordId}`),
  sourceValid: check("referrals_source_valid", sql`${t.source} IN ('link_bot','link_site','later_bot','later_site')`),
}));
```

In `verificationChallenges`, after `targetDayzId`:

```ts
  /** The referrer named at /link start or on the site's link page, recorded when this challenge completes. */
  referrerDiscordId: text("referrer_discord_id"),
  /** Set by completeChallenge when the named referrer could not be recorded; the Verified DM explains it. */
  referralRefused: text("referral_refused"),
```

Import `check` / `index` from `drizzle-orm/pg-core` if the file does not already.

- [ ] **Step 2: Generate the migration and append the trigger**

Run: `pnpm --filter @factions/db generate`
Then append to the generated `0054_*.sql`:

```sql
--> statement-breakpoint
CREATE OR REPLACE FUNCTION referrals_permanent() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'referrals are permanent: % refused', lower(TG_OP);
  END IF;
  IF NEW.referred_discord_id IS DISTINCT FROM OLD.referred_discord_id
     OR NEW.referrer_discord_id IS DISTINCT FROM OLD.referrer_discord_id
     OR NEW.referrer_dayz_id IS DISTINCT FROM OLD.referrer_dayz_id
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.referrer_notified_at IS NOT NULL AND NEW.referrer_notified_at IS DISTINCT FROM OLD.referrer_notified_at) THEN
    RAISE EXCEPTION 'referrals are permanent: update refused';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER referrals_permanent BEFORE UPDATE OR DELETE ON referrals
  FOR EACH ROW EXECUTE FUNCTION referrals_permanent();
--> statement-breakpoint
CREATE TRIGGER referrals_no_truncate BEFORE TRUNCATE ON referrals
  FOR EACH STATEMENT EXECUTE FUNCTION referrals_permanent();
```

⚠️ If any existing test helper TRUNCATEs every table between tests, exclude `referrals` from that helper and clean it with `ALTER TABLE referrals DISABLE TRIGGER USER; DELETE FROM referrals; ALTER TABLE referrals ENABLE TRIGGER USER;` in the test helper only; note it in a comment.

- [ ] **Step 3: Write the failing tests**

`packages/db/test/referrals.test.ts`:

```ts
it("rejects a delete", async () => {
  await insertReferral(db, { referred: "A", referrer: "B" });
  await expect(db.execute(sql`DELETE FROM referrals WHERE referred_discord_id = 'A'`)).rejects.toThrow(/permanent/);
});
it("rejects changing the referrer", async () => {
  await insertReferral(db, { referred: "A", referrer: "B" });
  await expect(db.execute(sql`UPDATE referrals SET referrer_discord_id = 'C' WHERE referred_discord_id = 'A'`)).rejects.toThrow(/permanent/);
});
it("allows marking the referrer notified once, and never again", async () => {
  await insertReferral(db, { referred: "A", referrer: "B" });
  await db.execute(sql`UPDATE referrals SET referrer_notified_at = now() WHERE referred_discord_id = 'A'`);
  await expect(db.execute(sql`UPDATE referrals SET referrer_notified_at = now() + interval '1 day' WHERE referred_discord_id = 'A'`)).rejects.toThrow(/permanent/);
});
it("rejects self-referral and a second referrer", async () => {
  await expect(insertReferral(db, { referred: "A", referrer: "A" })).rejects.toThrow(/referrals_not_self/);
  await insertReferral(db, { referred: "A", referrer: "B" });
  await expect(insertReferral(db, { referred: "A", referrer: "C" })).rejects.toThrow(/duplicate key/);
});
it("rejects truncate", async () => {
  await expect(db.execute(sql`TRUNCATE referrals`)).rejects.toThrow(/permanent/);
});
```

with a local helper `insertReferral(db, { referred, referrer })` inserting `referrerDayzId: "uid-" + referrer, source: "later_bot"`.

- [ ] **Step 4: Run, implement until green, run the gate**

Run: `TEST_DATABASE_URL=... npx vitest run test/referrals.test.ts` in `packages/db`, then the full gate.

- [ ] **Step 5: Commit** — `feat(db): referrals table with a permanence trigger`

---

### Task 2: Verification — the write, the check, and link-time referrals

**Files:**
- Create: `packages/verification/src/referral.ts`
- Modify: `packages/verification/src/store.ts` (`LiveChallenge`, `createChallenge`, `completeChallenge`, `PendingNotification`, `pendingNotifications`, new methods)
- Modify: `packages/verification/src/issue.ts` (`IssueContext.referrerDiscordId`)
- Modify: `packages/verification/src/index.ts` (exports)
- Test: `packages/verification/test/referral.test.ts`, additions to the existing store and issue tests

**Interfaces:**
- Consumes: Task 1's `referrals`, `verificationChallenges.referrerDiscordId`, `.referralRefused`, `ReferralSource`.
- Produces:
  - `type ReferralRefusal = "already-referred" | "self" | "referrer-not-linked" | "loop" | "not-linked"`
  - `recordReferralTx(tx, a: { referredDiscordId: string; referrerDiscordId: string; source: ReferralSource; at: Date }): Promise<"recorded" | ReferralRefusal>`
  - `checkReferral(db, a: { referredDiscordId: string; referrerDiscordId: string }): Promise<null | Exclude<ReferralRefusal, "not-linked">>` (read-only pre-check; does not require the referred player to be linked)
  - `IssueContext.referrerDiscordId?: string | null` and `LiveChallenge.referrerDiscordId: string | null`
  - `PendingNotification` completed variant gains `referralRefused: ReferralRefusal | null` and `referrerDiscordId: string | null`
  - store: `pendingReferralNotices(): Promise<{ referredDiscordId: string; referrerDiscordId: string; referredGamertag: string | null }[]>`, `markReferralNotified(referredDiscordId: string, at: Date): Promise<void>`, `setChallengeReferrer(challengeId: number, referrerDiscordId: string): Promise<void>`

- [ ] **Step 1: Write the failing tests** (`packages/verification/test/referral.test.ts`, DB-backed like the store tests)

```ts
it("records a referral between two linked players", ...)            // → "recorded", row present, source kept
it("refuses a second referrer", ...)                                  // → "already-referred", first row unchanged
it("refuses self", ...)                                               // → "self"
it("refuses an unlinked referrer, and an unlinked referred player", ...) // → "referrer-not-linked" / "not-linked"
it("refuses a direct loop and a three-step loop", ...)                // A→B then B→A: "loop"; A→B, B→C then C→A: "loop"
it("serialises concurrent opposite referrals: one wins, one is a loop", async () => {
  const [x, y] = await Promise.all([
    db.transaction((tx) => recordReferralTx(tx, { referredDiscordId: "A", referrerDiscordId: "B", source: "later_bot", at })),
    db.transaction((tx) => recordReferralTx(tx, { referredDiscordId: "B", referrerDiscordId: "A", source: "later_bot", at })),
  ]);
  expect([x, y].sort()).toEqual(["loop", "recorded"]);
});
it("checkReferral refuses already-referred even while the player is unlinked", ...) // Review Focus 2
```

Store tests to add:

```ts
it("completeChallenge records the named referrer in the same transaction", ...)
it("completeChallenge still links when the referrer unlinked meanwhile, and says why", ...)
  // referral absent; challenge.referral_refused = "referrer-not-linked"; pendingNotifications() carries referralRefused
it("pendingReferralNotices lists un-notified referrals once; markReferralNotified retires them", ...)
it("pendingReferralNotices names an unlinked referred player as null", ...) // Review Focus 5
```

Issue tests to add (Review Focus 4):

```ts
it("saves the referrer on a new challenge", ...)
it("re-showing the live challenge with a new referrer updates it", ...)
it("a redraw without a referrer keeps the one already named", ...)
```

- [ ] **Step 2: Run them to see them fail**

Run: `TEST_DATABASE_URL=... npx vitest run` in `packages/verification`. Expected: missing exports.

- [ ] **Step 3: Implement `referral.ts`**

```ts
import type { Database } from "@factions/db";
import { identityLinks, referrals, type ReferralSource } from "@factions/db";
import { eq, sql } from "drizzle-orm";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Reader = Database | Tx;

export type ReferralRefusal = "already-referred" | "self" | "referrer-not-linked" | "loop" | "not-linked";

/** Would naming `referrer` put `referred` in their own chain of referrers? */
async function makesLoop(db: Reader, referredDiscordId: string, referrerDiscordId: string): Promise<boolean> {
  const rows = await db.execute(sql`
    WITH RECURSIVE chain(d) AS (
      SELECT referrer_discord_id FROM referrals WHERE referred_discord_id = ${referrerDiscordId}
      UNION
      SELECT r.referrer_discord_id FROM referrals r JOIN chain c ON r.referred_discord_id = c.d
    )
    SELECT 1 FROM chain WHERE d = ${referredDiscordId} LIMIT 1`);
  return rows.length > 0;
}

/** The friendly refusal before a challenge is issued. The referred player need not be linked yet. */
export async function checkReferral(db: Reader, a: { referredDiscordId: string; referrerDiscordId: string }): Promise<null | Exclude<ReferralRefusal, "not-linked">> {
  if (a.referredDiscordId === a.referrerDiscordId) return "self";
  const [existing] = await db.select({ d: referrals.referredDiscordId }).from(referrals).where(eq(referrals.referredDiscordId, a.referredDiscordId));
  if (existing) return "already-referred";
  const [link] = await db.select({ d: identityLinks.discordId }).from(identityLinks).where(eq(identityLinks.discordId, a.referrerDiscordId));
  if (!link) return "referrer-not-linked";
  return (await makesLoop(db, a.referredDiscordId, a.referrerDiscordId)) ? "loop" : null;
}

/**
 * The only write to `referrals` (spec §4). Inside the caller's transaction.
 *
 * ⚠️ The advisory lock serialises every referral write: without it, A→B and
 * B→A in flight together both pass the loop walk and both insert. Referrals
 * are rare, so one global lock costs nothing.
 */
export async function recordReferralTx(tx: Tx, a: { referredDiscordId: string; referrerDiscordId: string; source: ReferralSource; at: Date }): Promise<"recorded" | ReferralRefusal> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('referrals'))`);
  const [me] = await tx.select({ d: identityLinks.discordId }).from(identityLinks).where(eq(identityLinks.discordId, a.referredDiscordId));
  if (!me) return "not-linked";
  if (a.referredDiscordId === a.referrerDiscordId) return "self";
  const [referrer] = await tx.select({ dayzId: identityLinks.dayzId }).from(identityLinks).where(eq(identityLinks.discordId, a.referrerDiscordId));
  if (!referrer) return "referrer-not-linked";
  if (await makesLoop(tx, a.referredDiscordId, a.referrerDiscordId)) return "loop";
  const inserted = await tx.insert(referrals).values({
    referredDiscordId: a.referredDiscordId, referrerDiscordId: a.referrerDiscordId,
    referrerDayzId: referrer.dayzId, source: a.source, createdAt: a.at,
  }).onConflictDoNothing().returning({ d: referrals.referredDiscordId });
  return inserted.length > 0 ? "recorded" : "already-referred";
}
```

Adjust `db.execute` result access (`rows.length` vs `rows.rows.length`) to however this repo's postgres.js drizzle returns rows; grep an existing `db.execute(sql` call for the shape.

- [ ] **Step 4: Wire the store and issue**

- `toLive` maps `referrerDiscordId`; `createChallenge` input gains `referrerDiscordId: string | null`.
- In `completeChallenge`, in the success branch right after a non-empty `inserted` and before `return complete()`:

```ts
      if (challenge.referrerDiscordId) {
        const r = await recordReferralTx(tx, { referredDiscordId: challenge.discordId, referrerDiscordId: challenge.referrerDiscordId, source: challenge.guildId === null ? "link_site" : "link_bot", at });
        if (r !== "recorded") await tx.update(verificationChallenges).set({ referralRefused: r }).where(eq(verificationChallenges.id, challengeId));
      }
```

  ⚠️ `recordReferralTx` returning a refusal must never fail the link; only an exception rolls back, and that is the same as any other DB error in this transaction.
- `pendingNotifications`: the completed variant carries `referralRefused: r.referralRefused as ReferralRefusal | null` and `referrerDiscordId: r.referrerDiscordId`.
- `pendingReferralNotices`: `SELECT referred_discord_id, referrer_discord_id, identity_links.gamertag FROM referrals LEFT JOIN identity_links ON identity_links.discord_id = referrals.referred_discord_id WHERE referrer_notified_at IS NULL ORDER BY created_at`.
- `markReferralNotified`: `UPDATE referrals SET referrer_notified_at = $at WHERE referred_discord_id = $id AND referrer_notified_at IS NULL`.
- `setChallengeReferrer`: guarded update on an open challenge (`completed_at IS NULL AND canceled_at IS NULL`).
- `issueChallenge`: `IssueContext.referrerDiscordId?: string | null`. On the re-show path (`live` for the same target, no `newSequence`), if `ctx.referrerDiscordId` is set and differs, call `store.setChallengeReferrer(live.id, ctx.referrerDiscordId)` and return the live challenge with it. On every issuing path, pass `referrerDiscordId: ctx.referrerDiscordId ?? live?.referrerDiscordId ?? null` to `createChallenge` (a redraw keeps the old referrer; a switch to a different character also keeps it, since the referrer is about the person).
- Export `recordReferralTx`, `checkReferral`, `ReferralRefusal` from the package index. Update the `VerificationStore` interface and any in-memory fake store used by tests.

- [ ] **Step 5: Run the package tests, then the gate**

- [ ] **Step 6: Commit** — `feat(verification): record referrals, at link time and on their own`

---

### Task 3: Roster API and shared copy

**Files:**
- Create: `packages/roster/src/referral.ts`
- Modify: `packages/roster/src/api.ts` (new methods; `startLink` opts), `packages/roster/src/link.ts` (`startLinkDb`, `linkStatusDb`), `packages/roster/src/index.ts`
- Modify: `packages/copy/src/` (new `REFERRAL_COPY`; find where `ISSUE_COPY` lives and add beside it)
- Test: `packages/roster/test/referral.test.ts`, `packages/copy` test beside `ISSUE_COPY`'s

**Interfaces:**
- Consumes: Task 2's `recordReferralTx`, `checkReferral`, `ReferralRefusal`; existing `resolveGamertagLink(db, gamertag)` in `packages/roster/src/writes.ts`.
- Produces:
  - `type ReferrerRefusal = ReferralRefusal | "unknown-referrer" | "ambiguous-referrer"`
  - `type AddReferrerOutcome = { kind: "recorded"; referrerGamertag: string } | { kind: "refused"; reason: ReferrerRefusal; referrerGamertag?: string }` (`referrerGamertag` on `already-referred` is the EXISTING referrer's)
  - `type StartLinkOutcome = IssueOutcome | { kind: "referrer-refused"; reason: ReferrerRefusal }`
  - roster API:
    - `startLink(discordId, targetDayzId, opts: { newSequence?: boolean; referrerGamertag?: string }): Promise<StartLinkOutcome>` (the recorded `source` is inferred at completion from the challenge's guild: null means the site)
    - `addReferrer(discordId, referrerGamertag, source: "later_bot" | "later_site"): Promise<AddReferrerOutcome>`
    - `referralsFor(discordId): Promise<{ referredBy: { gamertag: string } | null; brought: { gamertag: string | null }[] }>`
    - `referralsForGamertag(gamertag): Promise<same | null>` (resolve the profile's link; null when the profile's player is not linked)
  - `LinkStatus` gains `referredBy: { gamertag: string } | null`
  - `REFERRAL_COPY: Record<ReferrerRefusal, (a: { referrerGamertag?: string }) => string>` and `REFERRAL_RECORDED(gamertag) => string`

- [ ] **Step 1: Failing tests** (`packages/roster/test/referral.test.ts`)

```ts
it("addReferrer resolves the gamertag case-insensitively and records it", ...)
it("addReferrer refuses an unknown gamertag and an ambiguous one", ...) // Review Focus 3
it("addReferrer names the existing referrer when already referred", ...)
it("startLink with a bad referrer refuses before issuing a challenge", ...) // no verification_challenges row written
it("startLink with a good referrer saves it on the challenge", ...)
it("referralsFor shows the referrer by current gamertag, falling back to the player's last seen gamertag", ...)
it("referralsFor lists brought-in players, null gamertag for those unlinked", ...)
it("a referral survives unlink and relink", ...) // spec §2 rule 6
```

- [ ] **Step 2: Implement** `packages/roster/src/referral.ts`:

```ts
export async function resolveReferrer(db: Database, gamertag: string): Promise<{ discordId: string } | "unknown-referrer" | "ambiguous-referrer"> {
  const r = await resolveGamertagLink(db, gamertag.trim());
  if (r === "ambiguous-gamertag") return "ambiguous-referrer";
  return r ? { discordId: r.discordId } : "unknown-referrer";
}

export async function addReferrerDb(db: Database, now: Date, discordId: string, gamertag: string, source: "later_bot" | "later_site"): Promise<AddReferrerOutcome> {
  const ref = await resolveReferrer(db, gamertag);
  if (typeof ref === "string") return { kind: "refused", reason: ref };
  const r = await db.transaction((tx) => recordReferralTx(tx, { referredDiscordId: discordId, referrerDiscordId: ref.discordId, source, at: now }));
  if (r === "recorded") return { kind: "recorded", referrerGamertag: await currentGamertag(db, ref.discordId) };
  if (r === "already-referred") return { kind: "refused", reason: r, referrerGamertag: (await referralsForDb(db, discordId)).referredBy?.gamertag };
  return { kind: "refused", reason: r };
}
```

`currentGamertag(db, discordId)`: the `identity_links.gamertag`, else `players.gamertag` for the referral's `referrer_dayz_id`. `referralsForDb` reads `referrals` both ways with those joins. `startLinkDb` gains `referrerGamertag?: string`: when set, `resolveReferrer` then `checkReferral` BEFORE `issueChallenge`, returning `{ kind: "referrer-refused", reason }` on refusal, else passing `referrerDiscordId` into the `IssueContext`. `linkStatusDb` adds `referredBy`.

Copy (plain voice, no em dashes):

```ts
export const REFERRAL_COPY = {
  "already-referred": (a) => a.referrerGamertag ? `You already named ${a.referrerGamertag} as your referrer, and that can't be changed.` : "You already have a referrer, and that can't be changed.",
  self: () => "You can't name yourself as your referrer.",
  "referrer-not-linked": () => "Your referrer has to be a linked player.",
  "unknown-referrer": () => "No linked player goes by that name. Pick one from the list.",
  "ambiguous-referrer": () => "More than one linked player matches that name. Type it exactly as it appears in the list.",
  loop: () => "That player was brought in by you, so they can't be your referrer.",
  "not-linked": () => "Link your character first, then you can name a referrer.",
} satisfies Record<ReferrerRefusal, (a: { referrerGamertag?: string }) => string>;
export const referralRecorded = (gamertag: string) => `${gamertag} is now your referrer. This is permanent.`;
```

Add a copy test asserting no string contains "—".

- [ ] **Step 3: Run tests, gate. Step 4: Commit** — `feat(roster): add a referrer, name one while linking, read referrals`

---

### Task 4: Bot — `/link start referrer`, `/link referrer`, status, and the DMs

**Files:**
- Modify: `apps/bot/src/commands/link.ts`, `apps/bot/src/commands/embeds/link.ts` (status line), `apps/bot/src/discord.ts` (`notifyCompleted`)
- Test: the existing link command tests (find with `grep -rln "link start" apps/bot/test`), `apps/bot/test/command-fakes.ts` (fake roster methods), the `notifyCompleted` tests

**Interfaces:**
- Consumes: Task 3's roster methods and copy; Task 2's store `pendingReferralNotices`, `markReferralNotified`, `PendingNotification.referralRefused`.
- Produces: nothing new for later tasks.

- [ ] **Step 1: Failing tests**

```ts
it("/link start passes the referrer and shows the refusal when it is refused", ...)
it("/link referrer records and says it is permanent", ...)
it("/link referrer shows each refusal's copy", ...)                 // it.each over REFERRAL_COPY keys
it("/link referrer's autocomplete offers linked players only", ...) // reuses `linkedPlayers` from roster.ts
it("/link status shows the referrer", ...)
it("the Verified DM explains a referrer that could not be recorded", ...)
it("the referrer is DMed once, and a failed send retries next pass", ...)
it("the referrer DM names an unlinked referred player as 'A player'", ...) // Review Focus 5
```

- [ ] **Step 2: Implement**

`link.ts`:

```ts
import { linkedPlayers } from "./roster.js";
import { REFERRAL_COPY, referralRecorded } from "@factions/copy";

// in start:
  const referrer = input.string("referrer")?.trim() || undefined;
  const outcome = await ctx.roster.startLink(input.actorDiscordId, target, { newSequence: input.boolean("redraw") === true, referrerGamertag: referrer });
  if (outcome.kind === "referrer-refused") return { content: REFERRAL_COPY[outcome.reason]({}), ephemeral: true };

/** `/link referrer`: name the player who brought you in, once and for good. */
const referrer: Handler = async (ctx, input) => {
  const name = input.string("gamertag")?.trim();
  if (!name) return { content: "Pick your referrer from the list.", ephemeral: true };
  const r = await ctx.roster.addReferrer(input.actorDiscordId, name, "later_bot");
  return { content: r.kind === "recorded" ? referralRecorded(r.referrerGamertag) : REFERRAL_COPY[r.reason](r), ephemeral: true };
};
```

Builder: add `.addStringOption((o) => o.setName("referrer").setDescription("The linked player who brought you here (optional, permanent)").setAutocomplete(true))` to `start`, and a subcommand:

```ts
    .addSubcommand((s) => s.setName("referrer").setDescription("Name the player who brought you here (permanent)")
      .addStringOption((o) => o.setName("gamertag").setDescription("Their gamertag").setRequired(true).setAutocomplete(true)))
```

Specs: `{ path: "link start", handler: start, autocomplete: { character: characters, referrer: linkedPlayers } }` and `{ path: "link referrer", handler: referrer, autocomplete: { gamertag: linkedPlayers } }`. Check `roster.ts` → `link.ts` import creates no cycle; if it does, move `linkedPlayers` to a small shared module.

Status embed: when `status.referredBy`, add a field or line `Referred by <gamertag>`.

`notifyCompleted`: the Verified content gains, when `c.referralRefused`:

```ts
` Your referrer could not be recorded: ${REFERRAL_COPY[c.referralRefused]({})} You can add one with \`/link referrer\` or on your profile.`
```

(`"already-referred"` there reads fine as is.) After the challenge loop, a second loop:

```ts
  for (const r of await deps.store.pendingReferralNotices()) {
    try {
      await send({ discordId: r.referrerDiscordId, channelId: null, content: `${r.referredGamertag ?? "A player"} named you as the player who brought them to Clan Wars.` });
      await deps.store.markReferralNotified(r.referredDiscordId, deps.now());
      sent++;
    } catch (err) {
      const key = `ref:${r.referredDiscordId}`;
      // same once-only logging as the challenge loop; widen NotifyFailureLog's key type to string | number if needed
    }
  }
```

Mind the existing verified copy contains an em dash ("Verified — your…"); leave it (out of scope), but the new text must not add one.

- [ ] **Step 3: Run tests, gate. Step 4: Commit** — `feat(bot): name a referrer on /link start or with /link referrer; DM the referrer`

Note: new subcommands and options register on bot start through the existing command registration; confirm with `apps/bot/test/command-registration.test.ts` and update its snapshot if it has one.

---

### Task 5: Website — link page, own-profile panel, public profile

**Files:**
- Modify: `apps/web/app/(site)/link/link-flow.tsx` (`ChooseCharacter`: optional referrer field; `onClaim(dayzId, referrer)`; show `referrer-refused`)
- Modify: `apps/web/app/api/link/start/route.ts` (accept `referrer`)
- Create: `apps/web/app/api/referral/route.ts`
- Modify: `apps/web/app/components/owner.tsx` (`AccountPanel` referral block), the owner loader that builds `Owner` (grep `loadOwner`) to include `referrals`
- Modify: `apps/web/app/(site)/players/[gamertag]/page.tsx` (public "Referred by" / "Brought in")
- Test: the web tests beside the link start route and owner panels (grep `apps/web/test` for `link/start` and `AccountPanel`)

**Interfaces:**
- Consumes: Task 3's `startLink` opts, `addReferrer`, `referralsFor`, `referralsForGamertag`, `REFERRAL_COPY`, `referralRecorded`.

- [ ] **Step 1: Failing tests**

```ts
it("POST /api/link/start passes a referrer and returns referrer-refused", ...)
it("POST /api/link/start rejects a referrer over the gamertag length", ...)   // 400 bad-referrer
it("POST /api/referral requires a session", ...)
it("POST /api/referral records, and redirects to the owner's profile with the result", ...)
it("POST /api/referral keeps the typed name on a refusal", ...)
it("AccountPanel shows 'Referred by' when set, and the form with the permanence warning when not", ...)
it("the public profile shows 'Referred by' and 'Brought in N players', unlinked ones counted not named", ...)
```

- [ ] **Step 2: Implement**

`/api/link/start`: `body.referrer` optional string, `<= GAMERTAG_MAX` (import from `@/lib/clan-limits`), passed as `referrerGamertag`. The client shows `REFERRAL_COPY[outcome.reason]({})` for `referrer-refused` as its `Refusal` notice.

`ChooseCharacter`: under the character box, a labelled optional input "Who referred you? (optional)" using `GamertagField scope="linked"` is a form-island meant for native submits; here the form is client-handled, so use a plain controlled `<input>` with the same `field` class plus a note "Permanent once your link completes." Keep it a single line of copy, no em dash.

`/api/referral/route.ts` (pattern of `app/api/clan/guest/route.ts`):

```ts
export async function POST(req: NextRequest): Promise<NextResponse> {
  const s = await sessionOr401();                       // or formAction's session handling, as guest/route.ts does
  // formAction(req, back, fn): back = the owner's own profile path, /players/<link gamertag>, read via viewerFor(session.sub)
  // text(form, "referrer", GAMERTAG_MAX); empty → code("referral", "input")
  // addReferrer(session.sub, referrer, "later_site")
  // recorded → result code "referral-recorded"; refused → code("referral", reason) with keep: { referrer }
}
```

Add the result/error codes to the site's copy lookup (`@/lib/clan-copy` `code()` and `RESULT_COPY`, or a sibling) mapping to `REFERRAL_COPY`/`referralRecorded`, following how `code("guest", …)` is wired; the page only ever looks codes up, never echoes them.

`AccountPanel`: below the unlink form, when `owner.referrals.referredBy`: `Referred by <a href=/players/…>{gamertag}</a>`. Otherwise a form posting to `/api/referral` with `<GamertagField scope="linked" name="referrer" … />`, a submit button "Save referrer", and the line "This can't be changed later."

Public profile: when `referralsForGamertag(profile.gamertag)` returns data, a small line or Facts rows in an existing panel: "Referred by X" (linked to X's profile) and, when `brought.length > 0`, "Brought in N players: A, B" plus "and K players no longer linked" when some gamertags are null. Wrap the read in `.catch(() => null)` like `achievementsFor`, so a failure costs the line, never the page.

- [ ] **Step 3: Run tests, gate. Step 4: Commit** — `feat(web): name a referrer while linking or on your profile; show referrals`

---

### Task 6: Docs and changelog

**Files:**
- Modify: `CLAUDE.md` (the linking section around lines 339-350 and 555-557: referrals table, permanence trigger, where the write lives)
- Modify: `CHANGELOG.md` `## [Unreleased]` → `### Added`: "When you link your gamertag, you can now name the player who brought you to Clan Wars, with `/link start` or on the website, or later with `/link referrer` or on your profile. It can't be changed once set. Your referrer gets a DM, and both your profiles show it."

- [ ] **Step 1: Edit both. Step 2: Gate. Step 3: Commit** — `docs: referrals`
